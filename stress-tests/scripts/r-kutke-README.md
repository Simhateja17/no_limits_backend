# r.kutke@gmx.de - Webhook Testing Orders

This script creates real WooCommerce orders for testing webhook integration.

## Quick Start

### 1. Get WooCommerce API Credentials

1. Log into r.kutke's WooCommerce admin panel
2. Go to: **WooCommerce → Settings → Advanced → REST API**
3. Click **Add key**
4. Set:
   - Description: "Webhook Testing"
   - User: (select admin user)
   - Permissions: **Read/Write**
5. Click **Generate API key**
6. **Copy the Consumer key and Consumer secret immediately** (they won't be shown again!)

### 2. Run the Script

#### Option A: Command-line arguments
```bash
cd backend
npx tsx stress-tests/scripts/r-kutke-order-test.ts \
  --url https://r-kutke-store.com \
  --key ck_xxxxxxxxxxxxx \
  --secret cs_xxxxxxxxxxxxx \
  --count 5
```

#### Option B: Environment variables (recommended)
```bash
cd backend
export RKUTKE_WOOCOMMERCE_URL=https://sanit-ersatzteile.de
export RKUTKE_WOOCOMMERCE_KEY=ck_8ec81f84468307f3851b60bbe91c85db5f7d5073
export RKUTKE_WOOCOMMERCE_SECRET=cs_e34609c2a83ddf9d409b56fd324e7e48404161e9

npx tsx stress-tests/scripts/r-kutke-order-test.ts --count 5
```

#### Option C: Dry run (test without creating orders)
```bash
npx tsx stress-tests/scripts/r-kutke-order-test.ts \
  --url https://r-kutke-store.com \
  --key ck_xxxxxxxxxxxxx \
  --secret cs_xxxxxxxxxxxxx \
  --count 5 \
  --dry-run
```

## Script Options

| Option | Description | Default |
|--------|-------------|---------|
| `--url` | WooCommerce store URL | Required (or `RKUTKE_WOOCOMMERCE_URL`) |
| `--key` | Consumer key from WooCommerce API | Required (or `RKUTKE_WOOCOMMERCE_KEY`) |
| `--secret` | Consumer secret from WooCommerce API | Required (or `RKUTKE_WOOCOMMERCE_SECRET`) |
| `--count` | Number of orders to create | 5 |
| `--delay` | Delay between orders (ms) | 1000 |
| `--dry-run` | Print orders without creating | false |

## What This Script Does

1. **Creates real WooCommerce orders** via the REST API
2. **Triggers webhooks** that flow to your backend
3. **Tests the full pipeline**: WooCommerce → Webhook → Backend → JTL-FFN
4. **Uses realistic data**:
   - German customer names and addresses
   - Random product combinations (1-3 items per order)
   - Various payment methods (PayPal, Bank Transfer, COD)
   - Different shipping methods
   - Unique email addresses per order

## After Running

### Monitor the Flow

1. **Backend Logs**: Check for webhook processing
   ```bash
   cd backend
   npm run dev
   # Watch for webhook events
   ```

2. **Admin Dashboard**: Verify orders appear
   ```
   http://localhost:3000/admin/orders
   ```

3. **Database**: Check orders table
   ```bash
   npx prisma studio
   ```

4. **JTL-FFN**: Confirm sync to fulfillment system
   - Check JTL-FFN admin panel
   - Look for orders with `_webhook_test` meta data

### Identify Test Orders

All test orders have these meta fields:
- `_webhook_test: "true"`
- `_test_client: "r.kutke@gmx.de"`
- `_test_id: "<unique-id>"`
- `_test_timestamp: "<ISO-timestamp>"`

Customer note includes: "Webhook test order #X for r.kutke@gmx.de"

## Customization

### Use Real Products

Edit `r-kutke-order-test.ts` and replace the test products:

```typescript
products: [
  { name: 'Actual Product Name', price: '49.99', sku: 'REAL-SKU-001' },
  // ... add more real products from the store
],
```

To find product SKUs:
1. Go to WooCommerce → Products
2. Click on a product
3. Copy the SKU field

### Adjust Order Frequency

For slower testing (to watch each order):
```bash
npx tsx stress-tests/scripts/r-kutke-order-test.ts --count 3 --delay 5000
```

For faster bulk testing:
```bash
npx tsx stress-tests/scripts/r-kutke-order-test.ts --count 20 --delay 500
```

## Troubleshooting

### Authentication Error
- Verify Consumer key and secret are correct
- Check API key has **Read/Write** permissions
- Ensure store URL is correct (no trailing slash)

### Product Not Found
- Products may not exist in the store
- Update the `products` array with real SKUs
- Or remove `sku` field to let WooCommerce create orders with product names only

### Webhook Not Triggering
- Check WooCommerce webhook configuration
- Verify webhook URL points to your backend
- Check webhook is enabled and active
- Review webhook delivery logs in WooCommerce

### Rate Limiting
- Increase `--delay` value
- WooCommerce typically allows 10 requests/second
- Default delay of 1000ms (1 order/sec) is safe

## Example Output

```
================================================================================
           REAL ORDER CREATION TEST - r.kutke@gmx.de
================================================================================
  Client:         r.kutke@gmx.de
  Store:          https://r-kutke-store.com
  Orders:         5
  Delay:          1000ms
  Dry Run:        false
  Purpose:        Webhook integration testing
================================================================================

⚠️  LIVE MODE - Real orders will be created in WooCommerce!
   These orders will trigger webhooks and flow through the system.
   Press Ctrl+C within 5 seconds to cancel...

[1/5] Creating order for rkutke-test-1-1706789012345@webhook-test.io...
  ✅ Success! Order ID: 1234
  Items: Test Product 1 (2x), Test Product 3 (1x)
  ⏱️  Waiting 1000ms before next order...

[2/5] Creating order for rkutke-test-2-1706789013456@webhook-test.io...
  ✅ Success! Order ID: 1235
  Items: Test Product 2 (1x)
  ⏱️  Waiting 1000ms before next order...

...

================================================================================
                           RESULTS
================================================================================
  Total Orders:    5
  Successful:      5 ✅
  Failed:          0 ✅
  Success Rate:    100.00%
  Duration:        6.23s
  Rate:            0.80 orders/sec
================================================================================

📊 Next Steps:
   1. Check your backend logs for webhook processing
   2. Verify orders appear in the admin dashboard
   3. Confirm JTL-FFN sync is working
   4. Monitor socket updates in the frontend
```
