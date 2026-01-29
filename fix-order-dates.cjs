/**
 * Migration Script: Fix Order Dates
 *
 * This script fetches the original order creation date from each channel (Shopify/WooCommerce)
 * and updates the orderDate in the database.
 *
 * Run with: node fix-order-dates.cjs
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Decryption service for channel secrets
function decrypt(encryptedText) {
  const algorithm = 'aes-256-gcm';
  const encryptionKey = process.env.ENCRYPTION_KEY || 'your-32-character-secret-key!!';
  const key = Buffer.from(encryptionKey.padEnd(32, '0').slice(0, 32));

  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    // Assume it's not encrypted
    return encryptedText;
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// Simple HTTP client for Shopify
async function fetchShopifyOrder(shop, accessToken, orderId) {
  const fetch = (await import('node-fetch')).default;
  const url = `https://${shop}/admin/api/2024-01/orders/${orderId}.json`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.order;
}

// Simple HTTP client for WooCommerce
async function fetchWooCommerceOrder(url, consumerKey, consumerSecret, orderId) {
  const fetch = (await import('node-fetch')).default;
  const baseUrl = url.replace(/\/$/, '');
  const apiUrl = `${baseUrl}/wp-json/wc/v3/orders/${orderId}`;

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const response = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`WooCommerce API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fixOrderDates() {
  console.log('🔄 Starting order date migration...\n');

  try {
    // Get all orders with their channel info
    const orders = await prisma.order.findMany({
      where: {
        externalOrderId: { not: null },
      },
      select: {
        id: true,
        externalOrderId: true,
        orderDate: true,
        createdAt: true,
        channelId: true,
        channel: {
          select: {
            id: true,
            type: true,
            shopifyShop: true,
            shopifyAccessToken: true,
            wooCommerceUrl: true,
            wooCommerceConsumerKey: true,
            wooCommerceConsumerSecret: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    console.log(`Found ${orders.length} orders with external IDs\n`);

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    // Group orders by channel to minimize API calls
    const ordersByChannel = {};
    for (const order of orders) {
      if (!order.channelId) {
        skipped++;
        continue;
      }
      if (!ordersByChannel[order.channelId]) {
        ordersByChannel[order.channelId] = [];
      }
      ordersByChannel[order.channelId].push(order);
    }

    // Process each channel
    for (const channelId of Object.keys(ordersByChannel)) {
      const channelOrders = ordersByChannel[channelId];
      const channel = channelOrders[0].channel;

      if (!channel) {
        console.log(`⚠️  Channel ${channelId} not found, skipping ${channelOrders.length} orders`);
        skipped += channelOrders.length;
        continue;
      }

      console.log(`\n📦 Processing ${channelOrders.length} orders from channel ${channelId} (${channel.type})...`);

      for (const order of channelOrders) {
        try {
          let originalOrderDate;

          if (channel.type === 'SHOPIFY' && channel.shopifyShop && channel.shopifyAccessToken) {
            // Decrypt token if needed
            const accessToken = decrypt(channel.shopifyAccessToken);

            // Parse external order ID (might be a string like "gid://shopify/Order/123" or just "123")
            let shopifyOrderId = order.externalOrderId;
            if (shopifyOrderId.includes('/')) {
              shopifyOrderId = shopifyOrderId.split('/').pop();
            }

            const shopifyOrder = await fetchShopifyOrder(
              channel.shopifyShop,
              accessToken,
              shopifyOrderId
            );

            if (shopifyOrder && shopifyOrder.created_at) {
              originalOrderDate = new Date(shopifyOrder.created_at);
            }
          } else if (channel.type === 'WOOCOMMERCE' && channel.wooCommerceUrl) {
            // Decrypt credentials if needed
            const consumerKey = decrypt(channel.wooCommerceConsumerKey);
            const consumerSecret = decrypt(channel.wooCommerceConsumerSecret);

            const wooOrder = await fetchWooCommerceOrder(
              channel.wooCommerceUrl,
              consumerKey,
              consumerSecret,
              order.externalOrderId
            );

            if (wooOrder && wooOrder.date_created) {
              originalOrderDate = new Date(wooOrder.date_created);
            }
          } else {
            console.log(`  ⏭️  Order ${order.externalOrderId}: Unsupported channel type ${channel.type}`);
            skipped++;
            continue;
          }

          if (!originalOrderDate) {
            console.log(`  ⚠️  Order ${order.externalOrderId}: Could not get original date`);
            skipped++;
            continue;
          }

          // Check if dates are different (more than 1 minute difference)
          const currentDate = new Date(order.orderDate);
          const timeDiff = Math.abs(originalOrderDate.getTime() - currentDate.getTime());

          if (timeDiff < 60000) {
            // Less than 1 minute difference, skip
            skipped++;
            continue;
          }

          // Update the order date
          await prisma.order.update({
            where: { id: order.id },
            data: { orderDate: originalOrderDate },
          });

          console.log(`  ✅ Order ${order.externalOrderId}: Updated ${currentDate.toISOString()} → ${originalOrderDate.toISOString()}`);
          updated++;

          // Rate limiting - small delay between API calls
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
          console.log(`  ❌ Order ${order.externalOrderId}: ${error.message}`);
          errors.push({ orderId: order.id, externalId: order.externalOrderId, error: error.message });
          failed++;
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 Migration Summary:');
    console.log(`   ✅ Updated: ${updated}`);
    console.log(`   ⏭️  Skipped: ${skipped}`);
    console.log(`   ❌ Failed: ${failed}`);

    if (errors.length > 0) {
      console.log('\n❌ Errors:');
      errors.forEach(e => console.log(`   - Order ${e.externalId}: ${e.error}`));
    }

    console.log('\n✨ Order date migration completed!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Run the migration
fixOrderDates();
