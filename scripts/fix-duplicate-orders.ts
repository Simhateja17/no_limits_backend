/**
 * Cleanup Script: Remove Duplicate Orders
 *
 * Finds duplicate orders with the same (channel_id, external_order_id) and removes
 * the lesser copy, keeping the "best" row based on:
 *   1. Has jtlOutboundId (already synced to FFN — must keep)
 *   2. Oldest createdAt (the original order)
 *
 * Usage:
 *   npx tsx backend/scripts/fix-duplicate-orders.ts            # dry-run (report only)
 *   npx tsx backend/scripts/fix-duplicate-orders.ts --execute   # actually delete duplicates
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// Initialize Prisma with pg adapter (Prisma 7 requirement)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const isDryRun = !process.argv.includes('--execute');

interface DuplicateGroup {
  channel_id: string;
  external_order_id: string;
  count: bigint;
}

async function main() {
  console.log('==========================================================');
  console.log('  DUPLICATE ORDER CLEANUP');
  console.log(`  Mode: ${isDryRun ? 'DRY-RUN (no changes will be made)' : '⚠️  EXECUTE — duplicates will be deleted'}`);
  console.log('==========================================================\n');

  // ─── Step 1: Find all duplicate (channel_id, external_order_id) groups ───
  console.log('[1] Searching for duplicate order groups...\n');

  const duplicateGroups = await prisma.$queryRaw<DuplicateGroup[]>`
    SELECT channel_id, "externalOrderId" as external_order_id, COUNT(*) as count
    FROM orders
    WHERE channel_id IS NOT NULL
      AND "externalOrderId" IS NOT NULL
      AND "isReplacement" = false
    GROUP BY channel_id, "externalOrderId"
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `;

  if (duplicateGroups.length === 0) {
    console.log('No duplicate orders found. Database is clean.');
    return;
  }

  console.log(`Found ${duplicateGroups.length} duplicate group(s):\n`);

  let totalToDelete = 0;
  const deletionPlan: { keep: string; remove: string[] }[] = [];

  // ─── Step 2: For each group, decide which to keep and which to delete ───
  for (const group of duplicateGroups) {
    const orders = await prisma.order.findMany({
      where: {
        channelId: group.channel_id,
        externalOrderId: group.external_order_id,
        isReplacement: false,
      },
      select: {
        id: true,
        orderId: true,
        orderNumber: true,
        externalOrderId: true,
        jtlOutboundId: true,
        syncStatus: true,
        paymentStatus: true,
        status: true,
        fulfillmentState: true,
        createdAt: true,
        updatedAt: true,
        clientId: true,
        channelId: true,
        channel: { select: { name: true, type: true } },
        _count: {
          select: {
            items: true,
            syncLogs: true,
            returns: true,
          },
        },
      },
      orderBy: [
        // Sort so the "best" order is first:
        // 1. Orders with jtlOutboundId come first (synced to FFN)
        // 2. Then oldest createdAt (the original)
        { createdAt: 'asc' },
      ],
    });

    // Pick the best: prefer one with jtlOutboundId, then oldest
    const sorted = [...orders].sort((a, b) => {
      // Has jtlOutboundId wins
      const aHasJtl = a.jtlOutboundId ? 1 : 0;
      const bHasJtl = b.jtlOutboundId ? 1 : 0;
      if (bHasJtl !== aHasJtl) return bHasJtl - aHasJtl;
      // Oldest wins
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    const keep = sorted[0];
    const remove = sorted.slice(1);

    console.log(`──────────────────────────────────────────────────`);
    console.log(`  Duplicate Group: externalOrderId=${group.external_order_id}`);
    console.log(`  Channel: ${keep.channel?.name || keep.channelId} (${keep.channel?.type || 'unknown'})`);
    console.log(`  Client: ${keep.clientId}`);
    console.log(`  Count: ${Number(group.count)} orders`);
    console.log('');

    console.log(`  KEEP:   [${keep.id}]`);
    console.log(`          orderNumber=#${keep.orderNumber || 'N/A'} | orderId=${keep.orderId}`);
    console.log(`          jtlOutboundId=${keep.jtlOutboundId || 'NULL'} | syncStatus=${keep.syncStatus}`);
    console.log(`          payment=${keep.paymentStatus || 'NULL'} | status=${keep.status} | fulfillment=${keep.fulfillmentState}`);
    console.log(`          created=${keep.createdAt.toISOString()} | updated=${keep.updatedAt.toISOString()}`);
    console.log(`          items=${keep._count.items} | syncLogs=${keep._count.syncLogs} | returns=${keep._count.returns}`);
    console.log('');

    for (const dup of remove) {
      console.log(`  DELETE: [${dup.id}]`);
      console.log(`          orderNumber=#${dup.orderNumber || 'N/A'} | orderId=${dup.orderId}`);
      console.log(`          jtlOutboundId=${dup.jtlOutboundId || 'NULL'} | syncStatus=${dup.syncStatus}`);
      console.log(`          payment=${dup.paymentStatus || 'NULL'} | status=${dup.status} | fulfillment=${dup.fulfillmentState}`);
      console.log(`          created=${dup.createdAt.toISOString()} | updated=${dup.updatedAt.toISOString()}`);
      console.log(`          items=${dup._count.items} | syncLogs=${dup._count.syncLogs} | returns=${dup._count.returns}`);

      if (dup.jtlOutboundId) {
        console.log(`          ⚠️  WARNING: This duplicate has a jtlOutboundId — review manually!`);
      }
      if (dup._count.returns > 0) {
        console.log(`          ⚠️  WARNING: This duplicate has returns — review manually!`);
      }
    }
    console.log('');

    totalToDelete += remove.length;
    deletionPlan.push({ keep: keep.id, remove: remove.map((r) => r.id) });
  }

  console.log('══════════════════════════════════════════════════');
  console.log(`  SUMMARY: ${deletionPlan.length} group(s), ${totalToDelete} order(s) to delete`);
  console.log('══════════════════════════════════════════════════\n');

  // ─── Step 3: Execute deletions if --execute flag is set ───
  if (isDryRun) {
    console.log('DRY-RUN complete. Re-run with --execute to delete duplicates.');
    return;
  }

  console.log('Executing deletions...\n');

  let deletedCount = 0;
  let errorCount = 0;

  for (const plan of deletionPlan) {
    for (const orderId of plan.remove) {
      try {
        await prisma.$transaction(async (tx) => {
          // Delete child records first (foreign key constraints)
          await tx.orderItem.deleteMany({ where: { orderId } });
          await tx.orderSyncLog.deleteMany({ where: { orderId } });
          await tx.orderSyncQueue.deleteMany({ where: { orderId } });
          await tx.shippingMethodMismatch.deleteMany({ where: { orderId } });
          await tx.notification.deleteMany({ where: { orderId } });
          // Delete the order itself
          await tx.order.delete({ where: { id: orderId } });
        });
        console.log(`  Deleted order ${orderId}`);
        deletedCount++;
      } catch (err: any) {
        console.error(`  FAILED to delete order ${orderId}: ${err.message}`);
        errorCount++;
      }
    }
  }

  console.log(`\nDone. Deleted ${deletedCount} order(s). Errors: ${errorCount}.`);
}

main()
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
