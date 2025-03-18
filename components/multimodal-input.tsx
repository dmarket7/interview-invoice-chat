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
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
            const uploadPromises = files.map(file => uploadFile(file, currentInput));
            const uploadedAttachments = await Promise.all(uploadPromises);
            const successfullyUploadedAttachments = uploadedAttachments.filter(
              (attachment) => attachment !== undefined,
            );

            // Submit with the uploaded attachments
            handleSubmit(undefined, {
              experimental_attachments: successfullyUploadedAttachments,
            });
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
        // If no uploads, just submit with existing attachments
        handleSubmit(undefined, {
          experimental_attachments: attachments,
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
    if (userInput && /process\s+this\s+invoice|extract\s+invoice|analyze\s+invoice|read\s+invoice/i.test(userInput)) {
      formData.append('type', 'invoice');
    }

    try {
      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        const { url, pathname, contentType } = data;

        // If this is invoice data and contains processed results, store in sessionStorage
        if (data.isInvoice && data.csvData) {
          const storageKey = `file-data-${Date.now()}`;
          sessionStorage.setItem(storageKey, JSON.stringify({
            csvData: data.csvData,
            extractedData: data.extractedData,
            fileName: file.name,
            contentType
          }));

          // Return a reference to the data in sessionStorage instead of the raw data
          return {
            url: `sessionStorage://${storageKey}`,
            name: pathname,
            contentType: contentType,
            isStorageReference: true
          };
        }

        // For large files of other types, also consider storing in sessionStorage
        // to avoid token overflow if file size is over 1MB
        if (fileSizeInMB > 1) {
          const storageKey = `file-data-${Date.now()}`;
          sessionStorage.setItem(storageKey, JSON.stringify({
            url,
            name: pathname,
            contentType,
            fileName: file.name,
            sizeInMB: fileSizeInMB.toFixed(1)
          }));

          // Return a reference that includes size info for the UI
          return {
            url: `sessionStorage://${storageKey}`,
            name: `${pathname} (${fileSizeInMB.toFixed(1)}MB - stored locally)`,
            contentType: contentType,
            isStorageReference: true
          };
        }

        return {
          url,
          name: pathname,
          contentType: contentType,
        };
      }
      const { error } = await response.json();
      toast.error(error);
    } catch (error) {
      toast.error('Failed to upload file, please try again!');
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
              isUploading={true}
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
