# Order & Return Sync - Implementation Summary

## Overview

This document summarizes the dual-master model implementation for orders and returns synchronization between the No-Limits platform, e-commerce channels (Shopify/WooCommerce), and JTL-FFN fulfillment network.

## Core Principles

### Order Synchronization
- **Singlze Creation Authority**: Orders ONLY originate from Shopify/WooCommerce
- **Commercial Fields**: Owned by commerce platform (price, customer identity, order totals)
- **Operational Fields**: Owned by No-Limits platform (fulfillment status, carrier, tracking, notes)
- **Sync Flow**: Shopify/WooCommerce → No-Limits → JTL-FFN → Warehouse

### Return Synchronization  
- **Return Master**: No-Limits platform is the master for all returns
- **Inspection Authority**: Platform owns inspection results, restock decisions
- **Multi-Origin**: Returns can initiate from Shopify, platform, or warehouse
- **Sync Flow**: Return Initiated → No-Limits (Master) → Warehouse → Stock Decision → Shopify

---

## Services Implemented

### 1. OrderSyncService (`order-sync.service.ts`)
Handles bi-directional order synchronization.

**Key Methods:**
- `processIncomingOrder()` - Receives orders from commerce platforms
- `updateOperationalFields()` - Update fulfillment, carrier, notes
- `cancelOrder()` - With sync to FFN and commerce
- `splitOrder()` - Split orders for partial fulfillment
- `isEcho()` - Detect and prevent sync loops

**Field Ownership:**
```typescript
const ORDER_FIELD_OWNERSHIP = {
  COMMERCIAL: ['total', 'subtotal', 'tax', 'currency', 'customerEmail', 'customerName'], // Read-only from commerce
  OPERATIONAL: ['fulfillmentState', 'trackingNumber', 'carrier', 'warehouseNotes']  // Editable in platform
};
```

### 2. ReturnSyncService (`return-sync.service.ts`)
Implements the return master model.

**Key Methods:**
- `processIncomingReturn()` - Receives returns from Shopify/WooCommerce
- `createWarehouseReturn()` - Unknown return scenario (package with no prior notice)
- `createPlatformReturn()` - Return initiated directly in No-Limits
- `inspectReturn()` - Record inspection results with per-item details
- `processRestock()` - Update inventory for restockable items
- `issueRefund()` - Issue refund with commerce platform sync
- `finalizeReturn()` - Makes return immutable

### 3. OrderOperationsService (`order-operations.service.ts`)
Handles operational order management owned by the platform.

**Key Methods:**
- `correctAddress()` - Correct shipping address before fulfillment (stores original)
- `createReplacementOrder()` - Create replacement for damaged/lost items
- `updatePriority()` - Update order priority level
- `holdOrder()` / `releaseOrder()` - Put/release order on hold
- `updateCarrier()` - Select carrier and service level

### 4. JTLOrderSyncService (`jtl-order-sync.service.ts`)
Handles JTL-FFN integration for order fulfillment.

**Key Methods:**
- `syncOrderToFFN()` - Create outbound in FFN from order
- `cancelOrderInFFN()` - Cancel outbound when order cancelled
- `createFulfillmentOrderInFFN()` - Create outbound for split orders
- `pollFFNUpdates()` - Poll FFN for status updates, sync tracking back

### 5. EnhancedWebhookProcessor (`enhanced-webhook-processor.service.ts`)
Routes incoming webhooks to appropriate sync services.

**Supported Webhooks:**
- Shopify: products/*, orders/*, refunds/*, inventory_levels/*
- WooCommerce: product.*, order.*

---

## API Endpoints

### Order Operations
```
POST /sync-admin/orders/:orderId/correct-address  - Correct shipping address
POST /sync-admin/orders/:orderId/replacement      - Create replacement order
POST /sync-admin/orders/:orderId/priority         - Update priority level
POST /sync-admin/orders/:orderId/hold             - Put order on hold
POST /sync-admin/orders/:orderId/release          - Release from hold
POST /sync-admin/orders/:orderId/carrier          - Update carrier selection
POST /sync-admin/orders/:orderId/sync-to-ffn      - Manual sync to JTL-FFN
POST /sync-admin/orders/:orderId/cancel-ffn       - Cancel in JTL-FFN
```

### Return Operations
```
POST /sync-admin/returns/warehouse            - Create warehouse return
POST /sync-admin/returns/platform             - Create platform-initiated return
POST /sync-admin/returns/:returnId/inspect    - Perform inspection
POST /sync-admin/returns/:returnId/refund     - Issue refund
POST /sync-admin/returns/:returnId/finalize   - Finalize return
```

### JTL FFN Operations
```
POST /sync-admin/clients/:clientId/poll-ffn   - Poll FFN for updates
```

---

## Database Schema Key Fields

### Order Model
```prisma
model Order {
  // Origin tracking
  orderOrigin         SyncOrigin    // SHOPIFY, WOOCOMMERCE, NOLIMITS
  orderState          OrderStatus   // Commercial state (from commerce)
  fulfillmentState    FulfillmentState // Operational state (platform-owned)
  
  // Operational fields (platform-owned)
  addressCorrected        Boolean @default(false)
  originalShippingAddress Json?
  carrierSelection        String?
  priorityLevel           Int @default(0)
  isOnHold                Boolean @default(false)
  warehouseNotes          String?
  
  // Split order support
  isSplitOrder            Boolean @default(false)
  splitFromOrderId        String?
  
  // Replacement order support
  isReplacement           Boolean @default(false)
  originalOrderId         String?
  
  // JTL FFN integration
  jtlOutboundId           String?
  lastJtlSync             DateTime?
  ffnSyncError            String?
}
```

### Return Model
```prisma
model Return {
  // Origin tracking (platform is master)
  returnOrigin        SyncOrigin    // SHOPIFY, WOOCOMMERCE, NOLIMITS, WAREHOUSE
  
  // Inspection (platform-owned)
  inspectionResult    InspectionResult
  inspectedAt         DateTime?
  restockEligible     Boolean?
  restockQuantity     Int?
  hasDamage           Boolean @default(false)
  hasDefect           Boolean @default(false)
  
  // Unknown return flag
  isUnknownReturn     Boolean @default(false)
  
  // Replacement trigger
  triggerReplacement  Boolean @default(false)
  replacementOrderId  String?
  
  // Immutability
  finalizedAt         DateTime?
}
```

---

## Sync Status Tracking

All entities use consistent sync status tracking:
- `syncStatus`: PENDING | SYNCED | CONFLICT | ERROR
- `lastSyncedAt`: When last synced
- `lastUpdatedBy`: Which system last updated (SHOPIFY, WOOCOMMERCE, NOLIMITS, JTL, WAREHOUSE)
- Sync logs: `OrderSyncLog`, `ReturnSyncLog` for audit trail

---

## Queue Jobs

Async processing via pg-boss v12 queue:
- `ORDER_SYNC_TO_FFN` - Create/update outbound in JTL ✅
- `ORDER_SYNC_TO_COMMERCE` - Sync tracking to Shopify/WooCommerce ✅
- `ORDER_CANCEL_SYNC` - Cancel order across systems ✅
- `RETURN_SYNC_TO_COMMERCE` - Sync return/refund to commerce ✅
- `RETURN_RESTOCK_SYNC` - Process inventory restock ✅
- `PRODUCT_SYNC_TO_SHOPIFY` - Sync products to Shopify ✅
- `PRODUCT_SYNC_TO_WOOCOMMERCE` - Sync products to WooCommerce ✅
- `PRODUCT_SYNC_TO_JTL` - Sync products to JTL ✅

### Queue Worker Initialization

```typescript
import { initializeQueue } from './services/queue/sync-queue.service';
import { initializeQueueWorkers } from './services/queue/queue-worker.service';

// In your app initialization:
await initializeQueue(process.env.DATABASE_URL, prisma);
await initializeQueueWorkers(prisma);
```

---

## Testing

Unit tests are available for critical sync flows:
- `src/__tests__/services/order-return-sync.test.ts`

Run tests:
```bash
npm test
```

---

## Completed Implementation

✅ **Order Sync**
- Incoming order processing from Shopify/WooCommerce
- Operational field updates (tracking, carrier, status)
- Order cancellation with FFN and commerce sync
- Order splitting support

✅ **Return Sync**
- Platform as return master
- Return processing from all origins (Shopify, platform, warehouse)
- Inspection workflow with per-item details
- Restock processing
- Refund synchronization

✅ **Order Operations**
- Address correction (with original preservation)
- Replacement orders
- Priority updates
- Order holds

✅ **JTL-FFN Integration**
- Order creation (outbound)
- Cancellation
- Status polling and update sync

✅ **Queue Workers**
- All handlers wired to actual services
- DLQ event tracking for monitoring
- Retry with exponential backoff

---

## Next Steps

1. **ProductSyncService Enhancement**: Wire product sync handlers to actual push methods
2. **Scheduled Polling**: Set up cron job to poll FFN for updates
3. **Enhanced Monitoring**: Add Prometheus metrics for sync success rates
4. **Error Alerting**: Integrate DLQ events with alerting system
5. **CI/CD**: Add test coverage to CI pipeline
