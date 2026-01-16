require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function cleanupAndCreateFourClients() {
  try {
    console.log('🧹 Starting cleanup of client-related data and creation of 4 clients...\n');

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

    // Create 4 new clients
    console.log('🌱 Creating 4 new clients...\n');

    const password = await bcrypt.hash('password123', 10);

    const clients = [
      {
        email: 'nora.schneider@example.com',
        name: 'Nora Schneider',
        companyName: 'Schneider Interiors',
        phone: '+49 30 44445555',
        address: 'Kurfürstendamm 10, 10719 Berlin',
      },
      {
        email: 'julian.bauer@example.com',
        name: 'Julian Bauer',
        companyName: 'Bauer Electronics',
        phone: '+49 40 55556666',
        address: 'Reeperbahn 20, 20359 Hamburg',
      },
      {
        email: 'ida.freitag@example.com',
        name: 'Ida Freitag',
        companyName: 'Freitag Tools',
        phone: '+49 89 66667777',
        address: 'Sendlinger Str. 30, 80331 München',
      },
      {
        email: 'oliver.neumann@example.com',
        name: 'Oliver Neumann',
        companyName: 'Neumann Prints',
        phone: '+49 69 77778888',
        address: 'Zeil 20, 60313 Frankfurt am Main',
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

cleanupAndCreateFourClients();
