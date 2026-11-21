import { jsPDF } from 'jspdf';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { companySigningAssets, invoices, users } from '../db/schema.ts';
import {
  downloadFromSupabaseStorage,
  isSupabaseStorageConfigured,
  uploadInvoicePdfToSupabase,
  uploadQuotationPdfToSupabase,
} from '../lib/supabase-admin.ts';
import { syncInvoiceToSupabase } from './supabase-ecommerce.ts';

function formatInr(amount: number): string {
  return `Rs. ${Number(amount || 0).toLocaleString('en-IN')}`;
}

async function fetchActiveSigningMedia(): Promise<{
  signatureDataUrl?: string;
  signatoryName?: string;
  signatoryDesignation?: string;
  stampDataUrl?: string;
}> {
  if (!isSupabaseStorageConfigured()) return {};
  try {
    const assets = await db
      .select()
      .from(companySigningAssets)
      .where(and(eq(companySigningAssets.isActive, true), eq(companySigningAssets.isDeleted, false)))
      .orderBy(desc(companySigningAssets.updatedAt));

    const sig = assets.find((a) => a.assetType === 'signature');
    const stamp = assets.find((a) => a.assetType === 'stamp');
    const result: {
      signatureDataUrl?: string;
      signatoryName?: string;
      signatoryDesignation?: string;
      stampDataUrl?: string;
    } = {};

    if (sig) {
      const buf = await downloadFromSupabaseStorage(sig.storageBucket || 'signatures-stamps', sig.storagePath);
      if (buf && buf.length > 0) {
        const mime = sig.mimeType || 'image/png';
        result.signatureDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
        result.signatoryName = sig.signatoryName;
        result.signatoryDesignation = sig.designation;
      }
    }
    if (stamp) {
      const buf = await downloadFromSupabaseStorage(stamp.storageBucket || 'signatures-stamps', stamp.storagePath);
      if (buf && buf.length > 0) {
        const mime = stamp.mimeType || 'image/png';
        result.stampDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function renderInvoicePdfBuffer(invoiceRow: {
  invoiceNumber: string;
  docType: string;
  amountInr: number;
  gstInr: number;
  issuedAt?: Date | string;
  customerId?: string;
  payload: Record<string, any>;
}): Promise<Buffer> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const payload = invoiceRow.payload || {};
  const sigMedia = await fetchActiveSigningMedia();

  // Header band
  doc.setFillColor(10, 22, 46);
  doc.rect(0, 0, 595, 96, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.text('NEXUSTEKFUSION PRIVATE LIMITED', 40, 40);
  doc.setFontSize(9.5);
  doc.setTextColor(186, 230, 253);
  doc.text('Engineering R&D, Robotics, Agricultural Drones & Custom 3D Manufacturing', 40, 58);
  doc.text('Amravati, Maharashtra, India | support@nexustekfusion.com', 40, 74);

  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text(String(invoiceRow.docType || 'TAX INVOICE').toUpperCase(), 555, 42, { align: 'right' });
  doc.setFontSize(10);
  doc.text(`#${invoiceRow.invoiceNumber}`, 555, 60, { align: 'right' });

  // Meta & Bill-To
  doc.setTextColor(30, 41, 59);
  doc.setFontSize(10);
  let y = 128;
  doc.setFont('helvetica', 'bold');
  doc.text('Billed To:', 40, y);
  doc.text('Document Details:', 350, y);
  doc.setFont('helvetica', 'normal');
  y += 16;

  const billing = payload.billingAddress || {};
  const customerName = String(payload.customerName || billing.fullName || 'Customer');
  const customerEmail = String(payload.customerEmail || billing.email || '');
  const customerPhone = String(payload.customerPhone || billing.mobile || '');
  const addressLine = [billing.line1, billing.city, billing.state, billing.pinCode].filter(Boolean).join(', ');

  doc.text(customerName, 40, y);
  if (invoiceRow.customerId) {
    doc.text(`Customer ID: ${invoiceRow.customerId}`, 350, y);
  }
  y += 14;
  if (customerEmail) {
    doc.text(customerEmail, 40, y);
  }
  const issuedStr = invoiceRow.issuedAt
    ? new Date(invoiceRow.issuedAt).toLocaleDateString('en-IN')
    : new Date().toLocaleDateString('en-IN');
  doc.text(`Issued Date: ${issuedStr}`, 350, y);
  y += 14;
  if (customerPhone) {
    doc.text(`Phone: ${customerPhone}`, 40, y);
  }
  if (payload.paymentId || payload.razorpayPaymentId) {
    doc.text(`Payment ID: ${payload.paymentId || payload.razorpayPaymentId}`, 350, y);
  }
  y += 14;
  if (addressLine) {
    const wrapped = doc.splitTextToSize(addressLine, 270);
    doc.text(wrapped, 40, y);
    y += wrapped.length * 13;
  }
  if (payload.orderNumber || payload.projectCode || payload.enquiryNumber) {
    doc.text(
      `Reference: ${payload.orderNumber || payload.projectCode || payload.enquiryNumber}`,
      350,
      Math.max(186, y - 10)
    );
  }

  // Table header
  y = Math.max(y + 24, 240);
  doc.setFillColor(241, 245, 249);
  doc.rect(40, y, 515, 24, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  doc.text('Description / Item', 50, y + 16);
  doc.text('Qty', 360, y + 16, { align: 'right' });
  doc.text('Unit Price', 450, y + 16, { align: 'right' });
  doc.text('Amount', 545, y + 16, { align: 'right' });
  y += 34;

  doc.setFont('helvetica', 'normal');
  const items: Array<Record<string, any>> = Array.isArray(payload.items) && payload.items.length > 0
    ? payload.items
    : [
        {
          name: payload.description || `${invoiceRow.docType} — ${payload.orderNumber || payload.projectCode || invoiceRow.invoiceNumber}`,
          qty: 1,
          unitPriceInr: Math.max(0, Number(invoiceRow.amountInr || 0) - Number(invoiceRow.gstInr || 0)),
          lineTotalInr: Math.max(0, Number(invoiceRow.amountInr || 0) - Number(invoiceRow.gstInr || 0)),
        },
      ];

  for (const item of items) {
    if (y > 680) {
      doc.addPage();
      y = 50;
    }
    const label = String(item.name || item.title || 'Engineering Service / Hardware');
    const qty = Number(item.qty || item.quantity || 1);
    const unitPrice = Number(item.unitPriceInr || item.unit_price || 0);
    const lineTotal = Number(item.lineTotalInr || unitPrice * qty || invoiceRow.amountInr);
    const lines = doc.splitTextToSize(label, 280);
    doc.text(lines, 50, y);
    doc.text(String(qty), 360, y, { align: 'right' });
    doc.text(formatInr(unitPrice), 450, y, { align: 'right' });
    doc.text(formatInr(lineTotal), 545, y, { align: 'right' });
    y += Math.max(20, lines.length * 13 + 6);
    doc.setDrawColor(226, 232, 240);
    doc.line(40, y - 4, 555, y - 4);
  }

  // Summary box
  y += 14;
  const subtotal = Math.max(0, Number(invoiceRow.amountInr || 0) - Number(invoiceRow.gstInr || 0));
  doc.setFontSize(10);
  doc.text('Taxable Subtotal:', 360, y);
  doc.text(formatInr(subtotal), 545, y, { align: 'right' });
  y += 16;
  doc.text('GST / Taxes:', 360, y);
  doc.text(formatInr(Number(invoiceRow.gstInr || 0)), 545, y, { align: 'right' });
  y += 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Grand Total:', 360, y);
  doc.text(formatInr(Number(invoiceRow.amountInr || 0)), 545, y, { align: 'right' });

  // Signature & Stamp section
  const sigY = Math.max(y + 50, 620);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text('Authorized Signatory & Company Seal', 360, sigY);
  doc.setFont('helvetica', 'normal');

  if (sigMedia.stampDataUrl) {
    try {
      const fmt = sigMedia.stampDataUrl.includes('jpeg') || sigMedia.stampDataUrl.includes('jpg') ? 'JPEG' : 'PNG';
      doc.addImage(sigMedia.stampDataUrl, fmt, 360, sigY + 8, 70, 70);
    } catch {
      // Ignore image decode failure in PDF fallback
    }
  }
  if (sigMedia.signatureDataUrl) {
    try {
      const fmt = sigMedia.signatureDataUrl.includes('jpeg') || sigMedia.signatureDataUrl.includes('jpg') ? 'JPEG' : 'PNG';
      doc.addImage(sigMedia.signatureDataUrl, fmt, 445, sigY + 18, 95, 42);
    } catch {
      // Ignore image decode failure in PDF fallback
    }
  }

  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  doc.text(sigMedia.signatoryName || 'NexusTekFusion Accounts & Engineering', 360, sigY + 92);
  doc.text(sigMedia.signatoryDesignation || 'Digitally Issued Cloud Document', 360, sigY + 104);
  doc.text('This is an electronically generated document stored securely in NexusTekFusion Cloud.', 40, 800);

  const ab = doc.output('arraybuffer');
  return Buffer.from(ab);
}

export async function generateAndStoreInvoicePdf(invoiceId: number): Promise<{
  bucket: string;
  storagePath: string;
  buffer: Buffer;
} | null> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) return null;

  let ownerUid = inv.customerId || '';
  if (!ownerUid && inv.userId) {
    const [u] = await db.select().from(users).where(eq(users.id, inv.userId));
    ownerUid = u?.authUserId || u?.uid || `u_${inv.userId}`;
  }

  const buffer = await renderInvoicePdfBuffer({
    invoiceNumber: inv.invoiceNumber,
    docType: inv.docType,
    amountInr: inv.amountInr,
    gstInr: inv.gstInr,
    issuedAt: inv.issuedAt,
    customerId: inv.customerId,
    payload: (inv.payload || {}) as Record<string, any>,
  });

  if (!isSupabaseStorageConfigured()) {
    return { bucket: 'invoices-pdf', storagePath: '', buffer };
  }

  const uploaded = await uploadInvoicePdfToSupabase({
    buffer,
    fileName: `${inv.invoiceNumber}.pdf`,
    ownerUid: ownerUid || 'shared',
  });

  const now = new Date();
  await db
    .update(invoices)
    .set({
      storageBucket: uploaded.bucket,
      pdfStoragePath: uploaded.storagePath,
      pdfGeneratedAt: now,
    })
    .where(eq(invoices.id, inv.id));

  await syncInvoiceToSupabase({
    invoiceNumber: inv.invoiceNumber,
    userUid: ownerUid,
    customerId: inv.customerId,
    entityType: inv.entityType,
    entityId: inv.entityId,
    docType: inv.docType,
    amountInr: inv.amountInr,
    gstInr: inv.gstInr,
    payload: (inv.payload || {}) as Record<string, unknown>,
    storageBucket: uploaded.bucket,
    pdfStoragePath: uploaded.storagePath,
    pdfGeneratedAt: now,
  });

  return { bucket: uploaded.bucket, storagePath: uploaded.storagePath, buffer };
}

export async function generateAndStoreQuotationPdf(params: {
  quotationNumber: string;
  enquiryNumber: string;
  customerName: string;
  customerEmail: string;
  projectTitle: string;
  items: Array<{ name: string; description?: string; qty: number; unitPriceInr: number }>;
  totalAmountInr: number;
  gstInr: number;
  advanceAmountInr: number;
  balanceAmountInr: number;
  technicalScope?: string;
  ownerUid?: string;
}): Promise<{ bucket: string; storagePath: string; buffer: Buffer }> {
  const buffer = await renderInvoicePdfBuffer({
    invoiceNumber: params.quotationNumber,
    docType: 'ENGINEERING QUOTATION',
    amountInr: params.totalAmountInr,
    gstInr: params.gstInr,
    issuedAt: new Date(),
    customerId: params.ownerUid,
    payload: {
      customerName: params.customerName,
      customerEmail: params.customerEmail,
      enquiryNumber: params.enquiryNumber,
      description: `${params.projectTitle} (${params.technicalScope || 'Custom Engineering'})`,
      items: params.items.map((it) => ({
        name: it.description ? `${it.name} — ${it.description}` : it.name,
        qty: it.qty,
        unitPriceInr: it.unitPriceInr,
        lineTotalInr: it.qty * it.unitPriceInr,
      })),
    },
  });

  if (!isSupabaseStorageConfigured()) {
    return { bucket: 'quotations', storagePath: '', buffer };
  }

  const uploaded = await uploadQuotationPdfToSupabase({
    buffer,
    fileName: `${params.quotationNumber}.pdf`,
    ownerUid: params.ownerUid || 'shared',
  });
  return { bucket: uploaded.bucket, storagePath: uploaded.storagePath, buffer };
}
