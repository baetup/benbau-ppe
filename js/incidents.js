// Incidents tab: report events, NCRs and policy violations, with photo/document evidence.
import { h, field, emptyState, openModal, confirmDialog, toast, busy, FAILED, errorMessage, formatDate, todayISO, dateInputToIso } from './ui.js';
import { icon } from './icons.js';

const PAGE = 30;
const PERIODS = [
  ['all', 'All time'], ['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'],
  ['90', 'Last 3 months'], ['year', 'This year'], ['lastyear', 'Last year'], ['365', 'Last 12 months'],
];
const FILTER_DEFAULTS = { locationId: 'all', type: 'all', action: 'all', branch: 'all', status: 'all', period: 'all', search: '', personId: null };
export const inc = { country: null, ...FILTER_DEFAULTS, rows: [], total: 0, seq: 0 };

const actionClass = a => (/red/i.test(a) ? 'act-red' : /yellow/i.test(a) ? 'act-yellow' : /verbal|coach/i.test(a) ? 'act-blue' : 'act-grey');
const actionBadge = a => (a ? h('span', { class: `act-badge ${actionClass(a)}` }, /card/i.test(a) ? h('span', { class: 'card-chip' }) : null, a) : null);
const statusTag = s => h('span', { class: 'tag ' + (s === 'Closed' ? 'tag-green' : 'tag-amber') }, s || 'Open');
const isImage = e => /^image\//.test(e.type || '');

// Opens the Incidents tab filtered to one person (from the Personnel card).
export function showPersonIncidents(ctx, person) {
  Object.assign(inc, FILTER_DEFAULTS, { country: 'all', personId: person.id });
  ctx.goToTab('incidents');
}

// Small summary on the person's card: number of incidents, the last one, and quick links.
export function personIncidentsLine(ctx, person) {
  const box = h('div', { class: 'person-incidents muted small' }, 'Checking incidents…');
  ctx.svc.queryIncidents({ personId: person.id, limit: 1 }).then(({ rows, total }) => {
    const report = h('button', { class: 'link-btn', onclick: () => openIncidentForm(ctx, null, { person, onSaved: ctx.rerender }) }, 'Report incident');
    if (!total) { box.replaceChildren('No incidents recorded · ', report); return; }
    const last = rows[0];
    box.replaceChildren(
      h('span', { class: 'status-dot warning' }, icon('alert')),
      h('b', null, ` ${total} incident${total === 1 ? '' : 's'}`),
      ` · last: ${last.ActionTaken || last.Type} on ${formatDate(last.IncidentDate)} · `,
      h('button', { class: 'link-btn', onclick: () => showPersonIncidents(ctx, person) }, 'View'), ' · ', report);
  }).catch(() => { box.textContent = ''; });
  return box;
}

// ctx: { svc, state, cfg, COUNTRIES, countryName, periodRange, locationOptions, choosePerson, createSignaturePad, goToTab }
export function incidentsView(ctx) {
  const { svc, state, cfg, COUNTRIES } = ctx;
  if (inc.country === null) inc.country = state.country;

  const filters = h('div', { class: 'hist-filters' });
  const count = h('span', { class: 'muted small', style: { fontWeight: '400', marginLeft: 'auto' } });
  const activeBadge = h('span', { class: 'count-badge', hidden: true });
  const list = h('div', { class: 'inc-list' });
  const person = inc.personId ? svc.person(inc.personId) : null;

  function filterValues() {
    let locationIds = null;
    if (inc.locationId !== 'all') locationIds = [Number(inc.locationId)];
    else if (inc.country !== 'all') locationIds = svc.locations.filter(l => svc.countryOf(l) === inc.country).map(l => l.id);
    const pick = v => (v === 'all' ? null : v);
    return {
      locationIds, personId: inc.personId, type: pick(inc.type), action: pick(inc.action), branch: pick(inc.branch),
      status: pick(inc.status), search: inc.search.trim() || null, ...ctx.periodRange(inc.period),
    };
  }

  function drawFilters() {
    const select = (key, label, options, after) => field(label, h('select', {
      class: 'input', value: String(inc[key]),
      onchange: e => { inc[key] = e.target.value; if (after) after(); drawFilters(); load(); },
    }, options.map(([v, l]) => h('option', { value: String(v) }, l))));
    const locs = svc.locations.filter(l => inc.country === 'all' || svc.countryOf(l) === inc.country);
    if (inc.locationId !== 'all' && !locs.some(l => String(l.id) === String(inc.locationId))) inc.locationId = 'all';
    const both = list => list.map(v => [v, v]);
    let timer;
    const active = ['locationId', 'type', 'action', 'branch', 'status', 'period'].filter(k => inc[k] !== 'all').length
      + (inc.country !== state.country ? 1 : 0) + (inc.search.trim() ? 1 : 0);
    activeBadge.textContent = String(active);
    activeBadge.hidden = !active;
    filters.replaceChildren(...[
      COUNTRIES.length > 1 ? select('country', 'Country', [['all', 'All countries'], ...COUNTRIES.map(c => [c.code, c.name])], () => { inc.locationId = 'all'; }) : null,
      select('locationId', 'Location', [['all', 'All locations'], ...locs.map(l => [l.id, l.Title])]),
      select('type', 'Type', [['all', 'All types'], ...both(cfg.incidentTypes)]),
      select('action', 'Action taken', [['all', 'All actions'], ...both(cfg.incidentActions)]),
      select('branch', 'Branch', [['all', 'All branches'], ...both(cfg.branches)]),
      select('status', 'Status', [['all', 'Open and closed'], ['Open', 'Open'], ['Closed', 'Closed']]),
      select('period', 'Period', PERIODS),
      inc.personId ? null : field('Person', h('input', {
        class: 'input', type: 'search', placeholder: 'Search name…', value: inc.search,
        oninput: e => { clearTimeout(timer); timer = setTimeout(() => { inc.search = e.target.value; load(); }, 350); },
      })),
    ].filter(Boolean));
  }

  async function load(more = false) {
    const seq = more ? inc.seq : ++inc.seq;
    if (!more) list.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Loading incidents…'));
    try {
      const page = await svc.queryIncidents({ ...filterValues(), offset: more ? inc.rows.length : 0, limit: PAGE });
      if (seq !== inc.seq) return;
      inc.rows = more ? inc.rows.concat(page.rows) : page.rows;
      inc.total = page.total;
    } catch (e) {
      if (seq === inc.seq) list.replaceChildren(h('div', { class: 'card error-box' }, h('p', null, errorMessage(e)), h('button', { class: 'btn btn-outline', onclick: () => load() }, icon('refresh'), 'Retry')));
      return;
    }
    count.textContent = inc.total ? `${inc.total.toLocaleString()} incident${inc.total === 1 ? '' : 's'}` : '';
    if (!inc.rows.length) {
      list.replaceChildren(emptyState('shield', 'No incidents', 'Nothing matches these filters.'));
      return;
    }
    list.replaceChildren(...inc.rows.map(x => incidentCard(ctx, x, () => load())),
      ...(inc.rows.length < inc.total ? [h('button', { class: 'btn btn-block btn-outline load-more', onclick: e => { e.currentTarget.disabled = true; load(true); } },
        `Load more (${(inc.total - inc.rows.length).toLocaleString()} more)`)] : []));
  }

  drawFilters();
  queueMicrotask(() => load());

  return h('div', { class: 'incidents' },
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn btn-brand grow-sm', onclick: () => openIncidentForm(ctx, null, { onSaved: () => load() }) }, icon('plus'), 'Report incident'),
      h('button', { class: 'btn btn-outline', onclick: () => exportIncidents(ctx, filterValues()) }, icon('download'), h('span', { class: 'hide-sm' }, 'Export CSV'))),
    person ? h('div', { class: 'filter-chip' }, `Showing incidents for ${person.Title}`,
      h('button', { class: 'icon-btn', 'aria-label': 'Show everyone', onclick: () => { inc.personId = null; ctx.rerender(); } }, icon('x'))) : null,
    h('details', { class: 'card filter-panel', open: inc.filtersOpen ?? window.matchMedia('(min-width: 768px)').matches, ontoggle: e => { inc.filtersOpen = e.target.open; } },
      h('summary', null, h('span', null, 'Filters ', activeBadge), count), filters),
    list);
}

function incidentCard(ctx, x, reload) {
  const files = (x.Evidence || []).length;
  return h('button', { class: 'card inc-card', type: 'button', onclick: () => openIncidentDetail(ctx, x.id, reload) },
    h('div', { class: 'inc-top' },
      h('div', { class: 'inc-who' },
        h('div', { class: 'inc-name' }, x.PersonnelName),
        h('div', { class: 'muted small' }, [formatDate(x.IncidentDate), x.Branch, x.LocationName].filter(Boolean).join(' · '))),
      actionBadge(x.ActionTaken)),
    h('div', { class: 'inc-desc' }, x.Description),
    h('div', { class: 'inc-foot' },
      h('span', { class: 'tag' }, x.Type),
      h('span', { class: 'tag' }, `Breach #${x.BreachCount || 1}`),
      statusTag(x.Status),
      files ? h('span', { class: 'tag' }, icon('paperclip'), String(files)) : null,
      x.ReportedBy ? h('span', { class: 'muted small' }, `by ${x.ReportedBy}`) : null));
}

// ---------- detail ----------
async function openIncidentDetail(ctx, id, reload) {
  const { svc } = ctx;
  const res = await busy('Loading incident…', async () => {
    const row = await svc.getIncident(id);
    const urls = await svc.evidenceUrls((row.Evidence || []).map(e => e.path)).catch(() => new Map());
    return { row, urls };
  });
  if (res === FAILED) return;
  const { row: x, urls } = res;
  const changed = () => { m.close(); reload && reload(); };

  const info = (label, value) => (value ? h('div', { class: 'info-row' }, h('span', { class: 'muted' }, label), h('span', null, value)) : null);
  const evidence = (x.Evidence || []).map(e => {
    const url = urls.get(e.path);
    if (isImage(e) && url) return h('a', { class: 'ev-thumb', href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: e.name || 'Evidence photo', loading: 'lazy' }));
    return h('a', { class: 'ev-file', href: url || '#', target: '_blank', rel: 'noopener' }, icon('paperclip'), e.name || 'File');
  });

  const m = openModal({
    title: 'Incident', iconName: 'shield', iconClass: 'c-brand',
    body: h('div', { class: 'stack' },
      h('div', { class: 'inc-top' },
        h('div', null, h('h2', { class: 'inc-title' }, x.PersonnelName), h('div', { class: 'muted small' }, `#${x.id} · reported ${formatDate(x.CreatedAt || x.IncidentDate)}`)),
        actionBadge(x.ActionTaken)),
      h('div', { class: 'info-grid' },
        info('Date', formatDate(x.IncidentDate)),
        info('Branch', x.Branch),
        info('Location', x.LocationName),
        info('Type', x.Type),
        info('Action taken', x.ActionTaken),
        info('Times breached', String(x.BreachCount || 1)),
        info('Reported by', x.ReportedBy),
        info('Witnesses', x.Witnesses),
        h('div', { class: 'info-row' }, h('span', { class: 'muted' }, 'Status'),
          h('span', null, statusTag(x.Status), x.Status === 'Closed' && x.ClosedAt ? ` ${formatDate(x.ClosedAt)}${x.ClosedBy ? ' by ' + x.ClosedBy : ''}` : ''))),
      h('div', null, h('div', { class: 'field-label' }, 'Description'), h('p', { class: 'pre' }, x.Description)),
      x.FollowUp ? h('div', null, h('div', { class: 'field-label' }, 'Follow-up / corrective action'), h('p', { class: 'pre' }, x.FollowUp)) : null,
      evidence.length ? h('div', null, h('div', { class: 'field-label' }, `Evidence (${evidence.length})`), h('div', { class: 'ev-grid' }, evidence)) : null,
      x.Signature ? h('div', null, h('div', { class: 'field-label' }, 'Worker acknowledgement'), h('img', { class: 'sig-image small', src: x.Signature, alt: 'Signature' })) : null),
    footer: h('div', { class: 'btn-grid' },
      h('button', { class: 'btn btn-outline', onclick: () => { m.close(); openIncidentForm(ctx, x, { onSaved: reload }); } }, icon('edit'), 'Edit'),
      x.Status === 'Closed'
        ? h('button', { class: 'btn btn-outline', onclick: async () => {
            if (!(await confirmDialog('Reopen this incident?', { okText: 'Reopen' }))) return;
            const r = await busy('Saving…', () => svc.saveIncident({ id: x.id, Status: 'Open', ClosedAt: null, ClosedBy: null }));
            if (r !== FAILED) { toast('Incident reopened', 'success'); changed(); }
          } }, icon('refresh'), 'Reopen')
        : h('button', { class: 'btn btn-outline c-green', onclick: () => closeIncident(ctx, x, changed) }, icon('check'), 'Close'),
      h('button', { class: 'btn btn-outline', onclick: () => printIncident(ctx, x, urls) }, icon('printer'), 'Print / PDF'),
      h('button', { class: 'btn btn-outline c-red', onclick: async () => {
        if (!(await confirmDialog(`Delete incident #${x.id} for ${x.PersonnelName}, including its evidence files? This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
        const r = await busy('Deleting…', () => svc.deleteIncident(x));
        if (r !== FAILED) { toast('Incident deleted', 'success'); changed(); }
      } }, icon('trash'), 'Delete')),
  });
}

function closeIncident(ctx, x, done) {
  const note = h('textarea', { class: 'input', rows: '4', placeholder: 'What was done? e.g. toolbox talk held, worker re-trained, supervisor informed…', value: x.FollowUp || '' });
  const m = openModal({
    title: 'Close incident', iconName: 'check', iconClass: 'c-green', size: 'sm', persistent: true,
    body: field('Follow-up / corrective action', note),
    footer: h('button', { class: 'btn btn-block btn-green', onclick: async () => {
      const r = await busy('Saving…', () => ctx.svc.saveIncident({
        id: x.id, Status: 'Closed', FollowUp: note.value.trim(), ClosedAt: new Date().toISOString(), ClosedBy: ctx.svc.user.name,
      }));
      if (r === FAILED) return;
      m.close();
      toast('Incident closed', 'success');
      done();
    } }, icon('check'), 'Close incident'),
  });
}

// ---------- form ----------
export function openIncidentForm(ctx, existing, { person: presetPerson, onSaved } = {}) {
  const { svc, state, cfg } = ctx;
  const isNew = !existing;
  const x = existing || {};
  let person = presetPerson || (x.PersonnelId ? svc.person(x.PersonnelId) : null);
  const personName = () => (person ? person.Title : x.PersonnelName);

  const personBtn = h('button', { class: 'picker-btn', type: 'button' });
  const drawPerson = () => personBtn.replaceChildren(h('span', { class: personName() ? '' : 'placeholder' }, personName() || 'Select person…'), icon('chevronDown'));
  drawPerson();

  const options = (list, current) => {
    const all = [...list];
    if (current && !all.includes(current)) all.push(current);
    return all.map(v => h('option', { value: v }, v));
  };
  const date = h('input', { class: 'input', type: 'date', max: todayISO(), value: x.IncidentDate ? new Date(x.IncidentDate).toLocaleDateString('sv-SE') : todayISO() });
  const branch = h('select', { class: 'input' }, h('option', { value: '' }, '—'), options(cfg.branches, x.Branch || (person && person.Company)));
  branch.value = x.Branch || (person && cfg.branches.includes(person.Company) ? person.Company : '') || (person && person.Company) || '';
  const locs = svc.activeLocations();
  const loc = h('select', { class: 'input' }, ctx.locationOptions(locs));
  loc.value = String(x.LocationId || state.locationId || (locs[0] && locs[0].id) || '');
  const type = h('select', { class: 'input' }, options(cfg.incidentTypes, x.Type));
  if (x.Type) type.value = x.Type;
  const description = h('textarea', { class: 'input', rows: '4', placeholder: 'What happened? Be specific: what, where, what equipment, who confirmed it…', value: x.Description || '' });
  const action = h('select', { class: 'input' }, h('option', { value: '' }, '—'), options(cfg.incidentActions, x.ActionTaken));
  action.value = x.ActionTaken || '';
  const breaches = h('input', { class: 'input', type: 'number', min: '1', inputmode: 'numeric', value: String(x.BreachCount || 1) });
  let breachesTouched = !isNew;
  breaches.addEventListener('input', () => { breachesTouched = true; });
  const reportedBy = h('input', { class: 'input', value: x.ReportedBy || svc.user.name });
  const witnesses = h('input', { class: 'input', placeholder: 'Optional', value: x.Witnesses || '' });
  const status = h('select', { class: 'input' }, h('option', { value: 'Open' }, 'Open'), h('option', { value: 'Closed' }, 'Closed'));
  status.value = x.Status || 'Open';
  const followUp = h('textarea', { class: 'input', rows: '2', placeholder: 'Optional', value: x.FollowUp || '' });
  const history = h('div', { hidden: true });

  // Evidence: files already saved (can be removed) + new files (uploaded on save).
  let kept = [...(x.Evidence || [])];
  const removed = [];
  const added = [];
  const evBox = h('div', { class: 'ev-edit' });
  const fileInput = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true });
  fileInput.addEventListener('change', () => { for (const f of fileInput.files) added.push(f); fileInput.value = ''; drawEvidence(); });
  let savedUrls = new Map();
  if (kept.length) svc.evidenceUrls(kept.map(e => e.path)).then(u => { savedUrls = u; drawEvidence(); }).catch(() => {});
  function drawEvidence() {
    const chip = (label, thumbUrl, onRemove) => h('div', { class: 'ev-chip' },
      thumbUrl ? h('img', { src: thumbUrl, alt: '' }) : icon('paperclip'),
      h('span', null, label),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove file', onclick: onRemove }, icon('x')));
    evBox.replaceChildren(
      ...kept.map(e => chip(e.name || 'File', isImage(e) ? savedUrls.get(e.path) : null, () => { removed.push(e.path); kept = kept.filter(k => k !== e); drawEvidence(); })),
      ...added.map(f => chip(f.name, /^image\//.test(f.type) ? URL.createObjectURL(f) : null, () => { added.splice(added.indexOf(f), 1); drawEvidence(); })),
      h('button', { class: 'btn btn-outline', type: 'button', onclick: () => fileInput.click() }, icon('paperclip'), 'Add photos / files'));
  }
  drawEvidence();

  // Worker acknowledgement signature (optional).
  let sig = null;
  const sigBox = h('div');
  const drawSig = () => {
    if (x.Signature && !sig) {
      sigBox.replaceChildren(h('img', { class: 'sig-image small', src: x.Signature, alt: 'Signature' }),
        h('button', { class: 'link-btn', type: 'button', onclick: () => { sig = ctx.createSignaturePad(); sigBox.replaceChildren(sig.el); } }, 'Sign again'));
    } else {
      sig = sig || ctx.createSignaturePad();
      sigBox.replaceChildren(sig.el);
    }
  };
  drawSig();

  // Earlier incidents of this person: shown as a hint, and used to fill in "Times breached".
  async function refreshHistory() {
    if (!person) { history.hidden = true; return; }
    const p = person;
    try {
      const [all, sameType] = await Promise.all([
        svc.queryIncidents({ personId: p.id, limit: 3 }),
        svc.queryIncidents({ personId: p.id, type: type.value, limit: 1 }),
      ]);
      if (p !== person) return;
      // When editing, don't count the incident itself.
      const earlier = all.rows.filter(r => r.id !== x.id);
      const otherTotal = all.total - (isNew ? 0 : 1);
      const sameCount = Math.max(0, sameType.total - (!isNew && x.Type === type.value ? 1 : 0));
      if (!breachesTouched) breaches.value = String(sameCount + 1);
      if (!earlier.length) { history.hidden = true; return; }
      history.replaceChildren(h('div', { class: 'warn-box' },
        h('div', { class: 'warn-title' }, icon('alert'), `${p.Title} has ${otherTotal} earlier incident${otherTotal === 1 ? '' : 's'} (${sameCount} of type ${type.value})`),
        h('ul', null, earlier.map(r => h('li', null, h('b', null, r.ActionTaken || '—'), ` — ${formatDate(r.IncidentDate)} · ${r.Type}: ${r.Description.length > 70 ? r.Description.slice(0, 70) + '…' : r.Description}`)))));
      history.hidden = false;
    } catch (e) { history.hidden = true; }
  }
  type.addEventListener('change', refreshHistory);
  personBtn.addEventListener('click', async () => {
    const p = await ctx.choosePerson(person && person.id);
    if (!p) return;
    person = p;
    drawPerson();
    if (p.Company) {
      if (![...branch.options].some(o => o.value === p.Company)) branch.append(h('option', { value: p.Company }, p.Company));
      branch.value = p.Company;
    }
    if (p.LocationId && [...loc.options].some(o => o.value === String(p.LocationId))) loc.value = String(p.LocationId);
    refreshHistory();
  });
  refreshHistory();

  const m = openModal({
    title: isNew ? 'Report incident' : `Edit incident #${x.id}`, iconName: 'shield', iconClass: 'c-brand', persistent: true,
    body: h('div', { class: 'form' },
      field('Person *', personBtn),
      history,
      h('div', { class: 'form-2col' }, field('Date *', date), field('Branch', branch)),
      h('div', { class: 'form-2col' }, field('Location *', loc), field('Type *', type)),
      field('Short description of the violation *', description),
      h('div', { class: 'form-2col' }, field('Action taken', action), field('Times policy was breached', breaches)),
      h('div', { class: 'form-2col' }, field('Reported by', reportedBy), field('Witnesses', witnesses)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Evidence (photos, documents)'), evBox, fileInput),
      field('Worker acknowledgement (optional signature)', sigBox),
      h('div', { class: 'form-2col' }, field('Status', status), h('div')),
      field('Follow-up / corrective action', followUp)),
    footer: h('button', { class: 'btn btn-block btn-brand', onclick: save }, icon('check'), isNew ? 'Save incident' : 'Save changes'),
  });

  async function save() {
    if (!person && !x.PersonnelName) return toast('Select the person', 'error');
    if (!date.value) return toast('Choose the date', 'error');
    if (!loc.value) return toast('Choose the location', 'error');
    if (!description.value.trim()) return toast('Describe what happened', 'error');
    const n = parseInt(breaches.value, 10);
    if (!(n >= 1)) return toast('Times breached must be 1 or more', 'error');
    const lid = Number(loc.value);
    const closing = status.value === 'Closed' && x.Status !== 'Closed';
    const fields = {
      id: x.id,
      IncidentDate: isNew || date.value !== new Date(x.IncidentDate).toLocaleDateString('sv-SE') ? dateInputToIso(date.value) : x.IncidentDate,
      PersonnelId: person ? person.id : x.PersonnelId, PersonnelName: personName(),
      Branch: branch.value, LocationId: lid, LocationName: svc.locName(lid),
      Type: type.value, Description: description.value.trim(), ActionTaken: action.value, BreachCount: n,
      ReportedBy: reportedBy.value.trim(), Witnesses: witnesses.value.trim(),
      Status: status.value, FollowUp: followUp.value.trim(),
      ClosedAt: status.value === 'Closed' ? (closing ? new Date().toISOString() : x.ClosedAt) : null,
      ClosedBy: status.value === 'Closed' ? (closing ? svc.user.name : x.ClosedBy) : null,
    };
    // A signature only confirms the facts it was given for: when they change, the old signature is dropped
    // (the audit log keeps a fingerprint of it) unless the worker signs again.
    const factsChanged = !isNew && ['PersonnelId', 'IncidentDate', 'LocationId', 'Type', 'Description', 'ActionTaken', 'BreachCount']
      .some(k => String(fields[k] ?? '') !== String(x[k] ?? ''));
    fields.Signature = sig && !sig.isEmpty() ? sig.toDataURL() : (factsChanged ? '' : (x.Signature || ''));
    if (factsChanged && x.Signature && sig && sig.isEmpty()) toast('The details changed, so the old signature was removed. Ask the worker to sign again.', 'info', 6000);
    if (isNew) Object.assign(fields, { CreatedBy: svc.user.name, CreatedByEmail: svc.user.email, Evidence: [] });

    const r = await busy(added.length ? 'Saving and uploading evidence…' : 'Saving…', async () => {
      const row = await svc.saveIncident(fields);
      const id = row.id || x.id;
      const evidence = [...kept];
      for (const f of added) {
        const prepared = await prepareFile(f);
        const path = `${id}/${uid()}.${prepared.ext}`;
        await svc.uploadEvidence(path, prepared.blob, prepared.type);
        evidence.push({ path, name: f.name, type: prepared.type });
      }
      if (removed.length) await svc.removeEvidence(removed);
      if (added.length || removed.length) await svc.saveIncident({ id, Evidence: evidence });
      return row;
    });
    if (r === FAILED) return;
    m.close();
    toast(isNew ? 'Incident saved' : 'Incident updated', 'success');
    if (onSaved) onSaved();
  }
}

// Photos are resized (max 1600 px, JPEG) to keep uploads fast and storage small. Other files are kept as they are.
async function prepareFile(file) {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().slice(0, 5);
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) {
    if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} is larger than 20 MB`);
    return { blob: file, type: file.type || 'application/octet-stream', ext };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error(`Could not read ${file.name}`)); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 0.82));
    return { blob, type: 'image/jpeg', ext: 'jpg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------- print / PDF ----------
function printIncident(ctx, x, urls) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : '');
  const photos = (x.Evidence || []).filter(e => isImage(e) && urls.get(e.path)).map(e => `<img src="${esc(urls.get(e.path))}" alt="">`).join('');
  const files = (x.Evidence || []).filter(e => !isImage(e)).map(e => `<li>${esc(e.name)}</li>`).join('');
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups for this site to print', 'error');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Incident #${x.id} – ${esc(x.PersonnelName)}</title>
<style>
  body{font-family:"Segoe UI",Arial,sans-serif;color:#111827;margin:32px;font-size:14px}
  h1{color:#EF7D00;font-size:22px;margin:0 0 4px} .sub{color:#6b7280;margin-bottom:20px}
  table{border-collapse:collapse;margin-bottom:16px} th{text-align:left;color:#6b7280;font-weight:400;padding:4px 16px 4px 0;vertical-align:top} td{padding:4px 0}
  h2{font-size:15px;margin:18px 0 6px} p{white-space:pre-wrap;margin:0}
  .photos{display:grid;grid-template-columns:repeat(2,1fr);gap:10px} .photos img{width:100%;border:1px solid #e5e7eb;border-radius:6px}
  .sig{width:260px;border:1px solid #e5e7eb;border-radius:6px} @media print{body{margin:12mm}}
</style></head><body>
<h1>Incident report #${x.id}</h1><div class="sub">${esc(ctx.cfg.appName)} · printed ${esc(formatDate(new Date().toISOString()))}</div>
<table>${row('Person', x.PersonnelName)}${row('Date', formatDate(x.IncidentDate))}${row('Branch', x.Branch)}${row('Location', x.LocationName)}
${row('Type', x.Type)}${row('Action taken', x.ActionTaken)}${row('Times policy was breached', x.BreachCount)}${row('Reported by', x.ReportedBy)}
${row('Witnesses', x.Witnesses)}${row('Status', x.Status + (x.Status === 'Closed' && x.ClosedAt ? ` (${formatDate(x.ClosedAt)}${x.ClosedBy ? ', ' + x.ClosedBy : ''})` : ''))}</table>
<h2>Description</h2><p>${esc(x.Description)}</p>
${x.FollowUp ? `<h2>Follow-up / corrective action</h2><p>${esc(x.FollowUp)}</p>` : ''}
${photos ? `<h2>Evidence</h2><div class="photos">${photos}</div>` : ''}
${files ? `<h2>Attached files</h2><ul>${files}</ul>` : ''}
${x.Signature ? `<h2>Worker acknowledgement</h2><img class="sig" src="${esc(x.Signature)}" alt="">` : ''}
<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script>
</body></html>`);
  w.document.close();
}

// ---------- export ----------
async function exportIncidents(ctx, f) {
  const rows = await busy('Preparing export…', async () => {
    let all = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await ctx.svc.queryIncidents({ ...f, offset, limit: 1000 });
      all = all.concat(page.rows);
      if (!page.rows.length || all.length >= page.total) return all;
    }
  });
  if (rows === FAILED) return;
  if (!rows.length) return toast('Nothing to export', 'error');
  const cell = v => { const s = String(v == null ? '' : v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const day = iso => (iso ? new Date(iso).toLocaleDateString('sv-SE') : '');
  const header = ['No.', 'Name', 'Date', 'Branch', 'Location', 'Short description of violation', 'Type', 'Reported by', 'Times policy was breached', 'Action taken', 'Witnesses', 'Status', 'Follow-up', 'Closed', 'Evidence files'];
  const lines = rows.map(x => [x.id, x.PersonnelName, day(x.IncidentDate), x.Branch, x.LocationName, x.Description, x.Type, x.ReportedBy,
    x.BreachCount, x.ActionTaken, x.Witnesses, x.Status, x.FollowUp, day(x.ClosedAt), (x.Evidence || []).length].map(cell).join(';'));
  const blob = new Blob(['﻿' + [header.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `Incidents ${todayISO()}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Exported ${rows.length.toLocaleString()} incidents`, 'success');
}
