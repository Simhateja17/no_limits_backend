import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

/**
 * Script to remove duplicate Shopify channels
 *
 * This script:
 * 1. Finds all duplicate channels (same clientId + shopDomain + type)
 * 2. For each duplicate group, keeps the most recently updated channel
 * 3. Migrates orders and products to the kept channel
 * 4. Deletes duplicate channels
 *
 * Run with: npx tsx backend/scripts/remove-duplicate-channels.ts
 */

interface DuplicateGroup {
  clientId: string;
  shopDomain: string;
  type: string;
  channels: Array<{
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    status: string;
    isActive: boolean;
  }>;
}

async function main() {
  console.log('🔍 Starting duplicate channel cleanup...\n');

  // Initialize Prisma with pg adapter (Prisma 7 requirement)
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL not found in environment');
  }

  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    // Find all channels grouped by clientId, shopDomain, and type
    const allChannels = await prisma.channel.findMany({
      select: {
        id: true,
        clientId: true,
        shopDomain: true,
        type: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        status: true,
        isActive: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    // Group channels by clientId + shopDomain + type
    const channelGroups = new Map<string, DuplicateGroup>();

    for (const channel of allChannels) {
      if (!channel.shopDomain) continue; // Skip channels without shop domain

      const key = `${channel.clientId}|${channel.shopDomain.toLowerCase().trim()}|${channel.type}`;

      if (!channelGroups.has(key)) {
        channelGroups.set(key, {
          clientId: channel.clientId,
          shopDomain: channel.shopDomain,
          type: channel.type,
          channels: [],
        });
      }

      channelGroups.get(key)!.channels.push({
        id: channel.id,
        name: channel.name,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
        status: channel.status,
        isActive: channel.isActive,
      });
    }

    // Filter to only groups with duplicates
    const duplicateGroups = Array.from(channelGroups.values()).filter(
      (group) => group.channels.length > 1
    );

    if (duplicateGroups.length === 0) {
      console.log('✅ No duplicate channels found! Database is clean.\n');
      return;
    }

    console.log(`⚠️  Found ${duplicateGroups.length} duplicate channel groups:\n`);

    // Process each duplicate group
    let totalRemoved = 0;
    let totalOrdersMigrated = 0;
    let totalProductsMigrated = 0;

    for (const group of duplicateGroups) {
      console.log(`\n📦 Processing duplicates for: ${group.shopDomain} (${group.type})`);
      console.log(`   Client ID: ${group.clientId}`);
      console.log(`   Found ${group.channels.length} duplicate channels:\n`);

      // Sort by updatedAt descending (most recent first)
      const sortedChannels = group.channels.sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
      );

      // Keep the most recently updated channel
      const keepChannel = sortedChannels[0];
      const removeChannels = sortedChannels.slice(1);

      console.log(`   ✅ KEEPING: ${keepChannel.id}`);
      console.log(`      Name: ${keepChannel.name}`);
      console.log(`      Status: ${keepChannel.status}`);
      console.log(`      Active: ${keepChannel.isActive}`);
      console.log(`      Created: ${keepChannel.createdAt.toISOString()}`);
      console.log(`      Updated: ${keepChannel.updatedAt.toISOString()}\n`);

      // Migrate data from duplicates to kept channel
      for (const removeChannel of removeChannels) {
        console.log(`   ❌ REMOVING: ${removeChannel.id}`);
        console.log(`      Name: ${removeChannel.name}`);
        console.log(`      Created: ${removeChannel.createdAt.toISOString()}`);
        console.log(`      Updated: ${removeChannel.updatedAt.toISOString()}`);

        // Migrate orders
        const ordersToMigrate = await prisma.order.count({
          where: { channelId: removeChannel.id },
        });

        if (ordersToMigrate > 0) {
          await prisma.order.updateMany({
            where: { channelId: removeChannel.id },
            data: { channelId: keepChannel.id },
          });
          console.log(`      → Migrated ${ordersToMigrate} orders`);
          totalOrdersMigrated += ordersToMigrate;
        }

        // Migrate products (ProductChannel many-to-many relationships)
        const productsToMigrate = await prisma.productChannel.count({
          where: { channelId: removeChannel.id },
        });

        if (productsToMigrate > 0) {
          await prisma.productChannel.updateMany({
            where: { channelId: removeChannel.id },
            data: { channelId: keepChannel.id },
          });
          console.log(`      → Migrated ${productsToMigrate} product-channel relationships`);
          totalProductsMigrated += productsToMigrate;
        }

        // Delete the duplicate channel
        await prisma.channel.delete({
          where: { id: removeChannel.id },
        });

        console.log(`      → Channel deleted\n`);
        totalRemoved++;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ CLEANUP COMPLETE!\n');
    console.log(`   Duplicate groups processed: ${duplicateGroups.length}`);
    console.log(`   Channels removed: ${totalRemoved}`);
    console.log(`   Orders migrated: ${totalOrdersMigrated}`);
    console.log(`   Products migrated: ${totalProductsMigrated}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
