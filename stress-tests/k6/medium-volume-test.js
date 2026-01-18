/**
 * k6 Load Test: Medium Volume (1,000-5,000 orders)
 * Busy day / Flash sale simulation
 * 
 * Run with: k6 run backend/stress-tests/k6/medium-volume-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import crypto from 'k6/crypto';

// Custom metrics
const webhooksProcessed = new Counter('webhooks_processed');
const webhookErrors = new Counter('webhook_errors');
const shopifyWebhooks = new Counter('shopify_webhooks');
const woocommerceWebhooks = new Counter('woocommerce_webhooks');
const successRate = new Rate('success_rate');
const webhookDuration = new Trend('webhook_duration');
const activeVUs = new Gauge('active_vus');

// Test configuration - Medium volume with burst pattern
export const options = {
  scenarios: {
    // Initial burst (simulates flash sale start)
    flash_sale_burst: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 200,
      stages: [
        { duration: '30s', target: 20 },  // Quick ramp to burst
        { duration: '1m', target: 20 },   // Sustained burst
        { duration: '30s', target: 10 },  // Ease off
      ],
      gracefulStop: '30s',
    },
    // Sustained traffic after burst
    sustained_traffic: {
      executor: 'ramping-arrival-rate',
      startTime: '2m30s',
      startRate: 8,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 150,
      stages: [
        { duration: '5m', target: 8 },    // Steady 8 orders/sec
        { duration: '1m', target: 15 },   // Second smaller burst
        { duration: '1m', target: 5 },    // Wind down
        { duration: '30s', target: 0 },   // Stop
      ],
      gracefulStop: '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000', 'p(99)<5000'],
    success_rate: ['rate>0.90'],
    webhook_errors: ['count<250'],
    http_req_failed: ['rate<0.10'],
  },
};

// Configuration
const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3001';
const CHANNEL_ID = __ENV.CHANNEL_ID || 'test-channel-id';
const SHOPIFY_WEBHOOK_SECRET = __ENV.SHOPIFY_WEBHOOK_SECRET || 'test-secret';
const WOOCOMMERCE_WEBHOOK_SECRET = __ENV.WOOCOMMERCE_WEBHOOK_SECRET || 'test-secret';
const SHOPIFY_PERCENTAGE = parseInt(__ENV.SHOPIFY_PERCENTAGE || '60');

// Extended test data pools
const firstNames = [
  'Emma', 'Liam', 'Sophia', 'Noah', 'Olivia', 'William', 'Ava', 'James',
  'Isabella', 'Oliver', 'Mia', 'Benjamin', 'Charlotte', 'Elijah', 'Amelia',
  'Lucas', 'Harper', 'Mason', 'Evelyn', 'Logan', 'Anna', 'Max', 'Maria',
];
const lastNames = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Mueller', 'Schmidt', 'Schneider', 'Fischer',
];
const cities = [
  { name: 'Berlin', zip: '10115', country: 'Germany', countryCode: 'DE' },
  { name: 'Munich', zip: '80331', country: 'Germany', countryCode: 'DE' },
  { name: 'Hamburg', zip: '20095', country: 'Germany', countryCode: 'DE' },
  { name: 'Frankfurt', zip: '60311', country: 'Germany', countryCode: 'DE' },
  { name: 'Cologne', zip: '50667', country: 'Germany', countryCode: 'DE' },
  { name: 'Vienna', zip: '1010', country: 'Austria', countryCode: 'AT' },
  { name: 'Zurich', zip: '8001', country: 'Switzerland', countryCode: 'CH' },
];
const products = [
  { sku: 'TSHIRT-BLK-M', name: 'Classic T-Shirt Black Medium', price: 29.99, weight: 200 },
  { sku: 'TSHIRT-WHT-L', name: 'Classic T-Shirt White Large', price: 29.99, weight: 200 },
  { sku: 'JEANS-BLU-32', name: 'Denim Jeans Blue 32', price: 79.99, weight: 500 },
  { sku: 'HOODIE-GRY-XL', name: 'Comfort Hoodie Grey XL', price: 59.99, weight: 450 },
  { sku: 'SNEAKER-WHT-42', name: 'Sport Sneakers White 42', price: 119.99, weight: 800 },
  { sku: 'CAP-BLK-OS', name: 'Baseball Cap Black One Size', price: 24.99, weight: 100 },
  { sku: 'JACKET-NVY-M', name: 'Winter Jacket Navy Medium', price: 149.99, weight: 900 },
];
const shippingMethodsShopify = [
  { title: 'Standard Shipping', code: 'standard', price: '4.99' },
  { title: 'Express Shipping', code: 'express', price: '9.99' },
  { title: 'Free Shipping', code: 'free_shipping', price: '0.00' },
];
const shippingMethodsWoo = [
  { method_title: 'Flat Rate', method_id: 'flat_rate', total: '4.99' },
  { method_title: 'Free Shipping', method_id: 'free_shipping', total: '0.00' },
  { method_title: 'Express Delivery', method_id: 'express', total: '12.99' },
];

// Unique ID generator with higher starting point
let orderIdCounter = Date.now() + 1000000;
function nextOrderId() {
  return orderIdCounter++;
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generate Shopify order with multiple items
function generateShopifyOrder() {
  const orderId = nextOrderId();
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);
  const city = randomItem(cities);
  const shipping = randomItem(shippingMethodsShopify);
  const itemCount = randomIntBetween(1, 4);
  
  const lineItems = [];
  let subtotal = 0;
  const usedProducts = new Set();
  
  for (let i = 0; i < itemCount; i++) {
    let product;
    do {
      product = randomItem(products);
    } while (usedProducts.has(product.sku) && usedProducts.size < products.length);
    usedProducts.add(product.sku);
    
    const quantity = randomIntBetween(1, 3);
    subtotal += product.price * quantity;
    
    lineItems.push({
      id: randomIntBetween(10000000000, 99999999999),
      variant_id: randomIntBetween(40000000000, 49999999999),
      product_id: randomIntBetween(8000000000, 8999999999),
      title: product.name,
      name: product.name,
      sku: product.sku,
      quantity: quantity,
      price: product.price.toFixed(2),
      grams: product.weight,
      fulfillment_status: null,
    });
  }
  
  const tax = subtotal * 0.19;
  const shippingCost = parseFloat(shipping.price);
  const total = subtotal + tax + shippingCost;

  return {
    id: orderId,
    order_number: orderId,
    name: `#${orderId}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomIntBetween(1000, 9999)}@test-medium.com`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
    total_price: total.toFixed(2),
    subtotal_price: subtotal.toFixed(2),
    total_tax: tax.toFixed(2),
    currency: 'EUR',
    financial_status: 'paid',
    fulfillment_status: null,
    confirmed: true,
    test: true,
    customer: {
      id: randomIntBetween(7000000000000, 7999999999999),
      email: `${firstName.toLowerCase()}@test-medium.com`,
      first_name: firstName,
      last_name: lastName,
      phone: `+49${randomIntBetween(100000000, 999999999)}`,
      accepts_marketing: Math.random() > 0.5,
    },
    shipping_address: {
      first_name: firstName,
      last_name: lastName,
      company: Math.random() > 0.7 ? `${lastName} GmbH` : null,
      address1: `Hauptstrasse ${randomIntBetween(1, 150)}`,
      address2: Math.random() > 0.8 ? `Apt ${randomIntBetween(1, 50)}` : null,
      city: city.name,
      province: city.name,
      zip: city.zip,
      country: city.country,
      country_code: city.countryCode,
      phone: `+49${randomIntBetween(100000000, 999999999)}`,
    },
    billing_address: {
      first_name: firstName,
      last_name: lastName,
      address1: `Hauptstrasse ${randomIntBetween(1, 150)}`,
      city: city.name,
      zip: city.zip,
      country: city.country,
      country_code: city.countryCode,
    },
    line_items: lineItems,
    shipping_lines: [{
      id: randomIntBetween(1000000000, 9999999999),
      title: shipping.title,
      price: shipping.price,
      code: shipping.code,
    }],
    tax_lines: [{
      title: 'VAT',
      price: tax.toFixed(2),
      rate: 0.19,
    }],
    note: Math.random() > 0.85 ? 'Please handle with care' : null,
    tags: 'stress-test,k6,medium-volume',
  };
}

// Generate WooCommerce order with multiple items
function generateWooCommerceOrder() {
  const orderId = nextOrderId();
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);
  const city = randomItem(cities);
  const shipping = randomItem(shippingMethodsWoo);
  const itemCount = randomIntBetween(1, 4);
  
  const lineItems = [];
  let subtotal = 0;
  const usedProducts = new Set();
  
  for (let i = 0; i < itemCount; i++) {
    let product;
    do {
      product = randomItem(products);
    } while (usedProducts.has(product.sku) && usedProducts.size < products.length);
    usedProducts.add(product.sku);
    
    const quantity = randomIntBetween(1, 3);
    const itemTotal = product.price * quantity;
    const itemTax = itemTotal * 0.19;
    subtotal += itemTotal;
    
    lineItems.push({
      id: randomIntBetween(1, 99999),
      name: product.name,
      product_id: randomIntBetween(100, 9999),
      variation_id: 0,
      quantity: quantity,
      sku: product.sku,
      price: product.price,
      subtotal: itemTotal.toFixed(2),
      total: itemTotal.toFixed(2),
      subtotal_tax: itemTax.toFixed(2),
      total_tax: itemTax.toFixed(2),
    });
  }
  
  const cartTax = subtotal * 0.19;
  const shippingTotal = parseFloat(shipping.total);
  const shippingTax = shippingTotal * 0.19;
  const total = subtotal + cartTax + shippingTotal + shippingTax;

  return {
    id: orderId,
    parent_id: 0,
    number: String(orderId),
    order_key: `wc_order_${crypto.randomBytes(8, 'hex')}`,
    created_via: 'checkout',
    version: '8.5.0',
    status: 'processing',
    currency: 'EUR',
    date_created: new Date().toISOString(),
    date_created_gmt: new Date().toISOString(),
    date_modified: new Date().toISOString(),
    date_modified_gmt: new Date().toISOString(),
    discount_total: '0.00',
    discount_tax: '0.00',
    shipping_total: shippingTotal.toFixed(2),
    shipping_tax: shippingTax.toFixed(2),
    cart_tax: cartTax.toFixed(2),
    total: total.toFixed(2),
    total_tax: (cartTax + shippingTax).toFixed(2),
    prices_include_tax: false,
    customer_id: randomIntBetween(100, 9999),
    customer_ip_address: `192.168.${randomIntBetween(0, 255)}.${randomIntBetween(1, 254)}`,
    customer_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
    customer_note: Math.random() > 0.85 ? 'Please leave at door' : '',
    billing: {
      first_name: firstName,
      last_name: lastName,
      company: Math.random() > 0.7 ? `${lastName} GmbH` : '',
      address_1: `Hauptstrasse ${randomIntBetween(1, 150)}`,
      address_2: Math.random() > 0.8 ? `Apt ${randomIntBetween(1, 50)}` : '',
      city: city.name,
      state: city.countryCode,
      postcode: city.zip,
      country: city.countryCode,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomIntBetween(1000, 9999)}@test-medium.com`,
      phone: `+49${randomIntBetween(100000000, 999999999)}`,
    },
    shipping: {
      first_name: firstName,
      last_name: lastName,
      company: '',
      address_1: `Hauptstrasse ${randomIntBetween(1, 150)}`,
      address_2: '',
      city: city.name,
      state: city.countryCode,
      postcode: city.zip,
      country: city.countryCode,
    },
    payment_method: Math.random() > 0.5 ? 'stripe' : 'paypal',
    payment_method_title: Math.random() > 0.5 ? 'Credit Card (Stripe)' : 'PayPal',
    transaction_id: crypto.randomBytes(12, 'hex'),
    date_paid: new Date().toISOString(),
    date_paid_gmt: new Date().toISOString(),
    line_items: lineItems,
    shipping_lines: [{
      id: randomIntBetween(1, 9999),
      method_title: shipping.method_title,
      method_id: shipping.method_id,
      instance_id: String(randomIntBetween(1, 10)),
      total: shipping.total,
      total_tax: shippingTax.toFixed(2),
    }],
    tax_lines: [{
      id: 1,
      rate_code: 'DE-VAT-1',
      rate_id: 1,
      label: 'VAT',
      compound: false,
      tax_total: cartTax.toFixed(2),
      shipping_tax_total: shippingTax.toFixed(2),
      rate_percent: 19,
    }],
    meta_data: [
      { id: 1, key: '_stress_test', value: 'true' },
      { id: 2, key: '_k6_test', value: 'medium_volume' },
    ],
    set_paid: true,
  };
}

// HMAC signature generation
function generateHmac(data, secret) {
  return crypto.hmac('sha256', secret, data, 'base64');
}

// Send Shopify webhook
function sendShopifyWebhook(order) {
  const body = JSON.stringify(order);
  const hmac = generateHmac(body, SHOPIFY_WEBHOOK_SECRET);
  
  return http.post(
    `${BASE_URL}/api/webhooks/shopify/${CHANNEL_ID}`,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Shop-Domain': 'test-store-medium.myshopify.com',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Webhook-Id': crypto.randomBytes(16, 'hex'),
        'X-Stress-Test': 'true',
        'X-Test-Mode': 'true',
      },
      tags: { name: 'ShopifyWebhook' },
    }
  );
}

// Send WooCommerce webhook
function sendWooCommerceWebhook(order) {
  const body = JSON.stringify(order);
  const signature = generateHmac(body, WOOCOMMERCE_WEBHOOK_SECRET);
  
  return http.post(
    `${BASE_URL}/api/webhooks/woocommerce/${CHANNEL_ID}`,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-WC-Webhook-Topic': 'order.created',
        'X-WC-Webhook-Source': 'https://test-store-medium.example.com',
        'X-WC-Webhook-Signature': signature,
        'X-WC-Webhook-Delivery-ID': crypto.randomBytes(16, 'hex'),
        'X-Stress-Test': 'true',
        'X-Test-Mode': 'true',
      },
      tags: { name: 'WooCommerceWebhook' },
    }
  );
}

// Main test function
export default function() {
  activeVUs.add(__VU);
  
  // 60% Shopify, 40% WooCommerce (configurable)
  const isShopify = (Math.random() * 100) < SHOPIFY_PERCENTAGE;
  
  let response;
  if (isShopify) {
    const order = generateShopifyOrder();
    response = sendShopifyWebhook(order);
    shopifyWebhooks.add(1);
  } else {
    const order = generateWooCommerceOrder();
    response = sendWooCommerceWebhook(order);
    woocommerceWebhooks.add(1);
  }

  webhookDuration.add(response.timings.duration);
  webhooksProcessed.add(1);

  const success = check(response, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'response time < 3s': (r) => r.timings.duration < 3000,
    'no server error': (r) => r.status < 500,
  });

  successRate.add(success);
  
  if (!success) {
    webhookErrors.add(1);
    if (response.status >= 500) {
      console.log(`Server Error: ${response.status} - ${response.body?.substring(0, 200)}`);
    }
  }

  // Minimal delay to maintain high throughput
  sleep(randomIntBetween(10, 50) / 1000);
}

export function setup() {
  console.log('🚀 Starting Medium Volume Stress Test');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Channel: ${CHANNEL_ID}`);
  console.log('   Expected orders: ~2,500-3,000');
  console.log('   Pattern: Burst + Sustained traffic');
  console.log(`   Platform mix: ${SHOPIFY_PERCENTAGE}% Shopify, ${100 - SHOPIFY_PERCENTAGE}% WooCommerce`);
  
  const healthCheck = http.get(`${BASE_URL}/health`);
  if (healthCheck.status !== 200) {
    console.warn('⚠️ Health check failed - server may not be ready');
  }
  
  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`\n✅ Medium Volume Test Complete`);
  console.log(`   Duration: ${duration.toFixed(2)}s`);
}

export function handleSummary(data) {
  const metrics = data.metrics;
  const summary = `
================================================================================
                          MEDIUM VOLUME TEST SUMMARY
================================================================================

Requests:
  Total:          ${metrics.http_reqs?.values?.count || 0}
  Success Rate:   ${((metrics.success_rate?.values?.rate || 0) * 100).toFixed(2)}%
  Errors:         ${metrics.webhook_errors?.values?.count || 0}
  Failed Reqs:    ${((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%

Response Times:
  Average:        ${(metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms
  Min:            ${(metrics.http_req_duration?.values?.min || 0).toFixed(2)}ms
  Max:            ${(metrics.http_req_duration?.values?.max || 0).toFixed(2)}ms
  Median:         ${(metrics.http_req_duration?.values?.med || 0).toFixed(2)}ms
  P90:            ${(metrics.http_req_duration?.values['p(90)'] || 0).toFixed(2)}ms
  P95:            ${(metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms
  P99:            ${(metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2)}ms

Platform Breakdown:
  Shopify:        ${metrics.shopify_webhooks?.values?.count || 0}
  WooCommerce:    ${metrics.woocommerce_webhooks?.values?.count || 0}

Throughput:
  Requests/sec:   ${(metrics.http_reqs?.values?.rate || 0).toFixed(2)}
  Data Received:  ${((metrics.data_received?.values?.count || 0) / 1024 / 1024).toFixed(2)} MB
  Data Sent:      ${((metrics.data_sent?.values?.count || 0) / 1024 / 1024).toFixed(2)} MB

Checks:
  Passed:         ${metrics.checks?.values?.passes || 0}
  Failed:         ${metrics.checks?.values?.fails || 0}

================================================================================
`;

  console.log(summary);
  
  return {
    'stdout': summary,
    'reports/medium-volume-summary.json': JSON.stringify(data, null, 2),
  };
}
