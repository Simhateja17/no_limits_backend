/**
 * Queue Metrics Collector
 * Monitors pg-boss queue performance during stress tests
 */

import pg from 'pg';

export interface QueueMetrics {
  timestamp: Date;
  queues: {
    name: string;
    created: number;
    active: number;
    completed: number;
    failed: number;
    cancelled: number;
    expired: number;
    retrying: number;
  }[];
  overall: {
    totalJobs: number;
    pendingJobs: number;
    activeJobs: number;
    completedJobs: number;
    failedJobs: number;
    jobsPerSecond: number;
    avgProcessingTime: number;
    oldestPendingJob: number; // age in seconds
  };
  workers: {
    active: number;
  };
  deadLetterQueue: {
    count: number;
    oldestAge: number; // seconds
  };
}

export interface QueueJob {
  id: string;
  name: string;
  state: string;
  createdOn: Date;
  startedOn: Date | null;
  completedOn: Date | null;
  data: any;
  retryCount: number;
  output: any;
}

export interface MetricsSnapshot {
  metrics: QueueMetrics;
  duration: number;
}

export class QueueMetricsCollector {
  private pool: pg.Pool;
  private isRunning: boolean = false;
  private metricsHistory: MetricsSnapshot[] = [];
  private collectionInterval: NodeJS.Timeout | null = null;
  private startTime: Date | null = null;
  private lastCompletedCount: number = 0;
  private lastSampleTime: number = 0;

  constructor(connectionString?: string) {
    this.pool = new pg.Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }

  /**
   * Collect current queue metrics
   */
  async collectMetrics(): Promise<QueueMetrics> {
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
        return this.getEmptyMetrics();
      }

      // Get queue-specific stats
      const queueStats = await client.query(`
        SELECT 
          name,
          count(*) FILTER (WHERE state = 'created') as created,
          count(*) FILTER (WHERE state = 'active') as active,
          count(*) FILTER (WHERE state = 'completed') as completed,
          count(*) FILTER (WHERE state = 'failed') as failed,
          count(*) FILTER (WHERE state = 'cancelled') as cancelled,
          count(*) FILTER (WHERE state = 'expired') as expired,
          count(*) FILTER (WHERE state = 'retry') as retrying
        FROM pgboss.job
        WHERE name NOT LIKE '__pgboss%'
        GROUP BY name
        ORDER BY name
      `);

      // Get overall stats
      const overallStats = await client.query(`
        SELECT 
          count(*) as total_jobs,
          count(*) FILTER (WHERE state = 'created') as pending_jobs,
          count(*) FILTER (WHERE state = 'active') as active_jobs,
          count(*) FILTER (WHERE state = 'completed') as completed_jobs,
          count(*) FILTER (WHERE state = 'failed') as failed_jobs
        FROM pgboss.job
        WHERE name NOT LIKE '__pgboss%'
      `);

      // Get oldest pending job age
      const oldestPending = await client.query(`
        SELECT 
          EXTRACT(EPOCH FROM (now() - min(createdon)))::int as oldest_age
        FROM pgboss.job
        WHERE state = 'created'
          AND name NOT LIKE '__pgboss%'
      `);

      // Get average processing time for completed jobs (last 100)
      const avgProcessingTime = await client.query(`
        SELECT 
          AVG(EXTRACT(EPOCH FROM (completedon - startedon)))::float as avg_time
        FROM pgboss.job
        WHERE state = 'completed'
          AND startedon IS NOT NULL
          AND completedon IS NOT NULL
          AND name NOT LIKE '__pgboss%'
        ORDER BY completedon DESC
        LIMIT 100
      `);

      // Dead letter queue (failed jobs)
      const deadLetterStats = await client.query(`
        SELECT 
          count(*) as count,
          EXTRACT(EPOCH FROM (now() - min(createdon)))::int as oldest_age
        FROM pgboss.job
        WHERE state = 'failed'
          AND name NOT LIKE '__pgboss%'
      `);

      // Calculate jobs per second
      const currentCompleted = parseInt(overallStats.rows[0].completed_jobs, 10);
      const currentTime = Date.now();
      let jobsPerSecond = 0;
      
      if (this.lastSampleTime > 0 && this.lastCompletedCount > 0) {
        const timeDelta = (currentTime - this.lastSampleTime) / 1000;
        const completedDelta = currentCompleted - this.lastCompletedCount;
        if (timeDelta > 0) {
          jobsPerSecond = completedDelta / timeDelta;
        }
      }
      
      this.lastCompletedCount = currentCompleted;
      this.lastSampleTime = currentTime;

      const queues = queueStats.rows.map(row => ({
        name: row.name,
        created: parseInt(row.created, 10) || 0,
        active: parseInt(row.active, 10) || 0,
        completed: parseInt(row.completed, 10) || 0,
        failed: parseInt(row.failed, 10) || 0,
        cancelled: parseInt(row.cancelled, 10) || 0,
        expired: parseInt(row.expired, 10) || 0,
        retrying: parseInt(row.retrying, 10) || 0,
      }));

      return {
        timestamp: new Date(),
        queues,
        overall: {
          totalJobs: parseInt(overallStats.rows[0].total_jobs, 10) || 0,
          pendingJobs: parseInt(overallStats.rows[0].pending_jobs, 10) || 0,
          activeJobs: parseInt(overallStats.rows[0].active_jobs, 10) || 0,
          completedJobs: parseInt(overallStats.rows[0].completed_jobs, 10) || 0,
          failedJobs: parseInt(overallStats.rows[0].failed_jobs, 10) || 0,
          jobsPerSecond: Math.max(0, jobsPerSecond),
          avgProcessingTime: parseFloat(avgProcessingTime.rows[0]?.avg_time) || 0,
          oldestPendingJob: parseInt(oldestPending.rows[0]?.oldest_age, 10) || 0,
        },
        workers: {
          active: queues.reduce((sum, q) => sum + q.active, 0),
        },
        deadLetterQueue: {
          count: parseInt(deadLetterStats.rows[0]?.count, 10) || 0,
          oldestAge: parseInt(deadLetterStats.rows[0]?.oldest_age, 10) || 0,
        },
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get empty metrics when pgboss is not available
   */
  private getEmptyMetrics(): QueueMetrics {
    return {
      timestamp: new Date(),
      queues: [],
      overall: {
        totalJobs: 0,
        pendingJobs: 0,
        activeJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        jobsPerSecond: 0,
        avgProcessingTime: 0,
        oldestPendingJob: 0,
      },
      workers: { active: 0 },
      deadLetterQueue: { count: 0, oldestAge: 0 },
    };
  }

  /**
   * Get recent failed jobs
   */
  async getFailedJobs(limit: number = 10): Promise<QueueJob[]> {
    const client = await this.pool.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          id,
          name,
          state,
          createdon as created_on,
          startedon as started_on,
          completedon as completed_on,
          data,
          retrycount as retry_count,
          output
        FROM pgboss.job
        WHERE state = 'failed'
          AND name NOT LIKE '__pgboss%'
        ORDER BY completedon DESC
        LIMIT $1
      `, [limit]);

      return result.rows.map(row => ({
        id: row.id,
        name: row.name,
        state: row.state,
        createdOn: row.created_on,
        startedOn: row.started_on,
        completedOn: row.completed_on,
        data: row.data,
        retryCount: row.retry_count,
        output: row.output,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get stuck jobs (active for too long)
   */
  async getStuckJobs(thresholdSeconds: number = 300): Promise<QueueJob[]> {
    const client = await this.pool.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          id,
          name,
          state,
          createdon as created_on,
          startedon as started_on,
          data,
          retrycount as retry_count
        FROM pgboss.job
        WHERE state = 'active'
          AND startedon < now() - interval '${thresholdSeconds} seconds'
          AND name NOT LIKE '__pgboss%'
        ORDER BY startedon
        LIMIT 20
      `);

      return result.rows.map(row => ({
        id: row.id,
        name: row.name,
        state: row.state,
        createdOn: row.created_on,
        startedOn: row.started_on,
        completedOn: null,
        data: row.data,
        retryCount: row.retry_count,
        output: null,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get queue depth over time (for trending)
   */
  async getQueueDepthHistory(): Promise<Array<{
    timestamp: Date;
    depth: number;
  }>> {
    return this.metricsHistory.map(snapshot => ({
      timestamp: snapshot.metrics.timestamp,
      depth: snapshot.metrics.overall.pendingJobs,
    }));
  }

  /**
   * Start continuous metrics collection
   */
  startCollection(intervalMs: number = 1000): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.startTime = new Date();
    this.metricsHistory = [];
    this.lastCompletedCount = 0;
    this.lastSampleTime = 0;

    console.log(`📊 Starting queue metrics collection (interval: ${intervalMs}ms)`);

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
        console.error('Error collecting queue metrics:', error);
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
    console.log('📊 Queue metrics collection stopped');
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
    totalJobsProcessed: number;
    totalJobsFailed: number;
    peakQueueDepth: number;
    avgQueueDepth: number;
    avgJobsPerSecond: number;
    peakJobsPerSecond: number;
    avgProcessingTime: number;
    maxProcessingTime: number;
  } {
    if (this.metricsHistory.length === 0) {
      return {
        duration: 0,
        samplesCollected: 0,
        totalJobsProcessed: 0,
        totalJobsFailed: 0,
        peakQueueDepth: 0,
        avgQueueDepth: 0,
        avgJobsPerSecond: 0,
        peakJobsPerSecond: 0,
        avgProcessingTime: 0,
        maxProcessingTime: 0,
      };
    }

    const first = this.metricsHistory[0];
    const last = this.metricsHistory[this.metricsHistory.length - 1];
    
    const queueDepths = this.metricsHistory.map(m => m.metrics.overall.pendingJobs);
    const jobsPerSecond = this.metricsHistory.map(m => m.metrics.overall.jobsPerSecond);
    const processingTimes = this.metricsHistory.map(m => m.metrics.overall.avgProcessingTime).filter(t => t > 0);

    return {
      duration: last.duration,
      samplesCollected: this.metricsHistory.length,
      totalJobsProcessed: last.metrics.overall.completedJobs - first.metrics.overall.completedJobs,
      totalJobsFailed: last.metrics.overall.failedJobs - first.metrics.overall.failedJobs,
      peakQueueDepth: Math.max(...queueDepths),
      avgQueueDepth: queueDepths.reduce((a, b) => a + b, 0) / queueDepths.length,
      avgJobsPerSecond: jobsPerSecond.reduce((a, b) => a + b, 0) / jobsPerSecond.length,
      peakJobsPerSecond: Math.max(...jobsPerSecond),
      avgProcessingTime: processingTimes.length > 0 
        ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length 
        : 0,
      maxProcessingTime: processingTimes.length > 0 ? Math.max(...processingTimes) : 0,
    };
  }

  /**
   * Generate a formatted report
   */
  generateReport(): string {
    const summary = this.getSummary();
    const latest = this.metricsHistory[this.metricsHistory.length - 1]?.metrics;

    if (!latest) {
      return 'No queue metrics collected yet.';
    }

    const formatDuration = (seconds: number): string => {
      if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
      if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
      return `${seconds.toFixed(1)}s`;
    };

    let queueDetails = '';
    for (const queue of latest.queues) {
      queueDetails += `
  ${queue.name}:
    Pending:    ${queue.created}
    Active:     ${queue.active}
    Completed:  ${queue.completed.toLocaleString()}
    Failed:     ${queue.failed}
    Retrying:   ${queue.retrying}`;
    }

    return `
================================================================================
                           QUEUE METRICS REPORT
================================================================================

COLLECTION SUMMARY:
  Duration:                ${(summary.duration / 1000).toFixed(2)}s
  Samples:                 ${summary.samplesCollected}
  Jobs Processed:          ${summary.totalJobsProcessed.toLocaleString()}
  Jobs Failed:             ${summary.totalJobsFailed.toLocaleString()}

CURRENT STATE:
  Total Jobs:              ${latest.overall.totalJobs.toLocaleString()}
  Pending Jobs:            ${latest.overall.pendingJobs.toLocaleString()}
  Active Jobs:             ${latest.overall.activeJobs}
  Completed Jobs:          ${latest.overall.completedJobs.toLocaleString()}
  Failed Jobs:             ${latest.overall.failedJobs.toLocaleString()}

THROUGHPUT:
  Current Rate:            ${latest.overall.jobsPerSecond.toFixed(2)} jobs/sec
  Average Rate:            ${summary.avgJobsPerSecond.toFixed(2)} jobs/sec
  Peak Rate:               ${summary.peakJobsPerSecond.toFixed(2)} jobs/sec

QUEUE DEPTH:
  Current:                 ${latest.overall.pendingJobs} jobs
  Average:                 ${summary.avgQueueDepth.toFixed(1)} jobs
  Peak:                    ${summary.peakQueueDepth} jobs
  Oldest Pending:          ${formatDuration(latest.overall.oldestPendingJob)}

PROCESSING TIME:
  Current Avg:             ${(latest.overall.avgProcessingTime * 1000).toFixed(0)}ms
  Overall Avg:             ${(summary.avgProcessingTime * 1000).toFixed(0)}ms
  Max Observed:            ${(summary.maxProcessingTime * 1000).toFixed(0)}ms

DEAD LETTER QUEUE:
  Failed Jobs:             ${latest.deadLetterQueue.count}
  Oldest Failed:           ${formatDuration(latest.deadLetterQueue.oldestAge)}

QUEUES BY NAME:${queueDetails || '\n  (No queues found)'}

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
export const queueMetricsCollector = new QueueMetricsCollector();

// Export for CLI usage
export async function collectQueueMetrics(): Promise<QueueMetrics> {
  return queueMetricsCollector.collectMetrics();
}
