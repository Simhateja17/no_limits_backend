/**
 * Fulfillment Controller
 * Handles fulfillment operations bridging frontend with JTL FFN
 *
 * Flow: Frontend → Backend Controller → JTL FFN Service → Warehouse
 *                                    → Shopify Service → Commerce
 */

import { Request, Response } from 'express';
import { prisma } from '../config/database.js';
import { JTLService } from '../services/integrations/jtl.service.js';
import { getEncryptionService } from '../services/encryption.service.js';

// Types
interface FulfillmentDashboardStats {
  totalOrders: number;
  pendingFulfillment: number;
  inProgress: number;
  onHold: number;
  shipped: number;
  delivered: number;
  avgFulfillmentTime: number;
  todayShipments: number;
}

interface HoldInput {
  reason: 'AWAITING_PAYMENT' | 'HIGH_RISK_OF_FRAUD' | 'INCORRECT_ADDRESS' | 'INVENTORY_OUT_OF_STOCK' | 'OTHER';
  notes?: string;
}

interface TrackingInput {
  trackingNumber: string;
  carrier: string;
  trackingUrl?: string;
  notifyCustomer?: boolean;
}

interface BulkOperationResult {
  success: boolean;
  processed: number;
  failed: number;
  results: Array<{
    orderId: string;
    success: boolean;
    error?: string;
  }>;
}

// Helper to get JTL service for client
async function getJTLService(clientId: string): Promise<JTLService | null> {
  try {
    const jtlConfig = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: clientId },
    });

    if (!jtlConfig || !jtlConfig.accessToken) {
      return null;
    }

    const encryptionService = getEncryptionService();

    return new JTLService({
      clientId: jtlConfig.clientId,
      clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
      fulfillerId: jtlConfig.fulfillerId,
      warehouseId: jtlConfig.warehouseId,
      environment: (jtlConfig.environment || 'sandbox') as 'sandbox' | 'production',
      accessToken: encryptionService.decrypt(jtlConfig.accessToken),
      refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
      tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
    }, prisma, clientId);
  } catch (error) {
    console.error('[Fulfillment] Failed to get JTL service:', error);
    return null;
  }
}

// Helper to map hold reason to JTL priority
function holdReasonToPriority(reason: string): number {
  const priorityMap: Record<string, number> = {
    'AWAITING_PAYMENT': -5,      // Lowest priority - don't process
    'HIGH_RISK_OF_FRAUD': -5,   // Lowest priority - needs review
    'INCORRECT_ADDRESS': -3,     // Low priority - needs correction
    'INVENTORY_OUT_OF_STOCK': -2, // Low priority - waiting for stock
    'OTHER': -1,                 // Slightly deprioritized
  };
  return priorityMap[reason] || -1;
}

/**
 * GET /api/fulfillment/dashboard/stats
 * Get fulfillment dashboard statistics
 */
export const getDashboardStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const clientFilter = user.role === 'CLIENT' ? { clientId: user.clientId } : {};

    // Parallel queries for performance
    const [
      totalOrders,
      pendingFulfillment,
      inProgress,
      onHold,
      shipped,
      delivered,
      todayShipments,
      avgFulfillmentData,
    ] = await Promise.all([
      // Total orders requiring fulfillment (not cancelled)
      prisma.order.count({
        where: {
          ...clientFilter,
          isCancelled: false,
        },
      }),
      // Pending fulfillment (PENDING or AWAITING_STOCK state)
      prisma.order.count({
        where: {
          ...clientFilter,
          isCancelled: false,
          fulfillmentState: { in: ['PENDING', 'AWAITING_STOCK'] },
          isOnHold: false,
        },
      }),
      // In progress (PROCESSING, PICKING, PACKING)
      prisma.order.count({
        where: {
          ...clientFilter,
          isCancelled: false,
          fulfillmentState: { in: ['READY_FOR_PICKING', 'PICKING', 'PACKING'] },
        },
      }),
      // On hold
      prisma.order.count({
        where: {
          ...clientFilter,
          isOnHold: true,
          isCancelled: false,
        },
      }),
      // Shipped (not yet delivered)
      prisma.order.count({
        where: {
          ...clientFilter,
          fulfillmentState: 'SHIPPED',
          deliveredAt: null,
          isCancelled: false,
        },
      }),
      // Delivered
      prisma.order.count({
        where: {
          ...clientFilter,
          fulfillmentState: 'DELIVERED',
        },
      }),
      // Today's shipments
      prisma.order.count({
        where: {
          ...clientFilter,
          shippedAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      // Average fulfillment time (orders shipped in last 30 days)
      prisma.order.findMany({
        where: {
          ...clientFilter,
          shippedAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
          orderDate: { not: null as any },
        },
        select: {
          orderDate: true,
          shippedAt: true,
        },
      }),
    ]);

    // Calculate average fulfillment time in hours
    let avgFulfillmentTime = 0;
    if (avgFulfillmentData.length > 0) {
      const totalHours = avgFulfillmentData.reduce((acc, order) => {
        if (order.orderDate && order.shippedAt) {
          const diff = order.shippedAt.getTime() - order.orderDate.getTime();
          return acc + diff / (1000 * 60 * 60);
        }
        return acc;
      }, 0);
      avgFulfillmentTime = Math.round(totalHours / avgFulfillmentData.length);
    }

    const stats: FulfillmentDashboardStats = {
      totalOrders,
      pendingFulfillment,
      inProgress,
      onHold,
      shipped,
      delivered,
      avgFulfillmentTime,
      todayShipments,
    };

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[Fulfillment] Error fetching dashboard stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch fulfillment statistics',
    });
  }
};

/**
 * GET /api/fulfillment/orders
 * Get fulfillment orders with filtering and pagination
 */
export const getFulfillmentOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const clientFilter = user.role === 'CLIENT' ? { clientId: user.clientId } : {};

    const {
      status,
      search,
      page = '1',
      limit = '20',
      sortBy = 'orderDate',
      sortOrder = 'desc',
    } = req.query;

    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: any = {
      ...clientFilter,
      isCancelled: false,
    };

    // Status filter
    if (status && status !== 'ALL') {
      switch (status) {
        case 'PENDING':
          where.fulfillmentState = { in: ['PENDING', 'AWAITING_STOCK'] };
          where.isOnHold = false;
          break;
        case 'IN_PROGRESS':
          where.fulfillmentState = { in: ['PROCESSING', 'PICKING', 'PACKING'] };
          break;
        case 'ON_HOLD':
          where.isOnHold = true;
          break;
        case 'SHIPPED':
          where.fulfillmentState = 'SHIPPED';
          break;
        case 'DELIVERED':
          where.fulfillmentState = 'DELIVERED';
          break;
        default:
          where.fulfillmentState = status;
      }
    }

    // Search filter
    if (search) {
      where.OR = [
        { orderId: { contains: search as string, mode: 'insensitive' } },
        { orderNumber: { contains: search as string, mode: 'insensitive' } },
        { customerName: { contains: search as string, mode: 'insensitive' } },
        { customerEmail: { contains: search as string, mode: 'insensitive' } },
        { trackingNumber: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    // Execute queries in parallel
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  sku: true,
                  name: true,
                  images: { take: 1, select: { url: true } },
                },
              },
            },
          },
          client: {
            select: {
              id: true,
              name: true,
              companyName: true,
            },
          },
        },
        orderBy: {
          [sortBy as string]: sortOrder,
        },
        skip,
        take: limitNum,
      }),
      prisma.order.count({ where }),
    ]);

    // Transform orders for frontend
    const transformedOrders = orders.map((order) => ({
      id: order.id,
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      externalOrderId: order.externalOrderId,
      status: order.isOnHold ? 'ON_HOLD' : order.fulfillmentState,
      orderDate: order.orderDate,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      shippingAddress: {
        firstName: order.shippingFirstName,
        lastName: order.shippingLastName,
        company: order.shippingCompany,
        address1: order.shippingAddress1,
        address2: order.shippingAddress2,
        city: order.shippingCity,
        zip: order.shippingZip,
        country: order.shippingCountry,
        countryCode: order.shippingCountryCode,
      },
      items: order.items.map((item) => ({
        id: item.id,
        sku: item.sku,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        productImage: item.product?.images?.[0]?.url,
      })),
      totalItems: order.items.reduce((sum, item) => sum + item.quantity, 0),
      total: order.total,
      currency: order.currency,
      shippingMethod: order.shippingMethod,
      carrier: order.carrierSelection,
      trackingNumber: order.trackingNumber,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
      isOnHold: order.isOnHold,
      holdReason: order.holdReason,
      holdNotes: order.holdNotes,
      warehouseNotes: order.warehouseNotes,
      priorityLevel: order.priorityLevel,
      jtlOutboundId: order.jtlOutboundId,
      client: order.client,
    }));

    res.json({
      success: true,
      data: {
        orders: transformedOrders,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('[Fulfillment] Error fetching orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch fulfillment orders',
    });
  }
};

/**
 * GET /api/fulfillment/orders/:orderId
 * Get single fulfillment order details
 */
export const getFulfillmentOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const user = (req as any).user;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                sku: true,
                name: true,
                images: { take: 1, select: { url: true } },
              },
            },
          },
        },
        client: true,
        syncLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    // Check access for client users
    if (user.role === 'CLIENT' && order.clientId !== user.clientId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error('[Fulfillment] Error fetching order:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch order details',
    });
  }
};

/**
 * POST /api/fulfillment/orders/:orderId/hold
 * Place order on hold
 */
export const holdOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const { reason, notes } = req.body as HoldInput;
    const user = (req as any).user;

    // Validate reason
    const validReasons = ['AWAITING_PAYMENT', 'HIGH_RISK_OF_FRAUD', 'INCORRECT_ADDRESS', 'INVENTORY_OUT_OF_STOCK', 'OTHER'];
    if (!validReasons.includes(reason)) {
      res.status(400).json({
        success: false,
        error: 'Invalid hold reason',
      });
      return;
    }

    // Get order
    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    // Check if already on hold
    if (order.isOnHold) {
      res.status(400).json({
        success: false,
        error: 'Order is already on hold',
      });
      return;
    }

    // Update in JTL FFN (set low priority to effectively hold)
    if (order.jtlOutboundId && order.clientId) {
      const jtlService = await getJTLService(order.clientId);
      if (jtlService) {
        const priority = holdReasonToPriority(reason);
        const internalNote = `HOLD: ${reason}${notes ? ` - ${notes}` : ''}`;

        await jtlService.updateOutbound(order.jtlOutboundId, {
          priority,
          internalNote,
        });
      }
    }

    // Update order
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        isOnHold: true,
        holdReason: reason,
        holdNotes: notes || null,
        holdPlacedAt: new Date(),
        holdPlacedBy: user.id,
        priorityLevel: holdReasonToPriority(reason),
        lastOperationalUpdateBy: 'NOLIMITS',
        lastOperationalUpdateAt: new Date(),
      },
    });

    // Log the action
    await prisma.orderSyncLog.create({
      data: {
        orderId,
        action: 'hold',
        origin: 'NOLIMITS',
        targetPlatform: 'jtl',
        success: true,
        changedFields: ['isOnHold', 'holdReason', 'priorityLevel'],
      },
    });

    res.json({
      success: true,
      message: 'Order placed on hold',
      data: updatedOrder,
    });
  } catch (error) {
    console.error('[Fulfillment] Error placing order on hold:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to place order on hold',
    });
  }
};

/**
 * POST /api/fulfillment/orders/:orderId/release
 * Release order from hold
 */
export const releaseHold = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const user = (req as any).user;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    if (!order.isOnHold) {
      res.status(400).json({
        success: false,
        error: 'Order is not on hold',
      });
      return;
    }

    // Prevent manual release of AWAITING_PAYMENT holds - these are system-managed
    if (order.holdReason === 'AWAITING_PAYMENT') {
      res.status(400).json({
        success: false,
        error: 'Cannot manually release payment hold. Order will be released automatically when payment is confirmed via webhook.',
      });
      return;
    }

    // Update in JTL FFN (restore normal priority)
    if (order.jtlOutboundId && order.clientId) {
      const jtlService = await getJTLService(order.clientId);
      if (jtlService) {
        await jtlService.updateOutbound(order.jtlOutboundId, {
          priority: 0,
          internalNote: 'Hold released - ready for processing',
        });
      }
    }

    // Update order
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        isOnHold: false,
        holdReason: null,
        holdNotes: null,
        holdReleasedAt: new Date(),
        holdReleasedBy: user.id,
        priorityLevel: 0,
        lastOperationalUpdateBy: 'NOLIMITS',
        lastOperationalUpdateAt: new Date(),
      },
    });

    // Log the action
    await prisma.orderSyncLog.create({
      data: {
        orderId,
        action: 'release_hold',
        origin: 'NOLIMITS',
        targetPlatform: 'jtl',
        success: true,
        changedFields: ['isOnHold', 'holdReason', 'priorityLevel'],
      },
    });

    res.json({
      success: true,
      message: 'Order released from hold',
      data: updatedOrder,
    });
  } catch (error) {
    console.error('[Fulfillment] Error releasing order from hold:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to release order from hold',
    });
  }
};

/**
 * POST /api/fulfillment/orders/:orderId/tracking
 * Add or update tracking information
 */
export const updateTracking = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const { trackingNumber, carrier, trackingUrl, notifyCustomer } = req.body as TrackingInput;

    if (!trackingNumber || !carrier) {
      res.status(400).json({
        success: false,
        error: 'Tracking number and carrier are required',
      });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    // Update tracking in JTL FFN via shipping notification
    if (order.jtlOutboundId && order.clientId) {
      const jtlService = await getJTLService(order.clientId);
      if (jtlService) {
        // JTL FFN uses shipping notifications for tracking updates
        // The tracking info is typically provided when the order is shipped
        console.log(`[Fulfillment] Tracking update for JTL outbound ${order.jtlOutboundId}: ${carrier} ${trackingNumber}`);
      }
    }

    // Update order
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        trackingNumber,
        carrierSelection: carrier,
        trackingUrl: trackingUrl || null,
        fulfillmentState: 'SHIPPED',
        shippedAt: order.shippedAt || new Date(),
        lastOperationalUpdateBy: 'NOLIMITS',
        lastOperationalUpdateAt: new Date(),
      },
    });

    // Log the action
    await prisma.orderSyncLog.create({
      data: {
        orderId,
        action: 'update_tracking',
        origin: 'NOLIMITS',
        targetPlatform: 'jtl',
        success: true,
        changedFields: ['trackingNumber', 'carrierSelection', 'fulfillmentState'],
      },
    });

    // TODO: If notifyCustomer is true, trigger notification via Shopify/email
    if (notifyCustomer) {
      console.log(`[Fulfillment] Customer notification requested for order ${orderId}`);
    }

    res.json({
      success: true,
      message: 'Tracking information updated',
      data: updatedOrder,
    });
  } catch (error) {
    console.error('[Fulfillment] Error updating tracking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update tracking information',
    });
  }
};

/**
 * GET /api/fulfillment/orders/:orderId/audit
 * Get order audit trail / history
 */
export const getOrderAudit = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    const auditLogs = await prisma.orderSyncLog.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });

    // Transform logs for frontend timeline display
    const timeline = auditLogs.map((log) => ({
      id: log.id,
      action: log.action,
      origin: log.origin,
      targetPlatform: log.targetPlatform,
      success: log.success,
      errorMessage: log.errorMessage,
      changedFields: log.changedFields,
      timestamp: log.createdAt,
      // Generate human-readable description
      description: generateAuditDescription(log.action, log.origin, log.changedFields),
    }));

    res.json({
      success: true,
      data: timeline,
    });
  } catch (error) {
    console.error('[Fulfillment] Error fetching audit trail:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch audit trail',
    });
  }
};

// Helper to generate human-readable audit descriptions
function generateAuditDescription(action: string, origin: string, changedFields: string[]): string {
  const originName = origin === 'NOLIMITS' ? 'Platform' : origin === 'SHOPIFY' ? 'Shopify' : origin === 'JTL' ? 'JTL FFN' : origin;

  switch (action) {
    case 'create':
      return `Order created from ${originName}`;
    case 'update':
      return `Order updated by ${originName}: ${changedFields.join(', ')}`;
    case 'hold':
      return `Order placed on hold by ${originName}`;
    case 'release_hold':
      return `Order released from hold by ${originName}`;
    case 'update_tracking':
      return `Tracking information updated by ${originName}`;
    case 'fulfill':
      return `Order fulfilled by ${originName}`;
    case 'cancel':
      return `Order cancelled by ${originName}`;
    case 'split':
      return `Order split by ${originName}`;
    default:
      return `${action} by ${originName}`;
  }
}

/**
 * POST /api/fulfillment/orders/:orderId/fulfill
 * Create fulfillment for order
 */
export const createFulfillment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const { trackingNumber, carrier, notifyCustomer } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
      },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    // Check if already fulfilled
    if (order.fulfillmentState === 'SHIPPED' || order.fulfillmentState === 'DELIVERED') {
      res.status(400).json({
        success: false,
        error: 'Order is already fulfilled',
      });
      return;
    }

    // Update order state
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        fulfillmentState: 'SHIPPED',
        trackingNumber: trackingNumber || null,
        carrierSelection: carrier || order.carrierSelection,
        shippedAt: new Date(),
        lastOperationalUpdateBy: 'NOLIMITS',
        lastOperationalUpdateAt: new Date(),
      },
    });

    // Log the action
    await prisma.orderSyncLog.create({
      data: {
        orderId,
        action: 'fulfill',
        origin: 'NOLIMITS',
        targetPlatform: 'jtl',
        success: true,
        changedFields: ['fulfillmentState', 'trackingNumber', 'shippedAt'],
      },
    });

    res.json({
      success: true,
      message: 'Fulfillment created successfully',
      data: {
        orderId,
        fulfillmentState: updatedOrder.fulfillmentState,
        trackingNumber: updatedOrder.trackingNumber,
        shippedAt: updatedOrder.shippedAt,
      },
    });
  } catch (error) {
    console.error('[Fulfillment] Error creating fulfillment:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create fulfillment',
    });
  }
};

/**
 * POST /api/fulfillment/bulk/hold
 * Bulk hold orders
 */
export const bulkHoldOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds, reason, notes } = req.body;
    const user = (req as any).user;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      res.status(400).json({
        success: false,
        error: 'orderIds array is required',
      });
      return;
    }

    const results: BulkOperationResult['results'] = [];
    let processed = 0;
    let failed = 0;

    for (const orderId of orderIds) {
      try {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
        });

        if (!order) {
          results.push({ orderId, success: false, error: 'Order not found' });
          failed++;
          continue;
        }

        if (order.isOnHold) {
          results.push({ orderId, success: false, error: 'Already on hold' });
          failed++;
          continue;
        }

        // Update in JTL FFN
        if (order.jtlOutboundId && order.clientId) {
          const jtlService = await getJTLService(order.clientId);
          if (jtlService) {
            await jtlService.updateOutbound(order.jtlOutboundId, {
              priority: holdReasonToPriority(reason),
              internalNote: `BULK HOLD: ${reason}${notes ? ` - ${notes}` : ''}`,
            });
          }
        }

        await prisma.order.update({
          where: { id: orderId },
          data: {
            isOnHold: true,
            holdReason: reason,
            holdNotes: notes || null,
            holdPlacedAt: new Date(),
            holdPlacedBy: user.id,
            priorityLevel: holdReasonToPriority(reason),
            lastOperationalUpdateBy: 'NOLIMITS',
            lastOperationalUpdateAt: new Date(),
          },
        });

        results.push({ orderId, success: true });
        processed++;
      } catch (error: any) {
        results.push({ orderId, success: false, error: error.message });
        failed++;
      }
    }

    res.json({
      success: failed === 0,
      data: {
        processed,
        failed,
        results,
      },
    });
  } catch (error) {
    console.error('[Fulfillment] Error in bulk hold:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process bulk hold',
    });
  }
};

/**
 * POST /api/fulfillment/bulk/release
 * Bulk release orders from hold
 */
export const bulkReleaseOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds } = req.body;
    const user = (req as any).user;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      res.status(400).json({
        success: false,
        error: 'orderIds array is required',
      });
      return;
    }

    const results: BulkOperationResult['results'] = [];
    let processed = 0;
    let failed = 0;

    for (const orderId of orderIds) {
      try {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
        });

        if (!order) {
          results.push({ orderId, success: false, error: 'Order not found' });
          failed++;
          continue;
        }

        if (!order.isOnHold) {
          results.push({ orderId, success: false, error: 'Not on hold' });
          failed++;
          continue;
        }

        // Skip AWAITING_PAYMENT holds - these are system-managed
        if (order.holdReason === 'AWAITING_PAYMENT') {
          results.push({ orderId, success: false, error: 'Cannot release payment hold - auto-released when payment confirmed' });
          failed++;
          continue;
        }

        // Update in JTL FFN
        if (order.jtlOutboundId && order.clientId) {
          const jtlService = await getJTLService(order.clientId);
          if (jtlService) {
            await jtlService.updateOutbound(order.jtlOutboundId, {
              priority: 0,
              internalNote: 'Bulk release - ready for processing',
            });
          }
        }

        await prisma.order.update({
          where: { id: orderId },
          data: {
            isOnHold: false,
            holdReason: null,
            holdNotes: null,
            holdReleasedAt: new Date(),
            holdReleasedBy: user.id,
            priorityLevel: 0,
            lastOperationalUpdateBy: 'NOLIMITS',
            lastOperationalUpdateAt: new Date(),
          },
        });

        results.push({ orderId, success: true });
        processed++;
      } catch (error: any) {
        results.push({ orderId, success: false, error: error.message });
        failed++;
      }
    }

    res.json({
      success: failed === 0,
      data: {
        processed,
        failed,
        results,
      },
    });
  } catch (error) {
    console.error('[Fulfillment] Error in bulk release:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process bulk release',
    });
  }
};

/**
 * POST /api/fulfillment/bulk/fulfill
 * Bulk fulfill orders
 */
export const bulkFulfillOrders = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderIds, carrier, notifyCustomers } = req.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      res.status(400).json({
        success: false,
        error: 'orderIds array is required',
      });
      return;
    }

    const results: BulkOperationResult['results'] = [];
    let processed = 0;
    let failed = 0;

    for (const orderId of orderIds) {
      try {
        const order = await prisma.order.findUnique({
          where: { id: orderId },
        });

        if (!order) {
          results.push({ orderId, success: false, error: 'Order not found' });
          failed++;
          continue;
        }

        if (order.fulfillmentState === 'SHIPPED' || order.fulfillmentState === 'DELIVERED') {
          results.push({ orderId, success: false, error: 'Already fulfilled' });
          failed++;
          continue;
        }

        if (order.isOnHold) {
          results.push({ orderId, success: false, error: 'Order is on hold' });
          failed++;
          continue;
        }

        await prisma.order.update({
          where: { id: orderId },
          data: {
            fulfillmentState: 'SHIPPED',
            carrierSelection: carrier || order.carrierSelection,
            shippedAt: new Date(),
            lastOperationalUpdateBy: 'NOLIMITS',
            lastOperationalUpdateAt: new Date(),
          },
        });

        await prisma.orderSyncLog.create({
          data: {
            orderId,
            action: 'fulfill',
            origin: 'NOLIMITS',
            targetPlatform: 'jtl',
            success: true,
            changedFields: ['fulfillmentState', 'shippedAt'],
          },
        });

        results.push({ orderId, success: true });
        processed++;
      } catch (error: any) {
        results.push({ orderId, success: false, error: error.message });
        failed++;
      }
    }

    res.json({
      success: failed === 0,
      data: {
        processed,
        failed,
        results,
      },
    });
  } catch (error) {
    console.error('[Fulfillment] Error in bulk fulfill:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process bulk fulfillment',
    });
  }
};

/**
 * POST /api/fulfillment/orders/:orderId/sync-to-jtl
 * Sync order to JTL FFN
 */
export const syncOrderToJTL = async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const user = (req as any).user;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      res.status(404).json({
        success: false,
        error: 'Order not found',
      });
      return;
    }

    // Permission check: Clients can only sync their own orders
    if (user.role === 'CLIENT' && order.clientId !== user.clientId) {
      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
      });
      return;
    }

    if (!order.clientId) {
      res.status(400).json({
        success: false,
        error: 'Order has no associated client',
      });
      return;
    }

    const jtlService = await getJTLService(order.clientId);
    if (!jtlService) {
      res.status(400).json({
        success: false,
        error: 'JTL FFN not configured for this client',
      });
      return;
    }

    // Sync to JTL FFN
    const result = await jtlService.syncOrderToFfn(orderId, prisma);

    if (result.success) {
      res.json({
        success: true,
        message: result.alreadyExisted
          ? 'Order already exists in JTL FFN - synced ID back to database'
          : 'Order synced to JTL FFN',
        data: {
          outboundId: result.outboundId,
          alreadyExisted: result.alreadyExisted || false,
        },
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to sync order to JTL FFN',
      });
    }
  } catch (error) {
    console.error('[Fulfillment] Error syncing to JTL:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync order to JTL FFN',
    });
  }
};

/**
 * GET /api/fulfillment/jtl/status
 * Get JTL FFN connection status
 */
export const getJTLStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;

    // For admin, check all client JTL configs
    // For client, check their own config
    const clientId = user.role === 'CLIENT' ? user.clientId : req.query.clientId as string;

    if (!clientId) {
      res.json({
        success: true,
        data: {
          connected: false,
          message: 'No client specified',
        },
      });
      return;
    }

    const jtlService = await getJTLService(clientId);

    if (!jtlService) {
      res.json({
        success: true,
        data: {
          connected: false,
          message: 'JTL FFN not configured',
        },
      });
      return;
    }

    const testResult = await jtlService.testConnection();

    res.json({
      success: true,
      data: {
        connected: testResult.success,
        message: testResult.message,
      },
    });
  } catch (error) {
    console.error('[Fulfillment] Error checking JTL status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check JTL FFN status',
    });
  }
};

/**
 * GET /api/fulfillment/shipping-methods
 * Get available shipping methods from JTL FFN
 */
export const getShippingMethods = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const clientId = user.role === 'CLIENT' ? user.clientId : req.query.clientId as string;

    if (!clientId) {
      res.status(400).json({
        success: false,
        error: 'Client ID required',
      });
      return;
    }

    const jtlService = await getJTLService(clientId);

    if (!jtlService) {
      res.status(400).json({
        success: false,
        error: 'JTL FFN not configured',
      });
      return;
    }

    const result = await jtlService.getShippingMethods();

    if (result.success) {
      res.json({
        success: true,
        data: result.data,
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to fetch shipping methods',
      });
    }
  } catch (error) {
    console.error('[Fulfillment] Error fetching shipping methods:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch shipping methods',
    });
  }
};

/**
 * GET /api/fulfillment/warehouses
 * Get available warehouses from JTL FFN
 */
export const getWarehouses = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user;
    const clientId = user.role === 'CLIENT' ? user.clientId : req.query.clientId as string;

    if (!clientId) {
      res.status(400).json({
        success: false,
        error: 'Client ID required',
      });
      return;
    }

    const jtlService = await getJTLService(clientId);

    if (!jtlService) {
      res.status(400).json({
        success: false,
        error: 'JTL FFN not configured',
      });
      return;
    }

    const warehouses = await jtlService.getWarehouses();

    res.json({
      success: true,
      data: warehouses,
    });
  } catch (error) {
    console.error('[Fulfillment] Error fetching warehouses:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch warehouses',
    });
  }
};
