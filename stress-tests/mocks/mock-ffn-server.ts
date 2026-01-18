/**
 * Mock JTL FFN API Server
 * Simulates the JTL FFN warehouse API for stress testing without affecting real warehouse
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export interface MockFFNConfig {
  port: number;
  latency: {
    min: number; // minimum response time in ms
    max: number; // maximum response time in ms
  };
  errorRate: number; // percentage of requests that should fail (0-100)
  rateLimitPerMinute: number;
  enableLogging: boolean;
}

export interface MockFFNStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  outboundsCreated: number;
  productsCreated: number;
  authRequests: number;
  averageLatency: number;
  requestsPerSecond: number;
  startTime: Date;
  lastRequestTime: Date | null;
}

export interface MockOutbound {
  id: string;
  merchantOutboundNumber: string;
  status: 'Created' | 'Processing' | 'Shipped' | 'Cancelled';
  createdAt: Date;
  items: Array<{
    merchantSku: string;
    quantity: number;
    jfsku: string;
  }>;
}

const defaultConfig: MockFFNConfig = {
  port: 3099,
  latency: {
    min: 50,
    max: 200,
  },
  errorRate: 0,
  rateLimitPerMinute: 1000,
  enableLogging: true,
};

export class MockFFNServer {
  private app: express.Application;
  private server: ReturnType<express.Application['listen']> | null = null;
  private config: MockFFNConfig;
  private stats: MockFFNStats;
  private outbounds: Map<string, MockOutbound> = new Map();
  private products: Map<string, any> = new Map();
  private tokens: Map<string, { expiresAt: Date; clientId: string }> = new Map();
  private requestTimes: number[] = [];
  private rateLimitWindow: number[] = [];

  constructor(config: Partial<MockFFNConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
    this.app = express();
    this.stats = this.initStats();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private initStats(): MockFFNStats {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      outboundsCreated: 0,
      productsCreated: 0,
      authRequests: 0,
      averageLatency: 0,
      requestsPerSecond: 0,
      startTime: new Date(),
      lastRequestTime: null,
    };
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '10mb' }));
    
    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();
      this.stats.totalRequests++;
      this.stats.lastRequestTime = new Date();
      
      // Rate limiting check
      const now = Date.now();
      this.rateLimitWindow = this.rateLimitWindow.filter(t => now - t < 60000);
      if (this.rateLimitWindow.length >= this.config.rateLimitPerMinute) {
        res.status(429).json({ error: 'Rate limit exceeded' });
        return;
      }
      this.rateLimitWindow.push(now);
      
      // Log request
      if (this.config.enableLogging) {
        console.log(`[Mock FFN] ${req.method} ${req.path}`);
      }
      
      // Capture response for stats
      const originalSend = res.send.bind(res);
      res.send = (body: any) => {
        const latency = Date.now() - startTime;
        this.requestTimes.push(latency);
        
        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.stats.successfulRequests++;
        } else {
          this.stats.failedRequests++;
        }
        
        // Update average latency (rolling window of last 1000 requests)
        if (this.requestTimes.length > 1000) {
          this.requestTimes.shift();
        }
        this.stats.averageLatency = 
          this.requestTimes.reduce((a, b) => a + b, 0) / this.requestTimes.length;
        
        return originalSend(body);
      };
      
      next();
    });
  }

  private async simulateLatency(): Promise<void> {
    const latency = this.config.latency.min + 
      Math.random() * (this.config.latency.max - this.config.latency.min);
    await new Promise(resolve => setTimeout(resolve, latency));
  }

  private shouldFail(): boolean {
    return Math.random() * 100 < this.config.errorRate;
  }

  private generateId(): string {
    return `FFN-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'healthy', uptime: Date.now() - this.stats.startTime.getTime() });
    });

    // OAuth2 Token endpoint
    this.app.post('/oauth/token', async (req: Request, res: Response) => {
      await this.simulateLatency();
      this.stats.authRequests++;

      if (this.shouldFail()) {
        res.status(500).json({ error: 'Internal server error' });
        return;
      }

      const { client_id, client_secret, grant_type } = req.body;

      if (grant_type !== 'client_credentials') {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
      }

      if (!client_id || !client_secret) {
        res.status(401).json({ error: 'invalid_client' });
        return;
      }

      const accessToken = crypto.randomBytes(32).toString('hex');
      const refreshToken = crypto.randomBytes(32).toString('hex');
      const expiresIn = 3600; // 1 hour

      this.tokens.set(accessToken, {
        expiresAt: new Date(Date.now() + expiresIn * 1000),
        clientId: client_id,
      });

      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        refresh_token: refreshToken,
      });
    });

    // Verify token middleware for protected routes
    const verifyToken = (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid authorization header' });
        return;
      }

      const token = authHeader.substring(7);
      const tokenData = this.tokens.get(token);

      // For testing, accept any token that looks valid
      if (!tokenData && token.length < 10) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      next();
    };

    // Create Outbound Order
    this.app.post('/api/merchant/outbounds', verifyToken, async (req: Request, res: Response) => {
      await this.simulateLatency();

      if (this.shouldFail()) {
        res.status(500).json({
          error: 'InternalServerError',
          message: 'An unexpected error occurred while processing the outbound order',
        });
        return;
      }

      const { merchantOutboundNumber, items, shipTo, shippingMethodId } = req.body;

      if (!merchantOutboundNumber) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'merchantOutboundNumber is required',
        });
        return;
      }

      if (!items || items.length === 0) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'At least one item is required',
        });
        return;
      }

      // Check for duplicate
      const existing = Array.from(this.outbounds.values()).find(
        o => o.merchantOutboundNumber === merchantOutboundNumber
      );
      if (existing) {
        res.status(409).json({
          error: 'DuplicateError',
          message: `Outbound with merchantOutboundNumber ${merchantOutboundNumber} already exists`,
        });
        return;
      }

      const outboundId = this.generateId();
      const outbound: MockOutbound = {
        id: outboundId,
        merchantOutboundNumber,
        status: 'Created',
        createdAt: new Date(),
        items: items.map((item: any) => ({
          merchantSku: item.merchantSku,
          quantity: item.quantity,
          jfsku: `JF-${item.merchantSku}`,
        })),
      };

      this.outbounds.set(outboundId, outbound);
      this.stats.outboundsCreated++;

      res.status(201).json({
        id: outboundId,
        merchantOutboundNumber,
        status: 'Created',
        items: outbound.items,
        shipTo,
        shippingMethodId,
        createdAt: outbound.createdAt.toISOString(),
      });
    });

    // Get Outbound Order
    this.app.get('/api/merchant/outbounds/:id', verifyToken, async (req: Request, res: Response) => {
      await this.simulateLatency();

      if (this.shouldFail()) {
        res.status(500).json({ error: 'InternalServerError' });
        return;
      }

      const outbound = this.outbounds.get(req.params.id);
      if (!outbound) {
        res.status(404).json({
          error: 'NotFound',
          message: `Outbound ${req.params.id} not found`,
        });
        return;
      }

      res.json(outbound);
    });

    // Cancel Outbound Order
    this.app.post('/api/merchant/outbounds/:id/cancel', verifyToken, async (req: Request, res: Response) => {
      await this.simulateLatency();

      if (this.shouldFail()) {
        res.status(500).json({ error: 'InternalServerError' });
        return;
      }

      const outbound = this.outbounds.get(req.params.id);
      if (!outbound) {
        res.status(404).json({
          error: 'NotFound',
          message: `Outbound ${req.params.id} not found`,
        });
        return;
      }

      if (outbound.status === 'Shipped') {
        res.status(400).json({
          error: 'InvalidOperation',
          message: 'Cannot cancel a shipped outbound',
        });
        return;
      }

      outbound.status = 'Cancelled';
      res.json({ success: true, status: 'Cancelled' });
    });

    // Create Product
    this.app.post('/api/merchant/products', verifyToken, async (req: Request, res: Response) => {
      await this.simulateLatency();

      if (this.shouldFail()) {
        res.status(500).json({ error: 'InternalServerError' });
        return;
      }

      const { merchantSku, name, identifier } = req.body;

      if (!merchantSku) {
        res.status(400).json({
          error: 'ValidationError',
          message: 'merchantSku is required',
        });
        return;
      }

      const productId = this.generateId();
      const jfsku = `JF-${merchantSku}`;

      const product = {
        id: productId,
        jfsku,
        merchantSku,
        name,
        identifier,
        createdAt: new Date(),
      };

      this.products.set(productId, product);
      this.stats.productsCreated++;

      res.status(201).json(product);
    });

    // Get Product
    this.app.get('/api/merchant/products/:id', verifyToken, async (req: Request, res: Response) => {
      await this.simulateLatency();

      const product = this.products.get(req.params.id);
      if (!product) {
        res.status(404).json({
          error: 'NotFound',
          message: `Product ${req.params.id} not found`,
        });
        return;
      }

      res.json(product);
    });

    // List Products
    this.app.get('/api/merchant/products', verifyToken, async (req: Request, res: Response) => {
      await this.simulateLatency();

      const products = Array.from(this.products.values());
      res.json({
        items: products,
        total: products.length,
        page: 1,
        pageSize: products.length,
      });
    });

    // Get Shipping Methods
    this.app.get('/api/merchant/shipping-methods', verifyToken, async (req: Request, res: Response) => {
      await this.simulateLatency();

      res.json({
        items: [
          { id: 'FULF0A0001', name: 'Standard Shipping', carrier: 'DHL' },
          { id: 'FULF0A0002', name: 'Express Shipping', carrier: 'DHL Express' },
          { id: 'FULF0A0003', name: 'Economy Shipping', carrier: 'Hermes' },
          { id: 'FULF0A0004', name: 'International', carrier: 'DHL International' },
        ],
      });
    });

    // Stats endpoint (for monitoring)
    this.app.get('/mock-stats', (_req: Request, res: Response) => {
      const uptime = Date.now() - this.stats.startTime.getTime();
      res.json({
        ...this.stats,
        uptime,
        requestsPerSecond: this.stats.totalRequests / (uptime / 1000),
        outboundsInMemory: this.outbounds.size,
        productsInMemory: this.products.size,
        activeTokens: this.tokens.size,
      });
    });

    // Reset endpoint (for testing)
    this.app.post('/mock-reset', (_req: Request, res: Response) => {
      this.outbounds.clear();
      this.products.clear();
      this.tokens.clear();
      this.stats = this.initStats();
      this.requestTimes = [];
      this.rateLimitWindow = [];
      res.json({ success: true, message: 'Mock server reset' });
    });

    // Configure endpoint (change settings at runtime)
    this.app.post('/mock-configure', (req: Request, res: Response) => {
      const { latency, errorRate, rateLimitPerMinute, enableLogging } = req.body;
      
      if (latency) {
        this.config.latency = { ...this.config.latency, ...latency };
      }
      if (typeof errorRate === 'number') {
        this.config.errorRate = Math.max(0, Math.min(100, errorRate));
      }
      if (typeof rateLimitPerMinute === 'number') {
        this.config.rateLimitPerMinute = rateLimitPerMinute;
      }
      if (typeof enableLogging === 'boolean') {
        this.config.enableLogging = enableLogging;
      }

      res.json({ success: true, config: this.config });
    });
  }

  /**
   * Start the mock server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, () => {
          console.log(`🔧 Mock JTL FFN Server running on port ${this.config.port}`);
          console.log(`   Latency: ${this.config.latency.min}-${this.config.latency.max}ms`);
          console.log(`   Error rate: ${this.config.errorRate}%`);
          console.log(`   Rate limit: ${this.config.rateLimitPerMinute}/min`);
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the mock server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('Mock JTL FFN Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get current stats
   */
  getStats(): MockFFNStats {
    return { ...this.stats };
  }

  /**
   * Get current config
   */
  getConfig(): MockFFNConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MockFFNConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Export for CLI usage
export async function startMockFFNServer(config?: Partial<MockFFNConfig>): Promise<MockFFNServer> {
  const server = new MockFFNServer(config);
  await server.start();
  return server;
}

// Run directly if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const port = parseInt(process.env.MOCK_FFN_PORT || '3099', 10);
  const errorRate = parseFloat(process.env.MOCK_FFN_ERROR_RATE || '0');
  
  startMockFFNServer({ port, errorRate }).catch(console.error);
}
