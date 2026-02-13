/**
 * JTL-FFN Merchant API Service
 * Handles all communication with JTL Fulfillment Network API
 * 
 * Endpoints:
 * - Outbounds: Create and manage orders for fulfillment
 * - Products: Register and manage product catalog
 * - Returns: Handle customer returns
 * - Inbounds: Announce stock deliveries to warehouse
 */

import {
  JTLCredentials,
  JTLOutbound,
  JTLProduct,
  JTLInbound,
  JTLReturn,
  SyncResult,
  SyncItemResult,
} from './types.js';
import { PrismaClient } from '@prisma/client';
import { getEncryptionService } from '../encryption.service.js';
import { Logger } from '../../utils/logger.js';
import { generateJobId } from '../../utils/job-id.js';

interface JTLTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface JTLOutboundResponse {
  outboundId: string;
  merchantOutboundNumber: string;
  status: string;
  createdAt: string;
}

interface JTLProductResponse {
  jfsku: string;
  merchantSku: string;
  name: string;
  status: string;
}

interface JTLInboundResponse {
  inboundId: string;
  merchantInboundNumber: string;
  status: string;
  createdAt: string;
}

interface JTLReturnResponse {
  returnId: string;
  merchantReturnNumber: string;
  status: string;
  createdAt: string;
}

interface JTLUpdateItem<T = unknown> {
  id: string;
  updateType: string;
  timestamp: string;
  data: T;
}

// Stock information from JTL FFN Products API
interface JTLStockInfo {
  stockLevel: number;           // Available stock
  stockLevelAnnounced: number;  // Expected from inbounds
  stockLevelReserved: number;   // Reserved for orders
  stockLevelBlocked: number;    // Blocked stock
  warehouses?: {
    warehouseId: string;
    fulfillerId: string;
    stockLevel: number;
    stockLevelAnnounced: number;
    stockLevelReserved: number;
    stockLevelBlocked: number;
  }[];
}

// Product with stock information from GET /api/v1/merchant/products
export interface JTLProductWithStock {
  jfsku: string;
  name: string;
  merchantSku: string;
  stock?: JTLStockInfo;
  modificationInfo?: {
    createdAt: string;
    updatedAt: string;
    state: string;
  };
}

// Response format from GET /api/v1/merchant/products
interface JTLProductsWithStockResponse {
  items: JTLProductWithStock[];
  _page?: {
    total: number;
    limit: number;
    offset: number;
  };
  count?: number;
}

// Stock item from GET /api/v1/merchant/stocks endpoint
interface JTLStockItem {
  jfsku: string;
  merchantSku?: string;
  stockLevel: number;
  stockLevelReserved: number;
  stockLevelBlocked: number;
  stockLevelAnnounced: number;
  warehouses?: {
    warehouseId: string;
    fulfillerId: string;
    stockLevel: number;
    stockLevelAnnounced: number;
    stockLevelReserved: number;
    stockLevelBlocked: number;
  }[];
}

// Response format from GET /api/v1/merchant/stocks
interface JTLStocksResponse {
  items: JTLStockItem[];
  _page?: {
    total: number;
    limit: number;
    offset: number;
  };
  count?: number;
}

export class JTLService {
  private credentials: JTLCredentials;
  private baseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  // For token persistence after refresh
  private prisma?: PrismaClient;
  private internalClientId?: string;
  private logger = new Logger('JTLService');

  // JTL FFN API base URLs
  private static readonly SANDBOX_URL = 'https://ffn-sbx.api.jtl-software.com/api';
  private static readonly PRODUCTION_URL = 'https://ffn.api.jtl-software.com/api';

  // OAuth URLs (same for both sandbox and production per JTL documentation)
  private static readonly OAUTH_URL = 'https://oauth2.api.jtl-software.com';

  constructor(credentials: JTLCredentials, prisma?: PrismaClient, internalClientId?: string) {
    this.credentials = credentials;
    this.baseUrl = credentials.environment === 'production'
      ? JTLService.PRODUCTION_URL
      : JTLService.SANDBOX_URL;

    // Store prisma and clientId for token persistence
    this.prisma = prisma;
    this.internalClientId = internalClientId;

    if (credentials.accessToken) {
      this.accessToken = credentials.accessToken;
    }
    if (credentials.tokenExpiresAt) {
      this.tokenExpiresAt = credentials.tokenExpiresAt;
    }
  }

  /**
   * Get OAuth2 authorization URL for user consent
   */
  getAuthorizationUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.credentials.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'ffn.merchant.read ffn.merchant.write',
      state,
    });

    return `${JTLService.OAUTH_URL}/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code: string, redirectUri: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }> {
    // JTL requires Basic Authentication (client_id:client_secret encoded in Base64)
    const authString = `${this.credentials.clientId}:${this.credentials.clientSecret}`;
    const basicAuth = Buffer.from(authString).toString('base64');

    const response = await fetch(`${JTLService.OAUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`JTL OAuth error: ${response.status} - ${error}`);
    }

    const data = await response.json() as JTLTokenResponse;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    this.accessToken = data.access_token;
    this.tokenExpiresAt = expiresAt;
    this.credentials.refreshToken = data.refresh_token;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    };
  }

  /**
   * Refresh the access token
   */
  async refreshAccessToken(): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }> {
    if (!this.credentials.refreshToken) {
      throw new Error('No refresh token available');
    }

    // JTL requires Basic Authentication (client_id:client_secret encoded in Base64)
    const authString = `${this.credentials.clientId}:${this.credentials.clientSecret}`;
    const basicAuth = Buffer.from(authString).toString('base64');

    const response = await fetch(`${JTLService.OAUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.credentials.refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`JTL token refresh error: ${response.status} - ${error}`);
    }

    const data = await response.json() as JTLTokenResponse;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    this.accessToken = data.access_token;
    this.tokenExpiresAt = expiresAt;
    this.credentials.refreshToken = data.refresh_token;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    };
  }

  /**
   * Refresh access token and persist to database
   */
  async refreshAndPersistToken(clientId: string, prisma: PrismaClient): Promise<void> {
    const tokens = await this.refreshAccessToken();
    const encryptionService = getEncryptionService();

    await prisma.jtlConfig.update({
      where: { clientId_fk: clientId },
      data: {
        accessToken: encryptionService.encrypt(tokens.accessToken),
        refreshToken: encryptionService.encrypt(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
      },
    });
  }

  /**
   * Ensure we have a valid access token
   */
  private async ensureValidToken(): Promise<void> {
    // If token is expired or will expire in 5 minutes, refresh it
    if (this.tokenExpiresAt && new Date() >= new Date(this.tokenExpiresAt.getTime() - 5 * 60 * 1000)) {
      this.logger.debug({
        event: 'token_refresh_needed',
        expiresAt: this.tokenExpiresAt.toISOString(),
        clientId: this.internalClientId
      });

      // If we have prisma and clientId, persist the new tokens to database
      if (this.prisma && this.internalClientId) {
        const startTime = Date.now();
        await this.refreshAndPersistToken(this.internalClientId, this.prisma);

        this.logger.debug({
          event: 'token_refresh_completed',
          clientId: this.internalClientId,
          duration: Date.now() - startTime,
          persisted: true
        });
      } else {
        this.logger.warn({
          event: 'token_refresh_not_persisted',
          reason: 'no_prisma_or_clientId'
        });
        await this.refreshAccessToken();
      }
    }

    if (!this.accessToken) {
      this.logger.error({
        event: 'token_missing',
        error: 'No access token available'
      });
      throw new Error('No access token available. Please authenticate first.');
    }
  }

  /**
   * Make an authenticated request to JTL API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    jobId?: string
  ): Promise<T> {
    const requestJobId = jobId || generateJobId('jtl-req');
    const startTime = Date.now();

    await this.ensureValidToken();

    const url = `${this.baseUrl}${endpoint}`;
    const method = options.method || 'GET';

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        ...options.headers,
      },
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();

      this.logger.error({
        jobId: requestJobId,
        event: 'api_error',
        method,
        url,
        status: response.status,
        duration,
        error,
        clientId: this.internalClientId
      });

      throw new Error(`JTL API error: ${response.status} - ${error}`);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json() as T;
    return data;
  }

  // ============= OUTBOUNDS (Orders) =============

  /**
   * Create an outbound (order for fulfillment)
   * @param outbound - The outbound order details
   * @param options - Additional options for outbound creation
   * @param options.oversale - Allow outbound creation with insufficient stock (default: true)
   * @param options.autoCompleteBillOfMaterials - Auto-complete bill of materials (default: false)
   */
  async createOutbound(
    outbound: JTLOutbound,
    options: {
      oversale?: boolean;
      autoCompleteBillOfMaterials?: boolean;
    } = {}
  ): Promise<JTLOutboundResponse> {
    // Default to allowing oversale to prevent order failures due to stock issues
    const { oversale = true, autoCompleteBillOfMaterials = false } = options;

    const queryParams = new URLSearchParams();
    if (oversale) {
      queryParams.set('oversale', 'true');
    }
    if (autoCompleteBillOfMaterials) {
      queryParams.set('autoCompleteBillOfMaterials', 'true');
    }

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/outbounds${query ? `?${query}` : ''}`;

    console.log(`[JTL] Creating outbound with options: oversale=${oversale}, autoCompleteBillOfMaterials=${autoCompleteBillOfMaterials}`);
    console.log(`[JTL] Outbound payload:`, JSON.stringify(outbound, null, 2));

    return this.request<JTLOutboundResponse>(endpoint, {
      method: 'POST',
      body: JSON.stringify(outbound),
    });
  }

  /**
   * Create multiple outbounds in batch
   */
  async createOutboundsBatch(outbounds: JTLOutbound[]): Promise<SyncResult<JTLOutboundResponse[]>> {
    const results: SyncItemResult[] = [];
    const successfulOutbounds: JTLOutboundResponse[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    for (const outbound of outbounds) {
      try {
        const result = await this.createOutbound(outbound);
        successfulOutbounds.push(result);
        results.push({
          externalId: outbound.merchantOutboundNumber,
          localId: result.outboundId,
          success: true,
          action: 'created',
        });
        itemsProcessed++;
      } catch (error) {
        results.push({
          externalId: outbound.merchantOutboundNumber,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          action: 'failed',
        });
        itemsFailed++;
      }
      
      // Rate limiting delay
      await this.delay(200);
    }

    return {
      success: itemsFailed === 0,
      data: successfulOutbounds,
      syncedAt: new Date(),
      itemsProcessed,
      itemsFailed,
      details: results,
    };
  }

  /**
   * Get outbound by ID
   */
  async getOutbound(outboundId: string): Promise<JTLOutboundResponse & { items: unknown[] }> {
    return this.request(`/v1/merchant/outbounds/${outboundId}`);
  }

  /**
   * Get outbound by merchant outbound number
   */
  async getOutboundByMerchantNumber(merchantOutboundNumber: string): Promise<JTLOutboundResponse | null> {
    const outbounds = await this.getOutbounds({
      merchantOutboundNumber,
      top: 1,
    });
    return outbounds.length > 0 ? outbounds[0] : null;
  }

  /**
   * List outbounds with filters
   * JTL FFN uses OData-style parameters: $top, $skip, $filter, $orderBy
   */
  async getOutbounds(params: {
    merchantOutboundNumber?: string;
    status?: string;
    warehouseId?: string;
    top?: number;
    skip?: number;
    filter?: string;
    orderBy?: string;
  } = {}): Promise<JTLOutboundResponse[]> {
    const queryParams = new URLSearchParams();

    // Map to OData-style parameters
    if (params.top !== undefined) queryParams.set('$top', String(params.top));
    if (params.skip !== undefined) queryParams.set('$skip', String(params.skip));
    if (params.orderBy) queryParams.set('$orderBy', params.orderBy);

    // Build OData filter if specific fields provided
    const filters: string[] = [];
    if (params.merchantOutboundNumber) {
      filters.push(`merchantOutboundNumber eq '${params.merchantOutboundNumber}'`);
    }
    if (params.status) {
      filters.push(`status eq '${params.status}'`);
    }
    if (params.warehouseId) {
      filters.push(`warehouseId eq '${params.warehouseId}'`);
    }
    if (params.filter) {
      filters.push(params.filter);
    }
    if (filters.length > 0) {
      queryParams.set('$filter', filters.join(' and '));
    }

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/outbounds${query ? `?${query}` : ''}`;

    const response = await this.request<{ items?: JTLOutboundResponse[]; outbounds?: JTLOutboundResponse[]; count?: number; nextPageLink?: string }>(endpoint);
    // JTL API returns items, not outbounds (similar to products endpoint)
    const outbounds = response.items || response.outbounds || [];
    return outbounds;
  }

  /**
   * Fetch ALL outbounds with automatic pagination
   * JTL FFN default page size is 50
   */
  async getAllOutbounds(params: {
    status?: string;
    warehouseId?: string;
  } = {}): Promise<JTLOutboundResponse[]> {
    const allOutbounds: JTLOutboundResponse[] = [];
    let skip = 0;
    const top = 50; // JTL default page size
    let pageCount = 0;

    console.log(`[JTL] Starting to fetch all outbounds (50 per page)...`);

    while (true) {
      pageCount++;
      const outbounds = await this.getOutbounds({
        ...params,
        top,
        skip,
      });

      if (outbounds.length === 0) {
        break;
      }

      allOutbounds.push(...outbounds);
      console.log(`[JTL] Page ${pageCount}: Fetched ${outbounds.length} outbounds (Total: ${allOutbounds.length})`);

      if (outbounds.length < top) {
        // Last page
        break;
      }

      skip += top;
      await this.delay(200); // Rate limiting
    }

    console.log(`[JTL] Outbound fetch complete: ${allOutbounds.length} total outbounds in ${pageCount} pages`);
    return allOutbounds;
  }

  /**
   * Cancel an outbound
   */
  async cancelOutbound(outboundId: string, reason?: string): Promise<void> {
    await this.request(`/v1/merchant/outbounds/${outboundId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  /**
   * Update an existing outbound (order)
   * 
   * Note: JTL FFN has restrictions on what can be updated based on outbound status.
   * Updates are generally only allowed before the order is picked.
   * 
   * Updateable fields:
   * - externalNumber, priority (-5 to 5)
   * - shippingMethodId, desiredDeliveryDate
   * - internalNote, externalNote
   * - shippingAddress (before picking)
   */
  async updateOutbound(outboundId: string, updateData: {
    externalNumber?: string;
    priority?: number;
    shippingMethodId?: string;
    desiredDeliveryDate?: string;
    internalNote?: string;
    externalNote?: string;
    shippingAddress?: {
      name?: string;
      company?: string;
      street?: string;
      additionalAddress?: string;
      city?: string;
      zip?: string;
      countryCode?: string;
      phone?: string;
      email?: string;
    };
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(`/v1/merchant/outbounds/${outboundId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateData),
      });
      console.log(`[JTL] Updated outbound ${outboundId}`);
      return { success: true };
    } catch (error: any) {
      console.error(`[JTL] Failed to update outbound ${outboundId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get outbound status updates (polling endpoint)
   *
   * @param params.fromDate - ISO datetime string for start of timeframe
   * @param params.toDate - ISO datetime string for end of timeframe
   * @param params.page - Page number for pagination (default: 1)
   * @param params.ignoreOwnApplicationId - Filter out self-made changes
   * @param params.ignoreOwnUserId - Filter out self-made changes
   * @returns Full response with data array and pagination info
   */
  async getOutboundUpdates(params: {
    fromDate?: string;
    toDate?: string;
    page?: number;
    ignoreOwnApplicationId?: boolean;
    ignoreOwnUserId?: boolean;
  } = {}): Promise<{
    data: JTLOutboundResponse[];
    moreDataAvailable: boolean;
    nextChunkUrl?: string;
    from: string;
    to: string;
  }> {
    const queryParams = new URLSearchParams();

    // Add parameters with correct JTL API names
    if (params.fromDate) queryParams.set('fromDate', params.fromDate);
    if (params.toDate) queryParams.set('toDate', params.toDate);
    if (params.page !== undefined) queryParams.set('page', String(params.page));
    if (params.ignoreOwnApplicationId !== undefined) {
      queryParams.set('ignoreOwnApplicationId', String(params.ignoreOwnApplicationId));
    }
    if (params.ignoreOwnUserId !== undefined) {
      queryParams.set('ignoreOwnUserId', String(params.ignoreOwnUserId));
    }

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/outbounds/updates${query ? `?${query}` : ''}`;

    const response = await this.request<{
      nextChunkUrl?: string;
      from: string;
      to: string;
      data: JTLOutboundResponse[];
      moreDataAvailable: boolean;
    }>(endpoint);

    // Return the full response so caller can handle pagination
    return {
      data: response.data || [],
      moreDataAvailable: response.moreDataAvailable || false,
      nextChunkUrl: response.nextChunkUrl,
      from: response.from,
      to: response.to,
    };
  }

  // ============= PRODUCTS =============

  /**
   * Create or update a product
   */
  async createProduct(product: JTLProduct): Promise<JTLProductResponse> {
    console.log('[JTL] Creating product with payload:', JSON.stringify(product, null, 2));
    return this.request<JTLProductResponse>('/v1/merchant/products', {
      method: 'POST',
      body: JSON.stringify(product),
    });
  }

  /**
   * Create or update multiple products in batch
   */
  async createProductsBatch(products: JTLProduct[]): Promise<SyncResult<JTLProductResponse[]>> {
    const results: SyncItemResult[] = [];
    const successfulProducts: JTLProductResponse[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    for (const product of products) {
      try {
        const result = await this.createProduct(product);
        successfulProducts.push(result);
        results.push({
          externalId: product.merchantSku,
          localId: result.jfsku,
          success: true,
          action: 'created',
        });
        itemsProcessed++;
      } catch (error) {
        results.push({
          externalId: product.merchantSku,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          action: 'failed',
        });
        itemsFailed++;
      }
      
      await this.delay(200);
    }

    return {
      success: itemsFailed === 0,
      data: successfulProducts,
      syncedAt: new Date(),
      itemsProcessed,
      itemsFailed,
      details: results,
    };
  }

  /**
   * Get product by JFSKU
   */
  async getProduct(jfsku: string): Promise<JTLProductResponse & { 
    gtin?: string;
    stockInfo?: { available: number; reserved: number };
  }> {
    return this.request(`/v1/merchant/products/${jfsku}`);
  }

  /**
   * Get product by merchant SKU
   * Note: JTL API doesn't properly filter by merchantSku in query params,
   * so we fetch all products with pagination and filter client-side
   * Uses OData-style parameters: $top, $skip
   */
  async getProductByMerchantSku(merchantSku: string): Promise<JTLProductResponse | null> {
    let skip = 0;
    const top = 50; // JTL default page size
    let totalChecked = 0;
    let totalCount: number | undefined;

    console.log(`[JTL] Searching for product with merchantSku: ${merchantSku}`);

    while (true) {
      const queryParams = new URLSearchParams();
      queryParams.set('$top', String(top));
      queryParams.set('$skip', String(skip));

      const query = queryParams.toString();
      const endpoint = `/v1/merchant/products?${query}`;

      const response = await this.request<{ items: JTLProductResponse[]; count?: number }>(endpoint);
      const products = response.items || [];

      // Track total count from first response
      if (totalCount === undefined && response.count !== undefined) {
        totalCount = response.count;
        console.log(`[JTL] Total products in JTL: ${totalCount}`);
      }

      if (products.length === 0) {
        console.log(`[JTL] No more products to check. Total checked: ${totalChecked}`);
        break;
      }

      totalChecked += products.length;

      // Filter client-side since JTL API returns all products regardless of merchantSku filter
      const matchingProduct = products.find(p => p.merchantSku === merchantSku);

      if (matchingProduct) {
        console.log(`[JTL] Found matching product for merchantSku ${merchantSku}: jfsku=${matchingProduct.jfsku} (checked ${totalChecked} products)`);
        return matchingProduct;
      }

      console.log(`[JTL] Page ${Math.floor(skip / top) + 1}: Checked ${products.length} products, no match yet (total: ${totalChecked})`);

      // If we got fewer products than the limit, we've reached the end
      if (products.length < top) {
        break;
      }

      skip += top;

      // Rate limiting delay
      await this.delay(200);
    }

    console.log(`[JTL] No product found with merchantSku ${merchantSku} (checked ${totalChecked} of ${totalCount || 'unknown'} total products)`);
    return null;
  }

  /**
   * List products with filters
   */
  async getProducts(params: {
    merchantSku?: string;
    gtin?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<JTLProductResponse[]> {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.set(key, String(value));
      }
    });

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/products${query ? `?${query}` : ''}`;

    const response = await this.request<{ items: JTLProductResponse[]; count?: number }>(endpoint);
    return response.items || [];
  }

  /**
   * Get stock levels for products (legacy method - may not work for merchants)
   */
  async getStockLevels(params: {
    jfsku?: string;
    warehouseId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ jfsku: string; available: number; reserved: number; warehouseId: string }[]> {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.set(key, String(value));
      }
    });

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/stock${query ? `?${query}` : ''}`;
    
    const response = await this.request<{ stockLevels: { jfsku: string; available: number; reserved: number; warehouseId: string }[] }>(endpoint);
    return response.stockLevels || [];
  }

  /**
   * Get all products with stock information using Products API
   * This is the proper way for merchants to get stock levels
   * 
   * API: GET /api/v1/merchant/stocks
   * Uses the dedicated stocks endpoint which returns stock per product
   * 
   * Returns: Stock info with jfsku, merchantSku, stockLevel, stockLevelReserved, etc.
   */
  async getProductsWithStock(params: {
    top?: number;
    skip?: number;
    filter?: string;
    orderBy?: string;
  } = {}): Promise<JTLProductWithStock[]> {
    const queryParams = new URLSearchParams();
    
    // Use JTL's OData-style parameters
    if (params.top !== undefined) queryParams.set('$top', String(params.top));
    if (params.skip !== undefined) queryParams.set('$skip', String(params.skip));
    if (params.orderBy) queryParams.set('$orderBy', params.orderBy);
    
    // Add filter if provided
    if (params.filter) queryParams.set('$filter', params.filter);

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/stocks${query ? `?${query}` : ''}`;
    
    const response = await this.request<JTLStocksResponse>(endpoint);
    
    // Transform the stocks response to our expected format
    return (response.items || []).map(stockItem => ({
      jfsku: stockItem.jfsku,
      merchantSku: stockItem.merchantSku || '',
      name: '', // Not available from stocks endpoint, will need to lookup from products if needed
      stock: {
        stockLevel: stockItem.stockLevel || 0,
        stockLevelReserved: stockItem.stockLevelReserved || 0,
        stockLevelAnnounced: stockItem.stockLevelAnnounced || 0,
        stockLevelBlocked: stockItem.stockLevelBlocked || 0,
      },
    }));
  }

  /**
   * Get all products with stock, handling pagination automatically
   * Fetches all pages and returns combined results
   */
  async getAllProductsWithStock(params: {
    batchSize?: number;
  } = {}): Promise<JTLProductWithStock[]> {
    const batchSize = params.batchSize || 100;
    const allProducts: JTLProductWithStock[] = [];
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
      const products = await this.getProductsWithStock({
        top: batchSize,
        skip,
      });

      allProducts.push(...products);

      if (products.length < batchSize) {
        hasMore = false;
      } else {
        skip += batchSize;
        // Add delay to avoid rate limiting
        await this.delay(200);
      }
    }

    console.log(`[JTL] Fetched ${allProducts.length} products with stock levels`);
    return allProducts;
  }

  /**
   * Update an existing product
   * 
   * Updateable fields:
   * - name, description, productGroup
   * - originCountry, customsCode, netWeight
   * - Dimensions (length, width, height in meters)
   * - identifier fields (ean, mpn, isbn, asin, han)
   */
  async updateProduct(jfsku: string, updateData: {
    name?: string;
    description?: string;
    productGroup?: string;
    originCountry?: string;
    customsCode?: string;
    netWeight?: number;
    length?: number;
    width?: number;
    height?: number;
    identifier?: {
      ean?: string;
      mpn?: string;
      isbn?: string;
      asin?: string;
      han?: string;
    };
    specifications?: {
      billOfMaterialsComponents?: Array<{
        jfsku?: string;
        merchantSku?: string;
        quantity: number;
      }>;
    };
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(`/v1/merchant/products/${jfsku}`, {
        method: 'PATCH',
        body: JSON.stringify(updateData),
      });
      console.log(`[JTL] Updated product ${jfsku}`);
      return { success: true };
    } catch (error: any) {
      console.error(`[JTL] Failed to update product ${jfsku}:`, error);
      return { success: false, error: error.message };
    }
  }

  // ============= INBOUNDS (Stock Deliveries) =============

  /**
   * Create an inbound (stock delivery announcement)
   */
  async createInbound(inbound: JTLInbound): Promise<JTLInboundResponse> {
    return this.request<JTLInboundResponse>('/v1/merchant/inbounds', {
      method: 'POST',
      body: JSON.stringify(inbound),
    });
  }

  /**
   * Get inbound by ID
   */
  async getInbound(inboundId: string): Promise<JTLInboundResponse & { items: unknown[] }> {
    return this.request(`/v1/merchant/inbounds/${inboundId}`);
  }

  /**
   * List inbounds with filters
   */
  async getInbounds(params: {
    merchantInboundNumber?: string;
    status?: string;
    warehouseId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<JTLInboundResponse[]> {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.set(key, String(value));
      }
    });

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/inbounds${query ? `?${query}` : ''}`;
    
    const response = await this.request<{ inbounds: JTLInboundResponse[] }>(endpoint);
    return response.inbounds || [];
  }

  /**
   * Cancel an inbound
   */
  async cancelInbound(inboundId: string, reason?: string): Promise<void> {
    await this.request(`/v1/merchant/inbounds/${inboundId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  }

  /**
   * Get inbound updates (polling endpoint)
   */
  async getInboundUpdates(params: {
    since?: string;
    limit?: number;
  } = {}): Promise<JTLUpdateItem<JTLInboundResponse>[]> {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.set(key, String(value));
      }
    });

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/inbounds/updates${query ? `?${query}` : ''}`;
    
    const response = await this.request<{ updates: JTLUpdateItem<JTLInboundResponse>[] }>(endpoint);
    return response.updates || [];
  }

  // ============= RETURNS =============

  /**
   * Announce a return
   */
  async createReturn(returnData: JTLReturn): Promise<JTLReturnResponse> {
    return this.request<JTLReturnResponse>('/v1/merchant/returns', {
      method: 'POST',
      body: JSON.stringify(returnData),
    });
  }

  /**
   * Create multiple returns in batch
   */
  async createReturnsBatch(returns: JTLReturn[]): Promise<SyncResult<JTLReturnResponse[]>> {
    const results: SyncItemResult[] = [];
    const successfulReturns: JTLReturnResponse[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    for (const returnData of returns) {
      try {
        const result = await this.createReturn(returnData);
        successfulReturns.push(result);
        results.push({
          externalId: returnData.merchantReturnNumber,
          localId: result.returnId,
          success: true,
          action: 'created',
        });
        itemsProcessed++;
      } catch (error) {
        results.push({
          externalId: returnData.merchantReturnNumber,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          action: 'failed',
        });
        itemsFailed++;
      }
      
      await this.delay(200);
    }

    return {
      success: itemsFailed === 0,
      data: successfulReturns,
      syncedAt: new Date(),
      itemsProcessed,
      itemsFailed,
      details: results,
    };
  }

  /**
   * Get return by ID
   */
  async getReturn(returnId: string): Promise<JTLReturnResponse & { items: unknown[] }> {
    return this.request(`/v1/merchant/returns/${returnId}`);
  }

  /**
   * List returns with filters
   */
  async getReturns(params: {
    merchantReturnNumber?: string;
    status?: string;
    warehouseId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<JTLReturnResponse[]> {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.set(key, String(value));
      }
    });

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/returns${query ? `?${query}` : ''}`;
    
    const response = await this.request<{ returns: JTLReturnResponse[] }>(endpoint);
    return response.returns || [];
  }

  /**
   * Get return updates (polling endpoint)
   */
  async getReturnUpdates(params: {
    since?: string;
    limit?: number;
  } = {}): Promise<JTLUpdateItem<JTLReturnResponse>[]> {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.set(key, String(value));
      }
    });

    const query = queryParams.toString();
    const endpoint = `/v1/merchant/returns/updates${query ? `?${query}` : ''}`;
    
    const response = await this.request<{ updates: JTLUpdateItem<JTLReturnResponse>[] }>(endpoint);
    return response.updates || [];
  }

  /**
   * Update an existing return
   * 
   * Updateable fields:
   * - status, expectedArrival
   * - internalNote, externalNote
   * - contact information
   * 
   * Note: Some fields may require objectVersion for optimistic locking
   */
  async updateReturn(returnId: string, updateData: {
    status?: string;
    expectedArrival?: string;
    internalNote?: string;
    externalNote?: string;
    contact?: {
      name?: string;
      email?: string;
      phone?: string;
    };
    objectVersion?: number;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(`/v1/merchant/returns/${returnId}`, {
        method: 'PATCH',
        body: JSON.stringify(updateData),
      });
      console.log(`[JTL] Updated return ${returnId}`);
      return { success: true };
    } catch (error: any) {
      console.error(`[JTL] Failed to update return ${returnId}:`, error);
      return { success: false, error: error.message };
    }
  }

  // ============= FULFILLERS & WAREHOUSES =============

  /**
   * Get list of available fulfillers
   */
  async getFulfillers(): Promise<{ fulfillerId: string; name: string; warehouses: { warehouseId: string; name: string }[] }[]> {
    const response = await this.request<{ fulfillers: { fulfillerId: string; name: string; warehouses: { warehouseId: string; name: string }[] }[] }>('/v1/merchant/fulfillers');
    return response.fulfillers || [];
  }

  /**
   * Get list of available warehouses
   */
  async getWarehouses(): Promise<{ warehouseId: string; name: string; fulfillerId: string }[]> {
    const fulfillers = await this.getFulfillers();
    const warehouses: { warehouseId: string; name: string; fulfillerId: string }[] = [];
    
    for (const fulfiller of fulfillers) {
      for (const warehouse of fulfiller.warehouses) {
        warehouses.push({
          ...warehouse,
          fulfillerId: fulfiller.fulfillerId,
        });
      }
    }
    
    return warehouses;
  }

  // ============= SHIPPING METHODS =============

  /**
   * Get all available shipping methods from JTL FFN
   * 
   * Response includes:
   * - shippingMethodId: Unique ID (e.g., "FULF0A0001")
   * - fulfillerId: Fulfiller ID (e.g., "FULF")
   * - name: Human-readable name (e.g., "DHL package")
   * - carrierCode: Carrier code
   * - carrierName: Carrier name (e.g., "DHL")
   * - shippingType: Type (Standard, Expedited, NextDay, SecondDay, SameDay)
   * - trackingUrlSchema: URL pattern for tracking
   * - cutoffTime: Latest time for same-day shipping
   */
  async getShippingMethods(params: {
    fulfillerId?: string;
    shippingType?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{
    success: boolean;
    data?: Array<{
      shippingMethodId: string;
      fulfillerId: string;
      name: string;
      carrierCode?: string;
      carrierName?: string;
      shippingType: string;
      trackingUrlSchema?: string;
      cutoffTime?: string;
      note?: string;
    }>;
    error?: string;
  }> {
    try {
      console.log('[JTL] getShippingMethods called with params:', JSON.stringify(params));
      await this.ensureValidToken();

      const queryParams = new URLSearchParams();

      // Build OData filter if needed
      const filters: string[] = [];
      if (params.fulfillerId) {
        filters.push(`fulfillerId eq '${params.fulfillerId}'`);
      }
      if (params.shippingType) {
        filters.push(`shippingType eq '${params.shippingType}'`);
      }

      if (filters.length > 0) {
        queryParams.set('$filter', filters.join(' and '));
      }

      if (params.limit) {
        queryParams.set('$top', String(params.limit));
      }
      if (params.offset) {
        queryParams.set('$skip', String(params.offset));
      }

      const query = queryParams.toString();
      const endpoint = `/v1/merchant/shippingmethods${query ? `?${query}` : ''}`;

      console.log(`[JTL] Fetching shipping methods from endpoint: ${endpoint}`);
      console.log(`[JTL] Using base URL: ${this.baseUrl}`);

      const response = await this.request<{
        shippingMethods: Array<{
          shippingMethodId: string;
          fulfillerId: string;
          name: string;
          carrierCode?: string;
          carrierName?: string;
          shippingType: string;
          trackingUrlSchema?: string;
          cutoffTime?: string;
          note?: string;
        }>;
      }>(endpoint);

      console.log(`[JTL] Raw API response:`, JSON.stringify(response, null, 2));

      // JTL FFN API might return data in different formats:
      // 1. { shippingMethods: [...] }
      // 2. { items: [...] }
      // 3. { value: [...] } (OData format)
      // 4. Direct array [...]
      let methods: Array<{
        shippingMethodId: string;
        fulfillerId: string;
        name: string;
        carrierCode?: string;
        carrierName?: string;
        shippingType: string;
        trackingUrlSchema?: string;
        cutoffTime?: string;
        note?: string;
      }> = [];

      if (Array.isArray(response)) {
        console.log('[JTL] Response is direct array');
        methods = response;
      } else if (response.shippingMethods) {
        console.log('[JTL] Response has shippingMethods key');
        methods = response.shippingMethods;
      } else if ((response as any).items) {
        console.log('[JTL] Response has items key');
        methods = (response as any).items;
      } else if ((response as any).value) {
        console.log('[JTL] Response has value key (OData format)');
        methods = (response as any).value;
      } else {
        console.log('[JTL] Unknown response format, available keys:', Object.keys(response));
      }

      console.log(`[JTL] Fetched ${methods.length} shipping methods`);
      return { success: true, data: methods };
    } catch (error: any) {
      console.error('[JTL] Failed to fetch shipping methods:', error);
      console.error('[JTL] Error stack:', error.stack);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get a specific shipping method by ID
   */
  async getShippingMethod(shippingMethodId: string): Promise<{
    success: boolean;
    data?: {
      shippingMethodId: string;
      fulfillerId: string;
      name: string;
      carrierCode?: string;
      carrierName?: string;
      shippingType: string;
      trackingUrlSchema?: string;
      cutoffTime?: string;
      note?: string;
    };
    error?: string;
  }> {
    try {
      await this.ensureValidToken();
      
      const response = await this.request<{
        shippingMethodId: string;
        fulfillerId: string;
        name: string;
        carrierCode?: string;
        carrierName?: string;
        shippingType: string;
        trackingUrlSchema?: string;
        cutoffTime?: string;
        note?: string;
      }>(`/v1/merchant/shippingmethods/${shippingMethodId}`);
      
      return { success: true, data: response };
    } catch (error: any) {
      console.error(`[JTL] Failed to fetch shipping method ${shippingMethodId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get shipping method updates (polling endpoint)
   */
  async getShippingMethodUpdates(params: {
    since?: string;
    limit?: number;
  } = {}): Promise<{
    success: boolean;
    data?: JTLUpdateItem<{
      shippingMethodId: string;
      fulfillerId: string;
      name: string;
      shippingType: string;
    }>[];
    error?: string;
  }> {
    try {
      await this.ensureValidToken();
      
      const queryParams = new URLSearchParams();
      if (params.since) {
        queryParams.set('since', params.since);
      }
      if (params.limit) {
        queryParams.set('$top', String(params.limit));
      }

      const query = queryParams.toString();
      const endpoint = `/v1/merchant/shippingmethods/updates${query ? `?${query}` : ''}`;
      
      const response = await this.request<{
        updates: JTLUpdateItem<{
          shippingMethodId: string;
          fulfillerId: string;
          name: string;
          shippingType: string;
        }>[];
      }>(endpoint);
      
      return { success: true, data: response.updates || [] };
    } catch (error: any) {
      console.error('[JTL] Failed to fetch shipping method updates:', error);
      return { success: false, error: error.message };
    }
  }

  // ============= FULFILLMENT OPERATIONS =============

  /**
   * Get fulfillment statistics from outbounds
   * Aggregates outbound status counts for dashboard
   */
  async getFulfillmentStats(): Promise<{
    total: number;
    pending: number;
    processing: number;
    shipped: number;
    delivered: number;
    cancelled: number;
  }> {
    try {
      // Get all outbounds and aggregate by status
      const outbounds = await this.getAllOutbounds();

      const stats = {
        total: outbounds.length,
        pending: 0,
        processing: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0,
      };

      for (const outbound of outbounds) {
        const status = outbound.status.toLowerCase();
        if (status === 'new' || status === 'pending') {
          stats.pending++;
        } else if (status === 'processing' || status === 'picking' || status === 'packing') {
          stats.processing++;
        } else if (status === 'shipped') {
          stats.shipped++;
        } else if (status === 'delivered') {
          stats.delivered++;
        } else if (status === 'cancelled') {
          stats.cancelled++;
        }
      }

      return stats;
    } catch (error) {
      console.error('[JTL] Failed to get fulfillment stats:', error);
      return {
        total: 0,
        pending: 0,
        processing: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0,
      };
    }
  }

  /**
   * Hold an outbound by setting low priority
   * JTL FFN doesn't have explicit hold, so we use priority -5 and internal notes
   *
   * @param outboundId - JTL FFN outbound ID
   * @param reason - Hold reason
   * @param notes - Additional notes
   */
  async holdOutbound(outboundId: string, reason: string, notes?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const internalNote = `HOLD: ${reason}${notes ? ` - ${notes}` : ''}`;

      await this.updateOutbound(outboundId, {
        priority: -5,  // Lowest priority
        internalNote,
      });

      console.log(`[JTL] Held outbound ${outboundId}: ${reason}`);
      return { success: true };
    } catch (error: any) {
      console.error(`[JTL] Failed to hold outbound ${outboundId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Release an outbound from hold by restoring normal priority
   *
   * @param outboundId - JTL FFN outbound ID
   * @param priority - Priority to restore (default: 0)
   */
  async releaseOutbound(outboundId: string, priority: number = 0): Promise<{ success: boolean; error?: string }> {
    try {
      await this.updateOutbound(outboundId, {
        priority,
        internalNote: 'Hold released - ready for processing',
      });

      console.log(`[JTL] Released outbound ${outboundId} with priority ${priority}`);
      return { success: true };
    } catch (error: any) {
      console.error(`[JTL] Failed to release outbound ${outboundId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Add shipping notification (tracking) to outbound
   * Used when tracking information becomes available
   *
   * @param outboundId - JTL FFN outbound ID
   * @param trackingInfo - Tracking information
   */
  async addShippingNotification(outboundId: string, trackingInfo: {
    trackingNumber: string;
    carrierCode: string;
    carrierName?: string;
    shippedAt?: string;
    trackingUrl?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      // JTL FFN shipping notifications are typically created by the warehouse
      // This endpoint allows manual tracking updates if supported
      await this.request(`/v1/merchant/outbounds/${outboundId}/shipping-notifications`, {
        method: 'POST',
        body: JSON.stringify({
          trackingNumber: trackingInfo.trackingNumber,
          carrierCode: trackingInfo.carrierCode,
          carrierName: trackingInfo.carrierName,
          shippedAt: trackingInfo.shippedAt || new Date().toISOString(),
        }),
      });

      console.log(`[JTL] Added shipping notification to outbound ${outboundId}`);
      return { success: true };
    } catch (error: any) {
      // Some JTL FFN setups may not support manual shipping notifications
      console.error(`[JTL] Failed to add shipping notification to ${outboundId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get shipping notifications for an outbound (includes tracking info)
   * API: GET /api/v1/merchant/outbounds/{outboundId}/shipping-notifications
   *
   * @param outboundId - JTL FFN outbound ID
   */
  async getShippingNotifications(outboundId: string): Promise<{
    success: boolean;
    data?: {
      packages: Array<{
        freightOption: string;
        estimatedDeliveryDate?: string;
        trackingUrl?: string;
        identifier: Array<{
          value: string;
          identifierType: string;
          name?: string;
        }>;
      }>;
    };
    error?: string;
  }> {
    try {
      // JTL API returns an array of shipping notifications, each containing a packages array
      // Response format: [{ outboundId, packages: [{ freightOption, trackingUrl, identifier: [...] }], ... }]
      const response = await this.request<Array<{
        outboundId?: string;
        fulfillerId?: string;
        fulfillerShippingNotificationNumber?: string;
        merchantOutboundNumber?: string;
        outboundShippingNotificationId?: string;
        outboundStatus?: string;
        note?: string;
        items?: Array<any>;
        packages?: Array<{
          freightOption: string;
          estimatedDeliveryDate?: string;
          trackingUrl?: string;
          identifier: Array<{
            value: string;
            identifierType: string;
            name?: string;
          }>;
        }>;
      }>>(`/v1/merchant/outbounds/${outboundId}/shipping-notifications`);

      // Extract packages from all shipping notifications and flatten into a single array
      const notifications = Array.isArray(response) ? response : [];
      console.log(`[JTL] Shipping notifications for ${outboundId}: ${notifications.length} notifications`);

      // Log the raw response structure for debugging
      if (notifications.length > 0) {
        console.log(`[JTL] First notification keys:`, Object.keys(notifications[0]));
        console.log(`[JTL] First notification packages:`, notifications[0].packages);
      }

      // Flatten packages from all notifications
      const packages = notifications.flatMap(notification => notification.packages || []);
      console.log(`[JTL] Total packages extracted: ${packages.length}`);

      return { success: true, data: { packages } };
    } catch (error: any) {
      // 404 means no shipping notification yet (not shipped)
      if (error.message?.includes('404') || error.message?.includes('Not Found')) {
        return { success: true, data: { packages: [] } };
      }
      console.error(`[JTL] Failed to get shipping notifications for ${outboundId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract tracking info from shipping notifications response
   * Returns the first tracking number and URL found
   */
  extractTrackingInfo(shippingNotifications: {
    packages: Array<{
      freightOption: string;
      estimatedDeliveryDate?: string;
      trackingUrl?: string;
      identifier: Array<{
        value: string;
        identifierType: string;
        name?: string;
      }>;
    }>;
  }): {
    trackingNumber?: string;
    trackingUrl?: string;
    carrier?: string;
  } {
    const firstPackage = shippingNotifications.packages?.[0];
    if (!firstPackage) {
      console.log(`[JTL] extractTrackingInfo: No packages found`);
      return {};
    }

    console.log(`[JTL] extractTrackingInfo: Package found with identifiers:`, firstPackage.identifier);

    const trackingId = firstPackage.identifier?.find(
      id => id.identifierType === 'TrackingId'
    );

    const result = {
      trackingNumber: trackingId?.value,
      trackingUrl: firstPackage.trackingUrl,
      carrier: firstPackage.freightOption,
    };

    console.log(`[JTL] extractTrackingInfo result:`, result);
    return result;
  }

  /**
   * Extract ALL tracking info from shipping notifications (multi-package support)
   * Returns an array of all packages with tracking numbers instead of just the first
   */
  extractAllTrackingInfo(shippingNotifications: {
    packages: Array<{
      freightOption: string;
      estimatedDeliveryDate?: string;
      trackingUrl?: string;
      identifier: Array<{
        value: string;
        identifierType: string;
        name?: string;
      }>;
    }>;
  }): Array<{
    trackingNumber?: string;
    trackingUrl?: string;
    carrier?: string;
  }> {
    if (!shippingNotifications.packages?.length) {
      console.log(`[JTL] extractAllTrackingInfo: No packages found`);
      return [];
    }

    const results = shippingNotifications.packages.map(pkg => {
      const trackingId = pkg.identifier?.find(
        id => id.identifierType === 'TrackingId'
      );

      return {
        trackingNumber: trackingId?.value,
        trackingUrl: pkg.trackingUrl,
        carrier: pkg.freightOption,
      };
    }).filter(pkg => pkg.trackingNumber); // Only include packages with tracking numbers

    console.log(`[JTL] extractAllTrackingInfo: Found ${results.length} packages with tracking`);
    return results;
  }

  /**
   * Poll for outbound status changes since last check
   * Returns outbounds that have been updated
   *
   * @param since - ISO timestamp to poll from
   */
  async pollOutboundChanges(since: string): Promise<{
    success: boolean;
    updates?: Array<{
      outboundId: string;
      merchantOutboundNumber: string;
      previousStatus?: string;
      currentStatus: string;
      updatedAt: string;
      shippingInfo?: {
        trackingNumber?: string;
        carrier?: string;
        shippedAt?: string;
      };
    }>;
    error?: string;
  }> {
    try {
      const response = await this.getOutboundUpdates({
        fromDate: since,
        toDate: new Date(Date.now() - 5000).toISOString(), // Subtract 5s to avoid clock sync issues
        page: 1
      });

      const processedUpdates = response.data.map((update) => ({
        outboundId: update.outboundId,
        merchantOutboundNumber: update.merchantOutboundNumber,
        currentStatus: update.status,
        updatedAt: update.createdAt || new Date().toISOString(),
      }));

      console.log(`[JTL] Polled ${processedUpdates.length} outbound updates since ${since}`);
      return { success: true, updates: processedUpdates };
    } catch (error: any) {
      console.error('[JTL] Failed to poll outbound changes:', error);
      return { success: false, error: error.message };
    }
  }

  // ============= HELPERS =============

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test connection to JTL API
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.ensureValidToken();
      const fulfillers = await this.getFulfillers();
      return {
        success: true,
        message: `Connected to JTL FFN. Found ${fulfillers.length} fulfillers.`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  // ============= ORDER SYNC WRAPPER METHODS =============

  /**
   * Sync order to JTL-FFN (create outbound)
   * Wrapper method for OrderSyncService
   *
   * @param orderId - The order ID to sync
   * @param prisma - PrismaClient instance for database access
   * @returns The created outbound ID
   */
  async syncOrderToFfn(orderId: string, prisma: PrismaClient, options?: { force?: boolean }): Promise<{
    success: boolean;
    outboundId?: string;
    error?: string;
    alreadyExisted?: boolean;
  }> {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: { include: { product: true } },
          client: true,
        },
      });

      if (!order) {
        return { success: false, error: `Order ${orderId} not found` };
      }

      // Don't sync cancelled orders
      if (order.isCancelled) {
        console.log(`[JTL] Skipping cancelled order ${orderId}`);
        return { success: true };
      }

      // Don't sync unpaid orders — block orders on payment hold or with unpaid status
      // When force=true (manual sync from UI), skip payment checks entirely
      if (options?.force) {
        console.log(`[JTL] Payment guard bypassed for order ${orderId} — manual sync (force=true, paymentStatus: "${order.paymentStatus || 'unknown'}")`);
      } else {
        const FFN_ALLOWED_PAYMENT_STATUSES = [
          'paid', 'completed', 'processing', 'refunded',
          'partially_refunded', 'authorized', 'partially_paid',
        ];

        if (order.isOnHold && order.holdReason === 'AWAITING_PAYMENT') {
          console.log(`[JTL] Blocking order ${orderId} — on payment hold (AWAITING_PAYMENT)`);
          return { success: false, error: `Order ${orderId} is on payment hold — cannot sync to FFN` };
        }

        const paymentStatus = (order.paymentStatus || '').toLowerCase();
        if (!paymentStatus || !FFN_ALLOWED_PAYMENT_STATUSES.includes(paymentStatus)) {
          if (order.paymentHoldOverride) {
            console.log(`[JTL] Payment guard bypassed for order ${orderId} — manual override (paymentStatus: "${order.paymentStatus}")`);
          } else {
            console.log(`[JTL] Blocking order ${orderId} — payment status "${order.paymentStatus || 'unknown'}" not in allowed list`);
            return { success: false, error: `Order ${orderId} has payment status "${order.paymentStatus || 'unknown'}" — cannot sync to FFN until paid` };
          }
        }
      }

      // Check if already synced locally
      if (order.jtlOutboundId) {
        console.log(`[JTL] Order ${orderId} already synced as outbound ${order.jtlOutboundId}`);
        return { success: true, outboundId: order.jtlOutboundId };
      }

      // Check if order already exists in FFN (by querying FFN directly)
      console.log(`[JTL-FFN-SYNC] Checking if order ${orderId} exists in FFN...`);
      const merchantOutboundNumber = order.orderNumber || order.orderId;
      const existingOutbound = await this.getOutboundByMerchantNumber(merchantOutboundNumber);
      if (existingOutbound) {
        // Order exists in FFN but not in our DB - sync the ID back
        console.log(`[JTL-FFN-SYNC] Order already exists in FFN as outbound ${existingOutbound.outboundId} - syncing ID back`);
        await prisma.order.update({
          where: { id: orderId },
          data: {
            jtlOutboundId: existingOutbound.outboundId,
            lastJtlSync: new Date(),
            syncStatus: 'SYNCED',
          },
        });

        // Log the sync
        await prisma.orderSyncLog.create({
          data: {
            orderId,
            action: 'update',
            origin: 'NOLIMITS',
            targetPlatform: 'jtl',
            success: true,
            externalId: existingOutbound.outboundId,
            changedFields: ['jtlOutboundId', 'lastJtlSync'],
          },
        });

        return {
          success: true,
          outboundId: existingOutbound.outboundId,
          alreadyExisted: true,
        };
      }
      console.log(`[JTL-FFN-SYNC] Order not in FFN, creating new outbound...`);
      console.log(`[JTL-FFN-SYNC] Using credentials - warehouseId: ${this.credentials.warehouseId}, fulfillerId: ${this.credentials.fulfillerId}`);

      // Validate required credentials before creating outbound
      if (!this.credentials.warehouseId) {
        return {
          success: false,
          error: 'JTL warehouseId not configured. Please set up the warehouse ID in JTL integration settings.',
        };
      }

      // Transform order to JTL outbound format
      const outbound = this.transformOrderToOutbound(order);

      // Check if any items are BOM products (bundles)
      const hasBOMItems = order.items.some((item: any) => item.product?.isBundle);

      // Create outbound in JTL-FFN
      const result = await this.createOutbound(outbound, {
        oversale: true,
        autoCompleteBillOfMaterials: hasBOMItems,
      });

      // Update order with JTL IDs
      await prisma.order.update({
        where: { id: orderId },
        data: {
          jtlOutboundId: result.outboundId,
          lastJtlSync: new Date(),
          syncStatus: 'SYNCED',
          fulfillmentState: 'PENDING',
        },
      });

      // Log sync
      await prisma.orderSyncLog.create({
        data: {
          orderId,
          action: 'create',
          origin: 'NOLIMITS',
          targetPlatform: 'jtl',
          success: true,
          externalId: result.outboundId,
          changedFields: ['jtlOutboundId', 'lastJtlSync'],
        },
      });

      console.log(`[JTL] Order ${orderId} synced to FFN as outbound ${result.outboundId}`);
      return { success: true, outboundId: result.outboundId };
    } catch (error: any) {
      console.error(`[JTL] Failed to sync order ${orderId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update operational fields for existing outbound order
   * Wrapper method for OrderSyncService
   * 
   * Note: JTL-FFN has limited update capabilities for outbounds after creation.
   * Supported updates:
   * - Priority level changes
   * - Shipping address corrections (before picking starts)
   * - Carrier/service level changes (before shipping)
   * - Notes and instructions
   * 
   * @param orderId - The order ID to update
   * @param changedFields - List of fields that changed
   * @param prisma - PrismaClient instance for database access
   */
  async updateOrderOperationalFields(
    orderId: string, 
    changedFields: string[],
    prisma: PrismaClient
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: { include: { product: true } },
        },
      });

      if (!order) {
        return { success: false, error: `Order ${orderId} not found` };
      }

      // If order hasn't been synced to FFN yet, nothing to update
      if (!order.jtlOutboundId) {
        console.log(`[JTL] Order ${orderId} not yet synced to FFN, skipping update`);
        return { success: true };
      }

      // Check current FFN status to determine what can be updated
      const currentOutbound = await this.getOutbound(order.jtlOutboundId);
      const ffnStatus = currentOutbound.status.toUpperCase();

      // After certain statuses, updates are not possible
      const nonUpdateableStatuses = ['SHIPPED', 'DELIVERED', 'CANCELLED'];
      if (nonUpdateableStatuses.includes(ffnStatus)) {
        console.log(`[JTL] Order ${orderId} is in status ${ffnStatus}, cannot update`);
        return { 
          success: false, 
          error: `Cannot update order in status ${ffnStatus}` 
        };
      }

      // Build update payload based on changed fields
      // JTL-FFN may not have a direct update endpoint, so we log and track
      const updateableFields = [
        'warehouseNotes',
        'carrierSelection', 
        'carrierServiceLevel',
        'priorityLevel',
        'pickingInstructions',
        'packingInstructions',
        'shippingAddress1',
        'shippingAddress2',
        'shippingCity',
        'shippingZip',
        'shippingCountryCode',
      ];

      const fieldsToSync = changedFields.filter(f => updateableFields.includes(f));
      
      if (fieldsToSync.length === 0) {
        console.log(`[JTL] No updateable operational fields changed for order ${orderId}`);
        return { success: true };
      }

      // Log the operational update
      console.log(`[JTL] Operational update for order ${orderId}: ${fieldsToSync.join(', ')}`);

      // For address corrections before picking, JTL-FFN may support updates
      // For now, log and track - the actual API call depends on JTL capabilities
      await prisma.orderSyncLog.create({
        data: {
          orderId,
          action: 'update',
          origin: 'NOLIMITS',
          targetPlatform: 'jtl',
          success: true,
          changedFields: fieldsToSync,
        },
      });

      await prisma.order.update({
        where: { id: orderId },
        data: {
          lastJtlSync: new Date(),
          lastOperationalUpdateBy: 'NOLIMITS',
          lastOperationalUpdateAt: new Date(),
        },
      });

      return { success: true };
    } catch (error: any) {
      console.error(`[JTL] Failed to update order ${orderId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel order in JTL-FFN
   * Wrapper method for OrderSyncService
   * 
   * @param orderId - The order ID to cancel
   * @param prisma - PrismaClient instance for database access
   * @param reason - Optional cancellation reason
   * @param restockItems - Whether to restock items (default: true)
   */
  async cancelOrderInFfn(
    orderId: string, 
    prisma: PrismaClient,
    reason?: string,
    restockItems: boolean = true
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        return { success: false, error: `Order ${orderId} not found` };
      }

      if (!order.jtlOutboundId) {
        console.log(`[JTL] Order ${orderId} not synced to FFN, nothing to cancel`);
        return { success: true };
      }

      // Call FFN cancel endpoint
      const cancelReason = reason || `Cancelled from No-Limits. Restock: ${restockItems}`;
      await this.cancelOutbound(order.jtlOutboundId, cancelReason);

      // Update order
      await prisma.order.update({
        where: { id: orderId },
        data: {
          lastJtlSync: new Date(),
          isCancelled: true,
          cancelledAt: new Date(),
          cancelledBy: 'NOLIMITS',
          cancellationReason: cancelReason,
        },
      });

      // Log cancellation
      await prisma.orderSyncLog.create({
        data: {
          orderId,
          action: 'cancel',
          origin: 'NOLIMITS',
          targetPlatform: 'jtl',
          success: true,
          externalId: order.jtlOutboundId,
          changedFields: ['isCancelled', 'cancelledAt'],
        },
      });

      console.log(`[JTL] Order ${orderId} cancelled in FFN`);
      return { success: true };
    } catch (error: any) {
      console.error(`[JTL] Failed to cancel order ${orderId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create fulfillment order for split order
   * Wrapper method for OrderSyncService
   * 
   * Split orders occur when:
   * - Items are in different warehouse locations
   * - Partial stock availability requires multiple shipments
   * - Different items require different carriers/handling
   * 
   * @param splitOrderId - The split order ID
   * @param items - Items to include in this fulfillment
   * @param prisma - PrismaClient instance for database access
   */
  async createFulfillmentOrder(
    splitOrderId: string, 
    items: Array<{ sku: string; quantity: number }>,
    prisma: PrismaClient
  ): Promise<{
    success: boolean;
    outboundId?: string;
    error?: string;
  }> {
    try {
      const order = await prisma.order.findUnique({
        where: { id: splitOrderId },
        include: {
          items: { include: { product: true } },
          client: true,
          splitFromOrder: true,
        },
      });

      if (!order) {
        return { success: false, error: `Split order ${splitOrderId} not found` };
      }

      // Transform order to outbound with only the specified items
      const outbound = this.transformOrderToOutbound(order, items);

      // Create outbound in JTL-FFN
      const result = await this.createOutbound(outbound);

      // Update split order with fulfillment ID
      await prisma.order.update({
        where: { id: splitOrderId },
        data: {
          jtlOutboundId: result.outboundId,
          jtlFulfillmentId: result.outboundId,
          lastJtlSync: new Date(),
          syncStatus: 'SYNCED',
          fulfillmentState: 'PENDING',
        },
      });

      // Log sync
      await prisma.orderSyncLog.create({
        data: {
          orderId: splitOrderId,
          action: 'create',
          origin: 'NOLIMITS',
          targetPlatform: 'jtl',
          success: true,
          externalId: result.outboundId,
          changedFields: ['jtlFulfillmentId', 'lastJtlSync'],
        },
      });

      console.log(`[JTL] Split order ${splitOrderId} synced to FFN as outbound ${result.outboundId}`);
      return { success: true, outboundId: result.outboundId };
    } catch (error: any) {
      console.error(`[JTL] Failed to create fulfillment order ${splitOrderId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Transform order to JTL outbound format
   * 
   * NOTE: JTL FFN accepts either `shippingType` OR `shippingMethodId`, NOT BOTH.
   * If we have a resolved jtlShippingMethodId, use that (more precise).
   * Otherwise fall back to carrier selection or generic shipping method.
   * 
   * @private
   */
  private transformOrderToOutbound(
    order: any,
    filterItems?: Array<{ sku: string; quantity: number }>
  ): JTLOutbound {
    let items = order.items || [];

    // If filterItems provided (for split orders), only include those items
    if (filterItems && filterItems.length > 0) {
      items = items.filter((item: any) =>
        filterItems.some((fi) => fi.sku === item.sku && fi.quantity <= item.quantity)
      );
    }

    // Determine shipping method to use
    // Priority: jtlShippingMethodId > carrierSelection > shippingMethod
    const useJtlShippingMethodId = !!order.jtlShippingMethodId;

    // Parse shipping name into firstname/lastname for JTL format
    const fullName = `${order.shippingFirstName || ''} ${order.shippingLastName || ''}`.trim() ||
      order.customerName ||
      'Unknown';
    const nameParts = fullName.split(' ');
    const firstname = nameParts[0] || 'Unknown';
    const lastname = nameParts.slice(1).join(' ') || firstname;

    return {
      merchantOutboundNumber: order.orderNumber || order.orderId,
      warehouseId: this.credentials.warehouseId,
      fulfillerId: this.credentials.fulfillerId,
      currency: order.currency || 'EUR',
      customerOrderNumber: order.orderNumber || order.orderId,
      orderDate: order.orderDate?.toISOString() || new Date().toISOString(),
      shippingAddress: {
        firstname,
        lastname,
        company: order.shippingCompany || undefined,
        street: order.shippingAddress1 || '',
        addition: order.shippingAddress2 || undefined,
        city: order.shippingCity || '',
        zip: order.shippingZip || '',
        country: order.shippingCountryCode || order.shippingCountry || 'DE',
        phone: order.customerPhone || undefined,
        email: order.customerEmail || undefined,
      },
      items: items.map((item: any) => ({
        merchantSku: item.sku || 'UNKNOWN',
        jfsku: item.product?.jtlProductId || undefined,
        outboundItemId: item.product?.jtlProductId || item.sku || 'UNKNOWN',
        name: item.productName || item.sku || 'Unknown Product',
        quantity: item.quantity,
        unitPrice: item.unitPrice ? parseFloat(item.unitPrice.toString()) : 0,
      })),
      // Use JTL shipping method ID if available (more precise), otherwise use shippingType
      shippingMethodId: useJtlShippingMethodId ? order.jtlShippingMethodId : undefined,
      shippingType: !useJtlShippingMethodId ? 'Standard' : undefined,
      priority: order.priorityLevel || 0,
      note: order.warehouseNotes || order.notes || undefined,
      attributes: order.tags?.length
        ? order.tags.map((tag: string) => ({ key: 'tag', value: tag }))
        : undefined,
    };
  }
}

export default JTLService;
