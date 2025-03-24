import { InvoiceClientContent } from './invoice-client';

export const metadata = {
  title: 'Invoices',
  description: 'View and manage your invoices',
};

export default function InvoicesPage() {
  return (
    <div className="container p-6 space-y-8">
      <div className="flex flex-col gap-2 pb-4 border-b">
        <h1 className="text-2xl font-bold">Invoices</h1>
        <p className="text-muted-foreground">
          Upload, view, and manage your invoices
        </p>
      </div>

      <InvoiceClientContent />
    </div>
  );
}