/**
 * Shopify GraphQL Integration Service
 * Handles all communication with Shopify Admin GraphQL API
 * Mirrors the interface of ShopifyService (REST) for drop-in replacement
 */

import crypto from 'crypto';
import { shopifyApi, ApiVersion, Session } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';
import {
  ShopifyCredentials,
  ShopifyOrder,
  ShopifyProduct,
  ShopifyRefund,
  ShopifyVariant,
  SyncResult,
  SyncItemResult,
} from './types.js';

// Import GraphQL queries and mutations
import {
  GET_ORDERS_QUERY,
  GET_ORDER_QUERY,
  GET_ORDER_FULFILLMENT_ORDERS_QUERY,
  GET_FULFILLMENT_ORDER_QUERY,
  GET_FULFILLMENT_ORDERS_QUERY,
  GET_PRODUCTS_QUERY,
  GET_PRODUCT_QUERY,
  GET_INVENTORY_LEVELS_QUERY,
  GET_SHOP_QUERY,
  GET_WEBHOOKS_QUERY,
  GET_SUGGESTED_REFUND_QUERY,
  GET_LOCATIONS_QUERY,
} from './shopify-graphql/queries.js';

import {
  PRODUCT_CREATE_MUTATION,
  PRODUCT_UPDATE_MUTATION,
  PRODUCT_DELETE_MUTATION,
  PRODUCT_VARIANT_UPDATE_MUTATION,
  ORDER_UPDATE_MUTATION,
  ORDER_CANCEL_MUTATION,
  ORDER_CLOSE_MUTATION,
  ORDER_OPEN_MUTATION,
  DRAFT_ORDER_CREATE_MUTATION,
  DRAFT_ORDER_COMPLETE_MUTATION,
  REFUND_CREATE_MUTATION,
  FULFILLMENT_CREATE_MUTATION,
  FULFILLMENT_TRACKING_INFO_UPDATE_MUTATION,
  FULFILLMENT_ORDER_HOLD_MUTATION,
  FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION,
  FULFILLMENT_ORDER_MOVE_MUTATION,
  FULFILLMENT_ORDER_SUBMIT_CANCELLATION_REQUEST_MUTATION,
  FULFILLMENT_ORDER_SUBMIT_FULFILLMENT_REQUEST_MUTATION,
  FULFILLMENT_ORDER_ACCEPT_FULFILLMENT_REQUEST_MUTATION,
  FULFILLMENT_ORDER_REJECT_FULFILLMENT_REQUEST_MUTATION,
  FULFILLMENT_ORDER_ACCEPT_CANCELLATION_REQUEST_MUTATION,
  FULFILLMENT_ORDER_REJECT_CANCELLATION_REQUEST_MUTATION,
  INVENTORY_SET_QUANTITIES_MUTATION,
  WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
  WEBHOOK_SUBSCRIPTION_DELETE_MUTATION,
  getGraphQLWebhookTopic,
  getGraphQLCancelReason,
  getGraphQLProductStatus,
  getGraphQLWeightUnit,
  getGraphQLRestockType,
} from './shopify-graphql/mutations.js';

// Import utilities
import { toGid, extractNumericId, toLegacyId } from './shopify-graphql/utils/id-converter.js';
import { fetchAllPages, buildQueryFilter, DEFAULT_PAGE_SIZE } from './shopify-graphql/utils/pagination.js';
import { mapOrder, mapOrders, mapProduct, mapProducts, mapRefund } from './shopify-graphql/utils/response-mapper.js';

const DEFAULT_API_VERSION = '2024-10';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

export class ShopifyGraphQLService {
  private credentials: ShopifyCredentials;
  private shopify: ReturnType<typeof shopifyApi>;
  private session: Session;
  private graphqlEndpoint: string;
  private restBaseUrl: string;

  constructor(credentials: ShopifyCredentials) {
    this.credentials = credentials;
    const apiVersion = credentials.apiVersion || DEFAULT_API_VERSION;
    const shopDomain = credentials.shopDomain.trim();

    // Initialize Shopify API client
    this.shopify = shopifyApi({
      apiKey: 'placeholder', // Not needed for Admin API with access token
      apiSecretKey: 'placeholder',
      scopes: [],
      hostName: shopDomain,
      apiVersion: ApiVersion.October24,
      isEmbeddedApp: false,
      isCustomStoreApp: true,
      adminApiAccessToken: credentials.accessToken,
    });

    // Create session for GraphQL client
    this.session = new Session({
      id: `${shopDomain}_session`,
      shop: shopDomain,
      state: 'active',
      isOnline: false,
      accessToken: credentials.accessToken,
    });

    this.graphqlEndpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
    this.restBaseUrl = `https://${shopDomain}/admin/api/${apiVersion}`;
  }

  /**
   * Execute a GraphQL query/mutation
   */
  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.graphqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.credentials.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify GraphQL error: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as GraphQLResponse<T>;

    // Check for GraphQL errors
    if (result.errors && result.errors.length > 0) {
      const errorMessages = result.errors.map(e => e.message).join(', ');
      throw new Error(`Shopify GraphQL error: ${errorMessages}`);
    }

    // Log query cost for debugging/monitoring
    if (result.extensions?.cost) {
      const cost = result.extensions.cost;
      console.log(`[Shopify GraphQL] Query cost: ${cost.actualQueryCost}/${cost.throttleStatus.currentlyAvailable} points available`);
    }

    return result.data as T;
  }

  /**
   * Execute a Shopify Admin REST request.
   * Used as a targeted fallback for resources that are expensive in GraphQL.
   */
  private async rest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.restBaseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.credentials.accessToken,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify REST fallback error: ${response.status} - ${error}`);
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
    // Build query filter string
    const filters: string[] = [];

    if (params.status && params.status !== 'any') {
      filters.push(`status:${params.status}`);
    }
    if (params.fulfillment_status && params.fulfillment_status !== 'any') {
      filters.push(`fulfillment_status:${params.fulfillment_status}`);
    }
    if (params.financial_status && params.financial_status !== 'any') {
      filters.push(`financial_status:${params.financial_status}`);
    }
    if (params.created_at_min) {
      filters.push(`created_at:>='${params.created_at_min}'`);
    }
    if (params.created_at_max) {
      filters.push(`created_at:<='${params.created_at_max}'`);
    }
    if (params.updated_at_min) {
      filters.push(`updated_at:>='${params.updated_at_min}'`);
    }
    if (params.updated_at_max) {
      filters.push(`updated_at:<='${params.updated_at_max}'`);
    }

    const query = filters.length > 0 ? filters.join(' AND ') : undefined;
    const limit = Math.min(params.limit || DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);

    const data = await this.graphql<{
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        edges: Array<{ node: unknown }>;
      };
    }>(GET_ORDERS_QUERY, {
      first: limit,
      query,
    });

    const orders = data.orders.edges.map(e => e.node);
    return mapOrders(orders as Parameters<typeof mapOrders>[0]);
  }

  /**
   * Fetch all orders using cursor-based pagination (GraphQL)
   * This is the recommended approach for Shopify as it handles pagination correctly
   */
  async getAllOrders(params: {
    status?: 'open' | 'closed' | 'cancelled' | 'any';
    created_at_min?: string;
    updated_at_min?: string;
  } = {}): Promise<ShopifyOrder[]> {
    const filters: string[] = [];

    if (params.status && params.status !== 'any') {
      filters.push(`status:${params.status}`);
    }
    if (params.created_at_min) {
      filters.push(`created_at:>='${params.created_at_min}'`);
    }
    if (params.updated_at_min) {
      filters.push(`updated_at:>='${params.updated_at_min}'`);
    }

    const query = filters.length > 0 ? filters.join(' AND ') : undefined;

    console.log(`[Shopify GraphQL] Starting order fetch (${DEFAULT_PAGE_SIZE} per page, cursor-based pagination)...`);
    if (query) {
      console.log(`[Shopify GraphQL] Filter: ${query}`);
    }

    let pageCount = 0;
    const allOrders = await fetchAllPages<unknown>(
      async (cursor) => {
        const data = await this.graphql<{
          orders: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            edges: Array<{ node: unknown }>;
          };
        }>(GET_ORDERS_QUERY, {
          first: DEFAULT_PAGE_SIZE,
          after: cursor,
          query,
        });

        pageCount++;
        const orders = data.orders.edges.map(e => e.node);
        console.log(`[Shopify GraphQL] Page ${pageCount}: Fetched ${orders.length} orders (cursor: ${cursor || 'start'})`);

        return {
          nodes: orders,
          pageInfo: data.orders.pageInfo,
        };
      },
      { delayMs: 500 }
    );

    console.log(`[Shopify GraphQL] Order fetch complete: ${allOrders.length} total orders in ${pageCount} pages`);
    return mapOrders(allOrders as Parameters<typeof mapOrders>[0]);
  }

  /**
   * Fetch a single order by ID
   */
  async getOrder(orderId: number): Promise<ShopifyOrder> {
    const data = await this.graphql<{ order: unknown }>(GET_ORDER_QUERY, {
      id: toGid('Order', orderId),
    });

    return mapOrder(data.order as Parameters<typeof mapOrder>[0]);
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
    const filters: string[] = [];

    if (params.status) {
      filters.push(`status:${params.status}`);
    }
    if (params.product_type) {
      filters.push(`product_type:'${params.product_type}'`);
    }
    if (params.vendor) {
      filters.push(`vendor:'${params.vendor}'`);
    }
    if (params.created_at_min) {
      filters.push(`created_at:>='${params.created_at_min}'`);
    }
    if (params.updated_at_min) {
      filters.push(`updated_at:>='${params.updated_at_min}'`);
    }

    const query = filters.length > 0 ? filters.join(' AND ') : undefined;
    const limit = Math.min(params.limit || DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);

    const data = await this.graphql<{
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        edges: Array<{ node: unknown }>;
      };
    }>(GET_PRODUCTS_QUERY, {
      first: limit,
      query,
    });

    const products = data.products.edges.map(e => e.node);
    return mapProducts(products as Parameters<typeof mapProducts>[0]);
  }

  /**
   * Fetch all products using pagination
   */
  async getAllProducts(params: {
    status?: 'active' | 'archived' | 'draft';
    updated_at_min?: string;
  } = {}): Promise<ShopifyProduct[]> {
    const filters: string[] = [];

    if (params.status) {
      filters.push(`status:${params.status}`);
    }
    if (params.updated_at_min) {
      filters.push(`updated_at:>='${params.updated_at_min}'`);
    }

    const query = filters.length > 0 ? filters.join(' AND ') : undefined;

    const allProducts = await fetchAllPages<unknown>(
      async (cursor) => {
        const data = await this.graphql<{
          products: {
            pageInfo: { hasNextPage: boolean; endCursor: string };
            edges: Array<{ node: unknown }>;
          };
        }>(GET_PRODUCTS_QUERY, {
          first: DEFAULT_PAGE_SIZE,
          after: cursor,
          query,
        });

        return {
          nodes: data.products.edges.map(e => e.node),
          pageInfo: data.products.pageInfo,
        };
      },
      { delayMs: 500 }
    );

    return mapProducts(allProducts as Parameters<typeof mapProducts>[0]);
  }

  /**
   * Fetch a single product by ID
   */
  async getProduct(productId: number): Promise<ShopifyProduct> {
    const data = await this.graphql<{ product: unknown }>(GET_PRODUCT_QUERY, {
      id: toGid('Product', productId),
    });

    return mapProduct(data.product as Parameters<typeof mapProduct>[0]);
  }

  /**
   * Get products updated since a specific date
   */
  async getProductsUpdatedSince(since: Date): Promise<ShopifyProduct[]> {
    console.log('[Shopify GraphQL] getProductsUpdatedSince called with:', {
      since: since.toISOString(),
    });

    try {
      const filteredProducts = await this.getAllProducts({
        updated_at_min: since.toISOString(),
      });
      console.log(`[Shopify GraphQL] ✅ Products updated since: ${filteredProducts.length}`);
      return filteredProducts;
    } catch (error) {
      console.error('[Shopify GraphQL] ❌ ERROR in getProductsUpdatedSince:', error);
      throw error;
    }
  }

  // ============= REFUNDS =============

  /**
   * Fetch refunds for an order (included in order query)
   */
  async getRefunds(orderId: number): Promise<ShopifyRefund[]> {
    const order = await this.getOrder(orderId);
    return order.refunds;
  }

  /**
   * Fetch a single refund
   */
  async getRefund(orderId: number, refundId: number): Promise<ShopifyRefund> {
    const refunds = await this.getRefunds(orderId);
    const refund = refunds.find(r => r.id === refundId);
    if (!refund) {
      throw new Error(`Refund ${refundId} not found for order ${orderId}`);
    }
    return refund;
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
   * Fetch inventory levels for an inventory item
   */
  async getInventoryLevels(inventoryItemId: number): Promise<{ inventory_level: { inventory_item_id: number; location_id: number; available: number }[] }> {
    const data = await this.graphql<{
      inventoryItem: {
        id: string;
        legacyResourceId: string;
        inventoryLevels: {
          edges: Array<{
            node: {
              available: number;
              location: { id: string; legacyResourceId: string };
            };
          }>;
        };
      };
    }>(GET_INVENTORY_LEVELS_QUERY, {
      inventoryItemId: toGid('InventoryItem', inventoryItemId),
    });

    const levels = data.inventoryItem.inventoryLevels.edges.map(e => ({
      inventory_item_id: inventoryItemId,
      location_id: toLegacyId(e.node.location.legacyResourceId || e.node.location.id),
      available: e.node.available,
    }));

    return { inventory_level: levels };
  }

  /**
   * Update inventory level
   */
  async setInventoryLevel(inventoryItemId: number, locationId: number, available: number): Promise<void> {
    await this.graphql(INVENTORY_SET_QUANTITIES_MUTATION, {
      input: {
        name: 'available',
        reason: 'correction',
        quantities: [{
          inventoryItemId: toGid('InventoryItem', inventoryItemId),
          locationId: toGid('Location', locationId),
          quantity: available,
        }],
      },
    });
  }

  // ============= FULFILLMENTS =============

  /**
   * Create a fulfillment for an order
   * Uses the new fulfillmentCreate API (replaces deprecated fulfillmentCreateV2)
   */
  async createFulfillment(orderId: number, fulfillment: {
    location_id?: number;
    tracking_number?: string;
    tracking_company?: string;
    tracking_url?: string;
    line_items?: { id: number; quantity?: number }[];
    notify_customer?: boolean;
    message?: string;
  }): Promise<{ id: number; status: string; tracking_number: string | null }> {
    // Get fulfillment orders for this order
    const fulfillmentOrders = await this.getFulfillmentOrders(orderId);

    // Filter for open/in-progress orders
    const activeFOs = fulfillmentOrders.filter(fo =>
      fo.status === 'OPEN' || fo.status === 'IN_PROGRESS'
    );

    if (activeFOs.length === 0) {
      // Check why there are no active fulfillment orders
      const closedFOs = fulfillmentOrders.filter(fo => fo.status === 'CLOSED');
      if (closedFOs.length > 0) {
        throw new Error('Order already fulfilled');
      }
      const cancelledFOs = fulfillmentOrders.filter(fo => fo.status === 'CANCELLED');
      if (cancelledFOs.length > 0) {
        throw new Error('FulfillmentOrder was cancelled');
      }
      const heldFOs = fulfillmentOrders.filter(fo => fo.status === 'ON_HOLD');
      if (heldFOs.length > 0) {
        const holdReason = heldFOs[0].fulfillmentHolds?.[0]?.reason || 'Unknown';
        throw new Error(`FulfillmentOrder on hold: ${holdReason}`);
      }
      throw new Error(`No open fulfillment orders found for order ${orderId}`);
    }

    // Build fulfillment input for all active fulfillment orders
    const lineItemsByFulfillmentOrder = activeFOs.map(fo => ({
      fulfillmentOrderId: fo.id,
      fulfillmentOrderLineItems: fo.lineItems
        .filter(li => li.remainingQuantity > 0)
        .map(li => {
          // Check if specific line items were requested
          if (fulfillment.line_items) {
            const requested = fulfillment.line_items.find(
              req => req.id === toLegacyId(li.lineItem.legacyResourceId || li.lineItem.id)
            );
            if (requested) {
              return { id: li.id, quantity: requested.quantity || li.remainingQuantity };
            }
            return null;
          }
          return { id: li.id, quantity: li.remainingQuantity };
        })
        .filter(Boolean) as Array<{ id: string; quantity: number }>,
    })).filter(fo => fo.fulfillmentOrderLineItems.length > 0);

    if (lineItemsByFulfillmentOrder.length === 0) {
      throw new Error('No line items available for fulfillment');
    }

    // Build fulfillment input
    const fulfillmentInput: {
      lineItemsByFulfillmentOrder: typeof lineItemsByFulfillmentOrder;
      trackingInfo?: { number: string; company?: string; url?: string };
      notifyCustomer?: boolean;
    } = {
      lineItemsByFulfillmentOrder,
      notifyCustomer: fulfillment.notify_customer ?? true,
    };

    // Add tracking if provided
    if (fulfillment.tracking_number) {
      fulfillmentInput.trackingInfo = {
        number: fulfillment.tracking_number,
        company: fulfillment.tracking_company,
        url: fulfillment.tracking_url,
      };
    }

    const data = await this.graphql<{
      fulfillmentCreate: {
        fulfillment: {
          id: string;
          legacyResourceId: string;
          status: string;
          trackingInfo: Array<{ number: string }>;
        };
        userErrors: Array<{ field: string[]; message: string; code?: string }>;
      };
    }>(FULFILLMENT_CREATE_MUTATION, {
      fulfillment: fulfillmentInput,
      message: fulfillment.message,
    });

    if (data.fulfillmentCreate.userErrors.length > 0) {
      const errors = data.fulfillmentCreate.userErrors.map(e => e.message).join(', ');
      throw new Error(`Fulfillment creation failed: ${errors}`);
    }

    const created = data.fulfillmentCreate.fulfillment;
    return {
      id: toLegacyId(created.legacyResourceId || created.id),
      status: created.status.toLowerCase(),
      tracking_number: created.trackingInfo?.[0]?.number || null,
    };
  }

  /**
   * Update tracking information for an existing fulfillment
   */
  async updateFulfillmentTracking(
    fulfillmentId: string | number,
    tracking: {
      number: string;
      company?: string;
      url?: string;
    },
    notifyCustomer: boolean = true
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const gid = typeof fulfillmentId === 'string' && fulfillmentId.startsWith('gid://')
        ? fulfillmentId
        : toGid('Fulfillment', fulfillmentId);

      const data = await this.graphql<{
        fulfillmentTrackingInfoUpdate: {
          fulfillment: { id: string };
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(FULFILLMENT_TRACKING_INFO_UPDATE_MUTATION, {
        fulfillmentId: gid,
        trackingInfoInput: tracking,
        notifyCustomer,
      });

      if (data.fulfillmentTrackingInfoUpdate.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentTrackingInfoUpdate.userErrors.map(e => e.message).join(', '),
        };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Create a fulfillment in Shopify with tracking info
   * This is a convenience method that accepts a GID and handles the fulfillment creation
   * with tracking information to mark an order as fulfilled
   *
   * @param params.orderId - Shopify Order GID (e.g., "gid://shopify/Order/12345")
   * @param params.trackingNumber - Tracking number from carrier
   * @param params.trackingUrl - Full tracking URL
   * @param params.trackingCompany - Carrier name (e.g., "DHL", "UPS")
   */
  async createFulfillmentWithTracking(params: {
    orderId: string;
    trackingNumber?: string;
    trackingUrl?: string;
    trackingCompany?: string;
  }): Promise<{ success: boolean; fulfillment?: any; error?: string }> {
    try {
      // Extract numeric ID from GID
      const numericId = extractNumericId(params.orderId);

      // Use the existing createFulfillment method
      const result = await this.createFulfillment(numericId, {
        tracking_number: params.trackingNumber,
        tracking_url: params.trackingUrl,
        tracking_company: params.trackingCompany,
        notify_customer: true, // Send shipment notification email to customer
      });

      return {
        success: true,
        fulfillment: result,
      };
    } catch (error: any) {
      // Check for already fulfilled error
      if (error.message?.includes('already fulfilled')) {
        console.log(`[Shopify] Order ${params.orderId} is already fulfilled`);
        return { success: true, fulfillment: null };
      }

      console.error(`[Shopify] Failed to create fulfillment with tracking:`, error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // ============= FULFILLMENT ORDERS =============

  /**
   * FulfillmentOrder status enum
   */
  static FulfillmentOrderStatus = {
    OPEN: 'OPEN',
    IN_PROGRESS: 'IN_PROGRESS',
    SCHEDULED: 'SCHEDULED',
    ON_HOLD: 'ON_HOLD',
    CLOSED: 'CLOSED',
    CANCELLED: 'CANCELLED',
  } as const;

  /**
   * FulfillmentOrder request status enum (for 3PL flow)
   */
  static FulfillmentOrderRequestStatus = {
    UNSUBMITTED: 'UNSUBMITTED',
    SUBMITTED: 'SUBMITTED',
    ACCEPTED: 'ACCEPTED',
    REJECTED: 'REJECTED',
    CANCELLATION_REQUESTED: 'CANCELLATION_REQUESTED',
    CANCELLATION_ACCEPTED: 'CANCELLATION_ACCEPTED',
    CANCELLATION_REJECTED: 'CANCELLATION_REJECTED',
    CLOSED: 'CLOSED',
  } as const;

  /**
   * FulfillmentOrder hold reason enum
   */
  static FulfillmentHoldReason = {
    AWAITING_PAYMENT: 'AWAITING_PAYMENT',
    HIGH_RISK_OF_FRAUD: 'HIGH_RISK_OF_FRAUD',
    INCORRECT_ADDRESS: 'INCORRECT_ADDRESS',
    INVENTORY_OUT_OF_STOCK: 'INVENTORY_OUT_OF_STOCK',
    OTHER: 'OTHER',
  } as const;

  /**
   * FulfillmentOrder rejection reason enum (for 3PL flow)
   */
  static FulfillmentRejectionReason = {
    INELIGIBLE_PRODUCT: 'INELIGIBLE_PRODUCT',
    INVENTORY_OUT_OF_STOCK: 'INVENTORY_OUT_OF_STOCK',
    UNDELIVERABLE_DESTINATION: 'UNDELIVERABLE_DESTINATION',
    OTHER: 'OTHER',
  } as const;

  /**
   * Get fulfillment orders for an order with full details
   */
  async getFulfillmentOrders(orderId: number): Promise<Array<{
    id: string;
    status: string;
    requestStatus: string;
    createdAt?: string;
    updatedAt?: string;
    fulfillAt?: string;
    fulfillBy?: string;
    assignedLocation?: {
      location: { id: string; legacyResourceId?: string; name: string };
    };
    destination?: {
      firstName?: string;
      lastName?: string;
      address1?: string;
      city?: string;
      zip?: string;
      countryCode?: string;
    };
    lineItems: Array<{
      id: string;
      totalQuantity: number;
      remainingQuantity: number;
      lineItem: { id: string; legacyResourceId?: string; sku?: string };
    }>;
    fulfillmentHolds?: Array<{ reason: string; reasonNotes?: string }>;
    supportedActions?: Array<{ action: string }>;
  }>> {
    const data = await this.graphql<{
      order: {
        fulfillmentOrders: {
          edges: Array<{
            node: {
              id: string;
              status: string;
              requestStatus: string;
              createdAt?: string;
              updatedAt?: string;
              fulfillAt?: string;
              fulfillBy?: string;
              assignedLocation?: {
                location: { id: string; legacyResourceId?: string; name: string };
              };
              destination?: {
                firstName?: string;
                lastName?: string;
                company?: string;
                address1?: string;
                address2?: string;
                city?: string;
                province?: string;
                zip?: string;
                countryCode?: string;
                phone?: string;
                email?: string;
              };
              lineItems: {
                edges: Array<{
                  node: {
                    id: string;
                    totalQuantity: number;
                    remainingQuantity: number;
                    lineItem: { id: string; legacyResourceId?: string; sku?: string; title?: string };
                  };
                }>;
              };
              fulfillmentHolds?: Array<{ reason: string; reasonNotes?: string }>;
              supportedActions?: Array<{ action: string }>;
            };
          }>;
        };
      };
    }>(GET_ORDER_FULFILLMENT_ORDERS_QUERY, {
      orderId: toGid('Order', orderId),
    });

    return data.order.fulfillmentOrders.edges.map(e => ({
      ...e.node,
      lineItems: e.node.lineItems?.edges?.map(li => li.node) || [],
    }));
  }

  /**
   * Get a single fulfillment order by ID
   */
  async getFulfillmentOrder(fulfillmentOrderId: string): Promise<{
    id: string;
    status: string;
    requestStatus: string;
    order?: { id: string; legacyResourceId?: string; name?: string };
    lineItems: Array<{ id: string; remainingQuantity: number; lineItem: { id: string; sku?: string } }>;
  } | null> {
    const gid = fulfillmentOrderId.startsWith('gid://')
      ? fulfillmentOrderId
      : toGid('FulfillmentOrder', fulfillmentOrderId);

    const data = await this.graphql<{
      node: {
        id: string;
        status: string;
        requestStatus: string;
        order?: { id: string; legacyResourceId?: string; name?: string };
        lineItems?: {
          edges: Array<{
            node: { id: string; remainingQuantity: number; lineItem: { id: string; sku?: string } };
          }>;
        };
      } | null;
    }>(GET_FULFILLMENT_ORDER_QUERY, { id: gid });

    if (!data.node) return null;

    return {
      ...data.node,
      lineItems: data.node.lineItems?.edges?.map(li => li.node) || [],
    };
  }

  /**
   * Place a fulfillment order on hold
   */
  async holdFulfillmentOrder(
    fulfillmentOrderId: string,
    reason: 'AWAITING_PAYMENT' | 'HIGH_RISK_OF_FRAUD' | 'INCORRECT_ADDRESS' | 'INVENTORY_OUT_OF_STOCK' | 'OTHER',
    reasonNotes?: string,
    notifyMerchant: boolean = true
  ): Promise<{ success: boolean; fulfillmentOrder?: { id: string; status: string }; error?: string }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderHold: {
          fulfillmentOrder: { id: string; status: string; requestStatus: string };
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_HOLD_MUTATION, {
        id: gid,
        fulfillmentHold: {
          reason,
          reasonNotes,
          notifyMerchant,
        },
      });

      if (data.fulfillmentOrderHold.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderHold.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        fulfillmentOrder: data.fulfillmentOrderHold.fulfillmentOrder,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Release a hold on a fulfillment order
   */
  async releaseHoldFulfillmentOrder(
    fulfillmentOrderId: string
  ): Promise<{ success: boolean; fulfillmentOrder?: { id: string; status: string }; error?: string }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderReleaseHold: {
          fulfillmentOrder: { id: string; status: string; requestStatus: string };
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION, { id: gid });

      if (data.fulfillmentOrderReleaseHold.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderReleaseHold.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        fulfillmentOrder: data.fulfillmentOrderReleaseHold.fulfillmentOrder,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Move a fulfillment order to a different location
   */
  async moveFulfillmentOrder(
    fulfillmentOrderId: string,
    newLocationId: number
  ): Promise<{
    success: boolean;
    movedFulfillmentOrder?: { id: string; status: string };
    remainingFulfillmentOrder?: { id: string; status: string };
    error?: string;
  }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderMove: {
          movedFulfillmentOrder: { id: string; status: string };
          remainingFulfillmentOrder: { id: string; status: string } | null;
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_MOVE_MUTATION, {
        id: gid,
        newLocationId: toGid('Location', newLocationId),
      });

      if (data.fulfillmentOrderMove.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderMove.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        movedFulfillmentOrder: data.fulfillmentOrderMove.movedFulfillmentOrder,
        remainingFulfillmentOrder: data.fulfillmentOrderMove.remainingFulfillmentOrder || undefined,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Request cancellation of a fulfillment order
   */
  async requestCancellationFulfillmentOrder(
    fulfillmentOrderId: string,
    message?: string
  ): Promise<{ success: boolean; fulfillmentOrder?: { id: string; status: string }; error?: string }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderSubmitCancellationRequest: {
          fulfillmentOrder: { id: string; status: string; requestStatus: string };
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_SUBMIT_CANCELLATION_REQUEST_MUTATION, {
        id: gid,
        message,
      });

      if (data.fulfillmentOrderSubmitCancellationRequest.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderSubmitCancellationRequest.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        fulfillmentOrder: data.fulfillmentOrderSubmitCancellationRequest.fulfillmentOrder,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // ============= 3PL FLOW METHODS =============

  /**
   * Submit fulfillment request to 3PL service (e.g., JTL FFN)
   * Call this when an order is ready to be sent to the fulfillment service
   */
  async submitFulfillmentRequest(
    fulfillmentOrderId: string,
    options?: {
      message?: string;
      notifyCustomer?: boolean;
      lineItems?: Array<{ id: string; quantity: number }>;
    }
  ): Promise<{
    success: boolean;
    submittedFulfillmentOrder?: { id: string; status: string; requestStatus: string };
    unsubmittedFulfillmentOrder?: { id: string; status: string; requestStatus: string };
    error?: string;
  }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderSubmitFulfillmentRequest: {
          submittedFulfillmentOrder: { id: string; status: string; requestStatus: string };
          unsubmittedFulfillmentOrder: { id: string; status: string; requestStatus: string } | null;
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_SUBMIT_FULFILLMENT_REQUEST_MUTATION, {
        id: gid,
        message: options?.message,
        notifyCustomer: options?.notifyCustomer ?? false,
        fulfillmentOrderLineItems: options?.lineItems,
      });

      if (data.fulfillmentOrderSubmitFulfillmentRequest.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderSubmitFulfillmentRequest.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        submittedFulfillmentOrder: data.fulfillmentOrderSubmitFulfillmentRequest.submittedFulfillmentOrder,
        unsubmittedFulfillmentOrder: data.fulfillmentOrderSubmitFulfillmentRequest.unsubmittedFulfillmentOrder || undefined,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Accept a fulfillment request (as 3PL/fulfillment service)
   * Call this when JTL FFN accepts an order for fulfillment
   */
  async acceptFulfillmentRequest(
    fulfillmentOrderId: string,
    message?: string
  ): Promise<{ success: boolean; fulfillmentOrder?: { id: string; status: string; requestStatus: string }; error?: string }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderAcceptFulfillmentRequest: {
          fulfillmentOrder: { id: string; status: string; requestStatus: string };
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_ACCEPT_FULFILLMENT_REQUEST_MUTATION, {
        id: gid,
        message,
      });

      if (data.fulfillmentOrderAcceptFulfillmentRequest.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderAcceptFulfillmentRequest.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        fulfillmentOrder: data.fulfillmentOrderAcceptFulfillmentRequest.fulfillmentOrder,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Reject a fulfillment request (as 3PL/fulfillment service)
   * Call this when JTL FFN rejects an order
   */
  async rejectFulfillmentRequest(
    fulfillmentOrderId: string,
    reason: 'INELIGIBLE_PRODUCT' | 'INVENTORY_OUT_OF_STOCK' | 'UNDELIVERABLE_DESTINATION' | 'OTHER',
    message?: string,
    lineItems?: Array<{ id: string; quantity: number }>
  ): Promise<{ success: boolean; fulfillmentOrder?: { id: string; status: string; requestStatus: string }; error?: string }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderRejectFulfillmentRequest: {
          fulfillmentOrder: { id: string; status: string; requestStatus: string };
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_REJECT_FULFILLMENT_REQUEST_MUTATION, {
        id: gid,
        reason,
        message,
        lineItems,
      });

      if (data.fulfillmentOrderRejectFulfillmentRequest.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderRejectFulfillmentRequest.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        fulfillmentOrder: data.fulfillmentOrderRejectFulfillmentRequest.fulfillmentOrder,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Accept a cancellation request (as 3PL)
   */
  async acceptCancellationRequest(
    fulfillmentOrderId: string,
    message?: string
  ): Promise<{ success: boolean; fulfillmentOrder?: { id: string; status: string; requestStatus: string }; error?: string }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderAcceptCancellationRequest: {
          fulfillmentOrder: { id: string; status: string; requestStatus: string };
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_ACCEPT_CANCELLATION_REQUEST_MUTATION, {
        id: gid,
        message,
      });

      if (data.fulfillmentOrderAcceptCancellationRequest.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderAcceptCancellationRequest.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        fulfillmentOrder: data.fulfillmentOrderAcceptCancellationRequest.fulfillmentOrder,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Reject a cancellation request (as 3PL)
   */
  async rejectCancellationRequest(
    fulfillmentOrderId: string,
    message?: string
  ): Promise<{ success: boolean; fulfillmentOrder?: { id: string; status: string; requestStatus: string }; error?: string }> {
    try {
      const gid = fulfillmentOrderId.startsWith('gid://')
        ? fulfillmentOrderId
        : toGid('FulfillmentOrder', fulfillmentOrderId);

      const data = await this.graphql<{
        fulfillmentOrderRejectCancellationRequest: {
          fulfillmentOrder: { id: string; status: string; requestStatus: string };
          userErrors: Array<{ field: string[]; message: string; code?: string }>;
        };
      }>(FULFILLMENT_ORDER_REJECT_CANCELLATION_REQUEST_MUTATION, {
        id: gid,
        message,
      });

      if (data.fulfillmentOrderRejectCancellationRequest.userErrors.length > 0) {
        return {
          success: false,
          error: data.fulfillmentOrderRejectCancellationRequest.userErrors.map(e => e.message).join(', '),
        };
      }

      return {
        success: true,
        fulfillmentOrder: data.fulfillmentOrderRejectCancellationRequest.fulfillmentOrder,
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // ============= PRODUCT MUTATIONS =============

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
    // Build GraphQL input
    const input: Record<string, unknown> = {
      title: product.title,
      descriptionHtml: product.body_html,
      vendor: product.vendor,
      productType: product.product_type,
      tags: product.tags ? product.tags.split(',').map(t => t.trim()) : undefined,
      status: product.status ? getGraphQLProductStatus(product.status) : 'DRAFT',
    };

    // Add variants if provided
    if (product.variants && product.variants.length > 0) {
      input.variants = product.variants.map(v => ({
        price: v.price,
        sku: v.sku,
        barcode: v.barcode,
        weight: v.weight,
        weightUnit: v.weight_unit ? getGraphQLWeightUnit(v.weight_unit) : undefined,
        inventoryManagement: v.inventory_management === 'shopify' ? 'SHOPIFY' : undefined,
      }));
    }

    const data = await this.graphql<{
      productCreate: {
        product: unknown;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(PRODUCT_CREATE_MUTATION, { input });

    if (data.productCreate.userErrors.length > 0) {
      throw new Error(`Product creation failed: ${data.productCreate.userErrors.map(e => e.message).join(', ')}`);
    }

    return mapProduct(data.productCreate.product as Parameters<typeof mapProduct>[0]);
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
    const input: Record<string, unknown> = {
      id: toGid('Product', productId),
    };

    if (updates.title !== undefined) input.title = updates.title;
    if (updates.body_html !== undefined) input.descriptionHtml = updates.body_html;
    if (updates.vendor !== undefined) input.vendor = updates.vendor;
    if (updates.product_type !== undefined) input.productType = updates.product_type;
    if (updates.tags !== undefined) input.tags = updates.tags.split(',').map(t => t.trim());
    if (updates.status !== undefined) input.status = getGraphQLProductStatus(updates.status);

    const data = await this.graphql<{
      productUpdate: {
        product: unknown;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(PRODUCT_UPDATE_MUTATION, { input });

    if (data.productUpdate.userErrors.length > 0) {
      throw new Error(`Product update failed: ${data.productUpdate.userErrors.map(e => e.message).join(', ')}`);
    }

    return mapProduct(data.productUpdate.product as Parameters<typeof mapProduct>[0]);
  }

  /**
   * Delete a product from Shopify
   */
  async deleteProduct(productId: number): Promise<void> {
    const data = await this.graphql<{
      productDelete: {
        deletedProductId: string;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(PRODUCT_DELETE_MUTATION, {
      input: { id: toGid('Product', productId) },
    });

    if (data.productDelete.userErrors.length > 0) {
      throw new Error(`Product deletion failed: ${data.productDelete.userErrors.map(e => e.message).join(', ')}`);
    }
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
    const input: Record<string, unknown> = {
      id: toGid('ProductVariant', variantId),
    };

    if (updates.price !== undefined) input.price = updates.price;
    if (updates.sku !== undefined) input.sku = updates.sku;
    if (updates.barcode !== undefined) input.barcode = updates.barcode;
    if (updates.weight !== undefined) input.weight = updates.weight;
    if (updates.weight_unit !== undefined) input.weightUnit = getGraphQLWeightUnit(updates.weight_unit);

    const data = await this.graphql<{
      productVariantUpdate: {
        productVariant: {
          id: string;
          legacyResourceId: string;
          title: string;
          price: string;
          sku: string;
          barcode: string;
          weight: number;
          weightUnit: string;
          inventoryQuantity: number;
        };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(PRODUCT_VARIANT_UPDATE_MUTATION, { input });

    if (data.productVariantUpdate.userErrors.length > 0) {
      throw new Error(`Variant update failed: ${data.productVariantUpdate.userErrors.map(e => e.message).join(', ')}`);
    }

    const v = data.productVariantUpdate.productVariant;
    return {
      id: toLegacyId(v.legacyResourceId || v.id),
      product_id: 0, // Not returned by mutation
      title: v.title,
      price: v.price,
      sku: v.sku || '',
      barcode: v.barcode || null,
      grams: v.weight ? Math.round(v.weight * (v.weightUnit === 'KILOGRAMS' ? 1000 : 1)) : 0,
      weight: v.weight || 0,
      weight_unit: v.weightUnit?.toLowerCase() || 'g',
      inventory_quantity: v.inventoryQuantity || 0,
      inventory_item_id: 0, // Not returned by mutation
    };
  }

  // ============= ORDER MUTATIONS =============

  /**
   * Create a draft order in Shopify
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
    const input: Record<string, unknown> = {
      lineItems: draftOrder.line_items.map(li => ({
        variantId: li.variant_id ? toGid('ProductVariant', li.variant_id) : undefined,
        title: li.title,
        quantity: li.quantity,
        originalUnitPrice: li.price,
        sku: li.sku,
      })),
      note: draftOrder.note,
      tags: draftOrder.tags ? draftOrder.tags.split(',').map(t => t.trim()) : undefined,
    };

    if (draftOrder.customer) {
      input.customerId = draftOrder.customer.id ? toGid('Customer', draftOrder.customer.id) : undefined;
      input.email = draftOrder.customer.email;
    }

    if (draftOrder.shipping_address) {
      input.shippingAddress = {
        firstName: draftOrder.shipping_address.first_name,
        lastName: draftOrder.shipping_address.last_name,
        address1: draftOrder.shipping_address.address1,
        address2: draftOrder.shipping_address.address2,
        city: draftOrder.shipping_address.city,
        province: draftOrder.shipping_address.province,
        country: draftOrder.shipping_address.country,
        zip: draftOrder.shipping_address.zip,
        phone: draftOrder.shipping_address.phone,
      };
    }

    if (draftOrder.billing_address) {
      input.billingAddress = {
        firstName: draftOrder.billing_address.first_name,
        lastName: draftOrder.billing_address.last_name,
        address1: draftOrder.billing_address.address1,
        address2: draftOrder.billing_address.address2,
        city: draftOrder.billing_address.city,
        province: draftOrder.billing_address.province,
        country: draftOrder.billing_address.country,
        zip: draftOrder.billing_address.zip,
        phone: draftOrder.billing_address.phone,
      };
    }

    if (draftOrder.shipping_line) {
      input.shippingLine = {
        title: draftOrder.shipping_line.title,
        price: draftOrder.shipping_line.price,
      };
    }

    const data = await this.graphql<{
      draftOrderCreate: {
        draftOrder: {
          id: string;
          legacyResourceId: string;
          status: string;
          invoiceUrl: string;
          order: { id: string; legacyResourceId: string } | null;
        };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(DRAFT_ORDER_CREATE_MUTATION, { input });

    if (data.draftOrderCreate.userErrors.length > 0) {
      throw new Error(`Draft order creation failed: ${data.draftOrderCreate.userErrors.map(e => e.message).join(', ')}`);
    }

    const created = data.draftOrderCreate.draftOrder;
    return {
      id: toLegacyId(created.legacyResourceId || created.id),
      order_id: created.order ? toLegacyId(created.order.legacyResourceId || created.order.id) : null,
      status: created.status.toLowerCase(),
      invoice_url: created.invoiceUrl,
    };
  }

  /**
   * Complete a draft order (converts it to a real order)
   */
  async completeDraftOrder(draftOrderId: number, paymentPending = false): Promise<{ id: number; order_id: number }> {
    const data = await this.graphql<{
      draftOrderComplete: {
        draftOrder: {
          id: string;
          legacyResourceId: string;
          order: { id: string; legacyResourceId: string };
        };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(DRAFT_ORDER_COMPLETE_MUTATION, {
      id: toGid('DraftOrder', draftOrderId),
      paymentPending,
    });

    if (data.draftOrderComplete.userErrors.length > 0) {
      throw new Error(`Draft order completion failed: ${data.draftOrderComplete.userErrors.map(e => e.message).join(', ')}`);
    }

    const completed = data.draftOrderComplete.draftOrder;
    return {
      id: toLegacyId(completed.legacyResourceId || completed.id),
      order_id: toLegacyId(completed.order.legacyResourceId || completed.order.id),
    };
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
    const input: Record<string, unknown> = {
      id: toGid('Order', orderId),
    };

    if (updates.note !== undefined) input.note = updates.note;
    if (updates.tags !== undefined) input.tags = updates.tags.split(',').map(t => t.trim());
    if (updates.email !== undefined) input.email = updates.email;

    if (updates.shipping_address) {
      input.shippingAddress = {
        firstName: updates.shipping_address.first_name,
        lastName: updates.shipping_address.last_name,
        address1: updates.shipping_address.address1,
        address2: updates.shipping_address.address2,
        city: updates.shipping_address.city,
        province: updates.shipping_address.province,
        country: updates.shipping_address.country,
        zip: updates.shipping_address.zip,
        phone: updates.shipping_address.phone,
      };
    }

    const data = await this.graphql<{
      orderUpdate: {
        order: unknown;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(ORDER_UPDATE_MUTATION, { input });

    if (data.orderUpdate.userErrors.length > 0) {
      throw new Error(`Order update failed: ${data.orderUpdate.userErrors.map(e => e.message).join(', ')}`);
    }

    // Fetch full order since update only returns partial data
    return this.getOrder(orderId);
  }

  /**
   * Cancel an order in Shopify
   */
  async cancelOrder(orderId: number, options?: {
    reason?: 'customer' | 'fraud' | 'inventory' | 'declined' | 'other';
    email?: boolean;
    restock?: boolean;
  }): Promise<ShopifyOrder> {
    const data = await this.graphql<{
      orderCancel: {
        job: { id: string; done: boolean };
        orderCancelUserErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    }>(ORDER_CANCEL_MUTATION, {
      orderId: toGid('Order', orderId),
      notifyCustomer: options?.email ?? false,
      reason: options?.reason ? getGraphQLCancelReason(options.reason) : 'OTHER',
      restock: options?.restock ?? false,
    });

    if (data.orderCancel.orderCancelUserErrors.length > 0) {
      throw new Error(`Order cancellation failed: ${data.orderCancel.orderCancelUserErrors.map(e => e.message).join(', ')}`);
    }

    // Fetch updated order
    return this.getOrder(orderId);
  }

  /**
   * Close an order in Shopify
   */
  async closeOrder(orderId: number): Promise<ShopifyOrder> {
    const data = await this.graphql<{
      orderClose: {
        order: { id: string };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(ORDER_CLOSE_MUTATION, {
      input: { id: toGid('Order', orderId) },
    });

    if (data.orderClose.userErrors.length > 0) {
      throw new Error(`Order close failed: ${data.orderClose.userErrors.map(e => e.message).join(', ')}`);
    }

    return this.getOrder(orderId);
  }

  /**
   * Reopen a closed order
   */
  async reopenOrder(orderId: number): Promise<ShopifyOrder> {
    const data = await this.graphql<{
      orderOpen: {
        order: { id: string };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(ORDER_OPEN_MUTATION, {
      input: { id: toGid('Order', orderId) },
    });

    if (data.orderOpen.userErrors.length > 0) {
      throw new Error(`Order reopen failed: ${data.orderOpen.userErrors.map(e => e.message).join(', ')}`);
    }

    return this.getOrder(orderId);
  }

  // ============= REFUND MUTATIONS =============

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
    const input: Record<string, unknown> = {
      orderId: toGid('Order', orderId),
      notify: refund.notify ?? false,
      note: refund.note,
    };

    if (refund.shipping) {
      input.shipping = {
        fullRefund: refund.shipping.full_refund,
        amount: refund.shipping.amount,
      };
    }

    if (refund.refund_line_items) {
      input.refundLineItems = refund.refund_line_items.map(rli => ({
        lineItemId: toGid('LineItem', rli.line_item_id),
        quantity: rli.quantity,
        restockType: rli.restock_type ? getGraphQLRestockType(rli.restock_type) : 'NO_RESTOCK',
      }));
    }

    if (refund.transactions) {
      input.transactions = refund.transactions.map(t => ({
        parentId: toGid('OrderTransaction', t.parent_id),
        amount: t.amount,
        kind: 'REFUND',
        gateway: t.gateway,
      }));
    }

    const data = await this.graphql<{
      refundCreate: {
        refund: unknown;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(REFUND_CREATE_MUTATION, { input });

    if (data.refundCreate.userErrors.length > 0) {
      throw new Error(`Refund creation failed: ${data.refundCreate.userErrors.map(e => e.message).join(', ')}`);
    }

    return mapRefund(data.refundCreate.refund as Parameters<typeof mapRefund>[0]);
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
    const refundLineItems = calculation.refund_line_items?.map(rli => ({
      lineItemId: toGid('LineItem', rli.line_item_id),
      quantity: rli.quantity,
    }));

    const data = await this.graphql<{
      order: {
        suggestedRefund: {
          amount: string;
          subtotal: string;
          totalTax: string;
          shipping: { amount: string };
          refundLineItems: Array<{
            lineItem: { id: string; legacyResourceId: string };
            quantity: number;
            subtotal: string;
          }>;
        };
      };
    }>(GET_SUGGESTED_REFUND_QUERY, {
      orderId: toGid('Order', orderId),
      refundLineItems,
      shippingFullRefund: calculation.shipping?.full_refund,
      shippingAmount: calculation.shipping?.amount,
    });

    return {
      shipping: { amount: data.order.suggestedRefund.shipping.amount },
      refund_line_items: data.order.suggestedRefund.refundLineItems.map(rli => ({
        line_item_id: toLegacyId(rli.lineItem.legacyResourceId || rli.lineItem.id),
        quantity: rli.quantity,
        subtotal: rli.subtotal,
      })),
    };
  }

  // ============= WEBHOOKS =============

  /**
   * Register a webhook
   */
  async createWebhook(topic: string, address: string, format: 'json' | 'xml' = 'json'): Promise<{ id: number; topic: string; address: string }> {
    const graphqlTopic = getGraphQLWebhookTopic(topic);

    const data = await this.graphql<{
      webhookSubscriptionCreate: {
        webhookSubscription: {
          id: string;
          legacyResourceId: string;
          topic: string;
          endpoint: { callbackUrl: string };
        };
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(WEBHOOK_SUBSCRIPTION_CREATE_MUTATION, {
      topic: graphqlTopic,
      webhookSubscription: {
        callbackUrl: address,
        format: format.toUpperCase(),
      },
    });

    if (data.webhookSubscriptionCreate.userErrors.length > 0) {
      throw new Error(`Webhook creation failed: ${data.webhookSubscriptionCreate.userErrors.map(e => e.message).join(', ')}`);
    }

    const webhook = data.webhookSubscriptionCreate.webhookSubscription;
    return {
      id: toLegacyId(webhook.legacyResourceId || webhook.id),
      topic: topic, // Return REST topic format
      address: webhook.endpoint.callbackUrl,
    };
  }

  /**
   * List all webhooks
   */
  async getWebhooks(): Promise<{ id: number; topic: string; address: string }[]> {
    const data = await this.graphql<{
      webhookSubscriptions: {
        edges: Array<{
          node: {
            id: string;
            legacyResourceId: string;
            topic: string;
            endpoint: { callbackUrl: string };
          };
        }>;
      };
    }>(GET_WEBHOOKS_QUERY, { first: 100 });

    // Map GraphQL topic back to REST format
    const topicReverseMap: Record<string, string> = {};
    for (const [rest, gql] of Object.entries({
      'orders/create': 'ORDERS_CREATE',
      'orders/updated': 'ORDERS_UPDATED',
      'orders/cancelled': 'ORDERS_CANCELLED',
      'orders/fulfilled': 'ORDERS_FULFILLED',
      'products/create': 'PRODUCTS_CREATE',
      'products/update': 'PRODUCTS_UPDATE',
      'products/delete': 'PRODUCTS_DELETE',
      'refunds/create': 'REFUNDS_CREATE',
      'inventory_levels/update': 'INVENTORY_LEVELS_UPDATE',
    })) {
      topicReverseMap[gql] = rest;
    }

    return data.webhookSubscriptions.edges.map(e => ({
      id: toLegacyId(e.node.legacyResourceId || e.node.id),
      topic: topicReverseMap[e.node.topic] || e.node.topic.toLowerCase().replace(/_/g, '/'),
      address: e.node.endpoint.callbackUrl,
    }));
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: number): Promise<void> {
    const data = await this.graphql<{
      webhookSubscriptionDelete: {
        deletedWebhookSubscriptionId: string;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(WEBHOOK_SUBSCRIPTION_DELETE_MUTATION, {
      id: toGid('WebhookSubscription', webhookId),
    });

    if (data.webhookSubscriptionDelete.userErrors.length > 0) {
      throw new Error(`Webhook deletion failed: ${data.webhookSubscriptionDelete.userErrors.map(e => e.message).join(', ')}`);
    }
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
      const data = await this.graphql<{
        shop: {
          name: string;
          myshopifyDomain: string;
        };
      }>(GET_SHOP_QUERY);

      return {
        success: true,
        message: 'Connection successful',
        shopInfo: {
          name: data.shop.name,
          domain: data.shop.myshopifyDomain,
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
   * Verify webhook signature (static method - same as REST)
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

  // ============= OAUTH HELPERS (Static - same as REST) =============

  static isValidShopDomain(shopDomain: string): boolean {
    if (!shopDomain) return false;
    const cleanDomain = shopDomain.replace(/^https?:\/\//, '').trim().toLowerCase();
    const pattern = /^[a-z0-9][a-z0-9\-]*\.myshopify\.com$/;
    return pattern.test(cleanDomain);
  }

  static verifyOAuthHmac(
    queryParams: Record<string, string>,
    hmac: string,
    clientSecret: string
  ): boolean {
    if (!hmac || !clientSecret) return false;

    const params = { ...queryParams };
    delete params.hmac;

    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');

    const computedHmac = crypto
      .createHmac('sha256', clientSecret)
      .update(sortedParams)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(hmac, 'hex'),
        Buffer.from(computedHmac, 'hex')
      );
    } catch {
      return false;
    }
  }

  static isValidOAuthTimestamp(timestamp: string | number): boolean {
    const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;
    if (isNaN(ts)) return false;

    const now = Math.floor(Date.now() / 1000);
    const fiveMinutes = 5 * 60;
    return Math.abs(now - ts) <= fiveMinutes;
  }

  static generateOAuthNonce(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  static generateAuthorizationUrl(params: {
    shopDomain: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
  }): string {
    const { shopDomain, clientId, redirectUri, scopes, state } = params;
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

  static async exchangeCodeForToken(params: {
    shopDomain: string;
    clientId: string;
    clientSecret: string;
    code: string;
  }): Promise<{ accessToken: string; scope: string }> {
    const { shopDomain, clientId, clientSecret, code } = params;
    const cleanDomain = shopDomain.replace(/^https?:\/\//, '').trim();
    const tokenUrl = `https://${cleanDomain}/admin/oauth/access_token`;

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const data = (await response.json()) as { access_token: string; scope: string };
    return {
      accessToken: data.access_token,
      scope: data.scope,
    };
  }

  static validateOAuthState(state: string, expectedState: string): boolean {
    return state && expectedState ? state === expectedState : false;
  }

  // ============= SHIPPING =============

  /**
   * Get shipping methods (simplified for GraphQL - uses delivery profiles)
   */
  async getShippingZones(): Promise<Array<{
    id: number;
    name: string;
    countries: Array<{ code: string; name: string }>;
    price_based_shipping_rates: Array<{ id: number; name: string; price: string }>;
    weight_based_shipping_rates: Array<{ id: number; name: string; price: string }>;
    carrier_shipping_rate_providers: Array<{
      id: number;
      carrier_service_id: number;
      flat_modifier: string;
      percent_modifier: number;
      service_filter: Record<string, string>;
      shipping_zone_id: number;
    }>;
  }>> {
    console.log(`[Shopify GraphQL] getShippingZones: Fetching REST fallback from ${this.credentials.shopDomain}...`);
    const response = await this.rest<{ shipping_zones: Array<any> }>('/shipping_zones.json');
    const zones = response.shipping_zones || [];
    console.log(`[Shopify GraphQL] getShippingZones: Received ${zones.length} zones via REST fallback`);
    return zones;
  }

  async getShippingMethods(): Promise<Array<{
    id: string;
    name: string;
    type: 'price_based' | 'weight_based' | 'carrier';
    zoneId: number;
    zoneName: string;
  }>> {
    try {
      const methods: Array<{
        id: string;
        name: string;
        type: 'price_based' | 'weight_based' | 'carrier';
        zoneId: number;
        zoneName: string;
      }> = [];

      const zones = await this.getShippingZones();
      for (const zone of zones) {
        for (const rate of zone.price_based_shipping_rates || []) {
          methods.push({
            id: `price_${rate.id}`,
            name: rate.name,
            type: 'price_based',
            zoneId: zone.id,
            zoneName: zone.name,
          });
        }

        for (const rate of zone.weight_based_shipping_rates || []) {
          methods.push({
            id: `weight_${rate.id}`,
            name: rate.name,
            type: 'weight_based',
            zoneId: zone.id,
            zoneName: zone.name,
          });
        }

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

      // Keep behavior aligned with existing REST service: dedupe by name
      const uniqueMethods = new Map<string, typeof methods[0]>();
      for (const method of methods) {
        if (!uniqueMethods.has(method.name)) {
          uniqueMethods.set(method.name, method);
        }
      }

      const result = Array.from(uniqueMethods.values());
      console.log(`[Shopify GraphQL] getShippingMethods: Returning ${result.length} unique methods via REST fallback`);
      return result;
    } catch (error) {
      console.error('[Shopify GraphQL] Error fetching shipping methods:', error);
      return [];
    }
  }
}

export default ShopifyGraphQLService;
