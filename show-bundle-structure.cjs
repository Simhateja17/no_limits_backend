#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('\n📊 Bundle Database Structure');
  console.log('============================\n');

  // Query BundleItems
  const bundleItems = await prisma.$queryRaw`
    SELECT
      p_parent.sku as parent_sku,
      p_parent.name as parent_name,
      p_parent."isBundle",
      p_child.sku as child_sku,
      p_child.name as child_name,
      p_child."netSalesPrice" as child_price,
      p_child.available as child_stock,
      bi.quantity as bundle_quantity,
      bi."createdAt" as linked_at
    FROM bundle_items bi
    JOIN products p_parent ON bi.parent_product_id = p_parent.id
    JOIN products p_child ON bi.child_product_id = p_child.id
    WHERE p_parent.sku = 'BUNDLE-PREMIUM-SHIRTS'
    ORDER BY bi."createdAt" ASC;
  `;

  if (bundleItems.length === 0) {
    console.log('❌ No bundle items found');
    return;
  }

  const parent = bundleItems[0];
  console.log('🎁 Bundle Product:');
  console.log(`   Name: ${parent.parent_name}`);
  console.log(`   SKU: ${parent.parent_sku}`);
  console.log(`   Is Bundle: ${parent.isBundle}`);
  console.log('');

  console.log('📦 Bundle Components:');
  console.log('');

  let totalValue = 0;
  bundleItems.forEach((item, idx) => {
    const price = parseFloat(item.child_price || 0);
    const qty = item.bundle_quantity;
    const lineTotal = price * qty;
    totalValue += lineTotal;

    console.log(`   ${idx + 1}. ${item.child_name}`);
    console.log(`      SKU: ${item.child_sku}`);
    console.log(`      Unit Price: €${price.toFixed(2)}`);
    console.log(`      Quantity: ${qty}x`);
    console.log(`      Line Total: €${lineTotal.toFixed(2)}`);
    console.log(`      Stock Available: ${item.child_stock}`);
    console.log(`      Linked At: ${new Date(item.linked_at).toLocaleString()}`);
    console.log('');
  });

  console.log('💰 Bundle Value Calculation:');
  console.log(`   Total Value: €${totalValue.toFixed(2)}`);
  console.log('');

  // Check for any pending links
  const pendingLinks = await prisma.$queryRaw`
    SELECT
      p.sku as parent_sku,
      pbl."childSku",
      pbl."childExternalId",
      pbl.quantity,
      pbl.status,
      pbl."createdAt"
    FROM pending_bundle_links pbl
    JOIN products p ON pbl.parent_product_id = p.id
    WHERE p.sku = 'BUNDLE-PREMIUM-SHIRTS';
  `;

  if (pendingLinks.length > 0) {
    console.log('📋 Pending Bundle Links:');
    pendingLinks.forEach((link, idx) => {
      console.log(`   ${idx + 1}. ${link.status}`);
      console.log(`      Child SKU: ${link.childSku || 'N/A'}`);
      console.log(`      External ID: ${link.childExternalId || 'N/A'}`);
      console.log(`      Quantity: ${link.quantity}`);
    });
  } else {
    console.log('✅ No Pending Links - All components resolved!');
  }

  console.log('');
  console.log('🔗 Database Relationships:');
  console.log('   bundle_items table:');
  console.log(`     - ${bundleItems.length} records linking parent to children`);
  console.log('     - Each record has: parent_product_id, child_product_id, quantity');
  console.log('     - Foreign keys cascade on delete');
  console.log('');

  console.log('📋 Ready for JTL BOM Sync:');
  console.log('   When synced to JTL FFN, this bundle structure will be');
  console.log('   converted to BOM (Bill of Materials) specifications:');
  console.log('');
  bundleItems.forEach((item, idx) => {
    console.log(`   ${idx + 1}. Component: ${item.child_sku}`);
    console.log(`      Quantity per bundle: ${item.bundle_quantity}`);
  });
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
