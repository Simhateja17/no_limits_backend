/**
 * WooCommerce Integration Service
 * Handles all communication with WooCommerce REST API v3
 */

import {
  WooCommerceCredentials,
  WooCommerceOrder,
  WooCommerceProduct,
  WooCommerceRefund,
  WooCommerceAddress,
  SyncResult,
  SyncItemResult,
} from './types.js';

const DEFAULT_API_VERSION = 'wc/v3';

export class WooCommerceService {
  private credentials: WooCommerceCredentials;
  private baseUrl: string;

  constructor(credentials: WooCommerceCredentials) {
    this.credentials = credentials;
    const version = credentials.version || DEFAULT_API_VERSION;
    // Remove trailing slash from URL if present
    const cleanUrl = credentials.url.replace(/\/$/, '');
    this.baseUrl = `${cleanUrl}/wp-json/${version}`;
  }

  /**
   * Build authentication query params
   */
  private getAuthParams(): URLSearchParams {
    const params = new URLSearchParams();
    params.set('consumer_key', this.credentials.consumerKey);
    params.set('consumer_secret', this.credentials.consumerSecret);
    return params;
  }

  /**
   * Make an authenticated request to WooCommerce API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    additionalParams: Record<string, string> = {}
  ): Promise<T> {
    const authParams = this.getAuthParams();
    
    // Add additional query params
    Object.entries(additionalParams).forEach(([key, value]) => {
      authParams.set(key, value);
    });

    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${this.baseUrl}${endpoint}${separator}${authParams.toString()}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WooCommerce API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Parse Link header for pagination
   */
  private parseLinkHeader(linkHeader: string | null): { next?: string; prev?: string } {
    if (!linkHeader) return {};
    
    const links: { next?: string; prev?: string } = {};
    const parts = linkHeader.split(',');
    
    for (const part of parts) {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (match) {
        const [, url, rel] = match;
        if (rel === 'next' || rel === 'prev') {
          links[rel] = url;
        }
      }
    }
    
    return links;
  }

  // ============= ORDERS =============

  /**
   * Fetch orders with optional filters
   */
  async getOrders(params: {
    status?: string;
    after?: string;
    before?: string;
    modified_after?: string;
    modified_before?: string;
    page?: number;
    per_page?: number;
    order?: 'asc' | 'desc';
    orderby?: 'date' | 'id' | 'include' | 'title' | 'slug';
  } = {}): Promise<WooCommerceOrder[]> {
    const queryParams: Record<string, string> = {};
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams[key] = String(value);
      }
    });

    // Default to 100 per page (WooCommerce max)
    if (!queryParams.per_page) {
      queryParams.per_page = '100';
    }

    return this.request<WooCommerceOrder[]>('/orders', {}, queryParams);
  }

  /**
   * Fetch all orders using pagination
   */
  async getAllOrders(params: {
    status?: string;
    modified_after?: string;
  } = {}): Promise<WooCommerceOrder[]> {
    const allOrders: WooCommerceOrder[] = [];
    let page = 1;

    console.log(`[WooCommerce] Starting order fetch (100 per page)...`);

    while (true) {
      const orders = await this.getOrders({
        ...params,
        page,
        per_page: 100,
      });

      if (orders.length === 0) break;

      allOrders.push(...orders);

      console.log(`[WooCommerce] Page ${page}: Fetched ${orders.length} orders (Total: ${allOrders.length})`);

      if (orders.length < 100) break;

      page++;

      // Small delay to avoid rate limiting
      await this.delay(300);
    }

    console.log(`[WooCommerce] Order fetch complete: ${allOrders.length} total orders in ${page} pages`);
    return allOrders;
  }

  /**
   * Fetch a single order by ID
   */
  async getOrder(orderId: number): Promise<WooCommerceOrder> {
    return this.request<WooCommerceOrder>(`/orders/${orderId}`);
  }

  /**
   * Get orders updated since a specific date
   */
  async getOrdersUpdatedSince(since: Date): Promise<WooCommerceOrder[]> {
    return this.getAllOrders({
      modified_after: since.toISOString(),
    });
  }

  /**
   * Get orders created since a specific date (for historic data sync)
   * This pulls orders that were created after the specified date
   */
  async getOrdersCreatedSince(since: Date): Promise<WooCommerceOrder[]> {
    const allOrders: WooCommerceOrder[] = [];
    let page = 1;

    console.log(`[WooCommerce] Starting order fetch since ${since.toISOString()} (100 per page)...`);

    while (true) {
      const orders = await this.getOrders({
        after: since.toISOString(),
        page,
        per_page: 100,
      });

      if (orders.length === 0) break;

      allOrders.push(...orders);

      console.log(`[WooCommerce] Page ${page}: Fetched ${orders.length} orders (Total: ${allOrders.length})`);

      if (orders.length < 100) break;

      page++;
      await this.delay(300);
    }

    console.log(`[WooCommerce] Order fetch complete: ${allOrders.length} orders created since ${since.toISOString()}`);
    return allOrders;
  }

  /**
   * Update order status
   */
  async updateOrderStatus(orderId: number, status: string): Promise<WooCommerceOrder> {
    return this.request<WooCommerceOrder>(
      `/orders/${orderId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ status }),
      }
    );
  }

  // ============= PRODUCTS =============

  /**
   * Fetch products with optional filters
   */
  async getProducts(params: {
    status?: 'draft' | 'pending' | 'private' | 'publish' | 'any';
    type?: 'simple' | 'grouped' | 'external' | 'variable';
    category?: number;
    after?: string;
    before?: string;
    modified_after?: string;
    modified_before?: string;
    page?: number;
    per_page?: number;
    stock_status?: 'instock' | 'outofstock' | 'onbackorder';
  } = {}): Promise<WooCommerceProduct[]> {
    const queryParams: Record<string, string> = {};
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        queryParams[key] = String(value);
      }
    });

    if (!queryParams.per_page) {
      queryParams.per_page = '100';
    }

    return this.request<WooCommerceProduct[]>('/products', {}, queryParams);
  }

  /**
   * Fetch all products using pagination
   */
  async getAllProducts(params: {
    status?: 'draft' | 'pending' | 'private' | 'publish' | 'any';
    modified_after?: string;
  } = {}): Promise<WooCommerceProduct[]> {
    const allProducts: WooCommerceProduct[] = [];
    let page = 1;

    console.log(`[WooCommerce] Starting product fetch (100 per page)...`);

    while (true) {
      const products = await this.getProducts({
        ...params,
        page,
        per_page: 100,
      });

      if (products.length === 0) break;

      allProducts.push(...products);

      console.log(`[WooCommerce] Page ${page}: Fetched ${products.length} products (Total: ${allProducts.length})`);

      if (products.length < 100) break;

      page++;

      await this.delay(300);
    }

    console.log(`[WooCommerce] Product fetch complete: ${allProducts.length} total products in ${page} pages`);
    return allProducts;
  }

  /**
   * Fetch a single product by ID
   */
  async getProduct(productId: number): Promise<WooCommerceProduct> {
    return this.request<WooCommerceProduct>(`/products/${productId}`);
  }

  /**
   * Get products updated since a specific date
   */
  async getProductsUpdatedSince(since: Date): Promise<WooCommerceProduct[]> {
    return this.getAllProducts({
      modified_after: since.toISOString(),
    });
  }

  /**
   * Get product variations (for variable products)
   */
  async getProductVariations(productId: number): Promise<WooCommerceProduct[]> {
    return this.request<WooCommerceProduct[]>(
      `/products/${productId}/variations`,
      {},
      { per_page: '100' }
    );
  }

  /**
   * Update product stock
   */
  async updateProductStock(productId: number, stockQuantity: number, manageStock = true): Promise<WooCommerceProduct> {
    return this.request<WooCommerceProduct>(
      `/products/${productId}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          manage_stock: manageStock,
          stock_quantity: stockQuantity,
        }),
      }
    );
  }

  // ============= PRODUCT MUTATIONS (PUSH TO WOOCOMMERCE) =============

  /**
   * Create a new product in WooCommerce
   */
  async createProduct(product: {
    name: string;
    type?: 'simple' | 'grouped' | 'external' | 'variable';
    status?: 'draft' | 'pending' | 'private' | 'publish';
    description?: string;
    short_description?: string;
    sku?: string;
    regular_price?: string;
    sale_price?: string;
    manage_stock?: boolean;
    stock_quantity?: number;
    stock_status?: 'instock' | 'outofstock' | 'onbackorder';
    weight?: string;
    dimensions?: { length?: string; width?: string; height?: string };
    categories?: Array<{ id: number }>;
    images?: Array<{ src: string; alt?: string }>;
    attributes?: Array<{
      name: string;
      position?: number;
      visible?: boolean;
      variation?: boolean;
      options?: string[];
    }>;
  }): Promise<WooCommerceProduct> {
    return this.request<WooCommerceProduct>(
      '/products',
      {
        method: 'POST',
        body: JSON.stringify(product),
      }
    );
  }

  /**
   * Update an existing product in WooCommerce
   */
  async updateProduct(productId: number, updates: {
    name?: string;
    type?: 'simple' | 'grouped' | 'external' | 'variable';
    status?: 'draft' | 'pending' | 'private' | 'publish';
    description?: string;
    short_description?: string;
    sku?: string;
    regular_price?: string;
    sale_price?: string;
    manage_stock?: boolean;
    stock_quantity?: number;
    stock_status?: 'instock' | 'outofstock' | 'onbackorder';
    weight?: string;
    dimensions?: { length?: string; width?: string; height?: string };
    categories?: Array<{ id: number }>;
    images?: Array<{ id?: number; src?: string; alt?: string }>;
  }): Promise<WooCommerceProduct> {
    return this.request<WooCommerceProduct>(
      `/products/${productId}`,
      {
        method: 'PUT',
        body: JSON.stringify(updates),
      }
    );
  }

  /**
   * Delete a product from WooCommerce
   */
  async deleteProduct(productId: number, force = true): Promise<WooCommerceProduct> {
    return this.request<WooCommerceProduct>(
      `/products/${productId}`,
      {
        method: 'DELETE',
      },
      { force: String(force) }
    );
  }

  /**
   * Batch create/update/delete products
   */
  async batchProducts(batch: {
    create?: Array<{
      name: string;
      type?: 'simple' | 'grouped' | 'external' | 'variable';
      sku?: string;
      regular_price?: string;
      description?: string;
      manage_stock?: boolean;
      stock_quantity?: number;
    }>;
    update?: Array<{ id: number; [key: string]: unknown }>;
    delete?: number[];
  }): Promise<{
    create?: WooCommerceProduct[];
    update?: WooCommerceProduct[];
    delete?: WooCommerceProduct[];
  }> {
    return this.request('/products/batch', {
      method: 'POST',
      body: JSON.stringify(batch),
    });
  }

  /**
   * Create a product variation
   */
  async createProductVariation(productId: number, variation: {
    sku?: string;
    regular_price?: string;
    sale_price?: string;
    manage_stock?: boolean;
    stock_quantity?: number;
    stock_status?: 'instock' | 'outofstock' | 'onbackorder';
    weight?: string;
    dimensions?: { length?: string; width?: string; height?: string };
    attributes?: Array<{ id: number; name: string; option: string }>;
    image?: { src: string; alt?: string };
  }): Promise<WooCommerceProduct> {
    return this.request<WooCommerceProduct>(
      `/products/${productId}/variations`,
      {
        method: 'POST',
        body: JSON.stringify(variation),
      }
    );
  }

  /**
   * Update a product variation
   */
  async updateProductVariation(productId: number, variationId: number, updates: {
    sku?: string;
    regular_price?: string;
    sale_price?: string;
    manage_stock?: boolean;
    stock_quantity?: number;
    stock_status?: 'instock' | 'outofstock' | 'onbackorder';
    weight?: string;
    dimensions?: { length?: string; width?: string; height?: string };
  }): Promise<WooCommerceProduct> {
    return this.request<WooCommerceProduct>(
      `/products/${productId}/variations/${variationId}`,
      {
        method: 'PUT',
        body: JSON.stringify(updates),
      }
    );
  }

  // ============= ORDER MUTATIONS (PUSH TO WOOCOMMERCE) =============

  /**
   * Create a new order in WooCommerce
   */
  async createOrder(order: {
    status?: 'pending' | 'processing' | 'on-hold' | 'completed' | 'cancelled' | 'refunded' | 'failed';
    customer_id?: number;
    customer_note?: string;
    billing?: {
      first_name?: string;
      last_name?: string;
      company?: string;
      address_1?: string;
      address_2?: string;
      city?: string;
      state?: string;
      postcode?: string;
      country?: string;
      email?: string;
      phone?: string;
    };
    shipping?: {
      first_name?: string;
      last_name?: string;
      company?: string;
      address_1?: string;
      address_2?: string;
      city?: string;
      state?: string;
      postcode?: string;
      country?: string;
    };
    line_items: Array<{
      product_id?: number;
      variation_id?: number;
      quantity: number;
      sku?: string;
    }>;
    shipping_lines?: Array<{
      method_id: string;
      method_title: string;
      total: string;
    }>;
    set_paid?: boolean;
  }): Promise<WooCommerceOrder> {
    return this.request<WooCommerceOrder>(
      '/orders',
      {
        method: 'POST',
        body: JSON.stringify(order),
      }
    );
  }

  /**
   * Update an existing order in WooCommerce
   */
  async updateOrder(orderId: number, updates: {
    status?: 'pending' | 'processing' | 'on-hold' | 'completed' | 'cancelled' | 'refunded' | 'failed';
    customer_note?: string;
    billing?: {
      first_name?: string;
      last_name?: string;
      company?: string;
      address_1?: string;
      address_2?: string;
      city?: string;
      state?: string;
      postcode?: string;
      country?: string;
      email?: string;
      phone?: string;
    };
    shipping?: {
      first_name?: string;
      last_name?: string;
      company?: string;
      address_1?: string;
      address_2?: string;
      city?: string;
      state?: string;
      postcode?: string;
      country?: string;
    };
  }): Promise<WooCommerceOrder> {
    return this.request<WooCommerceOrder>(
      `/orders/${orderId}`,
      {
        method: 'PUT',
        body: JSON.stringify(updates),
      }
    );
  }

  /**
   * Delete an order from WooCommerce
   */
  async deleteOrder(orderId: number, force = false): Promise<WooCommerceOrder> {
    return this.request<WooCommerceOrder>(
      `/orders/${orderId}`,
      {
        method: 'DELETE',
      },
      { force: String(force) }
    );
  }

  /**
   * Batch create/update/delete orders
   */
  async batchOrders(batch: {
    create?: Array<{
      status?: string;
      line_items: Array<{ product_id?: number; quantity: number }>;
      billing?: WooCommerceAddress;
      shipping?: WooCommerceAddress;
    }>;
    update?: Array<{ id: number; status?: string; [key: string]: unknown }>;
    delete?: number[];
  }): Promise<{
    create?: WooCommerceOrder[];
    update?: WooCommerceOrder[];
    delete?: WooCommerceOrder[];
  }> {
    return this.request('/orders/batch', {
      method: 'POST',
      body: JSON.stringify(batch),
    });
  }

  // ============= REFUNDS =============

  /**
   * Fetch refunds for an order
   */
  async getRefunds(orderId: number): Promise<WooCommerceRefund[]> {
    return this.request<WooCommerceRefund[]>(`/orders/${orderId}/refunds`);
  }

  /**
   * Fetch a single refund
   */
  async getRefund(orderId: number, refundId: number): Promise<WooCommerceRefund> {
    return this.request<WooCommerceRefund>(`/orders/${orderId}/refunds/${refundId}`);
  }

  /**
   * Create a refund
   */
  async createRefund(orderId: number, refund: {
    amount?: string;
    reason?: string;
    line_items?: { id: number; quantity?: number; refund_total?: string }[];
    api_refund?: boolean;
  }): Promise<WooCommerceRefund> {
    return this.request<WooCommerceRefund>(
      `/orders/${orderId}/refunds`,
      {
        method: 'POST',
        body: JSON.stringify(refund),
      }
    );
  }

  /**
   * Get all refunds from orders updated since a date
   */
  async getRefundsUpdatedSince(since: Date): Promise<{ orderId: number; refunds: WooCommerceRefund[] }[]> {
    const orders = await this.getAllOrders({
      modified_after: since.toISOString(),
    });

    const results: { orderId: number; refunds: WooCommerceRefund[] }[] = [];

    for (const order of orders) {
      if (order.refunds && order.refunds.length > 0) {
        // Fetch full refund details
        const refunds = await this.getRefunds(order.id);
        results.push({
          orderId: order.id,
          refunds,
        });
        await this.delay(200);
      }
    }

    return results;
  }

  // ============= CUSTOMERS =============

  /**
   * Fetch a customer by ID
   */
  async getCustomer(customerId: number): Promise<{
    id: number;
    email: string;
    first_name: string;
    last_name: string;
    billing: { email: string; phone: string };
    shipping: { first_name: string; last_name: string };
  }> {
    return this.request(`/customers/${customerId}`);
  }

  // ============= WEBHOOKS =============

  /**
   * Create a webhook
   */
  async createWebhook(webhook: {
    name: string;
    topic: string;
    delivery_url: string;
    secret?: string;
    status?: 'active' | 'paused' | 'disabled';
  }): Promise<{ id: number; topic: string; delivery_url: string }> {
    return this.request<{ id: number; topic: string; delivery_url: string }>(
      '/webhooks',
      {
        method: 'POST',
        body: JSON.stringify({ ...webhook, status: webhook.status || 'active' }),
      }
    );
  }

  /**
   * List all webhooks
   */
  async getWebhooks(): Promise<{ id: number; topic: string; delivery_url: string }[]> {
    return this.request<{ id: number; topic: string; delivery_url: string }[]>(
      '/webhooks',
      {},
      { per_page: '100' }
    );
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: number): Promise<void> {
    await this.request(`/webhooks/${webhookId}`, {
      method: 'DELETE',
    }, { force: 'true' });
  }

  /**
   * Register all required webhooks for sync
   */
  async registerSyncWebhooks(baseUrl: string, secret: string): Promise<SyncResult> {
    const webhookTopics = [
      { name: 'Order Created', topic: 'order.created' },
      { name: 'Order Updated', topic: 'order.updated' },
      { name: 'Order Deleted', topic: 'order.deleted' },
      { name: 'Product Created', topic: 'product.created' },
      { name: 'Product Updated', topic: 'product.updated' },
      { name: 'Product Deleted', topic: 'product.deleted' },
    ];

    const results: SyncItemResult[] = [];
    let itemsProcessed = 0;
    let itemsFailed = 0;

    for (const { name, topic } of webhookTopics) {
      try {
        const deliveryUrl = `${baseUrl}/webhooks/woocommerce/${topic.replace('.', '-')}`;
        await this.createWebhook({
          name,
          topic,
          delivery_url: deliveryUrl,
          secret,
        });
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

  // ============= SYSTEM STATUS =============

  /**
   * Get store system status
   */
  async getSystemStatus(): Promise<{
    environment: { home_url: string; wc_version: string };
    database: { wc_database_version: string };
  }> {
    return this.request('/system_status');
  }

  /**
   * Test connection to WooCommerce
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const status = await this.getSystemStatus();
      return {
        success: true,
        message: `Connected to WooCommerce ${status.environment.wc_version}`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  // ============= HELPERS =============

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Verify webhook signature (WooCommerce sends signature in X-WC-Webhook-Signature header)
   */
  static verifyWebhookSignature(
    body: string,
    signature: string,
    secret: string
  ): boolean {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body, 'utf8');
    const computedSignature = hmac.digest('base64');
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(computedSignature)
    );
  }

  // ============= SHIPPING =============

  /**
   * Get all shipping zones
   * WooCommerce API: GET /wc/v3/shipping/zones
   */
  async getShippingZones(): Promise<Array<{
    id: number;
    name: string;
    order: number;
  }>> {
    console.log('[WooCommerce] API Call: GET /shipping/zones');
    const zones = await this.request<Array<{ id: number; name: string; order: number }>>('/shipping/zones');
    console.log(`[WooCommerce] API Response: Received ${zones.length} zones`);
    return zones;
  }

  /**
   * Get shipping methods for a specific zone
   * WooCommerce API: GET /wc/v3/shipping/zones/{zone_id}/methods
   */
  async getShippingZoneMethods(zoneId: number): Promise<Array<{
    instance_id: number;
    title: string;
    order: number;
    enabled: boolean;
    method_id: string;
    method_title: string;
    method_description: string;
    settings: {
      title?: { value: string };
      cost?: { value: string };
      [key: string]: { value: string } | undefined;
    };
  }>> {
    console.log(`[WooCommerce] API Call: GET /shipping/zones/${zoneId}/methods`);
    const methods = await this.request<Array<any>>(`/shipping/zones/${zoneId}/methods`);
    console.log(`[WooCommerce] API Response: Received ${methods.length} methods for zone ${zoneId}`);
    return methods;
  }

  /**
   * Get all shipping methods across all zones in a simplified format
   * Returns unique shipping methods that clients can map to JTL FFN
   */
  async getShippingMethods(): Promise<Array<{
    id: string;
    name: string;
    methodId: string;
    zoneId: number;
    zoneName: string;
    enabled: boolean;
  }>> {
    try {
      console.log('[WooCommerce] Starting to fetch shipping methods...');
      console.log(`[WooCommerce] Store URL: ${this.credentials.url}`);

      const zones = await this.getShippingZones();
      console.log(`[WooCommerce] Retrieved ${zones.length} shipping zones:`, zones.map(z => ({ id: z.id, name: z.name })));

      const methods: Array<{
        id: string;
        name: string;
        methodId: string;
        zoneId: number;
        zoneName: string;
        enabled: boolean;
      }> = [];

      for (const zone of zones) {
        try {
          console.log(`[WooCommerce] Fetching methods for zone "${zone.name}" (ID: ${zone.id})...`);
          const zoneMethods = await this.getShippingZoneMethods(zone.id);
          console.log(`[WooCommerce] Zone "${zone.name}" has ${zoneMethods.length} methods:`,
            zoneMethods.map(m => ({
              method_id: m.method_id,
              instance_id: m.instance_id,
              title: m.title,
              method_title: m.method_title,
              enabled: m.enabled,
              settings_title: m.settings?.title?.value
            }))
          );

          for (const method of zoneMethods) {
            // Use the custom title from settings if available, otherwise use method_title
            const displayName = method.settings?.title?.value || method.title || method.method_title;

            console.log(`[WooCommerce] Processing method in zone "${zone.name}":`, {
              instance_id: method.instance_id,
              method_id: method.method_id,
              display_name: displayName,
              enabled: method.enabled,
              title_source: method.settings?.title?.value ? 'settings.title.value' : (method.title ? 'title' : 'method_title')
            });

            methods.push({
              id: `${method.method_id}_${method.instance_id}`,
              name: displayName,
              methodId: method.method_id,
              zoneId: zone.id,
              zoneName: zone.name,
              enabled: method.enabled,
            });
          }
        } catch (err) {
          console.warn(`[WooCommerce] Could not fetch methods for zone ${zone.id} (${zone.name}):`, err);
        }
      }

      console.log(`[WooCommerce] Total methods collected (before deduplication): ${methods.length}`);
      console.log('[WooCommerce] All methods:', methods.map(m => ({ name: m.name, enabled: m.enabled, zone: m.zoneName })));

      // Deduplicate by name (same shipping method can appear in multiple zones)
      // Keep only enabled methods, but include all if none are enabled
      const enabledMethods = methods.filter(m => m.enabled);
      console.log(`[WooCommerce] Enabled methods: ${enabledMethods.length}, Total methods: ${methods.length}`);

      const methodsToUse = enabledMethods.length > 0 ? enabledMethods : methods;
      console.log(`[WooCommerce] Using ${methodsToUse.length} methods for deduplication (${enabledMethods.length > 0 ? 'enabled only' : 'all methods'})`);

      const uniqueMethods = new Map<string, typeof methods[0]>();
      for (const method of methodsToUse) {
        if (!uniqueMethods.has(method.name)) {
          console.log(`[WooCommerce] Adding unique method: "${method.name}" (${method.methodId}) from zone "${method.zoneName}"`);
          uniqueMethods.set(method.name, method);
        } else {
          console.log(`[WooCommerce] Skipping duplicate method: "${method.name}" from zone "${method.zoneName}"`);
        }
      }

      const finalMethods = Array.from(uniqueMethods.values());
      console.log(`[WooCommerce] Final unique shipping methods: ${finalMethods.length}`);
      console.log('[WooCommerce] Final methods list:', finalMethods.map(m => ({
        id: m.id,
        name: m.name,
        methodId: m.methodId,
        enabled: m.enabled,
        zone: m.zoneName
      })));

      return finalMethods;
    } catch (error) {
      console.error('[WooCommerce] Error fetching shipping methods:', error);
      if (error instanceof Error) {
        console.error('[WooCommerce] Error details:', {
          message: error.message,
          stack: error.stack
        });
      }
      return [];
    }
  }
}

export default WooCommerceService;
