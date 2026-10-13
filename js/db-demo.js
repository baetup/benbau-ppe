// Demo data store with the same interface as SupabaseDb, kept in localStorage.
// The stock operations mirror the database functions in supabase/setup.sql.
const KEY = 'ppe-demo-db-v12';

export class DemoDb {
  constructor(user) {
    this.user = user;
    // Remove demo data saved by older versions (frees browser storage).
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('ppe-demo-db-') && k !== KEY) localStorage.removeItem(k);
    } catch { /* storage unavailable */ }
    this.data = read() || seed();
    write(this.data);
  }

  rows(table) {
    return (this.data.tables[table] = this.data.tables[table] || []);
  }

  find(table, id) {
    return this.rows(table).find(r => r.id === id);
  }

  async list(table, filter) {
    await tick();
    let rows = this.rows(table);
    if (filter) rows = rows.filter(r => Object.entries(filter).every(([k, v]) => r[k] === v));
    return clone(rows);
  }

  async create(table, fields) {
    await tick();
    const row = { ...clean(fields), id: ++this.data.nextId };
    this.rows(table).push(row);
    write(this.data);
    return clone(row);
  }

  async update(table, id, fields) {
    await tick();
    const row = this.find(table, id);
    if (!row) throw new Error('Item not found');
    Object.assign(row, clean(fields));
    write(this.data);
    return clone(row);
  }

  async remove(table, id) {
    await tick();
    this.data.tables[table] = this.rows(table).filter(r => r.id !== id);
    write(this.data);
  }

  // ---------- demo users & roles (mirror of can_operate / in_my_country in setup.sql) ----------
  staffUser(email) {
    const s = this.rows('staff').find(x => x.Email === email) || this.rows('staff').find(x => x.Role === 'admin');
    return { name: s.Name, email: s.Email, role: s.Role, country: s.Country, locationId: s.LocationId };
  }

  canOperate(locationId) {
    const u = this.user;
    if (!u || u.role === 'admin') return true;
    const loc = this.find('locations', locationId);
    if (!loc) return false;
    return u.role === 'lead' ? loc.Country === u.country : loc.id === u.locationId;
  }

  mustOperate(locationId, message) {
    if (!this.canOperate(locationId)) throw new Error(message);
  }

  async listStaff() { await tick(); return clone(this.rows('staff')).sort((a, b) => a.Name.localeCompare(b.Name)); }

  async saveStaff(fields, originalEmail) {
    await tick();
    if (this.user.role !== 'admin') throw new Error('Only admins can manage users');
    const row = { Email: fields.Email, Name: fields.Name, Role: fields.Role, Country: fields.Country || null, LocationId: fields.LocationId || null };
    if (originalEmail) {
      const i = this.rows('staff').findIndex(x => x.Email === originalEmail);
      if (i >= 0) this.rows('staff')[i] = row;
    } else {
      if (this.rows('staff').some(x => x.Email.toLowerCase() === row.Email.toLowerCase())) throw new Error('This email is already on the staff list');
      this.rows('staff').push(row);
    }
    write(this.data);
  }

  async deleteStaff(email) {
    await tick();
    this.data.tables.staff = this.rows('staff').filter(x => x.Email !== email);
    write(this.data);
  }

  async setStock(productId, size, locationId, quantity, note, returned) {
    this.mustOperate(locationId, 'You can only change stock at your own location');
    this.checkProductCountry(productId, locationId);
    return this.transaction(() => {
      this.ctx = { source: 'Manual edit', note };
      const row = this.stockRow(productId, size, locationId);
      this.setQuantity(row, quantity);
      row.ReturnedQuantity = Math.max(0, Math.min(returned == null ? (row.ReturnedQuantity || 0) : returned, row.Quantity));
    });
  }

  async recordReturn(personId, locationId, items, note) {
    this.mustOperate(locationId, 'You can only receive returned PPE at your own location');
    return this.transaction(() => {
      const person = this.find('personnel', personId);
      const loc = this.find('locations', locationId);
      for (const it of items) {
        if (!(it.qty > 0)) continue;
        const h = this.find('handouts', it.handoutId);
        if (!h || h.PersonnelId !== personId) throw new Error('Handout not found for this worker');
        const open = h.Quantity - (h.ReturnedQuantity || 0);
        if (it.qty > open) throw new Error(`${h.Title} (${h.Size}): only ${open} not yet returned`);
        h.ReturnedQuantity = (h.ReturnedQuantity || 0) + it.qty;
        const toStock = it.toStock !== false;
        if (toStock && h.ProductId) {
          this.ctx = { source: 'Return', note: `From ${h.PersonnelName}${note ? ': ' + note : ''}` };
          this.adjust(h.ProductId, h.Size, locationId, it.qty, true, it.qty);
        }
        this.rows('returns').push({
          id: ++this.data.nextId, ReturnDate: new Date().toISOString(), HandoutId: h.id, PersonnelId: personId,
          PersonnelName: h.PersonnelName, Company: person && person.Company, ProductId: h.ProductId, Title: h.Title, Size: h.Size,
          Quantity: it.qty, LocationId: loc.id, LocationName: loc.Title, ToStock: toStock, Note: note || null,
          ReceivedBy: this.user.name, ReceivedByEmail: this.user.email,
        });
      }
    });
  }

  async stockUsage(locationId, from) {
    await tick();
    const logs = this.rows('stock_log').filter(r => r.LocationId === locationId);
    const used = new Map();
    for (const r of logs) {
      if (r.ChangedAt < from || !(r.Change < 0) || !['Handout', 'Manual edit'].includes(r.Source)) continue;
      const k = `${r.ProductId}|${r.Size}`;
      used.set(k, (used.get(k) || 0) - r.Change);
    }
    const first = logs.reduce((a, r) => (!a || r.ChangedAt < a ? r.ChangedAt : a), null);
    return { first_log: first, rows: [...used].map(([k, v]) => { const [pid, size] = k.split('|'); return { product_id: Number(pid), size, used: v }; }) };
  }

  async outstandingPpe(country, status, excludeCompany) {
    await tick();
    const out = new Map();
    for (const p of this.rows('personnel')) {
      const loc = this.find('locations', p.LocationId);
      if (!loc || (country && (loc.Country || 'DK') !== country)) continue;
      if (excludeCompany && (p.Company || '').trim().toLowerCase() === excludeCompany.toLowerCase()) continue;
      const st = p.Active === false ? 'lost' : p.InRotation ? 'rotation' : 'active';
      if (st !== status) continue;
      for (const h of this.rows('handouts')) {
        if (h.PersonnelId !== p.id) continue;
        const prod = this.find('products', h.ProductId);
        if (prod && prod.Returnable === false) continue;
        const open = h.Quantity - (h.ReturnedQuantity || 0);
        if (open <= 0) continue;
        const k = `${p.id}|${h.ProductId}|${h.Size}`;
        const r = out.get(k) || { personnel_id: p.id, personnel_name: p.Title, company: (p.Company || '').trim() || '(no company)', location_name: loc.Title, product_id: h.ProductId, title: h.Title, size: h.Size, quantity: 0, last_handout: h.HandoutDate };
        r.quantity += open;
        if (h.HandoutDate > r.last_handout) r.last_handout = h.HandoutDate;
        out.set(k, r);
      }
    }
    return [...out.values()].sort((a, b) => a.company.localeCompare(b.company) || a.personnel_name.localeCompare(b.personnel_name));
  }

  async queryStockLog(f) {
    await tick();
    const q = (f.search || '').toLowerCase();
    const rows = this.rows('stock_log').filter(r =>
      (!f.locationIds || f.locationIds.includes(r.LocationId)) &&
      (!f.productId || r.ProductId === f.productId) &&
      (!f.source || r.Source === f.source) &&
      (!q || (r.ChangedBy || '').toLowerCase().includes(q)) &&
      (!f.from || r.ChangedAt >= f.from) &&
      (!f.to || r.ChangedAt < f.to))
      .sort((a, b) => (a.ChangedAt.localeCompare(b.ChangedAt) || a.id - b.id) * (f.asc ? 1 : -1));
    return { rows: clone(rows.slice(f.offset, f.offset + f.limit)), total: rows.length };
  }

  async handout({ personId, locationId, items, reason, notes, date, signature }) {
    this.mustOperate(locationId, 'You can only hand out PPE at your own location');
    return this.transaction(() => {
      const person = this.find('personnel', personId);
      const loc = this.find('locations', locationId);
      if (!person) throw new Error('Person not found');
      this.ctx = { source: 'Handout', note: `To ${person.Title}` };
      const batchId = `demo-${Date.now()}`;
      return items.map(it => {
        const p = this.find('products', it.productId);
        const ret = Math.max(0, Math.min(it.returned || 0, it.qty));
        this.ctx = { source: 'Handout', note: `To ${person.Title}${ret ? ` (${ret} from returned stock)` : ''}` };
        this.adjust(it.productId, it.size, locationId, -it.qty, false, -ret);
        const row = {
          id: ++this.data.nextId, BatchId: batchId, PersonnelId: person.id, PersonnelName: person.Title,
          ProductId: p.id, Title: p.Title, Size: it.size, Quantity: it.qty, LocationId: loc.id, LocationName: loc.Title,
          Reason: reason, Notes: notes, HandoutDate: date, HandedOutBy: this.user.name, HandedOutByEmail: this.user.email, Signature: signature,
          ReturnedQuantity: 0, FromReturned: ret,
        };
        this.rows('handouts').push(row);
        return clone(row);
      });
    });
  }

  async transfer({ fromId, toId, items, reason }) {
    return this.transaction(() => {
      const from = this.find('locations', fromId), to = this.find('locations', toId);
      if (from.Country !== to.Country) throw new Error('Transfers between countries are not allowed');
      this.mustOperate(fromId, 'You can only transfer from your own location');
      for (const it of items) {
        const p = this.find('products', it.productId);
        const why = reason ? `: ${reason}` : '';
        this.ctx = { source: 'Transfer', note: `To ${to.Title}${why}` };
        this.adjust(it.productId, it.size, fromId, -it.qty, false);
        this.ctx = { source: 'Transfer', note: `From ${from.Title}${why}` };
        this.adjust(it.productId, it.size, toId, it.qty, true);
        this.rows('transfers').push({
          id: ++this.data.nextId, ProductId: p.id, Title: p.Title, Size: it.size, Quantity: it.qty,
          FromLocationId: from.id, FromLocationName: from.Title, ToLocationId: to.id, ToLocationName: to.Title,
          Reason: reason, TransferDate: new Date().toISOString(), TransferredBy: this.user.name,
        });
      }
    });
  }

  filterHandouts(f) {
    const q = (f.search || '').toLowerCase();
    return this.rows('handouts').filter(h =>
      (!f.locationIds || f.locationIds.includes(h.LocationId)) &&
      (!f.productId || h.ProductId === f.productId) &&
      (!f.reason || h.Reason === f.reason) &&
      (!q || (h.PersonnelName || '').toLowerCase().includes(q)) &&
      (!f.from || h.HandoutDate >= f.from) &&
      (!f.to || h.HandoutDate < f.to));
  }

  async queryHandouts(f) {
    await tick();
    const key = { date: 'HandoutDate', person: 'PersonnelName', product: 'Title', location: 'LocationName' }[f.sort] || 'HandoutDate';
    const rows = this.filterHandouts(f).sort((a, b) =>
      (String(a[key] || '').localeCompare(String(b[key] || '')) * (f.asc ? 1 : -1)) ||
      String(b.HandoutDate).localeCompare(String(a.HandoutDate)) || b.id - a.id);
    return {
      rows: clone(rows.slice(f.offset, f.offset + f.limit).map(({ Signature, ...rest }) => rest)),
      total: rows.length,
    };
  }

  async handoutSummary(f) {
    await tick();
    const m = new Map();
    for (const h of this.filterHandouts(f)) {
      const k = `${h.Title}|${h.Size}`;
      const s = m.get(k) || { Title: h.Title, Size: h.Size, Quantity: 0, Records: 0 };
      s.Quantity += h.Quantity; s.Records += 1;
      m.set(k, s);
    }
    return [...m.values()];
  }

  // ---------- incidents ----------
  async queryIncidents(f) {
    await tick();
    const q = (f.search || '').toLowerCase();
    const rows = this.rows('incidents').filter(r =>
      (!f.locationIds || f.locationIds.includes(r.LocationId)) &&
      (!f.personId || r.PersonnelId === f.personId) &&
      (!f.type || r.Type === f.type) &&
      (!f.action || r.ActionTaken === f.action) &&
      (!f.branch || r.Branch === f.branch) &&
      (!f.status || r.Status === f.status) &&
      (!q || (r.PersonnelName || '').toLowerCase().includes(q)) &&
      (!f.from || r.IncidentDate >= f.from) &&
      (!f.to || r.IncidentDate < f.to))
      .sort((a, b) => b.IncidentDate.localeCompare(a.IncidentDate) || b.id - a.id);
    return { rows: clone(rows.slice(f.offset, f.offset + f.limit).map(({ Signature, ...rest }) => rest)), total: rows.length };
  }

  async getIncident(id) {
    await tick();
    const r = this.find('incidents', id);
    if (!r) throw new Error('Incident not found');
    return clone(r);
  }

  // Demo: files are kept as data URLs in the browser.
  async uploadEvidence(path, blob) {
    const url = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(blob); });
    this.rows('evidence_files').push({ path, url });
    write(this.data);
  }

  async evidenceUrls(paths) {
    return new Map(this.rows('evidence_files').filter(f => paths.includes(f.path)).map(f => [f.path, f.url]));
  }

  async removeEvidence(paths) {
    this.data.tables.evidence_files = this.rows('evidence_files').filter(f => !paths.includes(f.path));
    write(this.data);
  }

  async dashboardStats(f) {
    await tick();
    const rows = this.filterHandouts({ locationIds: f.locationIds, from: f.from, to: f.to });
    const group = (keyOf, make) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyOf(r);
        const g = m.get(k) || make(r);
        g.qty += r.Quantity;
        m.set(k, g);
      }
      return [...m.values()].sort((a, b) => b.qty - a.qty);
    };
    const bucketOf = iso => {
      const d = new Date(iso);
      const start = f.bucket === 'week'
        ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
        : new Date(d.getFullYear(), d.getMonth(), 1);
      return start.toLocaleDateString('sv-SE');
    };
    return {
      items: rows.reduce((a, r) => a + r.Quantity, 0),
      records: rows.length,
      people: new Set(rows.map(r => r.PersonnelId)).size,
      by_period: group(r => bucketOf(r.HandoutDate), r => ({ bucket: bucketOf(r.HandoutDate), qty: 0 })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
      by_product: group(r => r.ProductId, r => ({ product_id: r.ProductId, title: r.Title, qty: 0 })),
      by_location: group(r => r.LocationId, r => ({ location_id: r.LocationId, location_name: r.LocationName, qty: 0 })),
      by_reason: group(r => r.Reason || '—', r => ({ reason: r.Reason || '—', qty: 0 })),
    };
  }

  async recentHandouts(personId, productIds, since) {
    await tick();
    return clone(this.rows('handouts')
      .filter(h => h.PersonnelId === personId && productIds.includes(h.ProductId) && h.HandoutDate >= since)
      .sort((a, b) => b.HandoutDate.localeCompare(a.HandoutDate))
      .map(({ Signature, ...rest }) => rest));
  }

  async getHandoutBatch(batchId) {
    await tick();
    return clone(this.rows('handouts').filter(h => h.BatchId === batchId));
  }

  async exchangeHandout(id, newSize, quantity, locationId) {
    this.mustOperate(locationId, 'You can only exchange sizes at your own location');
    return this.transaction(() => {
      const h = this.find('handouts', id);
      if (!h) throw new Error('Handout not found');
      if (!newSize || newSize === h.Size) throw new Error('Choose a different size');
      const open = h.Quantity - (h.ReturnedQuantity || 0);
      if (!(quantity >= 1 && quantity <= open)) throw new Error(`Quantity must be between 1 and ${open} (items already returned cannot be exchanged)`);
      const loc = this.find('locations', locationId);
      this.ctx = { source: 'Size exchange', note: `${h.PersonnelName}: ${h.Size} → ${newSize}` };
      this.adjust(h.ProductId, newSize, locationId, -quantity, false);
      this.adjust(h.ProductId, h.Size, locationId, quantity, true);
      const note = `Size exchanged ${h.Size} → ${newSize} (${quantity} pcs) at ${loc.Title} on ${new Date().toISOString().slice(0, 10)} by ${this.user.name}`;
      const notes = [h.Notes, note].filter(Boolean).join('\n');
      if (quantity === h.Quantity) {
        Object.assign(h, { Size: newSize, Notes: notes });
      } else {
        h.Quantity -= quantity;
        h.FromReturned = Math.min(h.FromReturned || 0, h.Quantity);
        this.rows('handouts').push({ ...h, id: ++this.data.nextId, Size: newSize, Quantity: quantity, Notes: notes, ReturnedQuantity: 0, FromReturned: 0 });
      }
    });
  }

  async deleteHandout(id, returnToStock) {
    return this.transaction(() => {
      const h = this.find('handouts', id);
      if (!h) return;
      if (h.LocationId) this.mustOperate(h.LocationId, 'You can only change handouts made at your own location');
      this.ctx = { source: 'Handout deleted', note: `Returned from ${h.PersonnelName || 'unknown'}` };
      const open = h.Quantity - (h.ReturnedQuantity || 0);
      if (returnToStock && h.LocationId && h.ProductId && open > 0) this.adjust(h.ProductId, h.Size, h.LocationId, open, true, Math.min(h.FromReturned || 0, open));
      this.data.tables.handouts = this.rows('handouts').filter(r => r.id !== id);
    });
  }

  // Runs fn; on error, restores the data as it was (all-or-nothing, like the database functions).
  async transaction(fn) {
    await tick();
    const snapshot = clone(this.data);
    try {
      const result = fn();
      write(this.data);
      return result;
    } catch (e) {
      this.data = snapshot;
      throw e;
    }
  }

  stockRow(productId, size, locationId) {
    let row = this.rows('stock').find(r => r.ProductId === productId && r.Size === size && r.LocationId === locationId);
    if (!row) {
      row = { id: ++this.data.nextId, ProductId: productId, Size: size, LocationId: locationId, Quantity: 0, ReturnedQuantity: 0 };
      this.rows('stock').push(row);
    }
    return row;
  }

  // Mirror of check_product_country in setup.sql.
  checkProductCountry(productId, locationId) {
    const p = this.find('products', productId), l = this.find('locations', locationId);
    if (p && l && p.Country && l.Country && p.Country !== l.Country) throw new Error(`${p.Title} is a product for ${p.Country} and cannot be used at ${l.Title}.`);
  }

  adjust(productId, size, locationId, delta, allowNegative, returnedDelta = 0) {
    this.checkProductCountry(productId, locationId);
    const row = this.stockRow(productId, size, locationId);
    const label = `${this.find('products', productId).Title} (${size}) at ${this.find('locations', locationId).Title}`;
    if (!allowNegative && row.Quantity + delta < 0) throw new Error(`Not enough stock of ${label}. Available: ${row.Quantity}.`);
    const ret = row.ReturnedQuantity || 0;
    if (returnedDelta < 0 && ret + returnedDelta < 0) throw new Error(`Not enough returned stock of ${label}. Returned available: ${ret}.`);
    this.setQuantity(row, row.Quantity + delta);
    row.ReturnedQuantity = Math.max(0, Math.min(ret + returnedDelta, row.Quantity));
  }

  // Changes a stock row and writes the stock log entry (like the database trigger).
  setQuantity(row, quantity) {
    const old = row.Quantity;
    if (old === quantity) return;
    row.Quantity = quantity;
    const ctx = this.ctx || {};
    this.rows('stock_log').push({
      id: ++this.data.nextId, ChangedAt: new Date().toISOString(),
      ProductId: row.ProductId, ProductTitle: (this.find('products', row.ProductId) || {}).Title, Size: row.Size,
      LocationId: row.LocationId, LocationName: (this.find('locations', row.LocationId) || {}).Title,
      OldQuantity: old, NewQuantity: quantity, Change: quantity - old,
      Source: ctx.source || 'Other', Note: ctx.note || null, ChangedBy: this.user.name, ChangedByEmail: this.user.email,
    });
  }

  reset() {
    this.data = seed();
    write(this.data);
  }
}

const tick = () => new Promise(r => setTimeout(r, 60));
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (k !== 'id' && v !== undefined) out[k] = v;
  return out;
}

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

function write(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { console.warn('Demo data could not be saved', e); }
}

function seed() {
  let id = 0;
  const t = {
    locations: [], products: [], stock: [], personnel: [], handouts: [], transfers: [], stock_log: [],
    incidents: [], evidence_files: [], returns: [], staff: [],
  };
  const add = (table, f) => { const row = { ...f, id: ++id }; t[table].push(row); return row; };
  let n = 7;
  const rnd = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  const pick = list => list[Math.floor(rnd() * list.length)];
  const day = 86400000;
  const iso = ms => new Date(ms).toISOString();
  const now = Date.now();

  // ----- locations -----
  const locs = [['CPH', 'DK'], ['FRD2A', 'DK'], ['Kungsgarden', 'SE'], ['Ersbo', 'SE'], ['Stackbo', 'SE']]
    .map(([Title, Country]) => add('locations', { Title, Country, Active: true }));
  const dk = locs.filter(l => l.Country === 'DK'), se = locs.filter(l => l.Country === 'SE');

  // ----- demo users (menu → Switch demo user) -----
  const staff = [
    ['admin@demo.benbau.dk', 'Demo Admin', 'admin', null, null],
    ['lead.dk@demo.benbau.dk', 'Mette Hansen (Lead DK)', 'lead', 'DK', null],
    ['lead.se@demo.benbau.dk', 'Erik Lundqvist (Lead SE)', 'lead', 'SE', null],
    ['cph@demo.benbau.dk', 'Jonas Holm (Officer CPH)', 'officer', 'DK', locs[0].id],
    ['frd2a@demo.benbau.dk', 'Line Sørensen (Officer FRD2A)', 'officer', 'DK', locs[1].id],
    ['kungsgarden@demo.benbau.dk', 'Oskar Nilsson (Officer Kungsgarden)', 'officer', 'SE', locs[2].id],
    ['ersbo@demo.benbau.dk', 'Anna Berg (Officer Ersbo)', 'officer', 'SE', locs[3].id],
    ['stackbo@demo.benbau.dk', 'Sara Ek (Officer Stackbo)', 'officer', 'SE', locs[4].id],
  ];
  for (const [Email, Name, Role, Country, LocationId] of staff) t.staff.push({ Email, Name, Role, Country, LocationId });
  const officerAt = loc => (t.staff.find(s => s.LocationId === loc.id) || t.staff[0]).Name.replace(/ \(.*\)$/, '');

  // ----- products -----
  const clothes = 'S, M, L, XL, 2XL, 3XL, 4XL';
  const boots = '38, 39, 40, 41, 42, 43, 44, 45, 46, 47';
  const gloves = '7, 8, 9, 10, 11';
  const productDefs = [
    ['Winter Jacket', clothes, 'Jacket'], ['Softshell Jacket', clothes, 'Jacket'],
    ['Winter Trousers', clothes, 'Trousers'], ['Summer Work Trousers', clothes, 'Trousers'],
    ['Hi-Vis Vest', 'S, M, L, XL, 2XL, 3XL', 'Vest'],
    ['Safety Boots S3', boots, 'Boots'], ['Winter Safety Boots', boots, 'Boots'],
    ['Safety Helmet White', 'OneSize', ''], ['Fall-Arrest Harness', 'M, L, XL', ''],
    ['Work Gloves', gloves, 'Gloves', 'consumable'], ['Cut-Resistant Gloves', gloves, 'Gloves', 'consumable'],
    ['Winter Gloves', gloves, 'Gloves', 'consumable'],
    ['Safety Glasses Clear', 'OneSize', '', 'consumable'], ['Safety Glasses Tinted', 'OneSize', '', 'consumable'],
    ['Ear Plugs (box)', 'OneSize', '', 'consumable'], ['Ear Defenders', 'OneSize', '', 'consumable'],
    ['Knee Pads', 'OneSize', '', 'consumable'], ['FFP2 Masks (box)', 'OneSize', '', 'consumable'],
    ['Disposable Coveralls', 'M, L, XL, 2XL', '', 'consumable'],
  ];
  // Every country has its own products (different standards). Sweden uses a few different items.
  const swedish = { 'Safety Helmet White': 'Safety Helmet Yellow (SS-EN 397)', 'Hi-Vis Vest': 'Hi-Vis Vest Class 2 (SE)', 'Winter Safety Boots': 'Winter Safety Boots S3 SRC' };
  const products = ['DK', 'SE'].flatMap(Country => productDefs.map(([title, Sizes, SizeType, Category = 'regular']) => add('products', {
    Title: Country === 'SE' && swedish[title] ? swedish[title] : title, Sizes, SizeType, Category,
    Returnable: Category === 'regular', ImageUrl: '', Active: true, Country, base: title,
  })));
  // PC(base title, country) -> that country's version of the product.
  const PC = (title, country) => products.find(p => p.base === title && p.Country === country);
  const sizesOf = p => p.Sizes.split(',').map(s => s.trim());

  // ----- stock at every location, with the initial count in the stock log -----
  for (const loc of locs) {
    for (const p of products.filter(x => x.Country === loc.Country)) {
      for (const size of sizesOf(p)) {
        const r = rnd();
        if (r < 0.08) continue;                                      // never stocked here
        const q = r < 0.16 ? 0 : r < 0.3 ? 1 + Math.floor(rnd() * 2) : Math.floor(rnd() * (p.Category === 'consumable' ? 40 : 15));
        add('stock', { ProductId: p.id, Size: size, LocationId: loc.id, Quantity: q, ReturnedQuantity: p.Category === 'regular' && q > 5 && rnd() < 0.4 ? 1 + Math.floor(rnd() * 2) : 0 });
        if (q) add('stock_log', {
          ChangedAt: iso(now - (110 + Math.floor(rnd() * 20)) * day), ProductId: p.id, ProductTitle: p.Title, Size: size,
          LocationId: loc.id, LocationName: loc.Title, OldQuantity: 0, NewQuantity: q, Change: q, Source: 'Manual edit',
          Note: 'Initial stock count', ChangedBy: officerAt(loc), ChangedByEmail: 'demo@demo.benbau.dk',
        });
      }
    }
  }

  // ----- workers -----
  const first = ['Anders', 'Mads', 'Jonas', 'Frederik', 'Mikkel', 'Lars', 'Henrik', 'Søren', 'Erik', 'Johan', 'Oskar', 'Karl',
    'Piotr', 'Tomasz', 'Marek', 'Mihai', 'Andrei', 'Ionut', 'Darius', 'Tomas', 'Mantas', 'Marius', 'Linas', 'Arturas',
    'Imre', 'Laszlo', 'Nicolae', 'Cosmin', 'Viktor', 'Pavel', 'Maria', 'Sofia', 'Emma', 'Ida'];
  const last = ['Jensen', 'Nielsen', 'Hansen', 'Pedersen', 'Andersen', 'Larsen', 'Svensson', 'Lindqvist', 'Holm', 'Berg',
    'Nowak', 'Kowalski', 'Wiśniewski', 'Popescu', 'Ionescu', 'Dumitru', 'Petrauskas', 'Kazlauskas', 'Jankauskas',
    'Ivanovas', 'Nagy', 'Kovács', 'Szabó', 'Novák', 'Dvořák', 'Horváth', 'Olsen', 'Madsen'];
  const companies = ['Benbau', 'Benbau', 'Benbau', 'HIROS', 'Dipwork', 'Nortabyg', 'TSI'];
  const names = new Set();
  const people = [];
  for (let i = 0; i < 90; i++) {
    let name;
    do { name = `${pick(first)} ${pick(last)}`; } while (names.has(name));
    names.add(name);
    const company = pick(companies);
    const loc = rnd() < 0.5 ? pick(dk) : pick(se);
    const sub = company !== 'Benbau';
    const r = rnd();
    const status = sub ? (r < 0.14 ? 'rotation' : r < 0.26 ? 'left' : 'active') : (r < 0.06 ? 'left' : 'active');
    const jacket = pick(['M', 'L', 'L', 'XL', 'XL', '2XL', '3XL']);
    people.push(add('personnel', {
      Title: name, Company: company, Email: '', Phone: `+45 ${20000000 + Math.floor(rnd() * 79999999)}`, EmployeeNo: String(1000 + i),
      LocationId: loc.id, LocationName: loc.Title, Active: status !== 'left', InRotation: status === 'rotation',
      BootsSize: rnd() < 0.08 ? '' : String(39 + Math.floor(rnd() * 8)), JacketSize: jacket,
      TrouserSize: rnd() < 0.1 ? '' : pick(['M', 'L', 'XL', '2XL']), VestSize: jacket,
      GlovesSize: rnd() < 0.1 ? '' : String(8 + Math.floor(rnd() * 3)),
      startedDaysAgo: 60 + Math.floor(rnd() * 480),
    }));
  }

  // ----- handouts: a starter kit when a worker starts, then replacements and consumables -----
  const sizeFor = (person, p) => {
    const key = { Jacket: 'JacketSize', Trousers: 'TrouserSize', Vest: 'VestSize', Boots: 'BootsSize', Gloves: 'GlovesSize' }[p.SizeType];
    const sizes = sizesOf(p);
    const s = key && person[key];
    return s && sizes.includes(s) ? s : pick(sizes);
  };
  const reasons = ['Replacement - Worn Out', 'Replacement - Worn Out', 'Replacement - Damaged', 'Replacement - Lost', 'Size Change', 'Project Requirement'];
  let batch = 0;
  const handout = (person, items, daysAgo, reason) => {
    const loc = locs.find(l => l.id === person.LocationId);
    const date = iso(now - daysAgo * day - Math.floor(rnd() * 8) * 3600000);
    const b = `demo-b${++batch}`;
    for (const [p, qty] of items) {
      add('handouts', {
        Title: p.Title, BatchId: b, PersonnelId: person.id, PersonnelName: person.Title, ProductId: p.id, Size: sizeFor(person, p),
        Quantity: qty, LocationId: loc.id, LocationName: loc.Title, Reason: reason, Notes: '', HandoutDate: date,
        HandedOutBy: officerAt(loc), HandedOutByEmail: 'demo@demo.benbau.dk', Signature: '', ReturnedQuantity: 0, FromReturned: 0,
      });
    }
  };
  for (const person of people) {
    const country = locs.find(l => l.id === person.LocationId).Country;
    const P = title => PC(title, country);   // products of the worker's country
    const start = person.startedDaysAgo;
    const winter = rnd() < 0.7;
    handout(person, [
      [winter ? P('Winter Jacket') : P('Softshell Jacket'), 1], [winter ? P('Winter Trousers') : P('Summer Work Trousers'), 1],
      [P('Hi-Vis Vest'), 1], [P('Safety Boots S3'), 1], [P('Safety Helmet White'), 1],
      [P('Work Gloves'), 2], [P('Safety Glasses Clear'), 1], [P('Ear Plugs (box)'), 1],
    ], start, 'New Issue');
    if (rnd() < 0.25) handout(person, [[P('Fall-Arrest Harness'), 1]], start - 2, 'Training');
    // Replacements and consumables while the worker is on the project.
    const until = person.Active === false ? Math.floor(rnd() * 60) : 0;
    for (let d = start - 10; d > until; d -= 7 + Math.floor(rnd() * 25)) {
      const r = rnd();
      if (r < 0.45) handout(person, [[pick([P('Work Gloves'), P('Work Gloves'), P('Cut-Resistant Gloves'), P('Winter Gloves')]), 1 + Math.floor(rnd() * 3)]], d, 'Replacement - Worn Out');
      else if (r < 0.6) handout(person, [[pick([P('Ear Plugs (box)'), P('FFP2 Masks (box)'), P('Knee Pads'), P('Safety Glasses Tinted')]), 1]], d, 'New Issue');
      else if (r < 0.7) handout(person, [[pick([P('Winter Jacket'), P('Winter Trousers'), P('Summer Work Trousers'), P('Hi-Vis Vest'), P('Softshell Jacket')]), 1]], d, pick(reasons));
      else if (r < 0.76) handout(person, [[pick([P('Safety Boots S3'), P('Winter Safety Boots')]), 1]], d, pick(reasons));
      else if (r < 0.8) handout(person, [[P('Disposable Coveralls'), 2]], d, 'Project Requirement');
    }
  }

  // ----- returns: about half of the workers who left gave (some of) their PPE back -----
  for (const person of people.filter(p => p.Active === false && rnd() < 0.5)) {
    for (const hnd of t.handouts.filter(x => x.PersonnelId === person.id)) {
      const prod = products.find(p => p.id === hnd.ProductId);
      if (prod.Category !== 'regular' || rnd() < 0.3) continue;
      hnd.ReturnedQuantity = hnd.Quantity;
      const toStock = rnd() < 0.7;
      add('returns', {
        ReturnDate: iso(now - Math.floor(rnd() * 50) * day), HandoutId: hnd.id, PersonnelId: person.id, PersonnelName: person.Title,
        Company: person.Company, ProductId: hnd.ProductId, Title: hnd.Title, Size: hnd.Size, Quantity: hnd.Quantity,
        LocationId: hnd.LocationId, LocationName: hnd.LocationName, ToStock: toStock, Note: 'Left the project',
        ReceivedBy: officerAt(locs.find(l => l.id === hnd.LocationId)), ReceivedByEmail: 'demo@demo.benbau.dk',
      });
    }
  }
  for (const p of people) delete p.startedDaysAgo;
  for (const p of products) delete p.base;

  // ----- stock log for the last 3 months: handouts + weekly consumable counts (drives the Orders suggestions) -----
  for (const hnd of t.handouts) {
    if (now - new Date(hnd.HandoutDate).getTime() > 95 * day) continue;
    add('stock_log', {
      ChangedAt: hnd.HandoutDate, ProductId: hnd.ProductId, ProductTitle: hnd.Title, Size: hnd.Size,
      LocationId: hnd.LocationId, LocationName: hnd.LocationName, OldQuantity: 0, NewQuantity: 0, Change: -hnd.Quantity,
      Source: 'Handout', Note: `To ${hnd.PersonnelName}`, ChangedBy: hnd.HandedOutBy, ChangedByEmail: 'demo@demo.benbau.dk',
    });
  }
  for (const p of products.filter(x => x.Category === 'consumable')) {
    for (const loc of locs.filter(l => l.Country === p.Country)) {
      for (const size of sizesOf(p)) {
        for (let w = 12; w >= 1; w--) {
          const used = Math.floor(rnd() * (p.Title.includes('box') ? 6 : 4));
          if (!used) continue;
          add('stock_log', {
            ChangedAt: iso(now - w * 7 * day), ProductId: p.id, ProductTitle: p.Title, Size: size,
            LocationId: loc.id, LocationName: loc.Title, OldQuantity: 0, NewQuantity: 0, Change: -used,
            Source: 'Manual edit', Note: 'Weekly count', ChangedBy: officerAt(loc), ChangedByEmail: 'demo@demo.benbau.dk',
          });
        }
      }
    }
  }

  // ----- transfers within each country -----
  for (let i = 0; i < 30; i++) {
    const group = rnd() < 0.5 ? dk : se;
    const from = pick(group);
    const to = pick(group.filter(l => l !== from));
    const p = pick(products.filter(x => x.Country === from.Country));
    const size = pick(sizesOf(p));
    const qty = 1 + Math.floor(rnd() * 5);
    const date = iso(now - Math.floor(rnd() * 90) * day);
    add('transfers', {
      Title: p.Title, ProductId: p.id, Size: size, Quantity: qty, FromLocationId: from.id, FromLocationName: from.Title,
      ToLocationId: to.id, ToLocationName: to.Title, Reason: pick(['New workers arriving', 'Backup stock', 'Visitors on site', '']),
      TransferDate: date, TransferredBy: officerAt(from),
    });
    for (const [loc, change, note] of [[from, -qty, `To ${to.Title}`], [to, qty, `From ${from.Title}`]]) {
      add('stock_log', {
        ChangedAt: date, ProductId: p.id, ProductTitle: p.Title, Size: size, LocationId: loc.id, LocationName: loc.Title,
        OldQuantity: 0, NewQuantity: 0, Change: change, Source: 'Transfer', Note: note, ChangedBy: officerAt(from), ChangedByEmail: 'demo@demo.benbau.dk',
      });
    }
  }

  // ----- incidents (tab hidden unless incidentsEnabled) -----
  const violations = [
    ['Health and Safety', 'Working at height without the harness clipped on.'],
    ['Health and Safety', 'Grinding without safety glasses.'],
    ['Health and Safety', 'Talking on the phone while operating the telehandler.'],
    ['Other Policy', 'Smoking outside the designated smoking area.'],
    ['Quality', 'Reinforcement installed without inspection sign-off.'],
    ['Health and Safety', 'Using hot works without a permit.'],
  ];
  for (let i = 0; i < 18; i++) {
    const person = pick(people);
    const [Type, Description] = pick(violations);
    const prior = t.incidents.filter(x => x.PersonnelId === person.id && x.Type === Type).length;
    const daysAgo = Math.floor(rnd() * 120);
    const loc = locs.find(l => l.id === person.LocationId);
    add('incidents', {
      IncidentDate: iso(now - daysAgo * day), PersonnelId: person.id, PersonnelName: person.Title, Branch: person.Company,
      LocationId: loc.id, LocationName: loc.Title, Type, Description, BreachCount: prior + 1,
      ActionTaken: ['Verbal Coaching', 'Yellow Card', 'Red Card'][Math.min(prior, 2)], ReportedBy: officerAt(loc), Witnesses: '',
      Status: daysAgo > 20 ? 'Closed' : 'Open', FollowUp: daysAgo > 20 ? 'Discussed with the worker and the supervisor.' : '',
      ClosedAt: daysAgo > 20 ? iso(now - (daysAgo - 3) * day) : null, ClosedBy: daysAgo > 20 ? officerAt(loc) : null,
      Evidence: [], Signature: '', CreatedBy: officerAt(loc), CreatedAt: iso(now - daysAgo * day),
    });
  }

  return { nextId: id, tables: t };
}
