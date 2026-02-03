/**
 * Webhook Processor Service
 * Handles incoming webhook events FROM e-commerce platforms (Shopify/WooCommerce)
 *
 * This service processes individual webhook events rather than triggering full syncs,
 * enabling efficient real-time updates for products, orders, and returns.
 *
 * Flow:
 * - Platform (Shopify/WooCommerce) → Webhook → No-Limits Database → Queue JTL Sync
 */

import { PrismaClient, ChannelType, OrderStatus, ReturnStatus } from '@prisma/client';
import { SyncQueueProcessor } from './sync-queue-processor.service.js';
import { Logger } from '../../utils/logger.js';

// ============= TYPES =============

export interface WebhookEvent {
  channelId: string;
  channelType: ChannelType;
  topic: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface WebhookProcessResult {
  success: boolean;
  action: 'created' | 'updated' | 'deleted' | 'skipped' | 'failed';
  entityType: 'product' | 'order' | 'return' | 'refund' | 'unknown';
  localId?: string;
  externalId?: string;
  error?: string;
  details?: Record<string, unknown>;
}

// Shopify webhook payloads
interface ShopifyProductPayload {
  id: number;
  title: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  handle?: string;
  status?: 'active' | 'archived' | 'draft';
  variants?: Array<{
    id: number;
    sku?: string;
    price?: string;
    inventory_quantity?: number;
    weight?: number;
    weight_unit?: string;
  }>;
  images?: Array<{ id: number; src: string }>;
}

interface ShopifyOrderPayload {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  total_price: string;
  currency: string;
  financial_status: string;
  fulfillment_status?: string;
  note?: string;
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
  line_items?: Array<{
    id: number;
    product_id?: number;
    variant_id?: number;
    sku?: string;
    name?: string;
    quantity: number;
    price: string;
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

// WooCommerce webhook payloads
interface WooCommerceProductPayload {
  id: number;
  name: string;
  sku?: string;
  description?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  manage_stock?: boolean;
  stock_quantity?: number;
  weight?: string;
  status?: 'publish' | 'pending' | 'draft' | 'private';
  images?: Array<{ id: number; src: string }>;
}

interface WooCommerceOrderPayload {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
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
  line_items?: Array<{
    id: number;
    product_id?: number;
    variation_id?: number;
    sku?: string;
    name?: string;
    quantity: number;
    total: string;
  }>;
}

interface WooCommerceRefundPayload {
  id: number;
  order_id?: number;
  reason?: string;
  amount?: string;
  line_items?: Array<{
    id: number;
    quantity: number;
    refund_total: string;
  }>;
}

// ============= SERVICE =============

export class WebhookProcessorService {
  private prisma: PrismaClient;
  private syncQueueProcessor: SyncQueueProcessor | null;
  private logger = new Logger('WebhookProcessor');

  constructor(prisma: PrismaClient, syncQueueProcessor?: SyncQueueProcessor) {
    this.prisma = prisma;
    this.syncQueueProcessor = syncQueueProcessor || null;
  }

  /**
   * Main entry point for processing webhooks
   */
  async processWebhook(event: WebhookEvent): Promise<WebhookProcessResult> {
    console.log(`Processing webhook - Channel: ${event.channelId}, Topic: ${event.topic}`);

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

      // Route to appropriate handler based on channel type and topic
      if (channel.type === 'SHOPIFY') {
        return this.processShopifyWebhook(channel.id, channel.clientId, event.topic, event.payload);
      } else if (channel.type === 'WOOCOMMERCE') {
        return this.processWooCommerceWebhook(channel.id, channel.clientId, event.topic, event.payload);
      }

      return {
        success: false,
        action: 'skipped',
        entityType: 'unknown',
        error: `Unsupported channel type: ${channel.type}`,
      };
    } catch (error) {
      console.error('Webhook processing error:', error);
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
    payload: Record<string, unknown>
  ): Promise<WebhookProcessResult> {
    // Parse topic: "products/create", "orders/updated", etc.
    const [resource, action] = topic.split('/');

    switch (resource) {
      case 'products':
        return this.handleShopifyProductEvent(channelId, clientId, action, payload as unknown as ShopifyProductPayload);
      case 'orders':
        return this.handleShopifyOrderEvent(channelId, clientId, action, payload as unknown as ShopifyOrderPayload);
      case 'refunds':
        return this.handleShopifyRefundEvent(channelId, clientId, action, payload as unknown as ShopifyRefundPayload);
      default:
        return {
          success: false,
          action: 'skipped',
          entityType: 'unknown',
          error: `Unsupported Shopify resource: ${resource}`,
        };
    }
  }

  private async handleShopifyProductEvent(
    channelId: string,
    clientId: string,
    action: string,
    payload: ShopifyProductPayload
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);
    const variant = payload.variants?.[0];

    // Check if product already exists in this channel
    const existingProductChannel = await this.prisma.productChannel.findFirst({
      where: {
        channelId,
        externalProductId: externalId,
      },
      include: { product: true },
    });

    try {
      if (action === 'delete') {
        if (existingProductChannel) {
          // Remove the channel link, optionally delete product if no other channels
          await this.prisma.productChannel.delete({
            where: { id: existingProductChannel.id },
          });

          // Check if product has other channel links
          const otherChannels = await this.prisma.productChannel.count({
            where: { productId: existingProductChannel.productId },
          });

          if (otherChannels === 0) {
            // Delete the product if no other channels
            await this.prisma.product.delete({
              where: { id: existingProductChannel.productId },
            });
          }

          return {
            success: true,
            action: 'deleted',
            entityType: 'product',
            localId: existingProductChannel.productId,
            externalId,
          };
        }
        return {
          success: true,
          action: 'skipped',
          entityType: 'product',
          externalId,
          details: { reason: 'Product not found locally' },
        };
      }

      if (action === 'update' && existingProductChannel) {
        // Update existing product
        await this.prisma.product.update({
          where: { id: existingProductChannel.productId },
          data: {
            name: payload.title,
            description: payload.body_html || null,
            sku: variant?.sku || existingProductChannel.product.sku,
            netSalesPrice: variant?.price ? parseFloat(variant.price) : undefined,
            available: variant?.inventory_quantity ?? undefined,
            weightInKg: variant?.weight
              ? this.convertWeight(variant.weight, variant.weight_unit)
              : undefined,
            imageUrl: payload.images?.[0]?.src || null,
            updatedAt: new Date(),
          },
        });

        // Queue sync to JTL FFN
        await this.queueJTLSync(existingProductChannel.productId, 'SHOPIFY');

        return {
          success: true,
          action: 'updated',
          entityType: 'product',
          localId: existingProductChannel.productId,
          externalId,
          details: { title: payload.title },
        };
      }

      if (action === 'create' || (action === 'update' && !existingProductChannel)) {
        // Create new product
        const sku = variant?.sku || `SHOP-${payload.id}`;
        
        // Check if a product with this SKU already exists for this client
        const existingProduct = await this.prisma.product.findFirst({
          where: { sku, clientId },
        });

        if (existingProduct) {
          // Link existing product to this channel
          await this.prisma.productChannel.create({
            data: {
              productId: existingProduct.id,
              channelId,
              externalProductId: externalId,
            },
          });

          return {
            success: true,
            action: 'updated',
            entityType: 'product',
            localId: existingProduct.id,
            externalId,
            details: { reason: 'Linked to existing product by SKU' },
          };
        }

        // Create new product
        const newProduct = await this.prisma.product.create({
          data: {
            clientId,
            productId: `SHOP-${payload.id}`,
            sku,
            name: payload.title,
            description: payload.body_html || null,
            netSalesPrice: variant?.price ? parseFloat(variant.price) : 0,
            available: variant?.inventory_quantity ?? 0,
            reserved: 0,
            weightInKg: variant?.weight
              ? this.convertWeight(variant.weight, variant.weight_unit)
              : null,
            imageUrl: payload.images?.[0]?.src || null,
            channels: {
              create: {
                channelId,
                externalProductId: externalId,
              },
            },
          },
        });

        // Queue sync to JTL FFN
        await this.queueJTLSync(newProduct.id, 'SHOPIFY');

        return {
          success: true,
          action: 'created',
          entityType: 'product',
          localId: newProduct.id,
          externalId,
          details: { title: payload.title, sku },
        };
      }

      return {
        success: false,
        action: 'skipped',
        entityType: 'product',
        externalId,
        error: `Unknown action: ${action}`,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        entityType: 'product',
        externalId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleShopifyOrderEvent(
    channelId: string,
    clientId: string,
    action: string,
    payload: ShopifyOrderPayload
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);

    // Find existing order
    const existingOrder = await this.prisma.order.findFirst({
      where: {
        channelId,
        externalOrderId: externalId,
      },
    });

    try {
      if (action === 'cancelled' || action === 'delete') {
        if (existingOrder) {
          await this.prisma.order.update({
            where: { id: existingOrder.id },
            data: { status: OrderStatus.CANCELLED },
          });

          return {
            success: true,
            action: 'updated',
            entityType: 'order',
            localId: existingOrder.id,
            externalId,
            details: { status: 'cancelled' },
          };
        }
        return {
          success: true,
          action: 'skipped',
          entityType: 'order',
          externalId,
        };
      }

      if (action === 'updated' && existingOrder) {
        const status = this.mapShopifyOrderStatus(payload.fulfillment_status, payload.financial_status);

        await this.prisma.order.update({
          where: { id: existingOrder.id },
          data: {
            status,
            notes: payload.note || existingOrder.notes,
            updatedAt: new Date(),
          },
        });

        return {
          success: true,
          action: 'updated',
          entityType: 'order',
          localId: existingOrder.id,
          externalId,
          details: { status },
        };
      }

      if (action === 'create' || (action === 'updated' && !existingOrder)) {
        const orderId = `SHOP-${payload.name.replace('#', '')}`;
        const status = this.mapShopifyOrderStatus(payload.fulfillment_status, payload.financial_status);

        // Create new order
        const newOrder = await this.prisma.order.create({
          data: {
            clientId,
            channelId,
            orderId,
            orderNumber: payload.name,
            externalOrderId: externalId,
            status,
            total: parseFloat(payload.total_price),
            currency: payload.currency,
            customerEmail: payload.email || payload.customer?.email || null,
            customerName: payload.customer
              ? `${payload.customer.first_name || ''} ${payload.customer.last_name || ''}`.trim()
              : null,
            customerPhone: payload.phone || payload.customer?.phone || null,
            notes: payload.note || null,
            // Shipping address fields
            shippingFirstName: payload.shipping_address?.first_name || null,
            shippingLastName: payload.shipping_address?.last_name || null,
            shippingCompany: payload.shipping_address?.company || null,
            shippingAddress1: payload.shipping_address?.address1 || null,
            shippingAddress2: payload.shipping_address?.address2 || null,
            shippingCity: payload.shipping_address?.city || null,
            shippingZip: payload.shipping_address?.zip || null,
            shippingCountry: payload.shipping_address?.country || null,
            // Billing address fields
            billingFirstName: payload.billing_address?.first_name || null,
            billingLastName: payload.billing_address?.last_name || null,
            billingCompany: payload.billing_address?.company || null,
            billingAddress1: payload.billing_address?.address1 || null,
            billingAddress2: payload.billing_address?.address2 || null,
            billingCity: payload.billing_address?.city || null,
            billingZip: payload.billing_address?.zip || null,
            billingCountry: payload.billing_address?.country || null,
          },
        });

        // Create order items
        if (payload.line_items && payload.line_items.length > 0) {
          for (const item of payload.line_items) {
            // Try to find product by external ID or SKU
            let productId: string | null = null;

            if (item.product_id) {
              const productChannel = await this.prisma.productChannel.findFirst({
                where: {
                  channelId,
                  externalProductId: String(item.product_id),
                },
              });
              productId = productChannel?.productId || null;
            }

            if (!productId && item.sku) {
              const product = await this.prisma.product.findFirst({
                where: { sku: item.sku, clientId },
              });
              productId = product?.id || null;
            }

            await this.prisma.orderItem.create({
              data: {
                orderId: newOrder.id,
                productId,
                sku: item.sku || null,
                productName: item.name || null,
                quantity: item.quantity,
                unitPrice: parseFloat(item.price),
              },
            });
          }
        }

        // Queue sync to JTL FFN
        await this.queueJTLOrderSync(newOrder.id, 'SHOPIFY');

        return {
          success: true,
          action: 'created',
          entityType: 'order',
          localId: newOrder.id,
          externalId,
          details: { orderNumber: payload.name, status },
        };
      }

      return {
        success: false,
        action: 'skipped',
        entityType: 'order',
        externalId,
        error: `Unknown action: ${action}`,
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

  private async handleShopifyRefundEvent(
    channelId: string,
    clientId: string,
    action: string,
    payload: ShopifyRefundPayload
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);
    const externalOrderId = String(payload.order_id);

    try {
      // Find the order
      const order = await this.prisma.order.findFirst({
        where: {
          channelId,
          externalOrderId,
        },
      });

      if (!order) {
        return {
          success: false,
          action: 'skipped',
          entityType: 'refund',
          externalId,
          error: 'Associated order not found',
        };
      }

      // Check if return already exists
      const existingReturn = await this.prisma.return.findFirst({
        where: {
          orderId: order.id,
          externalReturnId: externalId,
        },
      });

      if (action === 'create' && !existingReturn) {
        // Create return record
        const newReturn = await this.prisma.return.create({
          data: {
            returnId: `REFUND-${externalId}`,
            orderId: order.id,
            externalReturnId: externalId,
            status: ReturnStatus.RECEIVED,
            reason: payload.reason || payload.note || 'Refund from Shopify',
          },
        });

        // Create return items
        if (payload.refund_line_items && payload.refund_line_items.length > 0) {
          for (const refundItem of payload.refund_line_items) {
            // Find the order item
            const orderItem = await this.prisma.orderItem.findFirst({
              where: { orderId: order.id },
              include: { product: true },
            });

            if (orderItem) {
              await this.prisma.returnItem.create({
                data: {
                  returnId: newReturn.id,
                  productId: orderItem.productId,
                  quantity: refundItem.quantity,
                },
              });
            }
          }
        }

        return {
          success: true,
          action: 'created',
          entityType: 'refund',
          localId: newReturn.id,
          externalId,
          details: { orderId: order.id },
        };
      }

      return {
        success: true,
        action: 'skipped',
        entityType: 'refund',
        externalId,
        details: { reason: existingReturn ? 'Already exists' : 'Unknown action' },
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

  // ============= WOOCOMMERCE HANDLERS =============

  private async processWooCommerceWebhook(
    channelId: string,
    clientId: string,
    topic: string,
    payload: Record<string, unknown>
  ): Promise<WebhookProcessResult> {
    // WooCommerce topics use dash format: "product-created", "order-updated", etc.
    const [resource, action] = topic.split('-');

    switch (resource) {
      case 'product':
        return this.handleWooCommerceProductEvent(channelId, clientId, action, payload as unknown as WooCommerceProductPayload);
      case 'order':
        return this.handleWooCommerceOrderEvent(channelId, clientId, action, payload as unknown as WooCommerceOrderPayload);
      case 'refund':
        return this.handleWooCommerceRefundEvent(channelId, clientId, action, payload as unknown as WooCommerceRefundPayload);
      default:
        return {
          success: false,
          action: 'skipped',
          entityType: 'unknown',
          error: `Unsupported WooCommerce resource: ${resource}`,
        };
    }
  }

  private async handleWooCommerceProductEvent(
    channelId: string,
    clientId: string,
    action: string,
    payload: WooCommerceProductPayload
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);

    // Check if product already exists in this channel
    const existingProductChannel = await this.prisma.productChannel.findFirst({
      where: {
        channelId,
        externalProductId: externalId,
      },
      include: { product: true },
    });

    try {
      if (action === 'deleted') {
        if (existingProductChannel) {
          await this.prisma.productChannel.delete({
            where: { id: existingProductChannel.id },
          });

          const otherChannels = await this.prisma.productChannel.count({
            where: { productId: existingProductChannel.productId },
          });

          if (otherChannels === 0) {
            await this.prisma.product.delete({
              where: { id: existingProductChannel.productId },
            });
          }

          return {
            success: true,
            action: 'deleted',
            entityType: 'product',
            localId: existingProductChannel.productId,
            externalId,
          };
        }
        return {
          success: true,
          action: 'skipped',
          entityType: 'product',
          externalId,
        };
      }

      if (action === 'updated' && existingProductChannel) {
        await this.prisma.product.update({
          where: { id: existingProductChannel.productId },
          data: {
            name: payload.name,
            description: payload.description || null,
            sku: payload.sku || existingProductChannel.product.sku,
            netSalesPrice: payload.price ? parseFloat(payload.price) : undefined,
            available: payload.stock_quantity ?? undefined,
            weightInKg: payload.weight ? parseFloat(payload.weight) : undefined,
            imageUrl: payload.images?.[0]?.src || null,
            updatedAt: new Date(),
          },
        });

        // Queue sync to JTL FFN
        await this.queueJTLSync(existingProductChannel.productId, 'WOOCOMMERCE');

        return {
          success: true,
          action: 'updated',
          entityType: 'product',
          localId: existingProductChannel.productId,
          externalId,
          details: { name: payload.name },
        };
      }

      if (action === 'created' || (action === 'updated' && !existingProductChannel)) {
        const sku = payload.sku || `WOO-${payload.id}`;

        const existingProduct = await this.prisma.product.findFirst({
          where: { sku, clientId },
        });

        if (existingProduct) {
          await this.prisma.productChannel.create({
            data: {
              productId: existingProduct.id,
              channelId,
              externalProductId: externalId,
            },
          });

          return {
            success: true,
            action: 'updated',
            entityType: 'product',
            localId: existingProduct.id,
            externalId,
          };
        }

        const newProduct = await this.prisma.product.create({
          data: {
            clientId,
            productId: `WOO-${payload.id}`,
            sku,
            name: payload.name,
            description: payload.description || null,
            netSalesPrice: payload.price ? parseFloat(payload.price) : 0,
            available: payload.stock_quantity ?? 0,
            reserved: 0,
            weightInKg: payload.weight ? parseFloat(payload.weight) : null,
            imageUrl: payload.images?.[0]?.src || null,
            channels: {
              create: {
                channelId,
                externalProductId: externalId,
              },
            },
          },
        });

        // Queue sync to JTL FFN
        await this.queueJTLSync(newProduct.id, 'WOOCOMMERCE');

        return {
          success: true,
          action: 'created',
          entityType: 'product',
          localId: newProduct.id,
          externalId,
          details: { name: payload.name, sku },
        };
      }

      return {
        success: false,
        action: 'skipped',
        entityType: 'product',
        externalId,
        error: `Unknown action: ${action}`,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        entityType: 'product',
        externalId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async handleWooCommerceOrderEvent(
    channelId: string,
    clientId: string,
    action: string,
    payload: WooCommerceOrderPayload
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);

    const existingOrder = await this.prisma.order.findFirst({
      where: {
        channelId,
        externalOrderId: externalId,
      },
    });

    try {
      if (action === 'deleted') {
        if (existingOrder) {
          await this.prisma.order.update({
            where: { id: existingOrder.id },
            data: { status: OrderStatus.CANCELLED },
          });

          return {
            success: true,
            action: 'updated',
            entityType: 'order',
            localId: existingOrder.id,
            externalId,
            details: { status: 'cancelled' },
          };
        }
        return {
          success: true,
          action: 'skipped',
          entityType: 'order',
          externalId,
        };
      }

      if (action === 'updated' && existingOrder) {
        const status = this.mapWooCommerceOrderStatus(payload.status);

        await this.prisma.order.update({
          where: { id: existingOrder.id },
          data: {
            status,
            notes: payload.customer_note || existingOrder.notes,
            updatedAt: new Date(),
          },
        });

        return {
          success: true,
          action: 'updated',
          entityType: 'order',
          localId: existingOrder.id,
          externalId,
          details: { status },
        };
      }

      if (action === 'created' || (action === 'updated' && !existingOrder)) {
        const orderId = `WOO-${payload.number}`;
        const status = this.mapWooCommerceOrderStatus(payload.status);

        const newOrder = await this.prisma.order.create({
          data: {
            clientId,
            channelId,
            orderId,
            orderNumber: payload.number,
            externalOrderId: externalId,
            status,
            orderOrigin: 'WOOCOMMERCE',
            total: parseFloat(payload.total),
            currency: payload.currency,
            customerEmail: payload.billing?.email || null,
            customerName: payload.billing
              ? `${payload.billing.first_name || ''} ${payload.billing.last_name || ''}`.trim()
              : null,
            customerPhone: payload.billing?.phone || null,
            notes: payload.customer_note || null,
            // Shipping address fields
            shippingFirstName: payload.shipping?.first_name || null,
            shippingLastName: payload.shipping?.last_name || null,
            shippingCompany: payload.shipping?.company || null,
            shippingAddress1: payload.shipping?.address_1 || null,
            shippingAddress2: payload.shipping?.address_2 || null,
            shippingCity: payload.shipping?.city || null,
            shippingZip: payload.shipping?.postcode || null,
            shippingCountry: payload.shipping?.country || null,
            // Billing address fields
            billingFirstName: payload.billing?.first_name || null,
            billingLastName: payload.billing?.last_name || null,
            billingCompany: payload.billing?.company || null,
            billingAddress1: payload.billing?.address_1 || null,
            billingAddress2: payload.billing?.address_2 || null,
            billingCity: payload.billing?.city || null,
            billingZip: payload.billing?.postcode || null,
            billingCountry: payload.billing?.country || null,
          },
        });

        // Create order items
        if (payload.line_items && payload.line_items.length > 0) {
          for (const item of payload.line_items) {
            let productId: string | null = null;

            if (item.product_id) {
              const productChannel = await this.prisma.productChannel.findFirst({
                where: {
                  channelId,
                  externalProductId: String(item.product_id),
                },
              });
              productId = productChannel?.productId || null;
            }

            if (!productId && item.sku) {
              const product = await this.prisma.product.findFirst({
                where: { sku: item.sku, clientId },
              });
              productId = product?.id || null;
            }

            await this.prisma.orderItem.create({
              data: {
                orderId: newOrder.id,
                productId,
                sku: item.sku || null,
                productName: item.name || null,
                quantity: item.quantity,
                unitPrice: parseFloat(item.total) / item.quantity,
              },
            });
          }
        }

        // Queue sync to JTL FFN
        await this.queueJTLOrderSync(newOrder.id, 'WOOCOMMERCE');

        return {
          success: true,
          action: 'created',
          entityType: 'order',
          localId: newOrder.id,
          externalId,
          details: { orderNumber: payload.number, status },
        };
      }

      return {
        success: false,
        action: 'skipped',
        entityType: 'order',
        externalId,
        error: `Unknown action: ${action}`,
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

  private async handleWooCommerceRefundEvent(
    channelId: string,
    _clientId: string,
    action: string,
    payload: WooCommerceRefundPayload
  ): Promise<WebhookProcessResult> {
    const externalId = String(payload.id);

    try {
      if (!payload.order_id) {
        return {
          success: false,
          action: 'skipped',
          entityType: 'refund',
          externalId,
          error: 'No order_id in payload',
        };
      }

      const order = await this.prisma.order.findFirst({
        where: {
          channelId,
          externalOrderId: String(payload.order_id),
        },
      });

      if (!order) {
        return {
          success: false,
          action: 'skipped',
          entityType: 'refund',
          externalId,
          error: 'Associated order not found',
        };
      }

      const existingReturn = await this.prisma.return.findFirst({
        where: {
          orderId: order.id,
          externalReturnId: externalId,
        },
      });

      if (action === 'created' && !existingReturn) {
        const newReturn = await this.prisma.return.create({
          data: {
            returnId: `REFUND-WOO-${externalId}`,
            orderId: order.id,
            externalReturnId: externalId,
            status: ReturnStatus.RECEIVED,
            reason: payload.reason || 'Refund from WooCommerce',
          },
        });

        return {
          success: true,
          action: 'created',
          entityType: 'refund',
          localId: newReturn.id,
          externalId,
          details: { orderId: order.id },
        };
      }

      return {
        success: true,
        action: 'skipped',
        entityType: 'refund',
        externalId,
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

  // ============= HELPERS =============

  /**
   * Queue product sync to JTL FFN after webhook processing
   * This ensures products/orders flow: Platform → No-Limits DB → JTL FFN
   */
  private async queueJTLSync(productId: string, channelType: ChannelType): Promise<void> {
    if (!this.syncQueueProcessor) {
      console.warn('[Webhook] SyncQueueProcessor not initialized, skipping JTL sync queue');
      return;
    }

    try {
      // Determine the origin based on channel type
      const origin = channelType === 'SHOPIFY' ? 'SHOPIFY' : 'WOOCOMMERCE';

      // Queue the product to be synced to JTL (and other platforms if needed)
      const jobIds = await this.syncQueueProcessor.queueProductSync(productId, origin, 10);
      console.log(`[Webhook] Queued JTL sync for product ${productId}, jobs: ${jobIds.join(', ')}`);
    } catch (error) {
      console.error(`[Webhook] Failed to queue JTL sync for product ${productId}:`, error);
      // Don't throw - webhook already succeeded, we just failed to queue the sync
    }
  }

  /**
   * Queue order sync to JTL FFN after webhook processing
   * Uses pg-boss queue (same as order-sync.service.ts) for proper worker processing
   */
  private async queueJTLOrderSync(orderId: string, channelType: ChannelType): Promise<void> {
    try {
      // Import queue service dynamically to avoid circular dependencies
      const { getQueue, QUEUE_NAMES } = await import('../queue/sync-queue.service.js');
      const queue = getQueue();

      // Determine the origin based on channel type
      const origin = channelType === 'SHOPIFY' ? 'shopify' : 'woocommerce';

      // Queue the order to pg-boss for processing by QueueWorkerService
      const jobId = await queue.enqueue(
        QUEUE_NAMES.ORDER_SYNC_TO_FFN,
        {
          orderId,
          origin,
          operation: 'create',
        },
        {
          priority: 1,
          retryLimit: 3,
          retryDelay: 60,
          retryBackoff: true,
        }
      );

      console.log(`[Webhook] Queued JTL sync for order ${orderId}, job: ${jobId}`);
    } catch (error) {
      console.error(`[Webhook] Failed to queue JTL sync for order ${orderId}:`, error);
      // Don't throw - webhook already succeeded, we just failed to queue the sync
    }
  }

  private convertWeight(weight: number, unit?: string): number {
    // Convert to kg
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

  private mapShopifyOrderStatus(fulfillmentStatus?: string, financialStatus?: string): OrderStatus {
    if (financialStatus === 'refunded') return OrderStatus.CANCELLED;
    if (fulfillmentStatus === 'fulfilled') return OrderStatus.DELIVERED;
    if (fulfillmentStatus === 'partial') return OrderStatus.SHIPPED;
    if (financialStatus === 'paid') return OrderStatus.PROCESSING;
    if (financialStatus === 'pending') return OrderStatus.PENDING;
    return OrderStatus.PENDING;
  }

  private mapWooCommerceOrderStatus(status: string): OrderStatus {
    switch (status) {
      case 'pending':
        return OrderStatus.PENDING;
      case 'processing':
        return OrderStatus.PROCESSING;
      case 'on-hold':
        return OrderStatus.ON_HOLD;
      case 'completed':
        return OrderStatus.DELIVERED;
      case 'cancelled':
      case 'refunded':
      case 'failed':
        return OrderStatus.CANCELLED;
      default:
        return OrderStatus.PENDING;
    }
  }
}

export default WebhookProcessorService;
