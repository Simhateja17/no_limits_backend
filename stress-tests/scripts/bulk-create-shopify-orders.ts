/**
 * Bulk Order Creation Script for Shopify
 * 
 * Creates test orders directly in a Shopify store via the Admin API.
 * These orders will trigger webhooks to flow through the real system.
 * 
 * Usage:
 *   npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts --store mystore.myshopify.com --token shpat_xxx --count 100
 * 
 * Options:
 *   --store     Shopify store domain (required)
 *   --token     Admin API access token (required)
 *   --count     Number of orders to create (default: 10)
 *   --delay     Delay between orders in ms (default: 500)
 *   --dry-run   Print orders without creating them
 */

import crypto from 'crypto';

interface ShopifyOrderInput {
  order: {
    line_items: Array<{
      title: string;
      quantity: number;
      price: string;
      sku?: string;
    }>;
    customer?: {
      first_name: string;
      last_name: string;
      email: string;
    };
    billing_address: {
      first_name: string;
      last_name: string;
      address1: string;
      city: string;
      province?: string;
      country: string;
      zip: string;
      phone?: string;
    };
    shipping_address: {
      first_name: string;
      last_name: string;
      address1: string;
      city: string;
      province?: string;
      country: string;
      zip: string;
      phone?: string;
    };
    financial_status?: 'pending' | 'authorized' | 'paid';
    fulfillment_status?: 'fulfilled' | 'partial' | null;
    tags?: string;
    note?: string;
    send_receipt?: boolean;
    send_fulfillment_receipt?: boolean;
    inventory_behaviour?: 'bypass' | 'decrement_ignoring_policy' | 'decrement_obeying_policy';
  };
}

interface BulkCreateConfig {
  storeDomain: string;
  accessToken: string;
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
    { title: 'Stress Test T-Shirt', price: '29.99', sku: 'ST-TSHIRT-001' },
    { title: 'Stress Test Hoodie', price: '59.99', sku: 'ST-HOODIE-001' },
    { title: 'Stress Test Cap', price: '19.99', sku: 'ST-CAP-001' },
    { title: 'Stress Test Socks Pack', price: '14.99', sku: 'ST-SOCKS-001' },
    { title: 'Stress Test Backpack', price: '79.99', sku: 'ST-BACKPACK-001' },
  ],
};

function randomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function generateTestOrder(index: number): ShopifyOrderInput {
  const firstName = randomElement(TEST_DATA.firstNames);
  const lastName = randomElement(TEST_DATA.lastNames);
  const city = randomElement(TEST_DATA.cities);
  const street = randomElement(TEST_DATA.streets);
  const houseNumber = Math.floor(Math.random() * 150) + 1;
  
  // Generate 1-4 line items
  const numItems = Math.floor(Math.random() * 4) + 1;
  const lineItems = [];
  const usedProducts = new Set<number>();
  
  for (let i = 0; i < numItems; i++) {
    let productIndex: number;
    do {
      productIndex = Math.floor(Math.random() * TEST_DATA.products.length);
    } while (usedProducts.has(productIndex) && usedProducts.size < TEST_DATA.products.length);
    
    usedProducts.add(productIndex);
    const product = TEST_DATA.products[productIndex];
    
    lineItems.push({
      title: product.title,
      quantity: Math.floor(Math.random() * 3) + 1,
      price: product.price,
      sku: product.sku,
    });
  }

  const email = `stress-test-${index}-${Date.now()}@stress-test.io`;
  const uniqueId = crypto.randomBytes(4).toString('hex');

  return {
    order: {
      line_items: lineItems,
      customer: {
        first_name: firstName,
        last_name: lastName,
        email,
      },
      billing_address: {
        first_name: firstName,
        last_name: lastName,
        address1: `${street} ${houseNumber}`,
        city: city.name,
        country: 'Germany',
        zip: city.zip,
        phone: `+49 ${Math.floor(Math.random() * 900000000) + 100000000}`,
      },
      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        address1: `${street} ${houseNumber}`,
        city: city.name,
        country: 'Germany',
        zip: city.zip,
        phone: `+49 ${Math.floor(Math.random() * 900000000) + 100000000}`,
      },
      financial_status: 'paid',
      fulfillment_status: null,
      tags: `stress-test, bulk-create, test-${uniqueId}`,
      note: `Stress test order #${index} created at ${new Date().toISOString()}`,
      send_receipt: false,
      send_fulfillment_receipt: false,
      inventory_behaviour: 'bypass',
    },
  };
}

async function createShopifyOrder(
  config: BulkCreateConfig,
  orderData: ShopifyOrderInput
): Promise<{ success: boolean; orderId?: number; error?: string }> {
  const url = `https://${config.storeDomain}/admin/api/${config.apiVersion}/orders.json`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': config.accessToken,
      },
      body: JSON.stringify(orderData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const result = await response.json();
    return { success: true, orderId: result.order?.id };
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
  console.log('                    SHOPIFY BULK ORDER CREATION');
  console.log('================================================================================');
  console.log(`  Store:          ${config.storeDomain}`);
  console.log(`  Orders:         ${config.orderCount}`);
  console.log(`  Delay:          ${config.delayBetweenOrders}ms`);
  console.log(`  Dry Run:        ${config.dryRun}`);
  console.log('================================================================================\n');

  for (let i = 0; i < config.orderCount; i++) {
    const orderData = generateTestOrder(i + 1);
    
    if (config.dryRun) {
      console.log(`[${i + 1}/${config.orderCount}] Would create order for ${orderData.order.customer?.email}`);
      result.successful++;
      result.orders.push({ index: i + 1, orderId: undefined });
    } else {
      const createResult = await createShopifyOrder(config, orderData);
      
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

  const storeDomain = getArg('store') || process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = getArg('token') || process.env.SHOPIFY_ACCESS_TOKEN;
  const orderCount = parseInt(getArg('count') || '10', 10);
  const delayBetweenOrders = parseInt(getArg('delay') || '500', 10);
  const dryRun = args.includes('--dry-run');

  if (!storeDomain || !accessToken) {
    console.error('Error: --store and --token are required');
    console.error('\nUsage:');
    console.error('  npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts \\');
    console.error('    --store mystore.myshopify.com \\');
    console.error('    --token shpat_xxxxxxxxxxxxx \\');
    console.error('    --count 100 \\');
    console.error('    --delay 500');
    console.error('\nOptions:');
    console.error('  --store     Shopify store domain (or set SHOPIFY_STORE_DOMAIN env var)');
    console.error('  --token     Admin API access token (or set SHOPIFY_ACCESS_TOKEN env var)');
    console.error('  --count     Number of orders to create (default: 10)');
    console.error('  --delay     Delay between orders in ms (default: 500)');
    console.error('  --dry-run   Print orders without creating them');
    process.exit(1);
  }

  const config: BulkCreateConfig = {
    storeDomain,
    accessToken,
    orderCount,
    delayBetweenOrders,
    dryRun,
    apiVersion: '2024-01',
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
