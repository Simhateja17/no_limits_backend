/**
 * Fulfillment Routes
 * API endpoints for fulfillment operations with JTL FFN integration
 */

import { Router } from 'express';
import {
  getDashboardStats,
  getFulfillmentOrders,
  getFulfillmentOrder,
  holdOrder,
  releaseHold,
  updateTracking,
  getOrderAudit,
  createFulfillment,
  bulkHoldOrders,
  bulkReleaseOrders,
  bulkFulfillOrders,
  syncOrderToJTL,
  getJTLStatus,
  getShippingMethods,
  getWarehouses,
} from '../controllers/fulfillment.controller.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

// All fulfillment routes require authentication
router.use(authenticate);

// ============= DASHBOARD =============
// GET /api/fulfillment/dashboard/stats - Get fulfillment statistics
router.get('/dashboard/stats', getDashboardStats);

// ============= ORDERS =============
// GET /api/fulfillment/orders - Get fulfillment orders with filtering
router.get('/orders', getFulfillmentOrders);

// GET /api/fulfillment/orders/:orderId - Get single order details
router.get('/orders/:orderId', getFulfillmentOrder);

// GET /api/fulfillment/orders/:orderId/audit - Get order audit trail
router.get('/orders/:orderId/audit', getOrderAudit);

// POST /api/fulfillment/orders/:orderId/hold - Place order on hold
router.post('/orders/:orderId/hold', holdOrder);

// POST /api/fulfillment/orders/:orderId/release - Release order from hold
router.post('/orders/:orderId/release', releaseHold);

// POST /api/fulfillment/orders/:orderId/tracking - Update tracking info
router.post('/orders/:orderId/tracking', updateTracking);

// POST /api/fulfillment/orders/:orderId/fulfill - Create fulfillment
router.post('/orders/:orderId/fulfill', createFulfillment);

// POST /api/fulfillment/orders/:orderId/sync-to-jtl - Sync to JTL FFN
router.post('/orders/:orderId/sync-to-jtl', requireAdmin, syncOrderToJTL);

// ============= BULK OPERATIONS =============
// POST /api/fulfillment/bulk/hold - Bulk hold orders
router.post('/bulk/hold', bulkHoldOrders);

// POST /api/fulfillment/bulk/release - Bulk release from hold
router.post('/bulk/release', bulkReleaseOrders);

// POST /api/fulfillment/bulk/fulfill - Bulk fulfill orders
router.post('/bulk/fulfill', bulkFulfillOrders);

// ============= JTL FFN INTEGRATION =============
// GET /api/fulfillment/jtl/status - Check JTL FFN connection status
router.get('/jtl/status', getJTLStatus);

// GET /api/fulfillment/shipping-methods - Get JTL FFN shipping methods
router.get('/shipping-methods', getShippingMethods);

// GET /api/fulfillment/warehouses - Get JTL FFN warehouses
router.get('/warehouses', getWarehouses);

export default router;
