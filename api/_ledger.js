// غنماية — دفتر المحفظة: كل حركة مال تمر من هنا، داخل Firestore Transaction
// الوحدة: سنت USDT (عدد صحيح). 1 USDT = 100.
// wallets/{uid}: { balance, held }   ← المتاح، والمحجوز في طلبات جارية
// wallets/platform: { balance }       ← عمولات المنصة
// transactions/{id}: سجل غير قابل للتعديل لكل حركة
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './_firebase.js';

export const PLATFORM = 'platform';
export const fmt = (c) => (c / 100).toFixed(2);

export async function walletSettings(db = adminDb()) {
  const s = await db.doc('settings/wallet').get();
  const d = s.exists ? s.data() : {};
  return {
    commissionRate: typeof d.commissionRate === 'number' ? d.commissionRate : 0.03,  // 3% افتراضياً
    sdgPerUsdt: typeof d.sdgPerUsdt === 'number' && d.sdgPerUsdt > 0 ? d.sdgPerUsdt : 0, // 0 = الدفع بالمحفظة معطّل
    minWithdraw: d.minWithdraw || 500,        // 5 USDT
    maxDeposit: d.maxDeposit || 50000,        // 500 USDT لكل إيداع
    releaseDays: d.releaseDays || 3
  };
}

// قراءة محفظة داخل معاملة (يجب أن تسبق أي كتابة)
export async function readWallet(t, db, uid) {
  const ref = db.doc(`wallets/${uid}`);
  const s = await t.get(ref);
  return { ref, balance: s.exists ? s.get('balance') || 0 : 0, held: s.exists ? s.get('held') || 0 : 0 };
}

export function writeWallet(t, w, patch) {
  t.set(w.ref, { balance: w.balance, held: w.held, ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

export function logTx(t, db, uid, type, amount, extra = {}) {
  t.set(db.collection('transactions').doc(), {
    uid, type, amount, ...extra, createdAt: FieldValue.serverTimestamp()
  });
}

// تحرير مبلغ طلب محجوز للبائع بعد خصم العمولة (يُستدعى داخل معاملة بعد قراءة كل شيء)
export function releaseEscrow(t, db, { orderRef, order, buyerW, sellerW, platW, rate, by }) {
  const amt = order.escrow.amount;
  const fee = Math.round(amt * rate);
  buyerW.held -= amt;
  sellerW.balance += amt - fee;
  platW.balance += fee;
  writeWallet(t, buyerW, {}); writeWallet(t, sellerW, {}); writeWallet(t, platW, {});
  logTx(t, db, order.buyerId, 'purchase', -amt, { orderId: orderRef.id, note: order.title });
  logTx(t, db, order.sellerId, 'sale', amt - fee, { orderId: orderRef.id, fee, note: order.title });
  if (fee) logTx(t, db, PLATFORM, 'commission', fee, { orderId: orderRef.id });
  t.update(orderRef, {
    status: 'completed', 'escrow.status': 'released', 'escrow.fee': fee, releasedBy: by,
    updatedAt: FieldValue.serverTimestamp()
  });
}

export function refundEscrow(t, db, { orderRef, order, buyerW, status, reason, by }) {
  const amt = order.escrow.amount;
  buyerW.held -= amt;
  buyerW.balance += amt;
  writeWallet(t, buyerW, {});
  logTx(t, db, order.buyerId, 'refund', amt, { orderId: orderRef.id, note: order.title });
  t.update(orderRef, {
    status, cancelReason: reason || '', 'escrow.status': 'refunded', refundedBy: by,
    updatedAt: FieldValue.serverTimestamp()
  });
}
