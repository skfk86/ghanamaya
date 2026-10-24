// غنماية — إنشاء فهارس Firestore المركّبة اللازمة للسوق بالصفحات (من لوحة الأدمن)
// يستخدم حساب الخدمة نفسه عبر Firestore Admin REST API.
import { getApp } from 'firebase-admin/app';
import { readFileSync } from 'node:fs';
import { adminDb } from './_firebase.js';

export function wantedIndexes() {
  try { return JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url))).indexes; }
  catch { return []; }
}
const sig = (fields) => fields.map(f => `${f.fieldPath}:${f.order || f.arrayConfig}`).join(',');

export async function ensureIndexes() {
  adminDb(); // تهيئة التطبيق
  const project = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT).project_id;
  const { access_token: token } = await getApp().options.credential.getAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups`;
  const out = { created: 0, existing: 0, building: 0, failed: [] };
  const byGroup = {};
  for (const ix of wantedIndexes()) (byGroup[ix.collectionGroup] ||= []).push(ix);
  for (const [group, list] of Object.entries(byGroup)) {
    const r = await fetch(`${base}/${group}/indexes`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { out.failed.push(`قراءة الفهارس: ${r.status} ${(await r.text()).slice(0, 160)}`); continue; }
    const have = ((await r.json()).indexes || []).map(i => ({ sig: sig((i.fields || []).filter(f => f.fieldPath !== '__name__')), state: i.state }));
    for (const ix of list) {
      const found = have.find(h => h.sig === sig(ix.fields));
      if (found) { found.state === 'READY' ? out.existing++ : out.building++; continue; }
      const c = await fetch(`${base}/${group}/indexes`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ queryScope: ix.queryScope, fields: ix.fields }) });
      if (c.ok) out.created++; else out.failed.push(`${sig(ix.fields)}: ${c.status} ${(await c.text()).slice(0, 160)}`);
    }
  }
  return out;
}
