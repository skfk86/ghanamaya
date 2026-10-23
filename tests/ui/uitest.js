// UI test: every visible control reachable by a real tap, no JS errors, no horizontal overflow
const { chromium } = require('playwright'); const fs = require('fs'); const P = __dirname;
const [,, htmlPath, mode] = process.argv; const ADMIN = mode === 'admin';
const issues = []; let checked = 0;
(async () => {
  const b = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: ADMIN ? { width: 1280, height: 860 } : { width: 360, height: 740 }, colorScheme: scheme, hasTouch: true });
    const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('dialog', d => d.dismiss());
    await ctx.route('**/*', async r => { const u = r.request().url();
      if (u.includes('gstatic.com/firebasejs')) return r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(P + '/fakefb.js', 'utf8') });
      if (u.includes('ik.imagekit.io')) return r.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(P + '/img/a1.jpg') });
      if (u.includes('/api/')) { const a = JSON.parse(r.request().postData() || '{}').action; return r.fulfill({ contentType: 'application/json', body: JSON.stringify(a === 'pinStatus' ? { ok: true, hasPin: true } : { ok: true }) }); }
      if (u.startsWith('file:')) return r.continue(); return r.fulfill({ status: 404, body: '' }); });
    let html = fs.readFileSync(htmlPath, 'utf8').replace('<script type="module">', `<script>${fs.readFileSync(P + '/seed.js', 'utf8')}</script><script type="module">`)
      .replace(/<\/script>\s*<\/body>/, ADMIN ? 'window.__dbg = { S, go };</script></body>' : 'window.__dbg = { S, push, render, renderShell, openFilters, depositSheet, withdrawSheet, pinSheet, openReport };</script></body>');
    fs.writeFileSync(P + '/_ui.html', html); await page.goto('file://' + P + '/_ui.html'); await page.waitForTimeout(900);
    const states = ADMIN ? ['home', 'reports', 'verify', 'listings', 'users', 'orders', 'finance'].map(s => [s, `__dbg.S.sec='${s}';__dbg.S.sel=null;__dbg.go()`]) : [
      ['home', "__dbg.S.stack=[];__dbg.S.tab='home';__dbg.renderShell()"],
      ['filters', "__dbg.openFilters()"],
      ['chats', "__dbg.S.stack=[];__dbg.S.tab='chats';__dbg.renderShell()"],
      ['orders-buy', "__dbg.S.stack=[];__dbg.S.tab='orders';__dbg.renderShell()"],
      ['orders-sell', "document.querySelectorAll('.seg button')[1]&&document.querySelectorAll('.seg button')[1].click()"],
      ['account', "__dbg.S.stack=[];__dbg.S.tab='account';__dbg.renderShell()"],
      ['details', "__dbg.S.stack=[{name:'details',params:{id:'l1'}}];__dbg.render()"],
      ['details-own', "__dbg.S.stack=[{name:'details',params:{id:'l3'}}];__dbg.render()"],
      ['seller', "__dbg.S.stack=[{name:'seller',params:{uid:'u2'}}];__dbg.render()"],
      ['chat', "__dbg.S.stack=[{name:'chat',params:{id:'l1_u1'}}];__dbg.render()"],
      ['chat-seller', "__dbg.S.stack=[{name:'chat',params:{id:'l3_u3'}}];__dbg.render()"],
      ['order-wallet-buyer', "__dbg.S.stack=[{name:'order',params:{id:'o1'}}];__dbg.render()"],
      ['order-bankak-seller', "__dbg.S.stack=[{name:'order',params:{id:'o2'}}];__dbg.render()"],
      ['order-done', "__dbg.S.stack=[{name:'order',params:{id:'o3'}}];__dbg.render()"],
      ['checkout', "__dbg.S.stack=[{name:'checkout',params:{id:'l2'}}];__dbg.render()"],
      ['checkout-wallet', "document.querySelector('[data-pm=wallet]')&&document.querySelector('[data-pm=wallet]').click()"],
      ['wallet', "__dbg.S.stack=[{name:'wallet',params:{}}];__dbg.render()"],
      ['deposit-sheet', "__dbg.depositSheet()"],
      ['withdraw-sheet', "__dbg.withdrawSheet()"],
      ['pin-sheet', "__dbg.pinSheet('change')"],
      ['report-sheet', "__dbg.openReport('listing','l1','u2')"],
      ['mine', "__dbg.S.stack=[{name:'mine',params:{}}];__dbg.render()"],
      ['favs', "__dbg.S.stack=[{name:'favs',params:{}}];__dbg.render()"],
      ['editor', "__dbg.S.stack=[{name:'edit',params:{id:'l3'}}];__dbg.render()"],
      ['reviews', "__dbg.S.stack=[{name:'reviews',params:{uid:'u2',name:'x'}}];__dbg.render()"]
    ];
    for (const [name, js] of states) {
      errs.length = 0;
      try { await page.evaluate(js); } catch (e) { issues.push(`[${scheme}] ${name}: فشل فتح الشاشة: ${e.message}`); continue; }
      await page.waitForTimeout(700);
      const res = await page.evaluate(async () => {
        const out = { bad: [], n: 0, overflow: 0 };
        const vw = innerWidth;
        out.overflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
        const inSheet = !!document.querySelector('.sheet');
        const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [data-open]';
        let els = [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.disabled; });
        if (inSheet) els = els.filter(e => e.closest('.sheet'));
        const fixedBar = (el) => !!el && !!el.closest('.tabbar,.bottombar,.composer,.topbar,.chat-head,.sheet,.toast');
        for (const e of els) {
          // داخل حاوية تمرير أفقية (مثل الشرائح): قرّبه للعرض
          e.scrollIntoView({ block: 'center', inline: 'center' });
          await new Promise(r => requestAnimationFrame(r));
          const r = e.getBoundingClientRect();
          if (r.right < 0 || r.left > vw) continue;
          const x = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1), y = r.top + r.height / 2;
          if (y < 0 || y > innerHeight) continue;
          out.n++;
          const hit = document.elementFromPoint(x, y);
          if (!hit) continue;
          const ok = hit === e || e.contains(hit) || (e.tagName === 'INPUT' && hit.closest('label') && hit.closest('label').contains(e)) || (hit.tagName === 'LABEL' && hit.contains(e));
          if (!ok) {
            // عنصر عادي تغطيه أشرطة ثابتة: مقبول إن كان التمرير لا يكفي لإظهاره (نهاية الصفحة)
            if (fixedBar(hit) && !fixedBar(e)) { out.bad.push(`مغطى بشريط ثابت: "${(e.textContent || e.getAttribute('aria-label') || e.id || e.className).trim().slice(0, 30)}" ← ${hit.className || hit.tagName}`); continue; }
            out.bad.push(`لا يُلمس: "${(e.textContent || e.getAttribute('aria-label') || e.placeholder || e.id || e.className).toString().trim().slice(0, 30)}" يغطيه ${hit.tagName}.${String(hit.className).slice(0, 40)}`);
          }
          // حجم اللمس الأدنى
          if ((r.width < 32 || r.height < 32) && !['INPUT', 'A'].includes(e.tagName) && !e.closest('table')) out.bad.push(`صغير للمس (${Math.round(r.width)}×${Math.round(r.height)}): "${(e.textContent || e.getAttribute('aria-label') || e.className).trim().slice(0, 25)}"`);
        }
        window.scrollTo(0, 0);
        return out;
      });
      checked += res.n;
      res.bad.forEach(x => issues.push(`[${scheme}] ${name}: ${x}`));
      if (res.overflow > 1) issues.push(`[${scheme}] ${name}: تمرير أفقي ${res.overflow}px`);
      errs.forEach(e => issues.push(`[${scheme}] ${name}: خطأ JS: ${e}`));
      if (!ADMIN) await page.evaluate(() => { document.querySelectorAll('.sheet,.sheet-bg').forEach(e => e.remove()); });
    }
    await ctx.close();
  }
  await b.close();
  const uniq = [...new Set(issues)];
  console.log(`فُحص ${checked} عنصراً تفاعلياً. مشاكل: ${uniq.length}`); uniq.forEach(i => console.log(' - ' + i));
})();
