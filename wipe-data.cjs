require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function wipeData() {
  try {
    console.log('🧹 Fetching tables in public schema (excluding prisma_migrations)...');
    const res = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'prisma_migrations';");
    const tables = res.rows.map(r => r.tablename).filter(Boolean);
    if (tables.length === 0) {
      console.log('⚠️ No user tables found to truncate.');
      return;
    }

    for (const t of tables) {
      console.log(`🔁 Truncating table: ${t}`);
      // Use double quotes around table name to handle mixed-case, though most names are lower-case
      await pool.query(`TRUNCATE TABLE public."${t}" RESTART IDENTITY CASCADE;`);
    }

    console.log('\n✅ All user data truncated (identities reset).');
  } catch (err) {
    console.error('❌ Error while truncating:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

wipeData();
