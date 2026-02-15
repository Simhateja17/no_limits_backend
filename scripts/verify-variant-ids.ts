import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { getEncryptionService } from '../src/services/encryption.service.js';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const enc = getEncryptionService();
  const channel = await prisma.channel.findFirstOrThrow({ where: { id: 'cmldqz5kb0094mglgiakm6b7a' } });
  const decToken = enc.safeDecrypt(channel.accessToken as string);
  const shopDomain = 'miimiitv.myshopify.com';

  // Try the stored externalProductId as a VARIANT
  const testId = '40715649122483';

  // 1. REST variant endpoint
  const variantUrl = `https://${shopDomain}/admin/api/2024-10/variants/${testId}.json`;
  console.log(`Trying as variant: ${variantUrl}`);
  const resp = await fetch(variantUrl, {
    headers: { 'X-Shopify-Access-Token': decToken, 'Content-Type': 'application/json' },
  });
  console.log(`Status: ${resp.status}`);
  if (resp.ok) {
    const data = await resp.json() as any;
    console.log(`FOUND AS VARIANT!`);
    console.log(`  Variant title: ${data.variant?.title}`);
    console.log(`  Parent Product ID: ${data.variant?.product_id}`);
    console.log(`  Inventory Item ID: ${data.variant?.inventory_item_id}`);
    console.log(`  SKU: ${data.variant?.sku}`);
  } else {
    console.log(`Not found as variant either: ${await resp.text()}`);
  }

  // 2. GraphQL as ProductVariant
  const gqlUrl = `https://${shopDomain}/admin/api/2024-10/graphql.json`;
  console.log(`\nTrying GraphQL as ProductVariant...`);
  const gqlResp = await fetch(gqlUrl, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': decToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ productVariant(id: "gid://shopify/ProductVariant/${testId}") { id title product { id title } inventoryItem { id } } }`
    }),
  });
  const gqlData = await gqlResp.json();
  console.log(JSON.stringify(gqlData, null, 2));

  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
