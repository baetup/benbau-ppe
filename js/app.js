import { h, field, emptyState, openModal, confirmDialog, pickFrom, toast, busy, FAILED, errorMessage, todayISO, dateInputToIso, formatDate } from './ui.js';
import { icon, microsoftLogo } from './icons.js';
import { LISTS, REASONS } from './schema.js';
import { PpeService, parseSizes } from './service.js';
import { DemoDb } from './db-demo.js';
import { SharePointDb } from './db-sharepoint.js';
import { createAuth } from './auth.js';
import { createGraph } from './graph.js';
import { createSignaturePad } from './signature.js';
import { buildReceiptHtml, receiptSubject } from './receipt.js';

const cfg = Object.assign({ appName: 'Benbau DK PPE Tracker' }, window.PPE_CONFIG || {});
const demo = !cfg.clientId || new URLSearchParams(location.search).has('demo');
const app = document.getElementById('app');
document.title = cfg.appName;

let svc, auth;

// ---------- UI state (persisted per browser) ----------
const PREF_KEY = 'ppe-prefs-' + (demo ? 'demo' : cfg.clientId);
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })();
const state = {
  tab: prefs.tab || 'inventory',
  locationId: prefs.locationId || null,
  personId: prefs.personId || null,
  cart: prefs.cart || [],             // [{ productId, size, qty }]
  cartLocationId: prefs.cartLocationId || null,
  search: '',
  sizeSel: {},                        // productId -> selected size
  qty: {},                            // productId -> stepper value
  stock: new Map(), stockLoc: null,   // stock map for stockLoc
  handouts: [], handoutsFor: null,
  hFilterProduct: 'all', hFilterPeriod: 'all',
};

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      tab: state.tab, locationId: state.locationId, personId: state.personId, cart: state.cart, cartLocationId: state.cartLocationId,
    }));
  } catch { /* storage unavailable */ }
}

// ---------- boot ----------
boot();

async function boot() {
  try {
    let db, user, mailer = null;
    if (demo) {
      db = new DemoDb();
      user = { name: 'Demo User', email: 'demo@example.com' };
    } else {
      if (!window.msal) throw new Error('Could not load the Microsoft sign-in library. Check your internet connection and reload.');
      renderLoading('Signing in…');
      auth = await createAuth(cfg);
      if (!auth.account) return renderLogin();
      const graph = createGraph(auth.getToken);
      user = { name: auth.account.name || auth.account.username, email: auth.account.username };
      db = new SharePointDb(graph, cfg.siteUrl);
      mailer = body => graph.post('/me/sendMail', body);
      renderLoading('Connecting to SharePoint…');
      const missing = await db.connect();
      if (missing.length) return renderSetup(db, missing);
    }
    renderLoading('Loading data…');
    svc = new PpeService(db, user, mailer);
    await svc.loadBase();
    startApp();
  } catch (e) {
    console.error(e);
    renderFatal(e);
  }
}

function renderLoading(text) {
  app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, text)));
}

function renderLogin() {
  app.replaceChildren(h('div', { class: 'center-screen' },
    h('div', { class: 'card login-card' },
      h('span', { class: 'brand-logo lg' }, icon('layers')),
      h('h1', null, cfg.appName),
      h('p', { class: 'muted' }, 'Sign in with your Microsoft 365 work account.'),
      h('button', { class: 'btn btn-block btn-ms', onclick: () => auth.login() }, microsoftLogo(), 'Sign in with Microsoft'))));
}

function renderSetup(db, missing) {
  const status = h('p', { class: 'muted small' });
  app.replaceChildren(h('div', { class: 'center-screen' },
    h('div', { class: 'card login-card left' },
      h('span', { class: 'brand-logo lg' }, icon('database')),
      h('h1', null, 'SharePoint setup'),
      h('p', null, 'The app stores its data in lists on ', h('b', null, cfg.siteUrl), '. These lists are missing:'),
      h('ul', { class: 'setup-list' }, missing.map(k => h('li', null, LISTS[k].title))),
      h('p', { class: 'muted small' }, 'You need Owner or Edit permission on the site. You may be asked to approve the “Manage your sites” permission once.'),
      h('button', {
        class: 'btn btn-block btn-brand', onclick: async () => {
          const r = await busy('Creating lists…', async () => {
            await auth.getToken(['Sites.Manage.All']);
            await db.provision(msg => { status.textContent = msg; });
          });
          if (r !== FAILED) { toast('SharePoint lists are ready', 'success'); boot(); }
        }
      }, icon('check'), 'Create lists'),
      status,
      h('button', { class: 'btn btn-block btn-outline', onclick: () => auth.logout() }, icon('logout'), 'Sign out'))));
}

function renderFatal(e) {
  let hint = '';
  if (e.status === 404) hint = 'The SharePoint site was not found. Check siteUrl in config.js.';
  else if (e.status === 403) hint = 'You do not have access to the SharePoint site. Ask the site owner to add you as a member.';
  app.replaceChildren(h('div', { class: 'center-screen' },
    h('div', { class: 'card login-card left' },
      h('span', { class: 'brand-logo lg danger' }, icon('alert')),
      h('h1', null, 'Something went wrong'),
      h('p', null, errorMessage(e)),
      hint ? h('p', { class: 'muted' }, hint) : null,
      h('button', { class: 'btn btn-block btn-brand', onclick: () => location.reload() }, icon('refresh'), 'Try again'),
      auth && auth.account ? h('button', { class: 'btn btn-block btn-outline', onclick: () => auth.logout() }, icon('logout'), 'Sign out') : null)));
}

function startApp() {
  ensureLocation();
  if (state.cartLocationId !== state.locationId) { state.cart = []; state.cartLocationId = state.locationId; }
  state.cart = state.cart.filter(c => svc.product(c.productId));
  savePrefs();
  renderShell();
  if (!svc.activeLocations().length) {
    toast('Add your first location to get started');
    openLocations();
  }
}

function ensureLocation() {
  const active = svc.activeLocations();
  if (!active.some(l => l.id === state.locationId)) state.locationId = active.length ? active[0].id : null;
}

// ---------- shell ----------
function renderShell() {
  const initials = (svc.user.name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  app.replaceChildren(
    h('header', { class: 'app-header' },
      h('div', { class: 'header-inner' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, icon('layers')), h('span', { class: 'brand-name' }, cfg.appName)),
        h('nav', { class: 'tabs' },
          tabButton('inventory', 'Inventory', 'package'),
          tabButton('personnel', 'Personnel', 'users')),
        h('button', { class: 'avatar-btn', title: svc.user.name, onclick: openUserMenu }, initials))),
    demo ? h('div', { class: 'demo-banner' }, 'Demo mode — sample data, stored only in this browser') : null,
    h('main', { class: 'view', id: 'view' }));
  renderView();
}

function tabButton(id, label, ic) {
  return h('button', {
    class: 'tab' + (state.tab === id ? ' active' : ''), 'data-tab': id,
    onclick: () => {
      state.tab = id;
      savePrefs();
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
      renderView();
      window.scrollTo(0, 0);
    },
  }, icon(ic), h('span', null, label));
}

function renderView() {
  const view = document.getElementById('view');
  if (view) view.replaceChildren(state.tab === 'inventory' ? inventoryView() : personnelView());
}

function openUserMenu() {
  const item = (ic, label, fn) => h('button', { class: 'menu-item', onclick: () => { m.close(); fn(); } }, icon(ic), label);
  const m = openModal({
    title: svc.user.name, iconName: 'user', iconClass: 'c-brand', size: 'sm',
    body: h('div', { class: 'menu' },
      h('div', { class: 'muted small pad-b' }, svc.user.email),
      item('pin', 'Manage locations', openLocations),
      item('refresh', 'Refresh data', refreshAll),
      !demo ? item('database', 'Check SharePoint lists', async () => {
        const r = await busy('Checking lists…', async () => { await auth.getToken(['Sites.Manage.All']); await svc.db.provision(); });
        if (r !== FAILED) toast('All lists and columns are in place', 'success');
      }) : null,
      demo ? item('refresh', 'Reset demo data', async () => {
        if (!(await confirmDialog('Delete all demo changes and restore the sample data?', { okText: 'Reset', danger: true }))) return;
        svc.db.reset();
        await refreshAll();
      }) : null,
      demo && cfg.clientId ? item('logout', 'Leave demo', () => { location.href = location.pathname; }) : null,
      !demo ? item('logout', 'Sign out', () => auth.logout()) : null),
  });
}

async function refreshAll() {
  const r = await busy('Refreshing…', () => svc.loadBase());
  if (r === FAILED) return;
  state.stockLoc = null;
  state.handoutsFor = null;
  startApp();
}

// ---------- inventory ----------
function inventoryView() {
  const locs = svc.activeLocations();
  const locSelect = h('select', {
    class: 'location-native', 'aria-label': 'Location', value: state.locationId == null ? '' : String(state.locationId),
    onchange: e => changeLocation(Number(e.target.value), e.target),
  }, locs.length ? locs.map(l => h('option', { value: String(l.id) }, l.Title)) : h('option', { value: '' }, 'No locations'));

  queueMicrotask(() => {
    updateCartBadge();
    if (state.stockLoc !== state.locationId) loadStock(); else fillProductList();
  });

  return h('div', { class: 'inventory' },
    h('div', { class: 'toolbar' },
      h('label', { class: 'location-pill' }, icon('pin'), locSelect, icon('chevronDown', 'chev')),
      h('button', { class: 'btn btn-outline cart-btn', 'aria-label': 'Cart', onclick: openCart }, icon('cart'), h('span', { class: 'badge', id: 'cart-badge' }))),
    h('div', { class: 'toolbar' },
      h('label', { class: 'search' }, icon('search'),
        h('input', { type: 'search', placeholder: 'Search products…', value: state.search, oninput: e => { state.search = e.target.value; fillProductList(); } })),
      h('button', { class: 'btn btn-outline', onclick: () => openProductEditor(null) }, icon('plus'), h('span', { class: 'hide-sm' }, 'New product'))),
    h('div', { class: 'product-grid', id: 'product-list' }));
}

async function changeLocation(id, select) {
  if (state.cart.length) {
    const ok = await confirmDialog(`Your cart has items from ${svc.locName(state.cartLocationId)}. Switching location will empty the cart.`, { okText: 'Switch location' });
    if (!ok) { select.value = String(state.locationId); return; }
    state.cart = [];
  }
  state.locationId = id;
  state.cartLocationId = id;
  savePrefs();
  updateCartBadge();
  loadStock();
}

async function loadStock() {
  const list = document.getElementById('product-list');
  const locId = state.locationId;
  if (!locId) {
    if (list) list.replaceChildren(emptyState('pin', 'No location yet', 'Add a location from the menu (top right).'));
    return;
  }
  if (list) list.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Loading stock…'));
  try {
    const stock = await svc.getStock(locId);
    if (locId !== state.locationId) return;
    state.stock = stock;
    state.stockLoc = locId;
  } catch (e) {
    if (list) list.replaceChildren(errorBox(e, loadStock));
    return;
  }
  fillProductList();
}

function errorBox(e, retry) {
  return h('div', { class: 'card error-box' }, h('p', null, errorMessage(e)), h('button', { class: 'btn btn-outline', onclick: retry }, icon('refresh'), 'Retry'));
}

const stockQty = (pid, size) => state.stock.get(`${pid}|${size}`) || 0;
const cartQty = (pid, size) => state.cart.filter(c => c.productId === pid && c.size === size).reduce((a, c) => a + c.qty, 0);

function fillProductList() {
  const list = document.getElementById('product-list');
  if (!list) return;
  const q = state.search.trim().toLowerCase();
  const prods = svc.activeProducts().filter(p => !q || `${p.Title} ${p.Brand || ''}`.toLowerCase().includes(q));
  if (!prods.length) {
    list.replaceChildren(q
      ? emptyState('search', 'No matching products', 'Try another search.')
      : emptyState('package', 'No products yet', 'Add your first product with “New product”.'));
    return;
  }
  list.replaceChildren(...prods.map(productCard));
}

function refreshCard(pid) {
  const old = document.querySelector(`.product-card[data-id="${pid}"]`);
  const p = svc.product(pid);
  if (old && p) old.replaceWith(productCard(p));
}

function thumb(p, cls) {
  const box = h('div', { class: cls });
  if (p && p.ImageUrl) {
    box.append(h('img', { src: p.ImageUrl, alt: '', loading: 'lazy', onerror: e => e.target.replaceWith(icon('package')) }));
  } else {
    box.append(icon('package'));
  }
  return box;
}

function productCard(p) {
  const sizes = svc.sizesOf(p);
  let size = state.sizeSel[p.id];
  if (!sizes.includes(size)) size = sizes[0];
  const inStock = stockQty(p.id, size);
  const inCart = cartQty(p.id, size);
  const qtyInput = h('input', {
    class: 'stepper-input', type: 'number', inputmode: 'numeric', min: '1', value: String(state.qty[p.id] ?? 1), 'aria-label': 'Quantity',
    oninput: e => { state.qty[p.id] = Math.max(0, parseInt(e.target.value, 10) || 0); },
  });
  const step = d => { const v = Math.max(1, (parseInt(qtyInput.value, 10) || 0) + d); qtyInput.value = String(v); state.qty[p.id] = v; };

  return h('article', { class: 'card product-card', 'data-id': p.id },
    h('div', { class: 'pc-top' },
      thumb(p, 'thumb'),
      h('div', { class: 'pc-title' }, h('h3', null, p.Title), h('div', { class: 'brand-text' }, p.Brand || '')),
      h('div', { class: 'pc-counts' },
        h('div', { class: 'count-stock' + (inStock <= 0 ? ' zero' : '') }, inStock), h('div', { class: 'count-label' }, 'in stock'),
        h('div', { class: 'count-cart' }, inCart), h('div', { class: 'count-label' }, 'in cart'))),
    field('Size / variant', h('select', {
      class: 'input', value: size,
      onchange: e => { state.sizeSel[p.id] = e.target.value; refreshCard(p.id); },
    }, sizes.map(s => h('option', { value: s }, `${s}   (${stockQty(p.id, s)} in stock)`)))),
    h('div', { class: 'pc-actions' },
      h('div', { class: 'stepper' },
        h('button', { type: 'button', 'aria-label': 'Less', onclick: () => step(-1) }, icon('minus')),
        qtyInput,
        h('button', { type: 'button', 'aria-label': 'More', onclick: () => step(1) }, icon('plus'))),
      h('button', { class: 'btn btn-dark grow', onclick: () => addToCart(p, size, parseInt(qtyInput.value, 10) || 0) }, icon('cart'), 'Add'),
      h('button', { class: 'btn btn-outline', onclick: () => openProductEditor(p) }, icon('edit'), h('span', { class: 'hide-xs' }, 'Edit'))));
}

function addToCart(p, size, qty) {
  if (!(qty > 0)) return toast('Choose a quantity first', 'error');
  const available = stockQty(p.id, size) - cartQty(p.id, size);
  if (qty > available) {
    return toast(available > 0 ? `Only ${available} more of ${p.Title} (${size}) in stock` : `${p.Title} (${size}) is not in stock at ${svc.locName(state.locationId)}`, 'error');
  }
  const existing = state.cart.find(c => c.productId === p.id && c.size === size);
  if (existing) existing.qty += qty; else state.cart.push({ productId: p.id, size, qty });
  state.cartLocationId = state.locationId;
  state.qty[p.id] = 1;
  savePrefs();
  refreshCard(p.id);
  updateCartBadge();
  toast(`${qty} × ${p.Title} (${size}) added to cart`, 'success', 1800);
}

function cartCount() { return state.cart.reduce((a, c) => a + c.qty, 0); }

function updateCartBadge() {
  const b = document.getElementById('cart-badge');
  if (!b) return;
  const n = cartCount();
  b.textContent = n ? String(n) : '';
  b.hidden = !n;
}

function afterCartChange() {
  savePrefs();
  updateCartBadge();
  fillProductList();
}

// ---------- cart ----------
function openCart() {
  const body = h('div');
  const countEl = h('span', { class: 'count-badge' });
  const requireItems = fn => () => { if (!state.cart.length) return toast('The cart is empty', 'error'); fn(); };
  const m = openModal({
    title: 'Selected items', titleExtra: countEl, iconName: 'cart', iconClass: 'c-brand', body,
    footer: h('div', { class: 'stack' },
      h('button', { class: 'btn btn-block btn-outline c-green', onclick: requireItems(() => openHandout(m)) }, icon('user'), 'Handout to worker'),
      h('button', { class: 'btn btn-block btn-outline c-blue', onclick: requireItems(() => openTransfer(m)) }, icon('swap'), 'Transfer to location'),
      h('button', {
        class: 'btn btn-block btn-outline', onclick: async () => {
          if (!state.cart.length) return;
          if (!(await confirmDialog('Remove all items from the cart?', { okText: 'Clear all', danger: true }))) return;
          state.cart = [];
          afterCartChange();
          draw();
        }
      }, icon('trash'), 'Clear all')),
  });
  function draw() {
    countEl.textContent = String(cartCount());
    if (!state.cart.length) { body.replaceChildren(emptyState('cart', 'The cart is empty', 'Add items from the inventory.')); return; }
    body.replaceChildren(h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, `From ${svc.locName(state.cartLocationId)}`),
      state.cart.map((c, i) => {
        const p = svc.product(c.productId);
        return h('div', { class: 'cart-item' },
          h('div', null,
            h('div', { class: 'ci-name' }, p.Title),
            h('div', { class: 'brand-text' }, p.Brand || ''),
            h('div', { class: 'ci-meta' }, `Size: ${c.size} · Quantity: ${c.qty}`)),
          h('button', { class: 'icon-btn c-red', 'aria-label': 'Remove', onclick: () => { state.cart.splice(i, 1); afterCartChange(); draw(); } }, icon('trash')));
      })));
  }
  draw();
}

function itemsSummary() {
  return h('div', { class: 'items-summary' },
    h('div', { class: 'field-label' }, `Items (${cartCount()}) from ${svc.locName(state.locationId)}`),
    state.cart.map(c => h('div', null, `${c.qty} × ${svc.product(c.productId).Title} — ${c.size}`)));
}

function choosePerson(selectedId, includeInactive = false) {
  const people = includeInactive ? svc.personnel : svc.activePersonnel();
  return pickFrom({
    title: 'Select personnel', iconName: 'users', selectedId,
    placeholder: 'Search by name or company…',
    items: people.map(p => ({
      id: p.id, label: p.Title,
      sub: [p.LocationName || svc.locName(p.LocationId), p.Company].filter(Boolean).join(' · '),
      badge: p.Active === false ? 'Inactive' : null,
    })),
    addLabel: 'Add new person',
    onAdd: () => openPersonEditor(null),
  }).then(id => (id ? svc.person(id) : null));
}

function personButton(person, onPick) {
  const btn = h('button', { class: 'picker-btn', type: 'button' });
  const draw = p => btn.replaceChildren(h('span', { class: p ? '' : 'placeholder' }, p ? p.Title : 'Select personnel…'), icon('chevronDown'));
  btn.addEventListener('click', async () => {
    const p = await choosePerson(person && person.id);
    if (p) { person = p; draw(p); onPick(p); }
  });
  draw(person);
  return btn;
}

function openHandout(cartModal) {
  let person = null;
  const reason = h('select', { class: 'input' }, REASONS.map(r => h('option', { value: r }, r)));
  const notes = h('textarea', { class: 'input', rows: '2', placeholder: 'Extra notes' });
  const date = h('input', { class: 'input', type: 'date', value: todayISO(), max: todayISO() });
  const sig = createSignaturePad();
  const emailCb = h('input', { type: 'checkbox' });
  const emailText = h('span');
  const emailRow = h('label', { class: 'check-row', hidden: true }, emailCb, emailText);
  const onPerson = p => {
    person = p;
    emailRow.hidden = !p.Email;
    emailCb.checked = !!p.Email;
    emailText.textContent = `Email receipt to ${p.Email || ''}`;
  };

  const m = openModal({
    title: 'Handout PPE', iconName: 'user', iconClass: 'c-brand', persistent: true,
    body: h('div', { class: 'form' },
      field('Personnel', personButton(null, onPerson)),
      field('Reason', reason),
      field('Notes', notes),
      field('Date', date),
      field('Receiver signature', sig.el),
      emailRow,
      itemsSummary()),
    footer: h('button', { class: 'btn btn-block btn-green', onclick: submit }, icon('check'), 'Complete handout'),
  });

  async function submit() {
    if (!person) return toast('Select the person receiving the PPE', 'error');
    if (!date.value) return toast('Choose a date', 'error');
    if (sig.isEmpty()) return toast('The receiver needs to sign', 'error');
    const sendTo = emailCb.checked ? person.Email : null;
    const rows = await busy('Saving handout…', () => svc.handout({
      person, locationId: state.locationId, items: state.cart.map(c => ({ ...c })),
      reason: reason.value, notes: notes.value.trim(), date: dateInputToIso(date.value), signature: sig.toDataURL(),
    }));
    state.stockLoc = null;
    state.handoutsFor = null;
    if (rows === FAILED) { loadStock(); return; }
    state.cart = [];
    m.close();
    cartModal.close();
    afterCartChange();
    loadStock();
    toast(`Handout to ${person.Title} saved`, 'success');
    if (sendTo) {
      const r = await busy('Sending receipt…', () => sendReceipt(rows, person, sendTo));
      if (r !== FAILED) toast(demo ? 'Demo mode: receipt email not sent' : `Receipt sent to ${sendTo}`, 'success');
    }
  }
}

function openTransfer(cartModal) {
  const fromId = state.locationId;
  const dests = svc.activeLocations().filter(l => l.id !== fromId);
  if (!dests.length) return toast('Add another location first (menu → Manage locations)', 'error');
  const dest = h('select', { class: 'input' }, h('option', { value: '' }, 'Choose destination…'), dests.map(l => h('option', { value: String(l.id) }, l.Title)));
  const reason = h('textarea', { class: 'input', rows: '5', placeholder: 'Write reason (ex: new workers incoming soon, visitors on site, backup in case of PPE wear…)' });

  const m = openModal({
    title: 'Transfer to location', iconName: 'swap', iconClass: 'c-blue', persistent: true,
    body: h('div', { class: 'form' },
      field('From', h('div', { class: 'input static' }, svc.locName(fromId))),
      field('Destination', dest),
      field('Reason', reason),
      itemsSummary()),
    footer: h('button', { class: 'btn btn-block btn-blue', onclick: submit }, icon('check'), 'Complete transfer'),
  });

  async function submit() {
    if (!dest.value) return toast('Choose a destination', 'error');
    const toId = Number(dest.value);
    const r = await busy('Transferring…', () => svc.transfer({
      fromId, toId, items: state.cart.map(c => ({ ...c })), reason: reason.value.trim(), date: dateInputToIso(todayISO()),
    }));
    state.stockLoc = null;
    if (r === FAILED) { loadStock(); return; }
    state.cart = [];
    m.close();
    cartModal.close();
    afterCartChange();
    loadStock();
    toast(`Transferred to ${svc.locName(toId)}`, 'success');
  }
}

// ---------- products ----------
function openProductEditor(product) {
  const isNew = !product;
  const p = product || { Title: '', Brand: '', Sizes: 'S, M, L, XL, 2XL', ImageUrl: '', Active: true };
  const locId = state.locationId;
  const name = h('input', { class: 'input', value: p.Title || '' });
  const brand = h('input', { class: 'input', value: p.Brand || '' });
  const sizes = h('input', { class: 'input', value: p.Sizes || '', placeholder: 'e.g. S, M, L, XL or OneSize' });
  const image = h('input', { class: 'input', type: 'url', value: p.ImageUrl || '', placeholder: 'https://… (optional)' });
  const active = h('input', { type: 'checkbox', checked: p.Active !== false });
  const stockGrid = h('div', { class: 'stock-grid' });
  const stockInputs = {};

  function drawStock() {
    const prev = Object.fromEntries(Object.entries(stockInputs).map(([s, inp]) => [s, inp.value]));
    for (const k of Object.keys(stockInputs)) delete stockInputs[k];
    const list = parseSizes(sizes.value);
    stockGrid.replaceChildren(...(list.length ? list : ['OneSize']).map(s => {
      const inp = h('input', { class: 'input', type: 'number', min: '0', inputmode: 'numeric', value: prev[s] ?? String(product ? stockQty(product.id, s) : 0) });
      stockInputs[s] = inp;
      return h('label', { class: 'stock-cell' }, h('span', null, s), inp);
    }));
  }
  sizes.addEventListener('input', drawStock);
  drawStock();

  const m = openModal({
    title: isNew ? 'New product' : 'Edit product', iconName: 'package', iconClass: 'c-brand', persistent: true,
    body: h('div', { class: 'form' },
      field('Product name *', name),
      field('Brand', brand),
      field('Sizes / variants (comma separated)', sizes),
      field('Image URL', image),
      locId ? h('div', { class: 'field' },
        h('span', { class: 'field-label' }, `Stock at ${svc.locName(locId)}`),
        h('span', { class: 'muted small' }, 'Use this to register deliveries or correct counts.'),
        stockGrid) : null,
      h('label', { class: 'check-row' }, active, 'Active (uncheck to hide the product)')),
    footer: h('button', { class: 'btn btn-block btn-brand', onclick: save }, icon('check'), 'Save'),
  });

  async function save() {
    if (!name.value.trim()) return toast('Product name is required', 'error');
    const r = await busy('Saving…', async () => {
      const saved = await svc.saveProduct({
        id: product && product.id, Title: name.value.trim(), Brand: brand.value.trim(),
        Sizes: parseSizes(sizes.value).join(', ') || 'OneSize', ImageUrl: image.value.trim(), Active: active.checked,
      });
      if (locId) {
        for (const [s, inp] of Object.entries(stockInputs)) {
          const qty = Math.max(0, parseInt(inp.value, 10) || 0);
          const old = product ? stockQty(saved.id, s) : 0;
          if (qty !== old) await svc.setStock(saved.id, s, locId, qty);
        }
      }
      return saved;
    });
    if (r === FAILED) return;
    m.close();
    toast('Product saved', 'success');
    state.stockLoc = null;
    if (state.tab === 'inventory') loadStock();
  }
}

// ---------- locations ----------
function openLocations() {
  const body = h('div', { class: 'stack' });
  function draw() {
    body.replaceChildren(
      ...svc.locations.map(l => {
        const name = h('input', { class: 'input', value: l.Title });
        const act = h('input', { type: 'checkbox', checked: l.Active !== false });
        return h('div', { class: 'loc-row' }, name, h('label', { class: 'check-row' }, act, 'Active'),
          h('button', {
            class: 'btn btn-outline', onclick: async () => {
              if (!name.value.trim()) return toast('Name is required', 'error');
              const r = await busy('Saving…', () => svc.saveLocation({ id: l.id, Title: name.value.trim(), Active: act.checked }));
              if (r !== FAILED) { toast('Location saved', 'success'); draw(); }
            }
          }, 'Save'));
      }),
      (() => {
        const name = h('input', { class: 'input', placeholder: 'New location name' });
        return h('div', { class: 'loc-row new' }, name, h('button', {
          class: 'btn btn-brand', onclick: async () => {
            if (!name.value.trim()) return toast('Enter a name', 'error');
            const r = await busy('Saving…', () => svc.saveLocation({ Title: name.value.trim(), Active: true }));
            if (r !== FAILED) { toast('Location added', 'success'); draw(); }
          }
        }, icon('plus'), 'Add'));
      })());
  }
  draw();
  openModal({
    title: 'Locations', iconName: 'pin', iconClass: 'c-brand', body,
    onClose: () => { ensureLocation(); savePrefs(); renderShell(); },
  });
}

// ---------- personnel ----------
const PERIODS = [['all', 'All time'], ['30', 'Last 30 days'], ['90', 'Last 3 months'], ['365', 'Last 12 months']];

function personnelView() {
  const person = svc.person(state.personId);
  const bar = h('div', { class: 'toolbar' },
    h('button', {
      class: 'picker-btn grow', onclick: async () => {
        const p = await choosePerson(state.personId, true);
        if (p) { state.personId = p.id; state.hFilterProduct = 'all'; savePrefs(); renderView(); }
      }
    }, h('span', { class: person ? '' : 'placeholder' }, person ? person.Title : 'Select personnel…'), icon('chevronDown')),
    h('button', {
      class: 'btn btn-outline square', title: 'Add person', 'aria-label': 'Add person', onclick: async () => {
        const p = await openPersonEditor(null);
        if (p) { state.personId = p.id; savePrefs(); renderView(); }
      }
    }, icon('userPlus')));

  if (!person) {
    return h('div', { class: 'personnel' }, bar, emptyState('users', 'No person selected', 'Choose a person to see their PPE history, or add a new one.'));
  }

  const locName = person.LocationName || svc.locName(person.LocationId);
  const contact = [person.Email, person.Phone].filter(Boolean).join(' · ');
  queueMicrotask(() => { if (state.handoutsFor !== person.id) loadHandouts(person.id); else fillHandouts(); });

  return h('div', { class: 'personnel' }, bar,
    h('section', { class: 'card person-card' },
      h('div', { class: 'person-head' },
        h('div', null,
          h('h2', null, person.Title),
          h('div', { class: 'tags' },
            locName ? h('span', { class: 'tag' }, icon('pin'), locName) : null,
            h('span', { class: 'tag ' + (person.Active !== false ? 'tag-green' : 'tag-grey') }, person.Active !== false ? 'Active' : 'Inactive'),
            person.Company ? h('span', { class: 'tag' }, person.Company) : null,
            person.EmployeeNo ? h('span', { class: 'tag' }, '#' + person.EmployeeNo) : null),
          contact ? h('div', { class: 'muted small' }, contact) : null),
        h('button', {
          class: 'icon-btn c-blue', title: 'Edit person', 'aria-label': 'Edit person', onclick: async () => {
            if (await openPersonEditor(person)) renderView();
          }
        }, icon('edit'))),
      h('div', { class: 'filters', id: 'handout-filters' })),
    h('div', { class: 'muted small summary-line', id: 'handout-summary' }),
    h('div', { class: 'handout-list', id: 'handout-list' }));
}

async function loadHandouts(personId) {
  const list = document.getElementById('handout-list');
  if (list) list.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Loading history…'));
  try {
    const rows = await svc.getHandoutsFor(personId);
    if (personId !== state.personId) return;
    state.handouts = rows;
    state.handoutsFor = personId;
  } catch (e) {
    if (list) list.replaceChildren(errorBox(e, () => loadHandouts(personId)));
    return;
  }
  fillHandouts();
}

function fillHandouts() {
  const filters = document.getElementById('handout-filters');
  const list = document.getElementById('handout-list');
  const summary = document.getElementById('handout-summary');
  if (!list) return;

  const products = new Map();
  for (const x of state.handouts) if (!products.has(x.ProductId)) products.set(x.ProductId, x.Title);
  if (state.hFilterProduct !== 'all' && !products.has(Number(state.hFilterProduct))) state.hFilterProduct = 'all';

  filters.replaceChildren(
    h('select', { class: 'input', 'aria-label': 'Filter by product', value: String(state.hFilterProduct), onchange: e => { state.hFilterProduct = e.target.value; fillHandouts(); } },
      h('option', { value: 'all' }, 'All products'),
      [...products].map(([id, title]) => h('option', { value: String(id) }, title))),
    h('select', { class: 'input', 'aria-label': 'Filter by period', value: state.hFilterPeriod, onchange: e => { state.hFilterPeriod = e.target.value; fillHandouts(); } },
      PERIODS.map(([v, l]) => h('option', { value: v }, l))));

  const since = state.hFilterPeriod === 'all' ? 0 : Date.now() - Number(state.hFilterPeriod) * 86400000;
  const rows = state.handouts.filter(x =>
    (state.hFilterProduct === 'all' || x.ProductId === Number(state.hFilterProduct)) &&
    (!since || new Date(x.HandoutDate).getTime() >= since));

  const total = rows.reduce((a, x) => a + (Number(x.Quantity) || 0), 0);
  summary.textContent = rows.length ? `${total} item${total === 1 ? '' : 's'} handed out` : '';
  list.replaceChildren(...(rows.length
    ? rows.map(handoutCard)
    : [emptyState('package', 'No handouts', state.handouts.length ? 'Nothing matches the filters.' : 'This person has not received any PPE yet.')]));
}

function handoutCard(x) {
  return h('article', { class: 'card handout-card' },
    thumb(svc.product(x.ProductId), 'thumb'),
    h('div', { class: 'hc-body' },
      h('div', { class: 'hc-title' }, x.Title),
      h('div', { class: 'small' }, `Size: ${x.Size} · Qty: ${x.Quantity}`),
      h('div', { class: 'muted xsmall' }, `Handed out by ${x.HandedOutBy || '—'} on ${formatDate(x.HandoutDate)}${x.LocationName ? ' · ' + x.LocationName : ''}`),
      h('div', { class: 'small' }, h('b', null, 'Reason: '), x.Reason || '—'),
      x.Notes ? h('div', { class: 'small muted' }, h('b', null, 'Notes: '), x.Notes) : null,
      x.Signature ? h('button', { class: 'link-btn', onclick: () => showSignature(x) }, 'View signature') : null),
    h('div', { class: 'hc-actions' },
      h('button', { class: 'icon-btn c-red', title: 'Delete', 'aria-label': 'Delete handout', onclick: () => deleteHandout(x) }, icon('trash')),
      h('button', { class: 'icon-btn c-blue', title: 'Email receipt', 'aria-label': 'Email receipt', onclick: () => openReceipt(x) }, icon('mail'))));
}

function showSignature(x) {
  openModal({
    title: 'Receiver signature', iconName: 'edit', iconClass: 'c-brand', size: 'sm',
    body: h('div', { class: 'stack' },
      h('img', { class: 'sig-image', src: x.Signature, alt: `Signature of ${x.PersonnelName}` }),
      h('div', { class: 'muted small' }, `${x.PersonnelName} · ${formatDate(x.HandoutDate)}`)),
  });
}

async function deleteHandout(x) {
  const canReturn = x.LocationId && svc.location(x.LocationId);
  const res = await confirmDialog(`Delete the handout record for ${x.Quantity} × ${x.Title} (${x.Size})?`, {
    title: 'Delete handout', okText: 'Delete', danger: true,
    checkbox: canReturn ? `Return ${x.Quantity} to stock at ${x.LocationName}` : null,
  });
  if (!res) return;
  const r = await busy('Deleting…', () => svc.deleteHandout(x, res.checked));
  if (r === FAILED) return;
  state.handouts = state.handouts.filter(y => y.id !== x.id);
  if (res.checked) state.stockLoc = null;
  fillHandouts();
  toast('Handout deleted', 'success');
}

async function sendReceipt(rows, person, to) {
  if (demo) return;
  await svc.sendReceipt({
    to,
    subject: receiptSubject(person, rows),
    html: buildReceiptHtml({ appName: cfg.appName, person, rows, signatureSrc: rows[0].Signature ? 'cid:signature' : '' }),
    signatureDataUrl: rows[0].Signature,
  });
}

function openReceipt(x) {
  const person = svc.person(x.PersonnelId) || { Title: x.PersonnelName };
  const rows = x.BatchId ? state.handouts.filter(y => y.BatchId === x.BatchId) : [x];
  const to = h('input', { class: 'input', type: 'email', value: person.Email || '', placeholder: 'name@company.com' });
  const frame = h('iframe', { class: 'receipt-frame', title: 'Receipt preview' });
  frame.srcdoc = buildReceiptHtml({ appName: cfg.appName, person, rows, signatureSrc: x.Signature || '' });

  const m = openModal({
    title: 'Email receipt', iconName: 'mail', iconClass: 'c-blue',
    body: h('div', { class: 'form' },
      field('Send to', to),
      demo ? h('div', { class: 'note' }, 'Demo mode: the email is not actually sent.') : null,
      field('Preview', frame)),
    footer: h('button', {
      class: 'btn btn-block btn-blue', onclick: async () => {
        const addr = to.value.trim();
        if (!/^\S+@\S+\.\S+$/.test(addr)) return toast('Enter a valid email address', 'error');
        const r = await busy('Sending…', () => sendReceipt(rows, person, addr));
        if (r === FAILED) return;
        m.close();
        toast(demo ? 'Demo mode: receipt not sent' : `Receipt sent to ${addr}`, 'success');
      }
    }, icon('mail'), 'Send receipt'),
  });
}

function openPersonEditor(person) {
  return new Promise(resolve => {
    const isNew = !person;
    const p = person || { Active: true, LocationId: state.locationId };
    const name = h('input', { class: 'input', value: p.Title || '', autocomplete: 'off' });
    const email = h('input', { class: 'input', type: 'email', value: p.Email || '', autocomplete: 'off' });
    const phone = h('input', { class: 'input', type: 'tel', value: p.Phone || '', autocomplete: 'off' });
    const company = h('input', { class: 'input', value: p.Company || '' });
    const empNo = h('input', { class: 'input', value: p.EmployeeNo || '' });
    const loc = h('select', { class: 'input', value: p.LocationId ? String(p.LocationId) : '' },
      h('option', { value: '' }, '—'), svc.locations.map(l => h('option', { value: String(l.id) }, l.Title)));
    const active = h('input', { type: 'checkbox', checked: p.Active !== false });
    let saved = null;

    const m = openModal({
      title: isNew ? 'Add person' : 'Edit person', iconName: isNew ? 'userPlus' : 'user', iconClass: 'c-brand', persistent: true,
      body: h('div', { class: 'form' },
        field('Full name *', name),
        field('Email (for receipts)', email),
        field('Phone', phone),
        field('Company', company),
        field('Employee no.', empNo),
        field('Site / location', loc),
        h('label', { class: 'check-row' }, active, 'Active')),
      footer: h('button', {
        class: 'btn btn-block btn-brand', onclick: async () => {
          if (!name.value.trim()) return toast('Name is required', 'error');
          if (email.value.trim() && !/^\S+@\S+\.\S+$/.test(email.value.trim())) return toast('Email address looks wrong', 'error');
          const lid = loc.value ? Number(loc.value) : null;
          const r = await busy('Saving…', () => svc.savePerson({
            id: person && person.id, Title: name.value.trim(), Email: email.value.trim(), Phone: phone.value.trim(),
            Company: company.value.trim(), EmployeeNo: empNo.value.trim(),
            LocationId: lid, LocationName: lid ? svc.locName(lid) : '', Active: active.checked,
          }));
          if (r === FAILED) return;
          saved = r;
          m.close();
          toast(isNew ? 'Person added' : 'Person saved', 'success');
        }
      }, icon('check'), 'Save'),
      onClose: () => resolve(saved),
    });
  });
}
