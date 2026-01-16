/**
 * Shopify Service Factory
 * Creates either REST or GraphQL service based on configuration
 */

import { ShopifyService } from './shopify.service.js';
import { ShopifyGraphQLService } from './shopify-graphql.service.js';
import { ShopifyCredentials } from './types.js';

export interface ShopifyServiceOptions {
  /**
   * Use GraphQL API instead of REST API
   * @default false
   */
  useGraphQL?: boolean;
}

/**
 * Union type for both Shopify service implementations
 * Both implement the same interface for drop-in replacement
 */
export type ShopifyServiceInstance = ShopifyService | ShopifyGraphQLService;

/**
 * Create a Shopify service instance
 * @param credentials - Shopify API credentials
 * @param options - Service options
 * @returns ShopifyService (REST) or ShopifyGraphQLService based on options
 */
export function createShopifyService(
  credentials: ShopifyCredentials,
  options: ShopifyServiceOptions = {}
): ShopifyServiceInstance {
  if (options.useGraphQL) {
    console.log('[ShopifyFactory] Creating GraphQL service');
    return new ShopifyGraphQLService(credentials);
  }

  console.log('[ShopifyFactory] Creating REST service');
  return new ShopifyService(credentials);
}

/**
 * Check if a service is using GraphQL
 */
export function isGraphQLService(service: ShopifyServiceInstance): service is ShopifyGraphQLService {
  return service instanceof ShopifyGraphQLService;
}

/**
 * Check if a service is using REST
 */
export function isRESTService(service: ShopifyServiceInstance): service is ShopifyService {
  return service instanceof ShopifyService;
}

/**
 * Environment variable to enable GraphQL globally
 */
export function shouldUseGraphQL(): boolean {
  return process.env.SHOPIFY_USE_GRAPHQL === 'true';
}

/**
 * Create a Shopify service with automatic selection based on environment
 * @param credentials - Shopify API credentials
 * @param forceGraphQL - Force GraphQL regardless of environment
 * @returns ShopifyService or ShopifyGraphQLService
 */
export function createShopifyServiceAuto(
  credentials: ShopifyCredentials,
  forceGraphQL?: boolean
): ShopifyServiceInstance {
  const useGraphQL = forceGraphQL ?? shouldUseGraphQL();
  return createShopifyService(credentials, { useGraphQL });
}

export default createShopifyService;
