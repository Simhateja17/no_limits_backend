/**
 * Shopify Order Payload Generator
 * Generates realistic Shopify webhook payloads for stress testing
 */

import crypto from 'crypto';
import { testDataConfig } from '../config/stress-test.config.js';

export interface ShopifyOrderPayload {
  id: number;
  order_number: number;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
  processed_at: string;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  total_discounts: string;
  total_shipping_price_set: {
    shop_money: { amount: string; currency_code: string };
    presentment_money: { amount: string; currency_code: string };
  };
  currency: string;
  financial_status: 'pending' | 'authorized' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded' | 'voided';
  fulfillment_status: null | 'fulfilled' | 'partial' | 'restocked';
  confirmed: boolean;
  test: boolean;
  gateway: string;
  checkout_token: string;
  customer: ShopifyCustomerPayload;
  billing_address: ShopifyAddressPayload;
  shipping_address: ShopifyAddressPayload;
  line_items: ShopifyLineItemPayload[];
  shipping_lines: ShopifyShippingLinePayload[];
  tax_lines: ShopifyTaxLinePayload[];
  discount_codes: ShopifyDiscountCodePayload[];
  note: string | null;
  note_attributes: Array<{ name: string; value: string }>;
  tags: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  refunds: ShopifyRefundPayload[];
  payment_gateway_names: string[];
  source_name: string;
  total_weight: number;
  browser_ip: string;
  landing_site: string;
  referring_site: string;
  cart_token: string;
  token: string;
  closed_at: string | null;
  app_id: number;
  location_id: number | null;
}

export interface ShopifyCustomerPayload {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  accepts_marketing: boolean;
  created_at: string;
  updated_at: string;
  orders_count: number;
  total_spent: string;
  verified_email: boolean;
  tax_exempt: boolean;
  tags: string;
  currency: string;
  default_address: ShopifyAddressPayload;
}

export interface ShopifyAddressPayload {
  id?: number;
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
  name: string;
  latitude?: number;
  longitude?: number;
}

export interface ShopifyLineItemPayload {
  id: number;
  variant_id: number;
  product_id: number;
  title: string;
  name: string;
  sku: string;
  vendor: string;
  quantity: number;
  price: string;
  total_discount: string;
  grams: number;
  fulfillment_status: null | 'fulfilled' | 'partial';
  fulfillment_service: string;
  requires_shipping: boolean;
  taxable: boolean;
  gift_card: boolean;
  properties: Array<{ name: string; value: string }>;
  variant_title: string;
  product_exists: boolean;
  fulfillable_quantity: number;
  tax_lines: ShopifyTaxLinePayload[];
}

export interface ShopifyShippingLinePayload {
  id: number;
  title: string;
  price: string;
  code: string;
  source: string;
  phone: string | null;
  carrier_identifier: string | null;
  requested_fulfillment_service_id: string | null;
  discount_allocations: Array<{
    amount: string;
    discount_application_index: number;
    amount_set: {
      shop_money: { amount: string; currency_code: string };
      presentment_money: { amount: string; currency_code: string };
    };
  }>;
  tax_lines: ShopifyTaxLinePayload[];
}

export interface ShopifyTaxLinePayload {
  title: string;
  price: string;
  rate: number;
  channel_liable: boolean;
}

export interface ShopifyDiscountCodePayload {
  code: string;
  amount: string;
  type: 'percentage' | 'fixed_amount' | 'shipping';
}

export interface ShopifyRefundPayload {
  id: number;
  created_at: string;
  note: string | null;
  restock: boolean;
  refund_line_items: Array<{
    id: number;
    line_item_id: number;
    quantity: number;
    subtotal: string;
    total_tax: string;
  }>;
}

export interface GeneratorOptions {
  orderId?: number;
  orderNumber?: number;
  customerId?: number;
  itemCount?: { min: number; max: number };
  includeDiscount?: boolean;
  financialStatus?: ShopifyOrderPayload['financial_status'];
  fulfillmentStatus?: ShopifyOrderPayload['fulfillment_status'];
  includeRefund?: boolean;
  currency?: string;
  testOrder?: boolean;
}

export class ShopifyOrderGenerator {
  private orderIdCounter: number;
  private orderNumberCounter: number;
  private customerIdCounter: number;
  private productIdCounter: number;
  private variantIdCounter: number;

  constructor(startingId: number = 5000000000000) {
    this.orderIdCounter = startingId;
    this.orderNumberCounter = 1000;
    this.customerIdCounter = 7000000000000;
    this.productIdCounter = 8000000000000;
    this.variantIdCounter = 9000000000000;
  }

  /**
   * Generate a unique ID
   */
  private nextOrderId(): number {
    return this.orderIdCounter++;
  }

  private nextOrderNumber(): number {
    return this.orderNumberCounter++;
  }

  private nextCustomerId(): number {
    return this.customerIdCounter++;
  }

  private nextProductId(): number {
    return this.productIdCounter++;
  }

  private nextVariantId(): number {
    return this.variantIdCounter++;
  }

  /**
   * Get random item from array
   */
  private randomItem<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * Get random integer between min and max (inclusive)
   */
  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Generate a random email
   */
  private generateEmail(firstName: string, lastName: string): string {
    const domain = this.randomItem(testDataConfig.emailDomains);
    const random = this.randomInt(1000, 9999);
    return `${firstName.toLowerCase()}.${lastName.toLowerCase()}${random}@${domain}`;
  }

  /**
   * Generate a random phone number (German format)
   */
  private generatePhone(): string {
    const prefix = ['+49', '+43', '+41', '+31', '+33', '+44'][this.randomInt(0, 5)];
    const number = this.randomInt(100000000, 999999999);
    return `${prefix}${number}`;
  }

  /**
   * Generate a random address
   */
  private generateAddress(firstName: string, lastName: string): ShopifyAddressPayload {
    const city = this.randomItem(testDataConfig.cities);
    const street = this.randomItem(testDataConfig.streets);
    const houseNumber = this.randomInt(1, 150);
    const hasCompany = Math.random() > 0.7;
    
    return {
      id: this.randomInt(10000000000, 99999999999),
      first_name: firstName,
      last_name: lastName,
      company: hasCompany ? `${lastName} GmbH` : null,
      address1: `${street} ${houseNumber}`,
      address2: Math.random() > 0.8 ? `Apartment ${this.randomInt(1, 50)}` : null,
      city: city.name,
      province: city.name,
      province_code: city.countryCode,
      zip: city.zip,
      country: city.country,
      country_code: city.countryCode,
      phone: this.generatePhone(),
      name: `${firstName} ${lastName}`,
      latitude: 48.8566 + (Math.random() - 0.5) * 10,
      longitude: 2.3522 + (Math.random() - 0.5) * 10,
    };
  }

  /**
   * Generate a customer payload
   */
  private generateCustomer(options: { firstName?: string; lastName?: string; email?: string } = {}): ShopifyCustomerPayload {
    const firstName = options.firstName || this.randomItem(testDataConfig.firstNames);
    const lastName = options.lastName || this.randomItem(testDataConfig.lastNames);
    const email = options.email || this.generateEmail(firstName, lastName);
    const now = new Date().toISOString();
    
    return {
      id: this.nextCustomerId(),
      email,
      first_name: firstName,
      last_name: lastName,
      phone: this.generatePhone(),
      accepts_marketing: Math.random() > 0.5,
      created_at: now,
      updated_at: now,
      orders_count: this.randomInt(1, 50),
      total_spent: (this.randomInt(50, 5000) + Math.random()).toFixed(2),
      verified_email: true,
      tax_exempt: false,
      tags: '',
      currency: 'EUR',
      default_address: this.generateAddress(firstName, lastName),
    };
  }

  /**
   * Generate line items
   */
  private generateLineItems(count: number): ShopifyLineItemPayload[] {
    const items: ShopifyLineItemPayload[] = [];
    const usedProducts = new Set<string>();
    
    for (let i = 0; i < count; i++) {
      // Get a unique product
      let product;
      do {
        product = this.randomItem(testDataConfig.products);
      } while (usedProducts.has(product.sku) && usedProducts.size < testDataConfig.products.length);
      
      usedProducts.add(product.sku);
      const quantity = this.randomInt(1, 5);
      const discount = Math.random() > 0.8 ? (product.price * 0.1).toFixed(2) : '0.00';
      
      items.push({
        id: this.randomInt(10000000000, 99999999999),
        variant_id: this.nextVariantId(),
        product_id: this.nextProductId(),
        title: product.name.split(' ').slice(0, -1).join(' '),
        name: product.name,
        sku: product.sku,
        vendor: 'Test Vendor',
        quantity,
        price: product.price.toFixed(2),
        total_discount: discount,
        grams: product.weight,
        fulfillment_status: null,
        fulfillment_service: 'manual',
        requires_shipping: true,
        taxable: true,
        gift_card: false,
        properties: [],
        variant_title: product.name.split(' ').slice(-1)[0],
        product_exists: true,
        fulfillable_quantity: quantity,
        tax_lines: [
          {
            title: 'VAT',
            price: ((product.price * quantity) * 0.19).toFixed(2),
            rate: 0.19,
            channel_liable: false,
          },
        ],
      });
    }
    
    return items;
  }

  /**
   * Generate shipping line
   */
  private generateShippingLine(): ShopifyShippingLinePayload {
    const shippingMethod = this.randomItem(testDataConfig.shippingMethods.shopify);
    
    return {
      id: this.randomInt(10000000000, 99999999999),
      title: shippingMethod.title,
      price: shippingMethod.price,
      code: shippingMethod.code,
      source: 'shopify',
      phone: null,
      carrier_identifier: null,
      requested_fulfillment_service_id: null,
      discount_allocations: [],
      tax_lines: [
        {
          title: 'VAT',
          price: (parseFloat(shippingMethod.price) * 0.19).toFixed(2),
          rate: 0.19,
          channel_liable: false,
        },
      ],
    };
  }

  /**
   * Generate a complete Shopify order payload
   */
  generate(options: GeneratorOptions = {}): ShopifyOrderPayload {
    const orderId = options.orderId || this.nextOrderId();
    const orderNumber = options.orderNumber || this.nextOrderNumber();
    const itemCount = this.randomInt(
      options.itemCount?.min || 1,
      options.itemCount?.max || 5
    );
    
    const customer = this.generateCustomer();
    const lineItems = this.generateLineItems(itemCount);
    const shippingLine = this.generateShippingLine();
    
    // Calculate totals
    const subtotal = lineItems.reduce((sum, item) => {
      return sum + (parseFloat(item.price) * item.quantity);
    }, 0);
    
    const totalDiscount = lineItems.reduce((sum, item) => {
      return sum + parseFloat(item.total_discount);
    }, 0);
    
    const totalTax = lineItems.reduce((sum, item) => {
      return sum + item.tax_lines.reduce((taxSum, tax) => taxSum + parseFloat(tax.price), 0);
    }, 0) + parseFloat(shippingLine.tax_lines[0]?.price || '0');
    
    const shippingCost = parseFloat(shippingLine.price);
    const total = subtotal - totalDiscount + totalTax + shippingCost;
    
    const totalWeight = lineItems.reduce((sum, item) => sum + (item.grams * item.quantity), 0);
    
    const now = new Date();
    const currency = options.currency || 'EUR';
    
    // Generate discount code if requested
    const discountCodes: ShopifyDiscountCodePayload[] = [];
    if (options.includeDiscount && Math.random() > 0.5) {
      discountCodes.push({
        code: `STRESS${this.randomInt(1000, 9999)}`,
        amount: totalDiscount.toFixed(2),
        type: 'percentage',
      });
    }

    const billingAddress = this.generateAddress(customer.first_name, customer.last_name);
    const shippingAddress = Math.random() > 0.2 
      ? { ...billingAddress } 
      : this.generateAddress(customer.first_name, customer.last_name);

    const order: ShopifyOrderPayload = {
      id: orderId,
      order_number: orderNumber,
      name: `#${orderNumber}`,
      email: customer.email,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      processed_at: now.toISOString(),
      total_price: total.toFixed(2),
      subtotal_price: subtotal.toFixed(2),
      total_tax: totalTax.toFixed(2),
      total_discounts: totalDiscount.toFixed(2),
      total_shipping_price_set: {
        shop_money: { amount: shippingCost.toFixed(2), currency_code: currency },
        presentment_money: { amount: shippingCost.toFixed(2), currency_code: currency },
      },
      currency,
      financial_status: options.financialStatus || 'paid',
      fulfillment_status: options.fulfillmentStatus || null,
      confirmed: true,
      test: options.testOrder ?? true,
      gateway: 'shopify_payments',
      checkout_token: crypto.randomBytes(16).toString('hex'),
      customer,
      billing_address: billingAddress,
      shipping_address: shippingAddress,
      line_items: lineItems,
      shipping_lines: [shippingLine],
      tax_lines: [
        {
          title: 'VAT',
          price: totalTax.toFixed(2),
          rate: 0.19,
          channel_liable: false,
        },
      ],
      discount_codes: discountCodes,
      note: Math.random() > 0.7 ? 'Please handle with care - fragile items' : null,
      note_attributes: [],
      tags: options.testOrder ? 'stress-test' : '',
      cancelled_at: null,
      cancel_reason: null,
      refunds: [],
      payment_gateway_names: ['shopify_payments'],
      source_name: 'web',
      total_weight: totalWeight,
      browser_ip: `192.168.${this.randomInt(0, 255)}.${this.randomInt(1, 254)}`,
      landing_site: '/products/test-product',
      referring_site: 'https://google.com',
      cart_token: crypto.randomBytes(16).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      closed_at: null,
      app_id: 580111,
      location_id: null,
    };

    // Add refund if requested
    if (options.includeRefund && options.financialStatus === 'partially_refunded') {
      const refundItem = lineItems[0];
      order.refunds = [
        {
          id: this.randomInt(10000000000, 99999999999),
          created_at: now.toISOString(),
          note: 'Customer requested refund',
          restock: true,
          refund_line_items: [
            {
              id: this.randomInt(10000000000, 99999999999),
              line_item_id: refundItem.id,
              quantity: 1,
              subtotal: refundItem.price,
              total_tax: refundItem.tax_lines[0]?.price || '0',
            },
          ],
        },
      ];
    }

    return order;
  }

  /**
   * Generate multiple orders
   */
  generateBatch(count: number, options: GeneratorOptions = {}): ShopifyOrderPayload[] {
    const orders: ShopifyOrderPayload[] = [];
    for (let i = 0; i < count; i++) {
      orders.push(this.generate(options));
    }
    return orders;
  }

  /**
   * Generate a webhook payload (wraps order in webhook format)
   */
  generateWebhookPayload(options: GeneratorOptions = {}): {
    topic: string;
    order: ShopifyOrderPayload;
    hmac: string;
    shopDomain: string;
  } {
    const order = this.generate(options);
    const shopDomain = 'test-store.myshopify.com';
    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || 'test-secret';
    
    // Generate HMAC signature
    const hmac = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(order))
      .digest('base64');

    return {
      topic: 'orders/paid',
      order,
      hmac,
      shopDomain,
    };
  }

  /**
   * Reset counters (useful for consistent test data)
   */
  resetCounters(startingId: number = 5000000000000): void {
    this.orderIdCounter = startingId;
    this.orderNumberCounter = 1000;
    this.customerIdCounter = 7000000000000;
    this.productIdCounter = 8000000000000;
    this.variantIdCounter = 9000000000000;
  }
}

// Export singleton instance
export const shopifyOrderGenerator = new ShopifyOrderGenerator();

// Export for direct use
export function generateShopifyOrder(options: GeneratorOptions = {}): ShopifyOrderPayload {
  return shopifyOrderGenerator.generate(options);
}

export function generateShopifyOrderBatch(count: number, options: GeneratorOptions = {}): ShopifyOrderPayload[] {
  return shopifyOrderGenerator.generateBatch(count, options);
}

export function generateShopifyWebhookPayload(options: GeneratorOptions = {}) {
  return shopifyOrderGenerator.generateWebhookPayload(options);
}
