-- Step 1: Add new enum values to existing FulfillmentState enum
ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'PREPARATION';
ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'ACKNOWLEDGED';
ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'LOCKED';
ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'PICKPROCESS';
ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'PARTIALLY_SHIPPED';
ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'CANCELED';
ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'PARTIALLY_CANCELED';

-- Step 2: Migrate existing data from old values to new values
UPDATE "orders" SET "fulfillmentState" = 'PREPARATION' WHERE "fulfillmentState" = 'AWAITING_STOCK';
UPDATE "orders" SET "fulfillmentState" = 'ACKNOWLEDGED' WHERE "fulfillmentState" = 'READY_FOR_PICKING';
UPDATE "orders" SET "fulfillmentState" = 'PICKPROCESS' WHERE "fulfillmentState" = 'PICKING';
UPDATE "orders" SET "fulfillmentState" = 'PICKPROCESS' WHERE "fulfillmentState" = 'PICKED';
UPDATE "orders" SET "fulfillmentState" = 'PICKPROCESS' WHERE "fulfillmentState" = 'PACKING';
UPDATE "orders" SET "fulfillmentState" = 'LOCKED' WHERE "fulfillmentState" = 'PACKED';
UPDATE "orders" SET "fulfillmentState" = 'LOCKED' WHERE "fulfillmentState" = 'LABEL_CREATED';
UPDATE "orders" SET "fulfillmentState" = 'IN_TRANSIT' WHERE "fulfillmentState" = 'OUT_FOR_DELIVERY';

-- Step 3: Now we can safely drop the old enum values by creating a new enum and migrating
-- Create new enum with only the new values
CREATE TYPE "FulfillmentState_new" AS ENUM (
  'PENDING',
  'PREPARATION',
  'ACKNOWLEDGED',
  'LOCKED',
  'PICKPROCESS',
  'SHIPPED',
  'PARTIALLY_SHIPPED',
  'CANCELED',
  'PARTIALLY_CANCELED',
  'IN_TRANSIT',
  'DELIVERED',
  'FAILED_DELIVERY',
  'RETURNED_TO_SENDER'
);

-- Alter the column to use the new enum
ALTER TABLE "orders"
  ALTER COLUMN "fulfillmentState" TYPE "FulfillmentState_new"
  USING "fulfillmentState"::text::"FulfillmentState_new";

-- Drop the old enum and rename the new one
DROP TYPE "FulfillmentState";
ALTER TYPE "FulfillmentState_new" RENAME TO "FulfillmentState";
