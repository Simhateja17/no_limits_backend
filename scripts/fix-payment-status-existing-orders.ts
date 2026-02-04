/**
 * Migration Script: Fix Payment Status for Existing WooCommerce Orders
 *
 * Problem: During initial sync, paymentStatus was not being set, causing all
 * orders to show as "Unpaid" in the UI.
 *
 * This script:
 * 1. Finds all WooCommerce orders with null paymentStatus
 * 2. Fetches current status from WooCommerce API
 * 3. Updates paymentStatus, isOnHold, holdReason, and orderDate
 *
 * Run: npx tsx scripts/fix-payment-status-existing-orders.ts
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

const WOOCOMMERCE_UNPAID_STATUSES = ['pending', 'on-hold'];

function mapWooCommercePaymentStatus(status?: string): string | null {
  if (!status) return null;
  switch (status.toLowerCase()) {
    case 'processing':
    case 'completed':
    case 'delivered': // Custom WooCommerce status - delivered orders are paid
      return 'paid';
    case 'refunded':
      return 'refunded';
    case 'pending':
    case 'on-hold':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'cancelled':
    default:
      return null;
  }
}

function shouldHoldForPayment(status?: string): boolean {
  if (!status) return true;
  return WOOCOMMERCE_UNPAID_STATUSES.includes(status.toLowerCase());
}

async function fixPaymentStatusForExistingOrders() {
  console.log('🔍 Finding WooCommerce channels...\n');

  // Find all WooCommerce channels with credentials
  const wooChannels = await prisma.channel.findMany({
    where: { type: 'WOOCOMMERCE' },
    select: {
      id: true,
      name: true,
      clientId: true,
      url: true,
      apiUrl: true,
      apiClientId: true,
      apiClientSecret: true,
    },
  });

  if (wooChannels.length === 0) {
    console.log('✅ No WooCommerce channels found.');
    return;
  }

  console.log(`Found ${wooChannels.length} WooCommerce channel(s):\n`);
  console.table(wooChannels.map(c => ({ id: c.id, name: c.name })));

  const encryptionService = getEncryptionService();
  let totalFixed = 0;
  let totalErrors = 0;

  for (const channel of wooChannels) {
    console.log(`\n📦 Processing channel: ${channel.name} (${channel.id})`);

    // Find orders with null paymentStatus
    const ordersToFix = await prisma.order.findMany({
      where: {
        channelId: channel.id,
        paymentStatus: null,
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderId: true,
        orderDate: true,
        isOnHold: true,
      },
    });

    if (ordersToFix.length === 0) {
      console.log(`   ✅ No orders need fixing for this channel.`);
      continue;
    }

    console.log(`   Found ${ordersToFix.length} orders with null paymentStatus`);

    // Initialize WooCommerce service
    let wooService: WooCommerceService;
    try {
      const storeUrl = channel.apiUrl || channel.url;
      if (!storeUrl || !channel.apiClientId || !channel.apiClientSecret) {
        console.log(`   ⚠️ Skipping channel - missing credentials`);
        continue;
      }

      wooService = new WooCommerceService({
        url: storeUrl,
        consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
        consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
      });
    } catch (error) {
      console.log(`   ⚠️ Failed to initialize WooCommerce service:`, error);
      continue;
    }

    // Process each order
    let channelFixed = 0;
    let channelErrors = 0;

    for (const order of ordersToFix) {
      try {
        const orderId = parseInt(order.externalOrderId, 10);
        if (isNaN(orderId)) {
          console.log(`   ⚠️ Invalid external order ID: ${order.externalOrderId}`);
          channelErrors++;
          continue;
        }

        // Fetch current status from WooCommerce
        const wooOrder = await wooService.getOrder(orderId);

        const newPaymentStatus = mapWooCommercePaymentStatus(wooOrder.status);
        const shouldHold = shouldHoldForPayment(wooOrder.status);
        const orderDate = wooOrder.date_created ? new Date(wooOrder.date_created) : order.orderDate;

        await prisma.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: newPaymentStatus,
            isOnHold: shouldHold,
            holdReason: shouldHold ? 'AWAITING_PAYMENT' : null,
            holdPlacedAt: shouldHold ? new Date() : null,
            holdPlacedBy: shouldHold ? 'SYSTEM' : null,
            orderDate: orderDate,
          },
        });

        channelFixed++;
        console.log(`   ✓ Order ${order.orderNumber}: status=${wooOrder.status} → paymentStatus=${newPaymentStatus}`);
      } catch (error) {
        channelErrors++;
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`   ✗ Order ${order.orderNumber}: ${errMsg}`);
      }

      // Rate limiting - avoid hitting API too hard
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`   📊 Channel summary: ${channelFixed} fixed, ${channelErrors} errors`);
    totalFixed += channelFixed;
    totalErrors += channelErrors;
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 Final Summary:');
  console.log(`   Total orders fixed: ${totalFixed}`);
  console.log(`   Total errors: ${totalErrors}`);
  console.log('='.repeat(50));

  await prisma.$disconnect();
}

fixPaymentStatusForExistingOrders()
  .then(() => {
    console.log('\n✨ Migration complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
