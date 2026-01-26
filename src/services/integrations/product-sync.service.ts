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

type Decimal = Prisma.Decimal;

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
    
    console.log(`[ProductSync] Processing incoming ${origin} product: ${externalId}`);
    
    try {
      // 1. Check if this is an echo of our own update (loop prevention)
      if (await this.isEchoFromOurUpdate(data.externalId, origin, channelId)) {
        console.log(`[ProductSync] Skipping echo from our own update: ${externalId}`);
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

      // 3. Prepare field updates respecting ownership
      const { updates, conflicts } = this.prepareFieldUpdates(
        existingProduct,
        data,
        origin
      );

      // 4. Handle conflicts if any
      if (conflicts.length > 0) {
        console.log(`[ProductSync] Conflicts detected for ${externalId}:`, conflicts);
        // For now, auto-resolve based on rules. Could queue for manual review.
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
      } else {
        // Create new product
        const sku = data.sku || `${origin.toUpperCase()}-${externalId}`;
        
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

      // 6. Queue sync to other platforms
      await this.queueSyncToOtherPlatforms(product.id, origin, webhookEventId);

      return {
        success: true,
        action,
        productId: product.id,
        externalIds: { [origin]: externalId },
        conflicts: conflicts.length > 0 ? conflicts : undefined,
      };
    } catch (error) {
      console.error(`[ProductSync] Error processing incoming product:`, error);
      return {
        success: false,
        action: 'failed',
        productId: '',
        error: error instanceof Error ? error.message : 'Unknown error',
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
        error: error instanceof Error ? error.message : 'Unknown error',
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
    console.log(`[ProductSync] Pushing product ${productId} to all platforms`);

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
      },
    });

    if (!product) {
      return {
        success: false,
        action: 'failed',
        productId,
        error: 'Product not found',
      };
    }

    const results: { platform: string; success: boolean; externalId?: string; error?: string }[] = [];
    const skipPlatforms = options.skipPlatforms || [];

    // Push to each linked channel
    for (const productChannel of product.channels) {
      const channelType = productChannel.channel.type.toLowerCase() as SyncOriginType;
      
      if (skipPlatforms.includes(channelType)) {
        results.push({ platform: channelType, success: true, externalId: productChannel.externalProductId || undefined });
        continue;
      }

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

        results.push({ platform: channelType, success: true, externalId });
      } catch (error) {
        console.error(`[ProductSync] Error pushing to ${channelType}:`, error);
        
        await this.prisma.productChannel.update({
          where: { id: productChannel.id },
          data: {
            syncStatus: 'ERROR',
            lastError: error instanceof Error ? error.message : 'Unknown error',
            lastErrorAt: new Date(),
          },
        });

        results.push({
          platform: channelType,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Push to JTL if configured and not skipped
    if (product.client.jtlConfig && !skipPlatforms.includes('jtl')) {
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

        results.push({ platform: 'jtl', success: true, externalId: jtlId });
      } catch (error) {
        console.error(`[ProductSync] Error pushing to JTL:`, error);
        
        await this.prisma.product.update({
          where: { id: productId },
          data: { jtlSyncStatus: 'ERROR' },
        });

        results.push({
          platform: 'jtl',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
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

    return {
      success: allSuccess,
      action: 'updated',
      productId,
      externalIds: Object.fromEntries(
        results.filter(r => r.externalId).map(r => [r.platform, r.externalId])
      ),
      syncedPlatforms: results.filter(r => r.success).map(r => r.platform),
      skippedPlatforms: skipPlatforms,
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
    console.log(`[ProductSync] Syncing stock for product ${productId} to channel ${channelId}`);

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
        console.log(`[ProductSync] No active channel found for product ${productId}, channel ${channelId}`);
        return { success: true }; // Not an error, just no channel to sync to
      }

      if (!productChannel.externalProductId) {
        console.log(`[ProductSync] Product ${productId} not yet synced to channel ${channelId}, skipping stock sync`);
        return { success: true }; // Product hasn't been pushed to channel yet
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

      console.log(`[ProductSync] Stock synced successfully for product ${productId} to ${productChannel.channel.type}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[ProductSync] Stock sync failed for product ${productId}:`, errorMessage);
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
      accessToken: encryptionService.decrypt(accessToken),
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
    console.log(`[ProductSync] Set Shopify inventory: item=${inventoryItemId}, location=${locationId}, available=${available}`);
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
      consumerKey: encryptionService.decrypt(apiClientId),
      consumerSecret: encryptionService.decrypt(apiClientSecret),
    });

    const productId = parseInt(externalProductId);
    await wooService.updateProductStock(productId, available, true);
    console.log(`[ProductSync] Set WooCommerce stock: product=${productId}, stock_quantity=${available}`);
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
      accessToken: encryptionService.decrypt(productChannel.channel.accessToken),
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
      const images = product.images?.map(img => ({ src: img.url, alt: img.altText })) || [];
      if (product.imageUrl && !images.some(img => img.src === product.imageUrl)) {
        images.unshift({ src: product.imageUrl, alt: null });
      }
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
      consumerKey: encryptionService.decrypt(productChannel.channel.apiClientId),
      consumerSecret: encryptionService.decrypt(productChannel.channel.apiClientSecret),
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
      const images = product.images?.map(img => ({ src: img.url, alt: img.altText })) || [];
      if (product.imageUrl && !images.some(img => img.src === product.imageUrl)) {
        images.unshift({ src: product.imageUrl, alt: null });
      }
      if (images.length > 0) {
        wooData.images = images;
      }
    }

    if (productChannel.externalProductId) {
      // Update existing
      const result = await wooService.updateProduct(
        parseInt(productChannel.externalProductId),
        wooData
      );
      return String(result.id);
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
      clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
      accessToken: encryptionService.decrypt(jtlConfig.accessToken),
      refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
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

    // JTL product data matching n8n workflow structure
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
    };

    const result = await jtlService.createProduct(jtlProduct);
    return result.jfsku;
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
            lastError: error instanceof Error ? error.message : 'Unknown error',
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
}
