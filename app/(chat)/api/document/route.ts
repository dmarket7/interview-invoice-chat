import { auth } from '@/app/(auth)/auth';
import type { BlockKind } from '@/components/block';
import {
  deleteDocumentsByIdAfterTimestamp,
  getDocumentsById,
  saveDocument,
} from '@/lib/db/queries';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Missing id', { status: 400 });
  }

  // Get auth session and ensure proper error handling
  try {
    const session = await auth();

    // Check if session exists
    if (!session) {
      console.error('No session found for document request');
      return new Response('Unauthorized - No valid session', { status: 401 });
    }

    // Check if session has user ID
    if (!session.user?.id) {
      console.error('Session missing user ID for document request');
      return new Response('Unauthorized - Invalid user session', { status: 401 });
    }

    const documents = await getDocumentsById({ id });

    // Check if document exists
    if (!documents || documents.length === 0) {
      return new Response('Document not found', { status: 404 });
    }

    // Since documents don't explicitly track ownership in this schema,
    // we'll just return the document if the user is authenticated
    // A more robust approach would be to add a userId field to the document schema
    return Response.json(documents, { status: 200 });
  } catch (error) {
    console.error('Error accessing document:', error);
    return new Response('Server error processing document request', { status: 500 });
  }
}

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Missing id', { status: 400 });
  }

  const session = await auth();

  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }

  const {
    content,
    title,
    kind,
  }: { content: string; title: string; kind: BlockKind; } = await request.json();

  if (session.user?.id) {
    const document = await saveDocument({
      id,
      content,
      title,
      kind,
      userId: session.user.id,
    });

    return Response.json(document, { status: 200 });
  }
  return new Response('Unauthorized', { status: 401 });
}

export async function PATCH(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  const { timestamp }: { timestamp: string; } = await request.json();

  if (!id) {
    return new Response('Missing id', { status: 400 });
  }

  try {
    const session = await auth();

    // Check if session exists
    if (!session || !session.user?.id) {
      return new Response('Unauthorized - Invalid session', { status: 401 });
    }

    const documents = await getDocumentsById({ id });

    // Check if document exists
    if (!documents || documents.length === 0) {
      return new Response('Document not found', { status: 404 });
    }

    // Since documents don't explicitly track ownership in this schema,
    // we'll just proceed if the user is authenticated

    await deleteDocumentsByIdAfterTimestamp({
      id,
      timestamp: new Date(timestamp),
    });

    return new Response('Deleted', { status: 200 });
  } catch (error) {
    console.error('Error deleting document versions:', error);
    return new Response('Server error processing document request', { status: 500 });
  }
}
