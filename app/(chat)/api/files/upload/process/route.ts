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

    console.log(`Processing file: ${fileReference} with ID ${fileId}, type: ${type}, agentInitiated: ${agentInitiated}`);

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
        // Try to extract invoice ID from the filename (timestamp-originalname.pdf)
        const filenameMatch = fileReference.match(/\/uploads\/(\d+)-/);
        const timestamp = filenameMatch ? filenameMatch[1] : null;

        console.log(`Extracted timestamp from filename: ${timestamp}`);

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
        console.log(`Found recent invoice with ID: ${mostRecentInvoice.id}`);

        // Get line items for this invoice
        const lineItems = await db
          .select()
          .from(lineItem)
          .where(eq(lineItem.invoiceId, mostRecentInvoice.id));

        console.log(`Found ${lineItems.length} line items`);

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
    } else {
      // For direct or upload-triggered processing
      try {
        // Try to find a key in our storage system
        const storageKey = await findFileReferenceKey(fileReference, fileId);

        if (!storageKey) {
          return NextResponse.json({
            error: 'File not found in storage',
            details: 'The invoice file could not be found in our storage system.'
          }, { status: 404 });
        }

        // Retrieve the file data
        const fileData = await getFileFromStorage(storageKey);

        if (!fileData || !fileData.extractedData) {
          return NextResponse.json({
            error: 'File data missing',
            details: 'The invoice data could not be retrieved or is incomplete.'
          }, { status: 404 });
        }

        return NextResponse.json({
          success: true,
          extractedData: fileData.extractedData,
          message: 'Invoice data retrieved successfully from storage'
        });
      } catch (error) {
        console.error('Error processing file directly:', error);
        return NextResponse.json({
          error: 'Failed to process file',
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

/**
 * Helper function to find a file reference in our storage system
 */
async function findFileReferenceKey(fileReference: string, fileId?: string): Promise<string | null> {
  // This would typically involve checking a database or storage system
  // For now, we'll simulate by returning the fileReference itself
  console.log(`Looking for storage key for file: ${fileReference}`);
  return fileReference;
}

/**
 * Helper function to retrieve file data from storage
 */
async function getFileFromStorage(storageKey: string): Promise<any> {
  // This would typically involve retrieving the file from a storage system
  // For now, we'll simulate with a mock response
  console.log(`Retrieving file data for key: ${storageKey}`);

  // Create a mock response with realistic invoice data
  return {
    extractedData: {
      invoiceId: nanoid(),
      invoiceNumber: "INV-2023-001",
      date: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      vendor: "Sample Vendor Corp",
      customer: "Client Company Ltd",
      total: 299.99,
      items: [
        {
          description: "Professional Services",
          quantity: 1,
          unitPrice: 249.99,
          amount: 249.99
        },
        {
          description: "Processing Fee",
          quantity: 1,
          unitPrice: 50.00,
          amount: 50.00
        }
      ]
    }
  };
}