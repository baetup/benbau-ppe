// Data access on SharePoint lists through Microsoft Graph.
// Rows are plain objects: { id, etag, Title, ...columns }.
import { LISTS } from './schema.js';

export class SharePointDb {
  constructor(graph, siteUrl) {
    this.graph = graph;
    this.siteUrl = siteUrl;
    this.listIds = {};
  }

  // Resolves the site and the list ids. Returns the keys of lists that do not exist yet.
  async connect() {
    if (!this.siteUrl || this.siteUrl.includes('YOURTENANT')) throw new Error('siteUrl is not set in config.js');
    const u = new URL(this.siteUrl);
    const path = u.pathname.replace(/\/+$/, '');
    const site = await this.graph.get(path ? `/sites/${u.hostname}:${path}` : `/sites/${u.hostname}`);
    this.siteId = site.id;
    const lists = await this.graph.getAll(`/sites/${this.siteId}/lists?$select=id,displayName`);
    const missing = [];
    for (const [key, def] of Object.entries(LISTS)) {
      const l = lists.find(x => x.displayName === def.title);
      if (l) this.listIds[key] = l.id; else missing.push(key);
    }
    return missing;
  }

  // Creates missing lists and adds missing columns to existing ones.
  async provision(onProgress = () => {}) {
    const g = this.graph.withScopes(['Sites.Manage.All']);
    const lists = await g.getAll(`/sites/${this.siteId}/lists?$select=id,displayName`);
    for (const [key, def] of Object.entries(LISTS)) {
      let l = lists.find(x => x.displayName === def.title);
      if (!l) {
        onProgress(`Creating list ${def.title}…`);
        l = await g.post(`/sites/${this.siteId}/lists`, {
          displayName: def.title,
          list: { template: 'genericList' },
          columns: def.columns.map(colDef),
        });
      } else {
        onProgress(`Checking list ${def.title}…`);
        const cols = await g.getAll(`/sites/${this.siteId}/lists/${l.id}/columns?$select=name`);
        for (const c of def.columns) {
          if (!cols.some(x => x.name === c.name)) await g.post(`/sites/${this.siteId}/lists/${l.id}/columns`, colDef(c));
        }
      }
      this.listIds[key] = l.id;
    }
  }

  items(table) {
    const id = this.listIds[table];
    if (!id) throw new Error(`SharePoint list ${LISTS[table].title} was not found`);
    return `/sites/${this.siteId}/lists/${id}/items`;
  }

  async list(table, filter) {
    let url = `${this.items(table)}?$expand=fields&$top=999`;
    const headers = {};
    if (filter && Object.keys(filter).length) {
      const expr = Object.entries(filter)
        .map(([k, v]) => `fields/${k} eq ${typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v}`)
        .join(' and ');
      url += '&$filter=' + encodeURIComponent(expr);
      headers.Prefer = 'HonorNonIndexedQueriesWarningMayFailRandomly';
    }
    return (await this.graph.getAll(url, headers)).map(norm);
  }

  async get(table, id) {
    return norm(await this.graph.get(`${this.items(table)}/${id}?$expand=fields`));
  }

  async create(table, fields) {
    return norm(await this.graph.post(this.items(table), { fields: clean(fields, true) }));
  }

  // etag enables optimistic concurrency: a 412 error means someone else changed the row.
  async update(table, id, fields, etag) {
    const r = await this.graph.patch(`${this.items(table)}/${id}/fields`, clean(fields, false), etag ? { 'If-Match': etag } : {});
    return { ...stripOdata(r), id: Number(id) };
  }

  async remove(table, id) {
    await this.graph.del(`${this.items(table)}/${id}`);
  }
}

function colDef(c) {
  const d = { name: c.name };
  if (c.indexed) d.indexed = true;
  switch (c.type) {
    case 'text': d.text = {}; break;
    case 'note': d.text = { allowMultipleLines: true, linesForEditing: 6 }; break;
    case 'number': d.number = {}; break;
    case 'boolean': d.boolean = {}; break;
    case 'dateTime': d.dateTime = { format: 'dateTime' }; break;
  }
  return d;
}

function stripOdata(f) {
  const out = {};
  for (const [k, v] of Object.entries(f || {})) if (!k.startsWith('@odata')) out[k] = v;
  return out;
}

function norm(item) {
  return { ...stripOdata(item.fields), id: Number(item.id), etag: item.eTag || (item.fields && item.fields['@odata.etag']) };
}

function clean(fields, dropNull) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || k === 'etag' || v === undefined || (dropNull && v === null)) continue;
    out[k] = v;
  }
  return out;
}
