/**
 * Bulk Order Creation Script for Shopify
 *
 * Creates test orders directly in a Shopify store via the Admin API.
 * These orders will trigger webhooks to flow through the real system.
 *
 * Usage with Channel ID (recommended - uses OAuth from database):
 *   npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts --channel-id clxxxxxxxxx --count 5
 *
 * Usage with manual credentials:
 *   npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts --store mystore.myshopify.com --token shpat_xxx --count 100
 *
 * Options:
 *   --channel-id  Channel ID from database (uses OAuth credentials)
 *   --store       Shopify store domain (required if not using --channel-id)
 *   --token       Admin API access token (required if not using --channel-id)
 *   --count       Number of orders to create (default: 10)
 *   --delay       Delay between orders in ms (default: 500)
 *   --dry-run     Print orders without creating them
 */

import crypto from 'crypto';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// Load environment variables from .env file
config();

// Create Prisma client with pg adapter (Prisma 7 requirement)
function createPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,  // Use minimal connections for script
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

// ============= ENCRYPTION SERVICE =============
// Inline encryption for standalone script usage

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
      // Not encrypted, return as-is
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
  channelId?: string;
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
): Promise<{ success: boolean; orderId?: number; orderNumber?: string; error?: string }> {
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
    return {
      success: true,
      orderId: result.order?.id,
      orderNumber: result.order?.order_number?.toString() || result.order?.name
    };
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
  orders: Array<{ index: number; orderId?: number; orderNumber?: string; error?: string }>;
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
  if (config.channelId) {
    console.log(`  Channel ID:     ${config.channelId}`);
  }
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
        result.orders.push({ index: i + 1, orderId: createResult.orderId, orderNumber: createResult.orderNumber });
        console.log(`  [${i + 1}/${config.orderCount}] Created order #${createResult.orderNumber} (ID: ${createResult.orderId})`);
      } else {
        result.failed++;
        result.orders.push({ index: i + 1, error: createResult.error });
        console.log(`  [${i + 1}/${config.orderCount}] Failed: ${createResult.error}`);
      }

      // Respect rate limits
      if (i < config.orderCount - 1) {
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
  console.log(`  Successful:      ${result.successful}`);
  console.log(`  Failed:          ${result.failed}`);
  console.log(`  Success Rate:    ${((result.successful / result.total) * 100).toFixed(2)}%`);
  console.log(`  Duration:        ${(result.duration / 1000).toFixed(2)}s`);
  console.log(`  Rate:            ${(result.total / (result.duration / 1000)).toFixed(2)} orders/sec`);
  console.log('================================================================================\n');

  if (result.successful > 0) {
    console.log('Created Order Numbers:');
    result.orders
      .filter(o => o.orderNumber)
      .forEach(o => console.log(`  - Order #${o.orderNumber}`));
    console.log('');
  }

  return result;
}

// ============= CHANNEL LOOKUP =============

async function getChannelCredentials(channelId: string): Promise<{ storeDomain: string; accessToken: string }> {
  const prisma = createPrismaClient();

  try {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        name: true,
        type: true,
        shopDomain: true,
        accessToken: true,
        status: true,
      },
    });

    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (channel.type !== 'SHOPIFY') {
      throw new Error(`Channel ${channelId} is not a Shopify channel (type: ${channel.type})`);
    }

    if (!channel.shopDomain) {
      throw new Error(`Channel ${channelId} has no shop domain configured`);
    }

    if (!channel.accessToken) {
      throw new Error(`Channel ${channelId} has no access token configured`);
    }

    console.log(`\n  Found channel: ${channel.name}`);
    console.log(`  Type: ${channel.type}`);
    console.log(`  Status: ${channel.status}`);
    console.log(`  Shop Domain: ${channel.shopDomain}`);

    // Decrypt the access token
    const encryptionService = new EncryptionService();
    const decryptedToken = encryptionService.isEncrypted(channel.accessToken)
      ? encryptionService.decrypt(channel.accessToken)
      : channel.accessToken;

    return {
      storeDomain: channel.shopDomain,
      accessToken: decryptedToken,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function listShopifyChannels(): Promise<void> {
  const prisma = createPrismaClient();

  try {
    const channels = await prisma.channel.findMany({
      where: { type: 'SHOPIFY' },
      select: {
        id: true,
        name: true,
        shopDomain: true,
        status: true,
        client: {
          select: {
            companyName: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    console.log('\n================================================================================');
    console.log('                    AVAILABLE SHOPIFY CHANNELS');
    console.log('================================================================================\n');

    if (channels.length === 0) {
      console.log('  No Shopify channels found in database.\n');
    } else {
      channels.forEach((ch, i) => {
        console.log(`  ${i + 1}. ${ch.name}`);
        console.log(`     ID:     ${ch.id}`);
        console.log(`     Domain: ${ch.shopDomain || 'Not set'}`);
        console.log(`     Status: ${ch.status}`);
        console.log(`     Client: ${ch.client?.companyName || 'No client'}`);
        console.log('');
      });
    }

    console.log('================================================================================');
    console.log('Usage: npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts \\');
    console.log('         --channel-id <ID> --count 5 --delay 2000');
    console.log('================================================================================\n');
  } finally {
    await prisma.$disconnect();
  }
}

// ============= CLI =============

async function main() {
  const args = process.argv.slice(2);

  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  // Show help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Shopify Bulk Order Creation Script

Usage:
  npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts [options]

Options:
  --channel-id <id>   Use OAuth credentials from database channel (recommended)
  --list              List all available Shopify channels
  --store <domain>    Shopify store domain (alternative to --channel-id)
  --token <token>     Admin API access token (alternative to --channel-id)
  --count <n>         Number of orders to create (default: 10)
  --delay <ms>        Delay between orders in ms (default: 500)
  --dry-run           Print orders without creating them
  --help              Show this help message

Examples:
  # Using channel ID (recommended)
  npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts --channel-id clxxx --count 5

  # List available channels
  npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts --list

  # Using manual credentials
  npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts --store mystore.myshopify.com --token shpat_xxx --count 10
`);
    process.exit(0);
  }

  // List channels
  if (args.includes('--list')) {
    await listShopifyChannels();
    process.exit(0);
  }

  const channelId = getArg('channel-id');
  let storeDomain = getArg('store') || process.env.SHOPIFY_STORE_DOMAIN;
  let accessToken = getArg('token') || process.env.SHOPIFY_ACCESS_TOKEN;
  const orderCount = parseInt(getArg('count') || '10', 10);
  const delayBetweenOrders = parseInt(getArg('delay') || '500', 10);
  const dryRun = args.includes('--dry-run');

  // If channel ID provided, look up credentials from database
  if (channelId) {
    console.log(`\nLooking up channel: ${channelId}...`);
    const credentials = await getChannelCredentials(channelId);
    storeDomain = credentials.storeDomain;
    accessToken = credentials.accessToken;
  }

  if (!storeDomain || !accessToken) {
    console.error('\nError: Credentials required. Use one of:');
    console.error('  --channel-id <id>  (recommended - uses OAuth from database)');
    console.error('  --store <domain> --token <token>  (manual credentials)');
    console.error('\nTo list available channels:');
    console.error('  npx tsx stress-tests/scripts/bulk-create-shopify-orders.ts --list');
    process.exit(1);
  }

  const config: BulkCreateConfig = {
    storeDomain,
    accessToken,
    orderCount,
    delayBetweenOrders,
    dryRun,
    apiVersion: '2024-01',
    channelId,
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
