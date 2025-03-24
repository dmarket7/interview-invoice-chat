'use client';

import { useRef } from 'react';
import { InvoiceUpload } from '@/components/invoice-upload';
import { InvoiceTable, InvoiceTableRef } from '@/components/invoice-table';

export function InvoiceClientContent() {
  const tableRef = useRef<InvoiceTableRef>(null);

  const handleUploadSuccess = () => {
    // Refetch invoices when upload is successful
    tableRef.current?.refetchInvoices();
  };

  return (
    <>
      <div className="w-full md:w-1/3">
        <InvoiceUpload onUploadSuccess={handleUploadSuccess} />
      </div>

      <InvoiceTable ref={tableRef} />
    </>
  );
}