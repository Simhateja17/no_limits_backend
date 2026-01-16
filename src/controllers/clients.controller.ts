import { Request, Response } from 'express';
import { prisma } from '../config/database.js';
import bcrypt from 'bcryptjs';

// Get all clients (for ADMIN/SUPER_ADMIN)
export const getClients = async (req: Request, res: Response): Promise<void> => {
  try {
    // Fetch clients with their associated user data and order statistics
    const clients = await prisma.client.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            lastLoginAt: true,
          },
        },
        _count: {
          select: {
            orders: true,
          },
        },
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            createdAt: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Transform the data to match frontend expectations
    const transformedClients = clients.map((client, index) => ({
      id: client.id,
      clientId: index + 1, // Sequential client ID for display
      name: client.user.name || client.name,
      email: client.email,
      company: client.companyName,
      phone: client.phone || '',
      address: client.address ? `${client.address}, ${client.zipCode || ''} ${client.city || ''}`.trim() : '',
      totalOrders: client._count.orders,
      totalValue: client.totalValue ? `€${parseFloat(client.totalValue.toString()).toFixed(2)}` : '€0.00',
      lastOrder: client.orders[0]?.createdAt || null,
      lastBillingPeriod: client.lastBillingPeriod || '',
      status: client.isActive ? 'active' : 'inactive',
      billingStatus: client.billingStatus?.toLowerCase() || 'pending',
      systemLogin: 'Login',
      emailAction: 'Mailservice',
      userId: client.userId,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    }));

    res.json({
      success: true,
      data: transformedClients,
      total: transformedClients.length,
    });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch clients',
    });
  }
};

// Get client by ID
export const getClientById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const client = await prisma.client.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            lastLoginAt: true,
          },
        },
        orders: {
          take: 10,
          orderBy: { createdAt: 'desc' },
        },
        channels: true,
        _count: {
          select: {
            orders: true,
            products: true,
            returns: true,
          },
        },
      },
    });

    if (!client) {
      res.status(404).json({
        success: false,
        error: 'Client not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        ...client,
        totalOrders: client._count.orders,
        totalProducts: client._count.products,
        totalReturns: client._count.returns,
      },
    });
  } catch (error) {
    console.error('Error fetching client:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch client',
    });
  }
};

// Get client statistics
export const getClientStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [totalClients, activeClients, inactiveClients, totalOrders] = await Promise.all([
      prisma.client.count(),
      prisma.client.count({ where: { isActive: true } }),
      prisma.client.count({ where: { isActive: false } }),
      prisma.order.count(),
    ]);

    // For quotations, we can either:
    // 1. Create a Quotation model if it doesn't exist
    // 2. Count orders with a specific status
    // For now, count orders on hold as a proxy for pending quotations
    const pendingQuotations = await prisma.order.count({
      where: {
        isOnHold: true,
      },
    });

    res.json({
      success: true,
      data: {
        total: totalClients,
        active: activeClients,
        inactive: inactiveClients,
        quotations: pendingQuotations,
        totalOrders,
      },
    });
  } catch (error) {
    console.error('Error fetching client stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch client statistics',
    });
  }
};

// Create a new client (for ADMIN/SUPER_ADMIN)
export const createClient = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      name,
      email,
      password,
      companyName,
      phone,
      address,
      city,
      zipCode,
      country,
      isActive = true,
    } = req.body;

    // Validation
    if (!name || !email || !password) {
      res.status(400).json({
        success: false,
        error: 'Name, email, and password are required',
      });
      return;
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      res.status(400).json({
        success: false,
        error: 'Email already exists',
      });
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user and client in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create user account
      const user = await tx.user.create({
        data: {
          email,
          name,
          password: hashedPassword,
          role: 'CLIENT',
          isActive,
        },
      });

      // Create client profile
      const client = await tx.client.create({
        data: {
          userId: user.id,
          name,
          email,
          companyName: companyName || name,
          phone,
          address,
          city,
          zipCode,
          country,
          isActive,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              isActive: true,
            },
          },
        },
      });

      return { user, client };
    });

    res.status(201).json({
      success: true,
      data: result.client,
      message: 'Client created successfully',
    });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create client',
    });
  }
};

// Update client (for ADMIN/SUPER_ADMIN)
export const updateClient = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Don't allow updating userId or id
    delete updateData.userId;
    delete updateData.id;

    const client = await prisma.client.update({
      where: { id },
      data: updateData,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
          },
        },
      },
    });

    res.json({
      success: true,
      data: client,
      message: 'Client updated successfully',
    });
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update client',
    });
  }
};

// Delete client (for ADMIN/SUPER_ADMIN)
export const deleteClient = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    await prisma.client.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: 'Client deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting client:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete client',
    });
  }
};
