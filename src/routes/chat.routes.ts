import { Router } from 'express';
import {
  getChatRooms,
  getChatMessages,
  sendMessage,
  getOrCreateChatRoom,
  getMyRoomInfo,
  getRecentMessages,
} from '../controllers/chat.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// All chat routes require authentication
router.use(authenticate);

// GET /api/chat/rooms - Get all chat rooms (for admins)
router.get('/rooms', getChatRooms);

// GET /api/chat/recent - Get recent messages across all rooms (for admin dashboard)
router.get('/recent', getRecentMessages);

// GET /api/chat/my-room - Get current user's own chat room (for clients/employees)
router.get('/my-room', getMyRoomInfo);

// GET /api/chat/rooms/:roomId/messages - Get messages for a specific chat room
router.get('/rooms/:roomId/messages', getChatMessages);

// POST /api/chat/rooms/:roomId/messages - Send a message in a chat room
router.post('/rooms/:roomId/messages', sendMessage);

// POST /api/chat/clients/:clientId/room - Get or create chat room for a client (for admins)
router.post('/clients/:clientId/room', getOrCreateChatRoom);

export default router;
