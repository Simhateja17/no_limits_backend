/**
 * Batch Database Operations Utility
 * Provides optimized batch insert/update operations using Prisma transactions
 */

import { PrismaClient } from '@prisma/client';
import { ProductCache } from './product-cache.js';
import { SyncResult, SyncItemResult } from './types.js';

// ============= BATCH RESULT TYPES =============

export interface BatchResult {
  inserted: number;
  updated: number;
  failed: number;
  errors: BatchError[];
  details: SyncItemResult[];
}

export interface BatchError {
  batchIndex: number;
  batchSize: number;
  error: string;
  items?: string[]; // IDs or SKUs of failed items
}

// ============= BATCH OPERATION CONFIG =============

const BATCH_SIZES = {
  PRODUCTS: 50,          // Simple objects, fast inserts
  ORDERS: 20,            // Complex with nested items
  RETURNS: 25,           // Similar to orders
  JTL_MAPPINGS: 100,     // Simple updates
};

const TRANSACTION_TIMEOUT = {
  PRODUCTS: 30000,       // 30 seconds
  ORDERS: 60000,         // 60 seconds (larger payload)
  RETURNS: 45000,        // 45 seconds
  JTL_MAPPINGS: 20000,   // 20 seconds (simple updates)
};

// ============= BATCH OPERATIONS CLASS =============

export class BatchOperations {
  constructor(private prisma: PrismaClient) {}

  /**
   * Chunk array into smaller batches
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Batch upsert products (insert new + update existing)
   * @param products - External products to upsert
   * @param clientId - Client ID
   * @param channelId - Channel ID
   * @returns BatchResult with inserted/updated/failed counts
   */
  async batchUpsertProducts(
    products: Array<{
      externalProductId: string;
      sku: string;
      name: string;
      description?: string;
      price: number;
      currency: string;
      imageUrl?: string;
      variantId?: string;
      variantName?: string;
    }>,
    clientId: string,
    channelId: string
  ): Promise<BatchResult & { productIds: Map<string, string> }> {
    const startTime = Date.now();
    const result: BatchResult = {
      inserted: 0,
      updated: 0,
      failed: 0,
      errors: [],
      details: [],
    };
    const productIds = new Map<string, string>(); // sku -> product.id

    try {
      // Step 1: Pre-fetch all existing products for this client (single query)
      const skus = products.map(p => p.sku);
      const existingProducts = await this.prisma.product.findMany({
        where: {
          clientId,
          sku: { in: skus },
        },
        select: {
          id: true,
          sku: true,
        },
      });

      // Step 2: Build lookup map
      const existingMap = new Map(
        existingProducts.map(p => [p.sku, p])
      );

      // Step 3: Separate new vs existing products
      const newProducts = products.filter(p => !existingMap.has(p.sku));
      const updateProducts = products.filter(p => existingMap.has(p.sku));

      console.log('[BatchOps] Product upsert analysis', {
        total: products.length,
        new: newProducts.length,
        update: updateProducts.length,
      });

      // Step 4: Batch create new products
      if (newProducts.length > 0) {
        const chunks = this.chunkArray(newProducts, BATCH_SIZES.PRODUCTS);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];

          try {
            // Use transaction for atomicity
            await this.prisma.$transaction(
              async (tx) => {
                // Create products
                for (const product of chunk) {
                  const created = await tx.product.create({
                    data: {
                      clientId,
                      productId: product.externalProductId || product.sku,
                      sku: product.sku,
                      name: product.name,
                      description: product.description || '',
                      imageUrl: product.imageUrl,
                      channels: {
                        create: {
                          channelId,
                          externalProductId: product.externalProductId,
                        },
                      },
                    },
                  });

                  productIds.set(product.sku, created.id);
                  result.details.push({
                    externalId: product.externalProductId,
                    localId: created.id,
                    success: true,
                    action: 'created',
                  });
                }
              },
              {
                maxWait: 10000,
                timeout: TRANSACTION_TIMEOUT.PRODUCTS,
              }
            );

            result.inserted += chunk.length;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error(`[BatchOps] Failed to create product batch ${i}:`, errorMsg);

            result.failed += chunk.length;
            result.errors.push({
              batchIndex: i,
              batchSize: chunk.length,
              error: errorMsg,
              items: chunk.map(p => p.sku),
            });

            // Mark all items in batch as failed
            for (const product of chunk) {
              result.details.push({
                externalId: product.externalProductId,
                success: false,
                error: errorMsg,
                action: 'failed',
              });
            }
          }
        }
      }

      // Step 5: Batch update existing products
      if (updateProducts.length > 0) {
        const chunks = this.chunkArray(updateProducts, BATCH_SIZES.PRODUCTS);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];

          try {
            await this.prisma.$transaction(
              async (tx) => {
                for (const product of chunk) {
                  const existing = existingMap.get(product.sku)!;

                  // Update product
                  await tx.product.update({
                    where: { id: existing.id },
                    data: {
                      name: product.name,
                      description: product.description || '',
                      imageUrl: product.imageUrl,
                    },
                  });

                  // Ensure channel mapping exists
                  await tx.productChannel.upsert({
                    where: {
                      productId_channelId: {
                        productId: existing.id,
                        channelId,
                      },
                    },
                    create: {
                      productId: existing.id,
                      channelId,
                    },
                    update: {},
                  });

                  productIds.set(product.sku, existing.id);
                  result.details.push({
                    externalId: product.externalProductId,
                    localId: existing.id,
                    success: true,
                    action: 'updated',
                  });
                }
              },
              {
                maxWait: 10000,
                timeout: TRANSACTION_TIMEOUT.PRODUCTS,
              }
            );

            result.updated += chunk.length;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error(`[BatchOps] Failed to update product batch ${i}:`, errorMsg);

            result.failed += chunk.length;
            result.errors.push({
              batchIndex: i,
              batchSize: chunk.length,
              error: errorMsg,
              items: chunk.map(p => p.sku),
            });

            for (const product of chunk) {
              result.details.push({
                externalId: product.externalProductId,
                success: false,
                error: errorMsg,
                action: 'failed',
              });
            }
          }
        }
      }

      const duration = Date.now() - startTime;
      console.log('[BatchOps] Product upsert completed', {
        inserted: result.inserted,
        updated: result.updated,
        failed: result.failed,
        duration: `${duration}ms`,
      });

      return { ...result, productIds };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[BatchOps] Product upsert failed:', errorMsg);
      throw error;
    }
  }

  /**
   * Batch update JTL product mappings
   * @param mappings - Array of {sku, jtlProductId}
   * @param productCache - Product cache for lookups
   * @returns BatchResult
   */
  async batchUpdateJTLMappings(
    mappings: Array<{ sku: string; jtlProductId: string }>,
    productCache?: ProductCache
  ): Promise<BatchResult> {
    const startTime = Date.now();
    const result: BatchResult = {
      inserted: 0,
      updated: 0,
      failed: 0,
      errors: [],
      details: [],
    };

    if (mappings.length === 0) {
      return result;
    }

    try {
      const chunks = this.chunkArray(mappings, BATCH_SIZES.JTL_MAPPINGS);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        try {
          await this.prisma.$transaction(
            async (tx) => {
              for (const mapping of chunk) {
                // Get product ID from cache or query
                let productId: string | undefined;

                if (productCache) {
                  const cached = productCache.get(mapping.sku);
                  productId = cached?.id;
                  // Update cache
                  if (cached) {
                    productCache.updateJTLMapping(mapping.sku, mapping.jtlProductId);
                  }
                } else {
                  const product = await tx.product.findFirst({
                    where: { sku: mapping.sku },
                    select: { id: true },
                  });
                  productId = product?.id;
                }

                if (!productId) {
                  result.failed++;
                  result.details.push({
                    externalId: mapping.sku,
                    success: false,
                    error: 'Product not found',
                    action: 'failed',
                  });
                  continue;
                }

                // Update JTL mapping
                await tx.product.update({
                  where: { id: productId },
                  data: { jtlProductId: mapping.jtlProductId },
                });

                result.updated++;
                result.details.push({
                  externalId: mapping.sku,
                  localId: productId,
                  success: true,
                  action: 'updated',
                });
              }
            },
            {
              maxWait: 5000,
              timeout: TRANSACTION_TIMEOUT.JTL_MAPPINGS,
            }
          );
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[BatchOps] Failed to update JTL mapping batch ${i}:`, errorMsg);

          result.failed += chunk.length;
          result.errors.push({
            batchIndex: i,
            batchSize: chunk.length,
            error: errorMsg,
            items: chunk.map(m => m.sku),
          });
        }
      }

      const duration = Date.now() - startTime;
      console.log('[BatchOps] JTL mappings updated', {
        updated: result.updated,
        failed: result.failed,
        duration: `${duration}ms`,
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[BatchOps] JTL mapping update failed:', errorMsg);
      throw error;
    }
  }

  /**
   * Batch create orders with nested items
   * @param orders - External orders to create
   * @param clientId - Client ID
   * @param channelId - Channel ID
   * @param productCache - Product cache to avoid N+1 queries
   * @returns BatchResult with created order IDs
   */
  async batchCreateOrders(
    orders: Array<{
      externalOrderId: string;
      orderNumber: string;
      customerEmail: string;
      customerName: string;
      totalAmount: number;
      currency: string;
      orderDate: Date;
      status: string;
      shippingAddress?: any;
      billingAddress?: any;
      items: Array<{
        sku: string;
        quantity: number;
        price: number;
        name: string;
      }>;
    }>,
    clientId: string,
    channelId: string,
    productCache?: ProductCache
  ): Promise<BatchResult & { orderIds: Map<string, string> }> {
    const startTime = Date.now();
    const result: BatchResult = {
      inserted: 0,
      updated: 0,
      failed: 0,
      errors: [],
      details: [],
    };
    const orderIds = new Map<string, string>(); // externalOrderId -> order.id

    try {
      // Pre-fetch existing orders (single query)
      const externalIds = orders.map(o => o.externalOrderId);
      const existingOrders = await this.prisma.order.findMany({
        where: {
          clientId,
          externalOrderId: { in: externalIds },
        },
        select: {
          id: true,
          externalOrderId: true,
        },
      });

      const existingMap = new Map(
        existingOrders.map(o => [o.externalOrderId, o.id])
      );

      // Filter out existing orders
      const newOrders = orders.filter(o => !existingMap.has(o.externalOrderId));

      if (newOrders.length === 0) {
        console.log('[BatchOps] No new orders to create (all exist)');
        return { ...result, orderIds };
      }

      console.log('[BatchOps] Creating orders', {
        total: orders.length,
        new: newOrders.length,
        existing: existingOrders.length,
      });

      const chunks = this.chunkArray(newOrders, BATCH_SIZES.ORDERS);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        try {
          await this.prisma.$transaction(
            async (tx) => {
              for (const order of chunk) {
                // Resolve product IDs for items using cache
                const orderItems = [];
                let hasUnresolvedProduct = false;

                for (const item of order.items) {
                  let productId: string | undefined;

                  if (productCache) {
                    const cached = productCache.get(item.sku);
                    productId = cached?.id;
                  } else {
                    const product = await tx.product.findFirst({
                      where: { sku: item.sku },
                      select: { id: true },
                    });
                    productId = product?.id;
                  }

                  if (!productId) {
                    console.warn(`[BatchOps] Product not found for SKU: ${item.sku}`);
                    hasUnresolvedProduct = true;
                    continue;
                  }

                  orderItems.push({
                    productId,
                    quantity: item.quantity,
                    price: item.price,
                    name: item.name,
                  });
                }

                if (hasUnresolvedProduct) {
                  result.failed++;
                  result.details.push({
                    externalId: order.externalOrderId,
                    success: false,
                    error: 'One or more products not found',
                    action: 'failed',
                  });
                  continue;
                }

                // Create order with nested items
                // Look up channel to determine orderOrigin
                const orderChannel = await tx.channel.findUnique({ where: { id: channelId } });
                const created = await tx.order.create({
                  data: {
                    clientId,
                    channelId,
                    orderId: order.externalOrderId || order.orderNumber || `order-${Date.now()}`,
                    externalOrderId: order.externalOrderId,
                    orderNumber: order.orderNumber,
                    customerEmail: order.customerEmail,
                    customerName: order.customerName,
                    total: order.totalAmount,
                    currency: order.currency,
                    orderDate: order.orderDate,
                    status: order.status as any,
                    orderOrigin: orderChannel?.type === 'WOOCOMMERCE' ? 'WOOCOMMERCE' : 'SHOPIFY',
                    items: {
                      create: orderItems,
                    },
                  },
                });

                orderIds.set(order.externalOrderId, created.id);
                result.inserted++;
                result.details.push({
                  externalId: order.externalOrderId,
                  localId: created.id,
                  success: true,
                  action: 'created',
                });
              }
            },
            {
              maxWait: 15000,
              timeout: TRANSACTION_TIMEOUT.ORDERS,
            }
          );
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[BatchOps] Failed to create order batch ${i}:`, errorMsg);

          result.failed += chunk.length;
          result.errors.push({
            batchIndex: i,
            batchSize: chunk.length,
            error: errorMsg,
            items: chunk.map(o => o.externalOrderId),
          });

          for (const order of chunk) {
            result.details.push({
              externalId: order.externalOrderId,
              success: false,
              error: errorMsg,
              action: 'failed',
            });
          }
        }
      }

      const duration = Date.now() - startTime;
      console.log('[BatchOps] Order creation completed', {
        inserted: result.inserted,
        failed: result.failed,
        duration: `${duration}ms`,
      });

      return { ...result, orderIds };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[BatchOps] Order creation failed:', errorMsg);
      throw error;
    }
  }
}

export default BatchOperations;
