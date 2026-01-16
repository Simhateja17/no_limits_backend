/**
 * Return Sync Service
 *
 * Implements the Return Master model:
 * - Returns can be initiated from: Shopify, Platform, or Warehouse
 * - Platform is the RETURN MASTER (owns inspection, restock decisions)
 * - FFN returns are unreliable, Shopify lacks warehouse context
 * - Platform coordinates everything with photo + AI workflows
 *
 * Core principles:
 * 1. Returns are event-driven, not editable objects
 * 2. Platform owns inspection results and restock decisions
 * 3. Refund/restock sync back to commerce platforms
 * 4. Unknown returns trigger admin review
 * 5. Finalized returns cannot be modified
 */

import {
  PrismaClient,
  SyncOrigin,
  SyncStatus,
  ReturnStatus,
  InspectionResult,
  ProductCondition,
  ReturnDisposition,
  Prisma
} from '@prisma/client';
import { ShopifyService } from './shopify.service.js';
import { WooCommerceService } from './woocommerce.service.js';

type Decimal = Prisma.Decimal;

// ============= TYPES =============

export type ReturnOriginType = 'shopify' | 'woocommerce' | 'nolimits' | 'warehouse' | 'system';

export interface ReturnSyncResult {
  success: boolean;
  action: 'created' | 'inspected' | 'restocked' | 'refunded' | 'finalized' | 'skipped' | 'failed';
  returnId: string;
  externalIds?: {
    shopify?: string;
    woocommerce?: string;
  };
  refundSynced?: boolean;
  restockSynced?: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface IncomingReturnData {
  // External IDs
  externalReturnId?: string;
  externalOrderId?: string;
  channelId?: string;

  // Return details
  returnDate?: Date;
  reason?: string;
  reasonCategory?: string;

  // Customer information
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;

  // Items
  items?: Array<{
    sku: string;
    productName?: string;
    quantity: number;
    expectedQuantity?: number;
  }>;

  // Refund info (from Shopify/WooCommerce)
  refundAmount?: number;
  refundCurrency?: string;

  // AI recognition
  aiRecognized?: boolean;
  aiConfidence?: number;
  aiMatchedOrderId?: string;

  // Metadata
  metadata?: Record<string, unknown>;
}

export interface ReturnInspectionData {
  returnId: string;
  inspectionResult: InspectionResult;
  restockEligible: boolean;
  restockQuantity?: number;
  restockReason?: string;

  // Damage/defect details
  hasDamage?: boolean;
  damageDescription?: string;
  hasDefect?: boolean;
  defectDescription?: string;

  // Per-item inspection
  items?: Array<{
    returnItemId: string;
    condition: ProductCondition;
    disposition: ReturnDisposition;
    restockableQuantity: number;
    damagedQuantity: number;
    defectiveQuantity: number;
    notes?: string;
  }>;

  // Photos
  photos?: Array<{
    url: string;
    description?: string;
  }>;

  inspectedBy: string; // User ID
}

export interface ReturnRefundData {
  returnId: string;
  refundAmount: number;
  refundCurrency?: string;
  reason?: string;
  syncToCommerce?: boolean;
}

// ============= RETURN SYNC SERVICE =============

export class ReturnSyncService {
  constructor(
    private prisma: PrismaClient,
    private shopifyService?: ShopifyService,
    private wooCommerceService?: WooCommerceService
  ) { }

  /**
   * Process incoming return from commerce platform (Shopify/WooCommerce)
   *
   * Returns can start anywhere, but the platform becomes the master
   */
  async processIncomingReturn(
    origin: 'shopify' | 'woocommerce',
    clientId: string,
    data: IncomingReturnData,
    webhookEventId?: string
  ): Promise<ReturnSyncResult> {
    try {
      // 1. Find the associated order
      const order = data.externalOrderId
        ? await this.prisma.order.findFirst({
          where: {
            clientId,
            externalOrderId: data.externalOrderId,
          },
        })
        : null;

      // 2. Check if return already exists
      const existingReturn = data.externalReturnId
        ? await this.prisma.return.findFirst({
          where: {
            clientId,
            externalReturnId: data.externalReturnId,
          },
        })
        : null;

      if (existingReturn) {
        console.log(`[ReturnSync] Return already exists: ${data.externalReturnId}`);
        return {
          success: true,
          action: 'skipped',
          returnId: existingReturn.id,
          details: { reason: 'Return already exists' },
        };
      }

      // 3. Create return record (Platform is the master)
      const returnId = `${origin.toUpperCase()}-${data.externalReturnId || Date.now()}`;

      const newReturn = await this.prisma.return.create({
        data: {
          returnId,
          externalOrderId: data.externalOrderId,
          externalReturnId: data.externalReturnId,
          returnOrigin: origin.toUpperCase() as SyncOrigin,
          status: 'RECEIVED',
          inspectionResult: 'PENDING',

          // Return details
          returnDate: data.returnDate || new Date(),
          reason: data.reason,
          reasonCategory: data.reasonCategory,

          // Customer info
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          customerPhone: data.customerPhone,
          customerAddress: data.customerAddress,

          // AI recognition
          aiRecognized: data.aiRecognized ?? false,
          aiConfidence: data.aiConfidence,
          aiMatchedOrderId: data.aiMatchedOrderId,

          // Refund info
          refundAmount: data.refundAmount ? new Prisma.Decimal(data.refundAmount) : null,
          refundCurrency: data.refundCurrency || 'EUR',
          refundSynced: false,

          // Sync tracking
          syncStatus: 'PENDING',

          // Relations
          clientId,
          orderId: order?.id,
          channelId: data.channelId,

          // Return items
          items: {
            create: data.items?.map(item => ({
              sku: item.sku,
              productName: item.productName,
              quantity: item.quantity,
              expectedQuantity: item.expectedQuantity || item.quantity,
              condition: 'GOOD', // Default, will be updated during inspection
              disposition: 'PENDING_DECISION',
            })) || [],
          },
        },
        include: { items: true },
      });

      console.log(`[ReturnSync] Created return ${returnId} from ${origin}`);

      // 4. Log sync event
      await this.logReturnSync({
        returnId: newReturn.id,
        action: 'create',
        origin: origin.toUpperCase() as SyncOrigin,
        targetPlatform: 'nolimits',
        success: true,
      });

      return {
        success: true,
        action: 'created',
        returnId: newReturn.id,
        externalIds: { [origin]: data.externalReturnId },
        details: {
          itemCount: newReturn.items.length,
          orderId: order?.id,
        },
      };
    } catch (error: any) {
      console.error(`[ReturnSync] Failed to process incoming return:`, error);

      await this.logReturnSync({
        returnId: data.externalReturnId || 'unknown',
        action: 'create',
        origin: origin.toUpperCase() as SyncOrigin,
        targetPlatform: 'nolimits',
        success: false,
        errorMessage: error.message,
      });

      return {
        success: false,
        action: 'failed',
        returnId: data.externalReturnId || '',
        error: error.message,
      };
    }
  }

  /**
   * Create return from warehouse (unknown return scenario)
   *
   * Warehouse receives a package without prior notice
   */
  async createWarehouseReturn(
    clientId: string,
    data: {
      sku?: string;
      quantity: number;
      notes?: string;
      photos?: Array<{ url: string; description?: string }>;
    }
  ): Promise<ReturnSyncResult> {
    try {
      const returnId = `WAREHOUSE-${Date.now()}`;

      const newReturn = await this.prisma.return.create({
        data: {
          returnId,
          returnOrigin: 'WAREHOUSE',
          status: 'RECEIVED',
          inspectionResult: 'PENDING',
          isUnknownReturn: true, // Flag for admin review
          returnDate: new Date(),
          warehouseNotes: data.notes,

          // Relations
          clientId,

          // Return items
          items: data.sku
            ? {
              create: {
                sku: data.sku,
                quantity: data.quantity,
                condition: 'GOOD',
                disposition: 'PENDING_DECISION',
              },
            }
            : undefined,

          // Photos
          images: {
            create: data.photos || [],
          },
        },
      });

      console.log(`[ReturnSync] Created unknown warehouse return ${returnId}`);

      await this.logReturnSync({
        returnId: newReturn.id,
        action: 'create',
        origin: 'WAREHOUSE',
        targetPlatform: 'nolimits',
        success: true,
      });

      return {
        success: true,
        action: 'created',
        returnId: newReturn.id,
        details: { isUnknownReturn: true },
      };
    } catch (error: any) {
      console.error(`[ReturnSync] Failed to create warehouse return:`, error);
      return {
        success: false,
        action: 'failed',
        returnId: '',
        error: error.message,
      };
    }
  }

  /**
   * Create return initiated from No-Limits platform
   *
   * This is for returns initiated by the merchant/warehouse staff directly in the platform,
   * not from Shopify webhook or warehouse scan. The platform is the return master,
   * so this creates the return here first, then optionally syncs to commerce platform.
   */
  async createPlatformReturn(
    clientId: string,
    data: {
      orderId: string;           // The order this return is for
      reason: string;
      reasonCategory?: string;
      items: Array<{
        sku: string;
        productName?: string;
        quantity: number;
      }>;
      notes?: string;
      triggerReplacement?: boolean;
      syncToCommerce?: boolean;
      createdBy: string;         // User ID who created this
    }
  ): Promise<ReturnSyncResult> {
    try {
      // Get the order
      const order = await this.prisma.order.findUnique({
        where: { id: data.orderId },
        include: {
          channel: true,
          items: { include: { product: true } },
        },
      });

      if (!order) {
        throw new Error(`Order ${data.orderId} not found`);
      }

      const returnId = `NOLIMITS-${Date.now()}`;

      // Create return record
      const newReturn = await this.prisma.return.create({
        data: {
          returnId,
          externalOrderId: order.externalOrderId,
          returnOrigin: 'NOLIMITS',
          status: 'ANNOUNCED', // Will become RECEIVED when warehouse confirms
          inspectionResult: 'PENDING',
          returnDate: new Date(),
          reason: data.reason,
          reasonCategory: data.reasonCategory,
          notes: data.notes,
          triggerReplacement: data.triggerReplacement || false,

          // Customer info from order
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone,

          // Sync tracking
          syncStatus: data.syncToCommerce ? 'PENDING' : 'SYNCED',

          // Relations
          clientId,
          orderId: order.id,
          channelId: order.channelId,

          // Return items
          items: {
            create: data.items.map((item) => {
              // Find matching order item to get product reference
              const orderItem = order.items.find((oi) => oi.sku === item.sku);
              return {
                sku: item.sku,
                productName: item.productName || orderItem?.productName,
                quantity: item.quantity,
                expectedQuantity: item.quantity,
                condition: 'GOOD',
                disposition: 'PENDING_DECISION',
                productId: orderItem?.productId,
              };
            }),
          },
        },
        include: { items: true },
      });

      console.log(`[ReturnSync] Created platform-initiated return ${returnId}`);

      // Log sync
      await this.logReturnSync({
        returnId: newReturn.id,
        action: 'create',
        origin: 'NOLIMITS',
        targetPlatform: 'nolimits',
        success: true,
      });

      // Sync to commerce platform if requested
      let commerceSynced = false;
      if (data.syncToCommerce && order.channel) {
        try {
          commerceSynced = await this.syncReturnToCommerce(newReturn, order);
        } catch (err: any) {
          console.warn(`[ReturnSync] Failed to sync to commerce:`, err.message);
        }
      }

      return {
        success: true,
        action: 'created',
        returnId: newReturn.id,
        externalIds: commerceSynced ? { [order.channel?.type?.toLowerCase() || '']: newReturn.externalReturnId || '' } : undefined,
        details: {
          orderId: order.id,
          itemCount: newReturn.items.length,
          commerceSynced,
          triggerReplacement: data.triggerReplacement,
        },
      };
    } catch (error: any) {
      console.error(`[ReturnSync] Failed to create platform return:`, error);
      return {
        success: false,
        action: 'failed',
        returnId: '',
        error: error.message,
      };
    }
  }

  /**
   * Sync return to commerce platform (create return/refund in Shopify/WooCommerce)
   */
  private async syncReturnToCommerce(
    returnRecord: any,
    order: any
  ): Promise<boolean> {
    if (!order.channel) return false;

    try {
      const service = this.getCommerceService(order.channel.type);
      if (!service) return false;

      // Create return in commerce platform
      const result = await (service as any).createReturn?.(order.externalOrderId, {
        reason: returnRecord.reason,
        items: returnRecord.items?.map((item: any) => ({
          sku: item.sku,
          quantity: item.quantity,
        })),
      });

      // Update return with external ID
      if (result?.id) {
        await this.prisma.return.update({
          where: { id: returnRecord.id },
          data: {
            externalReturnId: String(result.id),
            syncStatus: 'SYNCED',
            lastSyncedToCommerce: new Date(),
          },
        });
      }

      // Log sync
      await this.logReturnSync({
        returnId: returnRecord.id,
        action: 'create',
        origin: 'NOLIMITS',
        targetPlatform: order.channel.type.toLowerCase(),
        success: true,
        externalId: result?.id ? String(result.id) : undefined,
      });

      console.log(`[ReturnSync] Synced return ${returnRecord.id} to ${order.channel.type}`);

      return true;
    } catch (error: any) {
      console.error(`[ReturnSync] Failed to sync return to commerce:`, error);

      await this.prisma.return.update({
        where: { id: returnRecord.id },
        data: {
          commerceSyncError: error.message,
          syncStatus: 'ERROR',
        },
      });

      await this.logReturnSync({
        returnId: returnRecord.id,
        action: 'create',
        origin: 'NOLIMITS',
        targetPlatform: order.channel.type.toLowerCase(),
        success: false,
        errorMessage: error.message,
      });

      return false;
    }
  }

  /**
   * Perform return inspection
   *
   * Platform owns inspection results - this is the core of the return master model
   */
  async inspectReturn(data: ReturnInspectionData): Promise<ReturnSyncResult> {
    try {
      const { returnId, inspectionResult, restockEligible, items, photos, inspectedBy } = data;

      // 1. Get return
      const existingReturn = await this.prisma.return.findUnique({
        where: { id: returnId },
        include: { items: true, order: true },
      });

      if (!existingReturn) {
        throw new Error(`Return ${returnId} not found`);
      }

      if (existingReturn.finalizedAt) {
        throw new Error('Cannot inspect a finalized return');
      }

      // 2. Update return with inspection results
      const updatedReturn = await this.prisma.return.update({
        where: { id: returnId },
        data: {
          status: 'CHECKED',
          inspectionResult,
          inspectedAt: new Date(),
          inspectedById: inspectedBy,

          // Restock decision
          restockEligible,
          restockQuantity: data.restockQuantity || 0,
          restockReason: data.restockReason,

          // Damage/defect
          hasDamage: data.hasDamage,
          damageDescription: data.damageDescription,
          hasDefect: data.hasDefect,
          defectDescription: data.defectDescription,

          // Add photos
          images: photos
            ? {
              create: photos,
            }
            : undefined,
        },
      });

      // 3. Update return items with inspection details
      if (items) {
        for (const item of items) {
          await this.prisma.returnItem.update({
            where: { id: item.returnItemId },
            data: {
              condition: item.condition,
              disposition: item.disposition,
              restockableQuantity: item.restockableQuantity,
              damagedQuantity: item.damagedQuantity,
              defectiveQuantity: item.defectiveQuantity,
              notes: item.notes,
            },
          });
        }
      }

      console.log(`[ReturnSync] Inspected return ${returnId}: ${inspectionResult}`);

      // 4. Log sync event
      await this.logReturnSync({
        returnId,
        action: 'inspect',
        origin: 'NOLIMITS',
        targetPlatform: 'nolimits',
        success: true,
        inspectionData: {
          result: inspectionResult,
          restockEligible,
          restockQuantity: data.restockQuantity,
        },
      });

      // 5. If restockable, update inventory
      if (restockEligible && data.restockQuantity && data.restockQuantity > 0) {
        await this.processRestock(returnId, data.restockQuantity);
      }

      return {
        success: true,
        action: 'inspected',
        returnId,
        restockSynced: restockEligible,
        details: {
          inspectionResult,
          restockQuantity: data.restockQuantity,
        },
      };
    } catch (error: any) {
      console.error(`[ReturnSync] Failed to inspect return:`, error);
      return {
        success: false,
        action: 'failed',
        returnId: data.returnId,
        error: error.message,
      };
    }
  }

  /**
   * Process restock (update inventory)
   */
  private async processRestock(returnId: string, restockQuantity: number): Promise<void> {
    try {
      const returnRecord = await this.prisma.return.findUnique({
        where: { id: returnId },
        include: { items: true },
      });

      if (!returnRecord) return;

      // Update product stock levels
      for (const item of returnRecord.items) {
        if (item.productId && item.restockableQuantity > 0) {
          await this.prisma.product.update({
            where: { id: item.productId },
            data: {
              available: {
                increment: item.restockableQuantity,
              },
            },
          });

          console.log(
            `[ReturnSync] Restocked ${item.restockableQuantity} units of product ${item.productId}`
          );
        }
      }

      // Update return status
      await this.prisma.return.update({
        where: { id: returnId },
        data: {
          status: 'RESTOCKED',
        },
      });

      // Queue restock sync job
      await this.queueRestockSync(returnId);
    } catch (error) {
      console.error(`[ReturnSync] Failed to process restock:`, error);
    }
  }

  /**
   * Issue refund to customer
   */
  async issueRefund(data: ReturnRefundData): Promise<ReturnSyncResult> {
    try {
      const { returnId, refundAmount, refundCurrency, reason, syncToCommerce = true } = data;

      // 1. Get return
      const returnRecord = await this.prisma.return.findUnique({
        where: { id: returnId },
        include: { order: { include: { channel: true } } },
      });

      if (!returnRecord) {
        throw new Error(`Return ${returnId} not found`);
      }

      if (returnRecord.finalizedAt) {
        throw new Error('Cannot refund a finalized return');
      }

      // 2. Update return with refund info
      await this.prisma.return.update({
        where: { id: returnId },
        data: {
          refundAmount: new Prisma.Decimal(refundAmount),
          refundCurrency: refundCurrency || 'EUR',
          refundSynced: false,
        },
      });

      console.log(`[ReturnSync] Recorded refund ${refundAmount} for return ${returnId}`);

      // 3. Sync refund to commerce platform
      let refundSynced = false;
      if (syncToCommerce && returnRecord.order?.channel) {
        refundSynced = await this.syncRefundToCommerce(returnRecord, refundAmount, reason);
      }

      // 4. Log sync event
      await this.logReturnSync({
        returnId,
        action: 'refund',
        origin: 'NOLIMITS',
        targetPlatform: returnRecord.order?.channel?.type.toLowerCase() || 'unknown',
        success: refundSynced,
      });

      return {
        success: true,
        action: 'refunded',
        returnId,
        refundSynced,
        details: {
          refundAmount,
          syncedToCommerce: refundSynced,
        },
      };
    } catch (error: any) {
      console.error(`[ReturnSync] Failed to issue refund:`, error);
      return {
        success: false,
        action: 'failed',
        returnId: data.returnId,
        error: error.message,
      };
    }
  }

  /**
   * Finalize return (no further changes allowed)
   */
  async finalizeReturn(returnId: string, finalizedBy: string): Promise<ReturnSyncResult> {
    try {
      const returnRecord = await this.prisma.return.update({
        where: { id: returnId },
        data: {
          status: 'COMPLETED',
          finalizedAt: new Date(),
          finalizedById: finalizedBy,
          syncStatus: 'SYNCED',
        },
      });

      console.log(`[ReturnSync] Finalized return ${returnId}`);

      await this.logReturnSync({
        returnId,
        action: 'finalize',
        origin: 'NOLIMITS',
        targetPlatform: 'nolimits',
        success: true,
      });

      return {
        success: true,
        action: 'finalized',
        returnId,
      };
    } catch (error: any) {
      console.error(`[ReturnSync] Failed to finalize return:`, error);
      return {
        success: false,
        action: 'failed',
        returnId,
        error: error.message,
      };
    }
  }

  // ============= HELPER METHODS =============

  /**
   * Sync refund to commerce platform
   */
  private async syncRefundToCommerce(
    returnRecord: any,
    refundAmount: number,
    reason?: string
  ): Promise<boolean> {
    if (!returnRecord.order?.channel) return false;

    try {
      const service = this.getCommerceService(returnRecord.order.channel.type);
      if (!service) return false;

      // Issue refund in commerce platform
      await service.createRefund(returnRecord.externalOrderId, {
        amount: String(refundAmount),
        reason: reason || returnRecord.reason,
        note: returnRecord.restockEligible ? 'Restocked' : 'Not restocked',
      });

      // Update return
      await this.prisma.return.update({
        where: { id: returnRecord.id },
        data: {
          refundSynced: true,
          refundSyncedAt: new Date(),
          lastSyncedToCommerce: new Date(),
        },
      });

      console.log(
        `[ReturnSync] Synced refund to ${returnRecord.order.channel.type} for return ${returnRecord.id}`
      );

      return true;
    } catch (error: any) {
      console.error(`[ReturnSync] Failed to sync refund to commerce:`, error);

      await this.prisma.return.update({
        where: { id: returnRecord.id },
        data: {
          commerceSyncError: error.message,
        },
      });

      return false;
    }
  }

  /**
   * Queue restock sync job
   */
  private async queueRestockSync(returnId: string): Promise<void> {
    try {
      const { getQueue, QUEUE_NAMES } = await import('../queue/sync-queue.service.js');
      const queue = getQueue();

      await queue.enqueue(
        QUEUE_NAMES.RETURN_RESTOCK_SYNC,
        {
          returnId,
          operation: 'restock',
        },
        {
          priority: 1,
          retryLimit: 3,
        }
      );

      console.log(`[ReturnSync] Queued restock sync for return ${returnId}`);
    } catch (error) {
      console.error(`[ReturnSync] Failed to queue restock sync:`, error);
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
   * Log return sync event
   */
  private async logReturnSync(data: {
    returnId: string;
    action: string;
    origin: SyncOrigin;
    targetPlatform: string;
    success: boolean;
    errorMessage?: string;
    externalId?: string;
    inspectionData?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.returnSyncLog.create({
        data: {
          returnId: data.returnId,
          action: data.action,
          origin: data.origin,
          targetPlatform: data.targetPlatform,
          success: data.success,
          errorMessage: data.errorMessage,
          externalId: data.externalId,
          inspectionData: data.inspectionData as Prisma.InputJsonValue ?? undefined,
        },
      });
    } catch (error) {
      console.error(`[ReturnSync] Failed to log sync event:`, error);
    }
  }
}
