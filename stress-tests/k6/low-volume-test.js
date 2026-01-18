/**
 * k6 Load Test: Low Volume (100-500 orders)
 * Baseline performance test
 * 
 * Run with: k6 run backend/stress-tests/k6/low-volume-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import crypto from 'k6/crypto';

// Custom metrics
const webhooksProcessed = new Counter('webhooks_processed');
const webhookErrors = new Counter('webhook_errors');
const shopifyWebhooks = new Counter('shopify_webhooks');
const woocommerceWebhooks = new Counter('woocommerce_webhooks');
const successRate = new Rate('success_rate');
const webhookDuration = new Trend('webhook_duration');

// Test configuration
export const options = {
  scenarios: {
    low_volume: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 50,
      stages: [
        { duration: '30s', target: 2 },  // Ramp up
        { duration: '4m', target: 2 },   // Steady state ~480 orders
        { duration: '30s', target: 0 },  // Ramp down
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
    success_rate: ['rate>0.95'],
    webhook_errors: ['count<25'],
  },
};

// Configuration
const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3001';
const CHANNEL_ID = __ENV.CHANNEL_ID || 'test-channel-id';
const SHOPIFY_WEBHOOK_SECRET = __ENV.SHOPIFY_WEBHOOK_SECRET || 'test-secret';
const WOOCOMMERCE_WEBHOOK_SECRET = __ENV.WOOCOMMERCE_WEBHOOK_SECRET || 'test-secret';

// Test data pools
const firstNames = ['Emma', 'Liam', 'Sophia', 'Noah', 'Olivia', 'William', 'Ava', 'James', 'Isabella', 'Oliver'];
const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Mueller', 'Schmidt'];
const cities = [
  { name: 'Berlin', zip: '10115', country: 'Germany', countryCode: 'DE' },
  { name: 'Munich', zip: '80331', country: 'Germany', countryCode: 'DE' },
  { name: 'Hamburg', zip: '20095', country: 'Germany', countryCode: 'DE' },
];
const products = [
  { sku: 'TSHIRT-BLK-M', name: 'Classic T-Shirt Black Medium', price: 29.99 },
  { sku: 'JEANS-BLU-32', name: 'Denim Jeans Blue 32', price: 79.99 },
  { sku: 'HOODIE-GRY-XL', name: 'Comfort Hoodie Grey XL', price: 59.99 },
];

// Unique ID generator
let orderIdCounter = Date.now();
function nextOrderId() {
  return orderIdCounter++;
}

// Random helpers
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generate Shopify order payload
function generateShopifyOrder() {
  const orderId = nextOrderId();
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);
  const city = randomItem(cities);
  const product = randomItem(products);
  const quantity = randomIntBetween(1, 3);
  const subtotal = product.price * quantity;
  const tax = subtotal * 0.19;
  const total = subtotal + tax + 4.99;

  return {
    id: orderId,
    order_number: orderId,
    name: `#${orderId}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomIntBetween(1000, 9999)}@test.com`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    total_price: total.toFixed(2),
    subtotal_price: subtotal.toFixed(2),
    total_tax: tax.toFixed(2),
    currency: 'EUR',
    financial_status: 'paid',
    fulfillment_status: null,
    test: true,
    customer: {
      id: randomIntBetween(7000000000000, 7999999999999),
      email: `${firstName.toLowerCase()}@test.com`,
      first_name: firstName,
      last_name: lastName,
      phone: `+49${randomIntBetween(100000000, 999999999)}`,
    },
    shipping_address: {
      first_name: firstName,
      last_name: lastName,
      address1: `Hauptstrasse ${randomIntBetween(1, 100)}`,
      city: city.name,
      zip: city.zip,
      country: city.country,
      country_code: city.countryCode,
    },
    billing_address: {
      first_name: firstName,
      last_name: lastName,
      address1: `Hauptstrasse ${randomIntBetween(1, 100)}`,
      city: city.name,
      zip: city.zip,
      country: city.country,
      country_code: city.countryCode,
    },
    line_items: [{
      id: randomIntBetween(10000000000, 99999999999),
      variant_id: randomIntBetween(40000000000, 49999999999),
      product_id: randomIntBetween(8000000000, 8999999999),
      title: product.name,
      name: product.name,
      sku: product.sku,
      quantity: quantity,
      price: product.price.toFixed(2),
      grams: 200,
    }],
    shipping_lines: [{
      id: randomIntBetween(1000000000, 9999999999),
      title: 'Standard Shipping',
      price: '4.99',
      code: 'standard',
    }],
    tags: 'stress-test,k6',
  };
}

// Generate WooCommerce order payload
function generateWooCommerceOrder() {
  const orderId = nextOrderId();
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);
  const city = randomItem(cities);
  const product = randomItem(products);
  const quantity = randomIntBetween(1, 3);
  const subtotal = product.price * quantity;
  const tax = subtotal * 0.19;
  const total = subtotal + tax + 4.99;

  return {
    id: orderId,
    number: String(orderId),
    order_key: `wc_order_${crypto.randomBytes(8, 'hex')}`,
    status: 'processing',
    currency: 'EUR',
    date_created: new Date().toISOString(),
    date_modified: new Date().toISOString(),
    total: total.toFixed(2),
    total_tax: tax.toFixed(2),
    shipping_total: '4.99',
    customer_id: randomIntBetween(100, 999),
    customer_note: '',
    billing: {
      first_name: firstName,
      last_name: lastName,
      address_1: `Hauptstrasse ${randomIntBetween(1, 100)}`,
      city: city.name,
      postcode: city.zip,
      country: city.countryCode,
      email: `${firstName.toLowerCase()}@test.com`,
      phone: `+49${randomIntBetween(100000000, 999999999)}`,
    },
    shipping: {
      first_name: firstName,
      last_name: lastName,
      address_1: `Hauptstrasse ${randomIntBetween(1, 100)}`,
      city: city.name,
      postcode: city.zip,
      country: city.countryCode,
    },
    line_items: [{
      id: randomIntBetween(1, 9999),
      name: product.name,
      product_id: randomIntBetween(100, 999),
      quantity: quantity,
      sku: product.sku,
      price: product.price,
      subtotal: subtotal.toFixed(2),
      total: subtotal.toFixed(2),
      total_tax: tax.toFixed(2),
    }],
    shipping_lines: [{
      id: randomIntBetween(1, 999),
      method_title: 'Flat Rate',
      method_id: 'flat_rate',
      total: '4.99',
    }],
    meta_data: [
      { key: '_stress_test', value: 'true' },
      { key: '_k6_test', value: 'low_volume' },
    ],
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
  
  const response = http.post(
    `${BASE_URL}/api/webhooks/shopify/${CHANNEL_ID}`,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': 'orders/paid',
        'X-Shopify-Shop-Domain': 'test-store.myshopify.com',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Webhook-Id': crypto.randomBytes(16, 'hex'),
        'X-Stress-Test': 'true',
        'X-Test-Mode': 'true',
      },
      tags: { name: 'ShopifyWebhook' },
    }
  );

  return response;
}

// Send WooCommerce webhook
function sendWooCommerceWebhook(order) {
  const body = JSON.stringify(order);
  const signature = generateHmac(body, WOOCOMMERCE_WEBHOOK_SECRET);
  
  const response = http.post(
    `${BASE_URL}/api/webhooks/woocommerce/${CHANNEL_ID}`,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-WC-Webhook-Topic': 'order.created',
        'X-WC-Webhook-Source': 'https://test-store.example.com',
        'X-WC-Webhook-Signature': signature,
        'X-WC-Webhook-Delivery-ID': crypto.randomBytes(16, 'hex'),
        'X-Stress-Test': 'true',
        'X-Test-Mode': 'true',
      },
      tags: { name: 'WooCommerceWebhook' },
    }
  );

  return response;
}

// Main test function
export default function() {
  // Randomly choose platform (50/50 split)
  const isShopify = Math.random() > 0.5;
  
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

  // Record metrics
  webhookDuration.add(response.timings.duration);
  webhooksProcessed.add(1);

  const success = check(response, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'response time < 2s': (r) => r.timings.duration < 2000,
  });

  successRate.add(success);
  
  if (!success) {
    webhookErrors.add(1);
    console.log(`Error: ${response.status} - ${response.body}`);
  }

  // Small random delay between requests
  sleep(randomIntBetween(100, 500) / 1000);
}

// Setup function
export function setup() {
  console.log('🚀 Starting Low Volume Stress Test');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Channel: ${CHANNEL_ID}`);
  console.log('   Expected orders: ~300-500');
  
  // Optional: Health check
  const healthCheck = http.get(`${BASE_URL}/health`);
  if (healthCheck.status !== 200) {
    console.warn('⚠️ Health check failed - server may not be ready');
  }
  
  return { startTime: Date.now() };
}

// Teardown function
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`\n✅ Low Volume Test Complete`);
  console.log(`   Duration: ${duration.toFixed(2)}s`);
}

// Handle summary
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'reports/low-volume-summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, options) {
  const metrics = data.metrics;
  return `
================================================================================
                           LOW VOLUME TEST SUMMARY
================================================================================

Requests:
  Total:        ${metrics.http_reqs?.values?.count || 0}
  Success Rate: ${((metrics.success_rate?.values?.rate || 0) * 100).toFixed(2)}%
  Errors:       ${metrics.webhook_errors?.values?.count || 0}

Response Times:
  Average:      ${(metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms
  Min:          ${(metrics.http_req_duration?.values?.min || 0).toFixed(2)}ms
  Max:          ${(metrics.http_req_duration?.values?.max || 0).toFixed(2)}ms
  P95:          ${(metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms
  P99:          ${(metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2)}ms

Platform Breakdown:
  Shopify:      ${metrics.shopify_webhooks?.values?.count || 0}
  WooCommerce:  ${metrics.woocommerce_webhooks?.values?.count || 0}

Throughput:
  Requests/sec: ${(metrics.http_reqs?.values?.rate || 0).toFixed(2)}

================================================================================
`;
}
