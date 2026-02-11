import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

console.log('='.repeat(80));
console.log('Checking Order 15991');
console.log('='.repeat(80));

const order = await prisma.order.findFirst({
  where: { orderNumber: '15991' },
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
  console.log('\n❌ Order 15991 not found in database\n');
  await prisma.$disconnect();
  process.exit(0);
}

console.log('\n[ORDER DETAILS]');
console.log(`  Order Number: ${order.orderNumber}`);
console.log(`  Order ID: ${order.orderId}`);
console.log(`  Customer: ${order.customerName || 'N/A'}`);
console.log(`  Email: ${order.customerEmail || 'N/A'}`);
console.log(`  Order Date: ${order.orderDate.toISOString()}`);

console.log('\n[PAYMENT STATUS]');
console.log(`  Payment Status: ${order.paymentStatus || 'N/A'}`);
console.log(`  On Hold: ${order.isOnHold}`);
if (order.isOnHold) {
  console.log(`  Hold Reason: ${order.holdReason || 'N/A'}`);
  console.log(`  Hold Placed: ${order.holdPlacedAt?.toISOString() || 'N/A'}`);
}

console.log('\n[ORDER STATUS]');
console.log(`  Order Origin: ${order.orderOrigin || 'N/A'}`);
console.log(`  Order State: ${order.orderState}`);
console.log(`  Fulfillment State: ${order.fulfillmentState || 'N/A'}`);
console.log(`  Is Cancelled: ${order.isCancelled}`);

console.log('\n[FINANCIAL]');
const total = order.total ? parseFloat(order.total.toString()) : 0;
console.log(`  Currency: ${order.currency}`);
console.log(`  Total: €${total.toFixed(2)}`);
console.log(`  Subtotal: €${order.subtotal ? parseFloat(order.subtotal.toString()).toFixed(2) : '0.00'}`);
console.log(`  Shipping Cost: €${order.shippingCost ? parseFloat(order.shippingCost.toString()).toFixed(2) : '0.00'}`);

console.log('\n[FFN SYNC STATUS]');
console.log(`  JTL Outbound ID: ${order.jtlOutboundId || 'Not synced'}`);
console.log(`  Sync Status: ${order.syncStatus || 'N/A'}`);
console.log(`  Last JTL Sync: ${order.lastJtlSync?.toISOString() || 'Never'}`);
if (order.ffnSyncError) {
  console.log(`  Sync Error: ${order.ffnSyncError}`);
}

console.log('\n[ORDER ITEMS]');
console.log(`  Total Items: ${order.items?.length || 0}`);
if (order.items && order.items.length > 0) {
  order.items.forEach((item, idx) => {
    console.log(`  ${idx + 1}. ${item.productName || 'N/A'}`);
    console.log(`     SKU: ${item.sku || 'N/A'}`);
    console.log(`     Quantity: ${item.quantity}`);
    console.log(`     Unit Price: €${item.unitPrice ? parseFloat(item.unitPrice.toString()).toFixed(2) : '0.00'}`);
    console.log(`     Total: €${item.totalPrice ? parseFloat(item.totalPrice.toString()).toFixed(2) : '0.00'}`);
    if (item.product) {
      console.log(`     Product ID: ${item.product.id}`);
      console.log(`     JTL Product ID: ${item.product.jtlProductId || 'Not synced'}`);
    }
  });
}

console.log('\n[CHANNEL & CLIENT]');
console.log(`  Channel Type: ${order.channel?.type || 'N/A'}`);
console.log(`  Channel Name: ${order.channel?.name || 'N/A'}`);
console.log(`  Client ID: ${order.clientId}`);
console.log(`  Has JTL Config: ${order.client?.jtlConfig?.isActive ? 'Yes' : 'No'}`);

console.log('\n[SHIPPING]');
console.log(`  Shipping Method: ${order.shippingMethod || 'N/A'}`);
console.log(`  Shipping Method Code: ${order.shippingMethodCode || 'N/A'}`);
console.log(`  JTL Shipping Method ID: ${order.jtlShippingMethodId || 'Not mapped'}`);
console.log(`  Address: ${order.shippingAddress1 || 'N/A'}`);
console.log(`  City: ${order.shippingCity || 'N/A'}, ${order.shippingZip || 'N/A'}`);
console.log(`  Country: ${order.shippingCountryCode || order.shippingCountry || 'N/A'}`);

// Check for blockers
console.log('\n' + '='.repeat(80));
console.log('BLOCKER ANALYSIS');
console.log('='.repeat(80));

const blockers = [];
const warnings = [];

// Payment hold check
if (order.isOnHold) {
  if (order.holdReason === 'AWAITING_PAYMENT') {
    blockers.push(`Payment hold active - ${order.holdReason}`);
  } else {
    blockers.push(`Order on hold - ${order.holdReason || 'unknown reason'}`);
  }
}

// Payment status check
const allowedPaymentStatuses = ['paid', 'completed', 'processing', 'refunded', 'partially_refunded', 'authorized', 'partially_paid'];
const paymentStatus = (order.paymentStatus || '').toLowerCase();
if (!paymentStatus || !allowedPaymentStatuses.includes(paymentStatus)) {
  blockers.push(`Invalid payment status: "${order.paymentStatus || 'null'}"`);
}

// Order origin check
if (!order.orderOrigin || order.orderOrigin === 'N/A') {
  warnings.push('Missing orderOrigin');
}

// Already synced check
if (order.jtlOutboundId) {
  warnings.push(`Already synced to FFN: ${order.jtlOutboundId}`);
}

// Sync error check
if (order.ffnSyncError) {
  warnings.push(`Previous sync error: ${order.ffnSyncError}`);
}

// JTL config check
if (!order.client?.jtlConfig?.isActive) {
  blockers.push('No active JTL FFN configuration');
}

// Items check
if (!order.items || order.items.length === 0) {
  blockers.push('No order items');
} else {
  const noSku = order.items.filter(i => !i.sku).length;
  if (noSku > 0) {
    warnings.push(`${noSku} items missing SKU`);
  }
}

// Cancelled check
if (order.isCancelled) {
  blockers.push('Order is cancelled');
}

// Total amount check
if (total === 0) {
  warnings.push('Order total is €0.00');
}

if (blockers.length === 0 && warnings.length === 0) {
  console.log('\n✅ No blockers found - Order is ready to sync!\n');
} else {
  if (blockers.length > 0) {
    console.log(`\n🚫 BLOCKERS (${blockers.length}):`);
    blockers.forEach(b => console.log(`   - ${b}`));
  }
  if (warnings.length > 0) {
    console.log(`\n⚠️  WARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }
  console.log('');
}

await prisma.$disconnect();
