/**
 * Sync Stock from Dashboard to Channels
 *
 * Reads the current stock levels (available quantity) from the No-Limits
 * dashboard database and pushes them to every linked channel
 * (Shopify / WooCommerce) for each active client.
 *
 * Flow per client:
 *   1. Fetch all products that have at least one active ProductChannel link
 *   2. For each product-channel pair, call ProductSyncService.syncStockToChannel()
 *      which uses the Shopify Inventory API or WooCommerce Stock API directly
 *   3. Report per-client and overall summary
 *
 * Usage:
 *   npx tsx scripts/sync-stock-to-channels.ts                  # all clients
 *   npx tsx scripts/sync-stock-to-channels.ts --client <id>    # single client
 *   npx tsx scripts/sync-stock-to-channels.ts --dry-run        # preview only
 *
 * Safety: Read-only in dry-run mode. In normal mode it only updates stock on
 *         external platforms — it never modifies local stock values.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ProductSyncService } from '../src/services/integrations/product-sync.service.js';

// ============= CLI ARGS =============

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const clientIdFlag = args.indexOf('--client');
const TARGET_CLIENT_ID = clientIdFlag !== -1 ? args[clientIdFlag + 1] : null;

// ============= DATABASE =============

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ============= SERVICES =============

const productSyncService = new ProductSyncService(prisma);

// ============= TYPES =============

interface ChannelSyncResult {
  productId: string;
  sku: string;
  channelId: string;
  channelName: string;
  channelType: string;
  available: number;
  success: boolean;
  error?: string;
}

interface ClientSummary {
  clientId: string;
  companyName: string;
  totalProducts: number;
  totalChannelPairs: number;
  synced: number;
  failed: number;
  skipped: number;
  errors: string[];
}

// ============= MAIN =============

async function main(): Promise<void> {
  console.log('='.repeat(80));
  console.log('  Stock Sync: Dashboard -> Channels');
  console.log('='.repeat(80));
  console.log(`  Mode:     ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log(`  Target:   ${TARGET_CLIENT_ID ?? 'All active clients'}`);
  console.log(`  Started:  ${new Date().toISOString()}`);
  console.log('='.repeat(80));
  console.log();

  // ---- Fetch clients ----
  const clients = await prisma.client.findMany({
    where: {
      ...(TARGET_CLIENT_ID ? { id: TARGET_CLIENT_ID } : {}),
    },
    select: {
      id: true,
      companyName: true,
    },
  });

  if (clients.length === 0) {
    console.log('No clients found. Exiting.');
    return;
  }

  console.log(`Found ${clients.length} client(s) to process.\n`);

  const overallSummary: ClientSummary[] = [];

  for (const client of clients) {
    const summary = await syncClientStock(client.id, client.companyName ?? 'Unknown');
    overallSummary.push(summary);
  }

  // ---- Overall report ----
  console.log('\n' + '='.repeat(80));
  console.log('  OVERALL SUMMARY');
  console.log('='.repeat(80));

  let totalSynced = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const s of overallSummary) {
    totalSynced += s.synced;
    totalFailed += s.failed;
    totalSkipped += s.skipped;

    const status = s.failed === 0 ? 'OK' : 'ERRORS';
    console.log(
      `  [${status}] ${s.companyName} — ` +
      `${s.totalProducts} products, ${s.totalChannelPairs} channel links | ` +
      `synced: ${s.synced}, failed: ${s.failed}, skipped: ${s.skipped}`
    );

    if (s.errors.length > 0) {
      for (const err of s.errors.slice(0, 5)) {
        console.log(`         -> ${err}`);
      }
      if (s.errors.length > 5) {
        console.log(`         ... and ${s.errors.length - 5} more errors`);
      }
    }
  }

  console.log('-'.repeat(80));
  console.log(`  Total synced:  ${totalSynced}`);
  console.log(`  Total failed:  ${totalFailed}`);
  console.log(`  Total skipped: ${totalSkipped}`);
  console.log(`  Finished:      ${new Date().toISOString()}`);
  console.log('='.repeat(80));
}

// ============= PER-CLIENT SYNC =============

async function syncClientStock(clientId: string, companyName: string): Promise<ClientSummary> {
  console.log('-'.repeat(80));
  console.log(`Client: ${companyName} (${clientId})`);
  console.log('-'.repeat(80));

  const summary: ClientSummary = {
    clientId,
    companyName,
    totalProducts: 0,
    totalChannelPairs: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Fetch all product-channel pairs for this client where sync is enabled
  const productChannels = await prisma.productChannel.findMany({
    where: {
      product: { clientId },
      syncEnabled: true,
      isActive: true,
      channel: {
        isActive: true,
        status: 'ACTIVE',
      },
    },
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          available: true,
          reserved: true,
        },
      },
      channel: {
        select: {
          id: true,
          name: true,
          type: true,
        },
      },
    },
  });

  if (productChannels.length === 0) {
    console.log('  No active product-channel links found. Skipping.\n');
    return summary;
  }

  // Unique products
  const uniqueProductIds = new Set(productChannels.map(pc => pc.productId));
  summary.totalProducts = uniqueProductIds.size;
  summary.totalChannelPairs = productChannels.length;

  console.log(`  Products: ${summary.totalProducts} | Channel links: ${summary.totalChannelPairs}`);
  console.log();

  for (const pc of productChannels) {
    const label = `${pc.product.sku} -> ${pc.channel.name} (${pc.channel.type})`;

    // Skip if no external product ID (product not yet pushed to channel)
    if (!pc.externalProductId) {
      summary.skipped++;
      console.log(`  [SKIP] ${label} — not yet pushed to channel`);
      continue;
    }

    if (DRY_RUN) {
      summary.synced++;
      console.log(`  [DRY]  ${label} — would sync available=${pc.product.available}`);
      continue;
    }

    try {
      const result = await productSyncService.syncStockToChannel(
        pc.product.id,
        pc.channel.id,
        { available: pc.product.available }
      );

      if (result.success) {
        summary.synced++;
        console.log(`  [OK]   ${label} — available=${pc.product.available}`);
      } else {
        summary.failed++;
        const errMsg = `${label}: ${result.error}`;
        summary.errors.push(errMsg);
        console.log(`  [FAIL] ${errMsg}`);
      }
    } catch (error) {
      summary.failed++;
      const errMsg = `${label}: ${error instanceof Error ? error.message : String(error)}`;
      summary.errors.push(errMsg);
      console.log(`  [FAIL] ${errMsg}`);
    }
  }

  console.log();
  console.log(
    `  Result: synced=${summary.synced} failed=${summary.failed} skipped=${summary.skipped}`
  );
  console.log();

  return summary;
}

// ============= ENTRYPOINT =============

main()
  .catch((error) => {
    console.error('\nFatal error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
