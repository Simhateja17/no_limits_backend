/**
 * Backfill Script: Mark Existing Shipped Orders as Fulfilled in Shopify
 *
 * Problem: Due to broken sync paths, orders marked SHIPPED/DELIVERED in our DB
 * were never marked "fulfilled" in Shopify. These orders still show as
 * "unfulfilled" in Shopify Admin.
 *
 * This script runs TWO passes:
 *
 * Pass 1 — Fulfill unfulfilled orders:
 *   1. Finds Shopify channels with valid credentials
 *   2. Queries orders that are SHIPPED/DELIVERED but never synced to Shopify
 *   3. Fetches tracking from JTL FFN if missing in DB (via getShippingNotifications)
 *   4. Creates fulfillments in Shopify with tracking info
 *   5. Handles "already fulfilled" gracefully
 *
 * Pass 2 — Update tracking on already-fulfilled orders:
 *   1. Finds orders that WERE synced to Shopify but have no tracking in DB
 *   2. Fetches tracking from JTL FFN
 *   3. Gets the Shopify fulfillment ID via REST API
 *   4. Updates the fulfillment's tracking info via GraphQL
 *   5. Persists tracking to DB
 *
 * Key decisions:
 * - notify_customer: false — orders shipped days/weeks ago; sending emails now would confuse customers
 * - Rate limiting: 250ms between API calls (4 req/sec) to stay within Shopify rate limits
 * - Idempotent: "already fulfilled" errors are handled gracefully, script can be re-run safely
 * - Tracking source logged per order (DB vs JTL FFN) for debugging visibility
 *
 * Usage:
 *   npx tsx scripts/fix-shopify-unfulfilled-orders.ts --dry-run   # Preview
 *   npx tsx scripts/fix-shopify-unfulfilled-orders.ts              # Execute
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createShopifyServiceAuto } from '../src/services/integrations/shopify-service-factory.js';
import { ShopifyGraphQLService } from '../src/services/integrations/shopify-graphql.service.js';
import { JTLService } from '../src/services/integrations/jtl.service.js';
import { getEncryptionService } from '../src/services/encryption.service.js';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const isDryRun = process.argv.includes('--dry-run');

interface BackfillStats {
  totalChecked: number;
  totalFulfilled: number;
  totalAlreadyFulfilled: number;
  totalSkipped: number;
  totalErrors: number;
  errorsByReason: Map<string, number>;
  // Pass 2: tracking update stats
  trackingUpdateChecked: number;
  trackingUpdated: number;
  trackingUpdateErrors: number;
}

/**
 * Fetch fulfillments for a Shopify order via REST API
 * Returns the first fulfillment's ID (for tracking update)
 */
async function getShopifyFulfillmentId(
  shopDomain: string,
  accessToken: string,
  orderId: number,
): Promise<{ fulfillmentId: number | null; hasTracking: boolean }> {
  const apiVersion = '2024-10';
  const url = `https://${shopDomain}/admin/api/${apiVersion}/orders/${orderId}/fulfillments.json`;

  const response = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify REST API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { fulfillments: Array<{ id: number; tracking_number: string | null; status: string }> };
  const fulfillments = data.fulfillments || [];

  if (fulfillments.length === 0) {
    return { fulfillmentId: null, hasTracking: false };
  }

  // Use the first fulfillment (most orders have exactly one)
  const fulfillment = fulfillments[0];
  return {
    fulfillmentId: fulfillment.id,
    hasTracking: !!fulfillment.tracking_number,
  };
}

async function fixShopifyUnfulfilledOrders() {
  const stats: BackfillStats = {
    totalChecked: 0,
    totalFulfilled: 0,
    totalAlreadyFulfilled: 0,
    totalSkipped: 0,
    totalErrors: 0,
    errorsByReason: new Map(),
    trackingUpdateChecked: 0,
    trackingUpdated: 0,
    trackingUpdateErrors: 0,
  };

  console.log('='.repeat(60));
  console.log('Shopify Unfulfilled Orders Backfill');
  console.log('='.repeat(60));

  if (isDryRun) {
    console.log('\n🔍 DRY RUN MODE - No changes will be made\n');
  }

  console.log('🔍 Finding Shopify channels...\n');

  // Find all Shopify channels with credentials
  const shopifyChannels = await prisma.channel.findMany({
    where: { type: 'SHOPIFY' },
    select: {
      id: true,
      name: true,
      shopDomain: true,
      accessToken: true,
      clientId: true,
    },
  });

  if (shopifyChannels.length === 0) {
    console.log('✅ No Shopify channels found. Nothing to backfill.');
    return;
  }

  console.log(`Found ${shopifyChannels.length} Shopify channel(s):\n`);
  console.table(shopifyChannels.map(c => ({ id: c.id, name: c.name, shopDomain: c.shopDomain })));

  const encryptionService = getEncryptionService();

  // Process each channel
  for (const channel of shopifyChannels) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📦 Processing channel: ${channel.name} (${channel.id})`);
    console.log(`${'─'.repeat(60)}`);

    // Verify channel has credentials
    if (!channel.shopDomain || !channel.accessToken) {
      console.log('⚠️  Skipping channel - missing Shopify credentials (shopDomain or accessToken)');
      continue;
    }

    // Initialize Shopify service
    let shopifyService: ReturnType<typeof createShopifyServiceAuto>;
    try {
      shopifyService = createShopifyServiceAuto({
        shopDomain: channel.shopDomain,
        accessToken: encryptionService.safeDecrypt(channel.accessToken),
      });
    } catch (error) {
      console.log(`❌ Failed to initialize Shopify service:`, error);
      continue;
    }

    // Initialize JTL service for this channel's client (for fetching tracking info)
    let jtlService: JTLService | null = null;
    try {
      const jtlConfig = await prisma.jtlConfig.findUnique({
        where: { clientId_fk: channel.clientId },
      });

      if (jtlConfig && jtlConfig.isActive && jtlConfig.accessToken) {
        jtlService = new JTLService({
          clientId: jtlConfig.clientId,
          clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
          accessToken: encryptionService.safeDecrypt(jtlConfig.accessToken),
          refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
          tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
          fulfillerId: jtlConfig.fulfillerId,
          warehouseId: jtlConfig.warehouseId,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        }, prisma, jtlConfig.clientId_fk);
        console.log(`   JTL service initialized for client ${channel.clientId}`);
      } else {
        console.log(`   ⚠️  No active JTL config found — tracking will come from DB only`);
      }
    } catch (error) {
      console.log(`   ⚠️  Failed to initialize JTL service (tracking will come from DB only):`, error);
    }

    // Find orders that are SHIPPED/DELIVERED but never synced to Shopify
    const candidateOrders = await prisma.order.findMany({
      where: {
        channelId: channel.id,
        orderOrigin: 'SHOPIFY',
        fulfillmentState: {
          in: ['SHIPPED', 'DELIVERED'],
        },
        externalOrderId: { not: null },
        lastSyncedToCommerce: null, // Never synced back to Shopify
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderId: true,
        fulfillmentState: true,
        trackingNumber: true,
        trackingUrl: true,
        carrierSelection: true,
        jtlOutboundId: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (candidateOrders.length === 0) {
      console.log('✅ No unsynced shipped/delivered orders found for this channel');
      continue;
    }

    console.log(`\n📋 Found ${candidateOrders.length} orders with SHIPPED/DELIVERED status (never synced to Shopify)`);
    console.log('   Creating fulfillments in Shopify...\n');

    let channelFulfilled = 0;
    let channelAlreadyFulfilled = 0;
    let channelSkipped = 0;
    let channelErrors = 0;

    // Process each order
    for (const order of candidateOrders) {
      try {
        stats.totalChecked++;
        const shopifyOrderId = parseInt(order.externalOrderId!, 10);

        if (isNaN(shopifyOrderId)) {
          throw new Error(`Invalid externalOrderId: ${order.externalOrderId}`);
        }

        // Resolve tracking info: prefer DB, fallback to fresh fetch from JTL FFN
        let trackingNumber = order.trackingNumber || undefined;
        let trackingUrl = order.trackingUrl || undefined;
        let carrier = order.carrierSelection || undefined;
        let trackingSource = trackingNumber ? 'DB' : 'none';

        if (!trackingNumber && order.jtlOutboundId && jtlService) {
          try {
            const notifications = await jtlService.getShippingNotifications(order.jtlOutboundId);
            if (notifications.success && notifications.data) {
              const trackingInfo = jtlService.extractTrackingInfo(notifications.data);
              if (trackingInfo.trackingNumber) {
                trackingNumber = trackingInfo.trackingNumber;
                trackingUrl = trackingInfo.trackingUrl || trackingUrl;
                carrier = trackingInfo.carrier || carrier;
                trackingSource = 'JTL FFN';

                // Persist fetched tracking to DB so future runs don't re-fetch
                if (!isDryRun) {
                  await prisma.order.update({
                    where: { id: order.id },
                    data: {
                      trackingNumber: trackingInfo.trackingNumber,
                      ...(trackingInfo.trackingUrl && { trackingUrl: trackingInfo.trackingUrl }),
                      ...(trackingInfo.carrier && { carrierSelection: trackingInfo.carrier }),
                    },
                  });
                }
              }
            }
          } catch (jtlError) {
            console.log(`   ⚠ Order ${order.orderNumber}: Failed to fetch tracking from JTL FFN — proceeding without tracking`);
          }
        }

        const trackingLabel = trackingNumber
          ? ` [tracking: ${trackingNumber} via ${trackingSource}]`
          : ` [no tracking${!order.jtlOutboundId ? ' — no outbound ID' : !jtlService ? ' — no JTL service' : ''}]`;

        if (!isDryRun) {
          try {
            // Create fulfillment in Shopify (without customer notification)
            await shopifyService.createFulfillment(shopifyOrderId, {
              tracking_number: trackingNumber,
              tracking_company: carrier,
              tracking_url: trackingUrl,
              notify_customer: false, // Don't notify — these orders shipped days/weeks ago
            } as any);

            // Update DB: mark as synced
            await prisma.order.update({
              where: { id: order.id },
              data: {
                lastSyncedToCommerce: new Date(),
                syncStatus: 'SYNCED',
              },
            });

            channelFulfilled++;
            stats.totalFulfilled++;
            console.log(`   ✓ Order ${order.orderNumber} (Shopify #${shopifyOrderId}): fulfilled${trackingLabel}`);
          } catch (fulfillError: any) {
            if (fulfillError.message?.includes('already fulfilled')) {
              // Order was already fulfilled in Shopify (maybe manually) — mark as synced
              await prisma.order.update({
                where: { id: order.id },
                data: {
                  lastSyncedToCommerce: new Date(),
                  syncStatus: 'SYNCED',
                },
              });

              channelAlreadyFulfilled++;
              stats.totalAlreadyFulfilled++;
              console.log(`   ℹ Order ${order.orderNumber} (Shopify #${shopifyOrderId}): already fulfilled in Shopify`);
            } else if (fulfillError.message?.includes('on hold')) {
              channelSkipped++;
              stats.totalSkipped++;
              console.log(`   ⚠ Order ${order.orderNumber} (Shopify #${shopifyOrderId}): on hold in Shopify - skipping`);
            } else {
              throw fulfillError;
            }
          }
        } else {
          // Dry run — just report what would happen
          channelFulfilled++;
          stats.totalFulfilled++;
          console.log(`   ✓ Order ${order.orderNumber} (Shopify #${shopifyOrderId}): would create fulfillment (dry run)${trackingLabel}`);
        }

        // Rate limiting — 250ms between calls (4 req/sec) to respect Shopify limits
        if (!isDryRun) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }

      } catch (error) {
        channelErrors++;
        stats.totalErrors++;
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`   ✗ Order ${order.orderNumber}: ${errMsg}`);

        // Track error reasons for summary
        const errorReason = errMsg.includes('404') || errMsg.includes('Not Found') ? 'Not found in Shopify (404)' :
                          errMsg.includes('401') || errMsg.includes('403') ? 'Auth error' :
                          errMsg.includes('429') ? 'Rate limited (429)' :
                          errMsg.includes('timeout') ? 'Timeout' :
                          errMsg.includes('No line items') ? 'No line items for fulfillment' :
                          errMsg.includes('No open fulfillment orders') ? 'No open fulfillment orders' :
                          'Other error';
        stats.errorsByReason.set(errorReason, (stats.errorsByReason.get(errorReason) || 0) + 1);
      }
    }

    // Channel summary
    console.log(`\n   📊 Channel Summary:`);
    console.log(`      Orders checked:          ${candidateOrders.length}`);
    console.log(`      Fulfilled:               ${channelFulfilled}${isDryRun ? ' (dry run)' : ''}`);
    console.log(`      Already fulfilled:        ${channelAlreadyFulfilled}`);
    console.log(`      Skipped (on hold):        ${channelSkipped}`);
    console.log(`      Errors:                   ${channelErrors}`);
  }

  // ═══════════════════════════════════════════════════════════
  // PASS 2: Update tracking on already-fulfilled orders
  // Orders that were previously fulfilled without tracking info
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('Pass 2: Update Tracking on Already-Fulfilled Orders');
  console.log('='.repeat(60));

  for (const channel of shopifyChannels) {
    if (!channel.shopDomain || !channel.accessToken) continue;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📦 Checking channel: ${channel.name} (${channel.id})`);
    console.log(`${'─'.repeat(60)}`);

    const decryptedAccessToken = encryptionService.safeDecrypt(channel.accessToken);

    // Create GraphQL service for updateFulfillmentTracking
    let graphqlService: ShopifyGraphQLService;
    try {
      graphqlService = new ShopifyGraphQLService({
        shopDomain: channel.shopDomain,
        accessToken: decryptedAccessToken,
      });
    } catch (error) {
      console.log(`   ❌ Failed to initialize Shopify GraphQL service:`, error);
      continue;
    }

    // Initialize JTL service for this channel's client
    let jtlService: JTLService | null = null;
    try {
      const jtlConfig = await prisma.jtlConfig.findUnique({
        where: { clientId_fk: channel.clientId },
      });

      if (jtlConfig && jtlConfig.isActive && jtlConfig.accessToken) {
        jtlService = new JTLService({
          clientId: jtlConfig.clientId,
          clientSecret: encryptionService.safeDecrypt(jtlConfig.clientSecret),
          accessToken: encryptionService.safeDecrypt(jtlConfig.accessToken),
          refreshToken: jtlConfig.refreshToken ? encryptionService.safeDecrypt(jtlConfig.refreshToken) : undefined,
          tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
          fulfillerId: jtlConfig.fulfillerId,
          warehouseId: jtlConfig.warehouseId,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        }, prisma, jtlConfig.clientId_fk);
      }
    } catch {
      // JTL init failure is non-fatal
    }

    if (!jtlService) {
      console.log('   ⚠️  No JTL service — cannot fetch tracking. Skipping pass 2 for this channel.');
      continue;
    }

    // Find orders that ARE synced but have no tracking in DB
    const syncedWithoutTracking = await prisma.order.findMany({
      where: {
        channelId: channel.id,
        orderOrigin: 'SHOPIFY',
        fulfillmentState: { in: ['SHIPPED', 'DELIVERED'] },
        externalOrderId: { not: null },
        lastSyncedToCommerce: { not: null }, // Already synced
        trackingNumber: null, // But no tracking in DB
        jtlOutboundId: { not: null }, // Has JTL outbound (can fetch tracking)
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderId: true,
        jtlOutboundId: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (syncedWithoutTracking.length === 0) {
      console.log('   ✅ No fulfilled orders missing tracking for this channel');
      continue;
    }

    console.log(`\n   📋 Found ${syncedWithoutTracking.length} fulfilled orders missing tracking — fetching from JTL FFN...\n`);

    for (const order of syncedWithoutTracking) {
      stats.trackingUpdateChecked++;

      try {
        // Fetch tracking from JTL FFN
        const notifications = await jtlService.getShippingNotifications(order.jtlOutboundId!);
        if (!notifications.success || !notifications.data) {
          console.log(`   ⚠ Order ${order.orderNumber}: JTL FFN returned no data — skipping`);
          continue;
        }

        const trackingInfo = jtlService.extractTrackingInfo(notifications.data);
        if (!trackingInfo.trackingNumber) {
          console.log(`   ⚠ Order ${order.orderNumber}: No tracking in JTL FFN shipping notifications — skipping`);
          continue;
        }

        const shopifyOrderId = parseInt(order.externalOrderId!, 10);

        if (isDryRun) {
          console.log(`   ✓ Order ${order.orderNumber} (Shopify #${shopifyOrderId}): would update tracking [${trackingInfo.trackingNumber}] (dry run)`);
          stats.trackingUpdated++;
          continue;
        }

        // Get the Shopify fulfillment ID via REST API
        const { fulfillmentId, hasTracking } = await getShopifyFulfillmentId(
          channel.shopDomain,
          decryptedAccessToken,
          shopifyOrderId,
        );

        if (!fulfillmentId) {
          console.log(`   ⚠ Order ${order.orderNumber}: No fulfillment found in Shopify — skipping`);
          continue;
        }

        if (hasTracking) {
          console.log(`   ℹ Order ${order.orderNumber}: Shopify fulfillment already has tracking — skipping`);
          // Still update DB with the tracking we fetched
          await prisma.order.update({
            where: { id: order.id },
            data: {
              trackingNumber: trackingInfo.trackingNumber,
              ...(trackingInfo.trackingUrl && { trackingUrl: trackingInfo.trackingUrl }),
              ...(trackingInfo.carrier && { carrierSelection: trackingInfo.carrier }),
            },
          });
          continue;
        }

        // Update tracking in Shopify
        const updateResult = await graphqlService.updateFulfillmentTracking(
          fulfillmentId,
          {
            number: trackingInfo.trackingNumber,
            company: trackingInfo.carrier,
            url: trackingInfo.trackingUrl,
          },
          false, // Don't notify customer
        );

        if (!updateResult.success) {
          console.log(`   ✗ Order ${order.orderNumber}: Shopify tracking update failed: ${updateResult.error}`);
          stats.trackingUpdateErrors++;
          continue;
        }

        // Update DB with tracking
        await prisma.order.update({
          where: { id: order.id },
          data: {
            trackingNumber: trackingInfo.trackingNumber,
            ...(trackingInfo.trackingUrl && { trackingUrl: trackingInfo.trackingUrl }),
            ...(trackingInfo.carrier && { carrierSelection: trackingInfo.carrier }),
          },
        });

        stats.trackingUpdated++;
        console.log(`   ✓ Order ${order.orderNumber} (Shopify #${shopifyOrderId}): tracking updated [${trackingInfo.trackingNumber}] via JTL FFN`);

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 250));

      } catch (error) {
        stats.trackingUpdateErrors++;
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`   ✗ Order ${order.orderNumber}: ${errMsg}`);
      }
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Final Summary');
  console.log('='.repeat(60));
  console.log(`\nPass 1 — Fulfill unfulfilled orders:`);
  console.log(`  Orders checked:              ${stats.totalChecked}`);
  console.log(`  Fulfilled in Shopify:        ${stats.totalFulfilled}${isDryRun ? ' (dry run)' : ''}`);
  console.log(`  Already fulfilled:           ${stats.totalAlreadyFulfilled}`);
  console.log(`  Skipped (on hold):           ${stats.totalSkipped}`);
  console.log(`  Errors:                      ${stats.totalErrors}`);

  console.log(`\nPass 2 — Update tracking on fulfilled orders:`);
  console.log(`  Orders checked:              ${stats.trackingUpdateChecked}`);
  console.log(`  Tracking updated:            ${stats.trackingUpdated}${isDryRun ? ' (dry run)' : ''}`);
  console.log(`  Errors:                      ${stats.trackingUpdateErrors}`);

  if (stats.errorsByReason.size > 0) {
    console.log('\n❌ Error Breakdown (Pass 1):');
    Array.from(stats.errorsByReason.entries()).forEach(([reason, count]) => {
      console.log(`   - ${reason}: ${count}`);
    });
  }

  if (isDryRun) {
    console.log('\n🔍 This was a dry run. Run without --dry-run to apply changes.');
  } else if (stats.totalFulfilled > 0 || stats.trackingUpdated > 0) {
    console.log('\n✨ Backfill complete!');
    if (stats.totalFulfilled > 0) console.log('   - Shopify orders have been marked as fulfilled.');
    if (stats.trackingUpdated > 0) console.log('   - Tracking info has been added to existing fulfillments.');
    console.log('\n💡 Note: notify_customer was set to false — no shipment emails were sent.');
  } else if (stats.totalAlreadyFulfilled > 0) {
    console.log('\n✨ All affected orders were already fulfilled in Shopify — DB records updated.');
  } else {
    console.log('\n✨ No orders needed backfilling — all Shopify fulfillments are already in sync!');
  }

  console.log('='.repeat(60));
}

// Entry point
async function main() {
  try {
    await fixShopifyUnfulfilledOrders();
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main()
  .then(() => {
    console.log('\n✅ Script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
