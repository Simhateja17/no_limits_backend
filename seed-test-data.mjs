import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword } from './dist/utils/auth.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('=== CHECKING EXISTING DATA ===\n');

  // Check existing clients
  const existingClients = await prisma.client.count();
  console.log(`📋 Existing Clients: ${existingClients}`);

  // Check existing chat rooms
  const existingChatRooms = await prisma.chatRoom.count();
  console.log(`💬 Existing Chat Rooms: ${existingChatRooms}`);

  // Check existing users
  const existingUsers = await prisma.user.count();
  console.log(`👤 Existing Users: ${existingUsers}`);

  // If no clients exist, create some test data
  if (existingClients === 0) {
    console.log('\n⚠️  No clients found. Creating test data...\n');

    // Create test client users
    const testClients = [
      {
        email: 'client1@test.com',
        name: 'Test Client 1',
        company: 'Company A'
      },
      {
        email: 'client2@test.com',
        name: 'Test Client 2',
        company: 'Company B'
      },
      {
        email: 'client3@test.com',
        name: 'Test Client 3',
        company: 'Company C'
      }
    ];

    for (const clientData of testClients) {
      try {
        // Create user
        const user = await prisma.user.create({
          data: {
            email: clientData.email,
            password: await hashPassword('password123'),
            name: clientData.name,
            role: 'CLIENT',
          }
        });

        // Create client
        const client = await prisma.client.create({
          data: {
            name: clientData.name,
            companyName: clientData.company,
            email: clientData.email,
            userId: user.id,
            billingStatus: 'PAID',
          }
        });

        // Create chat room for this client
        const chatRoom = await prisma.chatRoom.create({
          data: {
            clientId: client.id,
            participants: {
              create: [
                {
                  userId: user.id, // Client user as participant
                },
              ],
            },
          },
        });

        console.log(`✅ Created client: ${clientData.name} with chat room`);
      } catch (error) {
        console.error(`❌ Error creating ${clientData.name}:`, error.message);
      }
    }
  } else {
    console.log('\n✅ Clients already exist. Listing them:\n');

    const clients = await prisma.client.findMany({
      include: {
        user: {
          select: {
            email: true,
            name: true,
          }
        },
        chatRoom: true,
      }
    });

    clients.forEach((client, index) => {
      console.log(`${index + 1}. ${client.name} (${client.email})`);
      console.log(`   User: ${client.user?.email || 'No user'}`);
      console.log(`   Chat Room: ${client.chatRoom ? `ID ${client.chatRoom.id}` : 'No chat room'}`);
    });

    // Check if clients have chat rooms, if not create them
    for (const client of clients) {
      if (!client.chatRoom) {
        console.log(`\n⚠️  Creating chat room for ${client.name}...`);
        await prisma.chatRoom.create({
          data: {
            clientId: client.id,
            participants: {
              create: [
                {
                  userId: client.userId,
                },
              ],
            },
          },
        });
        console.log(`✅ Chat room created for ${client.name}`);
      }
    }
  }

  // Final count
  const finalClients = await prisma.client.count();
  const finalChatRooms = await prisma.chatRoom.count();

  console.log('\n=== FINAL COUNTS ===');
  console.log(`📋 Total Clients: ${finalClients}`);
  console.log(`💬 Total Chat Rooms: ${finalChatRooms}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
