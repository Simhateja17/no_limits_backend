#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function checkClientOrders() {
  try {
    const email = 'miimee.tube@gmail.com';
    
    console.log(`📊 Checking orders for client: ${email}\n`);

    // Find the user and client
    const user = await prisma.user.findUnique({
      where: { email },
      include: { client: true },
    });

    if (!user) {
      console.log(`❌ No user found with email: ${email}`);
      return;
    }

    if (!user.client) {
      console.log(`❌ No client record found for user: ${email}`);
      return;
    }

    const clientId = user.client.id;

    console.log(`Client: ${user.client.companyName}`);
    console.log(`Client ID: ${clientId}\n`);

    // Get order counts by status
    const totalOrders = await prisma.order.count({
      where: { clientId },
    });

    const ordersByStatus = await prisma.order.groupBy({
      by: ['status'],
      where: { clientId },
      _count: true,
    });

    const ordersByFulfillmentState = await prisma.order.groupBy({
      by: ['fulfillmentState'],
      where: { clientId },
      _count: true,
    });

    // Get some additional stats
    const totalOrderItems = await prisma.orderItem.count({
      where: {
        order: {
          clientId,
        },
      },
    });

    const ordersOnHold = await prisma.order.count({
      where: {
        clientId,
        isOnHold: true,
      },
    });

    const cancelledOrders = await prisma.order.count({
      where: {
        clientId,
        isCancelled: true,
      },
    });

    // Display results
    console.log('═══════════════════════════════════════');
    console.log('📦 ORDER STATISTICS');
    console.log('═══════════════════════════════════════');
    console.log(`Total Orders: ${totalOrders}`);
    console.log(`Total Order Items: ${totalOrderItems}`);
    console.log(`Orders On Hold: ${ordersOnHold}`);
    console.log(`Cancelled Orders: ${cancelledOrders}`);
    
    console.log('\n───────────────────────────────────────');
    console.log('📋 ORDERS BY STATUS:');
    console.log('───────────────────────────────────────');
    if (ordersByStatus.length > 0) {
      ordersByStatus.forEach(({ status, _count }) => {
        console.log(`  ${status}: ${_count}`);
      });
    } else {
      console.log('  No orders found');
    }

    console.log('\n───────────────────────────────────────');
    console.log('🚚 ORDERS BY FULFILLMENT STATE:');
    console.log('───────────────────────────────────────');
    if (ordersByFulfillmentState.length > 0) {
      ordersByFulfillmentState.forEach(({ fulfillmentState, _count }) => {
        console.log(`  ${fulfillmentState}: ${_count}`);
      });
    } else {
      console.log('  No orders found');
    }

    console.log('═══════════════════════════════════════\n');

  } catch (err) {
    console.error('❌ Error checking client orders:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

checkClientOrders();
