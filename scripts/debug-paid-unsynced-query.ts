/**
 * Debug script: Why does pushPaidUnsyncedOrdersToFFN return 0 results?
 * Tests each filter condition individually against order #5482.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const SAFE_PAYMENT_STATUSES = [
  'paid', 'completed', 'processing', 'refunded',
  'partially_refunded', 'authorized', 'partially_paid',
];

async function main() {
  console.log('=== Debug: pushPaidUnsyncedOrdersToFFN returning 0 results ===\n');

  // 1. Find order #5482 — try orderNumber with and without '#'
  let order = await prisma.order.findFirst({
    where: { orderNumber: '#5482' },
    select: {
      id: true,
      orderId: true,
      orderNumber: true,
      jtlOutboundId: true,
      paymentStatus: true,
      isReplacement: true,
      isCancelled: true,
      isOnHold: true,
      holdReason: true,
      paymentHoldOverride: true,
      channelId: true,
      createdAt: true,
      channel: {
        select: { id: true, name: true, isActive: true, syncEnabled: true },
      },
    },
  });

  if (!order) {
    order = await prisma.order.findFirst({
      where: { orderNumber: '5482' },
      select: {
        id: true,
        orderId: true,
        orderNumber: true,
        jtlOutboundId: true,
        paymentStatus: true,
        isReplacement: true,
        isCancelled: true,
        isOnHold: true,
        holdReason: true,
        paymentHoldOverride: true,
        channelId: true,
        createdAt: true,
        channel: {
          select: { id: true, name: true, isActive: true, syncEnabled: true },
        },
      },
    });
  }

  if (!order) {
    // Last resort: search by orderId containing '5482'
    order = await prisma.order.findFirst({
      where: { orderId: { contains: '5482' } },
      select: {
        id: true,
        orderId: true,
        orderNumber: true,
        jtlOutboundId: true,
        paymentStatus: true,
        isReplacement: true,
        isCancelled: true,
        isOnHold: true,
        holdReason: true,
        paymentHoldOverride: true,
        channelId: true,
        createdAt: true,
        channel: {
          select: { id: true, name: true, isActive: true, syncEnabled: true },
        },
      },
    });
  }

  if (!order) {
    console.log('ERROR: Could not find order #5482 by any method');
    return;
  }

  console.log('ORDER #5482 FIELDS:');
  console.log(JSON.stringify(order, null, 2));

  // 2. Check each filter condition individually
  console.log('\n=== FILTER CONDITION CHECK ===');
  const checks = [
    { label: 'jtlOutboundId is null', pass: order.jtlOutboundId === null },
    { label: `paymentStatus "${order.paymentStatus}" in SAFE list`, pass: SAFE_PAYMENT_STATUSES.includes(order.paymentStatus ?? '') },
    { label: `isReplacement is false (got: ${order.isReplacement})`, pass: order.isReplacement === false },
    { label: `isCancelled is false (got: ${order.isCancelled})`, pass: order.isCancelled === false },
    { label: `isOnHold is false (got: ${order.isOnHold})`, pass: order.isOnHold === false },
    { label: `holdReason not in block list (got: "${order.holdReason}")`, pass: !['AWAITING_PAYMENT', 'SHIPPING_METHOD_MISMATCH'].includes(order.holdReason ?? '') },
    { label: `paymentHoldOverride (got: ${order.paymentHoldOverride})`, pass: order.paymentHoldOverride === true },
    { label: `channel.isActive (got: ${order.channel?.isActive})`, pass: order.channel?.isActive === true },
    { label: `channel.syncEnabled (got: ${order.channel?.syncEnabled})`, pass: order.channel?.syncEnabled === true },
  ];

  // OR group: at least one of isOnHold=false, holdReason not in block list, paymentHoldOverride=true
  const orGroupPass = checks[4].pass || checks[5].pass || checks[6].pass;

  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'} — ${c.label}`);
  }
  console.log(`  ${orGroupPass ? 'PASS' : 'FAIL'} — OR group (isOnHold=false OR holdReason OK OR paymentHoldOverride=true)`);

  const failingChecks = checks.filter(c => !c.pass);
  if (failingChecks.length > 0) {
    console.log('\n>>> FAILING CONDITIONS:');
    failingChecks.forEach(c => console.log(`    - ${c.label}`));
  } else if (!orGroupPass) {
    console.log('\n>>> FAILING: OR group — all three sub-conditions are false');
  } else {
    console.log('\n>>> All individual conditions PASS — order should be returned');
  }

  // 3. Run the exact query from pushPaidUnsyncedOrdersToFFN
  console.log('\n=== FULL QUERY (exact replica) ===');
  const unsyncedOrders = await prisma.order.findMany({
    where: {
      jtlOutboundId: null,
      paymentStatus: { in: SAFE_PAYMENT_STATUSES },
      isReplacement: false,
      isCancelled: false,
      OR: [
        { isOnHold: false },
        { holdReason: { notIn: ['AWAITING_PAYMENT', 'SHIPPING_METHOD_MISMATCH'] } },
        { paymentHoldOverride: true },
      ],
      channel: {
        isActive: true,
        syncEnabled: true,
      },
    },
    select: {
      id: true,
      orderId: true,
      orderNumber: true,
      paymentStatus: true,
      clientId: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  console.log(`Full query returned: ${unsyncedOrders.length} orders`);
  if (unsyncedOrders.length > 0) {
    console.log('Orders:', unsyncedOrders.map(o => `${o.orderNumber || o.orderId} (${o.paymentStatus})`));
  }

  const includes5482 = unsyncedOrders.some(o => o.id === order!.id);
  console.log(`Includes order #5482: ${includes5482}`);

  // 4. Try without channel filter to isolate
  console.log('\n=== WITHOUT CHANNEL FILTER ===');
  const withoutChannel = await prisma.order.findMany({
    where: {
      jtlOutboundId: null,
      paymentStatus: { in: SAFE_PAYMENT_STATUSES },
      isReplacement: false,
      isCancelled: false,
      OR: [
        { isOnHold: false },
        { holdReason: { notIn: ['AWAITING_PAYMENT', 'SHIPPING_METHOD_MISMATCH'] } },
        { paymentHoldOverride: true },
      ],
    },
    select: { id: true, orderNumber: true, channelId: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  console.log(`Without channel filter: ${withoutChannel.length} orders`);
  const filteredOut = withoutChannel.filter(o => !unsyncedOrders.find(u => u.id === o.id));
  if (filteredOut.length > 0) {
    console.log('Orders excluded by channel filter:', filteredOut.map(o => `${o.orderNumber} (channelId: ${o.channelId})`));
  }

  // 5. Try with ONLY jtlOutboundId: null to see total unsynced
  console.log('\n=== MINIMAL FILTER (just jtlOutboundId: null) ===');
  const minimalCount = await prisma.order.count({
    where: { jtlOutboundId: null },
  });
  console.log(`Orders with jtlOutboundId=null: ${minimalCount}`);

  // 6. Check all channels' sync settings
  console.log('\n=== ALL CHANNELS ===');
  const channels = await prisma.channel.findMany({
    select: { id: true, name: true, isActive: true, syncEnabled: true },
  });
  channels.forEach(ch => {
    console.log(`  ${ch.name}: isActive=${ch.isActive}, syncEnabled=${ch.syncEnabled}`);
  });

  await prisma.$disconnect();
  await pool.end();
}

main().catch(console.error);
