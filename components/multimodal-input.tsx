'use client';

import type {
  Attachment,
  ChatRequestOptions,
  CreateMessage,
  Message,
} from 'ai';
import cx from 'classnames';
import type React from 'react';
import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type Dispatch,
  type SetStateAction,
  type ChangeEvent,
  memo,
} from 'react';
import { toast } from 'sonner';
import { useLocalStorage, useWindowSize } from 'usehooks-ts';
import { nanoid } from 'nanoid';

import { sanitizeUIMessages } from '@/lib/utils';

import { ArrowUpIcon, PaperclipIcon, StopIcon } from './icons';
import { PreviewAttachment } from './preview-attachment';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { SuggestedActions } from './suggested-actions';
import equal from 'fast-deep-equal';

function PureMultimodalInput({
  chatId,
  input,
  setInput,
  isLoading,
  stop,
  attachments,
  setAttachments,
  messages,
  setMessages,
  append,
  handleSubmit,
  className,
  currentInvoiceId,
  setCurrentInvoiceId,
  currentInvoiceFilename,
  setCurrentInvoiceFilename,
}: {
  chatId: string;
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  stop: () => void;
  attachments: Array<Attachment>;
  setAttachments: Dispatch<SetStateAction<Array<Attachment>>>;
  messages: Array<Message>;
  setMessages: Dispatch<SetStateAction<Array<Message>>>;
  append: (
    message: Message | CreateMessage,
    chatRequestOptions?: ChatRequestOptions,
  ) => Promise<string | null | undefined>;
  handleSubmit: (
    event?: {
      preventDefault?: () => void;
    },
    chatRequestOptions?: ChatRequestOptions,
  ) => void;
  className?: string;
  currentInvoiceId: string | null;
  setCurrentInvoiceId: Dispatch<SetStateAction<string | null>>;
  currentInvoiceFilename: string | null;
  setCurrentInvoiceFilename: Dispatch<SetStateAction<string | null>>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const { width } = useWindowSize();

  useEffect(() => {
    if (textareaRef.current) {
      adjustHeight();
    }
  }, []);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight + 2}px`;
    }
  };

  const resetHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = '98px';
    }
  };

  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    'input',
    '',
  );

  useEffect(() => {
    if (textareaRef.current) {
      const domValue = textareaRef.current.value;
      // Prefer DOM value over localStorage to handle hydration
      const finalValue = domValue || localStorageInput || '';
      setInput(finalValue);
      adjustHeight();
    }
    // Only run once after hydration
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLocalStorageInput(input);
  }, [input, setLocalStorageInput]);

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
    adjustHeight();
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<Array<string>>([]);

  const submitForm = useCallback(() => {
    window.history.replaceState({}, '', `/chat/${chatId}`);

    // Store current input value before clearing it
    const currentInput = input;

    // Immediately clear the input and local storage
    setInput('');
    setLocalStorageInput('');
    resetHeight();

    // Process any pending file uploads with the saved input text
    const processUploads = async () => {
      if (uploadQueue.length > 0) {
        try {
          const fileList = fileInputRef.current?.files;
          if (fileList) {
            const files = Array.from(fileList);

            // First, add a message indicating upload is in progress
            // This prevents the AI from responding before the upload completes
            const uploadingMessageId = nanoid();
            append({
              id: uploadingMessageId,
              role: 'user',
              content: currentInput ?
                `${currentInput}\n\n[Uploading file(s): ${files.map(f => f.name).join(', ')}...]` :
                `[Uploading file(s): ${files.map(f => f.name).join(', ')}...]`,
            });

            // Process uploads
            const uploadPromises = files.map(file => uploadFile(file, currentInput));
            const uploadResults = await Promise.all(uploadPromises);

            // Filter out undefined results
            const validResults = uploadResults.filter(result => result !== undefined);

            // Check if we have text modifications to add to the user's message
            const textModifications = validResults
              .filter(result => result.textModification)
              .map(result => result.textModification)
              .join('');

            // Filter to get only valid attachments (no textModification ones)
            const validAttachments = validResults
              .filter(result => !result.skipAttachment)
              .map(result => ({
                url: result.url,
                name: result.name,
                contentType: result.contentType
              }));

            // Remove the temporary "uploading" message
            setMessages(prevMessages => prevMessages.filter(msg => msg.id !== uploadingMessageId));

            // Add text modifications to the input before submitting
            const finalUserMessage = currentInput + textModifications;

            // First send user message with upload context
            const messageId = await append({
              role: 'user',
              content: finalUserMessage,
            }, {
              experimental_attachments: validAttachments.length > 0 ? validAttachments : [],
            });

            // Check if this is an invoice upload based on the presence of "invoice file" in textModifications
            const isInvoiceUpload = validResults.some(r => r.textModification?.includes('invoice file'));

            // If an invoice was uploaded, immediately inject a system message to guide the AI
            if (isInvoiceUpload && messageId) {
              // Give a small delay to ensure the user message is processed first
              setTimeout(() => {
                append({
                  role: 'system',
                  content: `IMPORTANT: The user has just uploaded an invoice file as shown in their message. Please process it using the uploadInvoice tool with the filename parameter set to the filename shown in their message. Do not ask them to upload an invoice.`
                });
              }, 100);
            }
          }
        } catch (error) {
          console.error('Error uploading files!', error);
          toast.error('Failed to upload file, please try again!');
          return;
        } finally {
          setUploadQueue([]);
          setAttachments([]);
        }
      } else {
        // If no uploads, just submit with existing attachments - ensure no PDFs
        console.log('DEBUG - Submitting with existing attachments:', JSON.stringify(attachments));

        // Process attachments to ensure no PDF mime types are sent directly
        const processedAttachments = attachments.map(attachment => {
          if (attachment.contentType === 'application/pdf') {
            // For PDFs, use a text-based data URL instead
            return {
              url: attachment.url,
              name: attachment.name,
              contentType: 'text/plain', // Change to text format
            };
          }
          return attachment;
        });

        handleSubmit(undefined, {
          experimental_attachments: processedAttachments,
        });
        setAttachments([]);
      }

      if (width && width > 768) {
        textareaRef.current?.focus();
      }
    };

    processUploads();
  }, [
    attachments,
    handleSubmit,
    setAttachments,
    setInput,
    setLocalStorageInput,
    width,
    chatId,
    uploadQueue,
    input,
    append,
    setMessages,
  ]);

  const uploadFile = async (file: File, userInput: string) => {
    // Check file size - roughly estimate tokens based on size
    // A rough estimate: 1 MB can be around 250K-750K tokens depending on content type
    const MAX_FILE_SIZE_MB = 5; // Limit to 5MB
    const fileSizeInMB = file.size / (1024 * 1024);

    if (fileSizeInMB > MAX_FILE_SIZE_MB) {
      toast.error(`File ${file.name} is too large (${fileSizeInMB.toFixed(1)}MB). Maximum size is ${MAX_FILE_SIZE_MB}MB to prevent context overflow.`);
      return undefined;
    }

    const formData = new FormData();
    formData.append('file', file);

    // Check if user message indicates this is an invoice
    const userIsAskingToSubmitInvoice = userInput && /(?=.*\binvoice\b)|(?=.*\b(process|scan|extract)\b)/i.test(userInput);
    if (userIsAskingToSubmitInvoice) {
      formData.append('type', 'invoice');
    }

    try {
      setIsUploading(true);
      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        const { url, pathname, contentType } = data;

        // PDF files need special handling to avoid the OpenAI API error
        if (contentType === 'application/pdf') {
          // For invoices, we already have structured data processing
          if (data.isInvoice && data.csvData) {
            // Store invoice information for later use by the agent
            if (data.invoiceId) {
              console.log('Setting invoice data:', data.invoiceId);
              setCurrentInvoiceId(data.invoiceId);
              setCurrentInvoiceFilename(pathname);

              // Show a toast to inform the user
              toast.success('Invoice uploaded successfully! The AI will process it automatically.');
            }

            // Create a text representation instead of sending raw PDF
            const textContent = `Document: ${data.documentTitle || `Invoice: ${file.name}`}\n\n` +
              `Extracted Invoice Data:\n${JSON.stringify(data.extractedData, null, 2)}\n\n` +
              `CSV Data:\n${data.csvData}`;

            // Instead of appending an assistant message, modify the user's input
            // to include the invoice information
            if (data.invoiceId) {
              // Show success toast instead of appending a message
              toast.success(`Invoice processed successfully with ID: ${data.invoiceId}`);

              // Store invoice ID and filename for the agent to use
              setCurrentInvoiceId(data.invoiceId);
              setCurrentInvoiceFilename(pathname);

              // Return an explicit message that makes it clear to the AI that
              // an invoice has already been processed and is ready for analysis
              return {
                textModification: `\n\n[INVOICE UPLOADED]
I've uploaded an invoice file "${file.name}" with ID: ${data.invoiceId}.

INVOICE DETAILS:
- Vendor: ${data.extractedData?.vendor || 'unknown vendor'}
- Customer: ${data.extractedData?.customer || 'unknown customer'}
- Total: ${data.extractedData?.total || 'unknown amount'}
- Invoice Number: ${data.extractedData?.invoiceNumber || 'unknown'}
- Date: ${data.extractedData?.date || 'unknown'}

Please analyze this invoice data using the uploadInvoice tool. The correct filename parameter to use is exactly: "${pathname}"`,
                skipAttachment: true
              };
            }

            // Return text content in a format compatible with the API
            return {
              url: `data:text/plain;base64,${btoa(textContent)}`,
              name: pathname,
              contentType: 'text/plain',
            };
          }

          // For statements or other PDFs
          if (userIsAskingToSubmitInvoice && data.isStatement) {
            const message = data.message || "This document appears to be an account statement or receipt, not an invoice.";
            toast.info(message);

            // Return a text modification instead of an attachment
            return {
              textModification: `\n\nI've uploaded a document that appears to be a statement or receipt, not an invoice. ${message} Please advise on what I should do next.`,
              skipAttachment: true
            };
          }

          // For other PDFs, use extracted text from server
          if (data.extractedText) {
            // Return a text modification instead of an attachment
            const timestamp = Date.now();
            setCurrentInvoiceFilename(pathname);

            return {
              textModification: `\n\nI've uploaded a PDF document: "${file.name}" with filename "${pathname}". The document contains extracted text. Please analyze this document and provide insights.`,
              skipAttachment: true
            };
          } else {
            // Fallback message if no text was extracted
            return {
              textModification: `\n\nI've uploaded a PDF document: "${file.name}" with filename "${pathname}". Please help me analyze this document.`,
              skipAttachment: true
            };
          }
        }

        // For non-PDF files, return a regular attachment
        if (fileSizeInMB > 1) {
          return {
            url,
            name: `${pathname} (${fileSizeInMB.toFixed(1)}MB)`,
            contentType: contentType,
          };
        }

        return {
          url,
          name: pathname,
          contentType: contentType,
        };
      } else {
        const errorData = await response.json();
        // Only show toast error if it's not an invoice validation issue
        if (!(userIsAskingToSubmitInvoice && errorData.isStatement)) {
          toast.error(errorData.error || 'Failed to upload file');
        }

        // If it's an invoice validation issue, return a text modification
        if (userIsAskingToSubmitInvoice && errorData.isStatement) {
          const message = errorData.message || "This document appears to be an account statement or receipt, not an invoice.";
          toast.info(message);

          return {
            textModification: `\n\nI tried to upload an invoice, but the system detected that this document is likely ${message} Please advise on what I should do next.`,
            skipAttachment: true
          };
        }
      }
    } catch (error) {
      toast.error('Failed to upload file, please try again!');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);

      if (files.length === 0) return;

      // Check total size of all files
      const totalSizeMB = files.reduce((total, file) => total + file.size / (1024 * 1024), 0);
      const MAX_TOTAL_SIZE_MB = 10; // Max 10MB total

      if (totalSizeMB > MAX_TOTAL_SIZE_MB) {
        toast.error(`Total file size (${totalSizeMB.toFixed(1)}MB) exceeds the ${MAX_TOTAL_SIZE_MB}MB limit. Please reduce file sizes to prevent context overflow.`);
        return;
      }

      // Check number of files
      const MAX_FILES = 3;
      if (files.length > MAX_FILES) {
        toast.error(`You can upload a maximum of ${MAX_FILES} files at once to prevent context overflow.`);
        return;
      }

      // Just queue the files for preview but don't upload yet
      setUploadQueue(files.map((file) => file.name));

      // Focus the textarea so the user can type instructions
      textareaRef.current?.focus();
    },
    [],
  );

  return (
    <div className="relative w-full flex flex-col gap-4">
      {messages.length === 0 &&
        attachments.length === 0 &&
        uploadQueue.length === 0 && (
          <SuggestedActions append={append} chatId={chatId} />
        )}

      <input
        type="file"
        className="fixed -top-4 -left-4 size-0.5 opacity-0 pointer-events-none"
        ref={fileInputRef}
        multiple
        onChange={handleFileChange}
        tabIndex={-1}
        disabled={isUploading}
      />

      {(attachments.length > 0 || uploadQueue.length > 0) && (
        <div className="flex flex-row gap-2 overflow-x-scroll items-end">
          {attachments.map((attachment) => (
            <PreviewAttachment key={attachment.url} attachment={attachment} />
          ))}

          {uploadQueue.map((filename) => (
            <PreviewAttachment
              key={filename}
              attachment={{
                url: '',
                name: filename,
                contentType: '',
              }}
              isUploading={isUploading}
            />
          ))}
        </div>
      )}

      <Textarea
        ref={textareaRef}
        placeholder="Send a message..."
        value={input}
        onChange={handleInput}
        className={cx(
          'min-h-[24px] max-h-[calc(75dvh)] overflow-hidden resize-none rounded-2xl !text-base bg-muted pb-10 dark:border-zinc-700',
          className,
        )}
        rows={2}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();

            if (isLoading) {
              toast.error('Please wait for the model to finish its response!');
            } else {
              submitForm();
            }
          }
        }}
      />

      <div className="absolute bottom-0 p-2 w-fit flex flex-row justify-start">
        <AttachmentsButton fileInputRef={fileInputRef} isLoading={isLoading} />
      </div>

      <div className="absolute bottom-0 right-0 p-2 w-fit flex flex-row justify-end">
        {isLoading ? (
          <StopButton stop={stop} setMessages={setMessages} />
        ) : (
          <SendButton
            input={input}
            submitForm={submitForm}
            uploadQueue={uploadQueue}
          />
        )}
      </div>
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) return false;
    if (prevProps.isLoading !== nextProps.isLoading) return false;
    if (!equal(prevProps.attachments, nextProps.attachments)) return false;
    if (prevProps.currentInvoiceId !== nextProps.currentInvoiceId) return false;
    if (prevProps.currentInvoiceFilename !== nextProps.currentInvoiceFilename) return false;

    return true;
  },
);

function PureAttachmentsButton({
  fileInputRef,
  isLoading,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  isLoading: boolean;
}) {
  return (
    <Button
      className="rounded-md rounded-bl-lg p-[7px] h-fit dark:border-zinc-700 hover:dark:bg-zinc-900 hover:bg-zinc-200"
      onClick={(event) => {
        event.preventDefault();
        fileInputRef.current?.click();
      }}
      disabled={isLoading}
      variant="ghost"
    >
      <PaperclipIcon size={14} />
    </Button>
  );
}

const AttachmentsButton = memo(PureAttachmentsButton);

function PureStopButton({
  stop,
  setMessages,
}: {
  stop: () => void;
  setMessages: Dispatch<SetStateAction<Array<Message>>>;
}) {
  return (
    <Button
      className="rounded-full p-1.5 h-fit border dark:border-zinc-600"
      onClick={(event) => {
        event.preventDefault();
        stop();
        setMessages((messages) => sanitizeUIMessages(messages));
      }}
    >
      <StopIcon size={14} />
    </Button>
  );
}

const StopButton = memo(PureStopButton);

function PureSendButton({
  submitForm,
  input,
  uploadQueue,
}: {
  submitForm: () => void;
  input: string;
  uploadQueue: Array<string>;
}) {
  return (
    <Button
      className="rounded-full p-1.5 h-fit border dark:border-zinc-600"
      onClick={(event) => {
        event.preventDefault();
        submitForm();
      }}
      // Enable button if there's text OR files queued for upload
      disabled={input.length === 0 && uploadQueue.length === 0}
    >
      <ArrowUpIcon size={14} />
    </Button>
  );
}

const SendButton = memo(PureSendButton, (prevProps, nextProps) => {
  if (prevProps.uploadQueue.length !== nextProps.uploadQueue.length)
    return false;
  if (prevProps.input !== nextProps.input) return false;
  return true;
});

