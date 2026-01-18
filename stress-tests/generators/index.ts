/**
 * Generators Index
 * Exports all order generators for easy access
 */

export * from './shopify-order.generator.js';
export * from './woocommerce-order.generator.js';

import { ShopifyOrderGenerator, shopifyOrderGenerator } from './shopify-order.generator.js';
import { WooCommerceOrderGenerator, wooCommerceOrderGenerator } from './woocommerce-order.generator.js';
import { testDataConfig } from '../config/stress-test.config.js';

export interface MixedOrderBatch {
  shopify: ReturnType<ShopifyOrderGenerator['generate']>[];
  woocommerce: ReturnType<WooCommerceOrderGenerator['generate']>[];
  total: number;
  shopifyCount: number;
  woocommerceCount: number;
}

/**
 * Generate a mixed batch of orders from both platforms
 */
export function generateMixedOrderBatch(
  totalOrders: number,
  shopifyPercentage: number = 50
): MixedOrderBatch {
  const shopifyCount = Math.round(totalOrders * (shopifyPercentage / 100));
  const woocommerceCount = totalOrders - shopifyCount;

  return {
    shopify: shopifyOrderGenerator.generateBatch(shopifyCount),
    woocommerce: wooCommerceOrderGenerator.generateBatch(woocommerceCount),
    total: totalOrders,
    shopifyCount,
    woocommerceCount,
  };
}

/**
 * Generate mixed webhook payloads for stress testing
 */
export function generateMixedWebhookPayloads(
  totalOrders: number,
  shopifyPercentage: number = 50
): Array<{
  platform: 'shopify' | 'woocommerce';
  payload: ReturnType<ShopifyOrderGenerator['generateWebhookPayload']> | ReturnType<WooCommerceOrderGenerator['generateWebhookPayload']>;
}> {
  const shopifyCount = Math.round(totalOrders * (shopifyPercentage / 100));
  const woocommerceCount = totalOrders - shopifyCount;
  
  const payloads: Array<{
    platform: 'shopify' | 'woocommerce';
    payload: any;
  }> = [];

  // Generate Shopify payloads
  for (let i = 0; i < shopifyCount; i++) {
    payloads.push({
      platform: 'shopify',
      payload: shopifyOrderGenerator.generateWebhookPayload(),
    });
  }

  // Generate WooCommerce payloads
  for (let i = 0; i < woocommerceCount; i++) {
    payloads.push({
      platform: 'woocommerce',
      payload: wooCommerceOrderGenerator.generateWebhookPayload(),
    });
  }

  // Shuffle to mix platforms
  for (let i = payloads.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [payloads[i], payloads[j]] = [payloads[j], payloads[i]];
  }

  return payloads;
}

/**
 * Reset all generators (useful for reproducible tests)
 */
export function resetAllGenerators(): void {
  shopifyOrderGenerator.resetCounters();
  wooCommerceOrderGenerator.resetCounters();
}

/**
 * Get test data configuration
 */
export function getTestDataConfig() {
  return testDataConfig;
}
