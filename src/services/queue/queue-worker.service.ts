/**
 * Queue Worker Service
 *
 * Wires up queue job handlers to actual sync services.
 * This service is responsible for processing background jobs for:
 * - Product sync (Shopify, WooCommerce, JTL)
 * - Order sync (FFN, commerce platforms)
 * - Return sync (commerce platforms, restock)
 *
 * Features:
 * - Proper error handling with retries
 * - Dead Letter Queue for failed jobs
 * - Metrics and monitoring
 * - Graceful shutdown
 */

import { PrismaClient } from '@prisma/client';
import {
    SyncQueueService,
    QUEUE_NAMES,
    ProductSyncJobData,
    OrderSyncJobData,
    ReturnSyncJobData,
    getQueue,
} from './sync-queue.service.js';
import { OrderSyncService } from '../integrations/order-sync.service.js';
import { ReturnSyncService } from '../integrations/return-sync.service.js';
import { JTLOrderSyncService } from '../integrations/jtl-order-sync.service.js';
import { ProductSyncService } from '../integrations/product-sync.service.js';

// ============= TYPES =============

interface JobResult {
    success: boolean;
    error?: string;
    details?: Record<string, unknown>;
}

// DLQ event for monitoring
interface DLQEvent {
    jobId: string;
    queueName: string;
    data: unknown;
    error: string;
    retryCount: number;
    timestamp: Date;
}

// ============= WORKER SERVICE =============

export class QueueWorkerService {
    private prisma: PrismaClient;
    private orderSyncService: OrderSyncService;
    private returnSyncService: ReturnSyncService;
    private jtlOrderSyncService: JTLOrderSyncService;
    private productSyncService: ProductSyncService;
    private dlqEvents: DLQEvent[] = [];
    private isInitialized: boolean = false;

    constructor(prisma: PrismaClient) {
        this.prisma = prisma;
        this.orderSyncService = new OrderSyncService(prisma);
        this.returnSyncService = new ReturnSyncService(prisma);
        this.jtlOrderSyncService = new JTLOrderSyncService(prisma);
        this.productSyncService = new ProductSyncService(prisma);
    }

    /**
     * Initialize all queue workers
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            console.log('[QueueWorker] Already initialized');
            return;
        }

        console.log('[QueueWorker] Initializing workers...');

        const queue = getQueue();

        // Register all workers
        await this.registerProductSyncWorkers(queue);
        await this.registerOrderSyncWorkers(queue);
        await this.registerReturnSyncWorkers(queue);

        this.isInitialized = true;
        console.log('[QueueWorker] All workers initialized');
    }

    // ============= PRODUCT SYNC WORKERS =============

    private async registerProductSyncWorkers(queue: SyncQueueService): Promise<void> {
        // Shopify product sync
        await queue.work<ProductSyncJobData>(
            QUEUE_NAMES.PRODUCT_SYNC_TO_SHOPIFY,
            async (job) => {
                const result = await this.handleProductSyncToShopify(job.data);
                if (!result.success) {
                    throw new Error(result.error);
                }
            },
            { batchSize: 5 }
        );

        // WooCommerce product sync
        await queue.work<ProductSyncJobData>(
            QUEUE_NAMES.PRODUCT_SYNC_TO_WOOCOMMERCE,
            async (job) => {
                const result = await this.handleProductSyncToWooCommerce(job.data);
                if (!result.success) {
                    throw new Error(result.error);
                }
            },
            { batchSize: 5 }
        );

        // JTL product sync
        await queue.work<ProductSyncJobData>(
            QUEUE_NAMES.PRODUCT_SYNC_TO_JTL,
            async (job) => {
                const result = await this.handleProductSyncToJTL(job.data);
                if (!result.success) {
                    throw new Error(result.error);
                }
            },
            { batchSize: 5 }
        );

        console.log('[QueueWorker] Product sync workers registered');
    }

    private async handleProductSyncToShopify(data: ProductSyncJobData): Promise<JobResult> {
        const { productId, channelId, fieldsToSync } = data;
        console.log(`[QueueWorker] Processing product sync to Shopify: ${productId}`);

        try {
            // Use ProductSyncService to push product to Shopify
            const result = await this.productSyncService.pushProductToAllPlatforms(
                productId,
                'nolimits',
                {
                    skipPlatforms: ['woocommerce', 'jtl'], // Only sync to Shopify
                    fieldsToSync: fieldsToSync,
                }
            );

            if (!result.success) {
                console.error(`[QueueWorker] Product sync to Shopify failed:`, result.error);
                return { success: false, error: result.error };
            }

            return {
                success: true,
                details: {
                    action: result.action,
                    externalIds: result.externalIds,
                    syncedPlatforms: result.syncedPlatforms,
                },
            };
        } catch (error: any) {
            console.error(`[QueueWorker] Product sync to Shopify failed:`, error);
            this.logDLQEvent('unknown', QUEUE_NAMES.PRODUCT_SYNC_TO_SHOPIFY, data, error.message, 0);
            return { success: false, error: error.message };
        }
    }

    private async handleProductSyncToWooCommerce(data: ProductSyncJobData): Promise<JobResult> {
        const { productId, channelId, fieldsToSync } = data;
        console.log(`[QueueWorker] Processing product sync to WooCommerce: ${productId}`);

        try {
            // Use ProductSyncService to push product to WooCommerce
            const result = await this.productSyncService.pushProductToAllPlatforms(
                productId,
                'nolimits',
                {
                    skipPlatforms: ['shopify', 'jtl'], // Only sync to WooCommerce
                    fieldsToSync: fieldsToSync,
                }
            );

            if (!result.success) {
                console.error(`[QueueWorker] Product sync to WooCommerce failed:`, result.error);
                return { success: false, error: result.error };
            }

            return {
                success: true,
                details: {
                    action: result.action,
                    externalIds: result.externalIds,
                    syncedPlatforms: result.syncedPlatforms,
                },
            };
        } catch (error: any) {
            console.error(`[QueueWorker] Product sync to WooCommerce failed:`, error);
            this.logDLQEvent('unknown', QUEUE_NAMES.PRODUCT_SYNC_TO_WOOCOMMERCE, data, error.message, 0);
            return { success: false, error: error.message };
        }
    }

    private async handleProductSyncToJTL(data: ProductSyncJobData): Promise<JobResult> {
        const { productId, fieldsToSync } = data;
        console.log(`[QueueWorker] Processing product sync to JTL: ${productId}`);

        try {
            // Use ProductSyncService to push product to JTL FFN
            const result = await this.productSyncService.pushProductToAllPlatforms(
                productId,
                'nolimits',
                {
                    skipPlatforms: ['shopify', 'woocommerce'], // Only sync to JTL
                    fieldsToSync: fieldsToSync,
                }
            );

            if (!result.success) {
                console.error(`[QueueWorker] Product sync to JTL failed:`, result.error);
                return { success: false, error: result.error };
            }

            return {
                success: true,
                details: {
                    action: result.action,
                    externalIds: result.externalIds,
                    syncedPlatforms: result.syncedPlatforms,
                },
            };
        } catch (error: any) {
            console.error(`[QueueWorker] Product sync to JTL failed:`, error);
            this.logDLQEvent('unknown', QUEUE_NAMES.PRODUCT_SYNC_TO_JTL, data, error.message, 0);
            return { success: false, error: error.message };
        }
    }

    // ============= ORDER SYNC WORKERS =============

    private async registerOrderSyncWorkers(queue: SyncQueueService): Promise<void> {
        // Order sync to FFN
        await queue.work<OrderSyncJobData>(
            QUEUE_NAMES.ORDER_SYNC_TO_FFN,
            async (job) => {
                const result = await this.handleOrderSyncToFFN(job.data);
                if (!result.success) {
                    throw new Error(result.error);
                }
            },
            { batchSize: 3 }
        );

        // Order sync to commerce platforms
        await queue.work<OrderSyncJobData>(
            QUEUE_NAMES.ORDER_SYNC_TO_COMMERCE,
            async (job) => {
                const result = await this.handleOrderSyncToCommerce(job.data);
                if (!result.success) {
                    throw new Error(result.error);
                }
            },
            { batchSize: 3 }
        );

        // Order cancellation sync
        await queue.work<OrderSyncJobData>(
            QUEUE_NAMES.ORDER_CANCEL_SYNC,
            async (job) => {
                const result = await this.handleOrderCancelSync(job.data);
                if (!result.success) {
                    throw new Error(result.error);
                }
            },
            { batchSize: 2 }
        );

        console.log('[QueueWorker] Order sync workers registered');
    }

    private async handleOrderSyncToFFN(data: OrderSyncJobData): Promise<JobResult> {
        const { orderId, operation } = data;
        const startTime = Date.now();
        console.log(`[QueueWorker] ========== FFN Sync Job Started ==========`);
        console.log(`[QueueWorker] Job details:`, { orderId, operation, timestamp: new Date().toISOString() });

        try {
            switch (operation) {
                case 'create':
                case 'update':
                    console.log(`[QueueWorker] Calling jtlOrderSyncService.syncOrderToFFN for ${orderId}...`);
                    const syncResult = await this.jtlOrderSyncService.syncOrderToFFN(orderId);
                    if (!syncResult.success) {
                        console.log(`[QueueWorker] FFN sync FAILED for ${orderId}: ${syncResult.error}`);
                        return { success: false, error: syncResult.error };
                    }
                    console.log(`[QueueWorker] FFN sync SUCCESS for ${orderId}, outboundId: ${syncResult.outboundId}`);
                    break;

                case 'cancel':
                    console.log(`[QueueWorker] Calling jtlOrderSyncService.cancelOrderInFFN for ${orderId}...`);
                    const cancelResult = await this.jtlOrderSyncService.cancelOrderInFFN(orderId);
                    if (!cancelResult.success) {
                        console.log(`[QueueWorker] FFN cancel FAILED for ${orderId}: ${cancelResult.error}`);
                        return { success: false, error: cancelResult.error };
                    }
                    console.log(`[QueueWorker] FFN cancel SUCCESS for ${orderId}`);
                    break;

                case 'fulfill':
                    // Fulfillment status comes FROM FFN, not TO FFN
                    console.log(`[QueueWorker] Fulfill operation not applicable for FFN sync`);
                    break;

                default:
                    console.log(`[QueueWorker] Unknown operation: ${operation}`);
                    return { success: false, error: `Unknown operation: ${operation}` };
            }

            const duration = Date.now() - startTime;
            console.log(`[QueueWorker] ========== FFN Sync Job Completed (${duration}ms) ==========`);
            return { success: true };
        } catch (error: any) {
            const duration = Date.now() - startTime;
            console.error(`[QueueWorker] ========== FFN Sync Job FAILED (${duration}ms) ==========`);
            console.error(`[QueueWorker] Error:`, { orderId, operation, error: error.message });
            this.logDLQEvent('unknown', QUEUE_NAMES.ORDER_SYNC_TO_FFN, data, error.message, 0);
            return { success: false, error: error.message };
        }
    }

    private async handleOrderSyncToCommerce(data: OrderSyncJobData): Promise<JobResult> {
        const { orderId, operation } = data;
        console.log(`[QueueWorker] Processing order sync to commerce: ${orderId} (${operation})`);

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

            // Sync operational fields to commerce platform
            const result = await this.orderSyncService.syncOperationalToCommerce(orderId, operation);

            if (!result.success) {
                return { success: false, error: result.error };
            }

            return { success: true };
        } catch (error: any) {
            console.error(`[QueueWorker] Order sync to commerce failed:`, error);
            this.logDLQEvent('unknown', QUEUE_NAMES.ORDER_SYNC_TO_COMMERCE, data, error.message, 0);
            return { success: false, error: error.message };
        }
    }

    private async handleOrderCancelSync(data: OrderSyncJobData): Promise<JobResult> {
        const { orderId } = data;
        console.log(`[QueueWorker] Processing order cancellation sync: ${orderId}`);

        try {
            // Cancel in FFN
            const ffnResult = await this.jtlOrderSyncService.cancelOrderInFFN(orderId, 'Order cancelled');
            if (!ffnResult.success) {
                console.warn(`[QueueWorker] FFN cancellation failed: ${ffnResult.error}`);
                // Continue to try commerce cancellation
            }

            // Cancel in commerce (update status)
            const commerceResult = await this.orderSyncService.syncOperationalToCommerce(orderId, 'cancel');
            if (!commerceResult.success) {
                console.warn(`[QueueWorker] Commerce cancellation failed: ${commerceResult.error}`);
            }

            return { success: true };
        } catch (error: any) {
            console.error(`[QueueWorker] Order cancel sync failed:`, error);
            this.logDLQEvent('unknown', QUEUE_NAMES.ORDER_CANCEL_SYNC, data, error.message, 0);
            return { success: false, error: error.message };
        }
    }

    // ============= RETURN SYNC WORKERS =============

    private async registerReturnSyncWorkers(queue: SyncQueueService): Promise<void> {
        // Return sync to commerce
        await queue.work<ReturnSyncJobData>(
            QUEUE_NAMES.RETURN_SYNC_TO_COMMERCE,
            async (job) => {
                const result = await this.handleReturnSyncToCommerce(job.data);
                if (!result.success) {
                    throw new Error(result.error);
                }
            },
            { batchSize: 2 }
        );

        // Return restock sync
        await queue.work<ReturnSyncJobData>(
            QUEUE_NAMES.RETURN_RESTOCK_SYNC,
            async (job) => {
                const result = await this.handleReturnRestockSync(job.data);
                if (!result.success) {
                    throw new Error(result.error);
                }
            },
            { batchSize: 2 }
        );

        console.log('[QueueWorker] Return sync workers registered');
    }

    private async handleReturnSyncToCommerce(data: ReturnSyncJobData): Promise<JobResult> {
        const { returnId, operation } = data;
        console.log(`[QueueWorker] Processing return sync to commerce: ${returnId} (${operation})`);

        try {
            const returnRecord = await this.prisma.return.findUnique({
                where: { id: returnId },
                include: {
                    order: { include: { channel: true } },
                    items: true,
                },
            });

            if (!returnRecord) {
                return { success: false, error: `Return ${returnId} not found` };
            }

            if (!returnRecord.order?.channel) {
                return { success: false, error: `Return ${returnId} has no associated channel` };
            }

            switch (operation) {
                case 'refund':
                    // Sync refund through ReturnSyncService
                    const refundResult = await this.returnSyncService.issueRefund({
                        returnId,
                        refundAmount: parseFloat(returnRecord.refundAmount?.toString() || '0'),
                        refundCurrency: returnRecord.order.currency || 'EUR',
                        reason: returnRecord.reason || undefined,
                        syncToCommerce: true,
                    });

                    if (!refundResult.success) {
                        return { success: false, error: refundResult.error || 'Failed to sync refund' };
                    }
                    break;

                case 'finalize':
                    // Final sync - update status
                    await this.prisma.return.update({
                        where: { id: returnId },
                        data: {
                            syncStatus: 'SYNCED',
                            lastSyncedToCommerce: new Date(),
                        },
                    });
                    break;

                default:
                    return { success: false, error: `Unknown operation: ${operation}` };
            }

            return { success: true };
        } catch (error: any) {
            console.error(`[QueueWorker] Return sync to commerce failed:`, error);
            this.logDLQEvent('unknown', QUEUE_NAMES.RETURN_SYNC_TO_COMMERCE, data, error.message, 0);
            return { success: false, error: error.message };
        }
    }

    private async handleReturnRestockSync(data: ReturnSyncJobData): Promise<JobResult> {
        const { returnId } = data;
        console.log(`[QueueWorker] Processing return restock sync: ${returnId}`);

        try {
            const returnRecord = await this.prisma.return.findUnique({
                where: { id: returnId },
                include: {
                    items: { include: { product: true } },
                },
            });

            if (!returnRecord) {
                return { success: false, error: `Return ${returnId} not found` };
            }

            if (!returnRecord.restockEligible) {
                console.log(`[QueueWorker] Return ${returnId} not eligible for restock`);
                return { success: true, details: { skipped: true, reason: 'Not eligible' } };
            }

            // Update stock for each restockable item
            for (const item of returnRecord.items) {
                if (!item.productId) continue;

                const restockQty = item.restockableQuantity || item.quantity;

                await this.prisma.product.update({
                    where: { id: item.productId },
                    data: {
                        available: { increment: restockQty },
                        lastUpdatedBy: 'NOLIMITS',
                        updatedAt: new Date(),
                    },
                });

                console.log(`[QueueWorker] Restocked ${restockQty} of product ${item.productId}`);
            }

            // Mark return as restock complete
            await this.prisma.return.update({
                where: { id: returnId },
                data: {
                    restockDecidedAt: new Date(),
                },
            });

            return { success: true };
        } catch (error: any) {
            console.error(`[QueueWorker] Return restock sync failed:`, error);
            this.logDLQEvent('unknown', QUEUE_NAMES.RETURN_RESTOCK_SYNC, data, error.message, 0);
            return { success: false, error: error.message };
        }
    }

    // ============= DLQ & MONITORING =============

    private logDLQEvent(
        jobId: string,
        queueName: string,
        data: unknown,
        error: string,
        retryCount: number
    ): void {
        const event: DLQEvent = {
            jobId,
            queueName,
            data,
            error,
            retryCount,
            timestamp: new Date(),
        };

        this.dlqEvents.push(event);

        // Keep only last 1000 events
        if (this.dlqEvents.length > 1000) {
            this.dlqEvents = this.dlqEvents.slice(-1000);
        }

        console.error('[QueueWorker] DLQ Event:', event);
    }

    /**
     * Get DLQ events for monitoring
     */
    getDLQEvents(queueName?: string): DLQEvent[] {
        if (queueName) {
            return this.dlqEvents.filter((e) => e.queueName === queueName);
        }
        return [...this.dlqEvents];
    }

    /**
     * Clear DLQ events
     */
    clearDLQEvents(queueName?: string): number {
        if (queueName) {
            const before = this.dlqEvents.length;
            this.dlqEvents = this.dlqEvents.filter((e) => e.queueName !== queueName);
            return before - this.dlqEvents.length;
        }
        const count = this.dlqEvents.length;
        this.dlqEvents = [];
        return count;
    }

    /**
     * Get worker statistics
     */
    async getStats(): Promise<{
        isInitialized: boolean;
        dlqEventCount: number;
        queues: Record<string, number>;
    }> {
        const queues: Record<string, number> = {};

        try {
            const queue = getQueue();
            const metrics = await queue.getMetrics();

            for (const q of metrics.queues) {
                queues[q.name] = q.created;
            }
        } catch (e) {
            // Queue not available
        }

        return {
            isInitialized: this.isInitialized,
            dlqEventCount: this.dlqEvents.length,
            queues,
        };
    }
}

// ============= SINGLETON =============

let workerInstance: QueueWorkerService | null = null;

export async function initializeQueueWorkers(prisma: PrismaClient): Promise<QueueWorkerService> {
    if (workerInstance) {
        return workerInstance;
    }

    workerInstance = new QueueWorkerService(prisma);
    await workerInstance.initialize();

    return workerInstance;
}

export function getQueueWorker(): QueueWorkerService {
    if (!workerInstance) {
        throw new Error('Queue workers not initialized. Call initializeQueueWorkers() first.');
    }
    return workerInstance;
}

export default QueueWorkerService;
