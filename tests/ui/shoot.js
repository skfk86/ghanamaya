const { chromium } = require('playwright');
const fs = require('fs'); const P = __dirname;
const [,, htmlPath, outDir, which, dark] = process.argv;
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: process.env.ADMIN ? { width: 1280, height: 860 } : { width: 390, height: 844 }, deviceScaleFactor: process.env.ADMIN ? 1 : 2, colorScheme: dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERR', e.message));
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.includes('gstatic.com/firebasejs')) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(P + '/fakefb.js', 'utf8') });
    if (u.includes('ik.imagekit.io')) { const m = u.match(/a(\d)\.jpg/); return route.fulfill({ contentType: 'image/jpeg', body: fs.readFileSync(`${P}/img/a${m ? m[1] : 0}.jpg`) }); }
    if (u.includes('/api/wallet')) { const a = JSON.parse(route.request().postData() || '{}').action; return route.fulfill({ contentType: 'application/json', body: JSON.stringify(a === 'pinStatus' ? { ok: true, hasPin: true } : { ok: true }) }); }
    if (u.startsWith('file:')) return route.continue();
    return route.fulfill({ status: 404, body: '' });
  });
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace('<script type="module">', `<script>${fs.readFileSync(P + '/seed.js', 'utf8')}</script><script type="module">`);
  html = html.replace(/<\/script>\s*<\/body>/, process.env.ADMIN ? "window.__dbg = { S, go };</script></body>" : "window.__dbg = { S, push, render, renderShell, openSellerSheet, sellerCodeSheet };</script></body>");
  fs.writeFileSync(P + '/_page.html', html);
  await page.goto('file://' + P + '/_page.html');
  await page.waitForTimeout(800);
  const shots = JSON.parse(which);
  for (const [name, js, full] of shots) {
    if (js) await page.evaluate(js); await page.waitForTimeout(700);
    await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: !!full });
  }
  await b.close();
})();
