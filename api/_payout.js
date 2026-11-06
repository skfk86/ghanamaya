// غنماية — السحب التلقائي الكامل عبر OxaPay Payout API، مع حماية صارمة
//
// كل سحب يُنفَّذ آلياً. الحماية لا تعتمد على الأدمن بل على:
//  1. سلامة الدفتر: رصيد المستخدم يجب أن يساوي مجموع حركاته. أي اختلاف ⇒ تجميد.
//  2. فترة انتظار أمنية للحالات الحساسة (حساب جديد، إيداع حديث، عنوان جديد، مبلغ كبير):
//     يُبلَّغ المستخدم فوراً ويستطيع الإلغاء، ثم يُرسل تلقائياً عند انتهاء المدة.
//  3. حدود يومية للمستخدم وللمنصة: ما يتجاوزها يُؤجَّل تلقائياً لليوم التالي.
//  4. قاطع دائرة: 3 إخفاقات من OxaPay خلال 24 ساعة ⇒ إيقاف السحب التلقائي حتى يعيده الأدمن.
// التجميد (يحتاج الأدمن) فقط عند: خلل في الدفتر، عنوان مشترك مع حساب آخر، أو فشل/انقطاع من OxaPay.
//
// الحالات: scheduled (ينتظر موعده) → processing (أُرسل لـ OxaPay) → sent
//          frozen (يحتاج الأدمن) ، cancelled (ألغاه المستخدم) ، rejected (رفضه الأدمن)
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { fmt, readWallet, writeWallet, logTx } from './_ledger.js';
import { pushTo } from './_push.js';

const H = 3600000, DAY = 24 * H;
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
const short = (a) => `${a.slice(0, 5)}…${a.slice(-4)}`;
export const OPEN = ['scheduled', 'processing', 'frozen', 'pending'];
const sandbox = () => process.env.OXAPAY_SANDBOX === 'true';

/* ---------- 1. سلامة الدفتر ---------- */
// الرصيد المتاح = مجموع كل الحركات عدا "purchase" (لأنه تحرير من المحجوز وليس من المتاح)
async function ledgerOk(db, uid) {
  const [w, txs] = await Promise.all([db.doc(`wallets/${uid}`).get(), db.collection('transactions').where('uid', '==', uid).get()]);
  const expected = txs.docs.reduce((a, d) => a + (d.get('type') === 'purchase' ? 0 : (d.get('amount') || 0)), 0);
  const actual = w.exists ? (w.get('balance') || 0) : 0;
  return { ok: expected === actual, expected, actual };
}

/* ---------- 2. تقييم المخاطر عند الطلب ---------- */
// يرجع { freeze: 'سبب' } أو { delayH: ساعات, why: [...] }
async function assess(db, set, { uid, me, cents, address, id }) {
  const led = await ledgerOk(db, uid);
  if (!led.ok) return { freeze: `خلل في الدفتر: المتوقع ${fmt(led.expected)} والفعلي ${fmt(led.actual)}` };
  // في التشغيل الحقيقي: رصيد من إيداعات تجريبية لا يُسحب أبداً
  if (!sandbox()) {
    const sb = await db.collection('transactions').where('uid', '==', uid).get();
    if (sb.docs.some(d => d.get('sandbox') === true)) return { freeze: 'الحساب فيه رصيد من إيداعات تجريبية: امسح بيانات التجربة' };
  }

  const since = Date.now() - DAY;
  const [deps, mine, sameAddr] = await Promise.all([
    db.collection('deposits').where('uid', '==', uid).get(),
    db.collection('withdrawals').where('uid', '==', uid).get(),
    db.collection('withdrawals').where('address', '==', address).get()
  ]);
  // عنوان استلم فعلاً أموالاً لحساب آخر (لا نحسب الملغى أو المرفوض، حتى لا يُجمّد مهاجم عنوان ضحية بطلب وهمي)
  const mineSent = sameAddr.docs.some(d => d.get('uid') === uid && d.get('status') === 'sent');
  if (!mineSent && sameAddr.docs.some(d => d.get('uid') !== uid && ['sent', 'processing'].includes(d.get('status')))) return { freeze: 'العنوان استلم سحوبات لحساب آخر' };

  const why = []; let delayH = 0;
  const need = (h, reason) => { why.push(reason); delayH = Math.max(delayH, h); };
  const ageDays = (Date.now() - ms(me.get('createdAt'))) / DAY;
  if (ageDays < set.autoMinAgeDays) need(48, `حساب جديد (أقل من ${set.autoMinAgeDays} أيام)`);
  if (deps.docs.some(d => d.get('status') === 'paid' && ms(d.get('paidAt')) > since)) need(24, 'إيداع خلال آخر 24 ساعة');
  const usedBefore = mine.docs.some(d => d.id !== id && d.get('address') === address && d.get('status') === 'sent');
  if (!usedBefore) need(24, 'عنوان سحب جديد');
  if (cents > set.autoMax) need(24, `مبلغ أكبر من ${fmt(set.autoMax)} USDT`);
  if (me.get('verified') !== true && cents > set.autoMax / 2) need(12, 'حساب غير موثّق');
  return { delayH, why };
}

/* ---------- طلب سحب جديد (بعد خصم الرصيد) ---------- */
export async function scheduleWithdrawal(db, set, { id, uid, me, cents, address }) {
  const ref = db.doc(`withdrawals/${id}`);
  const r = await assess(db, set, { uid, me, cents, address, id });
  if (r.freeze) {
    await ref.update({ status: 'frozen', reviewReason: r.freeze });
    await pushTo(db, uid, { title: 'طلب السحب قيد التحقق', body: `سحب ${fmt(cents)} USDT يحتاج تحققاً إضافياً من الإدارة. لن يضيع رصيدك.`, data: { kind: 'withdraw_hold' }, tag: `wd-${id}` });
    return { status: 'frozen' };
  }
  const releaseAt = Date.now() + r.delayH * H;
  await ref.update({ status: 'scheduled', releaseAt: Timestamp.fromMillis(releaseAt), delayH: r.delayH, reviewReason: r.why.join('، ') });
  // تنبيه أمني: إن لم يطلبه صاحب الحساب يستطيع الإلغاء خلال فترة الانتظار
  await pushTo(db, uid, {
    title: r.delayH ? `🔒 سحب ${fmt(cents)} USDT خلال ${r.delayH} ساعة` : `جارٍ تحويل ${fmt(cents)} USDT`,
    body: r.delayH ? `إلى ${short(address)}. فترة أمان لحمايتك (${r.why.join('، ')}). لم تطلبه؟ ألغِه من المحفظة فوراً.` : `إلى ${short(address)}. لم تطلبه؟ تواصل مع الدعم فوراً.`,
    data: { kind: 'withdraw_alert' }, tag: `wd-${id}`
  });
  if (!r.delayH) await processWithdrawal(db, set, ref);
  return { status: 'scheduled', delayH: r.delayH, releaseAt };
}

/* ---------- 3 + 4. التنفيذ عند حلول الموعد ---------- */
async function failure(db, ref, reason) {
  await ref.update({ status: 'frozen', reviewReason: reason });
  // قاطع الدائرة
  const s = db.doc('settings/wallet');
  await db.runTransaction(async (t) => {
    const d = (await t.get(s)).data() || {};
    const recent = (d.payoutFailures || []).filter(x => x > Date.now() - DAY).concat(Date.now());
    t.set(s, { payoutFailures: recent, ...(recent.length >= 3 ? { autoWithdraw: false, autoPausedReason: `توقف تلقائياً بعد ${recent.length} إخفاقات خلال 24 ساعة` } : {}) }, { merge: true });
  }).catch(() => {});
}

export async function processWithdrawal(db, set, ref) {
  if (!set.autoWithdraw) return false;
  const snap = await ref.get();
  const w = snap.data();
  if (!w || w.status !== 'scheduled' || ms(w.releaseAt) > Date.now()) return false;

  // الحدود اليومية: ما يتجاوزها يُؤجَّل 24 ساعة بدل الرفض
  const since = Date.now() - DAY;
  const [mine, all] = await Promise.all([
    db.collection('withdrawals').where('uid', '==', w.uid).get(),
    // آخر 24 ساعة فقط (لا نقرأ كل تاريخ السحوبات)
    db.collection('withdrawals').where('autoAt', '>', Timestamp.fromMillis(since)).get()
  ]);
  const sum = (s) => s.docs.filter(d => d.id !== ref.id && ['processing', 'sent'].includes(d.get('status')) && ms(d.get('autoAt')) > since).reduce((a, d) => a + (d.get('amount') || 0), 0);
  if (sum(mine) + w.amount > set.autoUserDaily || sum(all) + w.amount > set.autoGlobalDaily) {
    await ref.update({ releaseAt: Timestamp.fromMillis(Date.now() + DAY), reviewReason: 'تجاوز الحد اليومي، أُجّل 24 ساعة' });
    return false;
  }
  // تحقق الدفتر مرة أخرى قبل خروج المال
  const led = await ledgerOk(db, w.uid);
  if (!led.ok) { await ref.update({ status: 'frozen', reviewReason: `خلل في الدفتر قبل الإرسال: المتوقع ${fmt(led.expected)} والفعلي ${fmt(led.actual)}` }); return false; }

  // حجز التنفيذ (يمنع الإرسال المزدوج من مسارين متزامنين)
  const claimed = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (s.get('status') !== 'scheduled') return false;
    t.update(ref, { status: 'processing', auto: true, autoAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!claimed) return false;

  // وضع التجربة: محاكاة الإرسال (الأرصدة وهمية، فلا يخرج مال حقيقي أبداً)
  if (sandbox()) {
    await ref.update({ status: 'sent', txHash: `SANDBOX-${ref.id}`, payoutStatus: 'Confirmed', sandbox: true, decidedBy: 'auto', decidedAt: FieldValue.serverTimestamp() });
    await pushTo(db, w.uid, { title: '✅ تم تحويل سحبك بنجاح (تجريبي)', body: `${fmt(w.amount)} USDT. هذه محاكاة، لم تُرسل أموال حقيقية.`, data: { kind: 'withdraw_sent', amount: w.amount }, tag: `wd-${ref.id}` });
    return true;
  }
  if (!process.env.OXAPAY_PAYOUT_KEY) { await ref.update({ status: 'scheduled', reviewReason: 'مفتاح Payout غير مضبوط في السيرفر' }); return false; }

  let out = {};
  try {
    const r = await fetch('https://api.oxapay.com/v1/payout', {
      method: 'POST',
      headers: { 'payout_api_key': process.env.OXAPAY_PAYOUT_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: w.address, currency: 'USDT', network: await payoutNetwork(),
        amount: Number(fmt(w.amount)), callback_url: 'https://ghanamaya.vercel.app/api/oxapay-webhook', description: `ghanamaya ${ref.id}`
      }),
      signal: AbortSignal.timeout(15000)
    });
    out = await r.json().catch(() => ({}));
    if (!r.ok || !out.data || !out.data.track_id) {
      const msg = (out.error && (out.error.message || out.error.key)) || out.message || `HTTP ${r.status}`;
      console.error('payout', JSON.stringify(out).slice(0, 300));
      await failure(db, ref, `رفضت OxaPay السحب: ${String(msg).slice(0, 120)}`);
      return false;
    }
  } catch (e) {
    await failure(db, ref, 'انقطع الاتصال بـ OxaPay: تحقق من سجل Payout قبل أي إرسال يدوي (ربما أُرسل)');
    return false;
  }
  await ref.update({ payoutTrackId: String(out.data.track_id), payoutStatus: String(out.data.status || 'Processing') });
  return true;
}

// ينفّذ السحوبات التي حلّ موعدها (من الـ Cron، ومن أي استدعاء للمحفظة)
export async function processDue(db, set, limit = 5) {
  if (!set.autoWithdraw) return 0;
  const q = await db.collection('withdrawals').where('status', '==', 'scheduled').get();
  const due = q.docs.filter(d => ms(d.get('releaseAt')) <= Date.now()).sort((a, b) => ms(a.get('releaseAt')) - ms(b.get('releaseAt'))).slice(0, limit);
  let n = 0;
  for (const d of due) { try { if (await processWithdrawal(db, set, d.ref)) n++; } catch (e) { console.error('processDue', d.id, e); } }
  return n;
}

/* ---------- إلغاء المستخدم أثناء فترة الانتظار ⇒ إرجاع الرصيد ---------- */
export async function cancelWithdrawal(db, uid, id) {
  const ref = db.doc(`withdrawals/${id}`);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || s.get('uid') !== uid) throw Object.assign(new Error('غير موجود'), { user: true, code: 404 });
    if (!['scheduled', 'frozen', 'pending'].includes(s.get('status'))) throw Object.assign(new Error('لا يمكن إلغاؤه الآن، التحويل بدأ'), { user: true, code: 409 });
    const w = await readWallet(t, db, uid);
    w.balance += s.get('amount');
    writeWallet(t, w, {});
    logTx(t, db, uid, 'withdraw_refund', s.get('amount'), { withdrawalId: id, note: 'ألغاه المستخدم' });
    t.update(ref, { status: 'cancelled', decidedBy: 'user', decidedAt: FieldValue.serverTimestamp() });
    return { amount: s.get('amount') };
  });
}


/* ---------- شبكة السحب: يُقرأ اسمها الدقيق من OxaPay نفسها بدل التخمين ---------- */
const NET_RE = /bep-?20|\bbsc\b|binance smart chain|bnb smart chain/i;
let netCache = null;
async function oxa(path, headers = {}) {
  const r = await fetch(`https://api.oxapay.com/v1/${path}`, { headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && (j.status === undefined || j.status === 200), status: r.status, j };
}
// يبحث في قائمة عملات OxaPay عن شبكة USDT على BSC ويرجع اسمها كما تقبله الـ API
export async function usdtBscNetwork() {
  if (netCache && Date.now() - netCache.at < 6 * H) return netCache.v;
  const { ok, j } = await oxa('common/currencies');
  if (!ok) return null;
  const root = j.data || j;
  const usdt = root.USDT || root.usdt || Object.values(root).find(c => c && (c.symbol === 'USDT'));
  if (!usdt || !usdt.networks) return null;
  const list = Array.isArray(usdt.networks) ? usdt.networks : Object.entries(usdt.networks).map(([k, v]) => ({ key: k, ...(v || {}) }));
  const hit = list.find(n => [n.network, n.name, n.key].some(x => typeof x === 'string' && NET_RE.test(x)));
  if (!hit) return null;
  const v = { network: String(hit.network || hit.key || hit.name), name: String(hit.name || hit.network || ''),
    min: Number(hit.withdraw_min ?? hit.min_withdraw ?? NaN), fee: Number(hit.withdraw_fee ?? hit.fee ?? NaN) };
  netCache = { at: Date.now(), v };
  return v;
}
export async function payoutNetwork() {
  if (process.env.OXAPAY_PAYOUT_NETWORK) return process.env.OXAPAY_PAYOUT_NETWORK;
  try { const n = await usdtBscNetwork(); if (n) return n.network; } catch {}
  return 'BEP20';
}

/* ---------- فحص شامل قبل أي سحب حقيقي (للأدمن) ---------- */
export async function payoutCheck(db, set) {
  const out = []; const add = (ok, label, detail = '') => out.push({ ok, label, detail });
  const sb = sandbox();
  add(!sb, 'وضع التشغيل', sb ? 'وضع التجربة مفعّل (OXAPAY_SANDBOX): لن يخرج مال حقيقي. احذفه من Vercel للإطلاق' : 'تشغيل حقيقي');
  add(!!process.env.OXAPAY_MERCHANT_KEY, 'مفتاح الإيداع (Merchant)', process.env.OXAPAY_MERCHANT_KEY ? 'موجود' : 'غير موجود في Vercel');
  add(!!process.env.OXAPAY_PAYOUT_KEY, 'مفتاح السحب (Payout)', process.env.OXAPAY_PAYOUT_KEY ? 'موجود' : 'غير موجود في Vercel');
  try {
    const n = await usdtBscNetwork();
    if (!n) add(false, 'شبكة BEP20 لدى OxaPay', 'لم أجد USDT على BSC في قائمة OxaPay');
    else {
      const env = process.env.OXAPAY_PAYOUT_NETWORK;
      add(!env || env === n.network, 'اسم الشبكة', env && env !== n.network ? `OXAPAY_PAYOUT_NETWORK="${env}" لكن OxaPay تسميها "${n.network}": احذف المتغير` : `سيُستخدم "${n.network}" (${n.name})`);
      if (Number.isFinite(n.min)) add(set.minWithdraw / 100 >= n.min, 'أقل سحب', `OxaPay: ${n.min} USDT، تطبيقك: ${fmt(set.minWithdraw)} USDT`);
      if (Number.isFinite(n.fee)) add(true, 'رسوم الشبكة لدى OxaPay', `${n.fee} USDT لكل سحب`);
    }
  } catch (e) { add(false, 'الاتصال بـ OxaPay', 'تعذر الوصول: ' + String(e.message || e).slice(0, 80)); }
  if (process.env.OXAPAY_MERCHANT_KEY) {
    try { const r = await oxa('payment/accepted-currencies', { merchant_api_key: process.env.OXAPAY_MERCHANT_KEY });
      const list = JSON.stringify(r.j.data || {});
      add(r.ok, 'صلاحية مفتاح الإيداع', r.ok ? (/USDT/.test(list) ? 'صالح ويقبل USDT' : 'صالح، لكن USDT غير مفعّل في التاجر') : msgOf(r));
    } catch { add(false, 'صلاحية مفتاح الإيداع', 'تعذر الاتصال'); }
  }
  if (process.env.OXAPAY_PAYOUT_KEY) {
    try { const r = await oxa('payout?size=1', { payout_api_key: process.env.OXAPAY_PAYOUT_KEY });
      add(r.ok, 'صلاحية مفتاح السحب', r.ok ? 'صالح ويقبله OxaPay من سيرفر Vercel' : msgOf(r) + ' (تحقق من المفتاح، وأزل قيود الـ IP عنه)');
    } catch { add(false, 'صلاحية مفتاح السحب', 'تعذر الاتصال'); }
  }
  add(set.autoWithdraw !== false, 'السحب التلقائي', set.autoWithdraw !== false ? 'مفعّل' : 'متوقف: ' + (set.autoPausedReason || 'أوقفه الأدمن'));
  if (!sb) {
    const t = await db.collection('transactions').where('sandbox', '==', true).limit(1).get();
    add(t.empty, 'بيانات التجربة', t.empty ? 'نظيفة' : 'توجد أرصدة تجريبية: اضغط "مسح بيانات التجربة"');
  }
  return out;
}
function msgOf(r) { const e = r.j && (r.j.error || {}); return String(e.message || r.j.message || `HTTP ${r.status}`).slice(0, 120); }
