#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const channelId = process.argv[2] || 'cmki27ce80002mhs7j2h1ylb4';

async function main() {
  console.log(`\n🔍 Checking products in Shopify channel: ${channelId}\n`);

  // Get channel info
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: { client: true }
  });

  if (!channel) {
    console.log('❌ Channel not found!');
    return;
  }

  console.log(`📦 Channel: ${channel.name}`);
  console.log(`   Client: ${channel.client.name}`);
  console.log(`   Shop: ${channel.shopDomain}`);
  console.log('');

  // Get products linked to this channel
  const productChannels = await prisma.productChannel.findMany({
    where: { channelId },
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          netSalesPrice: true,
          available: true,
          isBundle: true,
          isActive: true
        }
      }
    },
    orderBy: { lastSyncAt: 'desc' },
    take: 20
  });

  if (productChannels.length === 0) {
    console.log('❌ No products found in this channel.');
    console.log('\n💡 Suggestion: Run a product sync first to import products from Shopify');
    return;
  }

  console.log(`✅ Found ${productChannels.length} products:\n`);

  productChannels.forEach((pc, idx) => {
    const p = pc.product;
    console.log(`${idx + 1}. ${p.name}`);
    console.log(`   SKU: ${p.sku}`);
    console.log(`   External ID: ${pc.externalProductId}`);
    console.log(`   Price: €${p.netSalesPrice || 'N/A'}`);
    console.log(`   Stock: ${p.available || 0}`);
    console.log(`   Bundle: ${p.isBundle ? 'Yes' : 'No'}`);
    console.log(`   Active: ${p.isActive ? 'Yes' : 'No'}`);
    console.log(`   Last Sync: ${pc.lastSyncAt?.toISOString() || 'Never'}`);
    console.log('');
  });

  // Suggest products for bundling
  const nonBundleProducts = productChannels
    .filter(pc => !pc.product.isBundle && pc.product.isActive)
    .slice(0, 5);

  if (nonBundleProducts.length >= 2) {
    console.log('\n💡 Suggested Products for Bundle Creation:');
    console.log('   (Pick 2-3 of these to create a realistic bundle)\n');

    nonBundleProducts.forEach((pc, idx) => {
      const p = pc.product;
      console.log(`   ${idx + 1}. ${p.name} (SKU: ${p.sku})`);
      console.log(`      External ID: ${pc.externalProductId}`);
      console.log(`      Price: €${p.netSalesPrice || 'N/A'}`);
    });

    console.log('\n📋 Next Steps:');
    console.log('   1. Copy the External IDs of 2-3 products you want to bundle');
    console.log('   2. I will create a bundle webhook with those products as components');
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
