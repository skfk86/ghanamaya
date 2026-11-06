// غنماية — السوق من ذاكرة مؤقتة (CDN): كل المستخدمين يأخذون نفس النسخة، والقاعدة تُقرأ مرة كل دقيقة لكل صفحة
// GET /api/feed?t=sheep&st=الخرطوم&sort=0&after=<cursor>
// يعيد الإعلانات النشطة بالحقول اللازمة للبطاقة فقط + بيانات البائع المختصرة (للتوثيق).
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './_firebase.js';

export const PAGE = 24;
const TYPES = ['goat', 'sheep', 'cattle', 'camel'];
const FIELDS = ['sellerId', 'sellerName', 'type', 'breed', 'sex', 'ageMonths', 'weightKg', 'price', 'qty', 'state', 'city', 'description', 'images', 'status', 'featuredUntil', 'negotiable', 'meetPoint'];
const ms = (t) => (t && t.toMillis ? t.toMillis() : null);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const q = req.query || {};
  const t = TYPES.includes(q.t) ? q.t : '';
  const st = typeof q.st === 'string' ? q.st.slice(0, 40) : '';
  const sort = ['0', '1', '2'].includes(String(q.sort)) ? Number(q.sort) : 0;
  const db = adminDb();
  try {
    let ref = db.collection('listings').where('status', '==', 'active');
    if (t) ref = ref.where('type', '==', t);
    if (st) ref = ref.where('state', '==', st);
    ref = sort === 0 ? ref.orderBy('createdAt', 'desc') : ref.orderBy('price', sort === 1 ? 'asc' : 'desc');
    // المؤشر: قيمة الترتيب + معرّف آخر إعلان (لصفحات ثابتة يمكن تخزينها مؤقتاً)
    if (q.after) {
      const [v, id] = String(q.after).split('~');
      const last = await db.doc(`listings/${String(id).replace(/[^A-Za-z0-9_-]/g, '')}`).get();
      if (last.exists) ref = ref.startAfter(last);
      else if (v) ref = ref.startAfter(sort === 0 ? Timestamp.fromMillis(Number(v)) : Number(v));
    }
    const snap = await ref.limit(PAGE).get();
    const items = snap.docs.map(d => {
      const x = d.data(), o = { id: d.id };
      for (const f of FIELDS) if (x[f] !== undefined) o[f] = x[f];
      o.createdAt = ms(x.createdAt); if (o.featuredUntil) o.featuredUntil = ms(o.featuredUntil);
      o.images = (x.images || []).slice(0, 6).map(i => ({ url: i.url }));
      return o;
    });
    // بيانات البائعين المختصرة (الاسم والتوثيق) حتى لا يقرأها كل مستخدم بنفسه
    const ids = [...new Set(items.map(i => i.sellerId))];
    const sellers = {};
    if (ids.length) {
      const docs = await db.getAll(...ids.map(id => db.doc(`users/${id}`)));
      for (const u of docs) if (u.exists) sellers[u.id] = { name: u.get('name') || '', storeName: u.get('storeName') || '', verified: u.get('verified') === true, rating: u.get('rating') || 0 };
    }
    const lastDoc = snap.docs[snap.docs.length - 1];
    const next = snap.size === PAGE && lastDoc ? `${sort === 0 ? ms(lastDoc.get('createdAt')) : lastDoc.get('price')}~${lastDoc.id}` : '';
    // دقيقة طازجة، وتُخدم القديمة 5 دقائق أثناء التحديث
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ items, sellers, next });
  } catch (e) {
    console.error('feed', e.code || e.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(e.code === 9 || /index/i.test(String(e.message)) ? 503 : 500).json({ error: 'feed unavailable', index: /index/i.test(String(e.message)) });
  }
}
