/**
 * Channel Data Service
 * Handles fetching channels, locations, and shipping methods for clients
 */

import { PrismaClient, ChannelType } from '@prisma/client';
import { createShopifyServiceAuto } from './shopify-service-factory.js';
import { WooCommerceService } from './woocommerce.service.js';
import { getEncryptionService } from '../encryption.service.js';

export class ChannelDataService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get all channels for a client
   */
  async getChannelsByClient(clientId: string) {
    try {
      const channels = await this.prisma.channel.findMany({
        where: {
          clientId,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          type: true,
          url: true,
          status: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return {
        success: true,
        channels,
      };
    } catch (error) {
      console.error('Error fetching channels:', error);
      return {
        success: false,
        error: 'Failed to fetch channels',
        channels: [],
      };
    }
  }

  /**
   * Get warehouse locations for a client
   * Note: Currently returns empty array as warehouse location model may not exist yet
   * This can be extended once the warehouse location model is added
   */
  async getWarehouseLocations(clientId: string) {
    try {
      // For now, return empty array
      // This can be extended when warehouse location model is added to Prisma schema
      const locations: any[] = [];

      return {
        success: true,
        locations,
      };
    } catch (error) {
      console.error('Error fetching warehouse locations:', error);
      return {
        success: false,
        error: 'Failed to fetch locations',
        locations: [],
      };
    }
  }

  /**
   * Get shipping methods for a channel
   * Returns both warehouse methods (from JTL FFN) and channel-specific methods (from Shopify/WooCommerce)
   */
  async getShippingMethodsForChannel(channelId: string) {
    try {
      // Verify channel exists and get its details
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        include: {
          client: true,
        },
      });

      if (!channel) {
        return {
          success: false,
          error: 'Channel not found',
          warehouseMethods: [],
          channelMethods: [],
        };
      }

      // Get warehouse methods (JTL FFN shipping methods)
      const warehouseMethods = await this.prisma.shippingMethod.findMany({
        where: {
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          carrier: true,
          jtlShippingMethodId: true,
        },
        orderBy: {
          name: 'asc',
        },
      });

      // Get channel methods from the e-commerce platform
      let channelMethods: Array<{ id: string; name: string; carrier?: string }> = [];

      try {
        channelMethods = await this.fetchChannelShippingMethods(channel);
        console.log(`[ChannelDataService] Fetched ${channelMethods.length} shipping methods from ${channel.type} for channel ${channelId}`);
        if (channelMethods.length > 0) {
          console.log(`[ChannelDataService] Shipping methods:`, channelMethods.map(m => m.name).join(', '));
        }
      } catch (err) {
        console.warn(`[ChannelDataService] Could not fetch shipping methods from ${channel.type}:`, err);
        // Return empty array but don't fail the whole request
      }

      return {
        success: true,
        warehouseMethods: warehouseMethods.map(m => ({
          id: m.id,
          name: m.name,
          carrier: m.carrier,
        })),
        channelMethods,
      };
    } catch (error) {
      console.error('Error fetching shipping methods:', error);
      return {
        success: false,
        error: 'Failed to fetch shipping methods',
        warehouseMethods: [],
        channelMethods: [],
      };
    }
  }

  /**
   * Fetch shipping methods from the channel's e-commerce platform
   */
  private async fetchChannelShippingMethods(channel: {
    id: string;
    type: ChannelType;
    shopDomain?: string | null;
    accessToken?: string | null;
    url?: string | null;
    apiClientId?: string | null;
    apiClientSecret?: string | null;
  }): Promise<Array<{ id: string; name: string; carrier?: string }>> {
    const encryptionService = getEncryptionService();

    if (channel.type === 'SHOPIFY') {
      if (!channel.shopDomain || !channel.accessToken) {
        console.warn('[ChannelDataService] Shopify channel missing credentials');
        return [];
      }

      const shopifyService = createShopifyServiceAuto({
        shopDomain: channel.shopDomain,
        accessToken: encryptionService.decrypt(channel.accessToken),
      });

      const methods = await shopifyService.getShippingMethods();
      return methods.map(m => ({
        id: m.id,
        name: m.name,
        carrier: m.type,
      }));
    }

    if (channel.type === 'WOOCOMMERCE') {
      if (!channel.url || !channel.apiClientId || !channel.apiClientSecret) {
        console.warn('[ChannelDataService] WooCommerce channel missing credentials');
        return [];
      }

      console.log(`[ChannelDataService] Fetching WooCommerce shipping methods for channel ${channel.id} (${channel.url})`);

      const wooService = new WooCommerceService({
        url: channel.url,
        consumerKey: encryptionService.decrypt(channel.apiClientId),
        consumerSecret: encryptionService.decrypt(channel.apiClientSecret),
      });

      const methods = await wooService.getShippingMethods();
      console.log(`[ChannelDataService] WooCommerce returned ${methods.length} shipping methods for channel ${channel.id}`);
      console.log(`[ChannelDataService] WooCommerce methods:`, methods.map(m => ({ id: m.id, name: m.name, methodId: m.methodId })));

      return methods.map(m => ({
        id: m.id,
        name: m.name,
        carrier: m.methodId,
      }));
    }

    // For other channel types, return empty array
    console.warn(`[ChannelDataService] Unsupported channel type for shipping methods: ${channel.type}`);
    return [];
  }

  /**
   * Get existing shipping method mappings for a channel
   * Returns mappings in the format: warehouseMethodId -> channelMethodName
   */
  async getShippingMappingsForChannel(channelId: string): Promise<{
    success: boolean;
    mappings: Record<string, string>;
    error?: string;
  }> {
    try {
      const mappings = await this.prisma.shippingMethodMapping.findMany({
        where: { channelId },
        include: {
          shippingMethod: {
            select: { id: true, name: true }
          }
        }
      });

      // Convert to format: { warehouseMethodId: channelMethodName }
      const result = mappings.reduce((acc, m) => {
        acc[m.shippingMethodId] = m.channelShippingTitle;
        return acc;
      }, {} as Record<string, string>);

      return {
        success: true,
        mappings: result,
      };
    } catch (error: any) {
      console.error('[ChannelDataService] Error fetching shipping mappings:', error);
      return {
        success: false,
        mappings: {},
        error: error.message,
      };
    }
  }

  /**
   * Save shipping method mappings for a channel
   * Maps channel shipping methods to JTL FFN shipping methods
   */
  async saveShippingMappings(
    channelId: string,
    mappings: Record<string, string> // warehouseMethodId -> channelMethodName
  ): Promise<{ success: boolean; saved: number; error?: string }> {
    try {
      // Get channel details
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
        select: {
          id: true,
          type: true,
          clientId: true,
        },
      });

      if (!channel) {
        return { success: false, saved: 0, error: 'Channel not found' };
      }

      let savedCount = 0;

      // Process each mapping
      for (const [warehouseMethodId, channelMethodName] of Object.entries(mappings)) {
        if (!channelMethodName) continue;

        // Find the warehouse shipping method to get the JTL ID
        const warehouseMethod = await this.prisma.shippingMethod.findUnique({
          where: { id: warehouseMethodId },
        });

        if (!warehouseMethod) {
          console.warn(`[ChannelDataService] Warehouse method not found: ${warehouseMethodId}`);
          continue;
        }

        // Create or update the mapping
        // The mapping is: channelMethodName (from Shopify/WooCommerce) -> warehouseMethod (JTL FFN)
        const existingMapping = await this.prisma.shippingMethodMapping.findFirst({
          where: {
            channelId,
            channelShippingTitle: channelMethodName,
          },
        });

        if (existingMapping) {
          await this.prisma.shippingMethodMapping.update({
            where: { id: existingMapping.id },
            data: {
              shippingMethodId: warehouseMethodId,
              updatedAt: new Date(),
            },
          });
        } else {
          await this.prisma.shippingMethodMapping.create({
            data: {
              channelId,
              clientId: channel.clientId,
              channelType: channel.type,
              channelShippingCode: channelMethodName.toLowerCase().replace(/\s+/g, '_'),
              channelShippingTitle: channelMethodName,
              shippingMethodId: warehouseMethodId,
            },
          });
        }

        savedCount++;
      }

      console.log(`[ChannelDataService] Saved ${savedCount} shipping mappings for channel ${channelId}`);

      return { success: true, saved: savedCount };
    } catch (error: any) {
      console.error('[ChannelDataService] Error saving shipping mappings:', error);
      return { success: false, saved: 0, error: error.message };
    }
  }
}
