// غنماية — تحرير المبالغ تلقائياً (يُشغّل يومياً من Vercel Cron)
// طلبات المحفظة المقبولة منذ أكثر من releaseDays بدون تأكيد أو نزاع ⇒ تُحرّر للبائع.
// الحماية: Vercel يرسل  Authorization: Bearer <CRON_SECRET>
import { adminDb } from './_firebase.js';
import { PLATFORM, walletSettings, readWallet, releaseEscrow } from './_ledger.js';
import { pushRelease } from './_push.js';
import { processDue } from './_payout.js';
import { applyStock } from './_stock.js';

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const db = adminDb();
  const set = await walletSettings(db);
  const cutoff = Date.now() - set.releaseDays * 86400000;
  const snap = await db.collection('orders').where('paymentMethod', '==', 'wallet').where('status', '==', 'accepted').get();
  let released = 0;
  for (const d of snap.docs) {
    const at = d.get('acceptedAt');
    if (!at || at.toMillis() > cutoff) continue;
    let fee = null, o0 = null;
    try {
      await db.runTransaction(async (t) => {
        const s = await t.get(d.ref);
        const o = s.data();
        if (o.status !== 'accepted' || !o.escrow || o.escrow.status !== 'held') return;
        const buyerW = await readWallet(t, db, o.buyerId), sellerW = await readWallet(t, db, o.sellerId), platW = await readWallet(t, db, PLATFORM);
        fee = releaseEscrow(t, db, { orderRef: d.ref, order: o, buyerW, sellerW, platW, rate: set.commissionRate, by: 'auto' });
        o0 = { ...o, id: d.id };
      });
      released++;
      if (o0) { await applyStock(db, o0.id); await pushRelease(db, o0, fee); }
    } catch (e) { console.error('release', d.id, e); }
  }
  const paid = await processDue(db, set, 25).catch((e) => { console.error('processDue', e); return 0; });
  return res.status(200).json({ ok: true, released, paid });
}
