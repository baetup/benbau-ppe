// Data access on Supabase. The app uses PascalCase field names (Title, ProductId, ...);
// the database uses snake_case columns (title, product_id, ...). Conversion happens here.
// Stock-changing operations run as database functions, so each one is all-or-nothing.

const TABLES = {
  locations: 'locations', products: 'products', stock: 'stock',
  personnel: 'personnel', handouts: 'handouts', transfers: 'transfers',
};
const PAGE = 1000;
const HISTORY_COLUMNS = 'id,batch_id,personnel_id,personnel_name,product_id,title,size,quantity,location_id,location_name,reason,notes,handout_date,handed_out_by';
const SORT_COLUMNS = { date: 'handout_date', person: 'personnel_name', product: 'title', location: 'location_name' };

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

  async setStock(productId, size, locationId, quantity, note) {
    check(await this.sb.rpc('set_stock', { p_product_id: productId, p_size: size, p_location_id: locationId, p_quantity: quantity, p_note: note || null }));
  }

  // History: one page of the stock change log, plus the total count.
  async queryStockLog(f) {
    if (f.locationIds && !f.locationIds.length) return { rows: [], total: 0 };
    let q = this.sb.from('stock_log').select('*', { count: 'exact' });
    if (f.locationIds) q = q.in('location_id', f.locationIds);
    if (f.productId) q = q.eq('product_id', f.productId);
    if (f.source) q = q.eq('source', f.source);
    if (f.search) q = q.ilike('changed_by', `%${f.search}%`);
    if (f.from) q = q.gte('changed_at', f.from);
    if (f.to) q = q.lt('changed_at', f.to);
    q = q.order('changed_at', { ascending: !!f.asc }).order('id', { ascending: !!f.asc }).range(f.offset, f.offset + f.limit - 1);
    const { data, error, count } = await q;
    check({ data, error });
    return { rows: data.map(fromDb), total: count || 0 };
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

  // History: one page of handouts matching the filters (without signatures), plus the total count.
  async queryHandouts(f) {
    if (f.locationIds && !f.locationIds.length) return { rows: [], total: 0 };
    let q = this.sb.from('handouts').select(HISTORY_COLUMNS, { count: 'exact' });
    if (f.locationIds) q = q.in('location_id', f.locationIds);
    if (f.productId) q = q.eq('product_id', f.productId);
    if (f.reason) q = q.eq('reason', f.reason);
    if (f.search) q = q.ilike('personnel_name', `%${f.search}%`);
    if (f.from) q = q.gte('handout_date', f.from);
    if (f.to) q = q.lt('handout_date', f.to);
    q = q.order(SORT_COLUMNS[f.sort] || 'handout_date', { ascending: !!f.asc });
    if (f.sort !== 'date') q = q.order('handout_date', { ascending: false });
    q = q.order('id', { ascending: false }).range(f.offset, f.offset + f.limit - 1);
    const { data, error, count } = await q;
    check({ data, error });
    return { rows: data.map(fromDb), total: count || 0 };
  }

  async handoutSummary(f) {
    if (f.locationIds && !f.locationIds.length) return [];
    const rows = check(await this.sb.rpc('handout_summary', {
      p_location_ids: f.locationIds, p_product_id: f.productId, p_reason: f.reason,
      p_search: f.search, p_from: f.from, p_to: f.to,
    }));
    return rows.map(fromDb);
  }

  // Dashboard: totals, items per week/month, per product, per location and per reason.
  async dashboardStats(f) {
    if (f.locationIds && !f.locationIds.length) return { items: 0, records: 0, people: 0, by_period: [], by_product: [], by_location: [], by_reason: [] };
    return check(await this.sb.rpc('dashboard_stats', {
      p_location_ids: f.locationIds, p_from: f.from, p_to: f.to, p_bucket: f.bucket,
    }));
  }

  // A person's handouts of the given products since a date (newest first, without signatures).
  async recentHandouts(personId, productIds, since) {
    if (!productIds.length) return [];
    return check(await this.sb.from('handouts').select(HISTORY_COLUMNS)
      .eq('personnel_id', personId).in('product_id', productIds).gte('handout_date', since)
      .order('handout_date', { ascending: false })).map(fromDb);
  }

  // All rows of one handout (with signature), for the receipt.
  async getHandoutBatch(batchId) {
    return check(await this.sb.from('handouts').select('*').eq('batch_id', batchId).order('id')).map(fromDb);
  }

  async exchangeHandout(id, newSize, quantity, locationId) {
    check(await this.sb.rpc('exchange_handout', { p_id: id, p_new_size: newSize, p_quantity: quantity, p_location_id: locationId }));
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
