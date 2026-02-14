/**
 * Sync Scheduler Service
 * Manages scheduled sync jobs for all channels
 * Runs periodic sync between e-commerce platforms and JTL FFN
 */

import { PrismaClient, ChannelType } from '@prisma/client';
import { SyncOrchestrator } from './sync-orchestrator.js';
import { SyncResult } from './types.js';
import { getEncryptionService } from '../encryption.service.js';
import { JTLService } from './jtl.service.js';
import { StockSyncService } from './stock-sync.service.js';
import { notificationService } from '../notification.service.js';
import { Logger } from '../../utils/logger.js';
import { generateJobId } from '../../utils/job-id.js';
import { getQueue, QUEUE_NAMES, OrderSyncJobData } from '../queue/sync-queue.service.js';

interface SchedulerConfig {
  /**
   * Interval for incremental sync in minutes
   * Default: 5 minutes
   */
  incrementalSyncIntervalMinutes: number;

  /**
   * Interval for full sync in hours
   * Default: 24 hours
   */
  fullSyncIntervalHours: number;

  /**
   * Interval for polling JTL updates in minutes
   * Default: 2 minutes
   */
  jtlPollIntervalMinutes: number;

  /**
   * Maximum concurrent channel syncs
   * Default: 3
   */
  maxConcurrentSyncs: number;

  /**
   * Interval for proactive JTL token refresh in hours
   * Default: 12 hours
   */
  tokenRefreshIntervalHours: number;

  /**
   * Interval for stock sync from JTL FFN in minutes
   * Default: 15 minutes (safety net - inbound-triggered sync is faster)
   */
  stockSyncIntervalMinutes: number;

  /**
   * Interval for polling JTL inbounds for stock changes in minutes
   * Default: 2 minutes (same as JTL poll - for near real-time stock updates)
   */
  inboundPollIntervalMinutes: number;

  /**
   * Interval for pushing paid-but-unsynced orders to JTL FFN in minutes
   * Safety net for missed webhooks / failed queue jobs
   * Default: 10 minutes
   */
  paidOrderSyncIntervalMinutes: number;
}

interface ChannelSyncState {
  channelId: string;
  lastIncrementalSync?: Date;
  lastFullSync?: Date;
  lastJtlPoll?: Date;
  isRunning: boolean;
  lastError?: string;
}

interface SyncJobResult {
  channelId: string;
  success: boolean;
  productsResult?: SyncResult;
  ordersResult?: SyncResult;
  returnsResult?: SyncResult;
  jtlUpdatesResult?: SyncResult;
  error?: string;
  duration: number;
}

// Type for channel with JTL config
interface ChannelWithConfig {
  id: string;
  type: ChannelType;
  shopDomain?: string | null;
  accessToken?: string | null;
  apiUrl?: string | null;
  apiClientId?: string | null;
  apiClientSecret?: string | null;
  client: {
    id: string;
    companyName: string;
    jtlConfig?: {
      clientId: string;
      clientSecret: string;
      accessToken?: string | null;
      refreshToken?: string | null;
      warehouseId: string;
      fulfillerId: string;
      environment: string;
      clientId_fk: string;
    } | null;
  };
}

export class SyncScheduler {
  private prisma: PrismaClient;
  private config: SchedulerConfig;
  private channelStates: Map<string, ChannelSyncState> = new Map();
  private incrementalTimer?: NodeJS.Timeout;
  private fullSyncTimer?: NodeJS.Timeout;
  private jtlPollTimer?: NodeJS.Timeout;
  private tokenRefreshTimer?: NodeJS.Timeout;
  private stockSyncTimer?: NodeJS.Timeout;
  private inboundPollTimer?: NodeJS.Timeout;
  private commerceReconcileTimer?: NodeJS.Timeout;
  private paidOrderSyncTimer?: NodeJS.Timeout;
  private stockSyncService: StockSyncService;
  private isRunning = false;
  private logger = new Logger('SyncScheduler');

  private static readonly DEFAULT_CONFIG: SchedulerConfig = {
    incrementalSyncIntervalMinutes: 5,
    fullSyncIntervalHours: 24,
    jtlPollIntervalMinutes: 2,
    maxConcurrentSyncs: 3,
    tokenRefreshIntervalHours: 12,
    stockSyncIntervalMinutes: 15,
    inboundPollIntervalMinutes: 2,
    paidOrderSyncIntervalMinutes: 10,
  };

  constructor(prisma: PrismaClient, config?: Partial<SchedulerConfig>) {
    this.prisma = prisma;
    this.config = { ...SyncScheduler.DEFAULT_CONFIG, ...config };
    this.stockSyncService = new StockSyncService(prisma);
  }

  /**
   * Start the sync scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Sync scheduler is already running');
      return;
    }

    console.log('Starting sync scheduler...');
    this.isRunning = true;

    // Initialize channel states
    await this.initializeChannelStates();

    // Start timers
    this.startIncrementalSyncTimer();
    this.startFullSyncTimer();
    this.startJtlPollTimer();
    this.startTokenRefreshTimer();
    this.startStockSyncTimer();
    this.startInboundPollTimer();
    this.startCommerceReconcileTimer();
    this.startPaidOrderSyncTimer();

    console.log('Sync scheduler started successfully');
    console.log(`- Incremental sync: every ${this.config.incrementalSyncIntervalMinutes} minutes`);
    console.log(`- Full sync: every ${this.config.fullSyncIntervalHours} hours`);
    console.log(`- JTL polling: every ${this.config.jtlPollIntervalMinutes} minutes`);
    console.log(`- Token refresh: every ${this.config.tokenRefreshIntervalHours} hours`);
    console.log(`- Stock sync (safety net): every ${this.config.stockSyncIntervalMinutes} minutes`);
    console.log(`- Inbound poll (stock trigger): every ${this.config.inboundPollIntervalMinutes} minutes`);
    console.log(`- Commerce reconcile: every 30 minutes`);
    console.log(`- Paid order FFN sync: every ${this.config.paidOrderSyncIntervalMinutes} minutes`);
  }

  /**
   * Stop the sync scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      console.log('Sync scheduler is not running');
      return;
    }

    console.log('Stopping sync scheduler...');

    if (this.incrementalTimer) {
      clearInterval(this.incrementalTimer);
      this.incrementalTimer = undefined;
    }

    if (this.fullSyncTimer) {
      clearInterval(this.fullSyncTimer);
      this.fullSyncTimer = undefined;
    }

    if (this.jtlPollTimer) {
      clearInterval(this.jtlPollTimer);
      this.jtlPollTimer = undefined;
    }

    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    if (this.stockSyncTimer) {
      clearInterval(this.stockSyncTimer);
      this.stockSyncTimer = undefined;
    }

    if (this.inboundPollTimer) {
      clearInterval(this.inboundPollTimer);
      this.inboundPollTimer = undefined;
    }

    if (this.commerceReconcileTimer) {
      clearInterval(this.commerceReconcileTimer);
      this.commerceReconcileTimer = undefined;
    }

    if (this.paidOrderSyncTimer) {
      clearInterval(this.paidOrderSyncTimer);
      this.paidOrderSyncTimer = undefined;
    }

    this.isRunning = false;
    console.log('Sync scheduler stopped');
  }

  /**
   * Initialize channel states from database
   */
  private async initializeChannelStates(): Promise<void> {
    const channels = await this.prisma.channel.findMany({
      where: {
        isActive: true,
        syncEnabled: true,
        type: { in: ['SHOPIFY', 'WOOCOMMERCE'] },
      },
      include: {
        client: {
          include: {
            jtlConfig: true,
          },
        },
      },
    });

    for (const channel of channels) {
      this.channelStates.set(channel.id, {
        channelId: channel.id,
        lastIncrementalSync: (channel as any).lastOrderPollAt || undefined,
        isRunning: false,
      });
    }

    console.log(`Initialized ${channels.length} channels for sync`);
  }

  /**
   * Start incremental sync timer
   */
  private startIncrementalSyncTimer(): void {
    const intervalMs = this.config.incrementalSyncIntervalMinutes * 60 * 1000;
    
    // Run immediately on start
    this.runIncrementalSyncForAllChannels();

    this.incrementalTimer = setInterval(() => {
      this.runIncrementalSyncForAllChannels();
    }, intervalMs);
  }

  /**
   * Start full sync timer
   */
  private startFullSyncTimer(): void {
    const intervalMs = this.config.fullSyncIntervalHours * 60 * 60 * 1000;

    this.fullSyncTimer = setInterval(() => {
      this.runFullSyncForAllChannels();
    }, intervalMs);
  }

  /**
   * Start JTL polling timer
   */
  private startJtlPollTimer(): void {
    const intervalMs = this.config.jtlPollIntervalMinutes * 60 * 1000;

    // Run immediately on start
    this.pollJtlUpdatesForAllChannels();

    this.jtlPollTimer = setInterval(() => {
      this.pollJtlUpdatesForAllChannels();
    }, intervalMs);
  }

  /**
   * Start proactive JTL token refresh timer
   */
  private startTokenRefreshTimer(): void {
    const intervalMs = this.config.tokenRefreshIntervalHours * 60 * 60 * 1000;

    // Run once on startup
    this.refreshAllJTLTokens();

    this.tokenRefreshTimer = setInterval(() => {
      this.refreshAllJTLTokens();
    }, intervalMs);
  }

  /**
   * Start periodic stock sync timer (safety net)
   * This ensures stock is synced even if inbound polling misses updates
   */
  private startStockSyncTimer(): void {
    const intervalMs = this.config.stockSyncIntervalMinutes * 60 * 1000;

    // Run on startup after a short delay (let other services initialize)
    setTimeout(() => {
      this.runStockSyncForAllClients();
    }, 10000); // 10 second delay

    this.stockSyncTimer = setInterval(() => {
      this.runStockSyncForAllClients();
    }, intervalMs);
  }

  /**
   * Start inbound polling timer for event-driven stock sync
   * When inbounds close (goods received), immediately sync stock
   */
  private startInboundPollTimer(): void {
    const intervalMs = this.config.inboundPollIntervalMinutes * 60 * 1000;

    // Run on startup after a short delay
    setTimeout(() => {
      this.pollInboundsAndSyncStock();
    }, 15000); // 15 second delay

    this.inboundPollTimer = setInterval(() => {
      this.pollInboundsAndSyncStock();
    }, intervalMs);
  }

  /**
   * Start commerce reconciliation timer
   * Re-enqueues orders that are SHIPPED in DB but failed to sync to commerce platform
   */
  private startCommerceReconcileTimer(): void {
    const intervalMs = 30 * 60 * 1000; // 30 minutes

    // First run after 2 minute delay (let queue initialize)
    setTimeout(() => {
      this.reconcileFailedCommerceSyncs();
      this.reconcileStuckFulfillments();
    }, 2 * 60 * 1000);

    this.commerceReconcileTimer = setInterval(() => {
      this.reconcileFailedCommerceSyncs();
      this.reconcileStuckFulfillments();
    }, intervalMs);
  }

  /**
   * Start paid-but-unsynced order sweep timer
   * Safety net: catches orders that are paid but never pushed to JTL FFN
   * (e.g. missed webhooks, failed queue jobs, hold-release flow didn't fire)
   */
  private startPaidOrderSyncTimer(): void {
    const intervalMs = this.config.paidOrderSyncIntervalMinutes * 60 * 1000;

    // First run after 3 minute delay (let other services initialize)
    setTimeout(() => {
      this.pushPaidUnsyncedOrdersToFFN();
    }, 3 * 60 * 1000);

    this.paidOrderSyncTimer = setInterval(() => {
      this.pushPaidUnsyncedOrdersToFFN();
    }, intervalMs);
  }

  /**
   * Find paid orders that were never synced to JTL FFN and enqueue them.
   * Excludes replacement orders (must be synced manually via force).
   * Downstream syncOrderToFFN() re-validates payment status as defense-in-depth.
   */
  async pushPaidUnsyncedOrdersToFFN(): Promise<{ found: number; queued: number; skipped: number; errors: number }> {
    const jobId = generateJobId('paid-order-ffn-sync');
    const startTime = Date.now();
    const stats = { found: 0, queued: 0, skipped: 0, errors: 0 };

    const SAFE_PAYMENT_STATUSES = [
      'paid', 'completed', 'processing', 'refunded',
      'partially_refunded', 'authorized', 'partially_paid',
    ];

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'paidOrderFFNSync',
      type: 'safety_net',
    });

    try {
      // Find orders that are paid but never pushed to FFN
      const unsyncedOrders = await this.prisma.order.findMany({
        where: {
          jtlOutboundId: null,
          paymentStatus: { in: SAFE_PAYMENT_STATUSES },
          isReplacement: false,
          isCancelled: false,
          OR: [
            { isOnHold: false },
            { holdReason: { notIn: ['AWAITING_PAYMENT', 'SHIPPING_METHOD_MISMATCH'] } },
            { paymentHoldOverride: true },
          ],
          channel: {
            isActive: true,
            syncEnabled: true,
          },
        },
        select: {
          id: true,
          orderId: true,
          orderNumber: true,
          paymentStatus: true,
          clientId: true,
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });

      stats.found = unsyncedOrders.length;

      if (unsyncedOrders.length === 0) {
        this.logger.debug({
          jobId,
          event: 'job_completed',
          operation: 'paidOrderFFNSync',
          duration: Date.now() - startTime,
          ...stats,
        });
        return stats;
      }

      this.logger.info({
        jobId,
        event: 'paid_unsynced_orders_found',
        count: unsyncedOrders.length,
        orders: unsyncedOrders.map(o => o.orderNumber || o.orderId),
      });

      const queue = getQueue();

      for (const order of unsyncedOrders) {
        try {
          const enqueuedJobId = await queue.enqueue<OrderSyncJobData>(
            QUEUE_NAMES.ORDER_SYNC_TO_FFN,
            {
              orderId: order.id,
              origin: 'nolimits',
              operation: 'create',
            },
            {
              singletonKey: `ffn-sync-${order.id}`,
              retryLimit: 3,
              retryDelay: 60,
              retryBackoff: true,
              expireInSeconds: 3600,
              priority: -1, // Lower priority than real-time webhook-driven jobs
            }
          );

          if (enqueuedJobId) {
            stats.queued++;
            this.logger.debug({
              jobId,
              event: 'order_enqueued_for_ffn',
              orderId: order.id,
              orderNumber: order.orderNumber,
              paymentStatus: order.paymentStatus,
              pgBossJobId: enqueuedJobId,
            });
          } else {
            stats.skipped++; // singletonKey duplicate — job already active
          }
        } catch (enqueueError) {
          stats.errors++;
          this.logger.warn({
            jobId,
            event: 'order_enqueue_failed',
            orderId: order.id,
            orderNumber: order.orderNumber,
            error: enqueueError instanceof Error ? enqueueError.message : 'Unknown error',
          });
        }
      }

      this.logger.info({
        jobId,
        event: 'job_completed',
        operation: 'paidOrderFFNSync',
        duration: Date.now() - startTime,
        ...stats,
      });

      // Track per-client cron job status
      const clientGroups = new Map<string, { found: number; queued: number; skipped: number }>();
      for (const order of unsyncedOrders) {
        if (!clientGroups.has(order.clientId)) {
          clientGroups.set(order.clientId, { found: 0, queued: 0, skipped: 0 });
        }
        clientGroups.get(order.clientId)!.found++;
      }
      const duration = Date.now() - startTime;
      for (const [clientId, clientStats] of clientGroups) {
        await this.updateCronJobStatus('paidOrderFFNSync', clientId, {
          success: true,
          duration,
          details: clientStats,
        });
      }
      // If no orders found, update for all clients with active channels
      if (unsyncedOrders.length === 0) {
        const activeClients = await this.prisma.channel.findMany({
          where: { isActive: true, syncEnabled: true },
          select: { clientId: true },
          distinct: ['clientId'],
        });
        for (const { clientId } of activeClients) {
          await this.updateCronJobStatus('paidOrderFFNSync', clientId, {
            success: true,
            duration,
            details: { found: 0, queued: 0, skipped: 0 },
          });
        }
      }
    } catch (error) {
      this.logger.error({
        jobId,
        event: 'job_failed',
        operation: 'paidOrderFFNSync',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    return stats;
  }

  /**
   * Reconcile stuck fulfillments — orders SHIPPED in FFN but missing Shopify Fulfillment GID.
   * Uses JTLOrderSyncService.reconcileStuckFulfillments() per client.
   */
  async reconcileStuckFulfillments(): Promise<void> {
    const jobId = generateJobId('stuck-fulfillment-reconcile');
    const startTime = Date.now();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'stuckFulfillmentReconcile',
    });

    try {
      // Get distinct client IDs with active Shopify channels
      const channels = await this.prisma.channel.findMany({
        where: {
          isActive: true,
          syncEnabled: true,
          type: 'SHOPIFY',
        },
        select: {
          clientId: true,
        },
        distinct: ['clientId'],
      });

      const clientIds = channels.map(c => c.clientId);
      let totalFound = 0;
      let totalQueued = 0;

      for (const clientId of clientIds) {
        const clientStart = Date.now();
        try {
          const JTLOrderSyncService = (await import('./jtl-order-sync.service.js')).default;
          const syncService = new JTLOrderSyncService(this.prisma);
          const result = await syncService.reconcileStuckFulfillments(clientId);
          totalFound += result.found;
          totalQueued += result.queued;

          await this.updateCronJobStatus('stuckFulfillmentReconcile', clientId, {
            success: true,
            duration: Date.now() - clientStart,
            details: { found: result.found, queued: result.queued },
          });
        } catch (err) {
          this.logger.warn({
            jobId,
            event: 'client_reconcile_failed',
            clientId,
            error: err instanceof Error ? err.message : 'Unknown error',
          });

          await this.updateCronJobStatus('stuckFulfillmentReconcile', clientId, {
            success: false,
            duration: Date.now() - clientStart,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      this.logger.info({
        jobId,
        event: 'job_completed',
        operation: 'stuckFulfillmentReconcile',
        duration: Date.now() - startTime,
        clientsProcessed: clientIds.length,
        totalFound,
        totalQueued,
      });
    } catch (error) {
      this.logger.error({
        jobId,
        event: 'job_failed',
        operation: 'stuckFulfillmentReconcile',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Reconcile orders that are SHIPPED but failed to sync to commerce
   * Catches orders where pg-boss retries were exhausted or errors occurred before this fix
   */
  async reconcileFailedCommerceSyncs(): Promise<void> {
    const jobId = generateJobId('commerce-reconcile');
    const startTime = Date.now();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'commerceReconcile',
      type: 'stuck_order_sweep',
    });

    try {
      // Find orders that are shipped but never synced to commerce
      const stuckOrders = await this.prisma.order.findMany({
        where: {
          fulfillmentState: 'SHIPPED',
          commerceSyncError: { not: null },
          lastSyncedToCommerce: null,
          channelId: { not: null },
        },
        select: {
          id: true,
          orderId: true,
          orderNumber: true,
          commerceSyncError: true,
          clientId: true,
        },
        take: 20, // Batch limit to keep load light
        orderBy: { updatedAt: 'asc' }, // Oldest first
      });

      if (stuckOrders.length === 0) {
        this.logger.debug({
          jobId,
          event: 'job_completed',
          operation: 'commerceReconcile',
          duration: Date.now() - startTime,
          stuckOrders: 0,
        });
        return;
      }

      this.logger.info({
        jobId,
        event: 'stuck_orders_found',
        count: stuckOrders.length,
        orders: stuckOrders.map(o => o.orderNumber || o.orderId),
      });

      let enqueued = 0;
      let skipped = 0;

      const queue = getQueue();

      for (const order of stuckOrders) {
        try {
          const enqueuedJobId = await queue.enqueue<OrderSyncJobData>(
            QUEUE_NAMES.ORDER_SYNC_TO_COMMERCE,
            {
              orderId: order.id,
              origin: 'nolimits',
              operation: 'fulfill',
            },
            {
              singletonKey: `commerce-fulfill-${order.id}`,
              retryLimit: 5,
              retryDelay: 30,
              retryBackoff: true,
              expireInSeconds: 7200,
              priority: -1, // Lower priority than real-time jobs
            }
          );

          if (enqueuedJobId) {
            enqueued++;
            this.logger.debug({
              jobId,
              event: 'order_re_enqueued',
              orderId: order.id,
              orderNumber: order.orderNumber,
              previousError: order.commerceSyncError,
              pgBossJobId: enqueuedJobId,
            });
          } else {
            skipped++; // singletonKey duplicate — job already active
          }
        } catch (enqueueError) {
          this.logger.warn({
            jobId,
            event: 'order_re_enqueue_failed',
            orderId: order.id,
            error: enqueueError instanceof Error ? enqueueError.message : 'Unknown error',
          });
        }
      }

      this.logger.info({
        jobId,
        event: 'job_completed',
        operation: 'commerceReconcile',
        duration: Date.now() - startTime,
        stuckOrders: stuckOrders.length,
        enqueued,
        skipped,
      });

      // Track per-client status — group stuck orders by clientId
      const clientGroups = new Map<string, number>();
      for (const order of stuckOrders) {
        clientGroups.set(order.clientId, (clientGroups.get(order.clientId) || 0) + 1);
      }
      const duration = Date.now() - startTime;
      for (const [clientId, count] of clientGroups) {
        await this.updateCronJobStatus('commerceReconcile', clientId, {
          success: true,
          duration,
          details: { stuckOrders: count, enqueued, skipped },
        });
      }
    } catch (error) {
      this.logger.error({
        jobId,
        event: 'job_failed',
        operation: 'commerceReconcile',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Run stock sync for all clients (periodic safety net)
   */
  async runStockSyncForAllClients(): Promise<void> {
    const jobId = generateJobId('stock-sync');
    const startTime = Date.now();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'stockSync',
      type: 'periodic_safety_net'
    });

    try {
      const result = await this.stockSyncService.syncStockForAllClients();

      const duration = Date.now() - startTime;
      this.logger.info({
        jobId,
        event: 'job_completed',
        operation: 'stockSync',
        duration,
        clientsProcessed: result.clientsProcessed,
        productsUpdated: result.totalProductsUpdated,
        productsFailed: result.totalProductsFailed
      });

      // Track per-client cron job status
      for (const [clientId, clientResult] of result.results) {
        await this.updateCronJobStatus('stockSync', clientId, {
          success: clientResult.success,
          duration,
          details: {
            productsUpdated: clientResult.productsUpdated,
            productsUnchanged: clientResult.productsUnchanged,
            productsFailed: clientResult.productsFailed,
          },
          error: clientResult.errors.length > 0 ? clientResult.errors[0] : undefined,
        });
      }
    } catch (error) {
      this.logger.error({
        jobId,
        event: 'job_failed',
        operation: 'stockSync',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  /**
   * Poll inbounds and sync stock when inbounds close
   */
  async pollInboundsAndSyncStock(): Promise<void> {
    const jobId = generateJobId('inbound-poll');
    const startTime = Date.now();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'inboundPoll',
      type: 'stock_change_detection'
    });

    try {
      const result = await this.stockSyncService.pollInboundsAndSyncForAllClients();

      const duration = Date.now() - startTime;
      this.logger.info({
        jobId,
        event: 'job_completed',
        operation: 'inboundPoll',
        duration,
        clientsProcessed: result.clientsProcessed,
        inboundsProcessed: result.totalInboundsProcessed,
        stockSyncsTriggered: result.stockSyncsTriggered
      });

      // Track aggregate status for all active JTL clients
      const activeClients = await this.prisma.client.findMany({
        where: { jtlConfig: { isActive: true } },
        select: { id: true },
      });
      for (const { id: clientId } of activeClients) {
        await this.updateCronJobStatus('inboundPoll', clientId, {
          success: true,
          duration,
          details: {
            clientsProcessed: result.clientsProcessed,
            inboundsProcessed: result.totalInboundsProcessed,
            stockSyncsTriggered: result.stockSyncsTriggered,
          },
        });
      }
    } catch (error) {
      this.logger.error({
        jobId,
        event: 'job_failed',
        operation: 'inboundPoll',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  }

  /**
   * Manually trigger stock sync for a specific client
   */
  async triggerStockSyncForClient(clientId: string): Promise<{
    success: boolean;
    productsUpdated: number;
    errors: string[];
  }> {
    const jobId = generateJobId('stock-sync-manual');
    const startTime = Date.now();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'manualStockSync',
      clientId,
      type: 'manual_trigger'
    });

    try {
      const result = await this.stockSyncService.syncStockForClient(clientId);

      this.logger.info({
        jobId,
        event: 'job_completed',
        operation: 'manualStockSync',
        clientId,
        duration: Date.now() - startTime,
        success: result.success,
        productsUpdated: result.productsUpdated,
        errorCount: result.errors.length
      });

      return {
        success: result.success,
        productsUpdated: result.productsUpdated,
        errors: result.errors,
      };
    } catch (error) {
      this.logger.error({
        jobId,
        event: 'job_failed',
        operation: 'manualStockSync',
        clientId,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });

      return {
        success: false,
        productsUpdated: 0,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }
  }

  /**
   * Proactively refresh all JTL tokens to prevent expiration
   */
  async refreshAllJTLTokens(): Promise<void> {
    const jobId = generateJobId('token-refresh');
    const startTime = Date.now();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'tokenRefresh',
      type: 'proactive'
    });

    const configs = await this.prisma.jtlConfig.findMany({
      where: { isActive: true },
    });

    if (configs.length === 0) {
      this.logger.warn({
        jobId,
        event: 'no_configs_found',
        operation: 'tokenRefresh'
      });
      return;
    }

    this.logger.debug({
      jobId,
      event: 'configs_found',
      configCount: configs.length
    });

    const encryptionService = getEncryptionService();
    let success = 0;
    let failed = 0;
    const skipped: string[] = [];

    for (const config of configs) {
      try {
        // Skip if no refresh token (can't refresh)
        if (!config.refreshToken) {
          this.logger.warn({
            jobId,
            event: 'client_skipped',
            clientId: config.clientId_fk,
            reason: 'no_refresh_token'
          });
          skipped.push(config.clientId_fk);
          continue;
        }

        this.logger.debug({
          jobId,
          event: 'token_refresh_started',
          clientId: config.clientId_fk
        });

        const jtlService = new JTLService({
          clientId: config.clientId,
          clientSecret: encryptionService.safeDecrypt(config.clientSecret),
          accessToken: config.accessToken ? encryptionService.safeDecrypt(config.accessToken) : undefined,
          refreshToken: encryptionService.safeDecrypt(config.refreshToken),
          tokenExpiresAt: config.tokenExpiresAt ?? undefined,
          environment: config.environment as 'sandbox' | 'production',
          fulfillerId: config.fulfillerId,
          warehouseId: config.warehouseId,
        }, this.prisma, config.clientId_fk);

        await jtlService.refreshAndPersistToken(config.clientId_fk, this.prisma);

        this.logger.debug({
          jobId,
          event: 'token_refresh_success',
          clientId: config.clientId_fk
        });
        success++;

        await this.updateCronJobStatus('tokenRefresh', config.clientId_fk, {
          success: true,
          duration: Date.now() - startTime,
        });
      } catch (error) {
        this.logger.error({
          jobId,
          event: 'token_refresh_failed',
          clientId: config.clientId_fk,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined
        });
        failed++;

        // Notify the client about refresh failure
        try {
          const client = await this.prisma.client.findUnique({
            where: { id: config.clientId_fk },
            select: { companyName: true },
          });
          await notificationService.createSyncErrorNotification({
            clientId: config.clientId_fk,
            clientName: client?.companyName || config.clientId_fk,
            errorType: 'JTL',
            errorMessage: `JTL token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}. Sync may stop soon if not resolved.`,
          });
        } catch { /* don't let notification failure break the refresh loop */ }

        await this.updateCronJobStatus('tokenRefresh', config.clientId_fk, {
          success: false,
          duration: Date.now() - startTime,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.info({
      jobId,
      event: 'job_completed',
      operation: 'tokenRefresh',
      duration: Date.now() - startTime,
      totalConfigs: configs.length,
      success,
      failed,
      skipped: skipped.length
    });
  }

  /**
   * Refresh channel states — adds new channels, removes deactivated ones
   * Called before each polling cycle to handle channels onboarded/deactivated after startup
   */
  private async refreshChannelStates(): Promise<void> {
    const activeChannels = await this.getActiveChannels();
    const activeIds = new Set(activeChannels.map(c => c.id));

    // Add new channels that aren't tracked yet
    for (const channel of activeChannels) {
      if (!this.channelStates.has(channel.id)) {
        this.channelStates.set(channel.id, {
          channelId: channel.id,
          lastIncrementalSync: (channel as any).lastOrderPollAt || undefined,
          isRunning: false,
        });
        this.logger.info({
          event: 'channel_added',
          channelId: channel.id,
          channelType: channel.type,
        });
      }
    }

    // Remove deactivated channels from state map
    for (const [channelId, state] of this.channelStates) {
      if (!activeIds.has(channelId) && !state.isRunning) {
        this.channelStates.delete(channelId);
        this.logger.info({
          event: 'channel_removed',
          channelId,
        });
      }
    }
  }

  /**
   * Run incremental sync for all channels
   */
  async runIncrementalSyncForAllChannels(): Promise<SyncJobResult[]> {
    const jobId = generateJobId('sync-inc');
    const startTime = Date.now();

    // Refresh channel list to pick up new/deactivated channels
    await this.refreshChannelStates();

    const channels = await this.getActiveChannels();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'incrementalSync',
      channelCount: channels.length
    });

    const results: SyncJobResult[] = [];

    // Process channels in batches
    const batches = this.chunkArray(channels, this.config.maxConcurrentSyncs);

    for (let i = 0; i < batches.length; i++) {
      const batchResults = await Promise.all(
        batches[i].map(channel => this.runIncrementalSyncForChannel(channel, jobId))
      );
      results.push(...batchResults);

      // Rate limit: 2s delay between batches to avoid hammering APIs
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    const successCount = results.filter(r => r.success).length;
    const totalProducts = results.reduce((sum, r) => sum + (r.productsResult?.itemsProcessed || 0), 0);
    const totalOrders = results.reduce((sum, r) => sum + (r.ordersResult?.itemsProcessed || 0), 0);
    const totalReturns = results.reduce((sum, r) => sum + (r.returnsResult?.itemsProcessed || 0), 0);

    this.logger.info({
      jobId,
      event: 'job_completed',
      operation: 'incrementalSync',
      duration: Date.now() - startTime,
      channelsProcessed: results.length,
      channelsSuccess: successCount,
      channelsFailed: results.length - successCount,
      totalProducts,
      totalOrders,
      totalReturns
    });

    return results;
  }

  /**
   * Run full sync for all channels
   */
  async runFullSyncForAllChannels(): Promise<SyncJobResult[]> {
    const jobId = generateJobId('sync-full');
    const startTime = Date.now();

    const channels = await this.getActiveChannels();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'fullSync',
      channelCount: channels.length
    });

    const results: SyncJobResult[] = [];

    const batches = this.chunkArray(channels, this.config.maxConcurrentSyncs);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(channel => this.runFullSyncForChannel(channel, jobId))
      );
      results.push(...batchResults);
    }

    const successCount = results.filter(r => r.success).length;
    const totalProducts = results.reduce((sum, r) => sum + (r.productsResult?.itemsProcessed || 0), 0);
    const totalOrders = results.reduce((sum, r) => sum + (r.ordersResult?.itemsProcessed || 0), 0);
    const totalReturns = results.reduce((sum, r) => sum + (r.returnsResult?.itemsProcessed || 0), 0);

    this.logger.info({
      jobId,
      event: 'job_completed',
      operation: 'fullSync',
      duration: Date.now() - startTime,
      channelsProcessed: results.length,
      channelsSuccess: successCount,
      channelsFailed: results.length - successCount,
      totalProducts,
      totalOrders,
      totalReturns
    });

    return results;
  }

  /**
   * Poll JTL updates for all channels
   */
  async pollJtlUpdatesForAllChannels(): Promise<SyncJobResult[]> {
    const jobId = generateJobId('jtl-poll');
    const startTime = Date.now();

    const channels = await this.getActiveChannels();

    this.logger.debug({
      jobId,
      event: 'job_started',
      operation: 'jtlPoll',
      channelCount: channels.length
    });

    const results: SyncJobResult[] = [];

    const batches = this.chunkArray(channels, this.config.maxConcurrentSyncs);

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(channel => this.pollJtlUpdatesForChannel(channel, jobId))
      );
      results.push(...batchResults);
    }

    const successCount = results.filter(r => r.success).length;
    const totalItemsProcessed = results.reduce((sum, r) => sum + (r.jtlUpdatesResult?.itemsProcessed || 0), 0);

    this.logger.info({
      jobId,
      event: 'job_completed',
      operation: 'jtlPoll',
      duration: Date.now() - startTime,
      channelsProcessed: results.length,
      channelsSuccess: successCount,
      channelsFailed: results.length - successCount,
      totalItemsProcessed
    });

    return results;
  }

  /**
   * Run incremental sync for a single channel
   */
  private async runIncrementalSyncForChannel(channel: ChannelWithConfig, parentJobId?: string): Promise<SyncJobResult> {
    const startTime = Date.now();
    const jobId = parentJobId || generateJobId('sync-inc-channel');
    const state = this.channelStates.get(channel.id);

    this.logger.debug({
      jobId,
      event: 'channel_sync_started',
      operation: 'incrementalSync',
      channelId: channel.id,
      channelType: channel.type
    });

    if (!state) {
      this.logger.warn({
        jobId,
        event: 'channel_sync_failed',
        channelId: channel.id,
        error: 'Channel state not found'
      });

      return {
        channelId: channel.id,
        success: false,
        error: 'Channel state not found',
        duration: 0,
      };
    }

    // Skip channels with revoked JTL tokens until re-authorized
    if (state.lastError === 'JTL_TOKEN_REVOKED') {
      this.logger.debug({
        jobId,
        event: 'channel_sync_skipped',
        channelId: channel.id,
        reason: 'jtl_token_revoked'
      });

      return {
        channelId: channel.id,
        success: false,
        error: 'JTL token revoked — skipping until re-authorized',
        duration: 0,
      };
    }

    if (state.isRunning) {
      this.logger.warn({
        jobId,
        event: 'channel_sync_skipped',
        channelId: channel.id,
        reason: 'sync_already_in_progress'
      });

      return {
        channelId: channel.id,
        success: false,
        error: 'Sync already in progress',
        duration: 0,
      };
    }

    state.isRunning = true;

    try {
      const orchestrator = this.createOrchestrator(channel);

      if (!orchestrator) {
        throw new Error('Could not create sync orchestrator - missing credentials');
      }

      // Apply 10-minute overlap window to avoid missing data at cursor boundaries
      const OVERLAP_WINDOW_MS = 10 * 60 * 1000;
      const rawSince = state.lastIncrementalSync || new Date(Date.now() - 24 * 60 * 60 * 1000); // Default to 24h ago
      const since = new Date(rawSince.getTime() - OVERLAP_WINDOW_MS);

      this.logger.debug({
        jobId,
        event: 'sync_execution_started',
        channelId: channel.id,
        since: since.toISOString(),
        rawCursor: rawSince.toISOString()
      });

      const result = await orchestrator.runIncrementalSync(since);

      state.lastIncrementalSync = new Date();
      state.lastError = undefined;

      // Persist cursors to DB for restart resilience
      try {
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: {
            lastOrderPollAt: state.lastIncrementalSync,
            lastProductPollAt: state.lastIncrementalSync,
          },
        });
      } catch (persistError) {
        this.logger.warn({
          jobId,
          event: 'cursor_persist_failed',
          channelId: channel.id,
          error: persistError instanceof Error ? persistError.message : 'Unknown error',
        });
      }

      this.logger.debug({
        jobId,
        event: 'channel_sync_completed',
        operation: 'incrementalSync',
        channelId: channel.id,
        duration: Date.now() - startTime,
        productsProcessed: result.products?.itemsProcessed || 0,
        ordersProcessed: result.orders?.itemsProcessed || 0,
        returnsProcessed: result.returns?.itemsProcessed || 0
      });

      return {
        channelId: channel.id,
        success: true,
        productsResult: result.products,
        ordersResult: result.orders,
        returnsResult: result.returns,
        jtlUpdatesResult: result.jtlOutboundUpdates,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Detect token revocation to prevent hammering a broken token
      if (errorMessage.includes('refresh token is invalid') ||
          errorMessage.includes('Token has been revoked') ||
          errorMessage.includes('invalid_request')) {
        state.lastError = 'JTL_TOKEN_REVOKED';
        this.logger.warn({
          jobId,
          event: 'channel_disabled_token_revoked',
          channelId: channel.id,
          duration: Date.now() - startTime,
          error: errorMessage
        });

        // Persist revocation to DB so it survives server restarts
        try {
          if (channel.client.jtlConfig?.clientId_fk) {
            await this.prisma.jtlConfig.update({
              where: { clientId_fk: channel.client.jtlConfig.clientId_fk },
              data: { isActive: false },
            });
          }
        } catch { /* don't let DB update failure break error handling */ }

        // Notify the client about token revocation
        try {
          await notificationService.createSyncErrorNotification({
            clientId: channel.client.id,
            clientName: channel.client.companyName,
            errorType: 'JTL',
            errorMessage: 'JTL refresh token expired or revoked. All fulfillment sync is stopped. Please re-authorize JTL in Settings → Integrations.',
          });
        } catch { /* don't let notification failure break error handling */ }
      } else {
        state.lastError = errorMessage;
        this.logger.error({
          jobId,
          event: 'channel_sync_failed',
          operation: 'incrementalSync',
          channelId: channel.id,
          duration: Date.now() - startTime,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined
        });
      }

      return {
        channelId: channel.id,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    } finally {
      state.isRunning = false;
    }
  }

  /**
   * Run full sync for a single channel
   */
  private async runFullSyncForChannel(channel: ChannelWithConfig, parentJobId?: string): Promise<SyncJobResult> {
    const startTime = Date.now();
    const jobId = parentJobId || generateJobId('sync-full-channel');
    const state = this.channelStates.get(channel.id);

    this.logger.debug({
      jobId,
      event: 'channel_sync_started',
      operation: 'fullSync',
      channelId: channel.id,
      channelType: channel.type
    });

    if (!state) {
      this.logger.warn({
        jobId,
        event: 'channel_sync_failed',
        channelId: channel.id,
        error: 'Channel state not found'
      });

      return {
        channelId: channel.id,
        success: false,
        error: 'Channel state not found',
        duration: 0,
      };
    }

    if (state.isRunning) {
      this.logger.warn({
        jobId,
        event: 'channel_sync_skipped',
        channelId: channel.id,
        reason: 'sync_already_in_progress'
      });

      return {
        channelId: channel.id,
        success: false,
        error: 'Sync already in progress',
        duration: 0,
      };
    }

    state.isRunning = true;

    try {
      const orchestrator = this.createOrchestrator(channel);

      if (!orchestrator) {
        throw new Error('Could not create sync orchestrator - missing credentials');
      }

      this.logger.debug({
        jobId,
        event: 'sync_execution_started',
        channelId: channel.id
      });

      const result = await orchestrator.runFullSync();

      state.lastFullSync = new Date();
      state.lastError = undefined;

      this.logger.debug({
        jobId,
        event: 'channel_sync_completed',
        operation: 'fullSync',
        channelId: channel.id,
        duration: Date.now() - startTime,
        productsProcessed: result.products?.itemsProcessed || 0,
        ordersProcessed: result.orders?.itemsProcessed || 0,
        returnsProcessed: result.returns?.itemsProcessed || 0
      });

      return {
        channelId: channel.id,
        success: true,
        productsResult: result.products,
        ordersResult: result.orders,
        returnsResult: result.returns,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      state.lastError = errorMessage;

      this.logger.error({
        jobId,
        event: 'channel_sync_failed',
        operation: 'fullSync',
        channelId: channel.id,
        duration: Date.now() - startTime,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      });

      return {
        channelId: channel.id,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    } finally {
      state.isRunning = false;
    }
  }

  /**
   * Poll JTL updates for a single channel
   */
  private async pollJtlUpdatesForChannel(channel: ChannelWithConfig, parentJobId?: string): Promise<SyncJobResult> {
    const startTime = Date.now();
    const jobId = parentJobId || generateJobId('jtl-poll-channel');
    const state = this.channelStates.get(channel.id);

    this.logger.debug({
      jobId,
      event: 'channel_poll_started',
      operation: 'jtlPoll',
      channelId: channel.id,
      channelType: channel.type
    });

    if (!state) {
      this.logger.warn({
        jobId,
        event: 'channel_poll_failed',
        channelId: channel.id,
        error: 'Channel state not found'
      });

      return {
        channelId: channel.id,
        success: false,
        error: 'Channel state not found',
        duration: 0,
      };
    }

    try {
      const orchestrator = this.createOrchestrator(channel);

      if (!orchestrator) {
        throw new Error('Could not create sync orchestrator - missing credentials');
      }

      const since = state.lastJtlPoll || new Date(Date.now() - 60 * 60 * 1000); // Default to 1h ago

      this.logger.debug({
        jobId,
        event: 'poll_execution_started',
        channelId: channel.id,
        since: since.toISOString()
      });

      const outboundResult = await orchestrator.pollJTLOutboundUpdates(since);
      const returnResult = await orchestrator.pollJTLReturnUpdates(since);

      state.lastJtlPoll = new Date();

      this.logger.debug({
        jobId,
        event: 'channel_poll_completed',
        operation: 'jtlPoll',
        channelId: channel.id,
        duration: Date.now() - startTime,
        outboundItemsProcessed: outboundResult.itemsProcessed,
        returnItemsProcessed: returnResult.itemsProcessed,
        totalItemsProcessed: outboundResult.itemsProcessed + returnResult.itemsProcessed
      });

      return {
        channelId: channel.id,
        success: true,
        jtlUpdatesResult: {
          success: outboundResult.success && returnResult.success,
          syncedAt: new Date(),
          itemsProcessed: outboundResult.itemsProcessed + returnResult.itemsProcessed,
          itemsFailed: outboundResult.itemsFailed + returnResult.itemsFailed,
        },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.logger.error({
        jobId,
        event: 'channel_poll_failed',
        operation: 'jtlPoll',
        channelId: channel.id,
        duration: Date.now() - startTime,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined
      });

      return {
        channelId: channel.id,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Get all active channels with their configurations
   */
  private async getActiveChannels(): Promise<ChannelWithConfig[]> {
    return this.prisma.channel.findMany({
      where: {
        isActive: true,
        syncEnabled: true,
        type: { in: ['SHOPIFY', 'WOOCOMMERCE'] },
      },
      include: {
        client: {
          include: {
            jtlConfig: true,
          },
        },
      },
    }) as unknown as Promise<ChannelWithConfig[]>;
  }

  /**
   * Create a sync orchestrator for a channel
   */
  private createOrchestrator(channel: ChannelWithConfig): SyncOrchestrator | null {
    const jtlConfig = channel.client.jtlConfig;

    if (!jtlConfig) {
      console.warn(`[Scheduler] No JTL config for channel ${channel.id}`);
      return null;
    }

    // Get encryption service for decrypting channel credentials
    const encryptionService = getEncryptionService();

    // Build config based on channel type
    if (channel.type === 'SHOPIFY') {
      if (!channel.shopDomain || !channel.accessToken) {
        console.warn(`[Scheduler] Missing Shopify credentials for channel ${channel.id}`);
        return null;
      }

      return new SyncOrchestrator(this.prisma, {
        channelId: channel.id,
        channelType: 'SHOPIFY',
        shopifyCredentials: {
          shopDomain: channel.shopDomain,
          accessToken: encryptionService.safeDecrypt(channel.accessToken),
        },
        jtlCredentials: {
          clientId: jtlConfig.clientId,
          clientSecret: jtlConfig.clientSecret,
          accessToken: jtlConfig.accessToken || undefined,
          refreshToken: jtlConfig.refreshToken || undefined,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        },
        jtlWarehouseId: jtlConfig.warehouseId,
        jtlFulfillerId: jtlConfig.fulfillerId,
      });
    } else if (channel.type === 'WOOCOMMERCE') {
      if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
        console.warn(`[Scheduler] Missing WooCommerce credentials for channel ${channel.id}`);
        return null;
      }

      return new SyncOrchestrator(this.prisma, {
        channelId: channel.id,
        channelType: 'WOOCOMMERCE',
        wooCommerceCredentials: {
          url: channel.apiUrl,
          consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
          consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
        },
        jtlCredentials: {
          clientId: jtlConfig.clientId,
          clientSecret: jtlConfig.clientSecret,
          accessToken: jtlConfig.accessToken || undefined,
          refreshToken: jtlConfig.refreshToken || undefined,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        },
        jtlWarehouseId: jtlConfig.warehouseId,
        jtlFulfillerId: jtlConfig.fulfillerId,
      });
    }

    return null;
  }

  /**
   * Manually trigger sync for a specific channel
   */
  async triggerSyncForChannel(channelId: string, fullSync = false): Promise<SyncJobResult> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      include: {
        client: {
          include: {
            jtlConfig: true,
          },
        },
      },
    });

    if (!channel) {
      return {
        channelId,
        success: false,
        error: 'Channel not found',
        duration: 0,
      };
    }

    if (fullSync) {
      return this.runFullSyncForChannel(channel);
    } else {
      return this.runIncrementalSyncForChannel(channel);
    }
  }

  /**
   * Get sync status for all channels
   */
  getSyncStatus(): ChannelSyncState[] {
    return Array.from(this.channelStates.values());
  }

  /**
   * Get sync status for a specific channel
   */
  getChannelSyncStatus(channelId: string): ChannelSyncState | undefined {
    return this.channelStates.get(channelId);
  }

  /**
   * Persist the latest run status of a cron job per client.
   * Uses upsert on @@unique([clientId, jobName]) — always stores only the most recent run.
   */
  private async updateCronJobStatus(jobName: string, clientId: string, result: {
    success: boolean;
    duration: number;
    details?: Record<string, unknown>;
    error?: string;
  }): Promise<void> {
    try {
      await this.prisma.cronJobStatus.upsert({
        where: { clientId_jobName: { clientId, jobName } },
        create: {
          clientId,
          jobName,
          lastRunAt: new Date(),
          success: result.success,
          duration: result.duration,
          details: result.details || undefined,
          error: result.error || null,
        },
        update: {
          lastRunAt: new Date(),
          success: result.success,
          duration: result.duration,
          details: result.details || undefined,
          error: result.error || null,
        },
      });
    } catch { /* don't let status tracking break the actual job */ }
  }

  /**
   * Helper to chunk array into batches
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

export default SyncScheduler;
