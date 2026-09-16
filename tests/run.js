// Playwright regression suite for Forage.
// Run with: node tests/run.js
// Requires the `playwright` package (with a chromium browser installed) to be resolvable,
// e.g. `npm install -D playwright && npx playwright install chromium`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8973;
const BASE = `http://127.0.0.1:${PORT}`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

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

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ok:', msg);
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('frame-ancestors')) errors.push(m.text()); });

  try {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('.card');

    console.log('--- XSS hardening: profile & payment fields must not execute injected markup ---');
    let xssFired = false;
    await page.exposeFunction('__xssMarker', () => { xssFired = true; });
    const payload = `"><img src=x onerror="window.__xssMarker()">`;

    await page.click("button[onclick=\"go('profile')\"]");
    await page.fill('#profileName', payload);
    await page.fill('#profileRecipient', payload);
    await page.fill('#profileLine1', payload);
    await page.fill('#profileCity', payload);
    await page.click("button[onclick='saveProfile()']");
    await page.fill('#cardLabel', payload);
    await page.fill('#cardLast4', '4444');
    await page.click("button[onclick='addPaymentMethod()']");
    await page.waitForTimeout(150);
    // force a fresh render pass from persisted state
    await page.click("button[onclick=\"go('shop')\"]");
    await page.waitForTimeout(50);
    await page.click("button[onclick=\"go('profile')\"]");
    await page.waitForTimeout(100);
    assert(!xssFired, 'injected payload in profile/payment fields did not execute');
    const profileHtml = await page.locator('.panel').first().evaluate(el => el.innerHTML);
    assert(!/<img[^>]*onerror=/i.test(profileHtml) || profileHtml.includes('&lt;img'), 'payload rendered as inert text, not a live <img> tag');

    console.log('--- Shop: filter + sort ---');
    await page.click("button[onclick=\"go('shop')\"]");
    await page.waitForTimeout(100);
    await page.click('[data-filter="Pottery"]');
    await page.waitForTimeout(100);
    assert((await page.locator('#resultsMeta').textContent()).length > 0, 'filter applied');
    await page.selectOption('#sortSelect', 'low');
    await page.click('[data-filter="All"]');

    console.log('--- Search (debounced) ---');
    await page.fill('#searchInput', 'mug');
    await page.waitForTimeout(300);
    assert((await page.locator('#resultsMeta').textContent()).includes('showing'), 'search results rendered');

    console.log('--- Product detail + wishlist + cart ---');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    await page.click("button[onclick^='toggleWish']");
    await page.click("button[onclick^='addCart']");
    await page.waitForTimeout(100);
    assert((await page.locator('.badge').textContent()) === '1', 'cart badge shows 1 item');

    console.log('--- Cart + checkout ---');
    await page.click("button[onclick=\"go('cart')\"]");
    await page.waitForTimeout(100);
    await page.fill('#shipRecipient', 'Test Recipient');
    await page.fill('#shipLine1', '1 Test Way');
    await page.fill('#shipCity', 'Testville');
    await page.click("button[onclick='checkout()']");
    await page.waitForTimeout(200);
    assert(await page.locator('.order').count() >= 1, 'order recorded after checkout');

    console.log('\n=== console/page errors ===', errors);
    assert(errors.length === 0, 'no unexpected console/page errors');

    console.log('\nALL TESTS PASSED');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch(e => { console.error(e); process.exitCode = 1; });
