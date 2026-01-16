/**
 * Script to clean up shopDomain fields in the database by trimming whitespace
 * Run this once to fix existing data
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not defined!');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function fixShopifyDomains() {
  try {
    console.log('Starting shopDomain cleanup...');

    // Get all channels with shopDomain
    const channels = await prisma.channel.findMany({
      where: {
        shopDomain: {
          not: null,
        },
      },
      select: {
        id: true,
        shopDomain: true,
        url: true,
      },
    });

    console.log(`Found ${channels.length} channels with shopDomain`);

    let updatedCount = 0;

    for (const channel of channels) {
      if (!channel.shopDomain) continue;

      const trimmedDomain = channel.shopDomain.trim();

      // Check if trimming made a difference
      if (trimmedDomain !== channel.shopDomain) {
        console.log(`Fixing channel ${channel.id}: "${channel.shopDomain}" -> "${trimmedDomain}"`);

        await prisma.channel.update({
          where: { id: channel.id },
          data: {
            shopDomain: trimmedDomain,
            url: `https://${trimmedDomain}`,
          },
        });

        updatedCount++;
      }
    }

    console.log(`✅ Cleanup complete! Updated ${updatedCount} channels.`);
  } catch (error) {
    console.error('Error fixing shopDomain fields:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
fixShopifyDomains()
  .then(() => {
    console.log('Script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
