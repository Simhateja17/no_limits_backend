import { Router } from 'express';
import {
  getTaskMessages,
  sendTaskMessage,
} from '../controllers/task-messages.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// All task message routes require authentication
router.use(authenticate);

// GET /api/tasks/:taskId/messages - Get all messages for a task
router.get('/:taskId/messages', getTaskMessages);

// POST /api/tasks/:taskId/messages - Send a message in a task chat
router.post('/:taskId/messages', sendTaskMessage);

export default router;
