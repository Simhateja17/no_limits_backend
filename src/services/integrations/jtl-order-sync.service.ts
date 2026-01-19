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

import { PrismaClient, Order, SyncOrigin, FulfillmentState } from '@prisma/client';
import { JTLService } from './jtl.service.js';
import { JTLOutbound } from './types.js';
import { getEncryptionService } from '../encryption.service.js';

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

// ============= SERVICE =============

export class JTLOrderSyncService {
    constructor(private prisma: PrismaClient) { }

    /**
     * Get JTL Service for a client
     */
    private async getJTLService(clientId: string): Promise<JTLService | null> {
        const jtlConfig = await this.prisma.jtlConfig.findUnique({
            where: { clientId_fk: clientId },
        });

        if (!jtlConfig || !jtlConfig.isActive) {
            console.log(`[JTL] No active JTL config for client ${clientId}`);
            return null;
        }

        const encryptionService = getEncryptionService();

        return new JTLService({
            clientId: jtlConfig.clientId,
            clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
            fulfillerId: jtlConfig.fulfillerId,
            warehouseId: jtlConfig.warehouseId,
            environment: jtlConfig.environment as 'sandbox' | 'production',
            accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
            refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
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
        const startTime = Date.now();
        console.log(`[JTL-FFN-SYNC] ========== START: Syncing order ${orderId} to JTL-FFN ==========`);
        
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: orderId },
                include: {
                    items: { include: { product: true } },
                    client: true,
                },
            });

            if (!order) {
                console.log(`[JTL-FFN-SYNC] ERROR: Order ${orderId} not found in database`);
                throw new Error(`Order ${orderId} not found`);
            }

            console.log(`[JTL-FFN-SYNC] Order details:`, {
                orderId: order.id,
                orderNumber: order.orderNumber,
                externalOrderId: order.externalOrderId,
                customerEmail: order.customerEmail,
                origin: order.orderOrigin,
                itemCount: order.items.length,
                total: order.total?.toString(),
                clientId: order.clientId,
            });

            // Don't sync cancelled orders
            if (order.isCancelled) {
                console.log(`[JTL-FFN-SYNC] SKIPPED: Order ${orderId} is cancelled - not syncing to FFN`);
                return { success: true };
            }

            // Get JTL service
            console.log(`[JTL-FFN-SYNC] Getting JTL service for client ${order.clientId}...`);
            const jtlService = await this.getJTLService(order.clientId);
            if (!jtlService) {
                console.log(`[JTL-FFN-SYNC] ERROR: JTL not configured or inactive for client ${order.clientId}`);
                return { success: false, error: 'JTL not configured for this client' };
            }
            console.log(`[JTL-FFN-SYNC] JTL service initialized successfully`);

            // Check if already synced
            if (order.jtlOutboundId) {
                console.log(`[JTL-FFN-SYNC] ALREADY SYNCED: Order ${orderId} already exists as outbound ${order.jtlOutboundId}`);
                return { success: true, outboundId: order.jtlOutboundId };
            }

            // Transform order to JTL outbound format
            console.log(`[JTL-FFN-SYNC] Transforming order to JTL outbound format...`);
            const outbound = this.transformOrderToOutbound(order);
            console.log(`[JTL-FFN-SYNC] Outbound payload prepared:`, {
                merchantOutboundNumber: outbound.merchantOutboundNumber,
                itemCount: outbound.items?.length,
                shippingCountry: outbound.shipTo?.countryCode,
            });

            // Create outbound in JTL-FFN
            console.log(`[JTL-FFN-SYNC] Sending order to JTL-FFN API...`);
            const result = await jtlService.createOutbound(outbound);
            console.log(`[JTL-FFN-SYNC] JTL-FFN API response:`, {
                success: true,
                outboundId: result.outboundId,
            });

            // Update order with JTL IDs
            console.log(`[JTL-FFN-SYNC] Updating order ${orderId} with JTL outbound ID...`);
            await this.prisma.order.update({
                where: { id: orderId },
                data: {
                    jtlOutboundId: result.outboundId,
                    lastJtlSync: new Date(),
                    syncStatus: 'SYNCED',
                    fulfillmentState: 'AWAITING_STOCK', // FFN now has the order
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

            const duration = Date.now() - startTime;
            console.log(`[JTL-FFN-SYNC] ========== SUCCESS: Order ${orderId} synced to FFN ==========`);
            console.log(`[JTL-FFN-SYNC] Summary:`, {
                orderId,
                orderNumber: order.orderNumber,
                outboundId: result.outboundId,
                duration: `${duration}ms`,
                syncStatus: 'SYNCED',
            });

            return { success: true, outboundId: result.outboundId };
        } catch (error: any) {
            const duration = Date.now() - startTime;
            console.error(`[JTL-FFN-SYNC] ========== FAILED: Order ${orderId} sync failed ==========`);
            console.error(`[JTL-FFN-SYNC] Error details:`, {
                orderId,
                error: error.message,
                stack: error.stack,
                duration: `${duration}ms`,
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
                console.log(`[JTL] Order ${orderId} not synced to FFN, nothing to cancel`);
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

            console.log(`[JTL] Order ${orderId} cancelled in FFN`);

            return { success: true };
        } catch (error: any) {
            console.error(`[JTL] Failed to cancel order ${orderId}:`, error);
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

            const jtlService = await this.getJTLService(order.clientId);
            if (!jtlService) {
                return { success: false, error: 'JTL not configured for this client' };
            }

            // Create outbound with only the split items
            const outbound = this.transformOrderToOutbound(order, items);
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

            console.log(`[JTL] Split order ${splitOrderId} synced to FFN as outbound ${result.outboundId}`);

            return { success: true, outboundId: result.outboundId };
        } catch (error: any) {
            console.error(`[JTL] Failed to create fulfillment order ${splitOrderId}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Poll FFN for outbound updates and sync to platform
     */
    async pollFFNUpdates(clientId: string, since?: Date): Promise<{
        success: boolean;
        updatesProcessed: number;
        error?: string;
    }> {
        try {
            const jtlService = await this.getJTLService(clientId);
            if (!jtlService) {
                return { success: false, updatesProcessed: 0, error: 'JTL not configured' };
            }

            // Get updates since last poll
            const sinceStr = since
                ? since.toISOString()
                : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Default: last 24 hours

            const updates = await jtlService.getOutboundUpdates({
                since: sinceStr,
                limit: 100,
            });

            console.log(`[JTL] Processing ${updates.length} outbound updates for client ${clientId}`);

            let processed = 0;

            for (const update of updates) {
                const order = await this.prisma.order.findFirst({
                    where: {
                        clientId,
                        jtlOutboundId: update.data.outboundId,
                    },
                    include: {
                        channel: true,
                    },
                });

                if (!order) {
                    console.log(`[JTL] No order found for outbound ${update.data.outboundId}`);
                    continue;
                }

                // Map FFN status to fulfillment state
                const fulfillmentState = this.mapFFNStatusToFulfillmentState(update.data.status);

                // Fetch detailed outbound data if status is 'shipped'
                let trackingNumber: string | undefined;
                let shippedAt: Date | undefined;

                if (fulfillmentState === 'SHIPPED') {
                    try {
                        const outboundDetail = await jtlService.getOutbound(update.data.outboundId);
                        // Extract tracking info from detail if available
                        trackingNumber = (outboundDetail as any).trackingNumber;
                        shippedAt = (outboundDetail as any).shippedAt
                            ? new Date((outboundDetail as any).shippedAt)
                            : new Date();
                    } catch (e) {
                        console.warn(`[JTL] Could not fetch outbound detail for ${update.data.outboundId}`);
                    }
                }

                // Update order
                await this.prisma.order.update({
                    where: { id: order.id },
                    data: {
                        fulfillmentState,
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

                // If shipped, sync tracking to commerce platform
                if (fulfillmentState === 'SHIPPED' && trackingNumber && order.channel) {
                    await this.queueCommerceTrackingSync(order.id, trackingNumber);
                }

                processed++;
            }

            return { success: true, updatesProcessed: processed };
        } catch (error: any) {
            console.error(`[JTL] Failed to poll FFN updates:`, error);
            return { success: false, updatesProcessed: 0, error: error.message };
        }
    }

    /**
     * Transform order to JTL outbound format
     */
    private transformOrderToOutbound(
        order: Order & { items: Array<{ sku: string | null; productName: string | null; quantity: number; unitPrice: any; totalPrice: any; product?: { jtlProductId?: string | null } | null }> },
        filterItems?: Array<{ sku: string; quantity: number }>
    ): JTLOutbound {
        let items = order.items;

        // If filterItems provided (for split orders), only include those items
        if (filterItems) {
            items = items.filter((item) =>
                filterItems.some((fi) => fi.sku === item.sku && fi.quantity === item.quantity)
            );
        }

        return {
            merchantOutboundNumber: order.orderId,
            customerOrderNumber: order.orderNumber || order.orderId,
            orderDate: order.orderDate.toISOString(),
            shipTo: {
                name: `${order.shippingFirstName || ''} ${order.shippingLastName || ''}`.trim() ||
                    order.customerName ||
                    'Unknown',
                company: order.shippingCompany || undefined,
                street: order.shippingAddress1 || '',
                additionalAddress: order.shippingAddress2 || undefined,
                city: order.shippingCity || '',
                zip: order.shippingZip || '',
                countryCode: order.shippingCountryCode || order.shippingCountry || 'DE',
                phone: order.customerPhone || undefined,
                email: order.customerEmail || undefined,
            },
            items: items.map((item) => ({
                merchantSku: item.sku || 'UNKNOWN',
                jfsku: item.product?.jtlProductId || undefined,
                name: item.productName || item.sku || 'Unknown Product',
                quantity: item.quantity,
                unitPrice: item.unitPrice ? parseFloat(item.unitPrice.toString()) : 0,
            })),
            shippingMethod: order.carrierSelection || order.shippingMethod || undefined,
            priority: order.priorityLevel || 0,
            note: order.warehouseNotes || order.notes || undefined,
        };
    }

    /**
     * Map FFN status to FulfillmentState
     */
    private mapFFNStatusToFulfillmentState(ffnStatus: string): FulfillmentState {
        const statusMap: Record<string, FulfillmentState> = {
            'NEW': 'AWAITING_STOCK',
            'OPEN': 'READY_FOR_PICKING',
            'IN_PICK': 'PICKING',
            'PICKED': 'PICKED',
            'PACKING': 'PACKING',
            'PACKED': 'PACKED',
            'SHIPPED': 'SHIPPED',
            'DELIVERED': 'DELIVERED',
            'CANCELLED': 'PENDING',
            'FAILED': 'FAILED_DELIVERY',
            'RETURNED': 'RETURNED_TO_SENDER',
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

            console.log(`[JTL] Queued commerce tracking sync for order ${orderId}`);
        } catch (error) {
            console.error(`[JTL] Failed to queue commerce tracking sync:`, error);
        }
    }
}

export default JTLOrderSyncService;
