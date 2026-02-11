/**
 * Diagnostic Script for Blocked Orders
 *
 * Identifies exact blocking reasons for 13 paid orders that haven't synced to JTL FFN.
 *
 * Checks:
 * - Payment hold status (isOnHold, holdReason)
 * - Order metadata (orderOrigin, fulfillmentState, totalAmount)
 * - FFN sync status (jtlFfnOrderId, ffnSyncError, syncStatus)
 * - Channel/Client associations
 * - Item validity (SKUs, quantities)
 *
 * Output: JSON report with detailed blocker analysis
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface OrderDiagnostic {
  orderNumber: string;
  orderId: string;
  customerName: string | null;
  blockers: string[];
  warnings: string[];
  metadata: {
    paymentStatus: string | null;
    isOnHold: boolean;
    holdReason: string | null;
    orderOrigin: string | null;
    fulfillmentState: string | null;
    totalAmount: string;
    itemCount: number;
    jtlFfnOrderId: string | null;
    syncStatus: string | null;
    ffnSyncError: string | null;
    channelType: string | null;
    clientId: string;
    hasJtlConfig: boolean;
  };
}

const ORDER_NUMBERS = [
  '15990', '15906', '15925', '15926', '15977',
  '15978', '15979', '15981', '15982', '15984',
  '15986', '15987', '15989'
];

async function diagnoseOrder(orderNumber: string): Promise<OrderDiagnostic> {
  console.log(`\n[DIAGNOSE] Checking order ${orderNumber}...`);

  const order = await prisma.order.findFirst({
    where: { orderNumber },
    include: {
      items: {
        include: {
          product: true
        }
      },
      channel: true,
      client: {
        include: {
          jtlConfig: true
        }
      }
    }
  });

  if (!order) {
    return {
      orderNumber,
      orderId: 'NOT_FOUND',
      customerName: null,
      blockers: ['Order not found in database'],
      warnings: [],
      metadata: {
        paymentStatus: null,
        isOnHold: false,
        holdReason: null,
        orderOrigin: null,
        fulfillmentState: null,
        totalAmount: '€0.00',
        itemCount: 0,
        jtlFfnOrderId: null,
        syncStatus: null,
        ffnSyncError: null,
        channelType: null,
        clientId: 'N/A',
        hasJtlConfig: false
      }
    };
  }

  const blockers: string[] = [];
  const warnings: string[] = [];

  // Check 1: Payment hold
  if (order.isOnHold) {
    if (order.holdReason === 'AWAITING_PAYMENT') {
      blockers.push(`Payment hold active - holdReason: ${order.holdReason}`);
      blockers.push(`Hold placed at: ${order.holdPlacedAt?.toISOString() || 'unknown'}`);
    } else {
      blockers.push(`Order on hold - reason: ${order.holdReason || 'unknown'}`);
    }
  }

  // Check 2: Payment status validation
  const allowedPaymentStatuses = ['paid', 'completed', 'processing', 'refunded', 'partially_refunded', 'authorized', 'partially_paid'];
  const paymentStatus = (order.paymentStatus || '').toLowerCase();

  if (!paymentStatus || !allowedPaymentStatuses.includes(paymentStatus)) {
    blockers.push(`Invalid payment status: "${order.paymentStatus || 'null'}" (not in allowed list)`);
  }

  // Check 3: Missing orderOrigin
  if (!order.orderOrigin || order.orderOrigin === 'N/A') {
    blockers.push('Missing orderOrigin (cannot determine platform)');

    // Try to determine from channel
    if (order.channel?.type) {
      warnings.push(`Can be fixed: Channel type is ${order.channel.type}`);
    } else {
      blockers.push('No channel associated - cannot determine platform');
    }
  }

  // Check 4: Check if already synced
  if (order.jtlOutboundId) {
    warnings.push(`Already synced - FFN Order ID: ${order.jtlOutboundId}`);
  }

  // Check 5: Stale sync error
  if (order.ffnSyncError) {
    warnings.push(`Previous sync error: ${order.ffnSyncError}`);
  }

  // Check 6: Client JTL config
  if (!order.client.jtlConfig || !order.client.jtlConfig.isActive) {
    blockers.push('No active JTL FFN configuration for client');
  }

  // Check 7: Order items validation
  if (!order.items || order.items.length === 0) {
    blockers.push('No order items found');
  } else {
    const itemsWithoutSKU = order.items.filter(item => !item.sku);
    if (itemsWithoutSKU.length > 0) {
      warnings.push(`${itemsWithoutSKU.length} items missing SKU`);
    }
  }

  // Check 8: Total amount
  const totalAmount = order.total ? parseFloat(order.total.toString()) : 0;
  if (totalAmount === 0) {
    warnings.push('Order total is €0.00 (may need recalculation)');
  }

  // Check 9: Fulfillment state
  if (!order.fulfillmentState) {
    warnings.push('Missing fulfillmentState');
  }

  // Check 10: Cancelled orders
  if (order.isCancelled) {
    blockers.push('Order is cancelled - should not sync to FFN');
  }

  console.log(`  ✓ Found order ${order.orderNumber} - ${blockers.length} blockers, ${warnings.length} warnings`);

  return {
    orderNumber: order.orderNumber || orderNumber,
    orderId: order.orderId,
    customerName: order.customerName,
    blockers,
    warnings,
    metadata: {
      paymentStatus: order.paymentStatus,
      isOnHold: order.isOnHold,
      holdReason: order.holdReason,
      orderOrigin: order.orderOrigin || null,
      fulfillmentState: order.fulfillmentState || null,
      totalAmount: totalAmount > 0 ? `€${totalAmount.toFixed(2)}` : '€0.00',
      itemCount: order.items?.length || 0,
      jtlFfnOrderId: order.jtlOutboundId,
      syncStatus: order.syncStatus,
      ffnSyncError: order.ffnSyncError,
      channelType: order.channel?.type || null,
      clientId: order.clientId,
      hasJtlConfig: !!(order.client.jtlConfig?.isActive)
    }
  };
}

async function main() {
  console.log('='.repeat(80));
  console.log('DIAGNOSTIC REPORT: Blocked Orders Analysis');
  console.log('='.repeat(80));
  console.log(`\nAnalyzing ${ORDER_NUMBERS.length} orders...\n`);

  const diagnostics: OrderDiagnostic[] = [];

  for (const orderNumber of ORDER_NUMBERS) {
    const diagnostic = await diagnoseOrder(orderNumber);
    diagnostics.push(diagnostic);
  }

  // Generate summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));

  const totalBlocked = diagnostics.filter(d => d.blockers.length > 0).length;
  const totalReady = diagnostics.filter(d => d.blockers.length === 0 && !d.metadata.jtlFfnOrderId).length;
  const alreadySynced = diagnostics.filter(d => d.metadata.jtlFfnOrderId).length;

  console.log(`Total orders analyzed: ${ORDER_NUMBERS.length}`);
  console.log(`Orders blocked from sync: ${totalBlocked}`);
  console.log(`Orders ready to sync: ${totalReady}`);
  console.log(`Orders already synced: ${alreadySynced}`);

  // Blocker breakdown
  console.log('\nCommon blockers:');
  const blockerCounts: Record<string, number> = {};
  diagnostics.forEach(d => {
    d.blockers.forEach(blocker => {
      const key = blocker.split(':')[0]; // Group similar blockers
      blockerCounts[key] = (blockerCounts[key] || 0) + 1;
    });
  });

  Object.entries(blockerCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([blocker, count]) => {
      console.log(`  - ${blocker}: ${count} orders`);
    });

  // Detailed report
  console.log('\n' + '='.repeat(80));
  console.log('DETAILED REPORT');
  console.log('='.repeat(80));

  diagnostics.forEach(d => {
    console.log(`\nOrder ${d.orderNumber} (${d.customerName || 'N/A'})`);
    console.log(`  Order ID: ${d.orderId}`);
    console.log(`  Status: ${d.metadata.paymentStatus || 'N/A'}`);
    console.log(`  Platform: ${d.metadata.orderOrigin || 'N/A'}`);
    console.log(`  Total: ${d.metadata.totalAmount}`);
    console.log(`  Items: ${d.metadata.itemCount}`);

    if (d.metadata.jtlFfnOrderId) {
      console.log(`  ✅ Already synced to FFN: ${d.metadata.jtlFfnOrderId}`);
    } else {
      console.log(`  ❌ Not synced to FFN`);
    }

    if (d.blockers.length > 0) {
      console.log(`  🚫 BLOCKERS (${d.blockers.length}):`);
      d.blockers.forEach(blocker => {
        console.log(`     - ${blocker}`);
      });
    }

    if (d.warnings.length > 0) {
      console.log(`  ⚠️  WARNINGS (${d.warnings.length}):`);
      d.warnings.forEach(warning => {
        console.log(`     - ${warning}`);
      });
    }
  });

  // Save to JSON file
  const reportPath = '/Users/teja/no_limits_v0/no_limits_all/backend/diagnostic-report.json';
  const fs = await import('fs/promises');
  await fs.writeFile(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: {
      totalOrders: ORDER_NUMBERS.length,
      blocked: totalBlocked,
      ready: totalReady,
      alreadySynced: alreadySynced
    },
    diagnostics
  }, null, 2));

  console.log(`\n✅ Diagnostic report saved to: ${reportPath}`);
}

main()
  .catch((error) => {
    console.error('❌ Diagnostic script failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
