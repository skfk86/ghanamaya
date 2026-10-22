// تهيئة Firebase Admin مشتركة بين الدوال (الملفات التي تبدأ بـ _ لا تصبح مسارات في Vercel)
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function app() {
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
}
export const adminAuth = () => { app(); return getAuth(); };
export const adminDb = () => { app(); return getFirestore(); };

// CORS: التطبيق يعمل من https://localhost داخل Capacitor
export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// مثل verifyUser لكن يعيد التوكن كاملاً (لفحص صلاحية الأدمن)
export async function verifyToken(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try { return await adminAuth().verifyIdToken(h.slice(7)); } catch { return null; }
}

// يتحقق من توكن Firebase المرسل في الهيدر ويعيد uid أو null
export async function verifyUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try { return (await adminAuth().verifyIdToken(h.slice(7))).uid; } catch { return null; }
}
