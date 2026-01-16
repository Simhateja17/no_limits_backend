import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function cleanTables() {
  try {
    console.log('Starting database cleanup...\n');

    // Delete Returns (cascade will handle ReturnItems, ReturnImages, ReturnItemImages)
    console.log('Deleting all returns...');
    const deletedReturns = await prisma.return.deleteMany();
    console.log(`✓ Deleted ${deletedReturns.count} returns\n`);

    // Delete Orders (cascade will handle OrderItems)
    console.log('Deleting all orders...');
    const deletedOrders = await prisma.order.deleteMany();
    console.log(`✓ Deleted ${deletedOrders.count} orders\n`);

    // Delete Products (cascade will handle ProductImages, ProductChannels)
    console.log('Deleting all products...');
    const deletedProducts = await prisma.product.deleteMany();
    console.log(`✓ Deleted ${deletedProducts.count} products\n`);

    // Verify tables are empty
    console.log('Verifying tables are empty...');
    const returnsCount = await prisma.return.count();
    const ordersCount = await prisma.order.count();
    const productsCount = await prisma.product.count();

    console.log(`Returns remaining: ${returnsCount}`);
    console.log(`Orders remaining: ${ordersCount}`);
    console.log(`Products remaining: ${productsCount}`);

    if (returnsCount === 0 && ordersCount === 0 && productsCount === 0) {
      console.log('\n✓ All tables successfully cleaned!');
    } else {
      console.log('\n⚠ Warning: Some records still remain');
    }

  } catch (error) {
    console.error('Error cleaning tables:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

cleanTables()
  .then(() => {
    console.log('\nCleanup completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Cleanup failed:', error);
    process.exit(1);
  });
