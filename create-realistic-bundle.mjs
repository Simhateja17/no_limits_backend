#!/usr/bin/env node
/**
 * Create Realistic Bundle Test
 *
 * Creates a bundle product using ACTUAL products from the Shopify store
 *
 * Bundle: "Premium Shirt Collection Bundle"
 * Components:
 *   - shirt-1 (qty: 1)
 *   - shirt-2 (qty: 1)
 *   - Example T-Shirt (qty: 2)
 */

import crypto from 'crypto';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret-key';
const channelId = process.argv[2];
const shopDomain = process.argv[3] || 'ffn-connector-test.myshopify.com';

if (!channelId) {
  console.error('❌ Usage: node create-realistic-bundle.mjs <channelId> [shopDomain]');
  process.exit(1);
}

// Realistic bundle with actual products from the store
const bundlePayload = {
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
    id: 'gid://shopify/Product/99999',  // New bundle product ID
    title: 'Premium Shirt Collection Bundle',
    description: 'Complete shirt collection with 2 premium shirts and 2 basic tees',
    handle: 'premium-shirt-collection',
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
            id: 'gid://shopify/ProductVariant/99999',
            title: 'Default',
            price: '1198.98',  // Sum of components: 198 + 981 + (19.99*2)
            sku: 'BUNDLE-PREMIUM-SHIRTS',
            barcode: '999888777666',
          },
        },
      ],
    },
    images: {
      edges: [
        {
          node: {
            id: 'gid://shopify/ProductImage/9999',
            url: 'https://cdn.shopify.com/bundle-premium.jpg',
            height: 1000,
            width: 1000,
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

async function sendBundleWebhook() {
  const topic = 'product_feeds/incremental_sync';
  const webhookUrl = `${BASE_URL}/api/integrations/webhooks/shopify-enhanced/${topic}`;
  const body = JSON.stringify(bundlePayload);
  const hmac = generateHmac(body, SHOPIFY_SECRET);

  console.log('\n🎁 Creating Realistic Bundle Product');
  console.log('======================================');
  console.log(`Bundle: Premium Shirt Collection Bundle`);
  console.log(`SKU: BUNDLE-PREMIUM-SHIRTS`);
  console.log(`Price: €1,198.98`);
  console.log('');
  console.log('📦 Bundle Components (from actual products in store):');
  console.log('   1. shirt-1 (qty: 1) - €198.00');
  console.log('      External ID: 10384018702677');
  console.log('      SKU: shirt-1-sku');
  console.log('');
  console.log('   2. shirt-2 (qty: 1) - €981.00');
  console.log('      External ID: 10384019587413');
  console.log('      SKU: shirt-2-sku');
  console.log('');
  console.log('   3. Example T-Shirt (qty: 2) - €19.99 each');
  console.log('      External ID: 788032119674292900');
  console.log('      SKU: SHOPIFY-788032119674292900');
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
        'X-Shopify-Webhook-Id': `test-bundle-${Date.now()}`,
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
      console.log('\n📋 Next Steps:');
      console.log('1. Verify bundle in database:');
      console.log(`   node verify-bundle-test.cjs BUNDLE-PREMIUM-SHIRTS`);
      console.log('');
      console.log('2. Now we need to simulate GraphQL sync to fetch component details.');
      console.log('   I will create a script to simulate bundleComponents being fetched.');
      console.log('');
      console.log('3. Expected result:');
      console.log('   - Product created with isBundle: true ✅');
      console.log('   - BundleItem records created linking to actual child products ✅');
      console.log('   - No PendingBundleLinks (children already exist) ✅');
    } else {
      console.log('\n❌ Bundle creation failed!');
      console.log('Check server logs for errors.');
    }
  } catch (error) {
    console.error('\n❌ Error sending webhook:', error.message);
    process.exit(1);
  }
}

sendBundleWebhook();
