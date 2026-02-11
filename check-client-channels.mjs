#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const clientId = process.argv[2] || 'cmkfdr8ey0001xrs1uyby0102';

async function main() {
  console.log(`\n🔍 Looking for channels for client: ${clientId}\n`);

  const channels = await prisma.channel.findMany({
    where: {
      clientId,
      type: 'SHOPIFY'
    },
    include: {
      client: {
        select: { name: true, email: true }
      }
    }
  });

  if (channels.length === 0) {
    console.log('❌ No Shopify channels found for this client.');
    console.log('\nTrying to find ANY channels for this client...\n');

    const allChannels = await prisma.channel.findMany({
      where: { clientId },
      include: {
        client: {
          select: { name: true, email: true }
        }
      }
    });

    if (allChannels.length === 0) {
      console.log('❌ No channels found at all for this client.');
      console.log('\nChecking if client exists...\n');

      const client = await prisma.client.findUnique({
        where: { id: clientId }
      });

      if (!client) {
        console.log('❌ Client not found!');
      } else {
        console.log('✅ Client exists:', client.name);
        console.log('   But has no channels configured.');
      }
    } else {
      console.log(`✅ Found ${allChannels.length} channel(s):\n`);
      allChannels.forEach((ch, idx) => {
        console.log(`${idx + 1}. ${ch.name}`);
        console.log(`   ID: ${ch.id}`);
        console.log(`   Type: ${ch.type}`);
        console.log(`   Status: ${ch.status}`);
        console.log(`   Active: ${ch.isActive}`);
        if (ch.shopDomain) console.log(`   Shop: ${ch.shopDomain}`);
        console.log('');
      });
    }
  } else {
    console.log(`✅ Found ${channels.length} Shopify channel(s):\n`);

    channels.forEach((ch, idx) => {
      console.log(`${idx + 1}. ${ch.name}`);
      console.log(`   ID: ${ch.id}`);
      console.log(`   Client: ${ch.client.name} (${ch.client.email})`);
      console.log(`   Shop Domain: ${ch.shopDomain}`);
      console.log(`   Status: ${ch.status}`);
      console.log(`   Active: ${ch.isActive}`);
      console.log(`   Sync Enabled: ${ch.syncEnabled}`);
      console.log(`   Last Sync: ${ch.lastSyncAt || 'Never'}`);
      console.log(`   Webhook Secret: ${ch.webhookSecret ? 'Configured' : 'Not set'}`);
      console.log(`   Access Token: ${ch.accessToken ? 'Configured' : 'Not set'}`);
      console.log('');
    });

    console.log('\n📋 Use this channel ID for testing:');
    console.log(`   ${channels[0].id}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
