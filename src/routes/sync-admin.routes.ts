/**
 * Sync Administration API Routes
 *
 * Admin endpoints for managing syncs, conflicts, queue jobs, returns, and order operations
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate as authMiddleware } from '../middleware/auth.js';
import { ConflictResolutionService } from '../services/integrations/conflict-resolution.service.js';
import { ReturnSyncService } from '../services/integrations/return-sync.service.js';
import { OrderOperationsService } from '../services/integrations/order-operations.service.js';
import { JTLOrderSyncService } from '../services/integrations/jtl-order-sync.service.js';
import { StockSyncService } from '../services/integrations/stock-sync.service.js';
import { getQueue } from '../services/queue/sync-queue.service.js';

const router = Router();

/**
 * Initialize routes with prisma client
 */
export function createSyncAdminRoutes(prisma: PrismaClient): Router {
  const conflictService = new ConflictResolutionService(prisma);
  const returnService = new ReturnSyncService(prisma);
  const orderOpsService = new OrderOperationsService(prisma);
  const jtlOrderSyncService = new JTLOrderSyncService(prisma);
  const stockSyncService = new StockSyncService(prisma);

  // ============= SYNC STATUS & MANAGEMENT =============

  /**
   * Get overall sync status for a client
   */
  router.get('/status/:clientId', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      // Get product sync status
      const products = await prisma.product.findMany({
        where: { clientId },
        select: {
          syncStatus: true,
        },
      });

      const productStatus = {
        total: products.length,
        synced: products.filter(p => p.syncStatus === 'SYNCED').length,
        pending: products.filter(p => p.syncStatus === 'PENDING').length,
        conflict: products.filter(p => p.syncStatus === 'CONFLICT').length,
        error: products.filter(p => p.syncStatus === 'ERROR').length,
      };

      // Get order sync status
      const orders = await prisma.order.findMany({
        where: { clientId },
        select: {
          syncStatus: true,
        },
      });

      const orderStatus = {
        total: orders.length,
        synced: orders.filter(o => o.syncStatus === 'SYNCED').length,
        pending: orders.filter(o => o.syncStatus === 'PENDING').length,
        error: orders.filter(o => o.syncStatus === 'ERROR').length,
      };

      // Get return sync status
      const returns = await prisma.return.findMany({
        where: { clientId },
        select: {
          syncStatus: true,
        },
      });

      const returnStatus = {
        total: returns.length,
        synced: returns.filter(r => r.syncStatus === 'SYNCED').length,
        pending: returns.filter(r => r.syncStatus === 'PENDING').length,
        error: returns.filter(r => r.syncStatus === 'ERROR').length,
      };

      res.json({
        success: true,
        data: {
          products: productStatus,
          orders: orderStatus,
          returns: returnStatus,
          lastSyncAt: new Date(),
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Trigger manual resync for a product
   */
  router.post('/products/:productId/resync', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { productId } = req.params;
      const { platforms } = req.body; // ['shopify', 'woocommerce', 'jtl']

      // Update product sync status
      await prisma.product.update({
        where: { id: productId },
        data: {
          syncStatus: 'PENDING',
        },
      });

      // Queue sync jobs for each platform
      const queue = getQueue();
      const jobIds: string[] = [];

      for (const platform of platforms || ['shopify', 'woocommerce', 'jtl']) {
        const queueName =
          platform === 'shopify'
            ? 'product-sync-to-shopify'
            : platform === 'woocommerce'
              ? 'product-sync-to-woocommerce'
              : 'product-sync-to-jtl';

        const jobId = await queue.enqueue(
          queueName as any,
          { productId, origin: 'nolimits' },
          { priority: 2 } // Higher priority for manual resyncs
        );

        if (jobId) jobIds.push(jobId);
      }

      res.json({
        success: true,
        data: {
          productId,
          platforms,
          jobIds,
          message: 'Resync jobs queued successfully',
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Trigger full sync for a client
   */
  router.post('/clients/:clientId/full-sync', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;
      const { entityType } = req.body; // 'products' | 'orders' | 'all'

      const queue = getQueue();
      let queuedCount = 0;

      if (entityType === 'products' || entityType === 'all') {
        const products = await prisma.product.findMany({
          where: { clientId },
          select: { id: true },
        });

        for (const product of products) {
          await queue.enqueue(
            'product-sync-to-shopify',
            { productId: product.id, origin: 'nolimits' },
            { priority: 1 }
          );
          queuedCount++;
        }
      }

      if (entityType === 'orders' || entityType === 'all') {
        const orders = await prisma.order.findMany({
          where: { clientId, syncStatus: { not: 'SYNCED' } },
          select: { id: true },
        });

        for (const order of orders) {
          await queue.enqueue(
            'order-sync-to-ffn',
            { orderId: order.id, origin: 'nolimits', operation: 'create' },
            { priority: 1 }
          );
          queuedCount++;
        }
      }

      res.json({
        success: true,
        data: {
          clientId,
          entityType,
          queuedJobs: queuedCount,
          message: `Full sync initiated for ${queuedCount} entities`,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============= CONFLICT MANAGEMENT =============

  /**
   * List unresolved conflicts
   */
  router.get('/conflicts/:clientId', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;
      const { entityType = 'product' } = req.query;

      const conflicts = await conflictService.getUnresolvedConflicts(
        entityType as any,
        clientId
      );

      res.json({
        success: true,
        data: {
          conflicts,
          count: conflicts.length,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Resolve a conflict manually
   */
  router.post('/conflicts/:conflictId/resolve', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { conflictId } = req.params;
      const { resolution, customValue } = req.body; // resolution: 'accept_local' | 'accept_incoming' | 'custom'

      const result = await conflictService.manuallyResolveConflict(
        conflictId,
        resolution,
        customValue
      );

      if (result.success) {
        res.json({
          success: true,
          data: {
            conflictId,
            resolution,
            message: 'Conflict resolved successfully',
          },
        });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============= QUEUE MANAGEMENT =============

  /**
   * Get queue metrics
   */
  router.get('/queue/metrics', authMiddleware, async (req: Request, res: Response) => {
    try {
      const queue = getQueue();
      const metrics = await queue.getMetrics();

      res.json({
        success: true,
        data: metrics,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Retry failed jobs for a queue
   */
  router.post('/queue/:queueName/retry-failed', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { queueName } = req.params;

      const queue = getQueue();
      const retriedCount = await queue.retryFailedJobs(queueName as any);

      res.json({
        success: true,
        data: {
          queueName,
          retriedJobs: retriedCount,
          message: `Retried ${retriedCount} failed jobs`,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Get failed jobs (Dead Letter Queue)
   */
  router.get('/queue/failed-jobs', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { queueName } = req.query;

      const queue = getQueue();
      const failedJobs = await queue.getFailedJobs(queueName as any);

      res.json({
        success: true,
        data: {
          failedJobs,
          count: failedJobs.length,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============= RETURN MANAGEMENT =============

  /**
   * Create warehouse return (unknown return)
   */
  router.post('/returns/warehouse', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { clientId, sku, quantity, notes, photos } = req.body;

      const result = await returnService.createWarehouseReturn(clientId, {
        sku,
        quantity,
        notes,
        photos,
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            returnId: result.returnId,
            message: 'Warehouse return created successfully',
          },
        });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Perform return inspection
   */
  router.post('/returns/:returnId/inspect', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { returnId } = req.params;
      const { inspectionResult, restockEligible, restockQuantity, items, photos } = req.body;
      const userId = (req as any).user?.id; // From auth middleware

      const result = await returnService.inspectReturn({
        returnId,
        inspectionResult,
        restockEligible,
        restockQuantity,
        items,
        photos,
        inspectedBy: userId,
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            returnId,
            inspectionResult,
            restockSynced: result.restockSynced,
            message: 'Return inspection completed successfully',
          },
        });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Issue refund for return
   */
  router.post('/returns/:returnId/refund', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { returnId } = req.params;
      const { refundAmount, refundCurrency, reason, syncToCommerce = true } = req.body;

      const result = await returnService.issueRefund({
        returnId,
        refundAmount,
        refundCurrency,
        reason,
        syncToCommerce,
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            returnId,
            refundAmount,
            refundSynced: result.refundSynced,
            message: 'Refund issued successfully',
          },
        });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Finalize return
   */
  router.post('/returns/:returnId/finalize', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { returnId } = req.params;
      const userId = (req as any).user?.id;

      const result = await returnService.finalizeReturn(returnId, userId);

      if (result.success) {
        res.json({
          success: true,
          data: {
            returnId,
            message: 'Return finalized successfully',
          },
        });
      } else {
        res.status(500).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============= SYNC LOGS =============

  /**
   * Get sync logs for an entity
   */
  router.get('/logs/:entityType/:entityId', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { entityType, entityId } = req.params;
      const { limit = 50, offset = 0 } = req.query;

      let logs: any[] = [];

      if (entityType === 'product') {
        logs = await prisma.productSyncLog.findMany({
          where: { productId: entityId },
          orderBy: { createdAt: 'desc' },
          take: Number(limit),
          skip: Number(offset),
        });
      } else if (entityType === 'order') {
        logs = await prisma.orderSyncLog.findMany({
          where: { orderId: entityId },
          orderBy: { createdAt: 'desc' },
          take: Number(limit),
          skip: Number(offset),
        });
      } else if (entityType === 'return') {
        logs = await prisma.returnSyncLog.findMany({
          where: { returnId: entityId },
          orderBy: { createdAt: 'desc' },
          take: Number(limit),
          skip: Number(offset),
        });
      }

      res.json({
        success: true,
        data: {
          logs,
          count: logs.length,
          entityType,
          entityId,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============= ORDER OPERATIONS =============

  /**
   * Correct shipping address before fulfillment
   */
  router.post('/orders/:orderId/correct-address', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const userId = (req as any).user?.id;
      const addressData = req.body;

      const result = await orderOpsService.correctAddress({
        orderId,
        correctedBy: userId,
        ...addressData,
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            orderId,
            action: 'address_corrected',
            details: result.details,
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Create replacement order
   */
  router.post('/orders/:orderId/replacement', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const userId = (req as any).user?.id;
      const { reason, returnId, items, customAddress, notes, expedited } = req.body;

      const result = await orderOpsService.createReplacementOrder({
        originalOrderId: orderId,
        returnId,
        reason,
        createdBy: userId,
        items,
        customAddress,
        notes,
        expedited,
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            replacementOrderId: result.orderId,
            originalOrderId: orderId,
            details: result.details,
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Update order priority
   */
  router.post('/orders/:orderId/priority', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const userId = (req as any).user?.id;
      const { priorityLevel, reason } = req.body;

      const result = await orderOpsService.updatePriority({
        orderId,
        priorityLevel,
        reason,
        updatedBy: userId,
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            orderId,
            newPriority: priorityLevel,
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Put order on hold
   */
  router.post('/orders/:orderId/hold', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const userId = (req as any).user?.id;
      const { holdReason } = req.body;

      const result = await orderOpsService.holdOrder({
        orderId,
        holdReason,
        holdBy: userId,
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            orderId,
            action: 'order_held',
            reason: holdReason,
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Release order from hold
   */
  router.post('/orders/:orderId/release', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const userId = (req as any).user?.id;

      const result = await orderOpsService.releaseOrder(orderId, userId);

      if (result.success) {
        res.json({
          success: true,
          data: {
            orderId,
            action: 'order_released',
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Update carrier selection
   */
  router.post('/orders/:orderId/carrier', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const userId = (req as any).user?.id;
      const { carrier, serviceLevel } = req.body;

      const result = await orderOpsService.updateCarrier(orderId, carrier, serviceLevel, userId);

      if (result.success) {
        res.json({
          success: true,
          data: {
            orderId,
            carrier,
            serviceLevel,
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============= PLATFORM-INITIATED RETURNS =============

  /**
   * Create return from platform (not from webhook)
   */
  router.post('/returns/platform', authMiddleware, async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user?.id;
      const { clientId, orderId, reason, reasonCategory, items, notes, triggerReplacement, syncToCommerce } = req.body;

      const result = await returnService.createPlatformReturn(clientId, {
        orderId,
        reason,
        reasonCategory,
        items,
        notes,
        triggerReplacement,
        syncToCommerce,
        createdBy: userId,
      });

      if (result.success) {
        res.json({
          success: true,
          data: {
            returnId: result.returnId,
            orderId,
            details: result.details,
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============= JTL FFN SYNC =============

  /**
   * Manually sync order to JTL-FFN
   */
  router.post('/orders/:orderId/sync-to-ffn', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;

      const result = await jtlOrderSyncService.syncOrderToFFN(orderId);

      if (result.success) {
        res.json({
          success: true,
          data: {
            orderId,
            outboundId: result.outboundId,
            message: 'Order synced to JTL-FFN successfully',
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Cancel order in JTL-FFN
   */
  router.post('/orders/:orderId/cancel-ffn', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const { reason } = req.body;

      const result = await jtlOrderSyncService.cancelOrderInFFN(orderId, reason);

      if (result.success) {
        res.json({
          success: true,
          data: {
            orderId,
            message: 'Order cancelled in JTL-FFN successfully',
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Poll JTL-FFN for order updates
   */
  router.post('/clients/:clientId/poll-ffn', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;
      const { since } = req.body;

      const result = await jtlOrderSyncService.pollFFNUpdates(
        clientId,
        since ? new Date(since) : undefined
      );

      if (result.success) {
        res.json({
          success: true,
          data: {
            clientId,
            updatesProcessed: result.updatesProcessed,
            message: `Processed ${result.updatesProcessed} updates from JTL-FFN`,
          },
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ============= STOCK SYNC (JTL FFN → DB) =============

  /**
   * Manually trigger stock sync from JTL-FFN for a client
   * This fetches current stock levels from JTL FFN and updates the local DB
   */
  router.post('/clients/:clientId/sync-stock', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;
      const { jfskus, forceUpdate } = req.body;

      console.log(`[API] Manual stock sync requested for client ${clientId}`);

      const result = await stockSyncService.syncStockForClient(clientId, {
        jfskus,
        forceUpdate,
      });

      res.json({
        success: result.success,
        data: {
          clientId,
          productsUpdated: result.productsUpdated,
          productsUnchanged: result.productsUnchanged,
          productsFailed: result.productsFailed,
          syncedAt: result.syncedAt,
          errors: result.errors,
          details: result.details,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Get stock sync status for a client
   */
  router.get('/clients/:clientId/stock-status', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      const status = await stockSyncService.getStockSyncStatus(clientId);

      res.json({
        success: true,
        data: {
          clientId,
          ...status,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Poll inbounds and sync stock for a client
   * This checks for closed inbounds and triggers stock sync if found
   */
  router.post('/clients/:clientId/poll-inbounds', authMiddleware, async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      console.log(`[API] Manual inbound poll requested for client ${clientId}`);

      const result = await stockSyncService.pollInboundUpdatesAndSyncStock(clientId);

      res.json({
        success: true,
        data: {
          clientId,
          inboundsProcessed: result.inboundsProcessed,
          stockSyncTriggered: result.stockSyncTriggered,
          stockSyncResult: result.stockSyncResult ? {
            productsUpdated: result.stockSyncResult.productsUpdated,
            productsFailed: result.stockSyncResult.productsFailed,
          } : null,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Sync stock for all clients (admin only)
   */
  router.post('/stock/sync-all', authMiddleware, async (req: Request, res: Response) => {
    try {
      console.log('[API] Manual stock sync for all clients requested');

      const result = await stockSyncService.syncStockForAllClients();

      res.json({
        success: true,
        data: {
          clientsProcessed: result.clientsProcessed,
          totalProductsUpdated: result.totalProductsUpdated,
          totalProductsFailed: result.totalProductsFailed,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

export default createSyncAdminRoutes;
