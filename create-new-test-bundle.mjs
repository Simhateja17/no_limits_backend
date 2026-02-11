#!/usr/bin/env node
/**
 * Create New Test Bundle from Shopify Product Feeds Webhook
 *
 * Simulates a Shopify Product Feeds webhook for a new bundle product
 * This tests the complete bundle import flow with bundlePrice auto-population
 */

import crypto from 'crypto';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-key';
const channelId = process.argv[2];
const shopDomain = process.argv[3] || 'ffn-connector-test.myshopify.com';

if (!channelId) {
  console.error('❌ Usage: node create-new-test-bundle.mjs <channelId> [shopDomain]');
  process.exit(1);
}

// New bundle product with different ID
const newBundlePayload = {
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
    id: 'gid://shopify/Product/88888',  // New bundle ID
    title: 'Office Essentials Bundle',
    description: 'Complete office supply bundle with 2 shirts and 4 t-shirts',
    handle: 'office-essentials-bundle',
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
            id: 'gid://shopify/ProductVariant/88888',
            title: 'Default',
            price: '2337.96',  // 198 + 981 + (19.99 * 4) = 2,258.96 → rounded to 2,337.96
            sku: 'BUNDLE-OFFICE-ESSENTIALS',
            barcode: '888777666555',
          },
        },
      ],
    },
    // Bundle components will be fetched later via GraphQL
    // But bundle is marked immediately via isBundle flag
  },
};

function generateHmac(data, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64');
}

async function createNewBundle() {
  const topic = 'product_feeds/incremental_sync';
  const webhookUrl = `${BASE_URL}/api/integrations/webhooks/shopify-enhanced/${topic}`;
  const body = JSON.stringify(newBundlePayload);
  const hmac = generateHmac(body, SHOPIFY_SECRET);

  console.log('\n🎁 Creating New Test Bundle from Shopify');
  console.log('=========================================');
  console.log(`Bundle: Office Essentials Bundle`);
  console.log(`SKU: BUNDLE-OFFICE-ESSENTIALS`);
  console.log(`Price: €2,337.96`);
  console.log(`isBundle: true`);
  console.log('');
  console.log('📋 Expected Behavior:');
  console.log('   1. Product created with isBundle: true');
  console.log('   2. netSalesPrice: 2337.96');
  console.log('   3. bundlePrice: 2337.96  ✅ AUTO-SET!');
  console.log('   4. No bundleComponents yet (will be fetched via GraphQL later)');
  console.log('');
  console.log(`URL: ${webhookUrl}`);
  console.log(`Channel ID: ${channelId}`);
  console.log(`Shop Domain: ${shopDomain}`);
  console.log('');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': topic,
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Shop-Domain': shopDomain,
        'X-Shopify-Webhook-Id': `test-new-bundle-${Date.now()}`,
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
      console.log('\n✅ Bundle created successfully!');
      console.log('\n📋 Verification:');
      console.log('1. Check database:');
      console.log(`   SELECT sku, "isBundle", "netSalesPrice", "bundlePrice"`);
      console.log(`   FROM products`);
      console.log(`   WHERE sku = 'BUNDLE-OFFICE-ESSENTIALS';`);
      console.log('');
      console.log('2. Expected result:');
      console.log('   sku: BUNDLE-OFFICE-ESSENTIALS');
      console.log('   isBundle: true  ✅');
      console.log('   netSalesPrice: 2337.96  ✅');
      console.log('   bundlePrice: 2337.96  ✅ NEW FIX WORKING!');
      console.log('');
      console.log('3. Next step:');
      console.log('   Simulate GraphQL sync to add bundle components:');
      console.log(`   node simulate-bundle-components-sync.mjs ${channelId}`);
    } else {
      console.log('\n❌ Bundle creation failed!');
      console.log('Check server logs for errors.');
    }
  } catch (error) {
    console.error('\n❌ Error sending webhook:', error.message);
    process.exit(1);
  }
}

createNewBundle();
