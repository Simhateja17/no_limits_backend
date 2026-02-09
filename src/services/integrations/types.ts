/**
 * Common types for e-commerce platform integrations
 * Shopify, WooCommerce, and JTL FFN
 */

// ============= SHOPIFY TYPES =============

export interface ShopifyCredentials {
  shopDomain: string;
  accessToken: string;
  apiVersion?: string;
}

export interface ShopifyOrder {
  id: number;
  order_number: number;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  customer: ShopifyCustomer;
  billing_address: ShopifyAddress | null;
  shipping_address: ShopifyAddress | null;
  line_items: ShopifyLineItem[];
  shipping_lines: ShopifyShippingLine[];
  refunds: ShopifyRefund[];
  note: string | null;
  tags: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

export interface ShopifyCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
}

export interface ShopifyAddress {
  first_name: string;
  last_name: string;
  company: string | null;
  address1: string;
  address2: string | null;
  city: string;
  province: string;
  province_code: string;
  zip: string;
  country: string;
  country_code: string;
  phone: string | null;
}

export interface ShopifyLineItem {
  id: number;
  variant_id: number;
  product_id: number;
  title: string;
  name: string;
  sku: string;
  quantity: number;
  price: string;
  grams: number;
  fulfillment_status: string | null;
}

export interface ShopifyShippingLine {
  id: number;
  title: string;
  price: string;
  code: string;
}

export interface ShopifyRefund {
  id: number;
  created_at: string;
  note: string | null;
  refund_line_items: ShopifyRefundLineItem[];
}

export interface ShopifyRefundLineItem {
  id: number;
  line_item_id: number;
  quantity: number;
  subtotal: string;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  created_at: string;
  updated_at: string;
  published_at: string;
  status: string;
  tags: string;
  variants: ShopifyVariant[];
  images: ShopifyProductImage[];
}

export interface ShopifyVariant {
  id: number;
  product_id: number;
  title: string;
  price: string;
  sku: string;
  barcode: string | null;
  grams: number;
  weight: number;
  weight_unit: string;
  inventory_quantity: number;
  inventory_item_id: number;
}

export interface ShopifyProductImage {
  id: number;
  product_id: number;
  position: number;
  src: string;
  alt: string | null;
}

// ============= WOOCOMMERCE TYPES =============

export interface WooCommerceCredentials {
  url: string;
  consumerKey: string;
  consumerSecret: string;
  version?: string;
}

export interface WooCommerceOrder {
  id: number;
  number: string;
  order_key: string;
  status: string;
  date_created: string;
  date_modified: string;
  total: string;
  total_tax: string;
  shipping_total: string;
  discount_total: string;
  currency: string;
  customer_id: number;
  customer_note: string;
  billing: WooCommerceAddress;
  shipping: WooCommerceAddress;
  line_items: WooCommerceLineItem[];
  shipping_lines: WooCommerceShippingLine[];
  refunds: WooCommerceRefund[];
}

export interface WooCommerceAddress {
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email?: string;
  phone?: string;
}

export interface WooCommerceLineItem {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  subtotal: string;
  subtotal_tax: string;
  total: string;
  total_tax: string;
  sku: string;
  price: number;
}

export interface WooCommerceShippingLine {
  id: number;
  method_id: string;
  method_title: string;
  total: string;
}

export interface WooCommerceRefund {
  id: number;
  reason: string;
  total: string;
}

export interface WooCommerceProduct {
  id: number;
  name: string;
  slug: string;
  type: string;
  status: string;
  description: string;
  short_description: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  stock_quantity: number | null;
  stock_status: string;
  manage_stock: boolean;
  weight: string;
  dimensions: WooCommerceDimensions;
  images: WooCommerceProductImage[];
  categories: WooCommerceCategory[];
  variations: number[];
}

export interface WooCommerceDimensions {
  length: string;
  width: string;
  height: string;
}

export interface WooCommerceProductImage {
  id: number;
  src: string;
  name: string;
  alt: string;
}

export interface WooCommerceCategory {
  id: number;
  name: string;
  slug: string;
}

// ============= JTL FFN MERCHANT API TYPES =============

export interface JTLCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  environment: 'sandbox' | 'production';
  // Additional fields for convenience when creating outbounds
  fulfillerId?: string;
  warehouseId?: string;
}

export interface JTLOutbound {
  merchantOutboundNumber: string;
  warehouseId?: string;
  fulfillerId?: string;
  currency?: string; // ISO 4217 currency code (EUR, USD, etc.)
  customerOrderNumber?: string;
  orderDate?: string;
  externalNumber?: string;
  premiumType?: 'None' | 'Prime' | 'EbayPlus' | 'Zalando';
  shippingType?: 'Standard' | 'Express' | 'NextDay' | 'SameDay';
  shippingMethod?: string;
  shippingMethodId?: string;
  desiredDeliveryDate?: string;
  priority?: 'Normal' | 'High' | 'Critical' | number;
  shippingAddress?: JTLAddress;
  shipTo?: JTLShipTo;
  senderAddress?: JTLAddress;
  items: JTLOutboundItem[];
  attributes?: JTLAttribute[];
  note?: string;
}

export interface JTLShipTo {
  name: string;
  company?: string;
  street: string;
  additionalAddress?: string;
  city: string;
  zip: string;
  countryCode: string;
  phone?: string;
  email?: string;
}

export interface JTLOutboundItem {
  outboundItemId?: string;
  jfsku?: string;
  merchantSku: string;
  name?: string;
  quantity: number;
  unitPrice?: number;
  bestBefore?: string;
  billOfMaterialsId?: string;
  billOfMaterialsItems?: JTLBillOfMaterialsItem[];
}

export interface JTLBillOfMaterialsItem {
  jfsku: string;
  quantity: number;
}

export interface JTLAddress {
  salutation?: 'Mr' | 'Mrs' | 'Company' | 'Undefined';
  firstname?: string;
  lastname: string;
  company?: string;
  addition?: string;
  street: string;
  houseNumber?: string;
  zip: string;
  city: string;
  country: string; // JTL API expects 'country' field (ISO country code like 'DE', 'US')
  stateCode?: string;
  email?: string;
  phone?: string;
}

export interface JTLAttribute {
  key: string;
  value: string;
}

export interface JTLProductIdentifier {
  ean?: string | null;
  mpn?: string | null;
  isbn?: string | null;
  asin?: string | null;
  han?: string | null;
}

export interface JTLProduct {
  // Required fields
  name: string;
  merchantSku: string;
  identifier: JTLProductIdentifier; // Singular object with identifier fields

  // Optional fields
  description?: string | null;
  productGroup?: string | null;
  note?: string | null;
  weight?: number | null; // Weight in kg
  length?: number | null; // Length in meters
  width?: number | null; // Width in meters
  height?: number | null; // Height in meters
  heightInCm?: number;
  lengthInCm?: number;
  widthInCm?: number;
  weightInKg?: number;
  isDivisible?: boolean;
  isBestBefore?: boolean;
  isSerial?: boolean;
  isBatch?: boolean;
  condition?: 'Unknown' | 'Default' | 'Refurbished' | 'Used' | 'Damaged';
  countryOfOrigin?: string;
  customsCode?: string;
  imageUrl?: string;
  attributes?: Array<{ key: string; value: string }>;
  netRetailPrice?: {
    amount: number;
    currency: string;
  };
  bundles?: Array<{ name: string; quantity: number; ean: string; upc: string }>;
}

export interface JTLInbound {
  merchantInboundNumber: string;
  warehouseId: string;
  purchaseOrderNumber?: string;
  externalInboundNumber?: string;
  estimatedArrival?: string;
  items: JTLInboundItem[];
  attributes?: JTLAttribute[];
}

export interface JTLInboundItem {
  inboundItemId: string;
  jfsku: string;
  merchantSku?: string;
  quantity: number;
  supplierSku?: string;
  bestBefore?: string;
  batchNumber?: string;
}

export interface JTLReturn {
  merchantReturnNumber: string;
  warehouseId: string;
  fulfillerId?: string;
  customerAddress?: JTLAddress;
  items: JTLReturnItem[];
  attributes?: JTLAttribute[];
}

export interface JTLReturnItem {
  returnItemId: string;
  jfsku: string;
  merchantSku?: string;
  name?: string;
  quantity: number;
  condition?: 'New' | 'Good' | 'Acceptable' | 'Damaged' | 'Defective';
  outboundId?: string;
  outboundItemId?: string;
}

// ============= SYNC TYPES =============

export interface SyncResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  syncedAt: Date;
  itemsProcessed: number;
  itemsFailed: number;
  details?: SyncItemResult[];
}

export interface SyncItemResult {
  externalId: string;
  localId?: string;
  success: boolean;
  error?: string;
  action: 'created' | 'updated' | 'skipped' | 'failed';
}

export interface WebhookPayload {
  topic: string;
  domain: string;
  timestamp: string;
  data: unknown;
}

// ============= MAPPING TYPES =============

export interface OrderMapping {
  localOrderId: string;
  externalOrderId: string;
  channelId: string;
  jtlOutboundId?: string;
  lastSyncAt: Date;
}

export interface ProductMapping {
  localProductId: string;
  externalProductId: string;
  channelId: string;
  jtlProductId?: string;
  lastSyncAt: Date;
}

export interface ReturnMapping {
  localReturnId: string;
  externalRefundId?: string;
  channelId: string;
  jtlReturnId?: string;
  lastSyncAt: Date;
}
