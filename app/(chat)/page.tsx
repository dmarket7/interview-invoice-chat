import { cookies } from 'next/headers';

import { Chat } from '@/components/chat';
import { DEFAULT_CHAT_MODEL } from '@/lib/ai/models';
import { generateUUID } from '@/lib/utils';
import { DataStreamHandler } from '@/components/data-stream-handler';
import { DocumentDataHandler } from '@/components/document-data-handler';

export default async function Page({
  searchParams,
}: {
  searchParams: { invoiceId?: string; documentId?: string; upload?: string; };
}) {
  const resolvedSearchParams = await searchParams;
  const id = resolvedSearchParams?.invoiceId || generateUUID();
  const documentId = resolvedSearchParams?.documentId;
  const isUpload = resolvedSearchParams?.upload === 'invoice';

  const cookieStore = await cookies();
  const modelIdFromCookie = cookieStore.get('chat-model');

  // Initialize with a default chat model if none is found in cookies
  const selectedModel = modelIdFromCookie ? modelIdFromCookie.value : DEFAULT_CHAT_MODEL;

  return (
    <>
      <Chat
        key={id}
        id={id}
        initialMessages={[]}
        selectedChatModel={selectedModel}
        selectedVisibilityType="private"
        initialDocumentId={documentId}
      />
      <DataStreamHandler id={id} />
      {documentId && <DocumentDataHandler documentId={documentId} />}
    </>
  );
}
