/**
 * Fix and Sync Orders to JTL FFN
 *
 * Fixes blocking issues for 13 paid orders and syncs them to JTL FFN.
 *
 * Operations:
 * 1. Fix missing orderOrigin from channel type
 * 2. Release payment holds (clear isOnHold, holdReason, ffnSyncError)
 * 3. Set fulfillmentState to PENDING if null
 * 4. Recalculate totalAmount if zero
 * 5. Sync to FFN using JTLOrderSyncService
 * 6. Monitor sync progress and capture results
 *
 * Safety: Idempotent - safe to run multiple times
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { JTLOrderSyncService } from '../src/services/integrations/jtl-order-sync.service.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const jtlOrderSyncService = new JTLOrderSyncService(prisma);

const ORDER_NUMBERS = [
  '15990', '15906', '15925', '15926', '15977',
  '15978', '15979', '15981', '15982', '15984',
  '15986', '15987', '15989'
];

interface SyncResult {
  orderNumber: string;
  orderId: string;
  customerName: string | null;
  preFixStatus: {
    isOnHold: boolean;
    holdReason: string | null;
    orderOrigin: string | null;
    fulfillmentState: string | null;
    totalAmount: number;
    jtlFfnOrderId: string | null;
    ffnSyncError: string | null;
  };
  actionsPerformed: string[];
  syncResult: {
    success: boolean;
    outboundId?: string;
    error?: string;
    syncTimeMs?: number;
    alreadyExisted?: boolean;
  };
  postFixStatus: {
    isOnHold: boolean;
    orderOrigin: string | null;
    fulfillmentState: string | null;
    totalAmount: number;
    jtlFfnOrderId: string | null;
    syncStatus: string | null;
  };
}

async function fixAndSyncOrder(orderNumber: string): Promise<SyncResult> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Processing order ${orderNumber}`);
  console.log('='.repeat(80));

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
    throw new Error(`Order ${orderNumber} not found`);
  }

  const actionsPerformed: string[] = [];
  const preFixStatus = {
    isOnHold: order.isOnHold,
    holdReason: order.holdReason,
    orderOrigin: order.orderOrigin,
    fulfillmentState: order.fulfillmentState,
    totalAmount: order.total ? parseFloat(order.total.toString()) : 0,
    jtlFfnOrderId: order.jtlOutboundId,
    ffnSyncError: order.ffnSyncError,
  };

  console.log(`\n[PRE-FIX STATUS]`);
  console.log(`  Customer: ${order.customerName || 'N/A'}`);
  console.log(`  Payment Status: ${order.paymentStatus || 'N/A'}`);
  console.log(`  On Hold: ${preFixStatus.isOnHold} ${preFixStatus.holdReason ? `(${preFixStatus.holdReason})` : ''}`);
  console.log(`  Order Origin: ${preFixStatus.orderOrigin || 'N/A'}`);
  console.log(`  Fulfillment State: ${preFixStatus.fulfillmentState || 'N/A'}`);
  console.log(`  Total: €${preFixStatus.totalAmount.toFixed(2)}`);
  console.log(`  FFN Order ID: ${preFixStatus.jtlFfnOrderId || 'Not synced'}`);
  if (preFixStatus.ffnSyncError) {
    console.log(`  Previous Error: ${preFixStatus.ffnSyncError}`);
  }

  // Action 1: Fix missing orderOrigin
  let orderOriginToSet: string | null = null;
  if (!order.orderOrigin || order.orderOrigin === 'N/A') {
    if (order.channel?.type) {
      orderOriginToSet = order.channel.type === 'SHOPIFY' ? 'SHOPIFY' :
                        order.channel.type === 'WOOCOMMERCE' ? 'WOOCOMMERCE' :
                        order.channel.type;
      actionsPerformed.push(`Set orderOrigin to ${orderOriginToSet} from channel type`);
      console.log(`\n[ACTION] Setting orderOrigin to ${orderOriginToSet}`);
    } else {
      console.log(`\n[WARNING] Cannot determine orderOrigin - no channel type`);
      orderOriginToSet = 'NOLIMITS'; // Fallback
      actionsPerformed.push(`Set orderOrigin to NOLIMITS (fallback - no channel)`);
    }
  }

  // Action 2: Fix zero total amount
  let totalAmountToSet: Prisma.Decimal | null = null;
  if (preFixStatus.totalAmount === 0 && order.items.length > 0) {
    const calculatedTotal = order.items.reduce((sum, item) => {
      const itemTotal = item.totalPrice ? parseFloat(item.totalPrice.toString()) : 0;
      return sum + itemTotal;
    }, 0);

    if (calculatedTotal > 0) {
      totalAmountToSet = new Prisma.Decimal(calculatedTotal);
      actionsPerformed.push(`Recalculated totalAmount: €${calculatedTotal.toFixed(2)}`);
      console.log(`\n[ACTION] Recalculating total amount: €${calculatedTotal.toFixed(2)}`);
    }
  }

  // Action 3: Release payment hold and clear errors
  const updateData: any = {
    updatedAt: new Date(),
  };

  if (order.isOnHold) {
    updateData.isOnHold = false;
    updateData.holdReason = null;
    updateData.holdReleasedAt = new Date();
    updateData.holdReleasedBy = 'SYSTEM';
    actionsPerformed.push('Released payment hold');
    console.log(`\n[ACTION] Releasing payment hold`);
  }

  if (order.ffnSyncError) {
    updateData.ffnSyncError = null;
    actionsPerformed.push('Cleared previous FFN sync error');
    console.log(`\n[ACTION] Clearing previous FFN sync error`);
  }

  if (orderOriginToSet) {
    updateData.orderOrigin = orderOriginToSet;
  }

  if (!order.fulfillmentState) {
    updateData.fulfillmentState = 'PENDING';
    actionsPerformed.push('Set fulfillmentState to PENDING');
    console.log(`\n[ACTION] Setting fulfillmentState to PENDING`);
  }

  if (totalAmountToSet) {
    updateData.total = totalAmountToSet;
  }

  // Apply fixes
  if (Object.keys(updateData).length > 1) { // More than just updatedAt
    console.log(`\n[APPLYING FIXES] Updating order in database...`);
    await prisma.order.update({
      where: { id: order.id },
      data: updateData
    });
    console.log(`  ✓ Fixes applied successfully`);
  } else {
    console.log(`\n[INFO] No fixes needed`);
  }

  // Action 4: Sync to FFN
  console.log(`\n[FFN SYNC] Syncing order to JTL FFN...`);
  const syncStartTime = Date.now();

  const syncResult = await jtlOrderSyncService.syncOrderToFFN(order.id);
  const syncTimeMs = Date.now() - syncStartTime;

  if (syncResult.success) {
    console.log(`  ✅ SUCCESS - FFN Order ID: ${syncResult.outboundId}`);
    console.log(`  ⏱️  Sync completed in ${syncTimeMs}ms`);
    actionsPerformed.push(`Synced to FFN (outboundId: ${syncResult.outboundId})`);

    if (syncResult.alreadyExisted) {
      console.log(`  ℹ️  Note: Order already existed in FFN, linked existing outbound`);
      actionsPerformed.push('Linked to existing FFN outbound');
    }
  } else {
    console.log(`  ❌ FAILED - ${syncResult.error}`);
    actionsPerformed.push(`FFN sync failed: ${syncResult.error}`);
  }

  // Fetch updated order for post-fix status
  const updatedOrder = await prisma.order.findUnique({
    where: { id: order.id },
    select: {
      isOnHold: true,
      orderOrigin: true,
      fulfillmentState: true,
      total: true,
      jtlOutboundId: true,
      syncStatus: true,
    }
  });

  const postFixStatus = {
    isOnHold: updatedOrder?.isOnHold || false,
    orderOrigin: updatedOrder?.orderOrigin || null,
    fulfillmentState: updatedOrder?.fulfillmentState || null,
    totalAmount: updatedOrder?.total ? parseFloat(updatedOrder.total.toString()) : 0,
    jtlFfnOrderId: updatedOrder?.jtlOutboundId || null,
    syncStatus: updatedOrder?.syncStatus || null,
  };

  console.log(`\n[POST-FIX STATUS]`);
  console.log(`  On Hold: ${postFixStatus.isOnHold}`);
  console.log(`  Order Origin: ${postFixStatus.orderOrigin || 'N/A'}`);
  console.log(`  Fulfillment State: ${postFixStatus.fulfillmentState || 'N/A'}`);
  console.log(`  Total: €${postFixStatus.totalAmount.toFixed(2)}`);
  console.log(`  FFN Order ID: ${postFixStatus.jtlFfnOrderId || 'Not synced'}`);
  console.log(`  Sync Status: ${postFixStatus.syncStatus || 'N/A'}`);

  return {
    orderNumber: order.orderNumber || orderNumber,
    orderId: order.orderId,
    customerName: order.customerName,
    preFixStatus,
    actionsPerformed,
    syncResult: {
      ...syncResult,
      syncTimeMs
    },
    postFixStatus
  };
}

async function main() {
  console.log('='.repeat(80));
  console.log('FIX AND SYNC ORDERS TO JTL FFN');
  console.log('='.repeat(80));
  console.log(`\nProcessing ${ORDER_NUMBERS.length} orders...\n`);

  const results: SyncResult[] = [];
  let successCount = 0;
  let failureCount = 0;
  let totalSyncTime = 0;

  for (const orderNumber of ORDER_NUMBERS) {
    try {
      const result = await fixAndSyncOrder(orderNumber);
      results.push(result);

      if (result.syncResult.success) {
        successCount++;
        totalSyncTime += result.syncResult.syncTimeMs || 0;
      } else {
        failureCount++;
      }

      // Small delay between orders to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`\n❌ Failed to process order ${orderNumber}:`, error);
      failureCount++;
    }
  }

  // Generate summary
  console.log('\n' + '='.repeat(80));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(80));
  console.log(`\nTotal orders processed: ${ORDER_NUMBERS.length}`);
  console.log(`✅ Successfully synced: ${successCount}`);
  console.log(`❌ Failed to sync: ${failureCount}`);

  if (successCount > 0) {
    const avgSyncTime = totalSyncTime / successCount;
    console.log(`⏱️  Average sync time: ${avgSyncTime.toFixed(0)}ms`);
  }

  // Save detailed results to JSON
  const resultsPath = '/Users/teja/no_limits_v0/no_limits_all/backend/sync-results.json';
  const fs = await import('fs/promises');
  await fs.writeFile(resultsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: {
      totalOrders: ORDER_NUMBERS.length,
      successfulSyncs: successCount,
      failedSyncs: failureCount,
      averageSyncTimeMs: successCount > 0 ? Math.round(totalSyncTime / successCount) : 0
    },
    results
  }, null, 2));

  console.log(`\n✅ Detailed results saved to: ${resultsPath}`);

  // Generate markdown report
  console.log('\n📄 Generating markdown report...');
  await generateMarkdownReport(results, successCount, failureCount, totalSyncTime);
}

async function generateMarkdownReport(
  results: SyncResult[],
  successCount: number,
  failureCount: number,
  totalSyncTime: number
) {
  const avgSyncTime = successCount > 0 ? (totalSyncTime / successCount).toFixed(0) : '0';

  const report = `# Order Sync Final Report

**Generated:** ${new Date().toISOString()}

---

## Executive Summary

This report documents the synchronization of 13 paid orders from the No-Limits database to JTL FFN (Fulfillment Network). These orders were previously blocked due to payment holds, missing metadata, and stale sync errors.

### Results

- **Total Orders Processed:** ${results.length}
- **Successfully Synced:** ${successCount} ✅
- **Failed to Sync:** ${failureCount} ❌
- **Average Sync Time:** ${avgSyncTime}ms

---

## Status Overview Table

| Order # | Customer | Pre-Fix Status | Post-Fix Status | FFN Order ID | Sync Time | Result |
|---------|----------|----------------|-----------------|--------------|-----------|--------|
${results.map(r => {
  const preStatus = r.preFixStatus.isOnHold ? 'On Hold' :
                   r.preFixStatus.jtlFfnOrderId ? 'Already Synced' :
                   'Ready';
  const postStatus = r.syncResult.success ? 'Synced' : 'Failed';
  const ffnId = r.postFixStatus.jtlFfnOrderId || 'N/A';
  const syncTime = r.syncResult.syncTimeMs ? `${r.syncResult.syncTimeMs}ms` : 'N/A';
  const result = r.syncResult.success ? '✅' : '❌';

  return `| ${r.orderNumber} | ${r.customerName || 'N/A'} | ${preStatus} | ${postStatus} | ${ffnId} | ${syncTime} | ${result} |`;
}).join('\n')}

---

## Detailed Order Breakdown

${results.map(r => `
### Order ${r.orderNumber} - ${r.customerName || 'N/A'}

**Order ID:** \`${r.orderId}\`

#### Pre-Fix Status
- **Payment Hold:** ${r.preFixStatus.isOnHold ? `Yes (${r.preFixStatus.holdReason})` : 'No'}
- **Order Origin:** ${r.preFixStatus.orderOrigin || 'N/A'}
- **Fulfillment State:** ${r.preFixStatus.fulfillmentState || 'N/A'}
- **Total Amount:** €${r.preFixStatus.totalAmount.toFixed(2)}
- **FFN Order ID:** ${r.preFixStatus.jtlFfnOrderId || 'Not synced'}
- **Previous Error:** ${r.preFixStatus.ffnSyncError || 'None'}

#### Actions Performed
${r.actionsPerformed.map(action => `- ${action}`).join('\n')}

#### Sync Result
- **Success:** ${r.syncResult.success ? 'Yes ✅' : 'No ❌'}
- **FFN Outbound ID:** ${r.syncResult.outboundId || 'N/A'}
- **Sync Time:** ${r.syncResult.syncTimeMs}ms
${r.syncResult.error ? `- **Error:** ${r.syncResult.error}` : ''}
${r.syncResult.alreadyExisted ? '- **Note:** Order already existed in FFN, linked existing outbound' : ''}

#### Post-Fix Status
- **Payment Hold:** ${r.postFixStatus.isOnHold ? 'Yes' : 'No'}
- **Order Origin:** ${r.postFixStatus.orderOrigin || 'N/A'}
- **Fulfillment State:** ${r.postFixStatus.fulfillmentState || 'N/A'}
- **Total Amount:** €${r.postFixStatus.totalAmount.toFixed(2)}
- **FFN Order ID:** ${r.postFixStatus.jtlFfnOrderId || 'Not synced'}
- **Sync Status:** ${r.postFixStatus.syncStatus || 'N/A'}

---
`).join('\n')}

## Issues Encountered

${failureCount > 0 ? `
### Failed Syncs (${failureCount})

${results.filter(r => !r.syncResult.success).map(r => `
#### Order ${r.orderNumber}
- **Customer:** ${r.customerName || 'N/A'}
- **Error:** ${r.syncResult.error || 'Unknown error'}
- **Recommendation:** ${getRecommendation(r)}
`).join('\n')}
` : '**No failed syncs!** All orders successfully synced to JTL FFN. ✅'}

---

## Root Causes Identified

Based on the diagnostic analysis, the following issues were preventing order sync:

1. **Payment Holds:** Orders had \`isOnHold = true\` with \`holdReason = 'AWAITING_PAYMENT'\`, despite having \`paymentStatus = 'paid'\`
2. **Missing Metadata:** Orders were missing \`orderOrigin\` field (showing as "N/A")
3. **Stale Errors:** Previous \`ffnSyncError\` messages were blocking retry attempts
4. **Zero Totals:** Some orders had \`totalAmount = €0.00\` requiring recalculation from items

---

## Actions Taken

### 1. Released Payment Holds
- Cleared \`isOnHold\` flag
- Removed \`holdReason\`
- Set \`holdReleasedAt\` timestamp
- Set \`holdReleasedBy = 'SYSTEM'\`

### 2. Fixed Missing Metadata
- Populated \`orderOrigin\` from channel type (SHOPIFY/WOOCOMMERCE)
- Set \`fulfillmentState = 'PENDING'\` where missing
- Recalculated \`totalAmount\` from order items where zero

### 3. Cleared Sync Errors
- Removed stale \`ffnSyncError\` messages to enable retry

### 4. Synced to FFN
- Called \`JTLOrderSyncService.syncOrderToFFN()\` for each order
- Created outbound orders in JTL FFN warehouse system
- Captured \`jtlFfnOrderId\` (outbound ID) for tracking

---

## Verification

### Database Verification Query
\`\`\`sql
SELECT orderNumber, customerName, jtlOutboundId, syncStatus, ffnSyncError
FROM "Order"
WHERE "orderNumber" IN ('15990', '15906', '15925', '15926', '15977',
                        '15978', '15979', '15981', '15982', '15984',
                        '15986', '15987', '15989');
\`\`\`

**Expected Result:** All orders should have \`jtlOutboundId != null\` and \`syncStatus = 'SYNCED'\`

---

## Next Steps

${failureCount > 0 ? `
1. **Review Failed Orders:** Investigate the ${failureCount} orders that failed to sync
2. **Manual Intervention:** Check JTL FFN dashboard for any manual fixes needed
3. **Rerun Script:** This script is idempotent and can be safely rerun for failed orders
` : `
1. **Monitor FFN Dashboard:** Verify all orders appear in JTL FFN warehouse system
2. **Check Fulfillment Progress:** Orders should transition through pick/pack/ship stages
3. **Track Shipping:** Wait for tracking numbers to be assigned by warehouse
`}

---

## Script Details

- **Script:** \`backend/scripts/fix-and-sync-orders.ts\`
- **Service Used:** \`JTLOrderSyncService\`
- **Safety:** Idempotent - safe to run multiple times
- **Rollback:** Orders remain in paid state, no destructive operations performed

---

**Report End**

🤖 Generated by No-Limits Order Sync Automation
`;

  const reportPath = '/Users/teja/no_limits_v0/no_limits_all/backend/ORDER_SYNC_FINAL_REPORT.md';
  const fs = await import('fs/promises');
  await fs.writeFile(reportPath, report);

  console.log(`  ✅ Markdown report saved to: ${reportPath}`);
}

function getRecommendation(result: SyncResult): string {
  if (result.syncResult.error?.includes('JTL not configured')) {
    return 'Check JTL FFN credentials and configuration in client settings';
  }
  if (result.syncResult.error?.includes('payment')) {
    return 'Manually verify payment status with payment provider';
  }
  if (result.syncResult.error?.includes('not found')) {
    return 'Order may have been deleted - check database consistency';
  }
  return 'Review error message and check JTL FFN API logs';
}

main()
  .catch((error) => {
    console.error('❌ Fix and sync script failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
