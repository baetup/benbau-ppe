// Orders tab (per location): one collapsible card per product, per size:
//   Workers   = active workers at this site with that size on their profile (when the product is linked to a size type)
//   In stock  = current stock here
//   Used / mo = average use per month (handouts + stock decreases from manual counts) over the last months
//   Suggested = what to order: use per month × months to cover + workers × spare share − stock
import { h, field, emptyState, errorMessage, todayISO } from './ui.js';
import { icon } from './icons.js';

const ord = { locationId: null, includeRotation: true, company: 'all', category: 'regular', open: new Set() };
const norm = s => String(s || '').trim().toUpperCase();

// ctx: { svc, state, countryName, PERSON_SIZES, orderSettings: { historyMonths, coverMonths, workerBuffer } }
export function ordersView(ctx) {
  const { svc, state } = ctx;
  const cfg = ctx.orderSettings;
  const locs = svc.locationsIn(state.country);
  if (!locs.some(l => l.id === ord.locationId)) ord.locationId = locs.some(l => l.id === state.locationId) ? state.locationId : (locs[0] && locs[0].id);
  if (!locs.length) return h('div', null, emptyState('pin', 'No locations', `There are no locations in ${ctx.countryName(state.country)}.`));

  const body = h('div');
  const companies = [...new Set(svc.personnel.map(p => (p.Company || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const loc = h('select', { class: 'input', value: String(ord.locationId), onchange: e => { ord.locationId = Number(e.target.value); load(); } },
    locs.map(l => h('option', { value: String(l.id) }, l.Title)));
  const company = h('select', { class: 'input', value: ord.company, onchange: e => { ord.company = e.target.value; load(); } },
    h('option', { value: 'all' }, 'All companies'), companies.map(c => h('option', { value: c }, c)));
  const rotation = h('input', { type: 'checkbox', checked: ord.includeRotation, onchange: e => { ord.includeRotation = e.target.checked; load(); } });
  const tabs = h('div', { class: 'segmented wide' });
  const drawTabs = () => tabs.replaceChildren(
    ...[['regular', 'Regular PPE'], ['consumable', 'Consumables']].map(([cat, label]) => h('button', {
      class: 'seg-btn' + (ord.category === cat ? ' active' : ''), type: 'button',
      onclick: () => { if (ord.category !== cat) { ord.category = cat; drawTabs(); load(); } },
    }, label)));
  drawTabs();

  async function load() {
    body.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Loading…'));
    let stock, usage;
    try {
      [stock, usage] = await Promise.all([svc.getStockFull(ord.locationId), svc.stockUsage(ord.locationId, cfg.historyMonths)]);
    } catch (e) {
      body.replaceChildren(h('div', { class: 'card error-box' }, h('p', null, errorMessage(e))));
      return;
    }
    render(stock.qty, usage);
  }

  function render(stock, usage) {
    const workers = svc.personnel.filter(p =>
      p.Active !== false && p.LocationId === ord.locationId &&
      (ord.includeRotation || !p.InRotation) &&
      (ord.company === 'all' || (p.Company || '').trim() === ord.company));
    const products = svc.activeProducts().filter(p => svc.categoryOf(p) === ord.category);
    // Months of history actually available (the stock log may be younger than the chosen period).
    const months = usage.first ? Math.min(cfg.historyMonths, Math.max(0.25, (Date.now() - usage.first.getTime()) / (30.44 * 86400000))) : 0;
    const csv = [];

    const cards = products.map(p => {
      const sizeKey = (ctx.PERSON_SIZES.find(([, label]) => label === p.SizeType) || [])[0];
      const sizes = svc.sizesOf(p);
      const workerCounts = new Map();
      let missing = 0;
      if (sizeKey) {
        for (const w of workers) {
          const s = norm(w[sizeKey]);
          if (!s) { missing++; continue; }
          workerCounts.set(s, (workerCounts.get(s) || 0) + 1);
        }
      }
      // One-size products without a size type: every worker counts.
      const allWorkers = !sizeKey && sizes.length === 1;
      const showWorkers = !!sizeKey || allWorkers;
      const extra = sizeKey ? [...workerCounts.keys()].filter(s => !sizes.some(x => norm(x) === s)) : [];

      const rows = [...sizes, ...extra].map(size => {
        const w = allWorkers ? workers.length : (workerCounts.get(norm(size)) || 0);
        const have = stock.get(`${p.id}|${size}`) || 0;
        const used = usage.used.get(`${p.id}|${size}`) || 0;
        const perMonth = months ? used / months : 0;
        const target = perMonth * cfg.coverMonths + (showWorkers ? w * cfg.workerBuffer : 0);
        const suggested = Math.max(0, Math.ceil(target - have));
        csv.push([p.Title, size, showWorkers ? w : '', have, months ? round1(perMonth) : '', suggested]);
        return { size, w, have, perMonth, suggested, extra: extra.includes(size) };
      });
      const total = k => rows.reduce((a, r) => a + r[k], 0);
      const suggestedTotal = total('suggested');
      const open = ord.open.has(p.id);
      const toggle = () => { open ? ord.open.delete(p.id) : ord.open.add(p.id); render(stock, usage); };

      return h('section', { class: 'card order-card' + (open ? ' open' : '') },
        h('button', { class: 'order-head', type: 'button', 'aria-expanded': String(open), onclick: toggle },
          h('div', { class: 'oh-title' }, h('b', null, p.Title),
            h('span', { class: 'muted small' }, sizeKey ? `Sizes from workers' ${p.SizeType.toLowerCase()} size` : allWorkers ? 'One size — every worker counts' : 'Not linked to worker sizes')),
          h('div', { class: 'oh-stats' },
            showWorkers ? h('span', { class: 'mini' }, `${allWorkers ? workers.length : total('w')} workers`) : null,
            h('span', { class: 'mini' }, `${total('have')} in stock`),
            h('span', { class: 'mini ' + (suggestedTotal ? 'suggest' : 'ok') }, suggestedTotal ? `Order ${suggestedTotal}` : 'Enough')),
          icon('chevronDown', 'crew-chev')),
        open ? h('div', { class: 'order-body' },
          h('div', { class: 'matrix-scroll' }, h('table', { class: 'stock-matrix order-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'Size'), showWorkers ? h('th', null, 'Workers') : null, h('th', null, 'In stock'),
              h('th', { title: `Average per month, last ${cfg.historyMonths} months` }, 'Used / month'), h('th', null, 'Suggested order'))),
            h('tbody', null, rows.map(r => h('tr', null,
              h('th', { scope: 'row' }, r.size, r.extra ? h('span', { class: 'muted xsmall' }, ' (not a product size)') : null),
              showWorkers ? h('td', { class: 'num strong' }, String(r.w)) : null,
              h('td', { class: 'num' }, String(r.have)),
              h('td', { class: 'num muted' }, months ? round1(r.perMonth) : '—'),
              h('td', { class: 'num' + (r.suggested ? ' suggest' : '') }, r.suggested ? String(r.suggested) : '—')))),
            h('tfoot', null, h('tr', null,
              h('th', null, 'Total'), showWorkers ? h('td', { class: 'num strong' }, String(allWorkers ? workers.length : total('w'))) : null,
              h('td', { class: 'num' }, String(total('have'))),
              h('td', { class: 'num muted' }, months ? round1(total('perMonth')) : '—'),
              h('td', { class: 'num' + (suggestedTotal ? ' suggest' : '') }, suggestedTotal ? String(suggestedTotal) : '—'))))),
          missing ? h('p', { class: 'muted small warn-line' }, icon('alert'), ` ${missing} worker${missing === 1 ? '' : 's'} without a ${p.SizeType.toLowerCase()} size recorded`) : null) : null);
    });

    const historyNote = !months
      ? 'No stock history yet at this location, so suggestions only use the worker count. They improve as handouts and stock counts are recorded.'
      : months < cfg.historyMonths ? `Based on ${round1(months)} month${months < 1.05 ? '' : 's'} of history (stock changes are recorded from when the stock log was switched on).`
      : `Based on the last ${cfg.historyMonths} months.`;

    body.replaceChildren(...[
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat-tile' }, h('span', { class: 'stat-label' }, 'Workers counted'), h('span', { class: 'stat-value' }, String(workers.length)),
          h('span', { class: 'stat-sub muted' }, ord.includeRotation ? 'on site + in rotation' : 'on site only')),
        h('button', { class: 'stat-tile clickable', type: 'button', onclick: () => exportCsv(csv) },
          h('span', { class: 'stat-label' }, icon('download'), 'Export CSV'), h('span', { class: 'stat-sub muted' }, 'All sizes with stock and suggestions'))),
      h('div', { class: 'order-actions' },
        h('span', { class: 'muted small' }, historyNote),
        products.length > 1 ? h('button', { class: 'link-btn', type: 'button', onclick: () => {
          const allOpen = products.every(p => ord.open.has(p.id));
          products.forEach(p => (allOpen ? ord.open.delete(p.id) : ord.open.add(p.id)));
          render(stock, usage);
        } }, products.every(p => ord.open.has(p.id)) ? 'Collapse all' : 'Expand all') : null),
      ...(products.length ? cards : [emptyState('package', ord.category === 'consumable' ? 'No consumables' : 'No PPE items', 'Add products in the Inventory tab.')]),
      h('p', { class: 'muted small formula' },
        `Suggested order = use per month × ${cfg.coverMonths} months + ${Math.round(cfg.workerBuffer * 100)}% of the workers with that size as spare − stock. `,
        'Change these numbers in config.js (orderSettings).'),
    ].filter(Boolean));
  }

  function exportCsv(rows) {
    const l = svc.location(ord.locationId);
    const cell = v => { const s = String(v == null ? '' : v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ['Product', 'Size', 'Workers', 'In stock', 'Used per month', 'Suggested order'];
    const blob = new Blob(['﻿' + [header.join(';'), ...rows.map(r => r.map(cell).join(';'))].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `Order ${ord.category === 'consumable' ? 'consumables' : 'PPE'} ${l ? l.Title : ''} ${todayISO()}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  queueMicrotask(load);
  return h('div', { class: 'orders' },
    h('section', { class: 'card' },
      h('div', { class: 'hist-filters' }, field('Location', loc), field('Company', company)),
      h('label', { class: 'check-row', style: { marginTop: '10px' } }, rotation, 'Include workers in rotation')),
    tabs,
    body);
}

function round1(n) {
  return (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
}
