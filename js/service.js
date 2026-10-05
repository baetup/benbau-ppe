// Business logic on top of a data store (SharePointDb or DemoDb).
export class PpeService {
  constructor(db, user, mailer) {
    this.db = db;
    this.user = user;       // { name, email } of the signed-in user
    this.mailer = mailer;   // async (graphSendMailBody) => void, or null in demo mode
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
      row = { ...cache.find(x => x.id === id), ...(await this.db.update(table, id, fields)) };
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
    for (const r of rows) {
      const k = `${r.ProductId}|${r.Size}`;
      m.set(k, (m.get(k) || 0) + (Number(r.Quantity) || 0));
    }
    return m;
  }

  // Adds delta to a stock row, retrying if someone else changed it at the same time.
  async adjustStock(productId, size, locationId, delta, { allowNegative = false } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = (await this.db.list('stock', { ProductId: productId, LocationId: locationId })).filter(r => r.Size === size);
      const total = rows.reduce((a, r) => a + (Number(r.Quantity) || 0), 0);
      if (!allowNegative && total + delta < 0) {
        throw new Error(`Not enough stock of ${this.label(productId, size)} at ${this.locName(locationId)}. Available: ${total}.`);
      }
      if (!rows.length) {
        return this.db.create('stock', { Title: `${productId}|${size}|${locationId}`, ProductId: productId, Size: size, LocationId: locationId, Quantity: delta });
      }
      const row = rows[0];
      try {
        return await this.db.update('stock', row.id, { Quantity: (Number(row.Quantity) || 0) + delta }, row.etag);
      } catch (e) {
        if (e.status !== 412) throw e;
      }
    }
    throw new Error('Stock was being changed by someone else at the same time. Please try again.');
  }

  async setStock(productId, size, locationId, quantity) {
    const rows = (await this.db.list('stock', { ProductId: productId, LocationId: locationId })).filter(r => r.Size === size);
    const total = rows.reduce((a, r) => a + (Number(r.Quantity) || 0), 0);
    if (quantity !== total) await this.adjustStock(productId, size, locationId, quantity - total, { allowNegative: true });
  }

  async checkAvailability(locationId, items) {
    const stock = await this.getStock(locationId);
    const need = new Map();
    for (const it of items) need.set(`${it.productId}|${it.size}`, (need.get(`${it.productId}|${it.size}`) || 0) + it.qty);
    const problems = [];
    for (const [k, qty] of need) {
      const have = stock.get(k) || 0;
      if (have < qty) {
        const [pid, size] = k.split('|');
        problems.push(`${this.label(Number(pid), size)}: ${have} in stock, ${qty} requested`);
      }
    }
    if (problems.length) throw new Error(`Not enough stock at ${this.locName(locationId)} — ${problems.join('; ')}`);
  }

  // ---------- handouts ----------
  async getHandoutsFor(personId) {
    const rows = await this.db.list('handouts', { PersonnelId: personId });
    return rows.sort((a, b) => (b.HandoutDate || '').localeCompare(a.HandoutDate || ''));
  }

  async handout({ person, locationId, items, reason, notes, date, signature }) {
    await this.checkAvailability(locationId, items);
    const batchId = uuid();
    const created = [];
    try {
      for (const it of items) {
        const p = this.product(it.productId);
        await this.adjustStock(it.productId, it.size, locationId, -it.qty);
        created.push(await this.db.create('handouts', {
          Title: p.Title, BatchId: batchId, PersonnelId: person.id, PersonnelName: person.Title,
          ProductId: p.id, Size: it.size, Quantity: it.qty, LocationId: locationId, LocationName: this.locName(locationId),
          Reason: reason, Notes: notes, HandoutDate: date,
          HandedOutBy: this.user.name, HandedOutByEmail: this.user.email, Signature: signature,
        }));
      }
    } catch (e) {
      if (created.length) e.message += ` (${created.length} of ${items.length} items were saved before the error)`;
      throw e;
    }
    return created;
  }

  async deleteHandout(h, returnToStock) {
    if (returnToStock && h.LocationId) await this.adjustStock(h.ProductId, h.Size, h.LocationId, Number(h.Quantity) || 0, { allowNegative: true });
    await this.db.remove('handouts', h.id);
  }

  // ---------- transfers ----------
  async transfer({ fromId, toId, items, reason, date }) {
    await this.checkAvailability(fromId, items);
    for (const it of items) {
      await this.adjustStock(it.productId, it.size, fromId, -it.qty);
      await this.adjustStock(it.productId, it.size, toId, it.qty, { allowNegative: true });
      await this.db.create('transfers', {
        Title: this.product(it.productId).Title, ProductId: it.productId, Size: it.size, Quantity: it.qty,
        FromLocationId: fromId, FromLocationName: this.locName(fromId), ToLocationId: toId, ToLocationName: this.locName(toId),
        Reason: reason, TransferDate: date, TransferredBy: this.user.name,
      });
    }
  }

  // ---------- email ----------
  async sendReceipt({ to, subject, html, signatureDataUrl }) {
    if (!this.mailer) return; // demo mode
    const attachments = [];
    if (signatureDataUrl && signatureDataUrl.startsWith('data:')) {
      const [meta, b64] = signatureDataUrl.split(',');
      const type = meta.slice(5, meta.indexOf(';'));
      attachments.push({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: type === 'image/png' ? 'signature.png' : 'signature.jpg',
        contentType: type, contentBytes: b64, isInline: true, contentId: 'signature',
      });
    }
    await this.mailer({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }], attachments },
      saveToSentItems: true,
    });
  }

  label(productId, size) { return `${(this.product(productId) || {}).Title || 'Item'} (${size})`; }
  locName(id) { return (this.location(id) || {}).Title || ''; }
}

export function parseSizes(s) {
  return String(s || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
}

function sortByTitle(rows) {
  return rows.sort((a, b) => (a.Title || '').localeCompare(b.Title || ''));
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}
