/**
 * Shopify GraphQL Response Mapper
 * Maps GraphQL responses to REST API compatible types
 */

import {
  ShopifyOrder,
  ShopifyProduct,
  ShopifyVariant,
  ShopifyCustomer,
  ShopifyAddress,
  ShopifyLineItem,
  ShopifyShippingLine,
  ShopifyRefund,
  ShopifyRefundLineItem,
  ShopifyProductImage,
} from '../../types.js';
import { extractNumericId, toLegacyId } from './id-converter.js';
import { extractNodes, Connection } from './pagination.js';

// ============= GraphQL Response Types =============

interface GraphQLMoneyV2 {
  amount: string;
  currencyCode: string;
}

interface GraphQLMoneyBag {
  shopMoney: GraphQLMoneyV2;
  presentmentMoney?: GraphQLMoneyV2;
}

interface GraphQLCustomer {
  id: string;
  legacyResourceId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

interface GraphQLAddress {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  provinceCode?: string;
  zip?: string;
  country?: string;
  countryCodeV2?: string;
  phone?: string;
}

interface GraphQLLineItem {
  id: string;
  legacyResourceId?: string;
  variant?: { id: string; legacyResourceId?: string };
  product?: { id: string; legacyResourceId?: string };
  title: string;
  name: string;
  sku?: string;
  quantity: number;
  originalUnitPriceSet?: GraphQLMoneyBag;
  fulfillmentStatus?: string;
}

interface GraphQLShippingLine {
  id: string;
  legacyResourceId?: string;
  title: string;
  code?: string;
  originalPriceSet?: GraphQLMoneyBag;
}

interface GraphQLRefundLineItem {
  lineItem: { id: string; legacyResourceId?: string };
  quantity: number;
  subtotalSet?: GraphQLMoneyBag;
}

interface GraphQLRefund {
  id: string;
  legacyResourceId?: string;
  createdAt: string;
  note?: string;
  refundLineItems?: Connection<GraphQLRefundLineItem> | { edges: Array<{ node: GraphQLRefundLineItem }> };
}

interface GraphQLOrder {
  id: string;
  legacyResourceId?: string;
  name: string;
  email?: string;
  createdAt: string;
  updatedAt: string;
  totalPriceSet?: GraphQLMoneyBag;
  subtotalPriceSet?: GraphQLMoneyBag;
  totalTaxSet?: GraphQLMoneyBag;
  currencyCode: string;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
  customer?: GraphQLCustomer;
  billingAddress?: GraphQLAddress;
  shippingAddress?: GraphQLAddress;
  lineItems?: Connection<GraphQLLineItem> | { edges: Array<{ node: GraphQLLineItem }> };
  shippingLines?: Connection<GraphQLShippingLine> | { edges: Array<{ node: GraphQLShippingLine }> };
  refunds?: GraphQLRefund[];
  note?: string;
  tags?: string[];
  cancelledAt?: string;
  cancelReason?: string;
}

interface GraphQLProductVariant {
  id: string;
  legacyResourceId?: string;
  title: string;
  price: string;
  sku?: string;
  barcode?: string;
  inventoryQuantity?: number;
  inventoryItem?: {
    id: string;
    legacyResourceId?: string;
    measurement?: {
      weight?: {
        value: number;
        unit: string;  // GRAMS, KILOGRAMS, OUNCES, POUNDS
      };
    };
  };
}

interface GraphQLProductImage {
  id: string;
  legacyResourceId?: string;
  url: string;
  altText?: string;
}

interface GraphQLProduct {
  id: string;
  legacyResourceId?: string;
  title: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  status: string;
  tags?: string[];
  variants?: Connection<GraphQLProductVariant> | { edges: Array<{ node: GraphQLProductVariant }> };
  images?: Connection<GraphQLProductImage> | { edges: Array<{ node: GraphQLProductImage }> };
  bundleComponents?: Connection<{
    componentProduct: {
      id: string;
      legacyResourceId?: string;
      title: string;
      variants?: Connection<{
        id: string;
        legacyResourceId?: string;
        sku?: string;
      }>;
    };
    quantity: number;
  }>;
}

// ============= Mapper Functions =============

/**
 * Helper to get numeric ID from GraphQL response
 */
function getNumericId(gid: string, legacyId?: string): number {
  if (legacyId) {
    return parseInt(legacyId, 10);
  }
  return extractNumericId(gid);
}

/**
 * Helper to extract nodes from connection or edges array
 */
function getNodes<T>(data: Connection<T> | { edges: Array<{ node: T }> } | undefined): T[] {
  if (!data) return [];
  if ('edges' in data) {
    return data.edges.map(e => e.node);
  }
  return [];
}

/**
 * Map GraphQL customer to REST format
 */
export function mapCustomer(customer?: GraphQLCustomer): ShopifyCustomer {
  if (!customer) {
    return {
      id: 0,
      email: '',
      first_name: '',
      last_name: '',
      phone: null,
    };
  }

  return {
    id: getNumericId(customer.id, customer.legacyResourceId),
    email: customer.email || '',
    first_name: customer.firstName || '',
    last_name: customer.lastName || '',
    phone: customer.phone || null,
  };
}

/**
 * Map GraphQL address to REST format
 */
export function mapAddress(address?: GraphQLAddress): ShopifyAddress | null {
  if (!address) return null;

  return {
    first_name: address.firstName || '',
    last_name: address.lastName || '',
    company: address.company || null,
    address1: address.address1 || '',
    address2: address.address2 || null,
    city: address.city || '',
    province: address.province || '',
    province_code: address.provinceCode || '',
    zip: address.zip || '',
    country: address.country || '',
    country_code: address.countryCodeV2 || '',
    phone: address.phone || null,
  };
}

/**
 * Map GraphQL line item to REST format
 */
export function mapLineItem(lineItem: GraphQLLineItem): ShopifyLineItem {
  return {
    id: getNumericId(lineItem.id, lineItem.legacyResourceId),
    variant_id: lineItem.variant ? getNumericId(lineItem.variant.id, lineItem.variant.legacyResourceId) : 0,
    product_id: lineItem.product ? getNumericId(lineItem.product.id, lineItem.product.legacyResourceId) : 0,
    title: lineItem.title,
    name: lineItem.name,
    sku: lineItem.sku || '',
    quantity: lineItem.quantity,
    price: lineItem.originalUnitPriceSet?.shopMoney?.amount || '0.00',
    grams: 0, // GraphQL doesn't return grams directly
    fulfillment_status: lineItem.fulfillmentStatus || null,
  };
}

/**
 * Map GraphQL shipping line to REST format
 */
export function mapShippingLine(shippingLine: GraphQLShippingLine): ShopifyShippingLine {
  return {
    id: getNumericId(shippingLine.id, shippingLine.legacyResourceId),
    title: shippingLine.title,
    price: shippingLine.originalPriceSet?.shopMoney?.amount || '0.00',
    code: shippingLine.code || '',
  };
}

/**
 * Map GraphQL refund line item to REST format
 */
export function mapRefundLineItem(item: GraphQLRefundLineItem, index: number): ShopifyRefundLineItem {
  return {
    id: index, // GraphQL doesn't provide a separate refund line item ID
    line_item_id: getNumericId(item.lineItem.id, item.lineItem.legacyResourceId),
    quantity: item.quantity,
    subtotal: item.subtotalSet?.shopMoney?.amount || '0.00',
  };
}

/**
 * Map GraphQL refund to REST format
 */
export function mapRefund(refund: GraphQLRefund): ShopifyRefund {
  const refundLineItems = getNodes(refund.refundLineItems);

  return {
    id: getNumericId(refund.id, refund.legacyResourceId),
    created_at: refund.createdAt,
    note: refund.note || null,
    refund_line_items: refundLineItems.map((item, index) => mapRefundLineItem(item, index)),
  };
}

/**
 * Map GraphQL order to REST format
 */
export function mapOrder(order: GraphQLOrder): ShopifyOrder {
  const lineItems = getNodes(order.lineItems);
  const shippingLines = getNodes(order.shippingLines);

  // Extract order number from name (e.g., "#1001" -> 1001)
  const orderNumber = parseInt(order.name.replace(/\D/g, ''), 10) || 0;

  return {
    id: getNumericId(order.id, order.legacyResourceId),
    order_number: orderNumber,
    name: order.name,
    email: order.email || '',
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    total_price: order.totalPriceSet?.shopMoney?.amount || '0.00',
    subtotal_price: order.subtotalPriceSet?.shopMoney?.amount || '0.00',
    total_tax: order.totalTaxSet?.shopMoney?.amount || '0.00',
    currency: order.currencyCode,
    financial_status: order.displayFinancialStatus?.toLowerCase().replace(/_/g, ' ') || 'pending',
    fulfillment_status: order.displayFulfillmentStatus?.toLowerCase().replace(/_/g, ' ') || null,
    customer: mapCustomer(order.customer),
    billing_address: mapAddress(order.billingAddress),
    shipping_address: mapAddress(order.shippingAddress),
    line_items: lineItems.map(mapLineItem),
    shipping_lines: shippingLines.map(mapShippingLine),
    refunds: (order.refunds || []).map(mapRefund),
    note: order.note || null,
    tags: Array.isArray(order.tags) ? order.tags.join(', ') : (order.tags || ''),
    cancelled_at: order.cancelledAt || null,
    cancel_reason: order.cancelReason || null,
  };
}

/**
 * Map GraphQL product variant to REST format
 * Note: weight is now at inventoryItem.measurement.weight (API 2024-07+)
 */
export function mapVariant(variant: GraphQLProductVariant, productId: number): ShopifyVariant {
  // Extract weight from the new inventoryItem.measurement.weight path
  const weightMeasurement = variant.inventoryItem?.measurement?.weight;
  const weightValue = weightMeasurement?.value || 0;
  const weightUnit = weightMeasurement?.unit || 'GRAMS';

  // Convert to grams for the grams field
  let grams = 0;
  if (weightValue > 0) {
    switch (weightUnit) {
      case 'KILOGRAMS':
        grams = Math.round(weightValue * 1000);
        break;
      case 'POUNDS':
        grams = Math.round(weightValue * 453.592);
        break;
      case 'OUNCES':
        grams = Math.round(weightValue * 28.3495);
        break;
      case 'GRAMS':
      default:
        grams = Math.round(weightValue);
        break;
    }
  }

  return {
    id: getNumericId(variant.id, variant.legacyResourceId),
    product_id: productId,
    title: variant.title,
    price: variant.price,
    sku: variant.sku || '',
    barcode: variant.barcode || null,
    grams,
    weight: weightValue,
    weight_unit: weightUnit.toLowerCase(),
    inventory_quantity: variant.inventoryQuantity || 0,
    inventory_item_id: variant.inventoryItem ? getNumericId(variant.inventoryItem.id, variant.inventoryItem.legacyResourceId) : 0,
  };
}

/**
 * Map GraphQL product image to REST format
 */
export function mapProductImage(image: GraphQLProductImage, productId: number, position: number): ShopifyProductImage {
  return {
    id: getNumericId(image.id, image.legacyResourceId),
    product_id: productId,
    position: position + 1,
    src: image.url,
    alt: image.altText || null,
  };
}

/**
 * Map GraphQL product to REST format
 */
export function mapProduct(product: GraphQLProduct): ShopifyProduct {
  const productId = getNumericId(product.id, product.legacyResourceId);
  const variants = getNodes(product.variants);
  const images = getNodes(product.images);

  const bundleComponents = getNodes(product.bundleComponents || undefined);

  return {
    id: productId,
    title: product.title,
    body_html: product.descriptionHtml || '',
    vendor: product.vendor || '',
    product_type: product.productType || '',
    created_at: product.createdAt,
    updated_at: product.updatedAt,
    published_at: product.publishedAt || '',
    status: product.status.toLowerCase(),
    tags: Array.isArray(product.tags) ? product.tags.join(', ') : (product.tags || ''),
    variants: variants.map(v => mapVariant(v, productId)),
    images: images.map((img, idx) => mapProductImage(img, productId, idx)),
    bundleComponents: bundleComponents.map(bc => {
      const componentVariants = getNodes(bc.componentProduct.variants || undefined);
      const firstVariant = componentVariants[0];
      return {
        productId: getNumericId(bc.componentProduct.id, bc.componentProduct.legacyResourceId),
        variantId: firstVariant
          ? getNumericId(firstVariant.id, firstVariant.legacyResourceId)
          : undefined,
        sku: firstVariant?.sku,
        title: bc.componentProduct.title,
        quantity: bc.quantity,
      };
    }),
  };
}

/**
 * Map array of GraphQL orders to REST format
 */
export function mapOrders(orders: GraphQLOrder[]): ShopifyOrder[] {
  return orders.map(mapOrder);
}

/**
 * Map array of GraphQL products to REST format
 */
export function mapProducts(products: GraphQLProduct[]): ShopifyProduct[] {
  return products.map(mapProduct);
}
