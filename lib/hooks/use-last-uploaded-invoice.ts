import { useEffect, useState } from 'react';

/**
 * Custom hook to retrieve the last uploaded invoice information from localStorage
 * This helps ensure the AI agent is aware of any invoice that was uploaded
 * through the UI before the current conversation
 */
export function useLastUploadedInvoice() {
  const [lastUploadedInvoice, setLastUploadedInvoice] = useState<{
    filename: string | null;
    invoiceId: string | null;
  }>({
    filename: null,
    invoiceId: null,
  });

  useEffect(() => {
    // Only run in browser environment
    if (typeof window === 'undefined') return;

    // Get the last uploaded invoice information from localStorage
    const filename = localStorage.getItem('lastUploadedInvoiceFilename');
    const invoiceId = localStorage.getItem('lastUploadedInvoiceId');

    if (filename && invoiceId) {
      setLastUploadedInvoice({ filename, invoiceId });
    }
  }, []);

  return lastUploadedInvoice;
}