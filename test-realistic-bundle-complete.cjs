#!/usr/bin/env node
/**
 * Complete Realistic Bundle Test
 *
 * This script:
 * 1. Creates a bundle product using Product Feeds webhook (isBundle: true)
 * 2. Simulates component linking by directly calling ProductSyncService with bundle data
 * 3. Verifies BundleItem records are created
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Import ProductSyncService
const { ProductSyncService } = require('./dist/services/integrations/product-sync.service.js');

const channelId = process.argv[2] || 'cmki27ce80002mhs7j2h1ylb4';

async function main() {
  console.log('\n🎁 Complete Realistic Bundle Test');
  console.log('===================================\n');

  // Get channel info
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    include: { client: true }
  });

  if (!channel) {
    console.log('❌ Channel not found!');
    return;
  }

  const clientId = channel.clientId;

  console.log(`📦 Channel: ${channel.name}`);
  console.log(`   Client: ${channel.client.name}`);
  console.log(`   Shop: ${channel.shopDomain}`);
  console.log('');

  // Step 1: Check if child products exist
  console.log('Step 1: Verifying child products exist...\n');

  const childProducts = [
    { sku: 'shirt-1-sku', externalId: '10384018702677', name: 'shirt-1' },
    { sku: 'shirt-2-sku', externalId: '10384019587413', name: 'shirt-2' },
    { sku: 'SHOPIFY-788032119674292900', externalId: '788032119674292900', name: 'Example T-Shirt' },
  ];

  const foundChildren = [];
  for (const child of childProducts) {
    const product = await prisma.product.findFirst({
      where: {
        clientId,
        sku: child.sku
      },
      select: { id: true, sku: true, name: true }
    });

    if (product) {
      console.log(`   ✅ Found: ${product.name} (${product.sku})`);
      foundChildren.push({ ...child, dbId: product.id });
    } else {
      console.log(`   ❌ Missing: ${child.name} (${child.sku})`);
    }
  }

  if (foundChildren.length !== childProducts.length) {
    console.log('\n⚠️  Not all child products exist in database.');
    console.log('   This is OK - PendingBundleLinks will be created instead.');
  }

  console.log('');

  // Step 2: Create/update bundle product with bundleComponents data
  console.log('Step 2: Creating bundle product with component links...\n');

  const productSyncService = new ProductSyncService(prisma);

  const bundleData = {
    externalId: '99999',  // Bundle product ID
    channelId,
    name: 'Premium Shirt Collection Bundle',
    description: 'Complete shirt collection with 2 premium shirts and 2 basic tees',
    sku: 'BUNDLE-PREMIUM-SHIRTS',
    price: 1198.98,
    isActive: true,
    productType: 'Bundle',
    vendor: 'Test Store',

    // Bundle-specific data
    isBundle: true,
    bundleComponents: [
      {
        externalId: '10384018702677',
        sku: 'shirt-1-sku',
        quantity: 1,
      },
      {
        externalId: '10384019587413',
        sku: 'shirt-2-sku',
        quantity: 1,
      },
      {
        externalId: '788032119674292900',
        sku: 'SHOPIFY-788032119674292900',
        quantity: 2,
      },
    ],
  };

  console.log('   📦 Bundle: Premium Shirt Collection Bundle');
  console.log('      SKU: BUNDLE-PREMIUM-SHIRTS');
  console.log('      Price: €1,198.98');
  console.log('      Components: 3');
  console.log('');

  try {
    const result = await productSyncService.processIncomingProduct(
      'shopify',
      clientId,
      channelId,
      bundleData,
      `test-bundle-${Date.now()}`
    );

    console.log(`   ✅ Product ${result.action}: ${result.productId}`);
    console.log('');

    // Step 3: Verify BundleItems created
    console.log('Step 3: Verifying BundleItem records...\n');

    const bundleProduct = await prisma.product.findFirst({
      where: { sku: 'BUNDLE-PREMIUM-SHIRTS' },
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
        }
      }
    });

    if (!bundleProduct) {
      console.log('   ❌ Bundle product not found!');
      return;
    }

    console.log(`   ✅ Bundle Product Found`);
    console.log(`      ID: ${bundleProduct.id}`);
    console.log(`      isBundle: ${bundleProduct.isBundle}`);
    console.log('');

    if (bundleProduct.bundleItems.length > 0) {
      console.log(`   ✅ BundleItems Created (${bundleProduct.bundleItems.length}):`);
      bundleProduct.bundleItems.forEach((item, idx) => {
        console.log(`      ${idx + 1}. ${item.childProduct.name} (${item.childProduct.sku})`);
        console.log(`         Quantity: ${item.quantity}`);
      });
      console.log('');
    } else {
      console.log('   ⚠️  No BundleItems created yet');
      console.log('');
    }

    if (bundleProduct.pendingBundleLinks.length > 0) {
      console.log(`   📋 Pending Bundle Links (${bundleProduct.pendingBundleLinks.length}):`);
      bundleProduct.pendingBundleLinks.forEach((link, idx) => {
        console.log(`      ${idx + 1}. Waiting for:`);
        console.log(`         External ID: ${link.childExternalId || 'N/A'}`);
        console.log(`         SKU: ${link.childSku || 'N/A'}`);
        console.log(`         Quantity: ${link.quantity}`);
      });
      console.log('');
    }

    // Step 4: Summary
    console.log('📊 Test Summary:');
    console.log('================');
    console.log(`   Bundle Product: ${bundleProduct.isBundle ? '✅' : '❌'} Marked as bundle`);
    console.log(`   BundleItems: ${bundleProduct.bundleItems.length} created`);
    console.log(`   Pending Links: ${bundleProduct.pendingBundleLinks.length}`);
    console.log('');

    if (bundleProduct.bundleItems.length === 3) {
      console.log('🎉 SUCCESS! All components linked successfully!');
      console.log('');
      console.log('   ✅ shirt-1 (qty: 1)');
      console.log('   ✅ shirt-2 (qty: 1)');
      console.log('   ✅ Example T-Shirt (qty: 2)');
      console.log('');
      console.log('💡 Next Step: Test JTL BOM sync to push bundle to JTL FFN');
    } else if (bundleProduct.pendingBundleLinks.length > 0) {
      console.log('⏳ Partial Success - Some components pending');
      console.log('');
      console.log('   Components will be linked when child products are imported.');
    } else {
      console.log('⚠️  No components linked - investigate logs');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
