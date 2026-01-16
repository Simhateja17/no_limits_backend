/**
 * Notifications Controller
 * 
 * Handles notification API endpoints for:
 * - Fetching user notifications
 * - Fetching admin broadcast notifications
 * - Marking notifications as read
 * - Dismissing notifications
 */

import { Request, Response } from 'express';
import { notificationService } from '../services/notification.service.js';
import { NotificationType } from '@prisma/client';

/**
 * GET /api/notifications
 * Get notifications for the authenticated user
 */
export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { unreadOnly, limit, offset, types } = req.query;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await notificationService.getForUser(userId, {
      unreadOnly: unreadOnly === 'true',
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
      types: types ? (types as string).split(',') as NotificationType[] : undefined,
    });

    res.json(result);
  } catch (error: any) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/notifications/admin
 * Get admin broadcast notifications (for ADMIN, SUPER_ADMIN, EMPLOYEE roles)
 */
export const getAdminNotifications = async (req: Request, res: Response) => {
  try {
    const role = req.user?.role;
    const { unreadOnly, limit, offset, types, clientId } = req.query;

    if (!['SUPER_ADMIN', 'ADMIN', 'EMPLOYEE'].includes(role || '')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await notificationService.getAdminNotifications({
      unreadOnly: unreadOnly === 'true',
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
      types: types ? (types as string).split(',') as NotificationType[] : undefined,
      clientId: clientId as string | undefined,
    });

    res.json(result);
  } catch (error: any) {
    console.error('Error fetching admin notifications:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/notifications/unread-count
 * Get unread notification count for authenticated user
 */
export const getUnreadCount = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get user's personal notifications count
    const userCount = await notificationService.getUnreadCount(userId);

    // For admin roles, also get admin broadcast notifications count
    let adminCount = 0;
    if (['SUPER_ADMIN', 'ADMIN', 'EMPLOYEE'].includes(role || '')) {
      adminCount = await notificationService.getAdminUnreadCount();
    }

    res.json({
      userCount,
      adminCount,
      totalCount: userCount + adminCount,
    });
  } catch (error: any) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * PUT /api/notifications/:id/read
 * Mark a notification as read
 */
export const markAsRead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    await notificationService.markAsRead(id, userId);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * PUT /api/notifications/read-all
 * Mark all notifications as read for the authenticated user
 */
export const markAllAsRead = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const count = await notificationService.markAllAsRead(userId);

    res.json({ success: true, count });
  } catch (error: any) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * DELETE /api/notifications/:id
 * Dismiss (hide) a notification
 */
export const dismissNotification = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await notificationService.dismiss(id);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error dismissing notification:', error);
    res.status(500).json({ error: error.message });
  }
};
