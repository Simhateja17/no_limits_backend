# Order Sync Scripts - Usage Guide

This guide explains how to diagnose and sync the 13 blocked paid orders to JTL FFN.

## Overview

Three scripts are provided:
1. **diagnose-blocked-orders.ts** - Identifies exact blocking reasons
2. **fix-and-sync-orders.ts** - Fixes issues and syncs to FFN
3. Final report generated automatically: **ORDER_SYNC_FINAL_REPORT.md**

## Prerequisites

- Node.js and npm installed
- Database connection configured
- JTL FFN credentials configured for client(s)

## Step 1: Run Diagnostic (Optional but Recommended)

First, identify what's blocking each order:

```bash
cd backend
npx tsx scripts/diagnose-blocked-orders.ts
```

**Output:**
- Console: Detailed blocker analysis for each order
- File: `backend/diagnostic-report.json` (structured data)

**What it checks:**
- Payment hold status
- Missing metadata (orderOrigin, fulfillmentState)
- FFN sync errors
- JTL configuration validity
- Order items and SKUs

## Step 2: Fix and Sync Orders

Run the main script to fix issues and sync to FFN:

```bash
cd backend
npx tsx scripts/fix-and-sync-orders.ts
```

**What it does:**
1. **Releases payment holds** - Clears `isOnHold`, `holdReason`, sets `holdReleasedAt`
2. **Fixes missing metadata** - Populates `orderOrigin` from channel type
3. **Sets fulfillment state** - Ensures `fulfillmentState = 'PENDING'`
4. **Recalculates totals** - Fixes zero amounts from order items
5. **Clears stale errors** - Removes `ffnSyncError` to enable retry
6. **Syncs to FFN** - Calls `JTLOrderSyncService.syncOrderToFFN()` for each order
7. **Monitors progress** - Captures sync time and FFN order IDs
8. **Generates report** - Creates comprehensive markdown report

**Safety:**
- ✅ Idempotent - Safe to run multiple times
- ✅ No destructive operations
- ✅ Orders remain in paid state if sync fails
- ✅ Individual order failures don't stop processing

**Output:**
- Console: Real-time progress with detailed logging
- File: `backend/sync-results.json` (structured results)
- File: `backend/ORDER_SYNC_FINAL_REPORT.md` (human-readable report)

## Step 3: Review Final Report

Open the generated report:

```bash
cat backend/ORDER_SYNC_FINAL_REPORT.md
# or
open backend/ORDER_SYNC_FINAL_REPORT.md
```

**Report includes:**
- Executive summary with success/failure counts
- Status overview table for all orders
- Detailed breakdown per order (before/after)
- Actions performed for each order
- FFN outbound IDs
- Sync times
- Error analysis and recommendations

## Verification

After successful sync, verify in database:

```sql
SELECT orderNumber, customerName, paymentStatus, isOnHold,
       orderOrigin, jtlOutboundId, syncStatus, ffnSyncError
FROM "Order"
WHERE "orderNumber" IN ('15990', '15906', '15925', '15926', '15977',
                        '15978', '15979', '15981', '15982', '15984',
                        '15986', '15987', '15989');
```

**Expected results:**
- ✅ All orders have `jtlOutboundId != null`
- ✅ All orders have `syncStatus = 'SYNCED'`
- ✅ All orders have `isOnHold = false`
- ✅ All orders have `ffnSyncError = null`

## Verify in JTL FFN

1. Log into JTL FFN dashboard
2. Navigate to Outbounds section
3. Search for merchant outbound numbers (order numbers)
4. Verify:
   - All 13 orders appear as outbounds
   - Customer/shipping info is correct
   - Items match order items with correct SKUs and quantities
   - Orders are ready for warehouse picking

## Troubleshooting

### Order still failing to sync

**Check JTL configuration:**
```sql
SELECT c.name, jc.isActive, jc.fulfillerId, jc.warehouseId, jc.environment
FROM "Client" c
LEFT JOIN "JtlConfig" jc ON c.id = jc.clientId_fk
WHERE c.id IN (SELECT DISTINCT clientId FROM "Order" WHERE orderNumber IN ('15990', ...));
```

**Check for missing SKUs:**
```sql
SELECT o.orderNumber, oi.sku, oi.productName
FROM "Order" o
JOIN "OrderItem" oi ON o.id = oi.orderId
WHERE o.orderNumber IN ('15990', '15906', ...)
  AND (oi.sku IS NULL OR oi.sku = '');
```

### Payment hold won't release

Manually override payment hold:

```sql
UPDATE "Order"
SET isOnHold = false,
    holdReason = null,
    holdReleasedAt = NOW(),
    holdReleasedBy = 'MANUAL',
    paymentHoldOverride = true
WHERE orderNumber = '15990';
```

Then rerun the sync script.

### Order already synced but shows error

Clear the error and verify FFN link:

```sql
UPDATE "Order"
SET ffnSyncError = null,
    syncStatus = 'SYNCED'
WHERE orderNumber = '15990'
  AND jtlOutboundId IS NOT NULL;
```

## Re-running for Failed Orders

The script is idempotent. To rerun for specific orders that failed:

1. Edit `ORDER_NUMBERS` array in `fix-and-sync-orders.ts`
2. Remove successfully synced order numbers
3. Keep only failed orders
4. Run: `npx tsx scripts/fix-and-sync-orders.ts`

## Order Number Reference

The 13 orders being synced:
- 15990, 15906, 15925, 15926, 15977
- 15978, 15979, 15981, 15982, 15984
- 15986, 15987, 15989

## Support

For issues:
1. Check `backend/sync-results.json` for detailed error messages
2. Review `ORDER_SYNC_FINAL_REPORT.md` recommendations
3. Check JTL FFN API logs
4. Verify database order data consistency

---

**Script Locations:**
- Diagnostic: `backend/scripts/diagnose-blocked-orders.ts`
- Fix & Sync: `backend/scripts/fix-and-sync-orders.ts`
- This Guide: `backend/scripts/README-ORDER-SYNC.md`
