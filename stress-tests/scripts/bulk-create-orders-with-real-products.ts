/**
 * Bulk Order Creation Script with Real Products
 *
 * Creates test orders using existing products from the database.
 * Targets specific stores:
 * - ida.freitag@example.com (Shopify)
 * - julian.bauer@example.com (WooCommerce)
 *
 * Usage:
 *   # Create 10 orders for each store
 *   npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 10
 *
 *   # Create orders only for Shopify
 *   npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 5 --platform shopify
 *
 *   # Create orders only for WooCommerce
 *   npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 5 --platform woocommerce
 *
 *   # Dry run (no actual orders created)
 *   npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 10 --dry-run
 *
 * Options:
 *   --count       Number of orders to create per platform (default: 10)
 *   --delay       Delay between orders in ms (default: 1000)
 *   --platform    Target platform: shopify, woocommerce, or both (default: both)
 *   --dry-run     Print orders without creating them
 *   --help        Show this help message
 */

import crypto from 'crypto';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// Load environment variables
config();

// ============= PRISMA CLIENT =============

function createPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

// ============= ENCRYPTION SERVICE =============

class EncryptionService {
  private algorithm = 'aes-256-gcm';
  private key: Buffer;

  constructor() {
    const encryptionKey = process.env.ENCRYPTION_KEY;

    if (!encryptionKey) {
      throw new Error(
        'ENCRYPTION_KEY environment variable is required. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }

    if (encryptionKey.length !== 64) {
      throw new Error(
        'ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
        'Current length: ' + encryptionKey.length
      );
    }

    this.key = Buffer.from(encryptionKey, 'hex');
  }

  decrypt(encryptedText: string): string {
    if (!encryptedText) {
      return encryptedText;
    }

    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      return encryptedText;
    }

    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.key,
      iv
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  isEncrypted(text: string): boolean {
    if (!text) return false;
    const parts = text.split(':');
    return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
  }
}

// ============= TYPES =============

interface Product {
  id: string;
  sku: string;
  name: string;
  available: number;
}

interface StoreConfig {
  id: string;
  name: string;
  email: string;
  type: 'SHOPIFY' | 'WOOCOMMERCE';
  shopDomain?: string;
  url?: string;
  accessToken: string;
  consumerKey?: string;
  consumerSecret?: string;
  products: Product[];
}

interface OrderCreationResult {
  platform: string;
  storeName: string;
  total: number;
  successful: number;
  failed: number;
  orders: Array<{ index: number; orderId?: number | string; orderNumber?: string; error?: string }>;
  duration: number;
}

// ============= TEST DATA =============

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
  ],
  streets: [
    'Hauptstraße', 'Berliner Straße', 'Schulstraße', 'Bahnhofstraße',
    'Gartenstraße', 'Dorfstraße', 'Ringstraße', 'Kirchstraße',
  ],
};

function randomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

// ============= DATABASE QUERIES =============

async function getStoreConfigurations(): Promise<StoreConfig[]> {
  const prisma = createPrismaClient();
  const encryptionService = new EncryptionService();

  try {
    // Find users by email
    const users = await prisma.user.findMany({
      where: {
        email: {
          in: ['ida.freitag@example.com', 'julian.bauer@example.com'],
        },
      },
      include: {
        client: {
          include: {
            channels: {
              where: {
                isActive: true,
                status: 'ACTIVE',
              },
            },
            products: {
              where: {
                isActive: true,
                // Note: Not filtering by stock for stress testing
                // We bypass inventory anyway with inventory_behaviour: 'bypass'
              },
              select: {
                id: true,
                sku: true,
                name: true,
                available: true,
              },
              take: 100, // Limit to 100 products to avoid overwhelming queries
            },
          },
        },
      },
    });

    const configs: StoreConfig[] = [];

    for (const user of users) {
      if (!user.client) continue;

      for (const channel of user.client.channels) {
        // Decrypt access token
        const decryptedToken = channel.accessToken && encryptionService.isEncrypted(channel.accessToken)
          ? encryptionService.decrypt(channel.accessToken)
          : channel.accessToken || '';

        // Decrypt consumer secret for WooCommerce
        let decryptedSecret = '';
        if (channel.type === 'WOOCOMMERCE' && channel.apiClientSecret) {
          decryptedSecret = encryptionService.isEncrypted(channel.apiClientSecret)
            ? encryptionService.decrypt(channel.apiClientSecret)
            : channel.apiClientSecret;
        }

        if (channel.type === 'SHOPIFY' && channel.shopDomain && decryptedToken) {
          configs.push({
            id: channel.id,
            name: channel.name,
            email: user.email,
            type: 'SHOPIFY',
            shopDomain: channel.shopDomain,
            accessToken: decryptedToken,
            products: user.client.products,
          });
        } else if (channel.type === 'WOOCOMMERCE' && channel.url && channel.apiClientId && decryptedSecret) {
          configs.push({
            id: channel.id,
            name: channel.name,
            email: user.email,
            type: 'WOOCOMMERCE',
            url: channel.url,
            accessToken: decryptedToken,
            consumerKey: channel.apiClientId,
            consumerSecret: decryptedSecret,
            products: user.client.products,
          });
        }
      }
    }

    return configs;
  } finally {
    await prisma.$disconnect();
  }
}

// ============= SHOPIFY ORDER GENERATION =============

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
      country: string;
      zip: string;
      phone?: string;
    };
    shipping_address: {
      first_name: string;
      last_name: string;
      address1: string;
      city: string;
      country: string;
      zip: string;
      phone?: string;
    };
    financial_status?: 'paid';
    fulfillment_status?: null;
    tags?: string;
    note?: string;
    send_receipt?: boolean;
    send_fulfillment_receipt?: boolean;
    inventory_behaviour?: 'bypass';
  };
}

function generateShopifyOrder(index: number, products: Product[]): ShopifyOrderInput {
  const firstName = randomElement(TEST_DATA.firstNames);
  const lastName = randomElement(TEST_DATA.lastNames);
  const city = randomElement(TEST_DATA.cities);
  const street = randomElement(TEST_DATA.streets);
  const houseNumber = Math.floor(Math.random() * 150) + 1;

  // Select 1-3 random products
  const numItems = Math.min(Math.floor(Math.random() * 3) + 1, products.length);
  const selectedProducts = [...products].sort(() => 0.5 - Math.random()).slice(0, numItems);

  const lineItems = selectedProducts.map(product => ({
    title: product.name,
    quantity: Math.floor(Math.random() * 2) + 1, // 1-2 items
    price: (Math.random() * 50 + 10).toFixed(2), // Random price $10-$60
    sku: product.sku,
  }));

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
      tags: `stress-test, real-products, test-${uniqueId}`,
      note: `Stress test order #${index} with real products - ${new Date().toISOString()}`,
      send_receipt: false,
      send_fulfillment_receipt: false,
      inventory_behaviour: 'bypass',
    },
  };
}

async function createShopifyOrder(
  config: StoreConfig,
  orderData: ShopifyOrderInput
): Promise<{ success: boolean; orderId?: number; orderNumber?: string; error?: string }> {
  const url = `https://${config.shopDomain}/admin/api/2024-01/orders.json`;

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
    return {
      success: true,
      orderId: result.order?.id,
      orderNumber: result.order?.order_number?.toString() || result.order?.name
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ============= WOOCOMMERCE ORDER GENERATION =============

interface WooCommerceOrderInput {
  payment_method: string;
  payment_method_title: string;
  set_paid: boolean;
  status: 'processing';
  billing: {
    first_name: string;
    last_name: string;
    address_1: string;
    city: string;
    postcode: string;
    country: string;
    email: string;
    phone?: string;
  };
  shipping: {
    first_name: string;
    last_name: string;
    address_1: string;
    city: string;
    postcode: string;
    country: string;
  };
  line_items: Array<{
    name: string;
    quantity: number;
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

function generateWooCommerceOrder(index: number, products: Product[]): WooCommerceOrderInput {
  const firstName = randomElement(TEST_DATA.firstNames);
  const lastName = randomElement(TEST_DATA.lastNames);
  const city = randomElement(TEST_DATA.cities);
  const street = randomElement(TEST_DATA.streets);
  const houseNumber = Math.floor(Math.random() * 150) + 1;

  // Select 1-3 random products
  const numItems = Math.min(Math.floor(Math.random() * 3) + 1, products.length);
  const selectedProducts = [...products].sort(() => 0.5 - Math.random()).slice(0, numItems);

  const lineItems = selectedProducts.map(product => {
    const quantity = Math.floor(Math.random() * 2) + 1;
    const price = Math.random() * 50 + 10;
    const total = (price * quantity).toFixed(2);

    return {
      name: product.name,
      quantity,
      sku: product.sku,
      total,
    };
  });

  const email = `stress-test-${index}-${Date.now()}@stress-test.io`;
  const uniqueId = crypto.randomBytes(4).toString('hex');
  const phone = `+49 ${Math.floor(Math.random() * 900000000) + 100000000}`;
  const address = `${street} ${houseNumber}`;

  return {
    payment_method: 'bacs',
    payment_method_title: 'Direct Bank Transfer',
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
        method_id: 'flat_rate',
        method_title: 'Standardversand',
        total: '4.99',
      },
    ],
    customer_note: `Stress test order #${index} with real products - ${new Date().toISOString()}`,
    meta_data: [
      { key: '_stress_test', value: 'true' },
      { key: '_stress_test_id', value: uniqueId },
      { key: '_stress_test_timestamp', value: new Date().toISOString() },
      { key: '_real_products', value: 'true' },
    ],
  };
}

function generateBasicAuth(key: string, secret: string): string {
  return Buffer.from(`${key}:${secret}`).toString('base64');
}

async function createWooCommerceOrder(
  config: StoreConfig,
  orderData: WooCommerceOrderInput
): Promise<{ success: boolean; orderId?: number; error?: string }> {
  const url = `${config.url}/wp-json/wc/v3/orders`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${generateBasicAuth(config.consumerKey!, config.consumerSecret!)}`,
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

// ============= ORCHESTRATION =============

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function createOrdersForStore(
  config: StoreConfig,
  orderCount: number,
  delay: number,
  dryRun: boolean
): Promise<OrderCreationResult> {
  const result: OrderCreationResult = {
    platform: config.type,
    storeName: config.name,
    total: orderCount,
    successful: 0,
    failed: 0,
    orders: [],
    duration: 0,
  };

  const startTime = Date.now();

  const productsWithStock = config.products.filter(p => p.available > 0).length;

  console.log('\n================================================================================');
  console.log(`         ${config.type} ORDER CREATION - ${config.name}`);
  console.log('================================================================================');
  console.log(`  Store:          ${config.email}`);
  console.log(`  Channel:        ${config.name}`);
  console.log(`  Products:       ${config.products.length} total (${productsWithStock} with stock)`);
  console.log(`  Orders:         ${orderCount}`);
  console.log(`  Delay:          ${delay}ms`);
  console.log(`  Dry Run:        ${dryRun}`);
  console.log(`  Inventory:      Bypassed (stress test mode)`);
  console.log('================================================================================\n');

  if (config.products.length === 0) {
    console.log('  ⚠️  No products found for this store. Skipping...\n');
    return result;
  }

  for (let i = 0; i < orderCount; i++) {
    if (config.type === 'SHOPIFY') {
      const orderData = generateShopifyOrder(i + 1, config.products);

      if (dryRun) {
        console.log(`  [${i + 1}/${orderCount}] Would create Shopify order with ${orderData.order.line_items.length} items`);
        result.successful++;
      } else {
        const createResult = await createShopifyOrder(config, orderData);

        if (createResult.success) {
          result.successful++;
          result.orders.push({ index: i + 1, orderId: createResult.orderId, orderNumber: createResult.orderNumber });
          console.log(`  ✓ [${i + 1}/${orderCount}] Created order #${createResult.orderNumber} (ID: ${createResult.orderId})`);
        } else {
          result.failed++;
          result.orders.push({ index: i + 1, error: createResult.error });
          console.log(`  ✗ [${i + 1}/${orderCount}] Failed: ${createResult.error}`);
        }
      }
    } else if (config.type === 'WOOCOMMERCE') {
      const orderData = generateWooCommerceOrder(i + 1, config.products);

      if (dryRun) {
        console.log(`  [${i + 1}/${orderCount}] Would create WooCommerce order with ${orderData.line_items.length} items`);
        result.successful++;
      } else {
        const createResult = await createWooCommerceOrder(config, orderData);

        if (createResult.success) {
          result.successful++;
          result.orders.push({ index: i + 1, orderId: createResult.orderId });
          console.log(`  ✓ [${i + 1}/${orderCount}] Created order ID: ${createResult.orderId}`);
        } else {
          result.failed++;
          result.orders.push({ index: i + 1, error: createResult.error });
          console.log(`  ✗ [${i + 1}/${orderCount}] Failed: ${createResult.error}`);
        }
      }
    }

    if (i < orderCount - 1) {
      await sleep(delay);
    }
  }

  result.duration = Date.now() - startTime;

  console.log('\n  Results:');
  console.log(`    Total:        ${result.total}`);
  console.log(`    Successful:   ${result.successful}`);
  console.log(`    Failed:       ${result.failed}`);
  console.log(`    Success Rate: ${((result.successful / result.total) * 100).toFixed(2)}%`);
  console.log(`    Duration:     ${(result.duration / 1000).toFixed(2)}s`);
  console.log('');

  return result;
}

// ============= CLI =============

async function main() {
  const args = process.argv.slice(2);

  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Bulk Order Creation with Real Products

Usage:
  npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts [options]

Options:
  --count <n>           Number of orders per platform (default: 10)
  --delay <ms>          Delay between orders in ms (default: 1000)
  --platform <type>     Target: shopify, woocommerce, or both (default: both)
  --dry-run             Print orders without creating them
  --help                Show this help message

Examples:
  # Create 10 orders for each platform
  npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 10

  # Create 5 Shopify orders only
  npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 5 --platform shopify

  # Dry run
  npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 10 --dry-run
`);
    process.exit(0);
  }

  const orderCount = parseInt(getArg('count') || '10', 10);
  const delay = parseInt(getArg('delay') || '1000', 10);
  const platform = (getArg('platform') || 'both').toLowerCase();
  const dryRun = args.includes('--dry-run');

  console.log('\n🔍 Loading store configurations from database...\n');
  const configs = await getStoreConfigurations();

  if (configs.length === 0) {
    console.error('❌ No active stores found for the specified users.');
    process.exit(1);
  }

  console.log(`✅ Found ${configs.length} active store(s):\n`);
  configs.forEach((config, i) => {
    const productsWithStock = config.products.filter(p => p.available > 0).length;
    console.log(`  ${i + 1}. ${config.name} (${config.type})`);
    console.log(`     Email: ${config.email}`);
    console.log(`     Products: ${config.products.length} total (${productsWithStock} with stock)`);
    console.log('');
  });

  const results: OrderCreationResult[] = [];

  for (const config of configs) {
    // Skip based on platform filter
    if (platform !== 'both') {
      if (platform === 'shopify' && config.type !== 'SHOPIFY') continue;
      if (platform === 'woocommerce' && config.type !== 'WOOCOMMERCE') continue;
    }

    const result = await createOrdersForStore(config, orderCount, delay, dryRun);
    results.push(result);
  }

  // Summary
  console.log('\n================================================================================');
  console.log('                         OVERALL SUMMARY');
  console.log('================================================================================');

  const totalOrders = results.reduce((sum, r) => sum + r.total, 0);
  const totalSuccessful = results.reduce((sum, r) => sum + r.successful, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`  Total Orders:     ${totalOrders}`);
  console.log(`  Successful:       ${totalSuccessful}`);
  console.log(`  Failed:           ${totalFailed}`);
  console.log(`  Success Rate:     ${totalOrders > 0 ? ((totalSuccessful / totalOrders) * 100).toFixed(2) : 0}%`);
  console.log(`  Total Duration:   ${(totalDuration / 1000).toFixed(2)}s`);
  console.log('================================================================================\n');

  process.exit(totalFailed > 0 ? 1 : 0);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}

export { createOrdersForStore, generateShopifyOrder, generateWooCommerceOrder };
