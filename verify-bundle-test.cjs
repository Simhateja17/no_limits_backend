#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const sku = process.argv[2] || 'BUNDLE-FAN-PACK';

async function main() {
  console.log(`\n🔍 Verifying Bundle Import for SKU: ${sku}\n`);

  // 1. Check if product was created
  const product = await prisma.product.findFirst({
    where: { sku },
    include: {
      bundleItems: {
        include: {
          childProduct: {
            select: { sku: true, name: true }
          }
        }
      },
      pendingBundleLinks: {
        where: { status: 'pending' }
      },
      channels: {
        include: {
          channel: {
            select: { name: true, type: true }
          }
        }
      }
    }
  });

  if (!product) {
    console.log('❌ Product not found!');
    console.log('\nPossible reasons:');
    console.log('1. Webhook processing failed');
    console.log('2. Server not running');
    console.log('3. Database connection issue');
    return;
  }

  console.log('✅ Product Found!\n');
  console.log(`📦 Product Details:`);
  console.log(`   ID: ${product.id}`);
  console.log(`   SKU: ${product.sku}`);
  console.log(`   Name: ${product.name}`);
  console.log(`   Is Bundle: ${product.isBundle}`);
  console.log(`   Price: €${product.price || 'N/A'}`);
  console.log(`   Created: ${product.createdAt}`);
  console.log('');

  // 2. Check bundle items (resolved components)
  if (product.bundleItems.length > 0) {
    console.log(`✅ Bundle Items (${product.bundleItems.length} resolved):`);
    product.bundleItems.forEach((item, idx) => {
      console.log(`   ${idx + 1}. ${item.childProduct.name} (${item.childProduct.sku})`);
      console.log(`      Quantity: ${item.quantity}`);
    });
    console.log('');
  } else {
    console.log('⚠️  No Bundle Items created yet');
    console.log('   This is expected - components will be fetched on next GraphQL sync\n');
  }

  // 3. Check pending bundle links
  if (product.pendingBundleLinks.length > 0) {
    console.log(`📋 Pending Bundle Links (${product.pendingBundleLinks.length}):`);
    product.pendingBundleLinks.forEach((link, idx) => {
      console.log(`   ${idx + 1}. Waiting for child:`);
      console.log(`      External ID: ${link.childExternalId || 'N/A'}`);
      console.log(`      SKU: ${link.childSku || 'N/A'}`);
      console.log(`      Quantity: ${link.quantity}`);
      console.log(`      Status: ${link.status}`);
    });
    console.log('');
  }

  // 4. Check channels
  if (product.channels.length > 0) {
    console.log(`🔗 Channels (${product.channels.length}):`);
    product.channels.forEach((pc, idx) => {
      console.log(`   ${idx + 1}. ${pc.channel.name} (${pc.channel.type})`);
      console.log(`      External ID: ${pc.externalProductId}`);
    });
    console.log('');
  }

  // 5. Summary
  console.log('📊 Summary:');
  if (product.isBundle) {
    console.log('   ✅ Product correctly marked as bundle');
  } else {
    console.log('   ⚠️  Product NOT marked as bundle (expected if Product Feeds not processed yet)');
  }

  if (product.bundleItems.length > 0) {
    console.log(`   ✅ ${product.bundleItems.length} component(s) linked`);
  } else if (product.pendingBundleLinks.length > 0) {
    console.log(`   ⏳ ${product.pendingBundleLinks.length} component(s) pending (waiting for children)`);
  } else {
    console.log('   ⏳ No components yet (will be fetched on next GraphQL sync)');
  }

  console.log('\n💡 Next Steps:');
  if (!product.isBundle) {
    console.log('   1. Product Feeds webhook marked the product - check logs');
    console.log('   2. Run GraphQL sync to fetch bundle components');
  } else if (product.bundleItems.length === 0 && product.pendingBundleLinks.length === 0) {
    console.log('   1. Bundle detected but no components fetched yet');
    console.log('   2. Run GraphQL sync to fetch bundleComponents details');
    console.log('   3. Command: curl -X POST http://localhost:3001/api/integrations/sync/products/<CHANNEL_ID>');
  } else if (product.pendingBundleLinks.length > 0) {
    console.log('   1. Import child products to resolve pending links');
    console.log('   2. Or run full product sync to import all products');
  } else {
    console.log('   ✅ Bundle fully linked! Ready for JTL BOM sync');
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
