/**
 * Shopify GraphQL Queries
 * All read operations for the Shopify Admin GraphQL API
 */

// ============= FRAGMENTS =============

export const MONEY_FRAGMENT = `
  fragment MoneyFields on MoneyV2 {
    amount
    currencyCode
  }
`;

export const MONEY_BAG_FRAGMENT = `
  fragment MoneyBagFields on MoneyBag {
    shopMoney {
      ...MoneyFields
    }
  }
  ${MONEY_FRAGMENT}
`;

export const ADDRESS_FRAGMENT = `
  fragment AddressFields on MailingAddress {
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
`;

export const CUSTOMER_FRAGMENT = `
  fragment CustomerFields on Customer {
    id
    legacyResourceId
    email
    firstName
    lastName
    phone
  }
`;

export const LINE_ITEM_FRAGMENT = `
  fragment LineItemFields on LineItem {
    id
    legacyResourceId
    variant {
      id
      legacyResourceId
    }
    product {
      id
      legacyResourceId
    }
    title
    name
    sku
    quantity
    originalUnitPriceSet {
      ...MoneyBagFields
    }
    fulfillmentStatus
  }
  ${MONEY_BAG_FRAGMENT}
`;

export const SHIPPING_LINE_FRAGMENT = `
  fragment ShippingLineFields on ShippingLine {
    id
    title
    code
    originalPriceSet {
      ...MoneyBagFields
    }
  }
  ${MONEY_BAG_FRAGMENT}
`;

export const REFUND_LINE_ITEM_FRAGMENT = `
  fragment RefundLineItemFields on RefundLineItem {
    lineItem {
      id
      legacyResourceId
    }
    quantity
    subtotalSet {
      ...MoneyBagFields
    }
  }
  ${MONEY_BAG_FRAGMENT}
`;

export const REFUND_FRAGMENT = `
  fragment RefundFields on Refund {
    id
    legacyResourceId
    createdAt
    note
    refundLineItems(first: 50) {
      edges {
        node {
          ...RefundLineItemFields
        }
      }
    }
  }
  ${REFUND_LINE_ITEM_FRAGMENT}
`;

export const VARIANT_FRAGMENT = `
  fragment VariantFields on ProductVariant {
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
`;

export const PRODUCT_IMAGE_FRAGMENT = `
  fragment ProductImageFields on Image {
    id
    url
    altText
  }
`;

// ============= ORDER QUERIES =============

export const GET_ORDERS_QUERY = `
  query GetOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          legacyResourceId
          name
          email
          createdAt
          updatedAt
          totalPriceSet {
            ...MoneyBagFields
          }
          subtotalPriceSet {
            ...MoneyBagFields
          }
          totalTaxSet {
            ...MoneyBagFields
          }
          currencyCode
          displayFinancialStatus
          displayFulfillmentStatus
          customer {
            ...CustomerFields
          }
          billingAddress {
            ...AddressFields
          }
          shippingAddress {
            ...AddressFields
          }
          lineItems(first: 100) {
            edges {
              node {
                ...LineItemFields
              }
            }
          }
          shippingLines(first: 10) {
            edges {
              node {
                ...ShippingLineFields
              }
            }
          }
          refunds(first: 20) {
            ...RefundFields
          }
          note
          tags
          cancelledAt
          cancelReason
        }
      }
    }
  }
  ${MONEY_BAG_FRAGMENT}
  ${CUSTOMER_FRAGMENT}
  ${ADDRESS_FRAGMENT}
  ${LINE_ITEM_FRAGMENT}
  ${SHIPPING_LINE_FRAGMENT}
  ${REFUND_FRAGMENT}
`;

export const GET_ORDER_QUERY = `
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      email
      createdAt
      updatedAt
      totalPriceSet {
        ...MoneyBagFields
      }
      subtotalPriceSet {
        ...MoneyBagFields
      }
      totalTaxSet {
        ...MoneyBagFields
      }
      currencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      customer {
        ...CustomerFields
      }
      billingAddress {
        ...AddressFields
      }
      shippingAddress {
        ...AddressFields
      }
      lineItems(first: 100) {
        edges {
          node {
            ...LineItemFields
          }
        }
      }
      shippingLines(first: 10) {
        edges {
          node {
            ...ShippingLineFields
          }
        }
      }
      refunds(first: 20) {
        ...RefundFields
      }
      note
      tags
      cancelledAt
      cancelReason
    }
  }
  ${MONEY_BAG_FRAGMENT}
  ${CUSTOMER_FRAGMENT}
  ${ADDRESS_FRAGMENT}
  ${LINE_ITEM_FRAGMENT}
  ${SHIPPING_LINE_FRAGMENT}
  ${REFUND_FRAGMENT}
`;

/**
 * Get fulfillment orders for an order with full details (enhanced for FulfillmentOrder API)
 * Includes status, request status, holds, destination, and line items
 */
export const GET_ORDER_FULFILLMENT_ORDERS_QUERY = `
  query GetOrderFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      id
      legacyResourceId
      fulfillmentOrders(first: 20) {
        edges {
          node {
            id
            status
            requestStatus
            createdAt
            updatedAt
            fulfillAt
            fulfillBy

            assignedLocation {
              location {
                id
                legacyResourceId
                name
                address {
                  address1
                  city
                  countryCode
                }
              }
            }

            destination {
              firstName
              lastName
              company
              address1
              address2
              city
              province
              zip
              countryCode
              phone
              email
            }

            deliveryMethod {
              methodType
              serviceCode
            }

            fulfillmentOrderLineItems(first: 100) {
              edges {
                node {
                  id
                  totalQuantity
                  remainingQuantity
                  lineItem {
                    id
                    legacyResourceId
                    sku
                    title
                    quantity
                    variant {
                      id
                      legacyResourceId
                      sku
                    }
                  }
                }
              }
            }

            merchantRequests(first: 10) {
              edges {
                node {
                  id
                  kind
                  message
                }
              }
            }

            fulfillmentHolds {
              reason
              reasonNotes
            }

            supportedActions {
              action
              externalUrl
            }
          }
        }
      }
    }
  }
`;

/**
 * Get a single fulfillment order by ID
 */
export const GET_FULFILLMENT_ORDER_QUERY = `
  query GetFulfillmentOrder($id: ID!) {
    node(id: $id) {
      ... on FulfillmentOrder {
        id
        status
        requestStatus
        createdAt
        updatedAt
        fulfillAt
        fulfillBy
        order {
          id
          legacyResourceId
          name
          email
        }
        assignedLocation {
          location {
            id
            legacyResourceId
            name
          }
        }
        destination {
          firstName
          lastName
          company
          address1
          address2
          city
          province
          zip
          countryCode
          phone
          email
        }
        deliveryMethod {
          methodType
          serviceCode
        }
        fulfillmentOrderLineItems(first: 100) {
          edges {
            node {
              id
              totalQuantity
              remainingQuantity
              lineItem {
                id
                legacyResourceId
                sku
                title
              }
            }
          }
        }
        fulfillmentHolds {
          reason
          reasonNotes
        }
        supportedActions {
          action
        }
      }
    }
  }
`;

/**
 * Query fulfillment orders for a shop (not tied to specific order)
 * Useful for getting all pending fulfillment orders
 */
export const GET_FULFILLMENT_ORDERS_QUERY = `
  query GetFulfillmentOrders(
    $first: Int!
    $after: String
    $query: String
  ) {
    fulfillmentOrders(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          status
          requestStatus
          createdAt
          updatedAt
          order {
            id
            legacyResourceId
            name
          }
          assignedLocation {
            location {
              id
              legacyResourceId
              name
            }
          }
          fulfillmentOrderLineItems(first: 50) {
            edges {
              node {
                id
                remainingQuantity
                lineItem {
                  id
                  sku
                  title
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ============= PRODUCT QUERIES =============

export const GET_PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          legacyResourceId
          title
          descriptionHtml
          vendor
          productType
          createdAt
          updatedAt
          publishedAt
          status
          tags
          variants(first: 100) {
            edges {
              node {
                ...VariantFields
              }
            }
          }
          images(first: 20) {
            edges {
              node {
                ...ProductImageFields
              }
            }
          }
        }
      }
    }
  }
  ${VARIANT_FRAGMENT}
  ${PRODUCT_IMAGE_FRAGMENT}
`;

export const GET_PRODUCT_QUERY = `
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      legacyResourceId
      title
      descriptionHtml
      vendor
      productType
      createdAt
      updatedAt
      publishedAt
      status
      tags
      variants(first: 100) {
        edges {
          node {
            ...VariantFields
          }
        }
      }
      images(first: 20) {
        edges {
          node {
            ...ProductImageFields
          }
        }
      }
    }
  }
  ${VARIANT_FRAGMENT}
  ${PRODUCT_IMAGE_FRAGMENT}
`;

// ============= INVENTORY QUERIES =============

export const GET_INVENTORY_LEVELS_QUERY = `
  query GetInventoryLevels($inventoryItemId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      id
      legacyResourceId
      inventoryLevels(first: 20) {
        edges {
          node {
            id
            available
            location {
              id
              legacyResourceId
            }
          }
        }
      }
    }
  }
`;

export const GET_LOCATIONS_QUERY = `
  query GetLocations($first: Int!) {
    locations(first: $first) {
      edges {
        node {
          id
          legacyResourceId
          name
          isActive
        }
      }
    }
  }
`;

// ============= SHOP QUERIES =============

export const GET_SHOP_QUERY = `
  query GetShop {
    shop {
      id
      name
      email
      myshopifyDomain
      primaryDomain {
        url
        host
      }
      currencyCode
    }
  }
`;

// ============= WEBHOOK QUERIES =============

export const GET_WEBHOOKS_QUERY = `
  query GetWebhooks($first: Int!) {
    webhookSubscriptions(first: $first) {
      edges {
        node {
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
      }
    }
  }
`;

// ============= SHIPPING QUERIES =============

export const GET_DELIVERY_PROFILES_QUERY = `
  query GetDeliveryProfiles($first: Int!) {
    deliveryProfiles(first: $first) {
      edges {
        node {
          id
          name
          profileLocationGroups {
            locationGroup {
              id
            }
            locationGroupZones(first: 20) {
              edges {
                node {
                  zone {
                    id
                    name
                    countries {
                      code {
                        countryCode
                      }
                      name
                    }
                  }
                  methodDefinitions(first: 20) {
                    edges {
                      node {
                        id
                        name
                        rateProvider {
                          ... on DeliveryRateDefinition {
                            price {
                              amount
                              currencyCode
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ============= REFUND QUERIES =============

export const GET_SUGGESTED_REFUND_QUERY = `
  query GetSuggestedRefund(
    $orderId: ID!
    $refundLineItems: [RefundLineItemInput!]
    $shippingFullRefund: Boolean
    $shippingAmount: Money
  ) {
    order(id: $orderId) {
      suggestedRefund(
        refundLineItems: $refundLineItems
        shippingFullRefund: $shippingFullRefund
        shippingAmount: $shippingAmount
      ) {
        amount
        subtotal
        totalTax
        maximumRefundable
        refundLineItems {
          lineItem {
            id
            legacyResourceId
          }
          quantity
          subtotal
        }
        shipping {
          amount
          tax
          maximumRefundable
        }
      }
    }
  }
`;
