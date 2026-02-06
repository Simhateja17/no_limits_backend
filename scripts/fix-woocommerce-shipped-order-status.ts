/**
 * Migration Script: Fix WooCommerce Shipped Order Status
 *
 * Problem: Due to a bug in fulfillment status sync (missing 'FULFILLED' mapping),
 * orders marked as "Shipped" in JTL FFN were synced to WooCommerce with status
 * "processing" instead of "completed". This bug has been fixed in the codebase,
 * but existing orders remain incorrect in WooCommerce.
 *
 * This script:
 * 1. Finds all WooCommerce orders with fulfillmentState = 'SHIPPED' or 'DELIVERED'
 * 2. Fetches current status from WooCommerce API
 * 3. Updates orders that are currently 'processing' to 'completed'
 * 4. Skips orders that are already correct or have other statuses
 * 5. Reports detailed statistics
 *
 * Impact:
 * - Only updates WooCommerce (via API) - no database changes needed
 * - Our database already has correct fulfillmentState
 * - WooCommerce may send "Order completed" emails (depending on settings)
 *
 * Usage:
 *   npx tsx scripts/fix-woocommerce-shipped-order-status.ts
 *   npx tsx scripts/fix-woocommerce-shipped-order-status.ts --dry-run
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { WooCommerceService } from '../src/services/integrations/woocommerce.service.js';
import { getEncryptionService } from '../src/services/encryption.service.js';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const isDryRun = process.argv.includes('--dry-run');

interface MigrationStats {
  totalChecked: number;
  totalFixed: number;
  totalAlreadyCorrect: number;
  totalSkipped: number;
  totalErrors: number;
  errorsByReason: Map<string, number>;
}

async function fixWooCommerceShippedOrderStatus() {
  const stats: MigrationStats = {
    totalChecked: 0,
    totalFixed: 0,
    totalAlreadyCorrect: 0,
    totalSkipped: 0,
    totalErrors: 0,
    errorsByReason: new Map(),
  };

  console.log('='.repeat(60));
  console.log('WooCommerce Shipped Order Status Migration');
  console.log('='.repeat(60));

  if (isDryRun) {
    console.log('\n🔍 DRY RUN MODE - No changes will be made\n');
  }

  console.log('🔍 Finding WooCommerce channels...\n');

  // Find all WooCommerce channels with credentials
  const wooChannels = await prisma.channel.findMany({
    where: { type: 'WOOCOMMERCE' },
    select: {
      id: true,
      name: true,
      url: true,
      apiUrl: true,
      apiClientId: true,
      apiClientSecret: true,
    },
  });

  if (wooChannels.length === 0) {
    console.log('✅ No WooCommerce channels found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${wooChannels.length} WooCommerce channel(s):\n`);
  console.table(wooChannels.map(c => ({ id: c.id, name: c.name, apiUrl: c.apiUrl })));

  const encryptionService = getEncryptionService();

  // Process each channel
  for (const channel of wooChannels) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📦 Processing channel: ${channel.name} (${channel.id})`);
    console.log(`${'─'.repeat(60)}`);

    // Verify channel has credentials
    const storeUrl = channel.apiUrl || channel.url;
    if (!storeUrl || !channel.apiClientId || !channel.apiClientSecret) {
      console.log('⚠️  Skipping channel - missing API credentials');
      continue;
    }

    // Initialize WooCommerce service
    let wooService: WooCommerceService;
    try {
      wooService = new WooCommerceService({
        url: storeUrl,
        consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
        consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
      });
    } catch (error) {
      console.log(`❌ Failed to initialize WooCommerce service:`, error);
      continue;
    }

    // Find orders with SHIPPED or DELIVERED fulfillment state
    const candidateOrders = await prisma.order.findMany({
      where: {
        channelId: channel.id,
        orderOrigin: 'WOOCOMMERCE',
        fulfillmentState: {
          in: ['SHIPPED', 'DELIVERED'],
        },
        externalOrderId: { not: null }, // Must have WooCommerce order ID
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderId: true,
        fulfillmentState: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (candidateOrders.length === 0) {
      console.log('✅ No shipped/delivered orders found for this channel');
      continue;
    }

    console.log(`\n📋 Found ${candidateOrders.length} orders with SHIPPED/DELIVERED status`);
    console.log('   Checking current WooCommerce status...\n');

    let channelFixed = 0;
    let channelAlreadyCorrect = 0;
    let channelSkipped = 0;
    let channelErrors = 0;

    // Process each order
    for (const order of candidateOrders) {
      try {
        stats.totalChecked++;
        const wooOrderId = parseInt(order.externalOrderId, 10);

        if (isNaN(wooOrderId)) {
          throw new Error(`Invalid externalOrderId: ${order.externalOrderId}`);
        }

        // Fetch current status from WooCommerce
        const wooOrder = await wooService.getOrder(wooOrderId);

        // Check current status and decide action
        if (wooOrder.status === 'processing') {
          // This is the bug - should be 'completed'
          if (!isDryRun) {
            await wooService.updateOrderStatus(wooOrderId, 'completed');
          }
          channelFixed++;
          stats.totalFixed++;
          console.log(`   ✓ Order ${order.orderNumber}: processing → completed${isDryRun ? ' (dry run)' : ''}`);
        } else if (wooOrder.status === 'completed') {
          // Already correct (maybe manually fixed or never had the bug)
          channelAlreadyCorrect++;
          stats.totalAlreadyCorrect++;
          console.log(`   ℹ Order ${order.orderNumber}: already completed`);
        } else {
          // Other status (cancelled, refunded, on-hold, etc.)
          // Don't override - could be intentional
          channelSkipped++;
          stats.totalSkipped++;
          console.log(`   ⚠ Order ${order.orderNumber}: unexpected status '${wooOrder.status}' - skipping`);
        }

        // Rate limiting - avoid hitting API too hard (100ms = 10 req/sec)
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        channelErrors++;
        stats.totalErrors++;
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`   ✗ Order ${order.orderNumber}: ${errMsg}`);

        // Track error reasons for summary
        const errorReason = errMsg.includes('404') ? 'Not found (404)' :
                          errMsg.includes('401') || errMsg.includes('403') ? 'Auth error' :
                          errMsg.includes('timeout') ? 'Timeout' :
                          'Other error';
        stats.errorsByReason.set(errorReason, (stats.errorsByReason.get(errorReason) || 0) + 1);
      }
    }

    // Channel summary
    console.log(`\n   📊 Channel Summary:`);
    console.log(`      Orders checked:       ${candidateOrders.length}`);
    console.log(`      Fixed:                ${channelFixed}${isDryRun ? ' (dry run)' : ''}`);
    console.log(`      Already correct:      ${channelAlreadyCorrect}`);
    console.log(`      Skipped (other status): ${channelSkipped}`);
    console.log(`      Errors:               ${channelErrors}`);
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Final Summary');
  console.log('='.repeat(60));
  console.log(`\nTotal orders checked:           ${stats.totalChecked}`);
  console.log(`Fixed (processing → completed): ${stats.totalFixed}${isDryRun ? ' (dry run)' : ''}`);
  console.log(`Already correct (completed):    ${stats.totalAlreadyCorrect}`);
  console.log(`Skipped (other statuses):       ${stats.totalSkipped}`);
  console.log(`Errors:                         ${stats.totalErrors}`);

  if (stats.errorsByReason.size > 0) {
    console.log('\n❌ Error Breakdown:');
    Array.from(stats.errorsByReason.entries()).forEach(([reason, count]) => {
      console.log(`   - ${reason}: ${count}`);
    });
  }

  if (isDryRun) {
    console.log('\n🔍 This was a dry run. Run without --dry-run to apply changes.');
  } else if (stats.totalFixed > 0) {
    console.log('\n✨ Migration complete! WooCommerce orders have been updated.');
    console.log('\n💡 Note: WooCommerce may have sent "Order completed" emails to customers');
    console.log('   if email notifications are enabled in WooCommerce → Settings → Emails.');
  } else {
    console.log('\n✨ No orders needed fixing - all WooCommerce statuses are already correct!');
  }

  console.log('='.repeat(60));
}

// Entry point
async function main() {
  try {
    await fixWooCommerceShippedOrderStatus();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main()
  .then(() => {
    console.log('\n✅ Script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
