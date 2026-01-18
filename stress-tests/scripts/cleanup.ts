/**
 * Cleanup Script for Stress Tests
 * Removes test data and resets the database to a clean state
 */

import pg from 'pg';

export interface CleanupOptions {
  removeTestOrders: boolean;
  removeAllOrders: boolean;
  resetSyncQueue: boolean;
  resetSyncLogs: boolean;
  vacuumAnalyze: boolean;
  dryRun: boolean;
}

export interface CleanupResult {
  ordersDeleted: number;
  orderItemsDeleted: number;
  syncLogsDeleted: number;
  syncQueueJobsDeleted: number;
  vacuumPerformed: boolean;
  duration: number;
}

export class StressTestCleanup {
  private pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new pg.Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }

  /**
   * Get counts of test data
   */
  async getTestDataCounts(): Promise<{
    testOrders: number;
    totalOrders: number;
    syncQueueJobs: number;
    syncLogs: number;
  }> {
    const client = await this.pool.connect();
    
    try {
      const testOrdersResult = await client.query(`
        SELECT COUNT(*) as count FROM orders 
        WHERE tags @> ARRAY['stress-test']::text[]
           OR tags @> ARRAY['k6']::text[]
           OR customer_email LIKE '%@test.com'
           OR customer_email LIKE '%@test-medium.com'
           OR customer_email LIKE '%@blackfriday-test.com'
           OR customer_email LIKE '%@stress-test.io'
           OR customer_email LIKE '%@load-test.net'
      `);

      const totalOrdersResult = await client.query(`
        SELECT COUNT(*) as count FROM orders
      `);

      const syncQueueResult = await client.query(`
        SELECT COUNT(*) as count FROM pgboss.job
        WHERE name NOT LIKE '__pgboss%'
      `);

      const syncLogsResult = await client.query(`
        SELECT COUNT(*) as count FROM order_sync_logs
      `);

      return {
        testOrders: parseInt(testOrdersResult.rows[0].count, 10),
        totalOrders: parseInt(totalOrdersResult.rows[0].count, 10),
        syncQueueJobs: parseInt(syncQueueResult.rows[0].count, 10),
        syncLogs: parseInt(syncLogsResult.rows[0].count, 10),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Remove test orders created during stress tests
   */
  async removeTestOrders(dryRun: boolean = false): Promise<number> {
    const client = await this.pool.connect();
    
    try {
      // First delete order items for test orders
      if (!dryRun) {
        await client.query(`
          DELETE FROM order_items
          WHERE order_id IN (
            SELECT id FROM orders 
            WHERE tags @> ARRAY['stress-test']::text[]
               OR tags @> ARRAY['k6']::text[]
               OR customer_email LIKE '%@test.com'
               OR customer_email LIKE '%@test-medium.com'
               OR customer_email LIKE '%@blackfriday-test.com'
               OR customer_email LIKE '%@stress-test.io'
               OR customer_email LIKE '%@load-test.net'
          )
        `);
      }

      // Then delete the orders
      const result = await client.query(`
        ${dryRun ? 'SELECT COUNT(*)' : 'DELETE'} FROM orders 
        WHERE tags @> ARRAY['stress-test']::text[]
           OR tags @> ARRAY['k6']::text[]
           OR customer_email LIKE '%@test.com'
           OR customer_email LIKE '%@test-medium.com'
           OR customer_email LIKE '%@blackfriday-test.com'
           OR customer_email LIKE '%@stress-test.io'
           OR customer_email LIKE '%@load-test.net'
        ${dryRun ? '' : 'RETURNING id'}
      `);

      return dryRun 
        ? parseInt(result.rows[0].count, 10)
        : result.rowCount || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Remove all orders (use with caution!)
   */
  async removeAllOrders(dryRun: boolean = false): Promise<number> {
    const client = await this.pool.connect();
    
    try {
      if (!dryRun) {
        // Delete in correct order due to foreign keys
        await client.query('DELETE FROM order_items');
        await client.query('DELETE FROM order_sync_logs');
        await client.query('DELETE FROM shipping_method_mismatches');
      }

      const result = await client.query(
        dryRun 
          ? 'SELECT COUNT(*) FROM orders'
          : 'DELETE FROM orders RETURNING id'
      );

      return dryRun 
        ? parseInt(result.rows[0].count, 10)
        : result.rowCount || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Clear the sync queue
   */
  async resetSyncQueue(dryRun: boolean = false): Promise<number> {
    const client = await this.pool.connect();
    
    try {
      // Check if pgboss schema exists
      const schemaCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.schemata 
          WHERE schema_name = 'pgboss'
        ) as exists
      `);

      if (!schemaCheck.rows[0].exists) {
        console.log('pgboss schema not found - skipping queue cleanup');
        return 0;
      }

      const result = await client.query(
        dryRun 
          ? "SELECT COUNT(*) FROM pgboss.job WHERE name NOT LIKE '__pgboss%'"
          : "DELETE FROM pgboss.job WHERE name NOT LIKE '__pgboss%' RETURNING id"
      );

      return dryRun 
        ? parseInt(result.rows[0].count, 10)
        : result.rowCount || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Clear sync logs
   */
  async resetSyncLogs(dryRun: boolean = false): Promise<number> {
    const client = await this.pool.connect();
    
    try {
      const result = await client.query(
        dryRun 
          ? 'SELECT COUNT(*) FROM order_sync_logs'
          : 'DELETE FROM order_sync_logs RETURNING id'
      );

      return dryRun 
        ? parseInt(result.rows[0].count, 10)
        : result.rowCount || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Vacuum and analyze tables
   */
  async vacuumAnalyze(): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      // VACUUM ANALYZE must run outside a transaction
      await client.query('VACUUM ANALYZE orders');
      await client.query('VACUUM ANALYZE order_items');
      await client.query('VACUUM ANALYZE order_sync_logs');
      
      // Check if pgboss exists
      const schemaCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.schemata 
          WHERE schema_name = 'pgboss'
        ) as exists
      `);

      if (schemaCheck.rows[0].exists) {
        await client.query('VACUUM ANALYZE pgboss.job');
      }
    } finally {
      client.release();
    }
  }

  /**
   * Run full cleanup
   */
  async cleanup(options: Partial<CleanupOptions> = {}): Promise<CleanupResult> {
    const opts: CleanupOptions = {
      removeTestOrders: true,
      removeAllOrders: false,
      resetSyncQueue: true,
      resetSyncLogs: false,
      vacuumAnalyze: true,
      dryRun: false,
      ...options,
    };

    const startTime = Date.now();
    const result: CleanupResult = {
      ordersDeleted: 0,
      orderItemsDeleted: 0,
      syncLogsDeleted: 0,
      syncQueueJobsDeleted: 0,
      vacuumPerformed: false,
      duration: 0,
    };

    console.log('\n🧹 Starting cleanup...');
    
    if (opts.dryRun) {
      console.log('   (DRY RUN - no data will be deleted)\n');
    }

    // Get initial counts
    const counts = await this.getTestDataCounts();
    console.log(`   Found ${counts.testOrders.toLocaleString()} test orders`);
    console.log(`   Found ${counts.totalOrders.toLocaleString()} total orders`);
    console.log(`   Found ${counts.syncQueueJobs.toLocaleString()} queue jobs`);
    console.log(`   Found ${counts.syncLogs.toLocaleString()} sync logs\n`);

    // Remove orders
    if (opts.removeAllOrders) {
      console.log('   ⚠️  Removing ALL orders...');
      result.ordersDeleted = await this.removeAllOrders(opts.dryRun);
      console.log(`   Deleted ${result.ordersDeleted.toLocaleString()} orders`);
    } else if (opts.removeTestOrders) {
      console.log('   Removing test orders...');
      result.ordersDeleted = await this.removeTestOrders(opts.dryRun);
      console.log(`   Deleted ${result.ordersDeleted.toLocaleString()} test orders`);
    }

    // Reset sync queue
    if (opts.resetSyncQueue) {
      console.log('   Clearing sync queue...');
      result.syncQueueJobsDeleted = await this.resetSyncQueue(opts.dryRun);
      console.log(`   Deleted ${result.syncQueueJobsDeleted.toLocaleString()} queue jobs`);
    }

    // Reset sync logs
    if (opts.resetSyncLogs) {
      console.log('   Clearing sync logs...');
      result.syncLogsDeleted = await this.resetSyncLogs(opts.dryRun);
      console.log(`   Deleted ${result.syncLogsDeleted.toLocaleString()} sync logs`);
    }

    // Vacuum analyze
    if (opts.vacuumAnalyze && !opts.dryRun) {
      console.log('   Running VACUUM ANALYZE...');
      await this.vacuumAnalyze();
      result.vacuumPerformed = true;
      console.log('   VACUUM ANALYZE completed');
    }

    result.duration = Date.now() - startTime;
    
    console.log(`\n✅ Cleanup completed in ${(result.duration / 1000).toFixed(2)}s\n`);

    return result;
  }

  /**
   * Close connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const includeLogs = args.includes('--logs');
  const skipVacuum = args.includes('--skip-vacuum');

  console.log('\n================================================================================');
  console.log('                    STRESS TEST CLEANUP');
  console.log('================================================================================');

  if (all) {
    console.log('\n⚠️  WARNING: --all flag will delete ALL orders, not just test orders!');
    console.log('    Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const cleanup = new StressTestCleanup();

  try {
    await cleanup.cleanup({
      removeTestOrders: !all,
      removeAllOrders: all,
      resetSyncQueue: true,
      resetSyncLogs: includeLogs,
      vacuumAnalyze: !skipVacuum,
      dryRun,
    });
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  } finally {
    await cleanup.close();
  }
}

// Run if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}

export { main as runCleanup };
