/**
 * Product Cache Utility
 * Eliminates N+1 queries during order and return sync by pre-loading all products
 */

import { PrismaClient } from '@prisma/client';

interface CachedProduct {
  id: string;
  sku: string;
  name: string;
  jtlProductId: string | null;
}

export class ProductCache {
  private cache: Map<string, CachedProduct> = new Map();
  private clientId?: string;

  constructor(private prisma: PrismaClient) {}

  /**
   * Initialize cache by loading all products for a client
   * @param clientId - Client ID to load products for
   */
  async initialize(clientId: string): Promise<void> {
    const startTime = Date.now();
    this.clientId = clientId;

    try {
      // Load all products for the client in a single query
      const products = await this.prisma.product.findMany({
        where: { clientId },
        select: {
          id: true,
          sku: true,
          name: true,
          jtlProductId: true,
        },
      });

      // Build SKU lookup map for O(1) access
      this.cache.clear();
      for (const product of products) {
        this.cache.set(product.sku, product);
      }

      const duration = Date.now() - startTime;
      console.log('[ProductCache] Loaded products', {
        clientId,
        productCount: this.cache.size,
        duration: `${duration}ms`,
      });
    } catch (error) {
      console.error('[ProductCache] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Get product by SKU with O(1) lookup
   * @param sku - Product SKU
   * @returns Cached product or undefined
   */
  get(sku: string): CachedProduct | undefined {
    return this.cache.get(sku);
  }

  /**
   * Get multiple products by SKUs
   * @param skus - Array of product SKUs
   * @returns Array of found products (may be partial)
   */
  getMultiple(skus: string[]): CachedProduct[] {
    const products: CachedProduct[] = [];
    for (const sku of skus) {
      const product = this.cache.get(sku);
      if (product) {
        products.push(product);
      }
    }
    return products;
  }

  /**
   * Update JTL product ID in cache after JTL sync
   * @param sku - Product SKU
   * @param jtlProductId - JTL product ID
   */
  updateJTLMapping(sku: string, jtlProductId: string): void {
    const product = this.cache.get(sku);
    if (product) {
      product.jtlProductId = jtlProductId;
    }
  }

  /**
   * Add product to cache (for products created during sync)
   * @param product - Product to add
   */
  add(product: CachedProduct): void {
    this.cache.set(product.sku, product);
  }

  /**
   * Check if product exists in cache
   * @param sku - Product SKU
   * @returns true if product exists
   */
  has(sku: string): boolean {
    return this.cache.has(sku);
  }

  /**
   * Get cache size
   * @returns Number of products in cache
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    this.clientId = undefined;
  }

  /**
   * Get memory usage estimate
   * @returns Estimated memory usage in bytes
   */
  getMemoryUsage(): number {
    // Estimate: ~200 bytes per product (id + sku + name + jtlProductId)
    return this.cache.size * 200;
  }
}

export default ProductCache;
