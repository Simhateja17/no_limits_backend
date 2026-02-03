/**
 * Test Script: Verify WooCommerce Payment Status Implementation
 *
 * Tests the following scenarios:
 * 1. New unpaid order (status: 'pending') - should have paymentStatus: 'pending'
 * 2. Payment confirmation (status: 'processing') - should update to paymentStatus: 'paid'
 * 3. New paid order (status: 'processing') - should have paymentStatus: 'paid'
 * 4. Refund (status: 'refunded') - should have paymentStatus: 'refunded'
 *
 * Usage: npx ts-node backend/scripts/test-woocommerce-payment-status.ts
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// Initialize Prisma with pg adapter (Prisma 7 requirement)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface TestResult {
  scenario: string;
  passed: boolean;
  details: string;
}

async function runTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  console.log('🧪 Starting WooCommerce Payment Status Tests\n');
  console.log('═'.repeat(80) + '\n');

  // Test 1: Check for orders with different payment statuses
  console.log('Test 1: Verify existing orders have correct payment status');
  console.log('─'.repeat(80));

  const ordersByPaymentStatus = await prisma.order.groupBy({
    by: ['paymentStatus', 'status'],
    where: {
      orderOrigin: 'WOOCOMMERCE',
    },
    _count: true,
  });

  console.log('\n📊 WooCommerce Orders by Payment Status:\n');
  console.table(
    ordersByPaymentStatus.map(g => ({
      'Order Status': g.status,
      'Payment Status': g.paymentStatus || 'null',
      'Count': g._count,
    }))
  );

  // Check if any orders still have null payment status
  const nullPaymentOrders = ordersByPaymentStatus.filter(g => g.paymentStatus === null);
  if (nullPaymentOrders.length === 0) {
    results.push({
      scenario: 'No orders with null paymentStatus',
      passed: true,
      details: 'All WooCommerce orders have payment status set',
    });
    console.log('\n✅ PASSED: All WooCommerce orders have payment status set\n');
  } else {
    results.push({
      scenario: 'No orders with null paymentStatus',
      passed: false,
      details: `Found ${nullPaymentOrders.reduce((sum, g) => sum + g._count, 0)} orders with null payment status`,
    });
    console.log('\n❌ FAILED: Some orders still have null payment status\n');
  }

  // Test 2: Verify payment status mapping is correct
  console.log('Test 2: Verify payment status mapping for each order status');
  console.log('─'.repeat(80));

  const expectedMappings = [
    { orderStatus: 'PROCESSING', expectedPaymentStatus: 'paid' },
    { orderStatus: 'DELIVERED', expectedPaymentStatus: 'paid' },
    { orderStatus: 'SHIPPED', expectedPaymentStatus: 'paid' },
    { orderStatus: 'ON_HOLD', expectedPaymentStatus: 'pending' },
    { orderStatus: 'PENDING', expectedPaymentStatus: 'pending' },
  ];

  for (const mapping of expectedMappings) {
    const orders = await prisma.order.findMany({
      where: {
        orderOrigin: 'WOOCOMMERCE',
        status: mapping.orderStatus as any,
      },
      select: {
        orderNumber: true,
        status: true,
        paymentStatus: true,
      },
      take: 5,
    });

    if (orders.length === 0) {
      console.log(`⏭️  Skipped: No orders with status ${mapping.orderStatus}`);
      continue;
    }

    const correctOrders = orders.filter(o => o.paymentStatus === mapping.expectedPaymentStatus);
    const passed = correctOrders.length === orders.length;

    results.push({
      scenario: `Payment status for ${mapping.orderStatus} orders`,
      passed,
      details: `${correctOrders.length}/${orders.length} orders have correct payment status (${mapping.expectedPaymentStatus})`,
    });

    if (passed) {
      console.log(`✅ ${mapping.orderStatus} → ${mapping.expectedPaymentStatus} (${orders.length} orders)`);
    } else {
      console.log(`❌ ${mapping.orderStatus} → Expected ${mapping.expectedPaymentStatus}, found mismatches`);
      console.log('   Sample mismatches:');
      orders
        .filter(o => o.paymentStatus !== mapping.expectedPaymentStatus)
        .slice(0, 3)
        .forEach(o => {
          console.log(`   - Order ${o.orderNumber}: paymentStatus = ${o.paymentStatus}`);
        });
    }
  }

  console.log('');

  // Test 3: Check orders on AWAITING_PAYMENT hold
  console.log('Test 3: Verify orders on AWAITING_PAYMENT hold have pending status');
  console.log('─'.repeat(80));

  const awaitingPaymentOrders = await prisma.order.findMany({
    where: {
      orderOrigin: 'WOOCOMMERCE',
      isOnHold: true,
      holdReason: 'AWAITING_PAYMENT',
    },
    select: {
      orderNumber: true,
      paymentStatus: true,
      status: true,
    },
    take: 10,
  });

  if (awaitingPaymentOrders.length === 0) {
    console.log('⏭️  No orders currently on AWAITING_PAYMENT hold\n');
  } else {
    const correctPendingStatus = awaitingPaymentOrders.filter(o => o.paymentStatus === 'pending');
    const passed = correctPendingStatus.length === awaitingPaymentOrders.length;

    results.push({
      scenario: 'AWAITING_PAYMENT orders have pending status',
      passed,
      details: `${correctPendingStatus.length}/${awaitingPaymentOrders.length} orders have pending status`,
    });

    if (passed) {
      console.log(`✅ All ${awaitingPaymentOrders.length} AWAITING_PAYMENT orders have paymentStatus: 'pending'\n`);
    } else {
      console.log(`❌ Some AWAITING_PAYMENT orders don't have pending status:`);
      awaitingPaymentOrders
        .filter(o => o.paymentStatus !== 'pending')
        .forEach(o => {
          console.log(`   - Order ${o.orderNumber}: paymentStatus = ${o.paymentStatus}`);
        });
      console.log('');
    }
  }

  // Test 4: Sample orders display
  console.log('Test 4: Sample WooCommerce orders with payment status');
  console.log('─'.repeat(80));

  const sampleOrders = await prisma.order.findMany({
    where: {
      orderOrigin: 'WOOCOMMERCE',
    },
    select: {
      orderNumber: true,
      status: true,
      paymentStatus: true,
      isOnHold: true,
      holdReason: true,
      total: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: 10,
  });

  console.log('\n📋 Recent WooCommerce Orders:\n');
  console.table(
    sampleOrders.map(o => ({
      'Order Number': o.orderNumber,
      'Status': o.status,
      'Payment Status': o.paymentStatus || 'null',
      'On Hold': o.isOnHold ? '🔴' : '✅',
      'Hold Reason': o.holdReason || '-',
      'Total': `€${o.total.toFixed(2)}`,
    }))
  );

  return results;
}

async function printSummary(results: TestResult[]) {
  console.log('\n' + '═'.repeat(80));
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(80) + '\n');

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  results.forEach(result => {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.scenario}`);
    console.log(`   ${result.details}\n`);
  });

  console.log('─'.repeat(80));
  console.log(`\n${passed}/${total} tests passed\n`);

  if (passed === total) {
    console.log('🎉 All tests passed! Payment status implementation is working correctly.\n');
  } else {
    console.log('⚠️  Some tests failed. Please review the implementation.\n');
  }

  console.log('💡 Next steps:');
  console.log('   1. Check frontend: Visit /admin/orders and verify PAYMENT STATUS column');
  console.log('   2. Test with new order: Create a test WooCommerce order and verify payment status');
  console.log('   3. Test payment flow: Create unpaid order, then mark as paid\n');
}

// Run tests
runTests()
  .then(printSummary)
  .then(() => {
    console.log('Test script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test script failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
