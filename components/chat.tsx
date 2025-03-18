'use client';

import type { Attachment, Message, CreateMessage } from 'ai';
import { useChat } from 'ai/react';
import { useState, useRef, useEffect } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useSearchParams } from 'next/navigation';

import { ChatHeader } from '@/components/chat-header';
import type { Vote } from '@/lib/db/schema';
import { fetcher, generateUUID } from '@/lib/utils';

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
  const containerRef = useRef<HTMLDivElement>(null);
  const isReadonly = false;
  const searchParams = useSearchParams();
  const isInvoiceUpload = searchParams.get('upload') === 'invoice';

  const {
    messages,
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

  const { data: votes } = useSWR<Array<Vote>>(
    `/api/vote?chatId=${id}`,
    fetcher,
  );

  const [attachments, setAttachments] = useState<Array<Attachment>>([]);
  const isBlockVisible = useBlockSelector((state) => state.isVisible);

  // Handle invoice data if present
  useEffect(() => {
    // Only run once when component mounts and isInvoiceUpload is true
    if (isInvoiceUpload) {
      // Get invoice data from sessionStorage
      const invoiceDataStr = sessionStorage.getItem('invoice-data');
      if (!invoiceDataStr) return;

      // Remove the data from sessionStorage immediately to prevent duplicate processing
      sessionStorage.removeItem('invoice-data');

      try {
        // Parse the invoice data
        const invoiceData = JSON.parse(invoiceDataStr);

        if (invoiceData.csvData) {
          // Add a small delay to ensure the chat is ready
          setTimeout(() => {
            // Create a message that explicitly requests a sheet
            const message: CreateMessage = {
              content: `Please create a sheet with this invoice data from ${invoiceData.fileName}:\n\n${invoiceData.csvData}`,
              role: 'user',
            };

            // Send the message to be processed by the AI
            append(message);

            toast.success('Invoice data loaded - creating spreadsheet...');
          }, 500);
        }
      } catch (error) {
        console.error('Error processing invoice data:', error);
        toast.error('Failed to process invoice data');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array - run only once on mount

  const handleReset = () => {
    setMessages([]);
  };

  return (
    <div className="flex-1 h-full">
      <div className="h-full flex flex-col overflow-auto">
        <ChatHeader
          selectedModelId={selectedChatModel}
          selectedVisibilityType={selectedVisibilityType}
          isReadonly={isReadonly}
          chatId={id}
        />
        <div
          className="overflow-auto flex-1 flex pb-[200px] flex-col justify-end"
          ref={containerRef}
        >
          <Messages
            messages={messages}
            setMessages={setMessages}
            isLoading={isLoading}
            isReadonly={isReadonly}
            chatId={id}
            reload={reload}
            votes={votes}
            isBlockVisible={isBlockVisible}
          />
        </div>
        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-background from-50% to-transparent h-36 pointer-events-none z-20" />
        <div className="absolute bottom-0 inset-x-0 px-4 space-y-4 pb-3 px-4 w-full max-w-3xl mx-auto">
          {!isReadonly && (
            <MultimodalInput
              chatId={id}
              input={input}
              setInput={setInput}
              isLoading={isLoading}
              stop={stop}
              attachments={attachments}
              setAttachments={setAttachments}
              messages={messages}
              setMessages={setMessages}
              append={append}
              handleSubmit={handleSubmit}
            />
          )}
        </div>
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
    </div>
  );
}
