/**
 * Enhanced Webhook Processor Service
 * 
 * Handles incoming webhooks from Shopify/WooCommerce and routes them to the
 * ProductSyncService for bi-directional sync with origin tracking.
 * 
 * Flow:
 * 1. Webhook arrives → Validate signature
 * 2. Parse payload → Extract product/order/return data
 * 3. Route to ProductSyncService → Process with field ownership rules
 * 4. Queue sync to other platforms → Async job processing
 */

import { PrismaClient, ChannelType, OrderStatus, ReturnStatus, SyncOrigin } from '@prisma/client';
import { ProductSyncService, IncomingProductData, SyncOriginType } from './product-sync.service.js';
import { OrderSyncService, IncomingOrderData } from './order-sync.service.js';
import { ReturnSyncService, IncomingReturnData } from './return-sync.service.js';
import crypto from 'crypto';
import { Logger } from '../../utils/logger.js';

// ============= TYPES =============

export interface WebhookEvent {
  channelId: string;
  channelType: ChannelType;
  topic: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  webhookId?: string; // Unique ID for deduplication
}

export interface WebhookProcessResult {
  success: boolean;
  action: 'created' | 'updated' | 'deleted' | 'cancelled' | 'fulfilled' | 'split' | 'conflict' | 'skipped' | 'failed';
  entityType: 'product' | 'order' | 'return' | 'refund' | 'inventory' | 'unknown';
  localId?: string;
  externalId?: string;
  error?: string;
  details?: Record<string, unknown>;
  syncQueuedTo?: string[]; // Platforms queued for sync
}

// Shopify payload types
interface ShopifyProductPayload {
  id: number;
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  handle?: string;
  status?: 'active' | 'archived' | 'draft';
  tags?: string;
  variants?: Array<{
    id: number;
    sku?: string;
    price?: string;
    compare_at_price?: string;
    inventory_quantity?: number;
    weight?: number;
    weight_unit?: string;
    barcode?: string;
    taxable?: boolean;
  }>;
  images?: Array<{ id: number; src: string; alt?: string; position?: number }>;
  options?: Array<{ id: number; name: string; values: string[] }>;
  created_at?: string;
  updated_at?: string;
}

interface ShopifyInventoryPayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
  updated_at: string;
}

interface ShopifyOrderPayload {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  created_at?: string;
  updated_at?: string;
  total_price: string;
  subtotal_price?: string;
  total_tax?: string;
  total_shipping_price_set?: { shop_money: { amount: string } };
  currency: string;
  financial_status: string;
  fulfillment_status?: string;
  note?: string;
  tags?: string;
  customer?: {
    id: number;
    email?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
  };
  shipping_address?: {
    first_name?: string;
    last_name?: string;
    company?: string;
    address1?: string;
    address2?: string;
    city?: string;
    zip?: string;
    country?: string;
    country_code?: string;
    phone?: string;
  };
  billing_address?: {
    first_name?: string;
    last_name?: string;
    company?: string;
    address1?: string;
    address2?: string;
    city?: string;
    zip?: string;
    country?: string;
  };
  // Shipping lines (shipping methods selected at checkout)
  shipping_lines?: Array<{
    id: number;
    title: string;      // Human-readable name, e.g., "Standard Shipping"
    code: string;       // Machine code, e.g., "standard", "express"
    price: string;
    source?: string;
  }>;
  line_items?: Array<{
    id: number;
    product_id?: number;
    variant_id?: number;
    sku?: string;
    name?: string;
    title?: string;
    quantity: number;
    price: string;
    grams?: number;
  }>;
  fulfillments?: Array<{
    id: number;
    status: string;
    tracking_number?: string;
    tracking_url?: string;
  }>;
}

interface ShopifyFulfillmentOrderPayload {
  id: number;
  shop_id: number;
  order_id: number;
  assigned_location_id: number;
  request_status: string;
  status: string;
  fulfill_at: string | null;
  fulfill_by: string | null;
  destination?: {
    first_name?: string;
    last_name?: string;
    company?: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    zip?: string;
    country_code?: string;
    phone?: string;
    email?: string;
  };
  line_items?: Array<{
    id: number;
    shop_id: number;
    fulfillment_order_id: number;
    quantity: number;
    line_item_id: number;
    inventory_item_id: number;
    fulfillable_quantity: number;
    variant_id: number;
  }>;
}

interface ShopifyRefundPayload {
  id: number;
  order_id: number;
  note?: string;
  reason?: string;
  refund_line_items?: Array<{
    id: number;
    line_item_id: number;
    quantity: number;
    subtotal: string;
  }>;
}

// WooCommerce payload types
interface WooCommerceProductPayload {
  id: number;
  name: string;
  slug?: string;
  sku?: string;
  description?: string;
  short_description?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  manage_stock?: boolean;
  stock_quantity?: number;
  stock_status?: string;
  weight?: string;
  dimensions?: {
    length?: string;
    width?: string;
    height?: string;
  };
  categories?: Array<{ id: number; name: string }>;
  tags?: Array<{ id: number; name: string }>;
  status?: 'publish' | 'pending' | 'draft' | 'private';
  tax_status?: string;
  images?: Array<{ id: number; src: string; alt?: string }>;
  attributes?: Array<{ id: number; name: string; options: string[] }>;
  meta_data?: Array<{ id: number; key: string; value: string }>;
}

interface WooCommerceOrderPayload {
  id: number;
  number: string;
  status: string;
  date_created?: string;
  date_modified?: string;
  currency: string;
  total: string;
  subtotal?: string;
  total_tax?: string;
  shipping_total?: string;
  customer_id?: number;
  customer_note?: string;
  billing?: {
    first_name?: string;
    last_name?: string;
    company?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    postcode?: string;
    country?: string;
    email?: string;
    phone?: string;
  };
  shipping?: {
    first_name?: string;
    last_name?: string;
    company?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    postcode?: string;
    country?: string;
  };
  // Shipping lines (shipping methods selected at checkout)
  shipping_lines?: Array<{
    id: number;
    method_id: string;      // Machine code, e.g., "flat_rate", "free_shipping"
    method_title: string;   // Human-readable name, e.g., "Flat Rate"
    total: string;
  }>;
  line_items?: Array<{
    id: number;
    product_id?: number;
    variation_id?: number;
    sku?: string;
    name?: string;
    quantity: number;
    total: string;
    price?: number;
  }>;
}

// ============= SERVICE =============

export class EnhancedWebhookProcessor {
  private prisma: PrismaClient;
  private productSyncService: ProductSyncService;
  private orderSyncService: OrderSyncService;
  private returnSyncService: ReturnSyncService;
  private processedWebhooks: Map<string, number> = new Map();
  private logger = new Logger('EnhancedWebhook');

  // Clean up processed webhooks every 5 minutes
  private cleanupInterval: NodeJS.Timeout;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.productSyncService = new ProductSyncService(prisma);
    this.orderSyncService = new OrderSyncService(prisma);
    this.returnSyncService = new ReturnSyncService(prisma);

    // Cleanup old webhook IDs
    this.cleanupInterval = setInterval(() => {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      for (const [id, timestamp] of this.processedWebhooks.entries()) {
        if (timestamp < fiveMinutesAgo) {
          this.processedWebhooks.delete(id);
        }
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Stop the cleanup interval
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Verify webhook signature
   */
  verifySignature(
    payload: string,
    signature: string,
    secret: string,
    channelType: 'SHOPIFY' | 'WOOCOMMERCE'
  ): boolean {
    try {
      if (channelType === 'SHOPIFY') {
        // Shopify uses HMAC SHA256
        const hmac = crypto.createHmac('sha256', secret);
        const digest = hmac.update(payload).digest('base64');
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
      } else if (channelType === 'WOOCOMMERCE') {
        // WooCommerce uses HMAC SHA256 with base64
        const hmac = crypto.createHmac('sha256', secret);
        const digest = hmac.update(payload).digest('base64');
        return signature === digest;
      }
      return false;
    } catch (error) {
      console.error('[Webhook] Signature verification error:', error);
      return false;
    }
  }

  /**
   * Main entry point for processing webhooks
   */
  async processWebhook(event: WebhookEvent): Promise<WebhookProcessResult> {
    const webhookId = event.webhookId || this.generateWebhookId(event);

    console.log(`[Webhook] Processing - Channel: ${event.channelId}, Topic: ${event.topic}, ID: ${webhookId}`);

    // Deduplication check
    if (this.processedWebhooks.has(webhookId)) {
      console.log(`[Webhook] Duplicate webhook detected: ${webhookId}`);
      return {
        success: true,
        action: 'skipped',
        entityType: 'unknown',
        details: { reason: 'Duplicate webhook' },
      };
    }
    this.processedWebhooks.set(webhookId, Date.now());

    try {
      // Get channel info
      const channel = await this.prisma.channel.findUnique({
        where: { id: event.channelId },
      });

      if (!channel) {
        return {
          success: false,
          action: 'failed',
          entityType: 'unknown',
          error: `Channel not found: ${event.channelId}`,
        };
      }

      // Verify signature if webhook secret is configured
      if (channel.webhookSecret && event.headers) {
        const signature = event.headers['x-shopify-hmac-sha256'] || event.headers['x-wc-webhook-signature'];
        if (signature) {
          const payloadString = JSON.stringify(event.payload);
          const isValid = this.verifySignature(
            payloadString,
            signature,
            channel.webhookSecret,
            channel.type as 'SHOPIFY' | 'WOOCOMMERCE'
          );

          if (!isValid) {
            console.error('[Webhook] Invalid signature');
            return {
              success: false,
              action: 'failed',
              entityType: 'unknown',
              error: 'Invalid webhook signature',
            };
          }
        }
      }

      // Route to appropriate handler
      if (channel.type === 'SHOPIFY') {
        return this.processShopifyWebhook(channel.id, channel.clientId, event.topic, event.payload, webhookId);
      } else if (channel.type === 'WOOCOMMERCE') {
        return this.processWooCommerceWebhook(channel.id, channel.clientId, event.topic, event.payload, webhookId);
      }

      return {
        success: false,
        action: 'skipped',
        entityType: 'unknown',
        error: `Unsupported channel type: ${channel.type}`,
      };
    } catch (error) {
      console.error('[Webhook] Processing error:', error);
      return {
        success: false,
        action: 'failed',
        entityType: 'unknown',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============= SHOPIFY HANDLERS =============

  private async processShopifyWebhook(
    channelId: string,
    clientId: string,
    topic: string,
    payload: Record<string, unknown>,
    webhookId: string
  ): Promise<WebhookProcessResult> {
    const [resource, action] = topic.split('/');

    switch (resource) {
      case 'products':
        return this.handleShopifyProduct(channelId, clientId, action, payload as unknown as ShopifyProductPayload, webhookId);
      case 'inventory_levels':
        return this.handleShopifyInventory(channelId, clientId, action, payload as unknown as ShopifyInventoryPayload);
      case 'orders':
        // Handle orders/paid webhook specially for payment hold release
        if (action === 'paid') {
          return this.handleShopifyOrderPaid(channelId, clientId, payload as unknown as ShopifyOrderPayload, webhookId);
        }
        return this.handleShopifyOrder(channelId, clientId, action, payload as unknown as ShopifyOrderPayload, webhookId);
      case 'refunds':
        return this.handleShopifyRefund(channelId, clientId, action, payload as unknown as ShopifyRefundPayload, webhookId);
      case 'fulfillment_orders':
        return this.handleShopifyFulfillmentOrder(channelId, clientId, action, payload as unknown as ShopifyFulfillmentOrderPayload, webhookId);
      default:
        return {
          success: false,
          action: 'skipped',
          entityType: 'unknown',
          error: `Unsupported Shopify resource: ${resource}`,
        };
    }
  }

  /**
   * Handle Shopify product webhook
   */
  private async handleShopifyProduct(
    channelId: string,
    clientId: string,
    action: string,
    payload: ShopifyProductPayload,
    webhookId: string
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);
    const variant = payload.variants?.[0];

    // Handle deletion
    if (action === 'delete') {
      const result = await this.productSyncService.processProductDeletion(
        'shopify',
        clientId,
        channelId,
        externalId
      );

      return {
        success: result.success,
        action: result.action === 'updated' ? 'updated' : result.action === 'deleted' ? 'deleted' : 'skipped',
        entityType: 'product',
        localId: result.productId,
        externalId,
        error: result.error,
        details: result.details,
      };
    }

    // Transform Shopify data to our format
    const productData: IncomingProductData = {
      externalId,
      channelId,
      name: payload.title,
      description: payload.body_html || undefined,
      sku: variant?.sku || undefined,
      gtin: variant?.barcode || undefined,
      price: variant?.price ? parseFloat(variant.price) : undefined,
      compareAtPrice: variant?.compare_at_price ? parseFloat(variant.compare_at_price) : undefined,
      quantity: variant?.inventory_quantity,
      weight: variant?.weight,
      weightUnit: variant?.weight_unit as 'g' | 'kg' | 'lb' | 'oz' | undefined,
      imageUrl: payload.images?.[0]?.src,
      images: payload.images?.map(img => ({
        url: img.src,
        alt: img.alt,
        position: img.position,
      })),
      taxable: variant?.taxable,
      tags: payload.tags?.split(',').map(t => t.trim()).filter(Boolean),
      productType: payload.product_type,
      vendor: payload.vendor,
      isActive: payload.status === 'active',
      status: payload.status,
      rawData: payload as unknown as Record<string, unknown>,
    };

    // Process through ProductSyncService
    const result = await this.productSyncService.processIncomingProduct(
      'shopify',
      clientId,
      channelId,
      productData,
      webhookId
    );

    return {
      success: result.success,
      action: result.action,
      entityType: 'product',
      localId: result.productId,
      externalId,
      error: result.error,
      details: {
        ...result.details,
        conflicts: result.conflicts,
      },
      syncQueuedTo: result.syncedPlatforms,
    };
  }

  /**
   * Handle Shopify inventory level webhook
   */
  private async handleShopifyInventory(
    channelId: string,
    clientId: string,
    action: string,
    payload: ShopifyInventoryPayload
  ): Promise<WebhookProcessResult> {
    // Find product by inventory_item_id
    // Note: This requires storing inventory_item_id in ProductChannel.platformData
    
    const productChannel = await this.prisma.productChannel.findFirst({
      where: {
        channelId,
        platformData: {
          path: ['inventory_item_id'],
          equals: payload.inventory_item_id,
        },
      },
      include: { product: true },
    });

    if (!productChannel) {
      // Try to find by fetching from Shopify API (would need credentials)
      return {
        success: true,
        action: 'skipped',
        entityType: 'inventory',
        externalId: String(payload.inventory_item_id),
        details: { reason: 'Product not found for inventory item' },
      };
    }

    // Only update stock if it's not from our platform
    // (Stock is ops-owned, but inventory webhooks from Shopify are usually from sales)
    
    // For now, we trust Shopify inventory updates as they reflect actual sales
    await this.prisma.product.update({
      where: { id: productChannel.productId },
      data: {
        available: payload.available,
        lastUpdatedBy: 'SHOPIFY',
        updatedAt: new Date(),
      },
    });

    return {
      success: true,
      action: 'updated',
      entityType: 'inventory',
      localId: productChannel.productId,
      externalId: String(payload.inventory_item_id),
      details: { newQuantity: payload.available },
    };
  }

  /**
   * Handle Shopify order webhook
   *
   * Uses OrderSyncService to enforce single creation authority
   */
  private async handleShopifyOrder(
    channelId: string,
    clientId: string,
    action: string,
    payload: ShopifyOrderPayload,
    webhookId?: string
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);

    try {
      // Extract shipping method from shipping_lines (first shipping line is the primary)
      const shippingLine = payload.shipping_lines?.[0];
      
      // Transform Shopify order to our format
      const orderData: IncomingOrderData = {
        externalOrderId: externalId,
        orderNumber: payload.name,
        channelId,
        orderDate: payload.created_at ? new Date(payload.created_at) : new Date(),
        status: this.mapShopifyOrderStatus(payload.fulfillment_status, payload.financial_status),

        // Customer information
        customerName: payload.customer
          ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim()
          : undefined,
        customerEmail: payload.email || payload.customer?.email,
        customerPhone: payload.phone || payload.customer?.phone,

        // Shipping address
        shippingFirstName: payload.shipping_address?.first_name,
        shippingLastName: payload.shipping_address?.last_name,
        shippingCompany: payload.shipping_address?.company,
        shippingAddress1: payload.shipping_address?.address1,
        shippingAddress2: payload.shipping_address?.address2,
        shippingCity: payload.shipping_address?.city,
        shippingZip: payload.shipping_address?.zip,
        shippingCountry: payload.shipping_address?.country,
        shippingCountryCode: payload.shipping_address?.country_code,

        // Billing address
        billingFirstName: payload.billing_address?.first_name,
        billingLastName: payload.billing_address?.last_name,
        billingCompany: payload.billing_address?.company,
        billingAddress1: payload.billing_address?.address1,
        billingAddress2: payload.billing_address?.address2,
        billingCity: payload.billing_address?.city,
        billingZip: payload.billing_address?.zip,
        billingCountry: payload.billing_address?.country,

        // Financial
        subtotal: payload.subtotal_price ? parseFloat(payload.subtotal_price) : undefined,
        shippingCost: payload.total_shipping_price_set?.shop_money?.amount
          ? parseFloat(payload.total_shipping_price_set.shop_money.amount)
          : undefined,
        tax: payload.total_tax ? parseFloat(payload.total_tax) : undefined,
        total: parseFloat(payload.total_price),
        currency: payload.currency,
        paymentStatus: payload.financial_status,

        // Shipping method (extracted from order - SOURCE OF TRUTH)
        shippingMethod: shippingLine?.title,       // Human-readable name
        shippingMethodCode: shippingLine?.code,    // Machine code for mapping

        // Shipping info
        trackingNumber: payload.fulfillments?.[0]?.tracking_number,

        // Items
        items: payload.line_items?.map(item => ({
          sku: item.sku || '',
          productName: item.name || item.title,
          quantity: item.quantity,
          unitPrice: parseFloat(item.price),
          totalPrice: parseFloat(item.price) * item.quantity,
        })),

        // Notes
        notes: payload.note,
        tags: payload.tags?.split(',').map(t => t.trim()).filter(Boolean),
      };

      // Process through OrderSyncService (enforces single creation authority)
      const result = await this.orderSyncService.processIncomingOrder(
        'shopify',
        clientId,
        orderData,
        webhookId
      );

      return {
        success: result.success,
        action: result.action,
        entityType: 'order',
        localId: result.orderId,
        externalId,
        error: result.error,
        details: result.details,
        syncQueuedTo: result.syncedToFfn ? ['jtl'] : [],
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        entityType: 'order',
        externalId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle Shopify orders/paid webhook
   *
   * This is triggered when an order's financial_status becomes "paid".
   * If the order was on AWAITING_PAYMENT hold, release the hold and queue for FFN sync.
   */
  private async handleShopifyOrderPaid(
    channelId: string,
    clientId: string,
    payload: ShopifyOrderPayload,
    webhookId?: string
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);

    console.log(`[Webhook] Shopify orders/paid received for order ${externalId}`);

    try {
      // Find the order in our database
      const order = await this.prisma.order.findFirst({
        where: {
          clientId,
          externalOrderId: externalId,
        },
      });

      if (!order) {
        console.log(`[Webhook] Order ${externalId} not found locally for payment confirmation`);
        return {
          success: true,
          action: 'skipped',
          entityType: 'order',
          externalId,
          details: { reason: 'Order not found locally' },
        };
      }

      // Check if order is on payment hold
      if (order.isOnHold && order.holdReason === 'AWAITING_PAYMENT') {
        console.log(`[Webhook] Releasing AWAITING_PAYMENT hold for order ${order.id} (${externalId})`);

        // Release the hold
        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            isOnHold: false,
            holdReason: null,
            holdNotes: null,
            holdReleasedAt: new Date(),
            holdReleasedBy: 'SYSTEM',
            paymentStatus: 'paid',
            lastOperationalUpdateBy: 'SHOPIFY',
            lastOperationalUpdateAt: new Date(),
            ffnSyncError: null, // Clear the "awaiting payment" message
          },
        });

        // Log the payment confirmation
        await this.prisma.orderSyncLog.create({
          data: {
            orderId: order.id,
            action: 'payment_confirmed',
            origin: 'SHOPIFY',
            targetPlatform: 'nolimits',
            success: true,
            changedFields: ['isOnHold', 'holdReason', 'paymentStatus', 'holdReleasedAt', 'holdReleasedBy'],
          },
        });

        // Queue for FFN sync now that payment is confirmed
        await this.queueOrderForFfnSync(order.id, 'shopify');

        console.log(`[Webhook] Order ${order.id} released from payment hold and queued for FFN sync`);

        return {
          success: true,
          action: 'updated',
          entityType: 'order',
          localId: order.id,
          externalId,
          details: { action: 'payment_hold_released', queuedForFfn: true },
          syncQueuedTo: ['jtl'],
        };
      } else {
        // Order was not on payment hold, just update payment status
        console.log(`[Webhook] Order ${order.id} was not on payment hold, updating payment status to 'paid'`);

        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: 'paid',
            lastOperationalUpdateAt: new Date(),
          },
        });

        return {
          success: true,
          action: 'updated',
          entityType: 'order',
          localId: order.id,
          externalId,
          details: { action: 'payment_status_updated' },
        };
      }
    } catch (error) {
      console.error(`[Webhook] Error processing Shopify orders/paid webhook:`, error);
      return {
        success: false,
        action: 'failed',
        entityType: 'order',
        externalId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Queue order for FFN sync (helper method for payment confirmation)
   *
   * Used when releasing a payment hold to trigger the FFN sync that was
   * originally skipped when the order was created.
   */
  private async queueOrderForFfnSync(orderId: string, origin: 'shopify' | 'woocommerce'): Promise<void> {
    try {
      const { getQueue, QUEUE_NAMES } = await import('../queue/sync-queue.service.js');
      const queue = getQueue();

      await queue.enqueue(
        QUEUE_NAMES.ORDER_SYNC_TO_FFN,
        {
          orderId,
          origin: origin as 'shopify' | 'woocommerce' | 'nolimits',
          operation: 'create',
        },
        {
          priority: 1,
          retryLimit: 3,
          retryDelay: 60,
          retryBackoff: true,
        }
      );

      console.log(`[Webhook] Queued order ${orderId} for FFN sync after payment confirmation`);

      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          syncStatus: 'PENDING',
        },
      });
    } catch (error) {
      console.error(`[Webhook] Failed to queue FFN sync for order ${orderId}:`, error);
    }
  }


  /**
   * Handle Shopify refund webhook
   *
   * Uses ReturnSyncService to enforce return master model
   */
  private async handleShopifyRefund(
    channelId: string,
    clientId: string,
    action: string,
    payload: ShopifyRefundPayload,
    webhookId?: string
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);
    const externalOrderId = String(payload.order_id);

    try {
      // Get the original order to retrieve currency and line item SKU mapping
      const originalOrder = await this.prisma.order.findFirst({
        where: {
          clientId,
          externalOrderId: externalOrderId,
        },
        include: {
          items: true,
        },
      });

      // Get currency from order, default to EUR
      const refundCurrency = originalOrder?.currency || 'EUR';

      // Build line item ID to SKU mapping from order items
      const lineItemSkuMap = new Map<string, string>();
      if (originalOrder?.items) {
        for (const item of originalOrder.items) {
          // Note: OrderItem doesn't have externalLineItemId in schema
          // Using item id as fallback if needed
          if (item.sku) {
            lineItemSkuMap.set(item.id, item.sku);
          }
        }
      }

      // Transform Shopify refund to return data
      const returnData: IncomingReturnData = {
        externalReturnId: externalId,
        externalOrderId,
        channelId,
        returnDate: new Date(),
        reason: payload.reason || payload.note || 'Refund from Shopify',

        // Calculate total refund amount
        refundAmount: payload.refund_line_items?.reduce((sum, item) => {
          return sum + parseFloat(item.subtotal);
        }, 0),
        refundCurrency,

        // Items - map line_item_id to SKU using the order's line items
        items: payload.refund_line_items?.map(item => {
          const lineItemId = String(item.line_item_id);
          const sku = lineItemSkuMap.get(lineItemId) || '';
          
          // If SKU not found in mapping, try to get from the line_item directly if available
          const itemSku = sku || (item as any).line_item?.sku || `UNKNOWN-${lineItemId}`;
          
          return {
            sku: itemSku,
            quantity: item.quantity,
          };
        }),
      };

      // Process through ReturnSyncService (platform is return master)
      const result = await this.returnSyncService.processIncomingReturn(
        'shopify',
        clientId,
        returnData,
        webhookId
      );

      return {
        success: result.success,
        action: result.action as any,
        entityType: 'refund',
        localId: result.returnId,
        externalId,
        error: result.error,
        details: result.details,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        entityType: 'refund',
        externalId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle Shopify FulfillmentOrder webhooks
   * These are used for 3PL flow integration with JTL FFN
   */
  private async handleShopifyFulfillmentOrder(
    channelId: string,
    clientId: string,
    action: string,
    payload: ShopifyFulfillmentOrderPayload,
    webhookId?: string
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);
    const externalOrderId = String(payload.order_id);

    console.log(`[Webhook] FulfillmentOrder ${action}: FO=${externalId}, Order=${externalOrderId}`);

    try {
      // Find the local order
      const order = await this.prisma.order.findFirst({
        where: {
          clientId,
          externalOrderId,
        },
      });

      if (!order) {
        console.log(`[Webhook] Order not found for FulfillmentOrder webhook: ${externalOrderId}`);
        return {
          success: true,
          action: 'skipped',
          entityType: 'order',
          externalId,
          details: { reason: 'Order not found locally' },
        };
      }

      // Handle different FulfillmentOrder actions
      switch (action) {
        case 'fulfillment_request_submitted':
          // Order sent to fulfillment service - update status
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentOrderId: `gid://shopify/FulfillmentOrder/${externalId}`,
              shopifyFulfillmentRequestStatus: 'SUBMITTED',
              fulfillmentState: 'PENDING',
            },
          });
          break;

        case 'fulfillment_request_accepted':
          // Fulfillment service accepted the order
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentRequestStatus: 'ACCEPTED',
              fulfillmentState: 'ACKNOWLEDGED',
            },
          });
          break;

        case 'fulfillment_request_rejected':
          // Fulfillment service rejected - needs manual intervention
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentRequestStatus: 'REJECTED',
              fulfillmentState: 'PENDING',
              isOnHold: true,
              ffnSyncError: `Fulfillment request rejected: ${payload.request_status}`,
            },
          });
          break;

        case 'cancellation_request_submitted':
          // Cancellation requested
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentRequestStatus: 'CANCELLATION_REQUESTED',
            },
          });
          break;

        case 'cancellation_request_accepted':
          // Cancellation accepted by fulfillment service
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentRequestStatus: 'CANCELLATION_ACCEPTED',
              isCancelled: true,
              cancelledAt: new Date(),
            },
          });
          break;

        case 'cancellation_request_rejected':
          // Cancellation rejected - order will still be fulfilled
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentRequestStatus: 'CANCELLATION_REJECTED',
              ffnSyncError: 'Cancellation request was rejected by fulfillment service',
            },
          });
          break;

        case 'placed_on_hold':
          // FulfillmentOrder placed on hold
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              isOnHold: true,
              shopifyFulfillmentOrderStatus: 'ON_HOLD',
            },
          });
          break;

        case 'hold_released':
          // Hold released
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              isOnHold: false,
              shopifyFulfillmentOrderStatus: 'OPEN',
            },
          });
          break;

        case 'moved':
          // FulfillmentOrder moved to different location
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              warehouseNotes: `FulfillmentOrder moved to location ${payload.assigned_location_id}`,
            },
          });
          break;

        case 'order_routing_complete':
          // Initial routing complete - order is ready for fulfillment
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentOrderId: `gid://shopify/FulfillmentOrder/${externalId}`,
              shopifyFulfillmentOrderStatus: payload.status,
            },
          });
          break;

        case 'rescheduled':
          // Fulfillment rescheduled
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentOrderStatus: 'SCHEDULED',
            },
          });
          break;

        case 'scheduled_fulfillment_order_ready':
          // Scheduled fulfillment is now ready
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              shopifyFulfillmentOrderStatus: 'OPEN',
            },
          });
          break;

        default:
          console.log(`[Webhook] Unhandled FulfillmentOrder action: ${action}`);
      }

      // Log the sync event
      await this.prisma.orderSyncLog.create({
        data: {
          orderId: order.id,
          action: `fulfillment_order_${action}`,
          origin: 'SHOPIFY',
          targetPlatform: 'nolimits',
          success: true,
          externalId,
          changedFields: ['shopifyFulfillmentOrderStatus', 'shopifyFulfillmentRequestStatus'],
        },
      });

      return {
        success: true,
        action: 'updated',
        entityType: 'order',
        localId: order.id,
        externalId,
        details: { fulfillmentOrderAction: action },
      };
    } catch (error) {
      console.error(`[Webhook] FulfillmentOrder handler error:`, error);
      return {
        success: false,
        action: 'failed',
        entityType: 'order',
        externalId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============= WOOCOMMERCE HANDLERS =============

  private async processWooCommerceWebhook(
    channelId: string,
    clientId: string,
    topic: string,
    payload: Record<string, unknown>,
    webhookId: string
  ): Promise<WebhookProcessResult> {
    // WooCommerce topics: product.created, product.updated, product.deleted, etc.
    const [resource, action] = topic.split('.');

    switch (resource) {
      case 'product':
        return this.handleWooCommerceProduct(channelId, clientId, action, payload as unknown as WooCommerceProductPayload, webhookId);
      case 'order':
        return this.handleWooCommerceOrder(channelId, clientId, action, payload as unknown as WooCommerceOrderPayload, webhookId);
      default:
        return {
          success: false,
          action: 'skipped',
          entityType: 'unknown',
          error: `Unsupported WooCommerce resource: ${resource}`,
        };
    }
  }

  /**
   * Handle WooCommerce product webhook
   */
  private async handleWooCommerceProduct(
    channelId: string,
    clientId: string,
    action: string,
    payload: WooCommerceProductPayload,
    webhookId: string
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);

    // Handle deletion
    if (action === 'deleted') {
      const result = await this.productSyncService.processProductDeletion(
        'woocommerce',
        clientId,
        channelId,
        externalId
      );

      return {
        success: result.success,
        action: result.action === 'deleted' ? 'deleted' : 'skipped',
        entityType: 'product',
        localId: result.productId,
        externalId,
        error: result.error,
      };
    }

    // Extract GTIN from meta_data if present
    const gtin = payload.meta_data?.find(m => m.key === '_gtin' || m.key === 'gtin')?.value;

    // Transform WooCommerce data to our format
    const productData: IncomingProductData = {
      externalId,
      channelId,
      name: payload.name,
      description: payload.description || payload.short_description || undefined,
      sku: payload.sku,
      gtin,
      price: payload.sale_price ? parseFloat(payload.sale_price) 
             : payload.price ? parseFloat(payload.price) : undefined,
      compareAtPrice: payload.regular_price && payload.sale_price 
                      ? parseFloat(payload.regular_price) : undefined,
      quantity: payload.manage_stock ? payload.stock_quantity : undefined,
      weight: payload.weight ? parseFloat(payload.weight) : undefined,
      weightUnit: 'kg', // WooCommerce default
      height: payload.dimensions?.height ? parseFloat(payload.dimensions.height) : undefined,
      length: payload.dimensions?.length ? parseFloat(payload.dimensions.length) : undefined,
      width: payload.dimensions?.width ? parseFloat(payload.dimensions.width) : undefined,
      imageUrl: payload.images?.[0]?.src,
      images: payload.images?.map(img => ({
        url: img.src,
        alt: img.alt,
      })),
      taxable: payload.tax_status === 'taxable',
      tags: payload.tags?.map(t => t.name),
      collections: payload.categories?.map(c => String(c.id)),
      isActive: payload.status === 'publish',
      status: payload.status,
      rawData: payload as unknown as Record<string, unknown>,
    };

    // Process through ProductSyncService
    const result = await this.productSyncService.processIncomingProduct(
      'woocommerce',
      clientId,
      channelId,
      productData,
      webhookId
    );

    return {
      success: result.success,
      action: result.action,
      entityType: 'product',
      localId: result.productId,
      externalId,
      error: result.error,
      details: {
        ...result.details,
        conflicts: result.conflicts,
      },
      syncQueuedTo: result.syncedPlatforms,
    };
  }

  /**
   * Handle WooCommerce order webhook
   *
   * Uses OrderSyncService to enforce single creation authority
   */
  private async handleWooCommerceOrder(
    channelId: string,
    clientId: string,
    action: string,
    payload: WooCommerceOrderPayload,
    webhookId?: string
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);

    try {
      // Check for payment confirmation (order.updated with status change to 'processing')
      // WooCommerce doesn't have a dedicated 'order.paid' webhook, so we detect payment
      // by watching for status changes from pending/on-hold to processing
      if (action === 'updated') {
        const newStatus = payload.status?.toLowerCase();

        // If the new status is 'processing', check if order was on payment hold
        if (newStatus === 'processing') {
          const existingOrder = await this.prisma.order.findFirst({
            where: {
              clientId,
              externalOrderId: externalId,
            },
          });

          if (existingOrder && existingOrder.isOnHold && existingOrder.holdReason === 'AWAITING_PAYMENT') {
            console.log(`[Webhook] WooCommerce payment confirmed for order ${externalId} (status: ${newStatus})`);

            // Release the hold
            await this.prisma.order.update({
              where: { id: existingOrder.id },
              data: {
                isOnHold: false,
                holdReason: null,
                holdNotes: null,
                holdReleasedAt: new Date(),
                holdReleasedBy: 'SYSTEM',
                lastOperationalUpdateBy: 'WOOCOMMERCE',
                lastOperationalUpdateAt: new Date(),
                ffnSyncError: null, // Clear the "awaiting payment" message
              },
            });

            // Log the payment confirmation
            await this.prisma.orderSyncLog.create({
              data: {
                orderId: existingOrder.id,
                action: 'payment_confirmed',
                origin: 'WOOCOMMERCE',
                targetPlatform: 'nolimits',
                success: true,
                changedFields: ['isOnHold', 'holdReason', 'holdReleasedAt', 'holdReleasedBy'],
              },
            });

            // Queue for FFN sync
            await this.queueOrderForFfnSync(existingOrder.id, 'woocommerce');

            console.log(`[Webhook] Order ${existingOrder.id} released from payment hold and queued for FFN sync`);

            return {
              success: true,
              action: 'updated',
              entityType: 'order',
              localId: existingOrder.id,
              externalId,
              details: { action: 'payment_hold_released', queuedForFfn: true },
              syncQueuedTo: ['jtl'],
            };
          }
        }
      }

      // Extract shipping method from shipping_lines (first shipping line is the primary)
      const shippingLine = payload.shipping_lines?.[0];
      
      // Transform WooCommerce order to our format
      const orderData: IncomingOrderData = {
        externalOrderId: externalId,
        orderNumber: payload.number,
        channelId,
        orderDate: payload.date_created ? new Date(payload.date_created) : new Date(),
        status: this.mapWooCommerceOrderStatus(payload.status),

        // Customer information
        customerName: payload.billing
          ? `${payload.billing.first_name || ''} ${payload.billing.last_name || ''}`.trim()
          : undefined,
        customerEmail: payload.billing?.email,
        customerPhone: payload.billing?.phone,

        // Shipping address
        shippingFirstName: payload.shipping?.first_name,
        shippingLastName: payload.shipping?.last_name,
        shippingCompany: payload.shipping?.company,
        shippingAddress1: payload.shipping?.address_1,
        shippingAddress2: payload.shipping?.address_2,
        shippingCity: payload.shipping?.city,
        shippingZip: payload.shipping?.postcode,
        shippingCountry: payload.shipping?.country,

        // Billing address
        billingFirstName: payload.billing?.first_name,
        billingLastName: payload.billing?.last_name,
        billingCompany: payload.billing?.company,
        billingAddress1: payload.billing?.address_1,
        billingAddress2: payload.billing?.address_2,
        billingCity: payload.billing?.city,
        billingZip: payload.billing?.postcode,
        billingCountry: payload.billing?.country,

        // Financial
        subtotal: payload.subtotal ? parseFloat(payload.subtotal) : undefined,
        shippingCost: payload.shipping_total ? parseFloat(payload.shipping_total) : undefined,
        tax: payload.total_tax ? parseFloat(payload.total_tax) : undefined,
        total: parseFloat(payload.total),
        currency: payload.currency,

        // Shipping method (extracted from order - SOURCE OF TRUTH)
        shippingMethod: shippingLine?.method_title,      // Human-readable name
        shippingMethodCode: shippingLine?.method_id,     // Machine code for mapping

        // Items
        items: payload.line_items?.map(item => ({
          sku: item.sku || '',
          productName: item.name,
          quantity: item.quantity,
          unitPrice: item.price || parseFloat(item.total) / item.quantity,
          totalPrice: parseFloat(item.total),
        })),

        // Notes
        notes: payload.customer_note,
      };

      // Process through OrderSyncService (enforces single creation authority)
      const result = await this.orderSyncService.processIncomingOrder(
        'woocommerce',
        clientId,
        orderData,
        webhookId
      );

      return {
        success: result.success,
        action: result.action,
        entityType: 'order',
        localId: result.orderId,
        externalId,
        error: result.error,
        details: result.details,
        syncQueuedTo: result.syncedToFfn ? ['jtl'] : [],
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        entityType: 'order',
        externalId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============= HELPER METHODS =============

  private generateWebhookId(event: WebhookEvent): string {
    const data = JSON.stringify({
      channelId: event.channelId,
      topic: event.topic,
      payload: event.payload,
    });
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  private mapShopifyOrderStatus(fulfillmentStatus?: string, financialStatus?: string): OrderStatus {
    if (financialStatus === 'refunded') return OrderStatus.CANCELLED;
    if (financialStatus === 'pending') return OrderStatus.ON_HOLD;
    
    switch (fulfillmentStatus) {
      case 'fulfilled':
        return OrderStatus.SHIPPED;
      case 'partial':
        return OrderStatus.PARTIALLY_FULFILLED;
      case null:
      case 'unfulfilled':
      default:
        return OrderStatus.PENDING;
    }
  }

  private mapWooCommerceOrderStatus(status: string): OrderStatus {
    switch (status) {
      case 'pending':
      case 'on-hold':
        return OrderStatus.ON_HOLD;
      case 'processing':
        return OrderStatus.PROCESSING;
      case 'completed':
        return OrderStatus.DELIVERED;
      case 'cancelled':
      case 'refunded':
        return OrderStatus.CANCELLED;
      case 'failed':
        return OrderStatus.ERROR;
      default:
        return OrderStatus.PENDING;
    }
  }
}
