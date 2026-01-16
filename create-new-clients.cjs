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
    console.log('🌱 Creating 3 new clients...\n');

    // Hash password for all users
    const password = await bcrypt.hash('password123', 10);

    const newClientsData = [
      {
        email: 'michael.braun@example.com',
        name: 'Michael Braun',
        companyName: 'Braun Electronics GmbH',
        phone: '+49 69 99887766',
        address: 'Mainzer Landstr. 100, 60327 Frankfurt',
      },
      {
        email: 'anna.schneider@example.com',
        name: 'Anna Schneider',
        companyName: 'Schneider Sports Shop',
        phone: '+49 221 55443322',
        address: 'Hohenzollernring 50, 50672 Köln',
      },
      {
        email: 'peter.fischer@example.com',
        name: 'Peter Fischer',
        companyName: 'Fischer Home & Garden',
        phone: '+49 711 33221100',
        address: 'Königstraße 28, 70173 Stuttgart',
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

    console.log('✨ Successfully created 3 new clients!\n');
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
