// يلتقط النمط المحسوب لكل عنصر في عدة شاشات (فاتح/داكن) ويكتب بصمة لكل شاشة
const { chromium } = require('playwright'); const fs = require('fs'); const crypto = require('crypto');
const P = __dirname; const [,, src, out] = process.argv;
(async () => { const b = await chromium.launch(); const res = {};
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 360, height: 740 }, colorScheme: scheme }); const page = await ctx.newPage();
    await ctx.route('**/*', r => { const u = r.request().url(); if (u.includes('gstatic.com/firebasejs')) return r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(P + '/fakefb.js', 'utf8') }); if (u.includes('ik.imagekit.io')) return r.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(P + '/img/a1.jpg') }); if (u.includes('/api/wallet')) return r.fulfill({ contentType: 'application/json', body: '{"ok":true,"hasPin":true}' }); if (u.startsWith('file:')) return r.continue(); return r.fulfill({ status: 404, body: '' }); });
    const html = fs.readFileSync(src, 'utf8').replace('<script type="module">', `<script>${fs.readFileSync(P + '/seed.js', 'utf8')}</script><script type="module">`).replace(/<\/script>\s*<\/body>/, 'window.__dbg = { S, push, render, renderShell };</script></body>');
    const f = P + '/_sty_' + scheme + '.html'; fs.writeFileSync(f, html); await page.goto('file://' + f); await page.waitForTimeout(900);
    const states = { home: "__dbg.S.stack=[];__dbg.S.tab='home';__dbg.renderShell()", chats: "__dbg.S.stack=[];__dbg.S.tab='chats';__dbg.renderShell()", orders: "__dbg.S.stack=[];__dbg.S.tab='orders';__dbg.renderShell()", account: "__dbg.S.stack=[];__dbg.S.tab='account';__dbg.renderShell()",
      details: "__dbg.S.stack=[{name:'details',params:{id:'l1'}}];__dbg.render()", seller: "__dbg.S.stack=[{name:'seller',params:{uid:'u2'}}];__dbg.render()", chat: "__dbg.S.stack=[{name:'chat',params:{id:'l1_u1'}}];__dbg.render()", checkout: "__dbg.S.stack=[{name:'checkout',params:{id:'l1'}}];__dbg.render()",
      order: "__dbg.S.stack=[{name:'order',params:{id:'o1'}}];__dbg.render()", wallet: "__dbg.S.stack=[{name:'wallet',params:{}}];__dbg.render()", mine: "__dbg.S.stack=[{name:'mine',params:{}}];__dbg.render()", editor: "__dbg.S.stack=[{name:'edit',params:{id:'l3'}}];__dbg.render()" };
    for (const [n, js] of Object.entries(states)) { await page.evaluate(js); await page.waitForTimeout(700);
      const dump = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => !['SCRIPT', 'STYLE', 'svg', 'symbol', 'path', 'use'].includes(e.tagName)).map(e => { const c = getComputedStyle(e); return e.tagName + '.' + e.className.toString().slice(0, 40) + '|' + [...c].filter(k => !k.startsWith('--')).map(k => k + ':' + c.getPropertyValue(k)).join(';'); }));
      res[scheme + ':' + n] = { n: dump.length, h: crypto.createHash('sha1').update(dump.join('\n')).digest('hex'), dump }; }
    await ctx.close(); fs.unlinkSync(f); }
  fs.writeFileSync(out, JSON.stringify(res)); await b.close(); })();
