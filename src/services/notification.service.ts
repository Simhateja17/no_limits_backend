/**
 * Notification Service
 * 
 * Handles system notifications for:
 * - Shipping method mismatches
 * - Orders put on hold
 * - Sync errors
 * - Inventory alerts
 * - Task assignments
 * 
 * Provides:
 * - Database persistence
 * - Real-time Socket.IO delivery
 * - Email notifications (for critical alerts)
 */

import { NotificationType, NotificationPriority, UserRole } from '@prisma/client';
import { prisma } from '../config/database.js';
import { getIO, emitToUser } from './socket.js';

export interface CreateNotificationParams {
  type: NotificationType;
  priority?: NotificationPriority;
  title: string;
  message: string;
  userId?: string | null;
  clientId?: string | null;
  orderId?: string | null;
  mismatchId?: string | null;
  metadata?: Record<string, unknown>;
  actionUrl?: string | null;
}

export interface NotificationWithRelations {
  id: string;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  message: string;
  userId: string | null;
  clientId: string | null;
  orderId: string | null;
  mismatchId: string | null;
  metadata: unknown;
  isRead: boolean;
  readAt: Date | null;
  isDismissed: boolean;
  dismissedAt: Date | null;
  actionUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  client?: { name: string; companyName: string } | null;
  order?: { orderId: string; orderNumber: string | null } | null;
}

class NotificationService {
  private prisma = prisma;

  /**
   * Create a notification and emit via Socket.IO
   */
  async create(params: CreateNotificationParams): Promise<NotificationWithRelations> {
    const {
      type,
      priority = NotificationPriority.MEDIUM,
      title,
      message,
      userId,
      clientId,
      orderId,
      mismatchId,
      metadata,
      actionUrl,
    } = params;

    const notification = await this.prisma.notification.create({
      data: {
        type,
        priority,
        title,
        message,
        userId,
        clientId,
        orderId,
        mismatchId,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
        actionUrl,
      },
      include: {
        client: { select: { name: true, companyName: true } },
        order: { select: { orderId: true, orderNumber: true } },
      },
    });

    // Emit real-time notification
    this.emitNotification(notification, userId);

    return notification;
  }

  /**
   * Create a shipping mismatch notification
   */
  async createShippingMismatchNotification(params: {
    orderId: string;
    orderDisplayId: string;
    clientId: string;
    clientName: string;
    channelShippingCode: string | null;
    channelShippingTitle: string | null;
    channelType: string;
    mismatchId: string;
    usedFallback: boolean;
    fallbackMethodName?: string;
  }): Promise<NotificationWithRelations> {
    const {
      orderId,
      orderDisplayId,
      clientId,
      clientName,
      channelShippingCode,
      channelShippingTitle,
      channelType,
      mismatchId,
      usedFallback,
      fallbackMethodName,
    } = params;

    let title: string;
    let message: string;
    let priority: NotificationPriority;

    if (usedFallback) {
      title = `Shipping Method Fallback Used`;
      message = `Order ${orderDisplayId} (${clientName}) used fallback shipping "${fallbackMethodName || 'default'}" because "${channelShippingTitle || channelShippingCode}" from ${channelType} is not mapped.`;
      priority = NotificationPriority.MEDIUM;
    } else {
      title = `Order On Hold - Shipping Method Unknown`;
      message = `Order ${orderDisplayId} (${clientName}) is on hold. Shipping method "${channelShippingTitle || channelShippingCode}" from ${channelType} has no mapping and no fallback is configured.`;
      priority = NotificationPriority.HIGH;
    }

    const notification = await this.create({
      type: NotificationType.SHIPPING_MISMATCH,
      priority,
      title,
      message,
      clientId,
      orderId,
      mismatchId,
      actionUrl: `/admin/shipping?mismatchId=${mismatchId}`,
      metadata: {
        channelShippingCode,
        channelShippingTitle,
        channelType,
        usedFallback,
        fallbackMethodName,
      },
    });

    // For high priority (order on hold without fallback), also broadcast to all admins
    if (priority === NotificationPriority.HIGH) {
      await this.broadcastToAdmins(notification);
    }

    return notification;
  }

  /**
   * Create an order on hold notification
   */
  async createOrderOnHoldNotification(params: {
    orderId: string;
    orderDisplayId: string;
    clientId: string;
    clientName: string;
    reason: string;
  }): Promise<NotificationWithRelations> {
    const { orderId, orderDisplayId, clientId, clientName, reason } = params;

    const notification = await this.create({
      type: NotificationType.ORDER_ON_HOLD,
      priority: NotificationPriority.HIGH,
      title: `Order On Hold: ${orderDisplayId}`,
      message: `Order ${orderDisplayId} (${clientName}) has been put on hold. Reason: ${reason}`,
      clientId,
      orderId,
      actionUrl: `/admin/orders/${orderId}`,
      metadata: { reason },
    });

    await this.broadcastToAdmins(notification);
    return notification;
  }

  /**
   * Create a sync error notification
   */
  async createSyncErrorNotification(params: {
    clientId: string;
    clientName: string;
    errorType: 'JTL' | 'SHOPIFY' | 'WOOCOMMERCE';
    errorMessage: string;
    orderId?: string;
    orderDisplayId?: string;
  }): Promise<NotificationWithRelations> {
    const { clientId, clientName, errorType, errorMessage, orderId, orderDisplayId } = params;

    return this.create({
      type: NotificationType.SYNC_ERROR,
      priority: NotificationPriority.HIGH,
      title: `Sync Error: ${errorType}`,
      message: orderDisplayId
        ? `Failed to sync order ${orderDisplayId} (${clientName}) to ${errorType}: ${errorMessage}`
        : `${errorType} sync failed for ${clientName}: ${errorMessage}`,
      clientId,
      orderId,
      actionUrl: orderId ? `/admin/orders/${orderId}` : `/admin/sync-status`,
      metadata: { errorType, errorMessage },
    });
  }

  /**
   * Get notifications for a user
   */
  async getForUser(
    userId: string,
    options: {
      unreadOnly?: boolean;
      limit?: number;
      offset?: number;
      types?: NotificationType[];
    } = {}
  ): Promise<{ notifications: NotificationWithRelations[]; total: number }> {
    const { unreadOnly = false, limit = 50, offset = 0, types } = options;

    const where = {
      userId,
      ...(unreadOnly && { isRead: false }),
      ...(types?.length && { type: { in: types } }),
      isDismissed: false,
    };

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          client: { select: { name: true, companyName: true } },
          order: { select: { orderId: true, orderNumber: true } },
        },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { notifications, total };
  }

  /**
   * Get admin notifications (all unassigned notifications)
   */
  async getAdminNotifications(
    options: {
      unreadOnly?: boolean;
      limit?: number;
      offset?: number;
      types?: NotificationType[];
      clientId?: string;
    } = {}
  ): Promise<{ notifications: NotificationWithRelations[]; total: number }> {
    const { unreadOnly = false, limit = 50, offset = 0, types, clientId } = options;

    const where = {
      userId: null, // Broadcast notifications
      ...(unreadOnly && { isRead: false }),
      ...(types?.length && { type: { in: types } }),
      ...(clientId && { clientId }),
      isDismissed: false,
    };

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          client: { select: { name: true, companyName: true } },
          order: { select: { orderId: true, orderNumber: true } },
        },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { notifications, total };
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: {
        userId,
        isRead: false,
        isDismissed: false,
      },
    });
  }

  /**
   * Get unread count for admins (broadcast notifications)
   */
  async getAdminUnreadCount(): Promise<number> {
    return this.prisma.notification.count({
      where: {
        userId: null,
        isRead: false,
        isDismissed: false,
      },
    });
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string, userId?: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return result.count;
  }

  /**
   * Dismiss a notification
   */
  async dismiss(notificationId: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        isDismissed: true,
        dismissedAt: new Date(),
      },
    });
  }

  /**
   * Delete old notifications (cleanup job)
   */
  async deleteOldNotifications(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.prisma.notification.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
        isRead: true, // Only delete read notifications
      },
    });

    return result.count;
  }

  /**
   * Emit notification via Socket.IO
   */
  private emitNotification(
    notification: NotificationWithRelations,
    targetUserId?: string | null
  ): void {
    try {
      const io = getIO();
      const payload = {
        id: notification.id,
        type: notification.type,
        priority: notification.priority,
        title: notification.title,
        message: notification.message,
        actionUrl: notification.actionUrl,
        createdAt: notification.createdAt,
        client: notification.client,
        order: notification.order,
      };

      if (targetUserId) {
        // Send to specific user
        emitToUser(targetUserId, 'notification:new', payload);
      } else {
        // Broadcast to all admin users
        io.emit('notification:admin', payload);
      }
    } catch (error) {
      // Socket.IO might not be initialized in test environment
      console.warn('Failed to emit notification via Socket.IO:', error);
    }
  }

  /**
   * Broadcast notification to all admin users
   */
  private async broadcastToAdmins(notification: NotificationWithRelations): Promise<void> {
    try {
      const io = getIO();
      const payload = {
        id: notification.id,
        type: notification.type,
        priority: notification.priority,
        title: notification.title,
        message: notification.message,
        actionUrl: notification.actionUrl,
        createdAt: notification.createdAt,
        client: notification.client,
        order: notification.order,
      };

      // Emit to all connected admin/superadmin users
      io.emit('notification:admin', payload);
    } catch (error) {
      console.warn('Failed to broadcast notification to admins:', error);
    }
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
export default notificationService;
