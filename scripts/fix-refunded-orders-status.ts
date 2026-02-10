/**
 * Fix Refunded Orders Status
 *
 * Updates all orders where paymentStatus is 'refunded' to have consistent
 * cancelled state across all relevant fields:
 *   - status → CANCELLED
 *   - fulfillmentState → CANCELED
 *   - isCancelled → true
 *   - isOnHold → false (release hold)
 *
 * Run: npx tsx scripts/fix-refunded-orders-status.ts
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function fixRefundedOrdersStatus() {
  // Find all orders with paymentStatus='refunded' that aren't fully cancelled
  const orders = await prisma.order.findMany({
    where: {
      paymentStatus: 'refunded',
      OR: [
        { NOT: { fulfillmentState: 'CANCELED' } },
        { isCancelled: false },
        { isOnHold: true },
      ],
    },
    select: {
      id: true,
      orderId: true,
      orderNumber: true,
      status: true,
      fulfillmentState: true,
      isCancelled: true,
      isOnHold: true,
    },
  });

  console.log(`Found ${orders.length} refunded order(s) needing fix:\n`);

  if (orders.length === 0) {
    console.log('Nothing to fix.');
    await prisma.$disconnect();
    return;
  }

  for (const order of orders) {
    console.log(`  ${order.orderNumber || order.orderId}: fulfillmentState=${order.fulfillmentState}, isCancelled=${order.isCancelled}, isOnHold=${order.isOnHold}`);
  }

  // Batch update all at once
  const result = await prisma.order.updateMany({
    where: {
      paymentStatus: 'refunded',
      OR: [
        { NOT: { fulfillmentState: 'CANCELED' } },
        { isCancelled: false },
        { isOnHold: true },
      ],
    },
    data: {
      status: 'CANCELLED',
      fulfillmentState: 'CANCELED',
      isCancelled: true,
      isOnHold: false,
      holdReason: null,
      holdReleasedAt: new Date(),
      holdReleasedBy: 'SYSTEM',
    },
  });

  console.log(`\nUpdated ${result.count} order(s).`);
  await prisma.$disconnect();
}

fixRefundedOrdersStatus()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Failed:', error);
    process.exit(1);
  });
