/**
 * Product Sync Service
 * 
 * Centralized bi-directional product sync between:
 * - No-Limits Platform (central hub)
 * - Shopify
 * - WooCommerce  
 * - JTL-FFN (Fulfillment)
 * 
 * Core principles:
 * 1. Both sides can create/edit
 * 2. Each update has an origin (prevents infinite loops)
 * 3. Field-level ownership (commerce vs ops fields)
 * 4. Conflict rules are deterministic
 * 5. Async, idempotent sync via job queue
 */

import { PrismaClient, ChannelType, SyncOrigin, SyncStatus, Prisma } from '@prisma/client';
import { createShopifyServiceAuto } from './shopify-service-factory.js';
import { WooCommerceService } from './woocommerce.service.js';
import { JTLService } from './jtl.service.js';
import { getEncryptionService } from '../encryption.service.js';
import crypto from 'crypto';
import { Logger } from '../../utils/logger.js';
import { generateJobId } from '../../utils/job-id.js';

type Decimal = Prisma.Decimal;

/** Extract a useful error message from any thrown value (not just Error instances) */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

// ============= FIELD OWNERSHIP DEFINITIONS =============

/**
 * Field ownership determines which platform is authoritative for each field
 */
export const FIELD_OWNERSHIP = {
  // 🟢 Commerce-owned (Shopify/WooCommerce authoritative)
  commerce: [
    'netSalesPrice',
    'compareAtPrice',
    'taxable',
    'seoTitle',
    'seoDescription',
    'tags',
    'collections',
    'productType',
    'vendor',
  ],
  
  // 🔵 Ops/Warehouse-owned (No-Limits authoritative)
  ops: [
    'sku',
    'gtin',
    'han',
    'weightInKg',
    'heightInCm',
    'lengthInCm',
    'widthInCm',
    'packagingUnit',
    'packagingQty',
    'hazmat',
    'hazmatClass',
    'warehouseNotes',
    'storageLocation',
    'minStockLevel',
    'reorderPoint',
    'customsCode',
    'countryOfOrigin',
    'manufacturer',
  ],
  
  // ⚪ Shared (last-write-wins with conflict detection)
  shared: [
    'name',
    'description',
    'imageUrl',
    'isActive',
  ],
  
  // 🟡 Stock (No-Limits/JTL authoritative - never overwritten by commerce)
  stock: [
    'available',
    'reserved',
    'announced',
  ],
} as const;

// ============= TYPES =============

export type SyncOriginType = 'shopify' | 'woocommerce' | 'nolimits' | 'jtl' | 'system';

export interface ProductSyncResult {
  success: boolean;
  action: 'created' | 'updated' | 'deleted' | 'skipped' | 'conflict' | 'failed';
  productId: string;
  externalIds?: {
    shopify?: string;
    woocommerce?: string;
    jtl?: string;
  };
  syncedPlatforms?: string[];
  skippedPlatforms?: string[];
  conflicts?: FieldConflict[];
  error?: string;
  details?: Record<string, unknown>;
}

export interface FieldConflict {
  field: string;
  localValue: unknown;
  incomingValue: unknown;
  incomingOrigin: SyncOriginType;
  resolution: 'accepted' | 'rejected' | 'manual';
  reason: string;
}

export interface SyncJobData {
  productId: string;
  operation: 'push_to_shopify' | 'push_to_woocommerce' | 'push_to_jtl' | 'sync_all';
  triggerOrigin: SyncOriginType;
  triggerEventId?: string;
  fieldsToSync?: string[];
  priority?: number;
  channelId?: string;
}

export interface IncomingProductData {
  // External IDs
  externalId: string;
  channelId?: string;
  
  // Core fields
  name?: string;
  description?: string;
  sku?: string;
  gtin?: string;
  price?: number;
  compareAtPrice?: number;
  
  // Stock
  quantity?: number;
  
  // Dimensions
  weight?: number;
  weightUnit?: 'g' | 'kg' | 'lb' | 'oz';
  height?: number;
  length?: number;
  width?: number;
  
  // Images
  imageUrl?: string;
  images?: Array<{ url: string; alt?: string; position?: number }>;
  
  // Commerce fields
  taxable?: boolean;
  tags?: string[];
  collections?: string[];
  productType?: string;
  vendor?: string;
  seoTitle?: string;
  seoDescription?: string;
  
  // Status
  isActive?: boolean;
  status?: string;

  // Bundle detection
  isBundle?: boolean;
  bundleComponents?: Array<{
    externalId?: string;  // Platform-specific product/variant ID
    sku?: string;
    quantity: number;
  }>;

  // Raw platform data
  rawData?: Record<string, unknown>;
}

interface ChannelWithCredentials {
  id: string;
  type: ChannelType;
  shopDomain?: string | null;
  accessToken?: string | null;
  apiUrl?: string | null;
  apiClientId?: string | null;
  apiClientSecret?: string | null;
  clientId: string;
}

// ============= SERVICE =============

export class ProductSyncService {
  private prisma: PrismaClient;
  private conflictWindowMinutes: number = 5; // Time window for conflict detection
  private logger = new Logger('ProductSync');

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // ============= INCOMING SYNC (Platform → No-Limits) =============

  /**
   * Process an incoming product from Shopify/WooCommerce webhook
   * This is called when a product is created or updated on the commerce platform
   */
  async processIncomingProduct(
    origin: SyncOriginType,
    clientId: string,
    channelId: string,
    data: IncomingProductData,
    webhookEventId?: string
  ): Promise<ProductSyncResult> {
    const externalId = data.externalId;
    const jobId = generateJobId('product-incoming');
    const startTime = Date.now();

    this.logger.debug({
      jobId,
      event: 'incoming_product_started',
      origin,
      externalId,
      sku: data.sku,
      channelId
    });

    try {
      // 1. Check if this is an echo of our own update (loop prevention)
      if (await this.isEchoFromOurUpdate(data.externalId, origin, channelId)) {
        this.logger.debug({
          jobId,
          event: 'echo_detected',
          origin,
          externalId,
          reason: 'Skipping our own update'
        });

        return {
          success: true,
          action: 'skipped',
          productId: '',
          details: { reason: 'Echo of our own update detected' },
        };
      }

      // 2. Find existing product by external ID or SKU
      const existingProduct = await this.findProductByExternalIdOrSku(
        clientId,
        channelId,
        externalId,
        data.sku
      );

      this.logger.debug({
        jobId,
        event: 'product_lookup',
        found: !!existingProduct,
        productId: existingProduct?.id,
        sku: existingProduct?.sku
      });

      // 3. Prepare field updates respecting ownership
      const { updates, conflicts } = this.prepareFieldUpdates(
        existingProduct,
        data,
        origin
      );

      // 4. Handle conflicts if any
      if (conflicts.length > 0) {
        this.logger.warn({
          jobId,
          event: 'conflicts_detected',
          externalId,
          conflictCount: conflicts.length,
          conflicts: conflicts.map(c => ({ field: c.field, resolution: c.resolution }))
        });

        const hasUnresolved = conflicts.some(c => c.resolution === 'manual');
        if (hasUnresolved) {
          return {
            success: false,
            action: 'conflict',
            productId: existingProduct?.id || '',
            conflicts,
            error: 'Unresolved conflicts require manual review',
          };
        }
      }

      let product: { id: string };
      let action: 'created' | 'updated';

      if (existingProduct) {
        // Update existing product
        this.logger.debug({
          jobId,
          event: 'updating_product',
          productId: existingProduct.id,
          sku: existingProduct.sku,
          fieldsUpdating: Object.keys(updates)
        });

        product = await this.prisma.product.update({
          where: { id: existingProduct.id },
          data: {
            ...updates,
            lastUpdatedBy: this.mapOriginToEnum(origin),
            updatedAt: new Date(),
            syncStatus: 'PENDING',
          },
        });
        action = 'updated';

        // Update ProductChannel
        await this.prisma.productChannel.updateMany({
          where: {
            productId: existingProduct.id,
            channelId,
          },
          data: {
            externalProductId: externalId,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });

        this.logger.info({
          jobId,
          event: 'product_updated',
          productId: product.id,
          sku: existingProduct.sku,
          origin,
          fieldsUpdated: Object.keys(updates).length,
          duration: Date.now() - startTime
        });
      } else {
        // Create new product
        const sku = data.sku || `${origin.toUpperCase()}-${externalId}`;

        this.logger.debug({
          jobId,
          event: 'creating_product',
          sku,
          name: data.name,
          origin
        });

        product = await this.prisma.product.create({
          data: {
            clientId,
            productId: `${origin.toUpperCase()}-${externalId}`,
            sku,
            name: data.name || 'Unnamed Product',
            description: data.description,
            netSalesPrice: data.price,
            compareAtPrice: data.compareAtPrice,
            available: data.quantity || 0,
            weightInKg: this.normalizeWeight(data.weight, data.weightUnit),
            heightInCm: data.height,
            lengthInCm: data.length,
            widthInCm: data.width,
            imageUrl: data.imageUrl,
            gtin: data.gtin,
            taxable: data.taxable ?? true,
            tags: data.tags || [],
            collections: data.collections || [],
            productType: data.productType,
            vendor: data.vendor,
            seoTitle: data.seoTitle,
            seoDescription: data.seoDescription,
            isActive: data.isActive ?? (data.status === 'active' || data.status === 'publish'),
            isBundle: data.isBundle ?? false,  // Bundle status from commerce platform
            bundlePrice: data.isBundle ? data.price : null,  // Bundle price from commerce platform
            lastUpdatedBy: this.mapOriginToEnum(origin),
            syncStatus: 'PENDING',
            channels: {
              create: {
                channelId,
                externalProductId: externalId,
                syncStatus: 'SYNCED',
                lastSyncAt: new Date(),
              },
            },
          },
        });
        action = 'created';

        this.logger.info({
          jobId,
          event: 'product_created',
          productId: product.id,
          sku,
          name: data.name,
          origin,
          duration: Date.now() - startTime
        });
      }

      // 5. Log the sync operation
      await this.logSyncOperation(product.id, {
        action,
        origin: this.mapOriginToEnum(origin),
        targetPlatform: origin,
        changedFields: Object.keys(updates),
        newValues: updates,
        success: true,
        externalId,
      });

      // 5b. Handle bundle linking (if bundle data provided)
      if (data.isBundle && data.bundleComponents?.length) {
        await this.processBundleLinking(product.id, clientId, channelId, data);
      }

      // 5c. Check if this product resolves any pending bundle links
      await this.resolveAnyPendingBundleLinks(
        product.id, clientId, data.sku, data.externalId, channelId
      );

      // 6. Queue sync to other platforms
      this.logger.debug({
        jobId,
        event: 'queuing_sync',
        productId: product.id,
        fromOrigin: origin,
        action: 'sync_to_other_platforms'
      });

      await this.queueSyncToOtherPlatforms(product.id, origin, webhookEventId);

      return {
        success: true,
        action,
        productId: product.id,
        externalIds: { [origin]: externalId },
        conflicts: conflicts.length > 0 ? conflicts : undefined,
      };
    } catch (error) {
      this.logger.error({
        jobId,
        event: 'incoming_product_failed',
        origin,
        externalId,
        duration: Date.now() - startTime,
        error: extractErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      return {
        success: false,
        action: 'failed',
        productId: '',
        error: extractErrorMessage(error),
      };
    }
  }

  /**
   * Process product deletion from platform
   */
  async processProductDeletion(
    origin: SyncOriginType,
    clientId: string,
    channelId: string,
    externalId: string
  ): Promise<ProductSyncResult> {
    console.log(`[ProductSync] Processing ${origin} product deletion: ${externalId}`);

    try {
      // Find the product channel link
      const productChannel = await this.prisma.productChannel.findFirst({
        where: {
          channelId,
          externalProductId: externalId,
        },
        include: { product: true },
      });

      if (!productChannel) {
        return {
          success: true,
          action: 'skipped',
          productId: '',
          details: { reason: 'Product not found locally' },
        };
      }

      // Remove the channel link
      await this.prisma.productChannel.delete({
        where: { id: productChannel.id },
      });

      // Check if product has other channel links
      const otherChannels = await this.prisma.productChannel.count({
        where: { productId: productChannel.productId },
      });

      // Log the operation
      await this.logSyncOperation(productChannel.productId, {
        action: 'delete',
        origin: this.mapOriginToEnum(origin),
        targetPlatform: origin,
        changedFields: [],
        success: true,
        externalId,
      });

      // Don't delete product if it has other channels - just unlink
      if (otherChannels > 0) {
        return {
          success: true,
          action: 'updated',
          productId: productChannel.productId,
          details: { reason: 'Unlinked from channel, product retained (has other channels)' },
        };
      }

      // Optionally delete if no other channels (configurable behavior)
      // For now, we keep the product but mark it inactive
      await this.prisma.product.update({
        where: { id: productChannel.productId },
        data: {
          isActive: false,
          lastUpdatedBy: this.mapOriginToEnum(origin),
          syncStatus: 'SYNCED',
        },
      });

      return {
        success: true,
        action: 'deleted',
        productId: productChannel.productId,
      };
    } catch (error) {
      console.error(`[ProductSync] Error processing product deletion:`, error);
      return {
        success: false,
        action: 'failed',
        productId: '',
        error: extractErrorMessage(error),
      };
    }
  }

  // ============= OUTGOING SYNC (No-Limits → Platforms) =============

  /**
   * Push a product from No-Limits to all linked platforms
   * Called when a product is created/updated in No-Limits
   */
  async pushProductToAllPlatforms(
    productId: string,
    origin: SyncOriginType = 'nolimits',
    options: {
      skipPlatforms?: SyncOriginType[];
      fieldsToSync?: string[];
    } = {}
  ): Promise<ProductSyncResult> {
    const jobId = generateJobId('product-push');
    const startTime = Date.now();

    this.logger.debug({
      jobId,
      event: 'push_started',
      productId,
      origin,
      skipPlatforms: options.skipPlatforms,
      fieldsToSync: options.fieldsToSync
    });

    // Fetch product with all necessary fields for sync
    // Note: Using include without select automatically includes all scalar fields
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        channels: {
          include: { channel: true },
          where: { syncEnabled: true, isActive: true },
        },
        images: true,
        client: {
          include: { jtlConfig: true },
        },
        bundleItems: {
          include: {
            childProduct: {
              select: { id: true, name: true, sku: true, gtin: true, jtlProductId: true },
            },
          },
        },
      },
    });

    if (!product) {
      this.logger.warn({
        jobId,
        event: 'product_not_found',
        productId
      });

      return {
        success: false,
        action: 'failed',
        productId,
        error: 'Product not found',
      };
    }

    this.logger.debug({
      jobId,
      event: 'product_loaded',
      productId,
      sku: product.sku,
      name: product.name,
      channelsCount: product.channels.length,
      hasJTLConfig: !!product.client.jtlConfig,
      jtlProductId: product.jtlProductId
    });

    const results: { platform: string; success: boolean; externalId?: string; error?: string }[] = [];
    const skipPlatforms = options.skipPlatforms || [];

    // Push to each linked channel
    for (const productChannel of product.channels) {
      const channelType = productChannel.channel.type.toLowerCase() as SyncOriginType;
      const channelStartTime = Date.now();

      if (skipPlatforms.includes(channelType)) {
        this.logger.debug({
          jobId,
          event: 'platform_skipped',
          platform: channelType,
          reason: 'in_skip_list',
          productId,
          sku: product.sku
        });

        results.push({ platform: channelType, success: true, externalId: productChannel.externalProductId || undefined });
        continue;
      }

      this.logger.debug({
        jobId,
        event: 'syncing_to_platform',
        platform: channelType,
        productId,
        sku: product.sku,
        externalId: productChannel.externalProductId
      });

      try {
        let externalId: string | undefined;

        if (productChannel.channel.type === 'SHOPIFY') {
          externalId = await this.pushToShopify(product, productChannel, options.fieldsToSync);
        } else if (productChannel.channel.type === 'WOOCOMMERCE') {
          externalId = await this.pushToWooCommerce(product, productChannel, options.fieldsToSync);
        }

        // Update ProductChannel with result
        await this.prisma.productChannel.update({
          where: { id: productChannel.id },
          data: {
            externalProductId: externalId || productChannel.externalProductId,
            lastSyncAt: new Date(),
            syncStatus: 'SYNCED',
            lastSyncChecksum: this.generateChecksum(product),
          },
        });

        this.logger.debug({
          jobId,
          event: 'platform_sync_success',
          platform: channelType,
          productId,
          sku: product.sku,
          externalId,
          duration: Date.now() - channelStartTime
        });

        // Trigger pending stock sync after product is pushed to channel
        // This handles the race condition where stock arrives before the product is created
        if (externalId && (channelType === 'shopify' || channelType === 'woocommerce')) {
          this.syncStockToChannel(product.id, productChannel.channel.id).catch(err => {
            this.logger.warn({
              jobId,
              event: 'post_push_stock_sync_failed',
              productId,
              channelId: productChannel.channel.id,
              error: err instanceof Error ? err.message : 'Unknown',
            });
          });
        }

        results.push({ platform: channelType, success: true, externalId });
      } catch (error) {
        const errMsg = extractErrorMessage(error);
        this.logger.error({
          jobId,
          event: 'platform_sync_failed',
          platform: channelType,
          productId,
          sku: product.sku,
          duration: Date.now() - channelStartTime,
          error: errMsg,
          stack: error instanceof Error ? error.stack : undefined
        });

        await this.prisma.productChannel.update({
          where: { id: productChannel.id },
          data: {
            syncStatus: 'ERROR',
            lastError: errMsg,
            lastErrorAt: new Date(),
          },
        });

        results.push({
          platform: channelType,
          success: false,
          error: errMsg,
        });
      }
    }

    // Push to JTL if configured and not skipped
    if (product.client.jtlConfig && !skipPlatforms.includes('jtl')) {
      const jtlStartTime = Date.now();

      this.logger.debug({
        jobId,
        event: 'syncing_to_platform',
        platform: 'jtl',
        productId,
        sku: product.sku,
        currentJtlId: product.jtlProductId,
        jtlSyncStatus: product.jtlSyncStatus
      });

      try {
        const jtlId = await this.pushToJTL(product, product.client.jtlConfig, options.fieldsToSync);

        await this.prisma.product.update({
          where: { id: productId },
          data: {
            jtlProductId: jtlId || product.jtlProductId,
            lastJtlSync: new Date(),
            jtlSyncStatus: 'SYNCED',
          },
        });

        this.logger.info({
          jobId,
          event: 'platform_sync_success',
          platform: 'jtl',
          productId,
          sku: product.sku,
          jtlProductId: jtlId,
          duration: Date.now() - jtlStartTime
        });

        results.push({ platform: 'jtl', success: true, externalId: jtlId });
      } catch (error) {
        const errMsg = extractErrorMessage(error);
        this.logger.error({
          jobId,
          event: 'platform_sync_failed',
          platform: 'jtl',
          productId,
          sku: product.sku,
          duration: Date.now() - jtlStartTime,
          error: errMsg,
          stack: error instanceof Error ? error.stack : undefined
        });

        await this.prisma.product.update({
          where: { id: productId },
          data: { jtlSyncStatus: 'ERROR' },
        });

        results.push({
          platform: 'jtl',
          success: false,
          error: errMsg,
        });
      }
    }

    // Update product sync status
    const allSuccess = results.every(r => r.success);
    await this.prisma.product.update({
      where: { id: productId },
      data: {
        syncStatus: allSuccess ? 'SYNCED' : 'ERROR',
        lastSyncedAt: allSuccess ? new Date() : undefined,
        syncChecksum: allSuccess ? this.generateChecksum(product) : undefined,
      },
    });

    // Log the sync operation
    await this.logSyncOperation(productId, {
      action: 'updated',
      origin: this.mapOriginToEnum(origin),
      targetPlatform: 'all',
      changedFields: options.fieldsToSync || [],
      success: allSuccess,
    });

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    this.logger.info({
      jobId,
      event: 'push_completed',
      productId,
      sku: product.sku,
      duration: Date.now() - startTime,
      totalPlatforms: results.length,
      successCount,
      failedCount,
      allSuccess,
      platforms: results.map(r => ({ platform: r.platform, success: r.success }))
    });

    return {
      success: allSuccess,
      action: 'updated',
      productId,
      externalIds: Object.fromEntries(
        results.filter(r => r.externalId).map(r => [r.platform, r.externalId])
      ),
      syncedPlatforms: results.filter(r => r.success).map(r => r.platform),
      skippedPlatforms: skipPlatforms,
      error: allSuccess
        ? undefined
        : results.find(r => !r.success)?.error || 'One or more platform sync operations failed',
    };
  }

  /**
   * Sync stock/inventory only to a specific channel
   * Uses dedicated inventory APIs (not full product updates)
   * This is more reliable and efficient for stock-only changes
   */
  async syncStockToChannel(
    productId: string,
    channelId: string,
    options: {
      available?: number;
      reserved?: number;
    } = {}
  ): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    const jobId = generateJobId('stock-sync');

    this.logger.debug({ jobId, event: 'stock_sync_started', productId, channelId });

    try {
      // Get product with channel info
      const productChannel = await this.prisma.productChannel.findFirst({
        where: {
          productId,
          channelId,
          syncEnabled: true,
          isActive: true,
        },
        include: {
          product: {
            select: {
              id: true,
              sku: true,
              available: true,
              reserved: true,
            },
          },
          channel: true,
        },
      });

      if (!productChannel) {
        this.logger.debug({
          jobId,
          event: 'stock_sync_no_active_channel',
          productId,
          channelId,
        });
        return { success: true }; // Not an error, just no channel to sync to
      }

      if (!productChannel.externalProductId) {
        this.logger.warn({
          event: 'stock_sync_pending_product_push',
          reason: 'missing_external_id',
          productId,
          channelId,
          sku: productChannel.product.sku,
        });

        await this.prisma.productChannel.update({
          where: { id: productChannel.id },
          data: {
            lastError: 'Product not yet pushed to channel - stock sync pending',
            lastErrorAt: new Date(),
            syncStatus: 'PENDING',
          },
        });

        return {
          success: false,
          error: 'Product not yet pushed to channel - will retry',
        };
      }

      const stockToSync = options.available ?? productChannel.product.available;
      const encryptionService = getEncryptionService();

      if (productChannel.channel.type === 'SHOPIFY') {
        await this.syncStockToShopify(
          productChannel.externalProductId,
          productChannel.channel.shopDomain,
          productChannel.channel.accessToken,
          stockToSync,
          encryptionService
        );
      } else if (productChannel.channel.type === 'WOOCOMMERCE') {
        await this.syncStockToWooCommerce(
          productChannel.externalProductId,
          productChannel.channel.apiUrl,
          productChannel.channel.apiClientId,
          productChannel.channel.apiClientSecret,
          stockToSync,
          encryptionService
        );
      }

      // Update last sync time
      await this.prisma.productChannel.update({
        where: { id: productChannel.id },
        data: { lastSyncAt: new Date() },
      });

      // Clear any previous errors on success
      await this.prisma.productChannel.update({
        where: { id: productChannel.id },
        data: {
          syncStatus: 'SYNCED',
          lastError: null,
          lastErrorAt: null,
        },
      });

      this.logger.info({
        jobId,
        event: 'stock_sync_completed',
        productId,
        channelId,
        channelType: productChannel.channel.type,
        stockSynced: stockToSync,
        duration: Date.now() - startTime,
      });

      return { success: true };
    } catch (error) {
      const errorMessage = extractErrorMessage(error);
      this.logger.error({
        jobId,
        event: 'stock_sync_failed',
        productId,
        channelId,
        error: errorMessage,
        duration: Date.now() - startTime,
      });

      // Track error on ProductChannel
      await this.prisma.productChannel.updateMany({
        where: { productId, channelId },
        data: {
          lastError: errorMessage,
          lastErrorAt: new Date(),
          syncStatus: 'ERROR',
        },
      }).catch(() => {});

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Sync stock to Shopify using the Inventory API
   */
  private async syncStockToShopify(
    externalProductId: string | null,
    shopDomain: string | null,
    accessToken: string | null,
    available: number,
    encryptionService: ReturnType<typeof getEncryptionService>
  ): Promise<void> {
    if (!shopDomain || !accessToken || !externalProductId) {
      throw new Error('Missing Shopify credentials or product ID');
    }

    // Use REST service directly for inventory operations
    const { ShopifyService } = await import('./shopify.service.js');
    const shopifyService = new ShopifyService({
      shopDomain,
      accessToken: encryptionService.safeDecrypt(accessToken),
    });

    // Get the product to find inventory item ID
    const productId = parseInt(externalProductId);
    const product = await shopifyService.getProduct(productId);
    
    if (!product?.variants?.[0]?.inventory_item_id) {
      throw new Error('Cannot find inventory_item_id for Shopify product');
    }

    const inventoryItemId = product.variants[0].inventory_item_id;
    
    // Get first location
    const locations = await shopifyService.getLocations();
    if (!locations || locations.length === 0) {
      throw new Error('No Shopify locations found');
    }
    const locationId = locations[0].id;

    // Set inventory level
    await shopifyService.setInventoryLevel(inventoryItemId, locationId, available);

    this.logger.info({
      event: 'shopify_inventory_updated',
      productId: externalProductId,
      inventoryItemId,
      locationId,
      available,
    });

    // Verify the update took effect
    const verifyProduct = await shopifyService.getProduct(productId);
    const actualQuantity = verifyProduct?.variants?.[0]?.inventory_quantity;
    if (actualQuantity !== undefined && actualQuantity !== available) {
      this.logger.error({
        event: 'shopify_inventory_verification_failed',
        expected: available,
        actual: actualQuantity,
        productId: externalProductId,
      });
      throw new Error(`Inventory verification failed: expected ${available}, got ${actualQuantity}`);
    }
  }

  /**
   * Sync stock to WooCommerce using the product stock API
   */
  private async syncStockToWooCommerce(
    externalProductId: string | null,
    apiUrl: string | null,
    apiClientId: string | null,
    apiClientSecret: string | null,
    available: number,
    encryptionService: ReturnType<typeof getEncryptionService>
  ): Promise<void> {
    if (!apiUrl || !apiClientId || !apiClientSecret || !externalProductId) {
      throw new Error('Missing WooCommerce credentials or product ID');
    }

    const wooService = new WooCommerceService({
      url: apiUrl,
      consumerKey: encryptionService.safeDecrypt(apiClientId),
      consumerSecret: encryptionService.safeDecrypt(apiClientSecret),
    });

    const productId = parseInt(externalProductId);
    const result = await wooService.updateProductStock(productId, available, true);

    this.logger.info({
      event: 'woocommerce_stock_updated',
      productId: externalProductId,
      stockQuantity: available,
    });

    if (result?.stock_quantity != null && result.stock_quantity !== available) {
      this.logger.error({
        event: 'woocommerce_stock_verification_failed',
        expected: available,
        actual: result.stock_quantity,
        productId: externalProductId,
      });
      throw new Error(`Stock verification failed: expected ${available}, got ${result.stock_quantity}`);
    }
  }

  /**
   * Build safe image payloads for commerce APIs.
   * Ensures `src` and `alt` are strings and removes invalid/duplicate URLs.
   */
  private static isValidImageUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  private buildPlatformImages(
    images: Array<{ url?: unknown; altText?: unknown }> | null | undefined,
    primaryImageUrl: unknown
  ): Array<{ src: string; alt: string }> {
    const normalizedImages: Array<{ src: string; alt: string }> = [];
    const seen = new Set<string>();

    for (const image of images || []) {
      if (typeof image?.url !== 'string') continue;
      const src = image.url.trim();
      if (!src || seen.has(src) || !ProductSyncService.isValidImageUrl(src)) continue;

      const alt = typeof image.altText === 'string' ? image.altText : '';
      normalizedImages.push({ src, alt });
      seen.add(src);
    }

    if (typeof primaryImageUrl === 'string') {
      const primarySrc = primaryImageUrl.trim();
      if (primarySrc && !seen.has(primarySrc) && ProductSyncService.isValidImageUrl(primarySrc)) {
        normalizedImages.unshift({ src: primarySrc, alt: '' });
      }
    }

    return normalizedImages;
  }

  /**
   * Push product to Shopify
   */
  private async pushToShopify(
    product: {
      id: string;
      name: string;
      description: string | null;
      sku: string;
      gtin: string | null;
      netSalesPrice: Decimal | null;
      compareAtPrice: Decimal | null;
      available: number;
      weightInKg: Decimal | null;
      imageUrl: string | null;
      isActive: boolean;
      tags: string[];
      productType: string | null;
      vendor: string | null;
      images?: Array<{ url: string; altText: string | null; sortOrder: number }>;
    },
    productChannel: {
      id: string;
      externalProductId: string | null;
      channel: {
        shopDomain: string | null;
        accessToken: string | null;
      };
    },
    fieldsToSync?: string[]
  ): Promise<string | undefined> {
    if (!productChannel.channel.shopDomain || !productChannel.channel.accessToken) {
      throw new Error('Missing Shopify credentials');
    }

    const encryptionService = getEncryptionService();
    const shopifyService = createShopifyServiceAuto({
      shopDomain: productChannel.channel.shopDomain,
      accessToken: encryptionService.safeDecrypt(productChannel.channel.accessToken),
    });

    const price = product.netSalesPrice ? Number(product.netSalesPrice) : 0;
    const compareAtPrice = product.compareAtPrice ? Number(product.compareAtPrice) : undefined;
    const weight = product.weightInKg ? Number(product.weightInKg) * 1000 : undefined; // Convert kg to g

    // Build update payload respecting fieldsToSync
    const shopifyData: Record<string, unknown> = {};
    
    if (!fieldsToSync || fieldsToSync.includes('name')) {
      shopifyData.title = product.name;
    }
    if (!fieldsToSync || fieldsToSync.includes('description')) {
      shopifyData.body_html = product.description || '';
    }
    if (!fieldsToSync || fieldsToSync.includes('productType')) {
      shopifyData.product_type = product.productType || '';
    }
    if (!fieldsToSync || fieldsToSync.includes('vendor')) {
      shopifyData.vendor = product.vendor || '';
    }
    if (!fieldsToSync || fieldsToSync.includes('tags')) {
      shopifyData.tags = product.tags.join(', ');
    }
    if (!fieldsToSync || fieldsToSync.includes('isActive')) {
      shopifyData.status = product.isActive ? 'active' : 'draft';
    }

    // Variant data
    const variantData: Record<string, unknown> = {
      sku: product.sku,
      barcode: product.gtin || undefined,
    };
    
    if (!fieldsToSync || fieldsToSync.includes('netSalesPrice')) {
      variantData.price = String(price);
    }
    if (!fieldsToSync || fieldsToSync.includes('compareAtPrice') && compareAtPrice) {
      variantData.compare_at_price = String(compareAtPrice);
    }
    if (!fieldsToSync || fieldsToSync.includes('weightInKg')) {
      variantData.weight = weight;
      variantData.weight_unit = 'g';
    }
    if (!fieldsToSync || fieldsToSync.includes('available')) {
      variantData.inventory_quantity = product.available;
    }

    shopifyData.variants = [variantData];

    // Images
    if (!fieldsToSync || fieldsToSync.includes('imageUrl') || fieldsToSync.includes('images')) {
      const images = this.buildPlatformImages(product.images, product.imageUrl);
      if (images.length > 0) {
        shopifyData.images = images;
      }
    }

    if (productChannel.externalProductId) {
      // Update existing
      const result = await shopifyService.updateProduct(
        parseInt(productChannel.externalProductId),
        shopifyData
      );
      return String(result.id);
    } else {
      // Create new
      shopifyData.status = product.isActive ? 'active' : 'draft';
      (shopifyData.variants as Record<string, unknown>[])[0].inventory_management = 'shopify';
      
      const result = await shopifyService.createProduct(shopifyData as any);
      return String(result.id);
    }
  }

  /**
   * Push product to WooCommerce
   */
  private async pushToWooCommerce(
    product: {
      id: string;
      name: string;
      description: string | null;
      sku: string;
      gtin: string | null;
      netSalesPrice: Decimal | null;
      compareAtPrice: Decimal | null;
      available: number;
      weightInKg: Decimal | null;
      imageUrl: string | null;
      isActive: boolean;
      tags: string[];
      images?: Array<{ url: string; altText: string | null }>;
    },
    productChannel: {
      id: string;
      externalProductId: string | null;
      channel: {
        apiUrl: string | null;
        apiClientId: string | null;
        apiClientSecret: string | null;
      };
    },
    fieldsToSync?: string[]
  ): Promise<string | undefined> {
    if (!productChannel.channel.apiUrl || !productChannel.channel.apiClientId || !productChannel.channel.apiClientSecret) {
      throw new Error('Missing WooCommerce credentials');
    }

    const encryptionService = getEncryptionService();
    const wooService = new WooCommerceService({
      url: productChannel.channel.apiUrl,
      consumerKey: encryptionService.safeDecrypt(productChannel.channel.apiClientId),
      consumerSecret: encryptionService.safeDecrypt(productChannel.channel.apiClientSecret),
    });

    const price = product.netSalesPrice ? Number(product.netSalesPrice) : 0;
    const salePrice = product.compareAtPrice && product.netSalesPrice && 
                      Number(product.compareAtPrice) > Number(product.netSalesPrice)
                      ? Number(product.netSalesPrice) : undefined;
    const regularPrice = salePrice 
                         ? Number(product.compareAtPrice)
                         : price;
    const weight = product.weightInKg ? String(product.weightInKg) : undefined;

    // Build update payload
    const wooData: Record<string, unknown> = {};
    
    if (!fieldsToSync || fieldsToSync.includes('name')) {
      wooData.name = product.name;
    }
    if (!fieldsToSync || fieldsToSync.includes('description')) {
      wooData.description = product.description || '';
    }
    if (!fieldsToSync || fieldsToSync.includes('netSalesPrice')) {
      wooData.regular_price = String(regularPrice);
      if (salePrice) {
        wooData.sale_price = String(salePrice);
      }
    }
    if (!fieldsToSync || fieldsToSync.includes('available')) {
      wooData.manage_stock = true;
      wooData.stock_quantity = product.available;
    }
    if (!fieldsToSync || fieldsToSync.includes('weightInKg')) {
      wooData.weight = weight;
    }
    if (!fieldsToSync || fieldsToSync.includes('isActive')) {
      wooData.status = product.isActive ? 'publish' : 'draft';
    }
    if (!fieldsToSync || fieldsToSync.includes('tags')) {
      wooData.tags = product.tags.map(t => ({ name: t }));
    }

    // SKU and GTIN
    wooData.sku = product.sku;
    if (product.gtin) {
      wooData.meta_data = wooData.meta_data || [];
      (wooData.meta_data as Array<{key: string; value: string}>).push({ key: '_gtin', value: product.gtin });
    }

    // Images
    if (!fieldsToSync || fieldsToSync.includes('imageUrl') || fieldsToSync.includes('images')) {
      const images = this.buildPlatformImages(product.images, product.imageUrl);
      if (images.length > 0) {
        wooData.images = images;
      }
    }

    if (productChannel.externalProductId) {
      // Update existing
      const wooProductId = parseInt(productChannel.externalProductId);
      try {
        const result = await wooService.updateProduct(wooProductId, wooData);
        return String(result.id);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!errorMsg.includes('invalid_image_id')) throw error;

        // Image error: retry without our images
        this.logger.warn({ event: 'woo_image_retry_without_images', sku: product.sku, error: errorMsg });
        delete wooData.images;
        try {
          const result = await wooService.updateProduct(wooProductId, wooData);
          return String(result.id);
        } catch (retryError: unknown) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          if (!retryMsg.includes('invalid_image_id')) throw retryError;

          // WooCommerce product itself has a broken image — clear all images
          this.logger.warn({ event: 'woo_clearing_broken_images', sku: product.sku });
          wooData.images = [];
          const result = await wooService.updateProduct(wooProductId, wooData);
          return String(result.id);
        }
      }
    } else {
      // Create new
      wooData.type = 'simple';
      wooData.status = product.isActive ? 'publish' : 'draft';

      const result = await wooService.createProduct(wooData as any);
      return String(result.id);
    }
  }

  /**
   * Push product to JTL-FFN
   */
  private async pushToJTL(
    product: {
      id: string;
      name: string;
      description: string | null;
      sku: string;
      gtin: string | null;
      han: string | null;
      netSalesPrice: Decimal | null;
      available: number;
      weightInKg: Decimal | null;
      heightInCm: Decimal | null;
      lengthInCm: Decimal | null;
      widthInCm: Decimal | null;
      customsCode: string | null;
      countryOfOrigin: string | null;
      imageUrl: string | null;
      hazmat: boolean;
      hazmatClass: string | null;
      jtlProductId: string | null;
      isBundle?: boolean;
      bundleItems?: Array<{
        quantity: number;
        childProduct: {
          id: string;
          name: string;
          sku: string;
          gtin: string | null;
          jtlProductId: string | null;
        };
      }>;
    },
    jtlConfig: {
      clientId: string;
      clientSecret: string;
      accessToken: string | null;
      refreshToken: string | null;
      tokenExpiresAt: Date | null;
      fulfillerId: string;
      warehouseId: string;
      environment: string;
      clientId_fk: string;
    },
    fieldsToSync?: string[]
  ): Promise<string | undefined> {
    if (!jtlConfig.accessToken) {
      throw new Error('JTL not authenticated');
    }

    const encryptionService = getEncryptionService();
    const jtlService = new JTLService({
      clientId: jtlConfig.clientId,
      clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
      accessToken: encryptionService.safeDecrypt(jtlConfig.accessToken),
      refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
      tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
      fulfillerId: jtlConfig.fulfillerId,
      warehouseId: jtlConfig.warehouseId,
      environment: jtlConfig.environment as 'sandbox' | 'production',
    }, this.prisma, jtlConfig.clientId_fk);

    // Build identifier object (matches n8n workflow structure)
    const identifier = {
      ean: product.gtin || product.sku || null,
      han: product.han || null,
    };

    // Build attributes for platform tracking
    const attributes = [
      {
        key: 'platform',
        value: 'internal', // From product sync service
      },
    ];

    // Check if product already exists in JTL (has jtlProductId)
    if (product.jtlProductId) {
      // Product already exists in JTL - UPDATE it using PATCH
      console.log(`[ProductSync] Updating existing JTL product ${product.jtlProductId} (SKU: ${product.sku})`);

      const updateResult = await jtlService.updateProduct(product.jtlProductId, {
        name: product.name,
        description: product.description || undefined,
        netWeight: product.weightInKg ? Number(product.weightInKg) : undefined,
        height: product.heightInCm ? Number(product.heightInCm) / 100 : undefined,
        length: product.lengthInCm ? Number(product.lengthInCm) / 100 : undefined,
        width: product.widthInCm ? Number(product.widthInCm) / 100 : undefined,
        identifier: {
          ean: product.gtin || undefined,
          han: product.han || undefined,
        },
        ...(product.isBundle && product.bundleItems && product.bundleItems.length > 0 ? {
          specifications: {
            billOfMaterialsComponents: product.bundleItems.map(bi => ({
              ...(bi.childProduct.jtlProductId
                ? { jfsku: bi.childProduct.jtlProductId }
                : { merchantSku: bi.childProduct.sku }),
              quantity: bi.quantity,
            })),
          },
        } : {}),
      });

      if (updateResult.success) {
        console.log(`[ProductSync] Successfully updated JTL product ${product.jtlProductId}`);
        return product.jtlProductId;
      } else {
        throw new Error(updateResult.error || 'Failed to update product in JTL');
      }
    }

    // No local jtlProductId - check if product already exists in JTL by SKU
    console.log(`[ProductSync] Checking if product ${product.sku} already exists in JTL...`);
    const existingJtlProduct = await jtlService.getProductByMerchantSku(product.sku);

    if (existingJtlProduct) {
      // Product exists in JTL but we didn't have the JFSKU locally - update our DB and return
      console.log(`[ProductSync] Found existing JTL product ${existingJtlProduct.jfsku} for SKU: ${product.sku} - linking to local product`);

      await this.prisma.product.update({
        where: { id: product.id },
        data: {
          jtlProductId: existingJtlProduct.jfsku,
          jtlSyncStatus: 'SYNCED',
          lastJtlSync: new Date(),
        },
      });

      return existingJtlProduct.jfsku;
    }

    // Pre-sync: resolve child product JTL IDs for bundles
    if (product.isBundle && product.bundleItems && product.bundleItems.length > 0) {
      for (const bi of product.bundleItems) {
        if (!bi.childProduct.jtlProductId) {
          const existing = await jtlService.getProductByMerchantSku(bi.childProduct.sku);
          if (existing) {
            await this.prisma.product.update({
              where: { id: bi.childProduct.id },
              data: { jtlProductId: existing.jfsku, jtlSyncStatus: 'SYNCED', lastJtlSync: new Date() },
            });
            bi.childProduct.jtlProductId = existing.jfsku;
            console.log(`[ProductSync] Resolved child product ${bi.childProduct.sku} → ${existing.jfsku}`);
          }
        }
      }
    }

    // Product doesn't exist in JTL yet - CREATE it
    console.log(`[ProductSync] Creating new JTL product for SKU: ${product.sku}`);

    const jtlProduct = {
      name: product.name,
      merchantSku: product.sku,
      identifier: identifier, // Singular object
      description: product.description || null,
      weight: product.weightInKg ? Number(product.weightInKg) : 0.1,
      height: product.heightInCm ? Number(product.heightInCm) / 100 : 0.01, // Convert cm to m
      length: product.lengthInCm ? Number(product.lengthInCm) / 100 : 0.01,
      width: product.widthInCm ? Number(product.widthInCm) / 100 : 0.01,
      customsCode: product.customsCode || undefined,
      countryOfOrigin: product.countryOfOrigin || undefined,
      imageUrl: product.imageUrl || undefined,
      attributes: attributes,
      ...(product.isBundle && product.bundleItems && product.bundleItems.length > 0 ? {
        specifications: {
          isBillOfMaterials: true,
          billOfMaterialsComponents: product.bundleItems.map(bi => ({
            ...(bi.childProduct.jtlProductId
              ? { jfsku: bi.childProduct.jtlProductId }
              : { merchantSku: bi.childProduct.sku }),
            quantity: bi.quantity,
          })),
          isBatch: false,
          isBestBefore: false,
          isDivisible: false,
          isPackaging: false,
          isSerialNumber: false,
        },
      } : {}),
    };

    try {
      const result = await jtlService.createProduct(jtlProduct);
      console.log(`[ProductSync] Successfully created JTL product ${result.jfsku} for SKU: ${product.sku}`);
      return result.jfsku;
    } catch (error) {
      // Auto-fix duplicate product errors by extracting JFSKU from error response
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Products_DuplicateProduct') || errorMessage.includes('DuplicateProduct')) {
        // Parse: {"errorMetaData":{"MerchantSku":"05.190.00..0001","Jfsku":"6EN701UK6QH"}}
        const jfskuMatch = errorMessage.match(/"Jfsku":"([A-Z0-9]+)"/i);
        if (jfskuMatch) {
          const jfsku = jfskuMatch[1];
          console.log(`[ProductSync] Auto-fixed duplicate: ${product.sku} → ${jfsku}`);

          // Update local product with extracted JFSKU
          await this.prisma.product.update({
            where: { id: product.id },
            data: {
              jtlProductId: jfsku,
              jtlSyncStatus: 'SYNCED',
              lastJtlSync: new Date(),
            },
          });

          return jfsku;
        }
      }
      // Re-throw if not a duplicate error or couldn't extract JFSKU
      throw error;
    }
  }

  // ============= JOB QUEUE MANAGEMENT =============

  /**
   * Queue sync jobs to other platforms after an update
   */
  async queueSyncToOtherPlatforms(
    productId: string,
    triggerOrigin: SyncOriginType,
    triggerEventId?: string
  ): Promise<void> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        channels: {
          where: { syncEnabled: true, isActive: true },
          include: { channel: true },
        },
        client: {
          include: { jtlConfig: true },
        },
      },
    });

    if (!product) return;

    const jobs: Array<{
      productId: string;
      operation: string;
      triggerOrigin: SyncOrigin;
      triggerEventId: string | null;
      channelId: string | null;
      priority: number;
      status: string;
      scheduledFor: Date;
    }> = [];

    // Queue jobs for each channel except the trigger origin
    for (const pc of product.channels) {
      const channelType = pc.channel.type.toLowerCase();
      if (channelType === triggerOrigin) continue;

      const operation = channelType === 'shopify' 
        ? 'push_to_shopify' 
        : channelType === 'woocommerce' 
          ? 'push_to_woocommerce' 
          : null;

      if (operation) {
        jobs.push({
          productId,
          operation,
          triggerOrigin: this.mapOriginToEnum(triggerOrigin),
          triggerEventId: triggerEventId || null,
          channelId: pc.channelId,
          priority: 0,
          status: 'pending',
          scheduledFor: new Date(),
        });
      }
    }

    // Queue JTL sync if configured and not the trigger
    if (product.client.jtlConfig && triggerOrigin !== 'jtl') {
      jobs.push({
        productId,
        operation: 'push_to_jtl',
        triggerOrigin: this.mapOriginToEnum(triggerOrigin),
        triggerEventId: triggerEventId || null,
        channelId: null,
        priority: 0,
        status: 'pending',
        scheduledFor: new Date(),
      });
    }

    // Batch insert jobs
    if (jobs.length > 0) {
      await this.prisma.productSyncQueue.createMany({
        data: jobs,
        skipDuplicates: true,
      });
    }
  }

  /**
   * Process pending sync jobs (called by scheduler)
   */
  async processSyncQueue(batchSize: number = 10): Promise<number> {
    // Get pending jobs
    const jobs = await this.prisma.productSyncQueue.findMany({
      where: {
        status: 'pending',
        scheduledFor: { lte: new Date() },
        attempts: { lt: 3 },
      },
      orderBy: [
        { priority: 'desc' },
        { scheduledFor: 'asc' },
      ],
      take: batchSize,
      include: { product: true },
    });

    let processed = 0;

    for (const job of jobs) {
      try {
        // Mark as processing
        await this.prisma.productSyncQueue.update({
          where: { id: job.id },
          data: {
            status: 'processing',
            startedAt: new Date(),
            attempts: { increment: 1 },
          },
        });

        // Execute the sync
        const skipPlatform = this.mapEnumToOrigin(job.triggerOrigin);
        await this.pushProductToAllPlatforms(job.productId, 'system', {
          skipPlatforms: skipPlatform ? [skipPlatform] : [],
        });

        // Mark as completed
        await this.prisma.productSyncQueue.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
          },
        });

        processed++;
      } catch (error) {
        console.error(`[ProductSync] Queue job ${job.id} failed:`, error);
        
        await this.prisma.productSyncQueue.update({
          where: { id: job.id },
          data: {
            status: job.attempts >= 2 ? 'failed' : 'pending',
            lastError: extractErrorMessage(error),
            scheduledFor: new Date(Date.now() + 5 * 60 * 1000), // Retry in 5 minutes
          },
        });
      }
    }

    return processed;
  }

  // ============= HELPER METHODS =============

  /**
   * Check if incoming webhook is an echo of our own update
   */
  private async isEchoFromOurUpdate(
    externalId: string,
    origin: SyncOriginType,
    channelId: string
  ): Promise<boolean> {
    // Check if we recently pushed to this platform for this product
    const recentSync = await this.prisma.productSyncLog.findFirst({
      where: {
        externalId,
        targetPlatform: origin,
        createdAt: { gte: new Date(Date.now() - 60 * 1000) }, // Within last minute
        success: true,
        action: { in: ['created', 'updated'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (recentSync) {
      console.log(`[ProductSync] Echo detected - our sync at ${recentSync.createdAt}`);
      return true;
    }

    // Also check the ProductChannel checksum
    const productChannel = await this.prisma.productChannel.findFirst({
      where: {
        channelId,
        externalProductId: externalId,
      },
      include: { product: true },
    });

    if (productChannel?.product) {
      // If last update was from nolimits/system within the window, likely an echo
      if (
        productChannel.product.lastUpdatedBy !== this.mapOriginToEnum(origin) &&
        productChannel.product.updatedAt > new Date(Date.now() - 30 * 1000)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find product by external ID or SKU
   */
  private async findProductByExternalIdOrSku(
    clientId: string,
    channelId: string,
    externalId: string,
    sku?: string
  ) {
    // First try by external ID in ProductChannel
    const byExternalId = await this.prisma.productChannel.findFirst({
      where: {
        channelId,
        externalProductId: externalId,
      },
      include: { product: true },
    });

    if (byExternalId) {
      return byExternalId.product;
    }

    // Try by SKU if provided
    if (sku) {
      return this.prisma.product.findFirst({
        where: { clientId, sku },
      });
    }

    return null;
  }

  /**
   * Prepare field updates respecting ownership rules
   */
  private prepareFieldUpdates(
    existingProduct: {
      id: string;
      name: string;
      description: string | null;
      netSalesPrice: Decimal | null;
      lastUpdatedBy: SyncOrigin;
      updatedAt: Date;
      lastFieldUpdates: Prisma.JsonValue;
    } | null,
    incomingData: IncomingProductData,
    origin: SyncOriginType
  ): { updates: Record<string, unknown>; conflicts: FieldConflict[] } {
    const updates: Record<string, unknown> = {};
    const conflicts: FieldConflict[] = [];

    const isCommerceOrigin = origin === 'shopify' || origin === 'woocommerce';
    const isOpsOrigin = origin === 'nolimits' || origin === 'jtl';

    // Map incoming data to our field names
    const fieldMapping: Record<string, { value: unknown; ownership: 'commerce' | 'ops' | 'shared' | 'stock' }> = {
      name: { value: incomingData.name, ownership: 'shared' },
      description: { value: incomingData.description, ownership: 'shared' },
      netSalesPrice: { value: incomingData.price, ownership: 'commerce' },
      compareAtPrice: { value: incomingData.compareAtPrice, ownership: 'commerce' },
      taxable: { value: incomingData.taxable, ownership: 'commerce' },
      tags: { value: incomingData.tags, ownership: 'commerce' },
      collections: { value: incomingData.collections, ownership: 'commerce' },
      productType: { value: incomingData.productType, ownership: 'commerce' },
      vendor: { value: incomingData.vendor, ownership: 'commerce' },
      seoTitle: { value: incomingData.seoTitle, ownership: 'commerce' },
      seoDescription: { value: incomingData.seoDescription, ownership: 'commerce' },
      isBundle: { value: incomingData.isBundle, ownership: 'commerce' },  // Bundle status defined by commerce platform
      bundlePrice: { value: incomingData.isBundle ? incomingData.price : undefined, ownership: 'commerce' },  // Bundle price from commerce platform
      sku: { value: incomingData.sku, ownership: 'ops' },
      gtin: { value: incomingData.gtin, ownership: 'ops' },
      weightInKg: { value: this.normalizeWeight(incomingData.weight, incomingData.weightUnit), ownership: 'ops' },
      heightInCm: { value: incomingData.height, ownership: 'ops' },
      lengthInCm: { value: incomingData.length, ownership: 'ops' },
      widthInCm: { value: incomingData.width, ownership: 'ops' },
      imageUrl: { value: incomingData.imageUrl, ownership: 'shared' },
      isActive: { value: incomingData.isActive, ownership: 'shared' },
      available: { value: incomingData.quantity, ownership: 'stock' },
    };

    for (const [field, { value, ownership }] of Object.entries(fieldMapping)) {
      if (value === undefined) continue;

      let shouldUpdate = false;
      let conflictReason = '';

      // Apply ownership rules
      if (ownership === 'commerce' && isCommerceOrigin) {
        // Commerce platform updating commerce fields - always allow
        shouldUpdate = true;
      } else if (ownership === 'ops' && isOpsOrigin) {
        // Ops platform updating ops fields - always allow
        shouldUpdate = true;
      } else if (ownership === 'shared') {
        // Shared fields - last write wins, but check for conflicts
        if (existingProduct) {
          const lastUpdate = existingProduct.updatedAt;
          const timeSinceUpdate = Date.now() - lastUpdate.getTime();
          
          // If updated within conflict window and from different origin
          if (timeSinceUpdate < this.conflictWindowMinutes * 60 * 1000 &&
              existingProduct.lastUpdatedBy !== this.mapOriginToEnum(origin)) {
            // Potential conflict - log it but accept last write
            conflicts.push({
              field,
              localValue: (existingProduct as Record<string, unknown>)[field],
              incomingValue: value,
              incomingOrigin: origin,
              resolution: 'accepted',
              reason: 'Last-write-wins for shared field',
            });
          }
        }
        shouldUpdate = true;
      } else if (ownership === 'stock') {
        // Stock fields - only allow from ops/jtl origins
        if (isOpsOrigin) {
          shouldUpdate = true;
        } else {
          // Commerce platforms shouldn't update stock
          conflictReason = 'Stock managed by warehouse/JTL';
        }
      } else {
        // Wrong origin trying to update restricted field
        conflictReason = `${ownership} fields can only be updated by ${ownership === 'commerce' ? 'Shopify/WooCommerce' : 'No-Limits/JTL'}`;
      }

      if (shouldUpdate) {
        updates[field] = value;
      } else if (conflictReason && existingProduct) {
        conflicts.push({
          field,
          localValue: (existingProduct as Record<string, unknown>)[field],
          incomingValue: value,
          incomingOrigin: origin,
          resolution: 'rejected',
          reason: conflictReason,
        });
      }
    }

    return { updates, conflicts };
  }

  /**
   * Log a sync operation
   */
  private async logSyncOperation(
    productId: string,
    data: {
      action: string;
      origin: SyncOrigin;
      targetPlatform: string;
      changedFields: string[];
      oldValues?: Record<string, unknown>;
      newValues?: Record<string, unknown>;
      success: boolean;
      errorMessage?: string;
      externalId?: string;
    }
  ): Promise<void> {
    await this.prisma.productSyncLog.create({
      data: {
        productId,
        action: data.action,
        origin: data.origin,
        targetPlatform: data.targetPlatform,
        changedFields: data.changedFields,
        oldValues: data.oldValues as any,
        newValues: data.newValues as any,
        success: data.success,
        errorMessage: data.errorMessage,
        externalId: data.externalId,
      },
    });
  }

  /**
   * Generate checksum for change detection
   */
  private generateChecksum(product: Record<string, unknown>): string {
    const relevantFields = [
      'name', 'description', 'sku', 'gtin', 'netSalesPrice',
      'available', 'weightInKg', 'imageUrl', 'isActive',
    ];
    
    const data = relevantFields.map(f => product[f]).join('|');
    return crypto.createHash('md5').update(data).digest('hex');
  }

  /**
   * Normalize weight to kg
   */
  private normalizeWeight(weight?: number, unit?: string): number | null {
    if (weight === undefined || weight === null) return null;
    
    switch (unit) {
      case 'g':
        return weight / 1000;
      case 'lb':
        return weight * 0.453592;
      case 'oz':
        return weight * 0.0283495;
      case 'kg':
      default:
        return weight;
    }
  }

  /**
   * Map string origin to enum
   */
  private mapOriginToEnum(origin: SyncOriginType): SyncOrigin {
    switch (origin) {
      case 'shopify':
        return 'SHOPIFY';
      case 'woocommerce':
        return 'WOOCOMMERCE';
      case 'jtl':
        return 'JTL';
      case 'system':
        return 'SYSTEM';
      case 'nolimits':
      default:
        return 'NOLIMITS';
    }
  }

  /**
   * Map enum to string origin
   */
  private mapEnumToOrigin(origin: SyncOrigin): SyncOriginType | null {
    switch (origin) {
      case 'SHOPIFY':
        return 'shopify';
      case 'WOOCOMMERCE':
        return 'woocommerce';
      case 'JTL':
        return 'jtl';
      case 'NOLIMITS':
        return 'nolimits';
      case 'SYSTEM':
        return 'system';
      default:
        return null;
    }
  }

  // ============= CONFLICT RESOLUTION =============

  /**
   * Get products with conflicts for manual review
   */
  async getProductsWithConflicts(clientId: string): Promise<Array<{
    product: { id: string; name: string; sku: string };
    conflicts: FieldConflict[];
    lastUpdatedBy: string;
    lastUpdatedAt: Date;
  }>> {
    const products = await this.prisma.product.findMany({
      where: {
        clientId,
        syncStatus: 'CONFLICT',
      },
      select: {
        id: true,
        name: true,
        sku: true,
        lastUpdatedBy: true,
        updatedAt: true,
        syncLogs: {
          where: { action: 'conflict' },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    return products.map(p => ({
      product: { id: p.id, name: p.name, sku: p.sku },
      conflicts: [], // Would parse from syncLogs
      lastUpdatedBy: p.lastUpdatedBy,
      lastUpdatedAt: p.updatedAt,
    }));
  }

  /**
   * Manually resolve a conflict
   */
  async resolveConflict(
    productId: string,
    resolution: 'accept_local' | 'accept_remote' | 'merge',
    mergeData?: Record<string, unknown>
  ): Promise<ProductSyncResult> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });

    if (!product) {
      return {
        success: false,
        action: 'failed',
        productId,
        error: 'Product not found',
      };
    }

    if (resolution === 'accept_local') {
      // Keep local data, push to all platforms
      await this.pushProductToAllPlatforms(productId, 'nolimits');
    } else if (resolution === 'merge' && mergeData) {
      // Apply merged data
      await this.prisma.product.update({
        where: { id: productId },
        data: {
          ...mergeData,
          syncStatus: 'PENDING',
          lastUpdatedBy: 'NOLIMITS',
        },
      });
      await this.pushProductToAllPlatforms(productId, 'nolimits');
    }

    // Clear conflict status
    await this.prisma.product.update({
      where: { id: productId },
      data: { syncStatus: 'SYNCED' },
    });

    return {
      success: true,
      action: 'updated',
      productId,
      details: { resolution },
    };
  }

  // ============= FULL SYNC OPERATIONS =============

  /**
   * Perform a full sync for a client's products
   */
  async fullSyncForClient(clientId: string): Promise<{
    totalProducts: number;
    synced: number;
    failed: number;
    errors: string[];
  }> {
    const products = await this.prisma.product.findMany({
      where: { clientId, isActive: true },
      select: { id: true },
    });

    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const product of products) {
      const result = await this.pushProductToAllPlatforms(product.id, 'system');
      if (result.success) {
        synced++;
      } else {
        failed++;
        if (result.error) errors.push(`${product.id}: ${result.error}`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return {
      totalProducts: products.length,
      synced,
      failed,
      errors,
    };
  }

  // ============= GENERATED SKU DETECTION =============

  /**
   * Patterns that indicate a generated/placeholder SKU
   * These products need manual linking to existing JTL FFN products
   */
  private static GENERATED_SKU_PATTERNS = ['SHOP-', 'WOO-'];

  /**
   * Check if a SKU is a generated placeholder (SHOP-xxx or WOO-xxx)
   * Products with generated SKUs should NOT be auto-pushed to JTL FFN
   * as they likely need to be manually linked to existing JTL products
   */
  private isGeneratedSku(sku: string): boolean {
    return ProductSyncService.GENERATED_SKU_PATTERNS.some(pattern => sku.startsWith(pattern));
  }

  /**
   * Push products to JTL FFN ONLY (skip Shopify/WooCommerce)
   * Used during initial sync pipeline Step 3 to avoid Shopify 404 errors
   *
   * Only pushes products that:
   * 1. Don't have jtlProductId set (not already linked)
   * 2. Have real SKUs (not generated SHOP-xxx or WOO-xxx)
   *
   * Products with generated SKUs are skipped - they need manual linking
   */
  async pushToJTLOnly(clientId: string): Promise<{
    totalProducts: number;
    synced: number;
    skipped: number;
    skippedAlreadyLinked: number;
    skippedManualLink: number;
    failed: number;
    errors: string[];
  }> {
    console.log(`[ProductSync] Pushing products to JTL ONLY for client ${clientId} (skipping Shopify/WooCommerce)`);

    // Get products that aren't linked to JTL yet
    const allUnlinkedProducts = await this.prisma.product.findMany({
      where: {
        clientId,
        isActive: true,
        jtlProductId: null, // Only products not yet linked to JTL
      },
      select: { id: true, sku: true },
    });

    // Separate products with real SKUs from those with generated SKUs
    const productsToSync = allUnlinkedProducts.filter(p => !this.isGeneratedSku(p.sku));
    const productsNeedingManualLink = allUnlinkedProducts.filter(p => this.isGeneratedSku(p.sku));

    // Also count already linked products
    const linkedCount = await this.prisma.product.count({
      where: {
        clientId,
        isActive: true,
        jtlProductId: { not: null },
      },
    });

    console.log(`[ProductSync] Found ${allUnlinkedProducts.length} unlinked products:`);
    console.log(`[ProductSync]   - ${productsToSync.length} with real SKUs → will check JTL first`);
    console.log(`[ProductSync]   - ${productsNeedingManualLink.length} with generated SKUs (SHOP-xxx/WOO-xxx) → need manual linking`);
    console.log(`[ProductSync]   - ${linkedCount} already linked to JTL`);

    // Log which products need manual linking for visibility
    if (productsNeedingManualLink.length > 0) {
      console.log(`[ProductSync] Products needing manual linking:`);
      productsNeedingManualLink.slice(0, 10).forEach(p => {
        console.log(`[ProductSync]   - ${p.sku}`);
      });
      if (productsNeedingManualLink.length > 10) {
        console.log(`[ProductSync]   ... and ${productsNeedingManualLink.length - 10} more`);
      }
    }

    // Use filtered products list (only real SKUs)
    const products = productsToSync;

    let synced = 0;
    let skippedAlreadyLinked = 0;
    let failed = 0;
    const errors: string[] = [];

    // Fetch ALL JTL products for this client to check for existing ones
    // This prevents duplicate product creation errors
    let jtlProductMap = new Map<string, string>(); // merchantSku → jfsku
    try {
      const jtlConfig = await this.prisma.jtlConfig.findUnique({
        where: { clientId_fk: clientId },
      });

      if (jtlConfig && jtlConfig.isActive && jtlConfig.accessToken) {
        const encryptionService = getEncryptionService();
        const jtlService = new JTLService({
          clientId: jtlConfig.clientId,
          clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
          accessToken: encryptionService.safeDecrypt(jtlConfig.accessToken),
          refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
          tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
          fulfillerId: jtlConfig.fulfillerId,
          warehouseId: jtlConfig.warehouseId,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        }, this.prisma, clientId);

        console.log(`[ProductSync] Fetching existing JTL products to check for duplicates...`);
        const jtlProducts = await jtlService.getAllProductsWithStock();
        console.log(`[ProductSync] Found ${jtlProducts.length} products in JTL FFN`);

        for (const jp of jtlProducts) {
          if (jp.merchantSku) {
            jtlProductMap.set(jp.merchantSku, jp.jfsku);
          }
        }
        console.log(`[ProductSync] Built JTL product map with ${jtlProductMap.size} SKU mappings`);
      } else {
        console.log(`[ProductSync] Warning: No active JTL config found, will attempt push without pre-check`);
      }
    } catch (error) {
      console.log(`[ProductSync] Warning: Failed to fetch JTL products for pre-check:`, error);
      // Continue anyway - will fall back to old behavior with potential duplicate errors
    }

    for (const product of products) {
      // Check if product already exists in JTL by SKU
      const existingJfsku = jtlProductMap.get(product.sku);
      if (existingJfsku) {
        // Product already exists in JTL - just link it, don't create
        try {
          await this.prisma.product.update({
            where: { id: product.id },
            data: {
              jtlProductId: existingJfsku,
              jtlSyncStatus: 'SYNCED',
              lastJtlSync: new Date(),
            },
          });
          console.log(`[ProductSync] Linked existing JTL product: ${product.sku} → ${existingJfsku}`);
          skippedAlreadyLinked++;
          continue; // Skip the push
        } catch (linkError) {
          console.log(`[ProductSync] Failed to link existing product ${product.sku}:`, linkError);
          // Fall through to try pushing anyway
        }
      }

      // Product doesn't exist in JTL - push it
      const result = await this.pushProductToAllPlatforms(
        product.id,
        'system',
        { skipPlatforms: ['shopify', 'woocommerce'] }
      );

      if (result.success) {
        synced++;
        console.log(`[ProductSync] Pushed ${product.sku} to JTL`);
      } else {
        failed++;
        if (result.error) {
          errors.push(`${product.sku}: ${result.error}`);
          console.log(`[ProductSync] Failed to push ${product.sku}: ${result.error}`);
        }
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`[ProductSync] JTL-only push complete: ${synced} created, ${skippedAlreadyLinked} linked existing, ${failed} failed, ${linkedCount} skipped (already linked), ${productsNeedingManualLink.length} need manual linking`);

    return {
      totalProducts: allUnlinkedProducts.length + linkedCount,
      synced,
      skipped: linkedCount,
      skippedAlreadyLinked,
      skippedManualLink: productsNeedingManualLink.length,
      failed,
      errors,
    };
  }

  /**
   * Pull products FROM JTL FFN and update local database with jtlProductId
   * This resolves "duplicate product" errors by syncing JTL's existing products back to local DB
   */
  async pullProductsFromJTL(clientId: string): Promise<{
    totalJtlProducts: number;
    matched: number;
    updated: number;
    notFound: number;
    errors: string[];
  }> {
    console.log(`[ProductSync] Pulling products from JTL for client ${clientId}`);

    const result = {
      totalJtlProducts: 0,
      matched: 0,
      updated: 0,
      notFound: 0,
      errors: [] as string[],
    };

    try {
      // Get JTL config for this client
      const jtlConfig = await this.prisma.jtlConfig.findUnique({
        where: { clientId_fk: clientId },
      });

      if (!jtlConfig || !jtlConfig.isActive || !jtlConfig.accessToken) {
        result.errors.push('No active JTL configuration found');
        return result;
      }

      // Create JTL service
      const encryptionService = getEncryptionService();
      const jtlService = new JTLService({
        clientId: jtlConfig.clientId,
        clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
        accessToken: encryptionService.safeDecrypt(jtlConfig.accessToken),
        refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
        tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
        fulfillerId: jtlConfig.fulfillerId,
        warehouseId: jtlConfig.warehouseId,
        environment: jtlConfig.environment as 'sandbox' | 'production',
      }, this.prisma, clientId);

      // Fetch ALL products from JTL FFN
      console.log(`[ProductSync] Fetching all products from JTL FFN...`);
      const jtlProducts = await jtlService.getAllProductsWithStock();
      result.totalJtlProducts = jtlProducts.length;
      console.log(`[ProductSync] Found ${jtlProducts.length} products in JTL FFN`);

      // Get all local products for this client
      const localProducts = await this.prisma.product.findMany({
        where: { clientId },
        select: {
          id: true,
          sku: true,
          jtlProductId: true,
          jtlSyncStatus: true,
        },
      });

      // Create a map for fast lookup by SKU
      const localProductMap = new Map(localProducts.map(p => [p.sku, p]));

      // Match JTL products with local products by merchantSku (maps to our SKU)
      for (const jtlProduct of jtlProducts) {
        const localProduct = localProductMap.get(jtlProduct.merchantSku);

        if (!localProduct) {
          result.notFound++;
          console.log(`[ProductSync] JTL product ${jtlProduct.jfsku} (SKU: ${jtlProduct.merchantSku}) not found in local DB`);
          continue;
        }

        result.matched++;

        // Check if we need to update
        if (localProduct.jtlProductId !== jtlProduct.jfsku) {
          try {
            // Update local product with JTL product ID
            await this.prisma.product.update({
              where: { id: localProduct.id },
              data: {
                jtlProductId: jtlProduct.jfsku,
                jtlSyncStatus: 'SYNCED',
                lastJtlSync: new Date(),
              },
            });

            result.updated++;
            console.log(`[ProductSync] Updated product ${localProduct.sku} with jtlProductId: ${jtlProduct.jfsku}`);
          } catch (error) {
            result.errors.push(`Failed to update ${localProduct.sku}: ${extractErrorMessage(error)}`);
          }
        }
      }

      console.log(`[ProductSync] Pull complete: ${result.matched} matched, ${result.updated} updated, ${result.notFound} not found in local DB`);
      return result;
    } catch (error) {
      console.error(`[ProductSync] Error pulling products from JTL:`, error);
      result.errors.push(extractErrorMessage(error));
      return result;
    }
  }

  /**
   * Import products FROM JTL FFN that don't exist in local database
   * Creates new products locally WITHOUT syncing to sales channels
   * Use this for warehouse-only products or to populate dashboard inventory
   */
  async importProductsFromJTL(clientId: string): Promise<{
    totalJtlProducts: number;
    alreadyExists: number;
    imported: number;
    failed: number;
    errors: string[];
    importedProducts: Array<{ sku: string; name: string; jfsku: string }>;
  }> {
    console.log(`[ProductSync] Importing products from JTL for client ${clientId}`);

    const result = {
      totalJtlProducts: 0,
      alreadyExists: 0,
      imported: 0,
      failed: 0,
      errors: [] as string[],
      importedProducts: [] as Array<{ sku: string; name: string; jfsku: string }>,
    };

    try {
      // Get JTL config for this client
      const jtlConfig = await this.prisma.jtlConfig.findUnique({
        where: { clientId_fk: clientId },
      });

      if (!jtlConfig || !jtlConfig.isActive || !jtlConfig.accessToken) {
        result.errors.push('No active JTL configuration found');
        return result;
      }

      // Create JTL service
      const encryptionService = getEncryptionService();
      const jtlService = new JTLService({
        clientId: jtlConfig.clientId,
        clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
        accessToken: encryptionService.safeDecrypt(jtlConfig.accessToken),
        refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
        tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
        fulfillerId: jtlConfig.fulfillerId,
        warehouseId: jtlConfig.warehouseId,
        environment: jtlConfig.environment as 'sandbox' | 'production',
      }, this.prisma, clientId);

      // Fetch ALL products from JTL FFN (with stock info)
      console.log(`[ProductSync] Fetching all products from JTL FFN...`);
      const jtlProducts = await jtlService.getAllProductsWithStock();
      result.totalJtlProducts = jtlProducts.length;
      console.log(`[ProductSync] Found ${jtlProducts.length} products in JTL FFN`);

      // Get all existing local products for this client (including name and id for matching)
      const localProducts = await this.prisma.product.findMany({
        where: { clientId },
        select: { id: true, sku: true, name: true, jtlProductId: true },
      });
      const existingSkus = new Set(localProducts.map(p => p.sku));

      // Create a map of normalized names to products for matching
      // This helps link products pulled from Shopify (with SHOP-xxx SKUs) to JTL products
      const normalizeProductName = (name: string): string => {
        return name.toLowerCase().trim()
          .replace(/\s+/g, ' ')           // normalize whitespace
          .replace(/[^\w\s-]/g, '')       // remove special chars except hyphen
          .replace(/\s*-\s*default\s*title$/i, ''); // remove " - Default Title" suffix
      };

      const productsByNormalizedName = new Map<string, typeof localProducts[0]>();
      for (const product of localProducts) {
        // Only consider products that don't have JTL link yet AND have generated SKUs
        if (!product.jtlProductId && (product.sku.startsWith('SHOP-') || product.sku.startsWith('WOO-'))) {
          const normalizedName = normalizeProductName(product.name);
          productsByNormalizedName.set(normalizedName, product);
        }
      }

      let linked = 0;

      // Import products that don't exist locally OR link existing products by name
      for (const jtlProduct of jtlProducts) {
        const sku = jtlProduct.merchantSku;
        const jtlProductName = jtlProduct.name || `Product ${sku}`;

        // Case 1: SKU already exists in local DB - just update JTL link if missing
        if (existingSkus.has(sku)) {
          const existingProduct = localProducts.find(p => p.sku === sku);
          if (existingProduct && !existingProduct.jtlProductId) {
            // Link existing product to JTL
            await this.prisma.product.update({
              where: { id: existingProduct.id },
              data: {
                jtlProductId: jtlProduct.jfsku,
                jtlSyncStatus: 'SYNCED',
                lastJtlSync: new Date(),
                available: jtlProduct.stock?.stockLevel || 0,
                reserved: jtlProduct.stock?.stockLevelReserved || 0,
                announced: jtlProduct.stock?.stockLevelAnnounced || 0,
              },
            });
            console.log(`[ProductSync] Linked existing product by SKU: ${sku} → ${jtlProduct.jfsku}`);
            linked++;
          }
          result.alreadyExists++;
          continue;
        }

        // Case 2: Try to find a match by name (for products with SHOP-xxx/WOO-xxx SKUs)
        const normalizedJtlName = normalizeProductName(jtlProductName);
        const matchedProduct = productsByNormalizedName.get(normalizedJtlName);

        if (matchedProduct) {
          try {
            // Update the existing product: fix SKU and link to JTL
            console.log(`[ProductSync] Found name match: "${matchedProduct.name}" (${matchedProduct.sku}) ↔ JTL "${jtlProductName}" (${sku})`);

            await this.prisma.product.update({
              where: { id: matchedProduct.id },
              data: {
                sku: sku,  // Update to correct JTL merchantSku
                jtlProductId: jtlProduct.jfsku,
                jtlSyncStatus: 'SYNCED',
                lastJtlSync: new Date(),
                available: jtlProduct.stock?.stockLevel || 0,
                reserved: jtlProduct.stock?.stockLevelReserved || 0,
                announced: jtlProduct.stock?.stockLevelAnnounced || 0,
              },
            });

            // Remove from map so we don't match again
            productsByNormalizedName.delete(normalizedJtlName);
            existingSkus.add(sku);  // Add new SKU to prevent creating duplicate

            linked++;
            console.log(`[ProductSync] ✅ Linked by name: ${matchedProduct.sku} → ${sku} (JTL: ${jtlProduct.jfsku})`);
            continue;
          } catch (error) {
            console.error(`[ProductSync] Failed to link ${matchedProduct.sku}: ${error}`);
            // Fall through to create new product
          }
        }

        // Case 3: No match found - create new product
        try {
          // Create new product in local DB (NO channel sync)
          const newProduct = await this.prisma.product.create({
            data: {
              clientId,
              productId: `JTL-${jtlProduct.jfsku}`,
              sku: sku,
              name: jtlProductName,
              available: jtlProduct.stock?.stockLevel || 0,
              reserved: jtlProduct.stock?.stockLevelReserved || 0,
              announced: jtlProduct.stock?.stockLevelAnnounced || 0,
              jtlProductId: jtlProduct.jfsku,
              jtlSyncStatus: 'SYNCED',
              lastJtlSync: new Date(),
              lastUpdatedBy: 'JTL',
              syncStatus: 'SYNCED',
              isActive: true,
              // NO channels - this is warehouse-only
            },
          });

          result.imported++;
          result.importedProducts.push({
            sku: sku,
            name: jtlProductName,
            jfsku: jtlProduct.jfsku,
          });

          console.log(`[ProductSync] Imported new product: ${sku} (${jtlProduct.jfsku})`);
        } catch (error) {
          result.failed++;
          const errorMsg = `Failed to import ${sku}: ${extractErrorMessage(error)}`;
          result.errors.push(errorMsg);
          console.error(`[ProductSync] ${errorMsg}`);
        }
      }

      console.log(`[ProductSync] Linked ${linked} existing products to JTL by name matching`);

      console.log(`[ProductSync] Import complete: ${result.imported} imported, ${result.alreadyExists} already exist, ${result.failed} failed`);
      return result;
    } catch (error) {
      console.error(`[ProductSync] Error importing products from JTL:`, error);
      result.errors.push(extractErrorMessage(error));
      return result;
    }
  }

  /**
   * Get sync status summary for a client
   */
  async getSyncStatus(clientId: string): Promise<{
    total: number;
    synced: number;
    pending: number;
    conflict: number;
    error: number;
    lastSyncAt: Date | null;
  }> {
    const counts = await this.prisma.product.groupBy({
      by: ['syncStatus'],
      where: { clientId },
      _count: true,
    });

    const lastSync = await this.prisma.product.findFirst({
      where: { clientId, lastSyncedAt: { not: null } },
      orderBy: { lastSyncedAt: 'desc' },
      select: { lastSyncedAt: true },
    });

    const statusMap = Object.fromEntries(counts.map(c => [c.syncStatus, c._count]));

    return {
      total: Object.values(statusMap).reduce((a, b) => a + b, 0),
      synced: statusMap.SYNCED || 0,
      pending: statusMap.PENDING || 0,
      conflict: statusMap.CONFLICT || 0,
      error: statusMap.ERROR || 0,
      lastSyncAt: lastSync?.lastSyncedAt || null,
    };
  }

  /**
   * Process bundle linking - create BundleItems or PendingBundleLinks
   */
  private async processBundleLinking(
    productId: string,
    clientId: string,
    channelId: string,
    data: IncomingProductData
  ): Promise<void> {
    if (!data.isBundle || !data.bundleComponents?.length) return;

    // Mark product as bundle
    await this.prisma.product.update({
      where: { id: productId },
      data: { isBundle: true },
    });

    const resolvedChildIds: string[] = [];

    for (const comp of data.bundleComponents) {
      // Try to find the child product
      const child = await this.findChildProduct(clientId, channelId, comp.externalId, comp.sku);

      if (child) {
        // Directly create BundleItem
        await this.prisma.bundleItem.upsert({
          where: {
            parentProductId_childProductId: {
              parentProductId: productId,
              childProductId: child.id,
            },
          },
          create: {
            parentProductId: productId,
            childProductId: child.id,
            quantity: comp.quantity,
          },
          update: { quantity: comp.quantity },
        });
        resolvedChildIds.push(child.id);
      } else {
        // Check if pending link already exists
        const existingPending = await this.prisma.pendingBundleLink.findFirst({
          where: {
            parentProductId: productId,
            OR: [
              comp.externalId ? { childExternalId: comp.externalId } : null,
              comp.sku ? { childSku: comp.sku } : null,
            ].filter(Boolean) as any[],
          },
        });

        if (!existingPending) {
          // Create PendingBundleLink for deferred resolution
          await this.prisma.pendingBundleLink.create({
            data: {
              parentProductId: productId,
              childExternalId: comp.externalId || null,
              childSku: comp.sku || null,
              quantity: comp.quantity,
              channelId,
              status: 'pending',
            },
          });
        } else {
          // Update quantity if changed
          await this.prisma.pendingBundleLink.update({
            where: { id: existingPending.id },
            data: { quantity: comp.quantity, status: 'pending' },
          });
        }
      }
    }

    // Clean up BundleItems for components no longer in the bundle
    if (resolvedChildIds.length > 0) {
      await this.prisma.bundleItem.deleteMany({
        where: {
          parentProductId: productId,
          childProductId: { notIn: resolvedChildIds },
        },
      });
    }
  }

  /**
   * Find child product by external ID or SKU
   */
  private async findChildProduct(
    clientId: string,
    channelId: string,
    externalId?: string,
    sku?: string
  ): Promise<{ id: string } | null> {
    if (externalId) {
      const byExternal = await this.prisma.product.findFirst({
        where: {
          clientId,
          channels: { some: { channelId, externalProductId: externalId } },
        },
        select: { id: true },
      });
      if (byExternal) return byExternal;
    }

    if (sku) {
      const bySku = await this.prisma.product.findFirst({
        where: { clientId, sku },
        select: { id: true },
      });
      if (bySku) return bySku;
    }

    return null;
  }

  /**
   * Resolve any pending bundle links where this product could be a child
   */
  private async resolveAnyPendingBundleLinks(
    productId: string,
    clientId: string,
    sku?: string,
    externalId?: string,
    channelId?: string
  ): Promise<void> {
    // Find pending links where this product could be a child
    const conditions: any[] = [];
    if (sku) conditions.push({ childSku: sku });
    if (externalId) conditions.push({ childExternalId: externalId });
    if (conditions.length === 0) return;

    const pendingLinks = await this.prisma.pendingBundleLink.findMany({
      where: { status: 'pending', OR: conditions },
      include: { parentProduct: { select: { id: true, clientId: true } } },
    });

    for (const link of pendingLinks) {
      if (link.parentProduct.clientId !== clientId) continue;

      // Create the BundleItem
      await this.prisma.bundleItem.upsert({
        where: {
          parentProductId_childProductId: {
            parentProductId: link.parentProductId,
            childProductId: productId,
          },
        },
        create: {
          parentProductId: link.parentProductId,
          childProductId: productId,
          quantity: link.quantity,
        },
        update: { quantity: link.quantity },
      });

      // Mark link as resolved
      await this.prisma.pendingBundleLink.update({
        where: { id: link.id },
        data: { status: 'resolved', childProductId: productId },
      });

      this.logger.info({
        event: 'pending_bundle_resolved',
        parentProductId: link.parentProductId,
        childProductId: productId,
        childSku: sku,
      });
    }
  }
}
