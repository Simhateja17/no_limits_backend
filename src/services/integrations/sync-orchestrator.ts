/**
 * Sync Orchestrator Service
 * Coordinates data synchronization between e-commerce platforms (Shopify/WooCommerce),
 * local database, and JTL FFN fulfillment system
 * 
 * Flow: Shopify/WooCommerce → No-Limits DB → JTL FFN
 */

import { PrismaClient, ChannelType, OrderStatus, ReturnStatus, Prisma } from '@prisma/client';
import { ShopifyService } from './shopify.service.js';
import { createShopifyServiceAuto, ShopifyServiceInstance } from './shopify-service-factory.js';
import { WooCommerceService } from './woocommerce.service.js';
import { JTLService } from './jtl.service.js';
import { getEncryptionService } from '../encryption.service.js';
import BatchOperations from './batch-utils.js';
import ProductCache from './product-cache.js';
import { getQueue, QUEUE_NAMES, OrderSyncJobData } from '../queue/sync-queue.service.js';
import {
  ShopifyOrder,
  ShopifyProduct,
  ShopifyRefund,
  WooCommerceOrder,
  WooCommerceProduct,
  WooCommerceRefund,
  JTLOutbound,
  JTLProduct,
  JTLReturn,
  JTLAddress,
  SyncResult,
  SyncItemResult,
  ShopifyLineItem,
  WooCommerceLineItem,
  ShopifyRefundLineItem,
} from './types.js';

// Payment hold detection - matching order-sync.service.ts logic
const SHOPIFY_PAID_STATUSES = ['paid', 'authorized', 'partially_paid'];
const WOOCOMMERCE_UNPAID_STATUSES = ['pending', 'on-hold'];

function shouldHoldShopifyOrderForPayment(paymentStatus?: string): boolean {
  if (!paymentStatus) return true;
  return !SHOPIFY_PAID_STATUSES.includes(paymentStatus.toLowerCase());
}

function shouldHoldWooCommerceOrderForPayment(orderStatus?: string): boolean {
  if (!orderStatus) return true;
  return WOOCOMMERCE_UNPAID_STATUSES.includes(orderStatus.toLowerCase());
}

// Map WooCommerce order status to paymentStatus field (matching webhook-processor.service.ts)
function mapWooCommercePaymentStatus(status?: string): string | null {
  if (!status) return null;
  switch (status.toLowerCase()) {
    case 'processing':
    case 'completed':
    case 'delivered': // Custom WooCommerce status - delivered orders are paid
      return 'paid';
    case 'refunded':
      return 'refunded';
    case 'pending':
    case 'on-hold':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'cancelled':
    default:
      return null;
  }
}

interface SyncConfig {
  channelId: string;
  channelType: ChannelType;
  shopifyCredentials?: {
    shopDomain: string;
    accessToken: string;
  };
  wooCommerceCredentials?: {
    url: string;
    consumerKey: string;
    consumerSecret: string;
  };
  jtlCredentials: {
    clientId: string;
    clientSecret: string;
    accessToken?: string;
    refreshToken?: string;
    environment: 'sandbox' | 'production';
  };
  jtlWarehouseId: string;
  jtlFulfillerId: string;
}

interface ProductSyncData {
  localProductId: string;
  externalProductId: string;
  sku: string;
  name: string;
  gtin?: string;
  weight?: number;
  imageUrl?: string;
}

interface OrderSyncData {
  localOrderId: string;
  externalOrderId: string;
  orderNumber: string;
  items: {
    sku: string;
    productName?: string;
    quantity: number;
    unitPrice?: number;
    jtlJfsku?: string;
  }[];
  shippingAddress: JTLAddress;
  customerEmail?: string;
  // Payment and date tracking for initial sync
  status?: string;           // WooCommerce order status (for payment hold)
  paymentStatus?: string;    // Shopify financial_status (for payment hold)
  orderDate?: Date;          // Original order creation date from platform
}

export class SyncOrchestrator {
  private prisma: PrismaClient;
  private shopifyService?: ShopifyServiceInstance;
  private wooCommerceService?: WooCommerceService;
  private jtlService: JTLService;
  private config: SyncConfig;
  private batchOps: BatchOperations;
  private productCache?: ProductCache;

  constructor(prisma: PrismaClient, config: SyncConfig) {
    this.prisma = prisma;
    this.config = config;
    this.batchOps = new BatchOperations(prisma);

    console.log('[SyncOrchestrator] Constructor - Config check:', {
      channelType: config.channelType,
      hasShopifyCredentials: !!config.shopifyCredentials,
      hasWooCredentials: !!config.wooCommerceCredentials,
      shopifyShopDomain: config.shopifyCredentials?.shopDomain,
    });

    // Initialize e-commerce service based on channel type
    if (config.channelType === 'SHOPIFY' && config.shopifyCredentials) {
      console.log('[SyncOrchestrator] Initializing ShopifyService (auto-select REST/GraphQL)');
      this.shopifyService = createShopifyServiceAuto(config.shopifyCredentials);
    } else if (config.channelType === 'WOOCOMMERCE' && config.wooCommerceCredentials) {
      console.log('[SyncOrchestrator] Initializing WooCommerceService');
      this.wooCommerceService = new WooCommerceService(config.wooCommerceCredentials);
    } else {
      console.log('[SyncOrchestrator] ⚠️ NO E-COMMERCE SERVICE INITIALIZED!');
    }

    // Initialize JTL service with decrypted tokens
    const encryptionService = getEncryptionService();
    const decryptedCredentials = {
      ...config.jtlCredentials,
      clientSecret: config.jtlCredentials.clientSecret
        ? encryptionService.safeDecrypt(config.jtlCredentials.clientSecret)
        : config.jtlCredentials.clientSecret,
      accessToken: config.jtlCredentials.accessToken
        ? encryptionService.safeDecrypt(config.jtlCredentials.accessToken)
        : config.jtlCredentials.accessToken,
      refreshToken: config.jtlCredentials.refreshToken
        ? encryptionService.safeDecrypt(config.jtlCredentials.refreshToken)
        : config.jtlCredentials.refreshToken,
    };
    this.jtlService = new JTLService(decryptedCredentials);
  }

  // ============= PRODUCTS SYNC =============

  /**
   * Full sync of products from e-commerce platform → DB → JTL
   */
  async syncProducts(): Promise<SyncResult> {
    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    try {
      // Step 1: Pull products from e-commerce platform
      const externalProducts = await this.pullProductsFromChannel();

      // Step 2: Store/update in local database
      for (const product of externalProducts) {
        try {
          const localProduct = await this.upsertProductInDB(product);

          // Step 3: Push to JTL FFN
          const jtlProduct = await this.pushProductToJTL(localProduct);
          if (jtlProduct) {
            await this.updateProductJTLMapping(localProduct.localProductId, jtlProduct.jfsku);
          }

          results.push({
            externalId: product.externalProductId,
            localId: localProduct.localProductId,
            success: true,
            action: 'updated',
          });
          itemsProcessed++;
        } catch (error) {
          results.push({
            externalId: product.externalProductId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            action: 'failed',
          });
          itemsFailed++;
        }
      }

      return {
        success: itemsFailed === 0,
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
        details: results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
      };
    }
  }

  /**
   * Incremental sync of products updated since last sync
   */
  async syncProductsIncremental(since: Date): Promise<SyncResult> {
    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    try {
      const externalProducts = await this.pullProductsFromChannel(since);

      for (const product of externalProducts) {
        try {
          const localProduct = await this.upsertProductInDB(product);

          // Push to JTL FFN
          const jtlProduct = await this.pushProductToJTL(localProduct);
          if (jtlProduct) {
            await this.updateProductJTLMapping(localProduct.localProductId, jtlProduct.jfsku);
          }

          results.push({
            externalId: product.externalProductId,
            localId: localProduct.localProductId,
            success: true,
            action: 'updated',
          });
          itemsProcessed++;
        } catch (error) {
          results.push({
            externalId: product.externalProductId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            action: 'failed',
          });
          itemsFailed++;
        }
      }

      return {
        success: itemsFailed === 0,
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
        details: results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
      };
    }
  }

  /**
   * Pull products from the configured e-commerce channel
   */
  private async pullProductsFromChannel(since?: Date): Promise<ProductSyncData[]> {
    const products: ProductSyncData[] = [];

    console.log('[pullProductsFromChannel] Config check:', {
      channelType: this.config.channelType,
      hasShopifyService: !!this.shopifyService,
      hasWooService: !!this.wooCommerceService,
      since: since?.toISOString(),
    });

    if (this.config.channelType === 'SHOPIFY' && this.shopifyService) {
      console.log('[pullProductsFromChannel] Calling Shopify API...');

      let shopifyProducts: any[];
      try {
        shopifyProducts = since
          ? await this.shopifyService.getProductsUpdatedSince(since)
          : await this.shopifyService.getAllProducts();

        console.log(`[pullProductsFromChannel] ✅ Shopify returned ${shopifyProducts.length} products`);
      } catch (error) {
        console.error('[pullProductsFromChannel] ❌ ERROR calling Shopify API:', error);
        throw error;
      }

      for (const product of shopifyProducts) {
        // Process each variant as a separate product
        for (const variant of product.variants) {
          products.push({
            localProductId: '', // Will be set after DB insert
            externalProductId: String(variant.id),
            sku: variant.sku || `SHOP-${variant.id}`,
            name: `${product.title}${variant.title !== 'Default Title' ? ` - ${variant.title}` : ''}`,
            gtin: variant.barcode || undefined,
            weight: variant.weight,
            imageUrl: product.images[0]?.src,
          });
        }
      }
    } else if (this.config.channelType === 'WOOCOMMERCE' && this.wooCommerceService) {
      console.log('[pullProductsFromChannel] Calling WooCommerce API...');

      let wooProducts: any[];
      try {
        wooProducts = since
          ? await this.wooCommerceService.getProductsUpdatedSince(since)
          : await this.wooCommerceService.getAllProducts();

        console.log(`[pullProductsFromChannel] ✅ WooCommerce returned ${wooProducts.length} products`);
      } catch (error) {
        console.error('[pullProductsFromChannel] ❌ ERROR calling WooCommerce API:', error);
        throw error;
      }

      for (const product of wooProducts) {
        products.push({
          localProductId: '',
          externalProductId: String(product.id),
          sku: product.sku || `WOO-${product.id}`,
          name: product.name,
          gtin: undefined, // WooCommerce doesn't have GTIN by default
          weight: product.weight ? parseFloat(product.weight) : undefined,
          imageUrl: product.images[0]?.src,
        });

        // Handle variable products
        if (product.variations && product.variations.length > 0) {
          const variations = await this.wooCommerceService.getProductVariations(product.id);
          for (const variation of variations) {
            products.push({
              localProductId: '',
              externalProductId: String(variation.id),
              sku: variation.sku || `WOO-VAR-${variation.id}`,
              name: `${product.name} - ${variation.name}`,
              weight: variation.weight ? parseFloat(variation.weight) : undefined,
              imageUrl: variation.images?.[0]?.src || product.images[0]?.src,
            });
          }
        }
      }
    }

    return products;
  }

  /**
   * Upsert product in local database
   */
  private async upsertProductInDB(productData: ProductSyncData): Promise<ProductSyncData> {
    // Get client ID from channel first (needed for proper filtering)
    const channel = await this.prisma.channel.findUnique({
      where: { id: this.config.channelId },
    });

    if (!channel) {
      throw new Error(`Channel ${this.config.channelId} not found`);
    }

    // Find existing product by SKU AND clientId (each client has their own products)
    const existingProduct = await this.prisma.product.findFirst({
      where: {
        clientId: channel.clientId, // Important: Filter by client!
        OR: [
          { sku: productData.sku },
          {
            channels: {
              some: {
                channelId: this.config.channelId,
                externalProductId: productData.externalProductId,
              },
            },
          },
        ],
      },
      include: { channels: true },
    });

    if (existingProduct) {
      // Update existing product
      await this.prisma.product.update({
        where: { id: existingProduct.id },
        data: {
          name: productData.name,
          sku: productData.sku,
          gtin: productData.gtin,
          updatedAt: new Date(),
        },
      });

      // Upsert product channel mapping
      await this.prisma.productChannel.upsert({
        where: {
          productId_channelId: {
            productId: existingProduct.id,
            channelId: this.config.channelId,
          },
        },
        create: {
          productId: existingProduct.id,
          channelId: this.config.channelId,
          externalProductId: productData.externalProductId,
          isActive: true,
        },
        update: {
          externalProductId: productData.externalProductId,
          isActive: true,
          updatedAt: new Date(),
        },
      });

      return { ...productData, localProductId: existingProduct.id };
    } else {
      // Create new product (channel was already fetched above)
      const newProduct = await this.prisma.product.create({
        data: {
          clientId: channel.clientId,
          productId: productData.sku, // Use SKU as productId
          name: productData.name,
          sku: productData.sku,
          gtin: productData.gtin,
          isActive: true,
          channels: {
            create: {
              channelId: this.config.channelId,
              externalProductId: productData.externalProductId,
              isActive: true,
            },
          },
        },
      });

      return { ...productData, localProductId: newProduct.id };
    }
  }

  /**
   * Push product to JTL FFN
   */
  private async pushProductToJTL(productData: ProductSyncData): Promise<{ jfsku: string } | null> {
    try {
      // Build identifier object (matches n8n workflow structure)
      const identifier: { ean?: string | null; han?: string | null } = {
        ean: productData.gtin || productData.sku || null,
        han: null,
      };

      // Build attributes array for platform tracking
      const attributes = [
        {
          key: 'platform',
          value: this.config.channelType, // Use channel type from config
        },
        {
          key: 'externalProductId',
          value: productData.externalProductId || '',
        },
      ];

      const jtlProduct: JTLProduct = {
        name: productData.name,
        merchantSku: productData.sku,
        identifier: identifier, // Singular object (not array)
        weight: productData.weight ? productData.weight / 1000 : 0.1, // Convert grams to kg, default 0.1
        length: 0.01, // Default 1cm in meters
        width: 0.01,
        height: 0.01,
        imageUrl: productData.imageUrl,
        attributes: attributes,
        condition: 'Default',
      };

      const result = await this.jtlService.createProduct(jtlProduct);
      return { jfsku: result.jfsku };
    } catch (error) {
      console.error(`Failed to push product ${productData.sku} to JTL:`, error);
      return null;
    }
  }

  /**
   * Update product with JTL mapping
   */
  private async updateProductJTLMapping(productId: string, jtlJfsku: string): Promise<void> {
    await this.prisma.product.update({
      where: { id: productId },
      data: {
        jtlProductId: jtlJfsku,
        lastJtlSync: new Date(),
      },
    });
  }

  // ============= ORDERS SYNC =============

  /**
   * Full sync of orders from e-commerce platform → DB → JTL
   */
  async syncOrders(): Promise<SyncResult> {
    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    try {
      const externalOrders = await this.pullOrdersFromChannel();

      for (const order of externalOrders) {
        try {
          const localOrder = await this.upsertOrderInDB(order);

          // Push to JTL FFN if order is pending or processing
          if (localOrder.status === 'PENDING' || localOrder.status === 'PROCESSING') {
            await this.pushOrderToJTL(localOrder);
          }

          results.push({
            externalId: order.externalOrderId,
            localId: localOrder.localOrderId,
            success: true,
            action: 'updated',
          });
          itemsProcessed++;
        } catch (error) {
          results.push({
            externalId: order.externalOrderId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            action: 'failed',
          });
          itemsFailed++;
        }
      }

      return {
        success: itemsFailed === 0,
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
        details: results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
      };
    }
  }

  /**
   * Incremental sync of orders updated since last sync
   */
  async syncOrdersIncremental(since: Date): Promise<SyncResult> {
    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    try {
      const externalOrders = await this.pullOrdersFromChannel(since);

      for (const order of externalOrders) {
        try {
          const localOrder = await this.upsertOrderInDB(order);

          // Push to JTL FFN if order is pending or processing
          if (localOrder.status === 'PENDING' || localOrder.status === 'PROCESSING') {
            await this.pushOrderToJTL(localOrder);
          }

          results.push({
            externalId: order.externalOrderId,
            localId: localOrder.localOrderId,
            success: true,
            action: 'updated',
          });
          itemsProcessed++;
        } catch (error) {
          results.push({
            externalId: order.externalOrderId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            action: 'failed',
          });
          itemsFailed++;
        }
      }

      return {
        success: itemsFailed === 0,
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
        details: results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
      };
    }
  }

  /**
   * Pull orders from the configured e-commerce channel
   * @param since Optional date to limit orders (uses created_at for historic data)
   */
  private async pullOrdersFromChannel(since?: Date): Promise<OrderSyncData[]> {
    const orders: OrderSyncData[] = [];

    if (this.config.channelType === 'SHOPIFY' && this.shopifyService) {
      // For historic sync with a date, use created_at filter
      // For regular incremental sync (no date), get all orders
      const shopifyOrders = since
        ? await this.shopifyService.getOrdersCreatedSince(since)
        : await this.shopifyService.getAllOrders({ status: 'any' });

      let ordersWithoutAddress = 0;
      for (const order of shopifyOrders) {
        orders.push(this.mapShopifyOrder(order));
        if (!order.shipping_address) {
          ordersWithoutAddress++;
        }
      }
      console.log(`[Shopify] Processing ${orders.length} orders (${ordersWithoutAddress} without shipping address)`);
    } else if (this.config.channelType === 'WOOCOMMERCE' && this.wooCommerceService) {
      console.log('[pullOrdersFromChannel] Calling WooCommerce API...');

      // For historic sync with a date, use created_at filter
      let wooOrders: any[];
      try {
        wooOrders = since
          ? await this.wooCommerceService.getOrdersCreatedSince(since)
          : await this.wooCommerceService.getAllOrders();

        console.log(`[pullOrdersFromChannel] ✅ WooCommerce returned ${wooOrders.length} orders`);
      } catch (error) {
        console.error('[pullOrdersFromChannel] ❌ ERROR calling WooCommerce API:', error);
        throw error;
      }

      let ordersWithoutAddress = 0;
      for (const order of wooOrders) {
        orders.push(this.mapWooCommerceOrder(order));
        if (!order.shipping) {
          ordersWithoutAddress++;
        }
      }
      console.log(`[WooCommerce] Processing ${orders.length} orders (${ordersWithoutAddress} without shipping address)`);
    }

    return orders;
  }

  /**
   * Map Shopify order to internal format
   */
  private mapShopifyOrder(order: ShopifyOrder): OrderSyncData {
    return {
      localOrderId: '',
      externalOrderId: String(order.id),
      orderNumber: order.name || String(order.order_number),
      items: order.line_items.map((item: ShopifyLineItem) => ({
        sku: item.sku || `NO-SKU-${item.variant_id || item.product_id}`,
        productName: item.name || item.title || 'Unknown Product',
        quantity: item.quantity,
        unitPrice: item.price ? parseFloat(item.price) : undefined,
      })),
      shippingAddress: {
        salutation: undefined,
        firstname: order.shipping_address?.first_name,
        lastname: order.shipping_address?.last_name || 'Unknown',
        company: order.shipping_address?.company || undefined,
        street: order.shipping_address?.address1 || '',
        houseNumber: undefined,
        zip: order.shipping_address?.zip || '',
        city: order.shipping_address?.city || '',
        country: order.shipping_address?.country_code || '',
        email: order.email,
        phone: order.shipping_address?.phone || undefined,
      },
      customerEmail: order.email,
      // Payment and date tracking for initial sync
      paymentStatus: order.financial_status,
      orderDate: order.created_at ? new Date(order.created_at) : undefined,
    };
  }

  /**
   * Map WooCommerce order to internal format
   */
  private mapWooCommerceOrder(order: WooCommerceOrder): OrderSyncData {
    // DEBUG: Log WooCommerce order ID vs order number for troubleshooting
    console.log(`[SyncOrchestrator] WooCommerce order mapping:`, {
      internalId: order.id,
      orderNumber: order.number,
      hasOrderNumber: !!order.number,
    });

    return {
      localOrderId: '',
      externalOrderId: String(order.id),
      orderNumber: order.number,
      items: order.line_items.map((item: WooCommerceLineItem) => ({
        sku: item.sku || `NO-SKU-${item.product_id}`,
        productName: item.name || 'Unknown Product',
        quantity: item.quantity,
        unitPrice: item.total && item.quantity ? parseFloat(item.total) / item.quantity : undefined,
      })),
      shippingAddress: {
        salutation: undefined,
        firstname: order.shipping.first_name,
        lastname: order.shipping.last_name || 'Unknown',
        company: order.shipping.company || undefined,
        street: order.shipping.address_1,
        houseNumber: undefined,
        zip: order.shipping.postcode,
        city: order.shipping.city,
        country: order.shipping.country,
        email: order.billing.email,
        phone: order.billing.phone || undefined,
      },
      customerEmail: order.billing.email,
      // Payment and date tracking for initial sync
      status: order.status,
      orderDate: order.date_created ? new Date(order.date_created) : undefined,
    };
  }

  /**
   * Upsert order in local database
   */
  // Track order upsert stats
  private orderUpsertStats = { created: 0, updated: 0 };

  private async upsertOrderInDB(orderData: OrderSyncData): Promise<OrderSyncData & { status: OrderStatus }> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: this.config.channelId },
    });

    if (!channel) {
      throw new Error(`Channel ${this.config.channelId} not found`);
    }

    // Find existing order
    const existingOrder = await this.prisma.order.findFirst({
      where: {
        channelId: this.config.channelId,
        externalOrderId: orderData.externalOrderId,
      },
    });

    if (existingOrder) {
      // Update existing order
      const updatedOrder = await this.prisma.order.update({
        where: { id: existingOrder.id },
        data: {
          updatedAt: new Date(),
        },
      });

      this.orderUpsertStats.updated++;

      return {
        ...orderData,
        localOrderId: updatedOrder.id,
        status: updatedOrder.status,
      };
    } else {
      // Determine if order requires payment hold
      const isWooCommerce = channel.type === 'WOOCOMMERCE';
      const requiresPaymentHold = isWooCommerce
        ? shouldHoldWooCommerceOrderForPayment(orderData.status)
        : shouldHoldShopifyOrderForPayment(orderData.paymentStatus);

      console.log(`[SyncOrchestrator] Payment hold check for order ${orderData.externalOrderId}:`, {
        channelType: channel.type,
        status: isWooCommerce ? orderData.status : orderData.paymentStatus,
        requiresPaymentHold,
      });

      // Determine payment status for this order
      const resolvedPaymentStatus = isWooCommerce
        ? mapWooCommercePaymentStatus(orderData.status)
        : orderData.paymentStatus;

      // Create new order
      const newOrder = await this.prisma.order.create({
        data: {
          orderId: `ORD-${Date.now()}`, // Generate unique order ID
          clientId: channel.clientId,
          channelId: this.config.channelId,
          externalOrderId: orderData.externalOrderId,
          orderNumber: orderData.orderNumber,
          status: resolvedPaymentStatus === 'refunded' ? 'CANCELLED' : 'PENDING',
          fulfillmentState: resolvedPaymentStatus === 'refunded' ? 'CANCELED' : 'PENDING',
          isCancelled: resolvedPaymentStatus === 'refunded',
          orderOrigin: isWooCommerce ? 'WOOCOMMERCE' : 'SHOPIFY',
          // Payment hold and order date from initial sync
          orderDate: orderData.orderDate,
          isOnHold: resolvedPaymentStatus === 'refunded' ? false : requiresPaymentHold,
          holdReason: resolvedPaymentStatus === 'refunded' ? null : (requiresPaymentHold ? 'AWAITING_PAYMENT' : null),
          holdPlacedAt: resolvedPaymentStatus === 'refunded' ? null : (requiresPaymentHold ? new Date() : null),
          holdPlacedBy: resolvedPaymentStatus === 'refunded' ? null : (requiresPaymentHold ? 'SYSTEM' : null),
          // Payment status for UI display (Paid/Unpaid badge)
          paymentStatus: resolvedPaymentStatus,
          shippingFirstName: orderData.shippingAddress.firstname || '',
          shippingLastName: orderData.shippingAddress.lastname,
          shippingCompany: orderData.shippingAddress.company,
          shippingAddress1: orderData.shippingAddress.street,
          shippingCity: orderData.shippingAddress.city,
          shippingZip: orderData.shippingAddress.zip,
          shippingCountry: orderData.shippingAddress.country,
          customerEmail: orderData.customerEmail,
          customerPhone: orderData.shippingAddress.phone,
          items: {
            create: await Promise.all(orderData.items.map(async (item) => {
              // Find product by SKU (only if SKU exists)
              let product = null;
              let resolvedSku = item.sku || `NO-SKU-${Date.now()}`;

              if (item.sku && !item.sku.startsWith('NO-SKU-')) {
                // Normal SKU - look up directly
                product = await this.prisma.product.findFirst({
                  where: { sku: item.sku },
                });
              } else if (item.sku?.startsWith('NO-SKU-')) {
                // NO-SKU fallback - try to find product by variant ID or name
                const fallbackProduct = await this.findProductByFallback(
                  item.sku,
                  item.productName,
                  channel.clientId
                );
                if (fallbackProduct) {
                  product = fallbackProduct;
                  // Update SKU to use the real SKU from the matched product
                  resolvedSku = fallbackProduct.sku;
                  console.log(`[SyncOrchestrator] Resolved NO-SKU item to real SKU: ${item.sku} -> ${resolvedSku}`);
                }
              }

              return {
                productId: product?.id,
                sku: resolvedSku,
                quantity: item.quantity,
                // Prefer productName from order data, then product lookup, then fallback
                productName: item.productName || product?.name || 'Unknown Product',
                unitPrice: item.unitPrice ? new Prisma.Decimal(item.unitPrice) : undefined,
              };
            })),
          },
        },
      });

      this.orderUpsertStats.created++;

      return {
        ...orderData,
        localOrderId: newOrder.id,
        status: newOrder.status,
      };
    }
  }

  /**
   * Push order to JTL FFN as outbound
   */
  private async pushOrderToJTL(orderData: OrderSyncData & { status: OrderStatus }): Promise<void> {
    // Get channel for clientId (needed for fallback product lookup)
    const channel = await this.prisma.channel.findUnique({
      where: { id: this.config.channelId },
      select: { clientId: true },
    });

    // Get JTL product IDs for order items
    const itemsWithJtlIds = await Promise.all(
      orderData.items.map(async (item) => {
        let product = null;
        let resolvedSku = item.sku;

        if (item.sku && !item.sku.startsWith('NO-SKU-')) {
          // Normal SKU - look up directly
          product = await this.prisma.product.findFirst({
            where: { sku: item.sku },
          });
        } else if (item.sku?.startsWith('NO-SKU-')) {
          // NO-SKU fallback - try to find product by variant ID or name
          const fallbackProduct = await this.findProductByFallback(
            item.sku,
            item.productName,
            channel?.clientId
          );
          if (fallbackProduct) {
            product = fallbackProduct;
            resolvedSku = fallbackProduct.sku;
            console.log(`[SyncOrchestrator] JTL push: Resolved NO-SKU to real SKU: ${item.sku} -> ${resolvedSku}`);
          }
        }

        return {
          ...item,
          sku: resolvedSku,
          jtlJfsku: product?.jtlProductId || undefined,
        };
      })
    );

    // Filter out items without JTL IDs
    const validItems = itemsWithJtlIds.filter(item => item.jtlJfsku);

    if (validItems.length === 0) {
      console.warn(`No valid items with JTL IDs for order ${orderData.orderNumber}`);
      return;
    }

    const jtlOutbound: JTLOutbound = {
      merchantOutboundNumber: orderData.orderNumber,
      warehouseId: this.config.jtlWarehouseId,
      fulfillerId: this.config.jtlFulfillerId,
      externalNumber: orderData.orderNumber,
      shippingType: 'Standard',
      priority: 'Normal',
      shippingAddress: orderData.shippingAddress,
      items: validItems.map((item, index) => ({
        outboundItemId: `${orderData.externalOrderId}-${index}`,
        jfsku: item.jtlJfsku!,
        merchantSku: item.sku,
        quantity: item.quantity,
      })),
    };

    try {
      const result = await this.jtlService.createOutbound(jtlOutbound);
      
      // Update order with JTL outbound ID
      await this.prisma.order.update({
        where: { id: orderData.localOrderId },
        data: {
          jtlOutboundId: result.outboundId,
          status: 'PROCESSING',
          lastJtlSync: new Date(),
        },
      });
    } catch (error) {
      console.error(`Failed to push order ${orderData.orderNumber} to JTL:`, error);
      throw error;
    }
  }

  // ============= RETURNS SYNC =============

  /**
   * Sync returns/refunds from e-commerce platform → DB → JTL
   */
  async syncReturns(since?: Date): Promise<SyncResult> {
    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    try {
      const externalRefunds = await this.pullRefundsFromChannel(since);

      for (const refund of externalRefunds) {
        try {
          const localReturn = await this.createReturnInDB(refund);

          // Skip orphan refunds (order not found in local DB)
          if (!localReturn) {
            results.push({
              externalId: refund.refundId,
              success: true,
              action: 'skipped',
            });
            continue;
          }

          // Push to JTL FFN
          await this.pushReturnToJTL(localReturn);

          results.push({
            externalId: refund.refundId,
            localId: localReturn.localReturnId,
            success: true,
            action: 'created',
          });
          itemsProcessed++;
        } catch (error) {
          results.push({
            externalId: refund.refundId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            action: 'failed',
          });
          itemsFailed++;
        }
      }

      return {
        success: itemsFailed === 0,
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
        details: results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
      };
    }
  }

  /**
   * Pull refunds from e-commerce channel
   */
  private async pullRefundsFromChannel(since?: Date): Promise<{
    refundId: string;
    orderId: string;
    items: { sku: string; quantity: number }[];
  }[]> {
    const refunds: {
      refundId: string;
      orderId: string;
      items: { sku: string; quantity: number }[];
    }[] = [];

    if (this.config.channelType === 'SHOPIFY' && this.shopifyService) {
      const refundData = await this.shopifyService.getRefundsUpdatedSince(since || new Date(0));
      
      for (const { orderId, refunds: orderRefunds } of refundData) {
        for (const refund of orderRefunds) {
          refunds.push({
            refundId: String(refund.id),
            orderId: String(orderId),
            items: refund.refund_line_items?.map((item: ShopifyRefundLineItem) => ({
              sku: '', // Would need to look up from order
              quantity: item.quantity,
            })) || [],
          });
        }
      }
    } else if (this.config.channelType === 'WOOCOMMERCE' && this.wooCommerceService) {
      const refundData = await this.wooCommerceService.getRefundsUpdatedSince(since || new Date(0));
      
      for (const { orderId, refunds: orderRefunds } of refundData) {
        for (const refund of orderRefunds) {
          refunds.push({
            refundId: String(refund.id),
            orderId: String(orderId),
            items: [], // WooCommerce refund structure differs
          });
        }
      }
    }

    return refunds;
  }

  /**
   * Create return in local database
   */
  private async createReturnInDB(refundData: {
    refundId: string;
    orderId: string;
    items: { sku: string; quantity: number }[];
  }): Promise<{
    localReturnId: string;
    orderId: string;
    items: { sku: string; quantity: number; jtlJfsku?: string }[];
  } | null> {
    // Find the order
    const order = await this.prisma.order.findFirst({
      where: {
        channelId: this.config.channelId,
        externalOrderId: refundData.orderId,
      },
      include: { items: true },
    });

    if (!order) {
      console.warn(`[SyncOrchestrator] ⚠️ Skipping refund ${refundData.refundId}: Order ${refundData.orderId} not found in local DB (may be an old/deleted order)`);
      return null;
    }

    // Create return record
    const returnRecord = await this.prisma.return.create({
      data: {
        returnId: `RET-${Date.now()}`, // Generate unique return ID
        orderId: order.id,
        clientId: order.clientId,
        status: 'ANNOUNCED',
        externalReturnId: refundData.refundId,
        items: {
          create: refundData.items.map(item => ({
            sku: item.sku || `NO-SKU-${Date.now()}`, // Fallback for items without SKU
            quantity: item.quantity,
          })),
        },
      },
      include: { items: true },
    });

    // Map items with JTL IDs (with fallback lookup for NO-SKU items)
    const itemsWithJtlIds = await Promise.all(
      refundData.items.map(async (item) => {
        let product = null;
        let resolvedSku = item.sku;

        if (item.sku && !item.sku.startsWith('NO-SKU-')) {
          // Normal SKU - look up directly
          product = await this.prisma.product.findFirst({
            where: { sku: item.sku },
          });
        } else if (item.sku?.startsWith('NO-SKU-')) {
          // NO-SKU fallback - try to find product by variant ID
          const fallbackProduct = await this.findProductByFallback(
            item.sku,
            undefined, // No product name available in refund data
            order.clientId
          );
          if (fallbackProduct) {
            product = fallbackProduct;
            resolvedSku = fallbackProduct.sku;
            console.log(`[SyncOrchestrator] Return: Resolved NO-SKU to real SKU: ${item.sku} -> ${resolvedSku}`);
          }
        }

        return {
          ...item,
          sku: resolvedSku,
          jtlJfsku: product?.jtlProductId || undefined,
        };
      })
    );

    return {
      localReturnId: returnRecord.id,
      orderId: order.id,
      items: itemsWithJtlIds,
    };
  }

  /**
   * Push return to JTL FFN
   */
  private async pushReturnToJTL(returnData: {
    localReturnId: string;
    orderId: string;
    items: { sku: string; quantity: number; jtlJfsku?: string }[];
  }): Promise<void> {
    const validItems = returnData.items.filter(item => item.jtlJfsku);

    if (validItems.length === 0) {
      console.warn(`No valid items with JTL IDs for return ${returnData.localReturnId}`);
      return;
    }

    // Get order for JTL outbound ID
    const order = await this.prisma.order.findUnique({
      where: { id: returnData.orderId },
    });

    const jtlReturn: JTLReturn = {
      merchantReturnNumber: returnData.localReturnId,
      warehouseId: this.config.jtlWarehouseId,
      fulfillerId: this.config.jtlFulfillerId,
      items: validItems.map((item, index) => ({
        returnItemId: `${returnData.localReturnId}-${index}`,
        jfsku: item.jtlJfsku!,
        merchantSku: item.sku,
        quantity: item.quantity,
        outboundId: order?.jtlOutboundId || undefined,
      })),
    };

    try {
      const result = await this.jtlService.createReturn(jtlReturn);
      
      await this.prisma.return.update({
        where: { id: returnData.localReturnId },
        data: {
          jtlReturnId: result.returnId,
          status: 'ANNOUNCED',
          lastJtlSync: new Date(),
        },
      });
    } catch (error) {
      console.error(`Failed to push return ${returnData.localReturnId} to JTL:`, error);
      throw error;
    }
  }

  // ============= JTL UPDATES POLLING =============

  /**
   * Link existing JTL outbounds to local orders by matching order numbers
   * This is a one-time reconciliation for historical orders that exist in JTL FFN
   * but haven't been linked to local orders yet.
   */
  async linkJTLOutboundsToOrders(): Promise<{ linked: number; alreadyLinked: number; notFound: number; errors: string[] }> {
    console.log(`\n[JTL] ${'─'.repeat(50)}`);
    console.log('[JTL] Starting outbound-to-order linking reconciliation...');
    console.log(`[JTL] ${'─'.repeat(50)}`);

    let linked = 0;
    let alreadyLinked = 0;
    let notFound = 0;
    const errors: string[] = [];

    try {
      // Fetch all outbounds from JTL (paginated automatically)
      const jtlOutbounds = await this.jtlService.getAllOutbounds();

      // Map to our internal structure
      const allOutbounds: Array<{ id: string; merchantOutboundNumber: string; status: string }> = jtlOutbounds.map(outbound => ({
        id: outbound.outboundId,
        merchantOutboundNumber: outbound.merchantOutboundNumber,
        status: outbound.status,
      }));

      // Get all orders for this channel that don't have a jtlOutboundId yet
      const unlinkdOrders = await this.prisma.order.findMany({
        where: {
          channelId: this.config.channelId,
          jtlOutboundId: null,
        },
        select: {
          id: true,
          orderId: true,
          orderNumber: true,
          externalOrderId: true,
        },
      });

      console.log(`[JTL] Found ${unlinkdOrders.length} local orders without JTL outbound link`);

      // Create a map for quick lookup by various order identifiers
      const orderMap = new Map<string, { id: string; orderId: string; orderNumber: string | null; externalOrderId: string | null }>();
      for (const order of unlinkdOrders) {
        // Map by orderId (our internal display ID)
        if (order.orderId) {
          orderMap.set(order.orderId.toLowerCase(), order);
        }
        // Map by orderNumber
        if (order.orderNumber) {
          orderMap.set(order.orderNumber.toLowerCase(), order);
        }
        // Map by externalOrderId (Shopify/WooCommerce order ID)
        if (order.externalOrderId) {
          orderMap.set(order.externalOrderId.toLowerCase(), order);
        }
      }

      // Try to match each outbound to a local order
      for (const outbound of allOutbounds) {
        try {
          // Check if this outbound is already linked to an order
          const existingLink = await this.prisma.order.findFirst({
            where: { jtlOutboundId: outbound.id },
            select: { id: true },
          });

          if (existingLink) {
            alreadyLinked++;
            continue;
          }

          // Try to find matching order by merchantOutboundNumber
          const merchantNum = outbound.merchantOutboundNumber?.toLowerCase();
          const matchedOrder = merchantNum ? orderMap.get(merchantNum) : null;

          if (matchedOrder) {
            // Link the order to the JTL outbound
            const newStatus = this.mapJTLStatusToOrderStatus(outbound.status);
            const newFulfillmentState = this.mapJTLStatusToFulfillmentState(outbound.status);

            // Prepare update data
            const updateData: any = {
              jtlOutboundId: outbound.id,
              status: newStatus,
              fulfillmentState: newFulfillmentState as any,
              lastJtlSync: new Date(),
            };

            // If status is shipped, fetch tracking info
            if (outbound.status.toLowerCase() === 'shipped') {
              try {
                const notifications = await this.jtlService.getShippingNotifications(outbound.id);
                if (notifications.success && notifications.data) {
                  const trackingInfo = this.jtlService.extractTrackingInfo(notifications.data);
                  if (trackingInfo.trackingNumber) {
                    updateData.trackingNumber = trackingInfo.trackingNumber;
                    updateData.trackingUrl = trackingInfo.trackingUrl;
                    updateData.carrierSelection = trackingInfo.carrier || null;
                    updateData.shippedAt = new Date();
                    console.log(`[JTL] Updated tracking for order ${matchedOrder.orderId}: ${trackingInfo.trackingNumber} (carrier: ${trackingInfo.carrier})`);
                  }
                }
              } catch (trackingError) {
                console.error(`[JTL] Failed to fetch tracking for order ${matchedOrder.orderId}:`, trackingError);
              }
            }

            await this.prisma.order.update({
              where: { id: matchedOrder.id },
              data: updateData,
            });

            console.log(`[JTL] Linked order ${matchedOrder.orderId} to outbound ${outbound.id} (status: ${outbound.status})`);
            linked++;

            // If shipped, also update Shopify fulfillment
            if (outbound.status.toLowerCase() === 'shipped') {
              if (updateData.trackingNumber) {
                try {
                  console.log(`[Shopify] Triggering fulfillment update for order ${matchedOrder.orderId} with tracking ${updateData.trackingNumber}`);
                  await this.updateShopifyFulfillmentForOrder(matchedOrder.id, updateData.trackingNumber, updateData.trackingUrl);
                } catch (shopifyError) {
                  console.error(`[JTL] Failed to update Shopify fulfillment for order ${matchedOrder.orderId}:`, shopifyError);
                }
              } else {
                console.log(`[Shopify] Skipping fulfillment update for order ${matchedOrder.orderId} - no tracking number available`);
              }
            }

            // Remove from map so we don't try to link it again
            if (matchedOrder.orderId) orderMap.delete(matchedOrder.orderId.toLowerCase());
            if (matchedOrder.orderNumber) orderMap.delete(matchedOrder.orderNumber.toLowerCase());
            if (matchedOrder.externalOrderId) orderMap.delete(matchedOrder.externalOrderId.toLowerCase());
          } else {
            notFound++;
          }
        } catch (error) {
          const errMsg = `Failed to link outbound ${outbound.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          errors.push(errMsg);
          console.error(`[JTL] ${errMsg}`);
        }
      }

      console.log(`[JTL] Outbound linking complete: ${linked} linked, ${alreadyLinked} already linked, ${notFound} not found in local DB`);

      return { linked, alreadyLinked, notFound, errors };
    } catch (error) {
      const errMsg = `Failed to fetch outbounds from JTL: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(`[JTL] ${errMsg}`);
      errors.push(errMsg);
      return { linked, alreadyLinked, notFound, errors };
    }
  }

  /**
   * Push orphaned orders (orders without jtlOutboundId) to JTL FFN
   *
   * This method finds orders that were pulled from Shopify/WooCommerce but never
   * pushed to JTL FFN, and queues them for sync.
   *
   * Order Eligibility Criteria:
   * - Has no jtlOutboundId (not already linked to JTL)
   * - isCancelled = false
   * - isOnHold = false (or holdReason not in AWAITING_PAYMENT, SHIPPING_METHOD_MISMATCH)
   * - Has at least one item with a jtlProductId (product mapping exists)
   *
   * @returns Statistics about queued, skipped, and errored orders
   */
  async pushOrphanedOrdersToJTL(): Promise<{
    queued: number;
    skippedAlreadyLinked: number;
    skippedCancelled: number;
    skippedOnHold: number;
    skippedNoProductMapping: number;
    errors: string[];
  }> {
    console.log(`\n[JTL] ${'─'.repeat(50)}`);
    console.log('[JTL] Starting orphaned orders push to JTL FFN...');
    console.log(`[JTL] ${'─'.repeat(50)}`);

    const result = {
      queued: 0,
      skippedAlreadyLinked: 0,
      skippedCancelled: 0,
      skippedOnHold: 0,
      skippedNoProductMapping: 0,
      errors: [] as string[],
    };

    try {
      // Find orders for this channel that don't have a jtlOutboundId
      const orphanedOrders = await this.prisma.order.findMany({
        where: {
          channelId: this.config.channelId,
          jtlOutboundId: null,
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  jtlProductId: true,
                },
              },
            },
          },
        },
      });

      console.log(`[JTL] Found ${orphanedOrders.length} orders without JTL outbound link`);

      if (orphanedOrders.length === 0) {
        console.log('[JTL] No orphaned orders to process');
        return result;
      }

      // Process each orphaned order
      for (const order of orphanedOrders) {
        try {
          // Check eligibility criteria

          // 1. Skip if already has jtlOutboundId (shouldn't happen due to query, but be safe)
          if (order.jtlOutboundId) {
            result.skippedAlreadyLinked++;
            continue;
          }

          // 2. Skip cancelled orders
          if (order.isCancelled) {
            console.log(`[JTL] Skipping cancelled order ${order.orderNumber}`);
            result.skippedCancelled++;
            continue;
          }

          // 3. Skip orders on hold with specific reasons
          if (order.isOnHold) {
            const holdReason = order.holdReason;
            // Skip if on payment hold or shipping method mismatch
            if (holdReason === 'AWAITING_PAYMENT' || holdReason === 'SHIPPING_METHOD_MISMATCH') {
              console.log(`[JTL] Skipping on-hold order ${order.orderNumber} (reason: ${holdReason})`);
              result.skippedOnHold++;
              continue;
            }
            // Other hold reasons may still be eligible - admin put them on hold for review
            // but once reviewed they can be synced
          }

          // 4. Check if at least one item has a JTL product mapping
          const hasProductMapping = order.items.some(
            (item) => item.product?.jtlProductId
          );

          if (!hasProductMapping) {
            console.log(`[JTL] Skipping order ${order.orderNumber} - no items have JTL product mapping`);
            result.skippedNoProductMapping++;
            continue;
          }

          // Order is eligible - queue for FFN sync
          const queueResult = await this.queueOrderForFfnSync(order.id, order.orderNumber || order.orderId);

          if (queueResult.success) {
            result.queued++;
          } else {
            result.errors.push(`Order ${order.orderNumber}: ${queueResult.error}`);
          }
        } catch (error: any) {
          const errMsg = `Failed to process order ${order.orderNumber || order.id}: ${error.message}`;
          console.error(`[JTL] ${errMsg}`);
          result.errors.push(errMsg);
        }
      }

      console.log(`\n[JTL] ${'─'.repeat(50)}`);
      console.log(`[JTL] Orphaned orders push complete:`);
      console.log(`[JTL]   ✅ Queued for FFN sync: ${result.queued}`);
      console.log(`[JTL]   ⏭️  Skipped (already linked): ${result.skippedAlreadyLinked}`);
      console.log(`[JTL]   ❌ Skipped (cancelled): ${result.skippedCancelled}`);
      console.log(`[JTL]   ⏸️  Skipped (on hold): ${result.skippedOnHold}`);
      console.log(`[JTL]   📦 Skipped (no product mapping): ${result.skippedNoProductMapping}`);
      console.log(`[JTL]   ⚠️  Errors: ${result.errors.length}`);
      console.log(`[JTL] ${'─'.repeat(50)}\n`);

      return result;
    } catch (error: any) {
      console.error('[JTL] Orphaned orders push failed:', error);
      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Queue an order for FFN sync via pg-boss queue
   *
   * @param orderId The order ID to queue
   * @param orderIdentifier Human-readable order identifier for logging
   * @returns Success status and any error message
   */
  private async queueOrderForFfnSync(
    orderId: string,
    orderIdentifier: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Get the queue instance
      let queue;
      try {
        queue = getQueue();
      } catch (queueError) {
        // Queue not initialized - fall back to direct sync
        console.log(`[JTL] Queue not available, attempting direct sync for order ${orderIdentifier}`);
        return await this.directSyncOrderToFfn(orderId, orderIdentifier);
      }

      // Prepare job data
      const jobData: OrderSyncJobData = {
        orderId,
        origin: 'nolimits',
        operation: 'create',
      };

      // Enqueue with deduplication key to prevent duplicate jobs
      const jobId = await queue.enqueue(
        QUEUE_NAMES.ORDER_SYNC_TO_FFN,
        jobData,
        {
          singletonKey: `ffn-sync-${orderId}`, // Prevent duplicate jobs for same order
          priority: 1,
          retryLimit: 3,
          retryDelay: 60,
          retryBackoff: true,
        }
      );

      if (jobId) {
        console.log(`[JTL] Queued order ${orderIdentifier} for FFN sync (job: ${jobId})`);

        // Update order sync status to PENDING
        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            syncStatus: 'PENDING',
          },
        });

        return { success: true };
      } else {
        // Job wasn't created (might be duplicate due to singletonKey)
        console.log(`[JTL] Order ${orderIdentifier} already queued or duplicate prevented`);
        return { success: true }; // Still consider this success - job exists
      }
    } catch (error: any) {
      console.error(`[JTL] Failed to queue order ${orderIdentifier}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fallback: Direct sync order to FFN when queue is not available
   * This is a simplified version that just pushes the order directly
   */
  private async directSyncOrderToFfn(
    orderId: string,
    orderIdentifier: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Get the order with items
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            include: {
              product: {
                select: { jtlProductId: true },
              },
            },
          },
        },
      });

      if (!order) {
        return { success: false, error: 'Order not found' };
      }

      // Build order data for pushOrderToJTL
      const orderData: OrderSyncData & { status: OrderStatus } = {
        localOrderId: order.id,
        externalOrderId: order.externalOrderId || '',
        orderNumber: order.orderNumber || order.orderId,
        items: order.items.map((item) => ({
          sku: item.sku || '',
          productName: item.productName || undefined,
          quantity: item.quantity,
          unitPrice: item.unitPrice ? Number(item.unitPrice) : undefined,
          jtlJfsku: item.product?.jtlProductId || undefined,
        })),
        shippingAddress: {
          firstname: order.shippingFirstName || '',
          lastname: order.shippingLastName || '',
          company: order.shippingCompany || undefined,
          street: order.shippingAddress1 || '',
          zip: order.shippingZip || '',
          city: order.shippingCity || '',
          country: order.shippingCountry || '',
          email: order.customerEmail || undefined,
          phone: order.customerPhone || undefined,
        },
        customerEmail: order.customerEmail || undefined,
        status: order.status,
      };

      // Push to JTL
      await this.pushOrderToJTL(orderData);

      console.log(`[JTL] Direct sync completed for order ${orderIdentifier}`);
      return { success: true };
    } catch (error: any) {
      console.error(`[JTL] Direct sync failed for order ${orderIdentifier}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Poll JTL for outbound (order) status updates
   */
  async pollJTLOutboundUpdates(since: Date): Promise<SyncResult> {
    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    try {
      const response = await this.jtlService.getOutboundUpdates({
        fromDate: since.toISOString(),
        toDate: new Date(Date.now() - 5000).toISOString(), // Subtract 5s to avoid clock sync issues
        page: 1,
      });

      for (const update of response.data) {
        try {
          // Find order by JTL outbound ID
          const order = await this.prisma.order.findFirst({
            where: { jtlOutboundId: update.outboundId },
          });

          if (order) {
            // Map JTL status to our order status and fulfillment state
            const newStatus = this.mapJTLStatusToOrderStatus(update.status);
            const newFulfillmentState = this.mapJTLStatusToFulfillmentState(update.status);

            console.log(`[JTL] Order ${order.id} status update: JTL=${update.status} -> status=${newStatus}, fulfillmentState=${newFulfillmentState}`);

            await this.prisma.order.update({
              where: { id: order.id },
              data: {
                status: newStatus,
                fulfillmentState: newFulfillmentState as any, // Cast to enum type
                lastJtlSync: new Date(),
              },
            });

            // Update e-commerce platform with fulfillment status if shipped
            if (newStatus === 'SHIPPED') {
              await this.updateChannelOrderStatus(order.id, 'fulfilled');
            }

            results.push({
              externalId: update.outboundId,
              localId: order.id,
              success: true,
              action: 'updated',
            });
            itemsProcessed++;
          }
        } catch (error) {
          results.push({
            externalId: update.outboundId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            action: 'failed',
          });
          itemsFailed++;
        }
      }

      return {
        success: itemsFailed === 0,
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
        details: results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
      };
    }
  }

  /**
   * Poll JTL for return status updates
   */
  async pollJTLReturnUpdates(since: Date): Promise<SyncResult> {
    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    try {
      const updates = await this.jtlService.getReturnUpdates({
        since: since.toISOString(),
      });

      for (const update of updates) {
        try {
          const returnRecord = await this.prisma.return.findFirst({
            where: { jtlReturnId: update.id },
          });

          if (returnRecord) {
            const newStatus = this.mapJTLStatusToReturnStatus(update.data.status);
            
            await this.prisma.return.update({
              where: { id: returnRecord.id },
              data: {
                status: newStatus,
                lastJtlSync: new Date(),
              },
            });

            results.push({
              externalId: update.id,
              localId: returnRecord.id,
              success: true,
              action: 'updated',
            });
            itemsProcessed++;
          }
        } catch (error) {
          results.push({
            externalId: update.id,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            action: 'failed',
          });
          itemsFailed++;
        }
      }

      return {
        success: itemsFailed === 0,
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
        details: results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        syncedAt: new Date(),
        itemsProcessed,
        itemsFailed,
      };
    }
  }

  /**
   * Update e-commerce channel with order status
   * Called when JTL reports fulfillment updates (shipped, tracking, etc.)
   */
  private async updateChannelOrderStatus(orderId: string, status: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        channel: true,
        items: true,
      },
    });

    if (!order) return;

    // If no channel linked, nothing to update
    if (!order.channel) {
      console.log(`[SyncOrchestrator] Order ${orderId} has no linked channel, skipping fulfillment update`);
      return;
    }

    try {
      const encryptionService = getEncryptionService();

      if (order.channel.type === 'SHOPIFY') {
        // Update Shopify order with fulfillment info
        if (!order.channel.shopDomain || !order.channel.accessToken) {
          console.log(`[SyncOrchestrator] Missing Shopify credentials for channel ${order.channel.id}`);
          return;
        }

        const shopifyService = createShopifyServiceAuto({
          shopDomain: order.channel.shopDomain,
          accessToken: encryptionService.safeDecrypt(order.channel.accessToken),
        });

        // Map status to Shopify fulfillment status
        const fulfillmentStatus = this.mapStatusToShopifyFulfillment(status);

        if (fulfillmentStatus === 'fulfilled' && order.trackingNumber) {
          // Create fulfillment with tracking info
          const externalOrderId = order.externalOrderId ? parseInt(order.externalOrderId) : null;
          if (externalOrderId) {
            try {
              // Get the first active location for fulfillment
              // The GraphQL service handles this automatically, but REST needs it
              let locationId = 1; // Default fallback
              try {
                // Check if getLocations method exists (REST service has it, GraphQL doesn't)
                if ('getLocations' in shopifyService && typeof (shopifyService as any).getLocations === 'function') {
                  const locations = await (shopifyService as any).getLocations();
                  const activeLocation = locations.find((loc: { id: number; name: string; active: boolean }) => loc.active);
                  if (activeLocation) {
                    locationId = activeLocation.id;
                  }
                }
              } catch (locError) {
                console.log(`[SyncOrchestrator] Could not fetch locations, using default: ${locError}`);
              }

              await shopifyService.createFulfillment(
                externalOrderId,
                {
                  location_id: locationId,
                  tracking_number: order.trackingNumber,
                  tracking_company: order.carrierSelection || undefined,
                  notify_customer: true,
                  // Don't pass line_items - let the service fulfill all remaining items
                }
              );
              console.log(`[SyncOrchestrator] Created Shopify fulfillment for order ${orderId}`);
            } catch (fulfillError: any) {
              // Handle common fulfillment errors gracefully
              if (fulfillError.message?.includes('already fulfilled')) {
                console.log(`[SyncOrchestrator] Order ${orderId} already fulfilled in Shopify`);
              } else if (fulfillError.message?.includes('on hold')) {
                console.log(`[SyncOrchestrator] Order ${orderId} is on hold in Shopify: ${fulfillError.message}`);
              } else {
                throw fulfillError;
              }
            }
          }
        } else if (fulfillmentStatus && order.externalOrderId) {
          // Update order status
          const externalOrderId = parseInt(order.externalOrderId);
          if (!isNaN(externalOrderId)) {
            // Update order note with status (note_attributes not supported in updateOrder)
            const existingNote = order.notes || '';
            const statusNote = `\n[No-Limits] Status: ${status} (${new Date().toISOString()})`;
            await shopifyService.updateOrder(externalOrderId, {
              note: existingNote + statusNote,
            });
          }
        }
      } else if (order.channel.type === 'WOOCOMMERCE') {
        // Update WooCommerce order status
        if (!order.channel.apiUrl || !order.channel.apiClientId || !order.channel.apiClientSecret) {
          console.log(`[SyncOrchestrator] Missing WooCommerce credentials for channel ${order.channel.id}`);
          return;
        }

        const wooService = new WooCommerceService({
          url: order.channel.apiUrl,
          consumerKey: encryptionService.safeDecrypt(order.channel.apiClientId),
          consumerSecret: encryptionService.safeDecrypt(order.channel.apiClientSecret),
        });

        // Map status to WooCommerce order status
        const wooStatus = this.mapStatusToWooCommerceStatus(status);

        if (order.externalOrderId) {
          await wooService.updateOrderStatus(
            parseInt(order.externalOrderId),
            wooStatus
          );

          console.log(`[SyncOrchestrator] Updated WooCommerce order ${order.externalOrderId} to status: ${wooStatus}`);
        }
      }

      // Log the fulfillment update
      await this.prisma.orderSyncLog.create({
        data: {
          orderId,
          action: 'fulfill',
          origin: 'JTL',
          targetPlatform: order.channel.type.toLowerCase(),
          success: true,
          changedFields: ['status', 'trackingNumber'],
        },
      });

      // Update order sync status
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          lastSyncedToCommerce: new Date(),
          syncStatus: 'SYNCED',
        },
      });
    } catch (error) {
      console.error(`[SyncOrchestrator] Failed to update channel order status:`, error);
      
      // Log the failure
      await this.prisma.orderSyncLog.create({
        data: {
          orderId,
          action: 'fulfill',
          origin: 'JTL',
          targetPlatform: order.channel?.type?.toLowerCase() || 'unknown',
          success: false,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  /**
   * Map internal status to Shopify fulfillment status
   */
  private mapStatusToShopifyFulfillment(status: string): string | null {
    const statusMap: Record<string, string> = {
      'SHIPPED': 'fulfilled',
      'DELIVERED': 'fulfilled',
      'PROCESSING': 'partial',
      'CANCELLED': 'restocked',
    };
    return statusMap[status.toUpperCase()] || null;
  }

  /**
   * Map internal status to WooCommerce order status
   */
  private mapStatusToWooCommerceStatus(status: string): string {
    const statusMap: Record<string, string> = {
      'PENDING': 'pending',
      'PROCESSING': 'processing',
      'FULFILLED': 'completed',
      'SHIPPED': 'completed',
      'DELIVERED': 'completed',
      'CANCELLED': 'cancelled',
      'ON_HOLD': 'on-hold',
    };
    return statusMap[status.toUpperCase()] || 'processing';
  }

  /**
   * Map JTL outbound status to internal order status
   * JTL statuses: Preparation, Pending, Acknowledged, Pickprocess, Locked, PartiallyShipped, Shipped, PartiallyCanceled, Canceled
   */
  private mapJTLStatusToOrderStatus(jtlStatus: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      'Preparation': 'PROCESSING',
      'Pending': 'PROCESSING',
      'Acknowledged': 'PROCESSING',
      'Pickprocess': 'PROCESSING',
      'Locked': 'ON_HOLD',
      'PartiallyShipped': 'PARTIALLY_FULFILLED',
      'Shipped': 'SHIPPED',
      'PartiallyCanceled': 'PARTIALLY_FULFILLED',
      'Canceled': 'CANCELLED',
      // Legacy mappings for backwards compatibility
      'Created': 'PROCESSING',
      'Accepted': 'PROCESSING',
      'Processing': 'PROCESSING',
      'Packed': 'PROCESSING',
      'Delivered': 'DELIVERED',
      'Cancelled': 'CANCELLED',
    };

    return statusMap[jtlStatus] || 'PENDING';
  }

  /**
   * Map JTL outbound status to internal fulfillment state
   * This provides more granular tracking of the operational state
   */
  private mapJTLStatusToFulfillmentState(jtlStatus: string): string {
    const stateMap: Record<string, string> = {
      'Preparation': 'PENDING',
      'Pending': 'READY_FOR_PICKING',
      'Acknowledged': 'READY_FOR_PICKING',
      'Pickprocess': 'PICKING',
      'Locked': 'PENDING',
      'PartiallyShipped': 'SHIPPED',
      'Shipped': 'SHIPPED',
      'PartiallyCanceled': 'PENDING',
      'Canceled': 'PENDING',
      // Legacy/additional mappings
      'Created': 'PENDING',
      'Accepted': 'READY_FOR_PICKING',
      'Processing': 'PICKING',
      'Packed': 'PACKED',
      'Delivered': 'DELIVERED',
    };

    return stateMap[jtlStatus] || 'PENDING';
  }

  /**
   * Map JTL return status to internal return status
   */
  private mapJTLStatusToReturnStatus(jtlStatus: string): ReturnStatus {
    const statusMap: Record<string, ReturnStatus> = {
      'Announced': 'ANNOUNCED',
      'Received': 'RECEIVED',
      'Processed': 'PROCESSED',
      'Completed': 'PROCESSED',
    };

    return statusMap[jtlStatus] || 'ANNOUNCED';
  }

  /**
   * Update sync job progress
   * Non-blocking - failures don't stop sync
   */
  private async updateSyncProgress(
    syncJobId: string | undefined,
    updates: {
      currentPhase?: string;
      totalProducts?: number;
      syncedProducts?: number;
      failedProducts?: number;
      totalOrders?: number;
      syncedOrders?: number;
      failedOrders?: number;
      totalReturns?: number;
      syncedReturns?: number;
      failedReturns?: number;
    }
  ): Promise<void> {
    if (!syncJobId) return;

    try {
      await this.prisma.syncJob.update({
        where: { id: syncJobId },
        data: updates,
      });
    } catch (error) {
      console.error('[Progress] Update failed:', error);
      // Don't fail sync if progress update fails
    }
  }

  // ============= CHANNEL-ONLY PULL (NO JTL) =============

  /**
   * Pull data from sales channel to local DB only (no JTL push)
   * Used during initial sync pipeline Step 1 to avoid duplicate errors in JTL
   *
   * This method:
   * - Pulls products, orders, and returns from Shopify/WooCommerce
   * - Saves them to the local database
   * - Does NOT push anything to JTL FFN
   *
   * @param since Optional date to limit sync to data created/updated since this date
   */
  async pullFromChannelOnly(since?: Date): Promise<{
    products: { itemsProcessed: number; itemsFailed: number };
    orders: { itemsProcessed: number; itemsFailed: number };
    returns: { itemsProcessed: number; itemsFailed: number; itemsSkipped: number };
  }> {
    console.log(`[SyncOrchestrator] Pull from channel only (no JTL push) since ${since?.toISOString() || 'all'}`);

    const results = {
      products: { itemsProcessed: 0, itemsFailed: 0 },
      orders: { itemsProcessed: 0, itemsFailed: 0 },
      returns: { itemsProcessed: 0, itemsFailed: 0, itemsSkipped: 0 },
    };

    // Verify channel exists
    const channel = await this.prisma.channel.findUnique({
      where: { id: this.config.channelId },
      select: { id: true },
    });
    if (!channel) throw new Error('Channel not found');

    // PHASE 1: Pull and store products (NO JTL push)
    try {
      const channelProducts = await this.pullProductsFromChannel(since);
      console.log(`[SyncOrchestrator] Pulled ${channelProducts.length} products from channel`);

      for (const product of channelProducts) {
        try {
          // upsertProductInDB already fetches clientId from channel internally
          await this.upsertProductInDB(product);
          results.products.itemsProcessed++;
        } catch (error) {
          console.error(`[SyncOrchestrator] Failed to save product ${product.sku}:`, error);
          results.products.itemsFailed++;
        }
      }
    } catch (error) {
      console.error('[SyncOrchestrator] Failed to pull products:', error);
    }

    // PHASE 2: Pull and store orders (NO JTL push)
    try {
      // Reset order upsert stats
      this.orderUpsertStats = { created: 0, updated: 0 };

      // Check existing orders count before sync
      const existingOrderCount = await this.prisma.order.count({
        where: { channelId: this.config.channelId },
      });
      console.log(`[SyncOrchestrator] Existing orders in DB for this channel: ${existingOrderCount}`);

      const channelOrders = await this.pullOrdersFromChannel(since);
      console.log(`[SyncOrchestrator] Pulled ${channelOrders.length} orders from channel`);

      // Check for duplicate external order IDs
      const externalIds = channelOrders.map(o => o.externalOrderId);
      const uniqueIds = new Set(externalIds);
      if (uniqueIds.size !== externalIds.length) {
        console.log(`[SyncOrchestrator] WARNING: Found ${externalIds.length - uniqueIds.size} duplicate external order IDs!`);
      } else {
        console.log(`[SyncOrchestrator] All ${uniqueIds.size} external order IDs are unique`);
      }

      for (const order of channelOrders) {
        try {
          await this.upsertOrderInDB(order);
          results.orders.itemsProcessed++;
        } catch (error) {
          console.error(`[SyncOrchestrator] Failed to save order ${order.orderNumber}:`, error);
          results.orders.itemsFailed++;
        }
      }

      console.log(`[SyncOrchestrator] Order upsert stats: ${this.orderUpsertStats.created} created, ${this.orderUpsertStats.updated} updated`);

      // Final count after sync
      const finalOrderCount = await this.prisma.order.count({
        where: { channelId: this.config.channelId },
      });
      console.log(`[SyncOrchestrator] Final orders in DB for this channel: ${finalOrderCount}`);
    } catch (error) {
      console.error('[SyncOrchestrator] Failed to pull orders:', error);
    }

    // PHASE 3: Pull and store returns (NO JTL push)
    try {
      const channelReturns = await this.pullRefundsFromChannel(since);
      console.log(`[SyncOrchestrator] Pulled ${channelReturns.length} returns from channel`);

      for (const ret of channelReturns) {
        try {
          const savedReturn = await this.createReturnInDB(ret);
          if (savedReturn) {
            results.returns.itemsProcessed++;
          } else {
            results.returns.itemsSkipped++;
          }
        } catch (error) {
          console.error(`[SyncOrchestrator] Failed to save return:`, error);
          results.returns.itemsFailed++;
        }
      }
    } catch (error) {
      console.error('[SyncOrchestrator] Failed to pull returns:', error);
    }

    console.log(`[SyncOrchestrator] Pull from channel only complete:`, results);
    return results;
  }

  // ============= FULL SYNC =============

  /**
   * Run full sync of all data types (OPTIMIZED with parallel processing)
   * @param since Optional date to limit sync to data updated since this date (for initial sync with 180-day limit)
   * @param syncJobId Optional sync job ID for progress tracking
   */
  async runFullSync(since?: Date, syncJobId?: string): Promise<{
    products: SyncResult;
    orders: SyncResult;
    returns: SyncResult;
  }> {
    console.log('[SyncOrchestrator] Starting optimized full sync', {
      channelId: this.config.channelId,
      syncJobId,
      since: since?.toISOString(),
    });

    try {
      // Get channel info to retrieve clientId
      const channel = await this.prisma.channel.findUnique({
        where: { id: this.config.channelId },
        select: { clientId: true },
      });

      if (!channel) {
        throw new Error(`Channel ${this.config.channelId} not found`);
      }

      // Initialize product cache for O(1) lookups during order/return sync
      this.productCache = new ProductCache(this.prisma);
      await this.productCache.initialize(channel.clientId);

      // Update sync job: starting products phase
      await this.updateSyncProgress(syncJobId, {
        currentPhase: 'products',
      });

      // PHASE 1: Sync products (sequential - orders depend on product JTL IDs)
      const productsResult = since
        ? await this.syncProductsIncremental(since)
        : await this.syncProducts();

      // Refresh product cache after products sync (now has JTL IDs)
      await this.productCache.initialize(channel.clientId);

      // Update sync job: products complete, starting parallel phase
      await this.updateSyncProgress(syncJobId, {
        currentPhase: 'parallel',
      });

      // PHASE 2: Sync orders + returns in PARALLEL (both can run independently)
      const [ordersResult, returnsResult] = await Promise.all([
        (async () => {
          await this.updateSyncProgress(syncJobId, { currentPhase: 'orders' });
          return since
            ? await this.syncOrdersIncremental(since)
            : await this.syncOrders();
        })(),
        (async () => {
          await this.updateSyncProgress(syncJobId, { currentPhase: 'returns' });
          return await this.syncReturns(since);
        })(),
      ]);

      // Clear product cache
      this.productCache.clear();
      this.productCache = undefined;

      console.log('[SyncOrchestrator] Optimized full sync completed', {
        channelId: this.config.channelId,
        syncJobId,
        results: {
          products: {
            processed: productsResult.itemsProcessed,
            failed: productsResult.itemsFailed,
          },
          orders: {
            processed: ordersResult.itemsProcessed,
            failed: ordersResult.itemsFailed,
          },
          returns: {
            processed: returnsResult.itemsProcessed,
            failed: returnsResult.itemsFailed,
          },
        },
      });

      return {
        products: productsResult,
        orders: ordersResult,
        returns: returnsResult,
      };
    } catch (error) {
      // Clean up cache on error
      if (this.productCache) {
        this.productCache.clear();
        this.productCache = undefined;
      }

      console.error('[SyncOrchestrator] Full sync failed:', error);
      throw error;
    }
  }

  /**
   * Run incremental sync of all data types
   */
  async runIncrementalSync(since: Date): Promise<{
    products: SyncResult;
    orders: SyncResult;
    returns: SyncResult;
    jtlOutboundUpdates: SyncResult;
    jtlReturnUpdates: SyncResult;
  }> {
    const productsResult = await this.syncProductsIncremental(since);
    const ordersResult = await this.syncOrdersIncremental(since);
    const returnsResult = await this.syncReturns(since);
    const jtlOutboundUpdates = await this.pollJTLOutboundUpdates(since);
    const jtlReturnUpdates = await this.pollJTLReturnUpdates(since);

    return {
      products: productsResult,
      orders: ordersResult,
      returns: returnsResult,
      jtlOutboundUpdates,
      jtlReturnUpdates,
    };
  }

  /**
   * Sync historical order statuses from JTL FFN
   * This method:
   * 1. Gets all orders for the channel that have jtlOutboundId
   * 2. Fetches their current status from JTL FFN
   * 3. Updates the local database
   * 4. Pushes the status to the channel (Shopify/WooCommerce)
   */
  async syncHistoricalOrderStatuses(): Promise<{
    success: boolean;
    totalOrders: number;
    statusesUpdated: number;
    channelsPushed: number;
    errors: string[];
  }> {
    console.log(`[SyncOrchestrator] Starting historical order status sync for channel ${this.config.channelId}`);

    const result = {
      success: true,
      totalOrders: 0,
      statusesUpdated: 0,
      channelsPushed: 0,
      errors: [] as string[],
    };

    try {
      // Get all orders for this channel that have JTL outbound IDs
      const orders = await this.prisma.order.findMany({
        where: {
          channelId: this.config.channelId,
          jtlOutboundId: { not: null },
        },
        include: {
          channel: true,
          items: true,
        },
      });

      result.totalOrders = orders.length;
      console.log(`[SyncOrchestrator] Found ${orders.length} orders with JTL outbound IDs`);

      if (orders.length === 0) {
        console.log(`[SyncOrchestrator] No orders with JTL outbound IDs found`);
        return result;
      }

      // Fetch all outbounds from JTL to get their statuses
      const outboundMap = new Map<string, { status: string; trackingNumber?: string; carrierName?: string }>();

      if (this.jtlService) {
        console.log(`[SyncOrchestrator] Fetching outbound statuses from JTL FFN...`);

        // Fetch all outbounds (handles pagination automatically)
        const outbounds = await this.jtlService.getAllOutbounds();

        for (const outbound of outbounds) {
          outboundMap.set(outbound.outboundId, {
            status: outbound.status,
          });
        }

        console.log(`[SyncOrchestrator] Fetched ${outboundMap.size} outbounds from JTL`);
      }

      // Process each order
      for (const order of orders) {
        try {
          const jtlOutbound = outboundMap.get(order.jtlOutboundId!);

          if (!jtlOutbound) {
            console.log(`[SyncOrchestrator] Outbound ${order.jtlOutboundId} not found in JTL for order ${order.id}`);
            continue;
          }

          // Map JTL status to internal status
          const newStatus = this.mapJTLStatusToInternal(jtlOutbound.status);
          const currentStatus = order.status;

          // Prepare update data
          const updateData: any = {
            status: newStatus as any,
            updatedAt: new Date(),
          };

          // If status is shipped and no tracking yet, fetch tracking info
          if ((newStatus === 'SHIPPED' || jtlOutbound.status.toLowerCase() === 'shipped' || jtlOutbound.status === 'Sent') && !order.trackingNumber) {
            try {
              const notifications = await this.jtlService.getShippingNotifications(order.jtlOutboundId!);
              if (notifications.success && notifications.data) {
                const trackingInfo = this.jtlService.extractTrackingInfo(notifications.data);
                if (trackingInfo.trackingNumber) {
                  updateData.trackingNumber = trackingInfo.trackingNumber;
                  updateData.trackingUrl = trackingInfo.trackingUrl;
                  updateData.carrierSelection = trackingInfo.carrier || null;
                  updateData.shippedAt = updateData.shippedAt || new Date();
                  console.log(`[SyncOrchestrator] Fetched tracking for order ${order.orderNumber}: ${trackingInfo.trackingNumber} (carrier: ${trackingInfo.carrier})`);
                }
              }
            } catch (trackingError) {
              console.error(`[SyncOrchestrator] Failed to fetch tracking for order ${order.orderNumber}:`, trackingError);
            }
          }

          // Only update if status changed or we have new tracking info
          if (newStatus !== currentStatus || updateData.trackingNumber) {
            console.log(`[SyncOrchestrator] Order ${order.orderNumber}: ${currentStatus} -> ${newStatus}`);

            // Update local database
            await this.prisma.order.update({
              where: { id: order.id },
              data: updateData,
            });

            result.statusesUpdated++;

            // Push to channel if order is shipped/delivered
            if (newStatus === 'SHIPPED' || newStatus === 'DELIVERED') {
              try {
                // Update Shopify fulfillment with tracking info
                if (updateData.trackingNumber) {
                  console.log(`[Shopify] Triggering fulfillment update for order ${order.orderNumber} with tracking ${updateData.trackingNumber}`);
                  await this.updateShopifyFulfillmentForOrder(order.id, updateData.trackingNumber, updateData.trackingUrl);
                } else {
                  console.log(`[Shopify] Skipping fulfillment update for order ${order.orderNumber} - no tracking number available`);
                }
                await this.updateChannelOrderStatus(order.id, newStatus);
                result.channelsPushed++;
                console.log(`[SyncOrchestrator] Pushed status to channel for order ${order.orderNumber}`);
              } catch (channelError: any) {
                console.error(`[SyncOrchestrator] Failed to push to channel for order ${order.orderNumber}:`, channelError.message);
                result.errors.push(`Order ${order.orderNumber}: Failed to push to channel - ${channelError.message}`);
              }
            }
          }
        } catch (orderError: any) {
          console.error(`[SyncOrchestrator] Error processing order ${order.orderNumber}:`, orderError.message);
          result.errors.push(`Order ${order.orderNumber}: ${orderError.message}`);
        }
      }

      console.log(`[SyncOrchestrator] Historical sync complete: ${result.statusesUpdated} statuses updated, ${result.channelsPushed} pushed to channels`);

    } catch (error: any) {
      console.error(`[SyncOrchestrator] Historical order status sync failed:`, error);
      result.success = false;
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Update Shopify fulfillment with tracking info when order is shipped
   * This creates a fulfillment in Shopify with tracking number and URL
   */
  private async updateShopifyFulfillmentForOrder(
    orderId: string,
    trackingNumber: string,
    trackingUrl?: string
  ): Promise<void> {
    // Get order with channel info
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        channel: true,
      },
    });

    if (!order || !order.channelId || !order.externalOrderId) {
      console.log(`[Shopify] Order ${orderId} not found or missing channel/external ID`);
      return;
    }

    // Only process Shopify orders
    if (order.channel?.type !== 'SHOPIFY') {
      console.log(`[Shopify] Order ${orderId} is not a Shopify order, skipping fulfillment update`);
      return;
    }

    // Check if we have a GraphQL service with fulfillment capability
    if (!this.shopifyService) {
      console.log(`[Shopify] No Shopify service available for order ${orderId}`);
      return;
    }

    // Check if it's a GraphQL service (has createFulfillmentWithTracking method)
    const { isGraphQLService } = await import('./shopify-service-factory.js');
    if (!isGraphQLService(this.shopifyService)) {
      console.log(`[Shopify] Shopify REST service doesn't support fulfillment creation with tracking`);
      return;
    }

    try {
      // Get carrier from order (populated from JTL freightOption) or default to DHL
      const carrier = order.carrierSelection || 'DHL';

      console.log(`[Shopify] Creating fulfillment for order ${order.orderId} (${order.externalOrderId}) with tracking ${trackingNumber}, carrier: ${carrier}`);

      // Create fulfillment with tracking in Shopify
      const result = await this.shopifyService.createFulfillmentWithTracking({
        orderId: `gid://shopify/Order/${order.externalOrderId}`,
        trackingNumber,
        trackingUrl,
        trackingCompany: carrier,
      });

      if (result.success) {
        console.log(`[Shopify] ✅ Created fulfillment for order ${order.orderId} with tracking ${trackingNumber}`);

        // Update order to mark it as synced to commerce
        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            lastSyncedToCommerce: new Date(),
            commerceSyncError: null,
          },
        });
      } else {
        console.error(`[Shopify] ❌ Failed to create fulfillment for order ${order.orderId}: ${result.error}`);

        // Store error for debugging
        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            commerceSyncError: result.error || 'Unknown error',
          },
        });
      }
    } catch (error: any) {
      console.error(`[Shopify] ❌ Error creating fulfillment for order ${order.orderId}:`, error.message);

      // Store error for debugging
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          commerceSyncError: error.message,
        },
      });
    }
  }

  /**
   * Map JTL outbound status to internal order status
   */
  private mapJTLStatusToInternal(jtlStatus: string): string {
    const statusMap: Record<string, string> = {
      'Open': 'PENDING',
      'InProgress': 'PROCESSING',
      'Sent': 'SHIPPED',
      'Delivered': 'DELIVERED',
      'Cancelled': 'CANCELLED',
      'PartiallyShipped': 'PROCESSING',
      'OnHold': 'ON_HOLD',
      'Returned': 'RETURNED',
    };

    return statusMap[jtlStatus] || 'PENDING';
  }

  /**
   * Fix existing order items that have NO-SKU-* values
   * This is a one-time migration to resolve NO-SKU items to their real products
   *
   * @returns Statistics about what was fixed
   */
  async fixExistingNoSkuItems(): Promise<{
    totalNoSkuItems: number;
    fixed: number;
    notFound: number;
    errors: string[];
  }> {
    console.log(`\n[SyncOrchestrator] ${'─'.repeat(50)}`);
    console.log('[SyncOrchestrator] Starting NO-SKU item fix for existing orders...');
    console.log(`[SyncOrchestrator] ${'─'.repeat(50)}`);

    const result = {
      totalNoSkuItems: 0,
      fixed: 0,
      notFound: 0,
      errors: [] as string[],
    };

    try {
      // Get channel info for clientId
      const channel = await this.prisma.channel.findUnique({
        where: { id: this.config.channelId },
        select: { clientId: true },
      });

      if (!channel) {
        throw new Error(`Channel ${this.config.channelId} not found`);
      }

      // Find all order items with NO-SKU-* for orders in this channel
      const noSkuItems = await this.prisma.orderItem.findMany({
        where: {
          sku: { startsWith: 'NO-SKU-' },
          order: {
            channelId: this.config.channelId,
          },
        },
        include: {
          order: {
            select: { id: true, orderNumber: true },
          },
        },
      });

      result.totalNoSkuItems = noSkuItems.length;
      console.log(`[SyncOrchestrator] Found ${noSkuItems.length} order items with NO-SKU-* values`);

      if (noSkuItems.length === 0) {
        console.log('[SyncOrchestrator] No NO-SKU items to fix');
        return result;
      }

      // Process each NO-SKU item
      for (const item of noSkuItems) {
        try {
          // Skip if SKU is somehow null (shouldn't happen with our query but TypeScript requires this)
          if (!item.sku) {
            console.log(`[SyncOrchestrator] Skipping item ${item.id} - SKU is null`);
            continue;
          }

          // Try to find the real product using fallback lookup
          const fallbackProduct = await this.findProductByFallback(
            item.sku,
            item.productName || undefined,
            channel.clientId
          );

          if (fallbackProduct) {
            // Update the order item with the real SKU and product reference
            await this.prisma.orderItem.update({
              where: { id: item.id },
              data: {
                sku: fallbackProduct.sku,
                productId: fallbackProduct.id,
              },
            });

            console.log(`[SyncOrchestrator] ✅ Fixed order item: ${item.sku} -> ${fallbackProduct.sku} (Order: ${item.order.orderNumber})`);
            result.fixed++;
          } else {
            console.log(`[SyncOrchestrator] ❌ Could not find product for: ${item.sku} (Order: ${item.order.orderNumber}, Name: "${item.productName}")`);
            result.notFound++;
          }
        } catch (error: any) {
          const errMsg = `Failed to fix item ${item.id} (${item.sku}): ${error.message}`;
          console.error(`[SyncOrchestrator] ${errMsg}`);
          result.errors.push(errMsg);
        }
      }

      console.log(`\n[SyncOrchestrator] ${'─'.repeat(50)}`);
      console.log(`[SyncOrchestrator] NO-SKU fix complete:`);
      console.log(`[SyncOrchestrator]   Total NO-SKU items: ${result.totalNoSkuItems}`);
      console.log(`[SyncOrchestrator]   Fixed: ${result.fixed}`);
      console.log(`[SyncOrchestrator]   Not found: ${result.notFound}`);
      console.log(`[SyncOrchestrator]   Errors: ${result.errors.length}`);
      console.log(`[SyncOrchestrator] ${'─'.repeat(50)}\n`);

      return result;
    } catch (error: any) {
      console.error('[SyncOrchestrator] NO-SKU fix failed:', error);
      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Find product by fallback methods when SKU is NO-SKU-*
   *
   * When Shopify orders don't include a SKU on the line item, we generate a fallback
   * like NO-SKU-{variant_id}. This method tries to find the actual product by:
   * 1. Extracting the variant_id from the NO-SKU string
   * 2. Looking up the product via ProductChannel table (externalProductId = variant_id)
   * 3. Optionally matching by product name if provided
   *
   * @param sku The SKU string (expected to be NO-SKU-{variant_id})
   * @param productName Optional product name to match against
   * @param clientId Optional client ID to filter products
   * @returns The matched product or null
   */
  private async findProductByFallback(
    sku: string,
    productName?: string,
    clientId?: string
  ): Promise<{ id: string; sku: string; jtlProductId: string | null; name: string } | null> {
    // Extract variant_id from NO-SKU-{variant_id}
    const variantIdMatch = sku.match(/^NO-SKU-(\d+)$/);
    if (!variantIdMatch) {
      return null;
    }

    const variantId = variantIdMatch[1];
    console.log(`[SyncOrchestrator] Attempting fallback product lookup for variant_id: ${variantId}, productName: "${productName}"`);

    // Method 1: Try to find by ProductChannel.externalProductId (variant ID)
    // This is the most reliable method as it matches the exact Shopify variant
    const productChannel = await this.prisma.productChannel.findFirst({
      where: {
        channelId: this.config.channelId,
        externalProductId: variantId,
      },
      include: {
        product: true,
      },
    });

    if (productChannel?.product) {
      console.log(`[SyncOrchestrator] ✅ Found product by variant_id ${variantId}: SKU=${productChannel.product.sku}, name="${productChannel.product.name}"`);
      return {
        id: productChannel.product.id,
        sku: productChannel.product.sku,
        jtlProductId: productChannel.product.jtlProductId,
        name: productChannel.product.name,
      };
    }

    // Method 2: Try to find by product name (fuzzy match)
    // This is less reliable but can catch cases where the variant ID mapping is missing
    if (productName) {
      // Build where clause
      const whereClause: any = {
        name: {
          contains: productName.split(' ')[0], // Match on first word of product name
          mode: 'insensitive',
        },
      };

      // Add clientId filter if provided
      if (clientId) {
        whereClause.clientId = clientId;
      }

      const productByName = await this.prisma.product.findFirst({
        where: whereClause,
      });

      if (productByName) {
        console.log(`[SyncOrchestrator] ✅ Found product by name match: SKU=${productByName.sku}, name="${productByName.name}" (searched for: "${productName}")`);
        return {
          id: productByName.id,
          sku: productByName.sku,
          jtlProductId: productByName.jtlProductId,
          name: productByName.name,
        };
      }
    }

    console.log(`[SyncOrchestrator] ❌ No product found for variant_id ${variantId} or name "${productName}"`);
    return null;
  }
}

export default SyncOrchestrator;
