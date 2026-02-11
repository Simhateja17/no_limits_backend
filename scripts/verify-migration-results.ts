/**
 * Verify Payment Status Migration Results
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const CLIENT_ID = 'cml7yr6pg0001mbs1jiw2rpn5';

async function verifyResults() {
  console.log('🔍 Verifying Migration Results...\n');

  // 1. Check remaining payment holds
  const remainingHolds = await prisma.order.count({
    where: {
      clientId: CLIENT_ID,
      isOnHold: true,
      holdReason: 'AWAITING_PAYMENT',
    },
  });

  console.log('✅ Remaining payment holds:', remainingHolds);
  console.log('   Expected: 0 (all holds should be released)\n');

  // 2. Check order #15971 (the problem order)
  const order15971 = await prisma.order.findFirst({
    where: { orderNumber: '15971' },
    select: {
      orderNumber: true,
      paymentStatus: true,
      isOnHold: true,
      holdReason: true,
      holdReleasedAt: true,
      holdReleasedBy: true,
      jtlOutboundId: true,
    },
  });

  console.log('✅ Order #15971 (problem order from investigation):');
  console.log('   Payment Status:', order15971?.paymentStatus);
  console.log('   Is On Hold:', order15971?.isOnHold);
  console.log('   Hold Reason:', order15971?.holdReason || 'NULL');
  console.log('   Hold Released At:', order15971?.holdReleasedAt?.toISOString() || 'NULL');
  console.log('   Hold Released By:', order15971?.holdReleasedBy || 'NULL');
  console.log('   JTL Outbound ID:', order15971?.jtlOutboundId || 'NULL');
  console.log('   Expected: paymentStatus=paid, isOnHold=false, holdReason=null\n');

  // 3. Check audit trail
  const auditEntries = await prisma.orderSyncLog.count({
    where: {
      action: 'update',
      targetPlatform: 'nolimits',
      createdAt: {
        gte: new Date(Date.now() - 10 * 60 * 1000), // Last 10 minutes
      },
    },
  });

  console.log('✅ Audit trail entries (last 10 minutes):', auditEntries);
  console.log('   Expected: 21 (one per updated order)\n');

  // 4. Check FFN sync queue
  const queuedOrders = await prisma.orderSyncQueue.count({
    where: {
      operation: 'sync_to_ffn',
      status: 'pending',
      payload: {
        path: ['reason'],
        equals: 'payment_hold_released_by_migration',
      },
    },
  });

  console.log('✅ Orders queued for FFN sync:', queuedOrders);
  console.log('   Expected: 12 (orders released from hold and not yet synced)\n');

  // 5. Get sample of updated orders
  const updatedOrders = await prisma.order.findMany({
    where: {
      clientId: CLIENT_ID,
      paymentStatus: 'paid',
      holdReleasedBy: 'SYSTEM_MIGRATION',
    },
    select: {
      orderNumber: true,
      paymentStatus: true,
      isOnHold: true,
      holdReleasedAt: true,
      jtlOutboundId: true,
    },
    take: 5,
  });

  console.log('✅ Sample of updated orders (showing 5):');
  updatedOrders.forEach((order) => {
    console.log(`   Order #${order.orderNumber}:`);
    console.log(`     Payment: ${order.paymentStatus}`);
    console.log(`     On Hold: ${order.isOnHold}`);
    console.log(`     Released: ${order.holdReleasedAt?.toISOString().split('T')[0]}`);
    console.log(`     FFN Synced: ${order.jtlOutboundId ? 'Yes' : 'No'}`);
  });

  console.log('\n' + '='.repeat(70));
  console.log('📊 VERIFICATION SUMMARY');
  console.log('='.repeat(70));

  const allChecks = [
    { name: 'Remaining payment holds', value: remainingHolds, expected: 0 },
    { name: 'Audit trail entries', value: auditEntries, expected: 21 },
    { name: 'Orders queued for FFN', value: queuedOrders, expected: 12 },
    { name: 'Order #15971 fixed', value: order15971?.paymentStatus === 'paid' && !order15971?.isOnHold, expected: true },
  ];

  let allPass = true;
  for (const check of allChecks) {
    const pass = check.value === check.expected;
    allPass = allPass && pass;
    console.log(`${pass ? '✅' : '❌'} ${check.name}: ${check.value} (expected: ${check.expected})`);
  }

  console.log('='.repeat(70));
  console.log(allPass ? '\n✅ All checks passed!' : '\n⚠️  Some checks failed - review above');

  await prisma.$disconnect();
  await pool.end();
}

verifyResults()
  .catch((error) => {
    console.error('❌ Verification failed:', error);
    process.exit(1);
  });
