/**
 * WooCommerce Order Payload Generator
 * Generates realistic WooCommerce webhook payloads for stress testing
 */

import crypto from 'crypto';
import { testDataConfig } from '../config/stress-test.config.js';

export interface WooCommerceOrderPayload {
  id: number;
  parent_id: number;
  number: string;
  order_key: string;
  created_via: string;
  version: string;
  status: 'pending' | 'processing' | 'on-hold' | 'completed' | 'cancelled' | 'refunded' | 'failed';
  currency: string;
  date_created: string;
  date_created_gmt: string;
  date_modified: string;
  date_modified_gmt: string;
  discount_total: string;
  discount_tax: string;
  shipping_total: string;
  shipping_tax: string;
  cart_tax: string;
  total: string;
  total_tax: string;
  prices_include_tax: boolean;
  customer_id: number;
  customer_ip_address: string;
  customer_user_agent: string;
  customer_note: string;
  billing: WooCommerceAddressPayload;
  shipping: WooCommerceAddressPayload;
  payment_method: string;
  payment_method_title: string;
  transaction_id: string;
  date_paid: string | null;
  date_paid_gmt: string | null;
  date_completed: string | null;
  date_completed_gmt: string | null;
  cart_hash: string;
  meta_data: Array<{ id: number; key: string; value: string }>;
  line_items: WooCommerceLineItemPayload[];
  tax_lines: WooCommerceTaxLinePayload[];
  shipping_lines: WooCommerceShippingLinePayload[];
  fee_lines: WooCommerceFeeLinePayload[];
  coupon_lines: WooCommerceCouponLinePayload[];
  refunds: WooCommerceRefundPayload[];
  set_paid: boolean;
  currency_symbol: string;
  _links: {
    self: Array<{ href: string }>;
    collection: Array<{ href: string }>;
  };
}

export interface WooCommerceAddressPayload {
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

export interface WooCommerceLineItemPayload {
  id: number;
  name: string;
  product_id: number;
  variation_id: number;
  quantity: number;
  tax_class: string;
  subtotal: string;
  subtotal_tax: string;
  total: string;
  total_tax: string;
  taxes: Array<{ id: number; total: string; subtotal: string }>;
  meta_data: Array<{ id: number; key: string; value: string; display_key: string; display_value: string }>;
  sku: string;
  price: number;
  image: { id: number; src: string };
  parent_name: string | null;
}

export interface WooCommerceTaxLinePayload {
  id: number;
  rate_code: string;
  rate_id: number;
  label: string;
  compound: boolean;
  tax_total: string;
  shipping_tax_total: string;
  rate_percent: number;
  meta_data: Array<{ id: number; key: string; value: string }>;
}

export interface WooCommerceShippingLinePayload {
  id: number;
  method_title: string;
  method_id: string;
  instance_id: string;
  total: string;
  total_tax: string;
  taxes: Array<{ id: number; total: string; subtotal: string }>;
  meta_data: Array<{ id: number; key: string; value: string }>;
}

export interface WooCommerceFeeLinePayload {
  id: number;
  name: string;
  tax_class: string;
  tax_status: string;
  amount: string;
  total: string;
  total_tax: string;
  taxes: Array<{ id: number; total: string; subtotal: string }>;
  meta_data: Array<{ id: number; key: string; value: string }>;
}

export interface WooCommerceCouponLinePayload {
  id: number;
  code: string;
  discount: string;
  discount_tax: string;
  meta_data: Array<{ id: number; key: string; value: string }>;
}

export interface WooCommerceRefundPayload {
  id: number;
  reason: string;
  total: string;
}

export interface WooGeneratorOptions {
  orderId?: number;
  orderNumber?: string;
  customerId?: number;
  itemCount?: { min: number; max: number };
  includeDiscount?: boolean;
  status?: WooCommerceOrderPayload['status'];
  includeRefund?: boolean;
  currency?: string;
  storeUrl?: string;
}

export class WooCommerceOrderGenerator {
  private orderIdCounter: number;
  private orderNumberCounter: number;
  private customerIdCounter: number;
  private productIdCounter: number;
  private lineItemIdCounter: number;

  constructor(startingId: number = 1000) {
    this.orderIdCounter = startingId;
    this.orderNumberCounter = startingId;
    this.customerIdCounter = 100;
    this.productIdCounter = 500;
    this.lineItemIdCounter = 10000;
  }

  /**
   * Generate unique IDs
   */
  private nextOrderId(): number {
    return this.orderIdCounter++;
  }

  private nextOrderNumber(): string {
    return String(this.orderNumberCounter++);
  }

  private nextCustomerId(): number {
    return this.customerIdCounter++;
  }

  private nextProductId(): number {
    return this.productIdCounter++;
  }

  private nextLineItemId(): number {
    return this.lineItemIdCounter++;
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
  private generateAddress(firstName: string, lastName: string, includeEmail: boolean = false): WooCommerceAddressPayload {
    const city = this.randomItem(testDataConfig.cities);
    const street = this.randomItem(testDataConfig.streets);
    const houseNumber = this.randomInt(1, 150);
    const hasCompany = Math.random() > 0.7;
    
    const address: WooCommerceAddressPayload = {
      first_name: firstName,
      last_name: lastName,
      company: hasCompany ? `${lastName} GmbH` : '',
      address_1: `${street} ${houseNumber}`,
      address_2: Math.random() > 0.8 ? `Apt ${this.randomInt(1, 50)}` : '',
      city: city.name,
      state: city.countryCode,
      postcode: city.zip,
      country: city.countryCode,
      phone: this.generatePhone(),
    };

    if (includeEmail) {
      address.email = this.generateEmail(firstName, lastName);
    }

    return address;
  }

  /**
   * Generate line items
   */
  private generateLineItems(count: number): WooCommerceLineItemPayload[] {
    const items: WooCommerceLineItemPayload[] = [];
    const usedProducts = new Set<string>();
    
    for (let i = 0; i < count; i++) {
      // Get a unique product
      let product;
      do {
        product = this.randomItem(testDataConfig.products);
      } while (usedProducts.has(product.sku) && usedProducts.size < testDataConfig.products.length);
      
      usedProducts.add(product.sku);
      const quantity = this.randomInt(1, 5);
      const subtotal = product.price * quantity;
      const taxRate = 0.19;
      const subtotalTax = subtotal * taxRate;
      
      items.push({
        id: this.nextLineItemId(),
        name: product.name,
        product_id: this.nextProductId(),
        variation_id: 0,
        quantity,
        tax_class: '',
        subtotal: subtotal.toFixed(2),
        subtotal_tax: subtotalTax.toFixed(2),
        total: subtotal.toFixed(2),
        total_tax: subtotalTax.toFixed(2),
        taxes: [
          {
            id: 1,
            total: subtotalTax.toFixed(2),
            subtotal: subtotalTax.toFixed(2),
          },
        ],
        meta_data: [],
        sku: product.sku,
        price: product.price,
        image: {
          id: this.randomInt(100, 999),
          src: `https://example.com/images/${product.sku.toLowerCase()}.jpg`,
        },
        parent_name: null,
      });
    }
    
    return items;
  }

  /**
   * Generate shipping line
   */
  private generateShippingLine(): WooCommerceShippingLinePayload {
    const shippingMethod = this.randomItem(testDataConfig.shippingMethods.woocommerce);
    const shippingTax = (parseFloat(shippingMethod.total) * 0.19).toFixed(2);
    
    return {
      id: this.randomInt(1, 9999),
      method_title: shippingMethod.method_title,
      method_id: shippingMethod.method_id,
      instance_id: String(this.randomInt(1, 10)),
      total: shippingMethod.total,
      total_tax: shippingTax,
      taxes: [
        {
          id: 1,
          total: shippingTax,
          subtotal: shippingTax,
        },
      ],
      meta_data: [],
    };
  }

  /**
   * Generate a complete WooCommerce order payload
   */
  generate(options: WooGeneratorOptions = {}): WooCommerceOrderPayload {
    const orderId = options.orderId || this.nextOrderId();
    const orderNumber = options.orderNumber || this.nextOrderNumber();
    const customerId = options.customerId || this.nextCustomerId();
    const itemCount = this.randomInt(
      options.itemCount?.min || 1,
      options.itemCount?.max || 5
    );
    
    const firstName = this.randomItem(testDataConfig.firstNames);
    const lastName = this.randomItem(testDataConfig.lastNames);
    
    const lineItems = this.generateLineItems(itemCount);
    const shippingLine = this.generateShippingLine();
    
    // Calculate totals
    const subtotal = lineItems.reduce((sum, item) => sum + parseFloat(item.subtotal), 0);
    const cartTax = lineItems.reduce((sum, item) => sum + parseFloat(item.total_tax), 0);
    const shippingTotal = parseFloat(shippingLine.total);
    const shippingTax = parseFloat(shippingLine.total_tax);
    
    // Apply discount if requested
    let discountTotal = 0;
    let discountTax = 0;
    const couponLines: WooCommerceCouponLinePayload[] = [];
    
    if (options.includeDiscount && Math.random() > 0.5) {
      discountTotal = subtotal * 0.1; // 10% discount
      discountTax = discountTotal * 0.19;
      couponLines.push({
        id: this.randomInt(1, 999),
        code: `STRESS${this.randomInt(1000, 9999)}`,
        discount: discountTotal.toFixed(2),
        discount_tax: discountTax.toFixed(2),
        meta_data: [],
      });
    }
    
    const totalTax = cartTax + shippingTax - discountTax;
    const total = subtotal + shippingTotal + totalTax - discountTotal;
    
    const now = new Date();
    const currency = options.currency || 'EUR';
    const storeUrl = options.storeUrl || 'https://test-store.example.com';
    
    const billingAddress = this.generateAddress(firstName, lastName, true);
    const shippingAddress = Math.random() > 0.2 
      ? { ...billingAddress, email: undefined }
      : this.generateAddress(firstName, lastName, false);

    // Payment methods
    const paymentMethods = [
      { method: 'stripe', title: 'Credit Card (Stripe)' },
      { method: 'paypal', title: 'PayPal' },
      { method: 'bacs', title: 'Direct Bank Transfer' },
      { method: 'cod', title: 'Cash on Delivery' },
    ];
    const payment = this.randomItem(paymentMethods);

    const order: WooCommerceOrderPayload = {
      id: orderId,
      parent_id: 0,
      number: orderNumber,
      order_key: `wc_order_${crypto.randomBytes(8).toString('hex')}`,
      created_via: 'checkout',
      version: '8.5.0',
      status: options.status || 'processing',
      currency,
      date_created: now.toISOString(),
      date_created_gmt: now.toISOString(),
      date_modified: now.toISOString(),
      date_modified_gmt: now.toISOString(),
      discount_total: discountTotal.toFixed(2),
      discount_tax: discountTax.toFixed(2),
      shipping_total: shippingTotal.toFixed(2),
      shipping_tax: shippingTax.toFixed(2),
      cart_tax: cartTax.toFixed(2),
      total: total.toFixed(2),
      total_tax: totalTax.toFixed(2),
      prices_include_tax: false,
      customer_id: customerId,
      customer_ip_address: `192.168.${this.randomInt(0, 255)}.${this.randomInt(1, 254)}`,
      customer_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      customer_note: Math.random() > 0.7 ? 'Please deliver to reception' : '',
      billing: billingAddress,
      shipping: shippingAddress,
      payment_method: payment.method,
      payment_method_title: payment.title,
      transaction_id: crypto.randomBytes(12).toString('hex'),
      date_paid: options.status === 'processing' || options.status === 'completed' ? now.toISOString() : null,
      date_paid_gmt: options.status === 'processing' || options.status === 'completed' ? now.toISOString() : null,
      date_completed: options.status === 'completed' ? now.toISOString() : null,
      date_completed_gmt: options.status === 'completed' ? now.toISOString() : null,
      cart_hash: crypto.randomBytes(16).toString('hex'),
      meta_data: [
        { id: 1, key: '_stress_test', value: 'true' },
        { id: 2, key: '_test_batch_id', value: crypto.randomBytes(4).toString('hex') },
      ],
      line_items: lineItems,
      tax_lines: [
        {
          id: 1,
          rate_code: 'DE-VAT-1',
          rate_id: 1,
          label: 'VAT',
          compound: false,
          tax_total: cartTax.toFixed(2),
          shipping_tax_total: shippingTax.toFixed(2),
          rate_percent: 19,
          meta_data: [],
        },
      ],
      shipping_lines: [shippingLine],
      fee_lines: [],
      coupon_lines: couponLines,
      refunds: [],
      set_paid: options.status === 'processing' || options.status === 'completed',
      currency_symbol: currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency,
      _links: {
        self: [{ href: `${storeUrl}/wp-json/wc/v3/orders/${orderId}` }],
        collection: [{ href: `${storeUrl}/wp-json/wc/v3/orders` }],
      },
    };

    // Add refund if requested
    if (options.includeRefund && options.status === 'refunded') {
      order.refunds = [
        {
          id: this.randomInt(1, 9999),
          reason: 'Customer requested refund',
          total: `-${total.toFixed(2)}`,
        },
      ];
    }

    return order;
  }

  /**
   * Generate multiple orders
   */
  generateBatch(count: number, options: WooGeneratorOptions = {}): WooCommerceOrderPayload[] {
    const orders: WooCommerceOrderPayload[] = [];
    for (let i = 0; i < count; i++) {
      orders.push(this.generate(options));
    }
    return orders;
  }

  /**
   * Generate a webhook payload (wraps order in webhook format)
   */
  generateWebhookPayload(options: WooGeneratorOptions = {}): {
    topic: string;
    order: WooCommerceOrderPayload;
    signature: string;
    source: string;
    deliveryId: string;
  } {
    const order = this.generate(options);
    const webhookSecret = process.env.WOOCOMMERCE_WEBHOOK_SECRET || 'test-secret';
    const storeUrl = options.storeUrl || 'https://test-store.example.com';
    
    // Generate signature (WooCommerce uses base64 encoded HMAC-SHA256)
    const signature = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(order))
      .digest('base64');

    return {
      topic: 'order.created',
      order,
      signature,
      source: storeUrl,
      deliveryId: crypto.randomBytes(16).toString('hex'),
    };
  }

  /**
   * Reset counters (useful for consistent test data)
   */
  resetCounters(startingId: number = 1000): void {
    this.orderIdCounter = startingId;
    this.orderNumberCounter = startingId;
    this.customerIdCounter = 100;
    this.productIdCounter = 500;
    this.lineItemIdCounter = 10000;
  }
}

// Export singleton instance
export const wooCommerceOrderGenerator = new WooCommerceOrderGenerator();

// Export for direct use
export function generateWooCommerceOrder(options: WooGeneratorOptions = {}): WooCommerceOrderPayload {
  return wooCommerceOrderGenerator.generate(options);
}

export function generateWooCommerceOrderBatch(count: number, options: WooGeneratorOptions = {}): WooCommerceOrderPayload[] {
  return wooCommerceOrderGenerator.generateBatch(count, options);
}

export function generateWooCommerceWebhookPayload(options: WooGeneratorOptions = {}) {
  return wooCommerceOrderGenerator.generateWebhookPayload(options);
}
