/**
 * Conflict Resolution Service
 *
 * Handles sync conflicts when the same field is updated from multiple sources
 * within a short time window.
 *
 * Resolution Strategy:
 * 1. Check field ownership rules (commerce vs ops vs shared)
 * 2. Apply deterministic conflict resolution:
 *    - Commerce fields: Prefer Shopify/WooCommerce
 *    - Ops fields: Prefer No-Limits
 *    - Shared fields: Last-write-wins (with conflict log)
 *    - Stock: Only No-Limits/JTL can update
 * 3. Log all conflicts for manual review if needed
 */

import { PrismaClient, SyncOrigin } from '@prisma/client';
import { FIELD_OWNERSHIP } from './product-sync.service.js';

// ============= TYPES =============

export interface FieldConflict {
  entityType: 'product' | 'order' | 'return';
  entityId: string;
  field: string;
  localValue: unknown;
  incomingValue: unknown;
  localOrigin: SyncOrigin;
  incomingOrigin: SyncOrigin;
  localTimestamp: Date;
  incomingTimestamp: Date;
  resolution: 'accept_local' | 'accept_incoming' | 'manual';
  resolvedValue?: unknown;
  reason: string;
}

export interface ConflictResolutionResult {
  hasConflict: boolean;
  conflicts: FieldConflict[];
  resolvedFields: Record<string, unknown>;
  manualReviewRequired: boolean;
}

// ============= CONFLICT RESOLUTION SERVICE =============

export class ConflictResolutionService {
  // Time window for conflict detection (5 minutes)
  private static readonly CONFLICT_WINDOW_MS = 5 * 60 * 1000;

  constructor(private prisma: PrismaClient) {}

  /**
   * Detect and resolve product field conflicts
   */
  async resolveProductConflicts(
    productId: string,
    incomingChanges: Record<string, unknown>,
    incomingOrigin: SyncOrigin,
    incomingTimestamp: Date = new Date()
  ): Promise<ConflictResolutionResult> {
    try {
      // 1. Get current product state
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
      });

      if (!product) {
        return {
          hasConflict: false,
          conflicts: [],
          resolvedFields: incomingChanges,
          manualReviewRequired: false,
        };
      }

      const conflicts: FieldConflict[] = [];
      const resolvedFields: Record<string, unknown> = {};

      // 2. Check each incoming field for conflicts
      for (const [field, incomingValue] of Object.entries(incomingChanges)) {
        const localValue = (product as any)[field];
        const lastFieldUpdate = (product.lastFieldUpdates as any)?.[field];

        // Skip if values are the same
        if (localValue === incomingValue) {
          resolvedFields[field] = incomingValue;
          continue;
        }

        // Check if there's a recent update to this field
        const hasRecentUpdate =
          lastFieldUpdate &&
          new Date(lastFieldUpdate.at).getTime() >
            Date.now() - ConflictResolutionService.CONFLICT_WINDOW_MS;

        if (hasRecentUpdate) {
          // Conflict detected!
          const conflict = this.resolveFieldConflict(
            'product',
            productId,
            field,
            localValue,
            incomingValue,
            lastFieldUpdate.by as SyncOrigin,
            incomingOrigin,
            new Date(lastFieldUpdate.at),
            incomingTimestamp
          );

          conflicts.push(conflict);
          resolvedFields[field] = conflict.resolvedValue ?? incomingValue;
        } else {
          // No conflict, accept incoming value
          resolvedFields[field] = incomingValue;
        }
      }

      // 3. Log conflicts
      if (conflicts.length > 0) {
        await this.logConflicts(conflicts);
      }

      return {
        hasConflict: conflicts.length > 0,
        conflicts,
        resolvedFields,
        manualReviewRequired: conflicts.some(c => c.resolution === 'manual'),
      };
    } catch (error) {
      console.error('[ConflictResolution] Error resolving conflicts:', error);
      return {
        hasConflict: false,
        conflicts: [],
        resolvedFields: incomingChanges,
        manualReviewRequired: false,
      };
    }
  }

  /**
   * Resolve a single field conflict using deterministic rules
   */
  private resolveFieldConflict(
    entityType: 'product' | 'order' | 'return',
    entityId: string,
    field: string,
    localValue: unknown,
    incomingValue: unknown,
    localOrigin: SyncOrigin,
    incomingOrigin: SyncOrigin,
    localTimestamp: Date,
    incomingTimestamp: Date
  ): FieldConflict {
    // Determine field ownership category
    const fieldCategory = this.getFieldCategory(field);

    let resolution: 'accept_local' | 'accept_incoming' | 'manual';
    let resolvedValue: unknown;
    let reason: string;

    switch (fieldCategory) {
      case 'commerce':
        // Commerce fields: Prefer commerce platform (Shopify/WooCommerce)
        if (this.isCommercePlatform(incomingOrigin)) {
          resolution = 'accept_incoming';
          resolvedValue = incomingValue;
          reason = 'Commerce field - accepting value from commerce platform';
        } else if (this.isCommercePlatform(localOrigin)) {
          resolution = 'accept_local';
          resolvedValue = localValue;
          reason = 'Commerce field - keeping value from commerce platform';
        } else {
          // Both from non-commerce platforms - use last-write-wins
          resolution = incomingTimestamp > localTimestamp ? 'accept_incoming' : 'accept_local';
          resolvedValue = resolution === 'accept_incoming' ? incomingValue : localValue;
          reason = 'Commerce field - last-write-wins between non-commerce platforms';
        }
        break;

      case 'ops':
        // Ops fields: Prefer No-Limits platform
        if (incomingOrigin === 'NOLIMITS') {
          resolution = 'accept_incoming';
          resolvedValue = incomingValue;
          reason = 'Ops field - accepting value from No-Limits platform';
        } else if (localOrigin === 'NOLIMITS') {
          resolution = 'accept_local';
          resolvedValue = localValue;
          reason = 'Ops field - keeping value from No-Limits platform';
        } else {
          // Both from non-platform sources - use last-write-wins
          resolution = incomingTimestamp > localTimestamp ? 'accept_incoming' : 'accept_local';
          resolvedValue = resolution === 'accept_incoming' ? incomingValue : localValue;
          reason = 'Ops field - last-write-wins between non-platform sources';
        }
        break;

      case 'stock':
        // Stock fields: Only No-Limits/JTL can update
        if (incomingOrigin === 'NOLIMITS' || incomingOrigin === 'JTL') {
          resolution = 'accept_incoming';
          resolvedValue = incomingValue;
          reason = 'Stock field - accepting value from authorized source (No-Limits/JTL)';
        } else {
          resolution = 'accept_local';
          resolvedValue = localValue;
          reason = 'Stock field - rejecting unauthorized update';
        }
        break;

      case 'shared':
      default:
        // Shared fields: Last-write-wins with conflict log
        if (incomingTimestamp > localTimestamp) {
          resolution = 'accept_incoming';
          resolvedValue = incomingValue;
          reason = 'Shared field - last-write-wins (incoming is newer)';
        } else if (localTimestamp > incomingTimestamp) {
          resolution = 'accept_local';
          resolvedValue = localValue;
          reason = 'Shared field - last-write-wins (local is newer)';
        } else {
          // Same timestamp - require manual resolution
          resolution = 'manual';
          resolvedValue = localValue; // Keep local for now
          reason = 'Shared field - same timestamp, manual review required';
        }
        break;
    }

    return {
      entityType,
      entityId,
      field,
      localValue,
      incomingValue,
      localOrigin,
      incomingOrigin,
      localTimestamp,
      incomingTimestamp,
      resolution,
      resolvedValue,
      reason,
    };
  }

  /**
   * Get field category based on ownership rules
   */
  private getFieldCategory(field: string): 'commerce' | 'ops' | 'stock' | 'shared' {
    if (FIELD_OWNERSHIP.commerce.includes(field as any)) return 'commerce';
    if (FIELD_OWNERSHIP.ops.includes(field as any)) return 'ops';
    if (FIELD_OWNERSHIP.stock.includes(field as any)) return 'stock';
    return 'shared';
  }

  /**
   * Check if origin is a commerce platform
   */
  private isCommercePlatform(origin: SyncOrigin): boolean {
    return origin === 'SHOPIFY' || origin === 'WOOCOMMERCE';
  }

  /**
   * Log conflicts for manual review
   */
  private async logConflicts(conflicts: FieldConflict[]): Promise<void> {
    try {
      for (const conflict of conflicts) {
        // Log to appropriate sync log table based on entity type
        if (conflict.entityType === 'product') {
          await this.prisma.productSyncLog.create({
            data: {
              productId: conflict.entityId,
              action: 'conflict',
              origin: conflict.incomingOrigin,
              targetPlatform: 'nolimits',
              changedFields: [conflict.field],
              oldValues: { [conflict.field]: conflict.localValue } as any,
              newValues: { [conflict.field]: conflict.incomingValue } as any,
              success: conflict.resolution !== 'manual',
              errorMessage:
                conflict.resolution === 'manual'
                  ? `Manual review required: ${conflict.reason}`
                  : undefined,
            },
          });
        }

        console.log(`[ConflictResolution] ${conflict.entityType} conflict:`, {
          field: conflict.field,
          resolution: conflict.resolution,
          reason: conflict.reason,
        });
      }
    } catch (error) {
      console.error('[ConflictResolution] Failed to log conflicts:', error);
    }
  }

  /**
   * Get unresolved conflicts for manual review
   */
  async getUnresolvedConflicts(
    entityType: 'product' | 'order' | 'return',
    clientId?: string
  ): Promise<FieldConflict[]> {
    try {
      if (entityType === 'product') {
        const conflictLogs = await this.prisma.productSyncLog.findMany({
          where: {
            action: 'conflict',
            success: false,
            ...(clientId
              ? {
                  product: {
                    clientId,
                  },
                }
              : {}),
          },
          include: {
            product: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 100,
        });

        return conflictLogs.map(log => ({
          entityType: 'product',
          entityId: log.productId,
          field: log.changedFields[0] || 'unknown',
          localValue: (log.oldValues as any)?.[log.changedFields[0]],
          incomingValue: (log.newValues as any)?.[log.changedFields[0]],
          localOrigin: ((log.oldValues as any)?._localOrigin as SyncOrigin) || 'NOLIMITS',
          incomingOrigin: log.origin,
          localTimestamp: log.createdAt,
          incomingTimestamp: log.createdAt,
          resolution: 'manual',
          reason: log.errorMessage || 'Manual review required',
        }));
      }

      // Handle order conflicts
      if (entityType === 'order') {
        const conflictLogs = await this.prisma.orderSyncLog.findMany({
          where: {
            action: 'conflict',
            success: false,
            ...(clientId
              ? {
                  order: {
                    clientId,
                  },
                }
              : {}),
          },
          include: {
            order: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 100,
        });

        return conflictLogs.map(log => {
          const previousState = log.previousState as Record<string, any> | null;
          const newState = log.newState as Record<string, any> | null;
          const field = log.changedFields[0] || 'unknown';
          return {
            entityType: 'order' as const,
            entityId: log.orderId,
            field,
            localValue: previousState?.[field],
            incomingValue: newState?.[field],
            localOrigin: (previousState?._localOrigin as SyncOrigin) || 'NOLIMITS' as SyncOrigin,
            incomingOrigin: log.origin,
            localTimestamp: log.createdAt,
            incomingTimestamp: log.createdAt,
            resolution: 'manual' as const,
            reason: log.errorMessage || 'Manual review required',
          };
        });
      }

      return [];
    } catch (error) {
      console.error('[ConflictResolution] Failed to get unresolved conflicts:', error);
      return [];
    }
  }

  /**
   * Manually resolve a conflict
   * 
   * @param conflictId - The sync log ID that represents the conflict
   * @param entityType - Type of entity: 'product', 'order', or 'return'
   * @param resolution - Resolution choice: 'accept_local', 'accept_incoming', or 'custom'
   * @param customValue - Custom value to use if resolution is 'custom'
   */
  async manuallyResolveConflict(
    conflictId: string,
    entityType: 'product' | 'order' | 'return',
    resolution: 'accept_local' | 'accept_incoming' | 'custom',
    customValue?: unknown
  ): Promise<{ success: boolean; error?: string; syncTriggered?: boolean }> {
    try {
      console.log(`[ConflictResolution] Manual resolution: ${resolution} for ${entityType} conflict ${conflictId}`);

      if (entityType === 'product') {
        // Get the conflict log
        const conflictLog = await this.prisma.productSyncLog.findUnique({
          where: { id: conflictId },
          include: { product: true },
        });

        if (!conflictLog) {
          return { success: false, error: 'Conflict log not found' };
        }

        const field = conflictLog.changedFields[0];
        const localValue = (conflictLog.oldValues as any)?.[field];
        const incomingValue = (conflictLog.newValues as any)?.[field];

        // Determine the resolved value
        let resolvedValue: unknown;
        if (resolution === 'accept_local') {
          resolvedValue = localValue;
        } else if (resolution === 'accept_incoming') {
          resolvedValue = incomingValue;
        } else if (resolution === 'custom' && customValue !== undefined) {
          resolvedValue = customValue;
        } else {
          return { success: false, error: 'Invalid resolution or missing custom value' };
        }

        // Update the product with the resolved value
        await this.prisma.product.update({
          where: { id: conflictLog.productId },
          data: {
            [field]: resolvedValue,
            lastUpdatedBy: 'NOLIMITS',
            syncStatus: 'PENDING', // Mark for re-sync
          },
        });

        // Mark the conflict as resolved in the sync log
        await this.prisma.productSyncLog.update({
          where: { id: conflictId },
          data: {
            success: true,
            errorMessage: `Manually resolved: ${resolution}${resolution === 'custom' ? ` (value: ${JSON.stringify(customValue)})` : ''}`,
          },
        });

        // Log the resolution
        await this.prisma.productSyncLog.create({
          data: {
            productId: conflictLog.productId,
            action: 'resolve_conflict',
            origin: 'NOLIMITS',
            targetPlatform: 'nolimits',
            changedFields: [field],
            oldValues: { [field]: localValue } as any,
            newValues: { [field]: resolvedValue } as any,
            success: true,
          },
        });

        console.log(`[ConflictResolution] Product ${conflictLog.productId} field "${field}" resolved to: ${JSON.stringify(resolvedValue)}`);

        return { success: true, syncTriggered: true };
      }

      if (entityType === 'order') {
        // Get the conflict log
        const conflictLog = await this.prisma.orderSyncLog.findUnique({
          where: { id: conflictId },
          include: { order: true },
        });

        if (!conflictLog) {
          return { success: false, error: 'Conflict log not found' };
        }

        const field = conflictLog.changedFields[0];
        const previousState = conflictLog.previousState as Record<string, any> | null;
        const newState = conflictLog.newState as Record<string, any> | null;
        const localValue = previousState?.[field];
        const incomingValue = newState?.[field];

        // Determine the resolved value
        let resolvedValue: unknown;
        if (resolution === 'accept_local') {
          resolvedValue = localValue;
        } else if (resolution === 'accept_incoming') {
          resolvedValue = incomingValue;
        } else if (resolution === 'custom' && customValue !== undefined) {
          resolvedValue = customValue;
        } else {
          return { success: false, error: 'Invalid resolution or missing custom value' };
        }

        // Update the order with the resolved value
        await this.prisma.order.update({
          where: { id: conflictLog.orderId },
          data: {
            [field]: resolvedValue,
            lastOperationalUpdateBy: 'NOLIMITS',
            lastOperationalUpdateAt: new Date(),
            syncStatus: 'PENDING', // Mark for re-sync
          },
        });

        // Mark the conflict as resolved in the sync log
        await this.prisma.orderSyncLog.update({
          where: { id: conflictId },
          data: {
            success: true,
            errorMessage: `Manually resolved: ${resolution}${resolution === 'custom' ? ` (value: ${JSON.stringify(customValue)})` : ''}`,
          },
        });

        // Log the resolution
        await this.prisma.orderSyncLog.create({
          data: {
            orderId: conflictLog.orderId,
            action: 'resolve_conflict',
            origin: 'NOLIMITS',
            targetPlatform: 'nolimits',
            changedFields: [field],
            previousState: { [field]: localValue } as any,
            newState: { [field]: resolvedValue } as any,
            success: true,
          },
        });

        console.log(`[ConflictResolution] Order ${conflictLog.orderId} field "${field}" resolved to: ${JSON.stringify(resolvedValue)}`);

        return { success: true, syncTriggered: true };
      }

      return { success: false, error: `Unsupported entity type: ${entityType}` };
    } catch (error: any) {
      console.error('[ConflictResolution] Failed to manually resolve conflict:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get conflict statistics for a client
   */
  async getConflictStats(clientId: string): Promise<{
    total: number;
    byEntityType: Record<string, number>;
    byField: Record<string, number>;
    recent: number;
  }> {
    try {
      // Get product conflicts
      const productConflicts = await this.prisma.productSyncLog.count({
        where: {
          action: 'conflict',
          success: false,
          product: { clientId },
        },
      });

      // Get order conflicts
      const orderConflicts = await this.prisma.orderSyncLog.count({
        where: {
          action: 'conflict',
          success: false,
          order: { clientId },
        },
      });

      // Get recent conflicts (last 24 hours)
      const recentDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentProductConflicts = await this.prisma.productSyncLog.count({
        where: {
          action: 'conflict',
          success: false,
          product: { clientId },
          createdAt: { gte: recentDate },
        },
      });
      const recentOrderConflicts = await this.prisma.orderSyncLog.count({
        where: {
          action: 'conflict',
          success: false,
          order: { clientId },
          createdAt: { gte: recentDate },
        },
      });

      return {
        total: productConflicts + orderConflicts,
        byEntityType: {
          product: productConflicts,
          order: orderConflicts,
        },
        byField: {}, // Would need more complex query to aggregate by field
        recent: recentProductConflicts + recentOrderConflicts,
      };
    } catch (error) {
      console.error('[ConflictResolution] Failed to get conflict stats:', error);
      return {
        total: 0,
        byEntityType: {},
        byField: {},
        recent: 0,
      };
    }
  }
}
