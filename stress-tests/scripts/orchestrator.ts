/**
 * Stress Test Orchestrator
 * Main runner that coordinates all stress testing components
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { WebhookSimulator, SimulatorResult } from './webhook-simulator.js';
import { MockFFNServer, MockFFNConfig } from '../mocks/mock-ffn-server.js';
import { DatabaseMetricsCollector } from '../metrics/database-metrics.js';
import { QueueMetricsCollector } from '../metrics/queue-metrics.js';
import { getConfig, ScenarioConfig, defaultConfig } from '../config/stress-test.config.js';

export interface OrchestratorConfig {
  scenario: 'low' | 'medium' | 'high' | 'custom';
  customScenario?: ScenarioConfig;
  apiBaseUrl: string;
  channelId: string;
  useMockFFN: boolean;
  mockFFNConfig?: Partial<MockFFNConfig>;
  useK6: boolean;
  testMode: boolean;
  metricsInterval: number;
  outputDir: string;
}

export interface TestReport {
  startTime: Date;
  endTime: Date;
  duration: number;
  scenario: ScenarioConfig;
  webhookResults?: SimulatorResult;
  databaseReport: string;
  queueReport: string;
  mockFFNStats?: any;
  summary: {
    totalOrders: number;
    successRate: number;
    avgResponseTime: number;
    p95ResponseTime: number;
    peakQueueDepth: number;
    deadlocksOccurred: number;
    errors: number;
  };
  passed: boolean;
  failureReasons: string[];
}

export class StressTestOrchestrator {
  private config: OrchestratorConfig;
  private webhookSimulator: WebhookSimulator | null = null;
  private mockFFNServer: MockFFNServer | null = null;
  private dbMetrics: DatabaseMetricsCollector | null = null;
  private queueMetrics: QueueMetricsCollector | null = null;
  private k6Process: ChildProcess | null = null;
  private isRunning: boolean = false;

  constructor(config: Partial<OrchestratorConfig> = {}) {
    const stressConfig = getConfig();
    
    this.config = {
      scenario: config.scenario || 'low',
      customScenario: config.customScenario,
      apiBaseUrl: config.apiBaseUrl || stressConfig.apiBaseUrl,
      channelId: config.channelId || 'test-channel-id',
      useMockFFN: config.useMockFFN ?? true,
      mockFFNConfig: config.mockFFNConfig,
      useK6: config.useK6 ?? false,
      testMode: config.testMode ?? true,
      metricsInterval: config.metricsInterval || 1000,
      outputDir: config.outputDir || path.join(process.cwd(), 'stress-tests', 'reports'),
    };
  }

  /**
   * Get the scenario configuration
   */
  private getScenario(): ScenarioConfig {
    if (this.config.customScenario) {
      return this.config.customScenario;
    }
    return defaultConfig.scenarios[this.config.scenario];
  }

  /**
   * Ensure output directory exists
   */
  private async ensureOutputDir(): Promise<void> {
    try {
      await fs.mkdir(this.config.outputDir, { recursive: true });
    } catch (error) {
      // Directory may already exist
    }
  }

  /**
   * Start the mock FFN server if configured
   */
  private async startMockFFN(): Promise<void> {
    if (!this.config.useMockFFN) return;

    console.log('🔧 Starting Mock JTL FFN Server...');
    this.mockFFNServer = new MockFFNServer({
      port: 3099,
      latency: { min: 50, max: 150 },
      errorRate: 0,
      rateLimitPerMinute: 10000,
      enableLogging: false,
      ...this.config.mockFFNConfig,
    });

    await this.mockFFNServer.start();
  }

  /**
   * Start metrics collectors
   */
  private async startMetricsCollection(): Promise<void> {
    console.log('📊 Starting metrics collection...');
    
    this.dbMetrics = new DatabaseMetricsCollector();
    this.queueMetrics = new QueueMetricsCollector();

    this.dbMetrics.startCollection(this.config.metricsInterval);
    this.queueMetrics.startCollection(this.config.metricsInterval);
  }

  /**
   * Run stress test using webhook simulator (Node.js)
   */
  private async runWithWebhookSimulator(scenario: ScenarioConfig): Promise<SimulatorResult> {
    console.log('🚀 Running stress test with Webhook Simulator...');
    
    this.webhookSimulator = new WebhookSimulator({
      apiBaseUrl: this.config.apiBaseUrl,
      channelId: this.config.channelId,
      testMode: this.config.testMode,
      concurrency: Math.min(scenario.concurrentUsers, 100),
      onProgress: (progress) => {
        const percent = ((progress.completed / progress.total) * 100).toFixed(1);
        process.stdout.write(`\r   Progress: ${percent}% | ${progress.completed}/${progress.total} | ${progress.currentRate.toFixed(1)} req/s`);
      },
      onError: (error) => {
        if (error.statusCode >= 500) {
          console.log(`\n   ⚠️ Server error: ${error.statusCode} - ${error.message.substring(0, 100)}`);
        }
      },
    });

    const result = await this.webhookSimulator.runScenario(scenario);
    console.log('\n');
    return result;
  }

  /**
   * Run stress test using k6
   */
  private async runWithK6(scenario: ScenarioConfig): Promise<void> {
    console.log('🚀 Running stress test with k6...');
    
    const scenarioName = this.config.scenario;
    const k6Script = path.join(
      process.cwd(),
      'stress-tests',
      'k6',
      `${scenarioName}-volume-test.js`
    );

    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        API_BASE_URL: this.config.apiBaseUrl,
        CHANNEL_ID: this.config.channelId,
        SHOPIFY_PERCENTAGE: String(scenario.shopifyPercentage),
      };

      this.k6Process = spawn('k6', ['run', k6Script], {
        env,
        stdio: 'inherit',
      });

      this.k6Process.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`k6 exited with code ${code}`));
        }
      });

      this.k6Process.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Stop all components
   */
  private async stopAll(): Promise<void> {
    console.log('\n🛑 Stopping all components...');

    // Stop k6 if running
    if (this.k6Process) {
      this.k6Process.kill('SIGTERM');
      this.k6Process = null;
    }

    // Stop webhook simulator
    if (this.webhookSimulator) {
      this.webhookSimulator.stop();
      this.webhookSimulator = null;
    }

    // Stop metrics collection
    if (this.dbMetrics) {
      this.dbMetrics.stopCollection();
    }
    if (this.queueMetrics) {
      this.queueMetrics.stopCollection();
    }

    // Stop mock FFN server
    if (this.mockFFNServer) {
      await this.mockFFNServer.stop();
      this.mockFFNServer = null;
    }
  }

  /**
   * Generate the final test report
   */
  private async generateReport(
    scenario: ScenarioConfig,
    webhookResults: SimulatorResult | null,
    startTime: Date
  ): Promise<TestReport> {
    const endTime = new Date();
    const duration = endTime.getTime() - startTime.getTime();

    // Get metrics summaries
    const dbSummary = this.dbMetrics?.getSummary();
    const queueSummary = this.queueMetrics?.getSummary();

    // Determine if test passed
    const failureReasons: string[] = [];
    
    if (webhookResults) {
      if (webhookResults.successfulOrders / webhookResults.totalOrders < 0.85) {
        failureReasons.push(`Success rate below 85%: ${((webhookResults.successfulOrders / webhookResults.totalOrders) * 100).toFixed(2)}%`);
      }
      if (webhookResults.p95ResponseTime > 5000) {
        failureReasons.push(`P95 response time above 5s: ${webhookResults.p95ResponseTime.toFixed(0)}ms`);
      }
    }

    if (dbSummary && dbSummary.deadlocksOccurred > 0) {
      failureReasons.push(`Database deadlocks occurred: ${dbSummary.deadlocksOccurred}`);
    }

    if (queueSummary && queueSummary.totalJobsFailed > scenario.totalOrders * 0.05) {
      failureReasons.push(`Queue failure rate above 5%: ${queueSummary.totalJobsFailed} failed`);
    }

    const report: TestReport = {
      startTime,
      endTime,
      duration,
      scenario,
      webhookResults: webhookResults || undefined,
      databaseReport: this.dbMetrics?.generateReport() || 'No database metrics collected',
      queueReport: this.queueMetrics?.generateReport() || 'No queue metrics collected',
      mockFFNStats: this.mockFFNServer?.getStats(),
      summary: {
        totalOrders: webhookResults?.totalOrders || 0,
        successRate: webhookResults 
          ? (webhookResults.successfulOrders / webhookResults.totalOrders) * 100 
          : 0,
        avgResponseTime: webhookResults?.averageResponseTime || 0,
        p95ResponseTime: webhookResults?.p95ResponseTime || 0,
        peakQueueDepth: queueSummary?.peakQueueDepth || 0,
        deadlocksOccurred: dbSummary?.deadlocksOccurred || 0,
        errors: webhookResults?.failedOrders || 0,
      },
      passed: failureReasons.length === 0,
      failureReasons,
    };

    return report;
  }

  /**
   * Save report to file
   */
  private async saveReport(report: TestReport): Promise<string> {
    await this.ensureOutputDir();
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `stress-test-${report.scenario.name.toLowerCase().replace(/\s+/g, '-')}-${timestamp}.json`;
    const filepath = path.join(this.config.outputDir, filename);

    await fs.writeFile(filepath, JSON.stringify(report, null, 2));
    
    // Also save a human-readable summary
    const summaryFilename = filepath.replace('.json', '-summary.txt');
    const summaryContent = this.formatReportSummary(report);
    await fs.writeFile(summaryFilename, summaryContent);

    return filepath;
  }

  /**
   * Format report as human-readable summary
   */
  private formatReportSummary(report: TestReport): string {
    return `
================================================================================
                      STRESS TEST FINAL REPORT
================================================================================
                    ${report.passed ? '✅ TEST PASSED' : '❌ TEST FAILED'}
================================================================================

TEST CONFIGURATION:
  Scenario:              ${report.scenario.name}
  Description:           ${report.scenario.description}
  Target Orders:         ${report.scenario.totalOrders.toLocaleString()}
  Duration Config:       ${report.scenario.duration}s
  Platform Mix:          ${report.scenario.shopifyPercentage}% Shopify / ${report.scenario.woocommercePercentage}% WooCommerce
  Pattern:               ${report.scenario.pattern}

EXECUTION:
  Start Time:            ${report.startTime.toISOString()}
  End Time:              ${report.endTime.toISOString()}
  Actual Duration:       ${(report.duration / 1000).toFixed(2)}s

RESULTS SUMMARY:
  Total Orders:          ${report.summary.totalOrders.toLocaleString()}
  Success Rate:          ${report.summary.successRate.toFixed(2)}%
  Errors:                ${report.summary.errors.toLocaleString()}
  
RESPONSE TIMES:
  Average:               ${report.summary.avgResponseTime.toFixed(2)}ms
  P95:                   ${report.summary.p95ResponseTime.toFixed(2)}ms

SYSTEM HEALTH:
  Peak Queue Depth:      ${report.summary.peakQueueDepth}
  Deadlocks:             ${report.summary.deadlocksOccurred}

${report.failureReasons.length > 0 ? `
FAILURE REASONS:
${report.failureReasons.map(r => `  - ${r}`).join('\n')}
` : ''}

================================================================================
                          DATABASE METRICS
================================================================================
${report.databaseReport}

================================================================================
                           QUEUE METRICS
================================================================================
${report.queueReport}

${report.mockFFNStats ? `
================================================================================
                        MOCK FFN SERVER STATS
================================================================================
  Total Requests:        ${report.mockFFNStats.totalRequests}
  Successful:            ${report.mockFFNStats.successfulRequests}
  Failed:                ${report.mockFFNStats.failedRequests}
  Outbounds Created:     ${report.mockFFNStats.outboundsCreated}
  Average Latency:       ${report.mockFFNStats.averageLatency?.toFixed(2)}ms
` : ''}

================================================================================
                           END OF REPORT
================================================================================
`;
  }

  /**
   * Print final summary to console
   */
  private printSummary(report: TestReport): void {
    console.log('\n');
    console.log('================================================================================');
    console.log(`                    ${report.passed ? '✅ TEST PASSED' : '❌ TEST FAILED'}`);
    console.log('================================================================================');
    console.log(`
  Scenario:          ${report.scenario.name}
  Total Orders:      ${report.summary.totalOrders.toLocaleString()}
  Success Rate:      ${report.summary.successRate.toFixed(2)}%
  Avg Response:      ${report.summary.avgResponseTime.toFixed(2)}ms
  P95 Response:      ${report.summary.p95ResponseTime.toFixed(2)}ms
  Duration:          ${(report.duration / 1000).toFixed(2)}s
`);
    
    if (report.failureReasons.length > 0) {
      console.log('  Failure Reasons:');
      report.failureReasons.forEach(r => console.log(`    - ${r}`));
    }
    
    console.log('================================================================================\n');
  }

  /**
   * Run the complete stress test
   */
  async run(): Promise<TestReport> {
    if (this.isRunning) {
      throw new Error('A stress test is already running');
    }

    this.isRunning = true;
    const startTime = new Date();
    const scenario = this.getScenario();
    let webhookResults: SimulatorResult | null = null;

    console.log('\n================================================================================');
    console.log('                    STRESS TEST ORCHESTRATOR');
    console.log('================================================================================');
    console.log(`  Scenario:     ${scenario.name}`);
    console.log(`  Orders:       ${scenario.totalOrders.toLocaleString()}`);
    console.log(`  Duration:     ${scenario.duration}s`);
    console.log(`  API URL:      ${this.config.apiBaseUrl}`);
    console.log(`  Test Mode:    ${this.config.testMode}`);
    console.log(`  Mock FFN:     ${this.config.useMockFFN}`);
    console.log(`  Use k6:       ${this.config.useK6}`);
    console.log('================================================================================\n');

    try {
      // Step 1: Start mock FFN server
      await this.startMockFFN();

      // Step 2: Start metrics collection
      await this.startMetricsCollection();

      // Wait a moment for collectors to initialize
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 3: Run the stress test
      if (this.config.useK6) {
        await this.runWithK6(scenario);
      } else {
        webhookResults = await this.runWithWebhookSimulator(scenario);
      }

      // Step 4: Wait for queue to drain (give it some time)
      console.log('⏳ Waiting for queue to process remaining jobs...');
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Step 5: Generate report
      const report = await this.generateReport(scenario, webhookResults, startTime);

      // Step 6: Save report
      const reportPath = await this.saveReport(report);
      console.log(`📄 Report saved to: ${reportPath}`);

      // Step 7: Print summary
      this.printSummary(report);

      return report;
    } catch (error) {
      console.error('\n❌ Stress test failed with error:', error);
      throw error;
    } finally {
      await this.stopAll();
      
      // Close metrics collectors
      if (this.dbMetrics) {
        await this.dbMetrics.close();
        this.dbMetrics = null;
      }
      if (this.queueMetrics) {
        await this.queueMetrics.close();
        this.queueMetrics = null;
      }
      
      this.isRunning = false;
    }
  }

  /**
   * Run a quick validation test
   */
  async runQuickTest(): Promise<TestReport> {
    this.config.customScenario = {
      name: 'Quick Validation',
      description: 'Quick test to validate setup',
      totalOrders: 20,
      duration: 30,
      rampUpTime: 5,
      shopifyPercentage: 50,
      woocommercePercentage: 50,
      pattern: 'steady',
      concurrentUsers: 5,
    };
    this.config.scenario = 'custom';
    
    return this.run();
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const scenario = (args[0] as 'low' | 'medium' | 'high') || 'low';
  const useK6 = args.includes('--k6');
  const quick = args.includes('--quick');

  const orchestrator = new StressTestOrchestrator({
    scenario: quick ? 'custom' : scenario,
    useK6,
    testMode: true,
    useMockFFN: true,
  });

  try {
    const report = quick 
      ? await orchestrator.runQuickTest()
      : await orchestrator.run();
    
    process.exit(report.passed ? 0 : 1);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}

export { main as runStressTest };
