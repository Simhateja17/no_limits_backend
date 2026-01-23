/**
 * Shipping Methods Controller
 * 
 * Handles shipping method management, JTL FFN synchronization,
 * and shipping method mappings for channels.
 */

import { Request, Response } from 'express';
import { ChannelType } from '@prisma/client';
import { prisma } from '../config/database.js';
import ShippingMethodService from '../services/shipping-method.service.js';
import { JTLService } from '../services/integrations/jtl.service.js';
import { getEncryptionService } from '../services/encryption.service.js';
const shippingMethodService = new ShippingMethodService(prisma);
const encryptionService = getEncryptionService();

// ============= SHIPPING METHODS =============

/**
 * Get all shipping methods
 */
export async function getShippingMethods(req: Request, res: Response) {
  try {
    const { activeOnly } = req.query;
    
    const shippingMethods = activeOnly === 'true'
      ? await shippingMethodService.getActiveShippingMethods()
      : await shippingMethodService.getAllShippingMethods();
    
    res.json({
      success: true,
      data: shippingMethods,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error getting shipping methods:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get shipping methods',
    });
  }
}

/**
 * Get a single shipping method by ID
 */
export async function getShippingMethod(req: Request, res: Response) {
  try {
    const { id } = req.params;
    
    const shippingMethod = await prisma.shippingMethod.findUnique({
      where: { id },
      include: { mappings: true },
    });
    
    if (!shippingMethod) {
      return res.status(404).json({
        success: false,
        error: 'Shipping method not found',
      });
    }
    
    res.json({
      success: true,
      data: shippingMethod,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error getting shipping method:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get shipping method',
    });
  }
}

/**
 * Create a new shipping method
 */
export async function createShippingMethod(req: Request, res: Response) {
  try {
    const {
      code,
      name,
      carrier,
      jtlShippingMethodId,
      jtlFulfillerId,
      jtlShippingType,
      basePrice,
      pricePerKg,
      logoUrl,
      isDefault,
    } = req.body;
    
    if (!code || !name || !carrier) {
      return res.status(400).json({
        success: false,
        error: 'Code, name, and carrier are required',
      });
    }
    
    const shippingMethod = await shippingMethodService.createShippingMethod({
      code,
      name,
      carrier,
      jtlShippingMethodId,
      jtlFulfillerId,
      jtlShippingType,
      basePrice,
      pricePerKg,
      logoUrl,
      isDefault,
    });
    
    res.status(201).json({
      success: true,
      data: shippingMethod,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error creating shipping method:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create shipping method',
    });
  }
}

/**
 * Update a shipping method
 */
export async function updateShippingMethod(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, carrier, isActive, isDefault, basePrice, pricePerKg, logoUrl } = req.body;
    
    const shippingMethod = await shippingMethodService.updateShippingMethod(id, {
      name,
      carrier,
      isActive,
      isDefault,
      basePrice,
      pricePerKg,
      logoUrl,
    });
    
    res.json({
      success: true,
      data: shippingMethod,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error updating shipping method:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update shipping method',
    });
  }
}

/**
 * Delete a shipping method
 */
export async function deleteShippingMethod(req: Request, res: Response) {
  try {
    const { id } = req.params;
    
    // Check if shipping method is in use
    const mappingsCount = await prisma.shippingMethodMapping.count({
      where: { shippingMethodId: id },
    });
    
    if (mappingsCount > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete shipping method - it has ${mappingsCount} active mappings`,
      });
    }
    
    await prisma.shippingMethod.delete({
      where: { id },
    });
    
    res.json({
      success: true,
      message: 'Shipping method deleted successfully',
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error deleting shipping method:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete shipping method',
    });
  }
}

// ============= JTL FFN SYNC =============

/**
 * Sync shipping methods from JTL FFN
 */
export async function syncFromJTL(req: Request, res: Response) {
  try {
    const { clientId } = req.params;
    
    // Get JTL config for the client
    const jtlConfig = await prisma.jtlConfig.findFirst({
      where: { clientId_fk: clientId },
    });
    
    if (!jtlConfig) {
      return res.status(404).json({
        success: false,
        error: 'JTL configuration not found for this client',
      });
    }
    
    // Initialize JTL service
    const jtlService = new JTLService({
      clientId: jtlConfig.clientId,
      clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
      accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
      refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
      tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
      fulfillerId: jtlConfig.fulfillerId,
      warehouseId: jtlConfig.warehouseId,
      environment: jtlConfig.environment as 'sandbox' | 'production',
    });
    
    // Sync shipping methods
    const result = await shippingMethodService.syncShippingMethodsFromJTL(jtlService);
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error,
      });
    }
    
    res.json({
      success: true,
      message: `Synced ${result.synced} shipping methods from JTL FFN`,
      synced: result.synced,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error syncing from JTL:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync shipping methods from JTL',
    });
  }
}

/**
 * Get shipping methods directly from JTL FFN (without saving)
 */
export async function getJTLShippingMethods(req: Request, res: Response) {
  try {
    const { clientId } = req.params;
    
    // Get JTL config for the client
    const jtlConfig = await prisma.jtlConfig.findFirst({
      where: { clientId_fk: clientId },
    });
    
    if (!jtlConfig) {
      return res.status(404).json({
        success: false,
        error: 'JTL configuration not found for this client',
      });
    }
    
    // Initialize JTL service
    const jtlService = new JTLService({
      clientId: jtlConfig.clientId,
      clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
      accessToken: jtlConfig.accessToken ? encryptionService.decrypt(jtlConfig.accessToken) : undefined,
      refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
      tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
      fulfillerId: jtlConfig.fulfillerId,
      warehouseId: jtlConfig.warehouseId,
      environment: jtlConfig.environment as 'sandbox' | 'production',
    });
    
    // Fetch shipping methods
    const result = await jtlService.getShippingMethods();
    
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error,
      });
    }
    
    res.json({
      success: true,
      data: result.data,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error fetching JTL shipping methods:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch JTL shipping methods',
    });
  }
}

// ============= SHIPPING METHOD MAPPINGS =============

/**
 * Get mappings for a client
 */
export async function getClientMappings(req: Request, res: Response) {
  try {
    const { clientId } = req.params;
    
    const mappings = await shippingMethodService.getClientMappings(clientId);
    
    res.json({
      success: true,
      data: mappings,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error getting client mappings:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get client mappings',
    });
  }
}

/**
 * Get mappings for a channel
 */
export async function getChannelMappings(req: Request, res: Response) {
  try {
    const { channelId } = req.params;
    
    const mappings = await shippingMethodService.getChannelMappings(channelId);
    
    res.json({
      success: true,
      data: mappings,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error getting channel mappings:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get channel mappings',
    });
  }
}

/**
 * Create or update a shipping method mapping
 */
export async function upsertMapping(req: Request, res: Response) {
  try {
    const {
      channelShippingCode,
      channelShippingTitle,
      channelType,
      shippingMethodId,
      clientId,
      channelId,
    } = req.body;
    
    if (!channelShippingCode || !channelShippingTitle || !channelType || !shippingMethodId) {
      return res.status(400).json({
        success: false,
        error: 'channelShippingCode, channelShippingTitle, channelType, and shippingMethodId are required',
      });
    }
    
    // Validate channel type
    if (!['SHOPIFY', 'WOOCOMMERCE'].includes(channelType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid channel type. Must be SHOPIFY or WOOCOMMERCE',
      });
    }
    
    const mapping = await shippingMethodService.upsertMapping({
      channelShippingCode,
      channelShippingTitle,
      channelType: channelType as ChannelType,
      shippingMethodId,
      clientId,
      channelId,
    });
    
    res.json({
      success: true,
      data: mapping,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error creating mapping:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create mapping',
    });
  }
}

/**
 * Delete a shipping method mapping
 */
export async function deleteMapping(req: Request, res: Response) {
  try {
    const { mappingId } = req.params;
    
    await shippingMethodService.deleteMapping(mappingId);
    
    res.json({
      success: true,
      message: 'Mapping deleted successfully',
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error deleting mapping:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete mapping',
    });
  }
}

// ============= CLIENT DEFAULT SHIPPING METHOD =============

/**
 * Set default shipping method for a client
 */
export async function setClientDefault(req: Request, res: Response) {
  try {
    const { clientId } = req.params;
    const { shippingMethodId } = req.body;
    
    if (!shippingMethodId) {
      return res.status(400).json({
        success: false,
        error: 'shippingMethodId is required',
      });
    }
    
    // Verify shipping method exists
    const shippingMethod = await prisma.shippingMethod.findUnique({
      where: { id: shippingMethodId },
    });
    
    if (!shippingMethod) {
      return res.status(404).json({
        success: false,
        error: 'Shipping method not found',
      });
    }
    
    const updatedClient = await shippingMethodService.setClientDefaultShippingMethod(
      clientId,
      shippingMethodId
    );
    
    res.json({
      success: true,
      data: {
        clientId: updatedClient.id,
        defaultShippingMethodId: updatedClient.defaultShippingMethodId,
        shippingMethodName: shippingMethod.name,
      },
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error setting client default:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to set client default shipping method',
    });
  }
}

/**
 * Get client's default shipping method
 */
export async function getClientDefault(req: Request, res: Response) {
  try {
    const { clientId } = req.params;
    
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      include: { defaultShippingMethod: true },
    });
    
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found',
      });
    }
    
    res.json({
      success: true,
      data: client.defaultShippingMethod,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error getting client default:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get client default shipping method',
    });
  }
}

// ============= SHIPPING METHOD MISMATCHES =============

/**
 * Get unresolved shipping method mismatches
 */
export async function getUnresolvedMismatches(req: Request, res: Response) {
  try {
    const { clientId } = req.query;
    
    const mismatches = await shippingMethodService.getUnresolvedMismatches(
      clientId as string | undefined
    );
    
    res.json({
      success: true,
      data: mismatches,
      count: mismatches.length,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error getting mismatches:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get mismatches',
    });
  }
}

/**
 * Resolve a shipping method mismatch
 */
export async function resolveMismatch(req: Request, res: Response) {
  try {
    const { mismatchId } = req.params;
    const { resolvedBy, resolutionNote, shippingMethodId } = req.body;
    
    if (!resolvedBy) {
      return res.status(400).json({
        success: false,
        error: 'resolvedBy is required',
      });
    }
    
    const mismatch = await shippingMethodService.resolveMismatch(
      mismatchId,
      resolvedBy,
      resolutionNote,
      shippingMethodId
    );
    
    // If a shipping method was selected, release the order from hold
    if (shippingMethodId) {
      const mismatchRecord = await prisma.shippingMethodMismatch.findUnique({
        where: { id: mismatchId },
        include: { order: true },
      });
      
      if (mismatchRecord?.order.isOnHold) {
        await prisma.order.update({
          where: { id: mismatchRecord.orderId },
          data: {
            isOnHold: false,
            shippingMethodMismatch: false,
            jtlShippingMethodId: await getJtlShippingMethodId(shippingMethodId),
          },
        });
      }
    }
    
    res.json({
      success: true,
      data: mismatch,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error resolving mismatch:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to resolve mismatch',
    });
  }
}

// Helper to get JTL shipping method ID
async function getJtlShippingMethodId(shippingMethodId: string): Promise<string | undefined> {
  const method = await prisma.shippingMethod.findUnique({
    where: { id: shippingMethodId },
    select: { jtlShippingMethodId: true },
  });
  return method?.jtlShippingMethodId || undefined;
}

/**
 * Sync shipping methods from JTL FFN for the authenticated client
 */
export async function syncMyShippingMethods(req: Request, res: Response) {
  try {
    console.log('[ShippingMethodsController] syncMyShippingMethods called');
    const user = (req as any).user;

    if (!user?.userId) {
      console.log('[ShippingMethodsController] No user found in request');
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
    }

    console.log('[ShippingMethodsController] User ID:', user.userId);

    // Fetch the user with their client association
    const dbUser = await prisma.user.findUnique({
      where: { id: user.userId },
      include: { client: true },
    });

    if (!dbUser?.client?.id) {
      console.log('[ShippingMethodsController] No client associated with user');
      return res.status(400).json({
        success: false,
        error: 'No client associated with this user',
      });
    }

    const clientId = dbUser.client.id;
    console.log('[ShippingMethodsController] Client ID:', clientId);

    // Get JTL config for the client
    const jtlConfig = await prisma.jtlConfig.findFirst({
      where: { clientId_fk: clientId },
    });

    if (!jtlConfig) {
      console.log('[ShippingMethodsController] No JTL config found for client:', clientId);
      return res.status(404).json({
        success: false,
        error: 'JTL configuration not found. Please connect your JTL FFN account first.',
      });
    }

    console.log('[ShippingMethodsController] JTL Config found:');
    console.log('[ShippingMethodsController]   - Environment:', jtlConfig.environment);
    console.log('[ShippingMethodsController]   - FulfillerId:', jtlConfig.fulfillerId);
    console.log('[ShippingMethodsController]   - WarehouseId:', jtlConfig.warehouseId);
    console.log('[ShippingMethodsController]   - Has access token:', !!jtlConfig.accessToken);
    console.log('[ShippingMethodsController]   - Token expires:', jtlConfig.tokenExpiresAt);

    if (!jtlConfig.accessToken) {
      console.log('[ShippingMethodsController] No access token in JTL config');
      return res.status(400).json({
        success: false,
        error: 'JTL OAuth not completed. Please authorize with JTL FFN first.',
      });
    }

    // Initialize JTL service
    console.log('[ShippingMethodsController] Initializing JTL service...');
    const jtlService = new JTLService({
      clientId: jtlConfig.clientId,
      clientSecret: encryptionService.decrypt(jtlConfig.clientSecret),
      accessToken: encryptionService.decrypt(jtlConfig.accessToken),
      refreshToken: jtlConfig.refreshToken ? encryptionService.decrypt(jtlConfig.refreshToken) : undefined,
      tokenExpiresAt: jtlConfig.tokenExpiresAt || undefined,
      fulfillerId: jtlConfig.fulfillerId,
      warehouseId: jtlConfig.warehouseId,
      environment: jtlConfig.environment as 'sandbox' | 'production',
    });

    // Sync shipping methods
    console.log('[ShippingMethodsController] Calling syncShippingMethodsFromJTL with fulfillerId:', jtlConfig.fulfillerId);
    const result = await shippingMethodService.syncShippingMethodsFromJTL(
      jtlService,
      jtlConfig.fulfillerId
    );

    console.log('[ShippingMethodsController] Sync result:', JSON.stringify(result));

    if (!result.success) {
      console.log('[ShippingMethodsController] Sync failed:', result.error);
      return res.status(500).json({
        success: false,
        error: result.error,
      });
    }

    // Return the synced methods
    const shippingMethods = await shippingMethodService.getActiveShippingMethods();
    console.log('[ShippingMethodsController] Active shipping methods after sync:', shippingMethods.length);

    res.json({
      success: true,
      message: `Synced ${result.synced} shipping methods from JTL FFN`,
      synced: result.synced,
      shippingMethods,
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error syncing shipping methods:', error);
    console.error('[ShippingMethodsController] Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync shipping methods',
    });
  }
}

/**
 * Get a channel's default shipping method
 */
export async function getChannelDefault(req: Request, res: Response) {
  try {
    const { channelId } = req.params;
    
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        name: true,
        defaultShippingMethod: true,
      },
    });
    
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found',
      });
    }
    
    // Get the full shipping method details if one is set
    let shippingMethod = null;
    if (channel.defaultShippingMethod) {
      shippingMethod = await prisma.shippingMethod.findFirst({
        where: { jtlShippingMethodId: channel.defaultShippingMethod },
      });
    }
    
    res.json({
      success: true,
      data: {
        channelId: channel.id,
        channelName: channel.name,
        defaultShippingMethodId: channel.defaultShippingMethod,
        shippingMethod,
      },
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error getting channel default:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get channel default shipping method',
    });
  }
}

/**
 * Set a channel's default shipping method
 */
export async function setChannelDefault(req: Request, res: Response) {
  try {
    const { channelId } = req.params;
    const { shippingMethodId } = req.body; // This is the JTL shipping method ID
    
    if (!shippingMethodId) {
      return res.status(400).json({
        success: false,
        error: 'shippingMethodId is required',
      });
    }
    
    // Verify the shipping method exists
    const shippingMethod = await prisma.shippingMethod.findFirst({
      where: { jtlShippingMethodId: shippingMethodId },
    });
    
    if (!shippingMethod) {
      return res.status(404).json({
        success: false,
        error: 'Shipping method not found',
      });
    }
    
    // Update the channel
    const channel = await prisma.channel.update({
      where: { id: channelId },
      data: {
        defaultShippingMethod: shippingMethodId,
      },
    });
    
    res.json({
      success: true,
      data: {
        channelId: channel.id,
        channelName: channel.name,
        defaultShippingMethodId: channel.defaultShippingMethod,
        shippingMethod,
      },
    });
  } catch (error: any) {
    console.error('[ShippingMethodsController] Error setting channel default:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to set channel default shipping method',
    });
  }
}

export default {
  getShippingMethods,
  getShippingMethod,
  createShippingMethod,
  updateShippingMethod,
  deleteShippingMethod,
  syncFromJTL,
  syncMyShippingMethods,
  getJTLShippingMethods,
  getClientMappings,
  getChannelMappings,
  upsertMapping,
  deleteMapping,
  setClientDefault,
  getClientDefault,
  setChannelDefault,
  getChannelDefault,
  getUnresolvedMismatches,
  resolveMismatch,
};
