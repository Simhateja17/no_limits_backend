import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function checkClient() {
  try {
    // Find client by email
    const client = await prisma.client.findFirst({
      where: { email: 'peter.becker@example.com' },
      include: {
        channels: {
          where: { type: 'SHOPIFY' },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!client) {
      console.log('❌ Client not found');
      await prisma.$disconnect();
      return;
    }

    console.log('✅ Client found:', client.id, client.name);
    console.log('📊 Shopify channels:', client.channels.length);

    client.channels.forEach((channel, i) => {
      console.log(`\nChannel ${i + 1}:`);
      console.log('  ID:', channel.id);
      console.log('  Shop Domain:', channel.shopDomain);
      console.log('  Status:', channel.status);
      console.log('  Auth Method:', channel.authMethod);
      console.log('  Created:', channel.createdAt);
      console.log('  Has Access Token:', !!channel.accessToken);
    });

    await prisma.$disconnect();
  } catch (error) {
    console.error('Error:', error);
    await prisma.$disconnect();
  }
}

checkClient();
