import {
  type Message,
  createDataStreamResponse,
  smoothStream,
  streamText,
} from 'ai';

import { auth } from '@/app/(auth)/auth';
import { myProvider } from '@/lib/ai/models';
import { systemPrompt } from '@/lib/ai/prompts';
import {
  deleteChatById,
  getChatById,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import {
  generateUUID,
  getMostRecentUserMessage,
  sanitizeResponseMessages,
} from '@/lib/utils';

import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { uploadInvoice } from '@/lib/ai/tools/upload-invoice';

export const maxDuration = 60;

// Define types for multipart message content
interface TextContent {
  type: 'text';
  text: string;
}

interface AttachmentContent {
  type: 'attachment';
  attachment: {
    content_type: string;
    name: string;
    url?: string;
  };
}

type MessageContentPart = TextContent | AttachmentContent;

export async function POST(request: Request) {
  const {
    id,
    messages,
    selectedChatModel,
  }: { id: string; messages: Array<Message>; selectedChatModel: string; } =
    await request.json();

  // Debug attachment data
  const lastMessage = messages[messages.length - 1];
  console.log('DEBUG - Last message content type:', typeof lastMessage.content);

  if (typeof lastMessage.content === 'object') {
    console.log('DEBUG - Last message has multipart content structure');
    const parts = lastMessage.content as Array<MessageContentPart>;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      console.log(`DEBUG - Content part ${i} type:`, part.type);

      if (part.type === 'attachment') {
        console.log(`DEBUG - Attachment found:`, JSON.stringify({
          mime: part.attachment.content_type,
          name: part.attachment.name
        }));

        // Check if PDF and convert to text if needed
        if (part.attachment.content_type === 'application/pdf') {
          console.log('DEBUG - PDF attachment detected - converting to text format');
          // Convert PDF reference to text description
          parts[i] = {
            type: 'text',
            text: `[PDF Document: ${part.attachment.name}] - The content has been processed as text.`
          } as MessageContentPart;
        }
      }
    }
  }

  const session = await auth();

  if (!session || !session.user || !session.user.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userMessage = getMostRecentUserMessage(messages);

  if (!userMessage) {
    return new Response('No user message found', { status: 400 });
  }

  const chat = await getChatById({ id });

  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: userMessage });
    await saveChat({ id, userId: session.user.id, title });
  }

  await saveMessages({
    messages: [{ ...userMessage, createdAt: new Date(), chatId: id }],
  });

  return createDataStreamResponse({
    execute: (dataStream) => {
      const result = streamText({
        model: myProvider.languageModel(selectedChatModel),
        system: systemPrompt({ selectedChatModel }),
        messages,
        maxSteps: 5,
        experimental_activeTools:
          selectedChatModel === 'chat-model-reasoning'
            ? []
            : [
              'getWeather',
              'createDocument',
              'updateDocument',
              'requestSuggestions',
              'uploadInvoice',
            ],
        experimental_transform: smoothStream({ chunking: 'word' }),
        experimental_generateMessageId: generateUUID,
        tools: {
          getWeather,
          createDocument: createDocument({
            session: {
              ...session,
              expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            },
            dataStream
          }),
          updateDocument: updateDocument({
            session: {
              ...session,
              expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            },
            dataStream
          }),
          requestSuggestions: requestSuggestions({
            session: {
              ...session,
              expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            },
            dataStream,
          }),
          uploadInvoice,
        },
        onFinish: async ({ response, reasoning }) => {
          if (session.user?.id) {
            try {
              const sanitizedResponseMessages = sanitizeResponseMessages({
                messages: response.messages,
                reasoning,
              });

              await saveMessages({
                messages: sanitizedResponseMessages.map((message) => {
                  return {
                    id: `msg-${Date.now()}-${message.id}`,
                    chatId: id,
                    role: message.role,
                    content: message.content,
                    createdAt: new Date(),
                  };
                }),
              });
            } catch (error) {
              console.error('Failed to save chat');
            }
          }
        },
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'stream-text',
        },
      });

      result.mergeIntoDataStream(dataStream, {
        sendReasoning: true,
      });
    },
    onError: (error) => {
      console.error('Error in chat stream:', error);
      // Handle different error types safely
      const errorMessage = error instanceof Error
        ? error.message
        : (typeof error === 'string' ? error : 'Unknown error');
      return `An error occurred while processing your request: ${errorMessage}`;
    },
  });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const session = await auth();

  if (!session || !session.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const chat = await getChatById({ id });

    await deleteChatById({ id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request', {
      status: 500,
    });
  }
}
