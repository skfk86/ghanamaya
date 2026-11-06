// Minimal in-memory Firestore for tests
const STORE = globalThis.__STORE ||= new Map(); // path -> data
let clock = () => Date.now();
export class Timestamp { constructor(ms) { this._ms = ms; } toMillis() { return this._ms; } toDate() { return new Date(this._ms); } static fromMillis(ms) { return new Timestamp(ms); } static now() { return new Timestamp(clock()); } }
const SERVER = Symbol('serverTimestamp');
const DEL = Symbol('delete');
export const FieldValue = { serverTimestamp: () => SERVER, delete: () => DEL };
const clone = (v) => v instanceof Timestamp ? v : Array.isArray(v) ? v.map(clone) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v;
const resolve = (v) => v === SERVER ? Timestamp.now() : v instanceof Timestamp ? v : Array.isArray(v) ? v.map(resolve) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : v;
const getPath = (o, f) => f.split('.').reduce((a, k) => a == null ? undefined : a[k], o);
let auto = 0;
class Snap { constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; } data() { return this._d === undefined ? undefined : clone(this._d); } get(f) { return clone(getPath(this._d || {}, f)); } }
class DocRef {
  constructor(path) { this.path = path; this.id = path.split('/').pop(); }
  get parent() { return new ColRef(this.path.split('/').slice(0, -1).join('/')); }
  collection(n) { return new ColRef(`${this.path}/${n}`); }
  async get() { return new Snap(this, STORE.get(this.path)); }
  async set(d, o) { applySet(this.path, d, o); }
  async create(d) { if (STORE.has(this.path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }); applySet(this.path, d); }
  async update(d) { applyUpdate(this.path, d); }
  async delete() { STORE.delete(this.path); }
}
function applySet(path, d, o = {}) { const cur = o.merge ? (STORE.get(path) || {}) : {}; STORE.set(path, deepMerge(cur, resolve(d))); }
function deepMerge(a, b) { const out = clone(a); for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !(v instanceof Timestamp) && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !(out[k] instanceof Timestamp) ? deepMerge(out[k], v) : v; return out; }
function applyUpdate(path, d) {
  if (!STORE.has(path)) throw Object.assign(new Error(`NOT_FOUND ${path}`), { code: 5 });
  const cur = clone(STORE.get(path));
  for (const [k, v] of Object.entries(d)) { const parts = k.split('.'); let o = cur; for (const p of parts.slice(0, -1)) o = (o[p] ||= {}); if (v === DEL) delete o[parts.at(-1)]; else o[parts.at(-1)] = resolve(v); }
  STORE.set(path, cur);
}
class Query {
  constructor(col, filters = [], lim = 0, cnt = false, ord = null, after = null) { this.col = col; this.filters = filters; this.lim = lim; this.cnt = cnt; this.ord = ord; this.after = after; }
  where(f, op, v) { return new Query(this.col, [...this.filters, [f, op, v]], this.lim, false, this.ord, this.after); }
  limit(n) { return new Query(this.col, this.filters, n, false, this.ord, this.after); }
  select() { return this; }
  orderBy(f, d = 'asc') { return new Query(this.col, this.filters, this.lim, false, [f, d], this.after); }
  startAfter(x) { return new Query(this.col, this.filters, this.lim, false, this.ord, x); }
  count() { const q = this; return { get: async () => { const s = await q.get(); return { data: () => ({ count: s.size }) }; } }; }
  async get() {
    const prefix = this.col + '/';
    let docs = [...STORE.entries()].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .filter(([, d]) => this.filters.every(([f, op, v]) => { let x = getPath(d, f); if (op === 'array-contains-any') return Array.isArray(x) && v.some(y => x.includes(y)); if (x instanceof Timestamp) x = x.toMillis(); if (v instanceof Timestamp) v = v.toMillis(); return op === '==' ? eq(x, v) : op === 'in' ? v.some(y => eq(x, y)) : op === 'array-contains' ? Array.isArray(x) && x.includes(v) : op === '<=' ? x <= v : op === '>=' ? x >= v : op === '<' ? x < v : op === '>' ? x > v : (() => { throw new Error('op ' + op); })(); }))
      .map(([p, d]) => new Snap(new DocRef(p), d));
    if (this.ord) { const [f, d] = this.ord; const v = (s) => { const x = s.get(f); return x instanceof Timestamp ? x.toMillis() : x; }; docs.sort((a, b) => ((v(a) > v(b)) - (v(a) < v(b))) * (d === 'desc' ? -1 : 1) || (a.id < b.id ? -1 : 1)); }
    if (this.after) { const i = this.after instanceof Snap ? docs.findIndex(d => d.id === this.after.id) : -1; docs = docs.slice(i + 1); }
    if (this.lim) docs = docs.slice(0, this.lim);
    return { docs, empty: !docs.length, size: docs.length, forEach: (f) => docs.forEach(f) };
  }
}
const eq = (a, b) => a instanceof Timestamp && b instanceof Timestamp ? a.toMillis() === b.toMillis() : a === b;
class ColRef extends Query { constructor(path) { super(path); this.path = path; } doc(id) { return new DocRef(`${this.path}/${id || 'auto' + (++auto).toString().padStart(6, '0')}`); } async add(d) { const r = this.doc(); await r.set(d); return r; } }
export const TX_STATS = globalThis.__TXS ||= { runs: 0 };
const db = {
  doc: (p) => new DocRef(p), collection: (p) => new ColRef(p),
  async getAll(...refs) { return Promise.all(refs.map(r => r.get())); },
  async runTransaction(fn) {
    TX_STATS.runs++;
    const writes = []; let wrote = false;
    const t = {
      async get(r) { if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.'); return r instanceof DocRef ? r.get() : r.get(); },
      set(r, d, o) { wrote = true; writes.push(() => applySet(r.path, d, o)); return t; },
      update(r, d) { wrote = true; writes.push(() => applyUpdate(r.path, d)); return t; },
      delete(r) { wrote = true; writes.push(() => STORE.delete(r.path)); return t; }
    };
    const out = await fn(t);
    writes.forEach(w => w());
    return out;
  },
  batch() { const w = []; return { set: (r, d, o) => w.push(() => applySet(r.path, d, o)), update: (r, d) => w.push(() => applyUpdate(r.path, d)), delete: (r) => w.push(() => STORE.delete(r.path)), commit: async () => w.forEach(f => f()) }; }
};
export const getFirestore = () => db;
export const __setClock = (f) => { clock = f; };
