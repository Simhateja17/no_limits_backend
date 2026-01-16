import { Request, Response } from 'express';
import { prisma } from '../config/database.js';

// Get all quotations for current client or all (for admin)
export const getQuotations = async (req: Request, res: Response): Promise<void> => {
  try {
    const userRole = req.user?.role;
    const userId = req.user?.userId;

    let quotations;

    if (userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') {
      // Admin can see all quotations
      quotations = await prisma.quotation.findMany({
        include: {
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              companyName: true,
            },
          },
          items: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
    } else {
      // Client can only see their own quotations
      const client = await prisma.client.findUnique({
        where: { userId },
      });

      if (!client) {
        res.status(404).json({
          success: false,
          error: 'Client not found',
        });
        return;
      }

      quotations = await prisma.quotation.findMany({
        where: {
          clientId_fk: client.id,
        },
        include: {
          items: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
    }

    res.json({
      success: true,
      data: quotations,
    });
  } catch (error) {
    console.error('Error fetching quotations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch quotations',
    });
  }
};

// Get quotation by ID
export const getQuotationById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const userId = req.user?.userId;

    const quotation = await prisma.quotation.findUnique({
      where: { id },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            companyName: true,
            phone: true,
            address: true,
            city: true,
            zipCode: true,
            country: true,
          },
        },
        items: true,
      },
    });

    if (!quotation) {
      res.status(404).json({
        success: false,
        error: 'Quotation not found',
      });
      return;
    }

    // Check access: Admin can see all, client can only see their own
    if (userRole !== 'ADMIN' && userRole !== 'SUPER_ADMIN') {
      const client = await prisma.client.findUnique({
        where: { userId },
      });

      if (!client || quotation.clientId_fk !== client.id) {
        res.status(403).json({
          success: false,
          error: 'Access denied',
        });
        return;
      }
    }

    res.json({
      success: true,
      data: quotation,
    });
  } catch (error) {
    console.error('Error fetching quotation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch quotation',
    });
  }
};

// Create new quotation (admin only)
export const createQuotation = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      clientId,
      quotationNumber,
      validUntil,
      items,
      subtotal,
      tax,
      total,
      notes,
      termsAndConditions,
      status = 'PENDING',
    } = req.body;

    // Validation
    if (!clientId || !quotationNumber || !items || items.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Client ID, quotation number, and items are required',
      });
      return;
    }

    // Check if quotation number already exists
    const existing = await prisma.quotation.findUnique({
      where: { quotationNumber },
    });

    if (existing) {
      res.status(400).json({
        success: false,
        error: 'Quotation number already exists',
      });
      return;
    }

    // Create quotation with items
    const quotation = await prisma.quotation.create({
      data: {
        clientId_fk: clientId,
        quotationNumber,
        validUntil: validUntil ? new Date(validUntil) : null,
        subtotal,
        tax,
        total,
        notes,
        termsAndConditions,
        status,
        items: {
          create: items.map((item: any) => ({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: item.total,
          })),
        },
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            companyName: true,
          },
        },
        items: true,
      },
    });

    res.status(201).json({
      success: true,
      data: quotation,
      message: 'Quotation created successfully',
    });
  } catch (error) {
    console.error('Error creating quotation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create quotation',
    });
  }
};

// Update quotation (admin only)
export const updateQuotation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Don't allow updating these fields directly
    delete updateData.id;
    delete updateData.clientId_fk;
    delete updateData.items; // Items should be updated separately

    const quotation = await prisma.quotation.update({
      where: { id },
      data: updateData,
      include: {
        client: {
          select: {
            id: true,
            name: true,
            email: true,
            companyName: true,
          },
        },
        items: true,
      },
    });

    res.json({
      success: true,
      data: quotation,
      message: 'Quotation updated successfully',
    });
  } catch (error) {
    console.error('Error updating quotation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update quotation',
    });
  }
};

// Update quotation status (accept/reject for client)
export const updateQuotationStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.user?.userId;

    if (!status || !['ACCEPTED', 'REJECTED'].includes(status)) {
      res.status(400).json({
        success: false,
        error: 'Valid status is required (ACCEPTED or REJECTED)',
      });
      return;
    }

    const quotation = await prisma.quotation.findUnique({
      where: { id },
      include: { client: true },
    });

    if (!quotation) {
      res.status(404).json({
        success: false,
        error: 'Quotation not found',
      });
      return;
    }

    // Check if user is the client owner
    if (quotation.client.userId !== userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
      });
      return;
    }

    const updated = await prisma.quotation.update({
      where: { id },
      data: {
        status,
        ...(status === 'ACCEPTED' ? { acceptedAt: new Date() } : {}),
        ...(status === 'REJECTED' ? { rejectedAt: new Date() } : {}),
      },
      include: {
        items: true,
      },
    });

    res.json({
      success: true,
      data: updated,
      message: `Quotation ${status.toLowerCase()} successfully`,
    });
  } catch (error) {
    console.error('Error updating quotation status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update quotation status',
    });
  }
};

// Delete quotation (admin only)
export const deleteQuotation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    await prisma.quotation.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: 'Quotation deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting quotation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete quotation',
    });
  }
};
