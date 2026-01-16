require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function cleanupAndCreateClients() {
  try {
    console.log('🧹 Starting database cleanup and client creation...\n');

    // Step 1: Clean all products, orders, and returns
    console.log('🗑️  Deleting all products, orders, and returns...');
    
    await prisma.orderItem.deleteMany({});
    console.log('   ✅ Deleted all order items');
    
    await prisma.order.deleteMany({});
    console.log('   ✅ Deleted all orders');
    
    await prisma.return.deleteMany({});
    console.log('   ✅ Deleted all returns');
    
    await prisma.product.deleteMany({});
    console.log('   ✅ Deleted all products\n');

    // Step 2: Delete ALL existing clients
    console.log('🗑️  Deleting all existing clients...');
    
    // Delete all sync jobs
    await prisma.syncJob.deleteMany({});
    console.log('   ✅ Deleted all sync jobs');

    // Delete all JTL configs
    await prisma.jtlConfig.deleteMany({});
    console.log('   ✅ Deleted all JTL configs');

    // Delete all channels
    await prisma.channel.deleteMany({});
    console.log('   ✅ Deleted all channels');

    // Delete all chat messages (to avoid foreign key constraint)
    await prisma.chatMessage.deleteMany({});
    console.log('   ✅ Deleted all chat messages');

    // Delete all users with CLIENT role
    const deletedUsers = await prisma.user.deleteMany({
      where: { role: 'CLIENT' },
    });
    console.log(`   ✅ Deleted ${deletedUsers.count} client users`);

    // Delete all clients
    const deletedClients = await prisma.client.deleteMany({});
    console.log(`   ✅ Deleted ${deletedClients.count} clients\n`);

    // Step 3: Create 3 new clients
    console.log('🌱 Creating 3 new clients...\n');

    const password = await bcrypt.hash('password123', 10);

    const newClientsData = [
      {
        email: 'anna.mueller@example.com',//tested
        name: 'Anna Müller',
        companyName: 'Müller Naturkosmetik',
        phone: '+49 30 12345678',
        address: 'Friedrichstraße 123, 10117 Berlin',
      },
      {
        email: 'thomas.schmidt@example.com', //tested
        name: 'Thomas Schmidt',
        companyName: 'Schmidt Sport & Fitness',
        phone: '+49 89 98765432',
        address: 'Maximilianstraße 45, 80539 München',
      },
      {
        email: 'lisa.weber@example.com', //tested
        name: 'Lisa Weber',
        companyName: 'Weber Home & Living',
        phone: '+49 40 55667788',
        address: 'Mönckebergstraße 78, 20095 Hamburg',
      },
      {
        email: 'robin.meier@example.com',
        name: 'Robin Meier',
        companyName: 'Meier Logistics',
        phone: '+49 40 44445555',
        address: 'Grosse Elbstraße 9, 20457 Hamburg',
      },
      {
        email: 'sophia.koch@example.com',
        name: 'Sophia Koch',
        companyName: 'Koch Baby Boutique',
        phone: '+49 30 55556666',
        address: 'Alt-Tegel 3, 13507 Berlin',
      },
      {
        email: 'maximilian.bauer@example.com',
        name: 'Maximilian Bauer',
        companyName: 'Bauer Tools',
        phone: '+49 89 66667777',
        address: 'Gärtnerplatz 4, 80331 München',
      },
      {
        email: 'emilia.konrad@example.com',
        name: 'Emilia Konrad',
        companyName: 'Konrad Books',
        phone: '+49 30 77778888',
        address: 'Prenzlauer Allee 21, 10405 Berlin',
      },
      {
        email: 'kolja.reuter@example.com',
        name: 'Kolja Reuter',
        companyName: 'Reuter Electronics',
        phone: '+49 69 88889999',
        address: 'Zeil 10, 60313 Frankfurt am Main',
      },
      {
        email: 'martina.schulz@example.com',
        name: 'Martina Schulz',
        companyName: 'Schulz Foods',
        phone: '+49 351 99990011',
        address: 'Altmarkt 2, 01067 Dresden',
      },
      {
        email: 'olga.nowak@example.com',
        name: 'Olga Nowak',
        companyName: 'Nowak Imports',
        phone: '+49 228 10101010',
        address: 'Universitätsstraße 8, 53113 Bonn',
      },
    ];

    for (const clientData of newClientsData) {
      console.log(`Creating client: ${clientData.companyName}...`);

      const user = await prisma.user.create({
        data: {
          email: clientData.email,
          password,
          name: clientData.name,
          role: 'CLIENT',
          phone: clientData.phone,
          isActive: true,
          client: {
            create: {
              name: clientData.name,
              companyName: clientData.companyName,
              email: clientData.email,
              phone: clientData.phone,
              address: clientData.address,
              isActive: true,
            },
          },
        },
      });

      console.log(`✅ Created user: ${user.email}`);
      console.log(`   Company: ${clientData.companyName}`);
      console.log(`   Name: ${clientData.name}`);
      console.log('');
    }

    console.log('✨ Database cleanup and client creation completed!\n');
    console.log('📋 Summary:');
    console.log(`   - Deleted all existing clients`);
    console.log(`   - Created ${newClientsData.length} new clients\n`);
    
    console.log('🔑 Login credentials for all new clients:');
    console.log('   Password: password123\n');
    
    newClientsData.forEach(client => {
      console.log(`${client.companyName}:`);
      console.log(`  Email: ${client.email}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error during cleanup and creation:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

cleanupAndCreateClients();
