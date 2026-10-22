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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  const raw = await rawBody(req);
  if (!validSig(raw, req.headers['hmac'], process.env.OXAPAY_MERCHANT_KEY)) {
    console.warn('oxapay: bad signature');
    return res.status(400).send('invalid signature');
  }
  let p; try { p = JSON.parse(raw); } catch { return res.status(400).send('bad json'); }

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
