#!/usr/bin/env node
/**
 * Test Shopify Product Feeds Bundle Import
 *
 * This script simulates Shopify Product Feeds webhooks to test bundle detection.
 *
 * Usage:
 *   node test-bundle-import-shopify.mjs <channelId> [scenario]
 *
 * Scenarios:
 *   1. bundle-with-components - Bundle product with component details
 *   2. bundle-without-children - Bundle where child products don't exist yet
 *   3. child-product-arrives - Child product that resolves pending links
 *   4. non-bundle-product - Regular product (not a bundle)
 *   5. delete-bundle - Delete bundle product
 */

import crypto from 'crypto';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-key';

const scenarios = {
  'bundle-with-components': {
    topic: 'product_feeds/incremental_sync',
    payload: {
      metadata: {
        action: 'UPDATE',
        type: 'INCREMENTAL',
        resource: 'PRODUCT',
        truncatedFields: [],
        occurred_at: new Date().toISOString(),
      },
      productFeed: {
        id: 'gid://shopify/ProductFeed/12345',
        shop_id: 'gid://shopify/Shop/12345',
        country: 'US',
        language: 'EN',
      },
      product: {
        id: 'gid://shopify/Product/8001',
        title: 'Team Fan Pack Bundle',
        description: 'Complete fan pack with jersey, cap, and scarf',
        handle: 'team-fan-pack',
        isBundle: true,
        isPublished: true,
        createdAt: '2025-01-01T10:00:00-05:00',
        updatedAt: new Date().toISOString(),
        productType: 'Bundle',
        vendor: 'Test Store',
        variants: {
          edges: [
            {
              node: {
                id: 'gid://shopify/ProductVariant/9001',
                title: 'Default',
                price: '99.99',
                sku: 'BUNDLE-FAN-PACK',
                barcode: '123456789',
              },
            },
          ],
        },
        images: {
          edges: [
            {
              node: {
                id: 'gid://shopify/ProductImage/1001',
                url: 'https://cdn.shopify.com/bundle.jpg',
                height: 800,
                width: 800,
              },
            },
          ],
        },
      },
    },
  },

  'bundle-without-children': {
    topic: 'product_feeds/incremental_sync',
    payload: {
      metadata: {
        action: 'CREATE',
        type: 'INCREMENTAL',
        resource: 'PRODUCT',
        truncatedFields: [],
        occurred_at: new Date().toISOString(),
      },
      productFeed: {
        id: 'gid://shopify/ProductFeed/12345',
        shop_id: 'gid://shopify/Shop/12345',
        country: 'US',
        language: 'EN',
      },
      product: {
        id: 'gid://shopify/Product/8002',
        title: 'Gift Set Bundle (No Children Yet)',
        description: 'Bundle with missing child products',
        handle: 'gift-set-bundle',
        isBundle: true,
        isPublished: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        productType: 'Bundle',
        vendor: 'Test Store',
        variants: {
          edges: [
            {
              node: {
                id: 'gid://shopify/ProductVariant/9002',
                title: 'Default',
                price: '149.99',
                sku: 'BUNDLE-GIFT-SET',
                barcode: '987654321',
              },
            },
          ],
        },
      },
    },
  },

  'child-product-arrives': {
    topic: 'product_feeds/incremental_sync',
    payload: {
      metadata: {
        action: 'CREATE',
        type: 'INCREMENTAL',
        resource: 'PRODUCT',
        truncatedFields: [],
        occurred_at: new Date().toISOString(),
      },
      productFeed: {
        id: 'gid://shopify/ProductFeed/12345',
        shop_id: 'gid://shopify/Shop/12345',
        country: 'US',
        language: 'EN',
      },
      product: {
        id: 'gid://shopify/Product/8003',
        title: 'Team Jersey (Child Product)',
        description: 'Official team jersey',
        handle: 'team-jersey',
        isBundle: false,
        isPublished: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        productType: 'Apparel',
        vendor: 'Test Store',
        variants: {
          edges: [
            {
              node: {
                id: 'gid://shopify/ProductVariant/9003',
                title: 'Size M',
                price: '49.99',
                sku: 'JERSEY-M',
                barcode: '111222333',
              },
            },
          ],
        },
      },
    },
  },

  'non-bundle-product': {
    topic: 'product_feeds/incremental_sync',
    payload: {
      metadata: {
        action: 'UPDATE',
        type: 'INCREMENTAL',
        resource: 'PRODUCT',
        truncatedFields: [],
        occurred_at: new Date().toISOString(),
      },
      productFeed: {
        id: 'gid://shopify/ProductFeed/12345',
        shop_id: 'gid://shopify/Shop/12345',
        country: 'US',
        language: 'EN',
      },
      product: {
        id: 'gid://shopify/Product/8004',
        title: 'Regular T-Shirt (Not a Bundle)',
        description: 'Simple t-shirt product',
        handle: 'regular-tshirt',
        isBundle: false,
        isPublished: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        productType: 'Apparel',
        vendor: 'Test Store',
        variants: {
          edges: [
            {
              node: {
                id: 'gid://shopify/ProductVariant/9004',
                title: 'Size L',
                price: '19.99',
                sku: 'TSHIRT-L',
                barcode: '444555666',
              },
            },
          ],
        },
      },
    },
  },

  'delete-bundle': {
    topic: 'product_feeds/incremental_sync',
    payload: {
      metadata: {
        action: 'DELETE',
        type: 'INCREMENTAL',
        resource: 'PRODUCT',
        truncatedFields: [],
        occurred_at: new Date().toISOString(),
      },
      productFeed: {
        id: 'gid://shopify/ProductFeed/12345',
        shop_id: 'gid://shopify/Shop/12345',
        country: 'US',
        language: 'EN',
      },
      product: {
        id: 'gid://shopify/Product/8001',
        title: 'Team Fan Pack Bundle',
        handle: 'team-fan-pack',
        isBundle: true,
        isPublished: false,
        createdAt: '2025-01-01T10:00:00-05:00',
        updatedAt: new Date().toISOString(),
      },
    },
  },
};

function generateHmac(data, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64');
}

async function sendWebhook(channelId, scenario) {
  const scenarioData = scenarios[scenario];
  if (!scenarioData) {
    console.error(`❌ Unknown scenario: ${scenario}`);
    console.log(`Available scenarios: ${Object.keys(scenarios).join(', ')}`);
    process.exit(1);
  }

  const { topic, payload } = scenarioData;
  // Extract just the action part for the URL (e.g., "incremental_sync" from "product_feeds/incremental_sync")
  const topicPath = topic.replace(/\//g, '-');  // Convert slashes to dashes for URL-safe format
  const webhookUrl = `${BASE_URL}/api/integrations/webhooks/shopify-enhanced/${topic}`;
  const body = JSON.stringify(payload);
  const hmac = generateHmac(body, SHOPIFY_SECRET);

  // We need to get the shop domain for this channel
  // For now, use a test domain - in production this would come from the channel config
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN || 'ffn-connector-test.myshopify.com';

  console.log('\n🧪 Shopify Product Feeds Bundle Test');
  console.log('=====================================');
  console.log(`Scenario: ${scenario}`);
  console.log(`Topic: ${topic}`);
  console.log(`URL: ${webhookUrl}`);
  console.log(`Channel ID: ${channelId}`);
  console.log(`Shop Domain: ${shopDomain}`);
  console.log(`Is Bundle: ${payload.product.isBundle}`);
  console.log(`Product ID: ${payload.product.id}`);
  console.log(`SKU: ${payload.product.variants?.edges[0]?.node.sku || 'N/A'}`);
  console.log('');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': topic,
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Shop-Domain': shopDomain,
        'X-Shopify-Webhook-Id': `test-webhook-${Date.now()}`,
      },
      body,
    });

    console.log(`Status: ${response.status} ${response.statusText}`);

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
      console.log('Response:', JSON.stringify(responseData, null, 2));
    } catch {
      console.log('Response:', responseText);
    }

    if (response.ok) {
      console.log('\n✅ Webhook sent successfully!');
      console.log('\n📋 Next Steps:');
      console.log('1. Check application logs for these events:');
      console.log('   - product_feed_webhook');
      if (payload.product.isBundle) {
        console.log('   - bundle_detected_via_feed');
      }
      console.log('\n2. Query database to verify:');
      console.log(`   SELECT * FROM products WHERE sku = '${payload.product.variants?.edges[0]?.node.sku || 'BUNDLE-SKU'}';`);
      if (payload.product.isBundle) {
        console.log(`   SELECT * FROM pending_bundle_links WHERE parent_product_id IN (SELECT id FROM products WHERE sku = '${payload.product.variants?.edges[0]?.node.sku}');`);
      }
    } else {
      console.log('\n❌ Webhook failed!');
      console.log('Check server logs for errors.');
    }
  } catch (error) {
    console.error('\n❌ Error sending webhook:', error.message);
    process.exit(1);
  }
}

// Main execution
const channelId = process.argv[2];
const scenario = process.argv[3] || 'bundle-with-components';

if (!channelId) {
  console.error('❌ Usage: node test-bundle-import-shopify.mjs <channelId> [scenario]');
  console.log('\nAvailable scenarios:');
  Object.keys(scenarios).forEach((s) => {
    console.log(`  - ${s}`);
  });
  process.exit(1);
}

sendWebhook(channelId, scenario);
