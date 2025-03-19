'use client';

import { useState, useEffect } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption
} from './ui/table';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from 'sonner';

// Define types for invoice and line item based on the database schema
type Invoice = {
  id: string;
  customerName: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: Date | null;
  dueDate: Date | null;
  amount: number | null;
  lineItems: LineItem[];
};

type LineItem = {
  id: string;
  invoiceId: string;
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
};

export function InvoiceTable() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingCell, setEditingCell] = useState<{
    invoiceId: string;
    itemId?: string;
    field: string;
  } | null>(null);

  // Load invoices and line items
  useEffect(() => {
    async function loadInvoices() {
      try {
        const response = await fetch('/api/invoices');
        if (!response.ok) throw new Error('Failed to load invoices');
        const data = await response.json();
        setInvoices(data);
      } catch (error) {
        console.error('Error loading invoices:', error);
        toast.error('Failed to load invoices');
      } finally {
        setLoading(false);
      }
    }

    loadInvoices();
  }, []);

  // Handle cell edit
  const handleCellEdit = (value: string, invoiceId: string, itemId: string | undefined, field: string) => {
    const updatedInvoices = invoices.map(invoice => {
      if (invoice.id === invoiceId) {
        if (itemId) {
          // Update line item
          return {
            ...invoice,
            lineItems: invoice.lineItems.map(item => {
              if (item.id === itemId) {
                return {
                  ...item,
                  [field]: field === 'description' ? value : Number(value) || 0
                };
              }
              return item;
            })
          };
        } else {
          // Update invoice
          return {
            ...invoice,
            [field]: field === 'customerName' || field === 'vendorName' || field === 'invoiceNumber'
              ? value
              : field === 'invoiceDate' || field === 'dueDate'
                ? new Date(value)
                : Number(value) || 0
          };
        }
      }
      return invoice;
    });

    setInvoices(updatedInvoices);
  };

  // Format date for display and editing
  const formatDate = (date: Date | null) => {
    if (!date) return '';
    const d = new Date(date);
    return d.toISOString().split('T')[0];
  };

  // Format currency for display
  const formatCurrency = (amount: number | null) => {
    if (amount === null) return '';
    // Assuming amount is stored in cents
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount / 100);
  };

  // Update the line item amount based on quantity and unit price
  const updateLineItemAmount = (invoiceId: string, itemId: string) => {
    const updatedInvoices = invoices.map(invoice => {
      if (invoice.id === invoiceId) {
        const updatedLineItems = invoice.lineItems.map(item => {
          if (item.id === itemId) {
            const quantity = item.quantity || 0;
            const unitPrice = item.unitPrice || 0;
            const amount = quantity * unitPrice;
            return { ...item, amount };
          }
          return item;
        });

        // Recalculate invoice total
        const newTotal = updatedLineItems.reduce((sum, item) => sum + (item.amount || 0), 0);

        return {
          ...invoice,
          lineItems: updatedLineItems,
          amount: newTotal
        };
      }
      return invoice;
    });

    setInvoices(updatedInvoices);
  };

  // Save changes to the server
  const saveChanges = async (invoiceId: string) => {
    setSaving(true);
    const invoice = invoices.find(inv => inv.id === invoiceId);

    if (!invoice) {
      toast.error('Invoice not found');
      setSaving(false);
      return;
    }

    try {
      const response = await fetch(`/api/invoices/${invoiceId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(invoice),
      });

      if (!response.ok) throw new Error('Failed to save changes');

      toast.success('Changes saved successfully');
    } catch (error) {
      console.error('Error saving invoice:', error);
      toast.error('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  // Render editable cell
  const renderEditableCell = (
    value: string | number | null,
    invoiceId: string,
    itemId: string | undefined,
    field: string,
    type: 'text' | 'number' | 'date' = 'text'
  ) => {
    const isEditing =
      editingCell?.invoiceId === invoiceId &&
      editingCell?.itemId === itemId &&
      editingCell?.field === field;

    if (isEditing) {
      return (
        <Input
          type={type}
          value={value || ''}
          onChange={(e) => handleCellEdit(e.target.value, invoiceId, itemId, field)}
          onBlur={() => {
            setEditingCell(null);
            if (field === 'quantity' || field === 'unitPrice') {
              updateLineItemAmount(invoiceId, itemId!);
            }
          }}
          autoFocus
          className="w-full"
        />
      );
    }

    return (
      <div
        onClick={() => setEditingCell({ invoiceId, itemId, field })}
        className="cursor-pointer hover:bg-gray-100 px-2 py-1 rounded"
      >
        {field === 'amount' || field === 'unitPrice'
          ? formatCurrency(value as number)
          : field === 'invoiceDate' || field === 'dueDate'
            ? typeof value === 'string' ? value : formatDate(value as Date | null)
            : value || ''}
      </div>
    );
  };

  if (loading) {
    return <div className="p-4">Loading invoices...</div>;
  }

  if (invoices.length === 0) {
    return <div className="p-4">No invoices found. Upload an invoice to get started.</div>;
  }

  return (
    <div className="space-y-8">
      {invoices.map((invoice) => (
        <div key={invoice.id} className="border rounded-lg p-4">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-medium">Invoice #{invoice.invoiceNumber}</h3>
            <Button
              onClick={() => saveChanges(invoice.id)}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <div className="text-sm font-medium mb-1">Customer</div>
              {renderEditableCell(invoice.customerName, invoice.id, undefined, 'customerName')}
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Vendor</div>
              {renderEditableCell(invoice.vendorName, invoice.id, undefined, 'vendorName')}
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Invoice Number</div>
              {renderEditableCell(invoice.invoiceNumber, invoice.id, undefined, 'invoiceNumber')}
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Invoice Date</div>
              {renderEditableCell(formatDate(invoice.invoiceDate), invoice.id, undefined, 'invoiceDate', 'date')}
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Due Date</div>
              {renderEditableCell(formatDate(invoice.dueDate), invoice.id, undefined, 'dueDate', 'date')}
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Total Amount</div>
              <div className="font-medium text-lg">{formatCurrency(invoice.amount)}</div>
            </div>
          </div>

          <Table>
            <TableCaption>Line Items</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead className="w-[100px]">Quantity</TableHead>
                <TableHead className="w-[150px]">Unit Price</TableHead>
                <TableHead className="w-[150px]">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.lineItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    {renderEditableCell(item.description, invoice.id, item.id, 'description')}
                  </TableCell>
                  <TableCell>
                    {renderEditableCell(item.quantity, invoice.id, item.id, 'quantity', 'number')}
                  </TableCell>
                  <TableCell>
                    {renderEditableCell(item.unitPrice, invoice.id, item.id, 'unitPrice', 'number')}
                  </TableCell>
                  <TableCell>{formatCurrency(item.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell>{formatCurrency(invoice.amount)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      ))}
    </div>
  );
}