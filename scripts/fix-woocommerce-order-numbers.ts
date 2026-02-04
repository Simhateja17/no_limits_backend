/**
 * Migration Script: Fix WooCommerce Order Numbers
 *
 * This script backfills the `orderNumber` field for WooCommerce orders that are
 * missing it. The order number (e.g., "2219-15905") is different from the internal
 * WooCommerce order ID (e.g., "15874") and should be displayed to users.
 *
 * Usage:
 *   npx ts-node backend/scripts/fix-woocommerce-order-numbers.ts
 *   npx ts-node backend/scripts/fix-woocommerce-order-numbers.ts --dry-run
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

import { WooCommerceService } from '../src/services/integrations/woocommerce.service.js';
import { getEncryptionService } from '../src/services/encryption.service.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const isDryRun = process.argv.includes('--dry-run');

interface MigrationStats {
  totalOrdersChecked: number;
  ordersNeedingFix: number;
  ordersFixed: number;
  ordersFailed: number;
  errors: Array<{ orderId: string; externalOrderId: string; error: string }>;
}

async function fixWooCommerceOrderNumbers(): Promise<void> {
  const stats: MigrationStats = {
    totalOrdersChecked: 0,
    ordersNeedingFix: 0,
    ordersFixed: 0,
    ordersFailed: 0,
    errors: [],
  };

  console.log('='.repeat(60));
  console.log('WooCommerce Order Number Migration');
  console.log('='.repeat(60));

  if (isDryRun) {
    console.log('\n🔍 DRY RUN MODE - No changes will be made\n');
  }

  // Step 1: Find all WooCommerce channels
  console.log('\n📦 Finding WooCommerce channels...\n');

  const wooChannels = await prisma.channel.findMany({
    where: { type: 'WOOCOMMERCE' },
    select: {
      id: true,
      name: true,
      apiUrl: true,
      apiClientId: true,
      apiClientSecret: true,
      clientId: true,
    },
  });

  if (wooChannels.length === 0) {
    console.log('✅ No WooCommerce channels found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${wooChannels.length} WooCommerce channel(s):`);
  console.table(wooChannels.map(c => ({ id: c.id, name: c.name, apiUrl: c.apiUrl })));

  const encryptionService = getEncryptionService();

  // Process each channel
  for (const channel of wooChannels) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Processing channel: ${channel.name} (${channel.id})`);
    console.log(`${'─'.repeat(60)}`);

    // Check if channel has valid credentials
    if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
      console.log(`⚠️  Skipping channel - missing API credentials`);
      continue;
    }

    // Create WooCommerce service instance
    let wooService: WooCommerceService;
    try {
      wooService = new WooCommerceService({
        url: channel.apiUrl,
        consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
        consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
      });
    } catch (error) {
      console.log(`❌ Failed to create WooCommerce service: ${error}`);
      continue;
    }

    // Find orders with missing orderNumber
    const ordersToFix = await prisma.order.findMany({
      where: {
        channelId: channel.id,
        orderOrigin: 'WOOCOMMERCE',
        OR: [
          { orderNumber: null },
          { orderNumber: '' },
        ],
      },
      select: {
        id: true,
        orderId: true,
        externalOrderId: true,
        orderNumber: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    stats.totalOrdersChecked += ordersToFix.length;
    stats.ordersNeedingFix += ordersToFix.length;

    console.log(`\n📋 Found ${ordersToFix.length} orders with missing orderNumber`);

    if (ordersToFix.length === 0) {
      console.log('✅ No orders need fixing in this channel');
      continue;
    }

    // Sample some orders
    if (ordersToFix.length > 5) {
      console.log('\nSample of orders to fix:');
      console.table(ordersToFix.slice(0, 5).map(o => ({
        id: o.id.substring(0, 8) + '...',
        externalOrderId: o.externalOrderId,
        currentOrderNumber: o.orderNumber || '(null)',
      })));
      console.log(`... and ${ordersToFix.length - 5} more`);
    } else {
      console.log('\nOrders to fix:');
      console.table(ordersToFix.map(o => ({
        id: o.id.substring(0, 8) + '...',
        externalOrderId: o.externalOrderId,
        currentOrderNumber: o.orderNumber || '(null)',
      })));
    }

    // Process orders in batches
    const BATCH_SIZE = 10;
    const totalBatches = Math.ceil(ordersToFix.length / BATCH_SIZE);

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const batchStart = batchNum * BATCH_SIZE;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, ordersToFix.length);
      const batch = ordersToFix.slice(batchStart, batchEnd);

      console.log(`\n📦 Processing batch ${batchNum + 1}/${totalBatches} (${batch.length} orders)...`);

      for (const order of batch) {
        try {
          // Fetch order from WooCommerce API using externalOrderId
          const wooOrderId = parseInt(order.externalOrderId, 10);

          if (isNaN(wooOrderId)) {
            throw new Error(`Invalid externalOrderId: ${order.externalOrderId}`);
          }

          const wooOrder = await wooService.getOrder(wooOrderId);

          if (!wooOrder.number) {
            throw new Error(`WooCommerce order ${wooOrderId} has no number field`);
          }

          console.log(`  ✓ Order ${order.externalOrderId} → number: ${wooOrder.number}`);

          if (!isDryRun) {
            // Update the order with the correct orderNumber
            await prisma.order.update({
              where: { id: order.id },
              data: { orderNumber: wooOrder.number },
            });
          }

          stats.ordersFixed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log(`  ✗ Order ${order.externalOrderId}: ${errorMessage}`);
          stats.ordersFailed++;
          stats.errors.push({
            orderId: order.id,
            externalOrderId: order.externalOrderId,
            error: errorMessage,
          });
        }

        // Rate limiting - small delay between API calls
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`\nTotal orders checked:    ${stats.totalOrdersChecked}`);
  console.log(`Orders needing fix:      ${stats.ordersNeedingFix}`);
  console.log(`Orders fixed:            ${stats.ordersFixed}${isDryRun ? ' (dry run)' : ''}`);
  console.log(`Orders failed:           ${stats.ordersFailed}`);

  if (stats.errors.length > 0) {
    console.log(`\n❌ Errors (${stats.errors.length}):`);
    for (const err of stats.errors.slice(0, 10)) {
      console.log(`   - Order ${err.externalOrderId}: ${err.error}`);
    }
    if (stats.errors.length > 10) {
      console.log(`   ... and ${stats.errors.length - 10} more errors`);
    }
  }

  if (isDryRun) {
    console.log('\n🔍 This was a dry run. Run without --dry-run to apply changes.');
  } else {
    console.log('\n✨ Migration complete!');
  }

  await prisma.$disconnect();
  await pool.end();
}

// Run migration
fixWooCommerceOrderNumbers()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  });
