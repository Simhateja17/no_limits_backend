/**
 * Bundle Calculator Utility
 *
 * Calculates the maximum possible quantity of bundles that can be assembled
 * based on component stock availability.
 *
 * Formula: possibleQuantity = MIN(floor(available / quantity)) for all components
 *
 * Examples:
 * - Component1: 20 stock (1× per bundle), Component2: 5 stock (1×), Component3: 3 stock (1×)
 *   → possibleQuantity = MIN(20, 5, 3) = 3
 *
 * - Component1: 20 stock (1×), Component2: 5 stock (2×), Component3: 3 stock (2×)
 *   → possibleQuantity = MIN(20/1, 5/2, 3/2) = MIN(20, 2, 1) = 1
 */

/**
 * Calculate possible quantity for a bundle based on component stock
 * @param bundleItems Array of bundle components with quantity and stock info
 * @returns The maximum number of complete bundles that can be assembled
 */
export function calculatePossibleQuantity(
  bundleItems: Array<{
    quantity: number;
    childProduct: { available: number };
  }>
): number {
  // Handle edge cases
  if (!bundleItems || bundleItems.length === 0) {
    return 0;
  }

  // Calculate how many bundles can be made from each component
  const quantities = bundleItems.map(item => {
    // Ensure we don't divide by zero
    if (item.quantity <= 0) return 0;

    return Math.floor(item.childProduct.available / item.quantity);
  });

  // The bottleneck component determines the maximum possible quantity
  return Math.min(...quantities);
}

/**
 * Enrich a product with the possibleQuantity field
 * @param product Product object that may or may not be a bundle
 * @returns Product with possibleQuantity field added
 */
export function enrichProductWithPossibleQuantity<T extends {
  isBundle?: boolean;
  bundleItems?: any[];
}>(product: T): T & { possibleQuantity?: number | null } {
  // Only calculate for bundles with components
  if (product.isBundle && product.bundleItems) {
    return {
      ...product,
      possibleQuantity: calculatePossibleQuantity(product.bundleItems)
    };
  }

  // Non-bundle products have null possibleQuantity
  return { ...product, possibleQuantity: null };
}
