// Demo data store with the same interface as SupabaseDb, kept in localStorage.
// The stock operations mirror the database functions in supabase/setup.sql.
const KEY = 'ppe-demo-db-v10';

export class DemoDb {
  constructor(user) {
    this.user = user;
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

  async setStock(productId, size, locationId, quantity, note, returned) {
    return this.transaction(() => {
      this.ctx = { source: 'Manual edit', note };
      const row = this.stockRow(productId, size, locationId);
      this.setQuantity(row, quantity);
      row.ReturnedQuantity = Math.max(0, Math.min(returned == null ? (row.ReturnedQuantity || 0) : returned, row.Quantity));
    });
  }

  async recordReturn(personId, locationId, items, note) {
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

  adjust(productId, size, locationId, delta, allowNegative, returnedDelta = 0) {
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
  const t = { locations: [], products: [], stock: [], personnel: [], handouts: [], transfers: [], stock_log: [], incidents: [], evidence_files: [], returns: [] };
  const add = (table, f) => { const row = { ...f, id: ++id }; t[table].push(row); return row; };

  const locs = [['CPH', 'DK'], ['FRD2A', 'DK'], ['Kungsgarden', 'SE'], ['Ersbo', 'SE'], ['Stackbo', 'SE']]
    .map(([Title, Country]) => add('locations', { Title, Country, Active: true }));
  const clothes = 'S, M, L, XL, 2XL, 3XL, 4XL';
  const products = [
    ['Winter Jacket', clothes, 'Jacket'],
    ['Winter Trousers', clothes, 'Trousers'],
    ['Summer Vest', 'S, M, L, XL, 2XL, 3XL', 'Vest'],
    ['AllWeather Helmet White', 'OneSize', ''],
    ['Work Gloves', '7, 8, 9, 10, 11', 'Gloves', 'consumable'],
    ['Safety Boots S3', '38, 39, 40, 41, 42, 43, 44, 45, 46, 47', 'Boots'],
    ['Safety Glasses Clear', 'OneSize', '', 'consumable'],
    ['Ear Defenders', 'OneSize', '', 'consumable'],
    ['Knee Pads', 'OneSize', '', 'consumable'],
    ['Ear Plugs (box)', 'OneSize', '', 'consumable'],
  ].map(([Title, Sizes, SizeType, Category = 'regular']) => add('products', {
    Title, Sizes, SizeType, Category, Returnable: Category === 'regular', ImageUrl: '', Active: true,
  }));

  let n = 7;
  const rnd = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  for (const loc of locs.slice(0, 3)) {
    for (const p of products) {
      for (const size of p.Sizes.split(',').map(s => s.trim())) {
        const q = Math.floor(rnd() * 12);
        if (!q) continue;
        add('stock', { ProductId: p.id, Size: size, LocationId: loc.id, Quantity: q, ReturnedQuantity: q > 6 ? 1 : 0 });
        add('stock_log', {
          ChangedAt: new Date(Date.now() - (60 + Math.floor(rnd() * 60)) * 86400000).toISOString(),
          ProductId: p.id, ProductTitle: p.Title, Size: size, LocationId: loc.id, LocationName: loc.Title,
          OldQuantity: 0, NewQuantity: q, Change: q, Source: 'Manual edit', Note: 'Initial stock count',
          ChangedBy: 'Demo User', ChangedByEmail: 'demo@example.com',
        });
      }
    }
  }

  const people = [
    ['Anders Jensen', 'Benbau', 0], ['Maria Nielsen', 'Benbau', 0], ['Jonas Berg', 'Nortabyg', 1],
    ['Sofia Lindqvist', 'Benbau', 2], ['Erik Holm', 'TSI', 3], ['Lars Madsen', 'Dipwork', 0],
    ['Piotr Nowak', 'Dipwork', 0, 'rotation'], ['Tomas Petrauskas', 'Nortabyg', 1, 'left'],
    ['Mihai Popescu', 'HIROS', 0, 'rotation'], ['Andrei Ionescu', 'HIROS', 1], ['Jan Kowalski', 'TSI', 3, 'left'],
    ['Karl Svensson', 'TSI', 2, 'rotation'],
  ].map(([Title, Company, li, status]) => add('personnel', {
    Title, Company, Email: Title.toLowerCase().replace(/\s+/g, '.') + '@example.com', Phone: '', EmployeeNo: '',
    LocationId: locs[li].id, LocationName: locs[li].Title, Active: status !== 'left', InRotation: status === 'rotation',
    BootsSize: String(40 + Math.floor(rnd() * 7)), JacketSize: ['M', 'L', 'XL', '2XL'][Math.floor(rnd() * 4)],
    TrouserSize: ['M', 'L', 'XL'][Math.floor(rnd() * 3)], VestSize: ['L', 'XL', '2XL'][Math.floor(rnd() * 3)],
    GlovesSize: String(8 + Math.floor(rnd() * 3)),
  }));

  const day = 86400000;
  const hand = (person, product, size, daysAgo, reason, notes = '') => add('handouts', {
    Title: product.Title, BatchId: `demo-${person.id}-${daysAgo}`, PersonnelId: person.id, PersonnelName: person.Title,
    ProductId: product.id, Size: size, Quantity: 1, LocationId: locs[0].id, LocationName: locs[0].Title,
    Reason: reason, Notes: notes, HandoutDate: new Date(Date.now() - daysAgo * day).toISOString(),
    HandedOutBy: 'Demo User', HandedOutByEmail: 'demo@example.com', Signature: '',
  });
  hand(people[0], products[0], 'L', 110, 'New Issue');
  hand(people[0], products[3], 'OneSize', 110, 'New Issue');
  hand(people[0], products[2], 'L', 20, 'Replacement - Worn Out', 'Old vest torn');
  hand(people[1], products[2], 'S', 45, 'Other', 'Management vest: HSE Lead');

  // Older sample history spread over 18 months and all locations, for the History screen.
  const reasons = ['New Issue', 'Replacement - Worn Out', 'Replacement - Damaged', 'Replacement - Lost', 'Size Change', 'Project Requirement'];
  for (let i = 0; i < 600; i++) {
    const person = people[Math.floor(rnd() * people.length)];
    const product = products[Math.floor(rnd() * products.length)];
    const sizes = product.Sizes.split(',').map(s => s.trim());
    const loc = locs[Math.floor(rnd() * locs.length)];
    add('handouts', {
      Title: product.Title, BatchId: `demo-h${i}`, PersonnelId: person.id, PersonnelName: person.Title,
      ProductId: product.id, Size: sizes[Math.floor(rnd() * sizes.length)], Quantity: 1 + Math.floor(rnd() * 2),
      LocationId: loc.id, LocationName: loc.Title, Reason: reasons[Math.floor(rnd() * reasons.length)], Notes: '',
      HandoutDate: new Date(Date.now() - Math.floor(rnd() * 540 * day)).toISOString(),
      HandedOutBy: 'Demo User', HandedOutByEmail: 'demo@example.com', Signature: '',
    });
  }

  // Stock log for the last 3 months, so the Orders suggestions have history:
  // handouts (regular PPE) and weekly manual counts that went down (consumables).
  for (const hnd of t.handouts) {
    if (Date.now() - new Date(hnd.HandoutDate).getTime() > 95 * day) continue;
    add('stock_log', {
      ChangedAt: hnd.HandoutDate, ProductId: hnd.ProductId, ProductTitle: hnd.Title, Size: hnd.Size,
      LocationId: hnd.LocationId, LocationName: hnd.LocationName, OldQuantity: 0, NewQuantity: 0, Change: -hnd.Quantity,
      Source: 'Handout', Note: `To ${hnd.PersonnelName}`, ChangedBy: 'Demo User', ChangedByEmail: 'demo@example.com',
    });
  }
  for (const p of products.filter(x => x.Category === 'consumable')) {
    for (const loc of locs.slice(0, 3)) {
      for (const size of p.Sizes.split(',').map(s => s.trim())) {
        for (let w = 12; w >= 1; w--) {
          const used = Math.floor(rnd() * (p.Title.startsWith('Ear Plugs') ? 6 : 4));
          if (!used) continue;
          add('stock_log', {
            ChangedAt: new Date(Date.now() - w * 7 * day).toISOString(), ProductId: p.id, ProductTitle: p.Title, Size: size,
            LocationId: loc.id, LocationName: loc.Title, OldQuantity: 0, NewQuantity: 0, Change: -used,
            Source: 'Manual edit', Note: 'Weekly count', ChangedBy: 'Demo User', ChangedByEmail: 'demo@example.com',
          });
        }
      }
    }
  }

  // Sample incidents.
  const incident = (person, daysAgo, branch, li, type, description, action, count) => add('incidents', {
    IncidentDate: new Date(Date.now() - daysAgo * day).toISOString(), PersonnelId: person.id, PersonnelName: person.Title,
    Branch: branch, LocationId: locs[li].id, LocationName: locs[li].Title, Type: type, Description: description,
    ActionTaken: action, BreachCount: count, ReportedBy: 'Demo User', Witnesses: '', Status: daysAgo > 20 ? 'Closed' : 'Open',
    FollowUp: daysAgo > 20 ? 'Discussed with the worker and the supervisor.' : '', ClosedAt: daysAgo > 20 ? new Date(Date.now() - (daysAgo - 3) * day).toISOString() : null,
    ClosedBy: daysAgo > 20 ? 'Demo User' : null, Evidence: [], Signature: '', CreatedBy: 'Demo User', CreatedAt: new Date(Date.now() - daysAgo * day).toISOString(),
  });
  incident(people[2], 40, 'Nortabyg', 1, 'Other Policy', 'Smoking outside the designated smoking area.', 'General NCR', 1);
  incident(people[2], 6, 'Nortabyg', 1, 'Other Policy', 'Smoking outside the designated smoking area again.', 'Verbal Coaching', 2);
  incident(people[0], 7, 'Benbau', 0, 'Health and Safety', 'Using hot works without a permit.', 'Verbal Coaching', 1);
  incident(people[5], 7, 'Dipwork', 0, 'Health and Safety', 'Talking on the phone while lifting rebar bundles with the telehandler. Supervisor confirmed it is not the first time.', 'Yellow Card', 2);
  incident(people[1], 3, 'Benbau', 0, 'Health and Safety', 'Grinding with the face mask improperly fitted and without hearing protection.', 'Verbal Coaching', 1);
  incident(people[4], 2, 'TSI', 3, 'Quality', 'Reinforcement installed without inspection sign-off.', 'General NCR', 1);

  return { nextId: id, tables: t };
}
