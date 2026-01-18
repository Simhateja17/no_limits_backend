/**
 * Order Sync Service
 *
 * Implements single creation authority model for orders:
 * - Commercial truth = Shopify/WooCommerce (orders born at checkout)
 * - Operational truth = No-Limits Platform (fulfillment, carrier, notes)
 *
 * Core principles:
 * 1. Orders ONLY created from commerce platforms (Shopify/WooCommerce)
 * 2. Platform can edit operational fields (fulfillment, carrier, splits, cancellations)
 * 3. Commercial fields (price, payment, customer) are READ-ONLY
 * 4. Operational updates sync to FFN and optionally back to commerce
 * 5. Async, idempotent sync via job queue
 * 6. Shipping method resolution with fallback and mismatch detection
 */

import {
  PrismaClient,
  SyncOrigin,
  SyncStatus,
  OrderStatus,
  FulfillmentState,
  ChannelType,
  Prisma
} from '@prisma/client';
import { ShopifyService } from './shopify.service.js';
import { WooCommerceService } from './woocommerce.service.js';
import { JTLService } from './jtl.service.js';
import ShippingMethodService from '../shipping-method.service.js';
import { notificationService } from '../notification.service.js';

/**
 * Test mode detection constants
 * Orders with these tags or email patterns are stress test orders
 * and should NOT sync to the real JTL-FFN warehouse
 */
const STRESS_TEST_TAGS = ['stress-test', 'k6', 'test-mode', 'load-test'];
const STRESS_TEST_EMAIL_PATTERNS = [
  '@test.com',
  '@test-medium.com',
  '@blackfriday-test.com',
  '@stress-test.io',
  '@load-test.net',
];
import crypto from 'crypto';

type Decimal = Prisma.Decimal;

// ============= FIELD OWNERSHIP DEFINITIONS =============

/**
 * Field ownership for orders
 *
 * 🔴 CRITICAL: Orders follow a DIFFERENT model than products.
 *    Orders are NOT bi-directional. They have a single creation authority.
 */
export const ORDER_FIELD_OWNERSHIP = {
  // 🟢 Commerce-owned (Shopify/WooCommerce authoritative - READ-ONLY in platform)
  // These fields CANNOT be edited in No-Limits. They come from the checkout.
  commercial: [
    'subtotal',
    'shippingCost',
    'tax',
    'total',
    'currency',
    'discountCode',
    'discountAmount',
    'paymentStatus',
    'paymentMethod',
    'customerName',
    'customerEmail',
    'customerPhone',
    'shippingFirstName',
    'shippingLastName',
    'shippingCompany',
    'shippingAddress1',
    'shippingAddress2',
    'shippingCity',
    'shippingZip',
    'shippingCountry',
    'shippingCountryCode',
    'billingFirstName',
    'billingLastName',
    'billingCompany',
    'billingAddress1',
    'billingAddress2',
    'billingCity',
    'billingZip',
    'billingCountry',
    'notes', // Customer notes from commerce platform
    'orderDate',
  ],

  // 🔵 Operational (No-Limits authoritative - EDITABLE in platform)
  // These fields control fulfillment and can be edited
  operational: [
    'fulfillmentState',
    'warehouseNotes',
    'carrierSelection',
    'carrierServiceLevel',
    'priorityLevel',
    'pickingInstructions',
    'packingInstructions',
    'trackingNumber',
    'shippedAt',
    'deliveredAt',
    'isOnHold',
    'isCancelled',
    'cancelledAt',
    'cancelledBy',
    'cancellationReason',
    'addressCorrected',
    'addressCorrectedAt',
    'originalShippingAddress',
    'isSplitOrder',
    'splitFromOrderId',
  ],
} as const;

// ============= TYPES =============

export type OrderSyncOriginType = 'shopify' | 'woocommerce' | 'nolimits' | 'jtl' | 'system';

export interface OrderSyncResult {
  success: boolean;
  action: 'created' | 'updated' | 'cancelled' | 'fulfilled' | 'split' | 'skipped' | 'failed';
  orderId: string;
  externalIds?: {
    shopify?: string;
    woocommerce?: string;
    jtl?: string;
  };
  syncedToFfn?: boolean;
  syncedToCommerce?: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface IncomingOrderData {
  // External IDs
  externalOrderId: string;
  orderNumber?: string;
  channelId: string;

  // Order details (commerce-owned)
  orderDate: Date;
  status?: OrderStatus;

  // Customer information (commerce-owned)
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;

  // Shipping address (commerce-owned)
  shippingFirstName?: string;
  shippingLastName?: string;
  shippingCompany?: string;
  shippingAddress1?: string;
  shippingAddress2?: string;
  shippingCity?: string;
  shippingZip?: string;
  shippingCountry?: string;
  shippingCountryCode?: string;

  // Billing address (commerce-owned)
  billingFirstName?: string;
  billingLastName?: string;
  billingCompany?: string;
  billingAddress1?: string;
  billingAddress2?: string;
  billingCity?: string;
  billingZip?: string;
  billingCountry?: string;

  // Financial (commerce-owned)
  subtotal?: number;
  shippingCost?: number;
  tax?: number;
  total?: number;
  currency?: string;
  discountCode?: string;
  discountAmount?: number;
  paymentStatus?: string;
  paymentMethod?: string;

  // Shipping info
  shippingMethod?: string;         // Human-readable shipping method name from channel
  shippingMethodCode?: string;     // Machine code for shipping method mapping
  trackingNumber?: string;

  // Items
  items?: Array<{
    sku: string;
    productName?: string;
    quantity: number;
    unitPrice?: number;
    totalPrice?: number;
  }>;

  // Notes
  notes?: string;
  tags?: string[];

  // Metadata
  metadata?: Record<string, unknown>;
}

export interface OrderOperationalUpdate {
  orderId: string;
  updates: {
    fulfillmentState?: FulfillmentState;
    warehouseNotes?: string;
    carrierSelection?: string;
    carrierServiceLevel?: string;
    priorityLevel?: number;
    pickingInstructions?: string;
    packingInstructions?: string;
    trackingNumber?: string;
    isOnHold?: boolean;
  };
  updateOrigin?: OrderSyncOriginType;
  syncToFfn?: boolean;
  syncToCommerce?: boolean;
}

export interface OrderCancellationData {
  orderId: string;
  reason?: string;
  cancelledBy: OrderSyncOriginType;
  refundCustomer?: boolean;
  restockItems?: boolean;
}

export interface OrderSplitData {
  originalOrderId: string;
  itemsToSplit: Array<{
    sku: string;
    quantity: number;
  }>;
  reason?: string;
  splitBy: OrderSyncOriginType;
}

// ============= ORDER SYNC SERVICE =============

export class OrderSyncService {
  private shippingMethodService: ShippingMethodService;
  
  constructor(
    private prisma: PrismaClient,
    private shopifyService?: ShopifyService,
    private wooCommerceService?: WooCommerceService,
    private jtlService?: JTLService
  ) {
    this.shippingMethodService = new ShippingMethodService(prisma);
  }

  /**
   * Process incoming order from commerce platform (Shopify/WooCommerce)
   *
   * 🔴 CRITICAL: This is the ONLY way orders should be created.
   *    Orders are born at checkout in the commerce platform.
   */
  async processIncomingOrder(
    origin: 'shopify' | 'woocommerce',
    clientId: string,
    data: IncomingOrderData,
    webhookEventId?: string
  ): Promise<OrderSyncResult> {
    try {
      // 1. Check for echo (did we just push this update?)
      if (await this.isEcho(data.externalOrderId, webhookEventId)) {
        console.log(`[OrderSync] Skipping echo from our own update: ${data.externalOrderId}`);
        return {
          success: true,
          action: 'skipped',
          orderId: data.externalOrderId,
          details: { reason: 'echo_detected' },
        };
      }

      // 2. Check if order already exists
      const existingOrder = await this.prisma.order.findFirst({
        where: {
          clientId,
          externalOrderId: data.externalOrderId,
        },
      });

      let orderId: string;
      let action: 'created' | 'updated';

      if (existingOrder) {
        // Update existing order with new commercial data from origin
        orderId = existingOrder.id;
        action = 'updated';

        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            // Update commercial fields from origin (READ-ONLY in platform)
            orderState: this.mapToOrderStatus(data.status),
            subtotal: data.subtotal ? new Prisma.Decimal(data.subtotal) : undefined,
            shippingCost: data.shippingCost ? new Prisma.Decimal(data.shippingCost) : undefined,
            tax: data.tax ? new Prisma.Decimal(data.tax) : undefined,
            total: data.total ? new Prisma.Decimal(data.total) : undefined,
            currency: data.currency,
            discountCode: data.discountCode,
            discountAmount: data.discountAmount ? new Prisma.Decimal(data.discountAmount) : undefined,
            paymentStatus: data.paymentStatus,
            paymentMethod: data.paymentMethod,
            customerName: data.customerName,
            customerEmail: data.customerEmail,
            customerPhone: data.customerPhone,
            notes: data.notes,
            tags: data.tags,

            // Update tracking
            lastOperationalUpdateAt: new Date(),
          },
        });

        console.log(`[OrderSync] Updated order ${data.externalOrderId} from ${origin}`);
      } else {
        // 2b. Resolve shipping method for new orders
        const channelType = origin.toUpperCase() as ChannelType;
        const shippingResolution = await this.shippingMethodService.resolveShippingMethod(
          { code: data.shippingMethodCode, title: data.shippingMethod },
          channelType,
          clientId,
          data.channelId
        );
        
        console.log(`[OrderSync] Shipping method resolution for ${data.externalOrderId}:`, {
          success: shippingResolution.success,
          jtlShippingMethodId: shippingResolution.jtlShippingMethodId,
          usedFallback: shippingResolution.usedFallback,
          mismatch: shippingResolution.mismatch,
          shouldHoldOrder: shippingResolution.shouldHoldOrder,
        });
        
        // Create new order with commerce data
        const order = await this.prisma.order.create({
          data: {
            orderId: data.externalOrderId,
            orderNumber: data.orderNumber,
            externalOrderId: data.externalOrderId,

            // Origin tracking (CRITICAL)
            orderOrigin: origin.toUpperCase() as SyncOrigin,
            orderState: this.mapToOrderStatus(data.status),
            fulfillmentState: 'PENDING',
            lastOperationalUpdateBy: 'NOLIMITS',

            // Order details
            orderDate: data.orderDate,
            status: this.mapToOrderStatus(data.status),

            // Commercial fields (from origin)
            subtotal: data.subtotal ? new Prisma.Decimal(data.subtotal) : undefined,
            shippingCost: data.shippingCost ? new Prisma.Decimal(data.shippingCost) : undefined,
            tax: data.tax ? new Prisma.Decimal(data.tax) : undefined,
            total: data.total ? new Prisma.Decimal(data.total) : undefined,
            currency: data.currency || 'EUR',
            discountCode: data.discountCode,
            discountAmount: data.discountAmount ? new Prisma.Decimal(data.discountAmount) : undefined,
            paymentStatus: data.paymentStatus,
            paymentMethod: data.paymentMethod,

            // Customer information
            customerName: data.customerName,
            customerEmail: data.customerEmail,
            customerPhone: data.customerPhone,

            // Shipping address
            shippingFirstName: data.shippingFirstName,
            shippingLastName: data.shippingLastName,
            shippingCompany: data.shippingCompany,
            shippingAddress1: data.shippingAddress1,
            shippingAddress2: data.shippingAddress2,
            shippingCity: data.shippingCity,
            shippingZip: data.shippingZip,
            shippingCountry: data.shippingCountry,
            shippingCountryCode: data.shippingCountryCode,

            // Billing address
            billingFirstName: data.billingFirstName,
            billingLastName: data.billingLastName,
            billingCompany: data.billingCompany,
            billingAddress1: data.billingAddress1,
            billingAddress2: data.billingAddress2,
            billingCity: data.billingCity,
            billingZip: data.billingZip,
            billingCountry: data.billingCountry,

            // Shipping info (resolved from channel shipping method)
            shippingMethod: data.shippingMethod,                           // Human-readable from channel
            shippingMethodCode: data.shippingMethodCode,                   // Machine code from channel
            jtlShippingMethodId: shippingResolution.jtlShippingMethodId,  // Resolved JTL ID
            shippingMethodMismatch: shippingResolution.mismatch,          // Flag if no mapping found
            shippingMethodFallback: shippingResolution.usedFallback,      // Flag if using fallback
            isOnHold: shippingResolution.shouldHoldOrder,                 // Hold if no shipping method
            trackingNumber: data.trackingNumber,

            // Notes
            notes: data.notes,
            tags: data.tags,

            // Sync tracking
            syncStatus: 'PENDING',

            // Relations
            clientId,
            channelId: data.channelId,

            // Order items
            items: {
              create: data.items?.map(item => ({
                sku: item.sku,
                productName: item.productName,
                quantity: item.quantity,
                unitPrice: item.unitPrice ? new Prisma.Decimal(item.unitPrice) : undefined,
                totalPrice: item.totalPrice ? new Prisma.Decimal(item.totalPrice) : undefined,
              })) || [],
            },
          },
        });

        orderId = order.id;
        action = 'created';

        // 2c. Create mismatch record if shipping method couldn't be resolved or fallback was used
        if (shippingResolution.mismatch) {
          const mismatchId = await this.shippingMethodService.createMismatchRecord(
            orderId,
            { code: data.shippingMethodCode, title: data.shippingMethod },
            channelType,
            shippingResolution.usedFallback,
            shippingResolution.jtlShippingMethodId ? await this.getShippingMethodIdByJtlId(shippingResolution.jtlShippingMethodId) : undefined
          );
          
          console.log(`[OrderSync] Created shipping method mismatch record for order ${orderId}`);
          
          // Send notification to admin/warehouse about the mismatch
          if (mismatchId) {
            try {
              // Get client name for notification
              const client = await this.prisma.client.findUnique({
                where: { id: clientId },
                select: { name: true, companyName: true },
              });
              
              // Get fallback method name if used
              let fallbackMethodName: string | undefined;
              if (shippingResolution.usedFallback && shippingResolution.jtlShippingMethodId) {
                const fallbackMethod = await this.prisma.shippingMethod.findFirst({
                  where: { jtlShippingMethodId: shippingResolution.jtlShippingMethodId },
                  select: { name: true },
                });
                fallbackMethodName = fallbackMethod?.name;
              }
              
              await notificationService.createShippingMismatchNotification({
                orderId,
                orderDisplayId: data.externalOrderId,
                clientId,
                clientName: client?.companyName || client?.name || 'Unknown Client',
                channelShippingCode: data.shippingMethodCode || null,
                channelShippingTitle: data.shippingMethod || null,
                channelType,
                mismatchId,
                usedFallback: shippingResolution.usedFallback,
                fallbackMethodName,
              });
              
              console.log(`[OrderSync] Sent shipping mismatch notification for order ${orderId}`);
            } catch (notifError) {
              console.error(`[OrderSync] Failed to send mismatch notification:`, notifError);
            }
          }
        }

        console.log(`[OrderSync] Created order ${data.externalOrderId} from ${origin}`);
      }

      // 3. Log sync event
      await this.logOrderSync({
        orderId,
        action,
        origin: origin.toUpperCase() as SyncOrigin,
        targetPlatform: 'nolimits',
        success: true,
        changedFields: Object.keys(data),
      });

      // 4. Queue sync to JTL-FFN (async)
      if (this.jtlService) {
        await this.queueFfnSync(orderId, origin, webhookEventId);
      }

      return {
        success: true,
        action,
        orderId,
        externalIds: { [origin]: data.externalOrderId },
      };
    } catch (error: any) {
      console.error(`[OrderSync] Failed to process incoming order:`, error);

      // Log failed sync
      if (data.externalOrderId) {
        await this.logOrderSync({
          orderId: data.externalOrderId,
          action: 'create',
          origin: origin.toUpperCase() as SyncOrigin,
          targetPlatform: 'nolimits',
          success: false,
          errorMessage: error.message,
        });
      }

      return {
        success: false,
        action: 'failed',
        orderId: data.externalOrderId,
        error: error.message,
      };
    }
  }

  /**
   * Update operational fields (fulfillment, carrier, notes, etc.)
   *
   * These updates are allowed in No-Limits and sync to FFN.
   * Optionally sync back to commerce platform (e.g., tracking number).
   */
  async updateOperationalFields(data: OrderOperationalUpdate): Promise<OrderSyncResult> {
    try {
      const { orderId, updates, updateOrigin = 'nolimits', syncToFfn = true, syncToCommerce = false } = data;

      // 1. Validate order exists
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { channel: true },
      });

      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      // 2. Update operational fields
      const updatedOrder = await this.prisma.order.update({
        where: { id: orderId },
        data: {
          ...updates,
          lastOperationalUpdateBy: updateOrigin.toUpperCase() as SyncOrigin,
          lastOperationalUpdateAt: new Date(),
        },
      });

      console.log(`[OrderSync] Updated operational fields for order ${orderId}`);

      // 3. Log sync event
      await this.logOrderSync({
        orderId,
        action: 'update',
        origin: updateOrigin.toUpperCase() as SyncOrigin,
        targetPlatform: 'nolimits',
        success: true,
        changedFields: Object.keys(updates),
      });

      // 4. Sync to FFN if requested
      if (syncToFfn && this.jtlService) {
        await this.syncOperationalToFfn(orderId, Object.keys(updates));
      }

      // 5. Sync to commerce platform if requested (e.g., tracking number)
      if (syncToCommerce && order.channel) {
        await this.syncOperationalToCommerceInternal(order, Object.keys(updates));
      }

      return {
        success: true,
        action: 'updated',
        orderId,
        syncedToFfn: syncToFfn,
        syncedToCommerce: syncToCommerce,
      };
    } catch (error: any) {
      console.error(`[OrderSync] Failed to update operational fields:`, error);
      return {
        success: false,
        action: 'failed',
        orderId: data.orderId,
        error: error.message,
      };
    }
  }

  /**
   * Cancel an order
   *
   * Cancellations can be initiated in No-Limits and must sync to FFN and commerce.
   */
  async cancelOrder(data: OrderCancellationData): Promise<OrderSyncResult> {
    try {
      const { orderId, reason, cancelledBy, refundCustomer = false, restockItems = true } = data;

      // 1. Update order
      const order = await this.prisma.order.update({
        where: { id: orderId },
        data: {
          isCancelled: true,
          cancelledAt: new Date(),
          cancelledBy: cancelledBy.toUpperCase() as SyncOrigin,
          cancellationReason: reason,
          orderState: 'CANCELLED',
          fulfillmentState: 'PENDING',
          lastOperationalUpdateBy: cancelledBy.toUpperCase() as SyncOrigin,
          lastOperationalUpdateAt: new Date(),
        },
        include: { channel: true },
      });

      console.log(`[OrderSync] Cancelled order ${orderId}`);

      // 2. Log sync event
      await this.logOrderSync({
        orderId,
        action: 'cancel',
        origin: cancelledBy.toUpperCase() as SyncOrigin,
        targetPlatform: 'nolimits',
        success: true,
        changedFields: ['isCancelled', 'cancelledAt', 'cancellationReason'],
      });

      // 3. Sync to FFN
      if (this.jtlService) {
        await this.jtlService.cancelOrderInFfn(orderId, this.prisma, undefined, restockItems);
      }

      // 4. Sync to commerce platform
      if (order.channel) {
        await this.syncCancellationToCommerce(order, refundCustomer);
      }

      return {
        success: true,
        action: 'cancelled',
        orderId,
        syncedToFfn: true,
        syncedToCommerce: true,
      };
    } catch (error: any) {
      console.error(`[OrderSync] Failed to cancel order:`, error);
      return {
        success: false,
        action: 'failed',
        orderId: data.orderId,
        error: error.message,
      };
    }
  }

  /**
   * Split an order into multiple fulfillment orders
   *
   * This is an operational feature that creates new FFN fulfillment orders.
   */
  async splitOrder(data: OrderSplitData): Promise<OrderSyncResult> {
    try {
      const { originalOrderId, itemsToSplit, reason, splitBy } = data;

      // 1. Validate original order
      const originalOrder = await this.prisma.order.findUnique({
        where: { id: originalOrderId },
        include: { items: true },
      });

      if (!originalOrder) {
        throw new Error(`Order ${originalOrderId} not found`);
      }

      // 2. Create split order record
      const splitOrder = await this.prisma.order.create({
        data: {
          orderId: `${originalOrder.orderId}-SPLIT-${Date.now()}`,
          orderNumber: `${originalOrder.orderNumber}-SPLIT`,
          externalOrderId: originalOrder.externalOrderId,

          // Copy from original order
          orderOrigin: originalOrder.orderOrigin,
          orderState: originalOrder.orderState,
          fulfillmentState: 'PENDING',
          lastOperationalUpdateBy: splitBy.toUpperCase() as SyncOrigin,

          // Mark as split
          isSplitOrder: true,
          splitFromOrderId: originalOrderId,

          // Copy commercial fields
          subtotal: originalOrder.subtotal,
          shippingCost: originalOrder.shippingCost,
          tax: originalOrder.tax,
          total: originalOrder.total,
          currency: originalOrder.currency,

          // Copy customer/shipping info
          customerName: originalOrder.customerName,
          customerEmail: originalOrder.customerEmail,
          customerPhone: originalOrder.customerPhone,
          shippingFirstName: originalOrder.shippingFirstName,
          shippingLastName: originalOrder.shippingLastName,
          shippingAddress1: originalOrder.shippingAddress1,
          shippingCity: originalOrder.shippingCity,
          shippingZip: originalOrder.shippingZip,
          shippingCountry: originalOrder.shippingCountry,

          // Relations
          clientId: originalOrder.clientId,
          channelId: originalOrder.channelId,

          // Items
          items: {
            create: itemsToSplit.map(item => {
              const originalItem = originalOrder.items.find(i => i.sku === item.sku);
              return {
                sku: item.sku,
                productName: originalItem?.productName,
                quantity: item.quantity,
                unitPrice: originalItem?.unitPrice,
                totalPrice: originalItem?.unitPrice
                  ? new Prisma.Decimal(originalItem.unitPrice.toString()).mul(item.quantity)
                  : undefined,
              };
            }),
          },
        },
      });

      console.log(`[OrderSync] Created split order ${splitOrder.id} from ${originalOrderId}`);

      // 3. Log sync event
      await this.logOrderSync({
        orderId: splitOrder.id,
        action: 'split',
        origin: splitBy.toUpperCase() as SyncOrigin,
        targetPlatform: 'nolimits',
        success: true,
        changedFields: ['isSplitOrder', 'splitFromOrderId'],
      });

      // 4. Create FFN fulfillment order for split
      if (this.jtlService) {
        await this.jtlService.createFulfillmentOrder(splitOrder.id, itemsToSplit, this.prisma);
      }

      return {
        success: true,
        action: 'split',
        orderId: splitOrder.id,
        details: { originalOrderId, splitOrderId: splitOrder.id },
      };
    } catch (error: any) {
      console.error(`[OrderSync] Failed to split order:`, error);
      return {
        success: false,
        action: 'failed',
        orderId: data.originalOrderId,
        error: error.message,
      };
    }
  }

  // ============= HELPER METHODS =============

  /**
   * Check if this is an echo from our own update
   */
  private async isEcho(externalOrderId: string, webhookEventId?: string): Promise<boolean> {
    if (!webhookEventId) return false;

    const recentLog = await this.prisma.orderSyncLog.findFirst({
      where: {
        externalId: externalOrderId,
        createdAt: {
          gte: new Date(Date.now() - 5 * 60 * 1000), // Last 5 minutes
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return recentLog !== null;
  }

  /**
   * Check if an order is a stress test order (should not sync to real FFN)
   */
  private isStressTestOrder(order: { tags?: string[] | null; customerEmail?: string | null }): boolean {
    // Check for stress test tags
    if (order.tags && Array.isArray(order.tags)) {
      const hasTestTag = order.tags.some(tag => 
        STRESS_TEST_TAGS.some(testTag => tag.toLowerCase().includes(testTag))
      );
      if (hasTestTag) return true;
    }

    // Check for stress test email patterns
    if (order.customerEmail) {
      const hasTestEmail = STRESS_TEST_EMAIL_PATTERNS.some(pattern =>
        order.customerEmail!.toLowerCase().includes(pattern.toLowerCase())
      );
      if (hasTestEmail) return true;
    }

    return false;
  }

  /**
   * Queue sync to JTL-FFN
   * 
   * NOTE: Stress test orders (identified by tags or email patterns) are
   * automatically skipped to prevent test data from reaching the real warehouse.
   */
  private async queueFfnSync(orderId: string, origin: string, eventId?: string): Promise<void> {
    try {
      // First, check if this is a stress test order
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { tags: true, customerEmail: true },
      });

      if (order && this.isStressTestOrder(order)) {
        console.log(`[OrderSync] Skipping FFN sync for stress test order ${orderId}`);
        
        // Update sync status to indicate test mode skip
        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            syncStatus: 'SKIPPED',
            ffnSyncError: 'Stress test order - FFN sync disabled',
          },
        });
        return;
      }

      // Import queue service dynamically to avoid circular dependencies
      const { getQueue, QUEUE_NAMES } = await import('../queue/sync-queue.service.js');

      const queue = getQueue();

      // Enqueue the job
      await queue.enqueue(
        QUEUE_NAMES.ORDER_SYNC_TO_FFN,
        {
          orderId,
          origin: origin as any,
          operation: 'create',
        },
        {
          priority: 1, // High priority for new orders
          retryLimit: 3,
          retryDelay: 60,
          retryBackoff: true,
        }
      );

      console.log(`[OrderSync] Queued FFN sync for order ${orderId}`);

      // Update sync status to pending
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          syncStatus: 'PENDING',
        },
      });
    } catch (error: any) {
      console.error(`[OrderSync] Failed to queue FFN sync:`, error);

      // Fallback to direct sync if queue is not available
      if (this.jtlService) {
        try {
          await this.jtlService.syncOrderToFfn(orderId, this.prisma);

          await this.prisma.order.update({
            where: { id: orderId },
            data: {
              lastSyncedToFfn: new Date(),
              syncStatus: 'SYNCED',
            },
          });
        } catch (syncError: any) {
          await this.prisma.order.update({
            where: { id: orderId },
            data: {
              ffnSyncError: syncError.message,
              syncStatus: 'ERROR',
            },
          });
        }
      }
    }
  }

  /**
   * Sync operational fields to FFN
   */
  private async syncOperationalToFfn(orderId: string, changedFields: string[]): Promise<void> {
    if (!this.jtlService) return;

    try {
      // Push operational changes to FFN
      await this.jtlService.updateOrderOperationalFields(orderId, changedFields, this.prisma);

      await this.prisma.order.update({
        where: { id: orderId },
        data: { lastSyncedToFfn: new Date() },
      });

      console.log(`[OrderSync] Synced operational fields to FFN: ${changedFields.join(', ')}`);
    } catch (error: any) {
      console.error(`[OrderSync] Failed to sync operational to FFN:`, error);

      await this.prisma.order.update({
        where: { id: orderId },
        data: { ffnSyncError: error.message },
      });
    }
  }

  /**
   * Sync operational fields to commerce platform (public wrapper for queue worker)
   */
  async syncOperationalToCommerce(
    orderId: string,
    operation: 'create' | 'update' | 'cancel' | 'fulfill'
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { channel: true },
      });

      if (!order) {
        return { success: false, error: `Order ${orderId} not found` };
      }

      if (!order.channel) {
        return { success: false, error: `Order ${orderId} has no channel` };
      }

      if (operation === 'cancel') {
        await this.syncCancellationToCommerce(order, true);
      } else if (operation === 'fulfill') {
        await this.syncOperationalToCommerceInternal(order, ['trackingNumber', 'shippedAt', 'fulfillmentState']);
      } else {
        // For create/update, sync all trackable operational fields
        await this.syncOperationalToCommerceInternal(order, ['trackingNumber', 'shippedAt', 'fulfillmentState', 'carrierSelection']);
      }

      return { success: true };
    } catch (error: any) {
      console.error(`[OrderSync] syncOperationalToCommerce failed:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sync operational fields to commerce platform (internal)
   */
  private async syncOperationalToCommerceInternal(order: any, changedFields: string[]): Promise<void> {
    if (!order.channel) return;

    try {
      const service = this.getCommerceService(order.channel.type);
      if (!service) return;

      // Only sync specific fields that commerce platforms care about
      const syncableFields = ['trackingNumber', 'shippedAt', 'fulfillmentState'];
      const fieldsToSync = changedFields.filter(f => syncableFields.includes(f));

      if (fieldsToSync.length === 0) return;

      // Push to commerce platform - use type assertion since method may not exist on all services
      const updateFn = (service as any).updateOrderFulfillment?.bind(service);
      if (updateFn) {
        await updateFn(order.externalOrderId, {
          trackingNumber: order.trackingNumber,
          shippedAt: order.shippedAt,
          status: this.mapFulfillmentStateToCommerceStatus(order.fulfillmentState),
        });
      } else {
        console.warn(`[OrderSync] ${order.channel.type} does not support updateOrderFulfillment`);
      }

      await this.prisma.order.update({
        where: { id: order.id },
        data: { lastSyncedToCommerce: new Date() },
      });

      console.log(`[OrderSync] Synced operational fields to ${order.channel.type}: ${fieldsToSync.join(', ')}`);
    } catch (error: any) {
      console.error(`[OrderSync] Failed to sync operational to commerce:`, error);

      await this.prisma.order.update({
        where: { id: order.id },
        data: { commerceSyncError: error.message },
      });
    }
  }

  /**
   * Sync cancellation to commerce platform
   */
  private async syncCancellationToCommerce(order: any, refundCustomer: boolean): Promise<void> {
    if (!order.channel) return;

    try {
      const service = this.getCommerceService(order.channel.type);
      if (!service) return;

      // Cancel order in commerce platform - use type assertion since method may not exist on all services
      const cancelFn = (service as any).cancelOrder?.bind(service);
      if (cancelFn) {
        await cancelFn(order.externalOrderId, {
          reason: order.cancellationReason,
          refund: refundCustomer,
          restock: true,
        });
      } else {
        console.warn(`[OrderSync] ${order.channel.type} does not support cancelOrder`);
      }

      await this.prisma.order.update({
        where: { id: order.id },
        data: { lastSyncedToCommerce: new Date() },
      });

      console.log(`[OrderSync] Synced cancellation to ${order.channel.type}`);
    } catch (error: any) {
      console.error(`[OrderSync] Failed to sync cancellation to commerce:`, error);

      await this.prisma.order.update({
        where: { id: order.id },
        data: { commerceSyncError: error.message },
      });
    }
  }

  /**
   * Get commerce service based on channel type
   */
  private getCommerceService(channelType: string): ShopifyService | WooCommerceService | null {
    switch (channelType.toLowerCase()) {
      case 'shopify':
        return this.shopifyService || null;
      case 'woocommerce':
        return this.wooCommerceService || null;
      default:
        return null;
    }
  }

  /**
   * Map to OrderStatus enum
   */
  private mapToOrderStatus(status?: OrderStatus | string): OrderStatus {
    if (!status) return 'PENDING';

    const statusMap: Record<string, OrderStatus> = {
      'pending': 'PENDING',
      'processing': 'PROCESSING',
      'on-hold': 'ON_HOLD',
      'completed': 'SHIPPED',
      'cancelled': 'CANCELLED',
      'refunded': 'CANCELLED',
      'failed': 'ERROR',
    };

    return statusMap[status.toLowerCase()] || status as OrderStatus;
  }

  /**
   * Map FulfillmentState to commerce platform status
   */
  private mapFulfillmentStateToCommerceStatus(state: FulfillmentState): string {
    const stateMap: Record<FulfillmentState, string> = {
      'PENDING': 'pending',
      'AWAITING_STOCK': 'pending',
      'READY_FOR_PICKING': 'processing',
      'PICKING': 'processing',
      'PICKED': 'processing',
      'PACKING': 'processing',
      'PACKED': 'processing',
      'LABEL_CREATED': 'processing',
      'SHIPPED': 'fulfilled',
      'IN_TRANSIT': 'fulfilled',
      'OUT_FOR_DELIVERY': 'fulfilled',
      'DELIVERED': 'delivered',
      'FAILED_DELIVERY': 'failed',
      'RETURNED_TO_SENDER': 'cancelled',
    };

    return stateMap[state] || 'pending';
  }

  /**
   * Log order sync event
   */
  private async logOrderSync(data: {
    orderId: string;
    action: string;
    origin: SyncOrigin;
    targetPlatform: string;
    success: boolean;
    changedFields?: string[];
    errorMessage?: string;
    externalId?: string;
  }): Promise<void> {
    try {
      await this.prisma.orderSyncLog.create({
        data: {
          orderId: data.orderId,
          action: data.action,
          origin: data.origin,
          targetPlatform: data.targetPlatform,
          changedFields: data.changedFields || [],
          success: data.success,
          errorMessage: data.errorMessage,
          externalId: data.externalId,
        },
      });
    } catch (error) {
      console.error(`[OrderSync] Failed to log sync event:`, error);
    }
  }

  /**
   * Get shipping method internal ID by JTL FFN shipping method ID
   */
  private async getShippingMethodIdByJtlId(jtlShippingMethodId: string): Promise<string | undefined> {
    const method = await this.prisma.shippingMethod.findFirst({
      where: { jtlShippingMethodId },
      select: { id: true },
    });
    return method?.id;
  }
}
