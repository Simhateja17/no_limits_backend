import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { JTLOrderSyncService } from './src/services/integrations/jtl-order-sync.service.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const jtlOrderSyncService = new JTLOrderSyncService(prisma);

console.log('Retrying failed order 15984...\n');

const order = await prisma.order.findFirst({
  where: { orderNumber: '15984' }
});

if (!order) {
  console.log('Order not found!');
  process.exit(1);
}

// Clear the error first
await prisma.order.update({
  where: { id: order.id },
  data: { ffnSyncError: null }
});

const result = await jtlOrderSyncService.syncOrderToFFN(order.id);

if (result.success) {
  console.log(`✅ SUCCESS! Order 15984 synced to FFN`);
  console.log(`   FFN Order ID: ${result.outboundId}`);
} else {
  console.log(`❌ FAILED: ${result.error}`);
}

await prisma.$disconnect();
