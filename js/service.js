// Business logic on top of a data store (SupabaseDb or DemoDb).
export class PpeService {
  constructor(db, user) {
    this.db = db;
    this.user = user;       // { name, email } of the signed-in user
    this.locations = [];
    this.products = [];
    this.personnel = [];
  }

  async loadBase() {
    const [l, p, pe] = await Promise.all([this.db.list('locations'), this.db.list('products'), this.db.list('personnel')]);
    this.locations = sortByTitle(l);
    this.products = sortByTitle(p);
    this.personnel = sortByTitle(pe);
  }

  location(id) { return this.locations.find(x => x.id === id); }
  product(id) { return this.products.find(x => x.id === id); }
  person(id) { return this.personnel.find(x => x.id === id); }
  activeLocations() { return this.locations.filter(x => x.Active !== false); }
  activeProducts() { return this.products.filter(x => x.Active !== false); }
  // Products belong to one country (different products / standards per country). 'all' or empty = every country.
  productCountry(p) { return (p && p.Country) || this.defaultCountry; }
  productsIn(country, { activeOnly = false } = {}) {
    return this.products.filter(p => (!activeOnly || p.Active !== false) && (!country || country === 'all' || this.productCountry(p) === country));
  }
  activePersonnel() { return this.personnel.filter(x => x.Active !== false); }

  // Countries: a location's Country column; locations without one belong to the default country.
  countryOf(loc) { return (loc && loc.Country) || this.defaultCountry; }
  locationsIn(country) { return this.activeLocations().filter(l => this.countryOf(l) === country); }
  // A person's country comes from their site; people without a site show in every country.
  personCountry(p) { const l = this.location(p.LocationId); return l ? this.countryOf(l) : null; }

  sizesOf(p) {
    const s = parseSizes(p && p.Sizes);
    return s.length ? s : ['OneSize'];
  }

  // ---------- master data ----------
  saveLocation(data) { return this.save('locations', this.locations, data); }
  saveProduct(data) { return this.save('products', this.products, data); }
  savePerson(data) { return this.save('personnel', this.personnel, data); }

  async save(table, cache, data) {
    const { id, ...fields } = data;
    let row;
    if (id) {
      row = await this.db.update(table, id, fields);
      cache.splice(cache.findIndex(x => x.id === id), 1, row);
    } else {
      row = await this.db.create(table, fields);
      cache.push(row);
    }
    cache.sort((a, b) => (a.Title || '').localeCompare(b.Title || ''));
    return row;
  }

  // ---------- stock ----------
  // Returns Map "productId|size" -> quantity for one location.
  async getStock(locationId) {
    const rows = await this.db.list('stock', { LocationId: locationId });
    const m = new Map();
    for (const r of rows) m.set(`${r.ProductId}|${r.Size}`, Number(r.Quantity) || 0);
    return m;
  }

  setStock(productId, size, locationId, quantity, note, returned) {
    return this.db.setStock(productId, size, locationId, quantity, note, returned);
  }

  // Stock of one location: { qty: Map "productId|size" -> quantity, returned: Map -> returned (used) part }
  async getStockFull(locationId) {
    const rows = await this.db.list('stock', { LocationId: locationId });
    const qty = new Map(), returned = new Map();
    for (const r of rows) {
      const k = `${r.ProductId}|${r.Size}`;
      qty.set(k, (qty.get(k) || 0) + (Number(r.Quantity) || 0));
      returned.set(k, (returned.get(k) || 0) + (Number(r.ReturnedQuantity) || 0));
    }
    return { qty, returned };
  }

  // ---------- worker status, returns, lost / rotation PPE ----------
  isMainCompany(company) { return !!this.mainCompany && (company || '').trim().toLowerCase() === this.mainCompany.toLowerCase(); }
  // 'active' (on site), 'rotation' or 'left'. Rotation only exists for subcontractor workers.
  statusOf(p) { return p.Active === false ? 'left' : (p.InRotation && !this.isMainCompany(p.Company) ? 'rotation' : 'active'); }
  setPersonStatus(p, status) {
    return this.savePerson({
      id: p.id, Active: status !== 'left', InRotation: status === 'rotation', StatusChangedAt: new Date().toISOString(),
    });
  }
  recordReturn(personId, locationId, items, note) { return this.db.recordReturn(personId, locationId, items, note); }
  returnsFor(personId) { return this.db.list('returns', { PersonnelId: personId }); }
  outstandingPpe(country, status) { return this.db.outstandingPpe(country, status, this.mainCompany); }

  // ---------- clothing sizes on a person's profile ----------
  // Stored in SizeProfile ({ Boots: '44', … }); the first five types also have their old columns, read as fallback.
  personSize(p, type) {
    const v = (p && p.SizeProfile && p.SizeProfile[type]) || (LEGACY_SIZE_COLUMNS[type] && p && p[LEGACY_SIZE_COLUMNS[type]]);
    return v ? String(v).trim() : '';
  }
  // Fields to save for edited sizes { type: value }. Types not shown in the form (e.g. removed from config) are kept.
  sizeFields(p, edited) {
    const profile = { ...((p && p.SizeProfile) || {}) };
    for (const [type, value] of Object.entries(edited)) {
      if (value) profile[type] = value; else delete profile[type];
    }
    const fields = { SizeProfile: profile };
    for (const [type, column] of Object.entries(LEGACY_SIZE_COLUMNS)) if (type in edited) fields[column] = edited[type] || '';
    return fields;
  }

  // ---------- roles ----------
  // admin: everything · lead: all locations in their country · officer: hands out only at their own location.
  get role() { return (this.user && this.user.role) || 'officer'; }
  isAdmin() { return this.role === 'admin'; }
  // Hand out, change stock, receive returns, exchange sizes at this location?
  canOperate(locationId) {
    if (this.isAdmin()) return true;
    const loc = this.location(locationId);
    if (!loc) return false;
    if (this.role === 'lead') return this.countryOf(loc) === this.user.country;
    return loc.id === this.user.locationId;
  }
  canEditProducts() { return this.role === 'admin' || this.role === 'lead'; }
  listStaff() { return this.db.listStaff(); }
  saveStaff(fields, originalEmail) { return this.db.saveStaff(fields, originalEmail); }
  deleteStaff(email) { return this.db.deleteStaff(email); }

  // ---------- categories & orders ----------
  categoryOf(p) { return p && p.Category === 'consumable' ? 'consumable' : 'regular'; }
  // Use per product/size at a location over the last `months` months: { first: Date|null, used: Map "pid|size" -> qty }
  async stockUsage(locationId, months) {
    const from = new Date();
    from.setMonth(from.getMonth() - months);
    const r = await this.db.stockUsage(locationId, from.toISOString());
    return {
      first: r.first_log ? new Date(r.first_log) : null,
      used: new Map((r.rows || []).map(x => [`${x.product_id}|${x.size}`, Number(x.used) || 0])),
    };
  }

  // Every stock row (all locations): Map "productId|size|locationId" -> quantity. Small: products × sizes × locations.
  async getAllStock() {
    const m = new Map();
    for (const r of await this.db.list('stock')) m.set(`${r.ProductId}|${r.Size}|${r.LocationId}`, Number(r.Quantity) || 0);
    return m;
  }

  // ---------- incidents ----------
  // Filters: { locationIds, personId, type, action, branch, status, search, from, to, offset, limit }
  queryIncidents(f) { return this.db.queryIncidents({ offset: 0, limit: 50, ...f }); }
  getIncident(id) { return this.db.getIncident(id); }
  saveIncident(data) {
    const { id, ...fields } = data;
    return id ? this.db.update('incidents', id, fields) : this.db.create('incidents', fields);
  }
  async deleteIncident(incident) {
    await this.db.removeEvidence((incident.Evidence || []).map(e => e.path));
    await this.db.remove('incidents', incident.id);
  }
  uploadEvidence(path, blob, type) { return this.db.uploadEvidence(path, blob, type); }
  evidenceUrls(paths) { return this.db.evidenceUrls(paths); }
  removeEvidence(paths) { return this.db.removeEvidence(paths); }

  // Dashboard numbers. Filters: { locationIds, from, to, bucket: 'week' | 'month' }
  dashboardStats(f) { return this.db.dashboardStats(f); }

  // Stock change log. Filters: { locationIds, productId, source, search, from, to, asc, offset, limit }
  queryStockLog(f) { return this.db.queryStockLog(f); }

  // ---------- handouts & transfers (all-or-nothing) ----------
  async getHandoutsFor(personId) {
    const rows = await this.db.list('handouts', { PersonnelId: personId });
    return rows.sort((a, b) => (b.HandoutDate || '').localeCompare(a.HandoutDate || ''));
  }

  handout({ person, locationId, items, reason, notes, date, signature }) {
    return this.db.handout({ personId: person.id, locationId, items, reason, notes, date, signature });
  }

  // History screen. Filters: { locationIds, productId, reason, search, from, to, sort, asc, offset, limit }
  queryHandouts(f) { return this.db.queryHandouts(f); }
  handoutSummary(f) { return this.db.handoutSummary(f); }
  getHandoutBatch(batchId) { return this.db.getHandoutBatch(batchId); }

  // Handouts of any of these products to this person in the last `months` months (any size).
  recentHandouts(personId, productIds, months = 3) {
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    return this.db.recentHandouts(personId, [...new Set(productIds)], since.toISOString());
  }

  exchangeHandout(h, newSize, quantity, locationId) {
    return this.db.exchangeHandout(h.id, newSize, quantity, locationId);
  }

  deleteHandout(h, returnToStock) {
    return this.db.deleteHandout(h.id, returnToStock);
  }

  transfer({ fromId, toId, items, reason }) {
    return this.db.transfer({ fromId, toId, items, reason });
  }

  locName(id) { return (this.location(id) || {}).Title || ''; }
}

// Size types that existed before sizes became configurable, with their own database columns.
const LEGACY_SIZE_COLUMNS = { Boots: 'BootsSize', Jacket: 'JacketSize', Trousers: 'TrouserSize', Vest: 'VestSize', Gloves: 'GlovesSize' };

export function parseSizes(s) {
  return String(s || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
}

function sortByTitle(rows) {
  return rows.sort((a, b) => (a.Title || '').localeCompare(b.Title || ''));
}
