/**
 * SQL Migration Script: Update FulfillmentState Enum
 *
 * This script performs a step-by-step migration of the FulfillmentState enum
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// Initialize Prisma with pg adapter
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function migrateEnum() {
    console.log('Starting enum migration...\n');

    try {
        // Step 1: Add new enum values
        console.log('Step 1: Adding new enum values...');
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'PREPARATION'`);
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'ACKNOWLEDGED'`);
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'LOCKED'`);
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'PICKPROCESS'`);
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'PARTIALLY_SHIPPED'`);
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'CANCELED'`);
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState" ADD VALUE IF NOT EXISTS 'PARTIALLY_CANCELED'`);
        console.log('✓ New enum values added\n');

        // Step 2: Migrate data
        console.log('Step 2: Migrating order data...');
        const updates = [
            { from: 'AWAITING_STOCK', to: 'PREPARATION' },
            { from: 'READY_FOR_PICKING', to: 'ACKNOWLEDGED' },
            { from: 'PICKING', to: 'PICKPROCESS' },
            { from: 'PICKED', to: 'PICKPROCESS' },
            { from: 'PACKING', to: 'PICKPROCESS' },
            { from: 'PACKED', to: 'LOCKED' },
            { from: 'LABEL_CREATED', to: 'LOCKED' },
            { from: 'OUT_FOR_DELIVERY', to: 'IN_TRANSIT' },
        ];

        for (const { from, to } of updates) {
            const result = await prisma.$executeRawUnsafe(
                `UPDATE "orders" SET "fulfillmentState" = '${to}' WHERE "fulfillmentState" = '${from}'`
            );
            if (result > 0) {
                console.log(`  ✓ Migrated ${result} orders from ${from} → ${to}`);
            }
        }
        console.log('✓ Data migration complete\n');

        // Step 3: Replace enum type
        console.log('Step 3: Replacing enum type...');

        // Create new enum
        await prisma.$executeRawUnsafe(`
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
            )
        `);
        console.log('  ✓ Created new enum type');

        // Drop default value first
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "orders"
            ALTER COLUMN "fulfillmentState" DROP DEFAULT
        `);
        console.log('  ✓ Dropped default value');

        // Alter column to use new enum
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "orders"
            ALTER COLUMN "fulfillmentState" TYPE "FulfillmentState_new"
            USING "fulfillmentState"::text::"FulfillmentState_new"
        `);
        console.log('  ✓ Updated column type');

        // Re-add default value (PENDING is the first value in the enum)
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "orders"
            ALTER COLUMN "fulfillmentState" SET DEFAULT 'PENDING'::"FulfillmentState_new"
        `);
        console.log('  ✓ Re-added default value');

        // Drop old enum and rename new one
        await prisma.$executeRawUnsafe(`DROP TYPE "FulfillmentState"`);
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState_new" RENAME TO "FulfillmentState"`);
        console.log('  ✓ Replaced old enum\n');

        console.log('✅ Enum migration completed successfully!');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
        await pool.end();
    }
}

// Run migration
migrateEnum()
    .then(() => {
        console.log('\n✅ Migration script completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Migration script failed:', error);
        process.exit(1);
    });
