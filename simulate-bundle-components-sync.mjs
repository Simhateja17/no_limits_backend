#!/usr/bin/env node
/**
 * Simulate Bundle Components Sync
 *
 * Simulates a GraphQL product sync that fetches bundleComponents details
 * and creates BundleItem records linking to actual child products
 */

import crypto from 'crypto';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-key';
const channelId = process.argv[2];
const shopDomain = process.argv[3] || 'ffn-connector-test.myshopify.com';

if (!channelId) {
  console.error('❌ Usage: node simulate-bundle-components-sync.mjs <channelId> [shopDomain]');
  process.exit(1);
}

// Enhanced webhook with bundleComponents details
// This simulates what would come from a GraphQL sync cycle
const enhancedBundlePayload = {
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
    id: 'gid://shopify/Product/99999',  // Same bundle product ID
    title: 'Premium Shirt Collection Bundle',
    description: 'Complete shirt collection with 2 premium shirts and 2 basic tees',
    handle: 'premium-shirt-collection',
    isBundle: true,
    isPublished: true,
    createdAt: '2026-02-11T00:00:00-05:00',
    updatedAt: new Date().toISOString(),
    productType: 'Bundle',
    vendor: 'Test Store',
    variants: {
      edges: [
        {
          node: {
            id: 'gid://shopify/ProductVariant/99999',
            title: 'Default',
            price: '1198.98',
            sku: 'BUNDLE-PREMIUM-SHIRTS',
            barcode: '999888777666',
          },
        },
      ],
    },
    // NEW: bundleComponents (simulating GraphQL query result)
    bundleComponents: {
      edges: [
        {
          node: {
            componentProduct: {
              id: 'gid://shopify/Product/10384018702677',
              legacyResourceId: '10384018702677',
              title: 'shirt-1',
              variants: {
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/ProductVariant/10384018702677',
                      legacyResourceId: '10384018702677',
                      sku: 'shirt-1-sku',
                    },
                  },
                ],
              },
            },
            quantity: 1,
          },
        },
        {
          node: {
            componentProduct: {
              id: 'gid://shopify/Product/10384019587413',
              legacyResourceId: '10384019587413',
              title: 'shirt-2',
              variants: {
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/ProductVariant/10384019587413',
                      legacyResourceId: '10384019587413',
                      sku: 'shirt-2-sku',
                    },
                  },
                ],
              },
            },
            quantity: 1,
          },
        },
        {
          node: {
            componentProduct: {
              id: 'gid://shopify/Product/788032119674292900',
              legacyResourceId: '788032119674292900',
              title: 'Example T-Shirt',
              variants: {
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/ProductVariant/788032119674292900',
                      legacyResourceId: '788032119674292900',
                      sku: 'SHOPIFY-788032119674292900',
                    },
                  },
                ],
              },
            },
            quantity: 2,
          },
        },
      ],
    },
  },
};

function generateHmac(data, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64');
}

async function sendComponentsSync() {
  const topic = 'product_feeds/incremental_sync';
  const webhookUrl = `${BASE_URL}/api/integrations/webhooks/shopify-enhanced/${topic}`;
  const body = JSON.stringify(enhancedBundlePayload);
  const hmac = generateHmac(body, SHOPIFY_SECRET);

  console.log('\n🔄 Simulating GraphQL Bundle Components Sync');
  console.log('=============================================');
  console.log(`Bundle: Premium Shirt Collection Bundle`);
  console.log(`SKU: BUNDLE-PREMIUM-SHIRTS`);
  console.log('');
  console.log('📦 Bundle Components (WITH component details):');
  console.log('   1. shirt-1 (qty: 1)');
  console.log('      External ID: 10384018702677');
  console.log('      SKU: shirt-1-sku');
  console.log('      → Should create BundleItem (child exists)');
  console.log('');
  console.log('   2. shirt-2 (qty: 1)');
  console.log('      External ID: 10384019587413');
  console.log('      SKU: shirt-2-sku');
  console.log('      → Should create BundleItem (child exists)');
  console.log('');
  console.log('   3. Example T-Shirt (qty: 2)');
  console.log('      External ID: 788032119674292900');
  console.log('      SKU: SHOPIFY-788032119674292900');
  console.log('      → Should create BundleItem (child exists)');
  console.log('');
  console.log(`URL: ${webhookUrl}`);
  console.log(`Channel ID: ${channelId}`);
  console.log('');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': topic,
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Shop-Domain': shopDomain,
        'X-Shopify-Webhook-Id': `test-components-${Date.now()}`,
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
      console.log('\n✅ Components sync completed!');
      console.log('\n📋 Verification Steps:');
      console.log('1. Check bundle product:');
      console.log(`   node verify-bundle-test.cjs BUNDLE-PREMIUM-SHIRTS`);
      console.log('');
      console.log('2. Query BundleItems:');
      console.log(`   SELECT
     parent.sku as parent_sku,
     child.sku as child_sku,
     bi.quantity
   FROM bundle_items bi
   JOIN products parent ON bi.parent_product_id = parent.id
   JOIN products child ON bi.child_product_id = child.id
   WHERE parent.sku = 'BUNDLE-PREMIUM-SHIRTS';`);
      console.log('');
      console.log('3. Expected results:');
      console.log('   ✅ 3 BundleItem records created');
      console.log('   ✅ shirt-1 (qty: 1)');
      console.log('   ✅ shirt-2 (qty: 1)');
      console.log('   ✅ Example T-Shirt (qty: 2)');
      console.log('   ✅ No PendingBundleLinks (all children exist)');
    } else {
      console.log('\n❌ Components sync failed!');
      console.log('Check server logs for errors.');
    }
  } catch (error) {
    console.error('\n❌ Error sending webhook:', error.message);
    process.exit(1);
  }
}

sendComponentsSync();
