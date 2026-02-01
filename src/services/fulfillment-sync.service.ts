/**
 * Fulfillment Sync Service
 * Handles bi-directional synchronization between:
 * - Shopify (commerce platform)
 * - No-Limits (operational hub)
 * - JTL FFN (warehouse fulfillment)
 *
 * Data Flow:
 * 1. Orders: Shopify → No-Limits → JTL FFN
 * 2. Fulfillment Status: JTL FFN → No-Limits → Shopify
 * 3. Tracking: JTL FFN → No-Limits → Shopify
 * 4. Holds: No-Limits → JTL FFN (priority) + Shopify (hold status)
 */

import { PrismaClient } from '@prisma/client';
import { JTLService } from './integrations/jtl.service.js';
import { getEncryptionService } from './encryption.service.js';
import { Logger } from '../utils/logger.js';
import { generateJobId } from '../utils/job-id.js';

// Status mappings between platforms
const JTL_TO_NOLIMITS_STATUS: Record<string, string> = {
  'pending': 'PENDING',
  'preparation': 'PREPARATION',
  'acknowledged': 'ACKNOWLEDGED',
  'locked': 'LOCKED',
  'pickprocess': 'PICKPROCESS',
  'shipped': 'SHIPPED',
  'partiallyshipped': 'PARTIALLY_SHIPPED',
  'canceled': 'CANCELED',
  'partiallycanceled': 'PARTIALLY_CANCELED',
  // Post-FFN tracking states (may come from carrier webhooks)
  'intransit': 'IN_TRANSIT',
  'delivered': 'DELIVERED',
  'failed': 'FAILED_DELIVERY',
  'returned': 'RETURNED_TO_SENDER',
};

const NOLIMITS_TO_SHOPIFY_STATUS: Record<string, string> = {
  'PENDING': 'OPEN',
  'PREPARATION': 'IN_PROGRESS',
  'ACKNOWLEDGED': 'IN_PROGRESS',
  'LOCKED': 'IN_PROGRESS',
  'PICKPROCESS': 'IN_PROGRESS',
  'SHIPPED': 'CLOSED',
  'PARTIALLY_SHIPPED': 'IN_PROGRESS',
  'CANCELED': 'CANCELLED',
  'PARTIALLY_CANCELED': 'IN_PROGRESS',
  'IN_TRANSIT': 'CLOSED',
  'DELIVERED': 'CLOSED',
  'FAILED_DELIVERY': 'OPEN',
  'RETURNED_TO_SENDER': 'CANCELLED',
  'ON_HOLD': 'ON_HOLD',
};

interface SyncResult {
  success: boolean;
  orderId: string;
  syncedTo: string[];
  errors: string[];
}

interface PollingResult {
  processedCount: number;
  errors: string[];
  lastPollTime: Date;
}

export class FulfillmentSyncService {
  private prisma: PrismaClient;
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;
  private logger = new Logger('FulfillmentSync');

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Get JTL service for a specific client
   */
  private async getJTLService(clientId: string): Promise<JTLService | null> {
    try {
      const jtlConfig = await this.prisma.jtlConfig.findUnique({
        where: { clientId_fk: clientId },
      });

      if (!jtlConfig || !jtlConfig.accessToken) {
        return null;
      }

      const encryptionService = getEncryptionService();

      return new JTLService({
        clientId: jtlConfig.clientId,
        clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
        environment: (jtlConfig.environment || 'sandbox') as 'sandbox' | 'production',
        accessToken: encryptionService.safeDecrypt(jtlConfig.accessToken),
        refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
        tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
        warehouseId: jtlConfig.warehouseId || undefined,
        fulfillerId: jtlConfig.fulfillerId || undefined,
      });
    } catch (error) {
      console.error('[FulfillmentSync] Failed to get JTL service:', error);
      return null;
    }
  }

  /**
   * Sync order hold status to JTL FFN
   * Uses priority levels to effectively hold/release orders
   */
  async syncHoldToJTL(orderId: string): Promise<SyncResult> {
    const jobId = generateJobId('hold-sync');
    const startTime = Date.now();

    const result: SyncResult = {
      success: false,
      orderId,
      syncedTo: [],
      errors: [],
    };

    this.logger.debug({
      jobId,
      event: 'sync_started',
      operation: 'syncHoldToJTL',
      orderId
    });

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        this.logger.warn({
          jobId,
          event: 'sync_failed',
          orderId,
          error: 'Order not found'
        });
        result.errors.push('Order not found');
        return result;
      }

      if (!order.jtlOutboundId || !order.clientId) {
        this.logger.warn({
          jobId,
          event: 'sync_skipped',
          orderId,
          reason: 'not_synced_to_jtl'
        });
        result.errors.push('Order not synced to JTL FFN');
        return result;
      }

      const jtlService = await this.getJTLService(order.clientId);
      if (!jtlService) {
        this.logger.error({
          jobId,
          event: 'sync_failed',
          orderId,
          error: 'JTL FFN not configured'
        });
        result.errors.push('JTL FFN not configured');
        return result;
      }

      if (order.isOnHold) {
        this.logger.debug({
          jobId,
          event: 'hold_operation',
          action: 'hold',
          orderId,
          jtlOutboundId: order.jtlOutboundId,
          holdReason: order.holdReason
        });

        // Place on hold
        const holdResult = await jtlService.holdOutbound(
          order.jtlOutboundId,
          order.holdReason || 'OTHER',
          order.holdNotes || undefined
        );

        if (!holdResult.success) {
          result.errors.push(holdResult.error || 'Failed to hold in JTL');
        } else {
          result.syncedTo.push('jtl');
        }
      } else {
        this.logger.debug({
          jobId,
          event: 'hold_operation',
          action: 'release',
          orderId,
          jtlOutboundId: order.jtlOutboundId,
          priorityLevel: order.priorityLevel
        });

        // Release from hold
        const releaseResult = await jtlService.releaseOutbound(
          order.jtlOutboundId,
          order.priorityLevel || 0
        );

        if (!releaseResult.success) {
          result.errors.push(releaseResult.error || 'Failed to release in JTL');
        } else {
          result.syncedTo.push('jtl');
        }
      }

      // Log sync
      await this.prisma.orderSyncLog.create({
        data: {
          orderId,
          action: order.isOnHold ? 'hold' : 'release_hold',
          origin: 'NOLIMITS',
          targetPlatform: 'jtl',
          success: result.errors.length === 0,
          errorMessage: result.errors.length > 0 ? result.errors.join('; ') : null,
          changedFields: ['priority', 'internalNote'],
        },
      });

      result.success = result.errors.length === 0;

      this.logger.info({
        jobId,
        event: 'sync_completed',
        operation: 'syncHoldToJTL',
        orderId,
        duration: Date.now() - startTime,
        success: result.success,
        action: order.isOnHold ? 'hold' : 'release'
      });

      return result;
    } catch (error: any) {
      this.logger.error({
        jobId,
        event: 'sync_failed',
        operation: 'syncHoldToJTL',
        orderId,
        duration: Date.now() - startTime,
        error: error.message,
        stack: error.stack
      });

      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Sync tracking information from JTL FFN to local DB
   */
  async syncTrackingFromJTL(orderId: string): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      orderId,
      syncedTo: [],
      errors: [],
    };

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
      });

      if (!order || !order.jtlOutboundId || !order.clientId) {
        result.errors.push('Order not found or not synced to JTL');
        return result;
      }

      const jtlService = await this.getJTLService(order.clientId);
      if (!jtlService) {
        result.errors.push('JTL FFN not configured');
        return result;
      }

      const notifications = await jtlService.getShippingNotifications(order.jtlOutboundId);

      if (!notifications.success || !notifications.data || notifications.data.packages.length === 0) {
        result.errors.push('No tracking information available');
        return result;
      }

      // Extract tracking info from the shipping notification
      const trackingInfo = jtlService.extractTrackingInfo(notifications.data);

      if (!trackingInfo.trackingNumber) {
        result.errors.push('No tracking number in shipping notification');
        return result;
      }

      console.log(`[FulfillmentSync] Extracted tracking for order ${orderId}: ${trackingInfo.trackingNumber} (carrier: ${trackingInfo.carrier})`);

      // Update order with tracking info
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          trackingNumber: trackingInfo.trackingNumber,
          carrierSelection: trackingInfo.carrier || null,
          trackingUrl: trackingInfo.trackingUrl || null,
          shippedAt: new Date(),
          fulfillmentState: 'SHIPPED',
          lastOperationalUpdateBy: 'JTL',
          lastOperationalUpdateAt: new Date(),
        },
      });

      // Log sync
      await this.prisma.orderSyncLog.create({
        data: {
          orderId,
          action: 'update_tracking',
          origin: 'JTL',
          targetPlatform: 'nolimits',
          success: true,
          changedFields: ['trackingNumber', 'carrierSelection', 'shippedAt'],
        },
      });

      result.syncedTo.push('nolimits');
      result.success = true;
      return result;
    } catch (error: any) {
      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Sync fulfillment status from JTL FFN to local DB
   */
  async syncStatusFromJTL(jtlOutboundId: string, jtlStatus: string): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      orderId: '',
      syncedTo: [],
      errors: [],
    };

    try {
      // Find order by JTL outbound ID
      const order = await this.prisma.order.findFirst({
        where: { jtlOutboundId },
      });

      if (!order) {
        result.errors.push(`Order not found for outbound ${jtlOutboundId}`);
        return result;
      }

      result.orderId = order.id;

      // Map JTL status to No-Limits status
      const normalizedJtlStatus = jtlStatus.toLowerCase();
      const noLimitsStatus = JTL_TO_NOLIMITS_STATUS[normalizedJtlStatus] || 'PROCESSING';

      // Only update if status actually changed
      if (order.fulfillmentState === noLimitsStatus) {
        result.success = true;
        return result;
      }

      // Build update data
      const updateData: any = {
        fulfillmentState: noLimitsStatus,
        lastOperationalUpdateBy: 'JTL',
        lastOperationalUpdateAt: new Date(),
      };

      // Set specific timestamps based on status
      if (noLimitsStatus === 'SHIPPED' && !order.shippedAt) {
        updateData.shippedAt = new Date();
      }
      if (noLimitsStatus === 'DELIVERED' && !order.deliveredAt) {
        updateData.deliveredAt = new Date();
      }

      // Update order
      await this.prisma.order.update({
        where: { id: order.id },
        data: updateData,
      });

      // Log sync
      await this.prisma.orderSyncLog.create({
        data: {
          orderId: order.id,
          action: 'update',
          origin: 'JTL',
          targetPlatform: 'nolimits',
          success: true,
          changedFields: Object.keys(updateData),
        },
      });

      result.syncedTo.push('nolimits');
      result.success = true;
      return result;
    } catch (error: any) {
      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Poll JTL FFN for status updates and sync to local DB
   * Should be called periodically (e.g., every 5 minutes)
   */
  async pollJTLUpdates(): Promise<PollingResult> {
    const result: PollingResult = {
      processedCount: 0,
      errors: [],
      lastPollTime: new Date(),
    };

    if (this.isPolling) {
      console.log('[FulfillmentSync] Polling already in progress, skipping');
      return result;
    }

    this.isPolling = true;

    try {
      // Get all clients with JTL config
      const clients = await this.prisma.client.findMany({
        where: {
          jtlConfig: {
            isNot: null,
          },
        },
        include: {
          jtlConfig: true,
        },
      });

      for (const client of clients) {
        try {
          const jtlService = await this.getJTLService(client.id);
          if (!jtlService) continue;

          // Get last poll time for this client (use lastSyncAt instead of lastPollAt)
          const lastPoll = client.jtlConfig?.lastSyncAt || new Date(Date.now() - 24 * 60 * 60 * 1000);
          const since = lastPoll.toISOString();

          // Poll for updates
          const updates = await jtlService.pollOutboundChanges(since);

          if (!updates.success || !updates.updates) {
            result.errors.push(`Client ${client.id}: ${updates.error}`);
            continue;
          }

          // Process each update
          for (const update of updates.updates) {
            try {
              await this.syncStatusFromJTL(update.outboundId, update.currentStatus);

              // If shipped, also sync tracking
              if (update.currentStatus.toLowerCase() === 'shipped') {
                const order = await this.prisma.order.findFirst({
                  where: { jtlOutboundId: update.outboundId },
                });
                if (order) {
                  await this.syncTrackingFromJTL(order.id);
                }
              }

              result.processedCount++;
            } catch (error: any) {
              result.errors.push(`Update ${update.outboundId}: ${error.message}`);
            }
          }

          // Update last sync time
          if (client.jtlConfig) {
            await this.prisma.jtlConfig.update({
              where: { id: client.jtlConfig.id },
              data: { lastSyncAt: new Date() },
            });
          }
        } catch (error: any) {
          result.errors.push(`Client ${client.id}: ${error.message}`);
        }
      }

      console.log(`[FulfillmentSync] Polling completed. Processed: ${result.processedCount}, Errors: ${result.errors.length}`);
    } catch (error: any) {
      result.errors.push(`Polling failed: ${error.message}`);
    } finally {
      this.isPolling = false;
    }

    return result;
  }

  /**
   * Start automatic polling for JTL updates
   *
   * @param intervalMs - Polling interval in milliseconds (default: 5 minutes)
   */
  startPolling(intervalMs: number = 5 * 60 * 1000): void {
    if (this.pollInterval) {
      console.log('[FulfillmentSync] Polling already started');
      return;
    }

    console.log(`[FulfillmentSync] Starting polling with interval ${intervalMs}ms`);

    // Initial poll
    this.pollJTLUpdates().catch(console.error);

    // Set up interval
    this.pollInterval = setInterval(() => {
      this.pollJTLUpdates().catch(console.error);
    }, intervalMs);
  }

  /**
   * Stop automatic polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[FulfillmentSync] Polling stopped');
    }
  }

  /**
   * Sync order to all platforms (JTL + optionally Shopify)
   * Used when creating/updating orders from No-Limits
   */
  async syncOrderToAll(orderId: string): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      orderId,
      syncedTo: [],
      errors: [],
    };

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: { include: { product: true } },
          client: true,
        },
      });

      if (!order) {
        result.errors.push('Order not found');
        return result;
      }

      // Sync to JTL FFN
      if (order.clientId) {
        const jtlService = await this.getJTLService(order.clientId);
        if (jtlService) {
          if (!order.jtlOutboundId) {
            // Create new outbound
            const jtlResult = await jtlService.syncOrderToFfn(orderId, this.prisma);
            if (jtlResult.success) {
              result.syncedTo.push('jtl');
            } else {
              result.errors.push(`JTL: ${jtlResult.error}`);
            }
          } else {
            // Update existing outbound (limited fields)
            const updateResult = await jtlService.updateOrderOperationalFields(orderId, ['priority', 'warehouseNotes'], this.prisma);
            if (updateResult.success) {
              result.syncedTo.push('jtl');
            } else {
              result.errors.push(`JTL update: ${updateResult.error}`);
            }
          }
        }
      }

      // TODO: Sync to Shopify if needed (fulfillment status, tracking)
      // This would require implementing Shopify Fulfillment API calls

      result.success = result.errors.length === 0 || result.syncedTo.length > 0;
      return result;
    } catch (error: any) {
      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Get sync status for an order
   */
  async getOrderSyncStatus(orderId: string): Promise<{
    orderId: string;
    jtlSynced: boolean;
    jtlOutboundId: string | null;
    shopifySynced: boolean;
    shopifyFulfillmentId: string | null;
    lastSync: Date | null;
    syncErrors: string[];
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        jtlOutboundId: true,
        shopifyFulfillmentOrderId: true,
        lastJtlSync: true,
        lastSyncedToCommerce: true,
        ffnSyncError: true,
        commerceSyncError: true,
      },
    });

    if (!order) {
      throw new Error('Order not found');
    }

    const syncErrors: string[] = [];
    if (order.ffnSyncError) syncErrors.push(`JTL: ${order.ffnSyncError}`);
    if (order.commerceSyncError) syncErrors.push(`Commerce: ${order.commerceSyncError}`);

    return {
      orderId: order.id,
      jtlSynced: !!order.jtlOutboundId,
      jtlOutboundId: order.jtlOutboundId,
      shopifySynced: !!order.shopifyFulfillmentOrderId,
      shopifyFulfillmentId: order.shopifyFulfillmentOrderId,
      lastSync: order.lastJtlSync || order.lastSyncedToCommerce || null,
      syncErrors,
    };
  }
}

// Export singleton factory
let fulfillmentSyncService: FulfillmentSyncService | null = null;

export function getFulfillmentSyncService(prisma: PrismaClient): FulfillmentSyncService {
  if (!fulfillmentSyncService) {
    fulfillmentSyncService = new FulfillmentSyncService(prisma);
  }
  return fulfillmentSyncService;
}

export default FulfillmentSyncService;
