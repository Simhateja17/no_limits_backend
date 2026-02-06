/**
 * Investigation script for Order #15971 (DB ID: cmla1gmje02f5mhquowypqnfq)
 *
 * This order has paymentStatus "Unpaid" but was synced to JTL FFN (Outbound: 6EN702XKNLCFFGD5).
 * The script builds a chronological timeline to identify HOW the unpaid order reached fulfillment.
 *
 * Approaches:
 * A) Check OrderSyncLog origin field for the create action
 * B) Check if order was ever on payment hold (holdPlacedAt / holdReleasedAt)
 * C) Timestamp correlation between order creation, sync log, and FFN outbound
 * D) Check channel type (WooCommerce vs Shopify)
 * E) Find other affected orders (unpaid but synced to FFN)
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { getEncryptionService } from '../src/services/encryption.service.js';
import JTLService from '../src/services/integrations/jtl.service.js';
import 'dotenv/config';

// Initialize Prisma with pg adapter (Prisma 7 requirement)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TARGET_ORDER_ID = 'cmla1gmje02f5mhquowypqnfq';
const TARGET_OUTBOUND_ID = '6EN702XKNLCFFGD5';

async function main() {
  console.log('==========================================================');
  console.log('INVESTIGATION: Unpaid Order #15971 Pushed to JTL FFN');
  console.log('==========================================================\n');

  try {
    // ─── Step 1: Query order from database ───
    console.log('[1] Fetching order from database...');
    const order = await prisma.order.findUnique({
      where: { id: TARGET_ORDER_ID },
      include: {
        channel: { select: { id: true, type: true, name: true, shopDomain: true, url: true } },
        items: { select: { id: true, sku: true, productName: true, quantity: true } },
      },
    });

    if (!order) {
      console.error('❌ Order not found in database!');
      return;
    }

    console.log('✅ Order found in database:');
    console.log(`   Order Number:       ${order.orderNumber}`);
    console.log(`   Order ID (internal):${order.orderId}`);
    console.log(`   DB ID:              ${order.id}`);
    console.log(`   Payment Status:     ${order.paymentStatus || 'NULL'}`);
    console.log(`   Is On Hold:         ${order.isOnHold}`);
    console.log(`   Hold Reason:        ${order.holdReason || 'NULL'}`);
    console.log(`   Hold Placed At:     ${order.holdPlacedAt?.toISOString() || 'NULL'}`);
    console.log(`   Hold Placed By:     ${order.holdPlacedBy || 'NULL'}`);
    console.log(`   Hold Released At:   ${order.holdReleasedAt?.toISOString() || 'NULL'}`);
    console.log(`   Hold Released By:   ${order.holdReleasedBy || 'NULL'}`);
    console.log(`   Is Cancelled:       ${order.isCancelled}`);
    console.log(`   Status:             ${order.status}`);
    console.log(`   Fulfillment State:  ${order.fulfillmentState}`);
    console.log(`   Sync Status:        ${order.syncStatus}`);
    console.log(`   JTL Outbound ID:    ${order.jtlOutboundId || 'NULL'}`);
    console.log(`   Order Origin:       ${order.orderOrigin || 'NULL'}`);
    console.log(`   Created At:         ${order.createdAt.toISOString()}`);
    console.log(`   Updated At:         ${order.updatedAt.toISOString()}`);
    console.log(`   Last JTL Sync:      ${order.lastJtlSync?.toISOString() || 'NULL'}`);
    console.log(`   Channel Type:       ${order.channel?.type || 'NULL'}`);
    console.log(`   Channel Name:       ${order.channel?.name || 'NULL'}`);
    console.log(`   Items:              ${order.items.length}`);
    order.items.forEach((item, i) => {
      console.log(`     ${i + 1}. ${item.sku} — ${item.productName} (qty: ${item.quantity})`);
    });
    console.log('');

    // ─── Step 2: Query OrderSyncLog for this order ───
    console.log('[2] Fetching sync logs for this order...');
    const syncLogs = await prisma.orderSyncLog.findMany({
      where: { orderId: TARGET_ORDER_ID },
      orderBy: { createdAt: 'asc' },
    });

    if (syncLogs.length === 0) {
      console.log('⚠️  No sync logs found for this order');
    } else {
      console.log(`✅ Found ${syncLogs.length} sync log entries:`);
      syncLogs.forEach((log, i) => {
        console.log(`   ${i + 1}. [${log.createdAt.toISOString()}] action=${log.action} origin=${log.origin} target=${log.targetPlatform} success=${log.success} externalId=${log.externalId || 'NULL'}`);
        if (log.errorMessage) {
          console.log(`      Error: ${log.errorMessage}`);
        }
        if (log.changedFields && (log.changedFields as string[]).length > 0) {
          console.log(`      Changed: ${(log.changedFields as string[]).join(', ')}`);
        }
      });
    }
    console.log('');

    // ─── Approach A: Identify the culprit sync log entry ───
    console.log('[Approach A] Identifying the FFN create sync...');
    const createLog = syncLogs.find(
      (l) => l.action === 'create' && l.targetPlatform === 'jtl' && l.success
    );
    if (createLog) {
      console.log(`   ✅ Found FFN create log:`);
      console.log(`      Timestamp: ${createLog.createdAt.toISOString()}`);
      console.log(`      Origin:    ${createLog.origin}`);
      console.log(`      External:  ${createLog.externalId}`);
    } else {
      console.log('   ⚠️  No successful FFN create log found — order may have been linked via reconciliation');
    }
    console.log('');

    // ─── Approach B: Check payment hold history ───
    console.log('[Approach B] Analyzing payment hold history...');
    if (!order.holdPlacedAt) {
      console.log('   🚨 holdPlacedAt is NULL — order was NEVER placed on payment hold!');
      console.log('   → This means the order was created through a path that SKIPS payment holds');
      console.log('   → Prime suspects: webhook-processor.service.ts (WooCommerce) or reconciliation');
    } else {
      console.log(`   Hold was placed at: ${order.holdPlacedAt.toISOString()} by ${order.holdPlacedBy}`);
      if (order.holdReleasedAt) {
        console.log(`   Hold was released at: ${order.holdReleasedAt.toISOString()} by ${order.holdReleasedBy}`);
        console.log('   → Hold was released — check if released BEFORE payment was confirmed');
      } else {
        console.log('   → Hold was placed but NEVER released — yet order was synced?');
        console.log('   → This means a code path bypassed the hold check');
      }
    }
    console.log('');

    // ─── Approach C: Timestamp correlation ───
    console.log('[Approach C] Timestamp correlation...');
    const orderCreatedAt = order.createdAt.getTime();
    const syncLogCreatedAt = createLog?.createdAt.getTime();
    if (syncLogCreatedAt) {
      const gapMs = syncLogCreatedAt - orderCreatedAt;
      const gapSec = gapMs / 1000;
      const gapMin = gapSec / 60;
      console.log(`   Order created → FFN sync: ${gapSec.toFixed(1)}s (${gapMin.toFixed(1)} min)`);
      if (gapSec < 5) {
        console.log('   → Milliseconds/seconds apart = AUTOMATIC sync (webhook processor or initial sync pipeline)');
      } else if (gapMin < 5) {
        console.log('   → Minutes apart = likely queued sync (webhook → queue → worker)');
      } else {
        console.log('   → Significant gap = manual sync, orphaned orders push, or reconciliation');
      }
    }
    console.log('');

    // ─── Approach D: Check channel type ───
    console.log('[Approach D] Channel type analysis...');
    if (order.channel?.type === 'WOOCOMMERCE') {
      console.log('   🎯 Channel is WOOCOMMERCE');
      console.log('   → webhook-processor.service.ts creates WooCommerce orders with NO payment hold');
      console.log('   → It calls queueJTLOrderSync() immediately after creation with NO payment check');
      console.log('   → This is the most likely culprit for unpaid WooCommerce orders');
    } else if (order.channel?.type === 'SHOPIFY') {
      console.log('   Channel is SHOPIFY');
      console.log('   → Enhanced webhook (sync-orchestrator) has proper payment hold logic');
      console.log('   → Check if order came through old webhook-processor.service.ts instead');
    } else {
      console.log(`   Channel type: ${order.channel?.type || 'UNKNOWN'}`);
    }
    console.log('');

    // ─── Step 3: Query JTL FFN API ───
    console.log('[3] Querying JTL FFN API for outbound details...');
    const jtlConfig = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: order.clientId },
    });

    if (!jtlConfig || !jtlConfig.accessToken) {
      console.log('⚠️  No JTL configuration found — skipping FFN API query');
    } else {
      const encryptionService = getEncryptionService();
      const jtlService = new JTLService({
        clientId: jtlConfig.clientId,
        clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
        environment: (jtlConfig.environment || 'sandbox') as 'sandbox' | 'production',
        accessToken: encryptionService.safeDecrypt(jtlConfig.accessToken),
        refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
        tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
        warehouseId: jtlConfig.warehouseId || undefined,
        fulfillerId: jtlConfig.fulfillerId || undefined,
      }, prisma, order.clientId);

      try {
        const outbound = await jtlService.getOutbound(TARGET_OUTBOUND_ID);
        console.log('✅ FFN Outbound found:');
        console.log(`   Outbound ID:              ${(outbound as any).outboundId}`);
        console.log(`   Status:                   ${outbound.status}`);
        console.log(`   Merchant Outbound Number: ${(outbound as any).merchantOutboundNumber}`);
        console.log(`   Created At:               ${outbound.createdAt}`);
        console.log(`   Full response:`);
        console.log(JSON.stringify(outbound, null, 2));
      } catch (err: any) {
        console.error(`❌ Failed to fetch outbound from FFN: ${err.message}`);
      }
    }
    console.log('');

    // ─── Approach E: Find other affected orders ───
    console.log('[Approach E] Searching for OTHER unpaid orders synced to FFN...');
    const affectedOrders = await prisma.order.findMany({
      where: {
        jtlOutboundId: { not: null },
        paymentStatus: { notIn: ['paid', 'completed', 'processing', 'refunded', 'partially_refunded', 'authorized', 'partially_paid'] },
      },
      select: {
        id: true,
        orderNumber: true,
        paymentStatus: true,
        jtlOutboundId: true,
        isOnHold: true,
        holdReason: true,
        createdAt: true,
        orderOrigin: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    if (affectedOrders.length === 0) {
      console.log('   ✅ No other unpaid orders found synced to FFN');
    } else {
      console.log(`   🚨 Found ${affectedOrders.length} unpaid orders synced to FFN:`);
      affectedOrders.forEach((o, i) => {
        console.log(`   ${i + 1}. #${o.orderNumber} | payment=${o.paymentStatus || 'NULL'} | outbound=${o.jtlOutboundId} | hold=${o.isOnHold} | origin=${o.orderOrigin} | created=${o.createdAt.toISOString()}`);
      });
    }

    // ─── Summary ───
    console.log('\n==========================================================');
    console.log('INVESTIGATION SUMMARY');
    console.log('==========================================================');
    console.log(`Order #${order.orderNumber} (${order.id})`);
    console.log(`Payment Status: ${order.paymentStatus || 'NULL'}`);
    console.log(`Was on hold: ${order.holdPlacedAt ? 'YES' : 'NO'}`);
    console.log(`Channel: ${order.channel?.type} (${order.channel?.name})`);
    console.log(`FFN Outbound: ${order.jtlOutboundId}`);
    console.log(`Sync origin: ${createLog?.origin || 'UNKNOWN'}`);
    console.log(`Other affected: ${affectedOrders.length} orders`);
    console.log('==========================================================\n');

  } catch (error) {
    console.error('❌ Unexpected error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main()
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
