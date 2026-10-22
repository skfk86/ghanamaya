// غنماية — رمز المحفظة (PIN) لتأكيد السحب
// يُحفظ مُجزّأً بـ scrypt + ملح في walletPins/{uid} (لا يقرؤه أحد من التطبيق).
// 5 محاولات خاطئة ⇒ قفل ساعة. تغيير الرمز أو استعادته ⇒ منع السحب 24 ساعة (يحمي من سارق الحساب).
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { pushTo } from './_push.js';

const H = 3600000;
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
const hash = (pin, salt) => scryptSync(pin, salt, 32).toString('hex');
const err = (message, code = 400) => Object.assign(new Error(message), { user: true, code });

function weak(pin) {
  if (!/^\d{6}$/.test(pin)) return 'الرمز 6 أرقام';
  if (/^(\d)\1{5}$/.test(pin)) return 'رمز ضعيف: أرقام متكررة';
  const asc = '01234567890', desc = '09876543210';
  if (asc.includes(pin) || desc.includes(pin)) return 'رمز ضعيف: أرقام متسلسلة';
  if (['121212', '112233', '123123', '696969', '101010'].includes(pin)) return 'رمز ضعيف، اختر غيره';
  return null;
}

export async function pinStatus(db, uid) {
  const s = await db.doc(`walletPins/${uid}`).get();
  const d = s.exists ? s.data() : {};
  return { hasPin: !!d.hash, lockedUntil: ms(d.lockedUntil) > Date.now() ? ms(d.lockedUntil) : 0, withdrawLockUntil: ms(d.withdrawLockUntil) > Date.now() ? ms(d.withdrawLockUntil) : 0 };
}

// تعيين أول مرة، أو تغيير (بالرمز القديم)، أو استعادة (بعد تسجيل دخول حديث خلال 5 دقائق)
export async function pinSet(db, uid, tok, { pin, oldPin, reset }) {
  pin = String(pin || '');
  const w = weak(pin); if (w) throw err(w);
  const ref = db.doc(`walletPins/${uid}`);
  const s = await ref.get();
  const d = s.exists ? s.data() : {};
  let changed = false;
  if (d.hash) {
    if (reset) {
      if (!tok.auth_time || Date.now() / 1000 - tok.auth_time > 300) throw err('لاستعادة الرمز: سجّل خروجاً ثم دخولاً، ثم أعد المحاولة خلال 5 دقائق', 401);
    } else {
      await pinCheck(db, uid, oldPin);
    }
    changed = true;
  }
  const salt = randomBytes(16).toString('hex');
  await ref.set({
    hash: hash(pin, salt), salt, fails: 0, lockedUntil: null, setAt: FieldValue.serverTimestamp(),
    ...(changed ? { withdrawLockUntil: Timestamp.fromMillis(Date.now() + 24 * H) } : {})
  }, { merge: true });
  if (changed) await pushTo(db, uid, { title: '🔐 تم تغيير رمز المحفظة', body: 'السحب متوقف 24 ساعة للحماية. لم تغيّره أنت؟ تواصل مع الدعم فوراً.', data: { kind: 'pin_changed' }, tag: 'pin' });
  return { ok: true, withdrawLockedHours: changed ? 24 : 0 };
}

export async function pinCheck(db, uid, pin) {
  const ref = db.doc(`walletPins/${uid}`);
  const res = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || !s.get('hash')) return { e: ['عيّن رمز المحفظة أولاً', 428] };
    const d = s.data();
    if (ms(d.lockedUntil) > Date.now()) return { e: [`محاولات كثيرة خاطئة. حاول بعد ${Math.ceil((ms(d.lockedUntil) - Date.now()) / 60000)} دقيقة`, 429] };
    const a = Buffer.from(hash(String(pin || ''), d.salt), 'hex'), b = Buffer.from(d.hash, 'hex');
    if (a.length === b.length && timingSafeEqual(a, b)) { if (d.fails) t.update(ref, { fails: 0 }); return {}; }
    const fails = (d.fails || 0) + 1;
    t.update(ref, { fails, ...(fails >= 5 ? { lockedUntil: Timestamp.fromMillis(Date.now() + H), fails: 0 } : {}) });
    return { e: [fails >= 5 ? 'رمز خاطئ 5 مرات: أُقفل السحب ساعة' : `رمز خاطئ. بقي ${5 - fails} محاولات`, 403], locked: fails >= 5 };
  });
  if (res.locked) await pushTo(db, uid, { title: '⚠️ محاولات خاطئة لرمز المحفظة', body: 'أُدخل رمز خاطئ 5 مرات، فأُقفل السحب ساعة. لم تكن أنت؟ غيّر كلمة سر حسابك.', data: { kind: 'pin_locked' }, tag: 'pin' });
  if (res.e) throw err(res.e[0], res.e[1]);
}

export async function withdrawGuard(db, uid, pin) {
  await pinCheck(db, uid, pin);
  const st = await pinStatus(db, uid);
  if (st.withdrawLockUntil) throw err(`السحب متوقف للحماية بعد تغيير الرمز. يُفتح بعد ${Math.ceil((st.withdrawLockUntil - Date.now()) / H)} ساعة`, 423);
}
