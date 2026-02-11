import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { JTLOrderSyncService } from '../src/services/integrations/jtl-order-sync.service.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const jtlOrderSyncService = new JTLOrderSyncService(prisma);

async function main() {
  console.log('='.repeat(80));
  console.log('Retrying Order 15984');
  console.log('='.repeat(80));

  const order = await prisma.order.findFirst({
    where: { orderNumber: '15984' }
  });

  if (!order) {
    console.log('❌ Order 15984 not found!');
    return;
  }

  console.log(`\nOrder: ${order.orderNumber} (${order.customerName || 'N/A'})`);
  console.log(`Current Status: ${order.syncStatus}`);
  console.log(`Current Error: ${order.ffnSyncError || 'None'}\n`);

  // Clear previous error
  await prisma.order.update({
    where: { id: order.id },
    data: { ffnSyncError: null, syncStatus: 'PENDING' }
  });

  console.log('Attempting sync...');
  const startTime = Date.now();
  const result = await jtlOrderSyncService.syncOrderToFFN(order.id);
  const duration = Date.now() - startTime;

  console.log('');
  if (result.success) {
    console.log(`✅ SUCCESS! Order 15984 synced to JTL FFN`);
    console.log(`   FFN Outbound ID: ${result.outboundId}`);
    console.log(`   Sync Time: ${duration}ms`);
  } else {
    console.log(`❌ FAILED: ${result.error}`);
    console.log(`   Duration: ${duration}ms`);
  }
}

main()
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
