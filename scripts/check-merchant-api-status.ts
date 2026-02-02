/**
 * Diagnostic script to check JTL Merchant API status for a specific outbound
 * This tests what the Merchant API returns vs what's actually in the warehouse
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

const TARGET_OUTBOUND_ID = 'L47C0278GBSKXF4Z';
const TARGET_CLIENT_ID = 'cml3pk4cd0001bjs16qqlwb7h';
const TARGET_ORDER_ID = 'cml3q2b1p00tcmgnh6tz4mzca';
const TARGET_ORDER_NUMBER = '#5446';

async function main() {
  console.log('=================================================');
  console.log('JTL MERCHANT API STATUS CHECK');
  console.log('=================================================\n');

  console.log('Target Details:');
  console.log(`  Client ID:        ${TARGET_CLIENT_ID}`);
  console.log(`  Order ID:         ${TARGET_ORDER_ID}`);
  console.log(`  Order Number:     ${TARGET_ORDER_NUMBER}`);
  console.log(`  JTL Outbound ID:  ${TARGET_OUTBOUND_ID}`);
  console.log('');

  try {
    // 1. Fetch JTL config for the client
    console.log('[1] Fetching JTL configuration...');
    const jtlConfig = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: TARGET_CLIENT_ID },
    });

    if (!jtlConfig) {
      console.error('❌ No JTL configuration found for this client!');
      return;
    }

    if (!jtlConfig.accessToken) {
      console.error('❌ No access token found in JTL configuration!');
      return;
    }

    console.log('✅ JTL configuration found');
    console.log(`   Environment: ${jtlConfig.environment}`);
    console.log(`   Warehouse ID: ${jtlConfig.warehouseId}`);
    console.log(`   Fulfiller ID: ${jtlConfig.fulfillerId}`);
    console.log('');

    // 2. Initialize JTL Service
    console.log('[2] Initializing JTL Service...');
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
    }, prisma, TARGET_CLIENT_ID);

    console.log('✅ JTL Service initialized');
    console.log('');

    // 3. Fetch order from database to get reference info
    console.log('[3] Fetching order from database...');
    const order = await prisma.order.findUnique({
      where: { id: TARGET_ORDER_ID },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        fulfillmentState: true,
        jtlOutboundId: true,
        lastJtlSync: true,
        trackingNumber: true,
        updatedAt: true,
      },
    });

    if (!order) {
      console.error('❌ Order not found in database!');
      return;
    }

    console.log('✅ Order found in database:');
    console.log(`   Order Number:       ${order.orderNumber}`);
    console.log(`   Status:             ${order.status}`);
    console.log(`   Fulfillment State:  ${order.fulfillmentState}`);
    console.log(`   JTL Outbound ID:    ${order.jtlOutboundId}`);
    console.log(`   Last JTL Sync:      ${order.lastJtlSync?.toISOString() || 'Never'}`);
    console.log(`   Tracking Number:    ${order.trackingNumber || 'None'}`);
    console.log(`   Last Updated:       ${order.updatedAt.toISOString()}`);
    console.log('');

    // 4. Call Merchant API - Get specific outbound details
    console.log('[4] Calling Merchant API - GET /api/v1/merchant/outbounds/{id}...');
    try {
      const outboundDetails = await jtlService.getOutbound(TARGET_OUTBOUND_ID);

      console.log('✅ Merchant API Response (Outbound Details):');
      console.log(JSON.stringify(outboundDetails, null, 2));
      console.log('');

      console.log('📋 Key fields from response:');
      console.log(`   Status:                ${outboundDetails.status}`);
      console.log(`   Created At:            ${outboundDetails.createdAt}`);
      console.log(`   Merchant Order Number: ${outboundDetails.merchantOutboundNumber}`);
      console.log('');
    } catch (error: any) {
      console.error('❌ Failed to fetch outbound details:', error.message);
    }

    // 5. Call Merchant API - Get outbound updates
    console.log('[5] Calling Merchant API - GET /api/v1/merchant/outbounds/updates...');
    console.log('   (Checking last 7 days of updates)');

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    try {
      // Note: The JTL Merchant API returns full outbound objects, not update wrappers
      const updates = await jtlService.getOutboundUpdates({
        since: sevenDaysAgo.toISOString(),
        limit: 100,
      }) as any[];

      console.log(`✅ Merchant API Response: ${updates.length} total updates found`);
      console.log('');

      // The updates are actually full outbound objects
      // Filter for our specific outbound using outboundId
      const targetUpdate = updates.find((u: any) => u.outboundId === TARGET_OUTBOUND_ID);

      if (!targetUpdate) {
        console.log(`⚠️  No updates found for outbound ${TARGET_OUTBOUND_ID} in the last 7 days`);
        console.log('');
        console.log('💡 This means the Merchant API /updates endpoint is NOT returning updates for this order.');
        console.log('   The order was shipped on 2026-02-01 at 14:14:47, which is within the 7-day window.');
        console.log('   This confirms the Merchant API updates endpoint may have stale or incomplete data.');
        console.log('');
      } else {
        console.log(`📦 Found update for outbound ${TARGET_OUTBOUND_ID}:`);
        console.log('');
        console.log(`     Status:              ${targetUpdate.status}`);
        console.log(`     Created At:          ${targetUpdate.modificationInfo.createdAt}`);
        console.log(`     Updated At:          ${targetUpdate.modificationInfo.updatedAt}`);
        console.log(`     Status Timestamps:   ${JSON.stringify(targetUpdate.statusTimestamp, null, 2)}`);
        console.log('');
      }

      // Show a few other recent updates for context
      if (updates.length > 0) {
        console.log('');
        console.log('📊 Recent updates (all outbounds, last 5):');
        updates.slice(0, 5).forEach((update: any, index: number) => {
          const status = update.status || 'Unknown';
          const outboundId = update.outboundId || 'Unknown';
          const merchantNum = update.merchantOutboundNumber || 'Unknown';
          const updatedAt = update.modificationInfo?.updatedAt || 'Unknown';
          console.log(`   ${index + 1}. Outbound: ${outboundId} (#${merchantNum}) | Status: ${status} | Updated: ${updatedAt}`);
        });

        // Show change tracking from first update
        if (updates[0].modificationInfo?.changesInRange) {
          console.log('');
          console.log('📋 Change tracking example (first update):');
          updates[0].modificationInfo.changesInRange.forEach((change: any, idx: number) => {
            console.log(`   ${idx + 1}. ${change.createdAt} - ${change.state}`);
          });
        }
      }
    } catch (error: any) {
      console.error('❌ Failed to fetch outbound updates:', error.message);
      console.error(error.stack);
    }

    console.log('');
    console.log('=================================================');
    console.log('DIAGNOSTIC COMPLETE');
    console.log('=================================================');

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
