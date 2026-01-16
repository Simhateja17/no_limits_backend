/**
 * Notifications Routes
 * 
 * API endpoints for notification management.
 */

import { Router } from 'express';
import {
  getNotifications,
  getAdminNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  dismissNotification,
} from '../controllers/notifications.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

/**
 * GET /api/notifications
 * Get notifications for the authenticated user
 * Query: ?unreadOnly=true&limit=50&offset=0&types=SHIPPING_MISMATCH,SYNC_ERROR
 */
router.get('/', getNotifications);

/**
 * GET /api/notifications/admin
 * Get admin broadcast notifications
 * Query: ?unreadOnly=true&limit=50&offset=0&types=SHIPPING_MISMATCH,SYNC_ERROR&clientId=xxx
 */
router.get('/admin', getAdminNotifications);

/**
 * GET /api/notifications/unread-count
 * Get unread notification count
 */
router.get('/unread-count', getUnreadCount);

/**
 * PUT /api/notifications/read-all
 * Mark all notifications as read
 */
router.put('/read-all', markAllAsRead);

/**
 * PUT /api/notifications/:id/read
 * Mark a specific notification as read
 */
router.put('/:id/read', markAsRead);

/**
 * DELETE /api/notifications/:id
 * Dismiss a notification
 */
router.delete('/:id', dismissNotification);

export default router;
