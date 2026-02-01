/**
 * Complete Enum Migration - Final Step
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function completeMigration() {
    console.log('Completing enum migration...\n');

    try {
        // Drop default value first
        console.log('Dropping default value...');
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "orders"
            ALTER COLUMN "fulfillmentState" DROP DEFAULT
        `);
        console.log('✓ Dropped default value\n');

        // Alter column to use new enum
        console.log('Updating column type...');
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "orders"
            ALTER COLUMN "fulfillmentState" TYPE "FulfillmentState_new"
            USING "fulfillmentState"::text::"FulfillmentState_new"
        `);
        console.log('✓ Updated column type\n');

        // Re-add default value
        console.log('Re-adding default value...');
        await prisma.$executeRawUnsafe(`
            ALTER TABLE "orders"
            ALTER COLUMN "fulfillmentState" SET DEFAULT 'PENDING'::"FulfillmentState_new"
        `);
        console.log('✓ Re-added default value\n');

        // Drop old enum and rename new one
        console.log('Replacing old enum...');
        await prisma.$executeRawUnsafe(`DROP TYPE "FulfillmentState"`);
        await prisma.$executeRawUnsafe(`ALTER TYPE "FulfillmentState_new" RENAME TO "FulfillmentState"`);
        console.log('✓ Replaced old enum\n');

        console.log('✅ Migration completed successfully!');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await prisma.$disconnect();
        await pool.end();
    }
}

completeMigration()
    .then(() => {
        console.log('\n✅ Script completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Script failed:', error);
        process.exit(1);
    });
