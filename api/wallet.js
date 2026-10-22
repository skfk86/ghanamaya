// غنماية — المحفظة الرقمية (كل العمليات المالية من السيرفر فقط)
// POST /api/wallet  مع  Authorization: Bearer <ID token>  والجسم {"action": "...", ...}
// متغيرات البيئة: OXAPAY_MERCHANT_KEY ، OXAPAY_SANDBOX=true (للتجربة)
import { FieldValue } from 'firebase-admin/firestore';
import { cors, verifyToken, adminDb } from './_firebase.js';
import { tryAutoPayout } from './_payout.js';
import { pushTo, pushRelease, pushRefund, usd } from './_push.js';
import { PLATFORM, fmt, walletSettings, readWallet, writeWallet, logTx, releaseEscrow, refundEscrow } from './_ledger.js';

const BASE = 'https://ghanamaya.vercel.app';
class UserError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const TRC20 = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const tok = await verifyToken(req);
  if (!tok) return res.status(401).json({ error: 'سجّل الدخول أولاً' });
  const uid = tok.uid, isAdmin = tok.admin === true;
  const body = req.body || {};
  const db = adminDb();

  try {
    const me = await db.doc(`users/${uid}`).get();
    if (!me.exists) throw new UserError('أكمل ملفك أولاً', 403);
    if (me.get('banned') === true && !isAdmin) throw new UserError('حسابك موقوف', 403);
    const fn = ACTIONS[body.action];
    if (!fn) throw new UserError('عملية غير معروفة');
    if (fn.admin && !isAdmin) throw new UserError('غير مصرّح', 403);
    const out = await fn({ db, uid, body, me });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof UserError) return res.status(e.code).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'حدث خطأ، حاول مرة أخرى' });
  }
}

/* ---------- مساعد: يقرأ الطلب ويتحقق من صلاحية المنفّذ ---------- */
async function loadOrder(t, db, orderId, uid, role, allowed) {
  if (typeof orderId !== 'string' || !orderId) throw new UserError('طلب غير صالح');
  const ref = db.doc(`orders/${orderId}`);
  const s = await t.get(ref);
  if (!s.exists) throw new UserError('الطلب غير موجود', 404);
  const o = s.data();
  if (o.paymentMethod !== 'wallet') throw new UserError('هذا الطلب ليس بالمحفظة');
  if (role === 'buyer' && o.buyerId !== uid) throw new UserError('غير مصرّح', 403);
  if (role === 'seller' && o.sellerId !== uid) throw new UserError('غير مصرّح', 403);
  if (allowed && !allowed.includes(o.status)) throw new UserError('لا يمكن تنفيذ هذا الإجراء الآن', 409);
  return { ref, o };
}

const ACTIONS = {
  /* ===== إيداع: ينشئ فاتورة OxaPay ===== */
  async deposit({ db, uid, body }) {
    const key = process.env.OXAPAY_MERCHANT_KEY;
    if (!key) throw new UserError('الإيداع غير مفعّل بعد', 503);
    const set = await walletSettings(db);
    const cents = Math.round(Number(body.amount) * 100);
    if (!(cents >= 100) || cents > set.maxDeposit) throw new UserError(`المبلغ بين 1 و ${fmt(set.maxDeposit)} USDT`);
    const ref = db.collection('deposits').doc();
    const sandbox = process.env.OXAPAY_SANDBOX === 'true';
    const r = await fetch('https://api.oxapay.com/v1/payment/invoice', {
      method: 'POST',
      headers: { merchant_api_key: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: cents / 100, currency: 'USDT', lifetime: 60, fee_paid_by_payer: 1,
        order_id: ref.id, callback_url: `${BASE}/api/oxapay-webhook`,
        description: `غنماية: شحن محفظة ${uid}`, thanks_message: 'تم شحن محفظتك في غنماية. عُد إلى التطبيق.',
        sandbox
      })
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.data || !out.data.payment_url) {
      console.error('oxapay', r.status, JSON.stringify(out).slice(0, 300));
      throw new UserError('تعذّر إنشاء فاتورة الدفع', 502);
    }
    await ref.set({
      uid, amount: cents, trackId: String(out.data.track_id), paymentUrl: out.data.payment_url,
      status: 'pending', sandbox, expiresAt: out.data.expired_at || null, createdAt: FieldValue.serverTimestamp()
    });
    return { paymentUrl: out.data.payment_url, depositId: ref.id, sandbox };
  },

  /* ===== حجز مبلغ طلب جديد من رصيد المشتري ===== */
  async hold({ db, uid, body }) {
    const set = await walletSettings(db);
    if (!set.sdgPerUsdt) throw new UserError('الدفع بالمحفظة غير متاح حالياً', 503);
    return db.runTransaction(async (t) => {
      const { ref, o } = await loadOrder(t, db, body.orderId, uid, 'buyer', ['pending']);
      if (o.escrow) throw new UserError('المبلغ محجوز مسبقاً', 409);
      const sel = await t.get(db.collection('users').doc(o.sellerId));
      if (sel.exists && sel.data().walletOff) throw new UserError('البائع لا يقبل الدفع بالمحفظة', 409);
      const amount = Math.ceil(o.total / set.sdgPerUsdt * 100);
      const w = await readWallet(t, db, uid);
      if (w.balance < amount) throw new UserError(`رصيدك غير كافٍ. المطلوب ${fmt(amount)} USDT`, 402);
      w.balance -= amount; w.held += amount;
      writeWallet(t, w, {});
      logTx(t, db, uid, 'hold', -amount, { orderId: ref.id, note: o.title });
      t.update(ref, { escrow: { amount, rate: set.sdgPerUsdt, status: 'held' }, updatedAt: FieldValue.serverTimestamp() });
      return { amount };
    });
  },

  /* ===== البائع يقبل ===== */
  async accept({ db, uid, body }) {
    return db.runTransaction(async (t) => {
      const { ref, o } = await loadOrder(t, db, body.orderId, uid, 'seller', ['pending']);
      if (!o.escrow || o.escrow.status !== 'held') throw new UserError('المبلغ غير محجوز', 409);
      t.update(ref, { status: 'accepted', acceptedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return {};
    });
  },

  /* ===== رفض البائع / إلغاء أحد الطرفين ⇒ استرداد كامل للمشتري ===== */
  async reject({ db, uid, body }) { return refundBy(db, uid, body, 'seller', ['pending'], 'rejected'); },
  async cancel({ db, uid, body }) {
    const s = await db.doc(`orders/${body.orderId}`).get();
    const role = s.exists && s.get('sellerId') === uid ? 'seller' : 'buyer';
    return refundBy(db, uid, body, role, role === 'buyer' ? ['pending'] : ['pending', 'accepted'], 'cancelled');
  },

  /* ===== المشتري يؤكد الاستلام ⇒ تحرير المبلغ للبائع ===== */
  async complete({ db, uid, body }) {
    const set = await walletSettings(db);
    let done = null;
    await db.runTransaction(async (t) => {
      const { ref, o } = await loadOrder(t, db, body.orderId, uid, 'buyer', ['accepted']);
      const buyerW = await readWallet(t, db, o.buyerId), sellerW = await readWallet(t, db, o.sellerId), platW = await readWallet(t, db, PLATFORM);
      const fee = releaseEscrow(t, db, { orderRef: ref, order: o, buyerW, sellerW, platW, rate: set.commissionRate, by: 'buyer' });
      done = { o: { ...o, id: ref.id }, fee };
    });
    if (done) await pushRelease(db, done.o, done.fee);
    return { amount: done ? done.o.escrow.amount : 0 };
  },

  /* ===== المشتري يفتح نزاعاً ⇒ يتجمّد المبلغ حتى قرار الأدمن ===== */
  async dispute({ db, uid, body }) {
    const reason = String(body.reason || '').slice(0, 500);
    if (reason.length < 5) throw new UserError('اشرح المشكلة باختصار');
    return db.runTransaction(async (t) => {
      const { ref } = await loadOrder(t, db, body.orderId, uid, 'buyer', ['accepted']);
      t.update(ref, { status: 'disputed', disputeReason: reason, disputedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return {};
    });
  },

  /* ===== طلب سحب ⇒ يُخصم فوراً ويُراجع يدوياً ===== */
  async withdraw({ db, uid, body, me }) {
    const set = await walletSettings(db);
    const cents = Math.round(Number(body.amount) * 100);
    const address = String(body.address || '').trim();
    if (!(cents >= set.minWithdraw)) throw new UserError(`أقل مبلغ للسحب ${fmt(set.minWithdraw)} USDT`);
    if (!TRC20.test(address)) throw new UserError('عنوان TRC20 غير صحيح (يبدأ بحرف T)');
    const pending = await db.collection('withdrawals').where('uid', '==', uid).where('status', '==', 'pending').get();
    if (!pending.empty) throw new UserError('لديك طلب سحب قيد المراجعة', 409);
    const id = await db.runTransaction(async (t) => {
      const w = await readWallet(t, db, uid);
      if (w.balance < cents) throw new UserError('رصيدك غير كافٍ', 402);
      w.balance -= cents;
      writeWallet(t, w, {});
      const wref = db.collection('withdrawals').doc();
      t.set(wref, { uid, amount: cents, address, network: 'TRC20', status: 'pending', createdAt: FieldValue.serverTimestamp() });
      logTx(t, db, uid, 'withdraw', -cents, { withdrawalId: wref.id, note: address });
      return wref.id;
    });
    const r = await tryAutoPayout(db, set, { id, uid, me, cents, address, callbackUrl: `${BASE}/api/oxapay-webhook` });
    return { withdrawalId: id, auto: r.auto };
  },

  /* ===== الأدمن: حسم نزاع ===== */
  resolve: Object.assign(async ({ db, body }) => {
    const set = await walletSettings(db);
    let done = null;
    await db.runTransaction(async (t) => {
      const { ref, o } = await loadOrder(t, db, body.orderId, null, 'admin', ['disputed', 'accepted', 'pending']);
      const buyerW = await readWallet(t, db, o.buyerId);
      if (body.to === 'seller') {
        const sellerW = await readWallet(t, db, o.sellerId), platW = await readWallet(t, db, PLATFORM);
        done = { o: { ...o, id: ref.id }, fee: releaseEscrow(t, db, { orderRef: ref, order: o, buyerW, sellerW, platW, rate: set.commissionRate, by: 'admin' }) };
      } else if (body.to === 'buyer') {
        refundEscrow(t, db, { orderRef: ref, order: o, buyerW, status: 'cancelled', reason: String(body.note || 'حُسم النزاع لصالح المشتري'), by: 'admin' });
        done = { o: { ...o, id: ref.id }, refund: true };
      } else throw new UserError('حدد الطرف');
    });
    if (done) await (done.refund ? pushRefund(db, done.o) : pushRelease(db, done.o, done.fee));
    return {};
  }, { admin: true }),

  /* ===== الأدمن: قرار طلب سحب ===== */
  withdrawDecide: Object.assign(async ({ db, uid, body }) => {
    let w = null;
    await db.runTransaction(async (t) => {
      const ref = db.doc(`withdrawals/${body.id}`);
      const s = await t.get(ref);
      if (!s.exists || s.get('status') !== 'pending') throw new UserError('الطلب غير موجود أو تم البت فيه', 409);
      w = s.data();
      if (body.decision === 'sent') {
        const txHash = String(body.txHash || '').trim();
        if (txHash.length < 10) throw new UserError('أدخل رقم المعاملة (TX hash)');
        t.update(ref, { status: 'sent', txHash, decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
      } else if (body.decision === 'rejected') {
        const wal = await readWallet(t, db, w.uid);
        wal.balance += w.amount;
        writeWallet(t, wal, {});
        logTx(t, db, w.uid, 'withdraw_refund', w.amount, { withdrawalId: ref.id, note: String(body.note || '') });
        t.update(ref, { status: 'rejected', note: String(body.note || ''), decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
      } else throw new UserError('قرار غير صالح');
    });
    if (w) await pushTo(db, w.uid, body.decision === 'sent'
      ? { title: '✅ تم تحويل سحبك بنجاح', body: `${usd(w.amount)} USDT في طريقها لمحفظتك (TRC20). تصل خلال دقائق`, data: { kind: 'withdraw_sent', amount: w.amount }, tag: `wd-${body.id}` }
      : { title: 'أُعيد مبلغ السحب لرصيدك', body: `+${usd(w.amount)} USDT عادت لمحفظتك.${body.note ? ' السبب: ' + String(body.note).slice(0, 80) : ''}`, data: { kind: 'withdraw_rejected', amount: w.amount }, tag: `wd-${body.id}` });
    return {};
  }, { admin: true })
};

async function refundBy(db, uid, body, role, allowed, status) {
  let done = null;
  await db.runTransaction(async (t) => {
    const { ref, o } = await loadOrder(t, db, body.orderId, uid, role, allowed);
    if (!o.escrow || o.escrow.status !== 'held') {
      // لم يُحجز شيء (فشل الحجز): إلغاء بدون حركة مال
      t.update(ref, { status, cancelReason: String(body.reason || ''), updatedAt: FieldValue.serverTimestamp() });
      return {};
    }
    const buyerW = await readWallet(t, db, o.buyerId);
    refundEscrow(t, db, { orderRef: ref, order: o, buyerW, status, reason: String(body.reason || ''), by: role });
    done = { ...o, id: ref.id };
  });
  if (done) await pushRefund(db, done);
  return {};
}
