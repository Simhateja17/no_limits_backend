import { PrismaClient, OrderStatus } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function mapOrderStatusToPaymentStatus(status: OrderStatus): string | null {
  switch (status) {
    case OrderStatus.PROCESSING:
    case OrderStatus.DELIVERED:
    case OrderStatus.SHIPPED:
    case OrderStatus.PARTIALLY_FULFILLED:
      return 'paid';
    case OrderStatus.CANCELLED:
      return 'refunded';
    case OrderStatus.ON_HOLD:
    case OrderStatus.PENDING:
      return 'pending';
    case OrderStatus.ERROR:
      return 'failed';
    default:
      return null;
  }
}

async function fixWooCommerceOrders() {
  console.log('🔍 Finding WooCommerce channels...\n');

  // Find all WooCommerce channels
  const wooChannels = await prisma.channel.findMany({
    where: { type: 'WOOCOMMERCE' },
    select: { id: true, name: true },
  });

  if (wooChannels.length === 0) {
    console.log('✅ No WooCommerce channels found.');
    return;
  }

  console.log(`Found ${wooChannels.length} WooCommerce channel(s):\n`);
  console.table(wooChannels);

  const channelIds = wooChannels.map(c => c.id);

  // Find orders from WooCommerce channels with SHOPIFY origin
  const ordersToFix = await prisma.order.findMany({
    where: {
      channelId: { in: channelIds },
      orderOrigin: 'SHOPIFY',
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
    },
  });

  console.log(`\n📦 Found ${ordersToFix.length} orders to fix\n`);

  if (ordersToFix.length === 0) {
    console.log('✅ No orders need fixing.');
    return;
  }

  let fixed = 0;

  for (const order of ordersToFix) {
    const newPaymentStatus = mapOrderStatusToPaymentStatus(order.status);

    await prisma.order.update({
      where: { id: order.id },
      data: {
        orderOrigin: 'WOOCOMMERCE',
        paymentStatus: newPaymentStatus,
      },
    });

    fixed++;
  }

  console.log(`\n✅ Fixed ${fixed} orders`);
  console.log('\n📊 Summary:');
  console.log(`   - Changed orderOrigin: SHOPIFY → WOOCOMMERCE`);
  console.log(`   - Updated paymentStatus based on order status`);

  await prisma.$disconnect();
}

fixWooCommerceOrders()
  .then(() => {
    console.log('\n✨ Migration complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
