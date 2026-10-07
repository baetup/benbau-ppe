// Dashboard tab: consumption statistics and a quick stock check.
// Consumption numbers are aggregated in the database (dashboard_stats), so they stay fast with a large history.
import { h, field, emptyState, openModal, errorMessage } from './ui.js';
import { icon } from './icons.js';
import { columnChart, barList } from './charts.js';

const PERIODS = [
  ['30', 'Last 30 days'], ['90', 'Last 3 months'], ['month', 'This month'], ['lastmonth', 'Last month'],
  ['year', 'This year'], ['lastyear', 'Last year'], ['365', 'Last 12 months'], ['all', 'All time'],
];
const WEEKLY = new Set(['30', '90', 'month', 'lastmonth']);

const dash = { country: null, locationId: 'all', period: '365', problemsOnly: false, seq: 0 };

// ctx: { svc, state, COUNTRIES, countryName, periodRange, lowStock, showHandoutHistory(productId, filters) }
export function dashboardView(ctx) {
  const { svc, state, COUNTRIES } = ctx;
  if (dash.country === null) dash.country = state.country;

  const filters = h('div', { class: 'dash-filters' });
  const body = h('div', { class: 'dash-body' }, h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Loading dashboard…'));

  function drawFilters() {
    const select = (key, label, options) => field(label, h('select', {
      class: 'input', value: String(dash[key]),
      onchange: e => {
        dash[key] = e.target.value;
        if (key === 'country') dash.locationId = 'all';
        drawFilters();
        load();
      },
    }, options.map(([v, l]) => h('option', { value: String(v) }, l))));
    const locs = svc.activeLocations().filter(l => dash.country === 'all' || svc.countryOf(l) === dash.country);
    if (dash.locationId !== 'all' && !locs.some(l => String(l.id) === dash.locationId)) dash.locationId = 'all';
    filters.replaceChildren(...[
      COUNTRIES.length > 1 ? select('country', 'Country', [['all', 'All countries'], ...COUNTRIES.map(c => [c.code, c.name])]) : null,
      select('locationId', 'Location', [['all', 'All locations'], ...locs.map(l => [l.id, l.Title])]),
      select('period', 'Consumption period', PERIODS),
    ].filter(Boolean));
  }

  // Locations in scope: one location, or every active location of the country (or all countries).
  function scope() {
    if (dash.locationId !== 'all') return svc.locations.filter(l => String(l.id) === dash.locationId);
    return svc.activeLocations().filter(l => dash.country === 'all' || svc.countryOf(l) === dash.country);
  }

  async function load() {
    const seq = ++dash.seq;
    const locs = scope();
    const range = ctx.periodRange(dash.period);
    const bucket = WEEKLY.has(dash.period) ? 'week' : 'month';
    // History is filtered by location ids; inactive locations of the country are included for consumption.
    const statLocIds = dash.locationId !== 'all' ? [Number(dash.locationId)]
      : dash.country === 'all' ? null
      : svc.locations.filter(l => svc.countryOf(l) === dash.country).map(l => l.id);
    try {
      const [stats, stock] = await Promise.all([
        svc.dashboardStats({ locationIds: statLocIds, ...range, bucket }),
        svc.getAllStock(),
      ]);
      if (seq !== dash.seq) return;
      render(stats, stock, locs, range, bucket);
    } catch (e) {
      if (seq !== dash.seq) return;
      console.error(e);
      body.replaceChildren(h('div', { class: 'card error-box' }, h('p', null, errorMessage(e)),
        h('button', { class: 'btn btn-outline', onclick: load }, icon('refresh'), 'Retry')));
    }
  }

  function render(stats, stock, locs, range, bucket) {
    const products = svc.activeProducts();
    const low = ctx.lowStock;

    // ----- stock figures for the locations in scope -----
    let inStock = 0, outCount = 0, lowCount = 0;
    const cells = new Map();   // "pid|lid" -> { total, out, low, sizes: [{ size, qty, known }] }
    for (const p of products) {
      for (const l of locs) {
        const c = { total: 0, out: 0, low: 0, carried: false, sizes: [] };
        for (const s of svc.sizesOf(p)) {
          const k = `${p.id}|${s}|${l.id}`;
          const known = stock.has(k);
          const qty = stock.get(k) || 0;
          c.sizes.push({ size: s, qty, known });
          c.total += qty;
          if (known) {
            c.carried = true;
            if (qty <= 0) c.out++;
            else if (qty <= low) c.low++;
          }
        }
        inStock += c.total;
        outCount += c.out;
        lowCount += c.low;
        cells.set(`${p.id}|${l.id}`, c);
      }
    }

    const items = Number(stats.items) || 0;
    const periodLabel = (PERIODS.find(([v]) => v === dash.period) || [, ''])[1].toLowerCase();
    const stockSection = h('section', { class: 'card dash-card dash-wide', id: 'dash-stock' });

    body.replaceChildren(
      h('div', { class: 'stat-row' },
        statTile('Items handed out', items, `${Number(stats.records).toLocaleString()} handouts · ${Number(stats.people).toLocaleString()} people · ${periodLabel}`),
        statTile('Items in stock now', inStock, `${locs.length} location${locs.length === 1 ? '' : 's'}`),
        statTile('Sizes out of stock', outCount, 'Show which', 'critical', () => focusProblems()),
        statTile('Sizes running low', lowCount, `${low} or fewer left`, 'warning', () => focusProblems())),
      h('div', { class: 'dash-grid' },
        h('section', { class: 'card dash-card dash-wide' },
          h('h3', null, `Items handed out per ${bucket}`),
          h('p', { class: 'muted small' }, `${periodLabel[0].toUpperCase()}${periodLabel.slice(1)} · tap a column for details`),
          timeSeries(stats.by_period, range, bucket)),
        h('section', { class: 'card dash-card' },
          h('h3', null, 'Most used equipment'),
          h('p', { class: 'muted small' }, 'Items handed out · tap to open in History'),
          stats.by_product.length
            ? barList(stats.by_product.map(r => ({
                label: r.title, value: Number(r.qty),
                onClick: r.product_id ? () => ctx.showHandoutHistory(r.product_id, { country: dash.country, locationId: dash.locationId, period: dash.period }) : null,
              })))
            : h('p', { class: 'muted small' }, 'No handouts in this period.')),
        h('section', { class: 'card dash-card' },
          h('h3', null, dash.locationId === 'all' ? 'By location' : 'By reason'),
          h('p', { class: 'muted small' }, 'Items handed out'),
          dash.locationId === 'all'
            ? (stats.by_location.length ? barList(stats.by_location.map(r => ({ label: r.location_name || '—', value: Number(r.qty) }))) : h('p', { class: 'muted small' }, 'No handouts in this period.'))
            : (stats.by_reason.length ? barList(stats.by_reason.map(r => ({ label: r.reason, value: Number(r.qty) }))) : h('p', { class: 'muted small' }, 'No handouts in this period.'))),
        dash.locationId === 'all' ? h('section', { class: 'card dash-card' },
          h('h3', null, 'By reason'),
          h('p', { class: 'muted small' }, 'Items handed out'),
          stats.by_reason.length ? barList(stats.by_reason.map(r => ({ label: r.reason, value: Number(r.qty) }))) : h('p', { class: 'muted small' }, 'No handouts in this period.')) : null,
        stockSection));

    drawStock();

    function focusProblems() {
      dash.problemsOnly = true;
      drawStock();
      stockSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function drawStock() {
      const problem = c => c.out > 0 || c.low > 0;
      const rows = products.filter(p => !dash.problemsOnly || locs.some(l => problem(cells.get(`${p.id}|${l.id}`))));
      const toggle = h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: dash.problemsOnly, onchange: e => { dash.problemsOnly = e.target.checked; drawStock(); } }),
        'Only out of stock / running low');
      const head = h('div', { class: 'dash-stock-head' },
        h('div', null, h('h3', null, 'Stock check'),
          h('p', { class: 'muted small' }, locs.length === 1 ? `Per size at ${locs[0].Title}` : 'Total per location · tap a number for sizes')),
        toggle);
      const legend = h('div', { class: 'stock-legend muted small' },
        statusBadge('critical', 'Out'), ' a size that ran out  ',
        statusBadge('warning', 'Low'), ` ${low} or fewer left`);

      let content;
      if (!locs.length) content = emptyState('pin', 'No locations', 'There are no active locations here.');
      else if (!rows.length) content = emptyState('check', dash.problemsOnly ? 'Nothing out of stock or low' : 'No products', dash.problemsOnly ? 'All carried sizes are above the low-stock level.' : '');
      else if (locs.length === 1) content = singleLocationStock(rows, locs[0]);
      else content = stockMatrix(rows);
      stockSection.replaceChildren(head, legend, content);
    }

    // One location: each product with every size as a chip.
    function singleLocationStock(rows, loc) {
      return h('div', { class: 'stock-lines' }, rows.map(p => {
        const c = cells.get(`${p.id}|${loc.id}`);
        return h('div', { class: 'stock-line' },
          h('div', { class: 'sl-name' }, h('b', null, p.Title), h('span', { class: 'muted small' }, `${c.total.toLocaleString()} in stock`)),
          h('div', { class: 'size-chips' }, c.sizes.map(s => sizeChip(s, low))));
      }));
    }

    // Several locations: products × locations with totals; tap a cell for the sizes.
    function stockMatrix(rows) {
      const table = h('table', { class: 'stock-matrix' },
        h('thead', null, h('tr', null, h('th', null, 'Equipment'), locs.map(l => h('th', null, l.Title)), h('th', null, 'Total'))),
        h('tbody', null, rows.map(p => {
          let rowTotal = 0;
          const tds = locs.map(l => {
            const c = cells.get(`${p.id}|${l.id}`);
            rowTotal += c.total;
            return h('td', null, h('button', {
              class: 'cell-btn' + (c.out ? ' has-out' : c.low ? ' has-low' : '') + (c.carried ? '' : ' not-carried'),
              title: 'Show sizes', onclick: () => openSizes(p, l, c),
            },
              h('span', { class: 'cell-num' }, c.carried ? c.total.toLocaleString() : '—'),
              c.out ? statusBadge('critical', String(c.out)) : c.low ? statusBadge('warning', String(c.low)) : null));
          });
          return h('tr', null, h('th', { scope: 'row' }, p.Title), tds, h('td', { class: 'row-total' }, rowTotal.toLocaleString()));
        })));
      return h('div', { class: 'matrix-scroll' }, table);
    }

    function openSizes(p, l, c) {
      openModal({
        title: `${p.Title} at ${l.Title}`, iconName: 'package', iconClass: 'c-brand', size: 'sm',
        body: h('div', { class: 'stack' },
          h('div', { class: 'muted small' }, `${c.total.toLocaleString()} in stock`),
          h('div', { class: 'size-chips big' }, c.sizes.map(s => sizeChip(s, low)))),
      });
    }
  }

  drawFilters();
  queueMicrotask(load);
  return h('div', { class: 'dashboard' }, h('section', { class: 'card' }, filters), body);
}

function statTile(label, value, sub, status, onClick) {
  return h(onClick ? 'button' : 'div', { class: 'stat-tile' + (onClick ? ' clickable' : ''), type: onClick ? 'button' : null, onclick: onClick },
    h('span', { class: 'stat-label' }, status ? statusIcon(status) : null, label),
    h('span', { class: 'stat-value' }, Number(value).toLocaleString()),
    h('span', { class: 'stat-sub muted' }, sub));
}

function statusIcon(status) {
  return h('span', { class: `status-dot ${status}` }, icon('alert'));
}

function statusBadge(status, text) {
  return h('span', { class: `status-badge ${status}` }, icon('alert'), text);
}

function sizeChip(s, low) {
  const state = !s.known ? 'none' : s.qty <= 0 ? 'out' : s.qty <= low ? 'low' : 'ok';
  return h('span', { class: `size-chip ${state}`, title: state === 'none' ? 'Never stocked here' : state === 'out' ? 'Out of stock' : state === 'low' ? 'Running low' : 'In stock' },
    h('span', { class: 'sc-size' }, s.size),
    h('span', { class: 'sc-qty' }, s.known ? s.qty.toLocaleString() : '—'));
}

// Fills in empty weeks/months so gaps show as zero, then draws the column chart.
function timeSeries(byPeriod, range, bucket) {
  const values = new Map(byPeriod.map(r => [r.bucket, Number(r.qty)]));
  if (!values.size && !range.from) return h('p', { class: 'muted small' }, 'No handouts yet.');
  const startOf = d => (bucket === 'week'
    ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
    : new Date(d.getFullYear(), d.getMonth(), 1));
  const first = range.from ? new Date(range.from) : new Date(`${[...values.keys()].sort()[0]}T00:00:00`);
  const end = range.to ? new Date(range.to) : new Date();
  const data = [];
  for (let d = startOf(first); d < end && data.length < 400; d = bucket === 'week'
    ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)
    : new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const key = d.toLocaleDateString('sv-SE');
    const month = d.toLocaleDateString(undefined, { month: 'short' });
    data.push({
      label: bucket === 'week' ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        : (d.getMonth() === 0 || !data.length ? `${month} ${String(d.getFullYear()).slice(2)}` : month),
      tip: bucket === 'week' ? `Week of ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
        : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      value: values.get(key) || 0,
    });
  }
  return columnChart(data);
}
