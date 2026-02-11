import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const orders = await prisma.order.findMany({
  where: {
    orderNumber: { in: ['15990', '15906', '15925', '15926', '15977', '15978', '15979', '15981', '15982', '15984', '15986', '15987', '15989'] }
  },
  select: {
    orderNumber: true,
    customerName: true,
    paymentStatus: true,
    jtlOutboundId: true,
    syncStatus: true,
    ffnSyncError: true,
    total: true
  },
  orderBy: { orderNumber: 'asc' }
});

console.log('\n=== VERIFICATION: Database Order Status ===\n');
orders.forEach(o => {
  const status = o.jtlOutboundId ? '✅ SYNCED' : '❌ NOT SYNCED';
  console.log(`Order ${o.orderNumber} (${o.customerName || 'N/A'}): ${status}`);
  console.log(`  FFN ID: ${o.jtlOutboundId || 'None'}`);
  console.log(`  Status: ${o.syncStatus}`);
  console.log(`  Total: €${o.total ? parseFloat(o.total.toString()).toFixed(2) : '0.00'}`);
  if (o.ffnSyncError) console.log(`  Error: ${o.ffnSyncError}`);
  console.log('');
});

const synced = orders.filter(o => o.jtlOutboundId).length;
console.log(`\nSummary: ${synced}/${orders.length} orders successfully synced to JTL FFN\n`);

await prisma.$disconnect();
