import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/app/(auth)/auth';
import { db } from '@/lib/db/index';
import { invoice } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

// Schema for the duplicate check request
const CheckDuplicateSchema = z.object({
  invoiceNumber: z.string().min(1),
  vendor: z.string().min(1),
  total: z.number().min(0)
});

export async function POST(request: Request) {
  try {
    const session = await auth();

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse the request body
    const body = await request.json();

    // Validate with schema
    const validationResult = CheckDuplicateSchema.safeParse(body);
    if (!validationResult.success) {
      console.error('Validation error:', validationResult.error);
      return NextResponse.json({
        error: 'Invalid request data',
        details: validationResult.error.errors
      }, { status: 400 });
    }

    const { invoiceNumber, vendor, total } = validationResult.data;

    // Convert total from dollars to cents for database comparison
    const totalCents = Math.round(total * 100);

    console.log(`Checking for duplicate invoice: ${invoiceNumber}, ${vendor}, ${totalCents} cents`);

    // Query the database for an invoice with the same number, vendor, and amount
    const duplicateInvoices = await db
      .select()
      .from(invoice)
      .where(
        and(
          eq(invoice.invoiceNumber, invoiceNumber),
          eq(invoice.vendorName, vendor),
          eq(invoice.amount, totalCents)
        )
      )
      .limit(1);

    const isDuplicate = duplicateInvoices.length > 0;
    console.log(`Duplicate check result: ${isDuplicate ? 'Duplicate found' : 'No duplicate found'}`);

    if (isDuplicate) {
      // Return the duplicate invoice data
      const duplicateInvoice = duplicateInvoices[0];
      return NextResponse.json({
        isDuplicate: true,
        invoice: {
          id: duplicateInvoice.id,
          invoiceNumber: duplicateInvoice.invoiceNumber,
          vendor: duplicateInvoice.vendorName,
          customer: duplicateInvoice.customerName,
          date: duplicateInvoice.invoiceDate,
          dueDate: duplicateInvoice.dueDate,
          total: (duplicateInvoice.amount ?? 0) / 100, // Convert cents to dollars with null check
          createdAt: duplicateInvoice.createdAt
        }
      });
    } else {
      return NextResponse.json({
        isDuplicate: false
      });
    }
  } catch (error) {
    console.error('Error checking for duplicate invoice:', error);
    return NextResponse.json({
      error: 'Server error checking for duplicate invoice',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}