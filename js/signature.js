// Finger / mouse signature pad.
import { h } from './ui.js';
import { icon } from './icons.js';

export function createSignaturePad() {
  const canvas = h('canvas', { class: 'sig-canvas' });
  const hint = h('span', { class: 'sig-hint' }, 'Sign here');
  const clearBtn = h('button', { class: 'icon-btn sig-clear', type: 'button', title: 'Clear signature', onclick: () => clear() }, icon('eraser'));
  const el = h('div', { class: 'sig-wrap' }, canvas, hint, clearBtn);

  let ctx, drawing = false, last = null, empty = true, width = 0, height = 0;

  function setup() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || (r.width === width && r.height === height)) return;
    const prev = empty ? null : canvas.toDataURL();
    width = r.width; height = r.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
    if (prev) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, width, height); img.src = prev; }
  }
  new ResizeObserver(setup).observe(canvas);

  const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  canvas.addEventListener('pointerdown', e => {
    setup();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#111827'; ctx.fill();
    markUsed();
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
    e.preventDefault();
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  function markUsed() { empty = false; hint.hidden = true; }
  function clear() {
    if (ctx) ctx.clearRect(0, 0, width, height);
    empty = true; hint.hidden = false;
  }

  // Small image (white background) so the database stays small.
  function toDataURL() {
    const w = 500, hgt = Math.round(500 * (height / width || 0.35));
    const off = document.createElement('canvas');
    off.width = w; off.height = hgt;
    const c = off.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, w, hgt);
    c.drawImage(canvas, 0, 0, w, hgt);
    let url = off.toDataURL('image/png');
    if (url.length > 60000) url = off.toDataURL('image/jpeg', 0.6);
    return url;
  }

  return { el, isEmpty: () => empty, clear, toDataURL };
}
