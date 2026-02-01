/**
 * Generates a unique job ID with format: {prefix}-{timestamp}-{random}
 * Example: "jtl-poll-20250201-a3f9b2c1"
 *
 * @param prefix - Service or operation prefix (e.g., "jtl-poll", "sync-inc")
 * @returns Unique job ID string
 */
export function generateJobId(prefix: string): string {
  const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}-${timestamp}-${random}`;
}
