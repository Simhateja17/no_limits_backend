/**
 * Shipping Methods Routes
 * 
 * API endpoints for shipping method management, JTL FFN sync,
 * and channel shipping method mappings.
 */

import { Router } from 'express';
import {
  getShippingMethods,
  getShippingMethod,
  createShippingMethod,
  updateShippingMethod,
  deleteShippingMethod,
  syncFromJTL,
  syncMyShippingMethods,
  getJTLShippingMethods,
  getClientMappings,
  getChannelMappings,
  upsertMapping,
  deleteMapping,
  setClientDefault,
  getClientDefault,
  setChannelDefault,
  getChannelDefault,
  getUnresolvedMismatches,
  resolveMismatch,
} from '../controllers/shipping-methods.controller.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// ============= SHIPPING METHODS CRUD =============

/**
 * GET /api/shipping-methods
 * Get all shipping methods
 * Query: ?activeOnly=true to get only active methods
 */
router.get('/', getShippingMethods);

/**
 * GET /api/shipping-methods/:id
 * Get a single shipping method by ID
 */
router.get('/:id', getShippingMethod);

/**
 * POST /api/shipping-methods
 * Create a new shipping method (admin only)
 */
router.post('/', requireAdmin, createShippingMethod);

/**
 * PUT /api/shipping-methods/:id
 * Update a shipping method (admin only)
 */
router.put('/:id', requireAdmin, updateShippingMethod);

/**
 * DELETE /api/shipping-methods/:id
 * Delete a shipping method (admin only)
 */
router.delete('/:id', requireAdmin, deleteShippingMethod);

// ============= JTL FFN INTEGRATION =============

/**
 * POST /api/shipping-methods/jtl/sync
 * Sync shipping methods from JTL FFN for the authenticated client
 * (Client can sync their own shipping methods)
 */
router.post('/jtl/sync', syncMyShippingMethods);

/**
 * POST /api/shipping-methods/jtl/:clientId/sync
 * Sync shipping methods from JTL FFN
 */
router.post('/jtl/:clientId/sync', requireAdmin, syncFromJTL);

/**
 * GET /api/shipping-methods/jtl/:clientId
 * Get shipping methods directly from JTL FFN (without saving)
 */
router.get('/jtl/:clientId', requireAdmin, getJTLShippingMethods);

// ============= SHIPPING METHOD MAPPINGS =============

/**
 * GET /api/shipping-methods/mappings/client/:clientId
 * Get all shipping method mappings for a client
 */
router.get('/mappings/client/:clientId', getClientMappings);

/**
 * GET /api/shipping-methods/mappings/channel/:channelId
 * Get all shipping method mappings for a channel
 */
router.get('/mappings/channel/:channelId', getChannelMappings);

/**
 * POST /api/shipping-methods/mappings
 * Create or update a shipping method mapping
 */
router.post('/mappings', upsertMapping);

/**
 * DELETE /api/shipping-methods/mappings/:mappingId
 * Delete a shipping method mapping
 */
router.delete('/mappings/:mappingId', deleteMapping);

// ============= CLIENT DEFAULT SHIPPING METHOD =============

/**
 * GET /api/shipping-methods/client/:clientId/default
 * Get a client's default shipping method
 */
router.get('/client/:clientId/default', getClientDefault);

/**
 * PUT /api/shipping-methods/client/:clientId/default
 * Set a client's default shipping method
 */
router.put('/client/:clientId/default', setClientDefault);

// ============= CHANNEL DEFAULT SHIPPING METHOD =============

/**
 * GET /api/shipping-methods/channel/:channelId/default
 * Get a channel's default shipping method
 */
router.get('/channel/:channelId/default', getChannelDefault);

/**
 * PUT /api/shipping-methods/channel/:channelId/default
 * Set a channel's default shipping method
 */
router.put('/channel/:channelId/default', setChannelDefault);

// ============= SHIPPING METHOD MISMATCHES =============

/**
 * GET /api/shipping-methods/mismatches
 * Get unresolved shipping method mismatches
 * Query: ?clientId=xxx to filter by client
 */
router.get('/mismatches', requireAdmin, getUnresolvedMismatches);

/**
 * POST /api/shipping-methods/mismatches/:mismatchId/resolve
 * Resolve a shipping method mismatch
 */
router.post('/mismatches/:mismatchId/resolve', requireAdmin, resolveMismatch);

export default router;
