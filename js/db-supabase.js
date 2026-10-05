// Data access on Supabase. The app uses PascalCase field names (Title, ProductId, ...);
// the database uses snake_case columns (title, product_id, ...). Conversion happens here.
// Stock-changing operations run as database functions, so each one is all-or-nothing.

const TABLES = {
  locations: 'locations', products: 'products', stock: 'stock',
  personnel: 'personnel', handouts: 'handouts', transfers: 'transfers',
};
const PAGE = 1000;

export class SupabaseDb {
  constructor(client) {
    this.sb = client;
  }

  async list(table, filter) {
    let all = [];
    for (let from = 0; ; from += PAGE) {
      let q = this.sb.from(TABLES[table]).select('*').order('id').range(from, from + PAGE - 1);
      if (filter) q = q.match(toDb(filter));
      const rows = check(await q);
      all = all.concat(rows.map(fromDb));
      if (rows.length < PAGE) return all;
    }
  }

  async create(table, fields) {
    return fromDb(check(await this.sb.from(TABLES[table]).insert(toDb(fields)).select().single()));
  }

  async update(table, id, fields) {
    return fromDb(check(await this.sb.from(TABLES[table]).update(toDb(fields)).eq('id', id).select().single()));
  }

  async remove(table, id) {
    check(await this.sb.from(TABLES[table]).delete().eq('id', id));
  }

  async setStock(productId, size, locationId, quantity) {
    check(await this.sb.rpc('set_stock', { p_product_id: productId, p_size: size, p_location_id: locationId, p_quantity: quantity }));
  }

  async handout({ personId, locationId, items, reason, notes, date, signature }) {
    const rows = check(await this.sb.rpc('create_handout', {
      p_personnel_id: personId, p_location_id: locationId, p_items: items,
      p_reason: reason, p_notes: notes, p_date: date, p_signature: signature,
    }));
    return rows.map(fromDb);
  }

  async transfer({ fromId, toId, items, reason }) {
    check(await this.sb.rpc('create_transfer', { p_from_location_id: fromId, p_to_location_id: toId, p_items: items, p_reason: reason }));
  }

  async deleteHandout(id, returnToStock) {
    check(await this.sb.rpc('delete_handout', { p_id: id, p_return_to_stock: !!returnToStock }));
  }
}

function check({ data, error }) {
  if (error) {
    const e = new Error(error.message || 'Database error');
    e.code = error.code;
    if (error.code === '42501' || error.code === 'PGRST301') e.status = 403;
    throw e;
  }
  return data;
}

// ProductId -> product_id, HandedOutByEmail -> handed_out_by_email, Title -> title
const snake = k => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
// product_id -> ProductId, title -> Title
const pascal = k => k.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');

function toDb(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || k === 'etag' || v === undefined) continue;
    out[snake(k)] = v;
  }
  return out;
}

function fromDb(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[k === 'id' ? 'id' : pascal(k)] = v;
  return out;
}
