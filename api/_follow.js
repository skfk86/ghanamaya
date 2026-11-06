// غنماية — متابعة البائعين وتنبيه المتابعين بالإعلانات الجديدة
// التخزين: users/{follower}/following/{seller} و users/{seller}/followers/{follower}، والعداد followersCount في ملف البائع.
// الكتابة من السيرفر فقط (القواعد تمنع التطبيق) حتى لا يُزوَّر العداد.
import { FieldValue } from 'firebase-admin/firestore';
import { pushTo } from './_push.js';

export const MAX_FOLLOWING = 300;     // حد المتابعات لكل مستخدم (يمنع الإساءة)
export const MAX_ALERTS = 200;        // أقصى عدد متابعين يُنبَّهون لكل إعلان (حد القراءات المجانية)

export async function setFollow(db, uid, sellerId, on) {
  const fRef = db.doc(`users/${uid}/following/${sellerId}`), rRef = db.doc(`users/${sellerId}/followers/${uid}`), sRef = db.doc(`users/${sellerId}`);
  return db.runTransaction(async (t) => {
    const [f, s] = await Promise.all([t.get(fRef), t.get(sRef)]);
    if (!s.exists || s.get('isSeller') !== true) throw Object.assign(new Error('البائع غير موجود'), { user: true, code: 404 });
    if (on && f.exists) return { following: true, followers: s.get('followersCount') || 0 };
    if (!on && !f.exists) return { following: false, followers: s.get('followersCount') || 0 };
    const n = Math.max(0, (s.get('followersCount') || 0) + (on ? 1 : -1));
    if (on) { t.set(fRef, { createdAt: FieldValue.serverTimestamp() }); t.set(rRef, { createdAt: FieldValue.serverTimestamp() }); }
    else { t.delete(fRef); t.delete(rRef); }
    t.update(sRef, { followersCount: n });
    return { following: on, followers: n };
  });
}

// يُستدعى عند ظهور إعلان جديد للمشترين أول مرة (مرة واحدة لكل إعلان)
export async function alertFollowers(db, listingId) {
  const ref = db.doc(`listings/${listingId}`);
  const claimed = await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists || s.get('status') !== 'active' || s.get('followersNotified')) return null;
    t.update(ref, { followersNotified: true });
    return s.data();
  });
  if (!claimed) return 0;
  const fol = await db.collection(`users/${claimed.sellerId}/followers`).limit(MAX_ALERTS).get();
  const T = { goat: 'ماعز', sheep: 'خروف', cattle: 'عجل', camel: 'جمل' };
  const title = `🆕 ${claimed.sellerName || 'بائع تتابعه'} نشر إعلاناً جديداً`;
  const body = `${T[claimed.type] || ''} ${claimed.breed || ''} · ${Number(claimed.price || 0).toLocaleString('en-US')} ج.س · ${claimed.city || ''}`.trim();
  let sent = 0;
  const ids = fol.docs.map(d => d.id);
  for (let i = 0; i < ids.length; i += 25) {
    const r = await Promise.all(ids.slice(i, i + 25).map(uid => pushTo(db, uid, { title, body, data: { kind: 'listing', listingId }, tag: `new-${listingId}`, channel: 'orders' })));
    sent += r.filter(Boolean).length;
  }
  return sent;
}

// عند حذف حساب: إزالة متابعاته (وتحديث عدادات البائعين) ومتابعيه
export async function dropFollows(db, uid) {
  const [mine, theirs] = await Promise.all([db.collection(`users/${uid}/following`).get(), db.collection(`users/${uid}/followers`).get()]);
  for (const d of mine.docs) await setFollow(db, uid, d.id, false).catch(() => d.ref.delete().catch(() => {}));
  for (const d of theirs.docs) { await db.doc(`users/${d.id}/following/${uid}`).delete().catch(() => {}); await d.ref.delete().catch(() => {}); }
}
