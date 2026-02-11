/**
 * Shopify GraphQL Mutations
 * All write operations for the Shopify Admin GraphQL API
 */

// ============= PRODUCT MUTATIONS =============

export const PRODUCT_CREATE_MUTATION = `
  mutation ProductCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        legacyResourceId
        title
        descriptionHtml
        vendor
        productType
        status
        tags
        createdAt
        updatedAt
        variants(first: 100) {
          edges {
            node {
              id
              legacyResourceId
              title
              price
              sku
              barcode
              weight
              weightUnit
              inventoryQuantity
              inventoryItem {
                id
                legacyResourceId
              }
            }
          }
        }
        images(first: 20) {
          edges {
            node {
              id
              url
              altText
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const PRODUCT_UPDATE_MUTATION = `
  mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        legacyResourceId
        title
        descriptionHtml
        vendor
        productType
        status
        tags
        updatedAt
        variants(first: 100) {
          edges {
            node {
              id
              legacyResourceId
              title
              price
              sku
              barcode
              weight
              weightUnit
              inventoryQuantity
              inventoryItem {
                id
                legacyResourceId
              }
            }
          }
        }
        images(first: 20) {
          edges {
            node {
              id
              url
              altText
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const PRODUCT_DELETE_MUTATION = `
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors {
        field
        message
      }
    }
  }
`;

export const PRODUCT_VARIANT_UPDATE_MUTATION = `
  mutation ProductVariantUpdate($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
      productVariant {
        id
        legacyResourceId
        title
        price
        sku
        barcode
        weight
        weightUnit
        inventoryQuantity
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product {
        id
      }
      productVariants {
        id
        legacyResourceId
        price
        sku
        barcode
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ============= ORDER MUTATIONS =============

export const ORDER_UPDATE_MUTATION = `
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        legacyResourceId
        note
        tags
        email
        shippingAddress {
          firstName
          lastName
          company
          address1
          address2
          city
          province
          provinceCode
          zip
          country
          countryCodeV2
          phone
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel(
    $orderId: ID!
    $notifyCustomer: Boolean
    $reason: OrderCancelReason
    $refund: Boolean
    $restock: Boolean
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      notifyCustomer: $notifyCustomer
      reason: $reason
      refund: $refund
      restock: $restock
      staffNote: $staffNote
    ) {
      job {
        id
        done
      }
      orderCancelUserErrors {
        field
        message
        code
      }
    }
  }
`;

export const ORDER_CLOSE_MUTATION = `
  mutation OrderClose($input: OrderCloseInput!) {
    orderClose(input: $input) {
      order {
        id
        legacyResourceId
        closed
        closedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const ORDER_OPEN_MUTATION = `
  mutation OrderOpen($input: OrderOpenInput!) {
    orderOpen(input: $input) {
      order {
        id
        legacyResourceId
        closed
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ============= DRAFT ORDER MUTATIONS =============

export const DRAFT_ORDER_CREATE_MUTATION = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        legacyResourceId
        status
        invoiceUrl
        order {
          id
          legacyResourceId
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const DRAFT_ORDER_COMPLETE_MUTATION = `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        legacyResourceId
        order {
          id
          legacyResourceId
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ============= REFUND MUTATIONS =============

export const REFUND_CREATE_MUTATION = `
  mutation RefundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        legacyResourceId
        createdAt
        note
        refundLineItems(first: 50) {
          edges {
            node {
              lineItem {
                id
                legacyResourceId
              }
              quantity
              subtotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
      order {
        id
        legacyResourceId
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ============= FULFILLMENT MUTATIONS =============

/**
 * Create a fulfillment (NEW API - replaces deprecated fulfillmentCreateV2)
 * Uses FulfillmentInput which works with FulfillmentOrders
 */
export const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate(
    $fulfillment: FulfillmentInput!
    $message: String
  ) {
    fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
      fulfillment {
        id
        legacyResourceId
        status
        createdAt
        updatedAt
        trackingInfo {
          number
          company
          url
        }
        fulfillmentLineItems(first: 50) {
          edges {
            node {
              id
              quantity
              lineItem {
                id
              }
            }
          }
        }
        fulfillmentOrders(first: 10) {
          edges {
            node {
              id
              status
              requestStatus
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Update tracking information for an existing fulfillment
 */
export const FULFILLMENT_TRACKING_INFO_UPDATE_MUTATION = `
  mutation FulfillmentTrackingInfoUpdate(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id
        trackingInfo {
          number
          company
          url
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ============= FULFILLMENT ORDER MUTATIONS =============

/**
 * Place a fulfillment order on hold
 * Use for fraud checks, payment issues, address problems, out of stock, etc.
 */
export const FULFILLMENT_ORDER_HOLD_MUTATION = `
  mutation FulfillmentOrderHold(
    $id: ID!
    $fulfillmentHold: FulfillmentOrderHoldInput!
  ) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
      fulfillmentOrder {
        id
        status
        requestStatus
        fulfillmentHolds {
          reason
          reasonNotes
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Release a hold on a fulfillment order
 */
export const FULFILLMENT_ORDER_RELEASE_HOLD_MUTATION = `
  mutation FulfillmentOrderReleaseHold($id: ID!) {
    fulfillmentOrderReleaseHold(id: $id) {
      fulfillmentOrder {
        id
        status
        requestStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Move fulfillment order to a different location
 */
export const FULFILLMENT_ORDER_MOVE_MUTATION = `
  mutation FulfillmentOrderMove($id: ID!, $newLocationId: ID!) {
    fulfillmentOrderMove(id: $id, newLocationId: $newLocationId) {
      movedFulfillmentOrder {
        id
        status
        assignedLocation {
          location {
            id
            legacyResourceId
            name
          }
        }
      }
      remainingFulfillmentOrder {
        id
        status
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Request cancellation of a fulfillment order
 */
export const FULFILLMENT_ORDER_SUBMIT_CANCELLATION_REQUEST_MUTATION = `
  mutation FulfillmentOrderSubmitCancellationRequest(
    $id: ID!
    $message: String
  ) {
    fulfillmentOrderSubmitCancellationRequest(id: $id, message: $message) {
      fulfillmentOrder {
        id
        status
        requestStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ============= 3PL FLOW MUTATIONS =============

/**
 * Submit fulfillment request to 3PL service (e.g., JTL FFN)
 * Call this when an order is ready to be sent to the fulfillment service
 */
export const FULFILLMENT_ORDER_SUBMIT_FULFILLMENT_REQUEST_MUTATION = `
  mutation FulfillmentOrderSubmitFulfillmentRequest(
    $id: ID!
    $message: String
    $notifyCustomer: Boolean
    $fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!]
  ) {
    fulfillmentOrderSubmitFulfillmentRequest(
      id: $id
      message: $message
      notifyCustomer: $notifyCustomer
      fulfillmentOrderLineItems: $fulfillmentOrderLineItems
    ) {
      submittedFulfillmentOrder {
        id
        status
        requestStatus
      }
      unsubmittedFulfillmentOrder {
        id
        status
        requestStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Accept a fulfillment request (as 3PL/fulfillment service)
 * Call this when JTL FFN accepts an order for fulfillment
 */
export const FULFILLMENT_ORDER_ACCEPT_FULFILLMENT_REQUEST_MUTATION = `
  mutation FulfillmentOrderAcceptFulfillmentRequest(
    $id: ID!
    $message: String
  ) {
    fulfillmentOrderAcceptFulfillmentRequest(id: $id, message: $message) {
      fulfillmentOrder {
        id
        status
        requestStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Reject a fulfillment request (as 3PL/fulfillment service)
 * Call this when JTL FFN rejects an order
 */
export const FULFILLMENT_ORDER_REJECT_FULFILLMENT_REQUEST_MUTATION = `
  mutation FulfillmentOrderRejectFulfillmentRequest(
    $id: ID!
    $message: String
    $reason: FulfillmentOrderRejectionReason
    $lineItems: [FulfillmentOrderLineItemInput!]
  ) {
    fulfillmentOrderRejectFulfillmentRequest(
      id: $id
      message: $message
      reason: $reason
      lineItems: $lineItems
    ) {
      fulfillmentOrder {
        id
        status
        requestStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Accept a cancellation request (as 3PL)
 */
export const FULFILLMENT_ORDER_ACCEPT_CANCELLATION_REQUEST_MUTATION = `
  mutation FulfillmentOrderAcceptCancellationRequest(
    $id: ID!
    $message: String
  ) {
    fulfillmentOrderAcceptCancellationRequest(id: $id, message: $message) {
      fulfillmentOrder {
        id
        status
        requestStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Reject a cancellation request (as 3PL)
 */
export const FULFILLMENT_ORDER_REJECT_CANCELLATION_REQUEST_MUTATION = `
  mutation FulfillmentOrderRejectCancellationRequest(
    $id: ID!
    $message: String
  ) {
    fulfillmentOrderRejectCancellationRequest(id: $id, message: $message) {
      fulfillmentOrder {
        id
        status
        requestStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ============= INVENTORY MUTATIONS =============

export const INVENTORY_SET_QUANTITIES_MUTATION = `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes {
          name
          delta
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const INVENTORY_ADJUST_QUANTITIES_MUTATION = `
  mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes {
          name
          delta
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ============= WEBHOOK MUTATIONS =============

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `
  mutation WebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        legacyResourceId
        topic
        endpoint {
          ... on WebhookHttpEndpoint {
            callbackUrl
          }
        }
        format
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const WEBHOOK_SUBSCRIPTION_DELETE_MUTATION = `
  mutation WebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors {
        field
        message
      }
    }
  }
`;

// ============= WEBHOOK TOPIC MAPPING =============

/**
 * Map REST webhook topics to GraphQL enum values
 */
export const WEBHOOK_TOPIC_MAP: Record<string, string> = {
  // Order webhooks
  'orders/create': 'ORDERS_CREATE',
  'orders/updated': 'ORDERS_UPDATED',
  'orders/cancelled': 'ORDERS_CANCELLED',
  'orders/fulfilled': 'ORDERS_FULFILLED',
  'orders/paid': 'ORDERS_PAID',

  // Product webhooks
  'products/create': 'PRODUCTS_CREATE',
  'products/update': 'PRODUCTS_UPDATE',
  'products/delete': 'PRODUCTS_DELETE',

  // Refund webhooks
  'refunds/create': 'REFUNDS_CREATE',

  // Inventory webhooks
  'inventory_levels/update': 'INVENTORY_LEVELS_UPDATE',
  'inventory_levels/connect': 'INVENTORY_LEVELS_CONNECT',
  'inventory_levels/disconnect': 'INVENTORY_LEVELS_DISCONNECT',

  // Customer webhooks
  'customers/create': 'CUSTOMERS_CREATE',
  'customers/update': 'CUSTOMERS_UPDATE',
  'customers/delete': 'CUSTOMERS_DELETE',

  // Fulfillment webhooks
  'fulfillments/create': 'FULFILLMENTS_CREATE',
  'fulfillments/update': 'FULFILLMENTS_UPDATE',

  // FulfillmentOrder webhooks (3PL flow)
  'fulfillment_orders/cancellation_request_accepted': 'FULFILLMENT_ORDERS_CANCELLATION_REQUEST_ACCEPTED',
  'fulfillment_orders/cancellation_request_rejected': 'FULFILLMENT_ORDERS_CANCELLATION_REQUEST_REJECTED',
  'fulfillment_orders/cancellation_request_submitted': 'FULFILLMENT_ORDERS_CANCELLATION_REQUEST_SUBMITTED',
  'fulfillment_orders/fulfillment_request_accepted': 'FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_ACCEPTED',
  'fulfillment_orders/fulfillment_request_rejected': 'FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_REJECTED',
  'fulfillment_orders/fulfillment_request_submitted': 'FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_SUBMITTED',
  'fulfillment_orders/hold_released': 'FULFILLMENT_ORDERS_HOLD_RELEASED',
  'fulfillment_orders/moved': 'FULFILLMENT_ORDERS_MOVED',
  'fulfillment_orders/order_routing_complete': 'FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE',
  'fulfillment_orders/placed_on_hold': 'FULFILLMENT_ORDERS_PLACED_ON_HOLD',
  'fulfillment_orders/rescheduled': 'FULFILLMENT_ORDERS_RESCHEDULED',
  'fulfillment_orders/scheduled_fulfillment_order_ready': 'FULFILLMENT_ORDERS_SCHEDULED_FULFILLMENT_ORDER_READY',

  // Product Feeds webhooks (bundle detection)
  'product_feeds/incremental_sync': 'PRODUCT_FEEDS_INCREMENTAL_SYNC',
  'product_feeds/full_sync': 'PRODUCT_FEEDS_FULL_SYNC',
};

/**
 * Get GraphQL webhook topic from REST topic
 */
export function getGraphQLWebhookTopic(restTopic: string): string {
  const graphqlTopic = WEBHOOK_TOPIC_MAP[restTopic];
  if (!graphqlTopic) {
    throw new Error(`Unknown webhook topic: ${restTopic}`);
  }
  return graphqlTopic;
}

// ============= ORDER CANCEL REASON MAPPING =============

export const ORDER_CANCEL_REASON_MAP: Record<string, string> = {
  'customer': 'CUSTOMER',
  'fraud': 'FRAUD',
  'inventory': 'INVENTORY',
  'declined': 'DECLINED',
  'other': 'OTHER',
};

/**
 * Get GraphQL order cancel reason from REST reason
 */
export function getGraphQLCancelReason(restReason: string): string {
  const reason = ORDER_CANCEL_REASON_MAP[restReason];
  return reason || 'OTHER';
}

// ============= PRODUCT STATUS MAPPING =============

export const PRODUCT_STATUS_MAP: Record<string, string> = {
  'active': 'ACTIVE',
  'archived': 'ARCHIVED',
  'draft': 'DRAFT',
};

/**
 * Get GraphQL product status from REST status
 */
export function getGraphQLProductStatus(restStatus: string): string {
  return PRODUCT_STATUS_MAP[restStatus] || 'DRAFT';
}

// ============= WEIGHT UNIT MAPPING =============

export const WEIGHT_UNIT_MAP: Record<string, string> = {
  'g': 'GRAMS',
  'kg': 'KILOGRAMS',
  'oz': 'OUNCES',
  'lb': 'POUNDS',
};

/**
 * Get GraphQL weight unit from REST unit
 */
export function getGraphQLWeightUnit(restUnit: string): string {
  return WEIGHT_UNIT_MAP[restUnit.toLowerCase()] || 'GRAMS';
}

// ============= RESTOCK TYPE MAPPING =============

export const RESTOCK_TYPE_MAP: Record<string, string> = {
  'no_restock': 'NO_RESTOCK',
  'cancel': 'CANCEL',
  'return': 'RETURN',
  'legacy_restock': 'LEGACY_RESTOCK',
};

/**
 * Get GraphQL restock type from REST type
 */
export function getGraphQLRestockType(restType: string): string {
  return RESTOCK_TYPE_MAP[restType] || 'NO_RESTOCK';
}
