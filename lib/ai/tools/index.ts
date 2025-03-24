import { getWeather } from './get-weather';
import { uploadInvoice } from './upload-invoice';
import { createDocument } from './create-document';
import { updateDocument } from './update-document';
import { requestSuggestions } from './request-suggestions';
import type { Session } from 'next-auth';
import type { DataStreamWriter } from 'ai';

export const createTools = ({
  session,
  dataStream,
}: {
  session: Session;
  dataStream: DataStreamWriter;
}) => ({
  getWeather,
  uploadInvoice,
  createDocument: createDocument({ session, dataStream }),
  updateDocument: updateDocument({ session, dataStream }),
  requestSuggestions: requestSuggestions({ session, dataStream }),
});

export {
  getWeather,
  uploadInvoice,
  createDocument,
  updateDocument,
  requestSuggestions,
};