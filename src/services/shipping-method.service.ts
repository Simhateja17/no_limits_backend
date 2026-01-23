/**
 * Shipping Method Service
 * 
 * Handles shipping method management, JTL FFN synchronization, and shipping method resolution for orders.
 * 
 * KEY CONCEPTS:
 * 1. JTL FFN has unique shipping method IDs (e.g., "FULF0A0001") that must be used in outbound creation
 * 2. Shopify/WooCommerce orders have their own shipping method codes/titles
 * 3. We need to MAP channel shipping methods TO JTL FFN shipping methods
 * 4. If no mapping exists, use the client's default shipping method as fallback
 * 5. If no fallback exists, PUT THE ORDER ON HOLD and create a notification
 */

import { PrismaClient, ChannelType } from '@prisma/client';
import { JTLService } from './integrations/jtl.service.js';

interface JTLShippingMethod {
  shippingMethodId: string;
  fulfillerId: string;
  name: string;
  carrierCode?: string;
  carrierName?: string;
  shippingType: 'Standard' | 'Expedited' | 'NextDay' | 'SecondDay' | 'SameDay' | 'ByShippingLabelProvider';
  trackingUrlSchema?: string;
  cutoffTime?: string;
  note?: string;
}

interface ShippingMethodResolution {
  success: boolean;
  jtlShippingMethodId?: string;
  shippingMethodName?: string;
  usedFallback: boolean;
  mismatch: boolean;
  mismatchReason?: string;
  shouldHoldOrder: boolean;
}

interface ChannelShippingInfo {
  code?: string;
  title?: string;
}

export class ShippingMethodService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Sync shipping methods from JTL FFN
   * Fetches all available shipping methods from the merchant's JTL FFN account
   */
  async syncShippingMethodsFromJTL(jtlService: JTLService, fulfillerId?: string): Promise<{
    success: boolean;
    synced: number;
    error?: string;
  }> {
    try {
      console.log('[ShippingMethodService] Starting sync from JTL FFN');
      console.log('[ShippingMethodService] FulfillerId filter:', fulfillerId || 'NONE (fetching all)');

      // Fetch shipping methods from JTL FFN
      // If fulfillerId is provided, filter by that fulfiller
      const response = await jtlService.getShippingMethods(
        fulfillerId ? { fulfillerId } : {}
      );

      console.log('[ShippingMethodService] JTL API response success:', response.success);
      console.log('[ShippingMethodService] JTL API response error:', response.error || 'none');
      console.log('[ShippingMethodService] JTL API data count:', response.data?.length || 0);

      // If no methods found with fulfillerId filter, try without filter
      if (response.success && (!response.data || response.data.length === 0) && fulfillerId) {
        console.log('[ShippingMethodService] No methods found with fulfillerId filter, trying without filter...');
        const allMethodsResponse = await jtlService.getShippingMethods({});
        console.log('[ShippingMethodService] All methods (without filter) count:', allMethodsResponse.data?.length || 0);
        if (allMethodsResponse.data && allMethodsResponse.data.length > 0) {
          console.log('[ShippingMethodService] Available fulfillerIds in all methods:',
            [...new Set(allMethodsResponse.data.map(m => m.fulfillerId))].join(', ')
          );
          // Use all methods if no filter was effective
          response.data = allMethodsResponse.data;
        }
      }

      if (!response.success || !response.data) {
        console.error('[ShippingMethodService] Failed to fetch shipping methods from JTL:', response.error);
        return { success: false, synced: 0, error: response.error || 'Failed to fetch shipping methods' };
      }

      const jtlMethods = response.data as JTLShippingMethod[];
      console.log('[ShippingMethodService] JTL methods to sync:', jtlMethods.length);
      if (jtlMethods.length > 0) {
        console.log('[ShippingMethodService] First method sample:', JSON.stringify(jtlMethods[0], null, 2));
      }
      let syncedCount = 0;

      for (const jtlMethod of jtlMethods) {
        // Upsert shipping method
        await this.prisma.shippingMethod.upsert({
          where: { jtlShippingMethodId: jtlMethod.shippingMethodId },
          update: {
            name: jtlMethod.name,
            carrier: jtlMethod.carrierName || jtlMethod.carrierCode || 'Unknown',
            jtlFulfillerId: jtlMethod.fulfillerId,
            jtlShippingType: jtlMethod.shippingType,
            jtlCarrierCode: jtlMethod.carrierCode,
            jtlCarrierName: jtlMethod.carrierName,
            trackingUrlSchema: jtlMethod.trackingUrlSchema,
            cutoffTime: jtlMethod.cutoffTime,
            updatedAt: new Date(),
          },
          create: {
            code: `jtl-${jtlMethod.shippingMethodId}`,
            name: jtlMethod.name,
            carrier: jtlMethod.carrierName || jtlMethod.carrierCode || 'Unknown',
            jtlShippingMethodId: jtlMethod.shippingMethodId,
            jtlFulfillerId: jtlMethod.fulfillerId,
            jtlShippingType: jtlMethod.shippingType,
            jtlCarrierCode: jtlMethod.carrierCode,
            jtlCarrierName: jtlMethod.carrierName,
            trackingUrlSchema: jtlMethod.trackingUrlSchema,
            cutoffTime: jtlMethod.cutoffTime,
            isActive: true,
          },
        });
        syncedCount++;
      }

      console.log(`[ShippingMethodService] Synced ${syncedCount} shipping methods from JTL FFN`);
      return { success: true, synced: syncedCount };
    } catch (error: any) {
      console.error('[ShippingMethodService] Failed to sync shipping methods:', error);
      return { success: false, synced: 0, error: error.message };
    }
  }

  /**
   * Resolve shipping method for an order
   * 
   * Priority:
   * 1. Try to find a mapping for the channel's shipping method
   * 2. Fall back to channel's default shipping method
   * 3. Fall back to client's default shipping method
   * 4. If no fallback, mark as mismatch and hold order
   */
  async resolveShippingMethod(
    channelShipping: ChannelShippingInfo,
    channelType: ChannelType,
    clientId: string,
    channelId?: string
  ): Promise<ShippingMethodResolution> {
    try {
      // Step 1: Try to find a mapping for this channel shipping method
      const mapping = await this.findShippingMapping(
        channelShipping,
        channelType,
        clientId,
        channelId
      );

      if (mapping) {
        // Found a mapping!
        const shippingMethod = await this.prisma.shippingMethod.findUnique({
          where: { id: mapping.shippingMethodId },
        });

        if (shippingMethod?.jtlShippingMethodId) {
          console.log(`[ShippingMethodService] Resolved shipping method: ${channelShipping.title || channelShipping.code} -> ${shippingMethod.name} (${shippingMethod.jtlShippingMethodId})`);
          return {
            success: true,
            jtlShippingMethodId: shippingMethod.jtlShippingMethodId,
            shippingMethodName: shippingMethod.name,
            usedFallback: false,
            mismatch: false,
            shouldHoldOrder: false,
          };
        }
      }

      // Step 2: No mapping found - try channel's default shipping method
      if (channelId) {
        const channel = await this.prisma.channel.findUnique({
          where: { id: channelId },
          select: { defaultShippingMethod: true },
        });

        if (channel?.defaultShippingMethod) {
          // defaultShippingMethod stores the JTL shipping method ID directly
          const shippingMethod = await this.prisma.shippingMethod.findFirst({
            where: { jtlShippingMethodId: channel.defaultShippingMethod },
          });

          if (shippingMethod) {
            console.log(`[ShippingMethodService] Using channel default shipping method: ${shippingMethod.name} (${shippingMethod.jtlShippingMethodId})`);
            return {
              success: true,
              jtlShippingMethodId: shippingMethod.jtlShippingMethodId!,
              shippingMethodName: shippingMethod.name,
              usedFallback: true,
              mismatch: false, // Not a mismatch - channel default is intentional
              shouldHoldOrder: false,
            };
          }
        }
      }

      // Step 3: No channel default - try client's default shipping method
      const client = await this.prisma.client.findUnique({
        where: { id: clientId },
        include: { defaultShippingMethod: true },
      });

      if (client?.defaultShippingMethod?.jtlShippingMethodId) {
        console.log(`[ShippingMethodService] Using client default shipping method: ${client.defaultShippingMethod.name}`);
        return {
          success: true,
          jtlShippingMethodId: client.defaultShippingMethod.jtlShippingMethodId,
          shippingMethodName: client.defaultShippingMethod.name,
          usedFallback: true,
          mismatch: false, // Not a mismatch - client default is intentional
          shouldHoldOrder: false,
        };
      }

      // Step 4: No fallback - this is a critical mismatch, order should be held
      console.warn(`[ShippingMethodService] CRITICAL: No shipping method mapping or fallback for client ${clientId}, shipping: ${channelShipping.title || channelShipping.code}`);
      return {
        success: false,
        usedFallback: false,
        mismatch: true,
        mismatchReason: `No mapping found for shipping method "${channelShipping.title || channelShipping.code}" and no default shipping method configured.`,
        shouldHoldOrder: true,
      };
    } catch (error: any) {
      console.error('[ShippingMethodService] Error resolving shipping method:', error);
      return {
        success: false,
        usedFallback: false,
        mismatch: true,
        mismatchReason: `Error resolving shipping method: ${error.message}`,
        shouldHoldOrder: true,
      };
    }
  }

  /**
   * Find shipping method mapping
   * Searches in order: Channel-specific -> Client-specific -> Global
   */
  private async findShippingMapping(
    channelShipping: ChannelShippingInfo,
    channelType: ChannelType,
    clientId: string,
    channelId?: string
  ) {
    const searchCode = channelShipping.code?.toLowerCase();
    const searchTitle = channelShipping.title?.toLowerCase();

    // Priority 1: Channel-specific mapping
    if (channelId) {
      const channelMapping = await this.prisma.shippingMethodMapping.findFirst({
        where: {
          channelId,
          channelType,
          isActive: true,
          OR: [
            { channelShippingCode: searchCode || '' },
            { channelShippingTitle: { contains: searchTitle || '', mode: 'insensitive' } },
          ],
        },
      });
      if (channelMapping) return channelMapping;
    }

    // Priority 2: Client-specific mapping
    const clientMapping = await this.prisma.shippingMethodMapping.findFirst({
      where: {
        clientId,
        channelId: null, // Client-level, not channel-specific
        channelType,
        isActive: true,
        OR: [
          { channelShippingCode: searchCode || '' },
          { channelShippingTitle: { contains: searchTitle || '', mode: 'insensitive' } },
        ],
      },
    });
    if (clientMapping) return clientMapping;

    // Priority 3: Global mapping (no client, no channel)
    const globalMapping = await this.prisma.shippingMethodMapping.findFirst({
      where: {
        clientId: null,
        channelId: null,
        channelType,
        isActive: true,
        OR: [
          { channelShippingCode: searchCode || '' },
          { channelShippingTitle: { contains: searchTitle || '', mode: 'insensitive' } },
        ],
      },
    });
    return globalMapping;
  }

  /**
   * Create a shipping method mismatch record
   */
  async createMismatchRecord(
    orderId: string,
    channelShipping: ChannelShippingInfo,
    channelType: ChannelType,
    usedFallback: boolean,
    usedShippingMethodId?: string
  ): Promise<string | null> {
    try {
      const mismatch = await this.prisma.shippingMethodMismatch.create({
        data: {
          orderId,
          channelShippingCode: channelShipping.code,
          channelShippingTitle: channelShipping.title,
          channelType,
          usedFallback,
          usedShippingMethodId,
          isResolved: usedFallback, // If fallback was used, it's considered "resolved" but flagged
        },
      });
      console.log(`[ShippingMethodService] Created mismatch record for order ${orderId}`);
      return mismatch.id;
    } catch (error: any) {
      console.error('[ShippingMethodService] Failed to create mismatch record:', error);
      return null;
    }
  }

  /**
   * Get all shipping methods (for admin)
   */
  async getAllShippingMethods() {
    return this.prisma.shippingMethod.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * Get active shipping methods (for client selection)
   */
  async getActiveShippingMethods() {
    return this.prisma.shippingMethod.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * Get shipping method mappings for a client
   */
  async getClientMappings(clientId: string) {
    return this.prisma.shippingMethodMapping.findMany({
      where: { clientId },
      include: { shippingMethod: true },
      orderBy: { channelShippingTitle: 'asc' },
    });
  }

  /**
   * Get shipping method mappings for a channel
   */
  async getChannelMappings(channelId: string) {
    return this.prisma.shippingMethodMapping.findMany({
      where: { channelId },
      include: { shippingMethod: true },
      orderBy: { channelShippingTitle: 'asc' },
    });
  }

  /**
   * Create or update a shipping method mapping
   */
  async upsertMapping(data: {
    channelShippingCode: string;
    channelShippingTitle: string;
    channelType: ChannelType;
    shippingMethodId: string;
    clientId?: string;
    channelId?: string;
  }) {
    const { channelShippingCode, channelShippingTitle, channelType, shippingMethodId, clientId, channelId } = data;

    // For compound unique keys with nullable fields, we need to find existing first
    const existing = await this.prisma.shippingMethodMapping.findFirst({
      where: {
        channelShippingCode,
        channelType,
        clientId: clientId ?? null,
        channelId: channelId ?? null,
      },
    });

    if (existing) {
      return this.prisma.shippingMethodMapping.update({
        where: { id: existing.id },
        data: {
          channelShippingTitle,
          shippingMethodId,
          updatedAt: new Date(),
        },
      });
    }

    return this.prisma.shippingMethodMapping.create({
      data: {
        channelShippingCode,
        channelShippingTitle,
        channelType,
        shippingMethodId,
        clientId: clientId ?? null,
        channelId: channelId ?? null,
      },
    });
  }

  /**
   * Delete a shipping method mapping
   */
  async deleteMapping(mappingId: string) {
    return this.prisma.shippingMethodMapping.delete({
      where: { id: mappingId },
    });
  }

  /**
   * Set default shipping method for a client
   */
  async setClientDefaultShippingMethod(clientId: string, shippingMethodId: string) {
    return this.prisma.client.update({
      where: { id: clientId },
      data: { defaultShippingMethodId: shippingMethodId },
    });
  }

  /**
   * Get unresolved mismatches (for dashboard/notifications)
   */
  async getUnresolvedMismatches(clientId?: string) {
    return this.prisma.shippingMethodMismatch.findMany({
      where: {
        isResolved: false,
        ...(clientId ? { order: { clientId } } : {}),
      },
      include: {
        order: {
          select: {
            id: true,
            orderId: true,
            orderNumber: true,
            customerName: true,
            clientId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Resolve a shipping method mismatch
   */
  async resolveMismatch(mismatchId: string, resolvedBy: string, resolutionNote?: string, shippingMethodId?: string) {
    return this.prisma.shippingMethodMismatch.update({
      where: { id: mismatchId },
      data: {
        isResolved: true,
        resolvedAt: new Date(),
        resolvedBy,
        resolutionNote,
        usedShippingMethodId: shippingMethodId,
      },
    });
  }

  /**
   * Create a new shipping method (manual creation)
   */
  async createShippingMethod(data: {
    code: string;
    name: string;
    carrier: string;
    jtlShippingMethodId?: string;
    jtlFulfillerId?: string;
    jtlShippingType?: string;
    basePrice?: number;
    pricePerKg?: number;
    logoUrl?: string;
    isDefault?: boolean;
  }) {
    return this.prisma.shippingMethod.create({
      data: {
        ...data,
        basePrice: data.basePrice ? String(data.basePrice) : undefined,
        pricePerKg: data.pricePerKg ? String(data.pricePerKg) : undefined,
      },
    });
  }

  /**
   * Update a shipping method
   */
  async updateShippingMethod(id: string, data: {
    name?: string;
    carrier?: string;
    isActive?: boolean;
    isDefault?: boolean;
    basePrice?: number;
    pricePerKg?: number;
    logoUrl?: string;
  }) {
    // If setting as default, unset other defaults first
    if (data.isDefault) {
      await this.prisma.shippingMethod.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.prisma.shippingMethod.update({
      where: { id },
      data: {
        ...data,
        basePrice: data.basePrice !== undefined ? String(data.basePrice) : undefined,
        pricePerKg: data.pricePerKg !== undefined ? String(data.pricePerKg) : undefined,
      },
    });
  }
}

export default ShippingMethodService;
