import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/app/(auth)/auth';
import { nanoid } from 'nanoid';
import { db } from '@/lib/db/index';
import { invoice, lineItem } from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';

// Schema for the process request
const ProcessRequestSchema = z.object({
  fileReference: z.string().min(1),
  fileId: z.string().optional(),
  type: z.enum(['invoice']),
  agentInitiated: z.optional(z.string()),
  purpose: z.optional(z.string())
});

export async function POST(request: Request) {
  try {
    const session = await auth();

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse the form data
    const formData = await request.formData();

    // Extract form fields
    const fileReference = formData.get('fileReference') as string;
    const fileId = formData.get('fileId') as string;
    const type = formData.get('type') as string;
    const agentInitiated = formData.get('agentInitiated') as string;
    const purpose = formData.get('purpose') as string || "Invoice data extraction"; // Default value if null


    // Validate with schema
    const validationResult = ProcessRequestSchema.safeParse({
      fileReference,
      fileId,
      type,
      agentInitiated,
      purpose
    });

    if (!validationResult.success) {
      console.error('Validation error:', validationResult.error);
      return NextResponse.json({
        error: 'Invalid request data',
        details: validationResult.error.errors
      }, { status: 400 });
    }

    // For agent-initiated requests, we try to retrieve already processed invoice data
    if (agentInitiated === 'true') {
      try {
        // Get the most recently created invoice (in case we don't have a timestamp)
        const invoiceRecords = await db
          .select()
          .from(invoice)
          .orderBy(desc(invoice.createdAt))
          .limit(1);

        if (invoiceRecords.length === 0) {
          return NextResponse.json({ error: 'No invoice found in database' }, { status: 404 });
        }

        const mostRecentInvoice = invoiceRecords[0];

        // Get line items for this invoice
        const lineItems = await db
          .select()
          .from(lineItem)
          .where(eq(lineItem.invoiceId, mostRecentInvoice.id));

        // Format the data for the response
        const invoiceData = {
          invoiceId: mostRecentInvoice.id,
          invoiceNumber: mostRecentInvoice.invoiceNumber,
          date: mostRecentInvoice.invoiceDate,
          dueDate: mostRecentInvoice.dueDate,
          vendor: mostRecentInvoice.vendorName,
          customer: mostRecentInvoice.customerName,
          total: (mostRecentInvoice.amount ?? 0) / 100, // Convert cents to dollars with null check
          items: lineItems.map(item => ({
            description: item.description,
            quantity: item.quantity ?? 1,
            unitPrice: (item.unitPrice ?? 0) / 100, // Convert cents to dollars with null check
            amount: (item.amount ?? 0) / 100 // Convert cents to dollars with null check
          }))
        };

        return NextResponse.json({
          success: true,
          extractedData: invoiceData,
          message: 'Invoice data retrieved successfully from database'
        });
      } catch (error) {
        console.error('Error retrieving invoice data:', error);
        return NextResponse.json({
          error: 'Failed to retrieve invoice data',
          details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
      }
    }
  } catch (error) {
    console.error('Error in process route:', error);
    return NextResponse.json({
      error: 'Server error processing request',
      details: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}
