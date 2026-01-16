/**
 * Shopify GraphQL Pagination Utilities
 * Handles cursor-based pagination for GraphQL queries
 */

/**
 * Page info from GraphQL response
 */
export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage?: boolean;
  startCursor?: string;
  endCursor?: string;
}

/**
 * Edge structure for connection-based responses
 */
export interface Edge<T> {
  node: T;
  cursor: string;
}

/**
 * Standard GraphQL connection response
 */
export interface Connection<T> {
  edges: Edge<T>[];
  pageInfo: PageInfo;
}

/**
 * Options for paginated queries
 */
export interface PaginationOptions {
  first?: number;
  after?: string | null;
  last?: number;
  before?: string | null;
}

/**
 * Default page size (Shopify max is 250)
 */
export const DEFAULT_PAGE_SIZE = 250;

/**
 * Extract nodes from a connection response
 * @param connection - The GraphQL connection object
 * @returns Array of node objects
 */
export function extractNodes<T>(connection: Connection<T>): T[] {
  return connection.edges.map(edge => edge.node);
}

/**
 * Check if there are more pages to fetch
 * @param pageInfo - The pageInfo object from response
 * @returns True if more pages exist
 */
export function hasMorePages(pageInfo: PageInfo): boolean {
  return pageInfo.hasNextPage;
}

/**
 * Get the cursor for the next page
 * @param pageInfo - The pageInfo object from response
 * @returns The endCursor or null if no more pages
 */
export function getNextCursor(pageInfo: PageInfo): string | null {
  if (!pageInfo.hasNextPage) {
    return null;
  }
  return pageInfo.endCursor || null;
}

/**
 * Build pagination variables for a GraphQL query
 * @param options - Pagination options
 * @returns Variables object for GraphQL query
 */
export function buildPaginationVariables(options: PaginationOptions = {}): {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
} {
  const variables: { first?: number; after?: string; last?: number; before?: string } = {};

  if (options.first !== undefined) {
    variables.first = Math.min(options.first, DEFAULT_PAGE_SIZE);
  } else if (options.last === undefined) {
    // Default to forward pagination
    variables.first = DEFAULT_PAGE_SIZE;
  }

  if (options.after) {
    variables.after = options.after;
  }

  if (options.last !== undefined) {
    variables.last = Math.min(options.last, DEFAULT_PAGE_SIZE);
  }

  if (options.before) {
    variables.before = options.before;
  }

  return variables;
}

/**
 * Helper to iterate through all pages of a paginated query
 * @param fetchPage - Function that fetches a single page
 * @param options - Initial pagination options
 * @returns All nodes from all pages
 */
export async function fetchAllPages<T>(
  fetchPage: (cursor: string | null) => Promise<{ nodes: T[]; pageInfo: PageInfo }>,
  options: { delayMs?: number; maxPages?: number } = {}
): Promise<T[]> {
  const allNodes: T[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  const maxPages = options.maxPages || Infinity;
  const delayMs = options.delayMs || 0;

  while (pageCount < maxPages) {
    const { nodes, pageInfo } = await fetchPage(cursor);

    allNodes.push(...nodes);
    pageCount++;

    if (!pageInfo.hasNextPage || !pageInfo.endCursor) {
      break;
    }

    cursor = pageInfo.endCursor;

    // Add delay between requests to avoid rate limiting
    if (delayMs > 0 && pageInfo.hasNextPage) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return allNodes;
}

/**
 * Build a GraphQL query filter string
 * Similar to Shopify's search query syntax
 * @param filters - Key-value filter pairs
 * @returns Query string for GraphQL query parameter
 */
export function buildQueryFilter(filters: Record<string, string | number | boolean | Date | undefined>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;

    if (value instanceof Date) {
      // Format as ISO string for date filters
      parts.push(`${key}:>${value.toISOString()}`);
    } else if (typeof value === 'string' && value.includes(' ')) {
      // Quote strings with spaces
      parts.push(`${key}:"${value}"`);
    } else {
      parts.push(`${key}:${value}`);
    }
  }

  return parts.join(' AND ');
}
