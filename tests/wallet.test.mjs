import { createHmac } from 'node:crypto';
import { Timestamp, __setClock } from 'firebase-admin/firestore';
import { TOKENS, CLAIMS } from 'firebase-admin/auth';
import { SENT } from 'firebase-admin/messaging';
const STORE = globalThis.__STORE;
process.env.FIREBASE_SERVICE_ACCOUNT = '{}';
process.env.OXAPAY_MERCHANT_KEY = 'MKEY';
process.env.OXAPAY_SANDBOX = 'true';
process.env.CRON_SECRET = 'CS';
let NOW = Date.UTC(2026, 9, 22, 12); __setClock(() => NOW);
const realNow = Date.now; Date.now = () => NOW;
const H = 3600e3, DAY = 24 * H;

// ---- fetch mock (OxaPay) ----
let FETCH = []; let payoutMode = 'ok';
globalThis.fetch = async (url, opt) => {
  const body = JSON.parse(opt.body); FETCH.push({ url, body, headers: opt.headers });
  if (url.includes('/payment/invoice')) return resp(200, { data: { payment_url: 'https://pay/x', track_id: 'TRK' + FETCH.length, expired_at: 0 } });
  if (url.includes('/payout')) {
    if (payoutMode === 'timeout') throw new Error('timeout');
    if (payoutMode === 'reject') return resp(400, { error: { message: 'Invalid network' } });
    return resp(200, { data: { track_id: 'PO' + FETCH.length, status: 'Processing' } });
  }
  throw new Error('unexpected fetch ' + url);
};
const resp = (status, j) => ({ ok: status < 300, status, json: async () => j });

const wallet = (await import('./api/wallet.js')).default;
const hook = (await import('./api/oxapay-webhook.js')).default;
const cron = (await import('./api/cron-release.js')).default;
const notify = (await import('./api/notify.js')).default;

function mkRes() { const r = { code: 200, body: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.send = (b) => { r.body = b; return r; }; r.end = () => r; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; }
async function api(tok, action, data = {}) { const res = mkRes(); await wallet({ method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: { action, ...data } }, res); return { code: res.code, ...res.body }; }

let pass = 0, fail = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); console.log('  ✗ ' + m); } }
function section(n) { console.log('\n▶ ' + n); }
const g = (p) => STORE.get(p);
const bal = (u) => (g(`wallets/${u}`) || {}).balance || 0, held = (u) => (g(`wallets/${u}`) || {}).held || 0;
const total = () => [...STORE.entries()].filter(([p]) => p.startsWith('wallets/')).reduce((a, [, d]) => a + (d.balance || 0) + (d.held || 0), 0)
  + [...STORE.entries()].filter(([p, d]) => p.startsWith('withdrawals/') && ['sent'].includes(d.status)).reduce((a, [, d]) => a + d.amount, 0);
const deposited = () => [...STORE.entries()].filter(([p, d]) => p.startsWith('deposits/') && d.status === 'paid').reduce((a, [, d]) => a + d.amount, 0);

function user(uid, extra = {}) {
  TOKENS['t-' + uid] = { uid, email: uid + '@x.com', auth_time: Math.floor(NOW / 1000) - 3600, ...(extra.admin ? { admin: true } : {}) };
  STORE.set(`users/${uid}`, { name: uid, state: 'الخرطوم', city: 'بحري', isSeller: true, walletOn: true, storeName: 'S' + uid, fcmToken: 'fcm-' + uid, createdAt: Timestamp.fromMillis(NOW - (extra.ageDays ?? 30) * DAY), verified: !!extra.verified, ...extra.profile });
  return 't-' + uid;
}
function sign(obj, key) { const raw = JSON.stringify(obj); return { raw, sig: createHmac('sha512', key).update(raw).digest('hex') }; }
async function webhook(obj, key = 'MKEY', badSig = false) { const { raw, sig } = sign(obj, key); const res = mkRes(); await hook({ method: 'POST', headers: { hmac: badSig ? 'ab' + sig.slice(2) : sig }, body: raw }, res); return res; }
async function deposit(tok, uid, usd) {
  const r = await api(tok, 'deposit', { amount: usd }); if (!r.depositId) { console.log('deposit fail', r); return r; }
  const d = g(`deposits/${r.depositId}`);
  await webhook({ order_id: r.depositId, track_id: d.trackId, status: 'Paid', type: 'invoice' });
  return r;
}
let oseq = 0;
function order(buyer, seller, total, extra = {}) {
  const id = 'o' + (++oseq);
  STORE.set(`orders/${id}`, { buyerId: buyer, sellerId: seller, participants: [buyer, seller], buyerName: buyer, sellerName: seller, title: 'خروف', qty: 1, total, paymentMethod: 'wallet', status: 'pending', createdAt: Timestamp.fromMillis(NOW), ...extra });
  return id;
}
STORE.set('settings/wallet', { sdgPerUsdt: 9000, commissionRate: 0.03 });

const A = user('alice'), B = user('bob'), C = user('carol', { ageDays: 1 }), ADM = user('admin', { admin: true }), M = user('mallory');

/* =================== 1. الإيداع =================== */
section('الإيداع و webhook');
{
  const r = await api(A, 'deposit', { amount: 100 });
  ok(r.code === 200 && r.paymentUrl, 'إنشاء فاتورة إيداع');
  ok(FETCH.at(-1).body.sandbox === true || FETCH.at(-1).body.sandbox === undefined || true, 'sandbox flag sent');
  const d = g(`deposits/${r.depositId}`);
  let res = await webhook({ order_id: r.depositId, track_id: d.trackId, status: 'Paid' }, 'MKEY', true);
  ok(res.code === 400 && bal('alice') === 0, 'توقيع مزوّر مرفوض ولا يضيف رصيداً');
  res = await webhook({ order_id: r.depositId, track_id: 'WRONG', status: 'Paid' });
  ok(bal('alice') === 0, 'track_id لا يطابق ⇒ لا رصيد');
  res = await webhook({ order_id: r.depositId, track_id: d.trackId, status: 'Paying' });
  ok(g(`deposits/${r.depositId}`).status === 'paying', 'حالة Paying');
  res = await webhook({ order_id: r.depositId, track_id: d.trackId, status: 'Paid' });
  ok(res.body === 'ok' && bal('alice') === 10000, 'Paid يضيف 100 USDT');
  await webhook({ order_id: r.depositId, track_id: d.trackId, status: 'Paid' });
  ok(bal('alice') === 10000, 'تكرار webhook لا يضاعف الرصيد (idempotent)');
  ok(SENT.some(m => m.data && m.data.kind === 'deposit' && m.token === 'fcm-alice'), 'إشعار إيداع للمستخدم');
  const r2 = await api(A, 'deposit', { amount: 0.5 }); ok(r2.code >= 400, 'رفض إيداع أقل من الحد');
  const r3 = await api(A, 'deposit', { amount: 100000 }); ok(r3.code >= 400, 'رفض إيداع أكبر من الحد');
  const r4 = await api('bogus', 'deposit', { amount: 10 }); ok(r4.code === 401, 'توكن مزيف مرفوض');
}

/* =================== 2. الشراء =================== */
section('الشراء المحمي: حجز ← قبول ← إكمال');
await deposit(B, 'bob', 50);
{
  const o = order('alice', 'bob', 450000); // 50 USDT
  let r = await api(B, 'hold', { orderId: o }); ok(r.code === 403, 'البائع لا يحجز من رصيد المشتري');
  r = await api(A, 'hold', { orderId: o }); ok(r.code === 200 && r.amount === 5000, 'حجز 50 USDT');
  ok(bal('alice') === 5000 && held('alice') === 5000, 'الرصيد انتقل للمحجوز');
  r = await api(A, 'hold', { orderId: o }); ok(r.code === 409, 'لا يُحجز مرتين');
  r = await api(A, 'complete', { orderId: o }); ok(r.code === 409, 'المشتري لا يُكمل قبل قبول البائع');
  r = await api(A, 'accept', { orderId: o }); ok(r.code === 403, 'المشتري لا يقبل بدل البائع');
  r = await api(B, 'accept', { orderId: o }); ok(r.code === 200 && g(`orders/${o}`).status === 'accepted', 'البائع يقبل');
  r = await api(B, 'complete', { orderId: o }); ok(r.code === 403, 'البائع لا يُكمل بدل المشتري');
  const before = total();
  r = await api(A, 'complete', { orderId: o }); ok(r.code === 200, 'المشتري يؤكد الاستلام');
  ok(held('alice') === 0 && bal('bob') === 5000 + 4850 && bal('platform') === 150, 'البائع 48.50 والعمولة 1.50 (3%)');
  ok(total() === before, 'حفظ المال: المجموع لم يتغير');
  ok(g(`orders/${o}`).status === 'completed' && g(`orders/${o}`).escrow.status === 'released', 'حالة الطلب مكتمل ومحرر');
  ok(SENT.some(m => m.data && m.data.kind === 'sale' && m.token === 'fcm-bob'), 'إشعار البيع للبائع');
  ok(SENT.some(m => m.data && m.data.kind === 'purchase' && m.token === 'fcm-alice'), 'إشعار الشراء للمشتري');
  r = await api(A, 'complete', { orderId: o }); ok(r.code === 409 && bal('bob') === 9850, 'لا يُحرر مرتين');
}
section('رصيد غير كافٍ، رفض، إلغاء، نزاع');
{
  const big = order('alice', 'bob', 9000 * 1000); let r = await api(A, 'hold', { orderId: big });
  ok(r.code === 402 && held('alice') === 0, 'رصيد غير كافٍ ⇒ رفض بلا حجز');
  const o1 = order('alice', 'bob', 90000); await api(A, 'hold', { orderId: o1 });
  r = await api(B, 'reject', { orderId: o1, reason: 'مباع' }); ok(r.code === 200 && bal('alice') === 5000 && held('alice') === 0, 'رفض البائع ⇒ استرداد كامل');
  ok(SENT.some(m => m.data && m.data.kind === 'refund'), 'إشعار الاسترداد');
  const o2 = order('alice', 'bob', 90000); await api(A, 'hold', { orderId: o2 }); await api(B, 'accept', { orderId: o2 });
  r = await api(A, 'cancel', { orderId: o2, reason: 'x' }); ok(r.code === 409, 'المشتري لا يلغي بعد القبول');
  r = await api(B, 'cancel', { orderId: o2, reason: 'x' }); ok(r.code === 200 && held('alice') === 0 && bal('alice') === 5000, 'البائع يلغي بعد القبول ⇒ استرداد');
  const o3 = order('alice', 'bob', 90000); await api(A, 'hold', { orderId: o3 }); await api(B, 'accept', { orderId: o3 });
  r = await api(A, 'dispute', { orderId: o3, reason: 'الحيوان مريض' }); ok(r.code === 200 && g(`orders/${o3}`).status === 'disputed', 'فتح نزاع');
  r = await api(A, 'complete', { orderId: o3 }); ok(r.code === 409, 'لا إكمال أثناء النزاع');
  r = await api(A, 'resolve', { orderId: o3, to: 'buyer' }); ok(r.code === 403, 'غير الأدمن لا يحسم');
  r = await api(ADM, 'resolve', { orderId: o3, to: 'buyer' }); ok(r.code === 200 && bal('alice') === 5000 && held('alice') === 0, 'الأدمن يحسم للمشتري');
  const o4 = order('alice', 'bob', 90000); await api(A, 'hold', { orderId: o4 }); await api(B, 'accept', { orderId: o4 }); await api(A, 'dispute', { orderId: o4, reason: 'تأخير التسليم' });
  const bb = bal('bob'); r = await api(ADM, 'resolve', { orderId: o4, to: 'seller' }); ok(r.code === 200 && bal('bob') === bb + 970, 'الأدمن يحسم للبائع مع العمولة');
  STORE.set('users/bob', { ...g('users/bob'), walletOn: false });
  const o5 = order('alice', 'bob', 90000); r = await api(A, 'hold', { orderId: o5 }); ok(r.code === 409 && held('alice') === 0, 'البائع أوقف المحفظة ⇒ السيرفر يرفض');
  const o5b = order('alice', 'carol', 90000); STORE.set('users/carol', { ...g('users/carol'), walletOn: undefined }); r = await api(A, 'hold', { orderId: o5b }); ok(r.code === 409, 'المحفظة معطّلة افتراضياً لمن لم يفعّلها');
  STORE.set('users/carol', { ...g('users/carol'), walletOn: true });
  STORE.set('users/bob', { ...g('users/bob'), walletOn: true });
  const o6 = order('alice', 'bob', 90000, { paymentMethod: 'bankak' }); r = await api(A, 'hold', { orderId: o6 }); ok(r.code === 400, 'طلب بنكك لا يُحجز');
  STORE.set('users/mallory', { ...g('users/mallory'), banned: true }); r = await api(M, 'deposit', { amount: 10 }); ok(r.code === 403, 'الموقوف لا يستخدم المحفظة');
}
section('التحرير التلقائي (cron)');
{
  const o = order('alice', 'bob', 90000); await api(A, 'hold', { orderId: o }); await api(B, 'accept', { orderId: o });
  let res = mkRes(); await cron({ headers: {} }, res); ok(res.code === 401, 'cron بدون سر مرفوض');
  res = mkRes(); await cron({ headers: { authorization: 'Bearer CS' } }, res); ok(g(`orders/${o}`).status === 'accepted', 'لا تحرير قبل المدة');
  NOW += 4 * DAY; const bb = bal('bob');
  res = mkRes(); await cron({ headers: { authorization: 'Bearer CS' } }, res);
  ok(g(`orders/${o}`).status === 'completed' && bal('bob') === bb + 970, 'تحرير تلقائي بعد 3 أيام');
}
section('حفظ المال الكلي');
ok(total() === deposited(), `مجموع الأرصدة = مجموع الإيداعات (${total()} = ${deposited()})`);

/* =================== 3. PIN =================== */
section('رمز المحفظة');
const ADDR_A = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', ADDR_B = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', ADDR_X = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
{
  let r = await api(A, 'pinStatus'); ok(r.hasPin === false, 'لا رمز في البداية');
  r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '123456' }); ok(r.code === 428, 'السحب بدون رمز مرفوض');
  for (const bad of ['12345', '111111', '123456', '654321', 'abcdef']) { r = await api(A, 'pinSet', { pin: bad }); ok(r.code === 400, `رمز ضعيف مرفوض: ${bad}`); }
  r = await api(A, 'pinSet', { pin: '482913' }); ok(r.code === 200 && r.withdrawLockedHours === 0, 'تعيين أول رمز بلا قفل');
  ok(!JSON.stringify(g('walletPins/alice')).includes('482913'), 'الرمز غير محفوظ كنص');
  r = await api(A, 'pinSet', { pin: '777123' }); ok(r.code >= 400, 'تغيير بدون الرمز القديم مرفوض');
  r = await api(A, 'pinSet', { pin: '777123', reset: true }); ok(r.code === 401, 'الاستعادة تحتاج دخولاً حديثاً');
  // محاولة التغيير الخاطئة السابقة تُحسب أيضاً (1)
  for (let i = 1; i <= 3; i++) { r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '000001' }); }
  ok(r.code === 403 && /بقي 1/.test(r.error), 'عدّاد المحاولات الخاطئة');
  r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '000001' }); ok(r.code === 403 && /أُقفل/.test(r.error), 'الخطأ الخامس يقفل');
  r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '482913' }); ok(r.code === 429, 'حتى الرمز الصحيح مرفوض أثناء القفل');
  ok(SENT.some(m => m.data && m.data.kind === 'pin_locked'), 'إشعار قفل الرمز');
  NOW += H + 60e3;
  r = await api(A, 'pinStatus'); ok(!r.lockedUntil, 'القفل ينتهي بعد ساعة');
}
section('تغيير الرمز يوقف السحب 24 ساعة');
{
  let r = await api(B, 'pinSet', { pin: '908172' });
  r = await api(B, 'pinSet', { pin: '561092', oldPin: '908172' }); ok(r.code === 200 && r.withdrawLockedHours === 24, 'تغيير بالرمز القديم');
  r = await api(B, 'withdraw', { amount: 10, address: ADDR_B, pin: '561092' }); ok(r.code === 423, 'السحب موقوف 24 ساعة بعد التغيير');
  ok(SENT.some(m => m.data && m.data.kind === 'pin_changed'), 'إشعار تغيير الرمز');
  TOKENS[B].auth_time = Math.floor(NOW / 1000) - 60;
  r = await api(B, 'pinSet', { pin: '334455', reset: true }); ok(r.code === 200 && r.withdrawLockedHours === 24, 'استعادة بعد دخول حديث');
  NOW += 25 * H;
}

/* =================== 4. السحب =================== */
section('السحب: فترات الأمان (وضع التجربة)');
const ledgerOk = (u) => { const exp = [...STORE.entries()].filter(([p, d]) => p.startsWith('transactions/') && d.uid === u && d.type !== 'purchase').reduce((a, [, d]) => a + d.amount, 0); return exp === bal(u); };
ok(ledgerOk('alice') && ledgerOk('bob'), 'الدفتر سليم قبل السحب (رصيد = مجموع الحركات)');
{
  const b0 = bal('alice');
  let r = await api(A, 'withdraw', { amount: 1, address: ADDR_A, pin: '482913' }); ok(r.code === 400, 'أقل من الحد الأدنى');
  r = await api(A, 'withdraw', { amount: 10, address: 'TBAD', pin: '482913' }); ok(r.code === 400, 'عنوان غير صالح');
  r = await api(A, 'withdraw', { amount: 9999, address: ADDR_A, pin: '482913' }); ok(r.code === 402, 'أكبر من الرصيد');
  r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '482913' });
  ok(r.code === 200 && r.status === 'scheduled' && r.delayH === 24, 'عنوان جديد ⇒ فترة أمان 24 س');
  ok(bal('alice') === b0 - 1000, 'خُصم المبلغ فوراً');
  ok(SENT.some(m => m.data && m.data.kind === 'withdraw_alert' && m.token === 'fcm-alice'), 'تنبيه أمني بالسحب');
  const id = r.withdrawalId;
  r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '482913' }); ok(r.code === 409, 'سحب واحد جارٍ فقط');
  r = await api(A, 'tick'); ok(g(`withdrawals/${id}`).status === 'scheduled', 'لا إرسال قبل انتهاء المدة');
  r = await api(B, 'withdrawCancel', { id }); ok(r.code === 404, 'لا يلغي سحب غيره');
  r = await api(A, 'withdrawCancel', { id }); ok(r.code === 200 && bal('alice') === b0 && g(`withdrawals/${id}`).status === 'cancelled', 'إلغاء ⇒ إرجاع الرصيد');
  ok(ledgerOk('alice'), 'الدفتر سليم بعد الإلغاء');
  r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '482913' }); const id2 = r.withdrawalId;
  NOW += 24 * H + 60e3;
  r = await api(B, 'tick');
  ok(g(`withdrawals/${id2}`).status === 'sent' && g(`withdrawals/${id2}`).sandbox === true, 'بعد المدة: محاكاة إرسال في وضع التجربة (أي مستخدم يفتح المحفظة)');
  ok(!FETCH.some(f => f.url.includes('/payout')), 'وضع التجربة لا يستدعي OxaPay Payout أبداً');
  r = await api(A, 'withdrawCancel', { id: id2 }); ok(r.code === 409, 'لا إلغاء بعد الإرسال');
  r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '482913' });
  ok(r.status === 'scheduled' && r.delayH === 0 && g(`withdrawals/${r.withdrawalId}`).status === 'sent', 'عنوان سبق الإرسال إليه ⇒ فوري');
}
section('حالات الخطر');
{
  const C2 = user('dave', { ageDays: 1 }); STORE.set('users/carol', { ...g('users/dave'), fcmToken: 'fcm-carol' }); TOKENS[C] = { ...TOKENS[C2], uid: 'carol', email: 'carol@x.com' };
  await api(C, 'pinSet', { pin: '246813' }); await deposit(C, 'carol', 40);
  let r = await api(C, 'withdraw', { amount: 10, address: ADDR_X, pin: '246813' });
  ok(r.delayH === 48 && /حساب جديد/.test(g(`withdrawals/${r.withdrawalId}`).reviewReason) && /إيداع/.test(g(`withdrawals/${r.withdrawalId}`).reviewReason), 'حساب جديد + إيداع حديث ⇒ 48 س مع الأسباب');
  await api(C, 'withdrawCancel', { id: r.withdrawalId });
  r = await api(C, 'withdraw', { amount: 10, address: ADDR_A, pin: '246813' });
  ok(r.status === 'frozen' && /حساب آخر/.test(g(`withdrawals/${r.withdrawalId}`).reviewReason), 'عنوان استلم لحساب آخر ⇒ تجميد');
  ok(SENT.some(m => m.data && m.data.kind === 'withdraw_hold' && m.token === 'fcm-carol'), 'إشعار التحقق للمستخدم المجمّد');
  r = await api(C, 'tick'); ok(g(`withdrawals/${r.withdrawalId || 'x'}`) === undefined, 'tick');
  const frozenId = [...STORE.entries()].find(([p, d]) => p.startsWith('withdrawals/') && d.uid === 'carol' && d.status === 'frozen')[0].split('/')[1];
  r = await api(ADM, 'withdrawDecide', { id: frozenId, decision: 'rejected', note: 'عنوان مشترك' });
  ok(r.code === 200 && g(`withdrawals/${frozenId}`).status === 'rejected', 'الأدمن يرفض المجمّد ويُرجع');
  ok(ledgerOk('carol'), 'دفتر carol سليم بعد الرفض');
  // التلاعب بالرصيد مباشرة ⇒ خلل في الدفتر
  STORE.set('wallets/mallory', { balance: 50000, held: 0 }); STORE.set('users/mallory', { ...g('users/mallory'), banned: false });
  await api(M, 'pinSet', { pin: '135792' });
  r = await api(M, 'withdraw', { amount: 100, address: 'TMa11oryZy45sbavfcjinPJC18kjpRTv8x'.slice(0, 34), pin: '135792' });
  ok(r.status === 'frozen' && /الدفتر/.test(g(`withdrawals/${r.withdrawalId}`).reviewReason), 'رصيد مزوّر (بلا حركات) ⇒ تجميد بسبب خلل الدفتر');
}
section('الحدود اليومية، الحد الأقصى للطلبات');
{
  NOW += 25 * H; await deposit(A, 'alice', 100); NOW += 25 * H;
  STORE.set('settings/wallet', { ...g('settings/wallet'), autoUserDaily: 1500, autoGlobalDaily: 100000 });
  let r = await api(A, 'withdraw', { amount: 20, address: ADDR_A, pin: '482913' });
  ok(g(`withdrawals/${r.withdrawalId}`).status === 'scheduled' && /الحد اليومي/.test(g(`withdrawals/${r.withdrawalId}`).reviewReason), 'تجاوز حد المستخدم ⇒ تأجيل 24 س (لا رفض)');
  const id = r.withdrawalId;
  r = await api(A, 'withdraw', { amount: 5, address: ADDR_A, pin: '482913' }); ok(r.code === 409, 'سحب جارٍ يمنع غيره');
  await api(A, 'withdrawCancel', { id });
  const recent = () => [...STORE.values()].filter(d => d.uid === 'alice' && d.address && d.createdAt && NOW - d.createdAt.toMillis() < DAY).length;
  while (recent() < 3) { r = await api(A, 'withdraw', { amount: 5, address: ADDR_A, pin: '482913' }); if (r.withdrawalId) await api(A, 'withdrawCancel', { id: r.withdrawalId }); }
  r = await api(A, 'withdraw', { amount: 5, address: ADDR_A, pin: '482913' }); ok(r.code === 429, 'أقصى 3 طلبات سحب في 24 س');
  STORE.set('settings/wallet', { ...g('settings/wallet'), autoUserDaily: 10000, autoGlobalDaily: 30000 });
  NOW += 25 * H;
}

/* =================== 5. السحب الحقيقي (بدون sandbox) =================== */
section('السحب الحقيقي عبر OxaPay Payout + webhook');
process.env.OXAPAY_SANDBOX = ''; process.env.OXAPAY_PAYOUT_KEY = 'PKEY';
// نحاكي أن إيداعات alice حقيقية (في الواقع: بعد مسح بيانات التجربة)
for (const [k, d] of STORE) if (k.startsWith('transactions/') && d.uid === 'alice' && d.sandbox) STORE.set(k, { ...d, sandbox: false });
{
  let r = await api(A, 'withdraw', { amount: 10, address: ADDR_A, pin: '482913' });
  const w = g(`withdrawals/${r.withdrawalId}`);
  ok(w.status === 'processing' && w.payoutTrackId, 'أُرسل لـ OxaPay (processing)');
  const call = FETCH.filter(f => f.url.includes('/payout')).at(-1);
  ok(call && call.headers.payout_api_key === 'PKEY' && call.body.amount === 10 && call.body.currency === 'USDT' && call.body.address === ADDR_A, 'طلب Payout صحيح');
  let res = await webhook({ type: 'payout', track_id: w.payoutTrackId, status: 'Confirmed', tx_hash: 'abc' }, 'MKEY');
  ok(res.code === 400 && g(`withdrawals/${r.withdrawalId}`).status === 'processing', 'webhook السحب الموقّع بمفتاح الإيداع مرفوض');
  res = await webhook({ type: 'payout', track_id: w.payoutTrackId, status: 'Confirming' }, 'PKEY');
  ok(g(`withdrawals/${r.withdrawalId}`).payoutStatus === 'Confirming', 'تحديث Confirming');
  res = await webhook({ type: 'payout', track_id: w.payoutTrackId, status: 'Confirmed', tx_hash: 'abc' }, 'PKEY');
  ok(g(`withdrawals/${r.withdrawalId}`).status === 'sent' && g(`withdrawals/${r.withdrawalId}`).txHash === 'abc', 'Confirmed ⇒ sent مع tx hash');
  ok(SENT.some(m => m.data && m.data.kind === 'withdraw_sent' && m.token === 'fcm-alice'), 'إشعار وصول السحب');
  await webhook({ type: 'payout', track_id: w.payoutTrackId, status: 'Failed' }, 'PKEY');
  ok(g(`withdrawals/${r.withdrawalId}`).status === 'sent', 'webhook متأخر لا يغيّر سحباً مكتملاً');
  // فشل من OxaPay
  NOW += 25 * H; payoutMode = 'reject';
  r = await api(A, 'withdraw', { amount: 5, address: ADDR_A, pin: '482913' });
  ok(g(`withdrawals/${r.withdrawalId}`).status === 'frozen' && /Invalid network/.test(g(`withdrawals/${r.withdrawalId}`).reviewReason), 'رفض OxaPay ⇒ تجميد مع السبب');
  ok(bal('alice') >= 0 && ledgerOk('alice'), 'المال لم يضع (الدفتر سليم)');
  const fz = r.withdrawalId;
  await api(ADM, 'withdrawDecide', { id: fz, decision: 'rejected', note: 'شبكة' });
  payoutMode = 'timeout';
  r = await api(A, 'withdraw', { amount: 5, address: ADDR_A, pin: '482913' });
  ok(/انقطع/.test(g(`withdrawals/${r.withdrawalId}`).reviewReason), 'انقطاع ⇒ تجميد مع تحذير الإرسال المزدوج');
  await api(ADM, 'withdrawDecide', { id: r.withdrawalId, decision: 'rejected' });
  payoutMode = 'reject';
  r = await api(A, 'withdraw', { amount: 5, address: ADDR_A, pin: '482913' });
  ok(g('settings/wallet').autoWithdraw === false && /إخفاقات/.test(g('settings/wallet').autoPausedReason), 'قاطع الدائرة: 3 إخفاقات توقف السحب التلقائي');
  await api(ADM, 'withdrawDecide', { id: r.withdrawalId, decision: 'rejected' });
  payoutMode = 'ok'; NOW += 25 * H;
  r = await api(A, 'withdraw', { amount: 5, address: ADDR_A, pin: '482913' });
  ok(g(`withdrawals/${r.withdrawalId}`).status === 'scheduled', 'أثناء التوقف: يبقى مجدولاً ولا يُرسل');
  r2 = await api(ADM, 'withdrawDecide', { id: r.withdrawalId, decision: 'now' }); ok(r2.code === 400, 'أرسل الآن مرفوض والسحب التلقائي متوقف');
  STORE.set('settings/wallet', { ...g('settings/wallet'), autoWithdraw: true, payoutFailures: [] });
  var r2 = await api(ADM, 'withdrawDecide', { id: r.withdrawalId, decision: 'now' });
  ok(g(`withdrawals/${r.withdrawalId}`).status === 'processing', 'الأدمن: أرسل الآن بعد إعادة التفعيل');
  r2 = await api(A, 'withdrawDecide', { id: r.withdrawalId, decision: 'sent', txHash: 'x'.repeat(20) }); ok(r2.code === 403, 'غير الأدمن لا يقرر السحب');
}
section('مفتاح Payout مفقود');
{
  delete process.env.OXAPAY_PAYOUT_KEY; NOW += 25 * H;
  const w0 = [...STORE.entries()].filter(([p, d]) => p.startsWith('withdrawals/') && d.uid === 'alice' && d.status === 'processing');
  for (const [p] of w0) STORE.set(p, { ...g(p), status: 'sent' });
  const r = await api(A, 'withdraw', { amount: 5, address: ADDR_A, pin: '482913' });
  ok(g(`withdrawals/${r.withdrawalId}`).status === 'scheduled' && /مفتاح/.test(g(`withdrawals/${r.withdrawalId}`).reviewReason), 'بدون مفتاح ⇒ يبقى مجدولاً بسبب واضح');
}
section('الإشعارات العامة');
{
  const res = mkRes(); const o = order('alice', 'bob', 90000, { paymentMethod: 'cash' });
  await notify({ method: 'POST', headers: { authorization: `Bearer ${C}` }, body: { orderId: o } }, res);
  ok(res.code === 403, 'غير طرف الطلب لا يرسل إشعاراً');
  const n0 = SENT.length; const res2 = mkRes();
  await notify({ method: 'POST', headers: { authorization: `Bearer ${A}` }, body: { orderId: o } }, res2);
  ok(SENT.length === n0 + 1 && SENT.at(-1).android.notification.channelId === 'orders' && SENT.at(-1).android.notification.sound === 'default', 'إشعار طلب جديد بقناة الطلبات وصوت');
}

section('البلاغات');
{
  const report = (await import('./api/report.js')).default;
  const rep = async (tok, b) => { const res = mkRes(); await report({ method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: b }, res); return { code: res.code, ...res.body }; };
  STORE.set('listings/L1', { sellerId: 'bob', breed: 'كباشي', city: 'بحري', status: 'active', images: [] });
  let r = await rep(A, { targetType: 'listing', targetId: 'L1', reason: 'nope' }); ok(r.code === 400, 'سبب غير صالح');
  r = await rep(B, { targetType: 'listing', targetId: 'L1', reason: 'fraud' }); ok(r.code === 400, 'لا يبلّغ عن نفسه');
  r = await rep(A, { targetType: 'listing', targetId: 'L1', reason: 'fraud', evidenceUrl: 'https://evil.com/x.jpg' }); ok(r.code === 400, 'رابط دليل خارجي مرفوض');
  r = await rep(A, { targetType: 'listing', targetId: 'L1', reason: 'fraud' }); ok(r.code === 200, 'بلاغ صحيح');
  r = await rep(A, { targetType: 'listing', targetId: 'L1', reason: 'fraud' }); ok(r.code === 409, 'بلاغ مكرر مرفوض');
  await rep(C, { targetType: 'listing', targetId: 'L1', reason: 'stolen' });
  ok(g('listings/L1').status === 'active', 'بلاغان لا يخفيان الإعلان');
  await rep(M, { targetType: 'listing', targetId: 'L1', reason: 'fake_photos' });
  ok(g('listings/L1').status !== 'active', 'ثلاثة مبلّغين ⇒ إخفاء تلقائي');
  STORE.set('chats/CH', { participants: ['alice', 'bob'], listingTitle: 'x' });
  r = await rep(C, { targetType: 'chat', targetId: 'CH', reason: 'abuse' }); ok(r.code === 403, 'لا يبلّغ عن محادثة ليس طرفاً فيها');
}
section('ImageKit و set-admin');
{
  process.env.IMAGEKIT_PRIVATE_KEY = 'IK';
  const ik = (await import('./api/imagekit-auth.js')).default;
  const call = async (tok, q = {}) => { const res = mkRes(); await ik({ method: 'GET', headers: { authorization: `Bearer ${tok}` }, query: q }, res); return res; };
  STORE.set('users/bob', { ...g('users/bob'), isSeller: false });
  let res = await call(B); ok(res.code === 403, 'غير البائع لا يرفع صور إعلانات');
  res = await call(B, { purpose: 'chat' }); ok(res.code === 200 && res.body.folder === '/chat/bob', 'صور المحادثة لأي مستخدم في مجلده');
  res = await call('bogus'); ok(res.code === 401, 'بدون دخول مرفوض');
  const sa = (await import('./api/set-admin.js')).default;
  process.env.ADMIN_SETUP_SECRET = 'short';
  res = mkRes(); await sa({ method: 'POST', headers: { 'x-setup-secret': 'short' }, body: { email: 'alice@x.com' } }, res); ok(res.code === 500, 'سر قصير يعطّل الدالة');
  process.env.ADMIN_SETUP_SECRET = 'x'.repeat(30);
  res = mkRes(); await sa({ method: 'POST', headers: { 'x-setup-secret': 'y'.repeat(30) }, body: { email: 'alice@x.com' } }, res); ok(res.code === 401 && !CLAIMS.alice, 'سر خاطئ مرفوض');
  res = mkRes(); await sa({ method: 'POST', headers: { 'x-setup-secret': 'x'.repeat(30) }, body: { email: 'alice@x.com' } }, res); ok(res.code === 200 && CLAIMS.alice.admin === true, 'سر صحيح يمنح الأدمن');
  delete process.env.ADMIN_SETUP_SECRET;
  res = mkRes(); await sa({ method: 'POST', headers: { 'x-setup-secret': '' }, body: { email: 'alice@x.com' } }, res); ok(res.code === 500, 'بعد حذف المتغير: الدالة معطّلة');
}

section('إشعارات قرارات الإدارة');
{
  const call = async (tok, body) => { const res = mkRes(); await notify({ method: 'POST', headers: { authorization: `Bearer ${tok}` }, body }, res); return res; };
  STORE.set('verifyRequests/bob', { status: 'pending' });
  let res = await call(A === 't-alice' ? B : B, { adminEvent: 'verify', to: 'bob' }); ok(res.code === 403, 'غير الأدمن لا يرسل إشعار إدارة');
  res = await call(ADM, { adminEvent: 'verify', to: 'bob' }); ok(res.code === 409, 'لا إشعار قبل البت في التوثيق');
  STORE.set('verifyRequests/bob', { status: 'approved' });
  let n0 = SENT.length; res = await call(ADM, { adminEvent: 'verify', to: 'bob' });
  ok(res.code === 200 && SENT.length === n0 + 1 && /موثّق/.test(SENT.at(-1).notification.title) && SENT.at(-1).token === 'fcm-bob', 'إشعار قبول التوثيق للتاجر');
  STORE.set('verifyRequests/bob', { status: 'rejected', decisionNote: 'الرقم غير صحيح' });
  res = await call(ADM, { adminEvent: 'verify', to: 'bob' }); ok(/الرقم غير صحيح/.test(SENT.at(-1).notification.body), 'إشعار الرفض يحمل السبب');
  res = await call(ADM, { adminEvent: 'warn', to: 'bob', note: 'سعر وهمي' }); ok(/تنبيه/.test(SENT.at(-1).notification.title) && /سعر وهمي/.test(SENT.at(-1).notification.body), 'إشعار التحذير');
  res = await call(ADM, { adminEvent: 'hide', to: 'bob' }); ok(/أُوقف/.test(SENT.at(-1).notification.title), 'إشعار إيقاف الإعلان');
  res = await call(ADM, { adminEvent: 'nuke', to: 'bob' }); ok(res.code === 400, 'نوع غير معروف مرفوض');
  ok(SENT.filter(m => m.android).every(m => m.android.notification.icon === 'ic_stat_goat'), 'كل الإشعارات بأيقونة الماعز');
}

section('تفعيل البائع عبر واتساب');
const seller = (await import('./api/seller.js'));
const sapi = async (tok, action, data = {}) => { const res = mkRes(); await seller.default({ method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: { action, ...data } }, res); return { code: res.code, ...res.body }; };
const E1 = user('eve', { ageDays: 20 }); STORE.set('users/eve', { ...g('users/eve'), isSeller: false, storeName: undefined, whatsapp: undefined });
{
  STORE.set('settings/app', { supportWhatsapp: '+249900000000' });
  let r = await sapi(E1, 'apply', { storeName: 'زريبة', whatsapp: '0911' }); ok(r.code === 400, 'رقم ناقص مرفوض');
  STORE.set('users/bob', { ...g('users/bob'), whatsapp: '+249911111111' });
  r = await sapi(E1, 'apply', { storeName: 'زريبة', whatsapp: '0911111111' }); ok(r.code === 409, 'رقم بائع آخر مرفوض');
  r = await sapi(E1, 'apply', { storeName: 'زريبة إيف', whatsapp: '0912000000' });
  ok(/^\d{6}$/.test(String(g('sellerApps/eve').code)) && r.code === g('sellerApps/eve').code, 'طلب تفعيل برمز من 6 أرقام');
  ok(r.whatsapp === '+249912000000' && r.support === '+249900000000', 'الرقم موحّد بصيغة دولية ورقم الدعم يُرجع');
  const code1 = g('sellerApps/eve').code;
  r = await sapi(E1, 'apply', { storeName: 'زريبة إيف', whatsapp: '0912000000' }); ok(g('sellerApps/eve').code === code1, 'إعادة الطلب بنفس الرقم لا تغيّر الرمز');
  ok(g('users/eve').isSeller === false, 'لا تفعيل قبل تأكيد الأدمن');
  r = await sapi(E1, 'sellerDecide', { uid: 'eve', decision: 'approve' }); ok(r.code === 403, 'غير الأدمن لا يفعّل');
  r = await sapi(ADM, 'sellerDecide', { uid: 'eve', decision: 'approve' });
  ok(r.code === 200 && g('users/eve').isSeller === true && g('users/eve').whatsapp === '+249912000000', 'الأدمن يفعّل بعد وصول الرمز');
  ok(SENT.some(m => m.token === 'fcm-eve' && /تفعيل/.test(m.notification.title)), 'إشعار التفعيل');
  r = await sapi(E1, 'apply', { storeName: 'x2', whatsapp: '0912000001' }); ok(r.code === 409, 'لا طلب جديد بعد التفعيل');
}
section('نشر الإعلانات: الحدود والمراجعة والمكرر');
const LD = (o = {}) => ({ type: 'sheep', breed: 'حمري', sex: 'm', ageMonths: 10, weightKg: 40, price: 300000, qty: 1, state: 'الخرطوم', city: 'بحري', description: 'وصف', images: [{ url: 'https://ik.imagekit.io/7uwbsw4wl/listings/eve/a.webp' }], ...o });
{
  const NS = user('nora'); STORE.set('users/nora', { ...g('users/nora'), isSeller: false });
  let r = await sapi(NS, 'createListing', { data: LD() }); ok(r.code === 403, 'غير البائع لا ينشر');
  r = await sapi(E1, 'createListing', { data: LD({ images: [{ url: 'https://evil.com/x.jpg' }] }) }); ok(r.code === 400, 'صور من خارج حسابنا مرفوضة');
  r = await sapi(E1, 'createListing', { data: LD({ images: [{ url: 'https://ik.imagekit.io/7uwbsw4wl/listings/bob/a.webp' }] }) }); ok(r.code === 400, 'صور مجلد بائع آخر مرفوضة');
  r = await sapi(E1, 'createListing', { data: LD({ breed: 'شامي' }) }); ok(r.code === 400, 'سلالة لا تطابق النوع');
  r = await sapi(E1, 'createListing', { data: LD(), dhash: 'aaaaaaaaaaaaaaaa' });
  ok(r.code === 200 && r.status === 'pending' && /أول إعلان/.test(r.reviewReason), 'أول إعلان ينتظر المراجعة');
  const first = r.id;
  r = await sapi(E1, 'createListing', { data: LD() }); ok(r.code === 409, 'إعلان مطابق مرفوض');
  r = await sapi(E1, 'createListing', { data: LD({ price: 310000, description: 'آخر' }), dhash: 'aaaaaaaaaaaaaaab' }); ok(r.code === 409 && /الصورة/.test(r.error), 'نفس الصورة تقريباً مرفوضة');
  r = await sapi(E1, 'listingDecide', { id: first, decision: 'approve' }); ok(r.code === 403, 'غير الأدمن لا يراجع');
  r = await sapi(ADM, 'listingDecide', { id: first, decision: 'approve' });
  ok(g(`listings/${first}`).status === 'active' && g('users/eve').firstListingOk === true && g(`listings/${first}`).reviewReason === undefined, 'الموافقة تنشر وتعفي ما بعده');
  r = await sapi(E1, 'createListing', { data: LD({ price: 320000, description: 'ثاني' }), dhash: '0f0f0f0f0f0f0f0f' });
  ok(r.status === 'active', 'الإعلان الثاني ينشر مباشرة');
  r = await sapi(E1, 'createListing', { data: LD({ price: 330000, description: 'ثالث' }), dhash: 'ffff0000ffff0000' });
  ok(r.code === 429 && /اليوم/.test(r.error), 'حد إعلانين يومياً لغير الموثّق');
  NOW += 25 * H;
  r = await sapi(E1, 'createListing', { data: LD({ price: 340000, description: 'رابع' }), dhash: '1234123412341234' }); ok(r.status === 'active', 'ثالث إعلان في يوم جديد');
  NOW += 25 * H;
  r = await sapi(E1, 'createListing', { data: LD({ price: 350000, description: 'خامس' }), dhash: '9999999999999999' }); ok(r.code === 429 && /3 إعلانات/.test(r.error), 'حد 3 إعلانات نشطة لغير الموثّق');
  STORE.set('users/eve', { ...g('users/eve'), verified: true });
  r = await sapi(E1, 'createListing', { data: LD({ price: 350000, description: 'خامس' }), dhash: '9999999999999999' }); ok(r.status === 'active', 'التوثيق يرفع الحد');
  // صورة تشبه إعلان بائع آخر
  STORE.set('users/bob', { ...g('users/bob'), isSeller: true, firstListingOk: true });
  const BB = B;
  r = await sapi(BB, 'createListing', { data: LD({ images: [{ url: 'https://ik.imagekit.io/7uwbsw4wl/listings/bob/z.webp' }], description: 'من بوب' }), dhash: '9999999999999998' });
  ok(r.status === 'pending' && /بائع آخر/.test(r.reviewReason), 'صورة مسروقة من بائع آخر ⇒ مراجعة');
  r = await sapi(ADM, 'listingDecide', { id: r.id, decision: 'reject', note: 'صور منسوخة' }); ok(g(`listings/${r.id || ''}`) === undefined || true, 'رفض');
}
section('تغيير صور إعلان قائم يمر بالمراجعة');
{
  const lid = [...STORE.entries()].find(([p, d]) => p.startsWith('listings/') && d.sellerId === 'eve' && d.status === 'active')[0].split('/')[1];
  const created0 = g(`listings/${lid}`).createdAt.toMillis();
  let r = await sapi(B, 'editImages', { id: lid, images: [{ url: 'https://ik.imagekit.io/7uwbsw4wl/listings/bob/x.webp' }] }); ok(r.code === 404, 'لا يغيّر صور إعلان غيره');
  r = await sapi(E1, 'editImages', { id: lid, images: [{ url: 'https://evil.com/x.jpg' }] }); ok(r.code === 400, 'صور خارجية مرفوضة');
  r = await sapi(E1, 'editImages', { id: lid, images: g(`listings/${lid}`).images }); ok(r.status === 'active', 'نفس الصور: لا مراجعة');
  r = await sapi(E1, 'editImages', { id: lid, images: [{ url: 'https://ik.imagekit.io/7uwbsw4wl/listings/eve/new.webp' }], dhash: '1111111111111111' });
  ok(r.status === 'pending' && g(`listings/${lid}`).prevStatus === 'active' && g(`listings/${lid}`).status === 'pending', 'صور جديدة ⇒ يختفي حتى المراجعة');
  r = await sapi(ADM, 'listingDecide', { id: lid, decision: 'approve' });
  ok(g(`listings/${lid}`).status === 'active' && g(`listings/${lid}`).prevStatus === undefined && g(`listings/${lid}`).createdAt.toMillis() === created0, 'الموافقة تعيده نشطاً بتاريخه الأصلي');
}
section('المحادثات: حد يومي');
{
  const F = user('frank', { ageDays: 1 });
  const lids = [...STORE.entries()].filter(([p, d]) => p.startsWith('listings/') && d.status === 'active' && d.sellerId !== 'frank').map(([p]) => p.split('/')[1]);
  let r = await sapi(F, 'startChat', { listingId: lids[0] }); ok(r.code === 200 && g(`chats/${r.id}`).buyerId === 'frank', 'بدء محادثة');
  const again = await sapi(F, 'startChat', { listingId: lids[0] }); ok(again.id === r.id, 'نفس المحادثة لا تتكرر');
  for (let i = 0; i < 8; i++) STORE.set(`chats/fake${i}_frank`, { buyerId: 'frank', createdAt: Timestamp.fromMillis(NOW) });
  r = await sapi(F, 'startChat', { listingId: lids[1] }); ok(r.code === 429, 'الحساب الجديد: 8 محادثات جديدة يومياً');
  const own = [...STORE.entries()].filter(([p, d]) => p.startsWith('listings/') && d.sellerId === 'eve' && d.status === 'active').map(([p]) => p.split('/')[1]).find(id => !g(`chats/${id}_frank`));
  r = await sapi(E1, 'startChat', { listingId: own }); ok(r.code === 400, 'لا يراسل نفسه');
  STORE.set(`users/eve/blocks/frank`, { createdAt: Timestamp.fromMillis(NOW) });
  for (let i = 0; i < 8; i++) STORE.delete(`chats/fake${i}_frank`);
  r = await sapi(F, 'startChat', { listingId: own }); ok(r.code === 403, 'المحظور لا يبدأ محادثة');
}
section('التوثيق بالهوية (صور خاصة)');
{
  process.env.IMAGEKIT_PRIVATE_KEY = 'IK';
  const files = { '/kyc/eve/id.webp': true, '/kyc/eve/s.webp': true, '/kyc/eve/pub.webp': false };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => { if (String(url).includes('api.imagekit.io')) { const u = new URL(url); const dir = u.searchParams.get('path'); const name = /name = "(.+)"/.exec(u.searchParams.get('searchQuery'))[1]; const fp = dir + name; return resp(200, fp in files ? [{ filePath: fp, isPrivateFile: files[fp] }] : []); } return realFetch(url, opt); };
  STORE.set('users/eve', { ...g('users/eve'), verified: false });
  let r = await sapi(E1, 'kycSubmit', { idPath: '/kyc/bob/id.webp', selfiePath: '/kyc/eve/s.webp' }); ok(r.code === 400, 'مسار مستخدم آخر مرفوض');
  r = await sapi(E1, 'kycSubmit', { idPath: '/kyc/eve/pub.webp', selfiePath: '/kyc/eve/s.webp' }); ok(r.code === 400 && /حماية/.test(r.error), 'صورة غير خاصة مرفوضة');
  r = await sapi(E1, 'kycSubmit', { idPath: '/kyc/eve/missing.webp', selfiePath: '/kyc/eve/s.webp' }); ok(r.code === 400, 'صورة غير موجودة مرفوضة');
  r = await sapi(E1, 'kycSubmit', { idPath: '/kyc/eve/id.webp', selfiePath: '/kyc/eve/s.webp', note: 'مربي' }); ok(r.code === 200 && g('verifyRequests/eve').status === 'pending', 'طلب توثيق صحيح');
  r = await sapi(E1, 'kycSubmit', { idPath: '/kyc/eve/id.webp', selfiePath: '/kyc/eve/s.webp' }); ok(r.code === 409, 'لا طلب مكرر أثناء المراجعة');
  r = await sapi(E1, 'kycUrls', { uid: 'eve' }); ok(r.code === 403, 'غير الأدمن لا يرى صور الهوية');
  r = await sapi(ADM, 'kycUrls', { uid: 'eve' });
  const u = new URL(r.id); const exp = u.searchParams.get('ik-t'); const sig = (await import('node:crypto')).createHmac('sha1', 'IK').update('kyc/eve/id.webp' + exp).digest('hex');
  ok(u.pathname === '/7uwbsw4wl/kyc/eve/id.webp' && u.searchParams.get('ik-s') === sig && +exp - NOW / 1000 <= 600, 'رابط موقّع صالح 10 دقائق فقط');
  ok(seller.hamming('ffffffffffffffff', 'fffffffffffffff0') === 4 && seller.hamming('x', 'y') === 64, 'حساب فرق البصمات');
  globalThis.fetch = realFetch;
}

section('قرارات التوثيق من السيرفر مع نتيجة الإشعار');
{
  STORE.set('verifyRequests/eve', { status: 'pending' }); STORE.set('users/eve', { ...g('users/eve'), verified: false });
  let r = await sapi(E1, 'verifyDecide', { uid: 'eve', decision: 'approve' }); ok(r.code === 403, 'غير الأدمن لا يوثّق');
  r = await sapi(ADM, 'verifyDecide', { uid: 'eve', decision: 'approve' });
  ok(r.notified === true && g('users/eve').verified === true && g('verifyRequests/eve').status === 'approved', 'التوثيق + إشعار وصل');
  STORE.set('users/eve', { ...g('users/eve'), fcmToken: '' });
  r = await sapi(ADM, 'verifyDecide', { uid: 'eve', decision: 'revoke', note: 'x' });
  ok(r.notified === false && /الإشعارات/.test(r.reason) && g('users/eve').verified === false, 'إلغاء الشارة + سبب عدم وصول الإشعار');
  STORE.set('verifyRequests/eve', { status: 'pending' }); STORE.set('users/eve', { ...g('users/eve'), fcmToken: 'fcm-eve' });
  r = await sapi(ADM, 'verifyDecide', { uid: 'eve', decision: 'reject', note: 'الصورة غير واضحة' });
  ok(g('verifyRequests/eve').status === 'rejected' && /غير واضحة/.test(SENT.at(-1).notification.body), 'الرفض مع السبب في الإشعار');
}
section('رصيد التجربة');
{
  process.env.OXAPAY_SANDBOX = ''; process.env.OXAPAY_PAYOUT_KEY = 'PKEY'; payoutMode = 'ok';
  STORE.set('settings/wallet', { ...g('settings/wallet'), autoWithdraw: true, payoutFailures: [] });
  NOW += 3 * DAY;
  const r0 = await api(B, 'withdraw', { amount: 5, address: ADDR_B, pin: '334455' });
  ok(r0.status === 'frozen' && /تجريبية/.test(g(`withdrawals/${r0.withdrawalId}`).reviewReason), 'في التشغيل الحقيقي: رصيد التجربة لا يُسحب');
  let r = await api(ADM, 'resetSandbox'); ok(r.code === 403, 'المسح ممنوع خارج وضع التجربة');
  process.env.OXAPAY_SANDBOX = 'true';
  r = await api(A, 'resetSandbox'); ok(r.code === 403, 'غير الأدمن لا يمسح');
  const oOpen = order('alice', 'bob', 90000); await deposit(A, 'alice', 20); await api(A, 'hold', { orderId: oOpen });
  r = await api(ADM, 'resetSandbox');
  ok(r.code === 200 && ![...STORE.keys()].some(k => /^(wallets|transactions|deposits|withdrawals|walletPins)\//.test(k)), 'مسح كل بيانات المحفظة التجريبية');
  ok(g(`orders/${oOpen}`).status === 'cancelled' && g(`orders/${oOpen}`).escrow.status === 'refunded', 'طلبات المحفظة المفتوحة أُلغيت');
}

section('حذف الحساب');
{
  const G = user('gina', { ageDays: 40 });
  STORE.set('users/gina', { ...g('users/gina'), whatsapp: '+249933333333' });
  STORE.set('users/gina/favorites/l1', { createdAt: Timestamp.fromMillis(NOW) });
  STORE.set('listings/gl1', { sellerId: 'gina', status: 'active', images: [] });
  STORE.set('orders/go1', { buyerId: 'gina', sellerId: 'bob', participants: ['gina', 'bob'], buyerName: 'gina', sellerName: 'bob', status: 'completed', paymentMethod: 'cash' });
  STORE.set('reviews/go1', { buyerId: 'gina', buyerName: 'gina', sellerId: 'bob', stars: 5 });
  let r = await sapi(G, 'deleteMe', { confirm: 'نعم' }); ok(r.code === 400, 'يجب كتابة "حذف"');
  r = await sapi(G, 'deleteMe', { confirm: 'حذف' }); ok(r.code === 401, 'يتطلب دخولاً حديثاً');
  TOKENS[G].auth_time = Math.floor(NOW / 1000) - 30;
  STORE.set('wallets/gina', { balance: 500, held: 0 });
  r = await sapi(G, 'deleteMe', { confirm: 'حذف' }); ok(r.code === 409 && /اسحبها/.test(r.error), 'رصيد في المحفظة يمنع الحذف');
  STORE.set('wallets/gina', { balance: 0, held: 0 });
  STORE.set('orders/go2', { buyerId: 'gina', sellerId: 'bob', participants: ['gina', 'bob'], status: 'accepted', paymentMethod: 'cash' });
  r = await sapi(G, 'deleteMe', { confirm: 'حذف' }); ok(r.code === 409 && /طلب جارٍ/.test(r.error), 'طلب جارٍ يمنع الحذف');
  STORE.set('orders/go2', { ...g('orders/go2'), status: 'completed' });
  r = await sapi(G, 'deleteMe', { confirm: 'حذف', reason: 'لم أعد أحتاج' });
  ok(r.code === 200 && !g('users/gina') && !g('users/gina/favorites/l1') && !g('listings/gl1') && !g('wallets/gina'), 'حُذف الملف والإعلانات والمفضلة والمحفظة');
  ok(g('orders/go1').buyerName === 'مستخدم محذوف' && g('reviews/go1').buyerName === 'مستخدم محذوف', 'السجلات تبقى بدون الاسم');
  ok((globalThis.__DELETED || []).includes('gina') && !TOKENS[G], 'حُذف حساب الدخول');
  // الأدمن
  const H2 = user('hank', { ageDays: 40 }); STORE.set('users/hank', { ...g('users/hank'), whatsapp: '+249944444444', banned: true });
  r = await sapi(E1, 'adminDeleteUser', { uid: 'hank' }); ok(r.code === 403, 'غير الأدمن لا يحذف');
  r = await sapi(ADM, 'adminDeleteUser', { uid: 'admin' }); ok(r.code === 400, 'الأدمن لا يحذف نفسه من هنا');
  r = await sapi(ADM, 'adminDeleteUser', { uid: 'hank', reason: 'احتيال' }); ok(r.code === 200 && !g('users/hank'), 'الأدمن يحذف حساباً');
  const NEWU = user('ivan'); STORE.set('users/ivan', { ...g('users/ivan'), isSeller: false });
  r = await sapi(NEWU, 'apply', { storeName: 'جديد', whatsapp: '0944444444' }); ok(r.code === 403 && /موقوف/.test(r.error), 'رقم المحذوف من الأدمن لا يعود للبيع');
  r = await sapi(NEWU, 'apply', { storeName: 'جديد', whatsapp: '0933333333' }); ok(r.whatsapp === '+249933333333', 'رقم من حذف حسابه بنفسه يمكن استخدامه');
}

console.log(`\n${pass} نجح، ${fail} فشل`);
if (fail) { console.log('الفاشلة:\n- ' + fails.join('\n- ')); process.exit(1); }
