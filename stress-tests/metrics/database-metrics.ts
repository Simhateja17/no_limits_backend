/**
 * Database Performance Metrics Collector
 * Monitors PostgreSQL performance during stress tests
 */

import pg from 'pg';

export interface DatabaseMetrics {
  timestamp: Date;
  connections: {
    active: number;
    idle: number;
    waiting: number;
    total: number;
    maxConnections: number;
  };
  queries: {
    activeQueries: number;
    slowQueries: number; // queries > 1 second
    lockedQueries: number;
    totalQueriesPerSecond: number;
  };
  tables: {
    ordersCount: number;
    orderItemsCount: number;
    orderSyncLogsCount: number;
    orderSyncQueueCount: number;
  };
  performance: {
    cacheHitRatio: number;
    indexHitRatio: number;
    deadlocks: number;
    tempFilesCreated: number;
    tempBytesWritten: number;
  };
  disk: {
    databaseSize: number; // bytes
    tablesSizeBytes: number;
    indexesSizeBytes: number;
  };
  replication?: {
    isReplica: boolean;
    replicationLag: number; // seconds
  };
}

export interface MetricsSnapshot {
  metrics: DatabaseMetrics;
  duration: number;
}

export class DatabaseMetricsCollector {
  private pool: pg.Pool;
  private isRunning: boolean = false;
  private metricsHistory: MetricsSnapshot[] = [];
  private collectionInterval: NodeJS.Timeout | null = null;
  private startTime: Date | null = null;

  constructor(connectionString?: string) {
    this.pool = new pg.Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
      max: 5, // Separate pool for metrics, keep it small
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  /**
   * Collect current database metrics
   */
  async collectMetrics(): Promise<DatabaseMetrics> {
    const client = await this.pool.connect();
    
    try {
      // Connection stats
      const connectionStats = await client.query(`
        SELECT 
          count(*) FILTER (WHERE state = 'active') as active,
          count(*) FILTER (WHERE state = 'idle') as idle,
          count(*) FILTER (WHERE wait_event_type = 'Lock') as waiting,
          count(*) as total
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);

      // Max connections
      const maxConnResult = await client.query(`SHOW max_connections`);
      const maxConnections = parseInt(maxConnResult.rows[0].max_connections, 10);

      // Active queries info
      const activeQueries = await client.query(`
        SELECT 
          count(*) as active_count,
          count(*) FILTER (WHERE now() - query_start > interval '1 second') as slow_count,
          count(*) FILTER (WHERE wait_event_type = 'Lock') as locked_count
        FROM pg_stat_activity
        WHERE state = 'active'
          AND datname = current_database()
          AND query NOT LIKE '%pg_stat%'
      `);

      // Table row counts (estimated for performance)
      const tableCounts = await client.query(`
        SELECT 
          (SELECT reltuples::bigint FROM pg_class WHERE relname = 'orders') as orders_count,
          (SELECT reltuples::bigint FROM pg_class WHERE relname = 'order_items') as order_items_count,
          (SELECT reltuples::bigint FROM pg_class WHERE relname = 'order_sync_logs') as sync_logs_count,
          (SELECT reltuples::bigint FROM pg_class WHERE relname = 'order_sync_queue') as sync_queue_count
      `);

      // Cache and index hit ratios
      const cacheStats = await client.query(`
        SELECT 
          CASE 
            WHEN sum(heap_blks_hit) + sum(heap_blks_read) > 0 
            THEN sum(heap_blks_hit)::float / (sum(heap_blks_hit) + sum(heap_blks_read))
            ELSE 1
          END as cache_hit_ratio,
          CASE 
            WHEN sum(idx_blks_hit) + sum(idx_blks_read) > 0
            THEN sum(idx_blks_hit)::float / (sum(idx_blks_hit) + sum(idx_blks_read))
            ELSE 1
          END as index_hit_ratio
        FROM pg_statio_user_tables
      `);

      // Deadlocks and temp files
      const perfStats = await client.query(`
        SELECT 
          deadlocks,
          temp_files as temp_files_created,
          temp_bytes as temp_bytes_written
        FROM pg_stat_database
        WHERE datname = current_database()
      `);

      // Database and table sizes
      const sizeStats = await client.query(`
        SELECT 
          pg_database_size(current_database()) as db_size,
          (SELECT sum(pg_table_size(c.oid)) FROM pg_class c WHERE c.relkind = 'r') as tables_size,
          (SELECT sum(pg_indexes_size(c.oid)) FROM pg_class c WHERE c.relkind = 'r') as indexes_size
      `);

      // Transaction rate (approximate)
      const txnStats = await client.query(`
        SELECT 
          xact_commit + xact_rollback as total_transactions
        FROM pg_stat_database
        WHERE datname = current_database()
      `);

      const connRow = connectionStats.rows[0];
      const queryRow = activeQueries.rows[0];
      const tableRow = tableCounts.rows[0];
      const cacheRow = cacheStats.rows[0];
      const perfRow = perfStats.rows[0];
      const sizeRow = sizeStats.rows[0];

      return {
        timestamp: new Date(),
        connections: {
          active: parseInt(connRow.active, 10) || 0,
          idle: parseInt(connRow.idle, 10) || 0,
          waiting: parseInt(connRow.waiting, 10) || 0,
          total: parseInt(connRow.total, 10) || 0,
          maxConnections,
        },
        queries: {
          activeQueries: parseInt(queryRow.active_count, 10) || 0,
          slowQueries: parseInt(queryRow.slow_count, 10) || 0,
          lockedQueries: parseInt(queryRow.locked_count, 10) || 0,
          totalQueriesPerSecond: 0, // Will be calculated from delta
        },
        tables: {
          ordersCount: parseInt(tableRow.orders_count, 10) || 0,
          orderItemsCount: parseInt(tableRow.order_items_count, 10) || 0,
          orderSyncLogsCount: parseInt(tableRow.sync_logs_count, 10) || 0,
          orderSyncQueueCount: parseInt(tableRow.sync_queue_count, 10) || 0,
        },
        performance: {
          cacheHitRatio: parseFloat(cacheRow.cache_hit_ratio) || 0,
          indexHitRatio: parseFloat(cacheRow.index_hit_ratio) || 0,
          deadlocks: parseInt(perfRow.deadlocks, 10) || 0,
          tempFilesCreated: parseInt(perfRow.temp_files_created, 10) || 0,
          tempBytesWritten: parseInt(perfRow.temp_bytes_written, 10) || 0,
        },
        disk: {
          databaseSize: parseInt(sizeRow.db_size, 10) || 0,
          tablesSizeBytes: parseInt(sizeRow.tables_size, 10) || 0,
          indexesSizeBytes: parseInt(sizeRow.indexes_size, 10) || 0,
        },
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get slow queries currently running
   */
  async getSlowQueries(): Promise<Array<{
    pid: number;
    duration: string;
    query: string;
    state: string;
    waitEvent: string | null;
  }>> {
    const client = await this.pool.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          pid,
          age(now(), query_start) as duration,
          left(query, 500) as query,
          state,
          wait_event_type as wait_event
        FROM pg_stat_activity
        WHERE state = 'active'
          AND datname = current_database()
          AND query NOT LIKE '%pg_stat%'
          AND query_start < now() - interval '1 second'
        ORDER BY query_start
        LIMIT 10
      `);

      return result.rows.map(row => ({
        pid: row.pid,
        duration: row.duration,
        query: row.query,
        state: row.state,
        waitEvent: row.wait_event,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get table statistics for orders-related tables
   */
  async getTableStats(): Promise<Array<{
    tableName: string;
    rowCount: number;
    totalSize: string;
    indexSize: string;
    seqScans: number;
    idxScans: number;
    nTupIns: number;
    nTupUpd: number;
    nTupDel: number;
  }>> {
    const client = await this.pool.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          relname as table_name,
          n_live_tup as row_count,
          pg_size_pretty(pg_total_relation_size(relid)) as total_size,
          pg_size_pretty(pg_indexes_size(relid)) as index_size,
          seq_scan as seq_scans,
          idx_scan as idx_scans,
          n_tup_ins,
          n_tup_upd,
          n_tup_del
        FROM pg_stat_user_tables
        WHERE relname IN ('orders', 'order_items', 'order_sync_logs', 'order_sync_queue', 'channels', 'clients')
        ORDER BY n_live_tup DESC
      `);

      return result.rows.map(row => ({
        tableName: row.table_name,
        rowCount: parseInt(row.row_count, 10),
        totalSize: row.total_size,
        indexSize: row.index_size,
        seqScans: parseInt(row.seq_scans, 10),
        idxScans: parseInt(row.idx_scans, 10),
        nTupIns: parseInt(row.n_tup_ins, 10),
        nTupUpd: parseInt(row.n_tup_upd, 10),
        nTupDel: parseInt(row.n_tup_del, 10),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Start continuous metrics collection
   */
  startCollection(intervalMs: number = 1000): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.startTime = new Date();
    this.metricsHistory = [];

    console.log(`📊 Starting database metrics collection (interval: ${intervalMs}ms)`);

    this.collectionInterval = setInterval(async () => {
      try {
        const metrics = await this.collectMetrics();
        const duration = Date.now() - this.startTime!.getTime();
        
        this.metricsHistory.push({ metrics, duration });

        // Keep only last 30 minutes of data
        const maxAge = 30 * 60 * 1000;
        this.metricsHistory = this.metricsHistory.filter(
          m => duration - m.duration < maxAge
        );
      } catch (error) {
        console.error('Error collecting database metrics:', error);
      }
    }, intervalMs);
  }

  /**
   * Stop metrics collection
   */
  stopCollection(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }
    this.isRunning = false;
    console.log('📊 Database metrics collection stopped');
  }

  /**
   * Get collected metrics history
   */
  getMetricsHistory(): MetricsSnapshot[] {
    return [...this.metricsHistory];
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    duration: number;
    samplesCollected: number;
    avgConnections: number;
    maxConnections: number;
    avgSlowQueries: number;
    maxSlowQueries: number;
    avgCacheHitRatio: number;
    minCacheHitRatio: number;
    ordersCreated: number;
    deadlocksOccurred: number;
  } {
    if (this.metricsHistory.length === 0) {
      return {
        duration: 0,
        samplesCollected: 0,
        avgConnections: 0,
        maxConnections: 0,
        avgSlowQueries: 0,
        maxSlowQueries: 0,
        avgCacheHitRatio: 0,
        minCacheHitRatio: 0,
        ordersCreated: 0,
        deadlocksOccurred: 0,
      };
    }

    const first = this.metricsHistory[0];
    const last = this.metricsHistory[this.metricsHistory.length - 1];
    
    const connections = this.metricsHistory.map(m => m.metrics.connections.active);
    const slowQueries = this.metricsHistory.map(m => m.metrics.queries.slowQueries);
    const cacheHits = this.metricsHistory.map(m => m.metrics.performance.cacheHitRatio);

    return {
      duration: last.duration,
      samplesCollected: this.metricsHistory.length,
      avgConnections: connections.reduce((a, b) => a + b, 0) / connections.length,
      maxConnections: Math.max(...connections),
      avgSlowQueries: slowQueries.reduce((a, b) => a + b, 0) / slowQueries.length,
      maxSlowQueries: Math.max(...slowQueries),
      avgCacheHitRatio: cacheHits.reduce((a, b) => a + b, 0) / cacheHits.length,
      minCacheHitRatio: Math.min(...cacheHits),
      ordersCreated: last.metrics.tables.ordersCount - first.metrics.tables.ordersCount,
      deadlocksOccurred: last.metrics.performance.deadlocks - first.metrics.performance.deadlocks,
    };
  }

  /**
   * Generate a formatted report
   */
  generateReport(): string {
    const summary = this.getSummary();
    const latest = this.metricsHistory[this.metricsHistory.length - 1]?.metrics;

    if (!latest) {
      return 'No metrics collected yet.';
    }

    const formatBytes = (bytes: number): string => {
      if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
      if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
      return `${bytes} B`;
    };

    return `
================================================================================
                         DATABASE METRICS REPORT
================================================================================

COLLECTION SUMMARY:
  Duration:             ${(summary.duration / 1000).toFixed(2)}s
  Samples:              ${summary.samplesCollected}
  Orders Created:       ${summary.ordersCreated.toLocaleString()}

CONNECTION STATISTICS:
  Current Active:       ${latest.connections.active}
  Current Idle:         ${latest.connections.idle}
  Current Waiting:      ${latest.connections.waiting}
  Total Connections:    ${latest.connections.total} / ${latest.connections.maxConnections}
  Avg Active:           ${summary.avgConnections.toFixed(2)}
  Max Active:           ${summary.maxConnections}

QUERY PERFORMANCE:
  Active Queries:       ${latest.queries.activeQueries}
  Slow Queries (>1s):   ${latest.queries.slowQueries}
  Locked Queries:       ${latest.queries.lockedQueries}
  Avg Slow Queries:     ${summary.avgSlowQueries.toFixed(2)}
  Max Slow Queries:     ${summary.maxSlowQueries}

CACHE PERFORMANCE:
  Cache Hit Ratio:      ${(latest.performance.cacheHitRatio * 100).toFixed(2)}%
  Index Hit Ratio:      ${(latest.performance.indexHitRatio * 100).toFixed(2)}%
  Avg Cache Hit:        ${(summary.avgCacheHitRatio * 100).toFixed(2)}%
  Min Cache Hit:        ${(summary.minCacheHitRatio * 100).toFixed(2)}%

TABLE STATISTICS:
  Orders:               ${latest.tables.ordersCount.toLocaleString()} rows
  Order Items:          ${latest.tables.orderItemsCount.toLocaleString()} rows
  Sync Logs:            ${latest.tables.orderSyncLogsCount.toLocaleString()} rows
  Sync Queue:           ${latest.tables.orderSyncQueueCount.toLocaleString()} rows

DISK USAGE:
  Database Size:        ${formatBytes(latest.disk.databaseSize)}
  Tables Size:          ${formatBytes(latest.disk.tablesSizeBytes)}
  Indexes Size:         ${formatBytes(latest.disk.indexesSizeBytes)}

ISSUES:
  Deadlocks:            ${summary.deadlocksOccurred}
  Temp Files Created:   ${latest.performance.tempFilesCreated}
  Temp Bytes Written:   ${formatBytes(latest.performance.tempBytesWritten)}

================================================================================
`;
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    this.stopCollection();
    await this.pool.end();
  }
}

// Export singleton for convenience
export const databaseMetricsCollector = new DatabaseMetricsCollector();

// Export for CLI usage
export async function collectDatabaseMetrics(): Promise<DatabaseMetrics> {
  return databaseMetricsCollector.collectMetrics();
}
