// غنماية — صفحة مشاركة عامة لإعلان: /l/{id}
// تعرض معاينة غنية في واتساب (Open Graph)، وتفتح الإعلان في التطبيق إن كان مثبتاً، وإلا تدعو للتحميل.
import { adminDb } from './_firebase.js';

const PLAY = 'https://play.google.com/store/apps/details?id=com.ghanamaya.app';
const T = { goat: 'ماعز', sheep: 'خروف', cattle: 'عجل', camel: 'جمل' };
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('en-US') + ' ج.س';

export default async function handler(req, res) {
  const id = String((req.query && req.query.id) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  let l = null;
  if (id) { try { const s = await adminDb().doc(`listings/${id}`).get(); if (s.exists && ['active', 'sold'].includes(s.get('status'))) l = s.data(); } catch (e) { console.error('share', e.message); } }
  const title = l ? `${T[l.type] || ''} ${l.breed} — ${money(l.price)}` : 'غنماية — سوق المواشي الموثوق في السودان';
  const desc = l ? `${l.city}، ${l.state} · ${l.ageMonths} شهر · ${l.weightKg} كجم${l.status === 'sold' ? ' · مباع' : ''}. اطلبه بأمان على غنماية.` : 'بيع واشترِ الضأن والماعز بأمان: بائعون موثّقون، ودفع محمي.';
  const img = l && l.images && l.images[0] ? `${l.images[0].url}?tr=w-1200,h-630,c-at_max,q-75` : 'https://ghanamaya.vercel.app/play-icon-512.png';
  const app = `ghanamaya://l/${id}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
  res.status(l || !id ? 200 : 404).send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<meta property="og:type" content="product"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(img)}"><meta property="og:url" content="https://ghanamaya.vercel.app/l/${esc(id)}"><meta property="og:locale" content="ar_SD"><meta name="twitter:card" content="summary_large_image">
<style>:root{--brand:#3F5A2E;--bg:#F7F3EC;--s:#fff;--ink:#1F1D1A;--m:#6B655C}@media (prefers-color-scheme:dark){:root{--bg:#151412;--s:#201E1B;--ink:#F2EEE7;--m:#A39C91;--brand:#8DB06F}}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif;line-height:1.7}main{max-width:520px;margin:0 auto;padding:16px}
.c{background:var(--s);border-radius:22px;overflow:hidden}.c img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#ddd}.b{padding:16px 18px 20px}
h1{font-size:21px;margin:0}.p{font-size:22px;font-weight:800;color:var(--brand);margin:6px 0}.m{color:var(--m);font-size:14px}
a.btn{display:block;text-align:center;text-decoration:none;font-weight:700;padding:14px;border-radius:16px;margin-top:12px}.pr{background:var(--brand);color:#fff}.gh{border:1.5px solid var(--brand);color:var(--brand)}</style></head>
<body><main><div class="c">${l && l.images && l.images[0] ? `<img src="${esc(l.images[0].url)}?tr=w-900,q-75" alt="">` : ''}<div class="b">
<h1>${esc(l ? `${T[l.type] || ''} ${l.breed}` : 'غنماية')}</h1>${l ? `<div class="p">${esc(money(l.price))}</div><div class="m">${esc(desc)}</div>` : `<div class="m">${l === null && id ? 'هذا الإعلان لم يعد متاحاً.' : esc(desc)}</div>`}
<a class="btn pr" href="${esc(app)}">افتح في تطبيق غنماية</a><a class="btn gh" href="${PLAY}">حمّل غنماية من Google Play</a>
<p class="m" style="text-align:center;margin-top:14px">دفع محمي · بائعون موثّقون · لا تحوّل قبل المعاينة</p></div></div></main></body></html>`);
}
