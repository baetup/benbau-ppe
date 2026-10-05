// Demo data store with the same interface as SharePointDb, kept in localStorage.
const KEY = 'ppe-demo-db-v1';

export class DemoDb {
  constructor() {
    this.data = read() || seed();
    write(this.data);
  }

  rows(table) {
    return (this.data.tables[table] = this.data.tables[table] || []);
  }

  async list(table, filter) {
    await tick();
    let rows = this.rows(table);
    if (filter) rows = rows.filter(r => Object.entries(filter).every(([k, v]) => r[k] === v));
    return clone(rows);
  }

  async get(table, id) {
    await tick();
    const row = this.rows(table).find(r => r.id === id);
    if (!row) throw notFound();
    return clone(row);
  }

  async create(table, fields) {
    await tick();
    const row = { ...clean(fields), id: ++this.data.nextId, etag: '"1"' };
    this.rows(table).push(row);
    write(this.data);
    return clone(row);
  }

  async update(table, id, fields, etag) {
    await tick();
    const row = this.rows(table).find(r => r.id === id);
    if (!row) throw notFound();
    if (etag && etag !== row.etag) { const e = new Error('Conflict'); e.status = 412; throw e; }
    Object.assign(row, clean(fields));
    row.etag = `"${Number(row.etag.replace(/"/g, '')) + 1}"`;
    write(this.data);
    return clone(row);
  }

  async remove(table, id) {
    await tick();
    this.data.tables[table] = this.rows(table).filter(r => r.id !== id);
    write(this.data);
  }

  reset() {
    this.data = seed();
    write(this.data);
  }
}

const tick = () => new Promise(r => setTimeout(r, 60));
const clone = v => JSON.parse(JSON.stringify(v));
const notFound = () => Object.assign(new Error('Item not found'), { status: 404 });

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (k !== 'id' && k !== 'etag' && v !== undefined) out[k] = v;
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
  const add = (table, f) => { const row = { ...f, id: ++id, etag: '"1"' }; t[table].push(row); return row; };

  const locs = ['CPH', 'FRD2A', 'Kungsgarden', 'Ersbo', 'Stackbo'].map(n => add('locations', { Title: n, Active: true }));
  const clothes = 'S, M, L, XL, 2XL, 3XL, 4XL';
  const products = [
    ['Winter Jacket', 'Portwest', clothes],
    ['Winter Trousers', 'Portwest', clothes],
    ['Summer Vest', 'Portwest', 'S, M, L, XL, 2XL, 3XL'],
    ['AllWeather Helmet White', 'Portwest', 'OneSize'],
    ['Work Gloves', 'Tegera', '7, 8, 9, 10, 11'],
    ['Safety Boots S3', 'Jalas', '38, 39, 40, 41, 42, 43, 44, 45, 46, 47'],
    ['Safety Glasses Clear', 'Uvex', 'OneSize'],
    ['Ear Defenders', '3M Peltor', 'OneSize'],
  ].map(([Title, Brand, Sizes]) => add('products', { Title, Brand, Sizes, ImageUrl: '', Active: true }));

  let n = 7;
  const rnd = () => (n = (n * 9301 + 49297) % 233280) / 233280;
  for (const loc of locs.slice(0, 3)) {
    for (const p of products) {
      for (const size of p.Sizes.split(',').map(s => s.trim())) {
        const q = Math.floor(rnd() * 12);
        if (q) add('stock', { Title: `${p.id}|${size}|${loc.id}`, ProductId: p.id, Size: size, LocationId: loc.id, Quantity: q });
      }
    }
  }

  const people = [
    ['Anders Jensen', 'Benbau', 0], ['Maria Nielsen', 'Benbau', 0], ['Jonas Berg', 'Subcontractor A/S', 1],
    ['Sofia Lindqvist', 'Benbau', 1], ['Erik Holm', 'Benbau', 2], ['Lars Madsen', 'Subcontractor A/S', 0],
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
