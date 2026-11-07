// مقارنة بصمتي أنماط: node tests/ui/style-diff.js before.json after.json
// تُستخدم قبل/بعد أي إعادة تنظيم لـ CSS: لا فرق = لا تغيير مرئي في أي عنصر من الشاشات الملتقطة.
const fs = require('fs'); const [,, A, B] = process.argv;
const a = JSON.parse(fs.readFileSync(A)), b = JSON.parse(fs.readFileSync(B));
const diff = Object.keys(a).filter(k => !b[k] || a[k].h !== b[k].h);
console.log(diff.length ? `فروق في: ${diff.join(', ')}` : `لا فروق (${Object.keys(a).length} شاشة، ${Object.values(a).reduce((n, v) => n + v.n, 0)} عنصراً)`);
process.exit(diff.length ? 1 : 0);
