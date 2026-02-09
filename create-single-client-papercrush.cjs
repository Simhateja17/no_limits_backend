#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function createSingleClient() {
  try {
    console.log('🌱 Creating a new client account...\n');

    const email = 'info@papercrush.de';
    const password = '4$%"§efsdfge';
    const name = 'Papercrush';
    const companyName = 'Papercrush';

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      console.log(`⚠️ User with email ${email} already exists!`);
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user and client in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create user account
      const user = await tx.user.create({
        data: {
          email,
          name,
          password: hashedPassword,
          role: 'CLIENT',
          isActive: true,
        },
      });

      // Create client profile
      const client = await tx.client.create({
        data: {
          userId: user.id,
          name,
          companyName,
          email,
          isActive: true,
        },
      });

      return { user, client };
    });

    console.log('✅ Client account created successfully!\n');
    console.log('Account Details:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Email: ${result.user.email}`);
    console.log(`Password: ${password}`);
    console.log(`Name: ${result.user.name}`);
    console.log(`Company: ${result.client.companyName}`);
    console.log(`Role: ${result.user.role}`);
    console.log(`User ID: ${result.user.id}`);
    console.log(`Client ID: ${result.client.id}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (err) {
    console.error('❌ Error creating client:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

createSingleClient();
