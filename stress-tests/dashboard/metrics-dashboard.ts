/**
 * Real-time Metrics Dashboard
 * 
 * A lightweight web server that displays live metrics during stress tests.
 * Uses Server-Sent Events (SSE) for real-time updates without WebSocket complexity.
 * 
 * Usage:
 *   npx tsx stress-tests/dashboard/metrics-dashboard.ts
 * 
 * Then open http://localhost:3098 in your browser.
 */

import http from 'http';
import { URL } from 'url';
import pg from 'pg';

const PORT = 3098;
const REFRESH_INTERVAL = 1000; // 1 second

interface DashboardMetrics {
  timestamp: string;
  database: {
    activeConnections: number;
    idleConnections: number;
    maxConnections: number;
    cacheHitRatio: number;
    slowQueries: number;
    deadlocks: number;
  };
  queue: {
    pending: number;
    active: number;
    completed: number;
    failed: number;
    retrying: number;
  };
  orders: {
    total: number;
    today: number;
    synced: number;
    pending: number;
    failed: number;
    skipped: number;
  };
  performance: {
    ordersPerMinute: number;
    avgProcessingTime: number;
  };
}

class MetricsDashboard {
  private pool: pg.Pool;
  private clients: Set<http.ServerResponse> = new Set();
  private intervalId: NodeJS.Timeout | null = null;

  constructor() {
    this.pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30000,
    });
  }

  async collectMetrics(): Promise<DashboardMetrics> {
    const client = await this.pool.connect();
    
    try {
      // Database metrics
      const connResult = await client.query(`
        SELECT 
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') as active,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle') as idle,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max
      `);

      const cacheResult = await client.query(`
        SELECT 
          ROUND(
            CASE WHEN (heap_blks_hit + heap_blks_read) > 0 
            THEN heap_blks_hit::numeric / (heap_blks_hit + heap_blks_read) * 100
            ELSE 100 END, 2
          ) as ratio
        FROM pg_statio_user_tables
        WHERE schemaname = 'public'
        LIMIT 1
      `);

      const slowQueryResult = await client.query(`
        SELECT COUNT(*) as count
        FROM pg_stat_statements 
        WHERE mean_exec_time > 100
      `).catch(() => ({ rows: [{ count: 0 }] }));

      const deadlockResult = await client.query(`
        SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()
      `);

      // Queue metrics
      let queueMetrics = { pending: 0, active: 0, completed: 0, failed: 0, retrying: 0 };
      try {
        const queueResult = await client.query(`
          SELECT 
            state,
            COUNT(*) as count
          FROM pgboss.job
          WHERE name NOT LIKE '__pgboss%'
          GROUP BY state
        `);
        
        for (const row of queueResult.rows) {
          switch (row.state) {
            case 'created': queueMetrics.pending = parseInt(row.count); break;
            case 'active': queueMetrics.active = parseInt(row.count); break;
            case 'completed': queueMetrics.completed = parseInt(row.count); break;
            case 'failed': queueMetrics.failed = parseInt(row.count); break;
            case 'retry': queueMetrics.retrying = parseInt(row.count); break;
          }
        }
      } catch (e) {
        // pgboss schema might not exist
      }

      // Order metrics
      const orderResult = await client.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today,
          COUNT(*) FILTER (WHERE sync_status = 'SYNCED') as synced,
          COUNT(*) FILTER (WHERE sync_status = 'PENDING') as pending,
          COUNT(*) FILTER (WHERE sync_status = 'ERROR') as failed,
          COUNT(*) FILTER (WHERE sync_status = 'SKIPPED') as skipped
        FROM orders
      `);

      // Performance metrics (orders per minute in last 5 minutes)
      const perfResult = await client.query(`
        SELECT 
          COALESCE(
            COUNT(*) / GREATEST(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 60, 1),
            0
          ) as orders_per_minute
        FROM orders
        WHERE created_at > NOW() - INTERVAL '5 minutes'
      `);

      const conn = connResult.rows[0];
      const orders = orderResult.rows[0];

      return {
        timestamp: new Date().toISOString(),
        database: {
          activeConnections: parseInt(conn.active),
          idleConnections: parseInt(conn.idle),
          maxConnections: parseInt(conn.max),
          cacheHitRatio: parseFloat(cacheResult.rows[0]?.ratio || '100'),
          slowQueries: parseInt(slowQueryResult.rows[0]?.count || '0'),
          deadlocks: parseInt(deadlockResult.rows[0]?.deadlocks || '0'),
        },
        queue: queueMetrics,
        orders: {
          total: parseInt(orders.total),
          today: parseInt(orders.today),
          synced: parseInt(orders.synced),
          pending: parseInt(orders.pending),
          failed: parseInt(orders.failed),
          skipped: parseInt(orders.skipped),
        },
        performance: {
          ordersPerMinute: parseFloat(perfResult.rows[0]?.orders_per_minute || '0'),
          avgProcessingTime: 0, // Would need webhook timing data
        },
      };
    } finally {
      client.release();
    }
  }

  private async broadcastMetrics(): Promise<void> {
    try {
      const metrics = await this.collectMetrics();
      const data = `data: ${JSON.stringify(metrics)}\n\n`;
      
      for (const client of this.clients) {
        client.write(data);
      }
    } catch (error) {
      console.error('Error collecting metrics:', error);
    }
  }

  private getHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stress Test Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 20px;
    }
    h1 { 
      text-align: center; 
      margin-bottom: 20px;
      color: #38bdf8;
    }
    .status {
      text-align: center;
      margin-bottom: 20px;
      padding: 10px;
      border-radius: 8px;
      font-weight: bold;
    }
    .status.connected { background: #166534; color: #86efac; }
    .status.disconnected { background: #991b1b; color: #fca5a5; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #334155;
    }
    .card h2 {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #94a3b8;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #334155;
    }
    .metric {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #334155;
    }
    .metric:last-child { border-bottom: none; }
    .metric-label { color: #94a3b8; }
    .metric-value { 
      font-size: 20px; 
      font-weight: bold;
      font-family: 'Monaco', 'Menlo', monospace;
    }
    .metric-value.good { color: #4ade80; }
    .metric-value.warning { color: #fbbf24; }
    .metric-value.bad { color: #f87171; }
    .metric-value.neutral { color: #38bdf8; }
    .timestamp {
      text-align: center;
      margin-top: 20px;
      color: #64748b;
      font-size: 12px;
    }
    .bar-container {
      width: 100%;
      height: 8px;
      background: #334155;
      border-radius: 4px;
      margin-top: 8px;
      overflow: hidden;
    }
    .bar {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    .bar.good { background: linear-gradient(90deg, #4ade80, #22c55e); }
    .bar.warning { background: linear-gradient(90deg, #fbbf24, #f59e0b); }
    .bar.bad { background: linear-gradient(90deg, #f87171, #ef4444); }
  </style>
</head>
<body>
  <h1>Stress Test Dashboard</h1>
  <div id="status" class="status disconnected">Connecting...</div>
  
  <div class="grid">
    <!-- Database Card -->
    <div class="card">
      <h2>Database</h2>
      <div class="metric">
        <span class="metric-label">Active Connections</span>
        <span id="db-active" class="metric-value neutral">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Idle Connections</span>
        <span id="db-idle" class="metric-value neutral">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Connection Usage</span>
        <span id="db-usage" class="metric-value neutral">-</span>
      </div>
      <div class="bar-container">
        <div id="db-usage-bar" class="bar good" style="width: 0%"></div>
      </div>
      <div class="metric">
        <span class="metric-label">Cache Hit Ratio</span>
        <span id="db-cache" class="metric-value good">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Slow Queries</span>
        <span id="db-slow" class="metric-value good">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Deadlocks</span>
        <span id="db-deadlocks" class="metric-value good">-</span>
      </div>
    </div>

    <!-- Queue Card -->
    <div class="card">
      <h2>Job Queue</h2>
      <div class="metric">
        <span class="metric-label">Pending</span>
        <span id="q-pending" class="metric-value warning">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Active</span>
        <span id="q-active" class="metric-value neutral">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Completed</span>
        <span id="q-completed" class="metric-value good">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Failed</span>
        <span id="q-failed" class="metric-value bad">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Retrying</span>
        <span id="q-retrying" class="metric-value warning">-</span>
      </div>
    </div>

    <!-- Orders Card -->
    <div class="card">
      <h2>Orders</h2>
      <div class="metric">
        <span class="metric-label">Total</span>
        <span id="o-total" class="metric-value neutral">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Today</span>
        <span id="o-today" class="metric-value neutral">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Synced</span>
        <span id="o-synced" class="metric-value good">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Pending</span>
        <span id="o-pending" class="metric-value warning">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Failed</span>
        <span id="o-failed" class="metric-value bad">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Skipped (Test)</span>
        <span id="o-skipped" class="metric-value neutral">-</span>
      </div>
    </div>

    <!-- Performance Card -->
    <div class="card">
      <h2>Performance</h2>
      <div class="metric">
        <span class="metric-label">Orders/Minute</span>
        <span id="p-opm" class="metric-value neutral">-</span>
      </div>
      <div class="metric">
        <span class="metric-label">Sync Success Rate</span>
        <span id="p-success" class="metric-value good">-</span>
      </div>
      <div class="bar-container">
        <div id="p-success-bar" class="bar good" style="width: 0%"></div>
      </div>
    </div>
  </div>

  <div id="timestamp" class="timestamp">Waiting for data...</div>

  <script>
    const elements = {
      status: document.getElementById('status'),
      timestamp: document.getElementById('timestamp'),
      dbActive: document.getElementById('db-active'),
      dbIdle: document.getElementById('db-idle'),
      dbUsage: document.getElementById('db-usage'),
      dbUsageBar: document.getElementById('db-usage-bar'),
      dbCache: document.getElementById('db-cache'),
      dbSlow: document.getElementById('db-slow'),
      dbDeadlocks: document.getElementById('db-deadlocks'),
      qPending: document.getElementById('q-pending'),
      qActive: document.getElementById('q-active'),
      qCompleted: document.getElementById('q-completed'),
      qFailed: document.getElementById('q-failed'),
      qRetrying: document.getElementById('q-retrying'),
      oTotal: document.getElementById('o-total'),
      oToday: document.getElementById('o-today'),
      oSynced: document.getElementById('o-synced'),
      oPending: document.getElementById('o-pending'),
      oFailed: document.getElementById('o-failed'),
      oSkipped: document.getElementById('o-skipped'),
      pOpm: document.getElementById('p-opm'),
      pSuccess: document.getElementById('p-success'),
      pSuccessBar: document.getElementById('p-success-bar'),
    };

    function updateMetrics(data) {
      // Database
      elements.dbActive.textContent = data.database.activeConnections;
      elements.dbIdle.textContent = data.database.idleConnections;
      
      const connUsage = Math.round((data.database.activeConnections + data.database.idleConnections) / data.database.maxConnections * 100);
      elements.dbUsage.textContent = connUsage + '%';
      elements.dbUsageBar.style.width = connUsage + '%';
      elements.dbUsageBar.className = 'bar ' + (connUsage > 80 ? 'bad' : connUsage > 50 ? 'warning' : 'good');
      
      elements.dbCache.textContent = data.database.cacheHitRatio.toFixed(1) + '%';
      elements.dbCache.className = 'metric-value ' + (data.database.cacheHitRatio > 95 ? 'good' : data.database.cacheHitRatio > 80 ? 'warning' : 'bad');
      
      elements.dbSlow.textContent = data.database.slowQueries;
      elements.dbSlow.className = 'metric-value ' + (data.database.slowQueries === 0 ? 'good' : data.database.slowQueries < 10 ? 'warning' : 'bad');
      
      elements.dbDeadlocks.textContent = data.database.deadlocks;
      elements.dbDeadlocks.className = 'metric-value ' + (data.database.deadlocks === 0 ? 'good' : 'bad');

      // Queue
      elements.qPending.textContent = data.queue.pending.toLocaleString();
      elements.qActive.textContent = data.queue.active.toLocaleString();
      elements.qCompleted.textContent = data.queue.completed.toLocaleString();
      elements.qFailed.textContent = data.queue.failed.toLocaleString();
      elements.qFailed.className = 'metric-value ' + (data.queue.failed === 0 ? 'good' : 'bad');
      elements.qRetrying.textContent = data.queue.retrying.toLocaleString();

      // Orders
      elements.oTotal.textContent = data.orders.total.toLocaleString();
      elements.oToday.textContent = data.orders.today.toLocaleString();
      elements.oSynced.textContent = data.orders.synced.toLocaleString();
      elements.oPending.textContent = data.orders.pending.toLocaleString();
      elements.oFailed.textContent = data.orders.failed.toLocaleString();
      elements.oFailed.className = 'metric-value ' + (data.orders.failed === 0 ? 'good' : 'bad');
      elements.oSkipped.textContent = data.orders.skipped.toLocaleString();

      // Performance
      elements.pOpm.textContent = data.performance.ordersPerMinute.toFixed(1);
      
      const total = data.orders.synced + data.orders.failed + data.orders.skipped;
      const successRate = total > 0 ? ((data.orders.synced + data.orders.skipped) / total * 100) : 100;
      elements.pSuccess.textContent = successRate.toFixed(1) + '%';
      elements.pSuccess.className = 'metric-value ' + (successRate > 95 ? 'good' : successRate > 80 ? 'warning' : 'bad');
      elements.pSuccessBar.style.width = successRate + '%';
      elements.pSuccessBar.className = 'bar ' + (successRate > 95 ? 'good' : successRate > 80 ? 'warning' : 'bad');

      // Timestamp
      elements.timestamp.textContent = 'Last updated: ' + new Date(data.timestamp).toLocaleTimeString();
    }

    function connect() {
      const eventSource = new EventSource('/events');
      
      eventSource.onopen = () => {
        elements.status.textContent = 'Connected';
        elements.status.className = 'status connected';
      };
      
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        updateMetrics(data);
      };
      
      eventSource.onerror = () => {
        elements.status.textContent = 'Disconnected - Reconnecting...';
        elements.status.className = 'status disconnected';
        eventSource.close();
        setTimeout(connect, 2000);
      };
    }

    connect();
  </script>
</body>
</html>`;
  }

  async start(): Promise<void> {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      if (url.pathname === '/events') {
        // SSE endpoint
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        this.clients.add(res);
        
        req.on('close', () => {
          this.clients.delete(res);
        });

        // Send initial data
        try {
          const metrics = await this.collectMetrics();
          res.write(`data: ${JSON.stringify(metrics)}\n\n`);
        } catch (e) {
          console.error('Error sending initial metrics:', e);
        }
      } else {
        // Serve dashboard HTML
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this.getHTML());
      }
    });

    // Start metrics broadcasting
    this.intervalId = setInterval(() => this.broadcastMetrics(), REFRESH_INTERVAL);

    server.listen(PORT, () => {
      console.log('\n================================================================================');
      console.log('                    STRESS TEST METRICS DASHBOARD');
      console.log('================================================================================');
      console.log(`  Dashboard URL:  http://localhost:${PORT}`);
      console.log(`  Refresh Rate:   ${REFRESH_INTERVAL}ms`);
      console.log('================================================================================');
      console.log('\n  Open the URL in your browser to view real-time metrics.');
      console.log('  Press Ctrl+C to stop.\n');
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down dashboard...');
      if (this.intervalId) {
        clearInterval(this.intervalId);
      }
      for (const client of this.clients) {
        client.end();
      }
      await this.pool.end();
      server.close();
      process.exit(0);
    });
  }
}

// Run if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const dashboard = new MetricsDashboard();
  dashboard.start().catch(console.error);
}

export { MetricsDashboard };
