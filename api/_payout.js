// غنماية — السحب التلقائي عبر OxaPay Payout API (نظام هجين)
// صغير + حساب قديم + لا إيداع حديث + ضمن الحدود اليومية ⇒ تلقائي. غير ذلك ⇒ مراجعة الأدمن.
// متغيرات البيئة: OXAPAY_PAYOUT_KEY (مفتاح Payout منفصل)، OXAPAY_PAYOUT_NETWORK (افتراضياً TRON)
import { FieldValue } from 'firebase-admin/firestore';
import { fmt } from './_ledger.js';

const DAY = 86400000;
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);

// يرجع null إن كان مؤهلاً، أو سبب التحويل للمراجعة اليدوية
async function reviewReason(db, set, { uid, me, cents, address, id }) {
  if (!set.autoWithdraw) return 'السحب التلقائي متوقف';
  if (!process.env.OXAPAY_PAYOUT_KEY) return 'مفتاح Payout غير مضبوط';
  if (process.env.OXAPAY_SANDBOX === 'true') return 'وضع التجربة: الأرصدة وهمية';
  if (cents > set.autoMax) return `أكبر من حد التلقائي (${fmt(set.autoMax)})`;
  if (me.get('verified') !== true && cents > set.autoMax / 2) return 'حساب غير موثّق ومبلغ متوسط';
  if (Date.now() - ms(me.get('createdAt')) < set.autoMinAgeDays * DAY) return `حساب عمره أقل من ${set.autoMinAgeDays} أيام`;
  const since = Date.now() - DAY;
  const [deps, mine, sameAddr, global] = await Promise.all([
    db.collection('deposits').where('uid', '==', uid).get(),
    db.collection('withdrawals').where('uid', '==', uid).get(),
    db.collection('withdrawals').where('address', '==', address).get(),
    db.collection('withdrawals').where('auto', '==', true).get()
  ]);
  if (deps.docs.some(d => d.get('status') === 'paid' && ms(d.get('paidAt')) > since)) return 'أودع خلال آخر 24 ساعة ثم سحب';
  if (sameAddr.docs.some(d => d.get('uid') !== uid)) return 'العنوان مستخدم من حساب آخر';
  const sum = (snap) => snap.docs.filter(d => d.id !== id && d.get('auto') === true && ms(d.get('createdAt')) > since && d.get('status') !== 'rejected').reduce((a, d) => a + (d.get('amount') || 0), 0);
  if (sum(mine) + cents > set.autoUserDaily) return 'تجاوز الحد اليومي للمستخدم';
  if (sum(global) + cents > set.autoGlobalDaily) return 'تجاوز الحد اليومي للمنصة';
  return null;
}

export async function tryAutoPayout(db, set, { id, uid, me, cents, address, callbackUrl }) {
  const ref = db.doc(`withdrawals/${id}`);
  const why = await reviewReason(db, set, { uid, me, cents, address, id });
  if (why) { await ref.update({ reviewReason: why }); return { auto: false }; }

  // حجز الطلب للتنفيذ التلقائي، حتى لا يرسله الأدمن يدوياً في نفس اللحظة
  const claimed = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || s.get('status') !== 'pending') return false;
    t.update(ref, { status: 'processing', auto: true, autoAt: FieldValue.serverTimestamp() });
    return true;
  });
  if (!claimed) return { auto: false };

  let out = {}, httpOk = false;
  try {
    const r = await fetch('https://api.oxapay.com/v1/payout', {
      method: 'POST',
      headers: { 'payout_api_key': process.env.OXAPAY_PAYOUT_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address, currency: 'USDT', network: process.env.OXAPAY_PAYOUT_NETWORK || 'TRON',
        amount: Number(fmt(cents)), callback_url: callbackUrl, description: `ghanamaya withdrawal ${id}`
      }),
      signal: AbortSignal.timeout(15000)
    });
    out = await r.json().catch(() => ({}));
    httpOk = r.ok && out.data && out.data.track_id;
  } catch (e) {
    // انقطاع: لا نعرف هل أُرسل أم لا ⇒ يُراجع يدوياً مع تحذير
    await ref.update({ status: 'pending', reviewReason: 'انقطع الاتصال بـ OxaPay أثناء السحب التلقائي: تحقق من سجل Payout قبل الإرسال يدوياً' });
    return { auto: false };
  }
  if (!httpOk) {
    const msg = (out.error && (out.error.message || out.error.key)) || out.message || 'خطأ غير معروف';
    console.error('payout', JSON.stringify(out).slice(0, 300));
    await ref.update({ status: 'pending', reviewReason: `رفضت OxaPay السحب التلقائي: ${String(msg).slice(0, 120)}` });
    return { auto: false };
  }
  await ref.update({ payoutTrackId: String(out.data.track_id), payoutStatus: String(out.data.status || 'Processing') });
  return { auto: true };
}
