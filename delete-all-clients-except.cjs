#!/usr/bin/env node
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const KEEP_PATTERNS = ['nora schneider', 'miimee', 'kutke', 'papercrush'];
const EXECUTE_FLAG = '--execute';
const DELETE_USERS_FLAG = '--delete-users';

const shouldExecute = process.argv.includes(EXECUTE_FLAG);
const shouldDeleteUsers = process.argv.includes(DELETE_USERS_FLAG);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildClientSearchFields(client) {
  return [
    client.name,
    client.companyName,
    client.email,
    client.user?.name,
    client.user?.email,
  ].filter(Boolean);
}

function getMatchToken(client) {
  const fields = buildClientSearchFields(client).map(normalize);
  const tokens = KEEP_PATTERNS.map(normalize);

  for (const token of tokens) {
    if (fields.some((field) => field.includes(token))) {
      return token;
    }
  }

  return null;
}

function formatClient(client) {
  const userEmail = client.user?.email ? ` | user: ${client.user.email}` : '';
  return `${client.name} (${client.companyName}) [${client.id}]${userEmail}`;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }

    const clients = await prisma.client.findMany({
      include: {
        user: {
          select: { id: true, email: true, name: true, role: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const toKeep = [];
    const toDelete = [];

    for (const client of clients) {
      const token = getMatchToken(client);
      if (token) {
        toKeep.push({ client, token });
      } else {
        toDelete.push(client);
      }
    }

    console.log('Keep patterns:', KEEP_PATTERNS.join(', '));
    console.log(`Total clients: ${clients.length}`);
    console.log(`Will keep: ${toKeep.length}`);
    console.log(`Will delete: ${toDelete.length}\n`);

    if (toKeep.length > 0) {
      console.log('Clients to keep:');
      for (const entry of toKeep) {
        console.log(`  - ${formatClient(entry.client)} (matched: ${entry.token})`);
      }
      console.log('');
    }

    if (toDelete.length > 0) {
      console.log('Clients to delete:');
      for (const client of toDelete) {
        console.log(`  - ${formatClient(client)}`);
      }
      console.log('');
    }

    if (!shouldExecute) {
      console.log(
        `Dry run only. Re-run with ${EXECUTE_FLAG} to apply deletions.`
      );
      console.log(
        `Optional: add ${DELETE_USERS_FLAG} to also delete linked CLIENT users.`
      );
      return;
    }

    let deletedClients = 0;
    let deletedUsers = 0;
    const failures = [];

    for (const client of toDelete) {
      try {
        await prisma.client.delete({ where: { id: client.id } });
        deletedClients += 1;
        console.log(`Deleted client: ${formatClient(client)}`);

        if (shouldDeleteUsers && client.userId) {
          try {
            await prisma.user.delete({ where: { id: client.userId } });
            deletedUsers += 1;
            console.log(`  Deleted linked user: ${client.user?.email || client.userId}`);
          } catch (userError) {
            failures.push({
              id: client.id,
              name: client.name,
              error: `User delete failed: ${userError.message}`,
            });
            console.error(
              `  Could not delete linked user ${client.user?.email || client.userId}:`,
              userError.message
            );
          }
        }
      } catch (error) {
        failures.push({ id: client.id, name: client.name, error: error.message });
        console.error(`Failed to delete client ${formatClient(client)}:`, error.message);
      }
    }

    console.log('\nDone.');
    console.log(`Deleted clients: ${deletedClients}`);
    if (shouldDeleteUsers) {
      console.log(`Deleted linked users: ${deletedUsers}`);
    }
    console.log(`Failures: ${failures.length}`);

    if (failures.length > 0) {
      console.log('\nFailure details:');
      for (const failure of failures) {
        console.log(`  - ${failure.name} [${failure.id}]: ${failure.error}`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Script failed:', error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
