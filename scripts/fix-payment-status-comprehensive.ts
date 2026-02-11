/**
 * Comprehensive Payment Status Migration Script
 *
 * Problem: Historical orders in the database are marked as unpaid (or have
 * paymentStatus = null) but are actually paid in WooCommerce/Shopify.
 *
 * This script:
 * 1. Queries for potentially affected orders (null status, incorrect status, active holds, synced but unpaid)
 * 2. Fetches current payment status from commerce platform APIs
 * 3. Updates local database with correct paymentStatus
 * 4. Releases/places payment holds where appropriate
 * 5. Queues newly-released orders for FFN sync
 * 6. Creates comprehensive audit trail
 *
 * Usage:
 *   npx tsx scripts/fix-payment-status-comprehensive.ts [options]
 *
 * Options:
 *   --dry-run              Preview changes without applying (default: true)
 *   --no-dry-run           Actually apply changes to database
 *   --client <id>          Only process specific client
 *   --channel <id>         Only process specific channel
 *   --channel-type <type>  Only SHOPIFY or WOOCOMMERCE
 *   --skip-api             Skip API calls, use local data only (faster but less accurate)
 *   --skip-queue           Don't queue orders for FFN sync
 *   --batch-size <n>       Orders per batch (default: 50)
 *   --rate-limit <ms>      Delay between API calls (default: 100)
 */

import { PrismaClient, ChannelType } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { WooCommerceService } from '../src/services/integrations/woocommerce.service.js';
import { ShopifyService } from '../src/services/integrations/shopify.service.js';
import { getEncryptionService } from '../src/services/encryption.service.js';
import type { WooCommerceOrder } from '../src/services/integrations/types.js';
import type { ShopifyOrder } from '../src/services/integrations/types.js';
import 'dotenv/config';

// Initialize Prisma with pg adapter (Prisma 7 requirement)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Payment statuses considered safe for fulfillment (FFN sync allowed)
const FFN_ALLOWED_PAYMENT_STATUSES = [
  'paid',
  'completed',
  'processing',
  'refunded',
  'partially_refunded',
  'authorized',
  'partially_paid',
];

// ============= TYPES =============

interface ScriptOptions {
  dryRun: boolean;
  clientId?: string;
  channelId?: string;
  channelType?: 'SHOPIFY' | 'WOOCOMMERCE';
  skipApi: boolean;
  skipQueue: boolean;
  batchSize: number;
  rateLimit: number;
}

interface UpdateResult {
  orderId: string;
  orderNumber: string;
  oldPaymentStatus: string | null;
  newPaymentStatus: string | null;
  oldHoldState: boolean;
  newHoldState: boolean;
  holdReleased: boolean;
  holdPlaced: boolean;
  queuedForFFN: boolean;
  skipped: boolean;
  error?: string;
}

interface ChannelStats {
  channelId: string;
  channelName: string;
  channelType: string;
  totalOrders: number;
  updated: number;
  holdsReleased: number;
  holdsPlaced: number;
  queuedForFFN: number;
  skipped: number;
  errors: number;
}

interface MigrationStats {
  totalScanned: number;
  scenarios: {
    nullPaymentStatus: number;
    incorrectPaymentStatus: number;
    activePaymentHold: number;
    syncedButUnpaid: number;
  };
  changes: {
    updated: number;
    holdsReleased: number;
    holdsPlaced: number;
    queuedForFFN: number;
    skipped: number;
    errors: number;
  };
  channelStats: ChannelStats[];
}

// ============= CLI ARGUMENT PARSING =============

function parseArguments(): ScriptOptions {
  const args = process.argv.slice(2);
  const options: ScriptOptions = {
    dryRun: true, // Default to dry-run for safety
    skipApi: false,
    skipQueue: false,
    batchSize: 50,
    rateLimit: 100,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-dry-run':
        options.dryRun = false;
        break;
      case '--client':
        options.clientId = args[++i];
        break;
      case '--channel':
        options.channelId = args[++i];
        break;
      case '--channel-type':
        const type = args[++i]?.toUpperCase();
        if (type !== 'SHOPIFY' && type !== 'WOOCOMMERCE') {
          throw new Error('--channel-type must be SHOPIFY or WOOCOMMERCE');
        }
        options.channelType = type as 'SHOPIFY' | 'WOOCOMMERCE';
        break;
      case '--skip-api':
        options.skipApi = true;
        break;
      case '--skip-queue':
        options.skipQueue = true;
        break;
      case '--batch-size':
        options.batchSize = parseInt(args[++i], 10);
        break;
      case '--rate-limit':
        options.rateLimit = parseInt(args[++i], 10);
        break;
      case '--help':
        console.log(`
Comprehensive Payment Status Migration Script

Usage:
  npx tsx scripts/fix-payment-status-comprehensive.ts [options]

Options:
  --dry-run              Preview changes without applying (default: true)
  --no-dry-run           Actually apply changes to database
  --client <id>          Only process specific client
  --channel <id>         Only process specific channel
  --channel-type <type>  Only SHOPIFY or WOOCOMMERCE
  --skip-api             Skip API calls, use local data only (faster but less accurate)
  --skip-queue           Don't queue orders for FFN sync
  --batch-size <n>       Orders per batch (default: 50)
  --rate-limit <ms>      Delay between API calls (default: 100)
  --help                 Show this help message
        `);
        process.exit(0);
        break;
    }
  }

  return options;
}

// ============= HELPER FUNCTIONS =============

/**
 * Sleep for specified milliseconds (rate limiting)
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map WooCommerce order status to payment status
 */
function mapWooCommercePaymentStatus(status?: string): string | null {
  if (!status) return null;
  switch (status.toLowerCase()) {
    case 'processing':
    case 'completed':
    case 'delivered': // Custom WooCommerce status - delivered orders are paid
      return 'paid';
    case 'refunded':
      return 'refunded';
    case 'pending':
    case 'on-hold':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'cancelled':
    default:
      return null;
  }
}

/**
 * Fetch current payment status from WooCommerce API
 */
async function fetchWooCommercePaymentStatus(
  channel: any,
  externalOrderId: string
): Promise<string | null> {
  const encryptionService = getEncryptionService();
  const storeUrl = channel.apiUrl || channel.url;

  if (!storeUrl || !channel.apiClientId || !channel.apiClientSecret) {
    throw new Error('Missing WooCommerce credentials');
  }

  const wooService = new WooCommerceService({
    url: storeUrl,
    consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
    consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
  });

  const orderId = parseInt(externalOrderId, 10);
  if (isNaN(orderId)) {
    throw new Error(`Invalid external order ID: ${externalOrderId}`);
  }

  const wooOrder = await wooService.getOrder(orderId);
  return mapWooCommercePaymentStatus(wooOrder.status);
}

/**
 * Fetch current payment status from Shopify API
 */
async function fetchShopifyPaymentStatus(
  channel: any,
  externalOrderId: string
): Promise<string | null> {
  const encryptionService = getEncryptionService();

  if (!channel.shopDomain || !channel.accessToken) {
    throw new Error('Missing Shopify credentials');
  }

  const shopifyService = new ShopifyService({
    shopDomain: channel.shopDomain,
    accessToken: encryptionService.safeDecrypt(channel.accessToken),
  });

  const orderId = parseInt(externalOrderId, 10);
  if (isNaN(orderId)) {
    throw new Error(`Invalid external order ID: ${externalOrderId}`);
  }

  const shopifyOrder = await shopifyService.getOrder(orderId);
  return shopifyOrder.financial_status || null;
}

/**
 * Exponential backoff retry wrapper
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if it's a rate limit or network error (retry-able)
      const errorMessage = lastError.message.toLowerCase();
      const isRetryable = errorMessage.includes('rate limit') ||
                         errorMessage.includes('timeout') ||
                         errorMessage.includes('econnreset') ||
                         errorMessage.includes('enotfound');

      if (!isRetryable || attempt === maxRetries - 1) {
        throw lastError;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`   ⏳ Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Update order payment status and manage holds
 */
async function updateOrderPaymentStatus(
  order: any,
  newPaymentStatus: string | null,
  dryRun: boolean
): Promise<UpdateResult> {
  const oldPaymentStatus = order.paymentStatus;
  const oldHoldState = order.isOnHold;

  const result: UpdateResult = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    oldPaymentStatus,
    newPaymentStatus,
    oldHoldState,
    newHoldState: oldHoldState,
    holdReleased: false,
    holdPlaced: false,
    queuedForFFN: false,
    skipped: false,
  };

  // Check if payment status actually changed
  if (oldPaymentStatus === newPaymentStatus) {
    result.skipped = true;
    return result;
  }

  const isPaymentSafe = newPaymentStatus
    ? FFN_ALLOWED_PAYMENT_STATUSES.includes(newPaymentStatus.toLowerCase())
    : false;

  const updateData: any = {
    paymentStatus: newPaymentStatus,
    updatedAt: new Date(),
  };

  const changedFields = ['paymentStatus'];

  // Release payment hold if status is now safe
  if (isPaymentSafe && order.isOnHold && order.holdReason === 'AWAITING_PAYMENT') {
    updateData.isOnHold = false;
    updateData.holdReason = null;
    updateData.holdNotes = null;
    updateData.holdReleasedAt = new Date();
    updateData.holdReleasedBy = 'SYSTEM_MIGRATION';
    updateData.ffnSyncError = null;
    changedFields.push('isOnHold', 'holdReason', 'holdReleasedAt', 'holdReleasedBy');
    result.holdReleased = true;
    result.newHoldState = false;
  }

  // Place hold if status is unsafe and not currently on hold
  if (!isPaymentSafe && !order.isOnHold) {
    updateData.isOnHold = true;
    updateData.holdReason = 'AWAITING_PAYMENT';
    updateData.holdPlacedAt = new Date();
    updateData.holdPlacedBy = 'SYSTEM_MIGRATION';
    changedFields.push('isOnHold', 'holdReason', 'holdPlacedAt', 'holdPlacedBy');
    result.holdPlaced = true;
    result.newHoldState = true;
  }

  if (dryRun) {
    console.log(`   [DRY-RUN] Would update order ${order.orderNumber}:`);
    console.log(`      Payment: ${oldPaymentStatus || 'NULL'} → ${newPaymentStatus || 'NULL'}`);
    console.log(`      Hold: ${oldHoldState} → ${updateData.isOnHold ?? oldHoldState}`);
    if (result.holdReleased) console.log(`      ✓ Would release payment hold`);
    if (result.holdPlaced) console.log(`      ✓ Would place payment hold`);
    return result;
  }

  // Update order in transaction with audit log
  try {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: updateData,
      });

      // Create audit log
      await tx.orderSyncLog.create({
        data: {
          orderId: order.id,
          action: 'update',
          origin: order.channel.type,
          targetPlatform: 'nolimits',
          success: true,
          changedFields,
          previousState: { paymentStatus: oldPaymentStatus, isOnHold: oldHoldState },
          newState: { paymentStatus: newPaymentStatus, isOnHold: updateData.isOnHold ?? oldHoldState },
        },
      });
    });

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

/**
 * Queue order for FFN sync
 */
async function queueOrderForFFN(orderId: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) {
    console.log(`   [DRY-RUN] Would queue order for FFN sync`);
    return true;
  }

  try {
    await prisma.orderSyncQueue.create({
      data: {
        orderId,
        operation: 'sync_to_ffn',
        priority: 5,
        triggerOrigin: 'NOLIMITS',
        status: 'pending',
        payload: { reason: 'payment_hold_released_by_migration' },
      },
    });
    return true;
  } catch (error) {
    console.error(`   ✗ Failed to queue order for FFN sync: ${error}`);
    return false;
  }
}

// ============= MAIN MIGRATION LOGIC =============

/**
 * Phase 1: Discovery - Find potentially affected orders
 */
async function discoverAffectedOrders(options: ScriptOptions): Promise<any[]> {
  console.log('📋 [Phase 1] Discovering affected orders...\n');

  const whereConditions: any = {
    OR: [
      // Scenario A: Null payment status
      { paymentStatus: null },

      // Scenario B: Incorrect payment status (not in safe list)
      {
        paymentStatus: {
          notIn: FFN_ALLOWED_PAYMENT_STATUSES,
        },
      },

      // Scenario C: Active payment hold
      { isOnHold: true, holdReason: 'AWAITING_PAYMENT' },

      // Scenario D: Unpaid but already synced to FFN (data integrity issue)
      {
        AND: [
          { jtlOutboundId: { not: null } },
          {
            paymentStatus: {
              notIn: FFN_ALLOWED_PAYMENT_STATUSES,
            },
          },
        ],
      },
    ],
    paymentHoldOverride: false, // Respect manual overrides
    status: { not: 'CANCELLED' }, // Skip cancelled orders
  };

  // Apply filters from CLI options
  if (options.clientId) {
    whereConditions.clientId = options.clientId;
  }

  if (options.channelId) {
    whereConditions.channelId = options.channelId;
  }

  if (options.channelType) {
    whereConditions.channel = { type: options.channelType };
  }

  const affectedOrders = await prisma.order.findMany({
    where: whereConditions,
    include: {
      channel: {
        select: {
          id: true,
          type: true,
          name: true,
          apiUrl: true,
          apiClientId: true,
          apiClientSecret: true,
          url: true,
          shopDomain: true,
          accessToken: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`✅ Found ${affectedOrders.length} potentially affected orders\n`);

  // Count by scenario (orders may match multiple scenarios)
  const scenarios = {
    nullPaymentStatus: affectedOrders.filter((o) => o.paymentStatus === null).length,
    incorrectPaymentStatus: affectedOrders.filter(
      (o) => o.paymentStatus && !FFN_ALLOWED_PAYMENT_STATUSES.includes(o.paymentStatus.toLowerCase())
    ).length,
    activePaymentHold: affectedOrders.filter((o) => o.isOnHold && o.holdReason === 'AWAITING_PAYMENT').length,
    syncedButUnpaid: affectedOrders.filter(
      (o) =>
        o.jtlOutboundId &&
        (!o.paymentStatus || !FFN_ALLOWED_PAYMENT_STATUSES.includes(o.paymentStatus.toLowerCase()))
    ).length,
  };

  console.log('📊 Orders by scenario:');
  console.log(`   Null payment status:       ${scenarios.nullPaymentStatus}`);
  console.log(`   Incorrect payment status:  ${scenarios.incorrectPaymentStatus}`);
  console.log(`   Active payment hold:       ${scenarios.activePaymentHold}`);
  console.log(`   Unpaid but synced to FFN:  ${scenarios.syncedButUnpaid}`);
  console.log('');

  return affectedOrders;
}

/**
 * Phase 2-4: Process orders for a specific channel
 */
async function processChannelOrders(
  channel: any,
  orders: any[],
  options: ScriptOptions
): Promise<UpdateResult[]> {
  console.log(`\n📦 Processing channel: ${channel.name} (${channel.type})`);
  console.log(`   Orders to process: ${orders.length}`);

  const results: UpdateResult[] = [];

  for (const order of orders) {
    try {
      let newPaymentStatus: string | null = null;

      // Phase 2: Platform Verification (fetch current status from API)
      if (options.skipApi) {
        // Use existing payment status (skip API call)
        newPaymentStatus = order.paymentStatus;
        console.log(`   [SKIP-API] Order ${order.orderNumber}: using existing status`);
      } else {
        // Fetch current status from platform
        console.log(`   Fetching order ${order.orderNumber} from ${channel.type}...`);

        try {
          newPaymentStatus = await retryWithBackoff(async () => {
            if (channel.type === 'WOOCOMMERCE') {
              return await fetchWooCommercePaymentStatus(channel, order.externalOrderId);
            } else if (channel.type === 'SHOPIFY') {
              return await fetchShopifyPaymentStatus(channel, order.externalOrderId);
            } else {
              throw new Error(`Unsupported channel type: ${channel.type}`);
            }
          });

          console.log(`   ✓ Order ${order.orderNumber}: payment status = ${newPaymentStatus || 'NULL'}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`   ✗ Order ${order.orderNumber}: API error - ${errorMessage}`);

          results.push({
            orderId: order.id,
            orderNumber: order.orderNumber,
            oldPaymentStatus: order.paymentStatus,
            newPaymentStatus: order.paymentStatus,
            oldHoldState: order.isOnHold,
            newHoldState: order.isOnHold,
            holdReleased: false,
            holdPlaced: false,
            queuedForFFN: false,
            skipped: false,
            error: errorMessage,
          });

          // Rate limiting between orders (even on error)
          await sleep(options.rateLimit);
          continue;
        }

        // Rate limiting between API calls
        await sleep(options.rateLimit);
      }

      // Phase 3: Database Updates
      const updateResult = await updateOrderPaymentStatus(order, newPaymentStatus, options.dryRun);
      results.push(updateResult);

      // Phase 4: FFN Re-sync Queue (if hold was released and order not yet synced)
      if (updateResult.holdReleased && !order.jtlOutboundId && !options.skipQueue) {
        const queued = await queueOrderForFFN(order.id, options.dryRun);
        updateResult.queuedForFFN = queued;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`   ✗ Order ${order.orderNumber}: ${errorMessage}`);

      results.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        oldPaymentStatus: order.paymentStatus,
        newPaymentStatus: order.paymentStatus,
        oldHoldState: order.isOnHold,
        newHoldState: order.isOnHold,
        holdReleased: false,
        holdPlaced: false,
        queuedForFFN: false,
        skipped: false,
        error: errorMessage,
      });
    }
  }

  return results;
}

/**
 * Phase 5: Generate comprehensive migration report
 */
function generateReport(
  allResults: UpdateResult[],
  channelStatsMap: Map<string, ChannelStats>,
  scenarios: MigrationStats['scenarios']
): void {
  const stats = {
    updated: allResults.filter((r) => !r.skipped && !r.error).length,
    holdsReleased: allResults.filter((r) => r.holdReleased).length,
    holdsPlaced: allResults.filter((r) => r.holdPlaced).length,
    queuedForFFN: allResults.filter((r) => r.queuedForFFN).length,
    skipped: allResults.filter((r) => r.skipped).length,
    errors: allResults.filter((r) => r.error).length,
  };

  console.log('\n' + '='.repeat(70));
  console.log('📊 PAYMENT STATUS MIGRATION COMPLETE');
  console.log('='.repeat(70));
  console.log(`\nTotal orders scanned: ${allResults.length}`);

  console.log('\n🔍 By scenario:');
  console.log(`   Null payment status:       ${scenarios.nullPaymentStatus}`);
  console.log(`   Incorrect payment status:  ${scenarios.incorrectPaymentStatus}`);
  console.log(`   Active payment hold:       ${scenarios.activePaymentHold}`);
  console.log(`   Unpaid but synced to FFN:  ${scenarios.syncedButUnpaid}`);

  console.log('\n✨ Changes made:');
  console.log(`   Orders updated:            ${stats.updated}`);
  console.log(`   Holds released:            ${stats.holdsReleased}`);
  console.log(`   Holds placed:              ${stats.holdsPlaced}`);
  console.log(`   Queued for FFN sync:       ${stats.queuedForFFN}`);
  console.log(`   Skipped (no change):       ${stats.skipped}`);
  console.log(`   Errors:                    ${stats.errors}`);

  if (channelStatsMap.size > 0) {
    console.log('\n📦 By channel:');
    const channelStatsArray = Array.from(channelStatsMap.values());
    for (const channelStats of channelStatsArray) {
      console.log(`   ${channelStats.channelName} (${channelStats.channelType}):`);
      console.log(`      Total orders:     ${channelStats.totalOrders}`);
      console.log(`      Updated:          ${channelStats.updated}`);
      console.log(`      Holds released:   ${channelStats.holdsReleased}`);
      console.log(`      Holds placed:     ${channelStats.holdsPlaced}`);
      console.log(`      Queued for FFN:   ${channelStats.queuedForFFN}`);
      console.log(`      Skipped:          ${channelStats.skipped}`);
      console.log(`      Errors:           ${channelStats.errors}`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

/**
 * Main migration function
 */
async function runMigration(): Promise<void> {
  const options = parseArguments();

  console.log('\n' + '='.repeat(70));
  console.log('🔧 COMPREHENSIVE PAYMENT STATUS MIGRATION');
  console.log('='.repeat(70));
  console.log('\n⚙️  Configuration:');
  console.log(`   Dry-run mode:      ${options.dryRun ? 'ENABLED (preview only)' : 'DISABLED (changes will be applied)'}`);
  console.log(`   Client filter:     ${options.clientId || 'ALL'}`);
  console.log(`   Channel filter:    ${options.channelId || 'ALL'}`);
  console.log(`   Channel type:      ${options.channelType || 'ALL'}`);
  console.log(`   Skip API calls:    ${options.skipApi}`);
  console.log(`   Skip FFN queue:    ${options.skipQueue}`);
  console.log(`   Batch size:        ${options.batchSize}`);
  console.log(`   Rate limit:        ${options.rateLimit}ms`);
  console.log('');

  try {
    // Phase 1: Discovery
    const affectedOrders = await discoverAffectedOrders(options);

    if (affectedOrders.length === 0) {
      console.log('✅ No orders need migration. Exiting.');
      return;
    }

    const scenarios = {
      nullPaymentStatus: affectedOrders.filter((o) => o.paymentStatus === null).length,
      incorrectPaymentStatus: affectedOrders.filter(
        (o) => o.paymentStatus && !FFN_ALLOWED_PAYMENT_STATUSES.includes(o.paymentStatus.toLowerCase())
      ).length,
      activePaymentHold: affectedOrders.filter((o) => o.isOnHold && o.holdReason === 'AWAITING_PAYMENT').length,
      syncedButUnpaid: affectedOrders.filter(
        (o) =>
          o.jtlOutboundId &&
          (!o.paymentStatus || !FFN_ALLOWED_PAYMENT_STATUSES.includes(o.paymentStatus.toLowerCase()))
      ).length,
    };

    // Group orders by channel for efficient batch processing
    const ordersByChannel = new Map<string, any[]>();
    const ordersWithoutChannel: any[] = [];

    for (const order of affectedOrders) {
      if (!order.channel) {
        console.log(`⚠️  Order ${order.orderNumber} (${order.id}) has no channel - skipping`);
        ordersWithoutChannel.push(order);
        continue;
      }

      const channelId = order.channel.id;
      if (!ordersByChannel.has(channelId)) {
        ordersByChannel.set(channelId, []);
      }
      ordersByChannel.get(channelId)!.push(order);
    }

    if (ordersWithoutChannel.length > 0) {
      console.log(`\n⚠️  Warning: ${ordersWithoutChannel.length} order(s) have no channel and will be skipped\n`);
    }

    console.log(`📦 Grouped into ${ordersByChannel.size} channel(s)\n`);

    // Process each channel
    const allResults: UpdateResult[] = [];
    const channelStatsMap = new Map<string, ChannelStats>();

    const channelEntries = Array.from(ordersByChannel.entries());
    for (const [channelId, orders] of channelEntries) {
      const channel = orders[0].channel;

      // Check for missing credentials
      if (channel.type === 'WOOCOMMERCE') {
        const hasCredentials = channel.apiUrl && channel.apiClientId && channel.apiClientSecret;
        if (!hasCredentials && !options.skipApi) {
          console.log(`\n⚠️  Skipping channel ${channel.name} - missing WooCommerce credentials`);
          continue;
        }
      } else if (channel.type === 'SHOPIFY') {
        const hasCredentials = channel.shopDomain && channel.accessToken;
        if (!hasCredentials && !options.skipApi) {
          console.log(`\n⚠️  Skipping channel ${channel.name} - missing Shopify credentials`);
          continue;
        }
      }

      const results = await processChannelOrders(channel, orders, options);
      allResults.push(...results);

      // Calculate channel stats
      const channelStats: ChannelStats = {
        channelId: channel.id,
        channelName: channel.name,
        channelType: channel.type,
        totalOrders: results.length,
        updated: results.filter((r) => !r.skipped && !r.error).length,
        holdsReleased: results.filter((r) => r.holdReleased).length,
        holdsPlaced: results.filter((r) => r.holdPlaced).length,
        queuedForFFN: results.filter((r) => r.queuedForFFN).length,
        skipped: results.filter((r) => r.skipped).length,
        errors: results.filter((r) => r.error).length,
      };

      channelStatsMap.set(channelId, channelStats);

      console.log(`\n   📊 Channel summary:`);
      console.log(`      Updated:          ${channelStats.updated}`);
      console.log(`      Holds released:   ${channelStats.holdsReleased}`);
      console.log(`      Holds placed:     ${channelStats.holdsPlaced}`);
      console.log(`      Queued for FFN:   ${channelStats.queuedForFFN}`);
      console.log(`      Skipped:          ${channelStats.skipped}`);
      console.log(`      Errors:           ${channelStats.errors}`);
    }

    // Phase 5: Generate Report
    generateReport(allResults, channelStatsMap, scenarios);

    if (options.dryRun) {
      console.log('\n💡 This was a DRY-RUN. No changes were made to the database.');
      console.log('   To apply changes, run with --no-dry-run flag.\n');
    } else {
      console.log('\n✅ Migration complete! All changes have been applied.\n');
    }
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// ============= SCRIPT ENTRY POINT =============

runMigration()
  .then(() => {
    console.log('✨ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Script failed:', error);
    process.exit(1);
  });
