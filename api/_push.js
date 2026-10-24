// غنماية — إرسال إشعار FCM لمستخدم (لأحداث المال: إيداع، سحب، بيع، شراء، استرداد)
import { getMessaging } from 'firebase-admin/messaging';

// يرجع true/false. pushResult يرجع السبب أيضاً (لعرضه في لوحة الأدمن)
export async function pushTo(db, uid, msg) { return (await pushResult(db, uid, msg)).sent; }
export async function pushResult(db, uid, { title, body, data = {}, tag, channel = 'wallet' }) {
  try {
    const ref = db.doc(`users/${uid}`);
    const token = (await ref.get()).get('fcmToken');
    if (!token) return { sent: false, reason: 'المستخدم لم يفعّل الإشعارات (لم يفتح النسخة الحديثة أو رفض الإذن)' };
    const strData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
    await getMessaging().send({
      token, notification: { title, body }, data: strData,
      android: { priority: 'high', notification: { channelId: channel, icon: 'ic_stat_goat', tag: tag || undefined, sound: 'default', defaultSound: true, defaultVibrateTimings: true, notificationPriority: 'PRIORITY_MAX', color: '#3F5A2E' } }
    });
    return { sent: true };
  } catch (e) {
    if (String(e.code).includes('registration-token-not-registered')) await db.doc(`users/${uid}`).update({ fcmToken: '' }).catch(() => {});
    console.error('push', uid, e.code || e.message);
    return { sent: false, reason: String(e.code || e.message || 'فشل الإرسال').includes('not-registered') ? 'رمز الإشعارات قديم: يحتاج المستخدم فتح التطبيق مجدداً' : `فشل الإرسال: ${e.code || e.message}` };
  }
}
export const usd = (c) => (c / 100).toFixed(2);

// إشعارات إتمام صفقة بالمحفظة: البائع يستلم، والمشتري يُبلَّغ
export async function pushRelease(db, o, fee) {
  const net = o.escrow.amount - fee;
  await Promise.all([
    pushTo(db, o.sellerId, { title: '💵 وصلتك أموال البيع', body: `+${usd(net)} USDT أُضيفت لرصيدك من بيع ${o.title}`, data: { kind: 'sale', amount: net, orderId: o.id || '' }, tag: `sale-${o.id}` }),
    pushTo(db, o.buyerId, { title: '🎉 اكتملت عملية الشراء', body: `مبروك! ${o.title} صار لك. شكراً لثقتك بغنماية`, data: { kind: 'purchase', amount: o.escrow.amount, orderId: o.id || '' }, tag: `buy-${o.id}` })
  ]);
}
export async function pushRefund(db, o) {
  await pushTo(db, o.buyerId, { title: '↩️ أُعيد المبلغ لمحفظتك', body: `+${usd(o.escrow.amount)} USDT عادت لرصيدك من طلب ${o.title}`, data: { kind: 'refund', amount: o.escrow.amount, orderId: o.id || '' }, tag: o.id });
}
