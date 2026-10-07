// Small, dependency-free charts (SVG / HTML) for the Dashboard.
// Specs: bars <= 24px with a 4px rounded data end (square at the baseline), hairline grid,
// muted axis text, values in text colours (never the series colour), hover tooltips.
import { h } from './ui.js';

const C = {
  series: '#2a78d6',       // categorical slot 1 (blue)
  seriesHover: '#1c5cab',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
};

// Clean axis maximum and step (1 / 2 / 5 × 10^n).
function niceScale(max, ticks = 4) {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
  return { max: Math.ceil(max / step) * step, step: Math.max(1, step) };
}

// Column chart over time. data: [{ label, value, tip }]
export function columnChart(data, { height = 230, unit = 'items' } = {}) {
  const wrap = h('div', { class: 'chart' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const svgBox = h('div');
  wrap.append(svgBox, tip);
  let lastW = 0;

  function draw() {
    const W = Math.round(wrap.clientWidth);
    if (!W || W === lastW) return;
    lastW = W;
    const padL = 40, padR = 8, padT = 12, padB = 26;
    const plotW = W - padL - padR, plotH = height - padT - padB;
    const n = data.length;
    const { max, step } = niceScale(Math.max(0, ...data.map(d => d.value)));
    const y = v => padT + plotH - (v / max) * plotH;
    const band = plotW / Math.max(n, 1);
    const barW = Math.max(2, Math.min(24, band * 0.62));
    const every = Math.max(1, Math.ceil(46 / band));
    let s = `<svg width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-label="Column chart">`;
    for (let v = 0; v <= max; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      s += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="${v === 0 ? C.axis : C.grid}" stroke-width="1"/>`;
      s += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${C.muted}" style="font-variant-numeric:tabular-nums">${v.toLocaleString()}</text>`;
    }
    data.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      const x = cx - barW / 2, top = y(d.value), base = y(0);
      const hgt = base - top;
      if (d.value > 0) {
        const r = Math.min(4, barW / 2, hgt);
        s += `<path class="bar" data-i="${i}" fill="${C.series}" d="M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${base}Z"/>`;
      }
      if (i % every === 0) {
        s += `<text x="${cx}" y="${height - 8}" text-anchor="middle" font-size="11" fill="${C.muted}">${d.label}</text>`;
      }
      s += `<rect class="hit" data-i="${i}" x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" fill="transparent"/>`;
    });
    s += '</svg>';
    svgBox.innerHTML = s;
  }

  function show(e) {
    const t = e.target.closest('[data-i]');
    svgBox.querySelectorAll('.bar').forEach(b => b.setAttribute('fill', C.series));
    if (!t) { tip.hidden = true; return; }
    const i = Number(t.dataset.i);
    const bar = svgBox.querySelector(`.bar[data-i="${i}"]`);
    if (bar) bar.setAttribute('fill', C.seriesHover);
    tip.replaceChildren(h('b', null, data[i].tip || data[i].label), h('span', null, `${data[i].value.toLocaleString()} ${unit}`));
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const hit = t.getBoundingClientRect();
    const left = Math.min(Math.max(hit.left - box.left + hit.width / 2, 60), box.width - 60);
    tip.style.left = `${left}px`;
  }
  wrap.addEventListener('pointermove', show);
  wrap.addEventListener('pointerdown', show);
  wrap.addEventListener('pointerleave', () => { tip.hidden = true; svgBox.querySelectorAll('.bar').forEach(b => b.setAttribute('fill', C.series)); });
  new ResizeObserver(draw).observe(wrap);
  return wrap;
}

// Ranked horizontal bars. rows: [{ label, value, onClick? }] (already sorted). Values at the bar tips.
export function barList(rows, { unit = 'items', limit = 8 } = {}) {
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit);
  const max = Math.max(1, ...rows.map(r => r.value));
  const line = r => h(r.onClick ? 'button' : 'div', {
    class: 'bl-row' + (r.onClick ? ' clickable' : ''), type: r.onClick ? 'button' : null, onclick: r.onClick,
    title: `${r.label}: ${r.value.toLocaleString()} ${unit}`,
  },
    h('span', { class: 'bl-label' }, r.label),
    h('span', { class: 'bl-track' },
      h('span', { class: 'bl-bar', style: { width: `${Math.max(1, (r.value / max) * 100)}%`, background: C.series } }),
      h('span', { class: 'bl-value' }, r.value.toLocaleString())));
  const out = h('div', { class: 'bar-list' }, shown.map(line));
  if (rest.length) {
    const other = rest.reduce((a, r) => a + r.value, 0);
    out.append(h('div', { class: 'bl-row' },
      h('span', { class: 'bl-label muted' }, `Other (${rest.length})`),
      h('span', { class: 'bl-track' },
        h('span', { class: 'bl-bar', style: { width: `${Math.min(100, Math.max(1, (other / max) * 100))}%`, background: C.axis } }),
        h('span', { class: 'bl-value' }, other.toLocaleString()))));
  }
  return out;
}
