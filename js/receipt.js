// Handout receipt: HTML preview, plain text (for the email body) and a PNG image (with signature).
import { formatDate } from './ui.js';

export function receiptText({ appName, person, rows }) {
  const r = rows[0];
  const lines = [
    `PPE handout receipt – ${appName}`,
    '',
    `Receiver: ${person.Title || r.PersonnelName}`,
    `Date: ${formatDate(r.HandoutDate)}`,
    r.LocationName ? `Location: ${r.LocationName}` : null,
    r.HandedOutBy ? `Handed out by: ${r.HandedOutBy}` : null,
    r.Reason ? `Reason: ${r.Reason}` : null,
    r.Notes ? `Notes: ${r.Notes}` : null,
    '',
    'Items:',
    ...rows.map(x => `- ${x.Quantity} × ${x.Title} (size ${x.Size})`),
    '',
    r.Signature ? 'The receiver signed for these items. The signed receipt image is attached.' : null,
  ];
  return lines.filter(l => l !== null).join('\n');
}

// Draws the receipt (including the signature) on a canvas and returns a PNG Blob.
export async function receiptImage({ appName, person, rows }) {
  const r = rows[0];
  const W = 800, pad = 40;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = (size, weight = 400) => `${weight} ${size}px "Segoe UI", Arial, sans-serif`;

  const details = [
    ['Receiver', person.Title || r.PersonnelName], ['Date', formatDate(r.HandoutDate)], ['Location', r.LocationName],
    ['Handed out by', r.HandedOutBy], ['Reason', r.Reason], ['Notes', r.Notes],
  ].filter(([, v]) => v);
  ctx.font = font(18);
  const detailLines = details.map(([k, v]) => [k, wrap(ctx, String(v), W - pad * 2 - 170)]);
  const sig = r.Signature ? await loadImage(r.Signature).catch(() => null) : null;
  const sigH = sig ? Math.min(200, (sig.height / sig.width) * 360) : 0;

  const H = pad + 90
    + detailLines.reduce((a, [, ls]) => a + ls.length * 26, 0) + 24
    + 40 + rows.length * 34 + 24
    + (sig ? 30 + sigH + 20 : 0) + 50;
  c.width = W; c.height = H;

  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  let y = pad;
  ctx.fillStyle = '#EF7D00'; ctx.font = font(28, 700); ctx.textBaseline = 'top';
  ctx.fillText('PPE handout receipt', pad, y); y += 40;
  ctx.fillStyle = '#6B7280'; ctx.font = font(18);
  ctx.fillText(appName, pad, y); y += 50;

  for (const [k, ls] of detailLines) {
    ctx.fillStyle = '#6B7280'; ctx.font = font(18); ctx.fillText(k, pad, y);
    ctx.fillStyle = '#111827';
    for (const l of ls) { ctx.fillText(l, pad + 170, y); y += 26; }
  }
  y += 24;

  ctx.fillStyle = '#F3F4F6'; ctx.fillRect(pad, y, W - pad * 2, 36);
  ctx.fillStyle = '#374151'; ctx.font = font(17, 700);
  ctx.fillText('Item', pad + 12, y + 8); ctx.fillText('Size', W - pad - 220, y + 8); ctx.fillText('Qty', W - pad - 60, y + 8);
  y += 40;
  ctx.font = font(18);
  for (const x of rows) {
    ctx.fillStyle = '#111827';
    ctx.fillText(truncate(ctx, x.Title, W - pad * 2 - 260), pad + 12, y + 6);
    ctx.fillText(String(x.Size), W - pad - 220, y + 6);
    ctx.fillText(String(x.Quantity), W - pad - 60, y + 6);
    ctx.fillStyle = '#E5E7EB'; ctx.fillRect(pad, y + 33, W - pad * 2, 1);
    y += 34;
  }
  y += 24;

  if (sig) {
    ctx.fillStyle = '#6B7280'; ctx.font = font(16); ctx.fillText('Receiver signature', pad, y); y += 26;
    ctx.drawImage(sig, pad, y, sigH * (sig.width / sig.height), sigH);
    ctx.strokeStyle = '#E5E7EB'; ctx.strokeRect(pad, y, sigH * (sig.width / sig.height), sigH);
    y += sigH + 20;
  }
  ctx.fillStyle = '#6B7280'; ctx.font = font(14);
  ctx.fillText('By signing, the receiver confirmed receiving the personal protective equipment listed above.', pad, y);

  return new Promise(resolve => c.toBlob(resolve, 'image/png'));
}

function loadImage(src) {
  return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
}

function wrap(ctx, text, max) {
  const words = text.split(/\s+/), lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > max && line) { lines.push(line); line = w; } else line = t;
  }
  lines.push(line);
  return lines;
}

function truncate(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length && ctx.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text + '…';
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function receiptSubject(person, rows) {
  return `PPE handout receipt – ${person.Title || rows[0].PersonnelName} – ${formatDate(rows[0].HandoutDate)}`;
}

// On-screen preview of the receipt.
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
