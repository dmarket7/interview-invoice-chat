'use client';

import type { Attachment, Message } from 'ai';
import { useChat } from 'ai/react';
import { useState, useEffect, useRef } from 'react';
import useSWR, { useSWRConfig } from 'swr';

import { ChatHeader } from '@/components/chat-header';
import type { Vote } from '@/lib/db/schema';
import { fetcher, generateUUID, filterToolMessages } from '@/lib/utils';
import { useLastUploadedInvoice } from '@/lib/hooks/use-last-uploaded-invoice';

import { Block } from './block';
import { MultimodalInput } from './multimodal-input';
import { Messages } from './messages';
import type { VisibilityType } from './visibility-selector';
import { useBlockSelector } from '@/hooks/use-block';
import { toast } from 'sonner';

export function Chat({
  id,
  initialMessages,
  selectedChatModel,
  selectedVisibilityType,
}: {
  id: string;
  initialMessages: Array<Message>;
  selectedChatModel: string;
  selectedVisibilityType: VisibilityType;
}) {
  const { mutate } = useSWRConfig();
  const lastUploadedInvoice = useLastUploadedInvoice();
  const systemMessageSentRef = useRef(false);
  const [currentInvoiceId, setCurrentInvoiceId] = useState<string | null>(null);
  const [currentInvoiceFilename, setCurrentInvoiceFilename] = useState<string | null>(null);

  const {
    messages: allMessages,
    setMessages,
    handleSubmit,
    input,
    setInput,
    append,
    isLoading,
    stop,
    reload,
  } = useChat({
    id,
    body: { id, selectedChatModel: selectedChatModel },
    initialMessages,
    experimental_throttle: 100,
    sendExtraMessageFields: true,
    generateId: generateUUID,
    onFinish: () => {
      mutate('/api/history');
    },
    onError: (error) => {
      toast.error('An error occured, please try again!');
    },
  });

  // Filter out system and tool-related messages for display
  const messages = filterToolMessages(allMessages);

  const { data: votes } = useSWR<Array<Vote>>(
    `/api/vote?chatId=${id}`,
    fetcher,
  );

  const [attachments, setAttachments] = useState<Array<Attachment>>([]);
  const isBlockVisible = useBlockSelector((state) => state.isVisible);

  // Reset the system message sent flag when starting a new conversation
  useEffect(() => {
    systemMessageSentRef.current = false;
  }, [id]);

  // Handle invoice detection and inject instructions to the AI
  useEffect(() => {
    // Skip if we've already sent a system message in this session
    if (systemMessageSentRef.current) return;

    const lastMessage = allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;
    if (!lastMessage || lastMessage.role !== 'user') return;

    // Special handling for invoice uploads
    let uploadFilename: string | null = null;
    let invoiceId: string | null = null;

    // Check for attachments
    const attachments = lastMessage.experimental_attachments || [];
    for (const attachment of attachments) {
      if (typeof attachment === 'object' && attachment && 'type' in attachment) {
        const attachmentType = (attachment as any).type;
        if (typeof attachmentType === 'string' && attachmentType.includes('pdf')) {
          // This is likely an invoice PDF
          const attachmentName = (attachment as any).name;
          if (typeof attachmentName === 'string') {
            uploadFilename = attachmentName;
            // Store it for processing
            setCurrentInvoiceFilename(uploadFilename);
          }
        }
      }
    }

    // Check message content as string
    if (!uploadFilename && typeof lastMessage.content === 'string') {
      // 1. Look for exact parameter format
      const filenameMatch = lastMessage.content.match(/filename parameter exactly as: "([^"]+)"/);
      if (filenameMatch?.[1]) {
        uploadFilename = filenameMatch[1];
        setCurrentInvoiceFilename(uploadFilename);
      }

      // 2. Look for quoted filename pattern
      const quotedFilenameMatch = lastMessage.content.match(/filename(?:.*?)"([^"]+\.pdf)"/);
      if (!uploadFilename && quotedFilenameMatch && quotedFilenameMatch[1]) {
        uploadFilename = quotedFilenameMatch[1];
        setCurrentInvoiceFilename(uploadFilename);
      }

      // 3. Look for /uploads/ pattern
      const uploadsMatch = lastMessage.content.match(/(\/uploads\/[^"\s]+\.pdf)/);
      if (!uploadFilename && uploadsMatch && uploadsMatch[1]) {
        uploadFilename = uploadsMatch[1];
        setCurrentInvoiceFilename(uploadFilename);
      }

      // 4. Look for invoice ID
      const invoiceIdMatch = lastMessage.content.match(/ID: ([a-zA-Z0-9_-]+)/);
      if (invoiceIdMatch?.[1]) {
        invoiceId = invoiceIdMatch[1];
        setCurrentInvoiceId(invoiceId);
      }
    }

    // If we detected an invoice upload, send a system message to instruct the AI
    if ((uploadFilename || invoiceId)) {
      // Send system message to explicitly instruct AI on using the upload tool with extra details
      systemMessageSentRef.current = true;
      setTimeout(() => {
        append({
          role: 'system',
          content: `IMPORTANT: The user has just uploaded an invoice file.

1. You MUST process it using the uploadInvoice tool with the ${uploadFilename ? `filename parameter set to exactly: "${uploadFilename}"` : `invoiceId parameter set to: "${invoiceId}"`}.
2. DO NOT ask them to upload an invoice - they already have.
3. After processing, analyze the invoice data and provide insights.
4. If you encounter an error, try again with the ID directly: "${invoiceId || ''}"
5. This system message is invisible to the user - they should only see your response to processing their invoice.
6. NEVER show error messages or raw JSON to the user. If there's an error, say "I'm processing your invoice..." and try again.`
        });
      }, 100);
    } else if (!systemMessageSentRef.current &&
      lastUploadedInvoice.filename &&
      lastUploadedInvoice.invoiceId &&
      allMessages.length === initialMessages.length) {
      // Handle previously uploaded invoice that hasn't been addressed yet
      systemMessageSentRef.current = true;
      append({
        role: 'system',
        content: `IMPORTANT: The user previously uploaded an invoice with filename "${lastUploadedInvoice.filename}" and ID "${lastUploadedInvoice.invoiceId}".

1. You MUST process it using the uploadInvoice tool with the filename parameter set to exactly: "${lastUploadedInvoice.filename}".
2. DO NOT ask them to upload an invoice - they already have.
3. After processing, analyze the invoice data and provide insights.
4. If you encounter an error, try again with the ID directly: "${lastUploadedInvoice.invoiceId || ''}"
5. This system message is invisible to the user - they should only see your response to processing their invoice.
6. NEVER show error messages or raw JSON to the user. If there's an error, say "I'm processing your invoice..." and try again.`
      });
    }
  }, [allMessages, append, lastUploadedInvoice, initialMessages.length]);

  return (
    <>
      <div className="flex flex-col min-w-0 h-dvh bg-background">
        <ChatHeader
          chatId={id}
          selectedModelId={selectedChatModel}
          selectedVisibilityType={selectedVisibilityType}
          isReadonly={false}
        />

        <Messages
          chatId={id}
          isLoading={isLoading}
          votes={votes}
          messages={messages}
          setMessages={setMessages}
          reload={reload}
          isReadonly={false}
          isBlockVisible={isBlockVisible}
        />

        <form className="flex mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full md:max-w-3xl">
          <MultimodalInput
            chatId={id}
            input={input}
            setInput={setInput}
            handleSubmit={handleSubmit}
            isLoading={isLoading}
            stop={stop}
            attachments={attachments}
            setAttachments={setAttachments}
            messages={messages}
            setMessages={setMessages}
            append={append}
            currentInvoiceId={currentInvoiceId}
            setCurrentInvoiceId={setCurrentInvoiceId}
            currentInvoiceFilename={currentInvoiceFilename}
            setCurrentInvoiceFilename={setCurrentInvoiceFilename}
          />
        </form>
      </div>

      <Block
        chatId={id}
        input={input}
        setInput={setInput}
        handleSubmit={handleSubmit}
        isLoading={isLoading}
        stop={stop}
        attachments={attachments}
        setAttachments={setAttachments}
        append={append}
        messages={messages}
        setMessages={setMessages}
        reload={reload}
        votes={votes}
        isReadonly={false}
      />
    </>
  );
}