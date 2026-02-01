/**
 * Data Migration Script: Update Fulfillment States to FFN-Aligned Values
 *
 * This script migrates existing orders from old FulfillmentState values to the new FFN-aligned values.
 *
 * Mapping:
 * - AWAITING_STOCK → PREPARATION
 * - READY_FOR_PICKING → ACKNOWLEDGED
 * - PICKING → PICKPROCESS
 * - PICKED → PICKPROCESS
 * - PACKING → PICKPROCESS
 * - PACKED → LOCKED
 * - LABEL_CREATED → LOCKED
 * - OUT_FOR_DELIVERY → IN_TRANSIT
 * - PENDING, SHIPPED, IN_TRANSIT, DELIVERED, FAILED_DELIVERY, RETURNED_TO_SENDER → no change
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// Initialize Prisma with pg adapter (Prisma 7 requirement)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Mapping from old values to new values
const STATUS_MIGRATION_MAP: Record<string, string> = {
    // Old statuses that need to be migrated
    'AWAITING_STOCK': 'PREPARATION',
    'READY_FOR_PICKING': 'ACKNOWLEDGED',
    'PICKING': 'PICKPROCESS',
    'PICKED': 'PICKPROCESS',
    'PACKING': 'PICKPROCESS',
    'PACKED': 'LOCKED',
    'LABEL_CREATED': 'LOCKED',
    'OUT_FOR_DELIVERY': 'IN_TRANSIT',

    // Statuses that stay the same (kept for completeness)
    'PENDING': 'PENDING',
    'SHIPPED': 'SHIPPED',
    'IN_TRANSIT': 'IN_TRANSIT',
    'DELIVERED': 'DELIVERED',
    'FAILED_DELIVERY': 'FAILED_DELIVERY',
    'RETURNED_TO_SENDER': 'RETURNED_TO_SENDER',
};

async function migratefulfillmentStates() {
    console.log('Starting fulfillment state migration...\n');

    try {
        // Get all orders with their current fulfillment states
        const orders = await prisma.order.findMany({
            select: {
                id: true,
                externalOrderId: true,
                fulfillmentState: true,
            },
        });

        console.log(`Found ${orders.length} total orders\n`);

        // Count orders by current status
        const statusCounts: Record<string, number> = {};
        orders.forEach(order => {
            if (order.fulfillmentState) {
                statusCounts[order.fulfillmentState] = (statusCounts[order.fulfillmentState] || 0) + 1;
            }
        });

        console.log('Current status distribution:');
        Object.entries(statusCounts).forEach(([status, count]) => {
            console.log(`  ${status}: ${count} orders`);
        });
        console.log('');

        // Perform migration
        let migratedCount = 0;
        let unchangedCount = 0;
        const migrationResults: Record<string, number> = {};

        for (const order of orders) {
            if (!order.fulfillmentState) {
                continue;
            }

            const currentStatus = order.fulfillmentState;
            const newStatus = STATUS_MIGRATION_MAP[currentStatus];

            if (!newStatus) {
                console.warn(`⚠️  Unknown status "${currentStatus}" for order ${order.externalOrderId} (ID: ${order.id})`);
                continue;
            }

            if (currentStatus !== newStatus) {
                // Update the order using raw SQL since Prisma doesn't recognize new enum values yet
                await prisma.$executeRaw`
                    UPDATE "orders"
                    SET "fulfillmentState" = ${newStatus}::text::"FulfillmentState"
                    WHERE id = ${order.id}
                `;

                migratedCount++;
                const migrationKey = `${currentStatus} → ${newStatus}`;
                migrationResults[migrationKey] = (migrationResults[migrationKey] || 0) + 1;
            } else {
                unchangedCount++;
            }
        }

        console.log('\nMigration complete!');
        console.log(`  ✓ ${migratedCount} orders migrated`);
        console.log(`  ✓ ${unchangedCount} orders unchanged\n`);

        if (Object.keys(migrationResults).length > 0) {
            console.log('Migration breakdown:');
            Object.entries(migrationResults).forEach(([migration, count]) => {
                console.log(`  ${migration}: ${count} orders`);
            });
            console.log('');
        }

        // Verify final distribution
        const updatedOrders = await prisma.order.findMany({
            select: { fulfillmentState: true },
        });

        const finalCounts: Record<string, number> = {};
        updatedOrders.forEach(order => {
            if (order.fulfillmentState) {
                finalCounts[order.fulfillmentState] = (finalCounts[order.fulfillmentState] || 0) + 1;
            }
        });

        console.log('Final status distribution:');
        Object.entries(finalCounts).forEach(([status, count]) => {
            console.log(`  ${status}: ${count} orders`);
        });

    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

// Run migration
migratefulfillmentStates()
    .then(() => {
        console.log('\n✅ Migration script completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Migration script failed:', error);
        process.exit(1);
    });
