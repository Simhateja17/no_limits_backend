import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

console.log('DATABASE_URL:', process.env.DATABASE_URL?.substring(0, 30) + '...');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  console.log('\n=== Checking JTL Config ===\n');

  const clientId = 'cmkfdr9pk0003xrs1i9ysvqqd';

  // Check if JTL config exists for this client
  const jtlConfigResult = await pool.query(
    'SELECT * FROM jtl_configs WHERE client_id = $1',
    [clientId]
  );

  if (jtlConfigResult.rows.length === 0) {
    console.log(`❌ No JTL config found for client: ${clientId}`);
  } else {
    const jtlConfig = jtlConfigResult.rows[0];
    console.log(`✅ JTL config found for client: ${clientId}`);
    console.log(`   - ID: ${jtlConfig.id}`);
    console.log(`   - isActive: ${jtlConfig.isActive}`);
    console.log(`   - Has accessToken: ${!!jtlConfig.accessToken}`);
    console.log(`   - Has refreshToken: ${!!jtlConfig.refreshToken}`);
    console.log(`   - tokenExpiresAt: ${jtlConfig.tokenExpiresAt}`);
    console.log(`   - clientId (OAuth): ${jtlConfig.clientId}`);
    console.log(`   - environment: ${jtlConfig.environment}`);
  }

  console.log('\n=== All JTL Configs ===\n');

  const allConfigsResult = await pool.query('SELECT client_id, "isActive" FROM jtl_configs');
  console.log(`Total configs: ${allConfigsResult.rows.length}`);
  allConfigsResult.rows.forEach(config => {
    console.log(`   - Client: ${config.client_id}, Active: ${config.isActive}`);
  });

  console.log('\n=== Checking Orders ===\n');

  const ordersResult = await pool.query(
    'SELECT id, "orderNumber", client_id FROM orders WHERE "orderNumber" IN (\'260\', \'262\', \'263\', \'264\', \'265\')'
  );

  console.log(`Found ${ordersResult.rows.length} orders:`);
  ordersResult.rows.forEach(order => {
    console.log(`   - Order #${order.orderNumber}: Client ${order.client_id}`);
  });

  await pool.end();
}

main().catch(console.error);
