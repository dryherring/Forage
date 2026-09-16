// Targeted regression/security tests for the Phase 2 frontend hardening pass (issue #6).
// These protect specifically the behavior that pass introduced or relies on:
//   - escaping of user-supplied values (XSS)
//   - localStorage state validation (corrupted/tampered data doesn't crash the app)
//   - external-link safety (noopener/noreferrer)
//   - the event-delegation refactor's trickier semantics (nested click targets, modal backdrop)
//   - the CSP's actual shape (no script-src unsafe-inline; no inline handlers left in markup)
//
// Run with: node tests/phase2-hardening.js  (or via `npm test`, which runs this after run.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8977;
const BASE = `http://127.0.0.1:${PORT}`;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

const results = [];
function record(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, pass: true }); console.log('  PASS:', name); },
    err => { results.push({ name, pass: false, error: err.message }); console.log('  FAIL:', name, '-', err.message); }
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  async function fresh() {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }

  await fresh();

  // --- Static markup: no inline handlers left --------------------------------
  await record('No inline onclick/onchange attributes remain anywhere in the rendered app', async () => {
    // Exercise every page so every render*() template gets a turn.
    for (const id of ['shop', 'cart', 'orders', 'stats', 'gifts', 'wishlist', 'reading', 'profile']) {
      await page.click(`#nav button[data-action="go"][data-page="${id}"]`);
      await page.waitForTimeout(60);
    }
    await page.click('#nav button[data-action="go"][data-page="shop"]');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    const inlineHandlerCount = await page.evaluate(() =>
      document.querySelectorAll('[onclick], [onchange]').length
    );
    assert(inlineHandlerCount === 0, `found ${inlineHandlerCount} elements with inline onclick/onchange`);
  });

  // --- CSP shape ---------------------------------------------------------------
  await record('CSP meta tag restricts script-src to self with no unsafe-inline', async () => {
    const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '');
    assert(csp.includes("script-src 'self'"), `CSP has script-src 'self' (got: ${csp})`);
    assert(!/script-src[^;]*unsafe-inline/.test(csp), `script-src does not allow unsafe-inline (got: ${csp})`);
    assert(csp.includes("object-src 'none'"), `CSP blocks object-src (got: ${csp})`);
  });

  // --- XSS: profile fields -----------------------------------------------------
  await record('XSS payload in profile name/address fields renders as inert text, not markup', async () => {
    await fresh();
    let xssFired = false;
    await page.exposeFunction('__xssMarker', () => { xssFired = true; });
    const payload = `"><img src=x onerror="window.__xssMarker()">`;
    await page.click('#nav button[data-action="go"][data-page="profile"]');
    await page.fill('#profileName', payload);
    await page.fill('#profileRecipient', payload);
    await page.fill('#profileLine1', payload);
    await page.click('button[data-action="save-profile"]');
    await page.waitForTimeout(100);
    // force a fresh render pass from persisted state, since typing alone doesn't re-render the input
    await page.click('#nav button[data-action="go"][data-page="shop"]');
    await page.click('#nav button[data-action="go"][data-page="profile"]');
    await page.waitForTimeout(100);
    assert(!xssFired, 'injected payload in profile fields did not execute');
    const html = await page.locator('.panel').first().evaluate(el => el.innerHTML);
    assert(!/<img[^>]*onerror=/i.test(html), 'no live <img onerror> tag was created from the payload');
  });

  // --- XSS: payment nickname ----------------------------------------------------
  await record('XSS payload in payment nickname renders as inert text, not markup', async () => {
    let xssFired = false;
    await page.exposeFunction('__xssMarker2', () => { xssFired = true; });
    const payload = `<img src=x onerror="window.__xssMarker2()">`;
    await page.fill('#cardLabel', payload);
    await page.fill('#cardLast4', '4444');
    await page.click('button[data-action="add-payment-method"]');
    await page.waitForTimeout(150);
    assert(!xssFired, 'injected payload in payment nickname did not execute');
    const savedRowsHtml = await page.locator('.saved-row').evaluateAll(els => els.map(el => el.innerHTML));
    assert(savedRowsHtml.some(h => h.includes('&lt;img')), 'payload appears HTML-escaped in a saved-row');
  });

  // --- localStorage corruption resilience ---------------------------------------
  await record('Corrupted cart/profile/giftIdeas/readingList in localStorage does not crash the app', async () => {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      localStorage.setItem('forageV2State', JSON.stringify({
        balance: 'not-a-number',
        spent: NaN,
        purchases: 'lots',
        pageNo: -5,
        filter: '<script>evil</script>',
        sort: 'hacked',
        query: 123,
        cart: [{ id: 'does-not-exist', qty: 'lots', option: { nested: true } }, 'garbage', null, 42],
        wishlist: ['ok-id', 42, null, {}],
        orders: ['garbage', null, { id: 'ok' }],
        readingList: [{ id: 'nope' }, 'legacy-string-id', null],
        giftIdeas: [{ notAName: true }, null, 'garbage', { id: 'nope', name: 'Kept anyway' }],
        profile: { paymentMethods: 'not-an-array', defaultAddress: 'not-an-object' }
      }));
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero', { timeout: 5000 });
    assert(await page.locator('.hero').count() === 1, 'app still loads to Discover with corrupted localStorage');
    assert((await page.locator('#balanceBox').textContent()).length > 0, 'balance renders something instead of throwing');
    for (const id of ['wishlist', 'reading', 'gifts', 'cart', 'orders', 'stats', 'profile']) {
      await page.click(`#nav button[data-action="go"][data-page="${id}"]`);
      await page.waitForTimeout(80);
      const brokeToFallback = await page.locator('.empty:has-text("Forage hit a snag.")').count();
      assert(brokeToFallback === 0, `${id} page renders normally, not the generic error fallback, despite corrupted state`);
    }
    assert(errors.length === 0, `no uncaught page errors while navigating with corrupted state (got: ${errors.join(' | ')})`);
  });

  // --- External link safety ------------------------------------------------------
  await record('Amazon external link opens with noopener and noreferrer', async () => {
    await fresh();
    await page.click('[data-filter="Books"]');
    await page.waitForTimeout(80);
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    const amazonBtn = page.locator('button[data-action="amazon-book"]');
    assert(await amazonBtn.count() === 1, 'a book detail page has the Amazon link button');
    const opensWithNoopener = await page.evaluate(() => {
      const original = window.open;
      let capturedFeatures = null;
      window.open = (url, target, features) => { capturedFeatures = features; return null; };
      try {
        document.querySelector('button[data-action="amazon-book"]').click();
      } finally {
        window.open = original;
      }
      return capturedFeatures;
    });
    assert(opensWithNoopener && opensWithNoopener.includes('noopener') && opensWithNoopener.includes('noreferrer'),
      `window.open features include noopener and noreferrer (got: "${opensWithNoopener}")`);
  });

  // --- Delegated click semantics: nested targets ----------------------------------
  await record('Heart button inside a product card toggles wishlist without opening the product', async () => {
    await fresh();
    await page.click('button[data-action="toggle-wish"]');
    await page.waitForTimeout(80);
    assert(await page.locator('.detail').count() === 0, 'clicking the heart did not navigate into product detail');
    assert(await page.locator('.card .heart.on').count() === 1, 'the heart button shows the wished state');
  });

  // --- Delegated click semantics: modal backdrop vs. content ------------------------
  await record('Size guide modal: content clicks keep it open, backdrop click closes it', async () => {
    await page.click('[data-filter="Style"]');
    await page.waitForTimeout(80);
    let opened = false;
    const count = await page.locator('.card').count();
    for (let i = 0; i < Math.min(count, 8) && !opened; i++) {
      await page.locator('.card').nth(i).click();
      await page.waitForSelector('.detail');
      if (await page.locator('button[data-action="show-size-guide"]').count()) {
        await page.click('button[data-action="show-size-guide"]');
        opened = true;
      } else {
        await page.click('#nav button[data-action="go"][data-page="shop"]');
        await page.waitForTimeout(60);
      }
    }
    if (!opened) { console.log('   (skipped: no product with a size guide found)'); return; }
    await page.waitForSelector('#sizeModal');
    await page.locator('.modal h2').click();
    await page.waitForTimeout(80);
    assert(await page.locator('#sizeModal').count() === 1, 'clicking inside the modal content keeps it open');
    await page.locator('#sizeModal').click({ position: { x: 3, y: 3 } });
    await page.waitForTimeout(80);
    assert(await page.locator('#sizeModal').count() === 0, 'clicking the backdrop itself closes the modal');
  });

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.pass);
  console.log('\n=== PHASE 2 HARDENING SUITE SUMMARY ===');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\n=== FAILURES ===');
    failed.forEach(f => console.log(` - ${f.name}\n   ${f.error}`));
    process.exitCode = 1;
  } else {
    console.log('\nALL TESTS PASSED');
  }
}

run().catch(e => { console.error('Suite crashed:', e); process.exitCode = 1; });
