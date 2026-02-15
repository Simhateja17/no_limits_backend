/**
 * Investigation script: Why does Shopify return 404 for products by externalProductId?
 */
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { getEncryptionService } from '../src/services/encryption.service.js';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('=== Shopify Product 404 Investigation ===\n');

  const encryptionService = getEncryptionService();

  // 1. Find the Shopify channel
  const channels = await prisma.channel.findMany({
    where: {
      type: 'SHOPIFY',
      name: { contains: 'miimiitv' },
    },
    select: {
      id: true,
      name: true,
      shopDomain: true,
      accessToken: true,
    },
  });

  if (channels.length === 0) {
    console.log('No Shopify channel found matching "miimiitv"');
    await pool.end();
    return;
  }

  const channel = channels[0];
  console.log(`Channel: ${channel.name} (${channel.id})`);
  console.log(`Shop Domain: ${channel.shopDomain}`);
  console.log(`Token encrypted: ${encryptionService.isEncrypted(channel.accessToken || '')}`);

  const decryptedToken = encryptionService.safeDecrypt(channel.accessToken || '');
  console.log(`Token (first 8 chars): ${decryptedToken.substring(0, 8)}...`);
  console.log('');

  // 2. Get some product channels with external IDs
  const productChannels = await prisma.productChannel.findMany({
    where: {
      channelId: channel.id,
      externalProductId: { not: null },
    },
    include: {
      product: {
        select: { name: true, sku: true },
      },
    },
    take: 5,
  });

  console.log(`Found ${productChannels.length} products with externalProductId:\n`);

  for (const pc of productChannels) {
    console.log(`  Product: ${pc.product.name}`);
    console.log(`  SKU: ${pc.product.sku}`);
    console.log(`  externalProductId: ${pc.externalProductId}`);
    console.log(`  externalVariantId: ${pc.externalVariantId || 'N/A'}`);
    console.log('');
  }

  // 3. Try fetching each product from Shopify REST API
  const shopDomain = channel.shopDomain?.trim();
  const apiVersion = '2024-10';

  for (const pc of productChannels) {
    const externalId = pc.externalProductId!;
    const url = `https://${shopDomain}/admin/api/${apiVersion}/products/${externalId}.json`;

    console.log(`--- Fetching: ${url}`);

    try {
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': decryptedToken,
        },
      });

      console.log(`  Status: ${response.status} ${response.statusText}`);

      if (response.ok) {
        const data = await response.json() as any;
        console.log(`  Product title: ${data.product?.title}`);
        console.log(`  Variants: ${data.product?.variants?.length}`);
        if (data.product?.variants?.[0]) {
          const v = data.product.variants[0];
          console.log(`  First variant ID: ${v.id}, inventory_item_id: ${v.inventory_item_id}`);
        }
      } else {
        const errorText = await response.text();
        console.log(`  Error body: ${errorText}`);
      }
    } catch (err: any) {
      console.log(`  Fetch error: ${err.message}`);
    }
    console.log('');
  }

  // 4. Also try GraphQL to see if the product exists by a different ID format
  console.log('=== Trying GraphQL for the same products ===\n');
  
  for (const pc of productChannels.slice(0, 2)) {
    const externalId = pc.externalProductId!;
    // Shopify GraphQL expects GID format: gid://shopify/Product/123
    const gid = externalId.startsWith('gid://') ? externalId : `gid://shopify/Product/${externalId}`;
    
    const graphqlUrl = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
    const query = `{
      product(id: "${gid}") {
        id
        title
        status
        variants(first: 3) {
          edges {
            node {
              id
              title
              inventoryItem {
                id
              }
            }
          }
        }
      }
    }`;

    console.log(`--- GraphQL query for externalProductId=${externalId} (GID: ${gid})`);

    try {
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': decryptedToken,
        },
        body: JSON.stringify({ query }),
      });

      console.log(`  Status: ${response.status}`);
      const data = await response.json();
      console.log(`  Response: ${JSON.stringify(data, null, 2)}`);
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
    }
    console.log('');
  }

  // 5. List actual products from Shopify to compare IDs
  console.log('=== Listing first 3 products from Shopify to compare ID formats ===\n');
  
  const listUrl = `https://${shopDomain}/admin/api/${apiVersion}/products.json?limit=3&fields=id,title,variants`;
  try {
    const response = await fetch(listUrl, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': decryptedToken,
      },
    });
    console.log(`  Status: ${response.status}`);
    if (response.ok) {
      const data = await response.json() as any;
      for (const p of data.products || []) {
        console.log(`  Shopify Product ID: ${p.id} | Title: ${p.title}`);
        if (p.variants?.[0]) {
          console.log(`    Variant ID: ${p.variants[0].id}`);
        }
      }
    } else {
      console.log(`  Error: ${await response.text()}`);
    }
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  console.log('\n=== Investigation complete ===');
  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  pool.end();
  process.exit(1);
});
