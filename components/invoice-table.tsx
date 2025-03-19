'use client';

import React from 'react';
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
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { ChevronDown, ChevronRight } from 'lucide-react';

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
  const [openInvoices, setOpenInvoices] = useState<Record<string, boolean>>({});
  const [allExpanded, setAllExpanded] = useState(false);

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
        onClick={(e) => {
          e.stopPropagation(); // Prevent collapsible toggle
          setEditingCell({ invoiceId, itemId, field });
        }}
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

  // Toggle open state for an invoice
  const toggleInvoice = (invoiceId: string) => {
    setOpenInvoices(prev => ({
      ...prev,
      [invoiceId]: !prev[invoiceId]
    }));
  };

  // Toggle all invoices open/closed
  const toggleAllInvoices = () => {
    const newState = !allExpanded;
    setAllExpanded(newState);

    const newOpenState: Record<string, boolean> = {};
    invoices.forEach(invoice => {
      newOpenState[invoice.id] = newState;
    });

    setOpenInvoices(newOpenState);
  };

  if (loading) {
    return <div className="p-4">Loading invoices...</div>;
  }

  if (invoices.length === 0) {
    return <div className="p-4">No invoices found. Upload an invoice to get started.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Invoices</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={toggleAllInvoices}
          className="flex items-center gap-1"
        >
          {allExpanded ? (
            <>
              <ChevronDown size={16} />
              Collapse All
            </>
          ) : (
            <>
              <ChevronRight size={16} />
              Expand All
            </>
          )}
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"></TableHead>
              <TableHead className="min-w-[120px]">Customer</TableHead>
              <TableHead className="min-w-[120px]">Vendor</TableHead>
              <TableHead className="min-w-[100px]">Invoice #</TableHead>
              <TableHead className="min-w-[100px]">Invoice Date</TableHead>
              <TableHead className="min-w-[100px]">Due Date</TableHead>
              <TableHead className="min-w-[120px]">Total Amount</TableHead>
              <TableHead className="w-[80px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((invoice) => (
              <React.Fragment key={invoice.id}>
                <TableRow
                  className={`cursor-pointer ${openInvoices[invoice.id] ? 'bg-gray-50 border-b-0' : 'hover:bg-gray-50'}`}
                  onClick={() => toggleInvoice(invoice.id)}
                >
                  <TableCell>
                    <div className="flex items-center justify-center w-6 h-6 rounded-full">
                      {openInvoices[invoice.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{invoice.customerName}</TableCell>
                  <TableCell>{invoice.vendorName}</TableCell>
                  <TableCell>{invoice.invoiceNumber}</TableCell>
                  <TableCell>{formatDate(invoice.invoiceDate)}</TableCell>
                  <TableCell>{formatDate(invoice.dueDate)}</TableCell>
                  <TableCell className="font-medium">{formatCurrency(invoice.amount)}</TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation(); // Prevent row toggle
                        saveChanges(invoice.id);
                      }}
                      disabled={saving}
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </Button>
                  </TableCell>
                </TableRow>
                {openInvoices[invoice.id] && (
                  <TableRow key={`details-${invoice.id}`}>
                    <TableCell colSpan={8} className="p-0">
                      <div className="p-4 bg-gray-50 border-t-0 border-x border-b rounded-b-md shadow-inner">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
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

                        <div className="overflow-x-auto">
                          <Table>
                            <TableCaption>Line Items</TableCaption>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="min-w-[200px]">Description</TableHead>
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
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}