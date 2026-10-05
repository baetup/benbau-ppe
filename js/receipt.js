// HTML for the handout receipt email (inline styles for email clients).
import { formatDate } from './ui.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function receiptSubject(person, rows) {
  return `PPE handout receipt – ${person.Title || rows[0].PersonnelName} – ${formatDate(rows[0].HandoutDate)}`;
}

// signatureSrc: "cid:signature" for the email, or the data URL for an on-screen preview.
export function buildReceiptHtml({ appName, person, rows, signatureSrc }) {
  const r = rows[0];
  const td = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;';
  const detail = (k, v) => v ? `<tr><td style="padding:3px 12px 3px 0;color:#6b7280;">${esc(k)}</td><td style="padding:3px 0;">${esc(v)}</td></tr>` : '';
  return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#111827;font-size:14px;max-width:600px;">
  <h2 style="color:#EF7D00;margin:0 0 2px;font-size:20px;">PPE handout receipt</h2>
  <div style="color:#6b7280;margin-bottom:16px;">${esc(appName)}</div>
  <table style="border-collapse:collapse;margin-bottom:16px;">
    ${detail('Receiver', person.Title || r.PersonnelName)}
    ${detail('Date', formatDate(r.HandoutDate))}
    ${detail('Location', r.LocationName)}
    ${detail('Handed out by', r.HandedOutBy)}
    ${detail('Reason', r.Reason)}
    ${detail('Notes', r.Notes)}
  </table>
  <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
    <tr style="background:#f9fafb;text-align:left;"><th style="${td}">Item</th><th style="${td}">Size</th><th style="${td}text-align:right;">Qty</th></tr>
    ${rows.map(x => `<tr><td style="${td}">${esc(x.Title)}</td><td style="${td}">${esc(x.Size)}</td><td style="${td}text-align:right;">${esc(x.Quantity)}</td></tr>`).join('')}
  </table>
  ${signatureSrc ? `<div style="color:#6b7280;margin-bottom:4px;">Receiver signature</div>
  <img src="${esc(signatureSrc)}" alt="Signature" width="300" style="width:300px;max-width:100%;border:1px solid #e5e7eb;border-radius:6px;">` : ''}
  <p style="font-size:12px;color:#6b7280;margin-top:16px;">By signing, the receiver confirmed receiving the personal protective equipment listed above.</p>
</div>`;
}
