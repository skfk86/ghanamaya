// غنماية — استقبال البلاغات (لا يكتب العميل البلاغات مباشرة)
// POST /api/report  مع  Authorization: Bearer <ID token>
// الجسم: {"targetType":"listing|user|chat","targetId":"...","reason":"...","note":"...","evidenceUrl":"..."}
// - بلاغ واحد لكل (مبلّغ + هدف)، وحد أقصى 10 بلاغات يومياً لكل مستخدم
// - 3 مبلّغين مختلفين عن نفس الإعلان ⇒ إخفاؤه تلقائياً حتى المراجعة
import { FieldValue } from 'firebase-admin/firestore';
import { cors, verifyUser, adminDb } from './_firebase.js';

const REASONS = {
  fraud: { label: 'احتيال أو طلب تحويل قبل المعاينة', priority: 1 },
  stolen: { label: 'حيوان مسروق أو مشبوه', priority: 1 },
  fake_photos: { label: 'صور غير حقيقية', priority: 2 },
  wrong_specs: { label: 'حيوان مريض أو مواصفات خاطئة', priority: 2 },
  abuse: { label: 'إساءة أو تحرش', priority: 2 },
  duplicate: { label: 'إعلان مكرر أو سعر وهمي', priority: 3 },
  other: { label: 'سبب آخر', priority: 2 }
};
const AUTO_HIDE_AT = 3;
const DAILY_LIMIT = 10;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const uid = await verifyUser(req);
  if (!uid) return res.status(401).json({ error: 'سجّل الدخول أولاً' });

  const { targetType, targetId, reason, note = '', evidenceUrl = '' } = req.body || {};
  if (!['listing', 'user', 'chat'].includes(targetType) || typeof targetId !== 'string' || !targetId || targetId.length > 200) {
    return res.status(400).json({ error: 'بلاغ غير صالح' });
  }
  if (!REASONS[reason]) return res.status(400).json({ error: 'اختر سبباً' });
  if (evidenceUrl && !/^https:\/\/ik\.imagekit\.io\/7uwbsw4wl\//.test(evidenceUrl)) return res.status(400).json({ error: 'صورة غير صالحة' });

  const db = adminDb();

  // الهدف موجود؟ ومن صاحبه؟ (المُبلَّغ عنه)
  let subjectUid = targetId, title = '', image = '';
  if (targetType === 'listing') {
    const l = await db.doc(`listings/${targetId}`).get();
    if (!l.exists) return res.status(404).json({ error: 'الإعلان غير موجود' });
    subjectUid = l.get('sellerId'); title = l.get('breed') ? `${l.get('breed')} · ${l.get('city')}` : ''; image = (l.get('images') || [])[0]?.url || '';
  } else if (targetType === 'chat') {
    const c = await db.doc(`chats/${targetId}`).get();
    if (!c.exists || !c.get('participants').includes(uid)) return res.status(403).json({ error: 'غير مسموح' });
    subjectUid = c.get('participants').find(p => p !== uid); title = c.get('listingTitle');
  } else {
    const u = await db.doc(`users/${targetId}`).get();
    if (!u.exists) return res.status(404).json({ error: 'المستخدم غير موجود' });
    title = u.get('storeName') || u.get('name');
  }
  if (subjectUid === uid) return res.status(400).json({ error: 'لا يمكنك الإبلاغ عن نفسك' });

  const reportId = `${targetType}_${targetId}_${uid}`;
  const ref = db.doc(`reports/${reportId}`);
  if ((await ref.get()).exists) return res.status(409).json({ error: 'أبلغت عن هذا من قبل، وهو قيد المراجعة' });

  // بدون فهارس مركّبة: نجلب بلاغات المستخدم ونعدّ ما في آخر 24 ساعة
  const since = Date.now() - 86400000;
  const mine = await db.collection('reports').where('reporterId', '==', uid).select('createdAt').get();
  const today = mine.docs.filter(d => d.get('createdAt') && d.get('createdAt').toMillis() > since).length;
  if (today >= DAILY_LIMIT) return res.status(429).json({ error: 'وصلت للحد اليومي للبلاغات' });

  // المبلّغ الذي رُفضت بلاغاته كثيراً تنخفض أولوية بلاغاته
  const reporter = await db.doc(`users/${uid}`).get();
  const dismissed = reporter.get('reportsDismissed') || 0;
  let priority = REASONS[reason].priority + (dismissed >= 3 ? 1 : 0);

  await ref.set({
    targetType, targetId, subjectUid, reporterId: uid, reporterName: reporter.get('name') || '',
    reason, reasonLabel: REASONS[reason].label, note: String(note).slice(0, 500), evidenceUrl,
    title, image, priority, status: 'open', createdAt: FieldValue.serverTimestamp()
  });

  // إخفاء تلقائي للإعلان
  let autoHidden = false;
  if (targetType === 'listing') {
    const n = await db.collection('reports').where('targetType', '==', 'listing').where('targetId', '==', targetId).where('status', '==', 'open').count().get();
    if (n.data().count >= AUTO_HIDE_AT) {
      const l = db.doc(`listings/${targetId}`);
      await db.runTransaction(async (t) => {
        const s = await t.get(l);
        if (s.exists && s.get('status') === 'active') { t.update(l, { status: 'hidden', hiddenReason: 'auto', updatedAt: FieldValue.serverTimestamp() }); autoHidden = true; }
      });
    }
  }
  return res.status(200).json({ ok: true, autoHidden });
}
