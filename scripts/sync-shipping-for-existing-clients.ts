/**
 * Migration Script: Sync Shipping Methods for Existing Clients
 * 
 * This script syncs JTL FFN shipping methods for all existing clients
 * who have already completed their JTL OAuth flow.
 * 
 * Run with: npx ts-node scripts/sync-shipping-for-existing-clients.ts
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import { JTLService } from '../src/services/integrations/jtl.service.js';
import { ShippingMethodService } from '../src/services/shipping-method.service.js';
import { getEncryptionService } from '../src/services/encryption.service.js';

// Load environment variables
dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not defined!');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function syncShippingMethodsForExistingClients() {
  console.log('🚀 Starting shipping methods migration for existing clients...\n');
  
  const encryptionService = getEncryptionService();
  const shippingMethodService = new ShippingMethodService(prisma);
  
  // Find all JTL configs that have valid access tokens (OAuth completed)
  const jtlConfigs = await prisma.jtlConfig.findMany({
    where: {
      accessToken: {
        not: null,
      },
    },
    include: {
      client: {
        select: {
          id: true,
          companyName: true,
        },
      },
    },
  });
  
  console.log(`📋 Found ${jtlConfigs.length} clients with JTL OAuth configured\n`);
  
  let successCount = 0;
  let failCount = 0;
  let alreadySyncedCount = 0;
  
  for (const config of jtlConfigs) {
    const clientName = config.client?.companyName || config.clientId_fk;
    console.log(`\n📦 Processing client: ${clientName}`);
    
    try {
      // Decrypt credentials
      let accessToken: string;
      let refreshToken: string | undefined;
      
      try {
        accessToken = encryptionService.decrypt(config.accessToken!);
        refreshToken = config.refreshToken ? encryptionService.decrypt(config.refreshToken) : undefined;
      } catch {
        console.log(`  ⚠️  Could not decrypt tokens (may be unencrypted), trying raw value...`);
        accessToken = config.accessToken!;
        refreshToken = config.refreshToken || undefined;
      }
      
      // Create JTL service with decrypted credentials
      const jtlService = new JTLService({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        accessToken,
        refreshToken,
        tokenExpiresAt: config.tokenExpiresAt || undefined,
        environment: config.environment as 'sandbox' | 'production',
      });
      
      // Check if we can connect
      const testResult = await jtlService.testConnection();
      if (!testResult.success) {
        console.log(`  ❌ Connection test failed: ${testResult.message}`);
        failCount++;
        continue;
      }
      
      // Sync shipping methods
      const syncResult = await shippingMethodService.syncShippingMethodsFromJTL(jtlService);
      
      if (syncResult.success) {
        if (syncResult.synced > 0) {
          console.log(`  ✅ Synced ${syncResult.synced} shipping methods`);
          successCount++;
        } else {
          console.log(`  ℹ️  No new shipping methods to sync`);
          alreadySyncedCount++;
        }
      } else {
        console.log(`  ❌ Sync failed: ${syncResult.error}`);
        failCount++;
      }
      
    } catch (error) {
      console.log(`  ❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      failCount++;
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 Migration Summary:');
  console.log(`   ✅ Successfully synced: ${successCount}`);
  console.log(`   ℹ️  Already up to date: ${alreadySyncedCount}`);
  console.log(`   ❌ Failed: ${failCount}`);
  console.log(`   📋 Total processed: ${jtlConfigs.length}`);
  console.log('='.repeat(50) + '\n');
  
  // Now list all synced shipping methods
  const allMethods = await prisma.shippingMethod.findMany({
    orderBy: { name: 'asc' },
  });
  
  if (allMethods.length > 0) {
    console.log('📋 Available Shipping Methods:');
    console.log('-'.repeat(80));
    for (const method of allMethods) {
      console.log(`   ${method.jtlShippingMethodId} | ${method.name} | ${method.carrier}`);
    }
    console.log('-'.repeat(80));
    console.log(`   Total: ${allMethods.length} shipping methods\n`);
  }
}

// Run the migration
syncShippingMethodsForExistingClients()
  .then(() => {
    console.log('✨ Migration completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
