import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const connectionString = process.env.DATABASE_URL || '';

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function checkDuplicateChannels() {
  console.log('🔍 Checking for duplicate Shopify channels...\n');

  try {
    // Get all Shopify channels
    const shopifyChannels = await prisma.channel.findMany({
      where: {
        type: 'SHOPIFY'
      },
      include: {
        client: {
          select: {
            name: true,
            email: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    console.log(`Found ${shopifyChannels.length} Shopify channel(s)\n`);

    // Group by shopDomain and clientId to find duplicates
    const groupedByDomain: Record<string, typeof shopifyChannels> = {};

    for (const channel of shopifyChannels) {
      const key = `${channel.shopDomain}_${channel.clientId}`;
      if (!groupedByDomain[key]) {
        groupedByDomain[key] = [];
      }
      groupedByDomain[key].push(channel);
    }

    // Find duplicates
    const duplicates = Object.entries(groupedByDomain).filter(([_, channels]) => channels.length > 1);

    if (duplicates.length > 0) {
      console.log('❌ DUPLICATES FOUND:\n');
      for (const [key, channels] of duplicates) {
        console.log(`Shop Domain: ${channels[0].shopDomain}`);
        console.log(`Client: ${channels[0].client.name} (${channels[0].client.email})`);
        console.log(`Number of duplicate entries: ${channels.length}\n`);

        channels.forEach((ch, index) => {
          console.log(`  [${index + 1}] ID: ${ch.id}`);
          console.log(`      Name: ${ch.name}`);
          console.log(`      Status: ${ch.status}`);
          console.log(`      Auth Method: ${ch.authMethod || 'not set'}`);
          console.log(`      Created At: ${ch.createdAt}`);
          console.log(`      Has Access Token: ${ch.accessToken ? 'Yes' : 'No'}`);
          console.log('');
        });
      }
    } else {
      console.log('✅ No duplicates found!');
    }

    // List all channels for reference
    console.log('\n📋 All Shopify Channels:');
    console.log('─'.repeat(80));
    shopifyChannels.forEach((ch, index) => {
      console.log(`${index + 1}. ${ch.name}`);
      console.log(`   ID: ${ch.id}`);
      console.log(`   Shop Domain: ${ch.shopDomain}`);
      console.log(`   Client: ${ch.client.name}`);
      console.log(`   Status: ${ch.status}`);
      console.log(`   Created: ${ch.createdAt}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

checkDuplicateChannels();