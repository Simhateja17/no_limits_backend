import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

console.log('DATABASE_URL:', process.env.DATABASE_URL?.substring(0, 30) + '...');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  console.log('\n=== Activating JTL Config ===\n');

  const clientId = 'cmkfdr9pk0003xrs1i9ysvqqd';

  // First, check current status
  const beforeResult = await pool.query(
    'SELECT id, client_id, "isActive" FROM jtl_configs WHERE client_id = $1',
    [clientId]
  );

  if (beforeResult.rows.length === 0) {
    console.log(`❌ No JTL config found for client: ${clientId}`);
    await pool.end();
    return;
  }

  const config = beforeResult.rows[0];
  console.log(`📋 Current status:`);
  console.log(`   - Config ID: ${config.id}`);
  console.log(`   - Client ID: ${config.client_id}`);
  console.log(`   - isActive: ${config.isActive}`);

  // Update isActive to true
  const updateResult = await pool.query(
    'UPDATE jtl_configs SET "isActive" = true WHERE client_id = $1 RETURNING id, client_id, "isActive"',
    [clientId]
  );

  console.log(`\n✅ Updated JTL config:`);
  console.log(`   - Config ID: ${updateResult.rows[0].id}`);
  console.log(`   - Client ID: ${updateResult.rows[0].client_id}`);
  console.log(`   - isActive: ${updateResult.rows[0].isActive}`);

  console.log('\n🎉 JTL config is now active and ready to sync orders!');

  await pool.end();
}

main().catch(console.error);
