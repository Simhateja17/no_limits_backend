/**
 * End-to-End JTL FFN Stress Test Script
 *
 * This script performs a complete integration test:
 * 1. Creates products in the local database
 * 2. Syncs products to JTL FFN warehouse
 * 3. Creates orders in Shopify with those products
 * 4. Orders flow through webhooks and sync to JTL FFN
 *
 * Usage:
 *   npx tsx stress-tests/scripts/e2e-jtl-stress-test.ts --channel-id <id> --count 5
 *
 * Options:
 *   --channel-id   Shopify channel ID (required)
 *   --count        Number of orders to create (default: 5)
 *   --delay        Delay between operations in ms (default: 1000)
 *   --skip-products Skip product creation/sync (use existing products)
 *   --dry-run      Print operations without executing them
 *   --help         Show help
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
      throw new Error('ENCRYPTION_KEY environment variable is required');
    }

    if (encryptionKey.length !== 64) {
      throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
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

// ============= TEST DATA =============

const TEST_PRODUCTS = [
  {
    sku: 'ST-TSHIRT-001',
    name: 'Stress Test T-Shirt',
    description: 'Premium quality stress test t-shirt for E2E testing',
    price: 29.99,
    weight: 0.25,
    gtin: '4260123456001',
  },
  {
    sku: 'ST-HOODIE-001',
    name: 'Stress Test Hoodie',
    description: 'Comfortable stress test hoodie for E2E testing',
    price: 59.99,
    weight: 0.6,
    gtin: '4260123456002',
  },
  {
    sku: 'ST-CAP-001',
    name: 'Stress Test Cap',
    description: 'Stylish stress test cap for E2E testing',
    price: 19.99,
    weight: 0.15,
    gtin: '4260123456003',
  },
  {
    sku: 'ST-SOCKS-001',
    name: 'Stress Test Socks Pack',
    description: 'Cozy stress test socks pack for E2E testing',
    price: 14.99,
    weight: 0.1,
    gtin: '4260123456004',
  },
  {
    sku: 'ST-BACKPACK-001',
    name: 'Stress Test Backpack',
    description: 'Durable stress test backpack for E2E testing',
    price: 79.99,
    weight: 0.8,
    gtin: '4260123456005',
  },
];

const TEST_ADDRESSES = {
  firstNames: ['Max', 'Anna', 'Felix', 'Julia', 'Leon', 'Sophie', 'Paul', 'Emma'],
  lastNames: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker'],
  cities: [
    { name: 'Berlin', zip: '10115' },
    { name: 'München', zip: '80331' },
    { name: 'Hamburg', zip: '20095' },
    { name: 'Köln', zip: '50667' },
    { name: 'Frankfurt', zip: '60311' },
  ],
  streets: ['Hauptstraße', 'Berliner Straße', 'Schulstraße', 'Bahnhofstraße', 'Gartenstraße'],
};

// ============= TYPES =============

interface E2ETestConfig {
  channelId: string;
  clientId: string;
  orderCount: number;
  delayMs: number;
  skipProducts: boolean;
  dryRun: boolean;
  shopifyDomain: string;
  shopifyToken: string;
  jtlConfig: {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
    warehouseId: string;
    fulfillerId: string;
    environment: 'sandbox' | 'production';
  } | null;
}

interface TestResult {
  phase: string;
  success: boolean;
  details: Record<string, any>;
  error?: string;
  duration: number;
}

// ============= JTL SERVICE (INLINE) =============

class JTLServiceInline {
  private baseUrl: string;
  private accessToken: string;

  constructor(config: E2ETestConfig['jtlConfig']) {
    if (!config) throw new Error('JTL config required');
    this.accessToken = config.accessToken;
    this.baseUrl = config.environment === 'production'
      ? 'https://ffn.api.jtl-software.com/api'
      : 'https://ffn-sbx.api.jtl-software.com/api';
  }

  async createProduct(product: {
    merchantSku: string;
    name: string;
    description?: string;
    identifier: { ean?: string };
    weight?: number;
  }): Promise<{ jfsku: string; merchantSku: string; status: string }> {
    const response = await fetch(`${this.baseUrl}/v1/merchant/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(product),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`JTL API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async getProductByMerchantSku(merchantSku: string): Promise<{ jfsku: string } | null> {
    const response = await fetch(
      `${this.baseUrl}/v1/merchant/products?merchantSku=${encodeURIComponent(merchantSku)}&$top=1`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.products?.[0] || null;
  }
}

// ============= HELPER FUNCTIONS =============

function randomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ============= PHASE 1: CREATE PRODUCTS IN DATABASE =============

async function createProductsInDatabase(
  prisma: PrismaClient,
  clientId: string,
  dryRun: boolean
): Promise<TestResult> {
  const startTime = Date.now();
  const createdProducts: string[] = [];
  const skippedProducts: string[] = [];
  const errors: string[] = [];

  console.log('\n  Creating products in local database...');

  for (const product of TEST_PRODUCTS) {
    try {
      // Check if product already exists
      const existing = await prisma.product.findFirst({
        where: { clientId, sku: product.sku },
      });

      if (existing) {
        skippedProducts.push(product.sku);
        console.log(`    [SKIP] ${product.sku} - already exists (ID: ${existing.id})`);
        continue;
      }

      if (dryRun) {
        console.log(`    [DRY-RUN] Would create ${product.sku}`);
        createdProducts.push(product.sku);
        continue;
      }

      // Create the product
      const created = await prisma.product.create({
        data: {
          clientId,
          sku: product.sku,
          name: product.name,
          description: product.description,
          gtin: product.gtin,
          netSalesPrice: product.price,
          weightInKg: product.weight,
          isActive: true,
          syncStatus: 'PENDING',
        },
      });

      createdProducts.push(product.sku);
      console.log(`    [OK] ${product.sku} - created (ID: ${created.id})`);
    } catch (error: any) {
      errors.push(`${product.sku}: ${error.message}`);
      console.log(`    [ERROR] ${product.sku} - ${error.message}`);
    }
  }

  return {
    phase: 'Create Products in Database',
    success: errors.length === 0,
    details: {
      created: createdProducts.length,
      skipped: skippedProducts.length,
      errors: errors.length,
      createdSkus: createdProducts,
      skippedSkus: skippedProducts,
    },
    error: errors.length > 0 ? errors.join('; ') : undefined,
    duration: Date.now() - startTime,
  };
}

// ============= PHASE 2: SYNC PRODUCTS TO JTL FFN =============

async function syncProductsToJTL(
  prisma: PrismaClient,
  clientId: string,
  config: E2ETestConfig,
): Promise<TestResult> {
  const startTime = Date.now();
  const syncedProducts: string[] = [];
  const skippedProducts: string[] = [];
  const errors: string[] = [];

  console.log('\n  Syncing products to JTL FFN...');

  if (!config.jtlConfig) {
    return {
      phase: 'Sync Products to JTL',
      success: false,
      details: { error: 'No JTL config found' },
      error: 'JTL is not configured for this client',
      duration: Date.now() - startTime,
    };
  }

  if (config.dryRun) {
    console.log('    [DRY-RUN] Would sync all products to JTL FFN');
    return {
      phase: 'Sync Products to JTL',
      success: true,
      details: { dryRun: true, productCount: TEST_PRODUCTS.length },
      duration: Date.now() - startTime,
    };
  }

  const jtlService = new JTLServiceInline(config.jtlConfig);

  for (const product of TEST_PRODUCTS) {
    try {
      // Check if product already exists in JTL
      const existingJtl = await jtlService.getProductByMerchantSku(product.sku);

      if (existingJtl) {
        skippedProducts.push(product.sku);
        console.log(`    [SKIP] ${product.sku} - already in JTL (JFSKU: ${existingJtl.jfsku})`);

        // Update local product with JTL ID
        await prisma.product.updateMany({
          where: { clientId, sku: product.sku },
          data: { jtlProductId: existingJtl.jfsku, syncStatus: 'SYNCED' },
        });
        continue;
      }

      // Create product in JTL
      const jtlProduct = {
        merchantSku: product.sku,
        name: product.name,
        description: product.description,
        identifier: { ean: product.gtin },
        weight: product.weight,
      };

      const result = await jtlService.createProduct(jtlProduct);

      // Update local product with JTL ID
      await prisma.product.updateMany({
        where: { clientId, sku: product.sku },
        data: { jtlProductId: result.jfsku, syncStatus: 'SYNCED' },
      });

      syncedProducts.push(product.sku);
      console.log(`    [OK] ${product.sku} - synced to JTL (JFSKU: ${result.jfsku})`);

      // Small delay to avoid rate limiting
      await sleep(300);
    } catch (error: any) {
      errors.push(`${product.sku}: ${error.message}`);
      console.log(`    [ERROR] ${product.sku} - ${error.message}`);
    }
  }

  return {
    phase: 'Sync Products to JTL',
    success: errors.length === 0,
    details: {
      synced: syncedProducts.length,
      skipped: skippedProducts.length,
      errors: errors.length,
      syncedSkus: syncedProducts,
    },
    error: errors.length > 0 ? errors.join('; ') : undefined,
    duration: Date.now() - startTime,
  };
}

// ============= PHASE 3: CREATE ORDERS IN SHOPIFY =============

async function createOrdersInShopify(
  config: E2ETestConfig
): Promise<TestResult> {
  const startTime = Date.now();
  const createdOrders: Array<{ id: number; number: string }> = [];
  const errors: string[] = [];

  console.log('\n  Creating orders in Shopify...');

  for (let i = 0; i < config.orderCount; i++) {
    try {
      const firstName = randomElement(TEST_ADDRESSES.firstNames);
      const lastName = randomElement(TEST_ADDRESSES.lastNames);
      const city = randomElement(TEST_ADDRESSES.cities);
      const street = randomElement(TEST_ADDRESSES.streets);
      const houseNumber = Math.floor(Math.random() * 150) + 1;

      // Generate 1-3 line items from our test products
      const numItems = Math.floor(Math.random() * 3) + 1;
      const lineItems = [];
      const usedIndices = new Set<number>();

      for (let j = 0; j < numItems; j++) {
        let idx: number;
        do {
          idx = Math.floor(Math.random() * TEST_PRODUCTS.length);
        } while (usedIndices.has(idx) && usedIndices.size < TEST_PRODUCTS.length);
        usedIndices.add(idx);

        const product = TEST_PRODUCTS[idx];
        lineItems.push({
          title: product.name,
          quantity: Math.floor(Math.random() * 2) + 1,
          price: product.price.toString(),
          sku: product.sku,
        });
      }

      const orderData = {
        order: {
          line_items: lineItems,
          customer: {
            first_name: firstName,
            last_name: lastName,
            email: `e2e-test-${i + 1}-${Date.now()}@stress-test.io`,
          },
          billing_address: {
            first_name: firstName,
            last_name: lastName,
            address1: `${street} ${houseNumber}`,
            city: city.name,
            country: 'Germany',
            zip: city.zip,
          },
          shipping_address: {
            first_name: firstName,
            last_name: lastName,
            address1: `${street} ${houseNumber}`,
            city: city.name,
            country: 'Germany',
            zip: city.zip,
          },
          financial_status: 'paid',
          fulfillment_status: null,
          tags: 'e2e-test, jtl-sync-test',
          note: `E2E JTL sync test order #${i + 1} - ${new Date().toISOString()}`,
          send_receipt: false,
          send_fulfillment_receipt: false,
          inventory_behaviour: 'bypass',
        },
      };

      if (config.dryRun) {
        console.log(`    [DRY-RUN] Would create order #${i + 1} with ${lineItems.length} items`);
        createdOrders.push({ id: 0, number: `DRY-${i + 1}` });
        continue;
      }

      const url = `https://${config.shopifyDomain}/admin/api/2024-01/orders.json`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': config.shopifyToken,
        },
        body: JSON.stringify(orderData),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      const orderId = result.order?.id;
      const orderNumber = result.order?.order_number?.toString() || result.order?.name;

      createdOrders.push({ id: orderId, number: orderNumber });
      console.log(`    [OK] Order #${orderNumber} created (ID: ${orderId}) - ${lineItems.length} items`);

      // Delay between orders
      if (i < config.orderCount - 1) {
        await sleep(config.delayMs);
      }
    } catch (error: any) {
      errors.push(`Order ${i + 1}: ${error.message}`);
      console.log(`    [ERROR] Order ${i + 1} - ${error.message}`);
    }
  }

  return {
    phase: 'Create Orders in Shopify',
    success: errors.length === 0,
    details: {
      created: createdOrders.length,
      errors: errors.length,
      orders: createdOrders,
    },
    error: errors.length > 0 ? errors.join('; ') : undefined,
    duration: Date.now() - startTime,
  };
}

// ============= MAIN EXECUTION =============

async function loadConfig(channelId: string): Promise<E2ETestConfig> {
  const prisma = createPrismaClient();
  const encryptionService = new EncryptionService();

  try {
    // Load channel info
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      include: { client: true },
    });

    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (channel.type !== 'SHOPIFY') {
      throw new Error(`Channel ${channelId} is not a Shopify channel`);
    }

    if (!channel.shopDomain || !channel.accessToken) {
      throw new Error(`Channel ${channelId} missing Shopify credentials`);
    }

    // Load JTL config
    const jtlConfig = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: channel.clientId },
    });

    let jtlConfigDecrypted: E2ETestConfig['jtlConfig'] = null;
    if (jtlConfig && jtlConfig.accessToken) {
      jtlConfigDecrypted = {
        clientId: jtlConfig.clientId,
        clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
        accessToken: encryptionService.decrypt(jtlConfig.accessToken),
        refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : '',
        warehouseId: jtlConfig.warehouseId,
        fulfillerId: jtlConfig.fulfillerId,
        environment: jtlConfig.environment as 'sandbox' | 'production',
      };
    }

    return {
      channelId,
      clientId: channel.clientId,
      orderCount: 5,
      delayMs: 1000,
      skipProducts: false,
      dryRun: false,
      shopifyDomain: channel.shopDomain,
      shopifyToken: encryptionService.isEncrypted(channel.accessToken)
        ? encryptionService.decrypt(channel.accessToken)
        : channel.accessToken,
      jtlConfig: jtlConfigDecrypted,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function runE2ETest(config: E2ETestConfig): Promise<void> {
  const prisma = createPrismaClient();
  const results: TestResult[] = [];
  const overallStart = Date.now();

  console.log('\n================================================================================');
  console.log('               E2E JTL FFN STRESS TEST');
  console.log('================================================================================');
  console.log(`  Channel ID:      ${config.channelId}`);
  console.log(`  Client ID:       ${config.clientId}`);
  console.log(`  Shopify Domain:  ${config.shopifyDomain}`);
  console.log(`  JTL Configured:  ${config.jtlConfig ? 'Yes' : 'No'}`);
  console.log(`  Order Count:     ${config.orderCount}`);
  console.log(`  Delay:           ${config.delayMs}ms`);
  console.log(`  Skip Products:   ${config.skipProducts}`);
  console.log(`  Dry Run:         ${config.dryRun}`);
  console.log('================================================================================');

  try {
    // Phase 1: Create products in database
    if (!config.skipProducts) {
      console.log('\n[PHASE 1] Creating Products in Database');
      console.log('─'.repeat(60));
      const phase1Result = await createProductsInDatabase(prisma, config.clientId, config.dryRun);
      results.push(phase1Result);
      console.log(`  Duration: ${formatDuration(phase1Result.duration)}`);
      console.log(`  Status: ${phase1Result.success ? '✓ SUCCESS' : '✗ FAILED'}`);

      if (!phase1Result.success) {
        console.log(`  Error: ${phase1Result.error}`);
      }

      await sleep(500);
    }

    // Phase 2: Sync products to JTL FFN
    if (!config.skipProducts && config.jtlConfig) {
      console.log('\n[PHASE 2] Syncing Products to JTL FFN');
      console.log('─'.repeat(60));
      const phase2Result = await syncProductsToJTL(prisma, config.clientId, config);
      results.push(phase2Result);
      console.log(`  Duration: ${formatDuration(phase2Result.duration)}`);
      console.log(`  Status: ${phase2Result.success ? '✓ SUCCESS' : '✗ FAILED'}`);

      if (!phase2Result.success) {
        console.log(`  Error: ${phase2Result.error}`);
      }

      // Wait for JTL to process
      console.log('\n  Waiting 3s for JTL to process products...');
      await sleep(3000);
    }

    // Phase 3: Create orders in Shopify
    console.log('\n[PHASE 3] Creating Orders in Shopify');
    console.log('─'.repeat(60));
    const phase3Result = await createOrdersInShopify(config);
    results.push(phase3Result);
    console.log(`  Duration: ${formatDuration(phase3Result.duration)}`);
    console.log(`  Status: ${phase3Result.success ? '✓ SUCCESS' : '✗ FAILED'}`);

    if (!phase3Result.success) {
      console.log(`  Error: ${phase3Result.error}`);
    }

    // Summary
    const overallDuration = Date.now() - overallStart;
    const allSuccess = results.every(r => r.success);

    console.log('\n================================================================================');
    console.log('                            SUMMARY');
    console.log('================================================================================');

    results.forEach((result, i) => {
      console.log(`  Phase ${i + 1}: ${result.phase}`);
      console.log(`           Status: ${result.success ? '✓ SUCCESS' : '✗ FAILED'}`);
      console.log(`           Duration: ${formatDuration(result.duration)}`);
      if (result.details.created !== undefined) {
        console.log(`           Created: ${result.details.created}`);
      }
      if (result.details.synced !== undefined) {
        console.log(`           Synced: ${result.details.synced}`);
      }
      if (result.details.skipped !== undefined) {
        console.log(`           Skipped: ${result.details.skipped}`);
      }
      console.log('');
    });

    console.log('================================================================================');
    console.log(`  Overall Status:  ${allSuccess ? '✓ ALL PHASES SUCCEEDED' : '✗ SOME PHASES FAILED'}`);
    console.log(`  Total Duration:  ${formatDuration(overallDuration)}`);
    console.log('================================================================================');

    if (phase3Result.details.orders?.length > 0) {
      console.log('\n  Next Steps:');
      console.log('  1. Shopify webhooks will trigger automatically');
      console.log('  2. Orders will be queued for JTL FFN sync');
      console.log('  3. Monitor Azure logs for sync status');
      console.log('\n  Created Orders:');
      phase3Result.details.orders.forEach((o: any) => {
        console.log(`    - Order #${o.number}${o.id ? ` (ID: ${o.id})` : ''}`);
      });
    }

    console.log('\n');
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

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
E2E JTL FFN Stress Test Script

Usage:
  npx tsx stress-tests/scripts/e2e-jtl-stress-test.ts [options]

Options:
  --channel-id <id>   Shopify channel ID (required)
  --count <n>         Number of orders to create (default: 5)
  --delay <ms>        Delay between operations in ms (default: 1000)
  --skip-products     Skip product creation/sync (use existing products)
  --dry-run           Print operations without executing them
  --help              Show this help message

Examples:
  # Full E2E test with 5 orders
  npx tsx stress-tests/scripts/e2e-jtl-stress-test.ts --channel-id clxxx --count 5

  # Skip product sync (products already in JTL)
  npx tsx stress-tests/scripts/e2e-jtl-stress-test.ts --channel-id clxxx --count 10 --skip-products

  # Dry run to see what would happen
  npx tsx stress-tests/scripts/e2e-jtl-stress-test.ts --channel-id clxxx --dry-run
`);
    process.exit(0);
  }

  const channelId = getArg('channel-id');
  if (!channelId) {
    console.error('\nError: --channel-id is required');
    console.error('Usage: npx tsx stress-tests/scripts/e2e-jtl-stress-test.ts --channel-id <id>');
    process.exit(1);
  }

  try {
    console.log(`\nLoading configuration for channel: ${channelId}...`);
    const config = await loadConfig(channelId);

    // Apply CLI overrides
    const countArg = getArg('count');
    if (countArg) config.orderCount = parseInt(countArg, 10);

    const delayArg = getArg('delay');
    if (delayArg) config.delayMs = parseInt(delayArg, 10);

    if (args.includes('--skip-products')) config.skipProducts = true;
    if (args.includes('--dry-run')) config.dryRun = true;

    await runE2ETest(config);
    process.exit(0);
  } catch (error: any) {
    console.error('\nFatal error:', error.message);
    process.exit(1);
  }
}

main();
