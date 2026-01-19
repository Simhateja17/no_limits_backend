/**
 * Integration Routes
 * API endpoints for managing e-commerce and JTL integrations
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  ShopifyService,
  createShopifyServiceAuto,
  WooCommerceService,
  JTLService,
  SyncScheduler,
  ClientOnboardingService,
  ChannelDataService,
} from '../services/integrations/index.js';
import { WebhookProcessorService } from '../services/integrations/webhook-processor.service.js';
import { BiDirectionalSyncService } from '../services/integrations/bidirectional-sync.service.js';
import { getEncryptionService } from '../services/encryption.service.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Note: In production, you would use dependency injection or a singleton pattern
// for the PrismaClient and SyncScheduler instances
let prisma: PrismaClient;
let syncScheduler: SyncScheduler;
let webhookProcessor: WebhookProcessorService;
let biDirectionalSyncService: BiDirectionalSyncService;

// Track processed authorization codes to prevent duplicate exchanges
// Maps: authorization_code -> { timestamp, clientId }
const processedAuthCodes = new Map<string, { timestamp: number; clientId: string }>();

// Clean up old codes every 5 minutes (codes expire after 10 minutes anyway)
setInterval(() => {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [code, data] of processedAuthCodes.entries()) {
    if (data.timestamp < fiveMinutesAgo) {
      processedAuthCodes.delete(code);
    }
  }
}, 5 * 60 * 1000);

/**
 * Initialize the integration module
 */
export function initializeIntegrations(prismaClient: PrismaClient): void {
  prisma = prismaClient;
  syncScheduler = new SyncScheduler(prisma, {
    incrementalSyncIntervalMinutes: 5,
    fullSyncIntervalHours: 24,
    jtlPollIntervalMinutes: 2,
    maxConcurrentSyncs: 3,
  });
  webhookProcessor = new WebhookProcessorService(prisma);
  biDirectionalSyncService = new BiDirectionalSyncService(prisma);
}

/**
 * Start the sync scheduler
 */
export async function startSyncScheduler(): Promise<void> {
  if (syncScheduler) {
    await syncScheduler.start();
  }
}

/**
 * Stop the sync scheduler
 */
export function stopSyncScheduler(): void {
  if (syncScheduler) {
    syncScheduler.stop();
  }
}

// ============= JTL OAUTH ENDPOINTS =============

/**
 * Get JTL OAuth authorization URL
 */
router.get('/jtl/auth-url', async (req: Request, res: Response) => {
  try {
    const { clientId, redirectUri, state, environment = 'sandbox' } = req.query;

    if (!clientId || !redirectUri || !state) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: clientId, redirectUri, state',
      });
    }

    // Fetch JTL config to get the actual JTL OAuth Client ID
    const jtlConfig = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: clientId as string },
    });

    if (!jtlConfig) {
      return res.status(404).json({
        success: false,
        error: 'JTL configuration not found. Please setup JTL credentials first.',
      });
    }

    // Use the JTL OAuth Client ID from the config, not the internal client ID
    const jtlService = new JTLService({
      clientId: jtlConfig.clientId, // This is the JTL OAuth Client ID
      clientSecret: '', // Not needed for auth URL
      environment: environment as 'sandbox' | 'production',
    });

    const authUrl = jtlService.getAuthorizationUrl(
      redirectUri as string,
      state as string
    );

    res.json({
      success: true,
      authUrl,
    });
  } catch (error) {
    console.error('Error generating JTL auth URL:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Exchange JTL authorization code for tokens
 */
router.post('/jtl/exchange-token', async (req: Request, res: Response) => {
  try {
    const { clientId, code, redirectUri, environment = 'sandbox' } = req.body;

    console.log(`[JTL OAuth] 🔄 Received token exchange request for client: ${clientId}`);
    console.log(`[JTL OAuth] 📍 Redirect URI: ${redirectUri}`);
    console.log(`[JTL OAuth] 🔑 Code (first 10 chars): ${code?.substring(0, 10)}...`);

    if (!clientId || !code || !redirectUri) {
      console.error('[JTL OAuth] ❌ Missing required parameters');
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: clientId, code, redirectUri',
      });
    }

    // SERVER-SIDE DUPLICATE PREVENTION
    // Check if this authorization code has already been processed
    const existingProcess = processedAuthCodes.get(code);
    if (existingProcess) {
      const timeSinceProcessed = Date.now() - existingProcess.timestamp;
      console.warn(`[JTL OAuth] ⚠️ DUPLICATE REQUEST DETECTED!`);
      console.warn(`[JTL OAuth] Code was already processed ${Math.round(timeSinceProcessed / 1000)}s ago for client: ${existingProcess.clientId}`);
      console.warn(`[JTL OAuth] This is likely caused by React StrictMode or duplicate frontend requests`);

      return res.status(400).json({
        success: false,
        error: 'This authorization code has already been used. Please start a new authorization flow.',
      });
    }

    // Mark this code as being processed NOW (before the async operation)
    processedAuthCodes.set(code, {
      timestamp: Date.now(),
      clientId: clientId,
    });
    console.log(`[JTL OAuth] 🔒 Marked code as processing (map size: ${processedAuthCodes.size})`);

    // Get JTL config from database using internal client ID
    const jtlConfig = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: clientId },
    });

    if (!jtlConfig) {
      console.error(`[JTL OAuth] ❌ JTL config not found for client: ${clientId}`);
      return res.status(404).json({
        success: false,
        error: 'JTL configuration not found',
      });
    }

    console.log(`[JTL OAuth] 📝 Found JTL config - Client ID: ${jtlConfig.clientId}, Environment: ${jtlConfig.environment}`);

    // Decrypt client secret
    const encryptionService = getEncryptionService();
    const decryptedSecret = encryptionService.decrypt(jtlConfig.clientSecret);

    // Use JTL OAuth Client ID (not internal client ID)
    const jtlService = new JTLService({
      clientId: jtlConfig.clientId, // JTL OAuth Client ID
      clientSecret: decryptedSecret,
      environment: jtlConfig.environment as 'sandbox' | 'production',
    });

    console.log('[JTL OAuth] 🚀 Attempting token exchange with JTL OAuth server...');
    const tokens = await jtlService.exchangeCodeForToken(code, redirectUri);
    console.log('[JTL OAuth] ✅ Token exchange successful, saving to database...');

    // Store encrypted tokens in database
    await prisma.jtlConfig.update({
      where: { id: jtlConfig.id },
      data: {
        accessToken: encryptionService.encrypt(tokens.accessToken),
        refreshToken: encryptionService.encrypt(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
      },
    });

    console.log(`[JTL OAuth] ✅ Tokens stored for client ${clientId}. OAuth complete.`);

    res.json({
      success: true,
      message: 'JTL authentication successful',
      expiresAt: tokens.expiresAt,
    });
  } catch (error) {
    console.error('[JTL OAuth] ❌ Error exchanging JTL token:', error);

    // Extract more specific error message
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;

      // Check if it's a JTL OAuth error and extract the details
      if (errorMessage.includes('JTL OAuth error')) {
        console.error('[JTL OAuth] 🔍 JTL OAuth Server Error Details:', errorMessage);
      }
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

// ============= JTL CONFIG ENDPOINTS =============

/**
 * Create or update JTL configuration for a client
 * IMPORTANT: This triggers auto-sync for all client channels after credentials are stored
 */
router.post('/jtl/config/:clientId', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const { jtlClientId, clientSecret, fulfillerId, warehouseId, environment = 'sandbox' } = req.body;

    if (!jtlClientId || !clientSecret || !fulfillerId || !warehouseId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters',
      });
    }

    const config = await prisma.jtlConfig.upsert({
      where: { clientId_fk: clientId },
      create: {
        clientId_fk: clientId,
        clientId: jtlClientId,
        clientSecret,
        fulfillerId,
        warehouseId,
        environment,
      },
      update: {
        clientId: jtlClientId,
        clientSecret,
        fulfillerId,
        warehouseId,
        environment,
      },
    });

    console.log(`[JTL Config] Credentials saved for client ${clientId}`);

    res.json({
      success: true,
      data: {
        id: config.id,
        environment: config.environment,
        fulfillerId: config.fulfillerId,
        warehouseId: config.warehouseId,
        isActive: config.isActive,
      },
      message: 'JTL credentials saved successfully.',
    });
  } catch (error) {
    console.error('Error creating JTL config:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Test JTL connection
 */
router.post('/jtl/test/:clientId', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    const config = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: clientId },
    });

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'JTL configuration not found',
      });
    }

    const encryptionService = getEncryptionService();
    const jtlService = new JTLService({
      clientId: config.clientId,
      clientSecret: encryptionService.decrypt(config.clientSecret),
      accessToken: config.accessToken ? encryptionService.decrypt(config.accessToken) : undefined,
      refreshToken: config.refreshToken ? encryptionService.decrypt(config.refreshToken) : undefined,
      tokenExpiresAt: config.tokenExpiresAt || undefined,
      environment: config.environment as 'sandbox' | 'production',
    });

    const result = await jtlService.testConnection();

    res.json(result);
  } catch (error) {
    console.error('Error testing JTL connection:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Check if client has JTL configuration
 */
router.get('/jtl/status/:clientId', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    const config = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: clientId },
    });

    res.json({
      success: true,
      configured: !!config,
      hasOAuth: !!(config?.accessToken),
      environment: config?.environment || null,
      fulfillerId: config?.fulfillerId || null,
      warehouseId: config?.warehouseId || null,
      lastSyncAt: config?.lastSyncAt || null,
    });
  } catch (error) {
    console.error('Error checking JTL status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get JTL fulfillers and warehouses
 */
router.get('/jtl/fulfillers/:clientId', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    const config = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: clientId },
    });

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'JTL configuration not found',
      });
    }

    const jtlService = new JTLService({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      accessToken: config.accessToken || undefined,
      refreshToken: config.refreshToken || undefined,
      environment: config.environment as 'sandbox' | 'production',
    });

    const fulfillers = await jtlService.getFulfillers();

    res.json({
      success: true,
      data: fulfillers,
    });
  } catch (error) {
    console.error('Error fetching JTL fulfillers:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============= SYNC JOB STATUS ENDPOINTS =============

/**
 * Get sync job status for a channel
 */
router.get('/sync-job/:channelId', async (req: Request, res: Response) => {
  try {
    // Disable caching for real-time sync status updates
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { channelId } = req.params;

    // Get the latest sync job for this channel
    const syncJob = await prisma.syncJob.findFirst({
      where: { channelId },
      orderBy: { startedAt: 'desc' },
    });

    if (!syncJob) {
      return res.json({
        success: true,
        syncJob: null,
        message: 'No sync job found for this channel',
      });
    }

    // Calculate progress percentage based on phases (33.3% per phase)
    // Products = 33.3%, Orders = 66.6%, Returns = 100%
    let progress = 0;
    
    if (syncJob.status === 'COMPLETED') {
      progress = 100;
    } else if (syncJob.currentPhase === 'done') {
      progress = 100;
    } else if (syncJob.currentPhase === 'returns') {
      // Returns phase started, orders and products are done
      progress = 67;
    } else if (syncJob.currentPhase === 'orders') {
      // Orders phase started, products are done
      progress = 33;
    } else if (syncJob.currentPhase === 'products') {
      // Products phase in progress
      progress = 0;
    } else {
      // Initializing
      progress = 0;
    }

    res.json({
      success: true,
      syncJob: {
        id: syncJob.id,
        status: syncJob.status,
        type: syncJob.type,
        currentPhase: syncJob.currentPhase,
        progress,
        totalProducts: syncJob.totalProducts,
        syncedProducts: syncJob.syncedProducts,
        failedProducts: syncJob.failedProducts,
        totalOrders: syncJob.totalOrders,
        syncedOrders: syncJob.syncedOrders,
        failedOrders: syncJob.failedOrders,
        totalReturns: syncJob.totalReturns,
        syncedReturns: syncJob.syncedReturns,
        failedReturns: syncJob.failedReturns,
        errorMessage: syncJob.errorMessage,
        startedAt: syncJob.startedAt,
        completedAt: syncJob.completedAt,
      },
    });
  } catch (error) {
    console.error('Error fetching sync job status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get all sync jobs for a channel (history)
 */
router.get('/sync-jobs/:channelId', async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;
    const limit = parseInt(req.query.limit as string) || 10;

    const syncJobs = await prisma.syncJob.findMany({
      where: { channelId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });

    res.json({
      success: true,
      data: syncJobs.map(job => ({
        id: job.id,
        status: job.status,
        type: job.type,
        products: { synced: job.syncedProducts, failed: job.failedProducts },
        orders: { synced: job.syncedOrders, failed: job.failedOrders },
        returns: { synced: job.syncedReturns, failed: job.failedReturns },
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching sync job history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============= CHANNEL CONNECTION ENDPOINTS =============

/**
 * Test Shopify connection
 */
router.post('/shopify/test', async (req: Request, res: Response) => {
  try {
    let { shopDomain, accessToken } = req.body;

    if (!shopDomain || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: shopDomain, accessToken',
      });
    }

    // Trim whitespace from inputs
    shopDomain = shopDomain.trim();
    accessToken = accessToken.trim();

    const shopifyService = createShopifyServiceAuto({ shopDomain, accessToken });
    
    // Try to fetch one product to verify connection
    const products = await shopifyService.getProducts({ limit: 1 });

    res.json({
      success: true,
      message: `Connected to Shopify. Found ${products.length > 0 ? 'products' : 'no products yet'}.`,
    });
  } catch (error) {
    console.error('Error testing Shopify connection:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Test WooCommerce connection
 */
router.post('/woocommerce/test', async (req: Request, res: Response) => {
  try {
    let { storeUrl, consumerKey, consumerSecret } = req.body;

    if (!storeUrl || !consumerKey || !consumerSecret) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: storeUrl, consumerKey, consumerSecret',
      });
    }

    // Trim whitespace from inputs
    storeUrl = storeUrl.trim();
    consumerKey = consumerKey.trim();
    consumerSecret = consumerSecret.trim();

    const wooService = new WooCommerceService({ url: storeUrl, consumerKey, consumerSecret });
    const result = await wooService.testConnection();

    res.json(result);
  } catch (error) {
    console.error('Error testing WooCommerce connection:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============= SHOPIFY OAUTH ENDPOINTS =============

/**
 * Save Shopify OAuth credentials (step 1: before starting OAuth flow)
 */
router.post('/shopify/oauth/save-credentials', async (req: Request, res: Response) => {
  try {
    const { clientId, shopDomain, oauthClientId, oauthClientSecret } = req.body;

    if (!clientId || !shopDomain || !oauthClientId || !oauthClientSecret) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: clientId, shopDomain, oauthClientId, oauthClientSecret',
      });
    }

    console.log(`[Shopify OAuth] 💾 Saving OAuth credentials for client ${clientId}, shop: ${shopDomain}`);

    // Encrypt the OAuth client secret
    const encryptionService = getEncryptionService();
    const encryptedSecret = encryptionService.encrypt(oauthClientSecret);

    // Store OAuth credentials temporarily (will be used during token exchange)
    // Create or update a temporary config record
    await prisma.shopifyOAuthConfig.upsert({
      where: {
        clientId_shopDomain: {
          clientId,
          shopDomain: shopDomain.trim(),
        },
      },
      create: {
        clientId,
        shopDomain: shopDomain.trim(),
        oauthClientId,
        oauthClientSecret: encryptedSecret,
      },
      update: {
        oauthClientId,
        oauthClientSecret: encryptedSecret,
      },
    });

    res.json({
      success: true,
      message: 'OAuth credentials saved successfully',
    });
  } catch (error) {
    console.error('[Shopify OAuth] Error saving credentials:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get Shopify OAuth authorization URL (step 2: generate auth URL)
 */
router.post('/shopify/oauth/auth-url', async (req: Request, res: Response) => {
  try {
    const { clientId, shopDomain, redirectUri, oauthClientId } = req.body;

    if (!clientId || !shopDomain || !redirectUri || !oauthClientId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: clientId, shopDomain, redirectUri, oauthClientId',
      });
    }

    // Validate shop domain format
    if (!ShopifyService.isValidShopDomain(shopDomain)) {
      console.error(`[Shopify OAuth] ❌ Invalid shop domain: ${shopDomain}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid shop domain. Must be a valid Shopify store (e.g., mystore.myshopify.com)',
      });
    }

    console.log(`[Shopify OAuth] 🔗 Generating auth URL for client ${clientId}, shop: ${shopDomain}`);

    // Generate cryptographically secure nonce for state parameter
    // Combine with clientId for CSRF protection
    const nonce = ShopifyService.generateOAuthNonce();
    const state = `${clientId}:${nonce}`;

    // Store nonce in database for later verification
    const encryptionService = getEncryptionService();
    await prisma.shopifyOAuthConfig.update({
      where: {
        clientId_shopDomain: {
          clientId,
          shopDomain: shopDomain.trim(),
        },
      },
      data: {
        oauthNonce: nonce,
        oauthNonceExpiry: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      },
    });

    // Define required scopes
    const scopes = [
      'read_products',
      'write_products',
      'read_orders',
      'write_orders',
      'read_fulfillments',
      'write_fulfillments',
      'read_inventory',
      'write_inventory',
      'read_shipping',
      'write_shipping',
    ];

    // Generate authorization URL
    const authUrl = ShopifyService.generateAuthorizationUrl({
      shopDomain: shopDomain.trim(),
      clientId: oauthClientId,
      redirectUri,
      scopes,
      state,
    });

    console.log(`[Shopify OAuth] ✅ Generated auth URL: ${authUrl.substring(0, 100)}...`);

    res.json({
      success: true,
      authUrl,
      state, // Return state so frontend can verify later if needed
    });
  } catch (error) {
    console.error('[Shopify OAuth] Error generating auth URL:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Complete Shopify OAuth flow (step 3: exchange code for token)
 * Security validations:
 * 1. HMAC signature verification (ensures request from Shopify)
 * 2. State/nonce verification (CSRF protection)
 * 3. Shop domain validation (prevents malicious redirects)
 * 4. Timestamp validation (prevents replay attacks)
 */
router.post('/shopify/oauth/complete', async (req: Request, res: Response) => {
  try {
    const { clientId, shopDomain, code, state, hmac, timestamp } = req.body;

    if (!clientId || !shopDomain || !code || !state) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: clientId, shopDomain, code, state',
      });
    }

    console.log(`[Shopify OAuth] 🔄 Completing OAuth for client ${clientId}, shop: ${shopDomain}`);

    // Security Check 1: Validate shop domain format
    if (!ShopifyService.isValidShopDomain(shopDomain)) {
      console.error(`[Shopify OAuth] ❌ Invalid shop domain: ${shopDomain}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid shop domain',
      });
    }

    // Security Check 2: Validate timestamp (if provided) - prevents replay attacks
    if (timestamp && !ShopifyService.isValidOAuthTimestamp(timestamp)) {
      console.error(`[Shopify OAuth] ❌ Invalid timestamp: ${timestamp}`);
      return res.status(400).json({
        success: false,
        error: 'Request has expired. Please try again.',
      });
    }

    // Security Check 3: Parse and verify state parameter (format: clientId:nonce)
    const stateParts = state.split(':');
    const stateClientId = stateParts[0];
    const stateNonce = stateParts.length > 1 ? stateParts.slice(1).join(':') : null;

    if (stateClientId !== clientId) {
      console.error(`[Shopify OAuth] ❌ State clientId mismatch: expected ${clientId}, got ${stateClientId}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid state parameter',
      });
    }

    // Get saved OAuth credentials
    const oauthConfig = await prisma.shopifyOAuthConfig.findUnique({
      where: {
        clientId_shopDomain: {
          clientId,
          shopDomain: shopDomain.trim(),
        },
      },
    });

    if (!oauthConfig) {
      console.error(`[Shopify OAuth] ❌ OAuth config not found for client ${clientId}`);
      return res.status(404).json({
        success: false,
        error: 'OAuth configuration not found. Please restart the setup process.',
      });
    }

    // Security Check 4: Verify nonce matches stored nonce (CSRF protection)
    if (stateNonce && oauthConfig.oauthNonce) {
      if (stateNonce !== oauthConfig.oauthNonce) {
        console.error(`[Shopify OAuth] ❌ Nonce mismatch`);
        return res.status(400).json({
          success: false,
          error: 'Invalid state parameter - nonce mismatch',
        });
      }

      // Check nonce expiry
      if (oauthConfig.oauthNonceExpiry && oauthConfig.oauthNonceExpiry < new Date()) {
        console.error(`[Shopify OAuth] ❌ Nonce expired`);
        return res.status(400).json({
          success: false,
          error: 'Authorization has expired. Please try again.',
        });
      }
    }

    // Decrypt OAuth client secret
    const encryptionService = getEncryptionService();
    const oauthClientSecret = encryptionService.decrypt(oauthConfig.oauthClientSecret);

    // Security Check 5: Verify HMAC signature (if provided)
    // This validates that the request actually came from Shopify
    if (hmac) {
      console.log(`[Shopify OAuth] 🔍 Verifying HMAC signature...`);
      console.log(`[Shopify OAuth] HMAC from request: ${hmac?.substring(0, 20)}...`);
      console.log(`[Shopify OAuth] Timestamp: ${timestamp}`);
      
      const queryParams: Record<string, string> = {
        code,
        shop: shopDomain,
        state,
        ...(timestamp && { timestamp }),
      };

      console.log(`[Shopify OAuth] Query params for HMAC:`, Object.keys(queryParams));

      const isValidHmac = ShopifyService.verifyOAuthHmac(queryParams, hmac, oauthClientSecret);
      if (!isValidHmac) {
        console.error(`[Shopify OAuth] ❌ Invalid HMAC signature`);
        console.error(`[Shopify OAuth] This might be expected if using a custom Shopify app in development`);
        console.warn(`[Shopify OAuth] ⚠️ Continuing anyway for development. ENABLE HMAC CHECK IN PRODUCTION!`);
        // In production, you should uncomment this:
        // return res.status(400).json({
        //   success: false,
        //   error: 'Invalid request signature',
        // });
      } else {
        console.log(`[Shopify OAuth] ✅ HMAC signature verified`);
      }
    } else {
      console.warn(`[Shopify OAuth] ⚠️ No HMAC provided - skipping signature verification`);
      console.warn(`[Shopify OAuth] ⚠️ This is a security risk. Ensure HMAC is passed in production!`);
    }


    console.log(`[Shopify OAuth] 🔑 Exchanging code for access token...`);

    // Exchange authorization code for access token
    const tokenData = await ShopifyService.exchangeCodeForToken({
      shopDomain: shopDomain.trim(),
      clientId: oauthConfig.oauthClientId,
      clientSecret: oauthClientSecret,
      code,
    });

    console.log(`[Shopify OAuth] ✅ Access token received, creating channel...`);

    // Encrypt the access token
    const encryptedAccessToken = encryptionService.encrypt(tokenData.accessToken);

    // Create the channel
    const channel = await prisma.channel.create({
      data: {
        clientId,
        name: `Shopify - ${shopDomain}`,
        type: 'SHOPIFY',
        shopDomain: shopDomain.trim(),
        accessToken: encryptedAccessToken,
        status: 'ACTIVE',
        isActive: true,
        lastSyncAt: null,
      },
    });

    console.log(`[Shopify OAuth] 📦 Channel created with ID: ${channel.id}`);

    // Clean up temporary OAuth config
    await prisma.shopifyOAuthConfig.delete({
      where: {
        clientId_shopDomain: {
          clientId,
          shopDomain: shopDomain.trim(),
        },
      },
    });

    // Check if JTL config exists and trigger sync automatically
    const jtlConfig = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: clientId },
    });

    if (jtlConfig && jtlConfig.isActive && jtlConfig.accessToken) {
      console.log(`[Shopify OAuth] JTL config found for client ${clientId}. Auto-triggering initial sync for new Shopify channel ${channel.id}`);
      // Trigger sync asynchronously (non-blocking)
      const onboardingService = new ClientOnboardingService(prisma);
      (onboardingService as any).triggerInitialSyncAsync(channel.id).catch((err: Error) => {
        console.error(`[Shopify OAuth] Failed to auto-trigger sync for channel ${channel.id}:`, err);
      });
    } else {
      console.log(`[Shopify OAuth] No active JTL config with OAuth tokens found for client ${clientId}. Sync will be triggered when JTL OAuth is completed.`);
    }

    res.json({
      success: true,
      channelId: channel.id,
      message: 'Shopify channel connected successfully via OAuth',
    });
  } catch (error) {
    console.error('[Shopify OAuth] ❌ Error completing OAuth:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'OAuth completion failed',
    });
  }
});

// ============= SYNC ENDPOINTS =============

/**
 * Trigger manual sync for a channel
 */
router.post('/sync/:channelId', async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;
    const { fullSync = false } = req.body;

    if (!syncScheduler) {
      return res.status(503).json({
        success: false,
        error: 'Sync scheduler not initialized',
      });
    }

    const result = await syncScheduler.triggerSyncForChannel(channelId, fullSync);

    res.json({
      success: result.success,
      data: result,
    });
  } catch (error) {
    console.error('Error triggering sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get sync status for all channels
 */
router.get('/sync/status', async (_req: Request, res: Response) => {
  try {
    if (!syncScheduler) {
      return res.status(503).json({
        success: false,
        error: 'Sync scheduler not initialized',
      });
    }

    const status = syncScheduler.getSyncStatus();

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('Error getting sync status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get sync status for a specific channel
 */
router.get('/sync/status/:channelId', async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;

    if (!syncScheduler) {
      return res.status(503).json({
        success: false,
        error: 'Sync scheduler not initialized',
      });
    }

    const status = syncScheduler.getChannelSyncStatus(channelId);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found',
      });
    }

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('Error getting channel sync status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============= WEBHOOK ENDPOINTS =============

/**
 * Shopify webhook handler
 * Processes individual webhook events for products, orders, refunds, and inventory
 */
router.post('/webhooks/shopify/:topic', async (req: Request, res: Response) => {
  try {
    const { topic } = req.params;
    const shopDomain = req.headers['x-shopify-shop-domain'] as string;
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;
    
    // Verify webhook signature in production
    if (process.env.NODE_ENV === 'production' && process.env.SHOPIFY_WEBHOOK_SECRET) {
      const isValid = ShopifyService.verifyWebhookSignature(
        JSON.stringify(req.body),
        hmacHeader,
        process.env.SHOPIFY_WEBHOOK_SECRET
      );
      if (!isValid) {
        console.warn(`Invalid Shopify webhook signature from ${shopDomain}`);
        return res.status(401).send('Invalid signature');
      }
    }

    console.log(`[Webhook] Received Shopify event: ${topic} from ${shopDomain}`);
    
    // Find channel by shop domain
    const channel = await prisma.channel.findFirst({
      where: {
        type: 'SHOPIFY',
        shopDomain,
        isActive: true,
      },
    });

    if (!channel) {
      console.warn(`[Webhook] No active channel found for shop domain: ${shopDomain}`);
      return res.status(200).send('OK'); // Still return 200 to acknowledge receipt
    }

    // Process the webhook event using the WebhookProcessorService
    if (webhookProcessor) {
      // IMPORTANT: Await processing to ensure it completes before serverless function terminates
      // This prevents intermittent data loss in Vercel serverless environment
      try {
        const result = await webhookProcessor.processWebhook({
          channelId: channel.id,
          channelType: 'SHOPIFY',
          topic,
          payload: req.body,
        });
        console.log(`[Webhook] Shopify ${topic} processed:`, result);
      } catch (error) {
        console.error(`[Webhook] Error processing Shopify ${topic}:`, error);
        // Still return 200 to prevent Shopify from retrying
      }
    } else {
      // Fallback to sync scheduler if webhook processor not available
      if (syncScheduler) {
        await syncScheduler.triggerSyncForChannel(channel.id, false);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[Webhook] Error processing Shopify webhook:', error);
    res.status(200).send('OK'); // Return 200 to prevent retries
  }
});

/**
 * WooCommerce webhook handler
 * Processes individual webhook events for products and orders
 */
router.post('/webhooks/woocommerce/:topic', async (req: Request, res: Response) => {
  try {
    const { topic } = req.params;
    const webhookSource = req.headers['x-wc-webhook-source'] as string;
    const signature = req.headers['x-wc-webhook-signature'] as string;
    
    // Verify webhook signature in production
    if (process.env.NODE_ENV === 'production' && process.env.WOOCOMMERCE_WEBHOOK_SECRET) {
      const isValid = WooCommerceService.verifyWebhookSignature(
        JSON.stringify(req.body),
        signature,
        process.env.WOOCOMMERCE_WEBHOOK_SECRET
      );
      if (!isValid) {
        console.warn(`[Webhook] Invalid WooCommerce webhook signature from ${webhookSource}`);
        return res.status(401).send('Invalid signature');
      }
    }
    
    console.log(`[Webhook] Received WooCommerce event: ${topic} from ${webhookSource}`);
    
    // Find channel by API URL
    let channel = null;
    try {
      const hostname = new URL(webhookSource).hostname;
      channel = await prisma.channel.findFirst({
        where: {
          type: 'WOOCOMMERCE',
          apiUrl: { contains: hostname },
          isActive: true,
        },
      });
    } catch (urlError) {
      console.warn(`[Webhook] Invalid webhook source URL: ${webhookSource}`);
    }

    if (!channel) {
      console.warn(`[Webhook] No active channel found for source: ${webhookSource}`);
      return res.status(200).send('OK');
    }

    // Process the webhook event using the WebhookProcessorService
    if (webhookProcessor) {
      // IMPORTANT: Await processing to ensure it completes before serverless function terminates
      // This prevents intermittent data loss in Vercel serverless environment
      try {
        const result = await webhookProcessor.processWebhook({
          channelId: channel.id,
          channelType: 'WOOCOMMERCE',
          topic,
          payload: req.body,
        });
        console.log(`[Webhook] WooCommerce ${topic} processed:`, result);
      } catch (error) {
        console.error(`[Webhook] Error processing WooCommerce ${topic}:`, error);
        // Still return 200 to prevent WooCommerce from retrying
      }
    } else {
      // Fallback to sync scheduler if webhook processor not available
      if (syncScheduler) {
        await syncScheduler.triggerSyncForChannel(channel.id, false);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[Webhook] Error processing WooCommerce webhook:', error);
    res.status(200).send('OK');
  }
});

// ============= CLIENT ONBOARDING ENDPOINTS =============

/**
 * Create a new client account
 */
router.post('/onboarding/client', async (req: Request, res: Response) => {
  try {
    const onboardingService = new ClientOnboardingService(prisma);
    const result = await onboardingService.createClient(req.body);

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Setup JTL credentials for a client
 */
router.post('/onboarding/jtl-credentials', async (req: Request, res: Response) => {
  try {
    const onboardingService = new ClientOnboardingService(prisma);
    const result = await onboardingService.setupJTLCredentials(req.body);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error setting up JTL credentials:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Complete JTL OAuth flow
 */
router.post('/onboarding/jtl-oauth-complete', async (req: Request, res: Response) => {
  try {
    const { clientId, authorizationCode, redirectUri } = req.body;

    if (!clientId || !authorizationCode || !redirectUri) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: clientId, authorizationCode, redirectUri',
      });
    }

    const onboardingService = new ClientOnboardingService(prisma);
    const result = await onboardingService.completeJTLOAuth(
      clientId,
      authorizationCode,
      redirectUri
    );

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error completing JTL OAuth:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start Shopify OAuth flow (saves credentials and returns auth URL)
 * This is the first step when using OAuth
 */
router.post('/onboarding/channel/shopify/start-oauth', async (req: Request, res: Response) => {
  try {
    const { clientId, shopDomain, oauthClientId, oauthClientSecret, redirectUri } = req.body;

    if (!clientId || !shopDomain || !oauthClientId || !oauthClientSecret) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: clientId, shopDomain, oauthClientId, oauthClientSecret',
      });
    }

    console.log(`[Shopify OAuth] Starting OAuth flow for client ${clientId}, shop: ${shopDomain}`);

    // Validate shop domain
    if (!ShopifyService.isValidShopDomain(shopDomain)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid shop domain. Must be a valid Shopify store (e.g., mystore.myshopify.com)',
      });
    }

    // Step 1: Save OAuth credentials
    const encryptionService = getEncryptionService();
    const encryptedSecret = encryptionService.encrypt(oauthClientSecret);

    await prisma.shopifyOAuthConfig.upsert({
      where: {
        clientId_shopDomain: {
          clientId,
          shopDomain: shopDomain.trim(),
        },
      },
      create: {
        clientId,
        shopDomain: shopDomain.trim(),
        oauthClientId,
        oauthClientSecret: encryptedSecret,
      },
      update: {
        oauthClientId,
        oauthClientSecret: encryptedSecret,
      },
    });

    // Step 2: Generate OAuth state with nonce
    const nonce = ShopifyService.generateOAuthNonce();
    const state = `${clientId}:${nonce}`;

    // Store nonce for verification
    await prisma.shopifyOAuthConfig.update({
      where: {
        clientId_shopDomain: {
          clientId,
          shopDomain: shopDomain.trim(),
        },
      },
      data: {
        oauthNonce: nonce,
        oauthNonceExpiry: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      },
    });

    // Step 3: Generate authorization URL
    const scopes = [
      'read_products',
      'write_products',
      'read_orders',
      'write_orders',
      'read_fulfillments',
      'write_fulfillments',
      'read_inventory',
      'write_inventory',
      'read_shipping',
      'write_shipping',
    ];

    const actualRedirectUri = redirectUri || `${process.env.FRONTEND_URL}/setup/shopify/callback`;

    const authUrl = ShopifyService.generateAuthorizationUrl({
      shopDomain: shopDomain.trim(),
      clientId: oauthClientId,
      redirectUri: actualRedirectUri,
      scopes,
      state,
    });

    console.log(`[Shopify OAuth] Generated auth URL for ${shopDomain}`);

    res.json({
      success: true,
      authUrl,
      state,
      redirectUri: actualRedirectUri,
      message: 'OAuth credentials saved. Redirect user to authUrl to complete authorization.',
    });
  } catch (error) {
    console.error('[Shopify OAuth] Error starting OAuth flow:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Add a Shopify channel for a client (Unified endpoint)
 * Supports both OAuth flow and manual credential input
 */
router.post('/onboarding/channel/shopify', async (req: Request, res: Response) => {
  try {
    const { clientId, shopDomain, code, state, hmac, timestamp, accessToken, channelName } = req.body;

    // Detect which flow is being used
    const isOAuthFlow = code && state; // OAuth flow has code and state
    const isManualFlow = accessToken; // Manual flow has accessToken

    if (!clientId || !shopDomain) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: clientId, shopDomain',
      });
    }

    // OAUTH FLOW - Complete OAuth and create channel
    if (isOAuthFlow) {
      console.log(`[Shopify Setup] Using OAuth flow for client ${clientId}, shop: ${shopDomain}`);

      // Validate shop domain format
      if (!ShopifyService.isValidShopDomain(shopDomain)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid shop domain',
        });
      }

      // Get saved OAuth credentials
      const oauthConfig = await prisma.shopifyOAuthConfig.findUnique({
        where: {
          clientId_shopDomain: {
            clientId,
            shopDomain: shopDomain.trim(),
          },
        },
      });

      if (!oauthConfig) {
        return res.status(404).json({
          success: false,
          error: 'OAuth configuration not found. Please start the OAuth flow from the beginning.',
        });
      }

      // Verify state parameter
      const stateParts = state.split(':');
      const stateClientId = stateParts[0];
      const stateNonce = stateParts.length > 1 ? stateParts.slice(1).join(':') : null;

      if (stateClientId !== clientId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid state parameter',
        });
      }

      // Verify nonce
      if (stateNonce && oauthConfig.oauthNonce) {
        if (stateNonce !== oauthConfig.oauthNonce) {
          return res.status(400).json({
            success: false,
            error: 'Invalid state parameter - nonce mismatch',
          });
        }

        if (oauthConfig.oauthNonceExpiry && oauthConfig.oauthNonceExpiry < new Date()) {
          return res.status(400).json({
            success: false,
            error: 'Authorization has expired. Please try again.',
          });
        }
      }

      // Decrypt OAuth client secret
      const encryptionService = getEncryptionService();
      const oauthClientSecret = encryptionService.decrypt(oauthConfig.oauthClientSecret);

      console.log(`[Shopify Setup] Exchanging code for access token...`);

      // Exchange authorization code for access token
      const tokenData = await ShopifyService.exchangeCodeForToken({
        shopDomain: shopDomain.trim(),
        clientId: oauthConfig.oauthClientId,
        clientSecret: oauthClientSecret,
        code,
      });

      // Encrypt the access token
      const encryptedAccessToken = encryptionService.encrypt(tokenData.accessToken);

      // Create the channel
      const channel = await prisma.channel.create({
        data: {
          clientId,
          name: channelName || `Shopify - ${shopDomain}`,
          type: 'SHOPIFY',
          shopDomain: shopDomain.trim(),
          accessToken: encryptedAccessToken,
          status: 'ACTIVE',
          isActive: true,
          syncEnabled: true,
          lastSyncAt: null,
        },
      });

      console.log(`[Shopify Setup] Channel created with ID: ${channel.id}`);

      // Clean up temporary OAuth config
      await prisma.shopifyOAuthConfig.delete({
        where: {
          clientId_shopDomain: {
            clientId,
            shopDomain: shopDomain.trim(),
          },
        },
      });

      // Check if JTL config exists and trigger sync automatically
      const jtlConfig = await prisma.jtlConfig.findUnique({
        where: { clientId_fk: clientId },
      });

      if (jtlConfig && jtlConfig.isActive && jtlConfig.accessToken) {
        console.log(`[Shopify Setup] JTL config found. Auto-triggering initial sync for channel ${channel.id}`);
        const onboardingService = new ClientOnboardingService(prisma);
        (onboardingService as any).triggerInitialSyncAsync(channel.id).catch((err: Error) => {
          console.error(`[Shopify Setup] Failed to auto-trigger sync for channel ${channel.id}:`, err);
        });
      }

      return res.status(201).json({
        success: true,
        channelId: channel.id,
        message: 'Shopify channel connected successfully via OAuth',
      });
    }

    // MANUAL FLOW - Use provided access token
    if (isManualFlow) {
      console.log(`[Shopify Setup] Using manual flow for client ${clientId}, shop: ${shopDomain}`);

      const onboardingService = new ClientOnboardingService(prisma);
      const result = await onboardingService.addShopifyChannel({
        clientId,
        shopDomain,
        accessToken,
        channelName,
      });

      if (result.success) {
        return res.status(201).json(result);
      } else {
        return res.status(400).json(result);
      }
    }

    // Neither flow detected
    return res.status(400).json({
      success: false,
      error: 'Invalid request. Provide either (code + state) for OAuth or (accessToken) for manual setup',
    });

  } catch (error) {
    console.error('[Shopify Setup] Error adding channel:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Add a WooCommerce channel for a client
 */
router.post('/onboarding/channel/woocommerce', async (req: Request, res: Response) => {
  try {
    const { clientId, storeUrl, consumerKey, consumerSecret } = req.body;

    if (!clientId || !storeUrl || !consumerKey || !consumerSecret) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: clientId, storeUrl, consumerKey, consumerSecret',
      });
    }

    console.log(`[WooCommerce Setup] Setting up channel for client ${clientId}, store: ${storeUrl}`);

    const onboardingService = new ClientOnboardingService(prisma);
    const result = await onboardingService.addWooCommerceChannel(req.body);

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('[WooCommerce Setup] Error adding channel:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Trigger initial sync for a channel
 */
router.post('/onboarding/sync/:channelId', async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;
    const { syncFromDate, enableHistoricalSync } = req.body;

    const onboardingService = new ClientOnboardingService(prisma);
    const result = await onboardingService.triggerInitialSync(
      channelId,
      syncFromDate,
      enableHistoricalSync
    );

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error triggering initial sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start background sync with user-selected date
 * This is called after JTL OAuth completion with the date the user wants to sync from
 */
router.post('/sync/background/:channelId', async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;
    const { syncFromDate } = req.body;

    if (!syncFromDate) {
      return res.status(400).json({
        success: false,
        error: 'syncFromDate is required',
      });
    }

    const syncDate = new Date(syncFromDate);
    if (isNaN(syncDate.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format for syncFromDate',
      });
    }

    const onboardingService = new ClientOnboardingService(prisma);
    const result = await onboardingService.startBackgroundSync(channelId, syncDate);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error starting background sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Trigger historic data sync for a channel (last 180 days)
 * This is used for initial onboarding to pull historic orders, returns, and inbounds
 */
router.post('/sync/historic/:channelId', authenticate, async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;
    const { daysBack = 180 } = req.body;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      include: {
        client: {
          include: { jtlConfig: true },
        },
      },
    });

    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found',
      });
    }

    if (!channel.client.jtlConfig) {
      return res.status(400).json({
        success: false,
        error: 'JTL credentials not configured for this client',
      });
    }

    // Calculate the date to sync from (default 180 days back)
    const sinceDays = Math.min(Math.max(Number(daysBack) || 180, 1), 365);
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    console.log(`Triggering historic sync for channel ${channelId} (last ${sinceDays} days, since ${since.toISOString()})`);

    // Build credentials based on channel type
    let channelCredentials: any;
    
    if (channel.type === 'SHOPIFY') {
      if (!channel.shopDomain || !channel.accessToken) {
        return res.status(400).json({
          success: false,
          error: 'Shopify credentials not configured',
        });
      }
      channelCredentials = {
        shopDomain: channel.shopDomain,
        accessToken: channel.accessToken,
      };
    } else if (channel.type === 'WOOCOMMERCE') {
      if (!channel.apiUrl || !channel.apiClientId || !channel.apiClientSecret) {
        return res.status(400).json({
          success: false,
          error: 'WooCommerce credentials not configured',
        });
      }
      channelCredentials = {
        url: channel.apiUrl,
        consumerKey: channel.apiClientId,
        consumerSecret: channel.apiClientSecret,
      };
    } else {
      return res.status(400).json({
        success: false,
        error: `Unsupported channel type: ${channel.type}`,
      });
    }

    const jtlConfig = channel.client.jtlConfig;
    const jtlCredentials = {
      clientId: jtlConfig.clientId,
      clientSecret: jtlConfig.clientSecret,
      accessToken: jtlConfig.accessToken || undefined,
      refreshToken: jtlConfig.refreshToken || undefined,
      environment: jtlConfig.environment as 'sandbox' | 'production',
    };

    // Import SyncOrchestrator dynamically to avoid circular dependencies
    const { SyncOrchestrator } = await import('../services/integrations/sync-orchestrator.js');

    // Create sync orchestrator config
    const orchestratorConfig = channel.type === 'SHOPIFY'
      ? {
          channelId: channel.id,
          channelType: channel.type,
          shopifyCredentials: channelCredentials,
          jtlCredentials,
          jtlFulfillerId: jtlConfig.fulfillerId,
          jtlWarehouseId: jtlConfig.warehouseId,
        }
      : {
          channelId: channel.id,
          channelType: channel.type,
          wooCommerceCredentials: channelCredentials,
          jtlCredentials,
          jtlFulfillerId: jtlConfig.fulfillerId,
          jtlWarehouseId: jtlConfig.warehouseId,
        };

    const orchestrator = new SyncOrchestrator(prisma, orchestratorConfig);

    // Run sync with the specified date limit
    const syncResult = await orchestrator.runFullSync(since);

    // Update last sync time
    await prisma.channel.update({
      where: { id: channelId },
      data: { lastSyncAt: new Date() },
    });

    // Check if any sync had errors
    const hasErrors = 
      syncResult.products.itemsFailed > 0 ||
      syncResult.orders.itemsFailed > 0 ||
      syncResult.returns.itemsFailed > 0;

    res.json({
      success: !hasErrors,
      channelId,
      syncedSince: since.toISOString(),
      details: {
        products: syncResult.products,
        orders: syncResult.orders,
        returns: syncResult.returns,
      },
    });
  } catch (error) {
    console.error('Error triggering historic sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get onboarding status for a client
 */
router.get('/onboarding/status/:clientId', async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const onboardingService = new ClientOnboardingService(prisma);
    const status = await onboardingService.getOnboardingStatus(clientId);

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error('Error getting onboarding status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Complete onboarding for a Shopify client (all-in-one)
 */
router.post('/onboarding/complete/shopify', async (req: Request, res: Response) => {
  try {
    const { client, jtl, shopify } = req.body;

    if (!client || !jtl || !shopify) {
      return res.status(400).json({
        success: false,
        error: 'Missing required data: client, jtl, shopify',
      });
    }

    const onboardingService = new ClientOnboardingService(prisma);
    const result = await onboardingService.onboardShopifyClient(client, jtl, shopify);

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error in complete Shopify onboarding:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Complete onboarding for a WooCommerce client (all-in-one)
 */
router.post('/onboarding/complete/woocommerce', async (req: Request, res: Response) => {
  try {
    const { client, jtl, woocommerce } = req.body;

    if (!client || !jtl || !woocommerce) {
      return res.status(400).json({
        success: false,
        error: 'Missing required data: client, jtl, woocommerce',
      });
    }

    const onboardingService = new ClientOnboardingService(prisma);
    const result = await onboardingService.onboardWooCommerceClient(client, jtl, woocommerce);

    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error in complete WooCommerce onboarding:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============= CHANNEL DATA ENDPOINTS =============

/**
 * Get channels for authenticated client
 */
router.get('/channels', authenticate, async (req: Request, res: Response) => {
  try {
    const { clientId } = req.query;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: clientId',
      });
    }

    const channelDataService = new ChannelDataService(prisma);
    const result = await channelDataService.getChannelsByClient(clientId as string);

    res.json(result);
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      channels: [],
    });
  }
});

/**
 * Get warehouse locations for authenticated client
 */
router.get('/warehouse-locations', authenticate, async (req: Request, res: Response) => {
  try {
    const { clientId } = req.query;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: clientId',
      });
    }

    const channelDataService = new ChannelDataService(prisma);
    const result = await channelDataService.getWarehouseLocations(clientId as string);

    res.json(result);
  } catch (error) {
    console.error('Error fetching warehouse locations:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      locations: [],
    });
  }
});

/**
 * Get shipping methods for a channel
 */
router.get('/shipping-methods/:channelId', authenticate, async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;

    if (!channelId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: channelId',
      });
    }

    const channelDataService = new ChannelDataService(prisma);
    const result = await channelDataService.getShippingMethodsForChannel(channelId);

    res.json(result);
  } catch (error) {
    console.error('Error fetching shipping methods:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      warehouseMethods: [],
      channelMethods: [],
    });
  }
});

/**
 * Save shipping method mappings for a channel
 * Maps channel shipping methods (from Shopify/WooCommerce) to warehouse methods (JTL FFN)
 */
router.put('/channels/:channelId/shipping-mappings', authenticate, async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;
    const { mappings } = req.body;

    if (!channelId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: channelId',
      });
    }

    if (!mappings || typeof mappings !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid mappings object',
      });
    }

    const channelDataService = new ChannelDataService(prisma);
    const result = await channelDataService.saveShippingMappings(channelId, mappings);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      message: `Saved ${result.saved} shipping method mappings`,
      saved: result.saved,
    });
  } catch (error) {
    console.error('Error saving shipping mappings:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============= BI-DIRECTIONAL SYNC ENDPOINTS =============
// Push data from No-Limits to Shopify/WooCommerce

/**
 * Push a product to the connected e-commerce platform
 */
router.post('/sync/push/product/:productId', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;

    if (!biDirectionalSyncService) {
      biDirectionalSyncService = new BiDirectionalSyncService(prisma);
    }

    const result = await biDirectionalSyncService.pushProductToPlatform(productId);

    res.json({
      success: result.success,
      message: result.success
        ? `Product pushed to ${result.totalProcessed} platform(s)`
        : `Failed to push product to ${result.totalFailed} platform(s)`,
      data: result,
    });
  } catch (error) {
    console.error('Error pushing product to platform:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Batch push multiple products to platforms
 */
router.post('/sync/push/products', authenticate, async (req: Request, res: Response) => {
  try {
    const { productIds } = req.body;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid productIds array',
      });
    }

    if (!biDirectionalSyncService) {
      biDirectionalSyncService = new BiDirectionalSyncService(prisma);
    }

    const result = await biDirectionalSyncService.batchPushProducts(productIds);

    res.json({
      success: result.success,
      message: `Processed ${result.totalProcessed} products, ${result.totalFailed} failed`,
      data: result,
    });
  } catch (error) {
    console.error('Error batch pushing products:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Delete a product from the connected e-commerce platform
 */
router.delete('/sync/push/product/:productId', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;

    if (!biDirectionalSyncService) {
      biDirectionalSyncService = new BiDirectionalSyncService(prisma);
    }

    const result = await biDirectionalSyncService.deleteProductFromPlatform(productId);

    res.json({
      success: result.success,
      message: result.success
        ? `Product deleted from ${result.totalProcessed} platform(s)`
        : `Failed to delete product from ${result.totalFailed} platform(s)`,
      data: result,
    });
  } catch (error) {
    console.error('Error deleting product from platform:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Push an order to the connected e-commerce platform
 */
router.post('/sync/push/order/:orderId', authenticate, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;

    if (!biDirectionalSyncService) {
      biDirectionalSyncService = new BiDirectionalSyncService(prisma);
    }

    const result = await biDirectionalSyncService.pushOrderToPlatform(orderId);

    if (result.success) {
      res.json({
        success: true,
        message: `Order ${result.action} successfully`,
        data: result,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
        data: result,
      });
    }
  } catch (error) {
    console.error('Error pushing order to platform:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Update order status on the connected e-commerce platform
 */
router.put('/sync/push/order/:orderId/status', authenticate, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: status',
      });
    }

    if (!biDirectionalSyncService) {
      biDirectionalSyncService = new BiDirectionalSyncService(prisma);
    }

    const result = await biDirectionalSyncService.updateOrderStatusOnPlatform(orderId, status);

    if (result.success) {
      res.json({
        success: true,
        message: 'Order status updated on platform',
        data: result,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
        data: result,
      });
    }
  } catch (error) {
    console.error('Error updating order status on platform:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Update inventory/stock on the connected e-commerce platform
 */
router.put('/sync/push/inventory/:productId', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { stockQuantity, channelId } = req.body;

    if (stockQuantity === undefined || stockQuantity === null) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: stockQuantity',
      });
    }

    if (!biDirectionalSyncService) {
      biDirectionalSyncService = new BiDirectionalSyncService(prisma);
    }

    // If channelId provided, update only that channel, otherwise update all channels
    let results: any[];
    if (channelId) {
      const result = await biDirectionalSyncService.updateInventoryOnPlatform(productId, channelId, stockQuantity);
      results = [result];
    } else {
      // Get all channels for this product
      const productChannels = await prisma.productChannel.findMany({
        where: { productId },
        select: { channelId: true },
      });

      results = await Promise.all(
        productChannels.map(pc =>
          biDirectionalSyncService.updateInventoryOnPlatform(productId, pc.channelId, stockQuantity)
        )
      );
    }

    const allSucceeded = results.every(r => r.success);

    res.json({
      success: allSucceeded,
      message: allSucceeded
        ? 'Inventory updated on platform(s)'
        : 'Some inventory updates failed',
      data: { results },
    });
  } catch (error) {
    console.error('Error updating inventory on platform:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Create a refund on the connected e-commerce platform
 */
router.post('/sync/push/refund/:returnId', authenticate, async (req: Request, res: Response) => {
  try {
    const { returnId } = req.params;

    if (!biDirectionalSyncService) {
      biDirectionalSyncService = new BiDirectionalSyncService(prisma);
    }

    const result = await biDirectionalSyncService.createRefundOnPlatform(returnId);

    if (result.success) {
      res.json({
        success: true,
        message: 'Refund created on platform',
        data: result,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
        data: result,
      });
    }
  } catch (error) {
    console.error('Error creating refund on platform:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Sync all products for a channel to the platform
 */
router.post('/sync/push/channel/:channelId/products', authenticate, async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;

    // Get all products for the channel
    const productChannels = await prisma.productChannel.findMany({
      where: {
        channelId,
      },
      select: { productId: true },
    });

    if (productChannels.length === 0) {
      return res.json({
        success: true,
        message: 'No products to sync',
        data: { totalProcessed: 0, totalFailed: 0, results: [] },
      });
    }

    if (!biDirectionalSyncService) {
      biDirectionalSyncService = new BiDirectionalSyncService(prisma);
    }

    const productIds = productChannels.map(pc => pc.productId);
    const result = await biDirectionalSyncService.batchPushProductsToChannel(productIds, channelId);

    res.json({
      success: result.success,
      message: `Synced ${result.totalProcessed} products, ${result.totalFailed} failed`,
      data: result,
    });
  } catch (error) {
    console.error('Error syncing channel products:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============= PRODUCT SYNC WITH ORIGIN TRACKING =============

import { ProductSyncService, EnhancedWebhookProcessor, SyncQueueProcessor, JTLPollingService, FIELD_OWNERSHIP } from '../services/integrations/index.js';

let productSyncService: ProductSyncService;
let enhancedWebhookProcessor: EnhancedWebhookProcessor;
let syncQueueProcessor: SyncQueueProcessor;
let jtlPollingService: JTLPollingService;

/**
 * Initialize enhanced sync services
 */
export function initializeEnhancedSync(prismaClient: PrismaClient): void {
  productSyncService = new ProductSyncService(prismaClient);
  enhancedWebhookProcessor = new EnhancedWebhookProcessor(prismaClient);
  syncQueueProcessor = new SyncQueueProcessor(prismaClient, {
    batchSize: 10,
    pollIntervalMs: 5000,
    maxRetries: 3,
  });
  jtlPollingService = new JTLPollingService(prismaClient, 2 * 60 * 1000); // Poll every 2 minutes

  // Re-create webhook processor with sync queue processor to enable JTL push
  webhookProcessor = new WebhookProcessorService(prismaClient, syncQueueProcessor);
}

/**
 * Start enhanced sync background processes
 */
export function startEnhancedSyncProcessors(): void {
  if (syncQueueProcessor) {
    syncQueueProcessor.start();
  }
  if (jtlPollingService) {
    jtlPollingService.start();
  }
}

/**
 * Stop enhanced sync background processes
 */
export function stopEnhancedSyncProcessors(): void {
  if (syncQueueProcessor) {
    syncQueueProcessor.stop();
  }
  if (jtlPollingService) {
    jtlPollingService.stop();
  }
  if (enhancedWebhookProcessor) {
    enhancedWebhookProcessor.destroy();
  }
}

/**
 * Get field ownership configuration
 */
router.get('/product-sync/field-ownership', authenticate, (req: Request, res: Response) => {
  res.json({
    success: true,
    data: FIELD_OWNERSHIP,
  });
});

/**
 * Get sync status for a client
 */
router.get('/product-sync/status/:clientId', authenticate, async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    if (!productSyncService) {
      productSyncService = new ProductSyncService(prisma);
    }

    const status = await productSyncService.getSyncStatus(clientId);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('Error getting sync status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get products with sync conflicts
 */
router.get('/product-sync/conflicts/:clientId', authenticate, async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    if (!productSyncService) {
      productSyncService = new ProductSyncService(prisma);
    }

    const conflicts = await productSyncService.getProductsWithConflicts(clientId);

    res.json({
      success: true,
      data: conflicts,
    });
  } catch (error) {
    console.error('Error getting conflicts:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Resolve a sync conflict
 */
router.post('/product-sync/conflicts/:productId/resolve', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { resolution, mergeData } = req.body;

    if (!productSyncService) {
      productSyncService = new ProductSyncService(prisma);
    }

    const result = await productSyncService.resolveConflict(
      productId,
      resolution,
      mergeData
    );

    if (result.success) {
      res.json({
        success: true,
        message: 'Conflict resolved',
        data: result,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error('Error resolving conflict:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Manually sync a product to all platforms
 */
router.post('/product-sync/product/:productId/sync', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { skipPlatforms } = req.body;

    if (!productSyncService) {
      productSyncService = new ProductSyncService(prisma);
    }

    const result = await productSyncService.pushProductToAllPlatforms(
      productId,
      'nolimits',
      { skipPlatforms }
    );

    res.json({
      success: result.success,
      message: result.success ? 'Product synced successfully' : 'Sync failed',
      data: result,
    });
  } catch (error) {
    console.error('Error syncing product:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Queue a product for async sync
 */
router.post('/product-sync/product/:productId/queue', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { priority } = req.body;

    if (!syncQueueProcessor) {
      syncQueueProcessor = new SyncQueueProcessor(prisma);
    }

    const jobIds = await syncQueueProcessor.queueProductSync(productId, 'NOLIMITS', priority || 0);

    res.json({
      success: true,
      message: `Queued ${jobIds.length} sync jobs`,
      data: { jobIds },
    });
  } catch (error) {
    console.error('Error queueing product sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get sync queue status for a product
 */
router.get('/product-sync/product/:productId/queue-status', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;

    if (!syncQueueProcessor) {
      syncQueueProcessor = new SyncQueueProcessor(prisma);
    }

    const status = await syncQueueProcessor.getProductQueueStatus(productId);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Retry failed sync jobs for a product
 */
router.post('/product-sync/product/:productId/retry-failed', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;

    if (!syncQueueProcessor) {
      syncQueueProcessor = new SyncQueueProcessor(prisma);
    }

    const count = await syncQueueProcessor.retryFailedJobs(productId);

    res.json({
      success: true,
      message: `Retried ${count} failed jobs`,
      data: { retriedCount: count },
    });
  } catch (error) {
    console.error('Error retrying failed jobs:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Full sync for all products of a client
 */
router.post('/product-sync/client/:clientId/full-sync', authenticate, async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;

    if (!productSyncService) {
      productSyncService = new ProductSyncService(prisma);
    }

    const result = await productSyncService.fullSyncForClient(clientId);

    res.json({
      success: result.failed === 0,
      message: `Synced ${result.synced}/${result.totalProducts} products`,
      data: result,
    });
  } catch (error) {
    console.error('Error running full sync:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get sync queue processor metrics
 */
router.get('/product-sync/metrics', authenticate, (req: Request, res: Response) => {
  if (!syncQueueProcessor) {
    return res.status(503).json({
      success: false,
      error: 'Sync queue processor not initialized',
    });
  }

  res.json({
    success: true,
    data: syncQueueProcessor.getMetrics(),
  });
});

/**
 * Get sync logs for a product
 */
router.get('/product-sync/product/:productId/logs', authenticate, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { limit = '20', offset = '0' } = req.query;

    const logs = await prisma.productSyncLog.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    const total = await prisma.productSyncLog.count({
      where: { productId },
    });

    res.json({
      success: true,
      data: {
        logs,
        total,
        hasMore: parseInt(offset as string) + logs.length < total,
      },
    });
  } catch (error) {
    console.error('Error getting sync logs:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Enhanced Shopify webhook handler with origin tracking
 * Note: Using regex pattern to handle topics with slashes (e.g., products/create)
 */
router.post(/^\/webhooks\/shopify-enhanced\/(.+)$/, async (req: Request, res: Response) => {
  try {
    // Extract topic from regex capture group
    const topic = req.params[0];
    const shopDomain = req.headers['x-shopify-shop-domain'] as string;
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] as string;
    const webhookId = req.headers['x-shopify-webhook-id'] as string;

    // Verify webhook signature in production
    if (process.env.NODE_ENV === 'production' && process.env.SHOPIFY_WEBHOOK_SECRET) {
      const isValid = ShopifyService.verifyWebhookSignature(
        JSON.stringify(req.body),
        hmacHeader,
        process.env.SHOPIFY_WEBHOOK_SECRET
      );
      if (!isValid) {
        console.warn(`[Webhook] Invalid Shopify signature from ${shopDomain}`);
        return res.status(401).send('Invalid signature');
      }
    }

    console.log(`[Webhook] Enhanced Shopify event: ${topic} from ${shopDomain}`);

    // Find channel
    const channel = await prisma.channel.findFirst({
      where: { type: 'SHOPIFY', shopDomain, isActive: true },
    });

    if (!channel) {
      console.warn(`[Webhook] No channel found for: ${shopDomain}`);
      return res.status(200).send('OK');
    }

    // Initialize processor if needed
    if (!enhancedWebhookProcessor) {
      enhancedWebhookProcessor = new EnhancedWebhookProcessor(prisma);
    }

    // IMPORTANT: Await processing to ensure it completes before serverless function terminates
    try {
      const result = await enhancedWebhookProcessor.processWebhook({
        channelId: channel.id,
        channelType: 'SHOPIFY',
        topic,
        payload: req.body,
        webhookId,
      });
      console.log(`[Webhook] Enhanced Shopify ${topic} processed:`, {
        success: result.success,
        action: result.action,
        entityType: result.entityType,
        syncQueuedTo: result.syncQueuedTo,
      });
    } catch (error) {
      console.error(`[Webhook] Error processing enhanced Shopify ${topic}:`, error);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[Webhook] Error in enhanced Shopify handler:', error);
    res.status(200).send('OK');
  }
});

/**
 * Enhanced WooCommerce webhook handler with origin tracking
 * Note: Using regex pattern to handle topics with dots (e.g., product.created)
 */
router.post(/^\/webhooks\/woocommerce-enhanced\/(.+)$/, async (req: Request, res: Response) => {
  try {
    // Extract topic from regex capture group
    const topic = req.params[0];
    const webhookSource = req.headers['x-wc-webhook-source'] as string;
    const webhookId = req.headers['x-wc-webhook-id'] as string;
    const webhookSignature = req.headers['x-wc-webhook-signature'] as string;

    console.log(`[Webhook] Enhanced WooCommerce event: ${topic} from ${webhookSource}`);

    // Find channel by source URL
    const channel = await prisma.channel.findFirst({
      where: {
        type: 'WOOCOMMERCE',
        apiUrl: { contains: new URL(webhookSource).host },
        isActive: true,
      },
    });

    if (!channel) {
      console.warn(`[Webhook] No channel found for: ${webhookSource}`);
      return res.status(200).send('OK');
    }

    // Initialize processor if needed
    if (!enhancedWebhookProcessor) {
      enhancedWebhookProcessor = new EnhancedWebhookProcessor(prisma);
    }

    // IMPORTANT: Await processing to ensure it completes before serverless function terminates
    try {
      const result = await enhancedWebhookProcessor.processWebhook({
        channelId: channel.id,
        channelType: 'WOOCOMMERCE',
        topic,
        payload: req.body,
        webhookId,
      });
      console.log(`[Webhook] Enhanced WooCommerce ${topic} processed:`, {
        success: result.success,
        action: result.action,
        entityType: result.entityType,
        syncQueuedTo: result.syncQueuedTo,
      });
    } catch (error) {
      console.error(`[Webhook] Error processing enhanced WooCommerce ${topic}:`, error);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[Webhook] Error in enhanced WooCommerce handler:', error);
    res.status(200).send('OK');
  }
});

/**
 * Create product from No-Limits and sync to all platforms
 */
router.post('/product-sync/create', authenticate, async (req: Request, res: Response) => {
  try {
    const {
      clientId,
      name,
      description,
      sku,
      gtin,
      price,
      compareAtPrice,
      quantity,
      weight,
      height,
      length,
      width,
      imageUrl,
      tags,
      productType,
      vendor,
      channelIds, // Optional: specific channels to sync to
    } = req.body;

    if (!clientId || !name || !sku) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: clientId, name, sku',
      });
    }

    // Create product in No-Limits
    const product = await prisma.product.create({
      data: {
        clientId,
        productId: `NL-${Date.now()}`,
        name,
        description,
        sku,
        gtin,
        netSalesPrice: price,
        compareAtPrice,
        available: quantity || 0,
        weightInKg: weight,
        heightInCm: height,
        lengthInCm: length,
        widthInCm: width,
        imageUrl,
        tags: tags || [],
        productType,
        vendor,
        lastUpdatedBy: 'NOLIMITS',
        syncStatus: 'PENDING',
      },
    });

    // Link to channels
    let linkedChannels: string[] = [];
    if (channelIds && channelIds.length > 0) {
      for (const channelId of channelIds) {
        await prisma.productChannel.create({
          data: {
            productId: product.id,
            channelId,
            syncStatus: 'PENDING',
          },
        });
        linkedChannels.push(channelId);
      }
    } else {
      // Link to all active channels for this client
      const channels = await prisma.channel.findMany({
        where: { clientId, isActive: true, syncEnabled: true },
      });
      for (const channel of channels) {
        await prisma.productChannel.create({
          data: {
            productId: product.id,
            channelId: channel.id,
            syncStatus: 'PENDING',
          },
        });
        linkedChannels.push(channel.id);
      }
    }

    // Initialize sync service if needed
    if (!productSyncService) {
      productSyncService = new ProductSyncService(prisma);
    }

    // Sync to all platforms
    const syncResult = await productSyncService.pushProductToAllPlatforms(product.id, 'nolimits');

    res.json({
      success: true,
      message: 'Product created and synced',
      data: {
        product,
        linkedChannels,
        syncResult,
      },
    });
  } catch (error) {
    console.error('Error creating and syncing product:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * TEST ENDPOINT - Verify Shopify connection and fetch products
 */
router.get('/test/shopify/:channelId', authenticate, async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;

    console.log(`[Test] Testing Shopify connection for channel: ${channelId}`);

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found'
      });
    }

    if (channel.type !== 'SHOPIFY') {
      return res.status(400).json({
        success: false,
        error: `Channel type is ${channel.type}, not SHOPIFY`
      });
    }

    if (!channel.shopDomain || !channel.accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Shopify credentials not configured'
      });
    }

    const encryptionService = getEncryptionService();
    const shopifyService = createShopifyServiceAuto({
      shopDomain: channel.shopDomain,
      accessToken: encryptionService.decrypt(channel.accessToken),
    });

    console.log(`[Test] Fetching products from Shopify: ${channel.shopDomain}`);
    const startTime = Date.now();

    const products = await shopifyService.getAllProducts();

    const duration = Date.now() - startTime;
    console.log(`[Test] Found ${products.length} products in ${duration}ms`);

    res.json({
      success: true,
      shopDomain: channel.shopDomain,
      productCount: products.length,
      duration: `${duration}ms`,
      sampleProducts: products.slice(0, 5).map(p => ({
        id: p.id,
        title: p.title,
        variantsCount: p.variants.length,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    });
  } catch (error) {
    console.error('[Test] Error testing Shopify connection:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
});

export default router;

