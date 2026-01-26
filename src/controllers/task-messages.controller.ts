import { Request, Response } from 'express';
import { prisma } from '../config/database.js';
import { getIO } from '../services/socket.js';

// Get all messages for a specific task
export const getTaskMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;
    const currentUserId = req.user?.userId;
    const currentUserRole = req.user?.role;

    if (!currentUserId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    // Verify task exists
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        assigneeId: true,
        creatorId: true,
      },
    });

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Check access: Admins can access any task, employees can access assigned/created tasks
    const isAdmin = currentUserRole === 'ADMIN' || currentUserRole === 'SUPER_ADMIN';
    const isAssignee = task.assigneeId === currentUserId;
    const isCreator = task.creatorId === currentUserId;

    if (!isAdmin && !isAssignee && !isCreator) {
      res.status(403).json({
        success: false,
        message: 'Access denied to this task',
      });
      return;
    }

    // Fetch messages for the task
    const messages = await prisma.taskMessage.findMany({
      where: { taskId },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            avatar: true,
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Transform to match frontend interface
    const transformedMessages = messages.map((msg) => ({
      id: msg.id,
      senderId: msg.sender.id,
      senderName: msg.sender.name || 'Unknown',
      senderAvatar: msg.sender.avatar || null,
      senderRole: msg.sender.role,
      content: msg.content,
      timestamp: msg.createdAt.toISOString(),
      isFromCurrentUser: msg.senderId === currentUserId,
    }));

    res.json({
      success: true,
      data: transformedMessages,
    });
  } catch (error) {
    console.error('Error fetching task messages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch task messages',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Send a message in a task chat
export const sendTaskMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.params;
    const { content } = req.body;
    const currentUserId = req.user?.userId;
    const currentUserRole = req.user?.role;

    if (!currentUserId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    if (!content || content.trim() === '') {
      res.status(400).json({
        success: false,
        message: 'Message content is required',
      });
      return;
    }

    // Verify task exists
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        assigneeId: true,
        creatorId: true,
      },
    });

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // Check access: Admins can access any task, employees can access assigned/created tasks
    const isAdmin = currentUserRole === 'ADMIN' || currentUserRole === 'SUPER_ADMIN';
    const isAssignee = task.assigneeId === currentUserId;
    const isCreator = task.creatorId === currentUserId;

    if (!isAdmin && !isAssignee && !isCreator) {
      res.status(403).json({
        success: false,
        message: 'Access denied to this task',
      });
      return;
    }

    // Create the message
    const message = await prisma.taskMessage.create({
      data: {
        content: content.trim(),
        taskId,
        senderId: currentUserId,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            avatar: true,
            role: true,
          },
        },
      },
    });

    // Transform to match frontend interface
    const transformedMessage = {
      id: message.id,
      senderId: message.sender.id,
      senderName: message.sender.name || 'Unknown',
      senderAvatar: message.sender.avatar || null,
      senderRole: message.sender.role,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
      isFromCurrentUser: true,
    };

    // Emit real-time event to task room participants
    try {
      const io = getIO();
      io.to(`task:${taskId}`).emit('task:newMessage', transformedMessage);
    } catch (socketError) {
      console.error('Error emitting socket event:', socketError);
      // Don't fail the request if socket emit fails
    }

    res.status(201).json({
      success: true,
      data: transformedMessage,
    });
  } catch (error) {
    console.error('Error sending task message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send task message',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
