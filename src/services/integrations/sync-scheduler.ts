/**
 * Sync Scheduler Service
 * Manages scheduled sync jobs for all channels
 * Runs periodic sync between e-commerce platforms and JTL FFN
 */

import { PrismaClient, ChannelType } from '@prisma/client';
import { SyncOrchestrator } from './sync-orchestrator.js';
import { SyncResult } from './types.js';
import { getEncryptionService } from '../encryption.service.js';
import { JTLService } from './jtl.service.js';
import { StockSyncService } from './stock-sync.service.js';

interface SchedulerConfig {
  /**
   * Interval for incremental sync in minutes
   * Default: 5 minutes
   */
  incrementalSyncIntervalMinutes: number;

  /**
   * Interval for full sync in hours
   * Default: 24 hours
   */
  fullSyncIntervalHours: number;

  /**
   * Interval for polling JTL updates in minutes
   * Default: 2 minutes
   */
  jtlPollIntervalMinutes: number;

  /**
   * Maximum concurrent channel syncs
   * Default: 3
   */
  maxConcurrentSyncs: number;

  /**
   * Interval for proactive JTL token refresh in hours
   * Default: 12 hours
   */
  tokenRefreshIntervalHours: number;

  /**
   * Interval for stock sync from JTL FFN in minutes
   * Default: 15 minutes (safety net - inbound-triggered sync is faster)
   */
  stockSyncIntervalMinutes: number;

  /**
   * Interval for polling JTL inbounds for stock changes in minutes
   * Default: 2 minutes (same as JTL poll - for near real-time stock updates)
   */
  inboundPollIntervalMinutes: number;
}

interface ChannelSyncState {
  channelId: string;
  lastIncrementalSync?: Date;
  lastFullSync?: Date;
  lastJtlPoll?: Date;
  isRunning: boolean;
  lastError?: string;
}

interface SyncJobResult {
  channelId: string;
  success: boolean;
  productsResult?: SyncResult;
  ordersResult?: SyncResult;
  returnsResult?: SyncResult;
  jtlUpdatesResult?: SyncResult;
  error?: string;
  duration: number;
}

// Type for channel with JTL config
interface ChannelWithConfig {
  id: string;
  type: ChannelType;
  shopDomain?: string | null;
  accessToken?: string | null;
  apiUrl?: string | null;
  apiClientId?: string | null;
  apiClientSecret?: string | null;
  client: {
    jtlConfig?: {
      clientId: string;
      clientSecret: string;
      accessToken?: string | null;
      refreshToken?: string | null;
      warehouseId: string;
      fulfillerId: string;
      environment: string;
    } | null;
  };
}

export class SyncScheduler {
  private prisma: PrismaClient;
  private config: SchedulerConfig;
  private channelStates: Map<string, ChannelSyncState> = new Map();
  private incrementalTimer?: NodeJS.Timeout;
  private fullSyncTimer?: NodeJS.Timeout;
  private jtlPollTimer?: NodeJS.Timeout;
  private tokenRefreshTimer?: NodeJS.Timeout;
  private stockSyncTimer?: NodeJS.Timeout;
  private inboundPollTimer?: NodeJS.Timeout;
  private stockSyncService: StockSyncService;
  private isRunning = false;

  private static readonly DEFAULT_CONFIG: SchedulerConfig = {
    incrementalSyncIntervalMinutes: 5,
    fullSyncIntervalHours: 24,
    jtlPollIntervalMinutes: 2,
    maxConcurrentSyncs: 3,
    tokenRefreshIntervalHours: 12,
    stockSyncIntervalMinutes: 15,
    inboundPollIntervalMinutes: 2,
  };

  constructor(prisma: PrismaClient, config?: Partial<SchedulerConfig>) {
    this.prisma = prisma;
    this.config = { ...SyncScheduler.DEFAULT_CONFIG, ...config };
    this.stockSyncService = new StockSyncService(prisma);
  }

  /**
   * Start the sync scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Sync scheduler is already running');
      return;
    }

    console.log('Starting sync scheduler...');
    this.isRunning = true;

    // Initialize channel states
    await this.initializeChannelStates();

    // Start timers
    this.startIncrementalSyncTimer();
    this.startFullSyncTimer();
    this.startJtlPollTimer();
    this.startTokenRefreshTimer();
    this.startStockSyncTimer();
    this.startInboundPollTimer();

    console.log('Sync scheduler started successfully');
    console.log(`- Incremental sync: every ${this.config.incrementalSyncIntervalMinutes} minutes`);
    console.log(`- Full sync: every ${this.config.fullSyncIntervalHours} hours`);
    console.log(`- JTL polling: every ${this.config.jtlPollIntervalMinutes} minutes`);
    console.log(`- Token refresh: every ${this.config.tokenRefreshIntervalHours} hours`);
    console.log(`- Stock sync (safety net): every ${this.config.stockSyncIntervalMinutes} minutes`);
    console.log(`- Inbound poll (stock trigger): every ${this.config.inboundPollIntervalMinutes} minutes`);
  }

  /**
   * Stop the sync scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      console.log('Sync scheduler is not running');
      return;
    }

    console.log('Stopping sync scheduler...');

    if (this.incrementalTimer) {
      clearInterval(this.incrementalTimer);
      this.incrementalTimer = undefined;
    }

    if (this.fullSyncTimer) {
      clearInterval(this.fullSyncTimer);
      this.fullSyncTimer = undefined;
    }

    if (this.jtlPollTimer) {
      clearInterval(this.jtlPollTimer);
      this.jtlPollTimer = undefined;
    }

    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    if (this.stockSyncTimer) {
      clearInterval(this.stockSyncTimer);
      this.stockSyncTimer = undefined;
    }

    if (this.inboundPollTimer) {
      clearInterval(this.inboundPollTimer);
      this.inboundPollTimer = undefined;
    }

    this.isRunning = false;
    console.log('Sync scheduler stopped');
  }

  /**
   * Initialize channel states from database
   */
  private async initializeChannelStates(): Promise<void> {
    const channels = await this.prisma.channel.findMany({
      where: {
        isActive: true,
        type: { in: ['SHOPIFY', 'WOOCOMMERCE'] },
      },
      include: {
        client: {
          include: {
            jtlConfig: true,
          },
        },
      },
    });

    for (const channel of channels) {
      this.channelStates.set(channel.id, {
        channelId: channel.id,
        isRunning: false,
      });
    }

    console.log(`Initialized ${channels.length} channels for sync`);
  }

  /**
   * Start incremental sync timer
   */
  private startIncrementalSyncTimer(): void {
    const intervalMs = this.config.incrementalSyncIntervalMinutes * 60 * 1000;
    
    // Run immediately on start
    this.runIncrementalSyncForAllChannels();

    this.incrementalTimer = setInterval(() => {
      this.runIncrementalSyncForAllChannels();
    }, intervalMs);
  }

  /**
   * Start full sync timer
   */
  private startFullSyncTimer(): void {
    const intervalMs = this.config.fullSyncIntervalHours * 60 * 60 * 1000;

    this.fullSyncTimer = setInterval(() => {
      this.runFullSyncForAllChannels();
    }, intervalMs);
  }

  /**
   * Start JTL polling timer
   */
  private startJtlPollTimer(): void {
    const intervalMs = this.config.jtlPollIntervalMinutes * 60 * 1000;

    // Run immediately on start
    this.pollJtlUpdatesForAllChannels();

    this.jtlPollTimer = setInterval(() => {
      this.pollJtlUpdatesForAllChannels();
    }, intervalMs);
  }

  /**
   * Start proactive JTL token refresh timer
   */
  private startTokenRefreshTimer(): void {
    const intervalMs = this.config.tokenRefreshIntervalHours * 60 * 60 * 1000;

    // Run once on startup
    this.refreshAllJTLTokens();

    this.tokenRefreshTimer = setInterval(() => {
      this.refreshAllJTLTokens();
    }, intervalMs);
  }

  /**
   * Start periodic stock sync timer (safety net)
   * This ensures stock is synced even if inbound polling misses updates
   */
  private startStockSyncTimer(): void {
    const intervalMs = this.config.stockSyncIntervalMinutes * 60 * 1000;

    // Run on startup after a short delay (let other services initialize)
    setTimeout(() => {
      this.runStockSyncForAllClients();
    }, 10000); // 10 second delay

    this.stockSyncTimer = setInterval(() => {
      this.runStockSyncForAllClients();
    }, intervalMs);
  }

  /**
   * Start inbound polling timer for event-driven stock sync
   * When inbounds close (goods received), immediately sync stock
   */
  private startInboundPollTimer(): void {
    const intervalMs = this.config.inboundPollIntervalMinutes * 60 * 1000;

    // Run on startup after a short delay
    setTimeout(() => {
      this.pollInboundsAndSyncStock();
    }, 15000); // 15 second delay

    this.inboundPollTimer = setInterval(() => {
      this.pollInboundsAndSyncStock();
    }, intervalMs);
  }

  /**
   * Run stock sync for all clients (periodic safety net)
   */
  async runStockSyncForAllClients(): Promise<void> {
    console.log('[Scheduler] Starting periodic stock sync for all clients...');

    try {
      const result = await this.stockSyncService.syncStockForAllClients();
      console.log(`[Scheduler] Stock sync completed: ${result.clientsProcessed} clients, ${result.totalProductsUpdated} products updated, ${result.totalProductsFailed} failed`);
    } catch (error) {
      console.error('[Scheduler] Stock sync failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Poll inbounds and sync stock when inbounds close
   */
  async pollInboundsAndSyncStock(): Promise<void> {
    console.log('[Scheduler] Polling inbounds for stock changes...');

    try {
      const result = await this.stockSyncService.pollInboundsAndSyncForAllClients();
      console.log(`[Scheduler] Inbound polling completed: ${result.clientsProcessed} clients, ${result.totalInboundsProcessed} inbounds, ${result.stockSyncsTriggered} stock syncs triggered`);
    } catch (error) {
      console.error('[Scheduler] Inbound polling failed:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Manually trigger stock sync for a specific client
   */
  async triggerStockSyncForClient(clientId: string): Promise<{
    success: boolean;
    productsUpdated: number;
    errors: string[];
  }> {
    console.log(`[Scheduler] Manual stock sync triggered for client ${clientId}`);

    try {
      const result = await this.stockSyncService.syncStockForClient(clientId);
      return {
        success: result.success,
        productsUpdated: result.productsUpdated,
        errors: result.errors,
      };
    } catch (error) {
      return {
        success: false,
        productsUpdated: 0,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      };
    }
  }

  /**
   * Proactively refresh all JTL tokens to prevent expiration
   */
  async refreshAllJTLTokens(): Promise<void> {
    console.log('[Scheduler] Starting proactive JTL token refresh...');

    const configs = await this.prisma.jtlConfig.findMany({
      where: { isActive: true },
    });

    if (configs.length === 0) {
      console.log('[Scheduler] No active JTL configs found');
      return;
    }

    const encryptionService = getEncryptionService();
    let success = 0;
    let failed = 0;

    for (const config of configs) {
      try {
        // Skip if no refresh token (can't refresh)
        if (!config.refreshToken) {
          console.warn(`[TokenRefresh] Skipping client ${config.clientId_fk} - no refresh token`);
          continue;
        }

        const jtlService = new JTLService({
          clientId: config.clientId,
          clientSecret: encryptionService.safeDecrypt(config.clientSecret),
          accessToken: config.accessToken ? encryptionService.safeDecrypt(config.accessToken) : undefined,
          refreshToken: encryptionService.safeDecrypt(config.refreshToken),
          tokenExpiresAt: config.tokenExpiresAt ?? undefined,
          environment: config.environment as 'sandbox' | 'production',
          fulfillerId: config.fulfillerId,
          warehouseId: config.warehouseId,
        }, this.prisma, config.clientId_fk);

        await jtlService.refreshAndPersistToken(config.clientId_fk, this.prisma);
        console.log(`[TokenRefresh] ✓ Refreshed tokens for client ${config.clientId_fk}`);
        success++;
      } catch (error) {
        console.error(`[TokenRefresh] ✗ Failed for client ${config.clientId_fk}:`, error instanceof Error ? error.message : 'Unknown error');
        failed++;
      }
    }

    console.log(`[Scheduler] Token refresh complete: ${success} success, ${failed} failed`);
  }

  /**
   * Run incremental sync for all channels
   */
  async runIncrementalSyncForAllChannels(): Promise<SyncJobResult[]> {
    console.log('[Scheduler] Starting incremental sync for all channels...');
    
    const channels = await this.getActiveChannels();
    const results: SyncJobResult[] = [];
    
    // Process channels in batches
    const batches = this.chunkArray(channels, this.config.maxConcurrentSyncs);
    
    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(channel => this.runIncrementalSyncForChannel(channel))
      );
      results.push(...batchResults);
    }

    console.log(`[Scheduler] Incremental sync completed. ${results.filter(r => r.success).length}/${results.length} successful`);
    return results;
  }

  /**
   * Run full sync for all channels
   */
  async runFullSyncForAllChannels(): Promise<SyncJobResult[]> {
    console.log('[Scheduler] Starting full sync for all channels...');
    
    const channels = await this.getActiveChannels();
    const results: SyncJobResult[] = [];
    
    const batches = this.chunkArray(channels, this.config.maxConcurrentSyncs);
    
    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(channel => this.runFullSyncForChannel(channel))
      );
      results.push(...batchResults);
    }

    console.log(`[Scheduler] Full sync completed. ${results.filter(r => r.success).length}/${results.length} successful`);
    return results;
  }

  /**
   * Poll JTL updates for all channels
   */
  async pollJtlUpdatesForAllChannels(): Promise<SyncJobResult[]> {
    console.log('[Scheduler] Polling JTL updates for all channels...');
    
    const channels = await this.getActiveChannels();
    const results: SyncJobResult[] = [];
    
    const batches = this.chunkArray(channels, this.config.maxConcurrentSyncs);
    
    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(channel => this.pollJtlUpdatesForChannel(channel))
      );
      results.push(...batchResults);
    }

    console.log(`[Scheduler] JTL polling completed. ${results.filter(r => r.success).length}/${results.length} successful`);
    return results;
  }

  /**
   * Run incremental sync for a single channel
   */
  private async runIncrementalSyncForChannel(channel: ChannelWithConfig): Promise<SyncJobResult> {
    const startTime = Date.now();
    const state = this.channelStates.get(channel.id);
    
    if (!state) {
      return {
        channelId: channel.id,
        success: false,
        error: 'Channel state not found',
        duration: 0,
      };
    }

    if (state.isRunning) {
      return {
        channelId: channel.id,
        success: false,
        error: 'Sync already in progress',
        duration: 0,
      };
    }

    state.isRunning = true;

    try {
      const orchestrator = this.createOrchestrator(channel);
      
      if (!orchestrator) {
        throw new Error('Could not create sync orchestrator - missing credentials');
      }

      const since = state.lastIncrementalSync || new Date(Date.now() - 24 * 60 * 60 * 1000); // Default to 24h ago
      
      const result = await orchestrator.runIncrementalSync(since);

      state.lastIncrementalSync = new Date();
      state.lastError = undefined;

      return {
        channelId: channel.id,
        success: true,
        productsResult: result.products,
        ordersResult: result.orders,
        returnsResult: result.returns,
        jtlUpdatesResult: result.jtlOutboundUpdates,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      state.lastError = errorMessage;
      
      console.error(`[Scheduler] Incremental sync failed for channel ${channel.id}:`, errorMessage);
      
      return {
        channelId: channel.id,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    } finally {
      state.isRunning = false;
    }
  }

  /**
   * Run full sync for a single channel
   */
  private async runFullSyncForChannel(channel: ChannelWithConfig): Promise<SyncJobResult> {
    const startTime = Date.now();
    const state = this.channelStates.get(channel.id);
    
    if (!state) {
      return {
        channelId: channel.id,
        success: false,
        error: 'Channel state not found',
        duration: 0,
      };
    }

    if (state.isRunning) {
      return {
        channelId: channel.id,
        success: false,
        error: 'Sync already in progress',
        duration: 0,
      };
    }

    state.isRunning = true;

    try {
      const orchestrator = this.createOrchestrator(channel);
      
      if (!orchestrator) {
        throw new Error('Could not create sync orchestrator - missing credentials');
      }

      const result = await orchestrator.runFullSync();

      state.lastFullSync = new Date();
      state.lastError = undefined;

      return {
        channelId: channel.id,
        success: true,
        productsResult: result.products,
        ordersResult: result.orders,
        returnsResult: result.returns,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      state.lastError = errorMessage;
      
      console.error(`[Scheduler] Full sync failed for channel ${channel.id}:`, errorMessage);
      
      return {
        channelId: channel.id,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    } finally {
      state.isRunning = false;
    }
  }

  /**
   * Poll JTL updates for a single channel
   */
  private async pollJtlUpdatesForChannel(channel: ChannelWithConfig): Promise<SyncJobResult> {
    const startTime = Date.now();
    const state = this.channelStates.get(channel.id);
    
    if (!state) {
      return {
        channelId: channel.id,
        success: false,
        error: 'Channel state not found',
        duration: 0,
      };
    }

    try {
      const orchestrator = this.createOrchestrator(channel);
      
      if (!orchestrator) {
        throw new Error('Could not create sync orchestrator - missing credentials');
      }

      const since = state.lastJtlPoll || new Date(Date.now() - 60 * 60 * 1000); // Default to 1h ago
      
      const outboundResult = await orchestrator.pollJTLOutboundUpdates(since);
      const returnResult = await orchestrator.pollJTLReturnUpdates(since);

      state.lastJtlPoll = new Date();

      return {
        channelId: channel.id,
        success: true,
        jtlUpdatesResult: {
          success: outboundResult.success && returnResult.success,
          syncedAt: new Date(),
          itemsProcessed: outboundResult.itemsProcessed + returnResult.itemsProcessed,
          itemsFailed: outboundResult.itemsFailed + returnResult.itemsFailed,
        },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      console.error(`[Scheduler] JTL polling failed for channel ${channel.id}:`, errorMessage);
      
      return {
        channelId: channel.id,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Get all active channels with their configurations
   */
  private async getActiveChannels(): Promise<ChannelWithConfig[]> {
    return this.prisma.channel.findMany({
      where: {
        isActive: true,
        type: { in: ['SHOPIFY', 'WOOCOMMERCE'] },
      },
      include: {
        client: {
          include: {
            jtlConfig: true,
          },
        },
      },
    }) as unknown as Promise<ChannelWithConfig[]>;
  }

  /**
   * Create a sync orchestrator for a channel
   */
  private createOrchestrator(channel: ChannelWithConfig): SyncOrchestrator | null {
    const jtlConfig = channel.client.jtlConfig;

    if (!jtlConfig) {
      console.warn(`[Scheduler] No JTL config for channel ${channel.id}`);
      return null;
    }

    // Get encryption service for decrypting channel credentials
    const encryptionService = getEncryptionService();

    // Build config based on channel type
    if (channel.type === 'SHOPIFY') {
      if (!channel.shopDomain || !channel.accessToken) {
        console.warn(`[Scheduler] Missing Shopify credentials for channel ${channel.id}`);
        return null;
      }

      return new SyncOrchestrator(this.prisma, {
        channelId: channel.id,
        channelType: 'SHOPIFY',
        shopifyCredentials: {
          shopDomain: channel.shopDomain,
          accessToken: encryptionService.safeDecrypt(channel.accessToken),
        },
        jtlCredentials: {
          clientId: jtlConfig.clientId,
          clientSecret: jtlConfig.clientSecret,
          accessToken: jtlConfig.accessToken || undefined,
          refreshToken: jtlConfig.refreshToken || undefined,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        },
        jtlWarehouseId: jtlConfig.warehouseId,
        jtlFulfillerId: jtlConfig.fulfillerId,
      });
    } else if (channel.type === 'WOOCOMMERCE') {
      if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
        console.warn(`[Scheduler] Missing WooCommerce credentials for channel ${channel.id}`);
        return null;
      }

      return new SyncOrchestrator(this.prisma, {
        channelId: channel.id,
        channelType: 'WOOCOMMERCE',
        wooCommerceCredentials: {
          url: channel.apiUrl,
          consumerKey: encryptionService.safeDecrypt(channel.apiClientId),
          consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
        },
        jtlCredentials: {
          clientId: jtlConfig.clientId,
          clientSecret: jtlConfig.clientSecret,
          accessToken: jtlConfig.accessToken || undefined,
          refreshToken: jtlConfig.refreshToken || undefined,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        },
        jtlWarehouseId: jtlConfig.warehouseId,
        jtlFulfillerId: jtlConfig.fulfillerId,
      });
    }

    return null;
  }

  /**
   * Manually trigger sync for a specific channel
   */
  async triggerSyncForChannel(channelId: string, fullSync = false): Promise<SyncJobResult> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      include: {
        client: {
          include: {
            jtlConfig: true,
          },
        },
      },
    });

    if (!channel) {
      return {
        channelId,
        success: false,
        error: 'Channel not found',
        duration: 0,
      };
    }

    if (fullSync) {
      return this.runFullSyncForChannel(channel);
    } else {
      return this.runIncrementalSyncForChannel(channel);
    }
  }

  /**
   * Get sync status for all channels
   */
  getSyncStatus(): ChannelSyncState[] {
    return Array.from(this.channelStates.values());
  }

  /**
   * Get sync status for a specific channel
   */
  getChannelSyncStatus(channelId: string): ChannelSyncState | undefined {
    return this.channelStates.get(channelId);
  }

  /**
   * Helper to chunk array into batches
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

export default SyncScheduler;
