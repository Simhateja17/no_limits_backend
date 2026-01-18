# Stress Testing Infrastructure

Comprehensive stress testing suite for the No-Limits fulfillment platform. Tests webhook processing, database performance, queue throughput, and end-to-end order flow under various load conditions.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Test Scenarios](#test-scenarios)
5. [Running Tests](#running-tests)
6. [Bulk Order Creation](#bulk-order-creation)
7. [Metrics & Monitoring](#metrics--monitoring)
8. [Test Mode Safety](#test-mode-safety)
9. [Cleanup](#cleanup)
10. [Troubleshooting](#troubleshooting)

---

## Overview

The stress testing infrastructure consists of:

| Component | Description | Location |
|-----------|-------------|----------|
| **Order Generators** | Generate realistic Shopify/WooCommerce payloads | `generators/` |
| **Webhook Simulator** | Send simulated webhooks to the API | `scripts/webhook-simulator.ts` |
| **Mock FFN Server** | Simulate JTL-FFN warehouse API | `mocks/mock-ffn-server.ts` |
| **k6 Load Tests** | Professional load testing scripts | `k6/` |
| **Metrics Collectors** | Database & queue monitoring | `metrics/` |
| **Orchestrator** | Coordinates all components | `scripts/orchestrator.ts` |
| **Cleanup Script** | Remove test data | `scripts/cleanup.ts` |

### Architecture

```
                    ┌──────────────────┐
                    │  Stress Test     │
                    │  Orchestrator    │
                    └────────┬─────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Webhook         │ │ Mock FFN        │ │ Metrics         │
│ Simulator       │ │ Server          │ │ Collectors      │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────┐
│                    Backend API                          │
│  (Webhook Routes → Order Sync → Queue → FFN Sync)      │
└─────────────────────────────────────────────────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   PostgreSQL    │ │   pg-boss       │ │   JTL-FFN       │
│   Database      │ │   Queue         │ │   (mocked)      │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## Prerequisites

### Required Software

1. **Node.js 18+** - Runtime environment
2. **PostgreSQL** - Database (accessible from test environment)
3. **k6** (optional) - For k6-based load tests

### Install k6 (macOS)

```bash
brew install k6
```

### Install k6 (Linux)

```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### Environment Variables

Ensure these are set in your `.env` file:

```env
DATABASE_URL=postgresql://user:pass@host:5432/db
API_BASE_URL=http://localhost:3001
```

---

## Quick Start

### 1. Run a Quick Validation Test

```bash
npm run stress:quick
```

This runs a minimal test (20 orders over 30 seconds) to verify setup.

### 2. Run Low Volume Test

```bash
npm run stress:low
```

300-500 orders over 5 minutes with steady load.

### 3. View Results

Reports are saved to `stress-tests/reports/` with:
- JSON report (machine-readable)
- Text summary (human-readable)

---

## Test Scenarios

### Low Volume (Daily Operations)

| Parameter | Value |
|-----------|-------|
| Total Orders | 300-500 |
| Duration | 5 minutes |
| Pattern | Steady |
| Platform Mix | 50% Shopify / 50% WooCommerce |
| Use Case | Normal daily operations |

```bash
npm run stress:low
```

### Medium Volume (Sales Event)

| Parameter | Value |
|-----------|-------|
| Total Orders | 2,500+ |
| Duration | 10 minutes |
| Pattern | Burst + Sustained |
| Platform Mix | 60% Shopify / 40% WooCommerce |
| Use Case | Flash sale, product launch |

```bash
npm run stress:medium
```

### High Volume (Black Friday)

| Parameter | Value |
|-----------|-------|
| Total Orders | 10,000+ |
| Duration | 24 minutes |
| Pattern | Three peaks (morning/lunch/evening) |
| Platform Mix | 70% Shopify / 30% WooCommerce |
| Use Case | Black Friday, major sale events |

```bash
npm run stress:high
```

---

## Running Tests

### Using the Orchestrator (Recommended)

The orchestrator coordinates all components:

```bash
# Quick validation
npm run stress:quick

# Low volume scenario
npm run stress:low

# Medium volume scenario
npm run stress:medium

# High volume scenario
npm run stress:high
```

### Using k6 (Advanced)

For more detailed metrics and professional load testing:

```bash
# With k6
npm run stress:k6:low
npm run stress:k6:medium
npm run stress:k6:high
```

### Running Individual Components

#### Start Mock FFN Server

```bash
npm run stress:mock-ffn
```

The mock server runs on port 3099 and simulates:
- OAuth token endpoint
- Outbound creation
- Product listing
- Configurable latency and error rates

#### Start Real-time Dashboard

```bash
npm run stress:dashboard
```

Opens a web-based dashboard at http://localhost:3098 showing:
- Database connections and cache hit ratio
- Queue depth and job status
- Order counts and sync status
- Real-time performance metrics

#### Run Webhook Simulator Only

```bash
npx tsx stress-tests/scripts/webhook-simulator.ts
```

---

## Bulk Order Creation

Create test orders directly in real Shopify/WooCommerce stores. These orders will trigger real webhooks and flow through the complete system.

### Shopify

```bash
npm run stress:bulk:shopify -- \
  --store mystore.myshopify.com \
  --token shpat_xxxxxxxxxxxxx \
  --count 100 \
  --delay 500
```

Options:
- `--store` - Shopify store domain
- `--token` - Admin API access token
- `--count` - Number of orders (default: 10)
- `--delay` - Delay between orders in ms (default: 500)
- `--dry-run` - Preview without creating

### WooCommerce

```bash
npm run stress:bulk:woo -- \
  --url https://mystore.com \
  --key ck_xxxxxxxxxxxxx \
  --secret cs_xxxxxxxxxxxxx \
  --count 100 \
  --delay 500
```

Options:
- `--url` - WooCommerce store URL
- `--key` - Consumer key
- `--secret` - Consumer secret
- `--count` - Number of orders (default: 10)
- `--delay` - Delay between orders in ms (default: 500)
- `--dry-run` - Preview without creating

---

## Metrics & Monitoring

### Database Metrics

Collected automatically during tests:
- Active connections
- Connection pool utilization
- Slow queries (>100ms)
- Lock wait times
- Cache hit ratio
- Table sizes
- Deadlock occurrences

### Queue Metrics

Collected automatically during tests:
- Queue depth per job type
- Jobs processed per second
- Average processing time
- Failed job count
- Dead letter queue size
- Retry statistics

### Viewing Metrics

Metrics are included in the final report. Real-time monitoring can be done via:

```bash
# PostgreSQL activity
SELECT * FROM pg_stat_activity WHERE state = 'active';

# pg-boss queue status
SELECT name, state, COUNT(*) 
FROM pgboss.job 
GROUP BY name, state;
```

---

## Test Mode Safety

### Automatic FFN Sync Skip

Test orders are automatically identified and **will NOT sync to the real JTL-FFN warehouse**. Detection is based on:

1. **Tags**: `stress-test`, `k6`, `test-mode`, `load-test`
2. **Email patterns**:
   - `@test.com`
   - `@test-medium.com`
   - `@blackfriday-test.com`
   - `@stress-test.io`
   - `@load-test.net`

When a test order is detected, the sync status is set to `SKIPPED` instead of `PENDING`.

### Verifying Test Mode

Check if test orders are being skipped:

```sql
SELECT id, customer_email, tags, sync_status, ffn_sync_error
FROM orders
WHERE sync_status = 'SKIPPED'
ORDER BY created_at DESC
LIMIT 10;
```

---

## Cleanup

### Remove Test Orders Only

```bash
npm run stress:cleanup
```

This removes orders with:
- Tags containing `stress-test` or `k6`
- Email patterns matching test domains

### Dry Run (Preview)

```bash
npm run stress:cleanup:dry
```

Shows what would be deleted without actually deleting.

### Remove ALL Orders (Dangerous!)

```bash
npm run stress:cleanup:all
```

**WARNING**: This deletes ALL orders, not just test orders. Use with caution!

### Manual Cleanup Query

```sql
-- View test orders
SELECT COUNT(*) FROM orders 
WHERE tags @> ARRAY['stress-test']::text[]
   OR customer_email LIKE '%@stress-test.io';

-- Delete test orders (after backing up!)
DELETE FROM order_items WHERE order_id IN (
  SELECT id FROM orders 
  WHERE tags @> ARRAY['stress-test']::text[]
);

DELETE FROM orders 
WHERE tags @> ARRAY['stress-test']::text[];

-- Vacuum to reclaim space
VACUUM ANALYZE orders;
```

---

## Troubleshooting

### Common Issues

#### "Connection refused" errors

**Cause**: Backend API not running or wrong port

**Solution**:
```bash
# Start the backend
npm run dev

# Verify API is accessible
curl http://localhost:3001/health
```

#### "Database connection timeout"

**Cause**: Too many connections during high load

**Solution**: Increase PostgreSQL connection limits:
```sql
ALTER SYSTEM SET max_connections = 200;
SELECT pg_reload_conf();
```

#### k6 not found

**Cause**: k6 not installed

**Solution**:
```bash
# macOS
brew install k6

# Or use npm-based tests
npm run stress:low  # Uses Node.js webhook simulator
```

#### Orders not appearing in database

**Cause**: Webhook signature validation failing

**Solution**: Check that the mock webhooks are using correct HMAC signatures. The simulator handles this automatically.

#### FFN sync errors in logs

**Cause**: Mock FFN server not running

**Solution**:
```bash
npm run stress:mock-ffn
```

### Performance Tuning

#### PostgreSQL Settings

```sql
-- Increase work_mem for complex queries
SET work_mem = '256MB';

-- Increase shared_buffers (requires restart)
ALTER SYSTEM SET shared_buffers = '2GB';
```

#### Connection Pool

In `prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  connectionPool {
    maxSize = 20
    minSize = 5
  }
}
```

---

## File Structure

```
stress-tests/
├── config/
│   └── stress-test.config.ts     # Test configuration and scenarios
├── dashboard/
│   └── metrics-dashboard.ts      # Real-time web dashboard
├── generators/
│   ├── index.ts                  # Generator exports
│   ├── shopify-order.generator.ts
│   └── woocommerce-order.generator.ts
├── k6/
│   ├── low-volume-test.js
│   ├── medium-volume-test.js
│   └── high-volume-test.js
├── metrics/
│   ├── database-metrics.ts       # PostgreSQL monitoring
│   └── queue-metrics.ts          # pg-boss monitoring
├── mocks/
│   └── mock-ffn-server.ts        # Simulated JTL-FFN API
├── scripts/
│   ├── orchestrator.ts           # Main test runner
│   ├── webhook-simulator.ts      # Webhook sender
│   ├── cleanup.ts                # Data cleanup
│   ├── bulk-create-shopify-orders.ts
│   └── bulk-create-woocommerce-orders.ts
├── reports/                      # Generated test reports
└── README.md                     # This file
```

---

## NPM Scripts Reference

| Script | Description |
|--------|-------------|
| `stress:quick` | Quick validation test (20 orders) |
| `stress:low` | Low volume test (300-500 orders) |
| `stress:medium` | Medium volume test (2,500+ orders) |
| `stress:high` | High volume test (10,000+ orders) |
| `stress:k6:low` | Low volume with k6 |
| `stress:k6:medium` | Medium volume with k6 |
| `stress:k6:high` | High volume with k6 |
| `stress:cleanup` | Remove test orders |
| `stress:cleanup:dry` | Preview cleanup |
| `stress:cleanup:all` | Remove ALL orders |
| `stress:mock-ffn` | Start mock FFN server |
| `stress:dashboard` | Start real-time metrics dashboard |
| `stress:bulk:shopify` | Create orders in Shopify |
| `stress:bulk:woo` | Create orders in WooCommerce |

---

## Success Criteria

Tests are considered **PASSED** when:

- Success rate >= 85%
- P95 response time < 5 seconds
- No database deadlocks
- Queue failure rate < 5%

Tests are considered **FAILED** when any of these thresholds are exceeded.
