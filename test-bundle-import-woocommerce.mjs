#!/usr/bin/env node
/**
 * Test WooCommerce Bundle Import
 *
 * This script simulates WooCommerce product webhooks to test bundle detection.
 *
 * Usage:
 *   node test-bundle-import-woocommerce.mjs <channelId> [scenario]
 *
 * Scenarios:
 *   1. bundle-with-items - Bundle product with bundled items
 *   2. bundle-without-children - Bundle where child products don't exist yet
 *   3. child-product-arrives - Child product that resolves pending links
 *   4. simple-product - Regular product (not a bundle)
 *   5. update-bundle-quantity - Update bundle component quantities
 */

import crypto from 'crypto';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const WC_SECRET = process.env.WC_WEBHOOK_SECRET || 'test-wc-secret';

const scenarios = {
  'bundle-with-items': {
    topic: 'product.updated',
    payload: {
      id: 5001,
      name: 'Complete Starter Kit Bundle',
      slug: 'starter-kit-bundle',
      type: 'bundle',
      status: 'publish',
      description: '<p>Everything you need to get started</p>',
      short_description: '<p>Complete starter kit</p>',
      sku: 'WC-BUNDLE-STARTER',
      price: '199.99',
      regular_price: '199.99',
      sale_price: '',
      stock_quantity: 50,
      stock_status: 'instock',
      manage_stock: true,
      weight: '5.5',
      dimensions: {
        length: '30',
        width: '20',
        height: '15',
      },
      images: [
        {
          id: 1001,
          src: 'https://example.com/bundle-starter.jpg',
          name: 'Starter Kit Bundle',
          alt: 'Complete Starter Kit',
        },
      ],
      categories: [
        { id: 10, name: 'Bundles', slug: 'bundles' },
      ],
      tags: [
        { id: 20, name: 'Starter', slug: 'starter' },
      ],
      bundled_items: [
        {
          product_id: 5010,
          quantity_default: 1,
          quantity_min: 1,
          quantity_max: 1,
        },
        {
          product_id: 5011,
          quantity_default: 2,
          quantity_min: 1,
          quantity_max: 5,
        },
        {
          product_id: 5012,
          quantity_default: 1,
          quantity_min: 1,
          quantity_max: 1,
        },
      ],
      date_created: '2025-01-01T10:00:00',
      date_modified: new Date().toISOString(),
    },
  },

  'bundle-without-children': {
    topic: 'product.created',
    payload: {
      id: 5002,
      name: 'Premium Bundle (Missing Children)',
      slug: 'premium-bundle',
      type: 'bundle',
      status: 'publish',
      description: '<p>Premium bundle with items not yet imported</p>',
      short_description: '<p>Premium bundle</p>',
      sku: 'WC-BUNDLE-PREMIUM',
      price: '299.99',
      regular_price: '299.99',
      sale_price: '',
      stock_quantity: 25,
      stock_status: 'instock',
      manage_stock: true,
      weight: '8.0',
      dimensions: {
        length: '40',
        width: '30',
        height: '20',
      },
      images: [
        {
          id: 1002,
          src: 'https://example.com/bundle-premium.jpg',
          name: 'Premium Bundle',
          alt: 'Premium Bundle',
        },
      ],
      categories: [
        { id: 10, name: 'Bundles', slug: 'bundles' },
      ],
      bundled_items: [
        {
          product_id: 5020,
          quantity_default: 1,
          quantity_min: 1,
          quantity_max: 1,
        },
        {
          product_id: 5021,
          quantity_default: 3,
          quantity_min: 1,
          quantity_max: 10,
        },
      ],
      date_created: new Date().toISOString(),
      date_modified: new Date().toISOString(),
    },
  },

  'child-product-arrives': {
    topic: 'product.created',
    payload: {
      id: 5010,
      name: 'Base Unit (Child Product)',
      slug: 'base-unit',
      type: 'simple',
      status: 'publish',
      description: '<p>Base unit component</p>',
      short_description: '<p>Base unit</p>',
      sku: 'WC-BASE-UNIT',
      price: '49.99',
      regular_price: '49.99',
      sale_price: '',
      stock_quantity: 100,
      stock_status: 'instock',
      manage_stock: true,
      weight: '1.5',
      dimensions: {
        length: '15',
        width: '10',
        height: '8',
      },
      images: [
        {
          id: 1010,
          src: 'https://example.com/base-unit.jpg',
          name: 'Base Unit',
          alt: 'Base Unit',
        },
      ],
      categories: [
        { id: 11, name: 'Components', slug: 'components' },
      ],
      bundled_by: [5001], // Referenced by bundle 5001
      date_created: new Date().toISOString(),
      date_modified: new Date().toISOString(),
    },
  },

  'simple-product': {
    topic: 'product.updated',
    payload: {
      id: 5030,
      name: 'Simple Product (Not a Bundle)',
      slug: 'simple-product',
      type: 'simple',
      status: 'publish',
      description: '<p>Regular simple product</p>',
      short_description: '<p>Simple product</p>',
      sku: 'WC-SIMPLE-001',
      price: '29.99',
      regular_price: '29.99',
      sale_price: '',
      stock_quantity: 200,
      stock_status: 'instock',
      manage_stock: true,
      weight: '0.5',
      dimensions: {
        length: '10',
        width: '8',
        height: '5',
      },
      images: [
        {
          id: 1030,
          src: 'https://example.com/simple.jpg',
          name: 'Simple Product',
          alt: 'Simple Product',
        },
      ],
      categories: [
        { id: 12, name: 'Accessories', slug: 'accessories' },
      ],
      date_created: '2025-01-01T12:00:00',
      date_modified: new Date().toISOString(),
    },
  },

  'update-bundle-quantity': {
    topic: 'product.updated',
    payload: {
      id: 5001,
      name: 'Complete Starter Kit Bundle',
      slug: 'starter-kit-bundle',
      type: 'bundle',
      status: 'publish',
      description: '<p>Everything you need to get started (updated quantities)</p>',
      short_description: '<p>Complete starter kit</p>',
      sku: 'WC-BUNDLE-STARTER',
      price: '199.99',
      regular_price: '199.99',
      sale_price: '',
      stock_quantity: 45,
      stock_status: 'instock',
      manage_stock: true,
      weight: '5.5',
      dimensions: {
        length: '30',
        width: '20',
        height: '15',
      },
      images: [
        {
          id: 1001,
          src: 'https://example.com/bundle-starter.jpg',
          name: 'Starter Kit Bundle',
          alt: 'Complete Starter Kit',
        },
      ],
      categories: [
        { id: 10, name: 'Bundles', slug: 'bundles' },
      ],
      bundled_items: [
        {
          product_id: 5010,
          quantity_default: 2, // Changed from 1 to 2
          quantity_min: 1,
          quantity_max: 1,
        },
        {
          product_id: 5011,
          quantity_default: 5, // Changed from 2 to 5
          quantity_min: 1,
          quantity_max: 10,
        },
        // Removed product_id 5012
      ],
      date_created: '2025-01-01T10:00:00',
      date_modified: new Date().toISOString(),
    },
  },
};

function generateSignature(data, secret) {
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
  const webhookUrl = `${BASE_URL}/api/integrations/webhooks/woocommerce-enhanced/${topic}`;
  const body = JSON.stringify(payload);
  const signature = generateSignature(body, WC_SECRET);

  console.log('\n🧪 WooCommerce Bundle Import Test');
  console.log('===================================');
  console.log(`Scenario: ${scenario}`);
  console.log(`Topic: ${topic}`);
  console.log(`URL: ${webhookUrl}`);
  console.log(`Channel ID: ${channelId}`);
  console.log(`Product Type: ${payload.type}`);
  console.log(`Is Bundle: ${payload.type === 'bundle'}`);
  console.log(`Product ID: ${payload.id}`);
  console.log(`SKU: ${payload.sku}`);
  if (payload.bundled_items) {
    console.log(`Bundle Items: ${payload.bundled_items.length}`);
  }
  console.log('');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WC-Webhook-Topic': topic,
        'X-WC-Webhook-Signature': signature,
        'X-WC-Webhook-Source': 'https://test-store.com',
        'X-WC-Webhook-ID': `${Date.now()}`,
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
      console.log('1. Check application logs for bundle processing events');
      console.log('\n2. Query database to verify:');
      console.log(`   SELECT * FROM products WHERE sku = '${payload.sku}';`);
      if (payload.type === 'bundle') {
        console.log(`   SELECT * FROM bundle_items WHERE parent_product_id IN (SELECT id FROM products WHERE sku = '${payload.sku}');`);
        console.log(`   SELECT * FROM pending_bundle_links WHERE parent_product_id IN (SELECT id FROM products WHERE sku = '${payload.sku}');`);
      }
      if (payload.bundled_by?.length) {
        console.log(`   -- This product should resolve pending bundle links for bundles: ${payload.bundled_by.join(', ')}`);
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
const scenario = process.argv[3] || 'bundle-with-items';

if (!channelId) {
  console.error('❌ Usage: node test-bundle-import-woocommerce.mjs <channelId> [scenario]');
  console.log('\nAvailable scenarios:');
  Object.keys(scenarios).forEach((s) => {
    console.log(`  - ${s}`);
  });
  process.exit(1);
}

sendWebhook(channelId, scenario);
