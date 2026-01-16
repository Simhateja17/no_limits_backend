import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { verifyAccessToken, TokenPayload } from '../utils/auth.js';
import { env } from '../config/index.js';
import { UserRole } from '@prisma/client';

// Extend Socket interface to include user data
interface AuthenticatedSocket extends Socket {
  user?: TokenPayload;
}

// Store for tracking online users
const onlineUsers = new Map<string, string>(); // userId -> socketId

let io: SocketIOServer;

export const initializeSocket = (httpServer: HTTPServer): SocketIOServer => {
  const allowedOrigins = env.frontendUrl.split(',').map(url => url.trim());

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling']
  });

  // Socket.IO authentication middleware
  io.use((socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const payload = verifyAccessToken(token);
      socket.user = payload;
      next();
    } catch (error) {
      console.error('Socket authentication error:', error);
      next(new Error('Authentication error: Invalid token'));
    }
  });

  // Handle socket connections
  io.on('connection', (socket: AuthenticatedSocket) => {
    const user = socket.user!;
    console.log(`User connected: ${user.email} (${user.userId}) - Role: ${user.role}`);

    // Store online user
    onlineUsers.set(user.userId, socket.id);

    // Join user to their personal room
    socket.join(`user:${user.userId}`);

    // Emit online status to all users
    io.emit('user:online', { userId: user.userId });

    // Handle joining chat rooms
    socket.on('chat:join', (roomId: string) => {
      socket.join(`chat:${roomId}`);
      console.log(`User ${user.email} joined room ${roomId}`);

      // Notify room participants that user is online
      socket.to(`chat:${roomId}`).emit('user:joined', {
        userId: user.userId,
        roomId
      });
    });

    // Handle leaving chat rooms
    socket.on('chat:leave', (roomId: string) => {
      socket.leave(`chat:${roomId}`);
      console.log(`User ${user.email} left room ${roomId}`);

      socket.to(`chat:${roomId}`).emit('user:left', {
        userId: user.userId,
        roomId
      });
    });

    // Handle typing indicator
    socket.on('chat:typing', ({ roomId, isTyping }: { roomId: string; isTyping: boolean }) => {
      socket.to(`chat:${roomId}`).emit('chat:typing', {
        userId: user.userId,
        roomId,
        isTyping,
        userName: user.email
      });
    });

    // Handle new message
    socket.on('chat:message', (data: any) => {
      console.log(`New message from ${user.email} in room ${data.roomId}`);

      // Emit message to all users in the room except sender
      socket.to(`chat:${data.roomId}`).emit('chat:message', {
        ...data,
        senderId: user.userId
      });
    });

    // Handle message read status
    socket.on('chat:read', ({ roomId, messageId }: { roomId: string; messageId: string }) => {
      socket.to(`chat:${roomId}`).emit('chat:read', {
        roomId,
        messageId,
        userId: user.userId
      });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`User disconnected: ${user.email} (${user.userId})`);

      // Remove from online users
      onlineUsers.delete(user.userId);

      // Emit offline status to all users
      io.emit('user:offline', { userId: user.userId });
    });
  });

  return io;
};

// Helper function to get Socket.IO instance
export const getIO = (): SocketIOServer => {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
};

// Helper function to emit events to specific users
export const emitToUser = (userId: string, event: string, data: any) => {
  const socketId = onlineUsers.get(userId);
  if (socketId) {
    io.to(socketId).emit(event, data);
  }
};

// Helper function to emit events to chat rooms
export const emitToRoom = (roomId: string, event: string, data: any) => {
  io.to(`chat:${roomId}`).emit(event, data);
};

// Helper function to check if user is online
export const isUserOnline = (userId: string): boolean => {
  return onlineUsers.has(userId);
};

// Helper function to get all online users
export const getOnlineUsers = (): string[] => {
  return Array.from(onlineUsers.keys());
};
