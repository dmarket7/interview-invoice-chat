import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { invoice, lineItem } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

interface LineItem {
  id: string;
  invoiceId: string;
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
}

interface Invoice {
  id: string;
  customerName: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string | Date | null;
  dueDate: string | Date | null;
  amount: number | null;
  lineItems: LineItem[];
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string; }; }
) {
  try {
    const invoiceId = params.id;
    const data: Invoice = await request.json();

    // Ensure this invoice exists
    const existingInvoice = await db.select().from(invoice).where(eq(invoice.id, invoiceId));

    if (existingInvoice.length === 0) {
      return NextResponse.json(
        { error: 'Invoice not found' },
        { status: 404 }
      );
    }

    // Prepare invoice data for update
    const invoiceData = {
      customerName: data.customerName,
      vendorName: data.vendorName,
      invoiceNumber: data.invoiceNumber,
      invoiceDate: data.invoiceDate instanceof Date ? data.invoiceDate :
        typeof data.invoiceDate === 'string' ? new Date(data.invoiceDate) : null,
      dueDate: data.dueDate instanceof Date ? data.dueDate :
        typeof data.dueDate === 'string' ? new Date(data.dueDate) : null,
      amount: data.amount,
      updatedAt: new Date(),
    };

    // Update invoice
    await db.update(invoice)
      .set(invoiceData)
      .where(eq(invoice.id, invoiceId));

    // Update line items
    for (const item of data.lineItems) {
      await db.update(lineItem)
        .set({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.amount,
          updatedAt: new Date(),
        })
        .where(eq(lineItem.id, item.id));
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating invoice:', error);
    return NextResponse.json(
      { error: 'Failed to update invoice' },
      { status: 500 }
    );
  }
}