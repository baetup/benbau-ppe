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

  setStock(productId, size, locationId, quantity) {
    return this.db.setStock(productId, size, locationId, quantity);
  }

  // ---------- handouts & transfers (all-or-nothing) ----------
  async getHandoutsFor(personId) {
    const rows = await this.db.list('handouts', { PersonnelId: personId });
    return rows.sort((a, b) => (b.HandoutDate || '').localeCompare(a.HandoutDate || ''));
  }

  handout({ person, locationId, items, reason, notes, date, signature }) {
    return this.db.handout({ personId: person.id, locationId, items, reason, notes, date, signature });
  }

  deleteHandout(h, returnToStock) {
    return this.db.deleteHandout(h.id, returnToStock);
  }

  transfer({ fromId, toId, items, reason }) {
    return this.db.transfer({ fromId, toId, items, reason });
  }

  locName(id) { return (this.location(id) || {}).Title || ''; }
}

export function parseSizes(s) {
  return String(s || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
}

function sortByTitle(rows) {
  return rows.sort((a, b) => (a.Title || '').localeCompare(b.Title || ''));
}
