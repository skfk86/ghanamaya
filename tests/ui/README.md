# اختبارات الواجهة (Playwright)
تعمل على نسخة وهمية من Firebase وبيانات تجريبية (`seed.js`)، بدون إنترنت.
- `node tests/ui/uitest.js www/index.html` — كل زر يُلمس فعلاً (لا شيء يغطيه)، حجم لمس كافٍ، لا أخطاء JS، لا تمرير أفقي، بالوضعين الفاتح والداكن.
- `node tests/ui/uitest.js admin/index.html admin` — نفس الفحص للوحة الأدمن.
- `node tests/ui/flow.js www/index.html` — مسارات بلمسات حقيقية: فتح إعلان، المحفظة، الإيداع، السحب، التبويبات، الطلب.
- `node tests/ui/shoot.js <html> <مجلد> '<json>'` — لقطات شاشة.
يتطلب Playwright مع Chromium.
