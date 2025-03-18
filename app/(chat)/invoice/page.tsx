import { auth } from '@/app/(auth)/auth';
import { InvoiceUpload } from '@/components/invoice-upload';
import { redirect } from 'next/navigation';

export default async function InvoicePage() {
  const session = await auth();

  if (!session?.user) {
    redirect('/sign-in');
  }

  return (
    <div className="container max-w-2xl py-10">
      <h1 className="text-2xl font-bold mb-6">Invoice Processing</h1>
      <div className="space-y-4">
        <p className="text-muted-foreground">
          Upload an invoice PDF to automatically extract data into a spreadsheet.
          You&apos;ll be able to review and edit the data before saving to the database.
        </p>
        <InvoiceUpload />
      </div>
    </div>
  );
}