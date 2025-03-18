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
        console.log(`Processing invoice PDF: ${filename}`);

        try {
          const extractedData = await extractInvoiceData(buffer);
          console.log('Successfully extracted invoice data');

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
                  if (parseInt(parts[0]) <= 12) {
                    const dateCandidate = new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
                    if (!isNaN(dateCandidate.getTime())) {
                      invoiceDate = dateCandidate;
                    }
                  } else {
                    // Try DD/MM/YYYY format
                    const dateCandidate = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
                    if (!isNaN(dateCandidate.getTime())) {
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
          if (!invoiceDate || isNaN(invoiceDate.getTime())) {
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
                  if (parseInt(parts[0]) <= 12) {
                    const dateCandidate = new Date(`${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`);
                    if (!isNaN(dateCandidate.getTime())) {
                      dueDate = dateCandidate;
                    }
                  } else {
                    // Try DD/MM/YYYY format
                    const dateCandidate = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`);
                    if (!isNaN(dateCandidate.getTime())) {
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
          if (!dueDate || isNaN(dueDate.getTime())) {
            console.warn('Invalid due date detected, using default 30 days from now');
            dueDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          }

          // Convert amount to cents for database storage
          const totalAmountCents = Math.round(extractedData.total * 100);

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

          console.log(`Saved invoice to database with ID: ${invoiceId}`);

          // Insert line items
          if (extractedData.items && Array.isArray(extractedData.items)) {
            for (const item of extractedData.items) {
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

            console.log(`Saved ${extractedData.items.length} line items to database`);
          }

          // Convert the extracted data to CSV format for sheet block
          const csvData = convertToCSV(extractedData);

          return NextResponse.json({
            url: `data:${file.type};base64,${buffer.toString('base64')}`,
            pathname: `/uploads/${uniqueFilename}`,
            contentType: file.type,
            isInvoice: true,
            csvData,
            extractedData,
            extractionMethods: extractedData.extractionMethods || ['regex'],
            invoiceId
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
      console.log(`File uploaded successfully: ${filename}`);

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
  console.log('Extracting invoice data with regex patterns');

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
    if (match && match[1]) {
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
    if (match && match[1]) {
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
    if (match && match[1]) {
      // Check if this is a "Net X days" format
      if (pattern.toString().includes('Net')) {
        netDays = parseInt(match[1]);
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
      if (!isNaN(dateObj.getTime())) {
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
      if (match && match[1] && match[1].length > 3) {
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
    if (match && match[1] && match[1].length > 3) {
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
    console.log(`Line items total (${itemsTotal}) doesn't match invoice total (${total}). Adjusting...`);

    // If the discrepancy is small relative to the total, adjust the total to match items
    if (Math.abs(itemsTotal - total) / total < 0.2 || confidence.items > confidence.total) {
      total = parseFloat(itemsTotal.toFixed(2));
      console.log(`Adjusted total to match line items: ${total}`);
    }
    // Otherwise, we keep the extracted total as it's likely more reliable
  }

  // Log confidence scores for debugging
  console.log('Extraction confidence scores:', confidence);

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
    const amount = parseFloat(match[1].replace(/,/g, ''));
    if (!isNaN(amount) && amount > largestAmount) {
      largestAmount = amount;
    }
  }

  return largestAmount;
}

// Helper function to extract data from PDF invoices
async function extractInvoiceData(buffer: Buffer) {
  try {
    console.log('Processing document extraction...');

    // Determine file type and choose appropriate strategies
    const fileSignature = buffer.slice(0, 4).toString('hex');
    const isPDF = fileSignature.startsWith('25504446'); // %PDF
    const isJPEG = fileSignature.startsWith('ffd8ff');
    const isPNG = fileSignature.startsWith('89504e47');

    console.log(`Detected file type: ${isPDF ? 'PDF' : (isJPEG ? 'JPEG' : (isPNG ? 'PNG' : 'Unknown'))}`);

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
      // Add PDF.js for better PDF extraction
      const pdfjs = require('pdfjs-dist');
      // Set proper worker path for PDF.js
      const pdfjsWorker = require('pdfjs-dist/build/pdf.worker.js');

      if (typeof window === 'undefined') {
        // In Node.js environment - fixed worker path configuration
        pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
      } else {
        // In browser environment
        pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;
      }

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
              extractedText += strings.join(' ') + '\n';
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
        console.log(`Extracted ${pdfData.length} characters using PDF.js`);
        extractedText = pdfData;
      }
    }

    // For images or if PDF extraction didn't yield enough text, try OCR
    if ((isJPEG || isPNG || extractedText.length < 100) && (!extractionResults.length || extractionResults[0].data.items.length === 0)) {
      console.log('Skipping OCR due to configuration issues.');
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
      console.log(`Merging results from ${extractionResults.length} extraction methods`);
      return mergeExtractionResults(extractionResults);
    } else if (extractionResults.length === 1) {
      return extractionResults[0].data;
    }

    // If all extraction methods fail, return a basic structure
    console.log('All extraction methods failed, returning default structure');
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
async function processWithGeminiVision(buffer: Buffer, mimeType: string = 'application/pdf') {
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
        console.log(`Using ${field} from ${results[i].method} as it has better data`);
        merged[field] = result[field];
        methodUsed = true;
      }

      // Special case for line items - use the one with more items if current has none or few
      if (field === 'items' &&
        Array.isArray(merged.items) &&
        Array.isArray(result.items) &&
        result.items.length > merged.items.length &&
        merged.items.length <= 1) {
        console.log(`Using items from ${results[i].method} as it has more line items (${result.items.length} vs ${merged.items.length})`);
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

  console.log('Sending text to OpenAI for extraction...');

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

    console.log('Successfully received extraction response from OpenAI');

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
    console.log('Falling back to regex extraction');
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
    validated.subtotal = parseFloat(validated.subtotal.replace(/[^0-9.-]+/g, ''));
  }

  if (validated.tax && typeof validated.tax === 'string') {
    validated.tax = parseFloat(validated.tax.replace(/[^0-9.-]+/g, ''));
  }

  if (validated.total && typeof validated.total === 'string') {
    validated.total = parseFloat(validated.total.replace(/[^0-9.-]+/g, ''));
  }

  // Normalize items array
  if (validated.items && Array.isArray(validated.items)) {
    validated.items = validated.items.map((item: any) => {
      const normalizedItem = { ...item };

      // Convert string values to numbers
      if (typeof normalizedItem.quantity === 'string') {
        normalizedItem.quantity = parseFloat(normalizedItem.quantity.replace(/[^0-9.-]+/g, ''));
      }

      if (typeof normalizedItem.unitPrice === 'string') {
        normalizedItem.unitPrice = parseFloat(normalizedItem.unitPrice.replace(/[^0-9.-]+/g, ''));
      }

      if (typeof normalizedItem.amount === 'string') {
        normalizedItem.amount = parseFloat(normalizedItem.amount.replace(/[^0-9.-]+/g, ''));
      }

      // Validate amount = quantity * unitPrice
      const calculatedAmount = normalizedItem.quantity * normalizedItem.unitPrice;
      if (Math.abs(calculatedAmount - normalizedItem.amount) > 0.1) {
        console.log(`Correcting inconsistent line item amount: ${normalizedItem.amount} to ${calculatedAmount}`);
        normalizedItem.amount = parseFloat(calculatedAmount.toFixed(2));
      }

      return normalizedItem;
    });

    // Calculate items total and validate against invoice total
    const calculatedTotal = validated.items.reduce((sum: number, item: any) => sum + item.amount, 0);
    const calculatedTotalRounded = parseFloat(calculatedTotal.toFixed(2));

    // If total doesn't match items sum (with some tolerance for rounding errors)
    if (Math.abs(calculatedTotalRounded - validated.total) > 1) {
      console.log(`Correcting inconsistent total: ${validated.total} to match sum of line items: ${calculatedTotalRounded}`);

      // If the difference is significant, we trust the items calculation more than the extracted total
      validated.total = calculatedTotalRounded;
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
      const quantity = parseFloat(match[2].replace(/,/g, ''));
      const unitPrice = parseFloat(match[3].replace(/,/g, ''));
      const amount = parseFloat(match[4].replace(/,/g, ''));

      if (description && !isNaN(quantity) && !isNaN(unitPrice) && !isNaN(amount)) {
        items.push({ description, quantity, unitPrice, amount });
      }
    }

    // Second attempt: Look for rows with a number (qty) followed by description and amount
    // Example: 2 x Product A $200.00
    if (items.length === 0) {
      const qtyDescriptionPattern = /(\d+)(?:\s*x\s*|\s+)([^$€£\n]+?)(?:[$€£]\s*|\s+)([\d,]+(?:\.\d+)?)/g;

      while ((match = qtyDescriptionPattern.exec(itemSection)) !== null) {
        const quantity = parseInt(match[1], 10);
        const description = match[2].trim();
        const amount = parseFloat(match[3].replace(/,/g, ''));
        const unitPrice = quantity > 0 ? amount / quantity : 0;

        if (description && !isNaN(quantity) && !isNaN(amount)) {
          items.push({
            description,
            quantity,
            unitPrice: parseFloat(unitPrice.toFixed(2)),
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
          const amount = parseFloat(numberMatches[numberMatches.length - 1].replace(/,/g, ''));

          // If we have at least 3 numbers, assume format is qty, unit price, amount
          let quantity, unitPrice;
          if (numberMatches.length >= 3) {
            quantity = parseFloat(numberMatches[0].replace(/,/g, ''));
            unitPrice = parseFloat(numberMatches[1].replace(/,/g, ''));
          } else {
            // With only 2 numbers, make best guess: first is quantity, calculate unit price
            quantity = parseFloat(numberMatches[0].replace(/,/g, ''));
            unitPrice = quantity > 0 ? amount / quantity : 0;
          }

          // Extract description by removing numbers and special characters
          let description = line.replace(/\d+(?:[,.]\d+)?/g, ' ')
            .replace(/[$€£%]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          if (description && !isNaN(quantity) && !isNaN(amount)) {
            items.push({
              description,
              quantity,
              unitPrice: parseFloat(unitPrice.toFixed(2)),
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
        quantity: parseInt(match[2], 10),
        unitPrice: parseFloat(match[3]),
        amount: parseFloat(match[4])
      });
    }

    // Second attempt: Look for lines with item description followed by price
    if (items.length === 0) {
      const alternativePattern = /(\d+)\s*(?:x)?\s*([^\n$€£]*)(?:[$€£]\s*(\d+(?:,\d+)*(?:\.\d+)?))/g;

      while ((match = alternativePattern.exec(text)) !== null) {
        const quantity = parseInt(match[1], 10) || 1;
        const description = match[2].trim();
        const totalAmount = parseFloat(match[3].replace(/,/g, '')) || 0;
        const unitPrice = quantity > 0 ? totalAmount / quantity : 0;

        items.push({
          description,
          quantity,
          unitPrice: parseFloat(unitPrice.toFixed(2)),
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
          const amount = parseFloat(currencyMatch[1].replace(/,/g, ''));

          // Extract quantity if present
          let quantity = 1;
          const qtyMatch = line.match(/(\d+)\s*(?:x|items|units|qty)/i);
          if (qtyMatch) {
            quantity = parseInt(qtyMatch[1], 10);
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
            unitPrice: parseFloat(unitPrice.toFixed(2)),
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
    new RegExp(label + '\\s*:?\\s*[$€£]\\s*([\\d,]+(?:\\.\\d+)?)', 'i'),

    // Pattern 2: Label followed by amount
    new RegExp(label + '[^\\d$€£]*([\\d,]+(?:\\.\\d+)?)', 'i'),

    // Pattern 3: Label with colon or equals sign followed by amount
    new RegExp(label + '\\s*(?::|=)\\s*([\\d,]+(?:\\.\\d+)?)', 'i'),

    // Pattern 4: Look for the label near the amount in the same line
    new RegExp('(?:^|\\s)' + label + '(?:\\s+[^\\d$€£]*)(?:[$€£]\\s*)?([\\d,]+(?:\\.\\d+)?)', 'i'),

    // Pattern 5: Look for label and then a currency amount on same line
    new RegExp('(?:^|\\s)' + label + '.*?[$€£]\\s*([\\d,]+(?:\\.\\d+)?)', 'i')
  ];

  // Try each pattern in order
  for (const pattern of patterns) {
    const match = flatText.match(pattern);
    if (match && match[1]) {
      const amountStr = match[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      if (!isNaN(amount)) {
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
        const amount = parseFloat(lastAmount.replace(/,/g, ''));
        if (!isNaN(amount)) {
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
