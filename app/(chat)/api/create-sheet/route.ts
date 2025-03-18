import { NextResponse } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { saveDocument } from '@/lib/db/queries';
import { nanoid } from 'nanoid';

export async function POST(request: Request) {
  try {
    // Check authentication
    const session = await auth();
    if (!session || !session.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse request body
    const { csvData, fileName } = await request.json();

    if (!csvData) {
      return NextResponse.json({ error: 'Missing CSV data' }, { status: 400 });
    }

    // Generate unique ID and title
    const documentId = nanoid();
    const title = `Invoice: ${fileName || 'Unknown'} - ${new Date().toLocaleDateString()}`;

    // Save document
    await saveDocument({
      id: documentId,
      content: csvData,
      title,
      kind: 'sheet',
      userId: session.user.id,
    });

    // Return success response
    return NextResponse.json({
      success: true,
      documentId,
      title
    });
  } catch (error) {
    console.error('Error creating sheet document:', error);
    return NextResponse.json({
      error: 'Failed to create sheet document'
    }, {
      status: 500
    });
  }
}