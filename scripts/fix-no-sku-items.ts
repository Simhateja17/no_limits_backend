/**
 * Fix NO-SKU-* Items Script
 *
 * This script fixes existing order items that have NO-SKU-{variant_id} values
 * by looking up the real product via the variant ID in ProductChannel.
 *
 * Usage: npx ts-node scripts/fix-no-sku-items.ts
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// Initialize Prisma with pg adapter (Prisma 7 requirement)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function fixNoSkuItems() {
  console.log('\n' + '═'.repeat(60));
  console.log('🔧 NO-SKU Item Fix Script');
  console.log('═'.repeat(60) + '\n');

  try {
    // Find all order items with NO-SKU-* pattern
    const noSkuItems = await prisma.orderItem.findMany({
      where: {
        sku: { startsWith: 'NO-SKU-' },
      },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            channelId: true,
            clientId: true,
          },
        },
      },
    });

    console.log(`Found ${noSkuItems.length} order items with NO-SKU-* values\n`);

    if (noSkuItems.length === 0) {
      console.log('✅ No NO-SKU items to fix!');
      return;
    }

    let fixed = 0;
    let notFound = 0;
    let errors = 0;

    for (const item of noSkuItems) {
      try {
        // Extract variant_id from NO-SKU-{variant_id}
        const match = item.sku?.match(/^NO-SKU-(\d+)$/);
        if (!match) {
          console.log(`⚠️  Skipping ${item.sku} - doesn't match expected pattern`);
          notFound++;
          continue;
        }

        const variantId = match[1];
        console.log(`\n📦 Order: ${item.order.orderNumber}`);
        console.log(`   Item: ${item.productName}`);
        console.log(`   Current SKU: ${item.sku}`);
        console.log(`   Variant ID: ${variantId}`);

        // Method 1: Look up via ProductChannel (most reliable)
        const productChannel = await prisma.productChannel.findFirst({
          where: {
            channelId: item.order.channelId!,
            externalProductId: variantId,
          },
          include: {
            product: true,
          },
        });

        if (productChannel?.product) {
          // Found product by variant ID
          console.log(`   ✅ Found product: ${productChannel.product.name} (SKU: ${productChannel.product.sku})`);

          await prisma.orderItem.update({
            where: { id: item.id },
            data: {
              sku: productChannel.product.sku,
              productId: productChannel.product.id,
            },
          });

          console.log(`   ✅ Updated SKU: ${item.sku} → ${productChannel.product.sku}`);
          fixed++;
          continue;
        }

        // Method 2: Try matching by product name
        if (item.productName) {
          // Extract potential SKU from product name (often in parentheses like "Feuerzeug (ZRR)")
          const skuMatch = item.productName.match(/\(([A-Z0-9]+)\)/);
          if (skuMatch) {
            const potentialSku = skuMatch[1];
            console.log(`   🔍 Trying SKU from name: ${potentialSku}`);

            const productBySku = await prisma.product.findFirst({
              where: {
                sku: potentialSku,
                clientId: item.order.clientId!,
              },
            });

            if (productBySku) {
              console.log(`   ✅ Found product by extracted SKU: ${productBySku.name}`);

              await prisma.orderItem.update({
                where: { id: item.id },
                data: {
                  sku: productBySku.sku,
                  productId: productBySku.id,
                },
              });

              console.log(`   ✅ Updated SKU: ${item.sku} → ${productBySku.sku}`);
              fixed++;
              continue;
            }
          }

          // Try fuzzy name match
          const firstWord = item.productName.split(' ')[0];
          const productByName = await prisma.product.findFirst({
            where: {
              clientId: item.order.clientId!,
              name: {
                contains: firstWord,
                mode: 'insensitive',
              },
            },
          });

          if (productByName) {
            console.log(`   ✅ Found product by name match: ${productByName.name} (SKU: ${productByName.sku})`);

            await prisma.orderItem.update({
              where: { id: item.id },
              data: {
                sku: productByName.sku,
                productId: productByName.id,
              },
            });

            console.log(`   ✅ Updated SKU: ${item.sku} → ${productByName.sku}`);
            fixed++;
            continue;
          }
        }

        console.log(`   ❌ Could not find matching product`);
        notFound++;

      } catch (error: any) {
        console.error(`   ❌ Error: ${error.message}`);
        errors++;
      }
    }

    console.log('\n' + '═'.repeat(60));
    console.log('📊 Results:');
    console.log('═'.repeat(60));
    console.log(`   Total NO-SKU items: ${noSkuItems.length}`);
    console.log(`   ✅ Fixed: ${fixed}`);
    console.log(`   ⚠️  Not found: ${notFound}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log('═'.repeat(60) + '\n');

  } catch (error) {
    console.error('Script failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Run the script
fixNoSkuItems();
