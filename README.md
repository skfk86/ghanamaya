# غنماية — المرحلة الأولى (الأساس)

تسجيل الدخول (Google + إيميل)، إكمال الملف، الحساب الهجين (مشترٍ ← بائع)، قواعد الأمان، دالة الأدمن، والبناء التلقائي للـ APK.

## الملفات
| الملف | الوظيفة |
|---|---|
| `www/index.html` | التطبيق كاملاً (ملف واحد) |
| `firestore.rules` | قواعد أمان Firestore |
| `api/set-admin.js` | دالة Vercel لمنح صلاحية الأدمن |
| `capacitor.config.json` | إعداد Capacitor (`com.ghanamaya.app`) |
| `.github/workflows/android.yml` | بناء APK تلقائياً عند كل push |

## خطوات الإعداد (مرة واحدة)

### 1. Firebase Console
1. **Authentication ← Sign-in method:** فعّل Email/Password و Google.
2. **Firestore Database:** أنشئها بمنطقة `eur3`.
3. **Project settings ← Add app ← Android:** الحزمة `com.ghanamaya.app`، ونزّل `google-services.json`.

### 2. التوقيع (تلقائي)
المفتاح موجود في `signing/ghanamaya.keystore` ويوقّع كل بناء تلقائياً، وكلمة سره في سر GitHub باسم `KEYSTORE_PASSWORD`.
أضف هاتين البصمتين في Firebase ← إعدادات تطبيق Android ← Add fingerprint، ثم نزّل `google-services.json` وضعه في جذر المستودع:
```
SHA1:   E5:A5:BF:85:21:C9:5D:C2:E0:6E:1C:A6:F7:0A:2A:03:D3:04:A6:E0
SHA256: 98:36:D4:4A:17:29:E2:02:18:47:DC:44:84:69:DA:4A:D9:C6:C0:DE:A5:CD:31:22:32:F9:AF:5B:F2:D2:A8:FA
```
**المستودع يجب أن يبقى خاصاً**، واحتفظ بنسخة من المفتاح وكلمة سره خارج GitHub: نفس المفتاح سيُستخدم لرفع التطبيق على Google Play.

### 3. نشر قواعد الأمان
انسخ محتوى `firestore.rules` إلى Firebase ← Firestore ← Rules ← Publish.
(أو: `npm i -g firebase-tools && firebase deploy --only firestore:rules --project ghanamaya-4e639`)

### 4. Vercel (الأدمن)
1. اربط المستودع بمشروع Vercel جديد.
2. Firebase ← Project settings ← Service accounts ← Generate new private key.
3. في Vercel ← Environment Variables:
   - `FIREBASE_SERVICE_ACCOUNT` = محتوى ملف JSON كاملاً
   - `ADMIN_SETUP_SECRET` = كلمة سر عشوائية طويلة (32 حرفاً فأكثر)
4. امنح نفسك صلاحية الأدمن (بعد أن تسجّل في التطبيق مرة):
```bash
curl -X POST https://<مشروعك>.vercel.app/api/set-admin \
  -H "x-setup-secret: <كلمة السر>" -H "Content-Type: application/json" \
  -d '{"email":"بريدك@gmail.com"}'
```

### 5. البناء
كل push على `main` يبني APK موقّعاً (`ghanamaya-apk`) وملف AAB لـ Google Play (`ghanamaya-aab-for-play`) في تبويب **Actions**.

محلياً: `npm install && npx cap add android` ثم أضف `rgcfaIncludeGoogle = true` داخل `ext {}` في `android/variables.gradle`، ثم `npm run build:debug`.


## الأمان في هذه المرحلة
- المستخدم يكتب فقط حقول ملفه المسموحة؛ `verified` و `rating` لا يكتبها إلا السيرفر.
- حساب بنكك في `users/{uid}/private/payout` لا يقرؤه إلا صاحبه والأدمن.
- البائع لا يستطيع إلغاء صفة البائع من التطبيق، والتفعيل يتطلب اسم متجر وواتساب.
- كل مجموعات المراحل القادمة مغلقة تماماً حتى تُكتب قواعدها.

## اختبار سريع من السودان
افتح التطبيق **بدون VPN** وتأكد أن تسجيل الدخول وحفظ الملف يعملان؛ هذا يؤكد أن Firebase متاح للمستخدمين هناك.
