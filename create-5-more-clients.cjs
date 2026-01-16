require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function createClients() {
  try {
    console.log('🌱 Creating 5 more new clients...\n');

    // Hash password for all users
    const password = await bcrypt.hash('password123', 10);

    const newClientsData = [
      {
        email: 'julia.hoffmann@example.com',
        name: 'Julia Hoffmann',
        companyName: 'Hoffmann Beauty & Cosmetics',
        phone: '+49 30 66554433',
        address: 'Kurfürstendamm 45, 10719 Berlin',
      },
      {
        email: 'markus.klein@example.com',
        name: 'Markus Klein',
        companyName: 'Klein Tech Solutions',
        phone: '+49 89 77665544',
        address: 'Leopoldstraße 88, 80802 München',
      },
      {
        email: 'sabine.wolf@example.com',
        name: 'Sabine Wolf',
        companyName: 'Wolf Fashion Boutique',
        phone: '+49 40 22334455',
        address: 'Jungfernstieg 12, 20095 Hamburg',
      },
      {
        email: 'christian.becker@example.com',
        name: 'Christian Becker',
        companyName: 'Becker Outdoor & Camping',
        phone: '+49 711 99887766',
        address: 'Königsallee 55, 70173 Stuttgart',
      },
      {
        email: 'stefanie.schulz@example.com',
        name: 'Stefanie Schulz',
        companyName: 'Schulz Kids & Toys',
        phone: '+49 221 44332211',
        address: 'Schildergasse 77, 50667 Köln',
      },
    ];

    for (const clientData of newClientsData) {
      console.log(`Creating client: ${clientData.companyName}...`);

      const user = await prisma.user.upsert({
        where: { email: clientData.email },
        update: {},
        create: {
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

    console.log('✨ Successfully created 5 more new clients!\n');
    console.log('Login credentials for all new clients:');
    console.log('Password: password123\n');
    
    newClientsData.forEach(client => {
      console.log(`${client.companyName}:`);
      console.log(`  Email: ${client.email}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error creating clients:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

createClients();
