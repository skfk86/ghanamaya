// Fake Firebase (app/auth/firestore) for UI previews
const SEED = window.__SEED || {};
const store = new Map(Object.entries(SEED.docs || {}));
const listeners = new Set();
let seq = 0;
class Ts { constructor(ms) { this._ms = ms; this.seconds = Math.floor(ms / 1000); } toMillis() { return this._ms; } toDate() { return new Date(this._ms); } }
const conv = (v) => v && typeof v === 'object' && v.__ts != null ? new Ts(v.__ts) : Array.isArray(v) ? v.map(conv) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])) : v;
for (const [k, v] of store) store.set(k, conv(v));
const SRV = { __srv: 1 };
const res = (v) => v === SRV ? new Ts(Date.now()) : Array.isArray(v) ? v.map(res) : v && typeof v === 'object' && !(v instanceof Ts) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, res(x)])) : v;
export const initializeApp = () => ({});
// ---- auth ----
const user = SEED.user ? { ...SEED.user, getIdToken: async () => 'tok', getIdTokenResult: async () => ({ claims: SEED.claims || {} }) } : null;
const authObj = { currentUser: user };
export const getAuth = () => authObj;
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(user), 0); return () => {}; };
export class GoogleAuthProvider { static credential() { return {}; } }
export const signInWithPopup = async () => {}, signInWithCredential = async () => {}, createUserWithEmailAndPassword = async () => {}, signInWithEmailAndPassword = async () => {}, sendPasswordResetEmail = async () => {}, updateProfile = async () => {}, signOut = async () => {};
// ---- firestore ----
export const getFirestore = () => ({});
const path = (segs) => segs.filter(s => typeof s === 'string').join('/');
export function doc(base, ...segs) { if (base && base.type === 'col' && !segs.length) return { type: 'doc', path: base.path + '/auto' + (++seq), id: 'auto' + seq }; const p = base && base.path ? [base.path, ...segs].join('/') : path(segs); return { type: 'doc', path: p, id: p.split('/').pop() }; }
export function collection(base, ...segs) { const p = base && base.path ? [base.path, ...segs].join('/') : path(segs); return { type: 'col', path: p }; }
export const where = (f, op, v) => ({ k: 'w', f, op, v }), orderBy = (f, d = 'asc') => ({ k: 'o', f, d }), limit = (n) => ({ k: 'l', n });
export const query = (col, ...c) => ({ type: 'q', path: col.path, c });
export const serverTimestamp = () => SRV;
const gp = (o, f) => f.split('.').reduce((a, k) => a == null ? undefined : a[k], o);
const val = (x) => x instanceof Ts ? x._ms : x;
const snapDoc = (p) => { const d = store.get(p); return { id: p.split('/').pop(), ref: { path: p, id: p.split('/').pop() }, exists: () => d !== undefined, data: () => d && JSON.parse(JSON.stringify(d), (k, v) => v && v._ms != null ? new Ts(v._ms) : v), get: (f) => gp(d || {}, f) }; };
function runQ(q) {
  const pre = q.path + '/';
  let rows = [...store.keys()].filter(p => p.startsWith(pre) && !p.slice(pre.length).includes('/'));
  for (const c of (q.c || [])) {
    if (c.k === 'w') rows = rows.filter(p => { const x = gp(store.get(p), c.f); return c.op === '==' ? x === c.v : c.op === 'in' ? c.v.includes(x) : c.op === 'array-contains' ? (x || []).includes(c.v) : true; });
    if (c.k === 'o') rows.sort((a, b) => (val(gp(store.get(a), c.f)) > val(gp(store.get(b), c.f)) ? 1 : -1) * (c.d === 'desc' ? -1 : 1));
    if (c.k === 'l') rows = rows.slice(0, c.n);
  }
  const docs = rows.map(snapDoc);
  return { docs, empty: !docs.length, size: docs.length, forEach: (f) => docs.forEach(f), docChanges: () => [] };
}
export const getDoc = async (r) => snapDoc(r.path);
export const getDocs = async (q) => runQ(q.type === 'col' ? { path: q.path, c: [] } : q);
const notify = () => listeners.forEach(f => f());
export const setDoc = async (r, d, o) => { store.set(r.path, { ...(o && o.merge ? store.get(r.path) : {}), ...res(d) }); notify(); };
export const addDoc = async (c, d) => { const r = doc(c); await setDoc(r, d); return r; };
export const updateDoc = async (r, d) => { store.set(r.path, { ...store.get(r.path), ...res(d) }); notify(); };
export const deleteDoc = async (r) => { store.delete(r.path); notify(); };
export function onSnapshot(r, cb) { const run = () => cb(r.type === 'doc' ? snapDoc(r.path) : runQ(r.type === 'col' ? { path: r.path, c: [] } : r)); setTimeout(run, 0); listeners.add(run); return () => listeners.delete(run); }
export const writeBatch = () => { const w = []; return { set: (r, d, o) => w.push(() => setDoc(r, d, o)), update: (r, d) => w.push(() => updateDoc(r, d)), delete: (r) => w.push(() => deleteDoc(r)), commit: async () => { for (const f of w) await f(); } }; };
export const increment = (n) => n;
export const getCountFromServer = async (q) => { const r = runQ(q); return { data: () => ({ count: r.size }) }; };
