require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Seeding database...\n');

  try {
    // Hash password for all users
    const password = await bcrypt.hash('password123', 10);

    // Create Super Admin
    const superAdmin = await prisma.user.upsert({
      where: { email: 'superadmin@nolimits.com' },
      update: {},
      create: {
        email: 'superadmin@nolimits.com',
        password,
        name: 'Super Admin',
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });
    console.log('✅ Created Super Admin:', superAdmin.email);

    // Create Admin (Warehouse Owner)
    const admin = await prisma.user.upsert({
      where: { email: 'admin@nolimits.com' },
      update: {},
      create: {
        email: 'admin@nolimits.com',
        password,
        name: 'Admin User',
        role: 'ADMIN',
        isActive: true,
      },
    });
    console.log('✅ Created Admin:', admin.email);

    // Create Warehouse Employee
    const employee = await prisma.user.upsert({
      where: { email: 'employee@nolimits.com' },
      update: {},
      create: {
        email: 'employee@nolimits.com',
        password,
        name: 'Warehouse Employee',
        role: 'EMPLOYEE',
        employeeId: 'EMP-001',
        department: 'Warehouse',
        isActive: true,
      },
    });
    console.log('✅ Created Employee:', employee.email);

    // Create Client Users with associated Client records
    const clientsData = [
      {
        email: 'papercrush@example.com',
        name: 'Max Schmidt',
        companyName: 'Papercrush GmbH',
        phone: '+49 30 12345678',
        address: 'Berliner Str. 123, 10115 Berlin',
      },
      {
        email: 'caobali@example.com',
        name: 'Sarah Mueller',
        companyName: 'Caobali Store',
        phone: '+49 40 87654321',
        address: 'Hafenstr. 456, 20459 Hamburg',
      },
      {
        email: 'terppens@example.com',
        name: 'Thomas Weber',
        companyName: 'Terppens Fashion',
        phone: '+49 89 11223344',
        address: 'Maximilianstr. 789, 80539 München',
      },
    ];

    for (const clientData of clientsData) {
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
              billingStatus: 'PAID',
              isActive: true,
            },
          },
        },
        include: {
          client: true,
        },
      });
      console.log('✅ Created Client:', user.email, '-', user.client?.companyName);
    }

    console.log('\n🎉 Database seeding completed successfully!');
    console.log('\n📝 Test Credentials:');
    console.log('   Super Admin: superadmin@nolimits.com / password123');
    console.log('   Admin:       admin@nolimits.com / password123');
    console.log('   Employee:    employee@nolimits.com / password123');
    console.log('   Client 1:    papercrush@example.com / password123');
    console.log('   Client 2:    caobali@example.com / password123');
    console.log('   Client 3:    terppens@example.com / password123');
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
