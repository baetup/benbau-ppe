import { h, field, emptyState, openModal, confirmDialog, pickFrom, toast, busy, FAILED, errorMessage, todayISO, dateInputToIso, formatDate } from './ui.js';
import { icon } from './icons.js';
import { REASONS } from './schema.js';
import { PpeService, parseSizes } from './service.js';
import { DemoDb } from './db-demo.js';
import { SupabaseDb } from './db-supabase.js';
import { createSignaturePad } from './signature.js';
import { buildReceiptHtml, receiptImage } from './receipt.js';
import { dashboardView } from './dashboard.js';

const cfg = Object.assign({ appName: 'Benbau PPE Tracker' }, window.PPE_CONFIG || {});
const demo = !cfg.supabaseUrl || !cfg.supabaseKey || new URLSearchParams(location.search).has('demo');
const COUNTRIES = (cfg.countries && cfg.countries.length) ? cfg.countries : [{ code: 'DK', name: 'Denmark' }];
// Clothing sizes stored on each person's profile: [field, label, placeholder]
const PERSON_SIZES = [
  ['BootsSize', 'Boots', 'e.g. 43'],
  ['JacketSize', 'Jacket', 'e.g. L'],
  ['TrouserSize', 'Trousers', 'e.g. 52 or L'],
  ['VestSize', 'Vest', 'e.g. XL'],
  ['GlovesSize', 'Gloves', 'e.g. 9'],
];
const countryName = code => (COUNTRIES.find(c => c.code === code) || { name: code || '—' }).name;
const app = document.getElementById('app');
document.title = cfg.appName;

let svc, sb;
// Opened from a "reset password" email link?
let passwordRecovery = /type=recovery/.test(location.hash);

// ---------- UI state (persisted per browser) ----------
const PREF_KEY = 'ppe-prefs-' + (demo ? 'demo' : 'live');
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })();
const state = {
  tab: 'dashboard',                   // the app always opens on the Dashboard
  country: COUNTRIES.some(c => c.code === prefs.country) ? prefs.country : COUNTRIES[0].code,
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
      tab: state.tab, country: state.country, locationId: state.locationId, personId: state.personId, cart: state.cart, cartLocationId: state.cartLocationId,
    }));
  } catch { /* storage unavailable */ }
}

// ---------- boot ----------
boot();

async function boot() {
  try {
    let db, user;
    if (demo) {
      user = { name: 'Demo User', email: 'demo@example.com' };
      db = new DemoDb(user);
    } else {
      if (!window.supabase) throw new Error('Could not load the Supabase library. Check your internet connection and reload.');
      if (!sb) {
        sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
        sb.auth.onAuthStateChange(event => {
          if (event === 'PASSWORD_RECOVERY') { passwordRecovery = true; renderNewPassword(); }
          if (event === 'SIGNED_OUT' && svc) location.reload();
        });
      }
      renderLoading('Signing in…');
      const { data: { session } } = await sb.auth.getSession();
      if (passwordRecovery && session) return renderNewPassword();
      if (!session) return renderLogin();

      // Only people listed in the staff table may use the app (the database enforces this too).
      const { data: staff, error } = await sb.from('staff').select('name, email').maybeSingle();
      if (error) throw new Error(error.message);
      if (!staff) return renderNoAccess(session.user.email);
      user = { name: staff.name, email: session.user.email };
      db = new SupabaseDb(sb);
    }
    renderLoading('Loading data…');
    svc = new PpeService(db, user);
    svc.defaultCountry = COUNTRIES[0].code;
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

function authCard(...children) {
  app.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'card login-card' }, children)));
}

function renderLogin() {
  const email = h('input', { class: 'input', type: 'email', name: 'email', autocomplete: 'username', placeholder: 'Email', required: true });
  const password = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'Password', required: true });
  const message = h('p', { class: 'form-error', hidden: true });
  const submit = h('button', { class: 'btn btn-block btn-brand', type: 'submit' }, 'Sign in');
  const showError = text => { message.textContent = text; message.hidden = false; };

  const form = h('form', {
    class: 'form login-form', onsubmit: async e => {
      e.preventDefault();
      message.hidden = true;
      submit.disabled = true;
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
      submit.disabled = false;
      if (error) return showError(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
      boot();
    },
  }, email, password, message, submit,
    h('button', {
      class: 'link-btn center', type: 'button', onclick: async () => {
        const addr = email.value.trim();
        if (!addr) return showError('Type your email address first, then click “Forgot password?” again.');
        const { error } = await sb.auth.resetPasswordForEmail(addr, { redirectTo: location.origin + location.pathname });
        if (error) return showError(error.message);
        toast('If the account exists, an email with a reset link is on its way.', 'success', 6000);
      }
    }, 'Forgot password?'));

  authCard(
    h('span', { class: 'brand-logo lg' }, icon('layers')),
    h('h1', null, cfg.appName),
    h('p', { class: 'muted' }, 'Sign in with the account you received from your administrator.'),
    form);
}

function renderNewPassword() {
  const pw1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password', required: true });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Repeat new password', required: true });
  authCard(
    h('span', { class: 'brand-logo lg' }, icon('layers')),
    h('h1', null, 'Choose a new password'),
    h('form', {
      class: 'form login-form', onsubmit: async e => {
        e.preventDefault();
        if (!(await changePassword(pw1.value, pw2.value))) return;
        passwordRecovery = false;
        history.replaceState(null, '', location.pathname);
        boot();
      },
    }, pw1, pw2, h('button', { class: 'btn btn-block btn-brand', type: 'submit' }, 'Save password')));
}

async function changePassword(pw1, pw2) {
  if (pw1.length < 8) { toast('Use at least 8 characters', 'error'); return false; }
  if (pw1 !== pw2) { toast('The two passwords are not the same', 'error'); return false; }
  const r = await busy('Saving…', async () => {
    const { error } = await sb.auth.updateUser({ password: pw1 });
    if (error) throw new Error(error.message);
  });
  if (r === FAILED) return false;
  toast('Password changed', 'success');
  return true;
}

function renderNoAccess(email) {
  authCard(
    h('span', { class: 'brand-logo lg danger' }, icon('alert')),
    h('h1', null, 'No access yet'),
    h('p', null, `You are signed in as ${email}, but this account has not been added to the staff list. Ask the administrator to add you.`),
    h('button', { class: 'btn btn-block btn-outline', onclick: signOut }, icon('logout'), 'Sign out'));
}

async function signOut() {
  svc = null;
  await sb.auth.signOut();
  location.reload();
}

function renderFatal(e) {
  authCard(
    h('span', { class: 'brand-logo lg danger' }, icon('alert')),
    h('h1', null, 'Something went wrong'),
    h('p', null, errorMessage(e)),
    h('button', { class: 'btn btn-block btn-brand', onclick: () => location.reload() }, icon('refresh'), 'Try again'),
    sb ? h('button', { class: 'btn btn-block btn-outline', onclick: signOut }, icon('logout'), 'Sign out') : null);
}

function startApp() {
  ensureLocation();
  if (state.cartLocationId !== state.locationId) { state.cart = []; state.cartLocationId = state.locationId; }
  state.cart = state.cart.filter(c => svc.product(c.productId));
  savePrefs();
  renderShell();
  if (!svc.locationsIn(state.country).length) {
    toast('Add your first location to get started');
    openLocations();
  }
}

function ensureLocation() {
  const active = svc.locationsIn(state.country);
  if (!active.some(l => l.id === state.locationId)) state.locationId = active.length ? active[0].id : null;
}

const inCountry = p => { const c = svc.personCountry(p); return !c || c === state.country; };

// <option>s for a location <select>, grouped by country when there is more than one.
function locationOptions(locs) {
  if (COUNTRIES.length < 2) return locs.map(l => h('option', { value: String(l.id) }, l.Title));
  return COUNTRIES
    .map(c => [c, locs.filter(l => svc.countryOf(l) === c.code)])
    .filter(([, ls]) => ls.length)
    .map(([c, ls]) => h('optgroup', { label: c.name }, ls.map(l => h('option', { value: String(l.id) }, l.Title))));
}

async function chooseCountry() {
  const code = await pickFrom({
    title: 'Country', iconName: 'globe', selectedId: state.country, placeholder: 'Search…',
    items: COUNTRIES.map(c => ({ id: c.code, label: c.name, sub: svc.locationsIn(c.code).map(l => l.Title).join(', ') || 'No locations yet' })),
  });
  if (!code || code === state.country) return;
  if (state.cart.length && !(await confirmDialog(`Your cart has items from ${svc.locName(state.cartLocationId)}. Switching country will empty the cart.`, { okText: 'Switch country' }))) return;
  state.country = code;
  hist.country = code;
  hist.locationId = 'all';
  state.cart = [];
  ensureLocation();
  state.cartLocationId = state.locationId;
  const person = svc.person(state.personId);
  if (person && !inCountry(person)) state.personId = null;
  savePrefs();
  renderShell();
}

// ---------- shell ----------
function renderShell() {
  const initials = (svc.user.name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  app.replaceChildren(
    h('header', { class: 'app-header' },
      h('div', { class: 'header-inner' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, icon('layers')), h('span', { class: 'brand-name' }, cfg.appName)),
        h('nav', { class: 'tabs' },
          tabButton('dashboard', 'Dashboard', 'chart'),
          tabButton('inventory', 'Inventory', 'package'),
          tabButton('personnel', 'Personnel', 'users'),
          tabButton('history', 'History', 'clock')),
        COUNTRIES.length > 1 ? h('button', { class: 'country-btn', title: `Country: ${countryName(state.country)}`, onclick: chooseCountry },
          icon('globe'), state.country, icon('chevronDown', 'chev')) : null,
        h('button', { class: 'avatar-btn', title: svc.user.name, onclick: openUserMenu }, initials))),
    ...(demo ? [h('div', { class: 'demo-banner' }, 'Demo mode — sample data, stored only in this browser')] : []),
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
  if (!view) return;
  const views = {
    inventory: inventoryView, personnel: personnelView, history: historyView,
    dashboard: () => dashboardView({
      svc, state, COUNTRIES, countryName, periodRange,
      lowStock: Number(cfg.lowStock) >= 0 ? Number(cfg.lowStock) : 2,
      showHandoutHistory,
    }),
  };
  view.replaceChildren((views[state.tab] || views.dashboard)());
}

function openUserMenu() {
  const item = (ic, label, fn) => h('button', { class: 'menu-item', onclick: () => { m.close(); fn(); } }, icon(ic), label);
  const m = openModal({
    title: svc.user.name, iconName: 'user', iconClass: 'c-brand', size: 'sm',
    body: h('div', { class: 'menu' },
      h('div', { class: 'muted small pad-b' }, svc.user.email),
      item('pin', 'Manage locations', openLocations),
      item('refresh', 'Refresh data', refreshAll),
      !demo ? item('edit', 'Change password', openChangePassword) : null,
      demo ? item('refresh', 'Reset demo data', async () => {
        if (!(await confirmDialog('Delete all demo changes and restore the sample data?', { okText: 'Reset', danger: true }))) return;
        svc.db.reset();
        await refreshAll();
      }) : null,
      demo && cfg.supabaseUrl ? item('logout', 'Leave demo', () => { location.href = location.pathname; }) : null,
      !demo ? item('logout', 'Sign out', signOut) : null),
  });
}

function openChangePassword() {
  const pw1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const m = openModal({
    title: 'Change password', iconName: 'edit', iconClass: 'c-brand', size: 'sm', persistent: true,
    body: h('div', { class: 'form' }, field('New password (min. 8 characters)', pw1), field('Repeat new password', pw2)),
    footer: h('button', { class: 'btn btn-block btn-brand', onclick: async () => { if (await changePassword(pw1.value, pw2.value)) m.close(); } }, icon('check'), 'Save'),
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
  const locs = svc.locationsIn(state.country);
  const locSelect = h('select', {
    class: 'location-native', 'aria-label': 'Location', value: state.locationId == null ? '' : String(state.locationId),
    onchange: e => changeLocation(Number(e.target.value), e.target),
  }, locs.length ? locs.map(l => h('option', { value: String(l.id) }, l.Title)) : h('option', { value: '' }, `No locations in ${countryName(state.country)}`));

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
  const hiddenCount = svc.products.length - svc.activeProducts().length;
  if (!hiddenCount) state.showHidden = false;
  const prods = (state.showHidden ? svc.products : svc.activeProducts()).filter(p => !q || p.Title.toLowerCase().includes(q));
  const toggle = hiddenCount ? h('button', {
    class: 'link-btn hidden-toggle', type: 'button',
    onclick: () => { state.showHidden = !state.showHidden; fillProductList(); },
  }, state.showHidden ? 'Hide hidden products' : `Show hidden products (${hiddenCount})`) : null;
  if (!prods.length) {
    list.replaceChildren(q
      ? emptyState('search', 'No matching products', 'Try another search.')
      : emptyState('package', 'No products yet', 'Add your first product with “New product”.'), ...(toggle ? [toggle] : []));
    return;
  }
  list.replaceChildren(...prods.map(productCard), ...(toggle ? [toggle] : []));
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

  const hidden = p.Active === false;
  return h('article', { class: 'card product-card' + (hidden ? ' is-hidden' : ''), 'data-id': p.id },
    h('div', { class: 'pc-top' },
      thumb(p, 'thumb'),
      h('div', { class: 'pc-title' }, h('h3', null, p.Title),
        hidden ? h('span', { class: 'tag tag-grey' }, 'Hidden — open Edit to show it again') : null),
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
      h('button', { class: 'btn btn-dark grow', disabled: hidden, onclick: () => addToCart(p, size, parseInt(qtyInput.value, 10) || 0) }, icon('cart'), 'Add'),
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
  const people = (includeInactive ? svc.personnel : svc.activePersonnel()).filter(inCountry);
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
  const receiptCb = h('input', { type: 'checkbox' });
  const receiptRow = h('label', { class: 'check-row' }, receiptCb, 'Show receipt after saving');
  const sizesBox = h('div', { hidden: true });
  const warningBox = h('div', { hidden: true });
  // Same items (any size) this person received in the last 3 months. null while checking.
  let recent = null, recentCheck = null;
  const checkRecent = p => {
    recent = null;
    warningBox.hidden = true;
    recentCheck = svc.recentHandouts(p.id, state.cart.map(c => c.productId))
      .then(rows => { if (person === p) { recent = rows; drawWarning(); } })
      .catch(e => { if (person === p) { recent = undefined; console.error(e); } });
    return recentCheck;
  };
  const drawWarning = () => {
    warningBox.hidden = !recent || !recent.length;
    if (warningBox.hidden) return;
    warningBox.replaceChildren(recentWarning(person, recent));
  };
  const onPerson = p => {
    person = p;
    sizesBox.replaceChildren(personSizes(p, true));
    sizesBox.hidden = false;
    checkRecent(p);
  };

  const m = openModal({
    title: 'Handout PPE', iconName: 'user', iconClass: 'c-brand', persistent: true,
    body: h('div', { class: 'form' },
      field('Personnel', personButton(null, onPerson)),
      sizesBox,
      warningBox,
      field('Reason', reason),
      field('Notes', notes),
      field('Date', date),
      field('Receiver signature', sig.el),
      receiptRow,
      itemsSummary()),
    footer: h('button', { class: 'btn btn-block btn-green', onclick: submit }, icon('check'), 'Complete handout'),
  });

  async function submit() {
    if (!person) return toast('Select the person receiving the PPE', 'error');
    if (!date.value) return toast('Choose a date', 'error');
    if (sig.isEmpty()) return toast('The receiver needs to sign', 'error');
    if (recent === null) await busy('Checking earlier handouts…', () => recentCheck);
    if (recent === undefined) await busy('Checking earlier handouts…', () => checkRecent(person));
    if (recent && recent.length) {
      const ok = await confirmDialog(recentWarning(person, recent), { title: 'Already received recently', okText: 'Hand out anyway' });
      if (!ok) return;
    }
    const showReceipt = receiptCb.checked;
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
    if (showReceipt) openReceipt(rows, person);
  }
}

// Warning listing the same items a person already received in the last 3 months.
function recentWarning(person, rows) {
  const shown = rows.slice(0, 8);
  return h('div', { class: 'warn-box' },
    h('div', { class: 'warn-title' }, icon('alert'), `${person.Title} already received this in the last 3 months`),
    h('ul', null, shown.map(x => h('li', null,
      h('b', null, `${x.Quantity} × ${x.Title}`), ` (size ${x.Size}) — ${formatDate(x.HandoutDate)}`,
      x.LocationName ? ` at ${x.LocationName}` : '', x.Reason ? h('span', { class: 'muted' }, ` · ${x.Reason}`) : null))),
    rows.length > shown.length ? h('div', { class: 'muted small' }, `…and ${rows.length - shown.length} more`) : null);
}

function openTransfer(cartModal) {
  const fromId = state.locationId;
  const dests = svc.activeLocations().filter(l => l.id !== fromId);
  if (!dests.length) return toast('Add another location first (menu → Manage locations)', 'error');
  const dest = h('select', { class: 'input' }, h('option', { value: '' }, 'Choose destination…'), locationOptions(dests));
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
  const p = product || { Title: '', Sizes: 'S, M, L, XL, 2XL', ImageUrl: '', Active: true };
  const locId = state.locationId;
  const name = h('input', { class: 'input', value: p.Title || '' });
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
  const stockNote = h('input', { class: 'input', list: 'stock-reasons', placeholder: 'e.g. Delivery received', autocomplete: 'off' });

  const m = openModal({
    title: isNew ? 'New product' : 'Edit product', iconName: 'package', iconClass: 'c-brand', persistent: true,
    body: h('div', { class: 'form' },
      field('Product name *', name),
      field('Sizes / variants (comma separated)', sizes),
      field('Image URL', image),
      locId ? h('div', { class: 'field' },
        h('span', { class: 'field-label' }, `Stock at ${svc.locName(locId)}`),
        h('span', { class: 'muted small' }, 'Use this to register deliveries or correct counts. Every change is logged.'),
        stockGrid) : null,
      locId ? field('Reason for stock change', h('div', null, stockNote,
        h('datalist', { id: 'stock-reasons' }, STOCK_REASONS.map(r => h('option', { value: r }))))) : null,
      !isNew && locId ? h('button', {
        class: 'link-btn', type: 'button', onclick: () => {
          m.close();
          showStockHistory(product.id, locId);
        }
      }, `Show stock history of ${product.Title} at ${svc.locName(locId)}`) : null,
      h('label', { class: 'check-row' }, active, 'Active (uncheck to hide the product)')),
    footer: h('button', { class: 'btn btn-block btn-brand', onclick: save }, icon('check'), 'Save'),
  });

  async function save() {
    if (!name.value.trim()) return toast('Product name is required', 'error');
    const changed = Object.entries(stockInputs).some(([s, inp]) =>
      Math.max(0, parseInt(inp.value, 10) || 0) !== (product ? stockQty(product.id, s) : 0));
    if (changed && !stockNote.value.trim()) return toast('Write a reason for the stock change', 'error');
    const r = await busy('Saving…', async () => {
      const saved = await svc.saveProduct({
        id: product && product.id, Title: name.value.trim(),
        Sizes: parseSizes(sizes.value).join(', ') || 'OneSize', ImageUrl: image.value.trim(), Active: active.checked,
      });
      if (locId) {
        for (const [s, inp] of Object.entries(stockInputs)) {
          const qty = Math.max(0, parseInt(inp.value, 10) || 0);
          const old = product ? stockQty(saved.id, s) : 0;
          if (qty !== old) await svc.setStock(saved.id, s, locId, qty, stockNote.value.trim());
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
  const countrySelect = code => h('select', { class: 'input', 'aria-label': 'Country', value: code },
    COUNTRIES.map(c => h('option', { value: c.code }, c.name)));
  const multi = COUNTRIES.length > 1;
  function draw() {
    const sorted = [...svc.locations].sort((a, b) =>
      COUNTRIES.findIndex(c => c.code === svc.countryOf(a)) - COUNTRIES.findIndex(c => c.code === svc.countryOf(b)) || a.Title.localeCompare(b.Title));
    body.replaceChildren(
      ...sorted.map(l => {
        const name = h('input', { class: 'input', value: l.Title, 'aria-label': 'Location name' });
        const country = countrySelect(svc.countryOf(l));
        const act = h('input', { type: 'checkbox', checked: l.Active !== false });
        return h('div', { class: 'loc-row' }, name,
          h('div', { class: 'loc-actions' },
            multi ? country : null,
            h('label', { class: 'check-row' }, act, 'Active'),
            h('button', {
              class: 'btn btn-outline', onclick: async () => {
                if (!name.value.trim()) return toast('Name is required', 'error');
                const r = await busy('Saving…', () => svc.saveLocation({ id: l.id, Title: name.value.trim(), Country: country.value, Active: act.checked }));
                if (r !== FAILED) { toast('Location saved', 'success'); draw(); }
              }
            }, 'Save')));
      }),
      (() => {
        const name = h('input', { class: 'input', placeholder: 'New location name' });
        const country = countrySelect(state.country);
        return h('div', { class: 'loc-row new' }, name,
          h('div', { class: 'loc-actions' },
            multi ? country : null,
            h('button', {
              class: 'btn btn-brand', onclick: async () => {
                if (!name.value.trim()) return toast('Enter a name', 'error');
                const r = await busy('Saving…', () => svc.saveLocation({ Title: name.value.trim(), Country: country.value, Active: true }));
                if (r !== FAILED) { toast('Location added', 'success'); draw(); }
              }
            }, icon('plus'), 'Add')));
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
      personSizes(person),
      h('div', { class: 'filters', id: 'handout-filters' })),
    h('div', { class: 'muted small summary-line', id: 'handout-summary' }),
    h('div', { class: 'handout-list', id: 'handout-list' }));
}

// The person's clothing sizes as small labelled boxes. compact: only the recorded ones (handout form).
function personSizes(p, compact = false) {
  const known = PERSON_SIZES.filter(([key]) => p[key]);
  if (!known.length) {
    return h('div', { class: 'muted small sizes-empty' }, compact
      ? 'No sizes recorded for this person.'
      : 'No sizes recorded yet — use ✎ Edit to add boots, jacket, trouser, vest and gloves sizes.');
  }
  return h('div', { class: 'person-sizes' + (compact ? ' compact' : '') },
    (compact ? known : PERSON_SIZES).map(([key, label]) => h('div', { class: 'size-box' },
      h('span', { class: 'size-label' }, label),
      h('span', { class: 'size-value' + (p[key] ? '' : ' none') }, p[key] || '—'))));
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
      h('button', { class: 'icon-btn c-brand', title: 'Exchange size / delete', 'aria-label': 'Exchange size or delete handout', onclick: () => openHandoutActions(x) }, icon('edit')),
      h('button', { class: 'icon-btn c-blue', title: 'Receipt', 'aria-label': 'Receipt', onclick: () => openReceipt(
        x.BatchId ? state.handouts.filter(y => y.BatchId === x.BatchId) : [x],
        svc.person(x.PersonnelId) || { Title: x.PersonnelName }) }, icon('download'))));
}

// Exchange the size of a handout, or delete it.
function openHandoutActions(x) {
  const product = svc.product(x.ProductId);
  const otherSizes = product ? svc.sizesOf(product).filter(s => s !== x.Size) : [];
  const locs = svc.locationsIn(state.country);
  const defaultLoc = locs.some(l => l.id === state.locationId) ? state.locationId : (locs[0] && locs[0].id);

  let exchange;
  if (!product) {
    exchange = h('p', { class: 'muted small' }, 'This product no longer exists, so the size cannot be exchanged.');
  } else if (!otherSizes.length) {
    exchange = h('p', { class: 'muted small' }, 'This product has only one size.');
  } else if (!locs.length) {
    exchange = h('p', { class: 'muted small' }, `There are no locations in ${countryName(state.country)}.`);
  } else {
    const sizeSel = h('select', { class: 'input' });
    const locSel = h('select', { class: 'input', value: String(defaultLoc), onchange: drawSizes }, locs.map(l => h('option', { value: String(l.id) }, l.Title)));
    const qty = h('input', { class: 'input', type: 'number', min: '1', max: String(x.Quantity), inputmode: 'numeric', value: String(x.Quantity) });
    async function drawSizes() {
      const keep = sizeSel.value;
      sizeSel.replaceChildren(h('option', null, 'Loading stock…'));
      try {
        const stock = await svc.getStock(Number(locSel.value));
        sizeSel.replaceChildren(...otherSizes.map(s => h('option', { value: s }, `${s}   (${stock.get(`${x.ProductId}|${s}`) || 0} in stock)`)));
        if (otherSizes.includes(keep)) sizeSel.value = keep;
      } catch (e) {
        sizeSel.replaceChildren(...otherSizes.map(s => h('option', { value: s }, s)));
      }
    }
    drawSizes();
    exchange = h('div', { class: 'form' },
      field('New size', sizeSel),
      x.Quantity > 1 ? field(`Quantity to exchange (max ${x.Quantity})`, qty) : null,
      field('Exchange at', locSel),
      h('div', { class: 'muted small' }, `Size ${x.Size} goes back into stock and the new size is taken from stock at this location.`),
      h('button', {
        class: 'btn btn-block btn-brand', onclick: async () => {
          const n = x.Quantity > 1 ? parseInt(qty.value, 10) : 1;
          if (!(n >= 1 && n <= x.Quantity)) return toast(`Quantity must be between 1 and ${x.Quantity}`, 'error');
          if (!otherSizes.includes(sizeSel.value)) return toast('Choose the new size', 'error');
          const r = await busy('Exchanging…', () => svc.exchangeHandout(x, sizeSel.value, n, Number(locSel.value)));
          if (r === FAILED) return;
          m.close();
          state.stockLoc = null;
          toast(`Exchanged ${n} × ${x.Title}: ${x.Size} → ${sizeSel.value}`, 'success');
          loadHandouts(state.personId);
        }
      }, icon('swap'), 'Exchange size'));
  }

  const m = openModal({
    title: 'Change handout', iconName: 'edit', iconClass: 'c-brand',
    body: h('div', { class: 'stack' },
      h('div', { class: 'items-summary' },
        h('b', null, `${x.Quantity} × ${x.Title} — size ${x.Size}`),
        h('div', { class: 'muted' }, `${x.PersonnelName || ''} · ${formatDate(x.HandoutDate)}${x.LocationName ? ' · ' + x.LocationName : ''}`)),
      h('h3', { class: 'section-title' }, 'Exchange size'),
      exchange,
      h('h3', { class: 'section-title' }, 'Delete handout'),
      h('button', { class: 'btn btn-block btn-outline c-red', onclick: () => { m.close(); deleteHandout(x); } }, icon('trash'), 'Delete handout')),
  });
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

// Receipt for one handout batch, downloadable as an image (with signature).
function openReceipt(rows, person) {
  const frame = h('iframe', { class: 'receipt-frame', title: 'Receipt preview' });
  frame.srcdoc = buildReceiptHtml({ appName: cfg.appName, person, rows, signatureSrc: rows[0].Signature || '' });
  const fileName = `PPE receipt ${(person.Title || rows[0].PersonnelName || '').replace(/[^\w\- ]+/g, '')} ${(rows[0].HandoutDate || '').slice(0, 10)}.png`;

  async function download() {
    const blob = await receiptImage({ appName: cfg.appName, person, rows });
    const a = h('a', { href: URL.createObjectURL(blob), download: fileName });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  openModal({
    title: 'Receipt', iconName: 'download', iconClass: 'c-blue',
    body: frame,
    footer: h('button', { class: 'btn btn-block btn-blue', onclick: download }, icon('download'), 'Download receipt image'),
  });
}

// ---------- history ----------
// Filtering, sorting and paging happen in the database, so this stays fast with thousands of handouts.
const HIST_PAGE = 50;
const HIST_PERIODS = [
  ['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'],
  ['year', 'This year'], ['lastyear', 'Last year'], ['30', 'Last 30 days'], ['90', 'Last 3 months'], ['365', 'Last 12 months'],
  ['all', 'All time'], ['custom', 'Custom dates…'],
];
const HIST_SORTS = [
  ['date-desc', 'Newest first'], ['date-asc', 'Oldest first'], ['person-asc', 'Person A–Z'],
  ['product-asc', 'Equipment A–Z'], ['location-asc', 'Location A–Z'],
];
const STOCK_SOURCES = ['Manual edit', 'Handout', 'Transfer', 'Handout deleted', 'Size exchange', 'Database edit', 'Other'];
const STOCK_REASONS = ['Delivery received', 'Stock count correction', 'Damaged / discarded', 'Initial stock count', 'Returned by worker'];
const HIST_DEFAULTS = {
  locationId: 'all', productId: 'all', period: 'month', from: '', to: '',
  reason: 'all', search: '', sort: 'date-desc',          // handouts view
  source: 'all', by: '', stockSort: 'desc',              // stock changes view
};
const hist = {
  mode: 'handouts', country: null, ...HIST_DEFAULTS,
  rows: [], total: 0, summary: [], totalsOpen: false, seq: 0,
};

function goToTab(tab) {
  state.tab = tab;
  savePrefs();
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  renderView();
  window.scrollTo(0, 0);
}

// Opens History > Handouts for one product with the Dashboard's country / location / period.
function showHandoutHistory(productId, { country, locationId, period }) {
  Object.assign(hist, HIST_DEFAULTS, { mode: 'handouts', country, locationId: String(locationId), productId: String(productId), period });
  goToTab('history');
}

// Opens History > Stock changes for one product at one location (from the product Edit form).
function showStockHistory(productId, locationId) {
  const loc = svc.location(locationId);
  Object.assign(hist, HIST_DEFAULTS, {
    mode: 'stock', country: loc ? svc.countryOf(loc) : state.country,
    locationId: String(locationId), productId: String(productId), period: 'all',
  });
  goToTab('history');
}

// Start (inclusive) and end (exclusive) of a period, as ISO timestamps. Weeks start on Monday.
function periodRange(key, fromStr, toStr) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const y = now.getFullYear(), m = now.getMonth();
  const r = (from, to) => ({ from: from ? from.toISOString() : null, to: to ? to.toISOString() : null });
  switch (key) {
    case 'week': return r(monday);
    case 'lastweek': return r(addDays(monday, -7), monday);
    case 'month': return r(new Date(y, m, 1));
    case 'lastmonth': return r(new Date(y, m - 1, 1), new Date(y, m, 1));
    case 'year': return r(new Date(y, 0, 1));
    case 'lastyear': return r(new Date(y - 1, 0, 1), new Date(y, 0, 1));
    case '30': return r(addDays(today, -30));
    case '90': return r(new Date(y, m - 3, now.getDate()));
    case '365': return r(addDays(today, -365));
    case 'custom': return r(fromStr ? new Date(fromStr + 'T00:00:00') : null, toStr ? addDays(new Date(toStr + 'T00:00:00'), 1) : null);
    default: return r(null, null);
  }
}

function histFilters() {
  let locationIds = null;
  if (hist.locationId !== 'all') locationIds = [Number(hist.locationId)];
  else if (hist.country !== 'all') locationIds = svc.locations.filter(l => svc.countryOf(l) === hist.country).map(l => l.id);
  const common = {
    locationIds,
    productId: hist.productId === 'all' ? null : Number(hist.productId),
    ...periodRange(hist.period, hist.from, hist.to),
  };
  if (hist.mode === 'stock') {
    return { ...common, source: hist.source === 'all' ? null : hist.source, search: hist.by.trim() || null, asc: hist.stockSort === 'asc' };
  }
  const [sort, dir] = hist.sort.split('-');
  return { ...common, reason: hist.reason === 'all' ? null : hist.reason, search: hist.search.trim() || null, sort, asc: dir === 'asc' };
}

const queryHistory = f => (hist.mode === 'stock' ? svc.queryStockLog(f) : svc.queryHandouts(f));

function historyView() {
  if (hist.country === null) hist.country = state.country;
  queueMicrotask(() => { renderHistoryFilters(); reloadHistory(); });
  const modeBtn = (mode, label) => h('button', {
    class: 'seg-btn' + (hist.mode === mode ? ' active' : ''), type: 'button',
    onclick: () => { if (hist.mode !== mode) { hist.mode = mode; renderView(); } },
  }, label);
  return h('div', { class: 'history' },
    h('div', { class: 'segmented' }, modeBtn('handouts', 'Handouts'), modeBtn('stock', 'Stock changes')),
    h('section', { class: 'card' },
      h('div', { class: 'hist-filters', id: 'hist-filters' }),
      h('div', { class: 'hist-actions' },
        h('div', { class: 'muted small', id: 'hist-count' }),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-outline', onclick: resetHistoryFilters }, icon('refresh'), h('span', { class: 'hide-sm' }, 'Reset')),
          h('button', { class: 'btn btn-outline', onclick: exportHistory }, icon('download'), 'Export CSV')))),
    hist.mode === 'handouts' ? h('details', {
      class: 'card hist-totals', id: 'hist-totals', open: hist.totalsOpen,
      ontoggle: e => { hist.totalsOpen = e.target.open; },
    }, h('summary', null, 'Totals by equipment'), h('div', { id: 'hist-totals-body' })) : null,
    h('div', { class: 'hist-list' + (hist.mode === 'stock' ? ' stock-list' : ''), id: 'hist-list' }));
}

function renderHistoryFilters() {
  const box = document.getElementById('hist-filters');
  if (!box) return;
  const select = (key, label, options, after) => field(label, h('select', {
    class: 'input', value: String(hist[key]),
    onchange: e => { hist[key] = e.target.value; if (after) after(); renderHistoryFilters(); reloadHistory(); },
  }, options.map(([v, l]) => h('option', { value: String(v) }, l))));

  const locs = svc.locations.filter(l => hist.country === 'all' || svc.countryOf(l) === hist.country);
  if (hist.locationId !== 'all' && !locs.some(l => String(l.id) === String(hist.locationId))) hist.locationId = 'all';
  let searchTimer;
  const searchField = (key, label) => field(label, h('input', {
    class: 'input', type: 'search', placeholder: 'Search name…', value: hist[key],
    oninput: e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { hist[key] = e.target.value; reloadHistory(); }, 350); },
  }));
  const stock = hist.mode === 'stock';

  box.replaceChildren(...[
    COUNTRIES.length > 1 ? select('country', 'Country', [['all', 'All countries'], ...COUNTRIES.map(c => [c.code, c.name])], () => { hist.locationId = 'all'; }) : null,
    select('locationId', 'Location', [['all', 'All locations'], ...locs.map(l => [l.id, l.Title + (l.Active === false ? ' (inactive)' : '')])]),
    select('productId', 'Equipment', [['all', 'All equipment'], ...svc.products.map(p => [p.id, p.Title])]),
    stock
      ? select('source', 'Type of change', [['all', 'All changes'], ...STOCK_SOURCES.map(s => [s, s])])
      : select('reason', 'Reason', [['all', 'All reasons'], ...REASONS.map(r => [r, r])]),
    select('period', 'Period', HIST_PERIODS),
    hist.period === 'custom' ? field('From', h('input', { class: 'input', type: 'date', value: hist.from, onchange: e => { hist.from = e.target.value; reloadHistory(); } })) : null,
    hist.period === 'custom' ? field('To', h('input', { class: 'input', type: 'date', value: hist.to, onchange: e => { hist.to = e.target.value; reloadHistory(); } })) : null,
    stock ? searchField('by', 'Changed by') : searchField('search', 'Person'),
    stock
      ? select('stockSort', 'Sort by', [['desc', 'Newest first'], ['asc', 'Oldest first']])
      : select('sort', 'Sort by', HIST_SORTS),
  ].filter(Boolean));
}

function resetHistoryFilters() {
  Object.assign(hist, HIST_DEFAULTS, { country: state.country });
  renderHistoryFilters();
  reloadHistory();
}

async function reloadHistory() {
  const seq = ++hist.seq;
  const list = document.getElementById('hist-list');
  if (!list) return;
  list.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Loading history…'));
  const f = histFilters();
  try {
    const [page, summary] = await Promise.all([
      queryHistory({ ...f, offset: 0, limit: HIST_PAGE }),
      hist.mode === 'handouts' ? svc.handoutSummary(f) : [],
    ]);
    if (seq !== hist.seq) return; // a newer search started meanwhile
    hist.rows = page.rows;
    hist.total = page.total;
    hist.summary = summary;
  } catch (e) {
    if (seq === hist.seq) list.replaceChildren(errorBox(e, reloadHistory));
    return;
  }
  fillHistory();
}

async function loadMoreHistory(btn) {
  const seq = hist.seq;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const page = await queryHistory({ ...histFilters(), offset: hist.rows.length, limit: HIST_PAGE });
    if (seq !== hist.seq) return;
    hist.rows = hist.rows.concat(page.rows);
    hist.total = page.total;
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
  fillHistory();
}

function fillHistory() {
  const list = document.getElementById('hist-list');
  if (!list) return;
  const stock = hist.mode === 'stock';
  const items = hist.summary.reduce((a, s) => a + Number(s.Quantity), 0);
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  document.getElementById('hist-count').textContent = !hist.total ? ''
    : stock ? plural(hist.total, 'stock change')
    : `${plural(hist.total, 'handout record')} · ${plural(items, 'item')}`;
  if (!stock) fillHistoryTotals();

  if (!hist.rows.length) {
    list.replaceChildren(emptyState('clock', stock ? 'No stock changes' : 'No handouts', 'Nothing matches these filters. Try a longer period or “All”.'));
    return;
  }
  const head = stock
    ? h('div', { class: 'hist-row stock-row hist-head' },
        h('span', null, 'Date'), h('span', null, 'Equipment'), h('span', null, 'Location'),
        h('span', null, 'Change'), h('span', null, 'Type'), h('span', null, 'Changed by'))
    : h('div', { class: 'hist-row hist-head' },
        h('span', null, 'Date'), h('span', null, 'Person'), h('span', null, 'Equipment'),
        h('span', null, 'Qty'), h('span', null, 'Location'), h('span', null, 'Reason'));
  const more = hist.rows.length < hist.total
    ? [h('button', { class: 'btn btn-block btn-outline load-more', onclick: e => loadMoreHistory(e.currentTarget) },
        `Load more (${(hist.total - hist.rows.length).toLocaleString()} more)`)]
    : [];
  list.replaceChildren(head, ...hist.rows.map(stock ? stockLogRow : historyRow), ...more);
}

function formatDateTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '—' : `${formatDate(iso)} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function stockLogRow(x) {
  const loc = svc.location(x.LocationId);
  const ch = Number(x.Change);
  return h('div', { class: 'hist-row stock-row' },
    h('span', { class: 'hr-date' }, formatDateTime(x.ChangedAt)),
    h('span', { class: 'hr-product' }, x.ProductTitle || '—', h('span', { class: 'muted' }, ` · ${x.Size}`)),
    h('span', { class: 'hr-loc' }, x.LocationName || '—', loc && COUNTRIES.length > 1 ? h('span', { class: 'muted' }, ` · ${svc.countryOf(loc)}`) : null),
    h('span', { class: 'hr-change' }, `${x.OldQuantity} → ${x.NewQuantity} `,
      h('span', { class: 'delta ' + (ch >= 0 ? 'up' : 'down') }, (ch > 0 ? '+' : ch < 0 ? '−' : '') + Math.abs(ch))),
    h('span', { class: 'hr-type' }, h('b', null, x.Source), x.Note ? h('span', { class: 'muted' }, ` · ${x.Note}`) : null),
    h('span', { class: 'hr-by muted' }, x.ChangedBy || '—'));
}

function fillHistoryTotals() {
  const body = document.getElementById('hist-totals-body');
  if (!body) return;
  if (!hist.summary.length) { body.replaceChildren(h('p', { class: 'muted small' }, 'No handouts in this selection.')); return; }
  const byProduct = new Map();
  for (const s of hist.summary) {
    if (!byProduct.has(s.Title)) byProduct.set(s.Title, []);
    byProduct.get(s.Title).push(s);
  }
  const sizeOrder = title => { const p = svc.products.find(x => x.Title === title); return p ? svc.sizesOf(p) : []; };
  body.replaceChildren(h('div', { class: 'totals-grid' },
    [...byProduct.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([title, sizes]) => {
      const order = sizeOrder(title);
      const rank = s => { const i = order.indexOf(s); return i < 0 ? 999 : i; };
      sizes.sort((a, b) => rank(a.Size) - rank(b.Size) || String(a.Size).localeCompare(String(b.Size)));
      const total = sizes.reduce((a, s) => a + Number(s.Quantity), 0);
      return h('div', { class: 'total-item' },
        h('div', { class: 'total-head' }, h('span', null, title), h('b', null, total.toLocaleString())),
        h('div', { class: 'muted small' }, sizes.map(s => `${s.Size}: ${Number(s.Quantity).toLocaleString()}`).join(' · ')));
    })));
}

function historyRow(x) {
  const loc = svc.location(x.LocationId);
  return h('button', { class: 'hist-row', type: 'button', title: 'Show receipt', onclick: () => openHistoryReceipt(x) },
    h('span', { class: 'hr-date' }, formatDate(x.HandoutDate)),
    h('span', { class: 'hr-person' }, x.PersonnelName || '—'),
    h('span', { class: 'hr-product' }, x.Title, h('span', { class: 'muted' }, ` · ${x.Size}`)),
    h('span', { class: 'hr-qty' }, `× ${x.Quantity}`),
    h('span', { class: 'hr-loc' }, x.LocationName || '—', loc && COUNTRIES.length > 1 ? h('span', { class: 'muted' }, ` · ${svc.countryOf(loc)}`) : null),
    h('span', { class: 'hr-reason muted' }, x.Reason || ''));
}

async function openHistoryReceipt(x) {
  const rows = await busy('Loading receipt…', () => svc.getHandoutBatch(x.BatchId));
  if (rows === FAILED || !rows.length) return;
  openReceipt(rows, svc.person(x.PersonnelId) || { Title: x.PersonnelName });
}

// Exports every row matching the filters (not just the loaded page). Semicolons so Excel in DK/SE opens it directly.
async function exportHistory() {
  const f = histFilters();
  const stock = hist.mode === 'stock';
  const rows = await busy('Preparing export…', async () => {
    let all = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await queryHistory({ ...f, offset, limit: 1000 });
      all = all.concat(page.rows);
      if (!page.rows.length || all.length >= page.total) return all;
    }
  });
  if (rows === FAILED) return;
  if (!rows.length) return toast('Nothing to export', 'error');
  const cell = v => { const s = String(v == null ? '' : v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const day = iso => (iso ? new Date(iso).toLocaleDateString('sv-SE') : '');
  const country = id => { const loc = svc.location(id); return loc ? countryName(svc.countryOf(loc)) : ''; };
  const header = stock
    ? ['Date', 'Time', 'Equipment', 'Size', 'Location', 'Country', 'Old quantity', 'New quantity', 'Change', 'Type', 'Note', 'Changed by']
    : ['Date', 'Person', 'Equipment', 'Size', 'Quantity', 'Location', 'Country', 'Reason', 'Notes', 'Handed out by'];
  const lines = rows.map(x => (stock
    ? [day(x.ChangedAt), new Date(x.ChangedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }), x.ProductTitle, x.Size,
       x.LocationName, country(x.LocationId), x.OldQuantity, x.NewQuantity, x.Change, x.Source, x.Note, x.ChangedBy]
    : [day(x.HandoutDate), x.PersonnelName, x.Title, x.Size, x.Quantity,
       x.LocationName, country(x.LocationId), x.Reason, x.Notes, x.HandedOutBy]
  ).map(cell).join(';'));
  const blob = new Blob(['﻿' + [header.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `PPE ${stock ? 'stock changes' : 'handouts'} ${todayISO()}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Exported ${rows.length.toLocaleString()} rows`, 'success');
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
      h('option', { value: '' }, '—'), locationOptions(svc.locations));
    const active = h('input', { type: 'checkbox', checked: p.Active !== false });
    const sizeInputs = PERSON_SIZES.map(([key, label, placeholder]) =>
      [key, label, h('input', { class: 'input', value: p[key] || '', placeholder, autocomplete: 'off' })]);
    let saved = null;

    const m = openModal({
      title: isNew ? 'Add person' : 'Edit person', iconName: isNew ? 'userPlus' : 'user', iconClass: 'c-brand', persistent: true,
      body: h('div', { class: 'form' },
        field('Full name *', name),
        field('Email', email),
        field('Phone', phone),
        field('Company', company),
        field('Employee no.', empNo),
        field('Site / location', loc),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, 'Sizes'),
          h('div', { class: 'size-inputs' }, sizeInputs.map(([, label, inp]) => h('label', { class: 'stock-cell' }, h('span', null, label), inp)))),
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
            ...Object.fromEntries(sizeInputs.map(([key, , inp]) => [key, inp.value.trim()])),
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
