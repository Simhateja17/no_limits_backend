require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function createThreeClients() {
  try {
    console.log('🌱 Creating 3 new clients (skips existing emails)...\n');

    const password = await bcrypt.hash('password123', 10);

    const clients = [
      { email: 'lena.schmid@example.com', name: 'Lena Schmid', companyName: 'Schmid Delights', phone: '+49 30 11112222', address: 'Karl-Liebknecht-Straße 1, 10178 Berlin' },
      { email: 'markus.kruger@example.com', name: 'Markus Krüger', companyName: 'Krüger Parts', phone: '+49 40 22223333', address: 'Neuer Wall 12, 20354 Hamburg' },
      { email: 'sofia.bauer@example.com', name: 'Sofia Bauer', companyName: 'Bauer Cosmetics', phone: '+49 89 33334444', address: 'Theresienstraße 30, 80333 München' },
    ];

    let created = 0;
    for (const c of clients) {
      const existing = await prisma.user.findFirst({ where: { email: c.email } });
      if (existing) {
        console.log(`⚠️ Skipping existing user: ${c.email}`);
        continue;
      }

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
    console.error('❌ Error creating clients:', err);
    throw err;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

createThreeClients();
