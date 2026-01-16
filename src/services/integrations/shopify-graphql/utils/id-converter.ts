/**
 * Shopify GraphQL ID Converter Utilities
 * Converts between numeric REST API IDs and GraphQL Global IDs (GIDs)
 */

export type ShopifyResourceType =
  | 'Order'
  | 'Product'
  | 'ProductVariant'
  | 'Customer'
  | 'LineItem'
  | 'Refund'
  | 'FulfillmentOrder'
  | 'Fulfillment'
  | 'InventoryItem'
  | 'Location'
  | 'Collection'
  | 'Shop'
  | 'WebhookSubscription'
  | 'DraftOrder'
  | 'OrderTransaction';

/**
 * Convert a numeric ID to a Shopify Global ID (GID)
 * @param type - The Shopify resource type
 * @param id - The numeric ID
 * @returns The GID string (e.g., "gid://shopify/Order/12345")
 */
export function toGid(type: ShopifyResourceType, id: number | string): string {
  return `gid://shopify/${type}/${id}`;
}

/**
 * Extract the numeric ID and type from a Shopify Global ID
 * @param gid - The GID string
 * @returns Object with type and numeric id
 * @throws Error if the GID format is invalid
 */
export function fromGid(gid: string): { type: string; id: number } {
  const match = gid.match(/gid:\/\/shopify\/(\w+)\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid Shopify GID format: ${gid}`);
  }
  return {
    type: match[1],
    id: parseInt(match[2], 10)
  };
}

/**
 * Extract just the numeric ID from a GID
 * @param gid - The GID string
 * @returns The numeric ID
 */
export function extractNumericId(gid: string): number {
  return fromGid(gid).id;
}

/**
 * Check if a string is a valid Shopify GID
 * @param value - The string to check
 * @returns True if it's a valid GID format
 */
export function isGid(value: string): boolean {
  return /^gid:\/\/shopify\/\w+\/\d+$/.test(value);
}

/**
 * Convert a GID to a legacy resource ID (numeric string)
 * Some GraphQL responses include legacyResourceId, this normalizes access
 * @param gidOrLegacyId - Either a GID or already a numeric string/number
 * @returns The numeric ID as a number
 */
export function toLegacyId(gidOrLegacyId: string | number): number {
  if (typeof gidOrLegacyId === 'number') {
    return gidOrLegacyId;
  }
  if (isGid(gidOrLegacyId)) {
    return extractNumericId(gidOrLegacyId);
  }
  return parseInt(gidOrLegacyId, 10);
}

/**
 * Batch convert numeric IDs to GIDs
 * @param type - The Shopify resource type
 * @param ids - Array of numeric IDs
 * @returns Array of GID strings
 */
export function toGidBatch(type: ShopifyResourceType, ids: (number | string)[]): string[] {
  return ids.map(id => toGid(type, id));
}

/**
 * Batch extract numeric IDs from GIDs
 * @param gids - Array of GID strings
 * @returns Array of numeric IDs
 */
export function fromGidBatch(gids: string[]): number[] {
  return gids.map(gid => extractNumericId(gid));
}
