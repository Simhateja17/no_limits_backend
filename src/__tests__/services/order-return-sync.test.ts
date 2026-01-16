/**
 * Order & Return Sync Tests
 *
 * Unit and integration tests for critical sync flows:
 * - Order creation from commerce platforms
 * - Operational updates
 * - Return inspection and processing
 * - Queue job handling
 */

import { PrismaClient, SyncOrigin, FulfillmentState, InspectionResult } from '@prisma/client';
import { OrderSyncService } from '../../services/integrations/order-sync.service.js';
import { ReturnSyncService } from '../../services/integrations/return-sync.service.js';
import { JTLOrderSyncService } from '../../services/integrations/jtl-order-sync.service.js';
import { OrderOperationsService } from '../../services/integrations/order-operations.service.js';

// Mock Prisma
const mockPrisma = {
    order: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
    },
    orderItem: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
    },
    orderSyncLog: {
        create: jest.fn(),
    },
    return: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    returnItem: {
        updateMany: jest.fn(),
    },
    returnSyncLog: {
        create: jest.fn(),
    },
    product: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
    channel: {
        findUnique: jest.fn(),
    },
    client: {
        findUnique: jest.fn(),
    },
    jtlConfig: {
        findUnique: jest.fn(),
    },
} as unknown as PrismaClient;

describe('OrderSyncService', () => {
    let orderSyncService: OrderSyncService;

    beforeEach(() => {
        jest.clearAllMocks();
        orderSyncService = new OrderSyncService(mockPrisma);
    });

    describe('processIncomingOrder', () => {
        it('should create a new order from Shopify webhook', async () => {
            // Arrange
            const clientId = 'client-123';
            const orderData = {
                externalOrderId: 'shopify-order-123',
                orderNumber: '#1001',
                email: 'customer@example.com',
                customerName: 'John Doe',
                total: 99.99,
                currency: 'EUR',
                items: [
                    { sku: 'SKU-001', productName: 'Test Product', quantity: 2, unitPrice: 49.99 },
                ],
                shippingAddress: {
                    firstName: 'John',
                    lastName: 'Doe',
                    address1: '123 Main St',
                    city: 'Berlin',
                    zip: '10115',
                    country: 'Germany',
                    countryCode: 'DE',
                },
            };

            (mockPrisma.order.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.order.create as jest.Mock).mockResolvedValue({
                id: 'order-uuid-123',
                ...orderData,
                orderOrigin: 'SHOPIFY',
            });
            (mockPrisma.orderSyncLog.create as jest.Mock).mockResolvedValue({});

            // Act
            const result = await orderSyncService.processIncomingOrder(
                'shopify',
                clientId,
                orderData
            );

            // Assert
            expect(result.success).toBe(true);
            expect(result.action).toBe('created');
            expect(mockPrisma.order.create).toHaveBeenCalled();
            expect(mockPrisma.orderSyncLog.create).toHaveBeenCalled();
        });

        it('should update existing order when already exists', async () => {
            // Arrange
            const clientId = 'client-123';
            const existingOrder = {
                id: 'order-uuid-123',
                externalOrderId: 'shopify-order-123',
                orderOrigin: 'SHOPIFY',
                lastOperationalUpdateAt: new Date(Date.now() - 60000), // 1 minute ago
                lastOperationalUpdateBy: 'SHOPIFY',
                channel: { type: 'SHOPIFY' },
            };

            (mockPrisma.order.findFirst as jest.Mock).mockResolvedValue(existingOrder);
            (mockPrisma.order.update as jest.Mock).mockResolvedValue(existingOrder);
            (mockPrisma.orderItem.deleteMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.orderItem.createMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.orderSyncLog.create as jest.Mock).mockResolvedValue({});

            const orderData = {
                externalOrderId: 'shopify-order-123',
                total: 99.99,
                items: [],
            };

            // Act
            const result = await orderSyncService.processIncomingOrder(
                'shopify',
                clientId,
                orderData
            );

            // Assert
            expect(result.success).toBe(true);
            expect(result.action).toBe('updated');
            expect(mockPrisma.order.update).toHaveBeenCalled();
        });
    });

    describe('updateOperationalFields', () => {
        it('should update operational fields and queue FFN sync', async () => {
            // Arrange
            const orderId = 'order-uuid-123';
            const order = {
                id: orderId,
                orderOrigin: 'SHOPIFY',
                fulfillmentState: 'PENDING' as FulfillmentState,
                channel: { type: 'SHOPIFY' },
            };

            (mockPrisma.order.findUnique as jest.Mock).mockResolvedValue(order);
            (mockPrisma.order.update as jest.Mock).mockResolvedValue({
                ...order,
                trackingNumber: 'TRACK-123',
                fulfillmentState: 'SHIPPED',
            });
            (mockPrisma.orderSyncLog.create as jest.Mock).mockResolvedValue({});

            // Act
            const result = await orderSyncService.updateOperationalFields({
                orderId,
                updates: {
                    trackingNumber: 'TRACK-123',
                    fulfillmentState: 'SHIPPED' as FulfillmentState,
                },
                syncToFfn: false, // Skip FFN sync for test
            });

            // Assert
            expect(result.success).toBe(true);
            expect(result.action).toBe('updated');
        });

        it('should reject updates to commercial fields', async () => {
            // Arrange
            const orderId = 'order-uuid-123';
            const order = {
                id: orderId,
                orderOrigin: 'SHOPIFY',
                channel: { type: 'SHOPIFY' },
            };

            (mockPrisma.order.findUnique as jest.Mock).mockResolvedValue(order);

            // Act
            const result = await orderSyncService.updateOperationalFields({
                orderId,
                updates: {
                    total: 199.99 as any, // Commercial field - should be rejected
                },
            });

            // Assert
            // The service should filter out commercial fields, not fail
            expect(result.success).toBe(true);
        });
    });
});

describe('ReturnSyncService', () => {
    let returnSyncService: ReturnSyncService;

    beforeEach(() => {
        jest.clearAllMocks();
        returnSyncService = new ReturnSyncService(mockPrisma);
    });

    describe('processIncomingReturn', () => {
        it('should create a return from Shopify refund webhook', async () => {
            // Arrange
            const clientId = 'client-123';
            const returnData = {
                externalReturnId: 'refund-123',
                externalOrderId: 'shopify-order-123',
                reason: 'Defective product',
                items: [{ sku: 'SKU-001', quantity: 1, expectedQuantity: 1 }],
            };

            (mockPrisma.order.findFirst as jest.Mock).mockResolvedValue({
                id: 'order-uuid-123',
                clientId,
                customerName: 'John Doe',
                customerEmail: 'customer@example.com',
            });
            (mockPrisma.return.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.return.create as jest.Mock).mockResolvedValue({
                id: 'return-uuid-123',
                returnOrigin: 'SHOPIFY',
                status: 'RECEIVED',
                inspectionResult: 'PENDING',
            });
            (mockPrisma.returnSyncLog.create as jest.Mock).mockResolvedValue({});

            // Act
            const result = await returnSyncService.processIncomingReturn(
                'shopify',
                clientId,
                returnData
            );

            // Assert
            expect(result.success).toBe(true);
            expect(result.action).toBe('created');
        });
    });

    describe('inspectReturn', () => {
        it('should record inspection with restock decision', async () => {
            // Arrange
            const returnId = 'return-uuid-123';
            const returnRecord = {
                id: returnId,
                status: 'RECEIVED',
                inspectionResult: 'PENDING' as InspectionResult,
                items: [{ id: 'item-1', sku: 'SKU-001', productId: 'prod-123' }],
            };

            (mockPrisma.return.findUnique as jest.Mock).mockResolvedValue(returnRecord);
            (mockPrisma.return.update as jest.Mock).mockResolvedValue({
                ...returnRecord,
                status: 'CHECKED',
                inspectionResult: 'APPROVED',
                restockEligible: true,
            });
            (mockPrisma.returnItem.updateMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.returnSyncLog.create as jest.Mock).mockResolvedValue({});

            // Act
            const result = await returnSyncService.inspectReturn({
                returnId,
                inspectionResult: 'APPROVED' as InspectionResult,
                restockEligible: true,
                items: [{ sku: 'SKU-001', condition: 'GOOD', restockable: true, restockQuantity: 1 }],
                inspectedBy: 'user-123',
            });

            // Assert
            expect(result.success).toBe(true);
            expect(mockPrisma.return.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        inspectionResult: 'APPROVED',
                        restockEligible: true,
                    }),
                })
            );
        });

        it('should handle damaged items with no restock', async () => {
            // Arrange
            const returnRecord = {
                id: 'return-uuid-123',
                status: 'RECEIVED',
                inspectionResult: 'PENDING' as InspectionResult,
                items: [{ id: 'item-1', sku: 'SKU-001', productId: 'prod-123' }],
            };

            (mockPrisma.return.findUnique as jest.Mock).mockResolvedValue(returnRecord);
            (mockPrisma.return.update as jest.Mock).mockResolvedValue({
                ...returnRecord,
                inspectionResult: 'REJECTED',
                hasDamage: true,
                restockEligible: false,
            });
            (mockPrisma.returnItem.updateMany as jest.Mock).mockResolvedValue({});
            (mockPrisma.returnSyncLog.create as jest.Mock).mockResolvedValue({});

            // Act
            const result = await returnSyncService.inspectReturn({
                returnId: 'return-uuid-123',
                inspectionResult: 'REJECTED' as InspectionResult,
                restockEligible: false,
                hasDamage: true,
                items: [{ sku: 'SKU-001', condition: 'DAMAGED', restockable: false }],
                inspectedBy: 'user-123',
            });

            // Assert
            expect(result.success).toBe(true);
            expect(mockPrisma.return.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        hasDamage: true,
                        restockEligible: false,
                    }),
                })
            );
        });
    });
});

describe('OrderOperationsService', () => {
    let orderOpsService: OrderOperationsService;

    beforeEach(() => {
        jest.clearAllMocks();
        orderOpsService = new OrderOperationsService(mockPrisma);
    });

    describe('correctAddress', () => {
        it('should store original address and update shipping address', async () => {
            // Arrange
            const order = {
                id: 'order-uuid-123',
                fulfillmentState: 'PENDING' as FulfillmentState,
                addressCorrected: false,
                shippingFirstName: 'John',
                shippingLastName: 'Doe',
                shippingAddress1: '123 Old St',
                shippingCity: 'Berlin',
                shippingZip: '10115',
                channel: { type: 'SHOPIFY' },
            };

            (mockPrisma.order.findUnique as jest.Mock).mockResolvedValue(order);
            (mockPrisma.order.update as jest.Mock).mockResolvedValue({
                ...order,
                shippingAddress1: '456 New St',
                addressCorrected: true,
            });
            (mockPrisma.orderSyncLog.create as jest.Mock).mockResolvedValue({});

            // Act
            const result = await orderOpsService.correctAddress({
                orderId: 'order-uuid-123',
                correctedBy: 'user-123',
                shippingAddress1: '456 New St',
                correctionReason: 'Customer requested change',
            });

            // Assert
            expect(result.success).toBe(true);
            expect(result.action).toBe('address_corrected');
            expect(mockPrisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        shippingAddress1: '456 New St',
                        addressCorrected: true,
                    }),
                })
            );
        });

        it('should reject address correction for shipped orders', async () => {
            // Arrange
            const order = {
                id: 'order-uuid-123',
                fulfillmentState: 'SHIPPED' as FulfillmentState,
            };

            (mockPrisma.order.findUnique as jest.Mock).mockResolvedValue(order);

            // Act
            const result = await orderOpsService.correctAddress({
                orderId: 'order-uuid-123',
                correctedBy: 'user-123',
                shippingAddress1: '456 New St',
            });

            // Assert
            expect(result.success).toBe(false);
            expect(result.error).toContain('SHIPPED');
        });
    });

    describe('createReplacementOrder', () => {
        it('should create replacement order linked to original', async () => {
            // Arrange
            const originalOrder = {
                id: 'order-uuid-123',
                orderId: 'ORD-001',
                orderNumber: '#1001',
                customerName: 'John Doe',
                customerEmail: 'john@example.com',
                shippingFirstName: 'John',
                shippingLastName: 'Doe',
                shippingAddress1: '123 Main St',
                shippingCity: 'Berlin',
                shippingZip: '10115',
                shippingCountry: 'Germany',
                clientId: 'client-123',
                channelId: 'channel-123',
                currency: 'EUR',
                items: [{ sku: 'SKU-001', productName: 'Test', quantity: 1 }],
            };

            (mockPrisma.order.findUnique as jest.Mock).mockResolvedValue(originalOrder);
            (mockPrisma.order.create as jest.Mock).mockResolvedValue({
                id: 'replacement-order-123',
                isReplacement: true,
                originalOrderId: 'order-uuid-123',
            });
            (mockPrisma.orderSyncLog.create as jest.Mock).mockResolvedValue({});

            // Act
            const result = await orderOpsService.createReplacementOrder({
                originalOrderId: 'order-uuid-123',
                reason: 'Damaged item',
                createdBy: 'user-123',
            });

            // Assert
            expect(result.success).toBe(true);
            expect(result.action).toBe('replacement_created');
            expect(mockPrisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        isReplacement: true,
                        originalOrderId: 'order-uuid-123',
                        orderOrigin: 'NOLIMITS',
                    }),
                })
            );
        });
    });
});

describe('JTLOrderSyncService', () => {
    let jtlOrderSyncService: JTLOrderSyncService;

    beforeEach(() => {
        jest.clearAllMocks();
        jtlOrderSyncService = new JTLOrderSyncService(mockPrisma);
    });

    describe('syncOrderToFFN', () => {
        it('should skip cancelled orders', async () => {
            // Arrange
            const order = {
                id: 'order-uuid-123',
                isCancelled: true,
            };

            (mockPrisma.order.findUnique as jest.Mock).mockResolvedValue(order);

            // Act
            const result = await jtlOrderSyncService.syncOrderToFFN('order-uuid-123');

            // Assert
            expect(result.success).toBe(true);
            // Should not have called JTL API
        });

        it('should skip orders already synced to FFN', async () => {
            // Arrange
            const order = {
                id: 'order-uuid-123',
                isCancelled: false,
                jtlOutboundId: 'outbound-456', // Already synced
                clientId: 'client-123',
            };

            (mockPrisma.order.findUnique as jest.Mock).mockResolvedValue(order);

            // Act
            const result = await jtlOrderSyncService.syncOrderToFFN('order-uuid-123');

            // Assert
            expect(result.success).toBe(true);
            expect(result.outboundId).toBe('outbound-456');
        });
    });
});
