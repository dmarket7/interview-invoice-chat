import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { invoice, lineItem } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
  try {
    // Fetch all invoices
    const invoices = await db.select().from(invoice);

    // For each invoice, fetch its line items
    const invoicesWithLineItems = await Promise.all(
      invoices.map(async (inv) => {
        const items = await db.select().from(lineItem).where(eq(lineItem.invoiceId, inv.id));

        return {
          ...inv,
          lineItems: items
        };
      })
    );

    return NextResponse.json(invoicesWithLineItems);
  } catch (error) {
    console.error('Error fetching invoices:', error);
    return NextResponse.json(
      { error: 'Failed to fetch invoices' },
      { status: 500 }
    );
  }
}