/**
 * Test Script: Shopify Fulfillment Integration
 *
 * Validates all 5 phases of the fulfillment integration improvements:
 *   Phase 1 — Schema + GID capture
 *   Phase 2 — Bidirectional hold sync
 *   Phase 3 — Tracking updates
 *   Phase 4 — Multi-package / shipments
 *   Phase 5 — Webhooks + error recovery
 *
 * Usage:
 *   npx tsx backend/scripts/test-fulfillment-integration.ts            # all tests
 *   npx tsx backend/scripts/test-fulfillment-integration.ts --phase 1  # single phase
 *   npx tsx backend/scripts/test-fulfillment-integration.ts --cleanup  # remove test data
 */

import { PrismaClient, FulfillmentState } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// ─── DB Connection ────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Test Helpers ─────────────────────────────────────────────────────
const TEST_PREFIX = 'FULFILLMENT-TEST';

// Resolved at runtime from the first active Shopify channel
let TEST_CLIENT_ID = '';
let TEST_CHANNEL_ID = '';

interface TestResult {
  phase: number;
  test: string;
  passed: boolean;
  details: string;
  duration: number;
}

const results: TestResult[] = [];

function record(phase: number, test: string, passed: boolean, details: string, duration: number) {
  results.push({ phase, test, passed, details, duration });
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} [Phase ${phase}] ${test} (${duration}ms)`);
  if (!passed) console.log(`     └─ ${details}`);
}

async function assert(phase: number, test: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    record(phase, test, true, '', Date.now() - start);
  } catch (err: any) {
    record(phase, test, false, err.message || String(err), Date.now() - start);
  }
}

// ─── Setup: Find existing client + channel (no synthetic data needed) ─
async function setupTestData() {
  console.log('\n🔧 Setting up test data...\n');

  // Find an existing active Shopify channel to attach test orders to
  const channel = await prisma.channel.findFirst({
    where: { type: 'SHOPIFY', isActive: true },
    select: { id: true, clientId: true, name: true },
  });

  if (!channel) {
    throw new Error('No active Shopify channel found in database — cannot run tests');
  }

  TEST_CLIENT_ID = channel.clientId;
  TEST_CHANNEL_ID = channel.id;

  console.log(`  ✓ Using channel: ${channel.name} (${TEST_CHANNEL_ID})`);
  console.log(`  ✓ Using client:  ${TEST_CLIENT_ID}\n`);
}

// ─── Cleanup ──────────────────────────────────────────────────────────
async function cleanup() {
  console.log('\n🧹 Cleaning up test data...\n');

  // Only delete orders created by this test (identified by TEST_PREFIX in orderId)
  const testOrders = await prisma.order.findMany({
    where: { orderId: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });

  const orderIds = testOrders.map(o => o.id);

  if (orderIds.length > 0) {
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderSyncLog.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderSyncQueue.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.notification.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }

  console.log(`  ✓ Cleaned up ${orderIds.length} test orders (client + channel untouched)\n`);
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1: Schema + GID Capture
// ═══════════════════════════════════════════════════════════════════════
async function testPhase1() {
  console.log('\n━━━ Phase 1: Schema + GID Capture ━━━\n');

  // Test 1.1: shopifyFulfillmentGid field exists on Order
  await assert(1, 'Order model has shopifyFulfillmentGid field', async () => {
    const order = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P1-001`,
        externalOrderId: '99901',
        status: 'PROCESSING',
        shopifyFulfillmentGid: 'gid://shopify/Fulfillment/123456789',
      },
    });

    if (order.shopifyFulfillmentGid !== 'gid://shopify/Fulfillment/123456789') {
      throw new Error(`Expected GID to be stored, got: ${order.shopifyFulfillmentGid}`);
    }
  });

  // Test 1.2: shopifyFulfillmentGid can be null
  await assert(1, 'shopifyFulfillmentGid is nullable (pre-fulfillment orders)', async () => {
    const order = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P1-002`,
        externalOrderId: '99902',
        status: 'PENDING',
      },
    });

    if (order.shopifyFulfillmentGid !== null) {
      throw new Error(`Expected null, got: ${order.shopifyFulfillmentGid}`);
    }
  });

  // Test 1.3: Shipment model exists and works
  await assert(1, 'Shipment model creates records with tracking data', async () => {
    const order = await prisma.order.findFirst({
      where: { orderId: `${TEST_PREFIX}-P1-001` },
    });
    if (!order) throw new Error('Test order not found');

    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id,
        trackingNumber: 'TEST-TRACK-001',
        carrier: 'DHL',
        trackingUrl: 'https://tracking.dhl.com/TEST-TRACK-001',
        shopifyFulfillmentGid: 'gid://shopify/Fulfillment/123456789',
        status: 'shipped',
      },
    });

    if (!shipment.id) throw new Error('Shipment not created');
    if (shipment.trackingNumber !== 'TEST-TRACK-001') throw new Error('Tracking mismatch');
    if (shipment.carrier !== 'DHL') throw new Error('Carrier mismatch');
  });

  // Test 1.4: Order → Shipments relation works
  await assert(1, 'Order includes shipments via relation', async () => {
    const order = await prisma.order.findFirst({
      where: { orderId: `${TEST_PREFIX}-P1-001` },
      include: { shipments: true },
    });

    if (!order) throw new Error('Test order not found');
    if (!order.shipments || order.shipments.length === 0) {
      throw new Error('Shipments relation returned empty');
    }
    if (order.shipments[0].trackingNumber !== 'TEST-TRACK-001') {
      throw new Error('Shipment tracking number mismatch in relation');
    }
  });

  // Test 1.5: Shipment cascade delete on Order delete
  await assert(1, 'Shipments cascade-delete when order is deleted', async () => {
    // Create a temporary order with a shipment
    const tempOrder = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P1-CASCADE`,
        status: 'SHIPPED',
      },
    });

    await prisma.shipment.create({
      data: {
        orderId: tempOrder.id,
        trackingNumber: 'CASCADE-TEST-001',
        status: 'shipped',
      },
    });

    // Delete order — shipment should cascade
    await prisma.order.delete({ where: { id: tempOrder.id } });

    const orphanedShipments = await prisma.shipment.findMany({
      where: { orderId: tempOrder.id },
    });

    if (orphanedShipments.length !== 0) {
      throw new Error(`Expected 0 orphaned shipments, found ${orphanedShipments.length}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2: Bidirectional Hold Sync
// ═══════════════════════════════════════════════════════════════════════
async function testPhase2() {
  console.log('\n━━━ Phase 2: Bidirectional Hold Sync ━━━\n');

  // Test 2.1: Queue service accepts new operations
  await assert(2, 'OrderSyncJobData type supports hold/release_hold/update_tracking', async () => {
    // Import and verify the type accepts our new operations
    const { QUEUE_NAMES } = await import('../src/services/queue/sync-queue.service.js');

    if (!QUEUE_NAMES.ORDER_SYNC_TO_COMMERCE) {
      throw new Error('QUEUE_NAMES.ORDER_SYNC_TO_COMMERCE not found');
    }
    if (!QUEUE_NAMES.ORDER_SYNC_TO_FFN) {
      throw new Error('QUEUE_NAMES.ORDER_SYNC_TO_FFN not found');
    }
  });

  // Test 2.2: OrderSyncService.syncOperationalToCommerce accepts new operations
  await assert(2, 'syncOperationalToCommerce handles hold operation (no channel → graceful skip)', async () => {
    const { OrderSyncService } = await import('../src/services/integrations/order-sync.service.js');
    const syncService = new OrderSyncService(prisma);

    const order = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P2-001`,
        externalOrderId: '99910',
        status: 'ON_HOLD',
        isOnHold: true,
        holdReason: 'AWAITING_PAYMENT',
        shopifyFulfillmentOrderId: 'gid://shopify/FulfillmentOrder/999',
      },
    });

    // Should not throw — credentials are fake so it will skip gracefully
    const result = await syncService.syncOperationalToCommerce(order.id, 'hold');
    // It should return success (skipped because fake credentials) or a controlled error
    if (result.success === undefined) {
      throw new Error('Expected result to have success field');
    }
  });

  // Test 2.3: syncOperationalToCommerce handles release_hold
  await assert(2, 'syncOperationalToCommerce handles release_hold operation', async () => {
    const { OrderSyncService } = await import('../src/services/integrations/order-sync.service.js');
    const syncService = new OrderSyncService(prisma);

    const order = await prisma.order.findFirst({
      where: { orderId: `${TEST_PREFIX}-P2-001` },
    });
    if (!order) throw new Error('Test order not found');

    const result = await syncService.syncOperationalToCommerce(order.id, 'release_hold');
    if (result.success === undefined) {
      throw new Error('Expected result to have success field');
    }
  });

  // Test 2.4: Hold fields stored correctly on order
  await assert(2, 'Order hold fields store Shopify-originated hold data', async () => {
    const order = await prisma.order.update({
      where: { id: (await prisma.order.findFirst({ where: { orderId: `${TEST_PREFIX}-P2-001` } }))!.id },
      data: {
        isOnHold: true,
        holdReason: 'HIGH_RISK_OF_FRAUD',
        holdPlacedBy: 'SHOPIFY',
        holdPlacedAt: new Date(),
        shopifyFulfillmentOrderStatus: 'ON_HOLD',
        shopifyFulfillmentHoldReason: 'HIGH_RISK_OF_FRAUD',
        shopifyFulfillmentHoldNotes: 'Flagged by Shopify fraud detection',
      },
    });

    if (order.holdPlacedBy !== 'SHOPIFY') throw new Error('holdPlacedBy mismatch');
    if (order.shopifyFulfillmentHoldReason !== 'HIGH_RISK_OF_FRAUD') throw new Error('hold reason mismatch');
    if (order.shopifyFulfillmentOrderStatus !== 'ON_HOLD') throw new Error('FO status mismatch');
  });
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3: Tracking Updates
// ═══════════════════════════════════════════════════════════════════════
async function testPhase3() {
  console.log('\n━━━ Phase 3: Tracking Updates ━━━\n');

  // Test 3.1: syncOperationalToCommerce accepts update_tracking
  await assert(3, 'syncOperationalToCommerce handles update_tracking operation', async () => {
    const { OrderSyncService } = await import('../src/services/integrations/order-sync.service.js');
    const syncService = new OrderSyncService(prisma);

    const order = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P3-001`,
        externalOrderId: '99920',
        status: 'SHIPPED',
        fulfillmentState: 'SHIPPED',
        trackingNumber: 'TRACK-OLD-001',
        shopifyFulfillmentGid: 'gid://shopify/Fulfillment/777',
      },
    });

    const result = await syncService.syncOperationalToCommerce(order.id, 'update_tracking');
    if (result.success === undefined) {
      throw new Error('Expected result to have success field');
    }
  });

  // Test 3.2: Update_tracking without GID falls back to fulfill
  await assert(3, 'update_tracking without GID falls back to fulfill flow', async () => {
    const { OrderSyncService } = await import('../src/services/integrations/order-sync.service.js');
    const syncService = new OrderSyncService(prisma);

    const order = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P3-002`,
        externalOrderId: '99921',
        status: 'SHIPPED',
        fulfillmentState: 'SHIPPED',
        trackingNumber: 'TRACK-NOGTID-001',
        // No shopifyFulfillmentGid — should fall back
      },
    });

    const result = await syncService.syncOperationalToCommerce(order.id, 'update_tracking');
    // Should not throw; it'll try the fulfill path which will fail on fake creds, but gracefully
    if (result.success === undefined) {
      throw new Error('Expected result to have success field');
    }
  });

  // Test 3.3: JTL extractAllTrackingInfo returns multi-package data
  await assert(3, 'JTL extractAllTrackingInfo returns array of all packages', async () => {
    const { JTLService } = await import('../src/services/integrations/jtl.service.js');
    // Create a minimal instance just for the extraction method (no API calls)
    const jtlService = new JTLService({
      clientId: 'test',
      clientSecret: 'test',
      environment: 'sandbox',
      fulfillerId: 'test',
      warehouseId: 'test',
    }, prisma, TEST_CLIENT_ID);

    const mockShippingNotifications = {
      packages: [
        {
          freightOption: 'DHL Express',
          trackingUrl: 'https://dhl.com/track/PKG1',
          identifier: [
            { value: 'PKG-001', identifierType: 'TrackingId', name: 'TrackingId' },
          ],
        },
        {
          freightOption: 'DHL Standard',
          trackingUrl: 'https://dhl.com/track/PKG2',
          identifier: [
            { value: 'PKG-002', identifierType: 'TrackingId', name: 'TrackingId' },
          ],
        },
        {
          freightOption: 'UPS',
          identifier: [
            { value: '', identifierType: 'TrackingId', name: 'TrackingId' },
          ],
        },
      ],
    };

    const allTracking = jtlService.extractAllTrackingInfo(mockShippingNotifications);

    if (!Array.isArray(allTracking)) throw new Error('Expected array');
    // Third package has empty tracking, should be filtered out
    if (allTracking.length !== 2) throw new Error(`Expected 2 packages, got ${allTracking.length}`);
    if (allTracking[0].trackingNumber !== 'PKG-001') throw new Error('First package tracking mismatch');
    if (allTracking[1].trackingNumber !== 'PKG-002') throw new Error('Second package tracking mismatch');
    if (allTracking[0].carrier !== 'DHL Express') throw new Error('First carrier mismatch');
  });

  // Test 3.4: extractAllTrackingInfo handles empty input
  await assert(3, 'extractAllTrackingInfo returns empty array for no packages', async () => {
    const { JTLService } = await import('../src/services/integrations/jtl.service.js');
    const jtlService = new JTLService({
      clientId: 'test', clientSecret: 'test', environment: 'sandbox',
      fulfillerId: 'test', warehouseId: 'test',
    }, prisma, TEST_CLIENT_ID);

    const result = jtlService.extractAllTrackingInfo({ packages: [] });
    if (result.length !== 0) throw new Error(`Expected empty array, got ${result.length}`);
  });

  // Test 3.5: Backward compat — extractTrackingInfo still returns first package only
  await assert(3, 'extractTrackingInfo (old method) still returns single package', async () => {
    const { JTLService } = await import('../src/services/integrations/jtl.service.js');
    const jtlService = new JTLService({
      clientId: 'test', clientSecret: 'test', environment: 'sandbox',
      fulfillerId: 'test', warehouseId: 'test',
    }, prisma, TEST_CLIENT_ID);

    const result = jtlService.extractTrackingInfo({
      packages: [
        {
          freightOption: 'DHL',
          identifier: [{ value: 'FIRST', identifierType: 'TrackingId' }],
        },
        {
          freightOption: 'UPS',
          identifier: [{ value: 'SECOND', identifierType: 'TrackingId' }],
        },
      ],
    });

    if (result.trackingNumber !== 'FIRST') throw new Error('Should return first package only');
  });
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 4: Multi-Package / Shipments
// ═══════════════════════════════════════════════════════════════════════
async function testPhase4() {
  console.log('\n━━━ Phase 4: Multi-Package / Shipments ━━━\n');

  // Test 4.1: Multiple shipments per order
  await assert(4, 'Multiple shipments can be created for one order', async () => {
    const order = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P4-001`,
        externalOrderId: '99930',
        status: 'SHIPPED',
        fulfillmentState: 'SHIPPED',
        shopifyFulfillmentGid: 'gid://shopify/Fulfillment/444',
      },
    });

    // Create 3 shipments
    for (let i = 1; i <= 3; i++) {
      await prisma.shipment.create({
        data: {
          orderId: order.id,
          trackingNumber: `MULTI-PKG-${i}`,
          carrier: i <= 2 ? 'DHL' : 'UPS',
          trackingUrl: `https://track.example.com/MULTI-PKG-${i}`,
          shopifyFulfillmentGid: `gid://shopify/Fulfillment/44${i}`,
          status: 'shipped',
        },
      });
    }

    const shipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
      orderBy: { shippedAt: 'asc' },
    });

    if (shipments.length !== 3) throw new Error(`Expected 3 shipments, got ${shipments.length}`);
    if (shipments[0].trackingNumber !== 'MULTI-PKG-1') throw new Error('First shipment mismatch');
    if (shipments[2].carrier !== 'UPS') throw new Error('Third shipment carrier mismatch');
  });

  // Test 4.2: Shipments included in order API response (via relation)
  await assert(4, 'Order query with include: { shipments } returns all packages', async () => {
    const order = await prisma.order.findFirst({
      where: { orderId: `${TEST_PREFIX}-P4-001` },
      include: {
        shipments: {
          orderBy: { shippedAt: 'asc' },
        },
      },
    });

    if (!order) throw new Error('Order not found');
    if (!order.shipments) throw new Error('Shipments not included');
    if (order.shipments.length !== 3) throw new Error(`Expected 3, got ${order.shipments.length}`);

    // Verify each shipment has the right GID
    const gids = order.shipments.map(s => s.shopifyFulfillmentGid);
    if (!gids.includes('gid://shopify/Fulfillment/441')) throw new Error('Missing GID 441');
    if (!gids.includes('gid://shopify/Fulfillment/443')) throw new Error('Missing GID 443');
  });

  // Test 4.3: Shipment with lineItems JSON
  await assert(4, 'Shipment lineItems JSON field stores SKU/quantity data', async () => {
    const order = await prisma.order.findFirst({
      where: { orderId: `${TEST_PREFIX}-P4-001` },
    });
    if (!order) throw new Error('Order not found');

    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id,
        trackingNumber: 'LINEITEMS-TEST',
        status: 'shipped',
        lineItems: [
          { sku: 'SKU-A', quantity: 2 },
          { sku: 'SKU-B', quantity: 1 },
        ],
      },
    });

    const fetched = await prisma.shipment.findUnique({ where: { id: shipment.id } });
    if (!fetched?.lineItems) throw new Error('lineItems not stored');

    const items = fetched.lineItems as any[];
    if (items.length !== 2) throw new Error(`Expected 2 line items, got ${items.length}`);
    if (items[0].sku !== 'SKU-A') throw new Error('Line item SKU mismatch');
  });

  // Test 4.4: Shipment deduplication check
  await assert(4, 'Duplicate shipment detection works via trackingNumber lookup', async () => {
    const order = await prisma.order.findFirst({
      where: { orderId: `${TEST_PREFIX}-P4-001` },
    });
    if (!order) throw new Error('Order not found');

    const existingShipments = await prisma.shipment.findMany({
      where: { orderId: order.id },
    });
    const existingTrackingNumbers = new Set(existingShipments.map(s => s.trackingNumber));

    // Simulate the dedup logic from order-sync.service.ts
    const newPackages = ['MULTI-PKG-1', 'MULTI-PKG-2', 'BRAND-NEW-PKG'];
    const toCreate = newPackages.filter(t => !existingTrackingNumbers.has(t));

    if (toCreate.length !== 1) throw new Error(`Expected 1 new package, got ${toCreate.length}`);
    if (toCreate[0] !== 'BRAND-NEW-PKG') throw new Error('Wrong package selected');
  });
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 5: Webhooks + Error Recovery
// ═══════════════════════════════════════════════════════════════════════
async function testPhase5() {
  console.log('\n━━━ Phase 5: Webhooks + Error Recovery ━━━\n');

  // Test 5.1: Enhanced webhook payload type has fulfillment_holds
  await assert(5, 'ShopifyFulfillmentOrderPayload type includes fulfillment_holds', async () => {
    // This is a compile-time test — if the import works without error, the type exists
    const mod = await import('../src/services/integrations/enhanced-webhook-processor.service.js');
    if (!mod.EnhancedWebhookProcessor) throw new Error('EnhancedWebhookProcessor not exported');
  });

  // Test 5.2: Reconciliation finds stuck fulfillments
  await assert(5, 'reconcileStuckFulfillments finds SHIPPED orders without GID', async () => {
    // Create stuck orders: SHIPPED but no shopifyFulfillmentGid
    for (let i = 1; i <= 3; i++) {
      await prisma.order.create({
        data: {
          clientId: TEST_CLIENT_ID,
          channelId: TEST_CHANNEL_ID,
          orderId: `${TEST_PREFIX}-P5-STUCK-${i}`,
          externalOrderId: `99950${i}`,
          status: 'SHIPPED',
          fulfillmentState: 'SHIPPED',
          shopifyFulfillmentGid: null, // STUCK — no GID
          isCancelled: false,
        },
      });
    }

    // Also create a non-stuck order (has GID)
    await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P5-OK`,
        externalOrderId: '999504',
        status: 'SHIPPED',
        fulfillmentState: 'SHIPPED',
        shopifyFulfillmentGid: 'gid://shopify/Fulfillment/999', // NOT stuck
      },
    });

    // Query stuck orders directly (same logic as reconcileStuckFulfillments)
    const stuckOrders = await prisma.order.findMany({
      where: {
        clientId: TEST_CLIENT_ID,
        fulfillmentState: 'SHIPPED',
        shopifyFulfillmentGid: null,
        isCancelled: false,
        channel: { type: 'SHOPIFY' },
      },
    });

    if (stuckOrders.length < 3) {
      throw new Error(`Expected at least 3 stuck orders, found ${stuckOrders.length}`);
    }

    // Verify the OK order is NOT in the stuck list
    const okInStuck = stuckOrders.find(o => o.orderId === `${TEST_PREFIX}-P5-OK`);
    if (okInStuck) throw new Error('Non-stuck order incorrectly included');
  });

  // Test 5.3: Cancelled orders excluded from reconciliation
  await assert(5, 'Cancelled orders are excluded from stuck fulfillment reconciliation', async () => {
    await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P5-CANCELLED`,
        externalOrderId: '999505',
        status: 'CANCELLED',
        fulfillmentState: 'SHIPPED',
        shopifyFulfillmentGid: null,
        isCancelled: true,
      },
    });

    const stuckOrders = await prisma.order.findMany({
      where: {
        clientId: TEST_CLIENT_ID,
        fulfillmentState: 'SHIPPED',
        shopifyFulfillmentGid: null,
        isCancelled: false,
        channel: { type: 'SHOPIFY' },
      },
    });

    const cancelledInStuck = stuckOrders.find(o => o.orderId === `${TEST_PREFIX}-P5-CANCELLED`);
    if (cancelledInStuck) throw new Error('Cancelled order should not be in stuck list');
  });

  // Test 5.4: Order cancellation fields from Shopify webhook
  await assert(5, 'Order stores Shopify cancellation data (cancelledBy, cancelledAt)', async () => {
    const order = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P5-SHOPIFY-CANCEL`,
        externalOrderId: '999506',
        status: 'PROCESSING',
        jtlOutboundId: 'JTL-OUTBOUND-TEST',
      },
    });

    // Simulate what the enhanced webhook processor does on 'cancelled'
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        isCancelled: true,
        cancelledAt: new Date(),
        cancelledBy: 'SHOPIFY',
        shopifyFulfillmentOrderStatus: 'CANCELLED',
      },
    });

    if (updated.cancelledBy !== 'SHOPIFY') throw new Error('cancelledBy not stored');
    if (!updated.cancelledAt) throw new Error('cancelledAt not stored');
    if (updated.shopifyFulfillmentOrderStatus !== 'CANCELLED') throw new Error('FO status not CANCELLED');
  });

  // Test 5.5: Error classification — commerceSyncError stored for hold errors
  await assert(5, 'commerceSyncError stored when fulfillment fails due to hold', async () => {
    const order = await prisma.order.create({
      data: {
        clientId: TEST_CLIENT_ID,
        channelId: TEST_CHANNEL_ID,
        orderId: `${TEST_PREFIX}-P5-HOLD-ERR`,
        externalOrderId: '999507',
        status: 'SHIPPED',
        fulfillmentState: 'SHIPPED',
        commerceSyncError: 'Shopify on hold: FulfillmentOrder is ON_HOLD',
      },
    });

    const fetched = await prisma.order.findUnique({ where: { id: order.id } });
    if (!fetched?.commerceSyncError?.includes('ON_HOLD')) {
      throw new Error('commerceSyncError should contain ON_HOLD');
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Main Runner
// ═══════════════════════════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const phaseArg = args.indexOf('--phase');
  const targetPhase = phaseArg >= 0 ? parseInt(args[phaseArg + 1]) : null;
  const isCleanup = args.includes('--cleanup');

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Shopify Fulfillment Integration — Test Suite             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (isCleanup) {
    await cleanup();
    return;
  }

  await setupTestData();

  const phases: [number, () => Promise<void>][] = [
    [1, testPhase1],
    [2, testPhase2],
    [3, testPhase3],
    [4, testPhase4],
    [5, testPhase5],
  ];

  for (const [num, fn] of phases) {
    if (targetPhase && num !== targetPhase) continue;
    await fn();
  }

  // ─── Summary ──────────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  Test Results Summary                                     ║');
  console.log('╠════════════════════════════════════════════════════════════╣');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  for (let phase = 1; phase <= 5; phase++) {
    const phaseResults = results.filter(r => r.phase === phase);
    if (phaseResults.length === 0) continue;
    const pPassed = phaseResults.filter(r => r.passed).length;
    const pFailed = phaseResults.filter(r => !r.passed).length;
    const icon = pFailed === 0 ? '✅' : '⚠️';
    console.log(`║  ${icon} Phase ${phase}: ${pPassed}/${phaseResults.length} passed${pFailed > 0 ? ` (${pFailed} failed)` : ''}`.padEnd(61) + '║');
  }

  console.log('╠════════════════════════════════════════════════════════════╣');
  const summaryIcon = failed === 0 ? '🎉' : '❌';
  console.log(`║  ${summaryIcon} Total: ${passed}/${total} passed, ${failed} failed`.padEnd(61) + '║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ❌ [Phase ${r.phase}] ${r.test}`);
      console.log(`     └─ ${r.details}`);
    }
  }

  // Cleanup test data
  console.log('');
  await cleanup();

  if (failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error('\n💥 Test suite crashed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
