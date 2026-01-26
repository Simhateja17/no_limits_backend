/**
 * Shopify Integration Service
 * Handles all communication with Shopify Admin REST API
 */

import crypto from 'crypto';
import {
  ShopifyCredentials,
  ShopifyOrder,
  ShopifyProduct,
  ShopifyRefund,
  ShopifyVariant,
  SyncResult,
  SyncItemResult,
} from './types.js';

const DEFAULT_API_VERSION = '2024-10';

export class ShopifyService {
  private credentials: ShopifyCredentials;
  private baseUrl: string;

  constructor(credentials: ShopifyCredentials) {
    this.credentials = credentials;
    const apiVersion = credentials.apiVersion || DEFAULT_API_VERSION;
    // Trim whitespace from shopDomain to prevent invalid URLs
    const shopDomain = credentials.shopDomain.trim();
    this.baseUrl = `https://${shopDomain}/admin/api/${apiVersion}`;
  }

  /**
   * Make an authenticated request to Shopify API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.credentials.accessToken,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  // ============= ORDERS =============

  /**
   * Fetch all orders with optional filters
   */
  async getOrders(params: {
    status?: 'open' | 'closed' | 'cancelled' | 'any';
    fulfillment_status?: 'shipped' | 'partial' | 'unshipped' | 'unfulfilled' | 'any';
    financial_status?: 'authorized' | 'pending' | 'paid' | 'partially_paid' | 'refunded' | 'voided' | 'any';
    created_at_min?: string;
    created_at_max?: string;
    updated_at_min?: string;
    updated_at_max?: string;
    limit?: number;
    since_id?: number;
  } = {}): Promise<ShopifyOrder[]> {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.append(key, String(value));
      }
    });

    // Default limit to 250 (Shopify max)
    if (!queryParams.has('limit')) {
      queryParams.set('limit', '250');
    }

    const query = queryParams.toString();
    const endpoint = `/orders.json${query ? `?${query}` : ''}`;
    
    const response = await this.request<{ orders: ShopifyOrder[] }>(endpoint);
    return response.orders;
  }

  /**
   * Fetch all orders using pagination
   */
  async getAllOrders(params: {
    status?: 'open' | 'closed' | 'cancelled' | 'any';
    created_at_min?: string;
    updated_at_min?: string;
  } = {}): Promise<ShopifyOrder[]> {
    const allOrders: ShopifyOrder[] = [];
    let sinceId: number | undefined;
    
    while (true) {
      const orders = await this.getOrders({
        ...params,
        limit: 250,
        since_id: sinceId,
      });

      if (orders.length === 0) break;

      allOrders.push(...orders);
      sinceId = orders[orders.length - 1].id;

      // Small delay to avoid rate limiting
      await this.delay(500);
    }

    return allOrders;
  }

  /**
   * Fetch a single order by ID
   */
  async getOrder(orderId: number): Promise<ShopifyOrder> {
    const response = await this.request<{ order: ShopifyOrder }>(
      `/orders/${orderId}.json`
    );
    return response.order;
  }

  /**
   * Get orders updated since a specific date (for incremental sync)
   */
  async getOrdersUpdatedSince(since: Date): Promise<ShopifyOrder[]> {
    return this.getAllOrders({
      updated_at_min: since.toISOString(),
      status: 'any',
    });
  }

  /**
   * Get orders created since a specific date (for historic data sync)
   * This pulls orders that were created after the specified date
   */
  async getOrdersCreatedSince(since: Date): Promise<ShopifyOrder[]> {
    return this.getAllOrders({
      created_at_min: since.toISOString(),
      status: 'any',
    });
  }

  // ============= PRODUCTS =============

  /**
   * Fetch all products with optional filters
   */
  async getProducts(params: {
    status?: 'active' | 'archived' | 'draft';
    product_type?: string;
    vendor?: string;
    created_at_min?: string;
    updated_at_min?: string;
    limit?: number;
    since_id?: number;
  } = {}): Promise<ShopifyProduct[]> {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams.append(key, String(value));
      }
    });

    if (!queryParams.has('limit')) {
      queryParams.set('limit', '250');
    }

    const query = queryParams.toString();
    const endpoint = `/products.json${query ? `?${query}` : ''}`;
    
    const response = await this.request<{ products: ShopifyProduct[] }>(endpoint);
    return response.products;
  }

  /**
   * Fetch all products using pagination
   */
  async getAllProducts(params: {
    status?: 'active' | 'archived' | 'draft';
    updated_at_min?: string;
  } = {}): Promise<ShopifyProduct[]> {
    const allProducts: ShopifyProduct[] = [];
    let sinceId: number | undefined;
    
    while (true) {
      const products = await this.getProducts({
        ...params,
        limit: 250,
        since_id: sinceId,
      });

      if (products.length === 0) break;

      allProducts.push(...products);
      sinceId = products[products.length - 1].id;

      await this.delay(500);
    }

    return allProducts;
  }

  /**
   * Fetch a single product by ID
   */
  async getProduct(productId: number): Promise<ShopifyProduct> {
    const response = await this.request<{ product: ShopifyProduct }>(
      `/products/${productId}.json`
    );
    return response.product;
  }

  /**
   * Get products updated since a specific date
   */
  async getProductsUpdatedSince(since: Date): Promise<ShopifyProduct[]> {
    console.log('[Shopify] getProductsUpdatedSince called with:', {
      since: since.toISOString(),
      sinceDate: since.toDateString(),
    });

    try {
      // First, let's see ALL products to understand what's available
      console.log('[Shopify] Fetching ALL products...');
      const allProducts = await this.getAllProducts();
      console.log(`[Shopify] ✅ Total products in store: ${allProducts.length}`);

      if (allProducts.length > 0) {
        console.log('[Shopify] Sample product dates:', allProducts.slice(0, 3).map(p => ({
          title: p.title,
          created_at: p.created_at,
          updated_at: p.updated_at,
        })));
      }

      // Now filter by updated_at_min
      console.log('[Shopify] Now fetching with updated_at_min filter...');
      const filteredProducts = await this.getAllProducts({
        updated_at_min: since.toISOString(),
      });
      console.log(`[Shopify] ✅ Products after updated_at_min filter: ${filteredProducts.length}`);

      return filteredProducts;
    } catch (error) {
      console.error('[Shopify] ❌ ERROR in getProductsUpdatedSince:', error);
      throw error;
    }
  }

  // ============= REFUNDS =============

  /**
   * Fetch refunds for an order
   */
  async getRefunds(orderId: number): Promise<ShopifyRefund[]> {
    const response = await this.request<{ refunds: ShopifyRefund[] }>(
      `/orders/${orderId}/refunds.json`
    );
    return response.refunds;
  }

  /**
   * Fetch a single refund
   */
  async getRefund(orderId: number, refundId: number): Promise<ShopifyRefund> {
    const response = await this.request<{ refund: ShopifyRefund }>(
      `/orders/${orderId}/refunds/${refundId}.json`
    );
    return response.refund;
  }

  /**
   * Get all refunds from orders updated since a date
   */
  async getRefundsUpdatedSince(since: Date): Promise<{ orderId: number; refunds: ShopifyRefund[] }[]> {
    const orders = await this.getAllOrders({
      updated_at_min: since.toISOString(),
      status: 'any',
    });

    const results: { orderId: number; refunds: ShopifyRefund[] }[] = [];

    for (const order of orders) {
      if (order.refunds && order.refunds.length > 0) {
        results.push({
          orderId: order.id,
          refunds: order.refunds,
        });
      }
    }

    return results;
  }

  // ============= INVENTORY =============

  /**
   * Get all locations for the shop
   */
  async getLocations(): Promise<{ id: number; name: string; active: boolean }[]> {
    const response = await this.request<{ locations: { id: number; name: string; active: boolean }[] }>(
      '/locations.json'
    );
    return response.locations || [];
  }

  /**
   * Fetch inventory levels for an inventory item
   */
  async getInventoryLevels(inventoryItemId: number): Promise<{ inventory_level: { inventory_item_id: number; location_id: number; available: number }[] }> {
    const response = await this.request<{ inventory_levels: { inventory_item_id: number; location_id: number; available: number }[] }>(
      `/inventory_levels.json?inventory_item_ids=${inventoryItemId}`
    );
    return { inventory_level: response.inventory_levels };
  }

  /**
   * Update inventory level
   */
  async setInventoryLevel(inventoryItemId: number, locationId: number, available: number): Promise<void> {
    await this.request('/inventory_levels/set.json', {
      method: 'POST',
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available,
      }),
    });
  }

  // ============= FULFILLMENTS =============

  /**
   * Create a fulfillment for an order
   */
  async createFulfillment(orderId: number, fulfillment: {
    location_id: number;
    tracking_number?: string;
    tracking_company?: string;
    tracking_url?: string;
    line_items?: { id: number; quantity?: number }[];
    notify_customer?: boolean;
  }): Promise<{ id: number; status: string; tracking_number: string | null }> {
    const response = await this.request<{ fulfillment: { id: number; status: string; tracking_number: string | null } }>(
      `/orders/${orderId}/fulfillments.json`,
      {
        method: 'POST',
        body: JSON.stringify({ fulfillment }),
      }
    );
    return response.fulfillment;
  }

  // ============= PRODUCT MUTATIONS (PUSH TO SHOPIFY) =============

  /**
   * Create a new product in Shopify
   */
  async createProduct(product: {
    title: string;
    body_html?: string;
    vendor?: string;
    product_type?: string;
    tags?: string;
    status?: 'active' | 'archived' | 'draft';
    variants?: Array<{
      title?: string;
      price: string;
      sku?: string;
      barcode?: string;
      weight?: number;
      weight_unit?: 'g' | 'kg' | 'oz' | 'lb';
      inventory_quantity?: number;
      inventory_management?: 'shopify' | null;
    }>;
    images?: Array<{ src: string; alt?: string }>;
  }): Promise<ShopifyProduct> {
    const response = await this.request<{ product: ShopifyProduct }>(
      '/products.json',
      {
        method: 'POST',
        body: JSON.stringify({ product }),
      }
    );
    return response.product;
  }

  /**
   * Update an existing product in Shopify
   */
  async updateProduct(productId: number, updates: {
    title?: string;
    body_html?: string;
    vendor?: string;
    product_type?: string;
    tags?: string;
    status?: 'active' | 'archived' | 'draft';
    variants?: Array<{
      id?: number;
      title?: string;
      price?: string;
      sku?: string;
      barcode?: string;
      weight?: number;
      weight_unit?: 'g' | 'kg' | 'oz' | 'lb';
      inventory_quantity?: number;
    }>;
    images?: Array<{ id?: number; src?: string; alt?: string }>;
  }): Promise<ShopifyProduct> {
    const response = await this.request<{ product: ShopifyProduct }>(
      `/products/${productId}.json`,
      {
        method: 'PUT',
        body: JSON.stringify({ product: updates }),
      }
    );
    return response.product;
  }

  /**
   * Delete a product from Shopify
   */
  async deleteProduct(productId: number): Promise<void> {
    await this.request(`/products/${productId}.json`, {
      method: 'DELETE',
    });
  }

  /**
   * Update a product variant
   */
  async updateVariant(variantId: number, updates: {
    price?: string;
    sku?: string;
    barcode?: string;
    weight?: number;
    weight_unit?: 'g' | 'kg' | 'oz' | 'lb';
    inventory_quantity?: number;
    inventory_management?: 'shopify' | null;
  }): Promise<ShopifyVariant> {
    const response = await this.request<{ variant: ShopifyVariant }>(
      `/variants/${variantId}.json`,
      {
        method: 'PUT',
        body: JSON.stringify({ variant: updates }),
      }
    );
    return response.variant;
  }

  // ============= ORDER MUTATIONS (PUSH TO SHOPIFY) =============

  /**
   * Create a draft order in Shopify (orders can't be created directly, use draft orders)
   */
  async createDraftOrder(draftOrder: {
    line_items: Array<{
      variant_id?: number;
      title?: string;
      quantity: number;
      price?: string;
      sku?: string;
    }>;
    customer?: { id?: number; email?: string };
    shipping_address?: {
      first_name: string;
      last_name: string;
      address1: string;
      address2?: string;
      city: string;
      province?: string;
      country: string;
      zip: string;
      phone?: string;
    };
    billing_address?: {
      first_name: string;
      last_name: string;
      address1: string;
      address2?: string;
      city: string;
      province?: string;
      country: string;
      zip: string;
      phone?: string;
    };
    note?: string;
    tags?: string;
    shipping_line?: { title: string; price: string };
  }): Promise<{ id: number; order_id: number | null; status: string; invoice_url: string }> {
    const response = await this.request<{ draft_order: { id: number; order_id: number | null; status: string; invoice_url: string } }>(
      '/draft_orders.json',
      {
        method: 'POST',
        body: JSON.stringify({ draft_order: draftOrder }),
      }
    );
    return response.draft_order;
  }

  /**
   * Complete a draft order (converts it to a real order)
   */
  async completeDraftOrder(draftOrderId: number, paymentPending = false): Promise<{ id: number; order_id: number }> {
    const response = await this.request<{ draft_order: { id: number; order_id: number } }>(
      `/draft_orders/${draftOrderId}/complete.json${paymentPending ? '?payment_pending=true' : ''}`,
      {
        method: 'PUT',
      }
    );
    return response.draft_order;
  }

  /**
   * Update an existing order in Shopify
   */
  async updateOrder(orderId: number, updates: {
    note?: string;
    tags?: string;
    email?: string;
    shipping_address?: {
      first_name?: string;
      last_name?: string;
      address1?: string;
      address2?: string;
      city?: string;
      province?: string;
      country?: string;
      zip?: string;
      phone?: string;
    };
  }): Promise<ShopifyOrder> {
    const response = await this.request<{ order: ShopifyOrder }>(
      `/orders/${orderId}.json`,
      {
        method: 'PUT',
        body: JSON.stringify({ order: updates }),
      }
    );
    return response.order;
  }

  /**
   * Cancel an order in Shopify
   */
  async cancelOrder(orderId: number, options?: {
    reason?: 'customer' | 'fraud' | 'inventory' | 'declined' | 'other';
    email?: boolean;
    restock?: boolean;
  }): Promise<ShopifyOrder> {
    const response = await this.request<{ order: ShopifyOrder }>(
      `/orders/${orderId}/cancel.json`,
      {
        method: 'POST',
        body: JSON.stringify(options || {}),
      }
    );
    return response.order;
  }

  /**
   * Close an order in Shopify
   */
  async closeOrder(orderId: number): Promise<ShopifyOrder> {
    const response = await this.request<{ order: ShopifyOrder }>(
      `/orders/${orderId}/close.json`,
      {
        method: 'POST',
      }
    );
    return response.order;
  }

  /**
   * Reopen a closed order
   */
  async reopenOrder(orderId: number): Promise<ShopifyOrder> {
    const response = await this.request<{ order: ShopifyOrder }>(
      `/orders/${orderId}/open.json`,
      {
        method: 'POST',
      }
    );
    return response.order;
  }

  // ============= REFUND MUTATIONS (PUSH TO SHOPIFY) =============

  /**
   * Create a refund in Shopify
   */
  async createRefund(orderId: number, refund: {
    reason?: string;
    notify?: boolean;
    note?: string;
    shipping?: { full_refund?: boolean; amount?: string };
    refund_line_items?: Array<{
      line_item_id: number;
      quantity: number;
      restock_type?: 'no_restock' | 'cancel' | 'return' | 'legacy_restock';
    }>;
    transactions?: Array<{
      parent_id: number;
      amount: string;
      kind: 'refund';
      gateway: string;
    }>;
  }): Promise<ShopifyRefund> {
    const response = await this.request<{ refund: ShopifyRefund }>(
      `/orders/${orderId}/refunds.json`,
      {
        method: 'POST',
        body: JSON.stringify({ refund }),
      }
    );
    return response.refund;
  }

  /**
   * Calculate refund (get suggested refund data before creating)
   */
  async calculateRefund(orderId: number, calculation: {
    shipping?: { full_refund?: boolean; amount?: string };
    refund_line_items?: Array<{
      line_item_id: number;
      quantity: number;
      restock_type?: 'no_restock' | 'cancel' | 'return' | 'legacy_restock';
    }>;
  }): Promise<{ shipping: { amount: string }; refund_line_items: Array<{ line_item_id: number; quantity: number; subtotal: string }> }> {
    const response = await this.request<{ refund: { shipping: { amount: string }; refund_line_items: Array<{ line_item_id: number; quantity: number; subtotal: string }> } }>(
      `/orders/${orderId}/refunds/calculate.json`,
      {
        method: 'POST',
        body: JSON.stringify({ refund: calculation }),
      }
    );
    return response.refund;
  }

  // ============= WEBHOOKS =============

  /**
   * Register a webhook
   */
  async createWebhook(topic: string, address: string, format: 'json' | 'xml' = 'json'): Promise<{ id: number; topic: string; address: string }> {
    const response = await this.request<{ webhook: { id: number; topic: string; address: string } }>(
      '/webhooks.json',
      {
        method: 'POST',
        body: JSON.stringify({
          webhook: { topic, address, format },
        }),
      }
    );
    return response.webhook;
  }

  /**
   * List all webhooks
   */
  async getWebhooks(): Promise<{ id: number; topic: string; address: string }[]> {
    const response = await this.request<{ webhooks: { id: number; topic: string; address: string }[] }>(
      '/webhooks.json'
    );
    return response.webhooks;
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: number): Promise<void> {
    await this.request(`/webhooks/${webhookId}.json`, {
      method: 'DELETE',
    });
  }

  /**
   * Register all required webhooks for sync
   */
  async registerSyncWebhooks(baseUrl: string): Promise<SyncResult> {
    const webhookTopics = [
      'orders/create',
      'orders/updated',
      'orders/cancelled',
      'orders/fulfilled',
      'products/create',
      'products/update',
      'products/delete',
      'refunds/create',
      'inventory_levels/update',
    ];

    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    for (const topic of webhookTopics) {
      try {
        const address = `${baseUrl}/webhooks/shopify/${topic.replace('/', '-')}`;
        await this.createWebhook(topic, address);
        results.push({
          externalId: topic,
          success: true,
          action: 'created',
        });
        itemsProcessed++;
      } catch (error) {
        results.push({
          externalId: topic,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          action: 'failed',
        });
        itemsFailed++;
      }
    }

    return {
      success: itemsFailed === 0,
      syncedAt: new Date(),
      itemsProcessed,
      itemsFailed,
      details: results,
    };
  }

  // ============= HELPERS =============

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test connection to Shopify store
   */
  async testConnection(): Promise<{ success: boolean; message: string; shopInfo?: { name: string; domain: string } }> {
    try {
      const response = await this.request<{ shop: { name: string; domain: string } }>('/shop.json');
      return {
        success: true,
        message: 'Connection successful',
        shopInfo: {
          name: response.shop.name,
          domain: response.shop.domain,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  /**
   * Verify webhook signature
   */
  static verifyWebhookSignature(
    body: string,
    signature: string,
    secret: string
  ): boolean {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body, 'utf8');
    const computedSignature = hmac.digest('base64');
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(computedSignature)
    );
  }

  // ============= OAUTH HELPERS =============

  /**
   * Validate that a shop domain is a valid Shopify hostname
   * Must match pattern: {shop}.myshopify.com
   * @param shopDomain - The shop domain to validate
   * @returns True if valid, false otherwise
   */
  static isValidShopDomain(shopDomain: string): boolean {
    if (!shopDomain) return false;
    
    // Remove protocol if present
    const cleanDomain = shopDomain.replace(/^https?:\/\//, '').trim().toLowerCase();
    
    // Must match pattern: {shop}.myshopify.com
    // Shop name can only contain letters, numbers, and hyphens
    const pattern = /^[a-z0-9][a-z0-9\-]*\.myshopify\.com$/;
    return pattern.test(cleanDomain);
  }

  /**
   * Verify HMAC signature from Shopify OAuth callback
   * This is CRITICAL for security - validates that the request came from Shopify
   * @param queryParams - All query parameters from the callback URL
   * @param hmac - The HMAC value from the query string
   * @param clientSecret - The app's client secret
   * @returns True if signature is valid
   */
  static verifyOAuthHmac(
    queryParams: Record<string, string>,
    hmac: string,
    clientSecret: string
  ): boolean {
    if (!hmac || !clientSecret) {
      console.error('[HMAC Verify] Missing hmac or clientSecret');
      return false;
    }
    
    // Create a copy without the hmac parameter
    const params = { ...queryParams };
    delete params.hmac;
    
    // Sort parameters alphabetically and create query string
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');
    
    console.log('[HMAC Verify] Sorted params string:', sortedParams);
    console.log('[HMAC Verify] Client secret length:', clientSecret.length);
    
    // Compute HMAC-SHA256
    const computedHmac = crypto
      .createHmac('sha256', clientSecret)
      .update(sortedParams)
      .digest('hex');
    
    console.log('[HMAC Verify] Computed HMAC:', computedHmac.substring(0, 20) + '...');
    console.log('[HMAC Verify] Received HMAC:', hmac.substring(0, 20) + '...');
    console.log('[HMAC Verify] Match:', computedHmac === hmac);
    
    // Use timing-safe comparison to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(hmac, 'hex'),
        Buffer.from(computedHmac, 'hex')
      );
    } catch (error) {
      console.error('[HMAC Verify] Error in timingSafeEqual:', error);
      return false;
    }
  }

  /**
   * Validate OAuth callback timestamp to prevent replay attacks
   * Request is valid if timestamp is within 5 minutes
   * @param timestamp - Unix timestamp from callback
   * @returns True if timestamp is valid
   */
  static isValidOAuthTimestamp(timestamp: string | number): boolean {
    const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;
    if (isNaN(ts)) return false;
    
    const now = Math.floor(Date.now() / 1000);
    const fiveMinutes = 5 * 60;
    
    // Timestamp should be within 5 minutes (past or future to account for clock skew)
    return Math.abs(now - ts) <= fiveMinutes;
  }

  /**
   * Generate a cryptographically secure nonce for OAuth state
   * @returns A random hex string
   */
  static generateOAuthNonce(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate OAuth authorization URL for Shopify
   * @param params - OAuth parameters
   * @returns The authorization URL to redirect the user to
   */
  static generateAuthorizationUrl(params: {
    shopDomain: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
  }): string {
    const { shopDomain, clientId, redirectUri, scopes, state } = params;

    // Clean shop domain (remove protocol if present)
    const cleanDomain = shopDomain.replace(/^https?:\/\//, '').trim();

    const authUrl = `https://${cleanDomain}/admin/oauth/authorize`;

    const queryParams = new URLSearchParams({
      client_id: clientId,
      scope: scopes.join(','),
      redirect_uri: redirectUri,
      state: state,
    });

    return `${authUrl}?${queryParams.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   * @param params - Token exchange parameters
   * @returns Access token and granted scopes
   */
  static async exchangeCodeForToken(params: {
    shopDomain: string;
    clientId: string;
    clientSecret: string;
    code: string;
  }): Promise<{ accessToken: string; scope: string }> {
    const { shopDomain, clientId, clientSecret, code } = params;

    // Clean shop domain
    const cleanDomain = shopDomain.replace(/^https?:\/\//, '').trim();

    const tokenUrl = `https://${cleanDomain}/admin/oauth/access_token`;

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify OAuth token exchange failed: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      scope: string;
    };
    return {
      accessToken: data.access_token,
      scope: data.scope,
    };
  }

  /**
   * Validate OAuth state for CSRF protection
   * @param state - The state received in the callback
   * @param expectedState - The expected state value
   * @returns True if the states match
   */
  static validateOAuthState(state: string, expectedState: string): boolean {
    if (!state || !expectedState) {
      return false;
    }
    return state === expectedState;
  }

  // ============= SHIPPING =============

  /**
   * Get all shipping zones with their rates
   * Shopify API: GET /admin/api/2024-10/shipping_zones.json
   */
  async getShippingZones(): Promise<Array<{
    id: number;
    name: string;
    countries: Array<{ code: string; name: string }>;
    price_based_shipping_rates: Array<{
      id: number;
      name: string;
      price: string;
    }>;
    weight_based_shipping_rates: Array<{
      id: number;
      name: string;
      price: string;
    }>;
    carrier_shipping_rate_providers: Array<{
      id: number;
      carrier_service_id: number;
      flat_modifier: string;
      percent_modifier: number;
      service_filter: { [key: string]: string };
      shipping_zone_id: number;
    }>;
  }>> {
    const response = await this.request<{ shipping_zones: Array<any> }>('/shipping_zones.json');
    return response.shipping_zones;
  }

  /**
   * Get shipping methods/rates from all zones in a simplified format
   * Returns unique shipping method names that clients can map to JTL FFN
   */
  async getShippingMethods(): Promise<Array<{
    id: string;
    name: string;
    type: 'price_based' | 'weight_based' | 'carrier';
    zoneId: number;
    zoneName: string;
  }>> {
    try {
      const zones = await this.getShippingZones();
      const methods: Array<{
        id: string;
        name: string;
        type: 'price_based' | 'weight_based' | 'carrier';
        zoneId: number;
        zoneName: string;
      }> = [];

      for (const zone of zones) {
        // Add price-based rates
        for (const rate of zone.price_based_shipping_rates || []) {
          methods.push({
            id: `price_${rate.id}`,
            name: rate.name,
            type: 'price_based',
            zoneId: zone.id,
            zoneName: zone.name,
          });
        }

        // Add weight-based rates
        for (const rate of zone.weight_based_shipping_rates || []) {
          methods.push({
            id: `weight_${rate.id}`,
            name: rate.name,
            type: 'weight_based',
            zoneId: zone.id,
            zoneName: zone.name,
          });
        }

        // Add carrier rates (like Shopify Shipping, USPS, etc.)
        for (const provider of zone.carrier_shipping_rate_providers || []) {
          methods.push({
            id: `carrier_${provider.id}`,
            name: `Carrier Service ${provider.carrier_service_id}`,
            type: 'carrier',
            zoneId: zone.id,
            zoneName: zone.name,
          });
        }
      }

      // Deduplicate by name (same shipping method can appear in multiple zones)
      const uniqueMethods = new Map<string, typeof methods[0]>();
      for (const method of methods) {
        if (!uniqueMethods.has(method.name)) {
          uniqueMethods.set(method.name, method);
        }
      }

      return Array.from(uniqueMethods.values());
    } catch (error) {
      console.error('[Shopify] Error fetching shipping methods:', error);
      return [];
    }
  }
}

export default ShopifyService;
