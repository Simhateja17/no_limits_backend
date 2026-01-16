require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function resetDatabase() {
  try {
    console.log('🗑️  RESETTING DATABASE - DELETING ALL DATA...\n');

    // Delete in order to avoid foreign key constraints
    console.log('Step 1: Deleting order items...');
    await prisma.orderItem.deleteMany({});
    console.log('   ✅ Deleted all order items\n');

    console.log('Step 2: Deleting orders...');
    await prisma.order.deleteMany({});
    console.log('   ✅ Deleted all orders\n');

    console.log('Step 3: Deleting returns...');
    await prisma.return.deleteMany({});
    console.log('   ✅ Deleted all returns\n');

    console.log('Step 4: Deleting products...');
    await prisma.product.deleteMany({});
    console.log('   ✅ Deleted all products\n');

    console.log('Step 5: Deleting sync jobs...');
    await prisma.syncJob.deleteMany({});
    console.log('   ✅ Deleted all sync jobs\n');

    console.log('Step 6: Deleting JTL configs...');
    await prisma.jtlConfig.deleteMany({});
    console.log('   ✅ Deleted all JTL configs\n');

    console.log('Step 7: Deleting channels...');
    await prisma.channel.deleteMany({});
    console.log('   ✅ Deleted all channels\n');

    console.log('Step 8: Deleting chat messages...');
    await prisma.chatMessage.deleteMany({});
    console.log('   ✅ Deleted all chat messages\n');

    console.log('Step 9: Deleting tasks...');
    await prisma.task.deleteMany({});
    console.log('   ✅ Deleted all tasks\n');

    console.log('Step 10: Deleting clients...');
    await prisma.client.deleteMany({});
    console.log('   ✅ Deleted all clients\n');

    console.log('Step 11: Deleting users...');
    await prisma.user.deleteMany({});
    console.log('   ✅ Deleted all users\n');

    console.log('═══════════════════════════════════════════════════════');
    console.log('✨ DATABASE RESET COMPLETE!');
    console.log('═══════════════════════════════════════════════════════');
    console.log('\n📊 All tables have been cleared.');
    console.log('🔄 Database is now empty and ready for fresh data.\n');

  } catch (error) {
    console.error('❌ Error during database reset:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

resetDatabase();
