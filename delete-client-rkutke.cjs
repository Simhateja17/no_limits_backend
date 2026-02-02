#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function deleteClientData() {
  try {
    const email = 'r.kutke@gmx.de';
    
    console.log(`🗑️  Deleting all data for client: ${email}\n`);

    // Find the user and client
    const user = await prisma.user.findUnique({
      where: { email },
      include: { client: true },
    });

    if (!user) {
      console.log(`⚠️  No user found with email: ${email}`);
      return;
    }

    if (!user.client) {
      console.log(`⚠️  No client record found for user: ${email}`);
      return;
    }

    const clientId = user.client.id;
    const userId = user.id;

    console.log(`Found client: ${user.client.companyName} (ID: ${clientId})`);
    console.log(`User ID: ${userId}\n`);

    // Delete all related data in a transaction
    await prisma.$transaction(async (tx) => {
      // 1. Delete orders and related data
      console.log('Deleting orders...');
      const orders = await tx.order.findMany({
        where: { clientId },
        select: { id: true },
      });
      
      if (orders.length > 0) {
        const orderIds = orders.map(o => o.id);
        
        // Delete order items
        const deletedOrderItems = await tx.orderItem.deleteMany({
          where: { orderId: { in: orderIds } },
        });
        console.log(`  ✓ Deleted ${deletedOrderItems.count} order items`);
        
        // Delete order sync logs
        const deletedOrderSyncLogs = await tx.orderSyncLog.deleteMany({
          where: { orderId: { in: orderIds } },
        });
        console.log(`  ✓ Deleted ${deletedOrderSyncLogs.count} order sync logs`);

        // Delete order sync queue entries
        const deletedOrderSyncQueue = await tx.orderSyncQueue.deleteMany({
          where: { orderId: { in: orderIds } },
        });
        console.log(`  ✓ Deleted ${deletedOrderSyncQueue.count} order sync queue entries`);

        // Delete shipping method mismatches
        const deletedShippingMismatches = await tx.shippingMethodMismatch.deleteMany({
          where: { orderId: { in: orderIds } },
        });
        console.log(`  ✓ Deleted ${deletedShippingMismatches.count} shipping method mismatches`);
        
        // Delete orders
        const deletedOrders = await tx.order.deleteMany({
          where: { id: { in: orderIds } },
        });
        console.log(`  ✓ Deleted ${deletedOrders.count} orders`);
      } else {
        console.log(`  ✓ No orders found`);
      }

      // 2. Delete products
      console.log('\nDeleting products...');
      const deletedProducts = await tx.product.deleteMany({
        where: { clientId },
      });
      console.log(`  ✓ Deleted ${deletedProducts.count} products`);

      // 3. Delete inbound deliveries and related data
      console.log('\nDeleting inbound deliveries...');
      const inbounds = await tx.inboundDelivery.findMany({
        where: { clientId },
        select: { id: true },
      });
      
      if (inbounds.length > 0) {
        const inboundIds = inbounds.map(i => i.id);
        
        // Delete inbound items
        const deletedInboundItems = await tx.inboundItem.deleteMany({
          where: { inboundDeliveryId: { in: inboundIds } },
        });
        console.log(`  ✓ Deleted ${deletedInboundItems.count} inbound items`);
        
        // Delete inbound deliveries
        const deletedInbounds = await tx.inboundDelivery.deleteMany({
          where: { id: { in: inboundIds } },
        });
        console.log(`  ✓ Deleted ${deletedInbounds.count} inbound deliveries`);
      } else {
        console.log(`  ✓ No inbound deliveries found`);
      }

      // 4. Delete channels
      console.log('\nDeleting channels...');
      const deletedChannels = await tx.channel.deleteMany({
        where: { clientId },
      });
      console.log(`  ✓ Deleted ${deletedChannels.count} channels`);

      // 5. Delete chat rooms
      console.log('\nDeleting chat data...');
      const chatRooms = await tx.chatRoom.findMany({
        where: { clientId },
        select: { id: true },
      });

      if (chatRooms.length > 0) {
        const chatRoomIds = chatRooms.map(cr => cr.id);
        
        // Delete chat messages
        const deletedMessages = await tx.chatMessage.deleteMany({
          where: { chatRoomId: { in: chatRoomIds } },
        });
        console.log(`  ✓ Deleted ${deletedMessages.count} chat messages`);
        
        // Delete chat participants
        const deletedParticipants = await tx.chatParticipant.deleteMany({
          where: { chatRoomId: { in: chatRoomIds } },
        });
        console.log(`  ✓ Deleted ${deletedParticipants.count} chat participants`);
        
        // Delete chat rooms
        const deletedChatRooms = await tx.chatRoom.deleteMany({
          where: { id: { in: chatRoomIds } },
        });
        console.log(`  ✓ Deleted ${deletedChatRooms.count} chat rooms`);
      } else {
        console.log(`  ✓ No chat rooms found`);
      }

      // 6. Delete notifications
      console.log('\nDeleting notifications...');
      const deletedNotifications = await tx.notification.deleteMany({
        where: { clientId },
      });
      console.log(`  ✓ Deleted ${deletedNotifications.count} notifications`);

      // 7. Delete JTL config
      console.log('\nDeleting JTL configuration...');
      const deletedJtlConfig = await tx.jtlConfig.deleteMany({
        where: { clientId_fk: clientId },
      });
      console.log(`  ✓ Deleted ${deletedJtlConfig.count} JTL configs`);

      // 8. Delete integration configs
      console.log('\nDeleting integration configs...');
      const deletedShopifyOAuth = await tx.shopifyOAuthConfig.deleteMany({
        where: { clientId },
      });
      console.log(`  ✓ Deleted ${deletedShopifyOAuth.count} Shopify OAuth configs`);

      // 9. Delete client record
      console.log('\nDeleting client record...');
      await tx.client.delete({
        where: { id: clientId },
      });
      console.log(`  ✓ Deleted client: ${user.client.companyName}`);

      // 10. Delete user account
      console.log('\nDeleting user account...');
      await tx.user.delete({
        where: { id: userId },
      });
      console.log(`  ✓ Deleted user: ${email}`);
    }, { timeout: 20000 });

    console.log('\n✅ All data deleted successfully!');
  } catch (err) {
    console.error('❌ Error deleting client data:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

deleteClientData();
