/**
 * Migration Script: Fix Payment Status for Existing WooCommerce Orders
 *
 * Problem: WooCommerce orders created before the payment status fix have paymentStatus = null
 * Solution: Update paymentStatus based on current order status
 *
 * Usage: npx ts-node backend/scripts/migrate-woocommerce-payment-status.ts
 */

import { PrismaClient, OrderStatus } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// Initialize Prisma with pg adapter (Prisma 7 requirement)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * Maps WooCommerce order status to payment status
 */
function mapOrderStatusToPaymentStatus(status: OrderStatus): string | null {
  switch (status) {
    case OrderStatus.PROCESSING:
    case OrderStatus.DELIVERED:
    case OrderStatus.PARTIALLY_FULFILLED:
    case OrderStatus.SHIPPED:
      return 'paid';
    case OrderStatus.CANCELLED:
      // Check if it was refunded or just cancelled before payment
      return null; // Will handle refunds separately
    case OrderStatus.ON_HOLD:
    case OrderStatus.PENDING:
      return 'pending';
    case OrderStatus.ERROR:
      return 'failed';
    default:
      return null;
  }
}

async function migrateWooCommercePaymentStatus() {
  console.log('🔍 Finding WooCommerce orders with null paymentStatus...\n');

  // Find all WooCommerce orders with null paymentStatus
  const orders = await prisma.order.findMany({
    where: {
      orderOrigin: 'WOOCOMMERCE',
      paymentStatus: null,
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      externalOrderId: true,
      isOnHold: true,
      holdReason: true,
    },
  });

  console.log(`Found ${orders.length} WooCommerce orders with null paymentStatus\n`);

  if (orders.length === 0) {
    console.log('✅ No orders to migrate. All WooCommerce orders have payment status set.');
    return;
  }

  let updated = 0;
  let skipped = 0;
  const updates: Array<{ orderNumber: string; status: OrderStatus; newPaymentStatus: string | null }> = [];

  for (const order of orders) {
    const newPaymentStatus = mapOrderStatusToPaymentStatus(order.status);

    // Special handling: If order is on AWAITING_PAYMENT hold, keep as 'pending'
    if (order.isOnHold && order.holdReason === 'AWAITING_PAYMENT') {
      updates.push({
        orderNumber: order.orderNumber,
        status: order.status,
        newPaymentStatus: 'pending',
      });

      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'pending' },
      });

      updated++;
      continue;
    }

    if (newPaymentStatus !== null) {
      updates.push({
        orderNumber: order.orderNumber,
        status: order.status,
        newPaymentStatus,
      });

      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: newPaymentStatus },
      });

      updated++;
    } else {
      skipped++;
    }
  }

  console.log('📊 Migration Summary:\n');
  console.log(`  ✅ Updated: ${updated} orders`);
  console.log(`  ⏭️  Skipped: ${skipped} orders (cancelled/unknown status)`);
  console.log('');

  if (updates.length > 0) {
    console.log('📋 Sample Updates (first 20):');
    console.log('─'.repeat(80));
    console.table(
      updates.slice(0, 20).map(u => ({
        'Order Number': u.orderNumber,
        'Order Status': u.status,
        'New Payment Status': u.newPaymentStatus,
      }))
    );
  }

  console.log('\n✅ Migration complete!');
  console.log('\n💡 Next steps:');
  console.log('   1. Verify in database: SELECT orderNumber, status, paymentStatus FROM "Order" WHERE origin = \'woocommerce\' LIMIT 10;');
  console.log('   2. Check frontend: Visit /admin/orders and verify PAYMENT STATUS column');
  console.log('   3. Test with new order: Create a test WooCommerce order and verify payment status\n');
}

// Run migration
migrateWooCommercePaymentStatus()
  .then(() => {
    console.log('Migration script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
