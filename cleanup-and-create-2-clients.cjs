require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function cleanupAndCreateTwoClients() {
  try {
    console.log('🧹 Starting cleanup of client-related data and creation of 2 clients...\n');

    // Remove operational data that belongs to clients
    console.log('🗑️  Deleting products, orders, returns and related items...');
    await prisma.orderItem.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.return.deleteMany({});
    await prisma.product.deleteMany({});
    console.log('   ✅ Deleted product/order/return related data\n');

    // Delete client-related configuration and channels
    console.log('🗑️  Deleting client-specific configs, channels, chats and sync jobs...');
    await prisma.syncJob.deleteMany({});
    await prisma.jtlConfig.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.chatMessage.deleteMany({});
    await prisma.chatParticipant.deleteMany({});
    await prisma.chatRoom.deleteMany({});
    console.log('   ✅ Deleted sync jobs, JTL configs, channels and chat data\n');

    // Delete all CLIENT users and clients
    console.log('🗑️  Deleting all CLIENT users and clients...');
    const deletedUsers = await prisma.user.deleteMany({ where: { role: 'CLIENT' } });
    console.log(`   ✅ Deleted ${deletedUsers.count} client users`);

    const deletedClients = await prisma.client.deleteMany({});
    console.log(`   ✅ Deleted ${deletedClients.count} clients\n`);

    // Create 2 new clients
    console.log('🌱 Creating 2 new clients...\n');

    const password = await bcrypt.hash('password123', 10);

    const clients = [
      {
        email: 'lena.schmid@example.com',
        name: 'Lena Schmid',
        companyName: 'Schmid Delights',
        phone: '+49 30 11112222',
        address: 'Karl-Liebknecht-Straße 1, 10178 Berlin',
      },
      {
        email: 'markus.kruger@example.com',
        name: 'Markus Krüger',
        companyName: 'Krüger Parts',
        phone: '+49 40 22223333',
        address: 'Neuer Wall 12, 20354 Hamburg',
      },
    ];

    let created = 0;
    for (const c of clients) {
      console.log(`Creating client: ${c.companyName}...`);
      const user = await prisma.user.create({
        data: {
          email: c.email,
          password,
          name: c.name,
          role: 'CLIENT',
          phone: c.phone,
          isActive: true,
          client: {
            create: {
              name: c.name,
              companyName: c.companyName,
              email: c.email,
              phone: c.phone,
              address: c.address,
              isActive: true,
            },
          },
        },
      });
      console.log(`✅ Created user: ${user.email} (${c.companyName})`);
      created++;
    }

    console.log(`\n✨ Done. Created ${created} new clients. Password for each: password123`);

  } catch (err) {
    console.error('❌ Error during cleanup and create:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

cleanupAndCreateTwoClients();
