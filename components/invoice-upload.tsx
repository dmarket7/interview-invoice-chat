'use client';

import { useState } from 'react';
import { Button } from './ui/button';
import { FileIcon, UploadIcon } from './icons';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';


export function InvoiceUpload() {
  const [isUploading, setIsUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const router = useRouter();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      // Check if file is PDF
      if (selectedFile.type !== 'application/pdf') {
        toast.error('Please upload a PDF invoice');
        return;
      }
      setFile(selectedFile);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error('Please select a file first');
      return;
    }

    setIsUploading(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'invoice'); // Add type to identify invoice upload

    try {
      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to upload invoice');
      }

      const data = await response.json();

      if (data.isInvoice && data.csvData) {
        // Store the extracted invoice data in sessionStorage to be accessed when the chat loads
        sessionStorage.setItem('invoice-data', JSON.stringify({
          csvData: data.csvData,
          invoiceData: data.extractedData,
          fileName: file.name,
        }));

        // Clear the file after successful upload
        setFile(null);
      } else {
        toast.error('Failed to extract invoice data');
      }
    } catch (error) {
      console.error('Error uploading invoice:', error);
      toast.error('Failed to upload invoice. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="border rounded-xl">
      <div className="flex flex-col gap-4">
        <Collapsible className="data-[state=closed]:hover:bg-secondary/50">
          <CollapsibleTrigger className="flex items-center justify-between w-full h-12 px-4">
            <h2 className="text-lg font-medium">Upload Invoice</h2>
            <ChevronDown size={16} />
          </CollapsibleTrigger>
          <CollapsibleContent className="p-4">
            <>
              <p className="text-muted-foreground text-sm">
                Upload a PDF invoice to automatically extract data.
              </p>

              <div className="flex flex-col gap-4">
                <label
                  htmlFor="invoice-upload"
                  className="border border-dashed rounded-lg p-8 flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-muted transition-colors"
                >
                  <FileIcon size={32} />
                  <p className="text-sm text-muted-foreground">
                    {file ? file.name : 'PDF Invoice (Max 10MB)'}
                  </p>
                  <input
                    id="invoice-upload"
                    type="file"
                    accept="application/pdf"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>

                <Button
                  onClick={handleUpload}
                  disabled={!file || isUploading}
                  className="w-full"
                >
                  {isUploading ? (
                    'Processing...'
                  ) : (
                    <>
                      <UploadIcon size={16} />
                      <span className="ml-2">Upload Invoice</span>
                    </>
                  )}
                </Button>
              </div>
            </>
          </CollapsibleContent>
        </Collapsible>


      </div>
    </div>
  );
}