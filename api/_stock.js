// غنماية — خصم الكمية من الإعلان عند اكتمال البيع (مرة واحدة لكل طلب)
// إذا وصلت الكمية إلى صفر يُعلَّم الإعلان "مباعاً" تلقائياً ويختفي من السوق.
import { FieldValue } from 'firebase-admin/firestore';
import { pushTo } from './_push.js';

export async function applyStock(db, orderId) {
  const oref = db.doc(`orders/${orderId}`);
  const res = await db.runTransaction(async (t) => {
    const os = await t.get(oref);
    if (!os.exists) return null;
    const o = os.data();
    if (o.status !== 'completed' || o.stockApplied === true || !o.listingId) return null;
    const lref = db.doc(`listings/${o.listingId}`);
    const ls = await t.get(lref);
    if (!ls.exists) { t.update(oref, { stockApplied: true }); return null; }
    const left = Math.max(0, (ls.get('qty') || 0) - (o.qty || 1));
    const soldOut = left === 0;
    t.update(lref, { ...(soldOut ? { status: ls.get('status') === 'active' ? 'sold' : ls.get('status'), qty: 1, soldAt: FieldValue.serverTimestamp() } : { qty: left }), updatedAt: FieldValue.serverTimestamp() });
    t.update(oref, { stockApplied: true });
    return { soldOut, left, sellerId: o.sellerId, title: o.title, listingId: o.listingId };
  });
  if (res && res.soldOut) await pushTo(db, res.sellerId, { title: '🎉 بِيع كل ما في الإعلان', body: `نفدت كمية ${res.title}، فعلّمناه "مباعاً" وأخفيناه من السوق. يمكنك إعادة نشره من إعلاناتي إن توفر غيره.`, data: { kind: 'listing', listingId: res.listingId }, tag: `stock-${res.listingId}`, channel: 'orders' });
  return res;
}
