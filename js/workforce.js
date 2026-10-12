// Worker status (on site / in rotation / left), PPE returns, and lost / rotation PPE reports.
// Rotation and the lost/rotation reports only apply to subcontractor workers (not the main company).
import { h, field, emptyState, openModal, confirmDialog, toast, busy, FAILED, errorMessage, formatDate, todayISO } from './ui.js';
import { icon } from './icons.js';

export const STATUS_LABEL = { active: 'On site', rotation: 'In rotation', left: 'Left' };
const outstandingQty = x => (Number(x.Quantity) || 0) - (Number(x.ReturnedQuantity) || 0);

// ctx: { svc, state, COUNTRIES, countryName, locationOptions, rerender, openWorker(personId) }

// ---------- status buttons ----------
export function statusControl(ctx, person, { compact = false, onChange } = {}) {
  const { svc } = ctx;
  const main = svc.isMainCompany(person.Company);
  const current = svc.statusOf(person);
  const options = main ? ['active', 'left'] : ['active', 'rotation', 'left'];
  return h('div', { class: 'status-seg' + (compact ? ' compact' : ''), role: 'group', 'aria-label': `Status of ${person.Title}` },
    options.map(s => h('button', {
      type: 'button', class: `seg-${s}` + (s === current ? ' active' : ''), 'aria-pressed': String(s === current),
      onclick: async e => {
        e.stopPropagation();
        if (s === current) return;
        if (await changeStatus(ctx, person, s)) (onChange || ctx.rerender)();
      },
    }, main && s === 'active' ? 'Active' : STATUS_LABEL[s])));
}

async function changeStatus(ctx, person, status) {
  const { svc } = ctx;
  if (status === 'left') {
    const handouts = await busy('Checking PPE…', () => svc.getHandoutsFor(person.id));
    if (handouts === FAILED) return false;
    const open = handouts.filter(x => outstandingQty(x) > 0 && isReturnable(svc, x)).reduce((a, x) => a + outstandingQty(x), 0);
    if (open) {
      const res = await confirmDialog(
        `${person.Title} still has ${open} item${open === 1 ? '' : 's'} of PPE that ${open === 1 ? 'has' : 'have'} not been returned.` +
        (svc.isMainCompany(person.Company) ? '' : ' Until returned, they count as lost PPE for ' + (person.Company || 'their company') + '.'),
        { title: 'Set as left', okText: 'Set as left', checkbox: 'Record returned PPE now', checkboxDefault: true });
      if (!res) return false;
      const r = await busy('Saving…', () => svc.setPersonStatus(person, status));
      if (r === FAILED) return false;
      toast(`${person.Title} set as left`, 'success');
      if (res.checked) openReturnModal(ctx, svc.person(person.id) || person, handouts, ctx.rerender);
      return true;
    }
  }
  const r = await busy('Saving…', () => svc.setPersonStatus(person, status));
  if (r === FAILED) return false;
  toast(`${person.Title}: ${STATUS_LABEL[status].toLowerCase()}`, 'success');
  return true;
}

const isReturnable = (svc, x) => { const p = svc.product(x.ProductId); return !p || p.Returnable !== false; };

// ---------- return PPE ----------
export function openReturnModal(ctx, person, handouts, onDone) {
  const { svc, state } = ctx;
  const open = handouts.filter(x => outstandingQty(x) > 0)
    .sort((a, b) => Number(isReturnable(svc, b)) - Number(isReturnable(svc, a)) || (a.Title || '').localeCompare(b.Title || ''));
  if (!open.length) return toast(`${person.Title} has no PPE left to return`, 'info');

  // Returned PPE can only be received at locations the user may operate (officers: their own).
  const locs = svc.activeLocations().filter(l => svc.countryOf(l) === state.country && svc.canOperate(l.id));
  if (!locs.length) return toast('You cannot receive returned PPE at any location', 'error');
  const loc = h('select', { class: 'input' }, locs.map(l => h('option', { value: String(l.id) }, l.Title)));
  const preferred = [state.locationId, person.LocationId].find(id => locs.some(l => l.id === id));
  if (preferred) loc.value = String(preferred);
  const note = h('input', { class: 'input', placeholder: 'Optional, e.g. "Left the project"' });
  const rows = open.map(x => {
    const max = outstandingQty(x);
    const qty = h('input', { class: 'input input-sm', type: 'number', min: '0', max: String(max), inputmode: 'numeric', value: '0', 'aria-label': `Returned quantity of ${x.Title} ${x.Size}` });
    const toStock = h('input', { type: 'checkbox', checked: true });
    const el = h('div', { class: 'return-row' },
      h('div', { class: 'rr-name' },
        h('b', null, x.Title), h('span', { class: 'muted small' }, ` · size ${x.Size}`),
        h('div', { class: 'muted xsmall' }, `${max} of ${x.Quantity} not returned · handed out ${formatDate(x.HandoutDate)}`,
          isReturnable(svc, x) ? '' : ' · consumable')),
      h('div', { class: 'rr-qty' }, qty, h('button', { class: 'btn btn-outline btn-xs', type: 'button', onclick: () => { qty.value = String(max); } }, 'All')),
      h('label', { class: 'check-row small rr-stock' }, toStock, 'Back in stock'));
    return { x, max, qty, toStock, el };
  });

  const m = openModal({
    title: `Return PPE — ${person.Title}`, iconName: 'undo', iconClass: 'c-brand', persistent: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'muted small' }, 'Enter how many of each item came back. Untick "Back in stock" for items that are damaged and thrown away (they still count as returned).'),
      h('div', { class: 'btn-row left' }, h('button', { class: 'btn btn-outline', type: 'button', onclick: () => rows.forEach(r => { r.qty.value = String(r.max); }) }, 'Everything returned')),
      h('div', { class: 'return-list' }, rows.map(r => r.el)),
      h('div', { class: 'form-2col' }, field('Returned at (stock location)', loc), field('Note', note))),
    footer: h('button', { class: 'btn btn-block btn-brand', onclick: save }, icon('check'), 'Save return'),
  });

  async function save() {
    const items = rows.map(r => ({ handoutId: r.x.id, qty: Math.max(0, parseInt(r.qty.value, 10) || 0), toStock: r.toStock.checked, max: r.max, title: r.x.Title }));
    const bad = items.find(i => i.qty > i.max);
    if (bad) return toast(`${bad.title}: at most ${bad.max} can be returned`, 'error');
    const chosen = items.filter(i => i.qty > 0);
    if (!chosen.length) return toast('Enter at least one returned item', 'error');
    if (!loc.value) return toast('Choose where the PPE was returned', 'error');
    const r = await busy('Saving return…', () => svc.recordReturn(person.id, Number(loc.value), chosen.map(({ handoutId, qty, toStock }) => ({ handoutId, qty, toStock })), note.value.trim()));
    if (r === FAILED) return;
    m.close();
    const n = chosen.reduce((a, i) => a + i.qty, 0);
    toast(`${n} item${n === 1 ? '' : 's'} returned by ${person.Title}`, 'success');
    state.stockLoc = null;
    state.handoutsFor = null;
    if (onDone) onDone();
  }
}

// Box on the worker's card: what they still hold, with a Return PPE button.
export function holdingsBox(ctx, person, handouts) {
  const { svc } = ctx;
  const open = handouts.filter(x => outstandingQty(x) > 0);
  const tracked = open.filter(x => isReturnable(svc, x));
  const items = tracked.reduce((a, x) => a + outstandingQty(x), 0);
  const status = svc.statusOf(person);
  const sub = !svc.isMainCompany(person.Company);
  const label = !items ? 'No PPE to return'
    : status === 'left' && sub ? `${items} item${items === 1 ? '' : 's'} not returned — counted as lost`
    : status === 'rotation' ? `${items} item${items === 1 ? '' : 's'} held during rotation`
    : `Holds ${items} returnable item${items === 1 ? '' : 's'}`;
  return h('div', { class: 'holdings' + (items && status === 'left' && sub ? ' lost' : '') },
    h('span', null, items && status === 'left' && sub ? h('span', { class: 'status-dot critical' }, icon('alert')) : null, ' ', label),
    open.length ? h('button', { class: 'btn btn-outline btn-sm', onclick: () => openReturnModal(ctx, person, handouts, ctx.rerender) }, icon('undo'), 'Return PPE') : null);
}

// ---------- Crews & rotation ----------
// open: companies that are expanded (null = not decided yet: expand only when there is one company)
const crew = { company: 'all', location: 'all', show: 'current', search: '', selected: new Set(), open: null };

export function crewsView(ctx) {
  const { svc, state } = ctx;
  const wrap = h('div', { class: 'crews' });
  const inCountry = p => { const c = svc.personCountry(p); return !c || c === state.country; };
  const subs = () => svc.personnel.filter(p => inCountry(p) && !svc.isMainCompany(p.Company));
  const companyOf = p => (p.Company || '').trim() || '(no company)';

  function draw() {
    const all = subs();
    const companies = [...new Set([...ctx.branches.filter(b => !svc.isMainCompany(b)), ...all.map(companyOf)])].sort((a, b) => a.localeCompare(b));
    if (crew.company !== 'all' && !companies.includes(crew.company)) crew.company = 'all';
    const locs = svc.locations.filter(l => svc.countryOf(l) === state.country);
    if (crew.location !== 'all' && !locs.some(l => String(l.id) === crew.location)) crew.location = 'all';
    const q = crew.search.trim().toLowerCase();
    const inCompany = all.filter(p => (crew.company === 'all' || companyOf(p) === crew.company) &&
      (crew.location === 'all' || String(p.LocationId) === crew.location));
    const count = s => inCompany.filter(p => svc.statusOf(p) === s).length;
    const shown = inCompany.filter(p => {
      const s = svc.statusOf(p);
      const okStatus = crew.show === 'all' || (crew.show === 'current' ? s !== 'left' : s === crew.show);
      return okStatus && (!q || p.Title.toLowerCase().includes(q));
    });
    for (const id of [...crew.selected]) if (!shown.some(p => p.id === id)) crew.selected.delete(id);

    const groups = new Map();
    for (const p of shown) {
      if (!groups.has(companyOf(p))) groups.set(companyOf(p), []);
      groups.get(companyOf(p)).push(p);
    }
    if (crew.open === null) crew.open = new Set(groups.size === 1 ? groups.keys() : []);
    const isOpen = c => groups.size === 1 || crew.open.has(c) || !!q;   // searching shows the matches

    const select = (key, label, options) => field(label, h('select', { class: 'input', value: crew[key], onchange: e => { crew[key] = e.target.value; draw(); } },
      options.map(([v, l]) => h('option', { value: v }, l))));
    let timer;
    const bulk = async status => {
      const people = shown.filter(p => crew.selected.has(p.id) && svc.statusOf(p) !== status);
      if (!people.length) return;
      if (status === 'left' && !(await confirmDialog(`Set ${people.length} worker${people.length === 1 ? '' : 's'} as left? PPE they have not returned will count as lost.`, { okText: 'Set as left' }))) return;
      const r = await busy('Saving…', async () => { for (const p of people) await svc.setPersonStatus(p, status); });
      if (r === FAILED) return;
      toast(`${people.length} worker${people.length === 1 ? '' : 's'}: ${STATUS_LABEL[status].toLowerCase()}`, 'success');
      crew.selected.clear();
      draw();
    };

    wrap.replaceChildren(...[
      h('section', { class: 'card' },
        h('div', { class: 'crew-counts' },
          countChip('active', 'On site', count('active')), countChip('rotation', 'In rotation', count('rotation')), countChip('left', 'Left', count('left'))),
        h('div', { class: 'hist-filters' },
          select('company', 'Company', [['all', 'All subcontractors'], ...companies.map(c => [c, c])]),
          select('location', 'Location', [['all', 'All locations'], ...locs.map(l => [String(l.id), l.Title])]),
          select('show', 'Show', [['current', 'On site + in rotation'], ['active', 'On site'], ['rotation', 'In rotation'], ['left', 'Left'], ['all', 'Everyone']]),
          field('Search', h('input', { class: 'input', type: 'search', placeholder: 'Name…', value: crew.search,
            oninput: e => { clearTimeout(timer); timer = setTimeout(() => { crew.search = e.target.value; draw(); }, 250); } }))),
        h('div', { class: 'crew-note' },
          h('span', { class: 'muted small' }, `Subcontractor workers in ${ctx.countryName(state.country)}. ${ctx.mainCompany} workers are not tracked here.`),
          groups.size > 1 ? h('button', { class: 'link-btn', type: 'button', onclick: () => {
            const allOpen = [...groups.keys()].every(c => crew.open.has(c));
            crew.open = new Set(allOpen ? [] : groups.keys());
            draw();
          } }, [...groups.keys()].every(c => crew.open.has(c)) ? 'Collapse all' : 'Expand all') : null)),
      crew.selected.size ? h('div', { class: 'bulk-bar' },
        h('b', null, `${crew.selected.size} selected`),
        h('button', { class: 'btn btn-sm btn-outline', onclick: () => bulk('active') }, 'On site'),
        h('button', { class: 'btn btn-sm btn-outline', onclick: () => bulk('rotation') }, 'In rotation'),
        h('button', { class: 'btn btn-sm btn-outline c-red', onclick: () => bulk('left') }, 'Left'),
        h('button', { class: 'icon-btn', 'aria-label': 'Clear selection', onclick: () => { crew.selected.clear(); draw(); } }, icon('x'))) : null,
      ...(groups.size ? [...groups].map(([company, people]) => {
        const allSel = people.every(p => crew.selected.has(p.id));
        const someSel = !allSel && people.some(p => crew.selected.has(p.id));
        const open = isOpen(company);
        const n = s => people.filter(p => svc.statusOf(p) === s).length;
        const toggle = () => { open ? crew.open.delete(company) : crew.open.add(company); draw(); };
        const companyBox = h('input', { type: 'checkbox', 'aria-label': `Select all of ${company}`, checked: allSel,
          onchange: e => { people.forEach(p => (e.target.checked ? crew.selected.add(p.id) : crew.selected.delete(p.id))); draw(); } });
        companyBox.indeterminate = someSel;
        return h('section', { class: 'card crew-group' + (open ? ' open' : '') },
          h('div', { class: 'crew-head' },
            companyBox,
            h('button', { class: 'crew-toggle', type: 'button', 'aria-expanded': String(open), onclick: toggle },
              h('b', null, company),
              h('span', { class: 'crew-mini' },
                n('active') ? h('span', { class: 'mini seg-active' }, `${n('active')} on site`) : null,
                n('rotation') ? h('span', { class: 'mini seg-rotation' }, `${n('rotation')} rotation`) : null,
                n('left') ? h('span', { class: 'mini seg-left' }, `${n('left')} left`) : null,
                someSel || allSel ? h('span', { class: 'mini sel' }, `${people.filter(p => crew.selected.has(p.id)).length} selected`) : null),
              icon('chevronDown', 'crew-chev'))),
          !open ? null : people.map(p => h('div', { class: 'crew-row' },
            h('input', { type: 'checkbox', 'aria-label': `Select ${p.Title}`, checked: crew.selected.has(p.id), onchange: e => { e.target.checked ? crew.selected.add(p.id) : crew.selected.delete(p.id); draw(); } }),
            h('button', { class: 'crew-name link-like', type: 'button', onclick: () => ctx.openWorker(p.id) },
              h('span', null, p.Title), h('span', { class: 'muted xsmall' }, p.LocationName || svc.locName(p.LocationId) || '—')),
            statusControl(ctx, p, { compact: true, onChange: draw }))));
      }) : [emptyState('users', 'No workers', 'No subcontractor workers match these filters. Set a worker\'s company in their profile (✎ Edit).')]),
    ].filter(Boolean));
  }

  function countChip(status, label, n) {
    return h('button', { class: `count-chip seg-${status}` + (crew.show === status ? ' active' : ''), type: 'button', onclick: () => { crew.show = crew.show === status ? 'current' : status; draw(); } },
      h('b', null, String(n)), ` ${label}`);
  }

  draw();
  return wrap;
}

// ---------- Lost / rotation PPE report ----------
const rep = { kind: 'lost', country: null, company: 'all', open: new Set() };

export function outstandingView(ctx) {
  const { svc, state, COUNTRIES } = ctx;
  if (!rep.country || !COUNTRIES.some(c => c.code === rep.country)) rep.country = state.country;
  const wrap = h('div', { class: 'outstanding' });
  const body = h('div');
  let data = [];

  const kindBtn = (kind, label) => h('button', { class: 'seg-btn' + (rep.kind === kind ? ' active' : ''), type: 'button', onclick: () => { rep.kind = kind; rep.open.clear(); load(); drawHead(); } }, label);
  const head = h('div');
  function drawHead() {
    head.replaceChildren(
      h('div', { class: 'segmented' }, kindBtn('lost', 'Lost PPE'), kindBtn('rotation', 'In rotation')),
      h('section', { class: 'card' },
        h('div', { class: 'hist-filters' },
          COUNTRIES.length > 1 ? field('Country', h('select', { class: 'input', value: rep.country, onchange: e => { rep.country = e.target.value; rep.company = 'all'; load(); } },
            COUNTRIES.map(c => h('option', { value: c.code }, c.name)))) : null,
          field('Company', h('select', { class: 'input', id: 'rep-company', value: rep.company, onchange: e => { rep.company = e.target.value; render(); } },
            h('option', { value: 'all' }, 'All subcontractors')))),
        h('p', { class: 'muted small' }, rep.kind === 'lost'
          ? 'PPE handed out to subcontractor workers who have left and that was never returned.'
          : 'PPE held by subcontractor workers who are currently in rotation.',
          ` Consumables and ${ctx.mainCompany} workers are not included.`)));
  }

  async function load() {
    body.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Loading…'));
    try {
      data = await svc.outstandingPpe(rep.country, rep.kind);
    } catch (e) {
      body.replaceChildren(h('div', { class: 'card error-box' }, h('p', null, errorMessage(e)), h('button', { class: 'btn btn-outline', onclick: load }, icon('refresh'), 'Retry')));
      return;
    }
    render();
  }

  function render() {
    const sel = head.querySelector('#rep-company');
    const companies = [...new Set(data.map(r => r.company))].sort((a, b) => a.localeCompare(b));
    if (rep.company !== 'all' && !companies.includes(rep.company)) rep.company = 'all';
    if (sel) {
      sel.replaceChildren(h('option', { value: 'all' }, 'All subcontractors'), ...companies.map(c => h('option', { value: c }, c)));
      sel.value = rep.company;
    }
    const rows = data.filter(r => rep.company === 'all' || r.company === rep.company);
    if (!rows.length) {
      body.replaceChildren(emptyState('check', rep.kind === 'lost' ? 'No lost PPE' : 'No PPE in rotation',
        rep.kind === 'lost' ? 'Every worker who left has returned their PPE (or nothing matches the filter).' : 'No subcontractor worker in rotation holds returnable PPE.'));
      return;
    }
    const total = rows.reduce((a, r) => a + Number(r.quantity), 0);
    const workers = new Set(rows.map(r => r.personnel_id)).size;
    const byCompany = group(rows, r => r.company);

    body.replaceChildren(...[
      h('div', { class: 'stat-row' },
        tile(rep.kind === 'lost' ? 'Items lost' : 'Items in rotation', total, rep.kind === 'lost' ? 'critical' : null),
        tile('Workers', workers),
        tile('Companies', byCompany.size),
        h('button', { class: 'stat-tile clickable', type: 'button', onclick: () => exportCsv(rows) },
          h('span', { class: 'stat-label' }, icon('download'), 'Export CSV'), h('span', { class: 'stat-sub muted' }, 'All rows in this report'))),
      rep.company === 'all' && byCompany.size > 1 ? h('section', { class: 'card' }, h('h3', null, 'All companies'), equipmentTable(rows)) : null,
      ...[...byCompany].map(([company, list]) => {
        const items = list.reduce((a, r) => a + Number(r.quantity), 0);
        const people = group(list, r => r.personnel_id);
        const isOpen = rep.open.has(company);
        return h('section', { class: 'card rep-company' },
          h('div', { class: 'rep-head' },
            h('div', null, h('h3', null, company), h('div', { class: 'muted small' }, `${items} item${items === 1 ? '' : 's'} · ${people.size} worker${people.size === 1 ? '' : 's'}`)),
            h('span', { class: 'rep-total' }, String(items))),
          equipmentTable(list),
          h('button', { class: 'link-btn', type: 'button', onclick: () => { isOpen ? rep.open.delete(company) : rep.open.add(company); render(); } },
            isOpen ? 'Hide workers' : `Show workers (${people.size})`),
          isOpen ? h('div', { class: 'rep-workers' }, [...people].map(([pid, items]) => h('div', { class: 'rep-worker' },
            h('button', { class: 'link-like', type: 'button', onclick: () => ctx.openWorker(Number(pid)) }, h('b', null, items[0].personnel_name)),
            h('span', { class: 'muted xsmall' }, ` · ${items[0].location_name || ''} · last handout ${formatDate(items.reduce((a, r) => (r.last_handout > a ? r.last_handout : a), items[0].last_handout))}`),
            h('div', { class: 'small' }, items.map(r => `${r.quantity} × ${r.title} (${r.size})`).join(', '))))) : null);
      }),
    ].filter(Boolean));
  }

  // Equipment rows with every size as a chip: "Winter Jacket — 5   M ×2  L ×3"
  function equipmentTable(rows) {
    const byProduct = group(rows, r => r.title);
    return h('div', { class: 'rep-equipment' }, [...byProduct].sort((a, b) => a[0].localeCompare(b[0])).map(([title, list]) => {
      const bySize = group(list, r => r.size);
      const p = svc.products.find(x => x.Title === title);
      const order = p ? svc.sizesOf(p) : [];
      const rank = s => { const i = order.indexOf(s); return i < 0 ? 999 : i; };
      const total = list.reduce((a, r) => a + Number(r.quantity), 0);
      return h('div', { class: 'rep-line' },
        h('div', { class: 'rep-title' }, h('b', null, title), h('span', { class: 'muted small' }, ` ${total}`)),
        h('div', { class: 'size-chips' }, [...bySize].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([size, l]) =>
          h('span', { class: 'size-chip ok' }, h('span', { class: 'sc-size' }, size), h('span', { class: 'sc-qty' }, String(l.reduce((a, r) => a + Number(r.quantity), 0)))))));
    }));
  }

  function exportCsv(rows) {
    const cell = v => { const s = String(v == null ? '' : v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ['Country', 'Company', 'Worker', 'Site', 'Equipment', 'Size', 'Quantity', 'Last handout'];
    const lines = rows.map(r => [ctx.countryName(rep.country), r.company, r.personnel_name, r.location_name, r.title, r.size, r.quantity,
      r.last_handout ? new Date(r.last_handout).toLocaleDateString('sv-SE') : ''].map(cell).join(';'));
    const blob = new Blob(['﻿' + [header.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${rep.kind === 'lost' ? 'Lost PPE' : 'PPE in rotation'} ${rep.country} ${todayISO()}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  drawHead();
  wrap.append(head, body);
  queueMicrotask(load);
  return wrap;
}

function tile(label, value, status) {
  return h('div', { class: 'stat-tile' },
    h('span', { class: 'stat-label' }, status ? h('span', { class: `status-dot ${status}` }, icon('alert')) : null, label),
    h('span', { class: 'stat-value' }, Number(value).toLocaleString()));
}

function group(rows, keyOf) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
