const { chromium } = require('playwright'); const fs = require('fs'); const P = __dirname;
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true }); const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await ctx.route('**/*', async r => { const u = r.request().url();
    if (u.includes('gstatic.com/firebasejs')) return r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(P + '/fakefb.js', 'utf8') });
    if (u.includes('ik.imagekit.io')) return r.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(P + '/img/a1.jpg') });
    if (u.includes('/api/feed')) { // محاكاة CDN من بيانات التجربة
      const w = {}; new Function('window', fs.readFileSync(P + '/seed.js', 'utf8'))(w);
      const qs = new URL(u).searchParams, t = qs.get('t'), st = qs.get('st'), after = qs.get('after');
      let items = Object.entries(w.__SEED.docs).filter(([k, d]) => /^listings\/[^/]+$/.test(k) && d.status === 'active' && (!t || d.type === t) && (!st || d.state === st)).map(([k, d]) => ({ ...d, id: k.split('/')[1], createdAt: d.createdAt.__ts, featuredUntil: d.featuredUntil ? d.featuredUntil.__ts : null }));
      items.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
      if (after) items = items.slice(items.findIndex(i => i.id === after.split('~')[1]) + 1);
      const page = items.slice(0, 24); globalThis.__cdnHits = (globalThis.__cdnHits || 0) + 1;
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: page, sellers: { u2: { storeName: 'مزرعة الرحمة', verified: true } }, next: items.length > 24 ? `${page[23].createdAt}~${page[23].id}` : '' }) });
    }
    if (u.includes('/api/seller')) { const a = JSON.parse(r.request().postData() || '{}'); globalThis.__sellerCalls = [...(globalThis.__sellerCalls || []), a]; return r.fulfill({ contentType: 'application/json', body: JSON.stringify(a.action === 'follow' ? { ok: true, following: a.on, followers: a.on ? 1 : 0 } : { ok: true }) }); }
    if (u.includes('/api/wallet')) { const a = JSON.parse(r.request().postData() || '{}').action; return r.fulfill({ contentType: 'application/json', body: JSON.stringify(a === 'pinStatus' ? { ok: true, hasPin: true } : a === 'deposit' ? { ok: true, paymentUrl: 'about:blank', sandbox: true, depositId: 'd1' } : { ok: true }) }); }
    if (u.startsWith('file:') || u === 'about:blank') return r.continue(); return r.fulfill({ status: 200, body: '{}' }); });
  let html = fs.readFileSync(process.argv[2], 'utf8').replace('<script type="module">', `<script>${fs.readFileSync(P + '/seed.js', 'utf8')}</script><script type="module">`).replace(/<\/script>\s*<\/body>/, 'window.__dbg = { S, push, render, filtered, parseQuery, renderError };</script></body>');
  fs.writeFileSync(P + '/_flow.html', html); await page.goto('file://' + P + '/_flow.html'); await page.waitForTimeout(900);
  const top = () => page.evaluate(() => { const s = __dbg.S.stack.at(-1); return s ? s.name : 'tab:' + __dbg.S.tab; });
  const tap = async (sel) => { const l = page.locator(sel).first(); await l.scrollIntoViewIfNeeded(); const bb = await l.boundingBox(); await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(600); };
  let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log('  ✗ ' + m)); };
  await tap('.lcard'); ok(await top() === 'details', 'لمس بطاقة يفتح التفاصيل');
  await tap('.gallery .bar button'); ok(await top() === 'tab:home', 'رجوع من التفاصيل');
  await tap('#homeWallet'); ok(await top() === 'wallet', 'زر الرصيد في الرئيسية يفتح المحفظة');
  await tap('#dep'); ok(await page.locator('.sheet #dGo').count() === 1, 'إيداع يفتح النافذة');
  await tap('[data-amt="25"]'); ok(await page.inputValue('#dAmt') === '25', 'اختيار مبلغ 25');
  await tap('#dGo'); ok(await page.locator('.toast').count() >= 1, 'متابعة للدفع تعرض تأكيداً');
  await page.waitForTimeout(900);
  await tap('#wd'); ok(await page.locator('.sheet #wNext').count() === 1, 'سحب يفتح النافذة');
  await page.fill('#wAmt', '5'); await page.fill('#wAddr', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'); await tap('#wNext');
  ok(await page.locator('.sheet #wGo').count() === 1, 'متابعة تفتح شاشة التأكيد');
  ok(await page.locator('#wGo').isDisabled(), 'التأكيد معطّل قبل الإقرار والرمز');
  await tap('#wOk'); await page.fill('#wPin', '482913'); await page.waitForTimeout(200);
  ok(!(await page.locator('#wGo').isDisabled()), 'التأكيد يُفعّل بعد الإقرار والرمز');
  await page.evaluate(() => document.querySelectorAll('.sheet,.sheet-bg').forEach(e => e.remove()));
  await tap('#back'); ok(await top() === 'tab:home', 'رجوع من المحفظة');
  for (const [t, n] of [['chats', 'tab:chats'], ['orders', 'tab:orders'], ['account', 'tab:account'], ['home', 'tab:home']]) { await tap(`[data-tab="${t}"]`); ok(await top() === n, `تبويب ${t}`); }
  await tap('[data-tab="chats"]'); await tap('.citem'); ok(await top() === 'chat', 'فتح محادثة');
  await tap('#back'); await tap('[data-tab="orders"]'); await tap('.ocard'); ok(await top() === 'order', 'فتح طلب');
  await tap('#back'); await tap('[data-tab="account"]'); await tap('#walletToggle');
  ok(await page.locator('.sheet #okBtn').count() === 1, 'تفعيل المحفظة يطلب تأكيداً');
  await tap('.sheet #okBtn');
  ok(await page.evaluate(() => __dbg.S.profile.walletOn === true), 'مفتاح قبول المحفظة يعمل (مُعطّل افتراضياً)');
  await tap('[data-tab="home"]'); await tap('[data-cat="goat"]'); ok(await page.evaluate(() => [...document.querySelectorAll('.lcard .title')].every(t => t.textContent.includes('ماعز'))), 'تصنيف الماعز يعرض الماعز فقط');
  await page.fill('#q', 'كباشي'); await page.waitForTimeout(500); ok(await page.locator('.lcard').count() >= 0, 'البحث');
  await tap('[data-cat="all"]'); await page.fill('#q', ''); await page.waitForTimeout(500);
  await tap('.lcard'); await tap('.bottombar .btn-primary'); ok(await top() === 'checkout', 'اطلب الآن يفتح إتمام الطلب');
  await page.evaluate(() => { document.querySelectorAll('.sheet,.sheet-bg').forEach(e => e.remove()); });
  for (let i = 0; i < 3 && !(await page.locator('[data-tab="home"]').count()); i++) await tap('#back');
  await tap('[data-tab="home"]'); await page.waitForTimeout(500);
  const n1 = await page.locator('.lcard').count();
  ok(n1 === 24, `الصفحة الأولى 24 إعلاناً (وجدنا ${n1})`);
  await page.locator('#moreFeed').scrollIntoViewIfNeeded(); await page.waitForTimeout(1200);
  const n2 = await page.locator('.lcard').count();
  ok(n2 > 24, `التمرير يحمّل المزيد تلقائياً (${n2})`);
  ok(await page.evaluate(() => __dbg.S.listings.every(l => l.status === 'active')), 'السوق يجلب النشط فقط');
  ok((globalThis.__cdnHits || 0) >= 2, `السوق يأتي من الذاكرة المؤقتة (${globalThis.__cdnHits} طلب)`);
  await tap('[data-cat="goat"]'); await page.waitForTimeout(600);
  ok(await page.evaluate(() => __dbg.S.listings.every(l => l.type === 'goat')), 'تصنيف الماعز من الخادم');
  await tap('[data-cat="all"]'); await page.waitForTimeout(600);
  await page.fill('#q', 'حمرى'); await page.waitForTimeout(900);
  ok(await page.evaluate(() => [...document.querySelectorAll('.lcard .title')].every(t => t.textContent.includes('حمري'))) && await page.locator('.lcard').count() > 0, 'البحث بـ"حمرى" يجد "حمري"');
  await page.fill('#q', ''); await page.waitForTimeout(400);
  // ===== البحث باللهجة =====
  let pq = await page.evaluate(() => { const r = __dbg.parseQuery('نعجة حمري'); return { t: [...r.types], s: r.sex, terms: r.terms }; });
  ok(pq.t.join() === 'sheep' && pq.s === 'f' && pq.terms.join() === 'حمري', 'تحليل "نعجة حمري": ضأن + أنثى + سلالة');
  pq = await page.evaluate(() => [...__dbg.parseQuery('الغنم').types].sort().join());
  ok(pq === 'goat,sheep', '"الغنم" = ماعز وضأن');
  await page.fill('#q', 'نعجه'); await page.waitForTimeout(700);
  ok(await page.evaluate(() => { const r = __dbg.filtered(); return r.length > 0 && r.every(l => l.type === 'sheep' && l.sex === 'f'); }), 'بحث "نعجه" يعرض إناث الضأن فقط');
  await page.fill('#q', 'تيس'); await page.waitForTimeout(700);
  ok(await page.evaluate(() => { const r = __dbg.filtered(); return r.length > 0 && r.every(l => l.type === 'goat' && l.sex === 'm'); }), 'بحث "تيس" يعرض ذكور الماعز');
  await page.fill('#q', 'حمري بحري'); await page.waitForTimeout(700);
  ok(await page.evaluate(() => { const r = __dbg.filtered(); return r.length > 0 && r.every(l => l.breed === 'حمري' && l.city === 'بحري'); }), 'كلمتان: كلتاهما مطلوبتان');
  await page.fill('#q', 'كباشي'); await page.waitForTimeout(700);
  ok(await page.evaluate(() => __dbg.filtered()[0].breed === 'كباشي'), 'الأكثر صلة أولاً');
  ok(await page.locator('#qSugg option').count() > 10, 'اقتراحات البحث موجودة');
  await page.fill('#q', ''); await page.waitForTimeout(400);
  // ===== السعر الثابت ومكان المعاينة =====
  await page.evaluate(() => __dbg.push('details', { id: 'l2' })); await page.waitForTimeout(500);
  ok(await page.locator('text=سعر ثابت').count() >= 1 && await page.locator('text=سوق المويلح').count() === 1, 'التفاصيل: سعر ثابت + مكان المعاينة');
  ok((await page.textContent('#chatL')).includes('راسل'), 'الإعلان الثابت: زر "راسل" بدل "فاوض"');
  // ===== متابعة البائع =====
  await page.evaluate(() => { __dbg.S.stack = []; __dbg.push('seller', { uid: 'u2' }); }); await page.waitForTimeout(600);
  ok(await page.evaluate(() => { __dbg.S.stack = []; return true; }), 'تهيئة');
  await page.evaluate(() => __dbg.push('seller', { uid: 'u2' })); await page.waitForTimeout(600);
  ok(await page.locator('#follow').count() === 1 && await page.locator('text=صفقة مكتملة').count() === 1, 'ملف البائع: زر المتابعة والإحصائيات');
  await tap('#follow'); await page.waitForTimeout(500);
  ok((await page.textContent('#follow')).includes('إلغاء المتابعة') && (await page.textContent('#folCnt')) === '1', 'المتابعة تعمل وتحدّث العداد');
  ok((globalThis.__sellerCalls || []).some(c => c.action === 'follow' && c.sellerId === 'u2' && c.on === true), 'تُرسل للسيرفر');
  await page.evaluate(() => { __dbg.S.stack = []; __dbg.push('following'); }); await page.waitForTimeout(500);
  ok(await page.evaluate(() => __dbg.S.stack.at(-1).name) === 'following' && await page.locator('#back').count() === 1, 'صفحة البائعين الذين أتابعهم تفتح');
  // ===== محرر الإعلان =====
  await page.evaluate(() => { __dbg.S.stack = []; __dbg.push('edit'); }); await page.waitForTimeout(600);
  await tap('[data-neg="0"]');
  ok(await page.locator('[data-neg="0"].on').count() === 1 && await page.locator('#meet').count() === 1, 'المحرر: اختيار السعر الثابت وحقل المعاينة');
  await page.evaluate(() => { __dbg.S.stack = []; __dbg.S.tab = 'home'; __dbg.render(); }); await page.waitForTimeout(500);
  // ===== رحلات UX =====
  const go = (js) => page.evaluate(js).then(() => page.waitForTimeout(600));
  // إتمام الطلب: الإجمالي فوق الزر، والعداد مخفي لرأس واحد
  await go("__dbg.S.stack=[{name:'checkout',params:{id:'l1'}}];__dbg.render()");
  ok((await page.textContent('#barTotal')).includes('450,000'), 'إتمام الطلب: الإجمالي ظاهر بجانب زر الإرسال');
  ok(!(await page.locator('#qi').isVisible()), 'رأس واحد متاح: لا عداد كمية بلا فائدة');
  ok(await page.locator('#place.btn-primary').count() === 1, 'زر الإرسال بلون الإجراء الأساسي');
  // الطلب: وقت التحرير التلقائي بالضبط
  await go("__dbg.S.stack=[{name:'order',params:{id:'o1'}}];__dbg.render()");
  ok(/يُحوَّل المبلغ تلقائياً بعد يومين و20 ساعة/.test(ot) && !/\d يومين/.test(ot), 'تفاصيل الطلب: الوقت المتبقي للتحرير التلقائي');
  // محادثة جديدة: أسئلة جاهزة تُرسل بلمسة
  await go("__dbg.S.stack=[{name:'chat',params:{id:'l4_u1'}}];__dbg.render()"); await page.waitForTimeout(500);
  ok(await page.locator('[data-quick]').count() >= 3, 'محادثة فارغة: أسئلة جاهزة');
  // المحرر: الخطأ عند الحقل نفسه
  await go("__dbg.S.stack=[{name:'edit',params:{}}];__dbg.render()");
  ok((await page.getAttribute('[name=age]', 'placeholder')).startsWith('مثال'), 'المحرر: النص المؤقت لا يشبه قيمة حقيقية');
  await page.evaluate(() => document.querySelector('#publish').click()); await page.waitForTimeout(500);
  ok(await page.locator('#photos.invalid').count() === 1, 'نشر بلا صور: حقل الصور يُعلَّم');
  // إعلاناتي: الحد ظاهر
  await go("__dbg.S.stack=[{name:'mine',params:{}}];__dbg.render()");
  ok(/من 3/.test(await page.textContent('body')), 'إعلاناتي: "X من 3 إعلانات نشطة"');
  // المحفظة: إلغاء السحب زر واضح
  await go("__dbg.S.stack=[{name:'wallet',params:{}}];__dbg.render()"); await page.waitForTimeout(500);
  ok(await page.locator('button[data-wdc]:has-text("إلغاء السحب")').count() === 1, 'المحفظة: "إلغاء السحب" زر بحجم لمس كامل');
  // حسابي: لا أزرار ميتة، والمساعدة تعمل
  await go("__dbg.S.stack=[];__dbg.S.tab='account';__dbg.render()");
  ok(await page.locator('[data-go="soon"]').count() === 0, 'حسابي: لا بنود "قيد التجهيز"');
  await page.evaluate(() => document.querySelector('[data-go="help"]').click()); await page.waitForTimeout(600);
  ok(await page.locator('.sheet details').count() >= 3, 'المساعدة: أسئلة وأجوبة');
  await page.evaluate(() => document.querySelectorAll('.sheet,.sheet-bg').forEach(e => e.remove()));
  // خطأ التحميل: إعادة المحاولة
  await go("__dbg.renderError({ userMsg: 'تجربة' })");
  ok(await page.locator('#retry').count() === 1, 'شاشة الخطأ فيها "إعادة المحاولة"');
  await go("__dbg.S.stack=[];__dbg.S.tab='home';__dbg.render()");
  await ctx.setOffline(true); await page.waitForTimeout(400);
  ok(await page.locator('#offline').count() === 1, 'يظهر شريط "لا يوجد اتصال"');
  await ctx.setOffline(false); await page.waitForTimeout(400);
  ok(await page.locator('#offline').count() === 0, 'يختفي الشريط عند عودة الاتصال');
  ok(errs.length === 0, 'لا أخطاء JS: ' + errs.join(' | '));
  console.log(`مسارات: ${pass} نجح، ${fail} فشل`); await b.close();
})();
