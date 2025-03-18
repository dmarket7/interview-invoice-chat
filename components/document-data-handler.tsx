'use client';

import { useEffect } from 'react';
import { useBlock } from '@/hooks/use-block';
import { toast } from 'sonner';

export function DocumentDataHandler({ documentId }: { documentId: string; }) {
  const { setBlock } = useBlock();

  useEffect(() => {
    const fetchDocument = async () => {
      try {
        const response = await fetch(`/api/document?id=${documentId}`);

        if (!response.ok) {
          throw new Error('Failed to fetch document');
        }

        const documents = await response.json();

        if (documents && documents.length > 0) {
          // Get the most recent document
          const latestDocument = documents[documents.length - 1];

          setBlock({
            documentId,
            title: latestDocument.title || 'Invoice Data Sheet',
            kind: latestDocument.kind || 'sheet',
            content: latestDocument.content || '',
            isVisible: true,
            status: 'idle',
            boundingBox: {
              top: 100,
              left: 100,
              width: 800,
              height: 600
            }
          });
        }
      } catch (error) {
        console.error('Error loading document:', error);
        toast.error('Failed to load document data');
      }
    };

    if (documentId) {
      fetchDocument();
    }
  }, [documentId, setBlock]);

  return null;
}