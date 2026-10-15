// غنماية — إرسال إشعار للطرف الآخر عند رسالة أو عرض جديد
// POST /api/notify  مع  Authorization: Bearer <Firebase ID token>  والجسم {"chatId":"...","messageId":"..."}
// يتحقق أن المرسل طرف في المحادثة وأنه صاحب الرسالة، ثم يرسل FCM للطرف الآخر.
import { getMessaging } from 'firebase-admin/messaging';
import { cors, verifyUser, adminDb } from './_firebase.js';

const preview = (m) => m.kind === 'image' ? 'أرسل صورة'
  : m.kind === 'offer' ? `عرض سعر: ${Number(m.offer.price).toLocaleString('en-US')} ج.س`
  : String(m.text || '').slice(0, 120);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const uid = await verifyUser(req);
  if (!uid) return res.status(401).json({ error: 'سجّل الدخول أولاً' });

  const { chatId, messageId, event } = req.body || {};
  if (typeof chatId !== 'string' || typeof messageId !== 'string') return res.status(400).json({ error: 'بيانات ناقصة' });

  const db = adminDb();
  const chatSnap = await db.doc(`chats/${chatId}`).get();
  if (!chatSnap.exists) return res.status(404).json({ error: 'not found' });
  const chat = chatSnap.data();
  if (!chat.participants.includes(uid)) return res.status(403).json({ error: 'forbidden' });

  const msgSnap = await db.doc(`chats/${chatId}/messages/${messageId}`).get();
  if (!msgSnap.exists) return res.status(404).json({ error: 'not found' });
  const msg = msgSnap.data();

  // رسالة جديدة: المرسل هو صاحبها. رد على عرض: المستجيب هو الطرف الآخر.
  const isReply = event === 'offer-reply' && msg.kind === 'offer' && msg.senderId !== uid;
  if (!isReply && msg.senderId !== uid) return res.status(403).json({ error: 'forbidden' });

  const to = chat.participants.find(p => p !== uid);
  const [toUser, fromUser] = await Promise.all([db.doc(`users/${to}`).get(), db.doc(`users/${uid}`).get()]);
  const token = toUser.get('fcmToken');
  if (!token) return res.status(200).json({ ok: true, sent: false });

  const fromName = fromUser.get('storeName') || fromUser.get('name') || 'غنماية';
  const status = { accepted: 'قبل عرضك', rejected: 'رفض عرضك', countered: 'ردّ بعرض جديد' }[msg.offer && msg.offer.status];
  const body = isReply ? `${status || 'ردّ على عرضك'} · ${chat.listingTitle}` : preview(msg);

  try {
    await getMessaging().send({
      token,
      notification: { title: fromName, body },
      data: { chatId },
      android: { priority: 'high', notification: { channelId: 'messages', tag: chatId } }
    });
    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    // توكن قديم: نحذفه حتى لا نحاول مجدداً
    if (String(e.code).includes('registration-token-not-registered')) {
      await db.doc(`users/${to}`).update({ fcmToken: '' }).catch(() => {});
    }
    return res.status(200).json({ ok: true, sent: false });
  }
}
