# Bulk Order Creation with Real Products

This stress test script creates orders using **real products** from your database for specific test stores.

## Target Stores

The script targets these two stores by default:
- **Shopify**: ida.freitag@example.com
- **WooCommerce**: julian.bauer@example.com

## Features

✅ Uses real products from the database (not hardcoded test data)
✅ Only uses products with available stock
✅ Supports both Shopify and WooCommerce
✅ Automatic credential decryption
✅ Rate limiting and delays between requests
✅ Dry-run mode for testing
✅ Detailed progress reporting

## Prerequisites

1. **Environment Variables**
   ```bash
   DATABASE_URL=postgresql://...
   ENCRYPTION_KEY=<your-64-char-hex-key>
   ```

2. **Active Stores**
   - The target user accounts must exist
   - They must have at least one active channel
   - Channels must have valid API credentials
   - At least one product with stock must exist

## Usage

### Create Orders for Both Platforms

```bash
# Create 10 orders for each platform (Shopify + WooCommerce)
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 10
```

### Create Orders for Specific Platform

```bash
# Shopify only
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 5 --platform shopify

# WooCommerce only
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 5 --platform woocommerce
```

### Dry Run (Test Without Creating)

```bash
# See what would be created without actually creating orders
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 10 --dry-run
```

### Custom Delay Between Orders

```bash
# Add 2-second delay between each order
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 20 --delay 2000
```

## Command-Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `--count <n>` | Number of orders to create per platform | 10 |
| `--delay <ms>` | Delay between orders in milliseconds | 1000 |
| `--platform <type>` | Target platform: `shopify`, `woocommerce`, or `both` | both |
| `--dry-run` | Print what would be created without actually creating orders | false |
| `--help` | Show help message | - |

## What the Script Does

1. **Queries Database**
   - Finds users by email (ida.freitag@example.com, julian.bauer@example.com)
   - Retrieves their active channels
   - Fetches products with available stock

2. **Decrypts Credentials**
   - Automatically decrypts API tokens using ENCRYPTION_KEY
   - Handles both Shopify access tokens and WooCommerce consumer keys/secrets

3. **Generates Realistic Orders**
   - Random customer names (German)
   - Random German addresses
   - 1-3 real products per order
   - Random quantities (1-2 per item)

4. **Creates Orders**
   - Sends requests to Shopify/WooCommerce APIs
   - Respects rate limits with delays
   - Tags orders as stress tests for easy identification

## Output Example

```
🔍 Loading store configurations from database...

✅ Found 2 active store(s):

  1. Ida's Shopify Store (SHOPIFY)
     Email: ida.freitag@example.com
     Products: 25

  2. Julian's WooCommerce Store (WOOCOMMERCE)
     Email: julian.bauer@example.com
     Products: 18

================================================================================
         SHOPIFY ORDER CREATION - Ida's Shopify Store
================================================================================
  Store:          ida.freitag@example.com
  Channel:        Ida's Shopify Store
  Products:       25 available
  Orders:         10
  Delay:          1000ms
  Dry Run:        false
================================================================================

  ✓ [1/10] Created order #1001 (ID: 5678901234567890)
  ✓ [2/10] Created order #1002 (ID: 5678901234567891)
  ...

  Results:
    Total:        10
    Successful:   10
    Failed:       0
    Success Rate: 100.00%
    Duration:     12.34s

================================================================================
                         OVERALL SUMMARY
================================================================================
  Total Orders:     20
  Successful:       20
  Failed:           0
  Success Rate:     100.00%
  Total Duration:   24.67s
================================================================================
```

## Order Tagging

All created orders are tagged for easy identification:
- `stress-test` - Identifies this as a test order
- `real-products` - Indicates real products were used
- `test-<uniqueId>` - Unique identifier for this test run

## Cleaning Up Test Orders

To remove test orders later, you can filter by these tags in Shopify/WooCommerce admin or use the cleanup script:

```bash
# Clean up all stress test orders
npx tsx stress-tests/scripts/cleanup.ts --tag stress-test
```

## Troubleshooting

### No products available

```
⚠️  No products available for this store. Skipping...
```

**Solution**: Make sure products exist in the database with `available > 0`

### Invalid credentials

```
✗ Failed: HTTP 401: Unauthorized
```

**Solutions**:
- Verify ENCRYPTION_KEY is correct
- Check that channel credentials are valid
- Ensure Shopify access token has order write permissions
- Verify WooCommerce consumer key/secret are correct

### Store not found

```
❌ No active stores found for the specified users.
```

**Solutions**:
- Verify users exist with exact emails
- Check that channels are set to `isActive: true` and `status: 'ACTIVE'`
- Ensure channels have required credentials configured

## Differences from Other Scripts

This script is different from `bulk-create-shopify-orders.ts` and `bulk-create-woocommerce-orders.ts`:

| Feature | This Script | Individual Scripts |
|---------|-------------|-------------------|
| Products | Real from DB | Hardcoded test data |
| Stores | Auto-detected | Manual config |
| Multi-platform | ✅ Both at once | ❌ One at a time |
| Product stock | Checks availability | Bypasses inventory |
| Credentials | Auto from DB | Manual entry required |

## Performance Notes

- **Rate Limiting**: Default 1000ms delay respects API limits
- **Batch Size**: Start with small counts (5-10) to test
- **Database Load**: Minimal - queries run once at startup
- **API Limits**:
  - Shopify: ~40 requests/minute
  - WooCommerce: Varies by server

## Examples

### Quick Test
```bash
# Test with 3 orders, dry run
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 3 --dry-run
```

### Medium Load Test
```bash
# 50 orders per platform with 500ms delay
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts --count 50 --delay 500
```

### Shopify Only Stress Test
```bash
# 100 Shopify orders with 750ms delay
npx tsx stress-tests/scripts/bulk-create-orders-with-real-products.ts \
  --count 100 \
  --platform shopify \
  --delay 750
```

## Integration with Other Tools

This script works well with:
- **Orchestrator**: Can be called from the main orchestrator
- **Metrics Dashboard**: Orders will appear in metrics
- **Cleanup Script**: Use tags to clean up afterwards
- **E2E Tests**: Can be used in E2E testing workflows
