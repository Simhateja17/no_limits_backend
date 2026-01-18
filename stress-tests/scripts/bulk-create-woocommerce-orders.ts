/**
 * Bulk Order Creation Script for WooCommerce
 * 
 * Creates test orders directly in a WooCommerce store via the REST API.
 * These orders will trigger webhooks to flow through the real system.
 * 
 * Usage:
 *   npx tsx stress-tests/scripts/bulk-create-woocommerce-orders.ts --url https://mystore.com --key ck_xxx --secret cs_xxx --count 100
 * 
 * Options:
 *   --url       WooCommerce store URL (required)
 *   --key       Consumer key (required)
 *   --secret    Consumer secret (required)
 *   --count     Number of orders to create (default: 10)
 *   --delay     Delay between orders in ms (default: 500)
 *   --dry-run   Print orders without creating them
 */

import crypto from 'crypto';

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

interface BulkCreateConfig {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  orderCount: number;
  delayBetweenOrders: number;
  dryRun: boolean;
  apiVersion: string;
}

// Test data pools (German addresses for realism)
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
  products: [
    { name: 'Stress Test T-Shirt', price: '29.99', sku: 'ST-TSHIRT-001' },
    { name: 'Stress Test Hoodie', price: '59.99', sku: 'ST-HOODIE-001' },
    { name: 'Stress Test Cap', price: '19.99', sku: 'ST-CAP-001' },
    { name: 'Stress Test Socks Pack', price: '14.99', sku: 'ST-SOCKS-001' },
    { name: 'Stress Test Backpack', price: '79.99', sku: 'ST-BACKPACK-001' },
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
  
  // Generate 1-4 line items
  const numItems = Math.floor(Math.random() * 4) + 1;
  const lineItems: WooCommerceOrderInput['line_items'] = [];
  const usedProducts = new Set<number>();
  
  for (let i = 0; i < numItems; i++) {
    let productIndex: number;
    do {
      productIndex = Math.floor(Math.random() * TEST_DATA.products.length);
    } while (usedProducts.has(productIndex) && usedProducts.size < TEST_DATA.products.length);
    
    usedProducts.add(productIndex);
    const product = TEST_DATA.products[productIndex];
    const quantity = Math.floor(Math.random() * 3) + 1;
    const total = (parseFloat(product.price) * quantity).toFixed(2);
    
    lineItems.push({
      name: product.name,
      quantity,
      sku: product.sku,
      total,
    });
  }

  const email = `stress-test-${index}-${Date.now()}@stress-test.io`;
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
    customer_note: `Stress test order #${index} created at ${new Date().toISOString()}`,
    meta_data: [
      { key: '_stress_test', value: 'true' },
      { key: '_stress_test_id', value: uniqueId },
      { key: '_stress_test_timestamp', value: new Date().toISOString() },
    ],
  };
}

function generateBasicAuth(key: string, secret: string): string {
  return Buffer.from(`${key}:${secret}`).toString('base64');
}

async function createWooCommerceOrder(
  config: BulkCreateConfig,
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

interface BulkCreateResult {
  total: number;
  successful: number;
  failed: number;
  orders: Array<{ index: number; orderId?: number; error?: string }>;
  startTime: Date;
  endTime: Date;
  duration: number;
}

async function bulkCreateOrders(config: BulkCreateConfig): Promise<BulkCreateResult> {
  const result: BulkCreateResult = {
    total: config.orderCount,
    successful: 0,
    failed: 0,
    orders: [],
    startTime: new Date(),
    endTime: new Date(),
    duration: 0,
  };

  console.log('\n================================================================================');
  console.log('                    WOOCOMMERCE BULK ORDER CREATION');
  console.log('================================================================================');
  console.log(`  Store:          ${config.storeUrl}`);
  console.log(`  Orders:         ${config.orderCount}`);
  console.log(`  Delay:          ${config.delayBetweenOrders}ms`);
  console.log(`  Dry Run:        ${config.dryRun}`);
  console.log('================================================================================\n');

  for (let i = 0; i < config.orderCount; i++) {
    const orderData = generateTestOrder(i + 1);
    
    if (config.dryRun) {
      console.log(`[${i + 1}/${config.orderCount}] Would create order for ${orderData.billing.email}`);
      result.successful++;
      result.orders.push({ index: i + 1, orderId: undefined });
    } else {
      const createResult = await createWooCommerceOrder(config, orderData);
      
      if (createResult.success) {
        result.successful++;
        result.orders.push({ index: i + 1, orderId: createResult.orderId });
        process.stdout.write(`\r  Progress: ${i + 1}/${config.orderCount} | Success: ${result.successful} | Failed: ${result.failed}`);
      } else {
        result.failed++;
        result.orders.push({ index: i + 1, error: createResult.error });
        console.log(`\n  [${i + 1}] Failed: ${createResult.error}`);
      }

      // Respect rate limits
      if (i < config.orderCount - 1) {
        await sleep(config.delayBetweenOrders);
      }
    }
  }

  result.endTime = new Date();
  result.duration = result.endTime.getTime() - result.startTime.getTime();

  console.log('\n\n================================================================================');
  console.log('                           RESULTS');
  console.log('================================================================================');
  console.log(`  Total Orders:    ${result.total}`);
  console.log(`  Successful:      ${result.successful}`);
  console.log(`  Failed:          ${result.failed}`);
  console.log(`  Success Rate:    ${((result.successful / result.total) * 100).toFixed(2)}%`);
  console.log(`  Duration:        ${(result.duration / 1000).toFixed(2)}s`);
  console.log(`  Rate:            ${(result.total / (result.duration / 1000)).toFixed(2)} orders/sec`);
  console.log('================================================================================\n');

  return result;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const storeUrl = getArg('url') || process.env.WOOCOMMERCE_URL;
  const consumerKey = getArg('key') || process.env.WOOCOMMERCE_KEY;
  const consumerSecret = getArg('secret') || process.env.WOOCOMMERCE_SECRET;
  const orderCount = parseInt(getArg('count') || '10', 10);
  const delayBetweenOrders = parseInt(getArg('delay') || '500', 10);
  const dryRun = args.includes('--dry-run');

  if (!storeUrl || !consumerKey || !consumerSecret) {
    console.error('Error: --url, --key, and --secret are required');
    console.error('\nUsage:');
    console.error('  npx tsx stress-tests/scripts/bulk-create-woocommerce-orders.ts \\');
    console.error('    --url https://mystore.com \\');
    console.error('    --key ck_xxxxxxxxxxxxx \\');
    console.error('    --secret cs_xxxxxxxxxxxxx \\');
    console.error('    --count 100 \\');
    console.error('    --delay 500');
    console.error('\nOptions:');
    console.error('  --url       WooCommerce store URL (or set WOOCOMMERCE_URL env var)');
    console.error('  --key       Consumer key (or set WOOCOMMERCE_KEY env var)');
    console.error('  --secret    Consumer secret (or set WOOCOMMERCE_SECRET env var)');
    console.error('  --count     Number of orders to create (default: 10)');
    console.error('  --delay     Delay between orders in ms (default: 500)');
    console.error('  --dry-run   Print orders without creating them');
    process.exit(1);
  }

  const config: BulkCreateConfig = {
    storeUrl: storeUrl.replace(/\/$/, ''), // Remove trailing slash
    consumerKey,
    consumerSecret,
    orderCount,
    delayBetweenOrders,
    dryRun,
    apiVersion: 'v3',
  };

  try {
    const result = await bulkCreateOrders(config);
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}

export { bulkCreateOrders, generateTestOrder, BulkCreateConfig, BulkCreateResult };
