require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function createAdminAndEmployee() {
  try {
    console.log('🌱 Creating admin and employee accounts...\n');

    // Hash password for all users
    const password = await bcrypt.hash('password123', 10);

    // Create ADMIN account
    console.log('Creating ADMIN account...');
    const admin = await prisma.user.upsert({
      where: { email: 'admin@nolimits.com' },
      update: {},
      create: {
        email: 'admin@nolimits.com',
        password,
        name: 'Admin User',
        role: 'ADMIN',
        phone: '+49 30 12345678',
        isActive: true,
      },
    });
    console.log(`✅ Created ADMIN: ${admin.email}`);
    console.log(`   Name: ${admin.name}`);
    console.log(`   Role: ${admin.role}`);
    console.log('');

    // Create EMPLOYEE account
    console.log('Creating EMPLOYEE account...');
    const employee = await prisma.user.upsert({
      where: { email: 'employee@nolimits.com' },
      update: {},
      create: {
        email: 'employee@nolimits.com',
        password,
        name: 'Warehouse Employee',
        role: 'EMPLOYEE',
        phone: '+49 30 87654321',
        employeeId: 'EMP-001',
        isActive: true,
      },
    });
    console.log(`✅ Created EMPLOYEE: ${employee.email}`);
    console.log(`   Name: ${employee.name}`);
    console.log(`   Role: ${employee.role}`);
    console.log(`   Employee ID: ${employee.employeeId}`);
    console.log('');

    console.log('✨ Successfully created admin and employee accounts!\n');
    console.log('Login credentials:');
    console.log('Password: password123\n');
    console.log('ADMIN:');
    console.log('  Email: admin@nolimits.com');
    console.log('');
    console.log('EMPLOYEE:');
    console.log('  Email: employee@nolimits.com');
    console.log('');

  } catch (error) {
    console.error('❌ Error creating accounts:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

createAdminAndEmployee();
