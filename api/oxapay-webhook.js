// غنماية — استقبال إشعارات OxaPay (callback_url)
// التحقق: الهيدر HMAC = HMAC-SHA512(النص الخام للطلب، OXAPAY_MERCHANT_KEY)
// عند الحالة Paid فقط يُضاف الرصيد، مرة واحدة لكل إيداع (idempotent).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './_firebase.js';
import { readWallet, writeWallet, logTx } from './_ledger.js';
import { pushTo, usd } from './_push.js';

// نحتاج النص الخام كما هو للتحقق من التوقيع
export const config = { api: { bodyParser: false } };
async function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}
function validSig(raw, sig, key) {
  if (!sig || !key) return false;
  const mine = createHmac('sha512', key).update(raw).digest('hex');
  const a = Buffer.from(mine), b = Buffer.from(String(sig).toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

async function payoutHook(req, res, p) {
  const db = adminDb();
  const status = String(p.status || '');
  const q = await db.collection('withdrawals').where('payoutTrackId', '==', String(p.track_id)).limit(1).get();
  if (q.empty) return res.status(200).send('ok');
  const ref = q.docs[0].ref;
  let notify = null;
  try {
    await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      const w = s.data();
      if (w.status !== 'processing') return;                       // حُسم مسبقاً
      if (status === 'Confirmed') {
        t.update(ref, { status: 'sent', txHash: String(p.tx_hash || ''), payoutStatus: status, decidedBy: 'auto', decidedAt: FieldValue.serverTimestamp() });
        notify = w;
      } else if (['Failed', 'Rejected', 'Canceled'].includes(status)) {
        // لا نعيد المال تلقائياً: الأدمن يقرر (إرسال يدوي أو رفض وإرجاع)
        t.update(ref, { status: 'frozen', payoutStatus: status, reviewReason: `فشل السحب في OxaPay (${status})` });
      } else {
        t.update(ref, { payoutStatus: status, ...(p.tx_hash ? { txHash: String(p.tx_hash) } : {}) });
      }
    });
  } catch (e) { console.error('payout webhook', e); return res.status(500).send('retry'); }
  if (notify) await pushTo(db, notify.uid, { title: '✅ تم تحويل سحبك بنجاح', body: `${usd(notify.amount)} USDT وصلت لمحفظتك على شبكة TRC20`, data: { kind: 'withdraw_sent', amount: notify.amount }, tag: `wd-${ref.id}` });
  return res.status(200).send('ok');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  const raw = await rawBody(req);
  let p; try { p = JSON.parse(raw); } catch { return res.status(400).send('bad json'); }
  // إشعارات السحب موقّعة بمفتاح Payout، والإيداع بمفتاح Merchant
  const isPayout = p && p.type === 'payout';
  if (!validSig(raw, req.headers['hmac'], isPayout ? process.env.OXAPAY_PAYOUT_KEY : process.env.OXAPAY_MERCHANT_KEY)) {
    console.warn('oxapay: bad signature', isPayout ? 'payout' : 'invoice');
    return res.status(400).send('invalid signature');
  }
  if (isPayout) return payoutHook(req, res, p);

  const depositId = p.order_id, status = String(p.status || '');
  if (!depositId) return res.status(200).send('ok');
  const db = adminDb();
  const ref = db.doc(`deposits/${depositId}`);

  let credited = null;
  try {
    await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists) return;
      const d = s.data();
      if (String(d.trackId) !== String(p.track_id)) return;   // لا يطابق الفاتورة التي أنشأناها
      if (d.status === 'paid') return;                          // أُضيف مسبقاً
      if (status === 'Paid') {
        const w = await readWallet(t, db, d.uid);
        w.balance += d.amount;
        writeWallet(t, w, {});
        logTx(t, db, d.uid, 'deposit', d.amount, { depositId, trackId: String(p.track_id), sandbox: !!d.sandbox });
        credited = { uid: d.uid, amount: d.amount };
        t.update(ref, { status: 'paid', paidAt: FieldValue.serverTimestamp(), txs: (p.txs || []).slice(0, 5) });
      } else if (status === 'Paying') {
        t.update(ref, { status: 'paying' });
      } else if (['Expired', 'Failed'].includes(status)) {
        t.update(ref, { status: status.toLowerCase() });
      }
    });
  } catch (e) {
    console.error('oxapay webhook', e);
    return res.status(500).send('retry');   // OxaPay يعيد المحاولة
  }
  if (credited) await pushTo(db, credited.uid, { title: '💰 تم شحن محفظتك بنجاح', body: `+${usd(credited.amount)} USDT أُضيفت لرصيدك. جاهز للشراء الآن`, data: { kind: 'deposit', amount: credited.amount }, tag: `dep-${depositId}` });
  return res.status(200).send('ok');
}
