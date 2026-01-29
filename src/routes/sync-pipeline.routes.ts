/**
 * Sync Pipeline Routes
 *
 * API endpoints for managing the initial sync pipeline during client onboarding.
 * Provides real-time progress tracking and pipeline control.
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { InitialSyncPipelineService } from '../services/integrations/initial-sync-pipeline.service.js';

const router = Router();

export default function createSyncPipelineRoutes(prisma: PrismaClient): Router {
  const pipelineService = new InitialSyncPipelineService(prisma);

  /**
   * POST /api/sync-pipeline/start
   * Start a new sync pipeline for a channel
   *
   * Body:
   * - channelId: string (required)
   * - clientId: string (required)
   * - syncFromDate?: string (ISO date)
   * - syncType?: 'initial' | 'full' | 'incremental' (default: 'initial')
   */
  router.post('/start', async (req: Request, res: Response) => {
    try {
      const { channelId, clientId, syncFromDate, syncType } = req.body;

      if (!channelId || !clientId) {
        return res.status(400).json({
          success: false,
          error: 'channelId and clientId are required',
        });
      }

      const result = await pipelineService.startPipeline({
        channelId,
        clientId,
        syncFromDate: syncFromDate ? new Date(syncFromDate) : undefined,
        syncType: syncType || 'initial',
      });

      if (result.success) {
        return res.status(201).json(result);
      } else {
        return res.status(400).json(result);
      }
    } catch (error) {
      console.error('[SyncPipelineRoutes] Error starting pipeline:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  /**
   * GET /api/sync-pipeline/status/:channelId
   * Get the current pipeline status for a channel
   *
   * Query params:
   * - syncType?: string (default: 'initial')
   */
  router.get('/status/:channelId', async (req: Request, res: Response) => {
    try {
      const { channelId } = req.params;
      const syncType = (req.query.syncType as string) || 'initial';

      const status = await pipelineService.getPipelineStatus(channelId, syncType);

      if (!status) {
        return res.status(404).json({
          success: false,
          error: 'Pipeline not found for this channel',
        });
      }

      return res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      console.error('[SyncPipelineRoutes] Error getting pipeline status:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  /**
   * POST /api/sync-pipeline/:pipelineId/pause
   * Pause a running pipeline
   */
  router.post('/:pipelineId/pause', async (req: Request, res: Response) => {
    try {
      const { pipelineId } = req.params;

      const result = await pipelineService.pausePipeline(pipelineId);

      if (result.success) {
        return res.json(result);
      } else {
        return res.status(400).json(result);
      }
    } catch (error) {
      console.error('[SyncPipelineRoutes] Error pausing pipeline:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  /**
   * POST /api/sync-pipeline/:pipelineId/resume
   * Resume a paused pipeline
   */
  router.post('/:pipelineId/resume', async (req: Request, res: Response) => {
    try {
      const { pipelineId } = req.params;

      const result = await pipelineService.resumePipeline(pipelineId);

      if (result.success) {
        return res.json(result);
      } else {
        return res.status(400).json(result);
      }
    } catch (error) {
      console.error('[SyncPipelineRoutes] Error resuming pipeline:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  /**
   * POST /api/sync-pipeline/:pipelineId/retry
   * Retry a failed pipeline from the failed step
   */
  router.post('/:pipelineId/retry', async (req: Request, res: Response) => {
    try {
      const { pipelineId } = req.params;

      const result = await pipelineService.retryPipeline(pipelineId);

      if (result.success) {
        return res.json(result);
      } else {
        return res.status(400).json(result);
      }
    } catch (error) {
      console.error('[SyncPipelineRoutes] Error retrying pipeline:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  /**
   * GET /api/sync-pipeline/client/:clientId/pipelines
   * Get all pipelines for a client
   */
  router.get('/client/:clientId/pipelines', async (req: Request, res: Response) => {
    try {
      const { clientId } = req.params;

      const pipelines = await prisma.syncPipeline.findMany({
        where: { clientId },
        include: {
          steps: {
            orderBy: { stepNumber: 'asc' },
          },
          channel: {
            select: {
              id: true,
              name: true,
              type: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return res.json({
        success: true,
        data: pipelines,
      });
    } catch (error) {
      console.error('[SyncPipelineRoutes] Error getting client pipelines:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  });

  return router;
}
