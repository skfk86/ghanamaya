// غنماية — البائعون والحماية من السبام (كل الإنشاءات الحساسة من السيرفر)
// POST /api/seller  مع  Authorization: Bearer <ID token>  والجسم {"action": "...", ...}
//
// - apply: طلب تفعيل حساب بائع ⇒ رمز يرسله البائع من رقمه عبر واتساب، والأدمن يؤكد
// - createListing: إنشاء إعلان بحدود (البائع الجديد/الموثّق)، أول إعلان يُراجَع، كشف المكرر والصور المسروقة
// - startChat: بدء محادثة بحد يومي (يمنع إغراق البائعين)
// - kycSubmit: طلب شارة التوثيق بصورة الهوية + سيلفي (ملفات خاصة في ImageKit)
// - للأدمن: sellerDecide, listingDecide, kycUrls
import { createHmac, randomInt } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { cors, verifyToken, adminDb } from './_firebase.js';
import { pushTo, pushResult } from './_push.js';
import { deleteAccount, deletionBlockers, phoneHash } from './_account.js';
import { applyStock } from './_stock.js';
import { ensureIndexes } from './_indexes.js';

const IK_ENDPOINT = 'https://ik.imagekit.io/7uwbsw4wl/';
const DAY = 86400000;
class UserError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;

// الحدود: البائع الجديد مقيّد، وتتسع مع التوثيق
export const LIMITS = {
  unverified: { active: 3, perDay: 2 },
  verified: { active: 30, perDay: 10 },
  chatsPerDay: { newUser: 8, normal: 25 },  // محادثات جديدة يومياً
  newUserDays: 7
};
const TYPES = { goat: ['شامي', 'نوبي', 'صحراوي', 'بلدي'], sheep: ['حمري', 'كباشي', 'زغاوي', 'بلدي'], cattle: ['كناني', 'بطانة', 'بقارة', 'بلدي'], camel: ['عنافي', 'بشاري', 'بلدي'] };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const tok = await verifyToken(req);
  if (!tok) return res.status(401).json({ error: 'سجّل الدخول أولاً' });
  const uid = tok.uid, isAdmin = tok.admin === true, body = req.body || {}, db = adminDb();
  try {
    const me = await db.doc(`users/${uid}`).get();
    // حذف الحساب متاح حتى لمن لم يكمل ملفه أو المُوقَف
    if (body.action === 'deleteMe') return res.status(200).json({ ok: true, ...(await deleteMe({ db, uid, tok, body })) });
    if (!me.exists) throw new UserError('أكمل ملفك أولاً', 403);
    if (me.get('banned') === true && !isAdmin) throw new UserError('حسابك موقوف', 403);
    const fn = ACTIONS[body.action];
    if (!fn) throw new UserError('عملية غير معروفة');
    if (fn.admin && !isAdmin) throw new UserError('غير مصرّح', 403);
    return res.status(200).json({ ok: true, ...(await fn({ db, uid, me, body })) });
  } catch (e) {
    if (e instanceof UserError) return res.status(e.code).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'حدث خطأ، حاول مرة أخرى' });
  }
}

function normPhone(v) {
  let p = String(v || '').replace(/[\s-]/g, '');
  if (/^0\d{9}$/.test(p)) p = '+249' + p.slice(1);
  if (/^249\d{9}$/.test(p)) p = '+' + p;
  return /^\+\d{9,15}$/.test(p) ? p : null;
}
const admin = (f) => Object.assign(f, { admin: true });

// تقسيم البصمة لـ 8 أجزاء (كل جزء 8 بت). صورتان بفرق ≤ 6 بتات تشتركان حتماً في جزأين على الأقل
export const bands = (h) => /^[0-9a-f]{16}$/.test(h || '') ? Array.from({ length: 8 }, (_, i) => `${i}:${h.slice(i * 2, i * 2 + 2)}`) : [];
// فرق البتات بين بصمتين (dHash 64 بت بصيغة hex)
export function hamming(a, b) {
  if (!/^[0-9a-f]{16}$/.test(a || '') || !/^[0-9a-f]{16}$/.test(b || '')) return 64;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

export const ACTIONS = {
  /* ===== طلب تفعيل حساب بائع ===== */
  async apply({ db, uid, me, body }) {
    if (me.get('isSeller') === true) throw new UserError('حسابك بائع مفعّل مسبقاً', 409);
    const storeName = String(body.storeName || '').trim(), whatsapp = normPhone(body.whatsapp);
    if (!str(storeName, 2, 60)) throw new UserError('اكتب اسم المتجر');
    if (!whatsapp) throw new UserError('رقم واتساب غير صحيح');
    // الرقم مستخدم لبائع آخر؟
    if ((await db.doc(`blockedPhones/${phoneHash(whatsapp)}`).get()).exists) throw new UserError('هذا الرقم موقوف من الإدارة', 403);
    const used = await db.collection('users').where('whatsapp', '==', whatsapp).get();
    if (used.docs.some(d => d.id !== uid)) throw new UserError('هذا الرقم مسجّل لحساب بائع آخر', 409);
    const ref = db.doc(`sellerApps/${uid}`);
    const old = await ref.get();
    // لا تغيير للرمز عند إعادة الإرسال بنفس الرقم (حتى لا يضيع رمز أُرسل فعلاً)
    const keep = old.exists && old.get('status') === 'pending' && old.get('whatsapp') === whatsapp;
    const code = keep ? old.get('code') : String(randomInt(100000, 999999));
    await ref.set({ uid, name: me.get('name'), storeName, whatsapp, code, status: 'pending', city: me.get('city') || '', state: me.get('state') || '', createdAt: FieldValue.serverTimestamp() }, { merge: false });
    const app = await db.doc('settings/app').get();
    return { code, whatsapp, support: (app.exists && app.get('supportWhatsapp')) || '' };
  },

  /* ===== الأدمن: قبول أو رفض تفعيل البائع ===== */
  sellerDecide: admin(async ({ db, body }) => {
    const ref = db.doc(`sellerApps/${body.uid}`);
    const s = await ref.get();
    if (!s.exists || s.get('status') !== 'pending') throw new UserError('الطلب غير موجود أو تم البت فيه', 409);
    const a = s.data();
    if (body.decision === 'approve') {
      const batch = db.batch();
      batch.update(db.doc(`users/${body.uid}`), { isSeller: true, storeName: a.storeName, whatsapp: a.whatsapp, sellerSince: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      batch.update(ref, { status: 'approved', decidedAt: FieldValue.serverTimestamp() });
      await batch.commit();
      await pushTo(db, body.uid, { title: '🎉 تم تفعيل حساب البائع', body: 'يمكنك الآن نشر إعلاناتك. أول إعلان يُراجع سريعاً قبل النشر.', data: { kind: 'seller' }, tag: 'seller' });
    } else if (body.decision === 'reject') {
      const note = String(body.note || 'لم نتمكن من تأكيد الرقم').slice(0, 200);
      await ref.update({ status: 'rejected', note, decidedAt: FieldValue.serverTimestamp() });
      await pushTo(db, body.uid, { title: 'لم يُفعّل حساب البائع', body: `${note}. يمكنك إعادة المحاولة من حسابك.`, data: { kind: 'seller' }, tag: 'seller' });
    } else throw new UserError('قرار غير صالح');
    return {};
  }),

  /* ===== إنشاء إعلان ===== */
  async createListing({ db, uid, me, body }) {
    if (me.get('isSeller') !== true) throw new UserError('فعّل حساب البائع أولاً', 403);
    const d = body.data || {}, verified = me.get('verified') === true;
    // التحقق من الحقول (نفس قواعد التطبيق)
    if (!TYPES[d.type] || !TYPES[d.type].includes(d.breed)) throw new UserError('النوع أو السلالة غير صحيحة');
    if (!['m', 'f'].includes(d.sex)) throw new UserError('حدد الجنس');
    if (!Number.isInteger(d.ageMonths) || d.ageMonths < 0 || d.ageMonths > 300) throw new UserError('العمر غير صحيح');
    if (typeof d.weightKg !== 'number' || !(d.weightKg > 0 && d.weightKg <= 2000)) throw new UserError('الوزن غير صحيح');
    if (!Number.isInteger(d.price) || d.price <= 0 || d.price > 1e11) throw new UserError('السعر غير صحيح');
    if (!Number.isInteger(d.qty) || d.qty < 1 || d.qty > 999) throw new UserError('الكمية غير صحيحة');
    if (!str(d.state, 2, 40) || !str(d.city, 2, 60)) throw new UserError('حدد الموقع');
    const description = String(d.description || '').trim().slice(0, 1000);
    const images = Array.isArray(d.images) ? d.images.slice(0, 6) : [];
    if (!images.length || !images.every(i => i && typeof i.url === 'string' && i.url.startsWith(`${IK_ENDPOINT}listings/${uid}/`))) throw new UserError('الصور غير صالحة');
    const dhash = /^[0-9a-f]{16}$/.test(body.dhash || '') ? body.dhash : '';

    const lim = verified ? LIMITS.verified : LIMITS.unverified;
    const mine = await db.collection('listings').where('sellerId', '==', uid).get();
    const live = mine.docs.filter(x => ['active', 'pending'].includes(x.get('status')));
    if (live.length >= lim.active) throw new UserError(verified ? `وصلت للحد الأقصى (${lim.active} إعلاناً نشطاً). علّم المباع أو احذف القديم.` : `البائع غير الموثّق يُسمح له بـ ${lim.active} إعلانات نشطة. وثّق حسابك لترفع الحد.`, 429);
    const today = mine.docs.filter(x => ms(x.get('createdAt')) > Date.now() - DAY).length;
    if (today >= lim.perDay) throw new UserError(`الحد ${lim.perDay} إعلانات جديدة في اليوم. حاول غداً.`, 429);

    // مكرر من نفس البائع: نفس النوع والسلالة والسعر والوصف، أو نفس الصورة تقريباً
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    if (live.some(x => x.get('type') === d.type && x.get('breed') === d.breed && x.get('price') === d.price && norm(x.get('description')) === norm(description)))
      throw new UserError('لديك إعلان مطابق منشور. عدّل الكمية فيه بدل تكراره.', 409);
    if (dhash && live.some(x => hamming(x.get('dhash'), dhash) <= 4)) throw new UserError('هذه الصورة مستخدمة في إعلان آخر لك. عدّل الإعلان القائم بدل تكراره.', 409);

    // صور تشبه إعلاناً لبائع آخر ⇒ مراجعة (ربما صور مسروقة من الإنترنت أو من بائع آخر)
    let review = '';
    if (me.get('firstListingOk') !== true) review = 'أول إعلان للبائع';
    if (dhash) {
      // بحث سريع بالأجزاء (LSH): لا نقرأ كل الإعلانات، فقط التي تشترك في جزء من البصمة
      const others = await db.collection('listings').where('dhashBands', 'array-contains-any', bands(dhash)).get();
      if (others.docs.some(x => x.get('sellerId') !== uid && ['active', 'pending', 'sold'].includes(x.get('status')) && hamming(x.get('dhash'), dhash) <= 6)) review = 'صورة تشبه إعلاناً لبائع آخر';
    }
    const ref = db.collection('listings').doc();
    await ref.set({
      sellerId: uid, sellerName: me.get('storeName') || me.get('name'), type: d.type, breed: d.breed, sex: d.sex,
      ageMonths: d.ageMonths, weightKg: d.weightKg, price: d.price, qty: d.qty, state: d.state.trim(), city: d.city.trim(),
      description, images: images.map(i => ({ url: i.url, fileId: String(i.fileId || '') })), dhash, dhashBands: bands(dhash),
      status: review ? 'pending' : 'active', ...(review ? { reviewReason: review } : {}),
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    return { id: ref.id, status: review ? 'pending' : 'active', reviewReason: review };
  },

  /* ===== تغيير صور إعلان قائم ⇒ مراجعة قبل الظهور ===== */
  async editImages({ db, uid, me, body }) {
    const ref = db.doc(`listings/${String(body.id || '')}`);
    const s = await ref.get();
    if (!s.exists || s.get('sellerId') !== uid) throw new UserError('غير موجود', 404);
    if (s.get('status') === 'hidden') throw new UserError('الإعلان موقوف من الإدارة', 403);
    const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
    if (!images.length || !images.every(i => i && typeof i.url === 'string' && i.url.startsWith(`${IK_ENDPOINT}listings/${uid}/`))) throw new UserError('الصور غير صالحة');
    const same = JSON.stringify((s.get('images') || []).map(i => i.url)) === JSON.stringify(images.map(i => i.url));
    if (same) return { status: s.get('status') };
    const dhash = /^[0-9a-f]{16}$/.test(body.dhash || '') ? body.dhash : (s.get('dhash') || '');
    const cur = s.get('status');
    await ref.update({
      images: images.map(i => ({ url: i.url, fileId: String(i.fileId || '') })), dhash, dhashBands: bands(dhash),
      status: 'pending', reviewReason: 'تغيير الصور', ...(cur !== 'pending' ? { prevStatus: cur } : {}),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { status: 'pending', reviewReason: 'تغيير الصور' };
  },

  /* ===== بعد اكتمال طلب نقدي/بنكك: خصم الكمية (يستدعيه أي طرف، والسيرفر يتحقق) ===== */
  async applyStock({ db, uid, body }) {
    const o = await db.doc(`orders/${String(body.orderId || '')}`).get();
    if (!o.exists || !(o.get('participants') || []).includes(uid)) throw new UserError('غير مصرّح', 403);
    const r = await applyStock(db, o.id);
    return { soldOut: !!(r && r.soldOut), left: r ? r.left : null };
  },

  /* ===== الأدمن: مراجعة إعلان ===== */
  listingDecide: admin(async ({ db, body }) => {
    const ref = db.doc(`listings/${body.id}`);
    const s = await ref.get();
    if (!s.exists || s.get('status') !== 'pending') throw new UserError('الإعلان غير موجود أو تمت مراجعته', 409);
    const sellerId = s.get('sellerId');
    if (body.decision === 'approve') {
      // تغيير صور إعلان قائم: يعود لحالته السابقة دون تغيير تاريخ النشر
      const back = s.get('prevStatus') === 'sold' ? 'sold' : 'active';
      await ref.update({ status: back, reviewReason: FieldValue.delete(), prevStatus: FieldValue.delete(), approvedAt: FieldValue.serverTimestamp(), ...(s.get('prevStatus') ? {} : { createdAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() });
      await db.doc(`users/${sellerId}`).update({ firstListingOk: true });
      await pushTo(db, sellerId, { title: '✅ نُشر إعلانك', body: 'وافقت الإدارة على إعلانك وأصبح ظاهراً للمشترين.', data: { kind: 'listing' }, tag: `l-${body.id}` });
    } else if (body.decision === 'reject') {
      const note = String(body.note || 'الإعلان مخالف لشروط النشر').slice(0, 200);
      await ref.update({ status: 'hidden', hiddenReason: 'admin', adminNote: note, updatedAt: FieldValue.serverTimestamp() });
      await pushTo(db, sellerId, { title: 'لم يُنشر إعلانك', body: note, data: { kind: 'listing' }, tag: `l-${body.id}` });
    } else throw new UserError('قرار غير صالح');
    return {};
  }),

  /* ===== بدء محادثة (بحد يومي) ===== */
  async startChat({ db, uid, me, body }) {
    const l = await db.doc(`listings/${String(body.listingId || '')}`).get();
    if (!l.exists || l.get('status') !== 'active') throw new UserError('الإعلان غير متاح', 404);
    const sellerId = l.get('sellerId');
    if (sellerId === uid) throw new UserError('هذا إعلانك');
    const id = `${l.id}_${uid}`, ref = db.doc(`chats/${id}`);
    if ((await ref.get()).exists) return { id };
    if ((await db.doc(`users/${sellerId}/blocks/${uid}`).get()).exists) throw new UserError('لا يمكنك مراسلة هذا البائع', 403);
    const isNew = Date.now() - ms(me.get('createdAt')) < LIMITS.newUserDays * DAY;
    const cap = isNew ? LIMITS.chatsPerDay.newUser : LIMITS.chatsPerDay.normal;
    const mine = await db.collection('chats').where('buyerId', '==', uid).get();
    if (mine.docs.filter(c => ms(c.get('createdAt')) > Date.now() - DAY).length >= cap) throw new UserError(`وصلت لحد ${cap} محادثات جديدة اليوم. أكمل محادثاتك الحالية أو حاول غداً.`, 429);
    const seller = await db.doc(`users/${sellerId}`).get();
    const images = l.get('images') || [];
    await ref.set({
      listingId: l.id, buyerId: uid, sellerId, participants: [uid, sellerId],
      buyerName: me.get('name'), sellerName: seller.get('storeName') || seller.get('name') || l.get('sellerName'),
      listingTitle: `${{ goat: 'ماعز', sheep: 'خروف', cattle: 'عجل', camel: 'جمل' }[l.get('type')] || ''} ${l.get('breed')}`.trim(),
      listingImage: (images[0] || {}).url || '', listingPrice: l.get('price'),
      lastMessage: '', lastSenderId: '', readAt: { [uid]: FieldValue.serverTimestamp() },
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    return { id };
  },

  /* ===== طلب شارة التوثيق: هوية + سيلفي (ملفات خاصة) ===== */
  async kycSubmit({ db, uid, me, body }) {
    if (me.get('isSeller') !== true) throw new UserError('للبائعين فقط', 403);
    if (me.get('verified') === true) throw new UserError('حسابك موثّق مسبقاً', 409);
    const ref = db.doc(`verifyRequests/${uid}`);
    const old = await ref.get();
    if (old.exists && old.get('status') === 'pending') throw new UserError('طلبك قيد المراجعة', 409);
    const paths = [body.idPath, body.selfiePath];
    if (!paths.every(p => typeof p === 'string' && p.startsWith(`/kyc/${uid}/`) && !p.includes('..'))) throw new UserError('أرفق صورة الهوية والسيلفي');
    // نتأكد أن الملفين خاصّان فعلاً (لا يمكن فتحهما برابط عادي)
    for (const p of paths) {
      const f = await ikFile(p);
      if (!f) throw new UserError('لم نجد الصورة، أعد رفعها');
      if (f.isPrivateFile !== true) throw new UserError('خطأ في حماية الصورة، أعد رفعها');
    }
    await ref.set({
      uid, name: me.get('name'), storeName: me.get('storeName'), whatsapp: me.get('whatsapp'), state: me.get('state'), city: me.get('city'),
      note: String(body.note || '').slice(0, 500), idPath: paths[0], selfiePath: paths[1], status: 'pending', createdAt: FieldValue.serverTimestamp()
    });
    return {};
  },

  /* ===== الأدمن: قرار شارة التوثيق (من السيرفر، مع إشعار ونتيجته) ===== */
  verifyDecide: admin(async ({ db, body }) => {
    const uid = String(body.uid || ''), note = String(body.note || '').slice(0, 200);
    const u = await db.doc(`users/${uid}`).get();
    if (!u.exists) throw new UserError('المستخدم غير موجود', 404);
    const vref = db.doc(`verifyRequests/${uid}`), v = await vref.get();
    const batch = db.batch();
    let msg;
    if (body.decision === 'approve') {
      batch.update(u.ref, { verified: true, updatedAt: FieldValue.serverTimestamp() });
      if (v.exists) batch.update(vref, { status: 'approved', decidedAt: FieldValue.serverTimestamp() });
      msg = { title: '🎉 مبروك! أصبحت تاجراً موثّقاً', body: 'تظهر الآن شارة التوثيق بجانب اسمك في كل إعلاناتك، وارتفع حد إعلاناتك.' };
    } else if (body.decision === 'reject') {
      if (!v.exists) throw new UserError('لا يوجد طلب', 404);
      batch.update(vref, { status: 'rejected', decisionNote: note || 'لم نتمكن من التحقق', decidedAt: FieldValue.serverTimestamp() });
      msg = { title: 'لم يُقبل طلب التوثيق', body: `${note || 'لم نتمكن من التحقق'}. يمكنك إعادة التقديم من حسابك.` };
    } else if (body.decision === 'revoke') {
      batch.update(u.ref, { verified: false, updatedAt: FieldValue.serverTimestamp() });
      msg = { title: 'أُزيلت شارة التوثيق', body: note || 'للاستفسار تواصل مع دعم غنماية.' };
    } else throw new UserError('قرار غير صالح');
    await batch.commit();
    const r = await pushResult(db, uid, { ...msg, data: { kind: 'verify' }, tag: 'verify', channel: 'orders' });
    return { notified: r.sent, reason: r.reason || '' };
  }),

  /* ===== الأدمن: إنشاء فهارس قاعدة البيانات (مرة واحدة، وكل ما أُضيف فهرس جديد) ===== */
  setupIndexes: admin(async () => ensureIndexes()),

  /* ===== الأدمن: حذف حساب مستخدم نهائياً ===== */
  adminDeleteUser: admin(async ({ db, uid: adminUid, body }) => {
    const target = String(body.uid || '');
    if (!target || target === adminUid) throw new UserError('لا يمكنك حذف حسابك من هنا');
    const blockers = await deletionBlockers(db, target);
    if (blockers.length && body.force !== true) throw new UserError('لا يمكن الحذف الآن: ' + blockers.join('، '), 409);
    if (blockers.length) throw new UserError('الحساب فيه مال أو طلبات جارية: احسمها أولاً من المالية والطلبات', 409);
    return deleteAccount(db, target, { by: 'admin', reason: body.reason });
  }),

  /* ===== الأدمن: روابط مؤقتة لصور التوثيق (10 دقائق) ===== */
  kycUrls: admin(async ({ db, body }) => {
    const s = await db.doc(`verifyRequests/${String(body.uid || '')}`).get();
    if (!s.exists) throw new UserError('غير موجود', 404);
    return { id: signedUrl(s.get('idPath')), selfie: signedUrl(s.get('selfiePath')) };
  })
};

// حذف المستخدم لحسابه: يتطلب دخولاً حديثاً (خلال 5 دقائق) حتى لا يحذفه من سرق جلسة مفتوحة
async function deleteMe({ db, uid, tok, body }) {
  if (body.confirm !== 'حذف') throw new UserError('اكتب كلمة "حذف" للتأكيد');
  if (!tok.auth_time || Date.now() / 1000 - tok.auth_time > 300) throw new UserError('للأمان: سجّل خروجاً ثم دخولاً، ثم احذف الحساب خلال 5 دقائق', 401);
  const blockers = await deletionBlockers(db, uid);
  if (blockers.length) throw new UserError(blockers.join('، '), 409);
  return deleteAccount(db, uid, { by: 'user', reason: body.reason });
}

// رابط موقّع لملف خاص في ImageKit: HMAC-SHA1(المفتاح الخاص، المسار + وقت الانتهاء)
export function signedUrl(path, seconds = 600) {
  if (!path || !process.env.IMAGEKIT_PRIVATE_KEY) return '';
  const rel = String(path).replace(/^\//, '');
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const sig = createHmac('sha1', process.env.IMAGEKIT_PRIVATE_KEY).update(rel + exp).digest('hex');
  return `${IK_ENDPOINT}${rel}?ik-t=${exp}&ik-s=${sig}`;
}

// تفاصيل ملف من ImageKit (للتأكد أنه خاص)
async function ikFile(path) {
  const key = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!key) throw new UserError('خدمة الصور غير مضبوطة', 500);
  const dir = path.slice(0, path.lastIndexOf('/') + 1), name = path.slice(path.lastIndexOf('/') + 1);
  const url = `https://api.imagekit.io/v1/files?path=${encodeURIComponent(dir)}&searchQuery=${encodeURIComponent(`name = "${name}"`)}`;
  const r = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') } });
  if (!r.ok) return null;
  const list = await r.json().catch(() => []);
  return Array.isArray(list) ? list.find(f => f.filePath === path) || null : null;
}
