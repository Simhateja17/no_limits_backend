/**
 * Order Operations Service
 *
 * Handles operational order management that the platform owns:
 * - Address corrections (before fulfillment)
 * - Carrier selection
 * - Order prioritization
 * - Replacement orders
 * - Order holds
 *
 * Key principle: Commercial truth = Shopify, Operational truth = No-Limits
 */

import {
    PrismaClient,
    Order,
    SyncOrigin,
    FulfillmentState,
    OrderStatus,
    Prisma,
} from '@prisma/client';

// ============= TYPES =============

export interface AddressCorrectionData {
    orderId: string;
    correctedBy: string; // User ID
    shippingFirstName?: string;
    shippingLastName?: string;
    shippingCompany?: string;
    shippingAddress1?: string;
    shippingAddress2?: string;
    shippingCity?: string;
    shippingZip?: string;
    shippingCountry?: string;
    shippingCountryCode?: string;
    shippingPhone?: string;
    correctionReason?: string;
}

export interface ReplacementOrderData {
    originalOrderId: string;
    returnId?: string; // If triggered from a return
    reason: string;
    createdBy: string;
    items?: Array<{
        sku: string;
        productName?: string;
        quantity: number;
    }>;
    useOriginalAddress?: boolean;
    customAddress?: {
        firstName?: string;
        lastName?: string;
        company?: string;
        address1?: string;
        address2?: string;
        city?: string;
        zip?: string;
        country?: string;
        countryCode?: string;
        phone?: string;
    };
    notes?: string;
    expedited?: boolean;
}

export interface OrderPriorityUpdate {
    orderId: string;
    priorityLevel: number;
    reason?: string;
    updatedBy: string;
}

export interface OrderHoldData {
    orderId: string;
    holdReason: string;
    holdBy: string;
}

export interface OperationResult {
    success: boolean;
    orderId?: string;
    action: string;
    error?: string;
    details?: Record<string, unknown>;
}

// ============= SERVICE =============

export class OrderOperationsService {
    constructor(private prisma: PrismaClient) { }

    /**
     * Correct shipping address before fulfillment
     *
     * This is an operational change that No-Limits owns.
     * The original address is stored for audit purposes.
     * Change is synced to FFN if order is already there.
     */
    async correctAddress(data: AddressCorrectionData): Promise<OperationResult> {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: data.orderId },
                include: { channel: true },
            });

            if (!order) {
                throw new Error(`Order ${data.orderId} not found`);
            }

            // Only allow address correction before shipping
            const nonEditableStates: FulfillmentState[] = [
                'SHIPPED',
                'IN_TRANSIT',
                'OUT_FOR_DELIVERY',
                'DELIVERED',
                'RETURNED_TO_SENDER',
            ];

            if (nonEditableStates.includes(order.fulfillmentState)) {
                throw new Error(
                    `Cannot correct address - order is already ${order.fulfillmentState}`
                );
            }

            // Store original address if not already corrected
            let originalAddress = order.originalShippingAddress as Record<string, unknown> | null;
            if (!order.addressCorrected) {
                originalAddress = {
                    firstName: order.shippingFirstName,
                    lastName: order.shippingLastName,
                    company: order.shippingCompany,
                    address1: order.shippingAddress1,
                    address2: order.shippingAddress2,
                    city: order.shippingCity,
                    zip: order.shippingZip,
                    country: order.shippingCountry,
                    countryCode: order.shippingCountryCode,
                };
            }

            // Update address
            const updatedOrder = await this.prisma.order.update({
                where: { id: data.orderId },
                data: {
                    shippingFirstName: data.shippingFirstName ?? order.shippingFirstName,
                    shippingLastName: data.shippingLastName ?? order.shippingLastName,
                    shippingCompany: data.shippingCompany ?? order.shippingCompany,
                    shippingAddress1: data.shippingAddress1 ?? order.shippingAddress1,
                    shippingAddress2: data.shippingAddress2 ?? order.shippingAddress2,
                    shippingCity: data.shippingCity ?? order.shippingCity,
                    shippingZip: data.shippingZip ?? order.shippingZip,
                    shippingCountry: data.shippingCountry ?? order.shippingCountry,
                    shippingCountryCode: data.shippingCountryCode ?? order.shippingCountryCode,
                    addressCorrected: true,
                    addressCorrectedAt: new Date(),
                    originalShippingAddress: originalAddress as Prisma.InputJsonValue ?? undefined,
                    warehouseNotes: data.correctionReason
                        ? `${order.warehouseNotes || ''}\n[Address Correction] ${data.correctionReason}`.trim()
                        : order.warehouseNotes,
                    lastOperationalUpdateBy: 'NOLIMITS',
                    lastOperationalUpdateAt: new Date(),
                },
            });

            // Log the change
            await this.prisma.orderSyncLog.create({
                data: {
                    orderId: data.orderId,
                    action: 'update',
                    origin: 'NOLIMITS',
                    targetPlatform: 'nolimits',
                    success: true,
                    changedFields: [
                        'shippingAddress',
                        'addressCorrected',
                        'addressCorrectedAt',
                        'originalShippingAddress',
                    ],
                    previousState: originalAddress as Prisma.InputJsonValue ?? undefined,
                    newState: {
                        firstName: updatedOrder.shippingFirstName,
                        lastName: updatedOrder.shippingLastName,
                        address1: updatedOrder.shippingAddress1,
                        city: updatedOrder.shippingCity,
                        zip: updatedOrder.shippingZip,
                    } as Prisma.InputJsonValue,
                },
            });

            // If order is synced to FFN, queue an update
            if (order.jtlOutboundId) {
                await this.queueFFNAddressUpdate(data.orderId);
            }

            console.log(`[OrderOps] Address corrected for order ${data.orderId}`);

            return {
                success: true,
                orderId: data.orderId,
                action: 'address_corrected',
                details: {
                    originalAddress,
                    correctedAt: new Date().toISOString(),
                    correctedBy: data.correctedBy,
                },
            };
        } catch (error: any) {
            console.error(`[OrderOps] Address correction failed:`, error);
            return {
                success: false,
                orderId: data.orderId,
                action: 'address_correction_failed',
                error: error.message,
            };
        }
    }

    /**
     * Create a replacement order
     *
     * Used when:
     * - Return inspection shows item needs replacement
     * - Customer received wrong/damaged item
     * - Lost in transit
     *
     * The replacement order references the original order.
     */
    async createReplacementOrder(data: ReplacementOrderData): Promise<OperationResult> {
        try {
            const originalOrder = await this.prisma.order.findUnique({
                where: { id: data.originalOrderId },
                include: {
                    items: true,
                    client: true,
                    channel: true,
                },
            });

            if (!originalOrder) {
                throw new Error(`Original order ${data.originalOrderId} not found`);
            }

            // Determine items for replacement
            const replacementItems = data.items || originalOrder.items.map((item) => ({
                sku: item.sku || 'UNKNOWN',
                productName: item.productName,
                quantity: item.quantity,
            }));

            // Determine shipping address
            const shippingAddress = data.customAddress || (data.useOriginalAddress ? {
                firstName: originalOrder.shippingFirstName,
                lastName: originalOrder.shippingLastName,
                company: originalOrder.shippingCompany,
                address1: originalOrder.shippingAddress1,
                address2: originalOrder.shippingAddress2,
                city: originalOrder.shippingCity,
                zip: originalOrder.shippingZip,
                country: originalOrder.shippingCountry,
                countryCode: originalOrder.shippingCountryCode,
                phone: originalOrder.customerPhone,
            } : {
                firstName: originalOrder.shippingFirstName,
                lastName: originalOrder.shippingLastName,
                company: originalOrder.shippingCompany,
                address1: originalOrder.shippingAddress1,
                address2: originalOrder.shippingAddress2,
                city: originalOrder.shippingCity,
                zip: originalOrder.shippingZip,
                country: originalOrder.shippingCountry,
                countryCode: originalOrder.shippingCountryCode,
                phone: originalOrder.customerPhone,
            });

            // Create replacement order
            const replacementOrder = await this.prisma.order.create({
                data: {
                    orderId: `REPL-${originalOrder.orderId}-${Date.now()}`,
                    orderNumber: `${originalOrder.orderNumber || originalOrder.orderId}-REPLACEMENT`,
                    externalOrderId: originalOrder.externalOrderId,

                    // Origin tracking
                    orderOrigin: 'NOLIMITS' as SyncOrigin, // Replacement created in platform
                    orderState: 'PENDING',
                    fulfillmentState: 'PENDING',
                    lastOperationalUpdateBy: 'NOLIMITS',
                    lastOperationalUpdateAt: new Date(),

                    // Mark as replacement
                    isReplacement: true,
                    originalOrderId: data.originalOrderId,

                    // Priority
                    priorityLevel: data.expedited ? 5 : 2, // Higher priority for replacements

                    // Commercial fields (from original - read-only)
                    subtotal: new Prisma.Decimal(0), // Replacement is free
                    total: new Prisma.Decimal(0),
                    currency: originalOrder.currency,

                    // Customer info
                    customerName: originalOrder.customerName,
                    customerEmail: originalOrder.customerEmail,
                    customerPhone: originalOrder.customerPhone,

                    // Shipping address
                    shippingFirstName: shippingAddress.firstName,
                    shippingLastName: shippingAddress.lastName,
                    shippingCompany: shippingAddress.company,
                    shippingAddress1: shippingAddress.address1,
                    shippingAddress2: shippingAddress.address2,
                    shippingCity: shippingAddress.city,
                    shippingZip: shippingAddress.zip,
                    shippingCountry: shippingAddress.country,
                    shippingCountryCode: shippingAddress.countryCode,

                    // Billing (copy from original)
                    billingFirstName: originalOrder.billingFirstName,
                    billingLastName: originalOrder.billingLastName,
                    billingAddress1: originalOrder.billingAddress1,
                    billingCity: originalOrder.billingCity,
                    billingZip: originalOrder.billingZip,
                    billingCountry: originalOrder.billingCountry,

                    // Notes
                    notes: `REPLACEMENT ORDER\nReason: ${data.reason}\n${data.notes || ''}`,
                    warehouseNotes: `Replacement for ${originalOrder.orderId}. Reason: ${data.reason}`,

                    // Payment (replacement is fulfilled, no payment needed)
                    paymentStatus: 'paid', // No payment required

                    // Tags
                    tags: ['replacement', ...(originalOrder.tags || [])],

                    // Sync status
                    syncStatus: 'PENDING',

                    // Relations
                    clientId: originalOrder.clientId,
                    channelId: originalOrder.channelId,

                    // Items
                    items: {
                        create: replacementItems.map((item) => ({
                            sku: item.sku,
                            productName: item.productName,
                            quantity: item.quantity,
                            unitPrice: new Prisma.Decimal(0), // Free replacement
                            totalPrice: new Prisma.Decimal(0),
                        })),
                    },
                },
            });

            // If there's a return, link it
            if (data.returnId) {
                await this.prisma.return.update({
                    where: { id: data.returnId },
                    data: {
                        triggerReplacement: true,
                        replacementOrderId: replacementOrder.id,
                    },
                });
            }

            // Log creation
            await this.prisma.orderSyncLog.create({
                data: {
                    orderId: replacementOrder.id,
                    action: 'create',
                    origin: 'NOLIMITS',
                    targetPlatform: 'nolimits',
                    success: true,
                    changedFields: ['isReplacement', 'originalOrderId'],
                    newState: {
                        isReplacement: true,
                        originalOrderId: data.originalOrderId,
                        returnId: data.returnId,
                        reason: data.reason,
                    },
                },
            });

            // Queue FFN sync
            await this.queueFFNSync(replacementOrder.id);

            console.log(
                `[OrderOps] Created replacement order ${replacementOrder.id} for ${data.originalOrderId}`
            );

            return {
                success: true,
                orderId: replacementOrder.id,
                action: 'replacement_created',
                details: {
                    originalOrderId: data.originalOrderId,
                    returnId: data.returnId,
                    reason: data.reason,
                    itemCount: replacementItems.length,
                },
            };
        } catch (error: any) {
            console.error(`[OrderOps] Failed to create replacement order:`, error);
            return {
                success: false,
                orderId: data.originalOrderId,
                action: 'replacement_creation_failed',
                error: error.message,
            };
        }
    }

    /**
     * Update order priority
     */
    async updatePriority(data: OrderPriorityUpdate): Promise<OperationResult> {
        try {
            const order = await this.prisma.order.update({
                where: { id: data.orderId },
                data: {
                    priorityLevel: data.priorityLevel,
                    warehouseNotes: data.reason
                        ? `${(await this.prisma.order.findUnique({ where: { id: data.orderId }, select: { warehouseNotes: true } }))?.warehouseNotes || ''}\n[Priority Update] Level ${data.priorityLevel}: ${data.reason}`.trim()
                        : undefined,
                    lastOperationalUpdateBy: 'NOLIMITS',
                    lastOperationalUpdateAt: new Date(),
                },
            });

            console.log(`[OrderOps] Priority updated for order ${data.orderId} to ${data.priorityLevel}`);

            return {
                success: true,
                orderId: data.orderId,
                action: 'priority_updated',
                details: { newPriority: data.priorityLevel },
            };
        } catch (error: any) {
            return {
                success: false,
                orderId: data.orderId,
                action: 'priority_update_failed',
                error: error.message,
            };
        }
    }

    /**
     * Put order on hold
     */
    async holdOrder(data: OrderHoldData): Promise<OperationResult> {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: data.orderId },
            });

            if (!order) {
                throw new Error(`Order ${data.orderId} not found`);
            }

            // Can't hold orders that are already shipping
            const nonHoldableStates: FulfillmentState[] = [
                'SHIPPED',
                'IN_TRANSIT',
                'OUT_FOR_DELIVERY',
                'DELIVERED',
            ];

            if (nonHoldableStates.includes(order.fulfillmentState)) {
                throw new Error(`Cannot hold order - already ${order.fulfillmentState}`);
            }

            await this.prisma.order.update({
                where: { id: data.orderId },
                data: {
                    isOnHold: true,
                    warehouseNotes: `${order.warehouseNotes || ''}\n[ON HOLD] ${data.holdReason}`.trim(),
                    lastOperationalUpdateBy: 'NOLIMITS',
                    lastOperationalUpdateAt: new Date(),
                },
            });

            console.log(`[OrderOps] Order ${data.orderId} put on hold`);

            return {
                success: true,
                orderId: data.orderId,
                action: 'order_held',
                details: { reason: data.holdReason },
            };
        } catch (error: any) {
            return {
                success: false,
                orderId: data.orderId,
                action: 'hold_failed',
                error: error.message,
            };
        }
    }

    /**
     * Release order from hold
     */
    async releaseOrder(orderId: string, releasedBy: string): Promise<OperationResult> {
        try {
            await this.prisma.order.update({
                where: { id: orderId },
                data: {
                    isOnHold: false,
                    warehouseNotes: (await this.prisma.order.findUnique({
                        where: { id: orderId },
                        select: { warehouseNotes: true },
                    }))?.warehouseNotes + `\n[RELEASED FROM HOLD]`,
                    lastOperationalUpdateBy: 'NOLIMITS',
                    lastOperationalUpdateAt: new Date(),
                },
            });

            console.log(`[OrderOps] Order ${orderId} released from hold`);

            return {
                success: true,
                orderId,
                action: 'order_released',
            };
        } catch (error: any) {
            return {
                success: false,
                orderId,
                action: 'release_failed',
                error: error.message,
            };
        }
    }

    /**
     * Update carrier selection
     */
    async updateCarrier(
        orderId: string,
        carrier: string,
        serviceLevel?: string,
        updatedBy?: string
    ): Promise<OperationResult> {
        try {
            await this.prisma.order.update({
                where: { id: orderId },
                data: {
                    carrierSelection: carrier,
                    carrierServiceLevel: serviceLevel,
                    lastOperationalUpdateBy: 'NOLIMITS',
                    lastOperationalUpdateAt: new Date(),
                },
            });

            console.log(`[OrderOps] Carrier updated for order ${orderId}: ${carrier}`);

            return {
                success: true,
                orderId,
                action: 'carrier_updated',
                details: { carrier, serviceLevel },
            };
        } catch (error: any) {
            return {
                success: false,
                orderId,
                action: 'carrier_update_failed',
                error: error.message,
            };
        }
    }

    // ============= HELPER METHODS =============

    private async queueFFNAddressUpdate(orderId: string): Promise<void> {
        try {
            const { getQueue, QUEUE_NAMES } = await import('../queue/sync-queue.service.js');
            const queue = getQueue();

            await queue.enqueue(
                QUEUE_NAMES.ORDER_SYNC_TO_FFN,
                {
                    orderId,
                    origin: 'nolimits',
                    operation: 'update',
                },
                { priority: 2 }
            );
        } catch (error) {
            console.error(`[OrderOps] Failed to queue FFN address update:`, error);
        }
    }

    private async queueFFNSync(orderId: string): Promise<void> {
        try {
            const { getQueue, QUEUE_NAMES } = await import('../queue/sync-queue.service.js');
            const queue = getQueue();

            await queue.enqueue(
                QUEUE_NAMES.ORDER_SYNC_TO_FFN,
                {
                    orderId,
                    origin: 'nolimits',
                    operation: 'create',
                },
                { priority: 1 }
            );
        } catch (error) {
            console.error(`[OrderOps] Failed to queue FFN sync:`, error);
        }
    }
}

export default OrderOperationsService;
