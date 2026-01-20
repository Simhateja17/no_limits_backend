/**
 * Sync Queue Processor
 * 
 * Background job processor for async product sync operations.
 * Processes queued sync jobs and handles retries with exponential backoff.
 * 
 * Features:
 * - Batch processing with configurable concurrency
 * - Exponential backoff for failed jobs
 * - Dead letter queue for permanently failed jobs
 * - Metrics and monitoring
 */

import { PrismaClient, SyncOrigin } from '@prisma/client';
import { ProductSyncService } from './product-sync.service.js';
import { JTLService } from './jtl.service.js';
import { getEncryptionService } from '../encryption.service.js';

// ============= TYPES =============

export interface QueueProcessorOptions {
  batchSize: number;
  pollIntervalMs: number;
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
}

export interface ProcessorMetrics {
  jobsProcessed: number;
  jobsFailed: number;
  jobsSkipped: number;
  avgProcessingTimeMs: number;
  lastRunAt: Date | null;
  isRunning: boolean;
}

// ============= SERVICE =============

export class SyncQueueProcessor {
  private prisma: PrismaClient;
  private productSyncService: ProductSyncService;
  private options: QueueProcessorOptions;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private metrics: ProcessorMetrics = {
    jobsProcessed: 0,
    jobsFailed: 0,
    jobsSkipped: 0,
    avgProcessingTimeMs: 0,
    lastRunAt: null,
    isRunning: false,
  };

  constructor(prisma: PrismaClient, options: Partial<QueueProcessorOptions> = {}) {
    this.prisma = prisma;
    this.productSyncService = new ProductSyncService(prisma);
    this.options = {
      batchSize: options.batchSize || 10,
      pollIntervalMs: options.pollIntervalMs || 5000, // 5 seconds
      maxRetries: options.maxRetries || 3,
      retryDelayMs: options.retryDelayMs || 60000, // 1 minute
      retryBackoffMultiplier: options.retryBackoffMultiplier || 2,
    };
  }

  /**
   * Start the queue processor
   */
  start(): void {
    if (this.isRunning) {
      console.log('[SyncQueueProcessor] Already running');
      return;
    }

    console.log('[SyncQueueProcessor] Starting...');
    this.isRunning = true;
    this.metrics.isRunning = true;

    // Initial run
    this.processQueue();

    // Schedule periodic runs
    this.intervalId = setInterval(() => {
      this.processQueue();
    }, this.options.pollIntervalMs);
  }

  /**
   * Stop the queue processor
   */
  stop(): void {
    console.log('[SyncQueueProcessor] Stopping...');
    this.isRunning = false;
    this.metrics.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): ProcessorMetrics {
    return { ...this.metrics };
  }

  /**
   * Process a batch of queued jobs
   */
  private async processQueue(): Promise<void> {
    if (!this.isRunning) return;

    const startTime = Date.now();

    try {
      // Get pending jobs
      const jobs = await this.prisma.productSyncQueue.findMany({
        where: {
          status: 'pending',
          scheduledFor: { lte: new Date() },
          attempts: { lt: this.options.maxRetries },
        },
        orderBy: [
          { priority: 'desc' },
          { scheduledFor: 'asc' },
        ],
        take: this.options.batchSize,
        include: {
          product: {
            include: {
              channels: {
                include: { channel: true },
              },
              client: {
                include: { jtlConfig: true },
              },
            },
          },
        },
      });

      if (jobs.length === 0) return;

      console.log(`[SyncQueueProcessor] Processing ${jobs.length} jobs`);

      for (const job of jobs) {
        await this.processJob(job);
      }

      // Process order queue
      const orderJobs = await this.prisma.orderSyncQueue.findMany({
        where: {
          status: 'pending',
          scheduledFor: { lte: new Date() },
          attempts: { lt: this.options.maxRetries },
        },
        orderBy: [
          { priority: 'desc' },
          { scheduledFor: 'asc' },
        ],
        take: this.options.batchSize,
        include: {
          order: {
            include: {
              items: {
                include: {
                  product: true,
                },
              },
              client: {
                include: { jtlConfig: true },
              },
              channel: true,
            },
          },
        },
      });

      if (orderJobs.length > 0) {
        console.log(`[SyncQueueProcessor] Processing ${orderJobs.length} order jobs`);
        for (const orderJob of orderJobs) {
          await this.processOrderJob(orderJob);
        }
      }

      this.metrics.lastRunAt = new Date();
      const processingTime = Date.now() - startTime;
      this.updateAvgProcessingTime(processingTime);

    } catch (error) {
      console.error('[SyncQueueProcessor] Queue processing error:', error);
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: {
    id: string;
    productId: string;
    operation: string;
    triggerOrigin: SyncOrigin;
    channelId: string | null;
    attempts: number;
    product: {
      id: string;
      name: string;
      sku: string;
      channels: Array<{
        id: string;
        channelId: string;
        externalProductId: string | null;
        channel: {
          id: string;
          type: string;
          shopDomain: string | null;
          accessToken: string | null;
          apiUrl: string | null;
          apiClientId: string | null;
          apiClientSecret: string | null;
        };
      }>;
      client: {
        jtlConfig: {
          clientId: string;
          clientSecret: string;
          accessToken: string | null;
          refreshToken: string | null;
          tokenExpiresAt: Date | null;
          fulfillerId: string;
          warehouseId: string;
          environment: string;
        } | null;
      };
    };
  }): Promise<void> {
    const jobStartTime = Date.now();

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

      // Execute the operation
      let success = false;
      let error: string | undefined;

      switch (job.operation) {
        case 'push_to_shopify':
          ({ success, error } = await this.pushToShopify(job));
          break;
        case 'push_to_woocommerce':
          ({ success, error } = await this.pushToWooCommerce(job));
          break;
        case 'push_to_jtl':
          ({ success, error } = await this.pushToJTL(job));
          break;
        case 'sync_all':
          ({ success, error } = await this.syncToAllPlatforms(job));
          break;
        default:
          error = `Unknown operation: ${job.operation}`;
      }

      if (success) {
        // Mark as completed
        await this.prisma.productSyncQueue.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
          },
        });
        this.metrics.jobsProcessed++;
        console.log(`[SyncQueueProcessor] Job ${job.id} completed successfully`);
      } else {
        throw new Error(error || 'Unknown error');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[SyncQueueProcessor] Job ${job.id} failed:`, errorMessage);

      // Calculate retry delay with exponential backoff
      const retryDelay = this.options.retryDelayMs * 
        Math.pow(this.options.retryBackoffMultiplier, job.attempts);

      // Mark as failed or pending retry
      const newStatus = job.attempts >= this.options.maxRetries - 1 ? 'failed' : 'pending';
      
      await this.prisma.productSyncQueue.update({
        where: { id: job.id },
        data: {
          status: newStatus,
          lastError: errorMessage,
          scheduledFor: newStatus === 'pending' 
            ? new Date(Date.now() + retryDelay) 
            : undefined,
        },
      });

      if (newStatus === 'failed') {
        this.metrics.jobsFailed++;
        // Log to product sync log for visibility
        await this.prisma.productSyncLog.create({
          data: {
            productId: job.productId,
            action: 'failed',
            origin: job.triggerOrigin,
            targetPlatform: job.operation.replace('push_to_', ''),
            changedFields: [],
            success: false,
            errorMessage,
          },
        });
      }
    }
  }

  /**
   * Process a single order sync job
   */
  private async processOrderJob(job: any): Promise<void> {
    const jobStartTime = Date.now();

    try {
      // Mark as processing
      await this.prisma.orderSyncQueue.update({
        where: { id: job.id },
        data: {
          status: 'processing',
          startedAt: new Date(),
          attempts: { increment: 1 },
        },
      });

      // Execute the operation
      let success = false;
      let error: string | undefined;

      if (job.operation === 'push_to_jtl') {
        ({ success, error } = await this.pushOrderToJTL(job));
      } else {
        error = `Unknown operation: ${job.operation}`;
      }

      if (success) {
        // Mark as completed
        await this.prisma.orderSyncQueue.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
          },
        });
        this.metrics.jobsProcessed++;
        console.log(`[OrderQueue] Job ${job.id} completed successfully`);
      } else {
        throw new Error(error || 'Unknown error');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[OrderQueue] Job ${job.id} failed:`, errorMessage);

      // Calculate retry delay
      const retryDelay = this.options.retryDelayMs *
        Math.pow(this.options.retryBackoffMultiplier, job.attempts);

      const newStatus = job.attempts >= this.options.maxRetries - 1 ? 'failed' : 'pending';

      await this.prisma.orderSyncQueue.update({
        where: { id: job.id },
        data: {
          status: newStatus,
          lastError: errorMessage,
          scheduledFor: newStatus === 'pending'
            ? new Date(Date.now() + retryDelay)
            : undefined,
        },
      });

      if (newStatus === 'failed') {
        this.metrics.jobsFailed++;
        // Log to order sync log
        await this.prisma.orderSyncLog.create({
          data: {
            orderId: job.orderId,
            action: 'failed',
            origin: job.triggerOrigin,
            targetPlatform: 'jtl',
            changedFields: [],
            success: false,
            errorMessage,
          },
        });
      }
    }
  }

  /**
   * Push product to Shopify
   */
  private async pushToShopify(job: {
    productId: string;
    channelId: string | null;
    triggerOrigin: SyncOrigin;
    product: {
      channels: Array<{
        channelId: string;
        channel: { type: string };
      }>;
    };
  }): Promise<{ success: boolean; error?: string }> {
    const targetChannel = job.channelId 
      ? job.product.channels.find(c => c.channelId === job.channelId)
      : job.product.channels.find(c => c.channel.type === 'SHOPIFY');

    if (!targetChannel) {
      return { success: false, error: 'Shopify channel not found' };
    }

    const result = await this.productSyncService.pushProductToAllPlatforms(
      job.productId,
      this.mapEnumToOrigin(job.triggerOrigin),
      { skipPlatforms: ['woocommerce', 'jtl'] }
    );

    return {
      success: result.success,
      error: result.error,
    };
  }

  /**
   * Push product to WooCommerce
   */
  private async pushToWooCommerce(job: {
    productId: string;
    channelId: string | null;
    triggerOrigin: SyncOrigin;
    product: {
      channels: Array<{
        channelId: string;
        channel: { type: string };
      }>;
    };
  }): Promise<{ success: boolean; error?: string }> {
    const targetChannel = job.channelId
      ? job.product.channels.find(c => c.channelId === job.channelId)
      : job.product.channels.find(c => c.channel.type === 'WOOCOMMERCE');

    if (!targetChannel) {
      return { success: false, error: 'WooCommerce channel not found' };
    }

    const result = await this.productSyncService.pushProductToAllPlatforms(
      job.productId,
      this.mapEnumToOrigin(job.triggerOrigin),
      { skipPlatforms: ['shopify', 'jtl'] }
    );

    return {
      success: result.success,
      error: result.error,
    };
  }

  /**
   * Push product to JTL-FFN
   */
  private async pushToJTL(job: {
    productId: string;
    triggerOrigin: SyncOrigin;
    product: {
      client: {
        jtlConfig: {
          clientId: string;
          clientSecret: string;
          accessToken: string | null;
        } | null;
      };
    };
  }): Promise<{ success: boolean; error?: string }> {
    if (!job.product.client.jtlConfig?.accessToken) {
      return { success: false, error: 'JTL not configured or authenticated' };
    }

    const result = await this.productSyncService.pushProductToAllPlatforms(
      job.productId,
      this.mapEnumToOrigin(job.triggerOrigin),
      { skipPlatforms: ['shopify', 'woocommerce'] }
    );

    return {
      success: result.success,
      error: result.error,
    };
  }

  /**
   * Push order to JTL FFN as outbound
   */
  private async pushOrderToJTL(job: any): Promise<{ success: boolean; error?: string }> {
    try {
      const order = job.order;
      const jtlConfig = order.client.jtlConfig;

      if (!jtlConfig || !jtlConfig.accessToken) {
        return { success: false, error: 'JTL not configured or authenticated' };
      }

      // Initialize JTL service
      const encryptionService = getEncryptionService();
      const jtlService = new JTLService({
        clientId: jtlConfig.clientId,
        clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
        accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
        refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
        tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
        fulfillerId: jtlConfig.fulfillerId,
        warehouseId: jtlConfig.warehouseId,
        environment: jtlConfig.environment as 'sandbox' | 'production',
      }, this.prisma, jtlConfig.clientId_fk);

      // Transform order to JTL outbound format
      const outboundItems = order.items.map((item: any) => ({
        outboundItemId: item.id,
        merchantSku: item.sku || item.product?.sku || `ITEM-${item.id}`,
        name: item.productName || item.product?.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice ? parseFloat(item.unitPrice.toString()) : undefined,
      }));

      const jtlOutbound = {
        merchantOutboundNumber: order.externalOrderId || order.orderId,
        warehouseId: jtlConfig.warehouseId,
        currency: order.currency || 'EUR',
        shippingAddress: {
          firstname: order.shippingFirstName || undefined,
          lastname: order.shippingLastName || 'Unknown',
          company: order.shippingCompany || undefined,
          street: order.shippingAddress1 || 'No address provided',
          addition: order.shippingAddress2 || undefined,
          city: order.shippingCity || 'Unknown',
          zip: order.shippingZip || '',
          country: (order.shippingCountryCode || order.shippingCountry || 'DE').substring(0, 2).toUpperCase(),
          email: order.customerEmail || undefined,
          phone: order.customerPhone || undefined,
        },
        items: outboundItems,
        externalNumber: order.orderNumber || order.orderId,
        orderValue: order.total ? parseFloat(order.total.toString()) : undefined,
        shippingFee: order.shippingCost ? parseFloat(order.shippingCost.toString()) : undefined,
        salesChannel: order.channel?.type || 'Unknown',
        desiredDeliveryDate: order.orderDate?.toISOString() || new Date().toISOString(),
        shippingType: 'Standard' as const,
        note: order.notes || null,
        attributes: [
          { key: 'platform', value: order.channel?.type || 'unknown' },
          { key: 'externalOrderId', value: order.externalOrderId || '' },
        ],
      };

      console.log('[OrderQueue] Pushing order to JTL:', {
        orderId: order.id,
        merchantOutboundNumber: jtlOutbound.merchantOutboundNumber,
        itemCount: outboundItems.length,
      });

      const result = await jtlService.createOutbound(jtlOutbound);

      // Update order with JTL outbound ID
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          jtlOutboundId: result.outboundId,
          lastJtlSync: new Date(),
          syncStatus: 'SYNCED',
        },
      });

      console.log('[OrderQueue] Order pushed to JTL successfully:', {
        orderId: order.id,
        jtlOutboundId: result.outboundId,
      });

      return { success: true };
    } catch (error) {
      console.error('[OrderQueue] Failed to push order to JTL:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Sync product to all platforms
   */
  private async syncToAllPlatforms(job: {
    productId: string;
    triggerOrigin: SyncOrigin;
  }): Promise<{ success: boolean; error?: string }> {
    const result = await this.productSyncService.pushProductToAllPlatforms(
      job.productId,
      this.mapEnumToOrigin(job.triggerOrigin)
    );

    return {
      success: result.success,
      error: result.error,
    };
  }

  /**
   * Map SyncOrigin enum to string
   */
  private mapEnumToOrigin(origin: SyncOrigin): 'shopify' | 'woocommerce' | 'nolimits' | 'jtl' | 'system' {
    switch (origin) {
      case 'SHOPIFY': return 'shopify';
      case 'WOOCOMMERCE': return 'woocommerce';
      case 'JTL': return 'jtl';
      case 'SYSTEM': return 'system';
      default: return 'nolimits';
    }
  }

  /**
   * Update average processing time metric
   */
  private updateAvgProcessingTime(newTime: number): void {
    const totalJobs = this.metrics.jobsProcessed + this.metrics.jobsFailed + 1;
    this.metrics.avgProcessingTimeMs = 
      (this.metrics.avgProcessingTimeMs * (totalJobs - 1) + newTime) / totalJobs;
  }

  // ============= MANUAL OPERATIONS =============

  /**
   * Queue a product for sync to all platforms
   */
  async queueProductSync(
    productId: string,
    origin: SyncOrigin = 'NOLIMITS',
    priority: number = 0
  ): Promise<string[]> {
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

    if (!product) {
      throw new Error('Product not found');
    }

    const jobIds: string[] = [];

    // Queue for each channel
    for (const pc of product.channels) {
      const operation = pc.channel.type === 'SHOPIFY' 
        ? 'push_to_shopify' 
        : 'push_to_woocommerce';

      const job = await this.prisma.productSyncQueue.create({
        data: {
          productId,
          operation,
          triggerOrigin: origin,
          channelId: pc.channelId,
          priority,
          status: 'pending',
          scheduledFor: new Date(),
        },
      });
      jobIds.push(job.id);
    }

    // Queue for JTL if configured
    if (product.client.jtlConfig) {
      const job = await this.prisma.productSyncQueue.create({
        data: {
          productId,
          operation: 'push_to_jtl',
          triggerOrigin: origin,
          priority,
          status: 'pending',
          scheduledFor: new Date(),
        },
      });
      jobIds.push(job.id);
    }

    return jobIds;
  }

  /**
   * Queue an order for sync to JTL FFN
   */
  async queueOrderSync(
    orderId: string,
    origin: SyncOrigin = 'NOLIMITS',
    priority: number = 0
  ): Promise<string | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        client: {
          include: { jtlConfig: true },
        },
      },
    });

    if (!order) {
      throw new Error('Order not found');
    }

    // Only queue for JTL if configured
    if (!order.client.jtlConfig) {
      console.log(`[OrderQueue] Client ${order.clientId} has no JTL config, skipping order sync`);
      return null;
    }

    const job = await this.prisma.orderSyncQueue.create({
      data: {
        orderId,
        operation: 'push_to_jtl',
        triggerOrigin: origin,
        priority,
        status: 'pending',
        scheduledFor: new Date(),
      },
    });

    return job.id;
  }

  /**
   * Retry all failed jobs for a product
   */
  async retryFailedJobs(productId: string): Promise<number> {
    const result = await this.prisma.productSyncQueue.updateMany({
      where: {
        productId,
        status: 'failed',
      },
      data: {
        status: 'pending',
        attempts: 0,
        lastError: null,
        scheduledFor: new Date(),
      },
    });

    return result.count;
  }

  /**
   * Get queue status for a product
   */
  async getProductQueueStatus(productId: string): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    jobs: Array<{
      id: string;
      operation: string;
      status: string;
      attempts: number;
      lastError: string | null;
      scheduledFor: Date;
    }>;
  }> {
    const jobs = await this.prisma.productSyncQueue.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const counts = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    for (const job of jobs) {
      if (job.status in counts) {
        counts[job.status as keyof typeof counts]++;
      }
    }

    return {
      ...counts,
      jobs: jobs.map(j => ({
        id: j.id,
        operation: j.operation,
        status: j.status,
        attempts: j.attempts,
        lastError: j.lastError,
        scheduledFor: j.scheduledFor,
      })),
    };
  }

  /**
   * Clean up old completed jobs
   */
  async cleanupOldJobs(daysOld: number = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.prisma.productSyncQueue.deleteMany({
      where: {
        status: { in: ['completed', 'skipped'] },
        completedAt: { lt: cutoffDate },
      },
    });

    console.log(`[SyncQueueProcessor] Cleaned up ${result.count} old jobs`);
    return result.count;
  }
}

// ============= JTL POLLING SERVICE =============

/**
 * Polls JTL-FFN for product and stock updates
 * JTL doesn't support webhooks, so we poll for changes
 */
export class JTLPollingService {
  private prisma: PrismaClient;
  private productSyncService: ProductSyncService;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;

  constructor(prisma: PrismaClient, pollIntervalMs: number = 2 * 60 * 1000) {
    this.prisma = prisma;
    this.productSyncService = new ProductSyncService(prisma);
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start polling
   */
  start(): void {
    if (this.isRunning) return;

    console.log('[JTLPollingService] Starting...');
    this.isRunning = true;

    // Initial poll
    this.pollAllClients();

    // Schedule periodic polls
    this.intervalId = setInterval(() => {
      this.pollAllClients();
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    console.log('[JTLPollingService] Stopping...');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Poll JTL for all configured clients
   */
  private async pollAllClients(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // Get all clients with JTL config
      const configs = await this.prisma.jtlConfig.findMany({
        where: {
          isActive: true,
          accessToken: { not: null },
        },
        include: {
          client: true,
        },
      });

      for (const config of configs) {
        await this.pollClientJTL(config);
      }
    } catch (error) {
      console.error('[JTLPollingService] Polling error:', error);
    }
  }

  /**
   * Poll JTL for a specific client
   */
  private async pollClientJTL(config: {
    id: string;
    clientId: string;
    clientSecret: string;
    accessToken: string | null;
    refreshToken: string | null;
    tokenExpiresAt: Date | null;
    fulfillerId: string;
    warehouseId: string;
    environment: string;
    lastSyncAt: Date | null;
    clientId_fk: string;
  }): Promise<void> {
    if (!config.accessToken) return;

    const encryptionService = getEncryptionService();
    
    try {
      const jtlService = new JTLService({
        clientId: config.clientId,
        clientSecret: encryptionService.decrypt(config.clientSecret),
        accessToken: encryptionService.decrypt(config.accessToken),
        refreshToken: config.refreshToken ? encryptionService.decrypt(config.refreshToken) : undefined,
        tokenExpiresAt: config.tokenExpiresAt || undefined,
        fulfillerId: config.fulfillerId,
        warehouseId: config.warehouseId,
        environment: config.environment as 'sandbox' | 'production',
      }, this.prisma, config.clientId_fk);

      // Get stock level updates
      const stockLevels = await jtlService.getStockLevels({
        warehouseId: config.warehouseId,
      });

      // Update our products with JTL stock levels
      for (const stock of stockLevels) {
        const product = await this.prisma.product.findFirst({
          where: {
            clientId: config.clientId_fk,
            jtlProductId: stock.jfsku,
          },
        });

        if (product && product.available !== stock.available) {
          console.log(`[JTLPollingService] Updating stock for ${product.sku}: ${product.available} -> ${stock.available}`);
          
          await this.prisma.product.update({
            where: { id: product.id },
            data: {
              available: stock.available,
              reserved: stock.reserved,
              lastUpdatedBy: 'JTL',
              lastJtlSync: new Date(),
            },
          });

          // Queue sync to commerce platforms
          await this.productSyncService.queueSyncToOtherPlatforms(
            product.id,
            'jtl'
          );
        }
      }

      // Update last sync time
      await this.prisma.jtlConfig.update({
        where: { id: config.id },
        data: { lastSyncAt: new Date() },
      });

    } catch (error: any) {
      // Handle specific error types gracefully
      const errorMessage = error.message || String(error);

      // Check for authentication errors (invalid/revoked tokens)
      if (errorMessage.includes('invalid_request') ||
          errorMessage.includes('refresh token is invalid') ||
          errorMessage.includes('Token has been revoked')) {
        console.warn(`[JTLPollingService] JTL OAuth token expired/revoked for client ${config.clientId_fk}. Disabling polling.`);

        // Mark config as inactive to stop polling
        await this.prisma.jtlConfig.update({
          where: { id: config.id },
          data: { isActive: false },
        }).catch(() => {});

      // Check for decryption errors (wrong encryption key or corrupted data)
      } else if (errorMessage.includes('Unsupported state') ||
                 errorMessage.includes('unable to authenticate data')) {
        console.warn(`[JTLPollingService] JTL credentials decryption failed for client ${config.clientId_fk}. Likely test/demo account.`);

        // Mark config as inactive for demo accounts
        await this.prisma.jtlConfig.update({
          where: { id: config.id },
          data: { isActive: false },
        }).catch(() => {});

      } else {
        // Log other errors normally
        console.error(`[JTLPollingService] Error polling JTL for client ${config.clientId_fk}:`, error);
      }
    }
  }
}
