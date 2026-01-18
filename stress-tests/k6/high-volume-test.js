/**
 * k6 Load Test: High Volume (10,000+ orders)
 * Black Friday / Cyber Monday simulation
 * 
 * Run with: k6 run backend/stress-tests/k6/high-volume-test.js
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
const queueBackpressure = new Counter('queue_backpressure');

// Test configuration - High volume with wave pattern
export const options = {
  scenarios: {
    // Wave 1: Morning rush
    wave1_morning_rush: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 400,
      stages: [
        { duration: '1m', target: 30 },   // Ramp up fast
        { duration: '3m', target: 30 },   // Peak morning
        { duration: '1m', target: 15 },   // Ease off
      ],
      gracefulStop: '30s',
    },
    // Wave 2: Lunch surge
    wave2_lunch_surge: {
      executor: 'ramping-arrival-rate',
      startTime: '6m',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 400,
      stages: [
        { duration: '1m', target: 40 },   // Bigger ramp
        { duration: '4m', target: 40 },   // Sustained peak
        { duration: '1m', target: 20 },   // Gradual decrease
      ],
      gracefulStop: '30s',
    },
    // Wave 3: Evening peak (biggest)
    wave3_evening_peak: {
      executor: 'ramping-arrival-rate',
      startTime: '13m',
      startRate: 15,
      timeUnit: '1s',
      preAllocatedVUs: 300,
      maxVUs: 500,
      stages: [
        { duration: '2m', target: 50 },   // Aggressive ramp
        { duration: '5m', target: 50 },   // Maximum sustained
        { duration: '2m', target: 25 },   // Wind down
        { duration: '1m', target: 5 },    // Cool off
        { duration: '30s', target: 0 },   // Stop
      ],
      gracefulStop: '1m',
    },
  },
  thresholds: {
    http_req_duration: ['p(90)<3000', 'p(95)<5000', 'p(99)<10000'],
    success_rate: ['rate>0.85'],
    webhook_errors: ['count<1500'],
    http_req_failed: ['rate<0.15'],
  },
};

// Configuration
const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:3001';
const CHANNEL_ID = __ENV.CHANNEL_ID || 'test-channel-id';
const SHOPIFY_WEBHOOK_SECRET = __ENV.SHOPIFY_WEBHOOK_SECRET || 'test-secret';
const WOOCOMMERCE_WEBHOOK_SECRET = __ENV.WOOCOMMERCE_WEBHOOK_SECRET || 'test-secret';
const SHOPIFY_PERCENTAGE = parseInt(__ENV.SHOPIFY_PERCENTAGE || '70');

// Comprehensive test data pools
const firstNames = [
  'Emma', 'Liam', 'Sophia', 'Noah', 'Olivia', 'William', 'Ava', 'James',
  'Isabella', 'Oliver', 'Mia', 'Benjamin', 'Charlotte', 'Elijah', 'Amelia',
  'Lucas', 'Harper', 'Mason', 'Evelyn', 'Logan', 'Anna', 'Max', 'Maria',
  'Felix', 'Laura', 'Paul', 'Julia', 'Leon', 'Sophie', 'Finn', 'Sarah',
  'Tom', 'Lisa', 'David', 'Jennifer', 'Michael', 'Jessica', 'Chris', 'Amanda',
];
const lastNames = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Mueller', 'Schmidt', 'Schneider', 'Fischer',
  'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Koch', 'Richter',
  'Klein', 'Wolf', 'Schroeder', 'Neumann', 'Schwarz', 'Braun', 'Hofmann', 'Hartmann',
];
const cities = [
  { name: 'Berlin', zip: '10115', country: 'Germany', countryCode: 'DE' },
  { name: 'Munich', zip: '80331', country: 'Germany', countryCode: 'DE' },
  { name: 'Hamburg', zip: '20095', country: 'Germany', countryCode: 'DE' },
  { name: 'Frankfurt', zip: '60311', country: 'Germany', countryCode: 'DE' },
  { name: 'Cologne', zip: '50667', country: 'Germany', countryCode: 'DE' },
  { name: 'Stuttgart', zip: '70173', country: 'Germany', countryCode: 'DE' },
  { name: 'Dusseldorf', zip: '40213', country: 'Germany', countryCode: 'DE' },
  { name: 'Leipzig', zip: '04109', country: 'Germany', countryCode: 'DE' },
  { name: 'Dortmund', zip: '44135', country: 'Germany', countryCode: 'DE' },
  { name: 'Essen', zip: '45127', country: 'Germany', countryCode: 'DE' },
  { name: 'Vienna', zip: '1010', country: 'Austria', countryCode: 'AT' },
  { name: 'Zurich', zip: '8001', country: 'Switzerland', countryCode: 'CH' },
  { name: 'Amsterdam', zip: '1012', country: 'Netherlands', countryCode: 'NL' },
  { name: 'Paris', zip: '75001', country: 'France', countryCode: 'FR' },
  { name: 'London', zip: 'W1A 1AA', country: 'United Kingdom', countryCode: 'GB' },
];
const products = [
  { sku: 'TSHIRT-BLK-M', name: 'Classic T-Shirt Black Medium', price: 29.99, weight: 200 },
  { sku: 'TSHIRT-WHT-L', name: 'Classic T-Shirt White Large', price: 29.99, weight: 200 },
  { sku: 'TSHIRT-BLU-S', name: 'Classic T-Shirt Blue Small', price: 29.99, weight: 200 },
  { sku: 'JEANS-BLU-32', name: 'Denim Jeans Blue 32', price: 79.99, weight: 500 },
  { sku: 'JEANS-BLK-34', name: 'Denim Jeans Black 34', price: 79.99, weight: 500 },
  { sku: 'HOODIE-GRY-XL', name: 'Comfort Hoodie Grey XL', price: 59.99, weight: 450 },
  { sku: 'HOODIE-BLK-L', name: 'Comfort Hoodie Black Large', price: 59.99, weight: 450 },
  { sku: 'SNEAKER-WHT-42', name: 'Sport Sneakers White 42', price: 119.99, weight: 800 },
  { sku: 'SNEAKER-BLK-44', name: 'Sport Sneakers Black 44', price: 119.99, weight: 800 },
  { sku: 'CAP-BLK-OS', name: 'Baseball Cap Black One Size', price: 24.99, weight: 100 },
  { sku: 'JACKET-NVY-M', name: 'Winter Jacket Navy Medium', price: 149.99, weight: 900 },
  { sku: 'SHORTS-KHK-L', name: 'Cargo Shorts Khaki Large', price: 44.99, weight: 300 },
  { sku: 'DRESS-RED-S', name: 'Summer Dress Red Small', price: 89.99, weight: 250 },
  { sku: 'SCARF-MIX-OS', name: 'Wool Scarf Mixed One Size', price: 34.99, weight: 150 },
  { sku: 'BELT-BRN-M', name: 'Leather Belt Brown Medium', price: 39.99, weight: 200 },
];
const shippingMethodsShopify = [
  { title: 'Standard Shipping', code: 'standard', price: '4.99' },
  { title: 'Express Shipping', code: 'express', price: '9.99' },
  { title: 'Free Shipping', code: 'free_shipping', price: '0.00' },
  { title: 'DHL Express', code: 'dhl_express', price: '14.99' },
  { title: 'Next Day Delivery', code: 'next_day', price: '19.99' },
];
const shippingMethodsWoo = [
  { method_title: 'Flat Rate', method_id: 'flat_rate', total: '4.99' },
  { method_title: 'Free Shipping', method_id: 'free_shipping', total: '0.00' },
  { method_title: 'Express Delivery', method_id: 'express', total: '12.99' },
  { method_title: 'DHL Paket', method_id: 'dhl_paket', total: '5.99' },
  { method_title: 'Premium Delivery', method_id: 'premium', total: '24.99' },
];

// Unique ID generator with very high starting point to avoid collisions
let orderIdCounter = Date.now() + 10000000;
function nextOrderId() {
  return orderIdCounter++;
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generate complex Shopify order with variable items
function generateShopifyOrder() {
  const orderId = nextOrderId();
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);
  const city = randomItem(cities);
  const shipping = randomItem(shippingMethodsShopify);
  
  // Black Friday orders tend to be larger
  const itemCount = randomIntBetween(1, 6);
  
  const lineItems = [];
  let subtotal = 0;
  let totalWeight = 0;
  const usedProducts = new Set();
  
  for (let i = 0; i < itemCount; i++) {
    let product;
    do {
      product = randomItem(products);
    } while (usedProducts.has(product.sku) && usedProducts.size < products.length);
    usedProducts.add(product.sku);
    
    const quantity = randomIntBetween(1, 4);
    const itemSubtotal = product.price * quantity;
    subtotal += itemSubtotal;
    totalWeight += product.weight * quantity;
    
    lineItems.push({
      id: randomIntBetween(10000000000, 99999999999),
      variant_id: randomIntBetween(40000000000, 49999999999),
      product_id: randomIntBetween(8000000000, 8999999999),
      title: product.name.split(' ').slice(0, -1).join(' '),
      name: product.name,
      sku: product.sku,
      vendor: 'Test Vendor',
      quantity: quantity,
      price: product.price.toFixed(2),
      total_discount: '0.00',
      grams: product.weight,
      fulfillment_status: null,
      requires_shipping: true,
      taxable: true,
      fulfillable_quantity: quantity,
    });
  }
  
  // Potential Black Friday discount
  const hasDiscount = Math.random() > 0.6;
  const discountAmount = hasDiscount ? subtotal * 0.2 : 0; // 20% off
  subtotal = subtotal - discountAmount;
  
  const tax = subtotal * 0.19;
  const shippingCost = parseFloat(shipping.price);
  const total = subtotal + tax + shippingCost;

  return {
    id: orderId,
    order_number: orderId,
    name: `#${orderId}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomIntBetween(1000, 9999)}@blackfriday-test.com`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
    total_price: total.toFixed(2),
    subtotal_price: subtotal.toFixed(2),
    total_tax: tax.toFixed(2),
    total_discounts: discountAmount.toFixed(2),
    total_weight: totalWeight,
    currency: 'EUR',
    financial_status: 'paid',
    fulfillment_status: null,
    confirmed: true,
    test: true,
    gateway: Math.random() > 0.3 ? 'shopify_payments' : 'paypal',
    customer: {
      id: randomIntBetween(7000000000000, 7999999999999),
      email: `${firstName.toLowerCase()}@blackfriday-test.com`,
      first_name: firstName,
      last_name: lastName,
      phone: `+${city.countryCode === 'DE' ? '49' : city.countryCode === 'AT' ? '43' : '41'}${randomIntBetween(100000000, 999999999)}`,
      accepts_marketing: Math.random() > 0.4,
      orders_count: randomIntBetween(1, 20),
      total_spent: (randomIntBetween(100, 5000) + Math.random()).toFixed(2),
    },
    shipping_address: {
      first_name: firstName,
      last_name: lastName,
      company: Math.random() > 0.75 ? `${lastName} GmbH` : null,
      address1: `Hauptstrasse ${randomIntBetween(1, 200)}`,
      address2: Math.random() > 0.85 ? `Apt ${randomIntBetween(1, 100)}` : null,
      city: city.name,
      province: city.name,
      province_code: city.countryCode,
      zip: city.zip,
      country: city.country,
      country_code: city.countryCode,
      phone: `+49${randomIntBetween(100000000, 999999999)}`,
      name: `${firstName} ${lastName}`,
    },
    billing_address: {
      first_name: firstName,
      last_name: lastName,
      address1: `Hauptstrasse ${randomIntBetween(1, 200)}`,
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
      source: 'shopify',
    }],
    tax_lines: [{
      title: 'VAT',
      price: tax.toFixed(2),
      rate: 0.19,
    }],
    discount_codes: hasDiscount ? [{
      code: 'BLACKFRIDAY20',
      amount: discountAmount.toFixed(2),
      type: 'percentage',
    }] : [],
    note: Math.random() > 0.9 ? 'Gift wrapping requested' : null,
    note_attributes: [],
    tags: 'stress-test,k6,high-volume,black-friday',
    source_name: 'web',
    browser_ip: `192.168.${randomIntBetween(0, 255)}.${randomIntBetween(1, 254)}`,
  };
}

// Generate complex WooCommerce order
function generateWooCommerceOrder() {
  const orderId = nextOrderId();
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);
  const city = randomItem(cities);
  const shipping = randomItem(shippingMethodsWoo);
  const itemCount = randomIntBetween(1, 6);
  
  const lineItems = [];
  let subtotal = 0;
  const usedProducts = new Set();
  
  for (let i = 0; i < itemCount; i++) {
    let product;
    do {
      product = randomItem(products);
    } while (usedProducts.has(product.sku) && usedProducts.size < products.length);
    usedProducts.add(product.sku);
    
    const quantity = randomIntBetween(1, 4);
    const itemTotal = product.price * quantity;
    const itemTax = itemTotal * 0.19;
    subtotal += itemTotal;
    
    lineItems.push({
      id: randomIntBetween(1, 999999),
      name: product.name,
      product_id: randomIntBetween(100, 99999),
      variation_id: 0,
      quantity: quantity,
      tax_class: '',
      sku: product.sku,
      price: product.price,
      subtotal: itemTotal.toFixed(2),
      subtotal_tax: itemTax.toFixed(2),
      total: itemTotal.toFixed(2),
      total_tax: itemTax.toFixed(2),
    });
  }
  
  // Black Friday discount
  const hasDiscount = Math.random() > 0.6;
  const discountAmount = hasDiscount ? subtotal * 0.2 : 0;
  const discountTax = discountAmount * 0.19;
  subtotal = subtotal - discountAmount;
  
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
    discount_total: discountAmount.toFixed(2),
    discount_tax: discountTax.toFixed(2),
    shipping_total: shippingTotal.toFixed(2),
    shipping_tax: shippingTax.toFixed(2),
    cart_tax: cartTax.toFixed(2),
    total: total.toFixed(2),
    total_tax: (cartTax + shippingTax - discountTax).toFixed(2),
    prices_include_tax: false,
    customer_id: randomIntBetween(100, 99999),
    customer_ip_address: `192.168.${randomIntBetween(0, 255)}.${randomIntBetween(1, 254)}`,
    customer_user_agent: 'Mozilla/5.0 (compatible; k6/stress-test)',
    customer_note: Math.random() > 0.9 ? 'Express delivery if possible' : '',
    billing: {
      first_name: firstName,
      last_name: lastName,
      company: Math.random() > 0.75 ? `${lastName} GmbH` : '',
      address_1: `Hauptstrasse ${randomIntBetween(1, 200)}`,
      address_2: Math.random() > 0.85 ? `Apt ${randomIntBetween(1, 100)}` : '',
      city: city.name,
      state: city.countryCode,
      postcode: city.zip,
      country: city.countryCode,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomIntBetween(1000, 9999)}@blackfriday-test.com`,
      phone: `+49${randomIntBetween(100000000, 999999999)}`,
    },
    shipping: {
      first_name: firstName,
      last_name: lastName,
      company: '',
      address_1: `Hauptstrasse ${randomIntBetween(1, 200)}`,
      address_2: '',
      city: city.name,
      state: city.countryCode,
      postcode: city.zip,
      country: city.countryCode,
    },
    payment_method: ['stripe', 'paypal', 'klarna'][randomIntBetween(0, 2)],
    payment_method_title: ['Credit Card', 'PayPal', 'Klarna'][randomIntBetween(0, 2)],
    transaction_id: crypto.randomBytes(12, 'hex'),
    date_paid: new Date().toISOString(),
    date_paid_gmt: new Date().toISOString(),
    line_items: lineItems,
    shipping_lines: [{
      id: randomIntBetween(1, 99999),
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
    coupon_lines: hasDiscount ? [{
      id: randomIntBetween(1, 999),
      code: 'BLACKFRIDAY20',
      discount: discountAmount.toFixed(2),
      discount_tax: discountTax.toFixed(2),
    }] : [],
    meta_data: [
      { id: 1, key: '_stress_test', value: 'true' },
      { id: 2, key: '_k6_test', value: 'high_volume' },
      { id: 3, key: '_black_friday', value: 'true' },
    ],
    set_paid: true,
  };
}

// HMAC signature generation
function generateHmac(data, secret) {
  return crypto.hmac('sha256', secret, data, 'base64');
}

// Send Shopify webhook with retry logic
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
        'X-Shopify-Shop-Domain': 'blackfriday-store.myshopify.com',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Webhook-Id': crypto.randomBytes(16, 'hex'),
        'X-Stress-Test': 'true',
        'X-Test-Mode': 'true',
        'X-Test-Scenario': 'high-volume',
      },
      tags: { name: 'ShopifyWebhook' },
      timeout: '30s',
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
        'X-WC-Webhook-Source': 'https://blackfriday-store.example.com',
        'X-WC-Webhook-Signature': signature,
        'X-WC-Webhook-Delivery-ID': crypto.randomBytes(16, 'hex'),
        'X-Stress-Test': 'true',
        'X-Test-Mode': 'true',
        'X-Test-Scenario': 'high-volume',
      },
      tags: { name: 'WooCommerceWebhook' },
      timeout: '30s',
    }
  );
}

// Main test function
export default function() {
  activeVUs.add(__VU);
  
  // 70% Shopify, 30% WooCommerce (typical Black Friday distribution)
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

  // Track backpressure (slow responses indicate queue backup)
  if (response.timings.duration > 5000) {
    queueBackpressure.add(1);
  }

  const success = check(response, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'response time < 5s': (r) => r.timings.duration < 5000,
    'response time < 10s': (r) => r.timings.duration < 10000,
    'no server error': (r) => r.status < 500,
  });

  successRate.add(success);
  
  if (!success) {
    webhookErrors.add(1);
    if (response.status >= 500) {
      console.log(`[${new Date().toISOString()}] Server Error: ${response.status}`);
    } else if (response.status === 429) {
      console.log(`[${new Date().toISOString()}] Rate Limited`);
    }
  }

  // Very minimal delay - high throughput test
  sleep(randomIntBetween(5, 20) / 1000);
}

export function setup() {
  console.log('🚀 Starting HIGH VOLUME Stress Test (Black Friday Simulation)');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Channel: ${CHANNEL_ID}`);
  console.log('   Expected orders: ~10,000-15,000');
  console.log('   Pattern: Three waves (Morning, Lunch, Evening Peak)');
  console.log(`   Platform mix: ${SHOPIFY_PERCENTAGE}% Shopify, ${100 - SHOPIFY_PERCENTAGE}% WooCommerce`);
  console.log('   Duration: ~24 minutes');
  console.log('');
  console.log('⚠️  WARNING: This is an intensive test. Monitor your system resources!');
  
  const healthCheck = http.get(`${BASE_URL}/health`);
  if (healthCheck.status !== 200) {
    console.error('❌ Health check failed - aborting test');
    throw new Error('Server not healthy');
  }
  
  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`\n✅ High Volume Test Complete`);
  console.log(`   Total Duration: ${(duration / 60).toFixed(2)} minutes`);
}

export function handleSummary(data) {
  const metrics = data.metrics;
  const totalReqs = metrics.http_reqs?.values?.count || 0;
  const successRateVal = (metrics.success_rate?.values?.rate || 0) * 100;
  const avgDuration = metrics.http_req_duration?.values?.avg || 0;
  
  // Determine if test passed
  const passed = successRateVal >= 85 && avgDuration < 5000;
  
  const summary = `
================================================================================
                    HIGH VOLUME (BLACK FRIDAY) TEST SUMMARY
================================================================================
                           ${passed ? '✅ TEST PASSED' : '❌ TEST FAILED'}
================================================================================

OVERVIEW:
  Total Requests:       ${totalReqs.toLocaleString()}
  Success Rate:         ${successRateVal.toFixed(2)}%
  Errors:               ${(metrics.webhook_errors?.values?.count || 0).toLocaleString()}
  HTTP Failures:        ${((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%
  Queue Backpressure:   ${(metrics.queue_backpressure?.values?.count || 0).toLocaleString()} (>5s responses)

RESPONSE TIMES:
  Average:              ${avgDuration.toFixed(2)}ms
  Minimum:              ${(metrics.http_req_duration?.values?.min || 0).toFixed(2)}ms
  Maximum:              ${(metrics.http_req_duration?.values?.max || 0).toFixed(2)}ms
  Median:               ${(metrics.http_req_duration?.values?.med || 0).toFixed(2)}ms
  P90:                  ${(metrics.http_req_duration?.values['p(90)'] || 0).toFixed(2)}ms
  P95:                  ${(metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms
  P99:                  ${(metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2)}ms

PLATFORM BREAKDOWN:
  Shopify:              ${(metrics.shopify_webhooks?.values?.count || 0).toLocaleString()} (${SHOPIFY_PERCENTAGE}% target)
  WooCommerce:          ${(metrics.woocommerce_webhooks?.values?.count || 0).toLocaleString()} (${100 - SHOPIFY_PERCENTAGE}% target)

THROUGHPUT:
  Requests/sec (avg):   ${(metrics.http_reqs?.values?.rate || 0).toFixed(2)}
  Peak RPS:             ~50 (during evening peak)
  Data Received:        ${((metrics.data_received?.values?.count || 0) / 1024 / 1024).toFixed(2)} MB
  Data Sent:            ${((metrics.data_sent?.values?.count || 0) / 1024 / 1024).toFixed(2)} MB

CHECKS:
  Passed:               ${(metrics.checks?.values?.passes || 0).toLocaleString()}
  Failed:               ${(metrics.checks?.values?.fails || 0).toLocaleString()}
  
THRESHOLDS:
  p(90) < 3000ms:       ${(metrics.http_req_duration?.values['p(90)'] || 0) < 3000 ? '✅ PASS' : '❌ FAIL'}
  p(95) < 5000ms:       ${(metrics.http_req_duration?.values['p(95)'] || 0) < 5000 ? '✅ PASS' : '❌ FAIL'}
  p(99) < 10000ms:      ${(metrics.http_req_duration?.values['p(99)'] || 0) < 10000 ? '✅ PASS' : '❌ FAIL'}
  Success Rate > 85%:   ${successRateVal >= 85 ? '✅ PASS' : '❌ FAIL'}

================================================================================
                              RECOMMENDATIONS
================================================================================
${successRateVal < 85 ? '- ERROR RATE TOO HIGH: Check server logs for bottlenecks\n' : ''}
${avgDuration > 3000 ? '- SLOW RESPONSES: Consider adding more database connections or workers\n' : ''}
${(metrics.queue_backpressure?.values?.count || 0) > totalReqs * 0.1 ? '- QUEUE BACKUP DETECTED: Increase queue workers or optimize processing\n' : ''}
${passed ? '- System handled Black Friday load well!\n- Consider running longer soak test\n' : '- Address performance issues before production deployment\n'}
================================================================================
`;

  console.log(summary);
  
  return {
    'stdout': summary,
    'reports/high-volume-summary.json': JSON.stringify(data, null, 2),
    'reports/high-volume-summary.txt': summary,
  };
}
