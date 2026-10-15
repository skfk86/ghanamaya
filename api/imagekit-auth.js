// غنماية — توقيع رفع صورة واحدة إلى ImageKit
// GET /api/imagekit-auth[?purpose=chat]  مع  Authorization: Bearer <Firebase ID token>
// صور الإعلانات للبائعين فقط؛ صور المحادثات لأي مستخدم. كل توقيع صالح لملف واحد خلال 10 دقائق.
// متغير البيئة: IMAGEKIT_PRIVATE_KEY
import { createHmac, randomUUID } from 'node:crypto';
import { cors, verifyUser, adminDb } from './_firebase.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const key = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!key) return res.status(500).json({ error: 'IMAGEKIT_PRIVATE_KEY غير مضبوط' });

  const uid = await verifyUser(req);
  if (!uid) return res.status(401).json({ error: 'سجّل الدخول أولاً' });

  // صور الإعلانات للبائعين فقط، وصور المحادثات لأي مستخدم له ملف
  const forChat = req.query && req.query.purpose === 'chat';
  const user = await adminDb().doc(`users/${uid}`).get();
  if (!user.exists) return res.status(403).json({ error: 'أكمل ملفك أولاً' });
  if (!forChat && user.get('isSeller') !== true) {
    return res.status(403).json({ error: 'فعّل حساب البائع لرفع الصور' });
  }

  const token = randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 600;
  const signature = createHmac('sha1', key).update(token + expire).digest('hex');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ token, expire, signature, folder: forChat ? `/chat/${uid}` : `/listings/${uid}` });
}
