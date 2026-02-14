/**
 * Bi-Directional Sync Service
 * Handles pushing data FROM No-Limits TO e-commerce platforms (Shopify/WooCommerce)
 * This complements the webhook processor which handles incoming data FROM platforms
 * 
 * Flow:
 * - No-Limits → Shopify/WooCommerce (Products, Orders, Returns)
 * - JTL → No-Limits → Shopify/WooCommerce (Inventory, Fulfillment status)
 */

import { PrismaClient, ChannelType, OrderStatus, Prisma } from '@prisma/client';
import { createShopifyServiceAuto } from './shopify-service-factory.js';
import { WooCommerceService } from './woocommerce.service.js';
import { getEncryptionService } from '../encryption.service.js';

type Decimal = Prisma.Decimal;

// ============= TYPES =============

export interface PushResult {
  success: boolean;
  action: 'created' | 'updated' | 'deleted' | 'skipped' | 'failed';
  localId: string;
  externalId?: string;
  platform: 'shopify' | 'woocommerce';
  error?: string;
  details?: Record<string, unknown>;
}

export interface BatchPushResult {
  success: boolean;
  totalProcessed: number;
  totalFailed: number;
  results: PushResult[];
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

export class BiDirectionalSyncService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // ============= PRODUCT SYNC (NO-LIMITS → PLATFORMS) =============

  /**
   * Push a product to all linked channels (wrapper for backwards compatibility)
   */
  async pushProductToPlatform(productId: string): Promise<BatchPushResult> {
    return this.pushProductToAllChannels(productId);
  }

  /**
   * Batch push products (wrapper)
   */
  async batchPushProducts(productIds: string[]): Promise<BatchPushResult> {
    const results: PushResult[] = [];
    let totalFailed = 0;

    for (const productId of productIds) {
      const result = await this.pushProductToAllChannels(productId);
      results.push(...result.results);
      totalFailed += result.totalFailed;
    }

    return {
      success: totalFailed === 0,
      totalProcessed: productIds.length,
      totalFailed,
      results,
    };
  }

  /**
   * Delete product from all channels (wrapper)
   */
  async deleteProductFromPlatform(productId: string): Promise<BatchPushResult> {
    const productChannels = await this.prisma.productChannel.findMany({
      where: { productId },
      select: { channelId: true },
    });

    const results: PushResult[] = [];
    let totalFailed = 0;

    for (const pc of productChannels) {
      const result = await this.deleteProductFromChannel(productId, pc.channelId);
      results.push(result);
      if (!result.success) totalFailed++;
    }

    return {
      success: totalFailed === 0,
      totalProcessed: productChannels.length,
      totalFailed,
      results,
    };
  }

  /**
   * Push a product to a specific channel
   */
  async pushProductToChannel(productId: string, channelId: string): Promise<PushResult> {
    try {
      // Get product with channel relationship
      const productChannel = await this.prisma.productChannel.findFirst({
        where: {
          productId,
          channelId,
        },
        include: {
          product: true,
          channel: true,
        },
      });

      if (!productChannel) {
        return {
          success: false,
          action: 'failed',
          localId: productId,
          platform: 'shopify',
          error: 'Product not linked to this channel',
        };
      }

      const { product, channel } = productChannel;

      if (channel.type === 'SHOPIFY') {
        return this.pushProductToShopify(product, productChannel, channel as ChannelWithCredentials);
      } else if (channel.type === 'WOOCOMMERCE') {
        return this.pushProductToWooCommerce(product, productChannel, channel as ChannelWithCredentials);
      }

      return {
        success: false,
        action: 'skipped',
        localId: productId,
        platform: 'shopify',
        error: `Unsupported channel type: ${channel.type}`,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Push a product to all linked channels
   */
  async pushProductToAllChannels(productId: string): Promise<BatchPushResult> {
    const productChannels = await this.prisma.productChannel.findMany({
      where: { productId },
      select: { channelId: true },
    });

    const results: PushResult[] = [];
    let totalFailed = 0;

    for (const pc of productChannels) {
      const result = await this.pushProductToChannel(productId, pc.channelId);
      results.push(result);
      if (!result.success) totalFailed++;
    }

    return {
      success: totalFailed === 0,
      totalProcessed: productChannels.length,
      totalFailed,
      results,
    };
  }

  /**
   * Push a product to Shopify
   */
  private async pushProductToShopify(
    product: {
      id: string;
      sku: string;
      name: string;
      description: string | null;
      netSalesPrice: Decimal | null;
      available: number;
      weightInKg: Decimal | null;
      imageUrl: string | null;
    },
    productChannel: { externalProductId: string | null },
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.shopDomain || !channel.accessToken) {
      return {
        success: false,
        action: 'failed',
        localId: product.id,
        platform: 'shopify',
        error: 'Missing Shopify credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const shopifyService = createShopifyServiceAuto({
      shopDomain: channel.shopDomain,
      accessToken: encryptionService.safeDecrypt(channel.accessToken),
    });

    try {
      const price = product.netSalesPrice ? Number(product.netSalesPrice) : 0;
      const weight = product.weightInKg ? Number(product.weightInKg) * 1000 : undefined; // Convert kg to g

      if (productChannel.externalProductId) {
        // Update existing product
        const shopifyProduct = await shopifyService.updateProduct(
          parseInt(productChannel.externalProductId),
          {
            title: product.name,
            body_html: product.description || '',
            variants: [{
              price: String(price),
              sku: product.sku,
              weight: weight,
              weight_unit: 'g',
              inventory_quantity: product.available,
            }],
            images: product.imageUrl ? [{ src: product.imageUrl }] : undefined,
          }
        );

        return {
          success: true,
          action: 'updated',
          localId: product.id,
          externalId: String(shopifyProduct.id),
          platform: 'shopify',
          details: { title: shopifyProduct.title },
        };
      } else {
        // Create new product
        const shopifyProduct = await shopifyService.createProduct({
          title: product.name,
          body_html: product.description || '',
          status: 'active',
          variants: [{
            price: String(price),
            sku: product.sku,
            weight: weight,
            weight_unit: 'g',
            inventory_quantity: product.available,
            inventory_management: 'shopify',
          }],
          images: product.imageUrl ? [{ src: product.imageUrl }] : undefined,
        });

        // Update ProductChannel with external ID
        await this.prisma.productChannel.updateMany({
          where: {
            productId: product.id,
            channelId: channel.id,
          },
          data: { externalProductId: String(shopifyProduct.id) },
        });

        return {
          success: true,
          action: 'created',
          localId: product.id,
          externalId: String(shopifyProduct.id),
          platform: 'shopify',
          details: { title: shopifyProduct.title },
        };
      }
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: product.id,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Push a product to WooCommerce
   */
  private async pushProductToWooCommerce(
    product: {
      id: string;
      sku: string;
      name: string;
      description: string | null;
      netSalesPrice: Decimal | null;
      available: number;
      weightInKg: Decimal | null;
      imageUrl: string | null;
    },
    productChannel: { externalProductId: string | null },
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
      return {
        success: false,
        action: 'failed',
        localId: product.id,
        platform: 'woocommerce',
        error: 'Missing WooCommerce credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const wooService = new WooCommerceService({
      url: channel.apiUrl,
      consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
      consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
    });

    try {
      const price = product.netSalesPrice ? Number(product.netSalesPrice) : 0;
      const weight = product.weightInKg ? String(product.weightInKg) : undefined;

      if (productChannel.externalProductId) {
        // Update existing product
        const wooProduct = await wooService.updateProduct(
          parseInt(productChannel.externalProductId),
          {
            name: product.name,
            description: product.description || '',
            sku: product.sku,
            regular_price: String(price),
            manage_stock: true,
            stock_quantity: product.available,
            weight: weight,
            images: product.imageUrl ? [{ src: product.imageUrl }] : undefined,
          }
        );

        return {
          success: true,
          action: 'updated',
          localId: product.id,
          externalId: String(wooProduct.id),
          platform: 'woocommerce',
          details: { name: wooProduct.name },
        };
      } else {
        // Create new product
        const wooProduct = await wooService.createProduct({
          name: product.name,
          type: 'simple',
          status: 'publish',
          description: product.description || '',
          sku: product.sku,
          regular_price: String(price),
          manage_stock: true,
          stock_quantity: product.available,
          weight: weight,
          images: product.imageUrl ? [{ src: product.imageUrl }] : undefined,
        });

        // Update ProductChannel with external ID
        await this.prisma.productChannel.updateMany({
          where: {
            productId: product.id,
            channelId: channel.id,
          },
          data: { externalProductId: String(wooProduct.id) },
        });

        return {
          success: true,
          action: 'created',
          localId: product.id,
          externalId: String(wooProduct.id),
          platform: 'woocommerce',
          details: { name: wooProduct.name },
        };
      }
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: product.id,
        platform: 'woocommerce',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Delete a product from a channel
   */
  async deleteProductFromChannel(productId: string, channelId: string): Promise<PushResult> {
    try {
      const productChannel = await this.prisma.productChannel.findFirst({
        where: { productId, channelId },
        include: {
          product: true,
          channel: true,
        },
      });

      if (!productChannel || !productChannel.externalProductId) {
        return {
          success: false,
          action: 'skipped',
          localId: productId,
          platform: 'shopify',
          error: 'Product not found or no external ID',
        };
      }

      const { channel } = productChannel;

      if (channel.type === 'SHOPIFY') {
        return this.deleteProductFromShopify(productId, productChannel.externalProductId, channel as ChannelWithCredentials);
      } else if (channel.type === 'WOOCOMMERCE') {
        return this.deleteProductFromWooCommerce(productId, productChannel.externalProductId, channel as ChannelWithCredentials);
      }

      return {
        success: false,
        action: 'skipped',
        localId: productId,
        platform: 'shopify',
        error: `Unsupported channel type: ${channel.type}`,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async deleteProductFromShopify(
    productId: string,
    externalProductId: string,
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.shopDomain || !channel.accessToken) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'shopify',
        error: 'Missing credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const shopifyService = createShopifyServiceAuto({
      shopDomain: channel.shopDomain,
      accessToken: encryptionService.safeDecrypt(channel.accessToken),
    });

    try {
      await shopifyService.deleteProduct(parseInt(externalProductId));
      return {
        success: true,
        action: 'deleted',
        localId: productId,
        externalId: externalProductId,
        platform: 'shopify',
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async deleteProductFromWooCommerce(
    productId: string,
    externalProductId: string,
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'woocommerce',
        error: 'Missing credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const wooService = new WooCommerceService({
      url: channel.apiUrl,
      consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
      consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
    });

    try {
      await wooService.deleteProduct(parseInt(externalProductId));
      return {
        success: true,
        action: 'deleted',
        localId: productId,
        externalId: externalProductId,
        platform: 'woocommerce',
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'woocommerce',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Batch push products to a channel
   */
  async batchPushProductsToChannel(productIds: string[], channelId: string): Promise<BatchPushResult> {
    const results: PushResult[] = [];
    let totalFailed = 0;

    for (const productId of productIds) {
      const result = await this.pushProductToChannel(productId, channelId);
      results.push(result);
      if (!result.success) totalFailed++;
    }

    return {
      success: totalFailed === 0,
      totalProcessed: productIds.length,
      totalFailed,
      results,
    };
  }

  // ============= ORDER SYNC (NO-LIMITS → PLATFORMS) =============

  /**
   * Push an order to its channel
   */
  async pushOrderToPlatform(orderId: string): Promise<PushResult> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          channel: true,
          items: {
            include: {
              product: {
                include: {
                  channels: true,
                },
              },
            },
          },
        },
      });

      if (!order) {
        return {
          success: false,
          action: 'failed',
          localId: orderId,
          platform: 'shopify',
          error: 'Order not found',
        };
      }

      const channel = order.channel;
      if (!channel) {
        return {
          success: false,
          action: 'failed',
          localId: orderId,
          platform: 'shopify',
          error: 'Channel not found for order',
        };
      }

      if (channel.type === 'SHOPIFY') {
        return this.pushOrderToShopify(order, channel as ChannelWithCredentials);
      } else if (channel.type === 'WOOCOMMERCE') {
        return this.pushOrderToWooCommerce(order, channel as ChannelWithCredentials);
      }

      return {
        success: false,
        action: 'skipped',
        localId: orderId,
        platform: 'shopify',
        error: `Unsupported channel type: ${channel.type}`,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: orderId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Push order to Shopify (creates draft order)
   */
  private async pushOrderToShopify(
    order: {
      id: string;
      orderId: string;
      orderNumber: string | null;
      externalOrderId: string | null;
      customerEmail: string | null;
      customerName: string | null;
      notes: string | null;
      shippingFirstName: string | null;
      shippingLastName: string | null;
      shippingAddress1: string | null;
      shippingAddress2: string | null;
      shippingCity: string | null;
      shippingZip: string | null;
      shippingCountry: string | null;
      channelId: string | null;
      items: Array<{
        quantity: number;
        unitPrice: Decimal | null;
        product: {
          sku: string;
          channels: Array<{ channelId: string; externalProductId: string | null }>;
        } | null;
      }>;
    },
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.shopDomain || !channel.accessToken) {
      return {
        success: false,
        action: 'failed',
        localId: order.id,
        platform: 'shopify',
        error: 'Missing Shopify credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const shopifyService = createShopifyServiceAuto({
      shopDomain: channel.shopDomain,
      accessToken: encryptionService.safeDecrypt(channel.accessToken),
    });

    try {
      if (order.externalOrderId) {
        // Update existing order
        const shopifyOrder = await shopifyService.updateOrder(
          parseInt(order.externalOrderId),
          {
            note: order.notes || undefined,
            tags: `no-limits-${order.orderId}`,
          }
        );

        return {
          success: true,
          action: 'updated',
          localId: order.id,
          externalId: String(shopifyOrder.id),
          platform: 'shopify',
          details: { orderNumber: shopifyOrder.name },
        };
      } else {
        // Create draft order - find external product IDs for this channel
        const lineItems = order.items.map(item => {
          const channelProduct = item.product?.channels.find(pc => pc.channelId === order.channelId);
          return {
            variant_id: channelProduct?.externalProductId
              ? parseInt(channelProduct.externalProductId)
              : undefined,
            title: item.product?.sku || 'Unknown Product',
            quantity: item.quantity,
            price: item.unitPrice ? String(item.unitPrice) : '0',
            sku: item.product?.sku,
          };
        });

        const draftOrder = await shopifyService.createDraftOrder({
          line_items: lineItems,
          customer: order.customerEmail ? { email: order.customerEmail } : undefined,
          shipping_address: order.shippingAddress1 ? {
            first_name: order.shippingFirstName || '',
            last_name: order.shippingLastName || '',
            address1: order.shippingAddress1,
            address2: order.shippingAddress2 || undefined,
            city: order.shippingCity || '',
            country: order.shippingCountry || '',
            zip: order.shippingZip || '',
          } : undefined,
          note: order.notes || undefined,
          tags: `no-limits-${order.orderId}`,
        });

        // Update order with external ID
        await this.prisma.order.update({
          where: { id: order.id },
          data: { externalOrderId: String(draftOrder.id) },
        });

        return {
          success: true,
          action: 'created',
          localId: order.id,
          externalId: String(draftOrder.id),
          platform: 'shopify',
          details: { draftOrderId: draftOrder.id },
        };
      }
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: order.id,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Push order to WooCommerce
   */
  private async pushOrderToWooCommerce(
    order: {
      id: string;
      orderId: string;
      orderNumber: string | null;
      externalOrderId: string | null;
      status: OrderStatus;
      customerEmail: string | null;
      customerName: string | null;
      customerPhone: string | null;
      notes: string | null;
      shippingFirstName: string | null;
      shippingLastName: string | null;
      shippingCompany: string | null;
      shippingAddress1: string | null;
      shippingAddress2: string | null;
      shippingCity: string | null;
      shippingZip: string | null;
      shippingCountry: string | null;
      billingFirstName: string | null;
      billingLastName: string | null;
      billingCompany: string | null;
      billingAddress1: string | null;
      billingAddress2: string | null;
      billingCity: string | null;
      billingZip: string | null;
      billingCountry: string | null;
      channelId: string | null;
      items: Array<{
        quantity: number;
        unitPrice: Decimal | null;
        product: {
          sku: string;
          channels: Array<{ channelId: string; externalProductId: string | null }>;
        } | null;
      }>;
    },
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
      return {
        success: false,
        action: 'failed',
        localId: order.id,
        platform: 'woocommerce',
        error: 'Missing WooCommerce credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const wooService = new WooCommerceService({
      url: channel.apiUrl,
      consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
      consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
    });

    try {
      const wooOrderStatus = this.mapToWooCommerceStatus(order.status);

      if (order.externalOrderId) {
        // Update existing order
        const wooOrder = await wooService.updateOrder(
          parseInt(order.externalOrderId),
          {
            status: wooOrderStatus,
            customer_note: order.notes || undefined,
          }
        );

        return {
          success: true,
          action: 'updated',
          localId: order.id,
          externalId: String(wooOrder.id),
          platform: 'woocommerce',
          details: { orderNumber: wooOrder.number },
        };
      } else {
        // Create new order - find external product IDs for this channel
        const lineItems = order.items.map(item => {
          const channelProduct = item.product?.channels.find(pc => pc.channelId === order.channelId);
          return {
            product_id: channelProduct?.externalProductId
              ? parseInt(channelProduct.externalProductId)
              : undefined,
            quantity: item.quantity,
            sku: item.product?.sku,
          };
        });

        const wooOrder = await wooService.createOrder({
          status: wooOrderStatus,
          customer_note: order.notes || undefined,
          billing: order.billingAddress1 ? {
            first_name: order.billingFirstName || '',
            last_name: order.billingLastName || '',
            company: order.billingCompany || '',
            address_1: order.billingAddress1,
            address_2: order.billingAddress2 || '',
            city: order.billingCity || '',
            postcode: order.billingZip || '',
            country: order.billingCountry || '',
            email: order.customerEmail || '',
            phone: order.customerPhone || '',
          } : undefined,
          shipping: order.shippingAddress1 ? {
            first_name: order.shippingFirstName || '',
            last_name: order.shippingLastName || '',
            company: order.shippingCompany || '',
            address_1: order.shippingAddress1,
            address_2: order.shippingAddress2 || '',
            city: order.shippingCity || '',
            postcode: order.shippingZip || '',
            country: order.shippingCountry || '',
          } : undefined,
          line_items: lineItems,
        });

        // Update order with external ID
        await this.prisma.order.update({
          where: { id: order.id },
          data: { externalOrderId: String(wooOrder.id) },
        });

        return {
          success: true,
          action: 'created',
          localId: order.id,
          externalId: String(wooOrder.id),
          platform: 'woocommerce',
          details: { orderNumber: wooOrder.number },
        };
      }
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: order.id,
        platform: 'woocommerce',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Update order status on platform
   */
  async updateOrderStatusOnPlatform(orderId: string, status: OrderStatus): Promise<PushResult> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { channel: true },
      });

      if (!order || !order.externalOrderId) {
        return {
          success: false,
          action: 'skipped',
          localId: orderId,
          platform: 'shopify',
          error: 'Order not found or no external ID',
        };
      }

      const channel = order.channel;
      if (!channel) {
        return {
          success: false,
          action: 'failed',
          localId: orderId,
          platform: 'shopify',
          error: 'Channel not found',
        };
      }

      if (channel.type === 'SHOPIFY') {
        return this.updateShopifyOrderStatus(orderId, order.externalOrderId, status, channel as ChannelWithCredentials);
      } else if (channel.type === 'WOOCOMMERCE') {
        return this.updateWooCommerceOrderStatus(orderId, order.externalOrderId, status, channel as ChannelWithCredentials);
      }

      return {
        success: false,
        action: 'skipped',
        localId: orderId,
        platform: 'shopify',
        error: `Unsupported channel type: ${channel.type}`,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: orderId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async updateShopifyOrderStatus(
    localId: string,
    externalOrderId: string,
    status: OrderStatus,
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.shopDomain || !channel.accessToken) {
      return {
        success: false,
        action: 'failed',
        localId,
        platform: 'shopify',
        error: 'Missing Shopify credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const shopifyService = createShopifyServiceAuto({
      shopDomain: channel.shopDomain,
      accessToken: encryptionService.safeDecrypt(channel.accessToken),
    });

    try {
      const orderId = parseInt(externalOrderId);

      if (status === OrderStatus.CANCELLED) {
        await shopifyService.cancelOrder(orderId, { reason: 'other' });
      } else if (status === OrderStatus.DELIVERED) {
        await shopifyService.closeOrder(orderId);
      }

      return {
        success: true,
        action: 'updated',
        localId,
        externalId: externalOrderId,
        platform: 'shopify',
        details: { status },
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async updateWooCommerceOrderStatus(
    localId: string,
    externalOrderId: string,
    status: OrderStatus,
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
      return {
        success: false,
        action: 'failed',
        localId,
        platform: 'woocommerce',
        error: 'Missing WooCommerce credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const wooService = new WooCommerceService({
      url: channel.apiUrl,
      consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
      consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
    });

    try {
      const wooStatus = this.mapToWooCommerceStatus(status);
      await wooService.updateOrderStatus(parseInt(externalOrderId), wooStatus);

      return {
        success: true,
        action: 'updated',
        localId,
        externalId: externalOrderId,
        platform: 'woocommerce',
        details: { status: wooStatus },
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId,
        platform: 'woocommerce',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============= INVENTORY SYNC =============

  /**
   * Update inventory on platform
   * @deprecated Use ProductSyncService.syncStockToChannel() instead.
   * This method will be removed in a future version.
   */
  async updateInventoryOnPlatform(productId: string, channelId: string, stockQuantity: number): Promise<PushResult> {
    console.warn('[BiDirectionalSync] DEPRECATED: updateInventoryOnPlatform() called. Use ProductSyncService.syncStockToChannel() instead.');
    try {
      const productChannel = await this.prisma.productChannel.findFirst({
        where: { productId, channelId },
        include: {
          product: true,
          channel: true,
        },
      });

      if (!productChannel || !productChannel.externalProductId) {
        return {
          success: false,
          action: 'skipped',
          localId: productId,
          platform: 'shopify',
          error: 'Product not found or no external ID',
        };
      }

      const channel = productChannel.channel;

      // Update local stock first
      await this.prisma.product.update({
        where: { id: productId },
        data: { available: stockQuantity },
      });

      if (channel.type === 'SHOPIFY') {
        return this.updateShopifyInventory(productId, productChannel.externalProductId, stockQuantity, channel as ChannelWithCredentials);
      } else if (channel.type === 'WOOCOMMERCE') {
        return this.updateWooCommerceInventory(productId, productChannel.externalProductId, stockQuantity, channel as ChannelWithCredentials);
      }

      return {
        success: false,
        action: 'skipped',
        localId: productId,
        platform: 'shopify',
        error: `Unsupported channel type: ${channel.type}`,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async updateShopifyInventory(
    productId: string,
    externalProductId: string,
    stockQuantity: number,
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.shopDomain || !channel.accessToken) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'shopify',
        error: 'Missing credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const shopifyService = createShopifyServiceAuto({
      shopDomain: channel.shopDomain,
      accessToken: encryptionService.safeDecrypt(channel.accessToken),
    });

    try {
      // Get product to find inventory item ID
      const shopifyProduct = await shopifyService.getProduct(parseInt(externalProductId));
      const variant = shopifyProduct.variants[0];

      if (variant && variant.inventory_item_id) {
        const inventoryLevels = await shopifyService.getInventoryLevels(variant.inventory_item_id);
        const locationId = inventoryLevels.inventory_level?.[0]?.location_id;

        if (locationId) {
          await shopifyService.setInventoryLevel(variant.inventory_item_id, locationId, stockQuantity);
        }
      }

      return {
        success: true,
        action: 'updated',
        localId: productId,
        externalId: externalProductId,
        platform: 'shopify',
        details: { stockQuantity },
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async updateWooCommerceInventory(
    productId: string,
    externalProductId: string,
    stockQuantity: number,
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'woocommerce',
        error: 'Missing credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const wooService = new WooCommerceService({
      url: channel.apiUrl,
      consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
      consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
    });

    try {
      await wooService.updateProductStock(parseInt(externalProductId), stockQuantity);

      return {
        success: true,
        action: 'updated',
        localId: productId,
        externalId: externalProductId,
        platform: 'woocommerce',
        details: { stockQuantity },
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: productId,
        platform: 'woocommerce',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============= REFUND SYNC =============

  /**
   * Create refund on platform
   */
  async createRefundOnPlatform(returnId: string): Promise<PushResult> {
    try {
      const returnRecord = await this.prisma.return.findUnique({
        where: { id: returnId },
        include: {
          order: {
            include: { channel: true },
          },
          items: {
            include: { product: true },
          },
        },
      });

      if (!returnRecord || !returnRecord.order) {
        return {
          success: false,
          action: 'failed',
          localId: returnId,
          platform: 'shopify',
          error: 'Return or order not found',
        };
      }

      const channel = returnRecord.order.channel;
      if (!channel || !returnRecord.order.externalOrderId) {
        return {
          success: false,
          action: 'skipped',
          localId: returnId,
          platform: 'shopify',
          error: 'No channel or external order ID',
        };
      }

      if (channel.type === 'SHOPIFY') {
        return this.createShopifyRefund(returnRecord, returnRecord.order.externalOrderId, channel as ChannelWithCredentials);
      } else if (channel.type === 'WOOCOMMERCE') {
        return this.createWooCommerceRefund(returnRecord, returnRecord.order.externalOrderId, channel as ChannelWithCredentials);
      }

      return {
        success: false,
        action: 'skipped',
        localId: returnId,
        platform: 'shopify',
        error: `Unsupported channel type: ${channel.type}`,
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: returnId,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async createShopifyRefund(
    returnRecord: { id: string; reason: string | null },
    externalOrderId: string,
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.shopDomain || !channel.accessToken) {
      return {
        success: false,
        action: 'failed',
        localId: returnRecord.id,
        platform: 'shopify',
        error: 'Missing credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const shopifyService = createShopifyServiceAuto({
      shopDomain: channel.shopDomain,
      accessToken: encryptionService.safeDecrypt(channel.accessToken),
    });

    try {
      const orderId = parseInt(externalOrderId);
      const refund = await shopifyService.createRefund(orderId, {
        reason: returnRecord.reason || 'Return from No-Limits',
        notify: true,
      });

      // Update return with external ID
      await this.prisma.return.update({
        where: { id: returnRecord.id },
        data: { externalReturnId: String(refund.id) },
      });

      return {
        success: true,
        action: 'created',
        localId: returnRecord.id,
        externalId: String(refund.id),
        platform: 'shopify',
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: returnRecord.id,
        platform: 'shopify',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async createWooCommerceRefund(
    returnRecord: { id: string; reason: string | null },
    externalOrderId: string,
    channel: ChannelWithCredentials
  ): Promise<PushResult> {
    if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
      return {
        success: false,
        action: 'failed',
        localId: returnRecord.id,
        platform: 'woocommerce',
        error: 'Missing credentials',
      };
    }

    const encryptionService = getEncryptionService();
    const wooService = new WooCommerceService({
      url: channel.apiUrl,
      consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
      consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
    });

    try {
      const orderId = parseInt(externalOrderId);
      const refund = await wooService.createRefund(orderId, {
        reason: returnRecord.reason || 'Return from No-Limits',
      });

      // Update return with external ID
      await this.prisma.return.update({
        where: { id: returnRecord.id },
        data: { externalReturnId: String(refund.id) },
      });

      return {
        success: true,
        action: 'created',
        localId: returnRecord.id,
        externalId: String(refund.id),
        platform: 'woocommerce',
      };
    } catch (error) {
      return {
        success: false,
        action: 'failed',
        localId: returnRecord.id,
        platform: 'woocommerce',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============= HELPERS =============

  private mapToWooCommerceStatus(status: OrderStatus): 'pending' | 'processing' | 'on-hold' | 'completed' | 'cancelled' | 'refunded' | 'failed' {
    switch (status) {
      case OrderStatus.PENDING:
        return 'pending';
      case OrderStatus.PROCESSING:
        return 'processing';
      case OrderStatus.SHIPPED:
        return 'processing';
      case OrderStatus.DELIVERED:
        return 'completed';
      case OrderStatus.CANCELLED:
        return 'cancelled';
      case OrderStatus.ON_HOLD:
        return 'on-hold';
      default:
        return 'pending';
    }
  }
}

export default BiDirectionalSyncService;
