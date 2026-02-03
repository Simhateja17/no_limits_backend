import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function checkData() {
  console.log('\n📊 CHANNELS BY TYPE:\n');
  const channels = await prisma.channel.groupBy({
    by: ['type'],
    _count: true,
  });
  console.table(channels.map(c => ({ Type: c.type, Count: c._count })));

  console.log('\n📊 ORDERS BY ORIGIN:\n');
  const orders = await prisma.order.groupBy({
    by: ['orderOrigin'],
    _count: true,
  });
  console.table(orders.map(o => ({ Origin: o.orderOrigin, Count: o._count })));

  // Check for WooCommerce channels with orders
  const wooChannels = await prisma.channel.findMany({
    where: { type: 'woocommerce' },
    select: { id: true, name: true },
  });

  if (wooChannels.length > 0) {
    console.log('\n📊 WOOCOMMERCE CHANNELS:\n');
    console.table(wooChannels);

    for (const channel of wooChannels) {
      const orderCount = await prisma.order.count({
        where: { channelId: channel.id },
      });
      const ordersByOrigin = await prisma.order.groupBy({
        by: ['orderOrigin'],
        where: { channelId: channel.id },
        _count: true,
      });
      
      console.log(`\n📦 Orders for channel "${channel.name}" (${channel.id}):`);
      console.table(ordersByOrigin.map(o => ({ Origin: o.orderOrigin, Count: o._count })));
    }
  }

  await prisma.$disconnect();
}

checkData().catch(console.error);
