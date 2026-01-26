/**
 * Stock Sync Service
 * Synchronizes inventory/stock levels from JTL FFN to local database
 * AND pushes stock changes to Shopify/WooCommerce
 *
 * JTL FFN is the source of truth for stock levels because:
 * 1. Products are created in Shopify/WooCommerce (without inventory)
 * 2. Products are synced to our DB and pushed to JTL FFN
 * 3. Warehouse receives inbound goods and counts inventory in JTL FFN
 * 4. This service pulls stock levels from JTL FFN back to our DB
 * 5. Stock changes are then pushed to Shopify/WooCommerce
 *
 * Sync Strategies:
 * - Inbound-triggered: When inbound status changes to "closed", immediately fetch stock
 * - Periodic: Full stock sync every 15-30 minutes as safety net
 * - Manual: On-demand stock refresh via API
 */

import { PrismaClient, SyncOrigin } from '@prisma/client';
import { JTLService, JTLProductWithStock } from './jtl.service.js';
import { getEncryptionService } from '../encryption.service.js';
import { getQueue, QUEUE_NAMES } from '../queue/sync-queue.service.js';

interface StockSyncResult {
  success: boolean;
  syncedAt: Date;
  productsUpdated: number;
  productsUnchanged: number;
  productsFailed: number;
  errors: string[];
  details?: {
    sku: string;
    jfsku: string;
    oldAvailable: number;
    newAvailable: number;
    oldReserved: number;
    newReserved: number;
  }[];
}

interface InboundUpdate {
  inboundId: string;
  status: string;
  merchantInboundNumber: string;
  updatedAt: string;
  items?: {
    jfsku: string;
    quantity: number;
  }[];
}

interface JTLCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  environment: 'sandbox' | 'production';
  fulfillerId: string;
  warehouseId: string;
}

export class StockSyncService {
  private prisma: PrismaClient;
  private lastInboundPollTime: Map<string, Date> = new Map(); // clientId -> lastPollTime

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Create JTL service instance for a client
   */
  private async createJTLService(clientId: string): Promise<JTLService | null> {
    const jtlConfig = await this.prisma.jtlConfig.findUnique({
      where: { clientId_fk: clientId },
    });

    if (!jtlConfig || !jtlConfig.isActive) {
      console.log(`[StockSync] No active JTL config for client ${clientId}`);
      return null;
    }

    const encryptionService = getEncryptionService();

    const credentials: JTLCredentials = {
      clientId: jtlConfig.clientId,
      clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
      accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
      refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
      tokenExpiresAt: jtlConfig.tokenExpiresAt ?? undefined,
      environment: jtlConfig.environment as 'sandbox' | 'production',
      fulfillerId: jtlConfig.fulfillerId,
      warehouseId: jtlConfig.warehouseId,
    };

    return new JTLService(credentials, this.prisma, clientId);
  }

  /**
   * Sync stock levels from JTL FFN for a specific client
   * This is the main entry point for stock synchronization
   */
  async syncStockForClient(clientId: string, options?: {
    jfskus?: string[];  // Optional: only sync specific products
    forceUpdate?: boolean;  // Update even if stock hasn't changed
  }): Promise<StockSyncResult> {
    const startTime = Date.now();
    console.log(`[StockSync] Starting stock sync for client ${clientId}`);

    const result: StockSyncResult = {
      success: false,
      syncedAt: new Date(),
      productsUpdated: 0,
      productsUnchanged: 0,
      productsFailed: 0,
      errors: [],
      details: [],
    };

    try {
      const jtlService = await this.createJTLService(clientId);
      if (!jtlService) {
        result.errors.push('No active JTL configuration found');
        return result;
      }

      // Fetch products with stock from JTL FFN using the dedicated Stocks API
      // This is the proper way to get stock levels for merchants
      const jtlProducts = await jtlService.getAllProductsWithStock();
      console.log(`[StockSync] Fetched ${jtlProducts.length} products with stock from JTL FFN`);

      if (jtlProducts.length === 0) {
        result.success = true;
        console.log(`[StockSync] No products with stock to sync`);
        return result;
      }

      // Filter by specific JFSKUs if provided
      const filteredProducts = options?.jfskus
        ? jtlProducts.filter(p => options.jfskus!.includes(p.jfsku))
        : jtlProducts;

      // Get all products for this client that have JTL product IDs
      const localProducts = await this.prisma.product.findMany({
        where: {
          clientId,
          jtlProductId: {
            not: null,
            ...(options?.jfskus ? { in: options.jfskus } : {}),
          },
        },
        select: {
          id: true,
          sku: true,
          jtlProductId: true,
          available: true,
          reserved: true,
          announced: true,
        },
      });

      // Create a map for quick lookup by JFSKU
      const localProductMap = new Map(
        localProducts.map(p => [p.jtlProductId!, p])
      );

      // Update each product's stock
      for (const jtlProduct of filteredProducts) {
        const localProduct = localProductMap.get(jtlProduct.jfsku);

        if (!localProduct) {
          // Product not found in local DB - might be a new product or different client
          continue;
        }

        // Extract stock levels from JTL product
        const newAvailable = jtlProduct.stock?.stockLevel ?? 0;
        const newReserved = jtlProduct.stock?.stockLevelReserved ?? 0;
        const newAnnounced = jtlProduct.stock?.stockLevelAnnounced ?? 0;

        try {
          const hasChanged =
            localProduct.available !== newAvailable ||
            localProduct.reserved !== newReserved ||
            localProduct.announced !== newAnnounced;

          if (hasChanged || options?.forceUpdate) {
            // Update stock in database
            await this.prisma.product.update({
              where: { id: localProduct.id },
              data: {
                available: newAvailable,
                reserved: newReserved,
                announced: newAnnounced,
                lastUpdatedBy: SyncOrigin.JTL,
                lastJtlSync: new Date(),
                jtlSyncStatus: 'SYNCED',
              },
            });

            // Log the sync
            await this.prisma.productSyncLog.create({
              data: {
                productId: localProduct.id,
                action: 'stock_update',
                origin: SyncOrigin.JTL,
                targetPlatform: 'nolimits',
                changedFields: ['available', 'reserved', 'announced'],
                oldValues: {
                  available: localProduct.available,
                  reserved: localProduct.reserved,
                  announced: localProduct.announced,
                },
                newValues: {
                  available: newAvailable,
                  reserved: newReserved,
                  announced: newAnnounced,
                },
                success: true,
              },
            });

            result.productsUpdated++;
            result.details?.push({
              sku: localProduct.sku,
              jfsku: jtlProduct.jfsku,
              oldAvailable: localProduct.available,
              newAvailable: newAvailable,
              oldReserved: localProduct.reserved,
              newReserved: newReserved,
            });

            console.log(`[StockSync] Updated ${localProduct.sku}: available ${localProduct.available} → ${newAvailable}, reserved ${localProduct.reserved} → ${newReserved}, announced ${localProduct.announced} → ${newAnnounced}`);

            // Queue sync to Shopify/WooCommerce to push stock changes
            await this.queueStockSyncToCommerce(localProduct.id);
          } else {
            result.productsUnchanged++;
          }
        } catch (error) {
          result.productsFailed++;
          result.errors.push(`Failed to update ${localProduct.sku}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      result.success = result.productsFailed === 0;

      const duration = Date.now() - startTime;
      console.log(`[StockSync] Completed for client ${clientId} in ${duration}ms: ${result.productsUpdated} updated, ${result.productsUnchanged} unchanged, ${result.productsFailed} failed`);

      return result;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : 'Unknown error');
      console.error(`[StockSync] Failed for client ${clientId}:`, error);
      return result;
    }
  }

  /**
   * Poll for inbound status changes and trigger stock sync when inbounds close
   * This provides near-real-time stock updates when warehouse receives goods
   */
  async pollInboundUpdatesAndSyncStock(clientId: string): Promise<{
    inboundsProcessed: number;
    stockSyncTriggered: boolean;
    stockSyncResult?: StockSyncResult;
  }> {
    console.log(`[StockSync] Polling inbound updates for client ${clientId}`);

    const result = {
      inboundsProcessed: 0,
      stockSyncTriggered: false,
      stockSyncResult: undefined as StockSyncResult | undefined,
    };

    try {
      const jtlService = await this.createJTLService(clientId);
      if (!jtlService) {
        return result;
      }

      // Get last poll time for this client
      const lastPollTime = this.lastInboundPollTime.get(clientId) || new Date(Date.now() - 60 * 60 * 1000); // Default 1 hour ago

      // Fetch inbound updates since last poll
      const updates = await jtlService.getInboundUpdates({
        since: lastPollTime.toISOString(),
      });

      // Update last poll time
      this.lastInboundPollTime.set(clientId, new Date());

      if (updates.length === 0) {
        console.log(`[StockSync] No inbound updates for client ${clientId}`);
        return result;
      }

      console.log(`[StockSync] Found ${updates.length} inbound updates for client ${clientId}`);

      // Check for closed/receipted inbounds
      const closedInbounds: InboundUpdate[] = [];
      const affectedJfskus: string[] = [];

      for (const update of updates) {
        result.inboundsProcessed++;

        // Cast to unknown first then to Record to access potential additional fields
        const updateData = update.data as unknown as Record<string, unknown>;
        const status = (updateData?.status as string)?.toLowerCase() || '';

        // Inbound statuses that indicate stock has been added:
        // - "receipted" / "eingetroffen" = goods received
        // - "closed" / "geschlossen" = inbound completed
        if (status === 'receipted' || status === 'closed' ||
            status === 'eingetroffen' || status === 'geschlossen') {

          // Try to extract items if available in the response
          const rawItems = updateData?.items as Array<{ jfsku?: string; quantity?: number }> | undefined;
          const items: InboundUpdate['items'] = rawItems?.map(item => ({
            jfsku: item.jfsku || '',
            quantity: item.quantity || 0,
          }));

          closedInbounds.push({
            inboundId: update.id,
            status: status,
            merchantInboundNumber: (updateData?.merchantInboundNumber as string) || '',
            updatedAt: update.timestamp,
            items: items,
          });

          // Collect affected JFSKUs if available
          if (rawItems && Array.isArray(rawItems)) {
            for (const item of rawItems) {
              if (item.jfsku) {
                affectedJfskus.push(item.jfsku);
              }
            }
          }

          // Log the inbound completion
          console.log(`[StockSync] Inbound ${update.id} (${updateData?.merchantInboundNumber}) status: ${status}`);
        }
      }

      // If any inbounds closed, trigger stock sync
      if (closedInbounds.length > 0) {
        console.log(`[StockSync] ${closedInbounds.length} inbounds closed, triggering stock sync`);

        result.stockSyncTriggered = true;

        // If we know which products were affected, only sync those
        // Otherwise sync all products
        result.stockSyncResult = await this.syncStockForClient(clientId, {
          jfskus: affectedJfskus.length > 0 ? [...new Set(affectedJfskus)] : undefined,
        });
      }

      return result;
    } catch (error) {
      console.error(`[StockSync] Failed to poll inbound updates for client ${clientId}:`, error);
      return result;
    }
  }

  /**
   * Sync stock for all active clients
   * Used for periodic full stock sync
   */
  async syncStockForAllClients(): Promise<{
    clientsProcessed: number;
    totalProductsUpdated: number;
    totalProductsFailed: number;
    results: Map<string, StockSyncResult>;
  }> {
    console.log(`[StockSync] Starting stock sync for all clients`);

    const overallResult = {
      clientsProcessed: 0,
      totalProductsUpdated: 0,
      totalProductsFailed: 0,
      results: new Map<string, StockSyncResult>(),
    };

    // Get all clients with active JTL config
    const clients = await this.prisma.client.findMany({
      where: {
        jtlConfig: {
          isActive: true,
        },
      },
      select: {
        id: true,
        companyName: true,
      },
    });

    console.log(`[StockSync] Found ${clients.length} clients with active JTL config`);

    for (const client of clients) {
      try {
        const result = await this.syncStockForClient(client.id);
        overallResult.results.set(client.id, result);
        overallResult.clientsProcessed++;
        overallResult.totalProductsUpdated += result.productsUpdated;
        overallResult.totalProductsFailed += result.productsFailed;
      } catch (error) {
        console.error(`[StockSync] Failed for client ${client.id} (${client.companyName}):`, error);
      }
    }

    console.log(`[StockSync] All clients sync completed: ${overallResult.clientsProcessed} clients, ${overallResult.totalProductsUpdated} products updated, ${overallResult.totalProductsFailed} failed`);

    return overallResult;
  }

  /**
   * Poll inbound updates and sync stock for all clients
   * Used for event-driven stock sync
   */
  async pollInboundsAndSyncForAllClients(): Promise<{
    clientsProcessed: number;
    totalInboundsProcessed: number;
    stockSyncsTriggered: number;
  }> {
    console.log(`[StockSync] Polling inbounds for all clients`);

    const result = {
      clientsProcessed: 0,
      totalInboundsProcessed: 0,
      stockSyncsTriggered: 0,
    };

    // Get all clients with active JTL config
    const clients = await this.prisma.client.findMany({
      where: {
        jtlConfig: {
          isActive: true,
        },
      },
      select: {
        id: true,
      },
    });

    for (const client of clients) {
      try {
        const pollResult = await this.pollInboundUpdatesAndSyncStock(client.id);
        result.clientsProcessed++;
        result.totalInboundsProcessed += pollResult.inboundsProcessed;
        if (pollResult.stockSyncTriggered) {
          result.stockSyncsTriggered++;
        }
      } catch (error) {
        console.error(`[StockSync] Failed to poll inbounds for client ${client.id}:`, error);
      }
    }

    console.log(`[StockSync] Inbound polling completed: ${result.clientsProcessed} clients, ${result.totalInboundsProcessed} inbounds, ${result.stockSyncsTriggered} stock syncs triggered`);

    return result;
  }

  /**
   * Get stock sync status for a client
   */
  async getStockSyncStatus(clientId: string): Promise<{
    lastSyncAt: Date | null;
    productsWithStock: number;
    productsWithoutStock: number;
    totalAvailable: number;
    totalReserved: number;
  }> {
    const products = await this.prisma.product.findMany({
      where: { clientId },
      select: {
        available: true,
        reserved: true,
        lastJtlSync: true,
        jtlProductId: true,
      },
    });

    const productsWithJtl = products.filter(p => p.jtlProductId);
    const lastSync = productsWithJtl
      .map(p => p.lastJtlSync)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    return {
      lastSyncAt: lastSync,
      productsWithStock: products.filter(p => p.available > 0).length,
      productsWithoutStock: products.filter(p => p.available === 0).length,
      totalAvailable: products.reduce((sum, p) => sum + p.available, 0),
      totalReserved: products.reduce((sum, p) => sum + p.reserved, 0),
    };
  }

  /**
   * Queue stock sync to commerce platforms (Shopify/WooCommerce)
   * This pushes stock level changes from JTL FFN to the storefronts
   */
  private async queueStockSyncToCommerce(productId: string): Promise<void> {
    try {
      const queue = getQueue();
      if (!queue) {
        console.warn(`[StockSync] Queue not available, skipping commerce sync for product ${productId}`);
        return;
      }

      // Get product channels to determine which platforms to sync to
      const productChannels = await this.prisma.productChannel.findMany({
        where: { productId },
        include: {
          channel: {
            select: {
              id: true,
              type: true,
              isActive: true,
            },
          },
        },
      });

      // Queue sync for each active channel
      for (const pc of productChannels) {
        if (!pc.channel.isActive) continue;

        if (pc.channel.type === 'SHOPIFY') {
          await queue.enqueue(
            QUEUE_NAMES.PRODUCT_SYNC_TO_SHOPIFY,
            {
              productId,
              channelId: pc.channel.id,
              origin: 'jtl',
              fieldsToSync: ['available', 'reserved'],
            },
            {
              priority: 5, // Higher priority for stock updates
              retryLimit: 3,
              retryDelay: 30,
            }
          );
          console.log(`[StockSync] Queued Shopify stock sync for product ${productId}`);
        } else if (pc.channel.type === 'WOOCOMMERCE') {
          await queue.enqueue(
            QUEUE_NAMES.PRODUCT_SYNC_TO_WOOCOMMERCE,
            {
              productId,
              channelId: pc.channel.id,
              origin: 'jtl',
              fieldsToSync: ['available', 'reserved'],
            },
            {
              priority: 5,
              retryLimit: 3,
              retryDelay: 30,
            }
          );
          console.log(`[StockSync] Queued WooCommerce stock sync for product ${productId}`);
        }
      }
    } catch (error) {
      console.error(`[StockSync] Failed to queue commerce sync for product ${productId}:`, error);
      // Don't throw - stock is already updated in DB, commerce sync can be retried
    }
  }
}

export default StockSyncService;
