/**
 * Webhook Simulator Service
 * Simulates incoming webhooks from Shopify and WooCommerce for stress testing
 */

import crypto from 'crypto';
import { 
  generateShopifyWebhookPayload, 
  generateWooCommerceWebhookPayload,
  generateMixedWebhookPayloads,
  resetAllGenerators,
} from '../generators/index.js';
import { getConfig, ScenarioConfig } from '../config/stress-test.config.js';

export interface WebhookSimulatorOptions {
  apiBaseUrl?: string;
  shopifyWebhookPath?: string;
  woocommerceWebhookPath?: string;
  shopifyWebhookSecret?: string;
  woocommerceWebhookSecret?: string;
  channelId?: string;
  clientId?: string;
  concurrency?: number;
  delayBetweenRequests?: number; // ms
  onProgress?: (progress: SimulatorProgress) => void;
  onError?: (error: SimulatorError) => void;
  testMode?: boolean;
}

export interface SimulatorProgress {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  currentRate: number; // requests per second
  elapsedTime: number; // ms
  estimatedTimeRemaining: number; // ms
  platform: {
    shopify: { completed: number; failed: number };
    woocommerce: { completed: number; failed: number };
  };
}

export interface SimulatorError {
  platform: 'shopify' | 'woocommerce';
  orderId: string;
  statusCode: number;
  message: string;
  timestamp: Date;
}

export interface SimulatorResult {
  success: boolean;
  totalOrders: number;
  successfulOrders: number;
  failedOrders: number;
  duration: number; // ms
  averageResponseTime: number; // ms
  minResponseTime: number; // ms
  maxResponseTime: number; // ms
  p95ResponseTime: number; // ms
  p99ResponseTime: number; // ms
  requestsPerSecond: number;
  errors: SimulatorError[];
  platformStats: {
    shopify: PlatformStats;
    woocommerce: PlatformStats;
  };
}

export interface PlatformStats {
  total: number;
  successful: number;
  failed: number;
  averageResponseTime: number;
  errors: SimulatorError[];
}

export class WebhookSimulator {
  private options: Required<WebhookSimulatorOptions>;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;
  private responseTimes: number[] = [];
  private errors: SimulatorError[] = [];
  private platformStats: {
    shopify: { total: number; successful: number; failed: number; responseTimes: number[] };
    woocommerce: { total: number; successful: number; failed: number; responseTimes: number[] };
  };

  constructor(options: WebhookSimulatorOptions = {}) {
    const config = getConfig();
    
    this.options = {
      apiBaseUrl: options.apiBaseUrl || config.apiBaseUrl,
      shopifyWebhookPath: options.shopifyWebhookPath || '/api/webhooks/shopify',
      woocommerceWebhookPath: options.woocommerceWebhookPath || '/api/webhooks/woocommerce',
      shopifyWebhookSecret: options.shopifyWebhookSecret || process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret',
      woocommerceWebhookSecret: options.woocommerceWebhookSecret || process.env.WOOCOMMERCE_WEBHOOK_SECRET || 'test-secret',
      channelId: options.channelId || 'test-channel-id',
      clientId: options.clientId || 'test-client-id',
      concurrency: options.concurrency || 10,
      delayBetweenRequests: options.delayBetweenRequests || 0,
      onProgress: options.onProgress || (() => {}),
      onError: options.onError || (() => {}),
      testMode: options.testMode ?? true,
    };

    this.platformStats = {
      shopify: { total: 0, successful: 0, failed: 0, responseTimes: [] },
      woocommerce: { total: 0, successful: 0, failed: 0, responseTimes: [] },
    };
  }

  /**
   * Generate HMAC signature for Shopify webhook
   */
  private generateShopifyHmac(body: string): string {
    return crypto
      .createHmac('sha256', this.options.shopifyWebhookSecret)
      .update(body, 'utf8')
      .digest('base64');
  }

  /**
   * Generate signature for WooCommerce webhook
   */
  private generateWooCommerceSignature(body: string): string {
    return crypto
      .createHmac('sha256', this.options.woocommerceWebhookSecret)
      .update(body, 'utf8')
      .digest('base64');
  }

  /**
   * Send a single Shopify webhook
   */
  private async sendShopifyWebhook(payload: ReturnType<typeof generateShopifyWebhookPayload>): Promise<{
    success: boolean;
    responseTime: number;
    statusCode: number;
    error?: string;
  }> {
    const url = `${this.options.apiBaseUrl}${this.options.shopifyWebhookPath}/${this.options.channelId}`;
    const body = JSON.stringify(payload.order);
    const hmac = this.generateShopifyHmac(body);

    const startTime = Date.now();
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Topic': payload.topic,
          'X-Shopify-Shop-Domain': payload.shopDomain,
          'X-Shopify-Hmac-Sha256': hmac,
          'X-Shopify-Webhook-Id': crypto.randomBytes(16).toString('hex'),
          'X-Stress-Test': 'true',
          'X-Test-Mode': String(this.options.testMode),
        },
        body,
      });

      const responseTime = Date.now() - startTime;
      
      return {
        success: response.ok,
        responseTime,
        statusCode: response.status,
        error: response.ok ? undefined : await response.text(),
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return {
        success: false,
        responseTime,
        statusCode: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Send a single WooCommerce webhook
   */
  private async sendWooCommerceWebhook(payload: ReturnType<typeof generateWooCommerceWebhookPayload>): Promise<{
    success: boolean;
    responseTime: number;
    statusCode: number;
    error?: string;
  }> {
    const url = `${this.options.apiBaseUrl}${this.options.woocommerceWebhookPath}/${this.options.channelId}`;
    const body = JSON.stringify(payload.order);
    const signature = this.generateWooCommerceSignature(body);

    const startTime = Date.now();
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WC-Webhook-Topic': payload.topic,
          'X-WC-Webhook-Source': payload.source,
          'X-WC-Webhook-Signature': signature,
          'X-WC-Webhook-Delivery-ID': payload.deliveryId,
          'X-Stress-Test': 'true',
          'X-Test-Mode': String(this.options.testMode),
        },
        body,
      });

      const responseTime = Date.now() - startTime;
      
      return {
        success: response.ok,
        responseTime,
        statusCode: response.status,
        error: response.ok ? undefined : await response.text(),
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return {
        success: false,
        responseTime,
        statusCode: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Run stress test with specified scenario
   */
  async runScenario(scenario: ScenarioConfig): Promise<SimulatorResult> {
    console.log(`\n🚀 Starting stress test: ${scenario.name}`);
    console.log(`   Total orders: ${scenario.totalOrders}`);
    console.log(`   Duration: ${scenario.duration}s`);
    console.log(`   Pattern: ${scenario.pattern}`);
    console.log(`   Platform mix: ${scenario.shopifyPercentage}% Shopify, ${scenario.woocommercePercentage}% WooCommerce`);
    
    // Reset state
    resetAllGenerators();
    this.responseTimes = [];
    this.errors = [];
    this.platformStats = {
      shopify: { total: 0, successful: 0, failed: 0, responseTimes: [] },
      woocommerce: { total: 0, successful: 0, failed: 0, responseTimes: [] },
    };
    this.isRunning = true;
    this.shouldStop = false;

    // Generate all webhook payloads
    const payloads = generateMixedWebhookPayloads(
      scenario.totalOrders,
      scenario.shopifyPercentage
    );

    const startTime = Date.now();
    let completed = 0;
    let failed = 0;
    let inProgress = 0;

    // Calculate rate based on pattern
    const baseRate = scenario.totalOrders / scenario.duration; // orders per second

    // Process payloads with controlled concurrency
    const queue = [...payloads];
    const activePromises: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      if (this.shouldStop || queue.length === 0) return;

      const item = queue.shift();
      if (!item) return;

      inProgress++;
      
      let result;
      if (item.platform === 'shopify') {
        this.platformStats.shopify.total++;
        result = await this.sendShopifyWebhook(item.payload as ReturnType<typeof generateShopifyWebhookPayload>);
        
        if (result.success) {
          this.platformStats.shopify.successful++;
        } else {
          this.platformStats.shopify.failed++;
        }
        this.platformStats.shopify.responseTimes.push(result.responseTime);
      } else {
        this.platformStats.woocommerce.total++;
        result = await this.sendWooCommerceWebhook(item.payload as ReturnType<typeof generateWooCommerceWebhookPayload>);
        
        if (result.success) {
          this.platformStats.woocommerce.successful++;
        } else {
          this.platformStats.woocommerce.failed++;
        }
        this.platformStats.woocommerce.responseTimes.push(result.responseTime);
      }

      this.responseTimes.push(result.responseTime);
      inProgress--;

      if (result.success) {
        completed++;
      } else {
        failed++;
        const error: SimulatorError = {
          platform: item.platform,
          orderId: item.platform === 'shopify' 
            ? String((item.payload as any).order.id)
            : String((item.payload as any).order.id),
          statusCode: result.statusCode,
          message: result.error || 'Unknown error',
          timestamp: new Date(),
        };
        this.errors.push(error);
        this.options.onError(error);
      }

      // Report progress
      const elapsed = Date.now() - startTime;
      const rate = completed / (elapsed / 1000);
      const remaining = ((scenario.totalOrders - completed) / rate) * 1000;

      this.options.onProgress({
        total: scenario.totalOrders,
        completed,
        failed,
        inProgress,
        currentRate: rate,
        elapsedTime: elapsed,
        estimatedTimeRemaining: isFinite(remaining) ? remaining : 0,
        platform: {
          shopify: {
            completed: this.platformStats.shopify.successful,
            failed: this.platformStats.shopify.failed,
          },
          woocommerce: {
            completed: this.platformStats.woocommerce.successful,
            failed: this.platformStats.woocommerce.failed,
          },
        },
      });

      // Apply delay between requests if configured
      if (this.options.delayBetweenRequests > 0) {
        await new Promise(resolve => setTimeout(resolve, this.options.delayBetweenRequests));
      }

      // Continue processing
      await processNext();
    };

    // Start concurrent workers
    for (let i = 0; i < this.options.concurrency; i++) {
      activePromises.push(processNext());
    }

    // Wait for all to complete
    await Promise.all(activePromises);

    const duration = Date.now() - startTime;
    this.isRunning = false;

    // Calculate final stats
    const result: SimulatorResult = {
      success: failed === 0,
      totalOrders: scenario.totalOrders,
      successfulOrders: completed,
      failedOrders: failed,
      duration,
      averageResponseTime: this.responseTimes.length > 0 
        ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length 
        : 0,
      minResponseTime: this.responseTimes.length > 0 ? Math.min(...this.responseTimes) : 0,
      maxResponseTime: this.responseTimes.length > 0 ? Math.max(...this.responseTimes) : 0,
      p95ResponseTime: this.percentile(this.responseTimes, 95),
      p99ResponseTime: this.percentile(this.responseTimes, 99),
      requestsPerSecond: completed / (duration / 1000),
      errors: this.errors,
      platformStats: {
        shopify: {
          total: this.platformStats.shopify.total,
          successful: this.platformStats.shopify.successful,
          failed: this.platformStats.shopify.failed,
          averageResponseTime: this.platformStats.shopify.responseTimes.length > 0
            ? this.platformStats.shopify.responseTimes.reduce((a, b) => a + b, 0) / this.platformStats.shopify.responseTimes.length
            : 0,
          errors: this.errors.filter(e => e.platform === 'shopify'),
        },
        woocommerce: {
          total: this.platformStats.woocommerce.total,
          successful: this.platformStats.woocommerce.successful,
          failed: this.platformStats.woocommerce.failed,
          averageResponseTime: this.platformStats.woocommerce.responseTimes.length > 0
            ? this.platformStats.woocommerce.responseTimes.reduce((a, b) => a + b, 0) / this.platformStats.woocommerce.responseTimes.length
            : 0,
          errors: this.errors.filter(e => e.platform === 'woocommerce'),
        },
      },
    };

    console.log(`\n✅ Stress test completed!`);
    console.log(`   Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`   Success rate: ${((completed / scenario.totalOrders) * 100).toFixed(2)}%`);
    console.log(`   Avg response time: ${result.averageResponseTime.toFixed(2)}ms`);
    console.log(`   Requests/sec: ${result.requestsPerSecond.toFixed(2)}`);

    return result;
  }

  /**
   * Run a quick test with a small number of orders
   */
  async runQuickTest(orderCount: number = 10): Promise<SimulatorResult> {
    return this.runScenario({
      name: 'Quick Test',
      description: 'Quick validation test',
      totalOrders: orderCount,
      duration: 60,
      rampUpTime: 5,
      shopifyPercentage: 50,
      woocommercePercentage: 50,
      pattern: 'steady',
      concurrentUsers: 5,
    });
  }

  /**
   * Stop the currently running test
   */
  stop(): void {
    this.shouldStop = true;
  }

  /**
   * Check if a test is currently running
   */
  isTestRunning(): boolean {
    return this.isRunning;
  }
}

// Export singleton for convenience
export const webhookSimulator = new WebhookSimulator();

// Export for CLI usage
export async function runWebhookStressTest(
  scenario: ScenarioConfig,
  options?: WebhookSimulatorOptions
): Promise<SimulatorResult> {
  const simulator = new WebhookSimulator(options);
  return simulator.runScenario(scenario);
}
