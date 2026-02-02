/**
 * JTL Order Sync Service
 *
 * Handles synchronization of orders between No-Limits and JTL-FFN
 *
 * Key responsibilities:
 * - Create outbound orders in FFN from Shopify/WooCommerce orders
 * - Cancel orders in FFN when cancelled in platform
 * - Create fulfillment orders for split orders
 * - Poll FFN for order status updates
 * - Sync fulfillment/tracking info back to commerce platforms
 */

import { PrismaClient, Order, SyncOrigin, FulfillmentState, Prisma } from '@prisma/client';
import { JTLService } from './jtl.service.js';
import { JTLOutbound } from './types.js';
import { getEncryptionService } from '../encryption.service.js';
import { SyncLogger } from '../../utils/sync-logger.js';
import { createShopifyServiceAuto } from './shopify-service-factory.js';
import { WooCommerceService } from './woocommerce.service.js';

// ============= TYPES =============

interface JTLOrderItem {
    merchantSku: string;
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
}

interface FFNOutboundUpdate {
    outboundId: string;
    status: string;
    trackingNumber?: string;
    carrier?: string;
    shippedAt?: string;
    deliveredAt?: string;
    items?: Array<{
        merchantSku: string;
        quantityShipped: number;
    }>;
}

export interface FetchOrdersStats {
    ordersFoundInChannel: number;
    newOrdersCreated: number;
    ordersAlreadyExisted: number;
    ordersLinkedToFFN: number;
    ordersPushedToFFN: number;
    errors: number;
}

// ============= SERVICE =============

export class JTLOrderSyncService {
    private syncLogger = new SyncLogger('JTL-FFN-SYNC');

    constructor(private prisma: PrismaClient) { }

    /**
     * Get JTL Service for a client
     */
    private async getJTLService(clientId: string): Promise<JTLService | null> {
        const jtlConfig = await this.prisma.jtlConfig.findUnique({
            where: { clientId_fk: clientId },
        });

        if (!jtlConfig || !jtlConfig.isActive) {
            return null;
        }

        const encryptionService = getEncryptionService();

        return new JTLService({
            clientId: jtlConfig.clientId,
            clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
            fulfillerId: jtlConfig.fulfillerId,
            warehouseId: jtlConfig.warehouseId,
            environment: jtlConfig.environment as 'sandbox' | 'production',
            accessToken: jtlConfig.accessToken ? encryptionService.safeDecrypt(jtlConfig.accessToken) : undefined,
            refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
            tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
        }, this.prisma, clientId);
    }

    /**
     * Sync order to JTL-FFN (create outbound)
     */
    async syncOrderToFFN(orderId: string): Promise<{
        success: boolean;
        outboundId?: string;
        error?: string;
    }> {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: orderId },
                include: {
                    items: { include: { product: true } },
                    client: true,
                },
            });

            if (!order) {
                throw new Error(`Order ${orderId} not found`);
            }

            // Don't sync cancelled orders
            if (order.isCancelled) {
                return { success: true };
            }

            // Get JTL config
            const jtlConfig = await this.prisma.jtlConfig.findUnique({
                where: { clientId_fk: order.clientId },
            });

            if (!jtlConfig || !jtlConfig.isActive) {
                return { success: false, error: 'JTL not configured for this client' };
            }

            // Get JTL service
            const jtlService = await this.getJTLService(order.clientId);
            if (!jtlService) {
                return { success: false, error: 'JTL not configured for this client' };
            }

            // Check if already synced
            if (order.jtlOutboundId) {
                return { success: true, outboundId: order.jtlOutboundId };
            }

            // Transform and create outbound
            const outbound = this.transformOrderToOutbound(order, jtlConfig);
            const result = await jtlService.createOutbound(outbound);

            // Update order with JTL IDs
            await this.prisma.order.update({
                where: { id: orderId },
                data: {
                    jtlOutboundId: result.outboundId,
                    lastJtlSync: new Date(),
                    syncStatus: 'SYNCED',
                    fulfillmentState: 'PENDING', // FFN now has the order
                },
            });

            // Log sync
            await this.prisma.orderSyncLog.create({
                data: {
                    orderId,
                    action: 'create',
                    origin: 'NOLIMITS',
                    targetPlatform: 'jtl',
                    success: true,
                    externalId: result.outboundId,
                    changedFields: ['jtlOutboundId', 'lastJtlSync'],
                },
            });

            // ONLY LOG FINAL SUCCESS
            this.syncLogger.getLogger().info({
                event: 'order_synced_to_ffn',
                orderId,
                orderNumber: order.orderNumber,
                outboundId: result.outboundId,
                status: 'success'
            });

            return { success: true, outboundId: result.outboundId };
        } catch (error: any) {
            this.syncLogger.getLogger().error({
                event: 'ffn_sync_failed',
                orderId,
                error: error.message,
                stack: error.stack
            });

            // Log failed sync
            await this.prisma.orderSyncLog.create({
                data: {
                    orderId,
                    action: 'create',
                    origin: 'NOLIMITS',
                    targetPlatform: 'jtl',
                    success: false,
                    errorMessage: error.message,
                },
            });

            // Update order with error
            await this.prisma.order.update({
                where: { id: orderId },
                data: {
                    ffnSyncError: error.message,
                    syncStatus: 'ERROR',
                },
            });

            return { success: false, error: error.message };
        }
    }

    /**
     * Cancel order in JTL-FFN
     */
    async cancelOrderInFFN(orderId: string, reason?: string): Promise<{
        success: boolean;
        error?: string;
    }> {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: orderId },
            });

            if (!order) {
                throw new Error(`Order ${orderId} not found`);
            }

            if (!order.jtlOutboundId) {
                return { success: true };
            }

            const jtlService = await this.getJTLService(order.clientId);
            if (!jtlService) {
                return { success: false, error: 'JTL not configured for this client' };
            }

            // Cancel outbound in JTL-FFN
            await jtlService.cancelOutbound(order.jtlOutboundId, reason);

            // Update order
            await this.prisma.order.update({
                where: { id: orderId },
                data: {
                    lastJtlSync: new Date(),
                },
            });

            // Log sync
            await this.prisma.orderSyncLog.create({
                data: {
                    orderId,
                    action: 'cancel',
                    origin: 'NOLIMITS',
                    targetPlatform: 'jtl',
                    success: true,
                    externalId: order.jtlOutboundId,
                },
            });

            this.syncLogger.getLogger().info({
                event: 'order_cancelled_in_ffn',
                orderId,
                orderNumber: order.orderNumber,
                outboundId: order.jtlOutboundId
            });

            return { success: true };
        } catch (error: any) {
            this.syncLogger.getLogger().error({
                event: 'ffn_cancel_failed',
                orderId,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            return { success: false, error: error.message };
        }
    }

    /**
     * Create fulfillment order for split order
     */
    async createFulfillmentOrderInFFN(
        splitOrderId: string,
        items: Array<{ sku: string; quantity: number }>
    ): Promise<{
        success: boolean;
        outboundId?: string;
        error?: string;
    }> {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: splitOrderId },
                include: {
                    items: { include: { product: true } },
                    client: true,
                },
            });

            if (!order) {
                throw new Error(`Split order ${splitOrderId} not found`);
            }

            const jtlConfig = await this.prisma.jtlConfig.findUnique({
                where: { clientId_fk: order.clientId },
            });

            if (!jtlConfig || !jtlConfig.isActive) {
                return { success: false, error: 'JTL not configured for this client' };
            }

            const jtlService = await this.getJTLService(order.clientId);
            if (!jtlService) {
                return { success: false, error: 'JTL not configured for this client' };
            }

            // Create outbound with only the split items
            const outbound = this.transformOrderToOutbound(order, jtlConfig, items);
            const result = await jtlService.createOutbound(outbound);

            // Update order
            await this.prisma.order.update({
                where: { id: splitOrderId },
                data: {
                    jtlOutboundId: result.outboundId,
                    jtlFulfillmentId: result.outboundId,
                    lastJtlSync: new Date(),
                    syncStatus: 'SYNCED',
                },
            });

            this.syncLogger.getLogger().info({
                event: 'split_order_synced',
                splitOrderId,
                outboundId: result.outboundId
            });

            return { success: true, outboundId: result.outboundId };
        } catch (error: any) {
            this.syncLogger.getLogger().error({
                event: 'split_order_sync_failed',
                splitOrderId,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            return { success: false, error: error.message };
        }
    }

    /**
     * Poll FFN for outbound updates and sync to platform
     * @param verbose - If true, logs detailed progress (for manual syncs). If false, only logs errors (for background polling)
     */
    async pollFFNUpdates(clientId: string, since?: Date, verbose: boolean = false): Promise<{
        success: boolean;
        updatesProcessed: number;
        unchanged?: number;
        error?: string;
    }> {
        try {
            const jtlService = await this.getJTLService(clientId);
            if (!jtlService) {
                return { success: false, updatesProcessed: 0, error: 'JTL not configured' };
            }

            // Log start for manual syncs
            if (verbose) {
                this.syncLogger.getLogger().info({
                    event: 'manual_sync_started',
                    clientId,
                    since: since?.toISOString()
                });
            }

            // Get updates since last poll
            const fromDate = since
                ? since.toISOString()
                : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Default: last 24 hours
            // Subtract 5 seconds to avoid clock sync issues with JTL API
            // API rejects requests where toDate > API server's current time
            const toDate = new Date(Date.now() - 5000).toISOString();

            const response = await jtlService.getOutboundUpdates({
                fromDate,
                toDate,
                page: 1,
                ignoreOwnApplicationId: false,
                ignoreOwnUserId: false,
            });

            const updates = response.data || [];

            // PHASE 1 DEBUG: Log raw API response to understand format
            console.log('[JTL-SYNC-DEBUG] ========================================');
            console.log('[JTL-SYNC-DEBUG] Raw API response:', JSON.stringify(updates, null, 2));
            console.log('[JTL-SYNC-DEBUG] Response type:', typeof updates);
            console.log('[JTL-SYNC-DEBUG] Is array:', Array.isArray(updates));
            console.log('[JTL-SYNC-DEBUG] Count:', updates.length);

            if (updates.length > 0) {
                console.log('[JTL-SYNC-DEBUG] First update structure:', JSON.stringify(updates[0], null, 2));
                console.log('[JTL-SYNC-DEBUG] First update keys:', Object.keys(updates[0]));
            }

            // Log updates fetched for manual syncs
            if (verbose) {
                this.syncLogger.getLogger().info({
                    event: 'updates_fetched',
                    count: updates.length
                });
            }

            let processed = 0;
            let unchanged = 0;

            for (const update of updates) {
                // PHASE 1 DEBUG: Log each update being processed
                console.log('[JTL-SYNC-DEBUG] ----------------------------------------');
                console.log('[JTL-SYNC-DEBUG] Processing update:', JSON.stringify(update, null, 2));

                // API returns raw outbound objects: { outboundId: "...", status: "...", ... }
                const outboundId = update.outboundId;
                const outboundData = update;

                if (!outboundId) {
                    console.log('[JTL-SYNC-DEBUG] ❌ SKIPPING - No outboundId');
                    continue;
                }

                console.log('[JTL-SYNC-DEBUG] ✓ Extracted outboundId:', outboundId);
                console.log('[JTL-SYNC-DEBUG] ✓ Status from data:', outboundData.status);

                const order = await this.prisma.order.findFirst({
                    where: {
                        clientId,
                        jtlOutboundId: outboundId,
                    },
                    include: {
                        channel: true,
                    },
                });

                if (!order) {
                    console.log('[JTL-SYNC-DEBUG] ⚠️  No order found with jtlOutboundId:', outboundId);
                    continue;
                }

                console.log('[JTL-SYNC-DEBUG] ✓ Found order:', order.orderNumber || order.orderId);

                // Map FFN status to fulfillment state
                const oldState = order.fulfillmentState;
                const newState = this.mapFFNStatusToFulfillmentState(outboundData.status);

                console.log('[JTL-SYNC-DEBUG] FFN status from API:', outboundData.status);
                console.log('[JTL-SYNC-DEBUG] Old state in DB:', oldState);
                console.log('[JTL-SYNC-DEBUG] New state (mapped):', newState);
                console.log('[JTL-SYNC-DEBUG] State changed?', oldState !== newState);

                // ONLY UPDATE IF STATE CHANGED
                if (oldState !== newState) {
                    // Fetch detailed outbound data if status is 'shipped'
                    let trackingNumber: string | undefined;
                    let shippedAt: Date | undefined;

                    if (newState === 'SHIPPED') {
                        try {
                            const outboundDetail = await jtlService.getOutbound(outboundId);
                            // Extract tracking info from detail if available
                            trackingNumber = (outboundDetail as any).trackingNumber;
                            shippedAt = (outboundDetail as any).shippedAt
                                ? new Date((outboundDetail as any).shippedAt)
                                : new Date();
                        } catch (e) {
                            // Silently ignore - tracking info is optional
                        }
                    }

                    // Update order
                    await this.prisma.order.update({
                        where: { id: order.id },
                        data: {
                            fulfillmentState: newState,
                            trackingNumber: trackingNumber || order.trackingNumber,
                            shippedAt: shippedAt || order.shippedAt,
                            lastJtlSync: new Date(),
                            lastOperationalUpdateBy: 'JTL',
                            lastOperationalUpdateAt: new Date(),
                        },
                    });

                    // Log update
                    await this.prisma.orderSyncLog.create({
                        data: {
                            orderId: order.id,
                            action: 'update',
                            origin: 'JTL',
                            targetPlatform: 'nolimits',
                            success: true,
                            changedFields: ['fulfillmentState', 'trackingNumber', 'shippedAt'],
                        },
                    });

                    // Log state change for manual syncs
                    if (verbose) {
                        this.syncLogger.logStateChange({
                            id: order.id,
                            displayId: order.orderNumber || order.orderId,
                            oldState,
                            newState
                        });
                    }

                    // If shipped, sync tracking to commerce platform
                    if (newState === 'SHIPPED' && trackingNumber && order.channel) {
                        await this.queueCommerceTrackingSync(order.id, trackingNumber);
                    }

                    processed++;
                } else {
                    console.log('[JTL-SYNC-DEBUG] ℹ️  State unchanged - not updating');
                    // State unchanged - just update lastJtlSync timestamp
                    await this.prisma.order.update({
                        where: { id: order.id },
                        data: {
                            lastJtlSync: new Date(),
                        },
                    });
                    unchanged++;
                }
            }

            // Handle pagination - fetch additional pages if more data is available
            if (response.moreDataAvailable) {
                let currentPage = 1;
                let hasMoreData: boolean = response.moreDataAvailable;
                const maxPages = 10; // Safety limit to prevent infinite loops

                console.log('[JTL-SYNC-DEBUG] More data available, fetching additional pages...');

                while (hasMoreData && currentPage < maxPages) {
                    currentPage++;

                    console.log(`[JTL-SYNC-DEBUG] Fetching page ${currentPage}...`);

                    const pageResponse = await jtlService.getOutboundUpdates({
                        fromDate,
                        toDate,
                        page: currentPage,
                        ignoreOwnApplicationId: false,
                        ignoreOwnUserId: false,
                    });

                    const pageUpdates = pageResponse.data || [];
                    console.log(`[JTL-SYNC-DEBUG] Page ${currentPage} returned ${pageUpdates.length} updates`);

                    // Process updates from this page using the same logic
                    for (const update of pageUpdates) {
                        console.log('[JTL-SYNC-DEBUG] ----------------------------------------');
                        console.log('[JTL-SYNC-DEBUG] Processing update:', JSON.stringify(update, null, 2));

                        // API returns raw outbound objects: { outboundId: "...", status: "...", ... }
                        const outboundId = update.outboundId;
                        const outboundData = update;

                        if (!outboundId) {
                            console.log('[JTL-SYNC-DEBUG] ❌ SKIPPING - No outboundId');
                            continue;
                        }

                        console.log('[JTL-SYNC-DEBUG] ✓ Extracted outboundId:', outboundId);
                        console.log('[JTL-SYNC-DEBUG] ✓ Status from data:', outboundData.status);

                        const order = await this.prisma.order.findFirst({
                            where: {
                                clientId,
                                jtlOutboundId: outboundId,
                            },
                            include: {
                                channel: true,
                            },
                        });

                        if (!order) {
                            console.log('[JTL-SYNC-DEBUG] ⚠️  No order found with jtlOutboundId:', outboundId);
                            continue;
                        }

                        console.log('[JTL-SYNC-DEBUG] ✓ Found order:', order.orderNumber || order.orderId);

                        const oldState = order.fulfillmentState;
                        const newState = this.mapFFNStatusToFulfillmentState(outboundData.status);

                        console.log('[JTL-SYNC-DEBUG] FFN status from API:', outboundData.status);
                        console.log('[JTL-SYNC-DEBUG] Old state in DB:', oldState);
                        console.log('[JTL-SYNC-DEBUG] New state (mapped):', newState);
                        console.log('[JTL-SYNC-DEBUG] State changed?', oldState !== newState);

                        if (oldState !== newState) {
                            let trackingNumber: string | undefined;
                            let shippedAt: Date | undefined;

                            if (newState === 'SHIPPED') {
                                try {
                                    const outboundDetail = await jtlService.getOutbound(outboundId);
                                    trackingNumber = (outboundDetail as any).trackingNumber;
                                    shippedAt = (outboundDetail as any).shippedAt
                                        ? new Date((outboundDetail as any).shippedAt)
                                        : new Date();
                                } catch (e) {
                                    // Silently ignore - tracking info is optional
                                }
                            }

                            await this.prisma.order.update({
                                where: { id: order.id },
                                data: {
                                    fulfillmentState: newState,
                                    trackingNumber: trackingNumber || order.trackingNumber,
                                    shippedAt: shippedAt || order.shippedAt,
                                    lastJtlSync: new Date(),
                                    lastOperationalUpdateBy: 'JTL',
                                    lastOperationalUpdateAt: new Date(),
                                },
                            });

                            await this.prisma.orderSyncLog.create({
                                data: {
                                    orderId: order.id,
                                    action: 'update',
                                    origin: 'JTL',
                                    targetPlatform: 'nolimits',
                                    success: true,
                                    changedFields: ['fulfillmentState', 'trackingNumber', 'shippedAt'],
                                },
                            });

                            if (verbose) {
                                this.syncLogger.logStateChange({
                                    id: order.id,
                                    displayId: order.orderNumber || order.orderId,
                                    oldState,
                                    newState
                                });
                            }

                            if (newState === 'SHIPPED' && trackingNumber && order.channel) {
                                await this.queueCommerceTrackingSync(order.id, trackingNumber);
                            }

                            processed++;
                        } else {
                            console.log('[JTL-SYNC-DEBUG] ℹ️  State unchanged - not updating');
                            await this.prisma.order.update({
                                where: { id: order.id },
                                data: {
                                    lastJtlSync: new Date(),
                                },
                            });
                            unchanged++;
                        }
                    }

                    // Check if there are more pages
                    hasMoreData = pageResponse.moreDataAvailable;
                    if (!hasMoreData) {
                        console.log('[JTL-SYNC-DEBUG] No more pages available');
                    }
                }

                if (currentPage >= maxPages && hasMoreData) {
                    console.log(`[JTL-SYNC-DEBUG] ⚠️  Reached max page limit (${maxPages}), there may be more data`);
                }
            }

            // PHASE 1 DEBUG: Summary
            console.log('[JTL-SYNC-DEBUG] ========================================');
            console.log('[JTL-SYNC-DEBUG] SYNC SUMMARY:');
            console.log('[JTL-SYNC-DEBUG] Total updates received:', updates.length);
            console.log('[JTL-SYNC-DEBUG] Orders updated:', processed);
            console.log('[JTL-SYNC-DEBUG] Orders unchanged:', unchanged);
            console.log('[JTL-SYNC-DEBUG] ========================================');

            // Log completion summary for manual syncs (always) or background syncs (only if changes)
            if (verbose || processed > 0) {
                this.syncLogger.getLogger().info({
                    event: 'sync_completed',
                    updatesChecked: updates.length,
                    ordersUpdated: processed,
                    ordersUnchanged: unchanged,
                    clientId
                });
            }

            return { success: true, updatesProcessed: processed, unchanged: unchanged };
        } catch (error: any) {
            this.syncLogger.getLogger().error({
                event: 'ffn_poll_failed',
                clientId,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            return { success: false, updatesProcessed: 0, unchanged: 0, error: error.message };
        }
    }

    /**
     * Transform order to JTL outbound format
     */
    private transformOrderToOutbound(
        order: Order & { items: Array<{ sku: string | null; productName: string | null; quantity: number; unitPrice: any; totalPrice: any; product?: { jtlProductId?: string | null } | null }> },
        jtlConfig: { warehouseId: string; fulfillerId: string },
        filterItems?: Array<{ sku: string; quantity: number }>
    ): JTLOutbound {
        let items = order.items;

        // If filterItems provided (for split orders), only include those items
        if (filterItems) {
            items = items.filter((item) =>
                filterItems.some((fi) => fi.sku === item.sku && fi.quantity === item.quantity)
            );
        }

        // Parse shipping name into firstname/lastname for JTL format
        const fullName = `${order.shippingFirstName || ''} ${order.shippingLastName || ''}`.trim() ||
            order.customerName ||
            'Unknown';
        const nameParts = fullName.split(' ');
        const firstname = nameParts[0] || 'Unknown';
        const lastname = nameParts.slice(1).join(' ') || firstname;

        return {
            merchantOutboundNumber: order.orderId,
            warehouseId: jtlConfig.warehouseId,
            fulfillerId: jtlConfig.fulfillerId,
            currency: order.currency || 'EUR',
            customerOrderNumber: order.orderNumber || order.orderId,
            orderDate: order.orderDate.toISOString(),
            shippingAddress: {
                firstname,
                lastname,
                company: order.shippingCompany || undefined,
                street: order.shippingAddress1 || '',
                addition: order.shippingAddress2 || undefined,
                city: order.shippingCity || '',
                zip: order.shippingZip || '',
                country: order.shippingCountryCode || order.shippingCountry || 'DE',
                phone: order.customerPhone || undefined,
                email: order.customerEmail || undefined,
            },
            items: items.map((item) => ({
                merchantSku: item.sku || 'UNKNOWN',
                jfsku: item.product?.jtlProductId || undefined,
                outboundItemId: item.product?.jtlProductId || item.sku || 'UNKNOWN',
                name: item.productName || item.sku || 'Unknown Product',
                quantity: item.quantity,
                unitPrice: item.unitPrice ? parseFloat(item.unitPrice.toString()) : 0,
            })),
            shippingType: 'Standard',
            priority: order.priorityLevel || 0,
            note: order.warehouseNotes || order.notes || undefined,
        };
    }

    /**
     * Map FFN status to FulfillmentState
     */
    private mapFFNStatusToFulfillmentState(ffnStatus: string): FulfillmentState {
        const statusMap: Record<string, FulfillmentState> = {
            'PENDING': 'PENDING',
            'PREPARATION': 'PREPARATION',
            'ACKNOWLEDGED': 'ACKNOWLEDGED',
            'LOCKED': 'LOCKED',
            'PICKPROCESS': 'PICKPROCESS',
            'SHIPPED': 'SHIPPED',
            'PARTIALLY_SHIPPED': 'PARTIALLY_SHIPPED',
            'PARTIALLYSHIPPED': 'PARTIALLY_SHIPPED',
            'CANCELED': 'CANCELED',
            'CANCELLED': 'CANCELED',
            'PARTIALLY_CANCELED': 'PARTIALLY_CANCELED',
            'PARTIALLYCANCELED': 'PARTIALLY_CANCELED',
            'IN_TRANSIT': 'IN_TRANSIT',
            'INTRANSIT': 'IN_TRANSIT',
            'DELIVERED': 'DELIVERED',
            'FAILED': 'FAILED_DELIVERY',
            'RETURNED': 'RETURNED_TO_SENDER',

            // Backward compatibility with old FFN status names
            'NEW': 'PENDING',
            'OPEN': 'PREPARATION',
            'IN_PICK': 'PICKPROCESS',
            'PICKED': 'PICKPROCESS',
            'PACKING': 'PICKPROCESS',
            'PACKED': 'LOCKED',
        };

        return statusMap[ffnStatus.toUpperCase()] || 'PENDING';
    }

    /**
     * Queue commerce tracking sync
     */
    private async queueCommerceTrackingSync(orderId: string, trackingNumber: string): Promise<void> {
        try {
            const { getQueue, QUEUE_NAMES } = await import('../queue/sync-queue.service.js');
            const queue = getQueue();

            await queue.enqueue(
                QUEUE_NAMES.ORDER_SYNC_TO_COMMERCE,
                {
                    orderId,
                    origin: 'nolimits' as const,
                    operation: 'fulfill' as const,
                },
                {
                    priority: 1,
                }
            );

        } catch (error) {
            this.syncLogger.getLogger().error({
                event: 'queue_tracking_sync_failed',
                orderId,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    /**
     * Fetch orders from commerce channels and reconcile with JTL FFN
     * This recovers orders that may have been missed due to webhook failures
     *
     * Flow:
     * 1. Fetch orders from Shopify/WooCommerce (last 7 days by default)
     * 2. For each order:
     *    - Already in DB? Skip (mark as existing)
     *    - Not in DB? Create order, then:
     *      - Exists in JTL FFN? Link (set jtlOutboundId)
     *      - Not in JTL FFN? Push to FFN
     * 3. Return stats
     */
    async fetchAndReconcileOrders(
        clientId: string,
        since?: Date
    ): Promise<{
        success: boolean;
        stats: FetchOrdersStats;
        error?: string;
    }> {
        const stats: FetchOrdersStats = {
            ordersFoundInChannel: 0,
            newOrdersCreated: 0,
            ordersAlreadyExisted: 0,
            ordersLinkedToFFN: 0,
            ordersPushedToFFN: 0,
            errors: 0,
        };

        try {
            this.syncLogger.getLogger().info({
                event: 'fetch_orders_started',
                clientId,
                since: since?.toISOString() || '7 days ago'
            });

            // Default to 7 days ago if no date specified
            const sinceDate = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

            // Get client's active channels
            const channels = await this.prisma.channel.findMany({
                where: {
                    clientId,
                    isActive: true,
                },
            });

            if (channels.length === 0) {
                return {
                    success: false,
                    stats,
                    error: 'No active channels found for this client',
                };
            }

            // Get JTL service for this client
            const jtlService = await this.getJTLService(clientId);
            if (!jtlService) {
                return {
                    success: false,
                    stats,
                    error: 'JTL FFN not configured for this client',
                };
            }

            // Get JTL config for warehouse/fulfiller IDs
            const jtlConfig = await this.prisma.jtlConfig.findUnique({
                where: { clientId_fk: clientId },
            });

            if (!jtlConfig) {
                return {
                    success: false,
                    stats,
                    error: 'JTL configuration not found',
                };
            }

            const encryptionService = getEncryptionService();

            // Process each channel
            for (const channel of channels) {
                try {
                    let channelOrders: any[] = [];

                    // Fetch orders from channel based on type
                    if (channel.type === 'SHOPIFY' && channel.shopDomain && channel.accessToken) {
                        const shopifyService = createShopifyServiceAuto({
                            shopDomain: channel.shopDomain,
                            accessToken: encryptionService.safeDecrypt(channel.accessToken),
                        });

                        channelOrders = await shopifyService.getOrdersCreatedSince(sinceDate);
                        this.syncLogger.getLogger().info({
                            event: 'shopify_orders_fetched',
                            channelId: channel.id,
                            count: channelOrders.length,
                        });

                    } else if (channel.type === 'WOOCOMMERCE' && channel.apiClientId && channel.apiClientSecret) {
                        const wooService = new WooCommerceService({
                            url: channel.url || '',
                            consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
                            consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
                        });

                        channelOrders = await wooService.getOrdersCreatedSince(sinceDate);
                        this.syncLogger.getLogger().info({
                            event: 'woocommerce_orders_fetched',
                            channelId: channel.id,
                            count: channelOrders.length,
                        });
                    }

                    stats.ordersFoundInChannel += channelOrders.length;

                    // Process each order
                    for (const channelOrder of channelOrders) {
                        try {
                            await this.processChannelOrder(
                                channelOrder,
                                channel,
                                jtlService,
                                jtlConfig,
                                stats
                            );
                        } catch (orderError: any) {
                            this.syncLogger.getLogger().error({
                                event: 'order_processing_error',
                                orderId: channelOrder.id || channelOrder.name,
                                error: orderError.message,
                            });
                            stats.errors++;
                        }
                    }

                } catch (channelError: any) {
                    this.syncLogger.getLogger().error({
                        event: 'channel_fetch_error',
                        channelId: channel.id,
                        channelType: channel.type,
                        error: channelError.message,
                    });
                    stats.errors++;
                }
            }

            this.syncLogger.getLogger().info({
                event: 'fetch_orders_completed',
                clientId,
                stats,
            });

            return {
                success: stats.errors === 0,
                stats,
            };

        } catch (error: any) {
            this.syncLogger.getLogger().error({
                event: 'fetch_orders_failed',
                clientId,
                error: error.message,
            });

            return {
                success: false,
                stats,
                error: error.message,
            };
        }
    }

    /**
     * Process a single order from channel - check DB, check FFN, create/link as needed
     */
    private async processChannelOrder(
        channelOrder: any,
        channel: any,
        jtlService: JTLService,
        jtlConfig: any,
        stats: FetchOrdersStats
    ): Promise<void> {
        // Extract order identifier based on channel type
        const externalOrderId = String(channelOrder.id);
        const orderNumber = channel.type === 'SHOPIFY'
            ? (channelOrder.name || String(channelOrder.order_number))
            : channelOrder.number;

        // Check if order already exists in DB
        const existingOrder = await this.prisma.order.findFirst({
            where: {
                channelId: channel.id,
                externalOrderId: externalOrderId,
            },
        });

        if (existingOrder) {
            stats.ordersAlreadyExisted++;
            return;
        }

        // Order doesn't exist in DB - create it
        const newOrder = await this.createOrderFromChannelData(
            channelOrder,
            channel
        );
        stats.newOrdersCreated++;

        // Now check if this order exists in JTL FFN
        // We use orderId (e.g., "SHOP-123456789") as merchantOutboundNumber
        const ffnOutbound = await jtlService.getOutboundByMerchantNumber(newOrder.orderId);

        if (ffnOutbound) {
            // Order exists in FFN - link it
            await this.prisma.order.update({
                where: { id: newOrder.id },
                data: {
                    jtlOutboundId: ffnOutbound.outboundId,
                    lastJtlSync: new Date(),
                    syncStatus: 'SYNCED',
                    fulfillmentState: this.mapFFNStatusToFulfillmentState(ffnOutbound.status),
                },
            });

            this.syncLogger.getLogger().info({
                event: 'order_linked_to_ffn',
                orderId: newOrder.id,
                orderNumber: newOrder.orderNumber,
                outboundId: ffnOutbound.outboundId,
            });

            stats.ordersLinkedToFFN++;

        } else {
            // Order doesn't exist in FFN - push it
            const syncResult = await this.syncOrderToFFN(newOrder.id);

            if (syncResult.success) {
                stats.ordersPushedToFFN++;
            } else {
                this.syncLogger.getLogger().warn({
                    event: 'ffn_push_failed',
                    orderId: newOrder.id,
                    error: syncResult.error,
                });
                stats.errors++;
            }
        }
    }

    /**
     * Create an order in DB from channel data (Shopify or WooCommerce format)
     */
    private async createOrderFromChannelData(
        channelOrder: any,
        channel: any
    ): Promise<Order> {
        const isShopify = channel.type === 'SHOPIFY';
        const externalOrderId = String(channelOrder.id);
        const orderNumber = isShopify
            ? (channelOrder.name || String(channelOrder.order_number))
            : channelOrder.number;

        // Extract shipping address
        const shippingAddress = isShopify
            ? channelOrder.shipping_address || {}
            : channelOrder.shipping || {};

        // Extract line items
        const lineItems = isShopify
            ? channelOrder.line_items || []
            : channelOrder.line_items || [];

        // Determine order date
        const orderDate = channelOrder.created_at
            ? new Date(channelOrder.created_at)
            : new Date();

        // Create order with items
        // IMPORTANT: orderId format must match what webhooks create, so FFN reconciliation works
        // Webhooks use: SHOP-{orderNumber} or WOO-{orderNumber}
        // e.g., "SHOP-1001" (NOT "SHOP-5998766743874" with the internal ID)
        const cleanOrderNumber = String(orderNumber).replace(/^#/, '');
        const orderId = isShopify
            ? `SHOP-${cleanOrderNumber}`
            : `WOO-${cleanOrderNumber}`;

        const newOrder = await this.prisma.order.create({
            data: {
                orderId,
                clientId: channel.clientId,
                channelId: channel.id,
                externalOrderId: externalOrderId,
                orderNumber: orderNumber,
                orderDate: orderDate,
                status: 'PENDING',
                fulfillmentState: 'PENDING',
                syncStatus: 'PENDING',
                // Shipping address
                shippingFirstName: isShopify
                    ? (shippingAddress.first_name || '')
                    : (shippingAddress.first_name || ''),
                shippingLastName: isShopify
                    ? (shippingAddress.last_name || 'Unknown')
                    : (shippingAddress.last_name || 'Unknown'),
                shippingCompany: shippingAddress.company || null,
                shippingAddress1: isShopify
                    ? (shippingAddress.address1 || '')
                    : (shippingAddress.address_1 || ''),
                shippingAddress2: isShopify
                    ? (shippingAddress.address2 || null)
                    : (shippingAddress.address_2 || null),
                shippingCity: shippingAddress.city || '',
                shippingZip: isShopify
                    ? (shippingAddress.zip || '')
                    : (shippingAddress.postcode || ''),
                shippingCountry: isShopify
                    ? (shippingAddress.country || '')
                    : (shippingAddress.country || ''),
                shippingCountryCode: isShopify
                    ? (shippingAddress.country_code || '')
                    : (shippingAddress.country || ''),
                // Customer info
                customerEmail: isShopify
                    ? channelOrder.email
                    : channelOrder.billing?.email,
                customerPhone: shippingAddress.phone || null,
                customerName: `${shippingAddress.first_name || ''} ${shippingAddress.last_name || ''}`.trim() || 'Unknown',
                // Shipping method
                shippingMethod: isShopify
                    ? (channelOrder.shipping_lines?.[0]?.title || 'Standard')
                    : (channelOrder.shipping_lines?.[0]?.method_title || 'Standard'),
                // Financial data
                currency: channelOrder.currency || 'EUR',
                total: channelOrder.total_price
                    ? new Prisma.Decimal(channelOrder.total_price)
                    : null,
                // Payment status
                paymentStatus: isShopify
                    ? (channelOrder.financial_status === 'paid' ? 'paid' : 'pending')
                    : (channelOrder.status === 'completed' || channelOrder.status === 'processing' ? 'paid' : 'pending'),
                // Order items
                items: {
                    create: await Promise.all(lineItems.map(async (item: any) => {
                        const sku = isShopify
                            ? (item.sku || `NO-SKU-${item.variant_id || item.product_id}`)
                            : (item.sku || `NO-SKU-${item.product_id}`);

                        // Try to find matching product
                        const product = await this.prisma.product.findFirst({
                            where: {
                                clientId: channel.clientId,
                                sku: sku,
                            },
                        });

                        return {
                            productId: product?.id || null,
                            sku: sku,
                            quantity: item.quantity,
                            productName: isShopify
                                ? (item.name || item.title || 'Unknown Product')
                                : (item.name || 'Unknown Product'),
                            unitPrice: item.price
                                ? new Prisma.Decimal(item.price)
                                : null,
                            totalPrice: isShopify
                                ? (item.price ? new Prisma.Decimal(parseFloat(item.price) * item.quantity) : null)
                                : (item.total ? new Prisma.Decimal(item.total) : null),
                        };
                    })),
                },
            },
        });

        this.syncLogger.getLogger().info({
            event: 'order_created_from_channel',
            orderId: newOrder.id,
            orderNumber: newOrder.orderNumber,
            channelType: channel.type,
        });

        return newOrder;
    }
}

export default JTLOrderSyncService;
