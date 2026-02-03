#!/usr/bin/env npx tsx
/**
 * Real Order Creation Script for r.kutke@gmx.de
 *
 * Creates real orders in the WooCommerce store to test webhook integration.
 * Orders will flow through the real system: WooCommerce → Webhook → Backend → JTL-FFN
 *
 * Usage:
 *   npx tsx stress-tests/scripts/r-kutke-order-test.ts --url https://store.com --key ck_xxx --secret cs_xxx --count 5
 *
 * Or using environment variables:
 *   export RKUTKE_WOOCOMMERCE_URL=https://store.com
 *   export RKUTKE_WOOCOMMERCE_KEY=ck_xxx
 *   export RKUTKE_WOOCOMMERCE_SECRET=cs_xxx
 *   npx tsx stress-tests/scripts/r-kutke-order-test.ts --count 5
 *
 * Options:
 *   --url       WooCommerce store URL (required)
 *   --key       Consumer key (required)
 *   --secret    Consumer secret (required)
 *   --count     Number of orders to create (default: 5)
 *   --delay     Delay between orders in ms (default: 1000)
 *   --dry-run   Print orders without creating them
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

interface WooCommerceOrderInput {
  payment_method: string;
  payment_method_title: string;
  set_paid: boolean;
  status: 'pending' | 'processing' | 'on-hold' | 'completed' | 'cancelled' | 'refunded' | 'failed';
  billing: {
    first_name: string;
    last_name: string;
    address_1: string;
    address_2?: string;
    city: string;
    state?: string;
    postcode: string;
    country: string;
    email: string;
    phone?: string;
  };
  shipping: {
    first_name: string;
    last_name: string;
    address_1: string;
    address_2?: string;
    city: string;
    state?: string;
    postcode: string;
    country: string;
  };
  line_items: Array<{
    product_id?: number;
    name: string;
    quantity: number;
    price?: string;
    sku?: string;
    total: string;
  }>;
  shipping_lines: Array<{
    method_id: string;
    method_title: string;
    total: string;
  }>;
  customer_note?: string;
  meta_data?: Array<{ key: string; value: string }>;
}

interface OrderCreateConfig {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  orderCount: number;
  delayBetweenOrders: number;
  dryRun: boolean;
  apiVersion: string;
}

// Test data pools (German addresses for r.kutke)
const TEST_DATA = {
  firstNames: ['Max', 'Anna', 'Felix', 'Julia', 'Leon', 'Sophie', 'Paul', 'Emma', 'Jonas', 'Mia'],
  lastNames: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann'],
  cities: [
    { name: 'Berlin', zip: '10115' },
    { name: 'München', zip: '80331' },
    { name: 'Hamburg', zip: '20095' },
    { name: 'Köln', zip: '50667' },
    { name: 'Frankfurt', zip: '60311' },
    { name: 'Stuttgart', zip: '70173' },
    { name: 'Düsseldorf', zip: '40213' },
    { name: 'Leipzig', zip: '04109' },
    { name: 'Dresden', zip: '01067' },
    { name: 'Hannover', zip: '30159' },
  ],
  streets: [
    'Hauptstraße', 'Berliner Straße', 'Schulstraße', 'Bahnhofstraße',
    'Gartenstraße', 'Dorfstraße', 'Ringstraße', 'Kirchstraße',
    'Waldstraße', 'Parkstraße',
  ],
  // NOTE: Replace these with actual products from r.kutke's WooCommerce store
  // You can get real product data from: WooCommerce → Products → (view product) → copy SKU
  products: [
    { name: 'Test Product 1', price: '29.99', sku: 'TEST-001' },
    { name: 'Test Product 2', price: '59.99', sku: 'TEST-002' },
    { name: 'Test Product 3', price: '19.99', sku: 'TEST-003' },
    { name: 'Test Product 4', price: '14.99', sku: 'TEST-004' },
    { name: 'Test Product 5', price: '79.99', sku: 'TEST-005' },
  ],
  shippingMethods: [
    { id: 'flat_rate', title: 'Standardversand', price: '4.99' },
    { id: 'free_shipping', title: 'Kostenloser Versand', price: '0.00' },
    { id: 'express', title: 'Express Versand', price: '9.99' },
  ],
  paymentMethods: [
    { id: 'bacs', title: 'Direct Bank Transfer' },
    { id: 'paypal', title: 'PayPal' },
    { id: 'cod', title: 'Cash on Delivery' },
  ],
};

function randomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function generateTestOrder(index: number): WooCommerceOrderInput {
  const firstName = randomElement(TEST_DATA.firstNames);
  const lastName = randomElement(TEST_DATA.lastNames);
  const city = randomElement(TEST_DATA.cities);
  const street = randomElement(TEST_DATA.streets);
  const houseNumber = Math.floor(Math.random() * 150) + 1;
  const shippingMethod = randomElement(TEST_DATA.shippingMethods);
  const paymentMethod = randomElement(TEST_DATA.paymentMethods);

  // Generate 1-3 line items
  const numItems = Math.floor(Math.random() * 3) + 1;
  const lineItems: WooCommerceOrderInput['line_items'] = [];
  const usedProducts = new Set<number>();

  for (let i = 0; i < numItems; i++) {
    let productIndex: number;
    do {
      productIndex = Math.floor(Math.random() * TEST_DATA.products.length);
    } while (usedProducts.has(productIndex) && usedProducts.size < TEST_DATA.products.length);

    usedProducts.add(productIndex);
    const product = TEST_DATA.products[productIndex];
    const quantity = Math.floor(Math.random() * 2) + 1; // 1-2 items
    const total = (parseFloat(product.price) * quantity).toFixed(2);

    lineItems.push({
      name: product.name,
      quantity,
      sku: product.sku,
      total,
    });
  }

  const email = `rkutke-test-${index}-${Date.now()}@webhook-test.io`;
  const uniqueId = crypto.randomBytes(4).toString('hex');
  const phone = `+49 ${Math.floor(Math.random() * 900000000) + 100000000}`;
  const address = `${street} ${houseNumber}`;

  return {
    payment_method: paymentMethod.id,
    payment_method_title: paymentMethod.title,
    set_paid: true,
    status: 'processing',
    billing: {
      first_name: firstName,
      last_name: lastName,
      address_1: address,
      city: city.name,
      postcode: city.zip,
      country: 'DE',
      email,
      phone,
    },
    shipping: {
      first_name: firstName,
      last_name: lastName,
      address_1: address,
      city: city.name,
      postcode: city.zip,
      country: 'DE',
    },
    line_items: lineItems,
    shipping_lines: [
      {
        method_id: shippingMethod.id,
        method_title: shippingMethod.title,
        total: shippingMethod.price,
      },
    ],
    customer_note: `Webhook test order #${index} for r.kutke@gmx.de - ${new Date().toISOString()}`,
    meta_data: [
      { key: '_webhook_test', value: 'true' },
      { key: '_test_client', value: 'r.kutke@gmx.de' },
      { key: '_test_id', value: uniqueId },
      { key: '_test_timestamp', value: new Date().toISOString() },
    ],
  };
}

function generateBasicAuth(key: string, secret: string): string {
  return Buffer.from(`${key}:${secret}`).toString('base64');
}

async function createWooCommerceOrder(
  config: OrderCreateConfig,
  orderData: WooCommerceOrderInput
): Promise<{ success: boolean; orderId?: number; error?: string }> {
  const url = `${config.storeUrl}/wp-json/wc/${config.apiVersion}/orders`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${generateBasicAuth(config.consumerKey, config.consumerSecret)}`,
      },
      body: JSON.stringify(orderData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const result = await response.json();
    return { success: true, orderId: result.id };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface OrderCreateResult {
  total: number;
  successful: number;
  failed: number;
  orders: Array<{ index: number; orderId?: number; error?: string }>;
  startTime: Date;
  endTime: Date;
  duration: number;
}

async function createOrders(config: OrderCreateConfig): Promise<OrderCreateResult> {
  const result: OrderCreateResult = {
    total: config.orderCount,
    successful: 0,
    failed: 0,
    orders: [],
    startTime: new Date(),
    endTime: new Date(),
    duration: 0,
  };

  console.log('\n================================================================================');
  console.log('           REAL ORDER CREATION TEST - r.kutke@gmx.de');
  console.log('================================================================================');
  console.log(`  Client:         r.kutke@gmx.de`);
  console.log(`  Store:          ${config.storeUrl}`);
  console.log(`  Orders:         ${config.orderCount}`);
  console.log(`  Delay:          ${config.delayBetweenOrders}ms`);
  console.log(`  Dry Run:        ${config.dryRun}`);
  console.log(`  Purpose:        Webhook integration testing`);
  console.log('================================================================================\n');

  if (config.dryRun) {
    console.log('🔍 DRY RUN MODE - No orders will be created\n');
  } else {
    console.log('⚠️  LIVE MODE - Real orders will be created in WooCommerce!\n');
    console.log('   These orders will trigger webhooks and flow through the system.');
    console.log('   Press Ctrl+C within 5 seconds to cancel...\n');
    await sleep(5000);
  }

  for (let i = 0; i < config.orderCount; i++) {
    const orderData = generateTestOrder(i + 1);

    if (config.dryRun) {
      console.log(`[${i + 1}/${config.orderCount}] Would create order for ${orderData.billing.email}`);
      console.log(`  Items: ${orderData.line_items.map(item => `${item.name} (${item.quantity}x)`).join(', ')}`);
      result.successful++;
      result.orders.push({ index: i + 1, orderId: undefined });
    } else {
      console.log(`\n[${i + 1}/${config.orderCount}] Creating order for ${orderData.billing.email}...`);
      const createResult = await createWooCommerceOrder(config, orderData);

      if (createResult.success) {
        result.successful++;
        result.orders.push({ index: i + 1, orderId: createResult.orderId });
        console.log(`  ✅ Success! Order ID: ${createResult.orderId}`);
        console.log(`  Items: ${orderData.line_items.map(item => `${item.name} (${item.quantity}x)`).join(', ')}`);
      } else {
        result.failed++;
        result.orders.push({ index: i + 1, error: createResult.error });
        console.log(`  ❌ Failed: ${createResult.error}`);
      }

      // Respect rate limits
      if (i < config.orderCount - 1) {
        console.log(`  ⏱️  Waiting ${config.delayBetweenOrders}ms before next order...`);
        await sleep(config.delayBetweenOrders);
      }
    }
  }

  result.endTime = new Date();
  result.duration = result.endTime.getTime() - result.startTime.getTime();

  console.log('\n================================================================================');
  console.log('                           RESULTS');
  console.log('================================================================================');
  console.log(`  Total Orders:    ${result.total}`);
  console.log(`  Successful:      ${result.successful} ✅`);
  console.log(`  Failed:          ${result.failed} ${result.failed > 0 ? '❌' : '✅'}`);
  console.log(`  Success Rate:    ${((result.successful / result.total) * 100).toFixed(2)}%`);
  console.log(`  Duration:        ${(result.duration / 1000).toFixed(2)}s`);
  console.log(`  Rate:            ${(result.total / (result.duration / 1000)).toFixed(2)} orders/sec`);
  console.log('================================================================================');

  if (!config.dryRun && result.successful > 0) {
    console.log('\n📊 Next Steps:');
    console.log('   1. Check your backend logs for webhook processing');
    console.log('   2. Verify orders appear in the admin dashboard');
    console.log('   3. Confirm JTL-FFN sync is working');
    console.log('   4. Monitor socket updates in the frontend\n');

    // Verify order origins in database
    console.log('\n⏳ Waiting 40 seconds for webhooks to process...');
    await sleep(40000);
    
    await verifyOrderOrigins(result.orders.filter(o => o.orderId).map(o => o.orderId!));
  }

  return result;
}

/**
 * Verify order origins in the database
 */
async function verifyOrderOrigins(wooOrderIds: number[]): Promise<void> {
  console.log('\n================================================================================');
  console.log('                    ORDER ORIGIN VERIFICATION');
  console.log('================================================================================\n');

  // Initialize Prisma with pg adapter (Prisma 7 requirement)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  
  try {
    // Look up orders by external order ID (WooCommerce order IDs)
    const externalIds = wooOrderIds.map(id => String(id));
    
    const orders = await prisma.order.findMany({
      where: {
        externalOrderId: { in: externalIds }
      },
      select: {
        id: true,
        orderId: true,
        orderNumber: true,
        externalOrderId: true,
        orderOrigin: true,
        status: true,
        syncStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' }
    });

    if (orders.length === 0) {
      console.log('❌ No orders found in database yet. Webhooks may not have processed.\n');
      console.log('   Created WooCommerce Order IDs:', wooOrderIds.join(', '));
      return;
    }

    console.log(`Found ${orders.length}/${wooOrderIds.length} orders in database:\n`);
    
    let correctOrigin = 0;
    let wrongOrigin = 0;

    for (const order of orders) {
      const isCorrect = order.orderOrigin === 'WOOCOMMERCE';
      if (isCorrect) {
        correctOrigin++;
        console.log(`  ✅ ${order.orderId} (ext: ${order.externalOrderId}) → origin: ${order.orderOrigin}`);
      } else {
        wrongOrigin++;
        console.log(`  ❌ ${order.orderId} (ext: ${order.externalOrderId}) → origin: ${order.orderOrigin} (WRONG! Should be WOOCOMMERCE)`);
      }
    }

    console.log('\n--------------------------------------------------------------------------------');
    console.log(`  Correct Origin (WOOCOMMERCE): ${correctOrigin} ✅`);
    console.log(`  Wrong Origin:                 ${wrongOrigin} ${wrongOrigin > 0 ? '❌' : '✅'}`);
    console.log('--------------------------------------------------------------------------------\n');

    if (wrongOrigin > 0) {
      console.log('⚠️  Some orders have incorrect origin. Backend may need redeployment.\n');
    } else if (correctOrigin === wooOrderIds.length) {
      console.log('🎉 All orders have correct WOOCOMMERCE origin!\n');
    }
  } catch (error) {
    console.error('❌ Error verifying order origins:', error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const storeUrl = getArg('url') || process.env.RKUTKE_WOOCOMMERCE_URL;
  const consumerKey = getArg('key') || process.env.RKUTKE_WOOCOMMERCE_KEY;
  const consumerSecret = getArg('secret') || process.env.RKUTKE_WOOCOMMERCE_SECRET;
  const orderCount = parseInt(getArg('count') || '5', 10);
  const delayBetweenOrders = parseInt(getArg('delay') || '1000', 10);
  const dryRun = args.includes('--dry-run');

  if (!storeUrl || !consumerKey || !consumerSecret) {
    console.error('❌ Error: --url, --key, and --secret are required\n');
    console.error('Usage:');
    console.error('  npx tsx stress-tests/scripts/r-kutke-order-test.ts \\');
    console.error('    --url https://mystore.com \\');
    console.error('    --key ck_xxxxxxxxxxxxx \\');
    console.error('    --secret cs_xxxxxxxxxxxxx \\');
    console.error('    --count 5 \\');
    console.error('    --delay 1000\n');
    console.error('Or set environment variables:');
    console.error('  export RKUTKE_WOOCOMMERCE_URL=https://mystore.com');
    console.error('  export RKUTKE_WOOCOMMERCE_KEY=ck_xxxxxxxxxxxxx');
    console.error('  export RKUTKE_WOOCOMMERCE_SECRET=cs_xxxxxxxxxxxxx\n');
    console.error('Options:');
    console.error('  --url       WooCommerce store URL');
    console.error('  --key       Consumer key (from WooCommerce → Settings → Advanced → REST API)');
    console.error('  --secret    Consumer secret');
    console.error('  --count     Number of orders to create (default: 5)');
    console.error('  --delay     Delay between orders in ms (default: 1000)');
    console.error('  --dry-run   Print orders without creating them\n');
    process.exit(1);
  }

  const config: OrderCreateConfig = {
    storeUrl: storeUrl.replace(/\/$/, ''), // Remove trailing slash
    consumerKey,
    consumerSecret,
    orderCount,
    delayBetweenOrders,
    dryRun,
    apiVersion: 'v3',
  };

  try {
    const result = await createOrders(config);
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  }
}

// Run if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}

export { createOrders, generateTestOrder, OrderCreateConfig, OrderCreateResult };
