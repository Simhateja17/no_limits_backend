import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({});

async function main() {
  try {
    const channels = await prisma.channel.findMany({
      where: { 
        type: 'SHOPIFY',
        isActive: true
      },
      select: {
        id: true,
        name: true,
        shopDomain: true,
        clientId: true,
        isActive: true,
        createdAt: true,
        client: {
          select: {
            id: true,
            name: true,
            companyName: true
          }
        }
      }
    });
    
    console.log('\n=== ACTIVE SHOPIFY CHANNELS ===\n');
    if (channels.length === 0) {
      console.log('No active Shopify channels found.');
    } else {
      channels.forEach((channel, idx) => {
        console.log(`[${idx + 1}] Channel ID: ${channel.id}`);
        console.log(`    Shop: ${channel.shopDomain}`);
        console.log(`    Name: ${channel.name}`);
        console.log(`    Client: ${channel.client?.name || channel.client?.companyName || 'Unknown'}`);
        console.log(`    Client ID: ${channel.clientId}`);
        console.log('---');
      });
    }
  } catch (error: any) {
    console.error('Error querying channels:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
