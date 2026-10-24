// غنماية — حذف حساب نهائياً (من المستخدم نفسه أو من الأدمن)
// يُمنع الحذف إن كان في الحساب مال أو طلبات/سحوبات جارية (حماية للطرفين).
// يُحذف: الملف، المفضلة، الحظر، البيانات الخاصة، الإعلانات، طلبات التفعيل والتوثيق، رمز المحفظة، صور ImageKit، حساب الدخول.
// يبقى (سجل مالي/قانوني) مع إخفاء الاسم: الطلبات، المعاملات، التقييمات، المحادثات.
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth } from './_firebase.js';

const GONE = 'مستخدم محذوف';
export const phoneHash = (p) => createHash('sha256').update('ghanamaya:' + String(p || '')).digest('hex');

// أسباب منع الحذف (فارغة = مسموح)
export async function deletionBlockers(db, uid) {
  const out = [];
  const w = await db.doc(`wallets/${uid}`).get();
  if (w.exists && ((w.get('balance') || 0) > 0)) out.push(`في محفظتك ${((w.get('balance') || 0) / 100).toFixed(2)} USDT. اسحبها أولاً`);
  if (w.exists && ((w.get('held') || 0) > 0)) out.push('لديك مبلغ محجوز في طلب جارٍ');
  const [ob, os] = await Promise.all([db.collection('orders').where('buyerId', '==', uid).get(), db.collection('orders').where('sellerId', '==', uid).get()]);
  const open = [...ob.docs, ...os.docs].filter(d => ['pending', 'accepted', 'paid', 'disputed'].includes(d.get('status')));
  if (open.length) out.push(`لديك ${open.length} طلب جارٍ. أكمله أو ألغه أولاً`);
  const wd = await db.collection('withdrawals').where('uid', '==', uid).get();
  if (wd.docs.some(d => ['pending', 'scheduled', 'processing', 'frozen'].includes(d.get('status')))) out.push('لديك طلب سحب جارٍ');
  return out;
}

async function ikDeleteFolder(prefix) {
  const key = process.env.IMAGEKIT_PRIVATE_KEY; if (!key) return 0;
  const auth = 'Basic ' + Buffer.from(key + ':').toString('base64');
  let n = 0;
  try {
    const r = await fetch(`https://api.imagekit.io/v1/files?path=${encodeURIComponent(prefix)}&limit=1000`, { headers: { Authorization: auth } });
    const list = r.ok ? await r.json() : [];
    const ids = (Array.isArray(list) ? list : []).filter(f => String(f.filePath || '').startsWith(prefix)).map(f => f.fileId);
    for (let i = 0; i < ids.length; i += 100) {
      const d = await fetch('https://api.imagekit.io/v1/files/batch/deleteByFileIds', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: ids.slice(i, i + 100) }) });
      if (d.ok) n += ids.slice(i, i + 100).length;
    }
  } catch (e) { console.error('ik delete', prefix, e.message); }
  return n;
}

export async function deleteAccount(db, uid, { by = 'user', reason = '' } = {}) {
  const uref = db.doc(`users/${uid}`);
  const u = await uref.get();
  const profile = u.exists ? u.data() : {};
  // أثر صغير يمنع التهرّب من الإيقاف بإعادة التسجيل بنفس الرقم (بدون أي بيانات شخصية)
  if (profile.whatsapp && (profile.banned || by === 'admin')) {
    await db.doc(`blockedPhones/${phoneHash(profile.whatsapp)}`).set({ banned: !!profile.banned || by === 'admin', at: FieldValue.serverTimestamp() });
  }
  const del = async (q) => { const s = await q.get(); for (const d of s.docs) await d.ref.delete(); return s.size; };
  let n = 0;
  for (const sub of ['favorites', 'blocks', 'private']) n += await del(uref.collection(sub));
  n += await del(db.collection('listings').where('sellerId', '==', uid));
  for (const p of [`sellerApps/${uid}`, `verifyRequests/${uid}`, `walletPins/${uid}`, `wallets/${uid}`]) { await db.doc(p).delete(); n++; }
  // إخفاء الاسم في السجلات التي تبقى
  const anon = async (q, fields) => { const s = await q.get(); for (const d of s.docs) await d.ref.update(Object.fromEntries(fields.map(f => [f, GONE]))); };
  await anon(db.collection('orders').where('buyerId', '==', uid), ['buyerName']);
  await anon(db.collection('orders').where('sellerId', '==', uid), ['sellerName']);
  await anon(db.collection('chats').where('buyerId', '==', uid), ['buyerName']);
  await anon(db.collection('chats').where('sellerId', '==', uid), ['sellerName']);
  await anon(db.collection('reviews').where('buyerId', '==', uid), ['buyerName']);
  await uref.delete();
  const images = (await ikDeleteFolder(`/listings/${uid}/`)) + (await ikDeleteFolder(`/kyc/${uid}/`)) + (await ikDeleteFolder(`/chat/${uid}/`));
  try { await adminAuth().deleteUser(uid); } catch (e) { if (!String(e.code).includes('user-not-found')) throw e; }
  await db.collection('deletions').add({ uid, by, reason: String(reason).slice(0, 200), at: FieldValue.serverTimestamp() });
  return { deleted: n, images };
}
