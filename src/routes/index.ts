import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import authRoutes from './auth.routes.js';
import clientsRoutes from './clients.routes.js';
import quotationsRoutes from './quotations.routes.js';
import chatRoutes from './chat.routes.js';
import dataRoutes from './data.routes.js';
import shippingMethodsRoutes from './shipping-methods.routes.js';
import notificationsRoutes from './notifications.routes.js';
import fulfillmentRoutes from './fulfillment.routes.js';
import integrationsRoutes, {
  initializeIntegrations,
  startSyncScheduler,
  stopSyncScheduler,
  initializeEnhancedSync,
  startEnhancedSyncProcessors,
  stopEnhancedSyncProcessors,
} from './integrations.routes.js';
import createSyncAdminRoutes from './sync-admin.routes.js';
import { prisma } from '../config/index.js';

const router = Router();

// Health check endpoint
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes
router.use('/auth', authRoutes);

// Clients routes
router.use('/clients', clientsRoutes);

// Quotations routes
router.use('/quotations', quotationsRoutes);

// Chat routes
router.use('/chat', chatRoutes);

// Data routes (Products, Orders, Returns, Inbounds)
router.use('/data', dataRoutes);

// Shipping methods routes (JTL FFN shipping methods, mappings, mismatches)
router.use('/shipping-methods', shippingMethodsRoutes);

// Notifications routes
router.use('/notifications', notificationsRoutes);

// Fulfillment routes (JTL FFN integration)
router.use('/fulfillment', fulfillmentRoutes);

// Integrations routes (Shopify, WooCommerce, JTL)
router.use('/integrations', integrationsRoutes);

// Sync Admin routes (Queue management, Conflicts, Returns, Order Operations)
const syncAdminRoutes = createSyncAdminRoutes(prisma);
router.use('/sync-admin', syncAdminRoutes);

// Export integration lifecycle functions
export {
  initializeIntegrations,
  startSyncScheduler,
  stopSyncScheduler,
  initializeEnhancedSync,
  startEnhancedSyncProcessors,
  stopEnhancedSyncProcessors,
};

export default router;
