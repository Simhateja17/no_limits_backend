/**
 * Initial Sync Pipeline Service
 *
 * Manages the comprehensive sync pipeline for client onboarding.
 * Implements a state machine pattern with database-tracked progress.
 *
 * Pipeline Steps (Sequential):
 * 1. pull_channel_data - Channel → Local DB (SyncOrchestrator.runFullSync)
 * 2. import_jtl_products - JTL FFN → Local DB (ProductSyncService.importProductsFromJTL)
 * 3. push_products_to_jtl - Local → JTL FFN (ProductSyncService.fullSyncForClient)
 * 4. sync_order_statuses - JTL → Local → Channel (SyncOrchestrator.pollJTLOutboundUpdates)
 * 5. sync_stock_levels - JTL → Local → Channel (StockSyncService.syncStockForClient)
 *
 * Key Features:
 * - Channel marked ACTIVE after Step 1 (non-blocking for user)
 * - Progress tracking with percentage and messages
 * - Error recovery - can resume from failed step
 * - Idempotent - safe to run multiple times
 */

import { PrismaClient, PipelineStatus as PipelineStatusEnum, PipelineStepStatus as PipelineStepStatusEnum, ChannelType } from '@prisma/client';
import { SyncOrchestrator } from './sync-orchestrator.js';
import { ProductSyncService } from './product-sync.service.js';
import { StockSyncService } from './stock-sync.service.js';
import { getEncryptionService } from '../encryption.service.js';

// ============= TYPES =============

export interface PipelineStartOptions {
  channelId: string;
  clientId: string;
  syncFromDate?: Date;
  syncType?: 'initial' | 'full' | 'incremental';
}

export interface PipelineStatusResponse {
  pipelineId: string;
  channelId: string;
  clientId: string;
  status: PipelineStatusEnum;
  currentStep: number;
  totalSteps: number;
  progress: number;
  progressMessage: string | null;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  steps: Array<{
    stepNumber: number;
    stepName: string;
    stepDescription: string | null;
    status: PipelineStepStatusEnum;
    progress: number;
    itemsTotal: number;
    itemsProcessed: number;
    itemsFailed: number;
    errorMessage: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  }>;
}

export interface PipelineResult {
  success: boolean;
  pipelineId: string;
  message?: string;
  error?: string;
}

// Pipeline step definitions
// Step 1 is UNIDIRECTIONAL: Channel → Local DB only (no JTL push)
// Step 3 pushes to JTL with duplicate handling
const PIPELINE_STEPS = [
  {
    stepNumber: 1,
    stepName: 'pull_channel_data',
    stepDescription: 'Pulling products, orders, and returns from sales channel to local database',
  },
  {
    stepNumber: 2,
    stepName: 'import_jtl_products',
    stepDescription: 'Importing products from JTL FFN that are not in local database',
  },
  {
    stepNumber: 3,
    stepName: 'push_products_to_jtl',
    stepDescription: 'Pushing products from local database to JTL FFN (with duplicate handling)',
  },
  {
    stepNumber: 4,
    stepName: 'sync_order_statuses',
    stepDescription: 'Syncing order statuses from JTL FFN',
  },
  {
    stepNumber: 5,
    stepName: 'sync_stock_levels',
    stepDescription: 'Syncing stock/inventory levels from JTL FFN',
  },
];

// ============= SERVICE =============

export class InitialSyncPipelineService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Start a new pipeline or resume an existing one
   */
  async startPipeline(options: PipelineStartOptions): Promise<PipelineResult> {
    const { channelId, clientId, syncFromDate, syncType = 'initial' } = options;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[SyncPipeline] STARTING INITIAL SYNC PIPELINE`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`[SyncPipeline] Channel ID: ${channelId}`);
    console.log(`[SyncPipeline] Client ID: ${clientId}`);
    console.log(`[SyncPipeline] Sync Type: ${syncType}`);
    console.log(`[SyncPipeline] Sync From Date: ${syncFromDate?.toISOString() || 'Not specified (will use 180 days)'}`);
    console.log(`${'─'.repeat(60)}`);

    try {
      // Check if pipeline already exists for this channel
      let pipeline = await this.prisma.syncPipeline.findUnique({
        where: {
          channelId_syncType: {
            channelId,
            syncType,
          },
        },
        include: { steps: true },
      });

      if (pipeline) {
        // Pipeline exists - check if we can resume
        if (pipeline.status === 'COMPLETED') {
          return {
            success: false,
            pipelineId: pipeline.id,
            error: 'Pipeline already completed. Create a new sync type to run again.',
          };
        }

        if (pipeline.status === 'IN_PROGRESS') {
          return {
            success: false,
            pipelineId: pipeline.id,
            error: 'Pipeline already in progress',
          };
        }

        // Resume from PENDING, PAUSED, or FAILED
        console.log(`[SyncPipeline] Resuming existing pipeline ${pipeline.id} from step ${pipeline.currentStep}`);
      } else {
        // Create new pipeline with all steps
        pipeline = await this.prisma.syncPipeline.create({
          data: {
            channelId,
            clientId,
            syncFromDate,
            syncType,
            status: 'PENDING',
            currentStep: 0,
            totalSteps: PIPELINE_STEPS.length,
            progress: 0,
            progressMessage: 'Initializing pipeline...',
            steps: {
              create: PIPELINE_STEPS.map((step) => ({
                stepNumber: step.stepNumber,
                stepName: step.stepName,
                stepDescription: step.stepDescription,
                status: 'PENDING',
                progress: 0,
              })),
            },
          },
          include: { steps: true },
        });

        console.log(`[SyncPipeline] Created new pipeline ${pipeline.id}`);
      }

      // Start executing the pipeline asynchronously
      this.executePipeline(pipeline.id).catch((err) => {
        console.error(`[SyncPipeline] Pipeline ${pipeline.id} failed:`, err);
      });

      return {
        success: true,
        pipelineId: pipeline.id,
        message: 'Pipeline started successfully',
      };
    } catch (error) {
      console.error('[SyncPipeline] Error starting pipeline:', error);
      return {
        success: false,
        pipelineId: '',
        error: error instanceof Error ? error.message : 'Failed to start pipeline',
      };
    }
  }

  /**
   * Execute the pipeline sequentially
   */
  async executePipeline(pipelineId: string): Promise<void> {
    const pipelineStartTime = Date.now();
    console.log(`\n[SyncPipeline] ▶ Executing pipeline ${pipelineId}`);
    console.log(`[SyncPipeline] Pipeline has ${PIPELINE_STEPS.length} steps:`);
    PIPELINE_STEPS.forEach(s => console.log(`[SyncPipeline]   Step ${s.stepNumber}: ${s.stepName}`));

    try {
      // Mark pipeline as in progress
      let pipeline = await this.prisma.syncPipeline.update({
        where: { id: pipelineId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: new Date(),
          lastError: null,
        },
        include: {
          steps: { orderBy: { stepNumber: 'asc' } },
          channel: {
            include: {
              client: {
                include: { jtlConfig: true },
              },
            },
          },
        },
      });

      if (!pipeline.channel) {
        throw new Error('Channel not found for pipeline');
      }

      // Find the first step that needs to be executed
      const pendingStep = pipeline.steps.find(
        (s) => s.status === 'PENDING' || s.status === 'FAILED'
      );

      const startFromStep = pendingStep ? pendingStep.stepNumber : 1;

      console.log(`[SyncPipeline] Starting from step ${startFromStep}`);

      // Execute each step sequentially
      for (let stepNum = startFromStep; stepNum <= PIPELINE_STEPS.length; stepNum++) {
        // Check if pipeline was paused
        const refreshedPipeline = await this.prisma.syncPipeline.findUnique({
          where: { id: pipelineId },
          include: {
            steps: { orderBy: { stepNumber: 'asc' } },
            channel: {
              include: {
                client: {
                  include: { jtlConfig: true },
                },
              },
            },
          },
        });

        if (!refreshedPipeline) {
          throw new Error('Pipeline not found');
        }

        pipeline = refreshedPipeline;

        if (pipeline.status === 'PAUSED') {
          console.log(`[SyncPipeline] Pipeline ${pipelineId} is paused, stopping execution`);
          return;
        }

        // Execute the step
        const stepResult = await this.executeStep(pipelineId, stepNum, pipeline);

        if (!stepResult.success) {
          // Step failed - update pipeline status and stop
          await this.prisma.syncPipeline.update({
            where: { id: pipelineId },
            data: {
              status: 'FAILED',
              lastError: stepResult.error,
              retryCount: { increment: 1 },
            },
          });

          console.error(`[SyncPipeline] Pipeline ${pipelineId} failed at step ${stepNum}: ${stepResult.error}`);
          return;
        }

        // Update pipeline progress
        const progress = (stepNum / PIPELINE_STEPS.length) * 100;
        await this.prisma.syncPipeline.update({
          where: { id: pipelineId },
          data: {
            currentStep: stepNum,
            progress,
            progressMessage: `Completed step ${stepNum}: ${PIPELINE_STEPS[stepNum - 1].stepDescription}`,
          },
        });
      }

      // All steps completed successfully
      await this.prisma.syncPipeline.update({
        where: { id: pipelineId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          progress: 100,
          progressMessage: 'Pipeline completed successfully',
        },
      });

      const totalDuration = ((Date.now() - pipelineStartTime) / 1000).toFixed(1);
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`[SyncPipeline] ✅ PIPELINE COMPLETED SUCCESSFULLY`);
      console.log(`${'═'.repeat(60)}`);
      console.log(`[SyncPipeline] Pipeline ID: ${pipelineId}`);
      console.log(`[SyncPipeline] Total Duration: ${totalDuration}s`);
      console.log(`${'═'.repeat(60)}\n`);
    } catch (error) {
      const totalDuration = ((Date.now() - pipelineStartTime) / 1000).toFixed(1);
      console.error(`\n${'═'.repeat(60)}`);
      console.error(`[SyncPipeline] ❌ PIPELINE FAILED`);
      console.error(`${'═'.repeat(60)}`);
      console.error(`[SyncPipeline] Pipeline ID: ${pipelineId}`);
      console.error(`[SyncPipeline] Duration before failure: ${totalDuration}s`);
      console.error(`[SyncPipeline] Error:`, error);

      await this.prisma.syncPipeline.update({
        where: { id: pipelineId },
        data: {
          status: 'FAILED',
          lastError: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  /**
   * Execute a single pipeline step
   */
  private async executeStep(
    pipelineId: string,
    stepNumber: number,
    pipeline: {
      id: string;
      channelId: string;
      clientId: string;
      syncFromDate: Date | null;
      channel: {
        id: string;
        type: ChannelType;
        shopDomain: string | null;
        accessToken: string | null;
        apiUrl: string | null;
        apiClientId: string | null;
        apiClientSecret: string | null;
        client: {
          id: string;
          jtlConfig: {
            clientId: string;
            clientSecret: string;
            accessToken: string | null;
            refreshToken: string | null;
            fulfillerId: string;
            warehouseId: string;
            environment: string;
          } | null;
        };
      };
    }
  ): Promise<{ success: boolean; error?: string }> {
    const step = pipeline.channel.client.jtlConfig
      ? PIPELINE_STEPS.find((s) => s.stepNumber === stepNumber)
      : null;

    if (!step) {
      return { success: false, error: `Step ${stepNumber} not found` };
    }

    const stepStartTime = Date.now();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[SyncPipeline] 📦 STEP ${stepNumber}/${PIPELINE_STEPS.length}: ${step.stepName.toUpperCase()}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`[SyncPipeline] Description: ${step.stepDescription}`);
    console.log(`[SyncPipeline] Started at: ${new Date().toISOString()}`);

    // Update step status to in progress
    await this.prisma.pipelineStep.updateMany({
      where: {
        pipelineId,
        stepNumber,
      },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        errorMessage: null,
      },
    });

    try {
      let result: { success: boolean; itemsProcessed?: number; itemsFailed?: number; error?: string };

      switch (step.stepName) {
        case 'pull_channel_data':
          result = await this.stepPullChannelData(pipeline);
          // Mark channel as ACTIVE after step 1
          if (result.success) {
            await this.prisma.channel.update({
              where: { id: pipeline.channelId },
              data: { status: 'ACTIVE', lastSyncAt: new Date() },
            });
            console.log(`[SyncPipeline] Channel ${pipeline.channelId} marked as ACTIVE`);
          }
          break;

        case 'import_jtl_products':
          result = await this.stepImportJTLProducts(pipeline);
          break;

        case 'push_products_to_jtl':
          result = await this.stepPushProductsToJTL(pipeline);
          break;

        case 'sync_order_statuses':
          result = await this.stepSyncOrderStatuses(pipeline);
          break;

        case 'sync_stock_levels':
          result = await this.stepSyncStockLevels(pipeline);
          break;

        default:
          result = { success: false, error: `Unknown step: ${step.stepName}` };
      }

      // Update step status
      await this.prisma.pipelineStep.updateMany({
        where: {
          pipelineId,
          stepNumber,
        },
        data: {
          status: result.success ? 'COMPLETED' : 'FAILED',
          completedAt: new Date(),
          progress: result.success ? 100 : 0,
          itemsProcessed: result.itemsProcessed || 0,
          itemsFailed: result.itemsFailed || 0,
          errorMessage: result.error || null,
        },
      });

      const stepDuration = ((Date.now() - stepStartTime) / 1000).toFixed(1);
      if (result.success) {
        console.log(`[SyncPipeline] ✅ Step ${stepNumber} completed in ${stepDuration}s`);
        console.log(`[SyncPipeline]    Items processed: ${result.itemsProcessed || 0}, Failed: ${result.itemsFailed || 0}`);
      } else {
        console.log(`[SyncPipeline] ❌ Step ${stepNumber} failed after ${stepDuration}s`);
        console.log(`[SyncPipeline]    Error: ${result.error}`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await this.prisma.pipelineStep.updateMany({
        where: {
          pipelineId,
          stepNumber,
        },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorMessage,
        },
      });

      return { success: false, error: errorMessage };
    }
  }

  // ============= STEP IMPLEMENTATIONS =============

  /**
   * Step 1: Pull data from sales channel (Shopify/WooCommerce) to local DB ONLY
   *
   * IMPORTANT: This step is now UNIDIRECTIONAL (Channel → Local DB only)
   * It does NOT push to JTL FFN to avoid duplicate product errors.
   * JTL push happens in Step 3 with proper duplicate handling.
   */
  private async stepPullChannelData(pipeline: {
    channelId: string;
    syncFromDate: Date | null;
    channel: {
      type: ChannelType;
      shopDomain: string | null;
      accessToken: string | null;
      apiUrl: string | null;
      apiClientId: string | null;
      apiClientSecret: string | null;
      client: {
        jtlConfig: {
          clientId: string;
          clientSecret: string;
          accessToken: string | null;
          refreshToken: string | null;
          fulfillerId: string;
          warehouseId: string;
          environment: string;
        } | null;
      };
    };
  }): Promise<{ success: boolean; itemsProcessed?: number; itemsFailed?: number; error?: string }> {
    console.log('[SyncPipeline] Step 1: Pulling channel data (unidirectional - no JTL push)');
    console.log(`[SyncPipeline] Channel Type: ${pipeline.channel.type}`);
    console.log(`[SyncPipeline] This step pulls: Products, Orders, Returns from ${pipeline.channel.type}`);

    const { channel, channelId, syncFromDate } = pipeline;
    const jtlConfig = channel.client.jtlConfig;

    if (!jtlConfig) {
      return { success: false, error: 'JTL configuration not found' };
    }

    const encryptionService = getEncryptionService();

    // Build orchestrator config
    const orchestratorConfig: {
      channelId: string;
      channelType: ChannelType;
      shopifyCredentials?: { shopDomain: string; accessToken: string };
      wooCommerceCredentials?: { url: string; consumerKey: string; consumerSecret: string };
      jtlCredentials: {
        clientId: string;
        clientSecret: string;
        accessToken?: string;
        refreshToken?: string;
        environment: 'sandbox' | 'production';
      };
      jtlWarehouseId: string;
      jtlFulfillerId: string;
    } = {
      channelId,
      channelType: channel.type,
      jtlCredentials: {
        clientId: jtlConfig.clientId,
        clientSecret: jtlConfig.clientSecret,
        accessToken: jtlConfig.accessToken || undefined,
        refreshToken: jtlConfig.refreshToken || undefined,
        environment: jtlConfig.environment as 'sandbox' | 'production',
      },
      jtlWarehouseId: jtlConfig.warehouseId,
      jtlFulfillerId: jtlConfig.fulfillerId,
    };

    // Add channel-specific credentials
    if (channel.type === 'SHOPIFY' && channel.shopDomain && channel.accessToken) {
      orchestratorConfig.shopifyCredentials = {
        shopDomain: channel.shopDomain,
        accessToken: encryptionService.safeDecrypt(channel.accessToken),
      };
    } else if (channel.type === 'WOOCOMMERCE' && channel.apiUrl && channel.apiClientId && channel.apiClientSecret) {
      orchestratorConfig.wooCommerceCredentials = {
        url: channel.apiUrl,
        consumerKey: channel.apiClientId,
        consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
      };
    } else {
      return { success: false, error: 'Invalid channel credentials' };
    }

    const orchestrator = new SyncOrchestrator(this.prisma, orchestratorConfig);

    // Use syncFromDate if provided, otherwise default to 180 days
    const since = syncFromDate || new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    console.log(`[SyncPipeline] Pulling data since: ${since.toISOString()}`);

    // Use pullFromChannelOnly instead of runFullSync to avoid JTL push
    // This prevents Products_DuplicateProduct errors during initial sync
    console.log(`[SyncPipeline] Calling pullFromChannelOnly...`);
    const result = await orchestrator.pullFromChannelOnly(since);

    const totalProcessed =
      result.products.itemsProcessed +
      result.orders.itemsProcessed +
      result.returns.itemsProcessed;

    const totalFailed =
      result.products.itemsFailed +
      result.orders.itemsFailed +
      result.returns.itemsFailed;

    console.log(`[SyncPipeline] Step 1 Results:`);
    console.log(`[SyncPipeline]   📦 Products: ${result.products.itemsProcessed} processed, ${result.products.itemsFailed} failed`);
    console.log(`[SyncPipeline]   🛒 Orders: ${result.orders.itemsProcessed} processed, ${result.orders.itemsFailed} failed`);
    console.log(`[SyncPipeline]   ↩️  Returns: ${result.returns.itemsProcessed} processed, ${result.returns.itemsFailed} failed`);
    console.log(`[SyncPipeline]   📊 Total: ${totalProcessed} processed, ${totalFailed} failed`);

    return {
      success: totalFailed === 0,
      itemsProcessed: totalProcessed,
      itemsFailed: totalFailed,
      error: totalFailed > 0 ? `Failed items: products=${result.products.itemsFailed}, orders=${result.orders.itemsFailed}, returns=${result.returns.itemsFailed}` : undefined,
    };
  }

  /**
   * Step 2: Import products from JTL FFN that aren't in local DB
   */
  private async stepImportJTLProducts(pipeline: {
    clientId: string;
  }): Promise<{ success: boolean; itemsProcessed?: number; itemsFailed?: number; error?: string }> {
    console.log('[SyncPipeline] Step 2: Importing products from JTL FFN');
    console.log(`[SyncPipeline] This step imports products that exist in JTL but not in local DB`);
    console.log(`[SyncPipeline] Client ID: ${pipeline.clientId}`);

    const productSyncService = new ProductSyncService(this.prisma);
    console.log(`[SyncPipeline] Calling importProductsFromJTL...`);
    const result = await productSyncService.importProductsFromJTL(pipeline.clientId);

    console.log(`[SyncPipeline] Step 2 Results:`);
    console.log(`[SyncPipeline]   📥 Imported: ${result.imported} products from JTL`);
    console.log(`[SyncPipeline]   ⏭️  Already exist: ${result.alreadyExists} (skipped)`);
    console.log(`[SyncPipeline]   ❌ Failed: ${result.failed}`);
    if (result.errors.length > 0) {
      console.log(`[SyncPipeline]   Errors: ${result.errors.slice(0, 3).join('; ')}${result.errors.length > 3 ? '...' : ''}`);
    }

    return {
      success: result.failed === 0,
      itemsProcessed: result.imported,
      itemsFailed: result.failed,
      error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
    };
  }

  /**
   * Step 3: Push products to JTL FFN ONLY
   *
   * IMPORTANT: This step pushes ONLY to JTL FFN (not to Shopify/WooCommerce)
   * - Skips products already linked to JTL (have jtlProductId)
   * - Skips products with generated SKUs (SHOP-xxx, WOO-xxx) - they need manual linking
   * - Only creates new products in JTL for products that don't exist there
   * - Handles JTL duplicate errors by auto-fixing (extracts JFSKU and links)
   */
  private async stepPushProductsToJTL(pipeline: {
    clientId: string;
  }): Promise<{ success: boolean; itemsProcessed?: number; itemsFailed?: number; error?: string }> {
    console.log('[SyncPipeline] Step 3: Pushing products to JTL FFN');
    console.log(`[SyncPipeline] This step creates products in JTL FFN (with duplicate handling)`);
    console.log(`[SyncPipeline] Client ID: ${pipeline.clientId}`);

    const productSyncService = new ProductSyncService(this.prisma);
    console.log(`[SyncPipeline] Calling pushToJTLOnly...`);
    const result = await productSyncService.pushToJTLOnly(pipeline.clientId);

    console.log(`[SyncPipeline] Step 3 Results:`);
    console.log(`[SyncPipeline]   - ${result.synced} created in JTL`);
    console.log(`[SyncPipeline]   - ${result.skippedAlreadyLinked} linked to existing JTL products (no duplicate push)`);
    console.log(`[SyncPipeline]   - ${result.skipped} skipped (already linked in DB)`);
    console.log(`[SyncPipeline]   - ${result.skippedManualLink} skipped - have generated SKUs and need manual linking`);
    console.log(`[SyncPipeline]   - ${result.failed} failed`);

    if (result.skippedAlreadyLinked > 0) {
      console.log(`[SyncPipeline] ${result.skippedAlreadyLinked} products were found in JTL by SKU match and linked (avoided duplicate creation)`);
    }

    if (result.skippedManualLink > 0) {
      console.log(`[SyncPipeline] ${result.skippedManualLink} products have generated SKUs (SHOP-xxx/WOO-xxx) and need manual linking in the Products table`);
    }

    return {
      success: result.failed === 0,
      itemsProcessed: result.synced + result.skippedAlreadyLinked + result.skipped + result.skippedManualLink,
      itemsFailed: result.failed,
      error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
    };
  }

  /**
   * Step 4: Sync order statuses from JTL FFN
   */
  private async stepSyncOrderStatuses(pipeline: {
    channelId: string;
    syncFromDate: Date | null;
    channel: {
      type: ChannelType;
      shopDomain: string | null;
      accessToken: string | null;
      apiUrl: string | null;
      apiClientId: string | null;
      apiClientSecret: string | null;
      client: {
        jtlConfig: {
          clientId: string;
          clientSecret: string;
          accessToken: string | null;
          refreshToken: string | null;
          fulfillerId: string;
          warehouseId: string;
          environment: string;
        } | null;
      };
    };
  }): Promise<{ success: boolean; itemsProcessed?: number; itemsFailed?: number; error?: string }> {
    console.log('[SyncPipeline] Step 4: Syncing order statuses from JTL FFN');
    console.log(`[SyncPipeline] This step links JTL outbounds to local orders and syncs fulfillment statuses`);
    console.log(`[SyncPipeline] Channel ID: ${pipeline.channelId}`);

    const { channel, channelId } = pipeline;
    const jtlConfig = channel.client.jtlConfig;

    if (!jtlConfig) {
      return { success: false, error: 'JTL configuration not found' };
    }

    const encryptionService = getEncryptionService();

    // Build orchestrator config
    const orchestratorConfig: {
      channelId: string;
      channelType: ChannelType;
      shopifyCredentials?: { shopDomain: string; accessToken: string };
      wooCommerceCredentials?: { url: string; consumerKey: string; consumerSecret: string };
      jtlCredentials: {
        clientId: string;
        clientSecret: string;
        accessToken?: string;
        refreshToken?: string;
        environment: 'sandbox' | 'production';
      };
      jtlWarehouseId: string;
      jtlFulfillerId: string;
    } = {
      channelId,
      channelType: channel.type,
      jtlCredentials: {
        clientId: jtlConfig.clientId,
        clientSecret: jtlConfig.clientSecret,
        accessToken: jtlConfig.accessToken || undefined,
        refreshToken: jtlConfig.refreshToken || undefined,
        environment: jtlConfig.environment as 'sandbox' | 'production',
      },
      jtlWarehouseId: jtlConfig.warehouseId,
      jtlFulfillerId: jtlConfig.fulfillerId,
    };

    // Add channel-specific credentials
    if (channel.type === 'SHOPIFY' && channel.shopDomain && channel.accessToken) {
      orchestratorConfig.shopifyCredentials = {
        shopDomain: channel.shopDomain,
        accessToken: encryptionService.safeDecrypt(channel.accessToken),
      };
    } else if (channel.type === 'WOOCOMMERCE' && channel.apiUrl && channel.apiClientId && channel.apiClientSecret) {
      orchestratorConfig.wooCommerceCredentials = {
        url: channel.apiUrl,
        consumerKey: channel.apiClientId,
        consumerSecret: encryptionService.safeDecrypt(channel.apiClientSecret),
      };
    }

    const orchestrator = new SyncOrchestrator(this.prisma, orchestratorConfig);

    // Step 4a: First, link existing JTL outbounds to local orders by matching order numbers
    // This is a one-time reconciliation for historical orders
    console.log(`[SyncPipeline] Step 4a: Linking existing JTL outbounds to local orders...`);
    console.log(`[SyncPipeline] This matches JTL outbounds to local orders by order number`);
    const linkResult = await orchestrator.linkJTLOutboundsToOrders();
    console.log(`[SyncPipeline] Step 4a Results:`);
    console.log(`[SyncPipeline]   🔗 Linked: ${linkResult.linked} orders linked to JTL outbounds`);
    console.log(`[SyncPipeline]   ✅ Already linked: ${linkResult.alreadyLinked}`);
    console.log(`[SyncPipeline]   ⚠️  Not found in local DB: ${linkResult.notFound}`);
    if (linkResult.errors.length > 0) {
      console.log(`[SyncPipeline]   ❌ Errors: ${linkResult.errors.length}`);
    }

    // Step 4b: Poll for any recent status updates
    const since = pipeline.syncFromDate || new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    console.log(`[SyncPipeline] Step 4b: Polling JTL outbound updates since ${since.toISOString()}`);
    const result = await orchestrator.pollJTLOutboundUpdates(since);
    console.log(`[SyncPipeline] Step 4b Results:`);
    console.log(`[SyncPipeline]   📊 Status updates processed: ${result.itemsProcessed}`);
    console.log(`[SyncPipeline]   ❌ Failed: ${result.itemsFailed}`);

    const totalProcessed = linkResult.linked + result.itemsProcessed;
    const totalFailed = linkResult.errors.length + result.itemsFailed;

    console.log(`[SyncPipeline] Step 4 Total: ${totalProcessed} processed, ${totalFailed} failed`);

    return {
      success: totalFailed === 0,
      itemsProcessed: totalProcessed,
      itemsFailed: totalFailed,
      error: totalFailed > 0 ? `Linking errors: ${linkResult.errors.length}, Poll errors: ${result.itemsFailed}` : undefined,
    };
  }

  /**
   * Step 5: Sync stock levels from JTL FFN
   */
  private async stepSyncStockLevels(pipeline: {
    clientId: string;
  }): Promise<{ success: boolean; itemsProcessed?: number; itemsFailed?: number; error?: string }> {
    console.log('[SyncPipeline] Step 5: Syncing stock/inventory levels from JTL FFN');
    console.log(`[SyncPipeline] This step pulls stock levels from JTL and updates local products`);
    console.log(`[SyncPipeline] Client ID: ${pipeline.clientId}`);

    const stockSyncService = new StockSyncService(this.prisma);
    console.log(`[SyncPipeline] Calling syncStockForClient...`);
    const result = await stockSyncService.syncStockForClient(pipeline.clientId);

    console.log(`[SyncPipeline] Step 5 Results:`);
    console.log(`[SyncPipeline]   📦 Products updated: ${result.productsUpdated}`);
    console.log(`[SyncPipeline]   ❌ Failed: ${result.productsFailed}`);
    if (result.errors.length > 0) {
      console.log(`[SyncPipeline]   Errors: ${result.errors.slice(0, 3).join('; ')}${result.errors.length > 3 ? '...' : ''}`);
    }

    return {
      success: result.productsFailed === 0,
      itemsProcessed: result.productsUpdated,
      itemsFailed: result.productsFailed,
      error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
    };
  }

  // ============= PIPELINE MANAGEMENT =============

  /**
   * Get current pipeline status
   */
  async getPipelineStatus(channelId: string, syncType: string = 'initial'): Promise<PipelineStatusResponse | null> {
    const pipeline = await this.prisma.syncPipeline.findUnique({
      where: {
        channelId_syncType: {
          channelId,
          syncType,
        },
      },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
        },
      },
    });

    if (!pipeline) {
      return null;
    }

    return {
      pipelineId: pipeline.id,
      channelId: pipeline.channelId,
      clientId: pipeline.clientId,
      status: pipeline.status,
      currentStep: pipeline.currentStep,
      totalSteps: pipeline.totalSteps,
      progress: pipeline.progress,
      progressMessage: pipeline.progressMessage,
      lastError: pipeline.lastError,
      startedAt: pipeline.startedAt,
      completedAt: pipeline.completedAt,
      steps: pipeline.steps.map((step) => ({
        stepNumber: step.stepNumber,
        stepName: step.stepName,
        stepDescription: step.stepDescription,
        status: step.status,
        progress: step.progress,
        itemsTotal: step.itemsTotal,
        itemsProcessed: step.itemsProcessed,
        itemsFailed: step.itemsFailed,
        errorMessage: step.errorMessage,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
      })),
    };
  }

  /**
   * Pause a running pipeline
   */
  async pausePipeline(pipelineId: string): Promise<PipelineResult> {
    try {
      const pipeline = await this.prisma.syncPipeline.findUnique({
        where: { id: pipelineId },
      });

      if (!pipeline) {
        return { success: false, pipelineId, error: 'Pipeline not found' };
      }

      if (pipeline.status !== 'IN_PROGRESS') {
        return { success: false, pipelineId, error: 'Pipeline is not running' };
      }

      await this.prisma.syncPipeline.update({
        where: { id: pipelineId },
        data: {
          status: 'PAUSED',
          progressMessage: 'Pipeline paused by user',
        },
      });

      return { success: true, pipelineId, message: 'Pipeline paused' };
    } catch (error) {
      return {
        success: false,
        pipelineId,
        error: error instanceof Error ? error.message : 'Failed to pause pipeline',
      };
    }
  }

  /**
   * Resume a paused pipeline
   */
  async resumePipeline(pipelineId: string): Promise<PipelineResult> {
    try {
      const pipeline = await this.prisma.syncPipeline.findUnique({
        where: { id: pipelineId },
      });

      if (!pipeline) {
        return { success: false, pipelineId, error: 'Pipeline not found' };
      }

      if (pipeline.status !== 'PAUSED' && pipeline.status !== 'FAILED') {
        return { success: false, pipelineId, error: 'Pipeline is not paused or failed' };
      }

      // Resume execution
      this.executePipeline(pipelineId).catch((err) => {
        console.error(`[SyncPipeline] Pipeline ${pipelineId} failed:`, err);
      });

      return { success: true, pipelineId, message: 'Pipeline resumed' };
    } catch (error) {
      return {
        success: false,
        pipelineId,
        error: error instanceof Error ? error.message : 'Failed to resume pipeline',
      };
    }
  }

  /**
   * Retry a failed pipeline from the failed step
   */
  async retryPipeline(pipelineId: string): Promise<PipelineResult> {
    try {
      const pipeline = await this.prisma.syncPipeline.findUnique({
        where: { id: pipelineId },
      });

      if (!pipeline) {
        return { success: false, pipelineId, error: 'Pipeline not found' };
      }

      if (pipeline.status !== 'FAILED') {
        return { success: false, pipelineId, error: 'Pipeline is not in failed state' };
      }

      if (pipeline.retryCount >= pipeline.maxRetries) {
        return { success: false, pipelineId, error: 'Maximum retry attempts reached' };
      }

      // Reset failed step to pending
      await this.prisma.pipelineStep.updateMany({
        where: {
          pipelineId,
          status: 'FAILED',
        },
        data: {
          status: 'PENDING',
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        },
      });

      // Resume execution
      this.executePipeline(pipelineId).catch((err) => {
        console.error(`[SyncPipeline] Pipeline ${pipelineId} failed:`, err);
      });

      return { success: true, pipelineId, message: 'Pipeline retry started' };
    } catch (error) {
      return {
        success: false,
        pipelineId,
        error: error instanceof Error ? error.message : 'Failed to retry pipeline',
      };
    }
  }

  /**
   * Cancel a running pipeline completely
   * Marks it as FAILED so user can restart fresh
   */
  async cancelPipeline(pipelineId: string): Promise<PipelineResult> {
    try {
      const pipeline = await this.prisma.syncPipeline.findUnique({
        where: { id: pipelineId },
      });

      if (!pipeline) {
        return { success: false, pipelineId, error: 'Pipeline not found' };
      }

      if (pipeline.status !== 'IN_PROGRESS' && pipeline.status !== 'PAUSED' && pipeline.status !== 'PENDING') {
        return { success: false, pipelineId, error: 'Pipeline is not running or paused' };
      }

      // Update pipeline to FAILED status
      await this.prisma.syncPipeline.update({
        where: { id: pipelineId },
        data: {
          status: 'FAILED',
          lastError: 'Pipeline cancelled by user',
          completedAt: new Date(),
        },
      });

      // Mark any in-progress steps as failed
      await this.prisma.pipelineStep.updateMany({
        where: {
          pipelineId,
          status: 'IN_PROGRESS',
        },
        data: {
          status: 'FAILED',
          errorMessage: 'Cancelled by user',
          completedAt: new Date(),
        },
      });

      console.log(`[SyncPipeline] Pipeline ${pipelineId} cancelled by user`);

      return { success: true, pipelineId, message: 'Pipeline cancelled' };
    } catch (error) {
      return {
        success: false,
        pipelineId,
        error: error instanceof Error ? error.message : 'Failed to cancel pipeline',
      };
    }
  }
}

export default InitialSyncPipelineService;
