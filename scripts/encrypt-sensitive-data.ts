/**
 * Migration Script: Encrypt Sensitive Data
 *
 * Purpose: Encrypts existing plain-text sensitive data in the database
 *
 * Tables affected:
 * - channels: apiClientSecret, accessToken, refreshToken
 * - jtl_configs: clientSecret, accessToken, refreshToken
 *
 * Usage:
 *   npx tsx scripts/encrypt-sensitive-data.ts           # Dry run (preview)
 *   npx tsx scripts/encrypt-sensitive-data.ts --execute # Actually encrypt
 *   npx tsx scripts/encrypt-sensitive-data.ts --backup --execute # Create backup first
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import { getEncryptionService } from '../src/services/encryption.service.js';

// Load environment variables
dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not defined!');
  process.exit(1);
}

if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is not defined!');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const encryptionService = getEncryptionService();

interface EncryptionResult {
  total: number;
  encrypted: number;
  alreadyEncrypted: number;
  nullValues: number;
  errors: { id: string; field: string; error: string }[];
}

/**
 * Create backup tables before encryption
 */
async function createBackupTables(): Promise<void> {
  console.log('\nCreating backup tables...');

  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS channels_backup AS
    SELECT id, "apiClientSecret", "accessToken", "refreshToken", NOW() as backup_at
    FROM channels
    WHERE "apiClientSecret" IS NOT NULL
       OR "accessToken" IS NOT NULL
       OR "refreshToken" IS NOT NULL
  `;

  await prisma.$executeRaw`
    CREATE TABLE IF NOT EXISTS jtl_configs_backup AS
    SELECT id, "clientSecret", "accessToken", "refreshToken", NOW() as backup_at
    FROM jtl_configs
  `;

  console.log('Backup tables created successfully');
}

/**
 * Encrypt sensitive fields in the channels table
 */
async function encryptChannelCredentials(dryRun: boolean): Promise<EncryptionResult> {
  const result: EncryptionResult = {
    total: 0,
    encrypted: 0,
    alreadyEncrypted: 0,
    nullValues: 0,
    errors: [],
  };

  const channels = await prisma.channel.findMany({
    select: {
      id: true,
      name: true,
      apiClientSecret: true,
      accessToken: true,
      refreshToken: true,
    },
  });

  result.total = channels.length;

  for (const channel of channels) {
    const updates: Record<string, string> = {};

    // Process each sensitive field
    for (const field of ['apiClientSecret', 'accessToken', 'refreshToken'] as const) {
      const value = channel[field];

      if (!value) {
        result.nullValues++;
        continue;
      }

      if (encryptionService.isEncrypted(value)) {
        result.alreadyEncrypted++;
        console.log(`  [SKIP] Channel ${channel.id} - ${field} already encrypted`);
        continue;
      }

      try {
        const encrypted = encryptionService.encrypt(value);
        updates[field] = encrypted;
        console.log(`  [ENCRYPT] Channel ${channel.id} (${channel.name}) - ${field}`);
        console.log(`    Original length: ${value.length}, Encrypted length: ${encrypted.length}`);
      } catch (error) {
        result.errors.push({
          id: channel.id,
          field,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Apply updates if not dry run
    if (Object.keys(updates).length > 0) {
      if (dryRun) {
        console.log(`  [DRY RUN] Would update channel ${channel.id} with ${Object.keys(updates).length} fields`);
      } else {
        await prisma.channel.update({
          where: { id: channel.id },
          data: updates,
        });
        result.encrypted += Object.keys(updates).length;
      }
    }
  }

  return result;
}

/**
 * Encrypt sensitive fields in the jtl_configs table
 */
async function encryptJtlConfigCredentials(dryRun: boolean): Promise<EncryptionResult> {
  const result: EncryptionResult = {
    total: 0,
    encrypted: 0,
    alreadyEncrypted: 0,
    nullValues: 0,
    errors: [],
  };

  const configs = await prisma.jtlConfig.findMany({
    select: {
      id: true,
      clientId: true,
      clientSecret: true,
      accessToken: true,
      refreshToken: true,
    },
  });

  result.total = configs.length;

  for (const config of configs) {
    const updates: Record<string, string> = {};

    // Process each sensitive field
    for (const field of ['clientSecret', 'accessToken', 'refreshToken'] as const) {
      const value = config[field];

      if (!value) {
        result.nullValues++;
        continue;
      }

      if (encryptionService.isEncrypted(value)) {
        result.alreadyEncrypted++;
        console.log(`  [SKIP] JtlConfig ${config.id} - ${field} already encrypted`);
        continue;
      }

      try {
        const encrypted = encryptionService.encrypt(value);
        updates[field] = encrypted;
        console.log(`  [ENCRYPT] JtlConfig ${config.id} - ${field}`);
        console.log(`    Original length: ${value.length}, Encrypted length: ${encrypted.length}`);
      } catch (error) {
        result.errors.push({
          id: config.id,
          field,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    if (Object.keys(updates).length > 0) {
      if (dryRun) {
        console.log(`  [DRY RUN] Would update JtlConfig ${config.id}`);
      } else {
        await prisma.jtlConfig.update({
          where: { id: config.id },
          data: updates,
        });
        result.encrypted += Object.keys(updates).length;
      }
    }
  }

  return result;
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const createBackup = args.includes('--backup');

  console.log('='.repeat(80));
  console.log('Sensitive Data Encryption Migration');
  console.log('='.repeat(80));
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE'}`);
  console.log(`Backup: ${createBackup ? 'Yes' : 'No'}`);
  console.log('='.repeat(80));

  try {
    if (createBackup && !dryRun) {
      await createBackupTables();
    }

    console.log('\n--- Encrypting Channel Credentials ---');
    const channelResult = await encryptChannelCredentials(dryRun);

    console.log('\n--- Encrypting JTL Config Credentials ---');
    const jtlResult = await encryptJtlConfigCredentials(dryRun);

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));

    console.log('\nChannels:');
    console.log(`  Total records: ${channelResult.total}`);
    console.log(`  Fields encrypted: ${channelResult.encrypted}`);
    console.log(`  Already encrypted: ${channelResult.alreadyEncrypted}`);
    console.log(`  Null values (skipped): ${channelResult.nullValues}`);
    console.log(`  Errors: ${channelResult.errors.length}`);

    console.log('\nJTL Configs:');
    console.log(`  Total records: ${jtlResult.total}`);
    console.log(`  Fields encrypted: ${jtlResult.encrypted}`);
    console.log(`  Already encrypted: ${jtlResult.alreadyEncrypted}`);
    console.log(`  Null values (skipped): ${jtlResult.nullValues}`);
    console.log(`  Errors: ${jtlResult.errors.length}`);

    if (channelResult.errors.length > 0 || jtlResult.errors.length > 0) {
      console.log('\nErrors:');
      [...channelResult.errors, ...jtlResult.errors].forEach((e) => {
        console.log(`  - ${e.id} (${e.field}): ${e.error}`);
      });
    }

    if (dryRun) {
      console.log('\n[DRY RUN] No changes were made. Run with --execute to apply changes.');
    } else {
      console.log('\nEncryption completed successfully!');
    }
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
