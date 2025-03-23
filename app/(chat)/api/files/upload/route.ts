import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/app/(auth)/auth';
import { db } from '@/lib/db/index';
import { invoice, lineItem } from '@/lib/db/schema';
import { nanoid } from 'nanoid';

// Use Blob instead of File since File is not available in Node.js environment
const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 5 * 1024 * 1024, {
      message: 'File size should be less than 5MB',
    })
    // Update the file type based on the kind of files you want to accept
    .refine((file) => ['image/jpeg', 'image/png', 'application/pdf'].includes(file.type), {
      message: 'File type should be JPEG, PNG, or PDF',
    }),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (request.body === null) {
    return new Response('Request body is empty', { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as Blob;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(', ');

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // Check document type before processing
    const documentType = formData.get('type');
    if (documentType === 'invoice') {
      try {
        // First validate that this is likely an invoice document type
        const isLikelyInvoice = await preliminaryDocumentTypeCheck(file);
        if (!isLikelyInvoice) {
          // Convert file to buffer for response
          const fileBuffer = await file.arrayBuffer();
          const buffer = Buffer.from(fileBuffer);

          // Get filename safely
          const filename = formData.get('file') instanceof File
            ? (formData.get('file') as File).name
            : 'unknown-file';

          const dataURL = `data:${file.type};base64,${buffer.toString('base64')}`;

          // Return a successful response but with isStatement flag instead of an error
          return NextResponse.json({
            url: dataURL,
            contentType: file.type,
            isStatement: true,
            message: "This document appears to be an account statement or receipt, not an invoice.",
            details: "Please upload a valid invoice document. Account statements, receipts, and other financial documents are not supported.",
            agentResponse: "This document appears to be an account statement or receipt, not an invoice. Please upload a valid invoice document. Account statements, receipts, and other financial documents are not supported."
          });
        }
      } catch (error) {
        console.error("Document type check failed, proceeding with main validation:", error);
        // Continue without failing - we'll rely on the main validation
      }
    }

    // Get filename from formData since Blob doesn't have name property
    const filename = (formData.get('file') as File).name;
    const fileBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(fileBuffer);

    try {
      // Generate unique filename with timestamp
      const timestamp = Date.now();
      const uniqueFilename = `${timestamp}-${filename}`;

      // If it's a PDF invoice, process it
      if (file.type === 'application/pdf' && formData.get('type') === 'invoice') {

        try {
          const extractedData = await extractInvoiceData(buffer);
          const dataURL = `data:${file.type};base64,${buffer.toString('base64')}`;

          // Validate that this is actually an invoice document
          const isInvoice = validateIsInvoice(extractedData);
          if (!isInvoice) {
            return NextResponse.json({
              url: dataURL,
              contentType: file.type,
              isStatement: true,
              message: "The uploaded document doesn't appear to be an invoice. Please upload a valid invoice document.",
              details: "We couldn't find key invoice information such as invoice number, line items, or total amount.",
              agentResponse: "The uploaded document doesn't appear to be an invoice. Please upload a valid invoice document. We couldn't find key invoice information such as invoice number, line items, or total amount."
            });
          }

          // Save invoice to database
          const now = new Date();

          // Ensure we always have a valid invoiceDate - critical fix
          let invoiceDate = now; // Default to current date
          try {
            // Handle different date formats
            if (typeof extractedData.date === 'string') {
              const dateStr = extractedData.date;
              // Try DD/MM/YYYY or MM/DD/YYYY
              const parts = dateStr.split(/[-\/\.]/);
              if (parts.length === 3) {
                // Try to parse the date in multiple formats
                try {
                  // Try MM/DD/YYYY format
                  if (Number.parseInt(parts[0]) <= 12) {
                    const dateCandidate = new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
                    if (!Number.isNaN(dateCandidate.getTime())) {
                      invoiceDate = dateCandidate;
                    }
                  } else {
                    // Try DD/MM/YYYY format
                    const dateCandidate = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
                    if (!Number.isNaN(dateCandidate.getTime())) {
                      invoiceDate = dateCandidate;
                    }
                  }
                } catch (innerError) {
                  console.error('Inner date parsing error:', innerError);
                  // Keep using the default date
                }
              }
            }
          } catch (e) {
            console.error('Error parsing invoice date:', e);
            // Keep default date if parsing fails
          }

          // Ensure we have a valid date at this point
          if (!invoiceDate || Number.isNaN(invoiceDate.getTime())) {
            console.warn('Invalid invoice date detected, using current date instead');
            invoiceDate = now;
          }

          let dueDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // Default to 30 days from now
          try {
            if (typeof extractedData.dueDate === 'string') {
              const dueDateStr = extractedData.dueDate;
              const parts = dueDateStr.split(/[-\/\.]/);
              if (parts.length === 3) {
                // Try to parse the date in multiple formats
                try {
                  // Try MM/DD/YYYY format
                  if (Number.parseInt(parts[0]) <= 12) {
                    const dateCandidate = new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
                    if (!Number.isNaN(dateCandidate.getTime())) {
                      dueDate = dateCandidate;
                    }
                  } else {
                    // Try DD/MM/YYYY format
                    const dateCandidate = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
                    if (!Number.isNaN(dateCandidate.getTime())) {
                      dueDate = dateCandidate;
                    }
                  }
                } catch (innerError) {
                  console.error('Inner due date parsing error:', innerError);
                  // Keep using the default date
                }
              }
            }
          } catch (e) {
            console.error('Error parsing due date:', e);
            // Keep default due date if parsing fails
          }

          // Ensure we have a valid due date
          if (!dueDate || Number.isNaN(dueDate.getTime())) {
            console.warn('Invalid due date detected, using default 30 days from now');
            dueDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          }

          // Convert amount to cents for database storage
          const totalAmountCents = Math.round(extractedData.total * 100);

          // Check for duplicate invoice before saving
          try {
            const duplicateCheckResponse = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/invoices/check-duplicate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // Pass auth token to ensure the request is authorized
                'Cookie': request.headers.get('cookie') || ''
              },
              body: JSON.stringify({
                invoiceNumber: extractedData.invoiceNumber,
                vendor: extractedData.vendor,
                total: extractedData.total
              })
            });

            const duplicateCheck = await duplicateCheckResponse.json();

            if (duplicateCheck.isDuplicate) {
              // Convert the extracted data to CSV format for sheet block (still needed for UI)
              const csvData = convertToCSV(extractedData);

              // Get the base URL from environment variables or use an empty string as fallback
              const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';

              // Return response indicating duplicate
              return NextResponse.json({
                isDuplicate: true,
                duplicateInvoice: duplicateCheck.invoice,
                url: `${BASE_URL}/api/invoices/${duplicateCheck.invoice.id}`,
                pathname: `/uploads/${uniqueFilename}`,
                contentType: file.type,
                isInvoice: true,
                invoiceId: duplicateCheck.invoice.id,
                extractedData: extractedData,
                csvData: csvData,
                documentTitle: `Invoice: ${extractedData.invoiceNumber || uniqueFilename}`,
                message: `This invoice has already been processed. An invoice with the same invoice number (${extractedData.invoiceNumber}), vendor (${extractedData.vendor}), and amount (${extractedData.total}) already exists in the system.`
              });
            }
          } catch (duplicateError) {
            console.error('Error checking for duplicate invoice:', duplicateError);
            // Continue with processing even if duplicate check fails
          }

          // Generate unique ID for invoice
          const invoiceId = nanoid();

          // Insert invoice record
          await db.insert(invoice).values({
            id: invoiceId,
            customerName: extractedData.customer,
            vendorName: extractedData.vendor,
            invoiceNumber: extractedData.invoiceNumber,
            invoiceDate: invoiceDate,
            dueDate: dueDate,
            amount: totalAmountCents,
            createdAt: now,
            updatedAt: now
          });

          // Insert line items
          if (extractedData.items && Array.isArray(extractedData.items)) {
            for (const item of extractedData.items) {
              // Skip items with zero amount
              if (item.amount === 0) continue;

              const unitPriceCents = Math.round(item.unitPrice * 100);
              const amountCents = Math.round(item.amount * 100);

              await db.insert(lineItem).values({
                id: nanoid(),
                invoiceId: invoiceId,
                description: item.description,
                quantity: item.quantity,
                unitPrice: unitPriceCents,
                amount: amountCents,
                createdAt: now,
                updatedAt: now
              });
            }
          }

          // Convert the extracted data to CSV format for sheet block
          const csvData = convertToCSV(extractedData);

          // Get the base URL from environment variables or use an empty string as fallback
          const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || '';

          // Ensure extractedText is defined
          const extractedText = extractedData.extractionMethods ?
            `Invoice processed using: ${extractedData.extractionMethods.join(', ')}.\n\n` +
            `Invoice Number: ${extractedData.invoiceNumber}\n` +
            `Date: ${extractedData.date}\n` +
            `Due Date: ${extractedData.dueDate}\n` +
            `Vendor: ${extractedData.vendor}\n` +
            `Customer: ${extractedData.customer}\n` +
            `Total: ${extractedData.total}`
            : '';

          return NextResponse.json({
            url: `${BASE_URL}/api/invoices/${invoiceId}`,
            pathname: `/uploads/${uniqueFilename}`,
            contentType: file.type,
            isInvoice: true,
            invoiceId,
            extractedText: extractedText,
            extractedData: extractedData,
            csvData: csvData,
            documentTitle: `Invoice: ${extractedData.invoiceNumber || uniqueFilename}`
          });
        } catch (invoiceError: any) {
          console.error('Invoice processing error:', invoiceError);
          return NextResponse.json({
            error: `Invoice processing failed: ${invoiceError.message || 'Unknown error'}`,
            url: `data:${file.type};base64,${buffer.toString('base64')}`,
            pathname: `/uploads/${uniqueFilename}`,
            contentType: file.type
          }, { status: 422 });
        }
      }

      // Create data URL for immediate preview
      const dataURL = `data:${file.type};base64,${buffer.toString('base64')}`;

      return NextResponse.json({
        url: dataURL,
        pathname: `/uploads/${uniqueFilename}`,
        contentType: file.type
      });
    } catch (uploadError: any) {
      console.error('Upload processing error:', uploadError);
      return NextResponse.json({
        error: `Upload failed: ${uploadError.message || 'Unknown error'}`
      }, { status: 500 });
    }
  } catch (requestError: any) {
    console.error('Request processing error:', requestError);
    return NextResponse.json(
      { error: `Failed to process request: ${requestError.message || 'Unknown error'}` },
      { status: 500 },
    );
  }
}

// Helper function to extract invoice data using regex patterns
function extractInvoiceDataWithRegex(text: string) {
  // Replace newlines with spaces in the text for better pattern matching
  // but keep a version with newlines for line-by-line operations
  const flatText = text.replace(/\n/g, ' ');

  // Create a confidence scoring system
  const confidence = {
    invoiceNumber: 0,
    date: 0,
    dueDate: 0,
    vendor: 0,
    customer: 0,
    items: 0,
    total: 0
  };

  // Enhanced invoice number detection
  const invoiceNumPatterns = [
    { pattern: /(?:Invoice|INV)(?:[\s#]*|[^\d\w]*)([\w\d]+-?[\w\d]+)/i, score: 0.9 },
    { pattern: /(?:Invoice|Bill|Receipt)(?:\s+Number)?[\s:]*([A-Z0-9][\w\d-]+)/i, score: 0.8 },
    { pattern: /(?:No|Number|#)\s*:?\s*([A-Z0-9][\w\d-]{2,})/i, score: 0.7 },
    { pattern: /([A-Z]{2,}[0-9]{4,})/, score: 0.6 }
  ];

  let invoiceNumber = 'Unknown';
  for (const { pattern, score } of invoiceNumPatterns) {
    const match = flatText.match(pattern);
    if (match?.[1]) {
      invoiceNumber = match[1];
      confidence.invoiceNumber = score;
      break;
    }
  }

  // Enhanced date detection with more formats
  const datePatterns = [
    { pattern: /(?:Date|Issued|Invoice Date)(?:\s*:|of)?(?:\s*)(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i, score: 0.9 },
    { pattern: /(?:Date|Issued|Invoice Date)(?:\s*:|of)?(?:\s*)(\d{2,4}[-\/\.]\d{1,2}[-\/\.]\d{1,2})/i, score: 0.8 },
    { pattern: /(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/, score: 0.7 },
    { pattern: /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i, score: 0.9 },
    { pattern: /\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}/i, score: 0.9 }
  ];

  let date = new Date().toISOString().split('T')[0]; // Default to today
  for (const { pattern, score } of datePatterns) {
    const match = flatText.match(pattern);
    if (match?.[1]) {
      date = match[1];
      confidence.date = score;
      break;
    }
  }

  // Enhanced due date detection with clearer pattern identification
  const dueDatePatterns = [
    { pattern: /(?:Due|Payment)\s*Date\s*:?\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i, score: 0.9 },
    { pattern: /(?:Due|Payment)\s*:?\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i, score: 0.8 },
    { pattern: /(?:Due|Payment)(?:\s*on|by)\s*:?\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i, score: 0.8 },
    { pattern: /(?:Terms|Net)\s*:?\s*(\d{1,3})\s*days/, score: 0.7 } // For "Net 30 days" type terms
  ];

  let dueDate = '';
  let netDays = 0;

  for (const { pattern, score } of dueDatePatterns) {
    const match = flatText.match(pattern);
    if (match?.[1]) {
      // Check if this is a "Net X days" format
      if (pattern.toString().includes('Net')) {
        netDays = Number.parseInt(match[1]);
        confidence.dueDate = score;
      } else {
        dueDate = match[1];
        confidence.dueDate = score;
        break;
      }
    }
  }

  // If we found a "Net X days" but no explicit due date, calculate it
  if (!dueDate && netDays > 0) {
    try {
      // Parse the invoice date and add net days
      const dateObj = new Date(date);
      if (!Number.isNaN(dateObj.getTime())) {
        dateObj.setDate(dateObj.getDate() + netDays);
        dueDate = dateObj.toISOString().split('T')[0];
      }
    } catch (e) {
      console.error('Error calculating due date from Net days:', e);
    }
  }

  if (!dueDate) {
    // Default to 30 days from the invoice date if possible
    dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  }

  // Enhanced vendor detection with context-aware patterns
  const vendorPatterns = [
    { pattern: /(?:From|Vendor|Supplier|Company|Billed From|Sold By):\s*([^\n\.]+?)(?:\.|,|Inc|LLC|LTD|$)/i, score: 0.9 },
    { pattern: /(?:BILL FROM|FROM)[\s:]*([A-Z][^\n\.]{3,}?)(?:\.|,|Inc|LLC|LTD|$)/i, score: 0.8 },
    { pattern: /^([A-Z][a-zA-Z ]{2,}(?:Inc|LLC|Ltd|Corp|Company)?)\s/, score: 0.7 } // Header company pattern
  ];

  let vendor = '';
  // Try to extract the company name from the beginning of the document
  const firstLines = text.split('\n').slice(0, 5).join(' ');
  const firstLineMatch = firstLines.match(/^([A-Z][a-zA-Z ]{2,}(?:Inc|LLC|Ltd|Corp|Company)?)\s/);

  if (firstLineMatch) {
    vendor = firstLineMatch[1];
    confidence.vendor = 0.7;
  } else {
    // Try the patterns
    for (const { pattern, score } of vendorPatterns) {
      const match = flatText.match(pattern);
      if (match?.[1] && match[1].length > 3) {
        vendor = match[1].trim();
        confidence.vendor = score;
        break;
      }
    }
  }

  if (!vendor) vendor = 'Unknown Vendor';

  // Enhanced customer detection with more context sensitivity
  const customerPatterns = [
    { pattern: /(?:To|Bill To|Customer|Client|Ship To):\s*([^\n\.]+?)(?:\.|,|Inc|LLC|LTD|$)/i, score: 0.9 },
    { pattern: /(?:BILL TO|TO|SHIP TO)[\s:]*([A-Z][^\n\.]{3,}?)(?:\.|,|Inc|LLC|LTD|$)/i, score: 0.8 },
    { pattern: /Customer(?:[^:]*):(.+?)(?:\n|$)/, score: 0.7 },
    { pattern: /Attention:(.+?)(?:\n|$)/, score: 0.6 }
  ];

  let customer = '';
  for (const { pattern, score } of customerPatterns) {
    const match = flatText.match(pattern);
    if (match?.[1] && match[1].length > 3) {
      customer = match[1].trim();
      confidence.customer = score;
      break;
    }
  }

  if (!customer) customer = 'Unknown Customer';

  // Extract items, subtotal, tax and total with improved patterns
  const items = extractItemsFromText(text);
  confidence.items = items.length > 0 ? 0.8 : 0;

  const subtotal = extractAmountFromText(text, 'Subtotal');
  const tax = extractAmountFromText(text, 'Tax');
  let total = extractAmountFromText(text, 'Total');

  // If total wasn't found with "Total", try other variations
  if (total === 0) {
    const totalVariants = [
      { label: 'Amount Due', score: 0.9 },
      { label: 'Balance Due', score: 0.9 },
      { label: 'Grand Total', score: 0.9 },
      { label: 'Amount', score: 0.7 },
      { label: 'Balance', score: 0.7 },
      { label: 'Due', score: 0.6 }
    ];

    for (const { label, score } of totalVariants) {
      const amount = extractAmountFromText(text, label);
      if (amount > 0) {
        total = amount;
        confidence.total = score;
        break;
      }
    }

    // If still not found, try to find the largest dollar amount
    if (total === 0) {
      total = findLargestAmount(text);
      confidence.total = 0.5; // Lower confidence for this method
    }
  } else {
    confidence.total = 0.9; // High confidence if "Total" label was found
  }

  // Calculate line item total for validation
  const itemsTotal = items.reduce((sum, item) => sum + item.amount, 0);

  // If line items don't add up to total (with tolerance for rounding)
  if (items.length > 0 && Math.abs(itemsTotal - total) > 1) {
    // If the discrepancy is small relative to the total, adjust the total to match items
    if (Math.abs(itemsTotal - total) / total < 0.2 || confidence.items > confidence.total) {
      total = Number.parseFloat(itemsTotal.toFixed(2));
    }
    // Otherwise, we keep the extracted total as it's likely more reliable
  }

  return {
    invoiceNumber,
    date,
    dueDate,
    vendor,
    customer,
    items,
    subtotal,
    tax,
    total
  };
}

// Helper function to find the largest dollar amount in text
function findLargestAmount(text: string): number {
  // Look for currency amounts like $1,234.56
  const amountRegex = /[$€£][ ]?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
  let largestAmount = 0;
  let match;

  while ((match = amountRegex.exec(text)) !== null) {
    const amount = Number.parseFloat(match[1].replace(/,/g, ''));
    if (!Number.isNaN(amount) && amount > largestAmount) {
      largestAmount = amount;
    }
  }

  return largestAmount;
}

// Helper function to extract data from PDF invoices
async function extractInvoiceData(buffer: Buffer) {
  try {
    // Determine file type and choose appropriate strategies
    const fileSignature = buffer.slice(0, 4).toString('hex');
    const isPDF = fileSignature.startsWith('25504446'); // %PDF
    const isJPEG = fileSignature.startsWith('ffd8ff');
    const isPNG = fileSignature.startsWith('89504e47');

    // Store results from different extraction methods for comparison
    const extractionResults: any[] = [];

    // First try Gemini Vision if API key is available
    if (process.env.GEMINI_API_KEY) {
      try {
        console.log('Attempting extraction with Gemini Vision...');
        const geminiData = await processWithGeminiVision(buffer, isPDF ? 'application/pdf' : (isJPEG ? 'image/jpeg' : 'image/png'));
        if (geminiData) {
          console.log('Successfully extracted data with Gemini Vision');
          extractionResults.push({
            method: 'gemini',
            confidence: 0.9, // Generally high confidence for vision models
            data: geminiData
          });

          // If we're processing an image and got good results from Gemini, we can return it immediately
          // as image-based extraction is Gemini's strength
          if ((isJPEG || isPNG) && geminiData.items && geminiData.items.length > 0 && geminiData.total > 0) {
            return geminiData;
          }
        }
      } catch (geminiError) {
        console.error('Gemini Vision extraction failed:', geminiError);
        // Continue with other methods
      }
    }

    // For PDFs, use PDF.js extraction
    let extractedText = '';
    if (isPDF) {
      // First try Gemini Vision if API key is available - if successful, skip PDF.js
      if (extractionResults.length > 0 &&
        extractionResults[0].method === 'gemini' &&
        extractionResults[0].data.items &&
        extractionResults[0].data.items.length > 0 &&
        extractionResults[0].data.total > 0) {
      } else {
        // Only attempt PDF.js if Gemini wasn't successful
        try {
          const pdfjs = require('pdfjs-dist');

          // Skip PDF.js in serverless environment to avoid worker issues
          if (typeof window === 'undefined') {
            extractedText = ''; // Skip PDF.js in server environment
          } else {
            // Only use PDF.js in browser environment where worker is available
            pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

            // Create a new promise to handle PDF extraction
            const pdfData = await new Promise((resolve, reject) => {
              // Create temporary Uint8Array from buffer
              const data = new Uint8Array(buffer);

              // Use PDF.js to load and parse the document
              pdfjs.getDocument(data).promise
                .then(async (pdf: any) => {
                  let extractedText = '';

                  // Get total number of pages
                  const numPages = pdf.numPages;

                  // Extract text from each page
                  for (let i = 1; i <= numPages; i++) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent();
                    const strings = content.items.map((item: { str: string; }) => item.str);
                    extractedText += `${strings.join(' ')}\n`;
                  }

                  resolve(extractedText);
                })
                .catch((error: Error) => {
                  console.error('PDF.js extraction failed:', error);
                  resolve(''); // Resolve with empty string to allow fallback methods
                });
            });

            // Check if we got text from PDF.js
            if (pdfData && typeof pdfData === 'string' && pdfData.length > 100) {
              extractedText = pdfData;
            }
          }
        } catch (error) {
          console.error('Error extracting PDF with PDF.js:', error);
          extractedText = ''; // Fallback to OCR
        }
      }
    }

    // For images or if PDF extraction didn't yield enough text, try OCR
    if ((isJPEG || isPNG || extractedText.length < 100) && (!extractionResults.length || extractionResults[0].data.items.length === 0)) {
      // Skip OCR for now and rely on other methods
      extractedText = ""; // Force to use regex as fallback
    }

    // If we have sufficient text, process it with OpenAI or regex
    if (extractedText.length >= 100) {
      if (process.env.OPENAI_API_KEY) {
        try {
          const openaiData = await processExtractedText(extractedText);
          extractionResults.push({
            method: 'openai',
            confidence: 0.85, // High confidence but less than vision for invoices
            data: openaiData
          });
        } catch (openaiError) {
          console.error('OpenAI extraction failed:', openaiError);
        }
      }

      // Always do regex as a fallback or comparison
      try {
        const regexData = extractInvoiceDataWithRegex(extractedText);
        extractionResults.push({
          method: 'regex',
          confidence: 0.7, // Lower confidence than ML methods
          data: regexData
        });
      } catch (regexError) {
        console.error('Regex extraction failed:', regexError);
      }
    }

    // If we have multiple results, merge them for better accuracy
    if (extractionResults.length > 1) {
      return mergeExtractionResults(extractionResults);
    } else if (extractionResults.length === 1) {
      return extractionResults[0].data;
    }

    // If all extraction methods fail, return a basic structure
    return {
      invoiceNumber: 'Unknown',
      date: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      vendor: 'Unknown Vendor',
      customer: 'Unknown Customer',
      items: [{ description: 'Unable to extract items', quantity: 1, unitPrice: 0, amount: 0 }],
      subtotal: 0,
      tax: 0,
      total: 0
    };
  } catch (error) {
    console.error('Error extracting invoice data:', error);
    throw new Error('Failed to extract invoice data');
  }
}

// New function to process invoice with Gemini Vision
async function processWithGeminiVision(buffer: Buffer, mimeType = 'application/pdf') {
  const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

  // Initialize the Gemini API
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  // Prepare the model - Updated model name to the current supported version
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash", // Changed from "gemini-pro-vision" to "gemini-1.5-flash" per deprecation notice
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 1,
      topK: 32,
    },
  });

  // Convert buffer to base64
  const base64Image = buffer.toString('base64');

  // Prepare the content parts
  const parts = [
    {
      text: `You are an expert invoice data extractor. Please analyze this invoice image carefully and extract the following information with high precision:
1. Invoice Number
2. Date
3. Due Date
4. Vendor Name (company that issued the invoice)
5. Customer Name (company that received the invoice)
6. Line Items (with description, quantity, unit price, and amount for each)
7. Subtotal
8. Tax
9. Total Amount

Format your response strictly as a valid JSON object with these exact fields:
{
  "invoiceNumber": "string",
  "date": "MM/DD/YYYY",
  "dueDate": "MM/DD/YYYY",
  "vendor": "string",
  "customer": "string",
  "items": [
    {
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "amount": number
    }
  ],
  "subtotal": number,
  "tax": number,
  "total": number
}

Ensure all numeric values are properly parsed as numbers, not strings. For fields you can't determine, use reasonable default values. If the line items are not clearly visible, provide your best estimate based on other invoice information. Return ONLY the JSON with no additional text.`,
    },
    {
      inlineData: {
        mimeType: mimeType,
        data: base64Image
      }
    }
  ];

  try {
    // Generate content
    const result = await model.generateContent({
      contents: [{ role: "user", parts }],
    });

    const responseText = result.response.text();

    // Extract JSON from response (in case there's additional text)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No valid JSON found in Gemini response");
    }

    // Parse the JSON data
    const extractedData = JSON.parse(jsonMatch[0]);

    // Validate and normalize the data
    return validateInvoiceData(extractedData);
  } catch (error) {
    console.error("Error extracting data with Gemini:", error);
    throw error;
  }
}

// Function to merge results from different extraction methods
function mergeExtractionResults(results: Array<{ method: string, confidence: number, data: any; }>) {
  // Sort results by confidence (highest first)
  results.sort((a, b) => b.confidence - a.confidence);

  // Start with the highest confidence result
  const merged = { ...results[0].data };

  // Track which methods were used
  const usedMethods = [results[0].method];

  // Helper function to determine if a value is empty or default
  const isEmptyOrDefault = (value: any, field: string) => {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string' && (value === '' || value === 'Unknown' || value.includes('Unknown'))) return true;
    if (field === 'total' && value === 0) return true;
    if (field === 'items' && (value.length === 0 || (value.length === 1 && value[0].description.includes('Unable to extract')))) return true;
    return false;
  };

  // Merge fields from other results if they're better
  for (let i = 1; i < results.length; i++) {
    const result = results[i].data;
    let methodUsed = false;

    // For each field, consider using the alternative value if current is empty/default
    Object.keys(result).forEach(field => {
      if (isEmptyOrDefault(merged[field], field) && !isEmptyOrDefault(result[field], field)) {
        merged[field] = result[field];
        methodUsed = true;
      }

      // Special case for line items - use the one with more items if current has none or few
      if (field === 'items' &&
        Array.isArray(merged.items) &&
        Array.isArray(result.items) &&
        result.items.length > merged.items.length &&
        merged.items.length <= 1) {
        merged.items = result.items;
        methodUsed = true;
      }
    });

    if (methodUsed && !usedMethods.includes(results[i].method)) {
      usedMethods.push(results[i].method);
    }
  }

  // Add extraction methods to the result
  merged.extractionMethods = usedMethods;

  // Validate the merged data to ensure numerical consistency
  return validateInvoiceData(merged);
}

// Helper function to process extracted text with OpenAI or fallback to regex
async function processExtractedText(extractedText: string) {
  // Use the latest OpenAI SDK
  const OpenAI = require('openai');
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  if (!process.env.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY is not set. Using fallback extraction method.');
    return extractInvoiceDataWithRegex(extractedText);
  }

  try {
    // Prompt the LLM to extract invoice data - upgraded to GPT-4 for better accuracy
    const response = await openai.chat.completions.create({
      model: "gpt-4", // Upgraded from GPT-3.5-turbo to GPT-4 for better accuracy
      messages: [
        {
          role: "system",
          content: `You are an invoice data extraction expert. Extract the requested information from the invoice text with high precision.

Expected output format:
{
  "invoiceNumber": "INV12345",
  "date": "MM/DD/YYYY",
  "dueDate": "MM/DD/YYYY",
  "vendor": "Vendor Name",
  "customer": "Customer Name",
  "items": [
    {
      "description": "Item description",
      "quantity": 2,
      "unitPrice": 100.00,
      "amount": 200.00
    }
  ],
  "subtotal": 200.00,
  "tax": 20.00,
  "total": 220.00
}

Ensure all numeric values are properly parsed as numbers, not strings. Carefully extract line items by identifying tabular data in the invoice. If you can't determine a specific field, provide reasonable default values with a confidence indication.`
        },
        {
          role: "user",
          content: `Extract the following information from this invoice text:
            1. Invoice Number
            2. Date
            3. Due Date
            4. Vendor Name
            5. Customer Name
            6. Line Items (description, quantity, unit price, amount)
            7. Subtotal
            8. Tax
            9. Total Amount

            Format the response as a valid JSON object with these exact fields: invoiceNumber, date, dueDate, vendor, customer, items (array of objects with description, quantity, unitPrice, amount), subtotal, tax, total.

            Invoice text:
            ${extractedText}`
        }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    });

    // Parse the LLM response to get structured data
    const llmResponse = response.choices[0].message.content.trim();

    // Parse the JSON response
    try {
      const parsedData = JSON.parse(llmResponse);

      // Add validation step to ensure numerical consistency
      return validateInvoiceData(parsedData);
    } catch (jsonError) {
      console.error('Failed to parse LLM response as JSON:', jsonError);
      return extractInvoiceDataWithRegex(extractedText);
    }
  } catch (openaiError) {
    console.error('Error calling OpenAI API:', openaiError);
    return extractInvoiceDataWithRegex(extractedText);
  }
}

// New function to validate invoice data and ensure numerical consistency
function validateInvoiceData(data: any) {
  // Make a copy so we don't modify the original
  const validated = { ...data };

  // Preserve extraction methods information if it exists
  const extractionMethods = validated.extractionMethods || [];

  // Ensure all numerical values are converted to numbers
  if (validated.subtotal && typeof validated.subtotal === 'string') {
    validated.subtotal = Number.parseFloat(validated.subtotal.replace(/[^0-9.-]+/g, ''));
  }

  if (validated.tax && typeof validated.tax === 'string') {
    validated.tax = Number.parseFloat(validated.tax.replace(/[^0-9.-]+/g, ''));
  }

  if (validated.total && typeof validated.total === 'string') {
    validated.total = Number.parseFloat(validated.total.replace(/[^0-9.-]+/g, ''));
  }

  // Normalize items array
  if (validated.items && Array.isArray(validated.items)) {
    validated.items = validated.items.map((item: any) => {
      const normalizedItem = { ...item };

      // Convert string values to numbers
      if (typeof normalizedItem.quantity === 'string') {
        normalizedItem.quantity = Number.parseFloat(normalizedItem.quantity.replace(/[^0-9.-]+/g, ''));
      }

      if (typeof normalizedItem.unitPrice === 'string') {
        normalizedItem.unitPrice = Number.parseFloat(normalizedItem.unitPrice.replace(/[^0-9.-]+/g, ''));
      }

      if (typeof normalizedItem.amount === 'string') {
        normalizedItem.amount = Number.parseFloat(normalizedItem.amount.replace(/[^0-9.-]+/g, ''));
      }

      // Validate amount = quantity * unitPrice
      const calculatedAmount = normalizedItem.quantity * normalizedItem.unitPrice;
      if (Math.abs(calculatedAmount - normalizedItem.amount) > 0.1) {
        normalizedItem.amount = Number.parseFloat(calculatedAmount.toFixed(2));
      }

      return normalizedItem;
    });

    // Calculate items total and validate against invoice total
    const calculatedTotal = validated.items.reduce((sum: number, item: any) => sum + item.amount, 0);
    const calculatedTotalRounded = Number.parseFloat(calculatedTotal.toFixed(2));

    // If total doesn't match items sum (with some tolerance for rounding errors)
    if (Math.abs(calculatedTotalRounded - validated.total) > 1) {
      // Check if the difference could be due to tax not included in line items
      const tax = validated.tax || 0;
      const totalWithTax = Number.parseFloat((calculatedTotalRounded + tax).toFixed(2));

      // If the total with tax is close to the extracted total, we keep the extracted total
      if (Math.abs(totalWithTax - validated.total) <= 1) {
        console.log(`Total discrepancy likely due to tax. Keeping extracted total: ${validated.total}`);
      } else {
        console.log(`Correcting inconsistent total: ${validated.total} to match sum of line items + tax: ${totalWithTax}`);

        // If there's still a significant discrepancy even after accounting for tax,
        // update the total to be line items + tax
        validated.total = totalWithTax;
      }
    }
  }

  // Restore extraction methods
  if (extractionMethods.length > 0) {
    validated.extractionMethods = extractionMethods;
  }

  return validated;
}

// Helper function to extract line items from text
function extractItemsFromText(text: string) {
  const items = [];
  let match;

  // First try a table detection approach by analyzing the structure of the text
  // Look for sections that contain items/descriptions/services
  const itemSectionMarkers = [
    /description/i, /item/i, /product/i, /service/i, /detail/i, /qty|quantity/i, /unit.?price/i, /amount/i
  ];

  let itemSection = '';
  const lines = text.split('\n');

  // Try to find the table header line
  let headerLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check if this line contains multiple item section markers
    let markerCount = 0;
    for (const marker of itemSectionMarkers) {
      if (marker.test(line)) markerCount++;
    }

    // If we found a line with at least 3 markers, it's likely the header
    if (markerCount >= 3) {
      headerLineIndex = i;
      break;
    }
  }

  // If we found a header, extract the item section
  if (headerLineIndex >= 0) {
    // Determine the end of the items section (usually ends with subtotal/total)
    let endLineIndex = headerLineIndex + 1;
    for (let i = headerLineIndex + 1; i < lines.length; i++) {
      if (/subtotal|total/i.test(lines[i])) {
        endLineIndex = i;
        break;
      }
      // If we're more than 20 lines past the header without finding a total,
      // just use a reasonable number of lines
      if (i > headerLineIndex + 20) {
        endLineIndex = headerLineIndex + 15; // Assume up to 15 items
        break;
      }
    }

    // Extract items section for structured parsing
    itemSection = lines.slice(headerLineIndex + 1, endLineIndex).join('\n');

    // Use the itemSection with our existing patterns

    // First attempt: Try to find rows with description, qty, price, amount in tabular format
    // This handles various formats:
    // 1. Product A        2      100.00    200.00
    // 2. Service B        1      150.00    150.00
    const tabularPattern = /([^\n\d$€£]+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:[,.]\d+)?)\s+(\d+(?:[,.]\d+)?)/g;

    while ((match = tabularPattern.exec(itemSection)) !== null) {
      const description = match[1].trim();
      const quantity = Number.parseFloat(match[2].replace(/,/g, ''));
      const unitPrice = Number.parseFloat(match[3].replace(/,/g, ''));
      const amount = Number.parseFloat(match[4].replace(/,/g, ''));

      if (description && !Number.isNaN(quantity) && !Number.isNaN(unitPrice) && !Number.isNaN(amount)) {
        items.push({ description, quantity, unitPrice, amount });
      }
    }

    // Second attempt: Look for rows with a number (qty) followed by description and amount
    // Example: 2 x Product A $200.00
    if (items.length === 0) {
      const qtyDescriptionPattern = /(\d+)(?:\s*x\s*|\s+)([^$€£\n]+?)(?:[$€£]\s*|\s+)([\d,]+(?:\.\d+)?)/g;

      while ((match = qtyDescriptionPattern.exec(itemSection)) !== null) {
        const quantity = Number.parseInt(match[1], 10);
        const description = match[2].trim();
        const amount = Number.parseFloat(match[3].replace(/,/g, ''));
        const unitPrice = quantity > 0 ? amount / quantity : 0;

        if (description && !Number.isNaN(quantity) && !Number.isNaN(amount)) {
          items.push({
            description,
            quantity,
            unitPrice: Number.parseFloat(unitPrice.toFixed(2)),
            amount
          });
        }
      }
    }

    // If we still don't have items, try to parse each line individually
    if (items.length === 0) {
      const itemLines = itemSection.split('\n');

      for (const line of itemLines) {
        if (line.trim() === '') continue;

        // Skip lines that look like headers or totals
        if (/total|subtotal|tax|balance|amount due/i.test(line)) continue;

        // Look for description with numbers
        const numberMatches = line.match(/\d+(?:[,.]\d+)?/g);
        if (numberMatches && numberMatches.length >= 2) {
          // Try to determine which numbers are quantity, unit price, and amount
          // Usually, the last number is the amount
          const amount = Number.parseFloat(numberMatches[numberMatches.length - 1].replace(/,/g, ''));

          // If we have at least 3 numbers, assume format is qty, unit price, amount
          let quantity;
          let unitPrice;
          if (numberMatches.length >= 3) {
            quantity = Number.parseFloat(numberMatches[0].replace(/,/g, ''));
            unitPrice = Number.parseFloat(numberMatches[1].replace(/,/g, ''));
          } else {
            // With only 2 numbers, make best guess: first is quantity, calculate unit price
            quantity = Number.parseFloat(numberMatches[0].replace(/,/g, ''));
            unitPrice = quantity > 0 ? amount / quantity : 0;
          }

          // Extract description by removing numbers and special characters
          const description = line.replace(/\d+(?:[,.]\d+)?/g, ' ')
            .replace(/[$€£%]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          if (description && !Number.isNaN(quantity) && !Number.isNaN(amount)) {
            items.push({
              description,
              quantity,
              unitPrice: Number.parseFloat(unitPrice.toFixed(2)),
              amount
            });
          }
        }
      }
    }
  }

  // If the structured approach didn't work, try our original methods
  if (items.length === 0) {
    // First attempt: Look for tabular format with description, quantity, unit price, amount
    const standardPattern = /([^\n\d]+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/g;

    while ((match = standardPattern.exec(text)) !== null) {
      items.push({
        description: match[1].trim(),
        quantity: Number.parseInt(match[2], 10),
        unitPrice: Number.parseFloat(match[3]),
        amount: Number.parseFloat(match[4])
      });
    }

    // Second attempt: Look for lines with item description followed by price
    if (items.length === 0) {
      const alternativePattern = /(\d+)\s*(?:x)?\s*([^\n$€£]*)(?:[$€£]\s*(\d+(?:,\d+)*(?:\.\d+)?))/g;

      while ((match = alternativePattern.exec(text)) !== null) {
        const quantity = Number.parseInt(match[1], 10) || 1;
        const description = match[2].trim();
        const totalAmount = Number.parseFloat(match[3].replace(/,/g, '')) || 0;
        const unitPrice = quantity > 0 ? totalAmount / quantity : 0;

        items.push({
          description,
          quantity,
          unitPrice: Number.parseFloat(unitPrice.toFixed(2)),
          amount: totalAmount
        });
      }
    }

    // Third attempt: Look for lines with dollar amounts
    if (items.length === 0) {
      const lines = text.split('\n');
      let itemCount = 0;

      for (const line of lines) {
        // Skip empty lines or lines with common keywords to avoid false positives
        if (line.trim() === '' || /invoice|total|subtotal|tax|balance|amount due|date|payment|bill/i.test(line)) {
          continue;
        }

        // Look for lines with dollar amounts
        const currencyMatch = line.match(/[$€£]\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
        if (currencyMatch) {
          const amount = Number.parseFloat(currencyMatch[1].replace(/,/g, ''));

          // Extract quantity if present
          let quantity = 1;
          const qtyMatch = line.match(/(\d+)\s*(?:x|items|units|qty)/i);
          if (qtyMatch) {
            quantity = Number.parseInt(qtyMatch[1], 10);
          }

          // Calculate unit price
          const unitPrice = quantity > 0 ? amount / quantity : amount;

          // Get description by removing the currency portion and other numbers
          let description = line.replace(/[$€£]\s*\d+(?:,\d+)*(?:\.\d+)?/, '')
            .replace(/\d+\s*(?:x|items|units|qty)/i, '')
            .replace(/^\s*\d+[\.\)]\s*/, '') // Remove item numbers like "1. " or "2) "
            .trim();

          // If description is too short, try to add more context
          if (description.length < 3) {
            description = `Item ${++itemCount}`;
          }

          items.push({
            description,
            quantity,
            unitPrice: Number.parseFloat(unitPrice.toFixed(2)),
            amount
          });
        }
      }
    }
  }

  // If still no items found, return placeholder
  return items.length > 0 ? items : [
    { description: 'Item not detected', quantity: 1, unitPrice: 0, amount: 0 }
  ];
}

// Helper function to extract monetary amounts
function extractAmountFromText(text: string, label: string) {
  // Convert the text to a single line to improve pattern matching
  const flatText = text.replace(/\n/g, ' ');

  // Create an array of patterns to try, from most to least specific
  const patterns = [
    // Pattern 1: Label followed by currency symbol and amount
    new RegExp(`${label}\\s*:?\\s*[$€£]\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'),

    // Pattern 2: Label followed by amount
    new RegExp(`${label}[^\\d$€£]*([\\d,]+(?:\\.\\d+)?)`, 'i'),

    // Pattern 3: Label with colon or equals sign followed by amount
    new RegExp(`${label}\\s*(?::|=)\\s*([\\d,]+(?:\\.\\d+)?)`, 'i'),

    // Pattern 4: Look for the label near the amount in the same line
    new RegExp(`(?:^|\\s)${label}(?:\\s+[^\\d$€£]*)(?:[$€£]\\s*)?([\\d,]+(?:\\.\\d+)?)`, 'i'),

    // Pattern 5: Look for label and then a currency amount on same line
    new RegExp(`(?:^|\\s)${label}.*?[$€£]\\s*([\\d,]+(?:\\.\\d+)?)`, 'i')
  ];

  // Try each pattern in order
  for (const pattern of patterns) {
    const match = flatText.match(pattern);
    if (match?.[1]) {
      const amountStr = match[1].replace(/,/g, '');
      const amount = Number.parseFloat(amountStr);
      if (!Number.isNaN(amount)) {
        return amount;
      }
    }
  }

  // If none of the specific patterns matched, try a line-by-line approach
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes(label.toLowerCase())) {
      // This line contains the label we're looking for
      const amounts = line.match(/[$€£]?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g);
      if (amounts && amounts.length > 0) {
        // Get the last amount in the line
        const lastAmount = amounts[amounts.length - 1].replace(/[$€£\s]/g, '');
        const amount = Number.parseFloat(lastAmount.replace(/,/g, ''));
        if (!Number.isNaN(amount)) {
          return amount;
        }
      }
    }
  }

  // If no match found, return 0
  return 0;
}

// Helper function to convert the extracted invoice data to CSV format for the sheet block
function convertToCSV(data: any) {
  const headers = ['Item', 'Description', 'Quantity', 'Unit Price', 'Amount'];

  // Invoice metadata as rows
  const metadataRows = [
    ['Invoice Number', data.invoiceNumber, '', '', ''],
    ['Date', data.date, '', '', ''],
    ['Due Date', data.dueDate, '', '', ''],
    ['Vendor', data.vendor, '', '', ''],
    ['Customer', data.customer, '', '', ''],
    ['', '', '', '', ''] // Empty row for spacing
  ];

  // Item rows
  const itemRows = data.items.map((item: any, index: number) => [
    index + 1,
    item.description,
    item.quantity,
    item.unitPrice,
    item.amount
  ]);

  // Summary rows
  const summaryRows = [
    ['', '', '', 'Subtotal', data.subtotal],
    ['', '', '', 'Tax', data.tax],
    ['', '', '', 'Total', data.total]
  ];

  // Combine all rows
  const allRows = [
    headers,
    ...metadataRows,
    ...itemRows,
    ['', '', '', '', ''], // Empty row for spacing
    ...summaryRows
  ];

  // Convert to CSV
  return allRows.map(row => row.join(',')).join('\n');
}

// New validation function to determine if a document is an invoice
function validateIsInvoice(extractedData: any): boolean {
  // Check for key invoice characteristics

  // An invoice should have an invoice number
  const hasInvoiceNumber = extractedData.invoiceNumber &&
    extractedData.invoiceNumber !== 'Unknown' &&
    extractedData.invoiceNumber.length > 0;

  // An invoice should have at least one line item with actual data
  const hasLineItems = extractedData.items &&
    Array.isArray(extractedData.items) &&
    extractedData.items.length > 0 &&
    !extractedData.items[0].description.includes('Unable to extract') &&
    !extractedData.items[0].description.includes('not detected');

  // An invoice should have a total amount
  const hasTotal = typeof extractedData.total === 'number' && extractedData.total > 0;

  // An invoice typically has vendor and customer information
  const hasVendorInfo = extractedData.vendor &&
    extractedData.vendor !== 'Unknown Vendor' &&
    extractedData.vendor.length > 0;

  // Check for statement keywords across all text fields
  const statementKeywords = [
    /bank\s+statement/i,
    /account\s+statement/i,
    /credit\s+card/i,
    /statement\s+of\s+account/i,
    /monthly\s+statement/i,
    /quarterly\s+statement/i,
    /account\s+summary/i,
    /balance\s+summary/i,
    /transaction\s+history/i,
    /account\s+activity/i,
    /opening\s+balance/i,
    /closing\s+balance/i,
    /condominium\s+association/i,
    /homeowners\s+association/i,
    /hoa/i,
    /assessment/i,
    /maintenance\s+fee/i,
    /regular\s+assessment/i,
    /special\s+assessment/i,
    /association\s+fee/i,
    /monthly\s+fee/i,
    /reserve\s+fund/i
  ];

  // Check for receipt keywords across all text fields
  const receiptKeywords = [
    /receipt/i,
    /thank\s+you\s+for\s+your\s+purchase/i,
    /thank\s+you\s+for\s+shopping/i,
    /cash\s+receipt/i,
    /payment\s+receipt/i,
    /store\s+receipt/i,
    /return\s+policy/i,
    /cashier:/i,
    /terminal:/i,
    /register:/i,
    /transaction\s+id/i,
    /card\s+\w+\s+\d{4}/i
  ];

  // Check all text fields for statement or receipt keywords
  const allTextFields = [
    extractedData.vendor || '',
    extractedData.customer || '',
    extractedData.invoiceNumber || '',
    ...((extractedData.items || []).map((item: any) => item.description || '')),
  ].join(' ');

  // Check if any statement keywords are present
  const isLikelyStatement = statementKeywords.some(keyword => keyword.test(allTextFields));

  // Check if any receipt keywords are present
  const isLikelyReceipt = receiptKeywords.some(keyword => keyword.test(allTextFields));

  // Check for statement-specific structural indicators
  const hasStatementStructure =
    (!hasInvoiceNumber) && // Statements often lack invoice numbers
    (allTextFields.includes('balance') && allTextFields.includes('transaction')) ||
    (allTextFields.includes('payment') && allTextFields.includes('balance'));

  // Check for receipt-specific structural indicators
  const hasReceiptStructure =
    (!hasInvoiceNumber) && // Receipts often lack invoice numbers
    allTextFields.toLowerCase().includes('total') &&
    !allTextFields.toLowerCase().includes('invoice');

  // Check for condominium/HOA statements
  const isCondoStatement =
    (/condominium|association|community|homeowner/i.test(allTextFields)) &&
    (!hasLineItems || extractedData.items.length < 2);

  // Check for suspiciously empty invoices (no line items but has total)
  const isEmptyInvoice =
    (!hasLineItems || extractedData.items.length === 0) &&
    (extractedData.subtotal > 0 || extractedData.total > 0);

  // Check for numeric inconsistencies (large difference between subtotal and total)
  const hasNumericInconsistency =
    (Math.abs(extractedData.subtotal - extractedData.total) > 1000) ||
    (extractedData.subtotal > 1000 && extractedData.total < 100);

  // If any statement or receipt indicators are present, it's not a valid invoice
  if (isLikelyStatement || isLikelyReceipt ||
    hasStatementStructure || hasReceiptStructure ||
    isCondoStatement || isEmptyInvoice ||
    hasNumericInconsistency) {
    return false;
  }

  // Check if at least some key invoice features are present
  // We require invoice number, at least one line item, and matching total amounts
  return hasInvoiceNumber && hasLineItems && hasTotal && hasVendorInfo;
}

// New function to perform preliminary document type check
async function preliminaryDocumentTypeCheck(file: Blob): Promise<boolean> {
  // Extract a small sample of text to check document type
  try {
    const fileBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(fileBuffer);

    // For PDFs, just use Gemini Vision for checking as it works reliably
    if (file.type === 'application/pdf') {
      try {
        // Gemini Vision check if available
        if (process.env.GEMINI_API_KEY) {
          try {
            // Use Gemini API to check document type
            const geminiData = await processWithGeminiVision(buffer, 'application/pdf');

            // First, do a quick check for empty line items with subtotal
            if ((!geminiData.items || geminiData.items.length === 0) &&
              (geminiData.subtotal > 0 || geminiData.total > 0)) {
              return false;
            }

            // Check for major inconsistencies in totals
            if (Math.abs(geminiData.subtotal - geminiData.total) > 1000 ||
              (geminiData.subtotal > 1000 && geminiData.total < 100)) {
              return false;
            }

            // Statement indicator keywords - expanded with more HOA/condo terms
            const statementKeywords = [
              /statement/i,
              /account/i,
              /bank/i,
              /credit\s+card/i,
              /balance/i,
              /transaction/i,
              /withdrawal/i,
              /deposit/i,
              /available\s+credit/i,
              /interest\s+charged/i,
              /minimum\s+payment/i,
              /condominium/i,
              /association/i,
              /homeowner/i,
              /community/i,
              /hoa/i,
              /assessment/i,
              /maintenance\s+fee/i,
              /monthly\s+fee/i,
              /reserve\s+fund/i
            ];

            // Receipt indicator keywords
            const receiptKeywords = [
              /receipt/i,
              /thank\s+you/i,
              /purchase/i,
              /return\s+policy/i,
              /cashier/i,
              /terminal/i,
              /transaction\s+id/i,
              /card\s+\w+\s+\d{4}/i, // Card type ending in 1234
              /store\s+\#/i
            ];

            // Create a single text from all extracted data for keyword search
            const allExtractedText = [
              geminiData.vendor || '',
              geminiData.customer || '',
              geminiData.invoiceNumber || '',
              ...(geminiData.items || []).map((item: any) => item.description || '')
            ].join(' ');

            // Check for statement indicators in any field
            const hasStatementKeywords = statementKeywords.some(keyword =>
              keyword.test(geminiData.vendor || '') ||
              keyword.test(geminiData.customer || '') ||
              keyword.test(allExtractedText)
            );

            // Check for receipt indicators in any field
            const hasReceiptKeywords = receiptKeywords.some(keyword =>
              keyword.test(geminiData.vendor || '') ||
              keyword.test(geminiData.customer || '') ||
              keyword.test(allExtractedText)
            );

            // More comprehensive check for statement indicators in the data structure
            const hasStatementStructure =
              (!geminiData.invoiceNumber || geminiData.invoiceNumber === 'Unknown') &&
              (!geminiData.items || geminiData.items.length === 0 ||
                geminiData.items[0].description.includes('Unable to extract')) &&
              (geminiData.total === 0 || !geminiData.total);

            // Check for receipt-specific structure
            const hasReceiptStructure =
              (!geminiData.invoiceNumber || geminiData.invoiceNumber === 'Unknown') &&
              (!geminiData.customer || geminiData.customer === 'Unknown Customer') &&
              geminiData.items && geminiData.items.length > 0 &&
              geminiData.total > 0;

            // Check specifically for condominium/HOA statements
            const isCondoStatement =
              (/condominium|association|community|homeowner/i.test(allExtractedText)) &&
              (!geminiData.items || geminiData.items.length < 2);


            // If any statement or receipt indicators are present, reject the file
            if (hasStatementKeywords || hasReceiptKeywords ||
              hasStatementStructure || (hasReceiptStructure && hasReceiptKeywords) ||
              isCondoStatement) {
              console.log('Document appears to be a statement or receipt rather than an invoice');
              return false;
            }

            // If we have invoice data with valid items, it's likely an invoice
            if (geminiData.items &&
              geminiData.items.length > 0 &&
              !geminiData.items[0].description.includes('Unable to extract') &&
              geminiData.total > 0 &&
              geminiData.invoiceNumber &&
              geminiData.invoiceNumber !== 'Unknown' &&
              Math.abs(geminiData.subtotal - geminiData.total) < 500) { // Ensure totals are reasonably close
              return true;
            }

            // If we get here, we couldn't confirm it's an invoice
            return false;
          } catch (error) {
            // Fall back to rejecting if we can't process properly
            return false;
          }
        }

        return true; // Default to allowing - we'll rely on the main validation

      } catch (error) {
        // If we can't determine, we'll rely on the main validation
        return true;
      }
    }

    // For non-PDFs, we can't easily check
    return true;
  } catch (error) {
    console.error('Error checking document type:', error);
    return true; // Default to allowing if we can't check
  }
}
