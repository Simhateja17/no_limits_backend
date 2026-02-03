#!/usr/bin/env node

/**
 * WooCommerce Webhook Registration Script for sanit-ersatzteile.de
 *
 * This script registers 6 webhooks on the WooCommerce store to enable real-time
 * synchronization with the backend system:
 * - Order Created, Updated, Deleted
 * - Product Created, Updated, Deleted
 *
 * Usage: node backend/register-woocommerce-webhooks.mjs
 */

import { WooCommerceService } from './dist/services/integrations/woocommerce.service.js';

// ============= CONFIGURATION =============

const STORE_CONFIG = {
  url: 'https://sanit-ersatzteile.de',
  consumerKey: 'ck_8ec81f84468307f3851b60bbe91c85db5f7d5073',
  consumerSecret: 'cs_e34609c2a83ddf9d409b56fd324e7e48404161e9',
};

const WEBHOOK_BASE_URL = 'https://no-limits-backend-bub7gvhbbshufug0.germanywestcentral-01.azurewebsites.net/api/integrations';

// Get webhook secret from environment or use default
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || process.env.WOOCOMMERCE_WEBHOOK_SECRET || 'webhook-secret';

// ============= MAIN FUNCTION =============

async function registerWebhooks() {
  console.log('🔗 WooCommerce Webhook Registration');
  console.log('====================================');
  console.log(`Store: ${STORE_CONFIG.url}`);
  console.log(`Backend: ${WEBHOOK_BASE_URL}`);
  console.log(`Secret: ${WEBHOOK_SECRET.substring(0, 10)}...`);
  console.log('');

  try {
    // Step 1: Create WooCommerce service instance
    console.log('📦 Creating WooCommerce service instance...');
    const wooService = new WooCommerceService(STORE_CONFIG);
    console.log('✅ Service instance created\n');

    // Step 2: Test connection first
    console.log('🔌 Testing connection to WooCommerce...');
    const connectionTest = await wooService.testConnection();

    if (!connectionTest.success) {
      console.error('❌ Connection test failed:', connectionTest.message);
      console.error('');
      console.error('Possible causes:');
      console.error('  1. Invalid consumer key or secret');
      console.error('  2. Store URL is incorrect');
      console.error('  3. API credentials do not have proper permissions');
      console.error('  4. Network connectivity issue');
      process.exit(2);
    }

    console.log(`✅ ${connectionTest.message}\n`);

    // Step 3: Register webhooks
    console.log('📡 Registering webhooks...');
    console.log('');

    const result = await wooService.registerSyncWebhooks(WEBHOOK_BASE_URL, WEBHOOK_SECRET);

    // Step 4: Display results
    console.log('');
    console.log('📊 Registration Results:');
    console.log('========================');
    console.log(`Total Processed: ${result.itemsProcessed}`);
    console.log(`Successful: ${result.itemsProcessed - result.itemsFailed}`);
    console.log(`Failed: ${result.itemsFailed}`);
    console.log('');

    // Display individual results
    if (result.details && result.details.length > 0) {
      console.log('Webhook Details:');
      console.log('----------------');

      for (const detail of result.details) {
        const status = detail.success ? '✅' : '❌';
        const topic = detail.externalId;

        if (detail.success) {
          console.log(`${status} ${topic.padEnd(20)} - Created successfully`);
        } else {
          console.log(`${status} ${topic.padEnd(20)} - Failed: ${detail.error}`);
        }
      }

      console.log('');
    }

    // Step 5: Final summary and exit
    if (result.success) {
      console.log('✅ SUCCESS: All webhooks registered successfully!');
      console.log('');
      console.log('Next Steps:');
      console.log('  1. Verify webhooks in WooCommerce Admin → Settings → Advanced → Webhooks');
      console.log('  2. Create a test order to verify real-time sync is working');
      console.log('  3. Check backend logs to confirm webhook reception');
      console.log('');
      process.exit(0);
    } else if (result.itemsProcessed > result.itemsFailed) {
      console.log('⚠️  PARTIAL SUCCESS: Some webhooks failed to register');
      console.log('');
      console.log('Action Required:');
      console.log('  1. Check error messages above');
      console.log('  2. Manually create failed webhooks in WooCommerce Admin');
      console.log('  3. Or fix the issues and run this script again');
      console.log('');
      process.exit(1);
    } else {
      console.log('❌ FAILURE: All webhooks failed to register');
      console.log('');
      console.log('Common Issues:');
      console.log('  1. Webhooks already exist (delete them first)');
      console.log('  2. API credentials lack write permissions');
      console.log('  3. Network or CORS issues');
      console.log('');
      process.exit(2);
    }

  } catch (error) {
    console.error('');
    console.error('❌ CRITICAL ERROR:');
    console.error('==================');
    console.error(error.message);

    if (error.stack) {
      console.error('');
      console.error('Stack Trace:');
      console.error(error.stack);
    }

    console.error('');
    process.exit(2);
  }
}

// ============= EXECUTE =============

registerWebhooks();
