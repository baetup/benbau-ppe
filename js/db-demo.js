// Demo data store with the same interface as SupabaseDb, kept in localStorage.
// The stock operations mirror the database functions in supabase/setup.sql.
const KEY = 'ppe-demo-db-v4';

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

  async setStock(productId, size, locationId, quantity) {
    await tick();
    this.stockRow(productId, size, locationId).Quantity = quantity;
    write(this.data);
  }

  async handout({ personId, locationId, items, reason, notes, date, signature }) {
    return this.transaction(() => {
      const person = this.find('personnel', personId);
      const loc = this.find('locations', locationId);
      if (!person) throw new Error('Person not found');
      const batchId = `demo-${Date.now()}`;
      return items.map(it => {
        const p = this.find('products', it.productId);
        this.adjust(it.productId, it.size, locationId, -it.qty, false);
        const row = {
          id: ++this.data.nextId, BatchId: batchId, PersonnelId: person.id, PersonnelName: person.Title,
          ProductId: p.id, Title: p.Title, Size: it.size, Quantity: it.qty, LocationId: loc.id, LocationName: loc.Title,
          Reason: reason, Notes: notes, HandoutDate: date, HandedOutBy: this.user.name, HandedOutByEmail: this.user.email, Signature: signature,
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
        this.adjust(it.productId, it.size, fromId, -it.qty, false);
        this.adjust(it.productId, it.size, toId, it.qty, true);
        this.rows('transfers').push({
          id: ++this.data.nextId, ProductId: p.id, Title: p.Title, Size: it.size, Quantity: it.qty,
          FromLocationId: from.id, FromLocationName: from.Title, ToLocationId: to.id, ToLocationName: to.Title,
          Reason: reason, TransferDate: new Date().toISOString(), TransferredBy: this.user.name,
        });
      }
    });
  }

  async deleteHandout(id, returnToStock) {
    return this.transaction(() => {
      const h = this.find('handouts', id);
      if (!h) return;
      if (returnToStock && h.LocationId && h.ProductId) this.adjust(h.ProductId, h.Size, h.LocationId, h.Quantity, true);
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
      row = { id: ++this.data.nextId, ProductId: productId, Size: size, LocationId: locationId, Quantity: 0 };
      this.rows('stock').push(row);
    }
    return row;
  }

  adjust(productId, size, locationId, delta, allowNegative) {
    const row = this.stockRow(productId, size, locationId);
    if (!allowNegative && row.Quantity + delta < 0) {
      throw new Error(`Not enough stock of ${this.find('products', productId).Title} (${size}) at ${this.find('locations', locationId).Title}. Available: ${row.Quantity}.`);
    }
    row.Quantity += delta;
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
  const t = { locations: [], products: [], stock: [], personnel: [], handouts: [], transfers: [] };
  const add = (table, f) => { const row = { ...f, id: ++id }; t[table].push(row); return row; };

  const locs = [['CPH', 'DK'], ['FRD2A', 'DK'], ['Kungsgarden', 'SE'], ['Ersbo', 'SE'], ['Stackbo', 'SE']]
    .map(([Title, Country]) => add('locations', { Title, Country, Active: true }));
  const clothes = 'S, M, L, XL, 2XL, 3XL, 4XL';
  const products = [
    ['Winter Jacket', clothes],
    ['Winter Trousers', clothes],
    ['Summer Vest', 'S, M, L, XL, 2XL, 3XL'],
    ['AllWeather Helmet White', 'OneSize'],
    ['Work Gloves', '7, 8, 9, 10, 11'],
    ['Safety Boots S3', '38, 39, 40, 41, 42, 43, 44, 45, 46, 47'],
    ['Safety Glasses Clear', 'OneSize'],
    ['Ear Defenders', 'OneSize'],
  ].map(([Title, Sizes]) => add('products', { Title, Sizes, ImageUrl: '', Active: true }));

  let n = 7;
  const rnd = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  for (const loc of locs.slice(0, 3)) {
    for (const p of products) {
      for (const size of p.Sizes.split(',').map(s => s.trim())) {
        const q = Math.floor(rnd() * 12);
        if (q) add('stock', { ProductId: p.id, Size: size, LocationId: loc.id, Quantity: q });
      }
    }
  }

  const people = [
    ['Anders Jensen', 'Benbau', 0], ['Maria Nielsen', 'Benbau', 0], ['Jonas Berg', 'Subcontractor A/S', 1],
    ['Sofia Lindqvist', 'Benbau', 2], ['Erik Holm', 'Benbau', 3], ['Lars Madsen', 'Subcontractor A/S', 0],
  ].map(([Title, Company, li]) => add('personnel', {
    Title, Company, Email: Title.toLowerCase().replace(/\s+/g, '.') + '@example.com', Phone: '', EmployeeNo: '',
    LocationId: locs[li].id, LocationName: locs[li].Title, Active: true,
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

  return { nextId: id, tables: t };
}
