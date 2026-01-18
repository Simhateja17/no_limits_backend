/**
 * Stress Test Configuration
 * Central configuration for all stress testing parameters
 */

export interface StressTestConfig {
  // Environment
  environment: 'development' | 'staging' | 'production';
  testMode: boolean; // When true, prevents real warehouse orders
  
  // Target endpoints
  apiBaseUrl: string;
  webhookBaseUrl: string;
  
  // Test scenarios
  scenarios: {
    low: ScenarioConfig;
    medium: ScenarioConfig;
    high: ScenarioConfig;
  };
  
  // Rate limiting
  rateLimits: {
    shopify: {
      requestsPerMinute: number;
      burstSize: number;
    };
    woocommerce: {
      requestsPerMinute: number;
      burstSize: number;
    };
  };
  
  // Database
  database: {
    connectionPoolSize: number;
    queryTimeout: number;
  };
  
  // Queue
  queue: {
    maxConcurrentJobs: number;
    jobTimeout: number;
  };
  
  // Metrics collection
  metrics: {
    collectInterval: number; // ms
    retentionPeriod: number; // ms
  };
}

export interface ScenarioConfig {
  name: string;
  description: string;
  totalOrders: number;
  duration: number; // seconds
  rampUpTime: number; // seconds
  shopifyPercentage: number; // 0-100
  woocommercePercentage: number; // 0-100
  pattern: 'steady' | 'burst' | 'wave' | 'spike';
  concurrentUsers: number;
}

export const defaultConfig: StressTestConfig = {
  environment: 'development',
  testMode: true,
  
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3001',
  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || 'http://localhost:3001/api/webhooks',
  
  scenarios: {
    low: {
      name: 'Low Volume Test',
      description: 'Baseline test with 100-500 orders',
      totalOrders: 300,
      duration: 300, // 5 minutes
      rampUpTime: 30, // 30 seconds
      shopifyPercentage: 50,
      woocommercePercentage: 50,
      pattern: 'steady',
      concurrentUsers: 10,
    },
    medium: {
      name: 'Medium Volume Test',
      description: 'Busy day simulation with 1,000-5,000 orders',
      totalOrders: 2500,
      duration: 600, // 10 minutes
      rampUpTime: 60, // 1 minute
      shopifyPercentage: 60,
      woocommercePercentage: 40,
      pattern: 'burst',
      concurrentUsers: 50,
    },
    high: {
      name: 'High Volume Test',
      description: 'Black Friday/Cyber Monday simulation with 10,000+ orders',
      totalOrders: 10000,
      duration: 1800, // 30 minutes
      rampUpTime: 120, // 2 minutes
      shopifyPercentage: 70,
      woocommercePercentage: 30,
      pattern: 'wave',
      concurrentUsers: 100,
    },
  },
  
  rateLimits: {
    shopify: {
      requestsPerMinute: 40, // Shopify REST API limit
      burstSize: 10,
    },
    woocommerce: {
      requestsPerMinute: 100, // Self-hosted, configurable
      burstSize: 20,
    },
  },
  
  database: {
    connectionPoolSize: 20,
    queryTimeout: 30000, // 30 seconds
  },
  
  queue: {
    maxConcurrentJobs: 10,
    jobTimeout: 60000, // 60 seconds
  },
  
  metrics: {
    collectInterval: 1000, // 1 second
    retentionPeriod: 3600000, // 1 hour
  },
};

// Test data configuration
export const testDataConfig = {
  // Customer name pools
  firstNames: [
    'Emma', 'Liam', 'Sophia', 'Noah', 'Olivia', 'William', 'Ava', 'James',
    'Isabella', 'Oliver', 'Mia', 'Benjamin', 'Charlotte', 'Elijah', 'Amelia',
    'Lucas', 'Harper', 'Mason', 'Evelyn', 'Logan', 'Anna', 'Max', 'Maria',
    'Felix', 'Laura', 'Paul', 'Julia', 'Leon', 'Sophie', 'Finn', 'Sarah',
  ],
  
  lastNames: [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
    'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
    'Mueller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner',
    'Becker', 'Schulz', 'Hoffmann', 'Koch', 'Richter', 'Klein', 'Wolf',
  ],
  
  // Address pools (Germany-focused for EU testing)
  cities: [
    { name: 'Berlin', zip: '10115', country: 'Germany', countryCode: 'DE' },
    { name: 'Munich', zip: '80331', country: 'Germany', countryCode: 'DE' },
    { name: 'Hamburg', zip: '20095', country: 'Germany', countryCode: 'DE' },
    { name: 'Frankfurt', zip: '60311', country: 'Germany', countryCode: 'DE' },
    { name: 'Cologne', zip: '50667', country: 'Germany', countryCode: 'DE' },
    { name: 'Stuttgart', zip: '70173', country: 'Germany', countryCode: 'DE' },
    { name: 'Dusseldorf', zip: '40213', country: 'Germany', countryCode: 'DE' },
    { name: 'Vienna', zip: '1010', country: 'Austria', countryCode: 'AT' },
    { name: 'Zurich', zip: '8001', country: 'Switzerland', countryCode: 'CH' },
    { name: 'Amsterdam', zip: '1012', country: 'Netherlands', countryCode: 'NL' },
    { name: 'Paris', zip: '75001', country: 'France', countryCode: 'FR' },
    { name: 'London', zip: 'W1A 1AA', country: 'United Kingdom', countryCode: 'GB' },
  ],
  
  streets: [
    'Hauptstrasse', 'Bahnhofstrasse', 'Schulstrasse', 'Gartenstrasse',
    'Dorfstrasse', 'Bergstrasse', 'Kirchstrasse', 'Waldstrasse',
    'Ringstrasse', 'Marktplatz', 'Lindenstrasse', 'Mozartstrasse',
  ],
  
  // Shipping methods
  shippingMethods: {
    shopify: [
      { title: 'Standard Shipping', code: 'standard', price: '4.99' },
      { title: 'Express Shipping', code: 'express', price: '9.99' },
      { title: 'Free Shipping', code: 'free_shipping', price: '0.00' },
      { title: 'DHL Express', code: 'dhl_express', price: '14.99' },
      { title: 'UPS Standard', code: 'ups_standard', price: '7.99' },
    ],
    woocommerce: [
      { method_title: 'Flat Rate', method_id: 'flat_rate', total: '4.99' },
      { method_title: 'Free Shipping', method_id: 'free_shipping', total: '0.00' },
      { method_title: 'Local Pickup', method_id: 'local_pickup', total: '0.00' },
      { method_title: 'DHL Paket', method_id: 'dhl_paket', total: '5.99' },
      { method_title: 'Express Delivery', method_id: 'express', total: '12.99' },
    ],
  },
  
  // Sample products (SKUs)
  products: [
    { sku: 'TSHIRT-BLK-M', name: 'Classic T-Shirt Black Medium', price: 29.99, weight: 200 },
    { sku: 'TSHIRT-WHT-L', name: 'Classic T-Shirt White Large', price: 29.99, weight: 200 },
    { sku: 'JEANS-BLU-32', name: 'Denim Jeans Blue 32', price: 79.99, weight: 500 },
    { sku: 'HOODIE-GRY-XL', name: 'Comfort Hoodie Grey XL', price: 59.99, weight: 450 },
    { sku: 'SNEAKER-WHT-42', name: 'Sport Sneakers White 42', price: 119.99, weight: 800 },
    { sku: 'CAP-BLK-OS', name: 'Baseball Cap Black One Size', price: 24.99, weight: 100 },
    { sku: 'JACKET-NVY-M', name: 'Winter Jacket Navy Medium', price: 149.99, weight: 900 },
    { sku: 'SHORTS-KHK-L', name: 'Cargo Shorts Khaki Large', price: 44.99, weight: 300 },
    { sku: 'DRESS-RED-S', name: 'Summer Dress Red Small', price: 89.99, weight: 250 },
    { sku: 'SCARF-MIX-OS', name: 'Wool Scarf Mixed One Size', price: 34.99, weight: 150 },
    { sku: 'BELT-BRN-M', name: 'Leather Belt Brown Medium', price: 39.99, weight: 200 },
    { sku: 'SOCKS-BLK-3PK', name: 'Cotton Socks Black 3-Pack', price: 14.99, weight: 100 },
    { sku: 'WATCH-SLV-OS', name: 'Classic Watch Silver', price: 199.99, weight: 150 },
    { sku: 'BAG-BLK-OS', name: 'Backpack Black', price: 69.99, weight: 600 },
    { sku: 'GLASSES-BLK-OS', name: 'Sunglasses Black', price: 89.99, weight: 50 },
  ],
  
  // Email domains for testing
  emailDomains: [
    'test-customer.com',
    'example-store.de',
    'stress-test.io',
    'load-test.net',
  ],
};

export function getConfig(): StressTestConfig {
  return {
    ...defaultConfig,
    apiBaseUrl: process.env.API_BASE_URL || defaultConfig.apiBaseUrl,
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL || defaultConfig.webhookBaseUrl,
    testMode: process.env.TEST_MODE !== 'false',
  };
}
