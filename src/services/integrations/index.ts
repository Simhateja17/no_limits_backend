/**
 * Integration Services Index
 * Export all integration services and types
 */

export * from './types.js';
export { ShopifyService } from './shopify.service.js';
export { ShopifyGraphQLService } from './shopify-graphql.service.js';
export {
  createShopifyService,
  createShopifyServiceAuto,
  isGraphQLService,
  isRESTService,
  shouldUseGraphQL,
} from './shopify-service-factory.js';
export type { ShopifyServiceOptions, ShopifyServiceInstance } from './shopify-service-factory.js';
export { WooCommerceService } from './woocommerce.service.js';
export { JTLService } from './jtl.service.js';
export { SyncOrchestrator } from './sync-orchestrator.js';
export { SyncScheduler } from './sync-scheduler.js';
export { ClientOnboardingService } from './client-onboarding.service.js';
export { ChannelDataService } from './channel-data.service.js';
export { WebhookProcessorService } from './webhook-processor.service.js';
export { BiDirectionalSyncService } from './bidirectional-sync.service.js';

// New bi-directional sync with origin tracking
export { ProductSyncService, FIELD_OWNERSHIP } from './product-sync.service.js';
export type { ProductSyncResult, FieldConflict, SyncOriginType, IncomingProductData } from './product-sync.service.js';
export { EnhancedWebhookProcessor } from './enhanced-webhook-processor.service.js';
export type { WebhookEvent, WebhookProcessResult } from './enhanced-webhook-processor.service.js';
export { SyncQueueProcessor, JTLPollingService } from './sync-queue-processor.service.js';
