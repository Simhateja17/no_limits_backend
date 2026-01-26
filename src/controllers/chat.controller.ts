import { Request, Response } from 'express';
import { prisma } from '../config/database.js';
import { emitToRoom, getIO } from '../services/socket.js';

// Helper function to calculate unread count for a user in a chat room
async function calculateUnreadCount(
  roomId: string,
  userId: string,
  lastReadAt: Date | null
): Promise<number> {
  // Count messages that:
  // 1. Are in this room
  // 2. Were NOT sent by this user
  // 3. Were created after the user's lastReadAt (or all messages if never read)
  const whereClause: {
    chatRoomId: string;
    senderId: { not: string };
    createdAt?: { gt: Date };
  } = {
    chatRoomId: roomId,
    senderId: {
      not: userId,
    },
  };

  if (lastReadAt) {
    whereClause.createdAt = {
      gt: lastReadAt,
    };
  }

  return prisma.chatMessage.count({
    where: whereClause,
  });
}

// Get all chat rooms with latest message info (for admin)
export const getChatRooms = async (req: Request, res: Response): Promise<void> => {
  try {
    console.log('=== GET CHAT ROOMS REQUEST ===');
    console.log('User:', req.user);
    console.log('Fetching all chat rooms...');

    const currentUserId = req.user?.userId;

    const chatRooms = await prisma.chatRoom.findMany({
      include: {
        client: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatar: true,
              },
            },
          },
        },
        messages: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
          include: {
            sender: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        participants: {
          include: {
            user: {
              select: {
                id: true,
                isActive: true,
              },
            },
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    console.log(`Found ${chatRooms.length} chat rooms`);
    console.log('Chat rooms:', JSON.stringify(chatRooms, null, 2));

    // Transform to match frontend Contact interface
    const contacts = await Promise.all(
      chatRooms.map(async (room) => {
        const lastMessage = room.messages[0];
        const clientUser = room.client.user;

        // Find current user's participant record to get lastReadAt
        const userParticipant = room.participants.find(
          (p) => p.user.id === currentUserId
        );

        // Calculate unread count based on lastReadAt
        const unreadCount = currentUserId
          ? await calculateUnreadCount(
              room.id,
              currentUserId,
              userParticipant?.lastReadAt || null
            )
          : 0;

        return {
          id: room.id,
          name: clientUser.name || room.client.name,
          avatar: clientUser.avatar || '/default-avatar.png',
          lastMessage: lastMessage?.content || '',
          lastMessageDate: lastMessage?.createdAt.toISOString() || room.updatedAt.toISOString(),
          unreadCount,
          status: lastMessage?.status.toLowerCase() || 'none',
          isOnline: room.participants.some((p) => p.isOnline),
        };
      })
    );

    console.log(`Transformed ${contacts.length} contacts`);
    console.log('Contacts:', JSON.stringify(contacts, null, 2));

    res.json({
      success: true,
      data: contacts,
    });

    console.log('=== CHAT ROOMS RESPONSE SENT ===');
  } catch (error) {
    console.error('Error fetching chat rooms:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chat rooms',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Get messages for a specific chat room (with cursor-based pagination)
export const getChatMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { roomId } = req.params;
    const currentUserId = req.user?.userId;
    const currentUserRole = req.user?.role;
    
    // Pagination params: cursor (message ID), limit (default 50)
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    if (!currentUserId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    console.log(`=== GET MESSAGES REQUEST ===`);
    console.log(`Room ID: ${roomId}`);
    console.log(`User: ${currentUserId} (${currentUserRole})`);
    console.log(`Cursor: ${cursor}, Limit: ${limit}`);

    // Verify chat room exists
    const chatRoom = await prisma.chatRoom.findUnique({
      where: { id: roomId },
      include: {
        participants: true,
      },
    });

    if (!chatRoom) {
      console.log(`❌ Chat room not found: ${roomId}`);
      res.status(404).json({
        success: false,
        message: 'Chat room not found',
      });
      return;
    }

    // Check access: Admins can access any room, others must be participants
    const isAdmin = currentUserRole === 'ADMIN' || currentUserRole === 'SUPER_ADMIN';
    const isParticipant = chatRoom.participants.some(p => p.userId === currentUserId);

    if (!isAdmin && !isParticipant) {
      console.log(`❌ Access denied - User is not admin and not participant`);
      res.status(403).json({
        success: false,
        message: 'Access denied to this chat room',
      });
      return;
    }

    console.log(`✅ Access granted - Admin: ${isAdmin}, Participant: ${isParticipant}`);

    // Add admin as participant if they're not already (for future access)
    if (isAdmin && !isParticipant) {
      await prisma.chatParticipant.create({
        data: {
          chatRoomId: roomId,
          userId: currentUserId,
        },
      });
      console.log(`✅ Added admin as participant in room ${roomId}`);
    }

    // Build query for cursor-based pagination
    // Fetch messages older than cursor (for loading history)
    const whereClause: { chatRoomId: string; createdAt?: { lt: Date } } = {
      chatRoomId: roomId,
    };

    if (cursor) {
      // Get the cursor message's createdAt
      const cursorMessage = await prisma.chatMessage.findUnique({
        where: { id: cursor },
        select: { createdAt: true },
      });
      
      if (cursorMessage) {
        whereClause.createdAt = { lt: cursorMessage.createdAt };
      }
    }

    // Fetch messages (newest first when paginating backwards, then reverse for display)
    const messages = await prisma.chatMessage.findMany({
      where: whereClause,
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc', // Get newest messages first for pagination
      },
      take: limit + 1, // Fetch one extra to check if there are more
    });

    // Check if there are more messages
    const hasMore = messages.length > limit;
    const paginatedMessages = hasMore ? messages.slice(0, limit) : messages;
    
    // Reverse to get chronological order (oldest to newest)
    paginatedMessages.reverse();

    // Transform to match frontend ChatMessage interface
    const transformedMessages = paginatedMessages.map((msg) => ({
      id: msg.id,
      senderId: msg.senderId,
      senderName: msg.sender.name || 'Unknown',
      senderAvatar: msg.sender.avatar || '/default-avatar.png',
      content: msg.content,
      timestamp: msg.createdAt.toISOString(),
      isFromUser: msg.senderId === currentUserId,
      status: msg.status.toLowerCase(),
      attachmentUrl: msg.attachmentUrl,
      attachmentType: msg.attachmentType,
    }));

    // Update last read timestamp for the current user (only on initial load, not pagination)
    if (!cursor) {
      await prisma.chatParticipant.updateMany({
        where: {
          chatRoomId: roomId,
          userId: currentUserId,
        },
        data: {
          lastReadAt: new Date(),
        },
      });
    }

    // Get next cursor (oldest message ID in current batch)
    const nextCursor = hasMore && paginatedMessages.length > 0 
      ? paginatedMessages[0].id 
      : null;

    res.json({
      success: true,
      data: transformedMessages,
      pagination: {
        nextCursor,
        hasMore,
        limit,
      },
    });
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chat messages',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Send a message in a chat room
export const sendMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { roomId } = req.params;
    const { content, attachmentUrl, attachmentType } = req.body;
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

    console.log(`=== SEND MESSAGE REQUEST ===`);
    console.log(`Room ID: ${roomId}`);
    console.log(`User: ${currentUserId} (${currentUserRole})`);
    console.log(`Content: ${content.substring(0, 50)}...`);

    // Verify chat room exists
    const chatRoom = await prisma.chatRoom.findUnique({
      where: { id: roomId },
      include: {
        participants: true,
      },
    });

    if (!chatRoom) {
      console.log(`❌ Chat room not found: ${roomId}`);
      res.status(404).json({
        success: false,
        message: 'Chat room not found',
      });
      return;
    }

    // Check access: Admins can access any room, others must be participants
    const isAdmin = currentUserRole === 'ADMIN' || currentUserRole === 'SUPER_ADMIN';
    const isParticipant = chatRoom.participants.some(p => p.userId === currentUserId);

    if (!isAdmin && !isParticipant) {
      console.log(`❌ Access denied - User is not admin and not participant`);
      res.status(403).json({
        success: false,
        message: 'Access denied to this chat room',
      });
      return;
    }

    console.log(`✅ Access granted - Admin: ${isAdmin}, Participant: ${isParticipant}`);

    // Add admin as participant if they're not already
    if (isAdmin && !isParticipant) {
      await prisma.chatParticipant.create({
        data: {
          chatRoomId: roomId,
          userId: currentUserId,
        },
      });
      console.log(`✅ Added admin as participant in room ${roomId}`);
    }

    // Create the message
    const message = await prisma.chatMessage.create({
      data: {
        content: content.trim(),
        chatRoomId: roomId,
        senderId: currentUserId,
        attachmentUrl,
        attachmentType,
        status: 'SENT',
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
      },
    });

    // Update the chat room's updatedAt timestamp
    await prisma.chatRoom.update({
      where: { id: roomId },
      data: { updatedAt: new Date() },
    });

    // Transform to match frontend ChatMessage interface
    const transformedMessage = {
      id: message.id,
      senderId: message.senderId,
      senderName: message.sender.name || 'Unknown',
      senderAvatar: message.sender.avatar || '/default-avatar.png',
      content: message.content,
      timestamp: message.createdAt.toISOString(),
      isFromUser: true,
      status: message.status.toLowerCase(),
      attachmentUrl: message.attachmentUrl,
      attachmentType: message.attachmentType,
    };

    // Emit real-time event to chat room participants
    try {
      emitToRoom(roomId, 'chat:newMessage', transformedMessage);
    } catch (socketError) {
      console.error('Error emitting socket event:', socketError);
      // Don't fail the request if socket emit fails
    }

    res.status(201).json({
      success: true,
      data: transformedMessage,
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Get or create the current user's own chat room (for CLIENT/EMPLOYEE users)
export const getMyRoomInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const userRole = req.user?.role;

    if (!currentUserId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    // Find the client record for this user
    const client = await prisma.client.findUnique({
      where: { userId: currentUserId },
    });

    if (!client) {
      res.status(404).json({
        success: false,
        message: 'Client not found',
      });
      return;
    }

    // Check if chat room already exists for this client
    let chatRoom = await prisma.chatRoom.findUnique({
      where: { clientId: client.id },
    });

    // If no chat room exists, create one
    if (!chatRoom) {
      chatRoom = await prisma.chatRoom.create({
        data: {
          clientId: client.id,
          participants: {
            create: [
              {
                userId: currentUserId, // Client user
              },
            ],
          },
        },
      });
    } else {
      // Ensure current user is a participant
      const participant = await prisma.chatParticipant.findFirst({
        where: {
          chatRoomId: chatRoom.id,
          userId: currentUserId,
        },
      });

      if (!participant) {
        await prisma.chatParticipant.create({
          data: {
            chatRoomId: chatRoom.id,
            userId: currentUserId,
          },
        });
      }
    }

    res.json({
      success: true,
      data: {
        roomId: chatRoom.id,
        clientId: client.id,
      },
    });
  } catch (error) {
    console.error('Error getting/creating my chat room:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get or create chat room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Get recent messages across all chat rooms (for admin dashboard)
export const getRecentMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const currentUserRole = req.user?.role;
    const { limit = 5 } = req.query;

    if (!currentUserId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    const messageLimit = Math.min(parseInt(limit as string) || 5, 20);

    // Build query based on user role
    let messages;
    const isAdmin = currentUserRole === 'ADMIN' || currentUserRole === 'SUPER_ADMIN';

    if (isAdmin) {
      // Admins can see all messages from all chat rooms
      messages = await prisma.chatMessage.findMany({
        take: messageLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              avatar: true,
              role: true,
            },
          },
          chatRoom: {
            include: {
              client: {
                select: {
                  id: true,
                  name: true,
                  companyName: true,
                },
              },
            },
          },
        },
      });
    } else if (currentUserRole === 'CLIENT') {
      // Clients can only see messages from their own chat room
      const clientId = req.user?.clientId;
      if (!clientId) {
        res.status(403).json({
          success: false,
          message: 'Client ID not found',
        });
        return;
      }

      messages = await prisma.chatMessage.findMany({
        where: {
          chatRoom: {
            clientId: clientId,
          },
        },
        take: messageLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              avatar: true,
              role: true,
            },
          },
          chatRoom: {
            include: {
              client: {
                select: {
                  id: true,
                  name: true,
                  companyName: true,
                },
              },
            },
          },
        },
      });
    } else {
      // Employees can only see messages from chat rooms where they are a participant
      messages = await prisma.chatMessage.findMany({
        where: {
          chatRoom: {
            participants: {
              some: {
                userId: currentUserId,
              },
            },
          },
        },
        take: messageLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              avatar: true,
              role: true,
            },
          },
          chatRoom: {
            include: {
              client: {
                select: {
                  id: true,
                  name: true,
                  companyName: true,
                },
              },
            },
          },
        },
      });
    }

    // Transform to match frontend QuickChat interface
    const transformedMessages = messages.map((msg) => {
      // Calculate relative time
      const now = new Date();
      const msgDate = new Date(msg.createdAt);
      const diffMs = now.getTime() - msgDate.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      let timestamp: string;
      if (diffMins < 1) {
        timestamp = 'just now';
      } else if (diffMins < 60) {
        timestamp = `${diffMins}m ago`;
      } else if (diffHours < 24) {
        timestamp = `${diffHours}h ago`;
      } else {
        timestamp = `${diffDays}d ago`;
      }

      // Determine sender type and name
      const isEmployee = msg.sender.role === 'ADMIN' || msg.sender.role === 'SUPER_ADMIN' || msg.sender.role === 'EMPLOYEE';
      const senderLabel = isEmployee ? 'Fulfillment employee' : 'Fulfillment client';

      return {
        id: msg.id,
        roomId: msg.chatRoomId,
        sender: msg.sender.name || senderLabel,
        senderRole: msg.sender.role,
        avatar: msg.sender.avatar,
        avatarColor: isEmployee ? '#E5E7EB' : '#DBEAFE',
        timestamp,
        content: msg.content,
        clientName: msg.chatRoom.client?.companyName || msg.chatRoom.client?.name || 'Unknown',
        tasks: [], // Tasks would come from a separate system if implemented
      };
    });

    res.json({
      success: true,
      data: transformedMessages,
    });
  } catch (error) {
    console.error('Error fetching recent messages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent messages',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Get or create chat room for a client
export const getOrCreateChatRoom = async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = req.user?.userId;
    const { clientId } = req.params;

    if (!currentUserId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized',
      });
      return;
    }

    // Check if chat room already exists for this client
    let chatRoom = await prisma.chatRoom.findUnique({
      where: { clientId },
      include: {
        client: {
          include: {
            user: true,
          },
        },
        participants: true,
      },
    });

    // If no chat room exists, create one
    if (!chatRoom) {
      chatRoom = await prisma.chatRoom.create({
        data: {
          clientId,
          participants: {
            create: [
              {
                userId: currentUserId, // Admin user
              },
            ],
          },
        },
        include: {
          client: {
            include: {
              user: true,
            },
          },
          participants: true,
        },
      });

      // Add the client user as a participant
      await prisma.chatParticipant.create({
        data: {
          chatRoomId: chatRoom.id,
          userId: chatRoom.client.userId,
        },
      });
    } else {
      // Ensure current user is a participant
      const isParticipant = chatRoom.participants.some(
        (p) => p.userId === currentUserId
      );

      if (!isParticipant) {
        await prisma.chatParticipant.create({
          data: {
            chatRoomId: chatRoom.id,
            userId: currentUserId,
          },
        });
      }
    }

    res.json({
      success: true,
      data: {
        id: chatRoom.id,
        clientId: chatRoom.clientId,
      },
    });
  } catch (error) {
    console.error('Error getting/creating chat room:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get or create chat room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
