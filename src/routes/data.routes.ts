/**
 * Data Routes
 * API endpoints for fetching products, orders, returns, and inbounds
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../config/database.js';
import { authenticate } from '../middleware/auth.js';
import { getQueue, QUEUE_NAMES } from '../services/queue/sync-queue.service.js';
import { enrichProductWithPossibleQuantity } from '../utils/bundle-calculator.js';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/data/products
 * Fetch products for the authenticated user's client
 */
router.get('/products', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { includeBundleDetails } = req.query;

    // Get user with client relation
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // For CLIENT role, filter by their client
    // For ADMIN/EMPLOYEE, show all products
    const whereClause = user.role === 'CLIENT' && user.client
      ? { clientId: user.client.id }
      : {};

    // Use different query structure based on whether bundle details are needed
    const products = includeBundleDetails === 'true'
      ? await prisma.product.findMany({
          where: {
            ...whereClause,
            isActive: true,
          },
          select: {
            id: true,
            productId: true,
            name: true,
            sku: true,
            gtin: true,
            available: true,
            reserved: true,
            announced: true,
            weightInKg: true,
            imageUrl: true,
            jtlProductId: true,
            jtlSyncStatus: true,
            lastJtlSync: true,
            isBundle: true,
            bundlePrice: true,
            clientId: true,
            client: {
              select: {
                companyName: true,
                name: true,
              },
            },
            bundleItems: {
              select: {
                id: true,
                quantity: true,
                childProductId: true,
                childProduct: {
                  select: {
                    id: true,
                    available: true,
                  },
                },
              },
            },
            createdAt: true,
            updatedAt: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        })
      : await prisma.product.findMany({
          where: {
            ...whereClause,
            isActive: true,
          },
          select: {
            id: true,
            productId: true,
            name: true,
            sku: true,
            gtin: true,
            available: true,
            reserved: true,
            announced: true,
            weightInKg: true,
            imageUrl: true,
            jtlProductId: true,
            jtlSyncStatus: true,
            lastJtlSync: true,
            isBundle: true,
            bundlePrice: true,
            clientId: true,
            client: {
              select: {
                companyName: true,
                name: true,
              },
            },
            createdAt: true,
            updatedAt: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

    // Enrich products with possibleQuantity if bundle details were requested
    const enrichedProducts = includeBundleDetails === 'true'
      ? products.map(enrichProductWithPossibleQuantity)
      : products;

    res.json({
      success: true,
      data: enrichedProducts,
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch products',
    });
  }
});

/**
 * GET /api/data/dashboard/chart
 * Fetch processed orders chart data (for admin dashboard)
 * Returns monthly order counts with date range filtering
 */
router.get('/dashboard/chart', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { fromDate, toDate } = req.query;

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Build query filter based on user role
    let clientFilter: any = {};
    if (user.role === 'CLIENT') {
      if (!user.client?.id) {
        return res.status(403).json({
          success: false,
          error: 'Client ID not found',
        });
      }
      clientFilter = { clientId: user.client.id };
    }

    // Default date range: last 12 months
    const endDate = toDate ? new Date(toDate as string) : new Date();
    const startDate = fromDate
      ? new Date(fromDate as string)
      : new Date(endDate.getFullYear(), endDate.getMonth() - 11, 1);

    // Set to start of month for startDate
    startDate.setDate(1);
    startDate.setHours(0, 0, 0, 0);

    // Set to end of month for endDate
    const endOfMonth = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0);
    endOfMonth.setHours(23, 59, 59, 999);

    // Fetch orders within the date range
    const orders = await prisma.order.findMany({
      where: {
        ...clientFilter,
        orderDate: {
          gte: startDate,
          lte: endOfMonth,
        },
        status: {
          in: ['DELIVERED', 'SHIPPED', 'PROCESSING'],
        },
      },
      select: {
        orderDate: true,
      },
    });

    // Group orders by month
    const monthlyData: { [key: string]: number } = {};
    const currentDate = new Date(startDate);

    // Initialize all months with 0
    while (currentDate <= endOfMonth) {
      const monthKey = `${currentDate.toLocaleString('en-US', { month: 'long' }).toLowerCase()}${currentDate.getFullYear()}`;
      monthlyData[monthKey] = 0;
      currentDate.setMonth(currentDate.getMonth() + 1);
    }

    // Count orders per month
    orders.forEach((order) => {
      if (order.orderDate) {
        const date = new Date(order.orderDate);
        const monthKey = `${date.toLocaleString('en-US', { month: 'long' }).toLowerCase()}${date.getFullYear()}`;
        if (monthlyData.hasOwnProperty(monthKey)) {
          monthlyData[monthKey]++;
        }
      }
    });

    // Convert to array format for the chart
    const chartData = Object.entries(monthlyData).map(([monthKey, value]) => ({
      monthKey,
      value,
    }));

    // Also fetch comparison data (previous period)
    const previousStartDate = new Date(startDate);
    previousStartDate.setFullYear(previousStartDate.getFullYear() - 1);
    const previousEndDate = new Date(endOfMonth);
    previousEndDate.setFullYear(previousEndDate.getFullYear() - 1);

    const previousOrders = await prisma.order.findMany({
      where: {
        ...clientFilter,
        orderDate: {
          gte: previousStartDate,
          lte: previousEndDate,
        },
        status: {
          in: ['DELIVERED', 'SHIPPED', 'PROCESSING'],
        },
      },
      select: {
        orderDate: true,
      },
    });

    // Group previous period orders by month (using current year month keys for comparison)
    const referenceData: { monthKey: string; value: number }[] = [];
    const refCurrentDate = new Date(startDate);
    while (refCurrentDate <= endOfMonth) {
      const monthKey = `${refCurrentDate.toLocaleString('en-US', { month: 'long' }).toLowerCase()}${refCurrentDate.getFullYear()}`;
      const refMonthKey = `${refCurrentDate.toLocaleString('en-US', { month: 'long' }).toLowerCase()}${refCurrentDate.getFullYear() - 1}`;

      const count = previousOrders.filter((order) => {
        if (order.orderDate) {
          const date = new Date(order.orderDate);
          return `${date.toLocaleString('en-US', { month: 'long' }).toLowerCase()}${date.getFullYear()}` === refMonthKey;
        }
        return false;
      }).length;

      referenceData.push({ monthKey, value: count });
      refCurrentDate.setMonth(refCurrentDate.getMonth() + 1);
    }

    // Get available month options
    const monthOptions = chartData.map((d) => d.monthKey);

    res.json({
      success: true,
      data: {
        chartData,
        referenceData,
        monthOptions,
        dateRange: {
          from: startDate.toISOString(),
          to: endOfMonth.toISOString(),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching dashboard chart data:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch dashboard chart data',
    });
  }
});

/**
 * GET /api/data/dashboard/events
 * Fetch recent events for the admin dashboard
 * Combines returns, inbounds, and orders needing attention
 */
router.get('/dashboard/events', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { limit = 10 } = req.query;

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const eventLimit = Math.min(parseInt(limit as string) || 10, 50);

    // Build query filters based on user role
    let clientFilter: any = {};
    if (user.role === 'CLIENT') {
      if (!user.client?.id) {
        return res.status(403).json({
          success: false,
          error: 'Client ID not found',
        });
      }
      clientFilter = { clientId: user.client.id };
    }

    // Fetch recent returns
    const recentReturns = await prisma.return.findMany({
      where: clientFilter,
      take: eventLimit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        returnId: true,
        status: true,
        createdAt: true,
        items: {
          select: {
            quantity: true,
          },
        },
      },
    });

    // Fetch recent inbounds
    const recentInbounds = await prisma.inboundDelivery.findMany({
      where: clientFilter,
      take: eventLimit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        inboundId: true,
        status: true,
        createdAt: true,
        items: {
          select: {
            announcedQuantity: true,
            receivedQuantity: true,
          },
        },
      },
    });

    // Fetch orders needing attention (ERROR status or ON_HOLD)
    const ordersNeedingAttention = await prisma.order.findMany({
      where: {
        ...clientFilter,
        OR: [
          { status: 'ERROR' },
          { isOnHold: true },
          { status: 'ON_HOLD' },
        ],
      },
      take: eventLimit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        orderNumber: true,
        externalOrderId: true,
        status: true,
        createdAt: true,
      },
    });

    // Transform into unified event format
    const events: Array<{
      id: string;
      type: 'return' | 'inbound' | 'order_attention';
      entityId: string;
      title: string;
      description: string;
      createdAt: string;
    }> = [];

    // Add return events
    recentReturns.forEach((ret) => {
      const totalItems = ret.items.reduce((sum, item) => sum + item.quantity, 0);
      events.push({
        id: `return-${ret.id}`,
        type: 'return',
        entityId: ret.returnId,
        title: `Return #${ret.returnId.slice(-4)} initiated`,
        description: `${totalItems} item${totalItems !== 1 ? 's' : ''} returned - Status: ${ret.status}`,
        createdAt: ret.createdAt.toISOString(),
      });
    });

    // Add inbound events
    recentInbounds.forEach((inbound) => {
      const totalAnnounced = inbound.items.reduce((sum: number, item: { announcedQuantity: number; receivedQuantity: number | null }) => sum + item.announcedQuantity, 0);
      const totalReceived = inbound.items.reduce((sum: number, item: { announcedQuantity: number; receivedQuantity: number | null }) => sum + (item.receivedQuantity || 0), 0);
      events.push({
        id: `inbound-${inbound.id}`,
        type: 'inbound',
        entityId: inbound.inboundId,
        title: `Inbound #${inbound.inboundId.slice(-4)} booked`,
        description: `${totalReceived}/${totalAnnounced} items received - Status: ${inbound.status}`,
        createdAt: inbound.createdAt.toISOString(),
      });
    });

    // Add orders needing attention
    ordersNeedingAttention.forEach((order) => {
      const orderNum = order.externalOrderId || order.orderNumber || order.orderId;
      events.push({
        id: `order-${order.id}`,
        type: 'order_attention',
        entityId: order.orderId,
        title: `Order #${orderNum.slice(-4)} needs attention`,
        description: `Status: ${order.status} - Manual review required`,
        createdAt: order.createdAt.toISOString(),
      });
    });

    // Sort by date and limit
    events.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const limitedEvents = events.slice(0, eventLimit);

    res.json({
      success: true,
      data: limitedEvents,
    });
  } catch (error) {
    console.error('Error fetching dashboard events:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch dashboard events',
    });
  }
});

/**
 * GET /api/data/dashboard/stats
 * Fetch dashboard statistics for the authenticated client (last 30 days)
 */
router.get('/dashboard/stats', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    // Get user with client relation
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    if (user.role !== 'CLIENT' || !user.client) {
      return res.status(403).json({
        success: false,
        error: 'Only clients can access dashboard stats',
      });
    }

    const clientId = user.client.id;

    // Calculate date 30 days ago
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Get open orders count (orders that are not completed/cancelled/delivered)
    const openOrdersCount = await prisma.order.count({
      where: {
        clientId,
        createdAt: {
          gte: thirtyDaysAgo,
        },
        status: {
          notIn: ['DELIVERED', 'CANCELLED', 'SHIPPED'],
        },
        isCancelled: false,
      },
    });

    // Get error orders count
    const errorOrdersCount = await prisma.order.count({
      where: {
        clientId,
        createdAt: {
          gte: thirtyDaysAgo,
        },
        status: 'ERROR',
      },
    });

    // Calculate click rate (fulfillment success rate)
    // This is the percentage of orders that were successfully fulfilled (delivered) out of all orders
    const totalOrders = await prisma.order.count({
      where: {
        clientId,
        createdAt: {
          gte: thirtyDaysAgo,
        },
      },
    });

    const deliveredOrders = await prisma.order.count({
      where: {
        clientId,
        createdAt: {
          gte: thirtyDaysAgo,
        },
        status: 'DELIVERED',
      },
    });

    const clickRate = totalOrders > 0
      ? ((deliveredOrders / totalOrders) * 100).toFixed(2)
      : '0.00';

    res.json({
      success: true,
      data: {
        openOrders: openOrdersCount,
        errorOrders: errorOrdersCount,
        avgClickRate: `${clickRate}%`,
        period: 'Last 30 Days',
      },
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch dashboard stats',
    });
  }
});

/**
 * GET /api/data/products/:id
 * Fetch a single product by ID
 */
router.get('/products/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Build include clause for product queries
    const includeClause = {
      client: {
        select: {
          companyName: true,
          name: true,
        },
      },
      images: true,
      channels: {
        include: {
          channel: {
            select: {
              name: true,
              type: true,
            },
          },
        },
      },
      bundleItems: {
        include: {
          childProduct: {
            select: { id: true, name: true, sku: true, gtin: true, imageUrl: true, available: true },
          },
        },
        orderBy: { createdAt: 'asc' as const },
      },
    };

    // Try to find by database ID first, then by productId (external ID), then by SKU
    let product = await prisma.product.findUnique({
      where: { id },
      include: includeClause,
    });

    // If not found by ID, try by productId (external ID)
    if (!product) {
      const whereClause: any = { productId: id };
      // For CLIENT users, only search within their own products
      if (user.role === 'CLIENT' && user.client) {
        whereClause.clientId = user.client.id;
      }

      product = await prisma.product.findFirst({
        where: whereClause,
        include: includeClause,
      });
    }

    // If still not found, try by SKU
    if (!product) {
      const whereClause: any = { sku: id };
      // For CLIENT users, only search within their own products
      if (user.role === 'CLIENT' && user.client) {
        whereClause.clientId = user.client.id;
      }

      product = await prisma.product.findFirst({
        where: whereClause,
        include: includeClause,
      });
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found',
      });
    }

    // Check authorization
    if (user.role === 'CLIENT' && product.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Enrich product with possibleQuantity for bundles
    const enrichedProduct = enrichProductWithPossibleQuantity(product);

    res.json({
      success: true,
      data: enrichedProduct,
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch product',
    });
  }
});

/**
 * POST /api/data/products
 * Create a new product and sync to JTL FFN
 */
router.post('/products', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const {
      name,
      manufacturer,
      sku,
      gtin,
      han,
      heightInCm,
      lengthInCm,
      widthInCm,
      weightInKg,
      amazonAsin,
      amazonSku,
      isbn,
      mhd,
      charge,
      zolltarifnummer,
      ursprung,
      nettoVerkaufspreis,
      imageUrl,
    } = req.body;

    // Get user with client relation
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    if (!user.client) {
      return res.status(403).json({
        success: false,
        error: 'User must be associated with a client to create products',
      });
    }

    // Validate required fields
    if (!name || !sku) {
      return res.status(400).json({
        success: false,
        error: 'Product name and SKU are required',
      });
    }

    // Check for duplicate SKU within client
    const existingProduct = await prisma.product.findFirst({
      where: {
        clientId: user.client.id,
        sku,
      },
    });

    if (existingProduct) {
      return res.status(400).json({
        success: false,
        error: 'A product with this SKU already exists',
      });
    }

    // Create the product
    const product = await prisma.product.create({
      data: {
        clientId: user.client.id,
        productId: `NL-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
        name,
        manufacturer,
        sku,
        gtin: gtin || null,
        han: han || null,
        heightInCm: heightInCm ? parseFloat(heightInCm) : null,
        lengthInCm: lengthInCm ? parseFloat(lengthInCm) : null,
        widthInCm: widthInCm ? parseFloat(widthInCm) : null,
        weightInKg: weightInKg ? parseFloat(weightInKg) : null,
        amazonAsin: amazonAsin || null,
        amazonSku: amazonSku || null,
        isbn: isbn || null,
        customsCode: zolltarifnummer || null,
        countryOfOrigin: ursprung || null,
        netSalesPrice: nettoVerkaufspreis ? parseFloat(nettoVerkaufspreis) : null,
        imageUrl: imageUrl || null,
        lastUpdatedBy: 'NOLIMITS',
        syncStatus: 'PENDING',
        available: 0,
        reserved: 0,
        announced: 0,
      },
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
      },
    });

    // Queue product sync to JTL FFN
    try {
      // Check if client has JTL configured
      const jtlConfig = await prisma.jtlConfig.findUnique({
        where: { clientId_fk: user.client.id },
      });

      if (jtlConfig && jtlConfig.isActive) {
        const queue = getQueue();
        await queue.enqueue(
          QUEUE_NAMES.PRODUCT_SYNC_TO_JTL,
          {
            productId: product.id,
            origin: 'nolimits',
          },
          {
            priority: 1,
            retryLimit: 3,
            retryDelay: 60,
            retryBackoff: true,
          }
        );

        // Update product sync status
        await prisma.product.update({
          where: { id: product.id },
          data: { jtlSyncStatus: 'PENDING' },
        });

        console.log(`[DataRoutes] Queued JTL FFN sync for product ${product.sku}`);
      }
    } catch (syncError) {
      // Log but don't fail the product creation
      console.error('[DataRoutes] Failed to queue JTL FFN sync:', syncError);
    }

    res.status(201).json({
      success: true,
      data: product,
    });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create product',
    });
  }
});

/**
 * PUT /api/data/products/:id/bundle
 * Full replacement of bundle configuration
 */
router.put('/products/:id/bundle', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const { isBundle, bundlePrice, items } = req.body as {
      isBundle: boolean;
      bundlePrice?: number | null;
      items: Array<{ childProductId: string; quantity: number }>;
    };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Find the product
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    // Authorization: CLIENT can only edit their own products
    if (user.role === 'CLIENT' && product.clientId !== user.client?.id) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Validate items when bundle is enabled
    if (isBundle && items && items.length > 0) {
      // No self-reference
      if (items.some(i => i.childProductId === id)) {
        return res.status(400).json({ success: false, error: 'A product cannot contain itself as a bundle component' });
      }

      // All children must exist, belong to same client, and not be bundles themselves
      const childProducts = await prisma.product.findMany({
        where: { id: { in: items.map(i => i.childProductId) } },
        select: { id: true, clientId: true, isBundle: true },
      });

      if (childProducts.length !== items.length) {
        return res.status(400).json({ success: false, error: 'One or more component products not found' });
      }

      for (const child of childProducts) {
        if (child.clientId !== product.clientId) {
          return res.status(400).json({ success: false, error: 'Component products must belong to the same client' });
        }
        if (child.isBundle) {
          return res.status(400).json({ success: false, error: 'Nested bundles are not allowed — a component cannot itself be a bundle' });
        }
      }

      // Validate quantities
      if (items.some(i => !i.quantity || i.quantity < 1)) {
        return res.status(400).json({ success: false, error: 'Each component must have a quantity of at least 1' });
      }
    }

    // Transaction: update product + replace bundle items
    const updated = await prisma.$transaction(async (tx) => {
      // Update product flags
      await tx.product.update({
        where: { id },
        data: {
          isBundle,
          bundlePrice: isBundle && bundlePrice != null ? bundlePrice : null,
        },
      });

      // Delete existing bundle items
      await tx.bundleItem.deleteMany({ where: { parentProductId: id } });

      // Create new bundle items if bundle is enabled
      if (isBundle && items && items.length > 0) {
        await tx.bundleItem.createMany({
          data: items.map(i => ({
            parentProductId: id,
            childProductId: i.childProductId,
            quantity: i.quantity,
          })),
        });
      }

      // Return updated product with bundle items
      return tx.product.findUnique({
        where: { id },
        include: {
          bundleItems: {
            include: {
              childProduct: {
                select: { id: true, name: true, sku: true, gtin: true, imageUrl: true, available: true },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
          client: { select: { companyName: true, name: true } },
        },
      });
    });

    // Queue JTL sync for bundle: first sync unsynced child products, then parent
    try {
      const jtlConfig = await prisma.jtlConfig.findUnique({
        where: { clientId_fk: product.clientId },
      });
      if (jtlConfig && jtlConfig.isActive) {
        const queue = getQueue();

        // Queue child product syncs first (higher priority, no delay)
        if (isBundle && items && items.length > 0) {
          const unsyncedChildren = await prisma.product.findMany({
            where: { id: { in: items.map((i: any) => i.childProductId) }, jtlProductId: null },
            select: { id: true, sku: true },
          });
          for (const child of unsyncedChildren) {
            await queue.enqueue(
              QUEUE_NAMES.PRODUCT_SYNC_TO_JTL,
              { productId: child.id, origin: 'nolimits' },
              { priority: 2, retryLimit: 3, retryDelay: 30, retryBackoff: true }
            );
            console.log(`[DataRoutes] Queued JTL sync for child product ${child.sku}`);
          }
        }

        // Queue parent bundle sync with delay to give children a head start
        await queue.enqueue(
          QUEUE_NAMES.PRODUCT_SYNC_TO_JTL,
          { productId: product.id, origin: 'nolimits' },
          { priority: 1, retryLimit: 3, retryDelay: 60, retryBackoff: true, startAfter: 15 }
        );
        console.log(`[DataRoutes] Queued JTL FFN bundle sync for product ${product.sku} (15s delay)`);
      }
    } catch (syncError) {
      console.error('[DataRoutes] Failed to queue JTL bundle sync:', syncError);
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating bundle:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update bundle',
    });
  }
});

/**
 * GET /api/data/products/:id/bundle/search
 * Search for products to add as bundle components
 */
router.get('/products/:id/bundle/search', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const q = (req.query.q as string || '').trim();

    if (!q || q.length < 1) {
      return res.json({ success: true, data: [] });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Get the parent product to determine client scope
    const parentProduct = await prisma.product.findUnique({
      where: { id },
      select: { clientId: true },
    });

    if (!parentProduct) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    // Authorization
    if (user.role === 'CLIENT' && parentProduct.clientId !== user.client?.id) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const results = await prisma.product.findMany({
      where: {
        clientId: parentProduct.clientId,
        isActive: true,
        isBundle: false,
        id: { not: id },
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        name: true,
        sku: true,
        gtin: true,
        imageUrl: true,
        available: true,
      },
      take: 10,
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Error searching bundle components:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to search products',
    });
  }
});

/**
 * POST /api/data/orders
 * Create a new order for the authenticated user's client
 */
router.post('/orders', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const {
      orderId,
      items,
      shippingMethod,
      shippingFirstName,
      shippingLastName,
      shippingCompany,
      shippingAddress1,
      shippingAddress2,
      shippingCity,
      shippingZip,
      shippingCountry,
      shippingCountryCode,
      notes,
      tags,
      isOnHold,
    } = req.body;

    // Get user with client relation
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    if (!user.client) {
      return res.status(403).json({
        success: false,
        error: 'User must be associated with a client to create orders',
      });
    }

    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one order item is required',
      });
    }

    // Generate order ID if not provided
    const finalOrderId = orderId || `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Calculate total weight from products
    let totalWeight = 0;
    let totalQuantity = 0;

    // Validate products and calculate totals
    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({
          success: false,
          error: 'Each item must have a valid productId and quantity',
        });
      }

      const product = await prisma.product.findUnique({
        where: { id: item.productId },
      });

      if (!product) {
        return res.status(400).json({
          success: false,
          error: `Product not found: ${item.productId}`,
        });
      }

      // Verify product belongs to the same client
      if (product.clientId !== user.client.id) {
        return res.status(403).json({
          success: false,
          error: 'Cannot add products from another client',
        });
      }

      totalQuantity += item.quantity;
      if (product.weightInKg) {
        totalWeight += Number(product.weightInKg) * item.quantity;
      }
    }

    // Create the order with items
    const order = await prisma.order.create({
      data: {
        orderId: finalOrderId,
        orderNumber: finalOrderId,
        clientId: user.client.id,
        status: isOnHold ? 'ON_HOLD' : 'PENDING',
        orderOrigin: 'NOLIMITS',
        orderState: isOnHold ? 'ON_HOLD' : 'PENDING',
        fulfillmentState: 'PENDING',
        shippingMethod,
        shippingFirstName,
        shippingLastName,
        shippingCompany,
        shippingAddress1,
        shippingAddress2,
        shippingCity,
        shippingZip,
        shippingCountry,
        shippingCountryCode,
        notes,
        tags: tags || [],
        isOnHold: isOnHold || false,
        totalWeight,
        totalQuantity,
        items: {
          create: items.map((item: { productId: string; quantity: number; sku?: string; productName?: string }) => ({
            productId: item.productId,
            quantity: item.quantity,
            sku: item.sku,
            productName: item.productName,
          })),
        },
      },
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                name: true,
                sku: true,
                gtin: true,
              },
            },
          },
        },
        channel: {
          select: {
            name: true,
            type: true,
          },
        },
      },
    });

    // Queue order sync to JTL FFN if not on hold
    if (!isOnHold) {
      try {
        // Check if client has JTL configured
        const jtlConfig = await prisma.jtlConfig.findUnique({
          where: { clientId_fk: user.client.id },
        });

        if (jtlConfig && jtlConfig.isActive) {
          const queue = getQueue();
          await queue.enqueue(
            QUEUE_NAMES.ORDER_SYNC_TO_FFN,
            {
              orderId: order.id,
              origin: 'nolimits',
              operation: 'create',
            },
            {
              priority: 1,
              retryLimit: 3,
              retryDelay: 60,
              retryBackoff: true,
            }
          );

          // Update order sync status
          await prisma.order.update({
            where: { id: order.id },
            data: { syncStatus: 'PENDING' },
          });

          console.log(`[DataRoutes] Queued JTL FFN sync for order ${order.orderId}`);
        }
      } catch (syncError) {
        // Log but don't fail the order creation
        console.error('[DataRoutes] Failed to queue JTL FFN sync:', syncError);
      }
    }

    res.status(201).json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create order',
    });
  }
});

/**
 * GET /api/data/orders
 * Fetch orders for the authenticated user's client
 */
router.get('/orders', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const whereClause = user.role === 'CLIENT' && user.client
      ? { clientId: user.client.id }
      : {};

    const orders = await prisma.order.findMany({
      where: whereClause,
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                name: true,
                sku: true,
              },
            },
          },
        },
        channel: {
          select: {
            name: true,
            type: true,
          },
        },
      },
      orderBy: {
        orderDate: 'desc',
      },
    });

    res.json({
      success: true,
      data: orders,
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch orders',
    });
  }
});

/**
 * GET /api/data/orders/:id
 * Fetch a single order by ID
 */
router.get('/orders/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: true,
          },
        },
        channel: true,
        syncLogs: {
          orderBy: {
            createdAt: 'asc',
          },
          select: {
            id: true,
            action: true,
            origin: true,
            targetPlatform: true,
            changedFields: true,
            previousState: true,
            newState: true,
            success: true,
            createdAt: true,
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Check authorization
    if (user.role === 'CLIENT' && order.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch order',
    });
  }
});

/**
 * GET /api/data/returns
 * Fetch returns for the authenticated user's client
 */
router.get('/returns', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const whereClause = user.role === 'CLIENT' && user.client
      ? { clientId: user.client.id }
      : {};

    const returns = await prisma.return.findMany({
      where: whereClause,
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        order: {
          select: {
            orderId: true,
            orderNumber: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                name: true,
                sku: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({
      success: true,
      data: returns,
    });
  } catch (error) {
    console.error('Error fetching returns:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch returns',
    });
  }
});

/**
 * GET /api/data/returns/:id
 * Fetch a single return by ID
 */
router.get('/returns/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const returnData = await prisma.return.findUnique({
      where: { id },
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        order: true,
        items: {
          include: {
            product: true,
            images: true,
          },
        },
        images: true,
      },
    });

    if (!returnData) {
      return res.status(404).json({
        success: false,
        error: 'Return not found',
      });
    }

    // Check authorization
    if (user.role === 'CLIENT' && returnData.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    res.json({
      success: true,
      data: returnData,
    });
  } catch (error) {
    console.error('Error fetching return:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch return',
    });
  }
});

/**
 * POST /api/data/returns
 * Create a new return for the authenticated user's client
 */
router.post('/returns', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const {
      orderId,
      reason,
      reasonCategory,
      customerName,
      customerEmail,
      notes,
      warehouseNotes,
      items,
    } = req.body;

    // Get user with client relation
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Only ADMIN, SUPER_ADMIN, and EMPLOYEE can create returns
    // CLIENT users cannot create returns
    if (user.role === 'CLIENT') {
      return res.status(403).json({
        success: false,
        error: 'Clients are not authorized to create returns. Please contact support.',
      });
    }

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one return item is required',
      });
    }

    // Validate that at least one item has sku or productName
    const validItems = items.filter((item: any) => item.sku || item.productName);
    if (validItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one item must have a SKU or product name',
      });
    }

    // Generate a unique return ID
    const returnIdDisplay = `RET-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // If orderId is provided, try to find the order and get its clientId
    let orderRecord = null;
    let clientId: string | null = null;
    if (orderId) {
      orderRecord = await prisma.order.findFirst({
        where: {
          OR: [
            { id: orderId },
            { orderId: orderId },
            { externalOrderId: orderId },
          ],
        },
      });
      // If order found, use order's clientId
      if (orderRecord) {
        clientId = orderRecord.clientId;
      }
    }

    // Create the return with items
    const returnRecord = await prisma.return.create({
      data: {
        returnId: returnIdDisplay,
        clientId: clientId,
        orderId: orderRecord?.id || null,
        externalOrderId: orderId || null,
        reason: reason || null,
        reasonCategory: reasonCategory || null,
        customerName: customerName || null,
        customerEmail: customerEmail || null,
        notes: notes || null,
        warehouseNotes: warehouseNotes || null,
        status: 'ANNOUNCED',
        returnOrigin: 'NOLIMITS',
        syncStatus: 'PENDING',
        items: {
          create: validItems.map((item: any) => ({
            sku: item.sku || null,
            productName: item.productName || null,
            quantity: item.quantity || 1,
            condition: item.condition || 'GOOD',
            disposition: 'PENDING_DECISION',
          })),
        },
      },
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        order: true,
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    res.status(201).json({
      success: true,
      data: returnRecord,
    });
  } catch (error) {
    console.error('Error creating return:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create return',
    });
  }
});

/**
 * GET /api/data/inbounds
 * Fetch inbound deliveries for the authenticated user's client
 */
router.get('/inbounds', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const whereClause = user.role === 'CLIENT' && user.client
      ? { clientId: user.client.id }
      : {};

    const inbounds = await prisma.inboundDelivery.findMany({
      where: whereClause,
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                name: true,
                sku: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({
      success: true,
      data: inbounds,
    });
  } catch (error) {
    console.error('Error fetching inbounds:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch inbounds',
    });
  }
});

/**
 * GET /api/data/inbounds/:id
 * Fetch a single inbound delivery by ID
 */
router.get('/inbounds/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const inbound = await prisma.inboundDelivery.findUnique({
      where: { id },
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!inbound) {
      return res.status(404).json({
        success: false,
        error: 'Inbound delivery not found',
      });
    }

    // Check authorization
    if (user.role === 'CLIENT' && inbound.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    res.json({
      success: true,
      data: inbound,
    });
  } catch (error) {
    console.error('Error fetching inbound:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch inbound',
    });
  }
});

/**
 * POST /api/data/inbounds
 * Create a new inbound delivery
 */
router.post('/inbounds', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const {
      deliveryType,
      expectedDate,
      carrierName,
      trackingNumber,
      notes,
      simulateStock,
      items, // Array of { productId, quantity }
    } = req.body;

    console.log('[Inbound] ========== CREATE INBOUND REQUEST ==========');
    console.log('[Inbound] User ID:', userId);
    console.log('[Inbound] Request body:', JSON.stringify({
      deliveryType,
      expectedDate,
      carrierName,
      trackingNumber,
      notes,
      simulateStock,
      itemsCount: items?.length,
      items,
    }, null, 2));

    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      console.log('[Inbound] ERROR: No items provided');
      return res.status(400).json({
        success: false,
        error: 'At least one product is required',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user || !user.client) {
      console.log('[Inbound] ERROR: User or client not found for userId:', userId);
      return res.status(404).json({
        success: false,
        error: 'User or client not found',
      });
    }

    const clientId = user.client.id;
    console.log('[Inbound] Client ID:', clientId, '| Company:', user.client.companyName);

    // Generate inbound ID
    const count = await prisma.inboundDelivery.count({
      where: { clientId },
    });
    const inboundId = `INB-${String(count + 1).padStart(5, '0')}`;

    // Calculate total announced quantity
    const totalQuantity = items.reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0);

    // Map delivery type to valid enum value
    const validDeliveryTypes = ['FREIGHT_FORWARDER', 'PARCEL_SERVICE', 'SELF_DELIVERY', 'OTHER'];
    const mappedDeliveryType = validDeliveryTypes.includes(deliveryType?.toUpperCase())
      ? deliveryType.toUpperCase()
      : 'PARCEL_SERVICE';
    console.log('[Inbound] Mapped delivery type:', deliveryType, '->', mappedDeliveryType);

    // Create the inbound delivery with items
    console.log('[Inbound] Creating inbound in database...');
    const inbound = await prisma.inboundDelivery.create({
      data: {
        inboundId,
        clientId,
        deliveryType: mappedDeliveryType as any,
        expectedDate: expectedDate ? new Date(expectedDate) : null,
        carrierName: carrierName || null,
        trackingNumber: trackingNumber || null,
        notes: notes || null,
        simulateStock: simulateStock || false,
        announcedQuantity: totalQuantity,
        numberOfProducts: items.length,
        status: 'PENDING',
        items: {
          create: items.map((item: { productId: string; quantity: number }) => ({
            productId: item.productId,
            announcedQuantity: item.quantity,
          })),
        },
      },
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                name: true,
                sku: true,
              },
            },
          },
        },
      },
    });

    console.log('[Inbound] ✓ Inbound created in database');
    console.log('[Inbound] Inbound ID:', inbound.inboundId);
    console.log('[Inbound] Database ID:', inbound.id);
    console.log('[Inbound] Items created:', inbound.items.length);

    // Sync to JTL FFN if configured
    let jtlSyncResult = null;
    let jtlInboundId = null;

    try {
      // Check if client has JTL configured
      console.log('[Inbound] Checking JTL FFN configuration for client...');
      const jtlConfig = await prisma.jtlConfig.findUnique({
        where: { clientId_fk: clientId },
      });

      console.log('[Inbound] JTL Config found:', jtlConfig ? 'Yes' : 'No');
      if (jtlConfig) {
        console.log('[Inbound] JTL Config active:', jtlConfig.isActive);
        console.log('[Inbound] JTL Warehouse ID:', jtlConfig.warehouseId || 'NOT SET');
      }

      if (jtlConfig && jtlConfig.isActive && jtlConfig.warehouseId) {
        const { getEncryptionService } = await import('../services/encryption.service.js');
        const { JTLService } = await import('../services/integrations/jtl.service.js');

        const encryptionService = getEncryptionService();
        const jtlService = new JTLService({
          clientId: jtlConfig.clientId,
          clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
          accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
          refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
          tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        });

        // Get products with their JTL product IDs (jfsku)
        console.log('[JTL] Fetching products with JTL IDs...');
        const productIds = items.map((item: { productId: string }) => item.productId);
        const products = await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, jtlProductId: true, sku: true },
        });
        console.log('[JTL] Products found:', products.length);
        console.log('[JTL] Products with JTL IDs:', products.filter(p => p.jtlProductId).length);
        products.forEach(p => {
          console.log(`[JTL]   - SKU: ${p.sku}, JTL ID: ${p.jtlProductId || 'NOT SET'}`);
        });

        // Build JTL inbound items
        const jtlItems = items.map((item: { productId: string; quantity: number }, index: number) => {
          const product = products.find(p => p.id === item.productId);
          return {
            inboundItemId: `${inboundId}-ITEM-${index + 1}`,
            jfsku: product?.jtlProductId || '',
            merchantSku: product?.sku || '',
            quantity: item.quantity,
          };
        }).filter(item => item.jfsku); // Only include items with valid jfsku

        console.log('[JTL] JTL items to sync:', jtlItems.length);

        if (jtlItems.length > 0) {
          // Create inbound in JTL FFN
          const jtlInbound = {
            merchantInboundNumber: inboundId,
            warehouseId: jtlConfig.warehouseId,
            items: jtlItems,
            note: notes || undefined,
          };

          console.log('[JTL] Creating inbound:', JSON.stringify(jtlInbound, null, 2));

          const jtlResponse = await jtlService.createInbound(jtlInbound);
          jtlInboundId = jtlResponse.inboundId;
          jtlSyncResult = { success: true, inboundId: jtlInboundId };

          console.log('[JTL] Inbound created successfully:', jtlInboundId);

          // Update our inbound with JTL ID
          await prisma.inboundDelivery.update({
            where: { id: inbound.id },
            data: {
              jtlDeliveryId: jtlInboundId,
              lastJtlSync: new Date(),
            },
          });
          console.log('[JTL] ✓ Database updated with JTL inbound ID');
        } else {
          console.log('[JTL] No products with JTL IDs found, skipping JTL sync');
        }
      } else {
        console.log('[JTL] JTL FFN sync skipped - not configured or inactive');
      }
    } catch (jtlError: any) {
      console.error('[JTL] Error syncing inbound to JTL FFN:', jtlError);
      console.error('[JTL] Error details:', jtlError.stack || jtlError);
      jtlSyncResult = { success: false, error: jtlError.message };
      // Don't fail the request - the local inbound was created successfully
    }

    console.log('[Inbound] ========== CREATE INBOUND COMPLETE ==========');
    console.log('[Inbound] Inbound ID:', inbound.inboundId);
    console.log('[Inbound] JTL Sync:', jtlSyncResult ? (jtlSyncResult.success ? '✓ Success' : '✗ Failed') : 'Skipped');
    if (jtlInboundId) {
      console.log('[Inbound] JTL Inbound ID:', jtlInboundId);
    }

    res.status(201).json({
      success: true,
      data: {
        ...inbound,
        jtlDeliveryId: jtlInboundId,
      },
      jtlSync: jtlSyncResult,
    });
  } catch (error) {
    console.error('[Inbound] ========== CREATE INBOUND FAILED ==========');
    console.error('[Inbound] Error creating inbound:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create inbound',
    });
  }
});

/**
 * PATCH /api/data/inbounds/:id
 * Update inbound delivery details
 */
router.patch('/inbounds/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const {
      deliveryType,
      expectedDate,
      carrierName,
      trackingNumber,
      notes,
      externalInboundId,
    } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const inbound = await prisma.inboundDelivery.findUnique({
      where: { id },
    });

    if (!inbound) {
      return res.status(404).json({
        success: false,
        error: 'Inbound delivery not found',
      });
    }

    // Check authorization
    if (user.role === 'CLIENT' && inbound.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Build update data
    const updateData: any = {};
    if (deliveryType !== undefined) {
      const validDeliveryTypes = ['FREIGHT_FORWARDER', 'PARCEL_SERVICE', 'SELF_DELIVERY', 'OTHER'];
      updateData.deliveryType = validDeliveryTypes.includes(deliveryType?.toUpperCase())
        ? deliveryType.toUpperCase()
        : inbound.deliveryType;
    }
    if (expectedDate !== undefined) updateData.expectedDate = expectedDate ? new Date(expectedDate) : null;
    if (carrierName !== undefined) updateData.carrierName = carrierName || null;
    if (trackingNumber !== undefined) updateData.trackingNumber = trackingNumber || null;
    if (notes !== undefined) updateData.notes = notes || null;
    if (externalInboundId !== undefined) updateData.externalInboundId = externalInboundId || null;

    const updatedInbound = await prisma.inboundDelivery.update({
      where: { id },
      data: updateData,
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    res.json({
      success: true,
      data: updatedInbound,
    });
  } catch (error) {
    console.error('[DataRoutes] Error updating inbound:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update inbound',
    });
  }
});

// ============= EDIT ROUTES WITH JTL FFN SYNC =============

/**
 * PATCH /api/data/orders/:id
 * Update operational fields of an order and sync to JTL FFN
 * 
 * Operational fields (editable):
 * - warehouseNotes, carrierSelection, carrierServiceLevel
 * - priorityLevel, pickingInstructions, packingInstructions
 * - isOnHold, tags
 * - Shipping address corrections (before fulfillment)
 */
router.patch('/orders/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const {
      warehouseNotes,
      carrierSelection,
      carrierServiceLevel,
      priorityLevel,
      pickingInstructions,
      packingInstructions,
      isOnHold,
      tags,
      shippingFirstName,
      shippingLastName,
      shippingCompany,
      shippingAddress1,
      shippingAddress2,
      shippingCity,
      shippingZip,
      shippingCountryCode,
      jtlShippingMethodId,
      items,
    } = req.body;

    console.log('[DataRoutes] PATCH /orders/:id - Received update request:', { id, body: req.body });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: { client: true },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Check authorization
    if (user.role === 'CLIENT' && order.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Check if order can be edited (not shipped/delivered/cancelled)
    const nonEditableStatuses = ['SHIPPED', 'DELIVERED', 'CANCELLED'];
    if (nonEditableStatuses.includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot edit order in status ${order.status}`,
      });
    }

    // CLIENT users: cannot edit once warehouse picking starts
    if (user.role === 'CLIENT') {
      const clientEditableFulfillmentStates = ['PENDING', 'PREPARATION', 'ACKNOWLEDGED', 'LOCKED'];
      if (order.fulfillmentState && !clientEditableFulfillmentStates.includes(order.fulfillmentState)) {
        return res.status(400).json({
          success: false,
          error: 'Cannot edit order — it is currently being processed in the warehouse',
        });
      }
    }

    // Track which fields changed for sync
    const changedFields: string[] = [];
    const updateData: any = {
      lastOperationalUpdateAt: new Date(),
      lastOperationalUpdateBy: 'NOLIMITS',
    };

    // Build update data and track changes
    if (warehouseNotes !== undefined && warehouseNotes !== order.warehouseNotes) {
      updateData.warehouseNotes = warehouseNotes;
      changedFields.push('warehouseNotes');
    }
    if (carrierSelection !== undefined && carrierSelection !== order.carrierSelection) {
      updateData.carrierSelection = carrierSelection;
      changedFields.push('carrierSelection');
    }
    if (carrierServiceLevel !== undefined && carrierServiceLevel !== order.carrierServiceLevel) {
      updateData.carrierServiceLevel = carrierServiceLevel;
      changedFields.push('carrierServiceLevel');
    }
    if (priorityLevel !== undefined && priorityLevel !== order.priorityLevel) {
      updateData.priorityLevel = priorityLevel;
      changedFields.push('priorityLevel');
    }
    if (pickingInstructions !== undefined && pickingInstructions !== order.pickingInstructions) {
      updateData.pickingInstructions = pickingInstructions;
      changedFields.push('pickingInstructions');
    }
    if (packingInstructions !== undefined && packingInstructions !== order.packingInstructions) {
      updateData.packingInstructions = packingInstructions;
      changedFields.push('packingInstructions');
    }
    if (isOnHold !== undefined && isOnHold !== order.isOnHold) {
      updateData.isOnHold = isOnHold;
      updateData.status = isOnHold ? 'ON_HOLD' : (order.status === 'ON_HOLD' ? 'PENDING' : order.status);
      changedFields.push('isOnHold');
    }
    if (tags !== undefined) {
      updateData.tags = tags;
      changedFields.push('tags');
    }
    if (jtlShippingMethodId !== undefined && jtlShippingMethodId !== order.jtlShippingMethodId) {
      updateData.jtlShippingMethodId = jtlShippingMethodId;
      updateData.shippingMethodMismatch = false;
      changedFields.push('jtlShippingMethodId');
    }

    // Handle shipping address corrections
    const addressFields = {
      shippingFirstName,
      shippingLastName,
      shippingCompany,
      shippingAddress1,
      shippingAddress2,
      shippingCity,
      shippingZip,
      shippingCountryCode,
    };

    let addressChanged = false;
    for (const [field, value] of Object.entries(addressFields)) {
      if (value !== undefined && value !== (order as any)[field]) {
        updateData[field] = value;
        changedFields.push(field);
        addressChanged = true;
      }
    }

    if (addressChanged) {
      updateData.addressCorrected = true;
      updateData.addressCorrectedAt = new Date();
      // Store original address if not already stored
      if (!order.originalShippingAddress) {
        updateData.originalShippingAddress = JSON.stringify({
          shippingFirstName: order.shippingFirstName,
          shippingLastName: order.shippingLastName,
          shippingCompany: order.shippingCompany,
          shippingAddress1: order.shippingAddress1,
          shippingAddress2: order.shippingAddress2,
          shippingCity: order.shippingCity,
          shippingZip: order.shippingZip,
          shippingCountryCode: order.shippingCountryCode,
        });
      }
    }

    // Handle order items updates
    if (items && Array.isArray(items)) {
      console.log('[DataRoutes] PATCH /orders/:id - Processing items update:', items);

      // Get current order items
      const currentItems = await prisma.orderItem.findMany({
        where: { orderId: id },
      });

      const currentItemsMap = new Map(currentItems.map(item => [item.id, item]));
      const providedItemIds = new Set(items.filter((item: any) => item.id).map((item: any) => item.id));

      // Update or create items
      for (const item of items) {
        if (item.id) {
          // Update existing item
          const currentItem = currentItemsMap.get(item.id);
          if (currentItem && currentItem.quantity !== item.quantity) {
            await prisma.orderItem.update({
              where: { id: item.id },
              data: { quantity: item.quantity },
            });
            changedFields.push(`item_${item.id}_quantity`);
            console.log(`[DataRoutes] Updated item ${item.id} quantity: ${currentItem.quantity} -> ${item.quantity}`);
          }
        } else if (item.productId || item.sku) {
          // Create new item
          await prisma.orderItem.create({
            data: {
              orderId: id,
              productId: item.productId || undefined,
              sku: item.sku || undefined,
              productName: item.productName || undefined,
              quantity: item.quantity || 1,
              unitPrice: item.unitPrice || undefined,
              totalPrice: item.totalPrice || undefined,
            },
          });
          changedFields.push('items_added');
          console.log(`[DataRoutes] Added new item to order: ${item.productName || item.sku}`);
        }
      }

      // Delete items that are no longer present
      for (const currentItem of currentItems) {
        if (!providedItemIds.has(currentItem.id)) {
          await prisma.orderItem.delete({
            where: { id: currentItem.id },
          });
          changedFields.push(`item_${currentItem.id}_deleted`);
          console.log(`[DataRoutes] Deleted item ${currentItem.id} from order`);
        }
      }
    }

    // Update order in database
    console.log('[DataRoutes] PATCH /orders/:id - Updating with data:', { id, updateData, changedFields });
    const updatedOrder = await prisma.order.update({
      where: { id },
      data: updateData,
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                name: true,
                sku: true,
              },
            },
          },
        },
      },
    });
    console.log('[DataRoutes] PATCH /orders/:id - Order updated successfully:', updatedOrder.id);

    // Log the update
    await prisma.orderSyncLog.create({
      data: {
        orderId: id,
        action: 'update',
        origin: 'NOLIMITS',
        targetPlatform: 'nolimits',
        success: true,
        changedFields,
      },
    });

    // Sync to JTL FFN if order is already synced there
    let jtlSyncResult = null;
    if (order.jtlOutboundId && changedFields.length > 0) {
      try {
        // Check if client has JTL configured
        const jtlConfig = await prisma.jtlConfig.findUnique({
          where: { clientId_fk: order.clientId },
        });

        if (jtlConfig && jtlConfig.isActive) {
          const { getEncryptionService } = await import('../services/encryption.service.js');
          const { JTLService } = await import('../services/integrations/jtl.service.js');
          
          const encryptionService = getEncryptionService();
          const jtlService = new JTLService({
            clientId: jtlConfig.clientId,
            clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
            accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
            refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
            tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
            environment: jtlConfig.environment as 'sandbox' | 'production',
          });

          // Build JTL update payload
          const jtlUpdateData: any = {};
          
          if (changedFields.includes('priorityLevel')) {
            jtlUpdateData.priority = priorityLevel;
          }
          if (changedFields.includes('warehouseNotes') || changedFields.includes('pickingInstructions')) {
            jtlUpdateData.internalNote = [warehouseNotes, pickingInstructions].filter(Boolean).join('\n');
          }
          if (changedFields.includes('jtlShippingMethodId')) {
            jtlUpdateData.shippingMethodId = jtlShippingMethodId;
          }
          if (addressChanged) {
            jtlUpdateData.shippingAddress = {
              name: `${updateData.shippingFirstName || order.shippingFirstName} ${updateData.shippingLastName || order.shippingLastName}`.trim(),
              company: updateData.shippingCompany || order.shippingCompany,
              street: updateData.shippingAddress1 || order.shippingAddress1,
              additionalAddress: updateData.shippingAddress2 || order.shippingAddress2,
              city: updateData.shippingCity || order.shippingCity,
              zip: updateData.shippingZip || order.shippingZip,
              countryCode: updateData.shippingCountryCode || order.shippingCountryCode,
            };
          }

          if (Object.keys(jtlUpdateData).length > 0) {
            jtlSyncResult = await jtlService.updateOutbound(order.jtlOutboundId, jtlUpdateData);

            // Log JTL sync
            await prisma.orderSyncLog.create({
              data: {
                orderId: id,
                action: 'update',
                origin: 'NOLIMITS',
                targetPlatform: 'jtl',
                success: jtlSyncResult.success,
                externalId: order.jtlOutboundId,
                changedFields,
                errorMessage: jtlSyncResult.error,
              },
            });

            // Update sync status
            await prisma.order.update({
              where: { id },
              data: {
                lastJtlSync: new Date(),
                syncStatus: jtlSyncResult.success ? 'SYNCED' : 'ERROR',
              },
            });
          }
        }
      } catch (syncError) {
        console.error('[DataRoutes] JTL sync error:', syncError);
        jtlSyncResult = { success: false, error: syncError instanceof Error ? syncError.message : 'Sync failed' };
      }
    }

    res.json({
      success: true,
      data: updatedOrder,
      changedFields,
      jtlSync: jtlSyncResult,
    });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update order',
    });
  }
});

/**
 * PATCH /api/data/products/:id
 * Update product fields and sync to JTL FFN
 * 
 * Ops-owned fields (editable):
 * - name, manufacturer, sku, gtin, han
 * - heightInCm, lengthInCm, widthInCm, weightInKg
 * - amazonAsin, amazonSku, isbn
 * - customsCode, countryOfOrigin, netSalesPrice
 * - warehouseNotes, storageLocation, minStockLevel, reorderPoint
 */
router.patch('/products/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const {
      name,
      manufacturer,
      sku,
      gtin,
      han,
      heightInCm,
      lengthInCm,
      widthInCm,
      weightInKg,
      amazonAsin,
      amazonSku,
      isbn,
      customsCode,
      countryOfOrigin,
      netSalesPrice,
      warehouseNotes,
      storageLocation,
      minStockLevel,
      reorderPoint,
      mhd,
      charge,
      imageUrl,
    } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const product = await prisma.product.findUnique({
      where: { id },
      include: { client: true },
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found',
      });
    }

    // Check authorization
    if (user.role === 'CLIENT' && product.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Track which fields changed for sync
    const changedFields: string[] = [];
    const updateData: any = {
      lastUpdatedBy: 'NOLIMITS',
      updatedAt: new Date(),
    };

    // Build update data and track changes
    if (name !== undefined && name !== product.name) {
      updateData.name = name;
      changedFields.push('name');
    }
    if (manufacturer !== undefined && manufacturer !== product.manufacturer) {
      updateData.manufacturer = manufacturer;
      changedFields.push('manufacturer');
    }
    if (sku !== undefined && sku !== product.sku) {
      updateData.sku = sku;
      changedFields.push('sku');
    }
    if (gtin !== undefined && gtin !== product.gtin) {
      updateData.gtin = gtin;
      changedFields.push('gtin');
    }
    if (han !== undefined && han !== product.han) {
      updateData.han = han;
      changedFields.push('han');
    }
    if (heightInCm !== undefined && parseFloat(heightInCm) !== Number(product.heightInCm)) {
      updateData.heightInCm = parseFloat(heightInCm);
      changedFields.push('heightInCm');
    }
    if (lengthInCm !== undefined && parseFloat(lengthInCm) !== Number(product.lengthInCm)) {
      updateData.lengthInCm = parseFloat(lengthInCm);
      changedFields.push('lengthInCm');
    }
    if (widthInCm !== undefined && parseFloat(widthInCm) !== Number(product.widthInCm)) {
      updateData.widthInCm = parseFloat(widthInCm);
      changedFields.push('widthInCm');
    }
    if (weightInKg !== undefined && parseFloat(weightInKg) !== Number(product.weightInKg)) {
      updateData.weightInKg = parseFloat(weightInKg);
      changedFields.push('weightInKg');
    }
    if (amazonAsin !== undefined && amazonAsin !== product.amazonAsin) {
      updateData.amazonAsin = amazonAsin;
      changedFields.push('amazonAsin');
    }
    if (amazonSku !== undefined && amazonSku !== product.amazonSku) {
      updateData.amazonSku = amazonSku;
      changedFields.push('amazonSku');
    }
    if (isbn !== undefined && isbn !== product.isbn) {
      updateData.isbn = isbn;
      changedFields.push('isbn');
    }
    if (customsCode !== undefined && customsCode !== product.customsCode) {
      updateData.customsCode = customsCode;
      changedFields.push('customsCode');
    }
    if (countryOfOrigin !== undefined && countryOfOrigin !== product.countryOfOrigin) {
      updateData.countryOfOrigin = countryOfOrigin;
      changedFields.push('countryOfOrigin');
    }
    if (netSalesPrice !== undefined && parseFloat(netSalesPrice) !== Number(product.netSalesPrice)) {
      updateData.netSalesPrice = parseFloat(netSalesPrice);
      changedFields.push('netSalesPrice');
    }
    if (warehouseNotes !== undefined && warehouseNotes !== product.warehouseNotes) {
      updateData.warehouseNotes = warehouseNotes;
      changedFields.push('warehouseNotes');
    }
    if (storageLocation !== undefined && storageLocation !== product.storageLocation) {
      updateData.storageLocation = storageLocation;
      changedFields.push('storageLocation');
    }
    if (minStockLevel !== undefined && parseInt(minStockLevel) !== product.minStockLevel) {
      updateData.minStockLevel = parseInt(minStockLevel);
      changedFields.push('minStockLevel');
    }
    if (reorderPoint !== undefined && parseInt(reorderPoint) !== product.reorderPoint) {
      updateData.reorderPoint = parseInt(reorderPoint);
      changedFields.push('reorderPoint');
    }
    if (imageUrl !== undefined && imageUrl !== product.imageUrl) {
      updateData.imageUrl = imageUrl;
      changedFields.push('imageUrl');
    }

    // Update product in database
    const updatedProduct = await prisma.product.update({
      where: { id },
      data: updateData,
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
      },
    });

    // Log the update
    await prisma.productSyncLog.create({
      data: {
        productId: id,
        action: 'update',
        origin: 'NOLIMITS',
        targetPlatform: 'nolimits',
        success: true,
        changedFields,
      },
    });

    // Sync to JTL FFN if product is already synced there
    let jtlSyncResult = null;
    if (product.jtlProductId && changedFields.length > 0) {
      try {
        // Check if client has JTL configured
        const jtlConfig = await prisma.jtlConfig.findUnique({
          where: { clientId_fk: product.clientId },
        });

        if (jtlConfig && jtlConfig.isActive) {
          const { getEncryptionService } = await import('../services/encryption.service.js');
          const { JTLService } = await import('../services/integrations/jtl.service.js');
          
          const encryptionService = getEncryptionService();
          const jtlService = new JTLService({
            clientId: jtlConfig.clientId,
            clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
            accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
            refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
            tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
            environment: jtlConfig.environment as 'sandbox' | 'production',
          });

          // Build JTL update payload
          const jtlUpdateData: any = {};
          
          if (changedFields.includes('name')) {
            jtlUpdateData.name = name;
          }
          if (changedFields.includes('countryOfOrigin')) {
            jtlUpdateData.originCountry = countryOfOrigin;
          }
          if (changedFields.includes('customsCode')) {
            jtlUpdateData.customsCode = customsCode;
          }
          if (changedFields.includes('weightInKg')) {
            jtlUpdateData.netWeight = parseFloat(weightInKg);
          }
          // JTL uses meters for dimensions
          if (changedFields.includes('lengthInCm')) {
            jtlUpdateData.length = parseFloat(lengthInCm) / 100;
          }
          if (changedFields.includes('widthInCm')) {
            jtlUpdateData.width = parseFloat(widthInCm) / 100;
          }
          if (changedFields.includes('heightInCm')) {
            jtlUpdateData.height = parseFloat(heightInCm) / 100;
          }
          
          // Update identifiers
          const identifierUpdates: any = {};
          if (changedFields.includes('gtin')) identifierUpdates.ean = gtin;
          if (changedFields.includes('han')) identifierUpdates.han = han;
          if (changedFields.includes('amazonAsin')) identifierUpdates.asin = amazonAsin;
          if (changedFields.includes('isbn')) identifierUpdates.isbn = isbn;
          
          if (Object.keys(identifierUpdates).length > 0) {
            jtlUpdateData.identifier = identifierUpdates;
          }

          if (Object.keys(jtlUpdateData).length > 0) {
            jtlSyncResult = await jtlService.updateProduct(product.jtlProductId, jtlUpdateData);

            // Log JTL sync
            await prisma.productSyncLog.create({
              data: {
                productId: id,
                action: 'update',
                origin: 'NOLIMITS',
                targetPlatform: 'jtl',
                success: jtlSyncResult.success,
                externalId: product.jtlProductId,
                changedFields,
                errorMessage: jtlSyncResult.error,
              },
            });

            // Update sync status
            await prisma.product.update({
              where: { id },
              data: {
                lastJtlSync: new Date(),
                jtlSyncStatus: jtlSyncResult.success ? 'SYNCED' : 'ERROR',
              },
            });
          }
        }
      } catch (syncError) {
        console.error('[DataRoutes] JTL product sync error:', syncError);
        jtlSyncResult = { success: false, error: syncError instanceof Error ? syncError.message : 'Sync failed' };
      }
    }

    res.json({
      success: true,
      data: updatedProduct,
      changedFields,
      jtlSync: jtlSyncResult,
    });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update product',
    });
  }
});

/**
 * PATCH /api/data/returns/:id
 * Update return inspection results and sync to JTL FFN
 * 
 * Editable fields:
 * - inspectionResult, notes, warehouseNotes
 * - restockEligible, restockQuantity, restockReason
 * - hasDamage, damageDescription, hasDefect, defectDescription
 * - status (within allowed transitions)
 */
router.patch('/returns/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const {
      inspectionResult,
      notes,
      warehouseNotes,
      restockEligible,
      restockQuantity,
      restockReason,
      hasDamage,
      damageDescription,
      hasDefect,
      defectDescription,
      status,
      items, // Array of item updates: [{ returnItemId, condition, disposition, restockableQuantity, notes }]
    } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const returnData = await prisma.return.findUnique({
      where: { id },
      include: {
        client: true,
        items: true,
      },
    });

    if (!returnData) {
      return res.status(404).json({
        success: false,
        error: 'Return not found',
      });
    }

    // Check authorization
    if (user.role === 'CLIENT' && returnData.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Check if return can be edited (not finalized)
    const nonEditableStatuses = ['COMPLETED', 'PROCESSED'];
    if (nonEditableStatuses.includes(returnData.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot edit return in status ${returnData.status}`,
      });
    }

    // Track which fields changed for sync
    const changedFields: string[] = [];
    const updateData: any = {
      updatedAt: new Date(),
    };

    // Build update data and track changes
    if (inspectionResult !== undefined && inspectionResult !== returnData.inspectionResult) {
      updateData.inspectionResult = inspectionResult;
      changedFields.push('inspectionResult');
    }
    if (notes !== undefined && notes !== returnData.notes) {
      updateData.notes = notes;
      changedFields.push('notes');
    }
    if (warehouseNotes !== undefined && warehouseNotes !== returnData.warehouseNotes) {
      updateData.warehouseNotes = warehouseNotes;
      changedFields.push('warehouseNotes');
    }
    if (restockEligible !== undefined && restockEligible !== returnData.restockEligible) {
      updateData.restockEligible = restockEligible;
      changedFields.push('restockEligible');
    }
    if (restockQuantity !== undefined && restockQuantity !== returnData.restockQuantity) {
      updateData.restockQuantity = restockQuantity;
      changedFields.push('restockQuantity');
    }
    if (restockReason !== undefined && restockReason !== returnData.restockReason) {
      updateData.restockReason = restockReason;
      changedFields.push('restockReason');
    }
    if (hasDamage !== undefined && hasDamage !== returnData.hasDamage) {
      updateData.hasDamage = hasDamage;
      changedFields.push('hasDamage');
    }
    if (damageDescription !== undefined && damageDescription !== returnData.damageDescription) {
      updateData.damageDescription = damageDescription;
      changedFields.push('damageDescription');
    }
    if (hasDefect !== undefined && hasDefect !== returnData.hasDefect) {
      updateData.hasDefect = hasDefect;
      changedFields.push('hasDefect');
    }
    if (defectDescription !== undefined && defectDescription !== returnData.defectDescription) {
      updateData.defectDescription = defectDescription;
      changedFields.push('defectDescription');
    }
    if (status !== undefined && status !== returnData.status) {
      // Validate status transition
      const validTransitions: Record<string, string[]> = {
        'ANNOUNCED': ['RECEIVED', 'CANCELLED'],
        'RECEIVED': ['CHECKING', 'CANCELLED'],
        'CHECKING': ['CHECKED', 'CANCELLED'],
        'CHECKED': ['PROCESSED', 'RESTOCKED', 'NOT_RESTOCKED'],
        'RESTOCKED': ['COMPLETED'],
        'NOT_RESTOCKED': ['COMPLETED'],
        'PROCESSED': ['COMPLETED'],
        'UNKNOWN': ['RECEIVED', 'CHECKING', 'CANCELLED'],
      };
      
      const allowedNextStatuses = validTransitions[returnData.status] || [];
      if (!allowedNextStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status transition from ${returnData.status} to ${status}`,
        });
      }
      
      updateData.status = status;
      changedFields.push('status');
      
      // Set inspection timestamps
      if (status === 'CHECKING') {
        updateData.inspectedById = userId;
      }
      if (status === 'CHECKED' || status === 'PROCESSED') {
        updateData.inspectedAt = new Date();
      }
      if (status === 'RESTOCKED' || status === 'NOT_RESTOCKED') {
        updateData.restockDecidedAt = new Date();
        updateData.restockDecidedById = userId;
      }
      if (status === 'COMPLETED') {
        updateData.finalizedAt = new Date();
        updateData.finalizedById = userId;
        updateData.processedAt = new Date();
        updateData.processedById = userId;
      }
    }

    // Update return in database
    const updatedReturn = await prisma.return.update({
      where: { id },
      data: updateData,
      include: {
        client: {
          select: {
            companyName: true,
            name: true,
          },
        },
        items: {
          include: {
            product: true,
          },
        },
        order: {
          select: {
            orderId: true,
            orderNumber: true,
          },
        },
      },
    });

    // Update individual return items if provided
    if (items && Array.isArray(items)) {
      for (const item of items) {
        if (item.returnItemId) {
          await prisma.returnItem.update({
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
      changedFields.push('items');
    }

    // Log the update
    await prisma.returnSyncLog.create({
      data: {
        returnId: id,
        action: 'update',
        origin: 'NOLIMITS',
        targetPlatform: 'nolimits',
        success: true,
      },
    });

    // Sync to JTL FFN if return is already synced there
    let jtlSyncResult = null;
    if (returnData.jtlReturnId && changedFields.length > 0) {
      try {
        // Check if client has JTL configured
        const jtlConfig = returnData.clientId ? await prisma.jtlConfig.findUnique({
          where: { clientId_fk: returnData.clientId },
        }) : null;

        if (jtlConfig && jtlConfig.isActive) {
          const { getEncryptionService } = await import('../services/encryption.service.js');
          const { JTLService } = await import('../services/integrations/jtl.service.js');
          
          const encryptionService = getEncryptionService();
          const jtlService = new JTLService({
            clientId: jtlConfig.clientId,
            clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
            accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
            refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
            tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
            environment: jtlConfig.environment as 'sandbox' | 'production',
          });

          // Build JTL update payload
          const jtlUpdateData: any = {};
          
          if (changedFields.includes('notes') || changedFields.includes('warehouseNotes') || changedFields.includes('damageDescription')) {
            jtlUpdateData.internalNote = [notes, warehouseNotes, damageDescription, defectDescription].filter(Boolean).join('\n');
          }
          if (changedFields.includes('status')) {
            // Map our status to JTL status
            const statusMapping: Record<string, string> = {
              'CHECKING': 'InProgress',
              'CHECKED': 'Inspected',
              'RESTOCKED': 'Completed',
              'NOT_RESTOCKED': 'Completed',
              'COMPLETED': 'Completed',
            };
            if (statusMapping[status]) {
              jtlUpdateData.status = statusMapping[status];
            }
          }

          if (Object.keys(jtlUpdateData).length > 0) {
            jtlSyncResult = await jtlService.updateReturn(returnData.jtlReturnId, jtlUpdateData);

            // Log JTL sync
            await prisma.returnSyncLog.create({
              data: {
                returnId: id,
                action: 'update',
                origin: 'NOLIMITS',
                targetPlatform: 'jtl',
                success: jtlSyncResult.success,
                externalId: returnData.jtlReturnId,
                errorMessage: jtlSyncResult.error,
              },
            });

            // Update sync status
            await prisma.return.update({
              where: { id },
              data: {
                lastJtlSync: new Date(),
                syncStatus: jtlSyncResult.success ? 'SYNCED' : 'ERROR',
              },
            });
          }
        }
      } catch (syncError) {
        console.error('[DataRoutes] JTL return sync error:', syncError);
        jtlSyncResult = { success: false, error: syncError instanceof Error ? syncError.message : 'Sync failed' };
      }
    }

    res.json({
      success: true,
      data: updatedReturn,
      changedFields,
      jtlSync: jtlSyncResult,
    });
  } catch (error) {
    console.error('Error updating return:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update return',
    });
  }
});

// ============= DELETE ROUTES =============

/**
 * DELETE /api/data/orders/:id
 * Delete an order (only if not yet shipped)
 */
router.delete('/orders/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Only admins can delete orders
    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'Only admins can delete orders',
      });
    }

    const order = await prisma.order.findUnique({
      where: { id },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    // Cannot delete shipped or delivered orders
    const nonDeletableStatuses = ['SHIPPED', 'DELIVERED'];
    if (nonDeletableStatuses.includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete order in status ${order.status}. Orders can only be deleted if they are not yet shipped.`,
      });
    }

    // Delete order items first, then the order
    await prisma.orderItem.deleteMany({
      where: { orderId: id },
    });

    await prisma.order.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: 'Order deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete order',
    });
  }
});

/**
 * DELETE /api/data/products/:id
 * Delete a product (soft delete - marks as inactive)
 */
router.delete('/products/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const product = await prisma.product.findUnique({
      where: { id },
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found',
      });
    }

    // Check authorization - clients can only delete their own products
    if (user.role === 'CLIENT' && product.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Check if product has any reserved stock or pending orders
    if (product.reserved > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete product with reserved stock. Please wait for pending orders to be fulfilled.',
      });
    }

    // Soft delete - mark as inactive
    await prisma.product.update({
      where: { id },
      data: {
        isActive: false,
        updatedAt: new Date(),
      },
    });

    res.json({
      success: true,
      message: 'Product deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete product',
    });
  }
});

/**
 * DELETE /api/data/returns/:id
 * Delete a return (only if not yet processed)
 */
router.delete('/returns/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Only admins can delete returns
    if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'Only admins can delete returns',
      });
    }

    const returnData = await prisma.return.findUnique({
      where: { id },
    });

    if (!returnData) {
      return res.status(404).json({
        success: false,
        error: 'Return not found',
      });
    }

    // Cannot delete processed or completed returns
    const nonDeletableStatuses = ['PROCESSED', 'COMPLETED', 'RESTOCKED'];
    if (nonDeletableStatuses.includes(returnData.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete return in status ${returnData.status}. Returns can only be deleted if they are not yet processed.`,
      });
    }

    // Delete return items first, then the return
    await prisma.returnItem.deleteMany({
      where: { returnId: id },
    });

    await prisma.return.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: 'Return deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting return:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete return',
    });
  }
});

// ==================== TASKS ====================

/**
 * GET /api/data/tasks
 * Fetch all tasks (admin/employee see all, clients see their own)
 */
router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Build where clause based on role
    const whereClause = user.role === 'CLIENT' && user.client
      ? { clientId: user.client.id }
      : {};

    const tasks = await prisma.task.findMany({
      where: whereClause,
      include: {
        client: {
          select: {
            id: true,
            companyName: true,
            name: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch tasks',
    });
  }
});

/**
 * GET /api/data/tasks/:id
 * Fetch a single task by ID
 */
router.get('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        client: {
          select: {
            id: true,
            companyName: true,
            name: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        fromMessage: {
          select: {
            id: true,
            content: true,
            createdAt: true,
            sender: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!task) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    // Check authorization for clients
    if (user.role === 'CLIENT' && task.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    res.json({
      success: true,
      data: task,
    });
  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch task',
    });
  }
});

/**
 * POST /api/data/tasks
 * Create a new task
 */
router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const {
      title,
      description,
      type,
      priority,
      status,
      dueDate,
      assigneeId,
      clientId,
      notifyCustomer,
    } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Validate required fields
    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Task title is required',
      });
    }

    // Determine clientId based on role
    let taskClientId: string | null = null;
    if (user.role === 'CLIENT') {
      taskClientId = user.client?.id || null;
    } else if (clientId) {
      // Admin/Employee can specify a client
      taskClientId = clientId;
    }

    // Generate task ID
    const taskIdDisplay = `TASK-${Date.now().toString(36).toUpperCase()}`;

    const task = await prisma.task.create({
      data: {
        taskId: taskIdDisplay,
        title,
        description: description || null,
        type: type || 'OTHER',
        priority: priority || 'LOW',
        status: status || 'OPEN',
        dueDate: dueDate ? new Date(dueDate) : null,
        assigneeId: assigneeId || null,
        clientId: taskClientId,
        creatorId: userId,
        notifyCustomer: notifyCustomer || false,
      },
      include: {
        client: {
          select: {
            id: true,
            companyName: true,
            name: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    res.status(201).json({
      success: true,
      data: task,
    });
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create task',
    });
  }
});

/**
 * PUT /api/data/tasks/:id
 * Update an existing task
 */
router.put('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const {
      title,
      description,
      type,
      priority,
      status,
      dueDate,
      assigneeId,
      clientId,
      notifyCustomer,
    } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const existingTask = await prisma.task.findUnique({
      where: { id },
    });

    if (!existingTask) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    // Check authorization for clients
    if (user.role === 'CLIENT' && existingTask.clientId !== user.client?.id) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Build update data
    const updateData: any = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (type !== undefined) updateData.type = type;
    if (priority !== undefined) updateData.priority = priority;
    if (status !== undefined) {
      updateData.status = status;
      // If task is being completed/closed, set completedAt
      if (status === 'COMPLETED' || status === 'CLOSED') {
        updateData.completedAt = new Date();
      }
    }
    if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
    if (assigneeId !== undefined) updateData.assigneeId = assigneeId || null;
    if (notifyCustomer !== undefined) updateData.notifyCustomer = notifyCustomer;
    
    // Only admins/employees can change clientId
    if (clientId !== undefined && user.role !== 'CLIENT') {
      updateData.clientId = clientId || null;
    }

    const task = await prisma.task.update({
      where: { id },
      data: updateData,
      include: {
        client: {
          select: {
            id: true,
            companyName: true,
            name: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        creator: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    res.json({
      success: true,
      data: task,
    });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update task',
    });
  }
});

/**
 * DELETE /api/data/tasks/:id
 * Delete a task
 */
router.delete('/tasks/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const task = await prisma.task.findUnique({
      where: { id },
    });

    if (!task) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    // Check authorization - only creator, admin, or superadmin can delete
    const canDelete = 
      task.creatorId === userId ||
      user.role === 'ADMIN' ||
      user.role === 'SUPER_ADMIN';

    if (!canDelete) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized to delete this task',
      });
    }

    await prisma.task.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: 'Task deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete task',
    });
  }
});

/**
 * GET /api/data/health-status
 * Health status dashboard for client — channels, sync counts, FFN status, recent errors
 */
router.get('/health-status', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { client: true },
    });

    if (!user || !user.client) {
      return res.status(403).json({
        success: false,
        error: 'Client access required',
      });
    }

    const clientId = user.client.id;
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // 1. CHANNELS
    const channels = await prisma.channel.findMany({
      where: { clientId },
      select: {
        id: true,
        name: true,
        type: true,
        isActive: true,
        syncEnabled: true,
        lastSyncAt: true,
        lastOrderPollAt: true,
        lastProductPollAt: true,
        webhookUrl: true,
      },
    });

    // Get recent order counts per channel to detect webhook/polling activity
    const channelOrderCounts = await Promise.all(
      channels.map(async (ch) => ({
        channelId: ch.id,
        recentOrderCount: await prisma.order.count({
          where: {
            channelId: ch.id,
            createdAt: { gte: twentyFourHoursAgo },
          },
        }),
      }))
    );

    const channelData = channels.map((ch) => {
      // FIX 1: Use polling timestamps (lastOrderPollAt, lastProductPollAt) instead of lastSyncAt
      // lastSyncAt is only set during onboarding and never updated during normal operations
      const mostRecentActivity = [ch.lastOrderPollAt, ch.lastProductPollAt]
        .filter(Boolean)
        .sort((a, b) => (b as Date).getTime() - (a as Date).getTime())[0];

      let status: 'healthy' | 'warning' | 'error' | 'inactive' = 'error';
      if (!ch.isActive || !ch.syncEnabled) {
        status = 'inactive';
      } else if (mostRecentActivity && mostRecentActivity > thirtyMinAgo) {
        status = 'healthy';
      } else if (mostRecentActivity && mostRecentActivity > twoHoursAgo) {
        status = 'warning';
      }
      // else stays 'error' (no polling activity in >2h or never)

      // FIX 2: Detect webhook activity by checking if orders arrived recently
      // webhookUrl field is never populated, so we check functional activity instead
      const orderCount = channelOrderCounts.find((c) => c.channelId === ch.id)?.recentOrderCount || 0;
      const hasWebhook = orderCount > 0 || !!ch.webhookUrl;

      return {
        id: ch.id,
        name: ch.name,
        type: ch.type,
        isActive: ch.isActive,
        syncEnabled: ch.syncEnabled,
        lastSyncAt: mostRecentActivity || ch.lastSyncAt, // Show most recent operational activity
        lastOrderPollAt: ch.lastOrderPollAt,
        lastProductPollAt: ch.lastProductPollAt,
        hasWebhook,
        status,
      };
    });

    // 2. SYNC COUNTS using groupBy for efficiency
    const [productGroups, orderGroups, returnGroups] = await Promise.all([
      prisma.product.groupBy({
        by: ['syncStatus'],
        where: { clientId },
        _count: true,
      }),
      prisma.order.groupBy({
        by: ['syncStatus'],
        where: { clientId },
        _count: true,
      }),
      prisma.return.groupBy({
        by: ['syncStatus'],
        where: { clientId },
        _count: true,
      }),
    ]);

    const toSyncCounts = (groups: { syncStatus: string; _count: number }[], includeConflict = false) => {
      const map: Record<string, number> = {};
      for (const g of groups) {
        map[g.syncStatus] = g._count;
      }
      const total = Object.values(map).reduce((a, b) => a + b, 0);
      return {
        total,
        synced: map['SYNCED'] || 0,
        pending: map['PENDING'] || 0,
        error: map['ERROR'] || 0,
        ...(includeConflict ? { conflict: map['CONFLICT'] || 0 } : {}),
      };
    };

    // 3. FFN STATUS
    const [jtlConfig, ffnErrorCount, ffnHeldCount, ffnPendingCount] = await Promise.all([
      prisma.jtlConfig.findUnique({ where: { clientId_fk: clientId } }),
      prisma.order.count({ where: { clientId, ffnSyncError: { not: null } } }),
      prisma.order.count({ where: { clientId, isOnHold: true, holdReason: 'AWAITING_PAYMENT' } }),
      prisma.order.count({ where: { clientId, syncStatus: 'PENDING', lastSyncedToFfn: null } }),
    ]);

    // 3.5 FFN TO PLATFORM STATUS (Stock sync from JTL back to our platform)
    const lastStockSync = await prisma.product.findFirst({
      where: { clientId, jtlProductId: { not: null } },
      orderBy: { lastJtlSync: 'desc' },
      select: { lastJtlSync: true },
    });

    const recentStockUpdates = await prisma.product.count({
      where: {
        clientId,
        jtlProductId: { not: null },
        lastJtlSync: { gte: twentyFourHoursAgo },
      },
    });

    const orderStatusUpdatesFromFFN = await prisma.order.count({
      where: {
        clientId,
        lastJtlSync: { gte: twentyFourHoursAgo },
        ffnSyncError: null, // Only count successful syncs (no errors)
      },
    });

    // 3.6 COMMERCE FULFILLMENT SYNC STATUS
    // Orders that are SHIPPED in FFN but need to sync back to Shopify/WooCommerce
    const [commerceSyncedCount, commercePendingCount, commerceFailedCount, commerceFailedOrders] = await Promise.all([
      // Successfully synced to commerce platform
      prisma.order.count({
        where: {
          clientId,
          fulfillmentState: 'SHIPPED',
          lastSyncedToCommerce: { not: null },
          commerceSyncError: null,
          channelId: { not: null },
        },
      }),
      // Pending sync (in queue, no error yet)
      prisma.order.count({
        where: {
          clientId,
          fulfillmentState: 'SHIPPED',
          lastSyncedToCommerce: null,
          commerceSyncError: null,
          channelId: { not: null },
        },
      }),
      // Failed sync (has error, needs attention)
      prisma.order.count({
        where: {
          clientId,
          fulfillmentState: 'SHIPPED',
          commerceSyncError: { not: null },
          channelId: { not: null },
        },
      }),
      // List of failed orders (for debugging)
      prisma.order.findMany({
        where: {
          clientId,
          fulfillmentState: 'SHIPPED',
          commerceSyncError: { not: null },
          channelId: { not: null },
        },
        select: {
          id: true,
          orderId: true,
          orderNumber: true,
          commerceSyncError: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
    ]);

    // 4. RECENT ERRORS (last 24h, limit 20)
    const [productErrors, orderErrors, returnErrors] = await Promise.all([
      prisma.productSyncLog.findMany({
        where: {
          product: { clientId },
          success: false,
          createdAt: { gte: twentyFourHoursAgo },
        },
        select: {
          id: true,
          action: true,
          targetPlatform: true,
          errorMessage: true,
          createdAt: true,
          product: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.orderSyncLog.findMany({
        where: {
          order: { clientId },
          success: false,
          createdAt: { gte: twentyFourHoursAgo },
        },
        select: {
          id: true,
          action: true,
          targetPlatform: true,
          errorMessage: true,
          createdAt: true,
          order: { select: { id: true, orderNumber: true, orderId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.returnSyncLog.findMany({
        where: {
          return: { clientId },
          success: false,
          createdAt: { gte: twentyFourHoursAgo },
        },
        select: {
          id: true,
          action: true,
          targetPlatform: true,
          errorMessage: true,
          createdAt: true,
          return: { select: { id: true, returnId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const recentErrors = [
      ...productErrors.map((e) => ({
        id: e.id,
        type: 'product' as const,
        action: e.action,
        targetPlatform: e.targetPlatform,
        errorMessage: e.errorMessage,
        entityId: e.product.id,
        entityName: e.product.name,
        createdAt: e.createdAt,
      })),
      ...orderErrors.map((e) => ({
        id: e.id,
        type: 'order' as const,
        action: e.action,
        targetPlatform: e.targetPlatform,
        errorMessage: e.errorMessage,
        entityId: e.order.id,
        entityName: e.order.orderNumber || e.order.orderId,
        createdAt: e.createdAt,
      })),
      ...returnErrors.map((e) => ({
        id: e.id,
        type: 'return' as const,
        action: e.action,
        targetPlatform: e.targetPlatform,
        errorMessage: e.errorMessage,
        entityId: e.return.id,
        entityName: e.return.returnId,
        createdAt: e.createdAt,
      })),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20);

    // 5. LAST SYNC JOB
    const lastSyncJob = await prisma.syncJob.findFirst({
      where: { channel: { clientId } },
      orderBy: { startedAt: 'desc' },
      select: {
        status: true,
        type: true,
        startedAt: true,
        completedAt: true,
      },
    });

    res.json({
      success: true,
      data: {
        channels: channelData,
        sync: {
          products: toSyncCounts(productGroups as any, true),
          orders: toSyncCounts(orderGroups as any),
          returns: toSyncCounts(returnGroups as any),
        },
        ffn: {
          connected: !!jtlConfig?.isActive,
          lastSyncAt: jtlConfig?.lastSyncAt || null,
          pendingOrders: ffnPendingCount,
          errorOrders: ffnErrorCount,
          heldOrders: ffnHeldCount,
        },
        ffnToPlatform: {
          lastStockSync: lastStockSync?.lastJtlSync?.toISOString() || null,
          recentStockUpdates,
          orderStatusUpdates: orderStatusUpdatesFromFFN,
        },
        commerceSync: {
          syncedOrders: commerceSyncedCount,
          pendingOrders: commercePendingCount,
          failedOrders: commerceFailedCount,
          failedOrdersList: commerceFailedOrders.map(o => ({
            id: o.id,
            orderNumber: o.orderNumber || o.orderId,
            error: o.commerceSyncError,
            lastAttempt: o.updatedAt.toISOString(),
          })),
        },
        recentErrors,
        lastSyncJob: lastSyncJob || null,
        generatedAt: now.toISOString(),
      },
    });
  } catch (error: any) {
    console.error('Error fetching health status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch health status',
    });
  }
});

export default router;
