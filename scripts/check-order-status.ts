import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const orderNumbers = [
  '15990', // Nitschke
  '15906', // Busse
  '15925', // Lehnert
  '15926', // Jung
  '15977', // Bothe
  '15978', // von Daake
  '15979', // Olavarria
  '15981', // Müller
  '15982', // Douglas
  '15984', // Fritsch
  '15986', // Hartnauer
  '15987', // Boudhan
  '15989', // Aufleger
];

interface OrderStatus {
  orderNumber: string;
  customerName: string;
  existsInDB: boolean;
  id?: number;
  platform?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  jtlFfnOrderId?: string | null;
  syncedToFFN: boolean;
  isOnHold?: boolean;
  holdReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  totalAmount?: number;
  itemCount?: number;
}

async function checkOrders() {
  console.log('🔍 Checking order status for specified orders...\n');

  const results: OrderStatus[] = [];

  for (const orderNum of orderNumbers) {
    try {
      // Try to find the order
      const order = await prisma.order.findFirst({
        where: {
          orderNumber: orderNum,
        },
        include: {
          items: true,
          client: {
            select: {
              name: true,
            },
          },
        },
      });

      if (!order) {
        // Order not found
        results.push({
          orderNumber: orderNum,
          customerName: 'Unknown',
          existsInDB: false,
          syncedToFFN: false,
        });
        console.log(`❌ Order ${orderNum}: NOT FOUND IN DATABASE`);
      } else {
        // Order found
        const syncedToFFN = !!(order.jtlFfnOrderId && order.jtlFfnOrderId.trim() !== '');

        results.push({
          orderNumber: orderNum,
          customerName: order.customerName || 'N/A',
          existsInDB: true,
          id: order.id,
          platform: order.platform || 'N/A',
          paymentStatus: order.paymentStatus || 'N/A',
          fulfillmentStatus: order.fulfillmentStatus || 'N/A',
          jtlFfnOrderId: order.jtlFfnOrderId,
          syncedToFFN,
          isOnHold: order.isOnHold || false,
          holdReason: order.holdReason,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          totalAmount: order.totalAmount ? parseFloat(order.totalAmount.toString()) : 0,
          itemCount: order.items?.length || 0,
        });

        console.log(`✅ Order ${orderNum}: FOUND - ${order.customerName} - Payment: ${order.paymentStatus} - FFN Synced: ${syncedToFFN ? 'YES' : 'NO'}`);
      }
    } catch (error) {
      console.error(`Error checking order ${orderNum}:`, error);
      results.push({
        orderNumber: orderNum,
        customerName: 'Error',
        existsInDB: false,
        syncedToFFN: false,
      });
    }
  }

  // Generate markdown report
  const markdown = generateMarkdownReport(results);

  // Write to file
  const reportPath = path.join(process.cwd(), 'ORDER_STATUS_REPORT.md');
  fs.writeFileSync(reportPath, markdown);

  console.log(`\n✅ Report generated: ${reportPath}`);

  return results;
}

function generateMarkdownReport(results: OrderStatus[]): string {
  const timestamp = new Date().toISOString();

  let md = `# Order Status Report\n\n`;
  md += `**Generated:** ${timestamp}\n\n`;
  md += `**Total Orders Checked:** ${results.length}\n`;
  md += `**Found in Database:** ${results.filter(r => r.existsInDB).length}\n`;
  md += `**Not Found:** ${results.filter(r => !r.existsInDB).length}\n`;
  md += `**Synced to JTL FFN:** ${results.filter(r => r.syncedToFFN).length}\n`;
  md += `**On Hold:** ${results.filter(r => r.isOnHold).length}\n\n`;

  md += `---\n\n`;

  // Summary table
  md += `## Summary Table\n\n`;
  md += `| Order # | Customer | In DB | Payment Status | FFN Synced | On Hold | FFN Order ID |\n`;
  md += `|---------|----------|-------|----------------|------------|---------|-------------|\n`;

  for (const result of results) {
    const inDB = result.existsInDB ? '✅' : '❌';
    const payment = result.paymentStatus || 'N/A';
    const ffnSynced = result.syncedToFFN ? '✅' : '❌';
    const onHold = result.isOnHold ? '⚠️ YES' : 'No';
    const ffnId = result.jtlFfnOrderId || 'N/A';

    md += `| ${result.orderNumber} | ${result.customerName} | ${inDB} | ${payment} | ${ffnSynced} | ${onHold} | ${ffnId} |\n`;
  }

  md += `\n---\n\n`;

  // Detailed breakdown
  md += `## Detailed Breakdown\n\n`;

  for (const result of results) {
    md += `### Order #${result.orderNumber} - ${result.customerName}\n\n`;

    if (!result.existsInDB) {
      md += `**Status:** ❌ NOT FOUND IN DATABASE\n\n`;
      md += `---\n\n`;
      continue;
    }

    md += `**Status:** ✅ Found in Database\n\n`;
    md += `**Details:**\n`;
    md += `- **Database ID:** ${result.id}\n`;
    md += `- **Platform:** ${result.platform}\n`;
    md += `- **Payment Status:** ${result.paymentStatus}\n`;
    md += `- **Fulfillment Status:** ${result.fulfillmentStatus}\n`;
    md += `- **Total Amount:** €${result.totalAmount?.toFixed(2) || '0.00'}\n`;
    md += `- **Items Count:** ${result.itemCount}\n`;
    md += `- **Created:** ${result.createdAt?.toISOString() || 'N/A'}\n`;
    md += `- **Updated:** ${result.updatedAt?.toISOString() || 'N/A'}\n\n`;

    md += `**JTL FFN Sync Status:**\n`;
    if (result.syncedToFFN) {
      md += `- ✅ **Synced to FFN**\n`;
      md += `- **FFN Order ID:** ${result.jtlFfnOrderId}\n`;
    } else {
      md += `- ❌ **NOT Synced to FFN**\n`;
      md += `- **FFN Order ID:** None\n`;
    }
    md += `\n`;

    md += `**Hold Status:**\n`;
    if (result.isOnHold) {
      md += `- ⚠️ **ON HOLD**\n`;
      md += `- **Hold Reason:** ${result.holdReason || 'Not specified'}\n`;
    } else {
      md += `- ✅ **Not on hold**\n`;
    }
    md += `\n`;

    md += `---\n\n`;
  }

  // Issues section
  md += `## Issues Identified\n\n`;

  const notFound = results.filter(r => !r.existsInDB);
  const unpaidButSynced = results.filter(r =>
    r.existsInDB &&
    r.syncedToFFN &&
    r.paymentStatus &&
    !['paid', 'completed', 'processing', 'refunded', 'partially_refunded', 'authorized', 'partially_paid'].includes(r.paymentStatus.toLowerCase())
  );
  const paidButNotSynced = results.filter(r =>
    r.existsInDB &&
    !r.syncedToFFN &&
    r.paymentStatus &&
    ['paid', 'completed', 'processing', 'authorized', 'partially_paid'].includes(r.paymentStatus.toLowerCase()) &&
    !r.isOnHold
  );
  const onHoldOrders = results.filter(r => r.isOnHold);

  if (notFound.length > 0) {
    md += `### ❌ Orders Not Found in Database (${notFound.length})\n\n`;
    for (const order of notFound) {
      md += `- Order #${order.orderNumber}\n`;
    }
    md += `\n`;
  }

  if (unpaidButSynced.length > 0) {
    md += `### ⚠️ Unpaid Orders Synced to FFN (${unpaidButSynced.length})\n\n`;
    md += `**This should NOT happen - these orders may need investigation**\n\n`;
    for (const order of unpaidButSynced) {
      md += `- Order #${order.orderNumber} - Payment Status: ${order.paymentStatus} - FFN ID: ${order.jtlFfnOrderId}\n`;
    }
    md += `\n`;
  }

  if (paidButNotSynced.length > 0) {
    md += `### ⚠️ Paid Orders NOT Synced to FFN (${paidButNotSynced.length})\n\n`;
    for (const order of paidButNotSynced) {
      md += `- Order #${order.orderNumber} - Payment Status: ${order.paymentStatus}\n`;
    }
    md += `\n`;
  }

  if (onHoldOrders.length > 0) {
    md += `### ⏸️ Orders On Hold (${onHoldOrders.length})\n\n`;
    for (const order of onHoldOrders) {
      md += `- Order #${order.orderNumber} - Reason: ${order.holdReason || 'Not specified'}\n`;
    }
    md += `\n`;
  }

  if (notFound.length === 0 && unpaidButSynced.length === 0 && paidButNotSynced.length === 0 && onHoldOrders.length === 0) {
    md += `✅ No critical issues identified.\n\n`;
  }

  return md;
}

async function main() {
  try {
    await checkOrders();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
