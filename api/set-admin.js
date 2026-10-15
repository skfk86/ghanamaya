// غنماية — منح صلاحية الأدمن
// POST /api/set-admin  مع الهيدر  x-setup-secret  والجسم  {"email":"you@example.com"}  (أضف "revoke":true للسحب)
// متغيرات البيئة: FIREBASE_SERVICE_ACCOUNT ، ADMIN_SETUP_SECRET
import { timingSafeEqual } from 'node:crypto';
import { adminAuth } from './_firebase.js';

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const secret = process.env.ADMIN_SETUP_SECRET;
  if (!secret || secret.length < 24) return res.status(500).json({ error: 'ADMIN_SETUP_SECRET غير مضبوط أو قصير' });
  if (!sameSecret(req.headers['x-setup-secret'], secret)) return res.status(401).json({ error: 'غير مصرّح' });

  const { email, revoke } = req.body || {};
  if (typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'email مطلوب' });

  try {
    const auth = adminAuth();
    const user = await auth.getUserByEmail(email.trim());
    const claims = { ...(user.customClaims || {}) };
    if (revoke) delete claims.admin; else claims.admin = true;
    await auth.setCustomUserClaims(user.uid, claims);
    return res.status(200).json({ ok: true, uid: user.uid, admin: !revoke, note: 'سجّل خروجاً ودخولاً لتفعيل الصلاحية' });
  } catch (e) {
    return res.status(400).json({ error: e.code || 'فشل' });
  }
}
