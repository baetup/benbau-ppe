// Small DOM helpers: element builder, modals, toasts, busy overlay, pickers.
import { icon } from './icons.js';

const BOOL_PROPS = new Set(['checked', 'disabled', 'selected', 'required', 'multiple', 'hidden', 'readOnly']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') value = v;
      else if (BOOL_PROPS.has(k)) el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  // Set value last so <select> options exist first.
  if (value !== undefined) el.value = value;
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function field(label, control) {
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
}

export function emptyState(iconName, title, text) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon(iconName)),
    h('div', { class: 'empty-title' }, title),
    text ? h('div', { class: 'muted' }, text) : null);
}

// ---------- modals ----------
let z = 100;

export function openModal({ title, titleExtra, iconName, iconClass = '', body, footer, size = '', persistent = false, onClose }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const dialog = h('div', { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-header' },
      iconName ? h('span', { class: `modal-icon ${iconClass}` }, icon(iconName)) : null,
      h('h2', null, title, titleExtra ? ' ' : null, titleExtra),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-footer' }, footer) : null);
  backdrop.append(dialog);
  backdrop.style.zIndex = String(++z);
  if (!persistent) backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  const onKey = e => { if (e.key === 'Escape' && isTop()) close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  document.body.classList.add('modal-open');

  function isTop() {
    const all = document.querySelectorAll('.modal-backdrop');
    return all[all.length - 1] === backdrop;
  }
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (!document.querySelector('.modal-backdrop')) document.body.classList.remove('modal-open');
    if (onClose) onClose();
  }
  return { close, el: dialog };
}

export function confirmDialog(message, { title = 'Please confirm', okText = 'OK', danger = false, checkbox = null, checkboxDefault = true } = {}) {
  return new Promise(resolve => {
    let result = false;
    const cb = checkbox ? h('input', { type: 'checkbox', checked: checkboxDefault }) : null;
    const m = openModal({
      title, size: 'sm',
      body: h('div', { class: 'stack' },
        h('div', { class: 'confirm-text' }, message),
        cb ? h('label', { class: 'check-row' }, cb, checkbox) : null),
      footer: h('div', { class: 'btn-row' },
        h('button', { class: 'btn btn-outline', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-red' : 'btn-brand'}`, onclick: () => { result = { ok: true, checked: cb ? cb.checked : false }; m.close(); } }, okText)),
      onClose: () => resolve(result),
    });
  });
}

// Searchable list picker. Resolves with the chosen item id, or null.
export function pickFrom({ title, iconName, items, selectedId, placeholder = 'Search…', addLabel, onAdd }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; m.close(); resolve(v); };
    const input = h('input', { class: 'input', type: 'search', placeholder });
    const list = h('div', { class: 'pick-list' });
    function draw() {
      const q = input.value.trim().toLowerCase();
      const found = items.filter(i => !q || `${i.label} ${i.sub || ''}`.toLowerCase().includes(q));
      list.replaceChildren(...(found.length
        ? found.map(i => h('button', { class: 'pick-item' + (i.id === selectedId ? ' selected' : ''), type: 'button', onclick: () => finish(i.id) },
            h('span', { class: 'pi-label' }, i.label, i.badge ? h('span', { class: 'tag tag-grey' }, i.badge) : null),
            i.sub ? h('span', { class: 'pi-sub' }, i.sub) : null))
        : [h('div', { class: 'muted pad' }, 'No matches')]));
    }
    input.addEventListener('input', draw);
    const m = openModal({
      title, iconName, iconClass: 'c-brand',
      body: h('div', { class: 'stack' }, input, list),
      footer: onAdd ? h('button', {
        class: 'btn btn-block btn-outline', onclick: async () => {
          const created = await onAdd();
          if (created) finish(created.id);
        }
      }, icon('userPlus'), addLabel) : null,
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    draw();
    if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => input.focus(), 30);
  });
}

// ---------- toasts ----------
let toastHost;
export function toast(message, type = 'info', ms = 3200) {
  if (!toastHost) { toastHost = h('div', { class: 'toast-host', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const t = h('div', { class: `toast toast-${type}` }, message);
  toastHost.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, type === 'error' ? Math.max(ms, 5000) : ms);
}

// ---------- busy overlay ----------
export const FAILED = Symbol('failed');

export async function busy(label, fn) {
  const overlay = h('div', { class: 'busy' }, h('div', { class: 'busy-box' }, h('div', { class: 'spinner' }), h('span', null, label)));
  document.body.append(overlay);
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(errorMessage(e), 'error');
    return FAILED;
  } finally {
    overlay.remove();
  }
}

export function errorMessage(e) {
  if (!e) return 'Something went wrong';
  if (e.status === 401) return 'Your sign-in has expired. Please reload the page.';
  if (e.status === 403) return 'Access denied. Ask the administrator to add your email to the staff list. ' + (e.message || '');
  if (e instanceof TypeError && /fetch/i.test(e.message)) return 'No connection to the server. Check your internet connection.';
  return e.message || String(e);
}

// ---------- dates ----------
export function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// yyyy-mm-dd from a date input -> ISO timestamp (keeps the current time when it is today)
export function dateInputToIso(value) {
  if (!value || value === todayISO()) return isoNow();
  return new Date(value + 'T12:00:00').toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
