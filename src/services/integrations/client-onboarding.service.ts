/**
 * Client Onboarding Service
 * Handles the complete flow of onboarding a new client with their
 * Shopify/WooCommerce shop credentials and JTL-FFN API access
 * 
 * Flow:
 * 1. Create Client account
 * 2. Collect JTL-FFN OAuth credentials (client owns their JTL tenant)
 * 3. Add Shopify/WooCommerce channels with API credentials
 * 4. Register webhooks on the e-commerce platforms
 * 5. Trigger initial sync (products → orders → returns)
 */

import { PrismaClient, ChannelType, ChannelStatus, UserRole } from '@prisma/client';
import { ShopifyService } from './shopify.service.js';
import { createShopifyServiceAuto } from './shopify-service-factory.js';
import { WooCommerceService } from './woocommerce.service.js';
import { JTLService } from './jtl.service.js';
import { SyncOrchestrator } from './sync-orchestrator.js';
import { getEncryptionService } from '../encryption.service.js';
import { ShippingMethodService } from '../shipping-method.service.js';
import type { ShopifyCredentials, WooCommerceCredentials, JTLCredentials } from './types.js';
import crypto from 'crypto';

// ============= TYPES =============

export interface CreateClientInput {
  // User info for the client portal access
  email: string;
  password: string; // Will be hashed
  name: string;
  phone?: string;

  // Company info
  companyName: string;
  companyAddress?: string;
  billingEmail?: string;
  billingAddress?: string;
  vatNumber?: string;
}

export interface JTLSetupInput {
  clientId: string; // Our internal client ID
  jtlClientId: string; // JTL OAuth Client ID
  jtlClientSecret: string; // JTL OAuth Client Secret
  fulfillerId: string; // Client's fulfiller ID in JTL
  warehouseId: string; // Warehouse ID in JTL (your warehouse)
  environment: 'sandbox' | 'production';
}

export interface ShopifyChannelInput {
  clientId: string;
  shopDomain: string; // e.g., "mystore.myshopify.com"
  accessToken: string; // Shopify Admin API access token
  channelName?: string; // Optional display name
  syncFromDate?: string; // ISO date string for historical sync
  enableHistoricalSync?: boolean; // If true, sync from syncFromDate; if false, only quick sync (7 days)
}

export interface WooCommerceChannelInput {
  clientId: string;
  storeUrl: string; // e.g., "https://mystore.com"
  consumerKey: string;
  consumerSecret: string;
  channelName?: string;
  syncFromDate?: string; // ISO date string for historical sync
  enableHistoricalSync?: boolean; // If true, sync from syncFromDate; if false, only quick sync (7 days)
}

export interface ShopifySharedOAuthInput {
  clientId: string;
  shopDomain: string; // e.g., "mystore.myshopify.com"
  channelName?: string;
}

export interface ShopifyClientOAuthInput {
  clientId: string;
  shopDomain: string; // e.g., "mystore.myshopify.com"
  apiClientId: string; // Client's Shopify app client ID
  apiClientSecret: string; // Client's Shopify app client secret
  channelName?: string;
}

export interface ShopifyOAuthCallbackData {
  code: string;
  state: string;
  shopDomain: string;
}

export interface OnboardingResult {
  success: boolean;
  clientId?: string;
  channelId?: string;
  syncJobId?: string;
  error?: string;
  details?: Record<string, unknown>;
}

// ============= SERVICE =============

export class ClientOnboardingService {
  // Track active background syncs to prevent garbage collection
  private static activeBackgroundSyncs = new Set<Promise<void>>();

  constructor(private prisma: PrismaClient) {}

  /**
   * Step 1: Create a new client account
   * This creates the User (with CLIENT role) and Client record
   */
  async createClient(input: CreateClientInput): Promise<OnboardingResult> {
    try {
      // Check if user already exists
      const existingUser = await this.prisma.user.findUnique({
        where: { email: input.email },
      });

      if (existingUser) {
        return {
          success: false,
          error: 'A user with this email already exists',
        };
      }

      // Hash password (in production, use bcrypt or argon2)
      const hashedPassword = await this.hashPassword(input.password);

      // Create user and client in a transaction
      const result = await this.prisma.$transaction(async (tx) => {
        // Create user with CLIENT role
        const user = await tx.user.create({
          data: {
            email: input.email,
            password: hashedPassword,
            name: input.name,
            phone: input.phone,
            role: UserRole.CLIENT,
            isActive: true,
          },
        });

        // Create client record linked to user
        const client = await tx.client.create({
          data: {
            userId: user.id,
            name: input.name,
            companyName: input.companyName,
            email: input.billingEmail || input.email,
            phone: input.phone,
            address: input.companyAddress,
            isActive: true,
          },
        });

        return { user, client };
      });

      return {
        success: true,
        clientId: result.client.id,
        details: {
          userId: result.user.id,
          email: result.user.email,
          companyName: result.client.companyName,
        },
      };
    } catch (error) {
      console.error('Error creating client:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create client',
      };
    }
  }

  /**
   * Step 2: Setup JTL-FFN API credentials for a client
   * The client provides their JTL OAuth credentials (they own the JTL tenant)
   */
  async setupJTLCredentials(input: JTLSetupInput): Promise<OnboardingResult> {
    try {
      // Verify client exists
      const client = await this.prisma.client.findUnique({
        where: { id: input.clientId },
        include: { jtlConfig: true },
      });

      if (!client) {
        return {
          success: false,
          error: 'Client not found',
        };
      }

      // Test JTL connection before saving
      const jtlService = new JTLService({
        clientId: input.jtlClientId,
        clientSecret: input.jtlClientSecret,
        environment: input.environment,
      });

      // Encrypt the client secret before storing
      const encryptionService = getEncryptionService();
      const encryptedSecret = encryptionService.encrypt(input.jtlClientSecret);
      console.log(`🔐 [JTL Setup] Encrypting client secret for storage`);

      // Create or update JTL config
      const jtlConfig = await this.prisma.jtlConfig.upsert({
        where: { clientId_fk: input.clientId },
        create: {
          clientId_fk: input.clientId,
          clientId: input.jtlClientId,
          clientSecret: encryptedSecret,
          fulfillerId: input.fulfillerId,
          warehouseId: input.warehouseId,
          environment: input.environment,
          isActive: true,
        },
        update: {
          clientId: input.jtlClientId,
          clientSecret: encryptedSecret,
          fulfillerId: input.fulfillerId,
          warehouseId: input.warehouseId,
          environment: input.environment,
          isActive: true,
        },
      });

      // Auto-trigger sync for all client channels now that JTL credentials exist
      // NOTE: We do NOT auto-trigger sync here because we're using OAuth flow.
      // Sync will be triggered AFTER OAuth completes successfully and tokens are obtained.
      console.log('\n' + '='.repeat(80));
      console.log('✅ JTL credentials saved (Client ID: ' + input.clientId + ')');
      console.log('⏳ Waiting for OAuth completion before starting sync...');
      console.log('='.repeat(80) + '\n');

      return {
        success: true,
        clientId: input.clientId,
        details: {
          jtlConfigId: jtlConfig.id,
          environment: input.environment,
          message: 'JTL credentials saved. Use OAuth flow to obtain access token.',
        },
      };
    } catch (error) {
      console.error('Error setting up JTL credentials:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to setup JTL credentials',
      };
    }
  }

  /**
   * Step 2b: Complete JTL OAuth flow after user authorization
   */
  async completeJTLOAuth(
    clientId: string,
    authorizationCode: string,
    redirectUri: string
  ): Promise<OnboardingResult> {
    try {
      const jtlConfig = await this.prisma.jtlConfig.findUnique({
        where: { clientId_fk: clientId },
      });

      if (!jtlConfig) {
        return {
          success: false,
          error: 'JTL config not found. Please setup credentials first.',
        };
      }

      const jtlService = new JTLService({
        clientId: jtlConfig.clientId,
        clientSecret: jtlConfig.clientSecret,
        environment: jtlConfig.environment as 'sandbox' | 'production',
      });

      // Exchange code for tokens
      const tokenResult = await jtlService.exchangeCodeForToken(authorizationCode, redirectUri);

      if (!tokenResult) {
        return {
          success: false,
          error: 'Failed to exchange authorization code for tokens',
        };
      }

      // Update config with encrypted tokens
      const encryptionService = getEncryptionService();
      await this.prisma.jtlConfig.update({
        where: { id: jtlConfig.id },
        data: {
          accessToken: encryptionService.encrypt(tokenResult.accessToken),
          refreshToken: encryptionService.encrypt(tokenResult.refreshToken),
          tokenExpiresAt: tokenResult.expiresAt,
        },
      });

      // Auto-sync shipping methods from JTL FFN after OAuth completion
      try {
        const shippingMethodService = new ShippingMethodService(this.prisma);
        
        // Create a new JTL service with the fresh tokens for syncing
        const jtlServiceWithTokens = new JTLService({
          clientId: jtlConfig.clientId,
          clientSecret: jtlConfig.clientSecret,
          accessToken: tokenResult.accessToken,
          refreshToken: tokenResult.refreshToken,
          tokenExpiresAt: tokenResult.expiresAt,
          environment: jtlConfig.environment as 'sandbox' | 'production',
        });

        const syncResult = await shippingMethodService.syncShippingMethodsFromJTL(jtlServiceWithTokens);
        console.log(`[ClientOnboarding] Auto-synced ${syncResult.synced} shipping methods for client ${clientId}`);
      } catch (syncError) {
        // Log but don't fail the OAuth completion if sync fails
        console.error(`[ClientOnboarding] Failed to auto-sync shipping methods for client ${clientId}:`, syncError);
      }

      return {
        success: true,
        clientId,
        details: {
          message: 'JTL OAuth completed successfully',
          expiresAt: tokenResult.expiresAt,
        },
      };
    } catch (error) {
      console.error('Error completing JTL OAuth:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to complete JTL OAuth',
      };
    }
  }

  /**
   * Step 3a: Add a Shopify channel for the client
   */
  async addShopifyChannel(input: ShopifyChannelInput): Promise<OnboardingResult> {
    try {
      // Trim whitespace from inputs to prevent invalid URLs
      input.shopDomain = input.shopDomain.trim();
      input.accessToken = input.accessToken.trim();

      // Verify client exists
      const client = await this.prisma.client.findUnique({
        where: { id: input.clientId },
      });

      if (!client) {
        return {
          success: false,
          error: 'Client not found',
        };
      }

      // Test Shopify connection
      const shopifyService = createShopifyServiceAuto({
        shopDomain: input.shopDomain,
        accessToken: input.accessToken,
      });

      const connectionTest = await shopifyService.testConnection();
      if (!connectionTest.success) {
        return {
          success: false,
          error: `Shopify connection failed: ${connectionTest.message}`,
        };
      }

      // Encrypt sensitive credentials before storage
      const encryptionService = getEncryptionService();
      const encryptedAccessToken = encryptionService.encrypt(input.accessToken);

      // Create channel
      const channel = await this.prisma.channel.create({
        data: {
          clientId: input.clientId,
          name: input.channelName || `Shopify - ${input.shopDomain}`,
          type: ChannelType.SHOPIFY,
          status: ChannelStatus.ACTIVE,
          shopDomain: input.shopDomain,
          accessToken: encryptedAccessToken,
          url: `https://${input.shopDomain}`,
          isActive: true,
          syncEnabled: true,
        },
      });

      // Register webhooks for real-time updates
      try {
        const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || 'https://your-domain.com/api';
        await shopifyService.registerSyncWebhooks(webhookBaseUrl);
      } catch (webhookError) {
        console.warn('Failed to register Shopify webhooks:', webhookError);
        // Don't fail the whole operation, webhooks can be retried
      }

      return {
        success: true,
        clientId: input.clientId,
        channelId: channel.id,
        details: {
          channelName: channel.name,
          shopDomain: input.shopDomain,
          status: 'active',
          shopInfo: connectionTest.shopInfo,
        },
      };
    } catch (error) {
      console.error('Error adding Shopify channel:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add Shopify channel',
      };
    }
  }

  /**
   * Step 3b: Add a WooCommerce channel for the client
   */
  async addWooCommerceChannel(input: WooCommerceChannelInput): Promise<OnboardingResult> {
    try {
      // Verify client exists
      const client = await this.prisma.client.findUnique({
        where: { id: input.clientId },
      });

      if (!client) {
        return {
          success: false,
          error: 'Client not found',
        };
      }

      // Test WooCommerce connection
      const wooService = new WooCommerceService({
        url: input.storeUrl,
        consumerKey: input.consumerKey,
        consumerSecret: input.consumerSecret,
      });

      const connectionTest = await wooService.testConnection();
      if (!connectionTest.success) {
        return {
          success: false,
          error: `WooCommerce connection failed: ${connectionTest.message}`,
        };
      }

      // Encrypt sensitive credentials before storage
      const encryptionService = getEncryptionService();
      const encryptedConsumerSecret = encryptionService.encrypt(input.consumerSecret);

      // Create channel
      const channel = await this.prisma.channel.create({
        data: {
          clientId: input.clientId,
          name: input.channelName || `WooCommerce - ${new URL(input.storeUrl).hostname}`,
          type: ChannelType.WOOCOMMERCE,
          status: ChannelStatus.ACTIVE,
          apiUrl: input.storeUrl,
          apiClientId: input.consumerKey, // WooCommerce uses consumer key/secret
          apiClientSecret: encryptedConsumerSecret,
          url: input.storeUrl,
          isActive: true,
          syncEnabled: true,
        },
      });

      // Register webhooks for real-time updates
      try {
        const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || 'https://your-domain.com/api';
        const webhookSecret = process.env.WEBHOOK_SECRET || 'webhook-secret';
        await wooService.registerSyncWebhooks(webhookBaseUrl, webhookSecret);
      } catch (webhookError) {
        console.warn('Failed to register WooCommerce webhooks:', webhookError);
      }

      return {
        success: true,
        clientId: input.clientId,
        channelId: channel.id,
        details: {
          channelName: channel.name,
          storeUrl: input.storeUrl,
          status: 'active',
        },
      };
    } catch (error) {
      console.error('Error adding WooCommerce channel:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add WooCommerce channel',
      };
    }
  }

  /**
   * Step 4: Trigger initial sync for a channel
   * This pulls products, orders, and returns from the e-commerce platform
   * and pushes them to JTL-FFN
   *
   * @param channelId - The channel ID to sync
   * @param syncFromDate - Optional ISO date string to sync from (for historical sync)
   * @param enableHistoricalSync - If false, only quick sync (7 days); if true, sync from syncFromDate
   */
  async triggerInitialSync(
    channelId: string,
    syncFromDate?: string,
    enableHistoricalSync?: boolean
  ): Promise<OnboardingResult> {
    try {
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        include: {
          client: {
            include: { jtlConfig: true },
          },
        },
      });

      if (!channel) {
        return {
          success: false,
          error: 'Channel not found',
        };
      }

      if (!channel.client.jtlConfig) {
        return {
          success: false,
          error: 'JTL credentials not configured for this client',
        };
      }

      // Check if this is the first sync for this channel
      // If lastSyncAt is null, it means this is an initial sync
      const isFirstSync = !channel.lastSyncAt;

      // Determine sync date based on user settings
      let since: Date | undefined;
      if (isFirstSync) {
        if (enableHistoricalSync && syncFromDate) {
          // User wants to sync from a specific date
          since = new Date(syncFromDate);
          console.log(`[Sync] User-selected historical sync from ${since.toISOString()}`);
        } else if (enableHistoricalSync === false) {
          // User wants quick sync only (last 7 days)
          since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          console.log(`[Sync] Quick sync only (last 7 days)`);
        } else {
          // Default: 180 days for initial sync
          since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
          console.log(`[Sync] Default initial sync (last 180 days)`);
        }
      } else {
        // Subsequent syncs pull all data (no time limit)
        since = undefined;
        console.log(`[Sync] Subsequent sync (all data)`);
      }

      console.log(`Triggering ${isFirstSync ? 'initial' : 'subsequent'} sync for channel ${channelId}${since ? ` (limiting to data since ${since.toISOString()})` : ''}`);

      // Build credentials based on channel type
      let channelCredentials: ShopifyCredentials | WooCommerceCredentials;
      
      if (channel.type === ChannelType.SHOPIFY) {
        channelCredentials = {
          shopDomain: channel.shopDomain!,
          accessToken: channel.accessToken!,
        };
      } else if (channel.type === ChannelType.WOOCOMMERCE) {
        channelCredentials = {
          url: channel.apiUrl!,
          consumerKey: channel.apiClientId!,
          consumerSecret: channel.apiClientSecret!,
        };
      } else {
        return {
          success: false,
          error: `Unsupported channel type: ${channel.type}`,
        };
      }

      const jtlConfig = channel.client.jtlConfig;
      const jtlCredentials: JTLCredentials = {
        clientId: jtlConfig.clientId,
        clientSecret: jtlConfig.clientSecret,
        accessToken: jtlConfig.accessToken || undefined,
        refreshToken: jtlConfig.refreshToken || undefined,
        environment: jtlConfig.environment as 'sandbox' | 'production',
      };

      // Create sync orchestrator config
      const orchestratorConfig = channel.type === ChannelType.SHOPIFY
        ? {
            channelId: channel.id,
            channelType: channel.type,
            shopifyCredentials: channelCredentials as { shopDomain: string; accessToken: string },
            jtlCredentials,
            jtlFulfillerId: jtlConfig.fulfillerId,
            jtlWarehouseId: jtlConfig.warehouseId,
          }
        : {
            channelId: channel.id,
            channelType: channel.type,
            wooCommerceCredentials: channelCredentials as { url: string; consumerKey: string; consumerSecret: string },
            jtlCredentials,
            jtlFulfillerId: jtlConfig.fulfillerId,
            jtlWarehouseId: jtlConfig.warehouseId,
          };

      const orchestrator = new SyncOrchestrator(this.prisma, orchestratorConfig);

      // Run full sync with optional 180-day limit for initial sync
      const syncResult = await orchestrator.runFullSync(since);

      // Update last sync time
      await this.prisma.channel.update({
        where: { id: channelId },
        data: { lastSyncAt: new Date() },
      });

      // Check if any sync had errors
      const hasErrors = 
        syncResult.products.itemsFailed > 0 ||
        syncResult.orders.itemsFailed > 0 ||
        syncResult.returns.itemsFailed > 0;

      return {
        success: !hasErrors,
        channelId,
        details: {
          products: syncResult.products,
          orders: syncResult.orders,
          returns: syncResult.returns,
        },
      };
    } catch (error) {
      console.error('Error triggering initial sync:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to trigger sync',
      };
    }
  }

  /**
   * Start background sync with user-selected date
   * This is triggered after JTL OAuth completion with the user's chosen sync start date
   */
  async startBackgroundSync(channelId: string, syncFromDate: Date): Promise<OnboardingResult> {
    try {
      console.log(`[Background Sync] Starting sync for channel ${channelId} from ${syncFromDate.toISOString()}`);

      // Validate channel exists
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        include: {
          client: {
            include: { jtlConfig: true },
          },
        },
      });

      if (!channel) {
        return {
          success: false,
          error: 'Channel not found',
        };
      }

      if (!channel.client.jtlConfig) {
        return {
          success: false,
          error: 'JTL credentials not configured for this client',
        };
      }

      // Check if JTL OAuth is complete (has access token)
      if (!channel.client.jtlConfig.accessToken || !channel.client.jtlConfig.refreshToken) {
        console.log(`[Background Sync] ⚠️ JTL OAuth not completed yet for client ${channel.clientId}`);
        return {
          success: false,
          error: 'JTL OAuth not completed. Please complete JTL authorization first to enable syncing.',
        };
      }

      // Create sync job to track progress
      const syncJob = await this.prisma.syncJob.create({
        data: {
          channelId,
          status: 'IN_PROGRESS',
          type: 'INITIAL_FULL',
          currentPhase: 'background_sync',
          startedAt: new Date(),
        },
      });

      console.log(`[Background Sync] Created sync job ${syncJob.id}`);

      // Build sync config
      const syncConfig = await this.buildSyncConfig(channelId);

      // Start background sync (non-blocking)
      const backgroundSyncPromise = this.runBackgroundSyncWithDate(
        channelId,
        syncConfig,
        syncFromDate,
        syncJob.id
      )
        .catch(err => {
          console.error('[Background Sync] Failed:', err);
        })
        .finally(() => {
          ClientOnboardingService.activeBackgroundSyncs.delete(backgroundSyncPromise);
        });

      // Track the promise to keep it alive
      ClientOnboardingService.activeBackgroundSyncs.add(backgroundSyncPromise);

      return {
        success: true,
        channelId,
        syncJobId: syncJob.id,
        details: {
          message: 'Background sync started successfully',
          syncFromDate: syncFromDate.toISOString(),
        },
      };
    } catch (error) {
      console.error('Error starting background sync:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start background sync',
      };
    }
  }

  /**
   * Complete onboarding flow for a new client with Shopify
   */
  async onboardShopifyClient(
    clientInput: CreateClientInput,
    jtlInput: Omit<JTLSetupInput, 'clientId'>,
    shopifyInput: Omit<ShopifyChannelInput, 'clientId'>
  ): Promise<OnboardingResult> {
    try {
      // Step 1: Create client
      const clientResult = await this.createClient(clientInput);
      if (!clientResult.success || !clientResult.clientId) {
        return clientResult;
      }

      const clientId = clientResult.clientId;

      // Step 2: Setup JTL credentials
      const jtlResult = await this.setupJTLCredentials({
        ...jtlInput,
        clientId,
      });
      if (!jtlResult.success) {
        return jtlResult;
      }

      // Step 3: Add Shopify channel
      const channelResult = await this.addShopifyChannel({
        ...shopifyInput,
        clientId,
      });
      if (!channelResult.success || !channelResult.channelId) {
        return channelResult;
      }

      return {
        success: true,
        clientId,
        channelId: channelResult.channelId,
        details: {
          message: 'Client onboarded successfully',
          nextStep: 'Complete JTL OAuth flow, then trigger initial sync',
          ...channelResult.details,
        },
      };
    } catch (error) {
      console.error('Error in complete onboarding:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Onboarding failed',
      };
    }
  }

  /**
   * Complete onboarding flow for a new client with WooCommerce
   */
  async onboardWooCommerceClient(
    clientInput: CreateClientInput,
    jtlInput: Omit<JTLSetupInput, 'clientId'>,
    wooInput: Omit<WooCommerceChannelInput, 'clientId'>
  ): Promise<OnboardingResult> {
    try {
      // Step 1: Create client
      const clientResult = await this.createClient(clientInput);
      if (!clientResult.success || !clientResult.clientId) {
        return clientResult;
      }

      const clientId = clientResult.clientId;

      // Step 2: Setup JTL credentials
      const jtlResult = await this.setupJTLCredentials({
        ...jtlInput,
        clientId,
      });
      if (!jtlResult.success) {
        return jtlResult;
      }

      // Step 3: Add WooCommerce channel
      const channelResult = await this.addWooCommerceChannel({
        ...wooInput,
        clientId,
      });
      if (!channelResult.success || !channelResult.channelId) {
        return channelResult;
      }

      return {
        success: true,
        clientId,
        channelId: channelResult.channelId,
        details: {
          message: 'Client onboarded successfully',
          nextStep: 'Complete JTL OAuth flow, then trigger initial sync',
          ...channelResult.details,
        },
      };
    } catch (error) {
      console.error('Error in complete onboarding:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Onboarding failed',
      };
    }
  }

  /**
   * Get onboarding status for a client
   */
  async getOnboardingStatus(clientId: string): Promise<{
    client: boolean;
    jtlConfig: boolean;
    jtlOAuthComplete: boolean;
    channels: { id: string; name: string; type: string; status: string }[];
    readyForSync: boolean;
  }> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: {
        jtlConfig: true,
        channels: {
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            isActive: true,
          },
        },
      },
    });

    if (!client) {
      return {
        client: false,
        jtlConfig: false,
        jtlOAuthComplete: false,
        channels: [],
        readyForSync: false,
      };
    }

    const hasJtlConfig = !!client.jtlConfig;
    const jtlOAuthComplete = hasJtlConfig && !!client.jtlConfig?.accessToken;
    const hasActiveChannels = client.channels.some((c) => c.isActive);

    return {
      client: true,
      jtlConfig: hasJtlConfig,
      jtlOAuthComplete,
      channels: client.channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        status: c.status,
      })),
      readyForSync: jtlOAuthComplete && hasActiveChannels,
    };
  }

  // ============= SHOPIFY OAUTH METHODS =============

  /**
   * Initiate Shopify OAuth flow with shared platform app
   */
  async initiateShopifySharedOAuth(
    input: ShopifySharedOAuthInput
  ): Promise<{ success: boolean; authUrl?: string; state?: string; error?: string }> {
    try {
      const client = await this.prisma.client.findUnique({
        where: { id: input.clientId },
      });

      if (!client) {
        return { success: false, error: 'Client not found' };
      }

      // Generate CSRF state token
      const state = this.generateOAuthState();
      const stateExpiry = new Date(
        Date.now() + parseInt(process.env.OAUTH_STATE_EXPIRY_MINUTES || '15') * 60 * 1000
      );

      // Create pending channel with state
      const channel = await this.prisma.channel.create({
        data: {
          clientId: input.clientId,
          name: input.channelName || `Shopify - ${input.shopDomain}`,
          type: ChannelType.SHOPIFY,
          status: ChannelStatus.PENDING,
          shopDomain: input.shopDomain,
          authMethod: 'shared_oauth',
          oauthState: state,
          oauthStateExpiry: stateExpiry,
          isActive: false, // Activate after OAuth complete
          syncEnabled: false,
        },
      });

      // Validate environment variables
      if (!process.env.SHOPIFY_SHARED_APP_CLIENT_ID || !process.env.SHOPIFY_SHARED_APP_REDIRECT_URI) {
        throw new Error('Shopify shared app configuration is missing. Please set environment variables.');
      }

      // Generate authorization URL using platform's shared app
      const authUrl = ShopifyService.generateAuthorizationUrl({
        shopDomain: input.shopDomain,
        clientId: process.env.SHOPIFY_SHARED_APP_CLIENT_ID,
        redirectUri: process.env.SHOPIFY_SHARED_APP_REDIRECT_URI,
        scopes: (process.env.SHOPIFY_SHARED_APP_SCOPES || '').split(',').filter(s => s.trim()),
        state: state,
      });

      return {
        success: true,
        authUrl,
        state,
      };
    } catch (error) {
      console.error('Error initiating Shopify shared OAuth:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initiate OAuth',
      };
    }
  }

  /**
   * Initiate Shopify OAuth flow with client-provided app
   */
  async initiateShopifyClientOAuth(
    input: ShopifyClientOAuthInput
  ): Promise<{ success: boolean; authUrl?: string; state?: string; error?: string }> {
    try {
      const client = await this.prisma.client.findUnique({
        where: { id: input.clientId },
      });

      if (!client) {
        return { success: false, error: 'Client not found' };
      }

      // Generate CSRF state token
      const state = this.generateOAuthState();
      const stateExpiry = new Date(
        Date.now() + parseInt(process.env.OAUTH_STATE_EXPIRY_MINUTES || '15') * 60 * 1000
      );

      // Encrypt client secret before storing
      const encryptionService = getEncryptionService();
      const encryptedSecret = encryptionService.encrypt(input.apiClientSecret);

      // Create pending channel with client's app credentials
      const channel = await this.prisma.channel.create({
        data: {
          clientId: input.clientId,
          name: input.channelName || `Shopify - ${input.shopDomain}`,
          type: ChannelType.SHOPIFY,
          status: ChannelStatus.PENDING,
          shopDomain: input.shopDomain,
          authMethod: 'client_oauth',
          apiClientId: input.apiClientId,
          apiClientSecret: encryptedSecret,
          oauthState: state,
          oauthStateExpiry: stateExpiry,
          isActive: false,
          syncEnabled: false,
        },
      });

      // Build redirect URI for client's app
      const redirectUri = `${process.env.FRONTEND_URL?.split(',')[0]}/integrations/shopify/callback`;

      // Generate authorization URL using client's app
      const authUrl = ShopifyService.generateAuthorizationUrl({
        shopDomain: input.shopDomain,
        clientId: input.apiClientId,
        redirectUri: redirectUri,
        scopes: (process.env.SHOPIFY_SHARED_APP_SCOPES || '').split(',').filter(s => s.trim()),
        state: state,
      });

      return {
        success: true,
        authUrl,
        state,
      };
    } catch (error) {
      console.error('Error initiating Shopify client OAuth:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initiate OAuth',
      };
    }
  }

  /**
   * Complete Shopify OAuth flow
   */
  async completeShopifyOAuth(data: ShopifyOAuthCallbackData): Promise<OnboardingResult> {
    try {
      // Find pending channel by state
      const channel = await this.prisma.channel.findFirst({
        where: {
          oauthState: data.state,
          type: ChannelType.SHOPIFY,
          status: ChannelStatus.PENDING,
        },
      });

      if (!channel) {
        return {
          success: false,
          error: 'Invalid OAuth state or channel not found',
        };
      }

      // Validate state hasn't expired
      if (channel.oauthStateExpiry && channel.oauthStateExpiry < new Date()) {
        return {
          success: false,
          error: 'OAuth state has expired. Please restart the authentication process.',
        };
      }

      // Validate shop domain matches
      const cleanShopDomain = data.shopDomain.replace(/^https?:\/\//, '').trim();
      const cleanChannelDomain = channel.shopDomain?.replace(/^https?:\/\//, '').trim();

      if (cleanChannelDomain !== cleanShopDomain) {
        return {
          success: false,
          error: 'Shop domain mismatch',
        };
      }

      let clientId: string;
      let clientSecret: string;

      // Determine which app credentials to use
      if (channel.authMethod === 'shared_oauth') {
        if (!process.env.SHOPIFY_SHARED_APP_CLIENT_ID || !process.env.SHOPIFY_SHARED_APP_CLIENT_SECRET) {
          return {
            success: false,
            error: 'Shopify shared app configuration is missing',
          };
        }
        clientId = process.env.SHOPIFY_SHARED_APP_CLIENT_ID;
        clientSecret = process.env.SHOPIFY_SHARED_APP_CLIENT_SECRET;
      } else if (channel.authMethod === 'client_oauth') {
        if (!channel.apiClientId || !channel.apiClientSecret) {
          return {
            success: false,
            error: 'Client app credentials not found',
          };
        }
        clientId = channel.apiClientId;
        const encryptionService = getEncryptionService();
        clientSecret = encryptionService.decrypt(channel.apiClientSecret);
      } else {
        return {
          success: false,
          error: 'Invalid authentication method',
        };
      }

      // Exchange code for access token
      const tokenData = await ShopifyService.exchangeCodeForToken({
        shopDomain: data.shopDomain,
        clientId: clientId,
        clientSecret: clientSecret,
        code: data.code,
      });

      // Encrypt access token before storing
      const encryptionService = getEncryptionService();
      const encryptedToken = encryptionService.encrypt(tokenData.accessToken);

      // Update channel with access token and activate
      await this.prisma.channel.update({
        where: { id: channel.id },
        data: {
          accessToken: encryptedToken,
          status: ChannelStatus.ACTIVE,
          isActive: true,
          syncEnabled: true,
          oauthState: null, // Clear state after use
          oauthStateExpiry: null,
          url: `https://${cleanShopDomain}`,
        },
      });

      // Test connection
      const shopifyService = createShopifyServiceAuto({
        shopDomain: data.shopDomain,
        accessToken: tokenData.accessToken,
      });

      const connectionTest = await shopifyService.testConnection();
      if (!connectionTest.success) {
        return {
          success: false,
          error: `Connection test failed: ${connectionTest.message}`,
        };
      }

      // Register webhooks
      try {
        const webhookBaseUrl = process.env.WEBHOOK_BASE_URL || 'https://your-domain.com/api';
        await shopifyService.registerSyncWebhooks(webhookBaseUrl);
      } catch (webhookError) {
        console.warn('Failed to register Shopify webhooks:', webhookError);
      }

      return {
        success: true,
        clientId: channel.clientId,
        channelId: channel.id,
        details: {
          channelName: channel.name,
          shopDomain: data.shopDomain,
          authMethod: channel.authMethod,
          status: 'active',
          shopInfo: connectionTest.shopInfo,
        },
      };
    } catch (error) {
      console.error('Error completing Shopify OAuth:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to complete OAuth',
      };
    }
  }

  // ============= HELPERS =============

  /**
   * Generate a cryptographically random OAuth state token
   */
  private generateOAuthState(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private async hashPassword(password: string): Promise<string> {
    // In production, use bcrypt or argon2
    // This is a placeholder - DO NOT use in production
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  /**
   * Trigger initial sync asynchronously after channel creation
   * Creates a SyncJob record to track progress
   */
  private async triggerInitialSyncAsync(channelId: string): Promise<void> {
    console.log('\n' + '='.repeat(80));
    console.log('🚀 [TWO-PHASE SYNC] Initial Sync Process Beginning');
    console.log('='.repeat(80));
    console.log(`Channel ID: ${channelId}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('Strategy: Quick sync (7 days) → Channel ACTIVE → Background full sync (180 days)');
    console.log('='.repeat(80) + '\n');

    try {
      //  Build sync config
      const syncConfig = await this.buildSyncConfig(channelId);

      // ========== PHASE 1: QUICK SYNC (7 DAYS) ==========
      console.log('\n⚡ [PHASE 1] Quick Sync - Last 7 Days');
      console.log('='.repeat(80));

      const quickSyncJob = await this.prisma.syncJob.create({
        data: {
          channelId,
          status: 'IN_PROGRESS',
          type: 'INITIAL_QUICK',
          currentPhase: 'quick_sync',
          startedAt: new Date(),
        },
      });
      console.log(`📋 Quick sync job created: ${quickSyncJob.id}`);

      const orchestrator = new SyncOrchestrator(this.prisma, syncConfig);
      const quickSyncSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Last 7 days

      const quickResult = await orchestrator.runFullSync(quickSyncSince, quickSyncJob.id);

      console.log('✅ Quick sync completed!');
      console.log(`   - Products: ${quickResult.products.itemsProcessed}/${quickResult.products.itemsProcessed + quickResult.products.itemsFailed}`);
      console.log(`   - Orders: ${quickResult.orders.itemsProcessed}/${quickResult.orders.itemsProcessed + quickResult.orders.itemsFailed}`);
      console.log(`   - Returns: ${quickResult.returns.itemsProcessed}/${quickResult.returns.itemsProcessed + quickResult.returns.itemsFailed}`);

      // Mark channel as ACTIVE immediately!
      await this.prisma.channel.update({
        where: { id: channelId },
        data: {
          status: 'ACTIVE',
          lastSyncAt: new Date(),
        },
      });
      console.log('🎉 Channel is now ACTIVE!');

      // Complete quick sync job
      await this.prisma.syncJob.update({
        where: { id: quickSyncJob.id },
        data: {
          status: 'COMPLETED',
          currentPhase: 'quick_sync_done',
          completedAt: new Date(),
          totalProducts: quickResult.products.itemsProcessed + quickResult.products.itemsFailed,
          syncedProducts: quickResult.products.itemsProcessed,
          failedProducts: quickResult.products.itemsFailed,
          totalOrders: quickResult.orders.itemsProcessed + quickResult.orders.itemsFailed,
          syncedOrders: quickResult.orders.itemsProcessed,
          failedOrders: quickResult.orders.itemsFailed,
          totalReturns: quickResult.returns.itemsProcessed + quickResult.returns.itemsFailed,
          syncedReturns: quickResult.returns.itemsProcessed,
          failedReturns: quickResult.returns.itemsFailed,
        },
      });

      console.log('\n' + '='.repeat(80));
      console.log('✨ [PHASE 1 COMPLETED] Channel is ready to use!');
      console.log('='.repeat(80) + '\n');

      // ========== PHASE 2: BACKGROUND FULL SYNC (180 DAYS) ==========
      console.log('🔄 [PHASE 2] Starting background full sync (180 days)...');
      console.log('This will run asynchronously without blocking the channel.\n');

      // Start background sync and track it to prevent garbage collection
      const backgroundSyncPromise = this.runBackgroundFullSync(channelId, syncConfig)
        .catch(err => {
          console.error('[Background Sync] Failed:', err);
        })
        .finally(() => {
          // Remove from active syncs when complete
          ClientOnboardingService.activeBackgroundSyncs.delete(backgroundSyncPromise);
          console.log(`[Background Sync] Removed from tracking. Active syncs: ${ClientOnboardingService.activeBackgroundSyncs.size}`);
        });

      // Track the promise to keep it alive
      ClientOnboardingService.activeBackgroundSyncs.add(backgroundSyncPromise);
      console.log(`[Background Sync] Added to tracking. Active syncs: ${ClientOnboardingService.activeBackgroundSyncs.size}`);

    } catch (error) {
      console.error('\n' + '='.repeat(80));
      console.error('❌ [SYNC FAILED] Error During Quick Sync');
      console.error('='.repeat(80));
      console.error(`Channel ID: ${channelId}`);
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.error('='.repeat(80) + '\n');
      throw error;
    }
  }

  /**
   * Run background sync with user-selected date
   * This runs asynchronously without blocking the channel
   */
  private async runBackgroundSyncWithDate(
    channelId: string,
    syncConfig: any,
    syncFromDate: Date,
    syncJobId: string
  ): Promise<void> {
    console.log('\n' + '='.repeat(80));
    console.log('📚 [BACKGROUND SYNC] Starting User-Selected Historical Sync');
    console.log('='.repeat(80));
    console.log(`Channel ID: ${channelId}`);
    console.log(`Sync From Date: ${syncFromDate.toISOString()}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('='.repeat(80) + '\n');

    try {
      const orchestrator = new SyncOrchestrator(this.prisma, syncConfig);

      const result = await orchestrator.runFullSync(syncFromDate, syncJobId);

      console.log('✅ Background sync completed!');
      console.log(`   - Products: ${result.products.itemsProcessed}/${result.products.itemsProcessed + result.products.itemsFailed}`);
      console.log(`   - Orders: ${result.orders.itemsProcessed}/${result.orders.itemsProcessed + result.orders.itemsFailed}`);
      console.log(`   - Returns: ${result.returns.itemsProcessed}/${result.returns.itemsProcessed + result.returns.itemsFailed}`);

      // Update channel last sync time
      await this.prisma.channel.update({
        where: { id: channelId },
        data: {
          status: 'ACTIVE',
          lastSyncAt: new Date(),
        },
      });

      console.log('\n' + '='.repeat(80));
      console.log('✨ [BACKGROUND SYNC COMPLETED] Channel data synced successfully!');
      console.log('='.repeat(80) + '\n');
    } catch (error) {
      console.error('\n' + '='.repeat(80));
      console.error('❌ [BACKGROUND SYNC FAILED] Error During Sync');
      console.error('='.repeat(80));
      console.error(`Channel ID: ${channelId}`);
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.error('='.repeat(80) + '\n');

      // Update sync job to failed
      await this.prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : 'Unknown error during sync',
          completedAt: new Date(),
        },
      });

      throw error;
    }
  }

  /**
   * Run background full sync (180 days)
   * This runs asynchronously without blocking the channel
   */
  private async runBackgroundFullSync(channelId: string, syncConfig: any): Promise<void> {
    console.log('\n' + '='.repeat(80));
    console.log('📚 [BACKGROUND SYNC] Starting Full Historical Sync (180 days)');
    console.log('='.repeat(80));
    console.log(`Channel ID: ${channelId}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('='.repeat(80) + '\n');

    let backgroundSyncJob;
    try {
      backgroundSyncJob = await this.prisma.syncJob.create({
        data: {
          channelId,
          status: 'IN_PROGRESS',
          type: 'INITIAL_FULL',
          currentPhase: 'background_sync',
          startedAt: new Date(),
        },
      });
      console.log(`📋 Background sync job created: ${backgroundSyncJob.id}`);

      const orchestrator = new SyncOrchestrator(this.prisma, syncConfig);
      const fullSyncSince = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000); // Last 180 days

      const fullResult = await orchestrator.runFullSync(fullSyncSince, backgroundSyncJob.id);

      console.log('✅ Background full sync completed!');
      console.log(`   - Products: ${fullResult.products.itemsProcessed}/${fullResult.products.itemsProcessed + fullResult.products.itemsFailed}`);
      console.log(`   - Orders: ${fullResult.orders.itemsProcessed}/${fullResult.orders.itemsProcessed + fullResult.orders.itemsFailed}`);
      console.log(`   - Returns: ${fullResult.returns.itemsProcessed}/${fullResult.returns.itemsProcessed + fullResult.returns.itemsFailed}`);

      // Update sync job to completed
      await this.prisma.syncJob.update({
        where: { id: backgroundSyncJob.id },
        data: {
          status: 'COMPLETED',
          currentPhase: 'done',
          completedAt: new Date(),
          totalProducts: fullResult.products.itemsProcessed + fullResult.products.itemsFailed,
          syncedProducts: fullResult.products.itemsProcessed,
          failedProducts: fullResult.products.itemsFailed,
          totalOrders: fullResult.orders.itemsProcessed + fullResult.orders.itemsFailed,
          syncedOrders: fullResult.orders.itemsProcessed,
          failedOrders: fullResult.orders.itemsFailed,
          totalReturns: fullResult.returns.itemsProcessed + fullResult.returns.itemsFailed,
          syncedReturns: fullResult.returns.itemsProcessed,
          failedReturns: fullResult.returns.itemsFailed,
        },
      });

      // Update channel last sync time
      await this.prisma.channel.update({
        where: { id: channelId },
        data: { lastSyncAt: new Date() },
      });

      console.log('\n' + '='.repeat(80));
      console.log('✨ [BACKGROUND SYNC COMPLETED] All Historical Data Synced!');
      console.log('='.repeat(80) + '\n');
    } catch (error) {
      console.error('\n' + '='.repeat(80));
      console.error('❌ [BACKGROUND SYNC FAILED]');
      console.error('='.repeat(80));
      console.error(`Channel ID: ${channelId}`);
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.error('='.repeat(80) + '\n');

      if (backgroundSyncJob) {
        await this.prisma.syncJob.update({
          where: { id: backgroundSyncJob.id },
          data: {
            status: 'FAILED',
            errorMessage: error instanceof Error ? error.message : 'Unknown error during background sync',
            completedAt: new Date(),
          },
        });
      }
    }
  }

  /**
   * Build sync configuration from channel data
   * Extracted for reuse in both quick and background sync
   */
  private async buildSyncConfig(channelId: string): Promise<any> {
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
      throw new Error(`Channel ${channelId} not found`);
    }

    const jtlConfig = channel.client.jtlConfig;
    if (!jtlConfig) {
      throw new Error('No JTL configuration found. Please set up JTL credentials first.');
    }

    // NOTE: Don't decrypt here - let SyncOrchestrator handle decryption
    // to avoid double-decryption issues

    // Build sync config
    const syncConfig: {
      channelId: string;
      channelType: ChannelType;
      shopifyCredentials?: { shopDomain: string; accessToken: string };
      wooCommerceCredentials?: { url: string; consumerKey: string; consumerSecret: string };
      jtlCredentials: {
        clientId: string;
        clientSecret: string;  // This should be ENCRYPTED (will be decrypted by SyncOrchestrator)
        accessToken?: string;  // This should be ENCRYPTED (will be decrypted by SyncOrchestrator)
        refreshToken?: string; // This should be ENCRYPTED (will be decrypted by SyncOrchestrator)
        environment: 'sandbox' | 'production';
      };
      jtlWarehouseId: string;
      jtlFulfillerId: string;
    } = {
      channelId: channel.id,
      channelType: channel.type as ChannelType,
      jtlCredentials: {
        clientId: jtlConfig.clientId,
        clientSecret: jtlConfig.clientSecret, // Keep encrypted
        accessToken: jtlConfig.accessToken || undefined,  // Keep encrypted
        refreshToken: jtlConfig.refreshToken || undefined, // Keep encrypted
        environment: jtlConfig.environment as 'sandbox' | 'production',
      },
      jtlWarehouseId: jtlConfig.warehouseId,
      jtlFulfillerId: jtlConfig.fulfillerId,
    };

    // Add platform-specific credentials (decrypt before passing to sync)
    // Handle both encrypted and unencrypted credentials for backward compatibility
    const encryptionService = getEncryptionService();

    // Helper to safely decrypt - returns original value if not encrypted
    const safeDecrypt = (value: string): string => {
      if (encryptionService.isEncrypted(value)) {
        return encryptionService.decrypt(value);
      }
      // Return as-is if not encrypted (legacy data)
      return value;
    };

    if (channel.type === ChannelType.SHOPIFY && channel.shopDomain && channel.accessToken) {
      syncConfig.shopifyCredentials = {
        shopDomain: channel.shopDomain,
        accessToken: safeDecrypt(channel.accessToken),
      };
    } else if (channel.type === ChannelType.WOOCOMMERCE && channel.url && channel.apiClientId && channel.apiClientSecret) {
      syncConfig.wooCommerceCredentials = {
        url: channel.url,
        consumerKey: channel.apiClientId,
        consumerSecret: safeDecrypt(channel.apiClientSecret),
      };
    }

    return syncConfig;
  }
}

export default ClientOnboardingService;
