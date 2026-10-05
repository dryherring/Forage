// Regression coverage for the Forage Fund popover, ported from the prior
// production implementation on main into dev's CSP/data-action/delegated-
// listener architecture. Covers open/close (click + outside-click + Escape),
// correct Starting/Spent/Remaining figures, figures staying correct after a
// checkout, and non-interference with the existing gift-modal/nav behavior.
//
// Run with: node tests/forage-fund.js (or via `npm test`)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8985;
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
const navSel = id => `#nav button[data-action="go"][data-page="${id}"]`;
async function goNav(page, id) { await page.click(navSel(id)); await page.waitForTimeout(80); }

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  async function fresh(seed) {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    if (seed) {
      await page.evaluate((s) => localStorage.setItem('forageV2State', JSON.stringify(s)), seed);
      await page.reload({ waitUntil: 'networkidle' });
    } else {
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'networkidle' });
    }
    await page.waitForSelector('.card');
  }

  await record('Fund panel is hidden by default and opens on clicking the balance pill, updating aria-expanded', async () => {
    await fresh();
    const panel = page.locator('#fundPanel');
    assert(await panel.getAttribute('hidden') !== null, 'panel starts hidden');
    const button = page.locator('#balanceBox');
    assert((await button.getAttribute('aria-expanded')) === 'false', 'aria-expanded starts false');
    await button.click();
    assert(await panel.getAttribute('hidden') === null, 'panel is visible after click');
    assert((await button.getAttribute('aria-expanded')) === 'true', 'aria-expanded becomes true');
    assert((await panel.locator('h3').textContent()).trim() === 'Forage Fund', 'panel shows the Forage Fund heading');
  });

  await record('Fund panel shows correct Starting fund / Spent / Remaining figures for a seeded state', async () => {
    await fresh({
      balance: 1200, spent: 1300, cart: [], wishlist: [], orders: [], purchases: 0,
      filter: 'All', query: '', sort: 'daily', pageNo: 1, readingList: [], giftIdeas: [],
    });
    await page.click('#balanceBox');
    const rows = await page.locator('#fundPanel .fund-row').allTextContents();
    assert(rows.some(r => r.includes('Starting fund') && r.includes('2,500')), `Starting fund = max(2000, 1200+1300) = 2,500 (got ${JSON.stringify(rows)})`);
    assert(rows.some(r => r.includes('Spent') && r.includes('1,300')), `Spent = 1,300 (got ${JSON.stringify(rows)})`);
    assert(rows.some(r => r.includes('Remaining') && r.includes('1,200')), `Remaining = 1,200 (got ${JSON.stringify(rows)})`);
    const amount = (await page.locator('#fundPanel .fund-amount').textContent()).trim();
    assert(amount.includes('1,200'), `big amount shows current balance, 1,200 (got "${amount}")`);
  });

  await record('Clicking the balance pill again closes the panel (toggle)', async () => {
    await fresh();
    await page.click('#balanceBox');
    assert(await page.locator('#fundPanel').getAttribute('hidden') === null, 'open after first click');
    await page.click('#balanceBox');
    assert(await page.locator('#fundPanel').getAttribute('hidden') !== null, 'closed after second click');
    assert((await page.locator('#balanceBox').getAttribute('aria-expanded')) === 'false', 'aria-expanded resets to false');
  });

  await record('Clicking elsewhere on the page closes an open Fund panel', async () => {
    await fresh();
    await page.click('#balanceBox');
    assert(await page.locator('#fundPanel').getAttribute('hidden') === null, 'open before outside click');
    await page.click('.hero'); // anywhere outside .fund-wrap
    assert(await page.locator('#fundPanel').getAttribute('hidden') !== null, 'closed after clicking outside');
  });

  await record('Escape closes an open Fund panel', async () => {
    await fresh();
    await page.click('#balanceBox');
    assert(await page.locator('#fundPanel').getAttribute('hidden') === null, 'open before Escape');
    await page.keyboard.press('Escape');
    assert(await page.locator('#fundPanel').getAttribute('hidden') !== null, 'closed after Escape');
  });

  await record('Fund panel figures update correctly after a checkout', async () => {
    await fresh();
    const before = await page.evaluate(() => ({ balance: state.balance, spent: state.spent }));
    await goNav(page, 'shop');
    const firstCard = page.locator('.card').first();
    await firstCard.click();
    await page.waitForSelector('.detail');
    await page.click('button[data-action="add-cart"]');
    await goNav(page, 'cart');
    await page.fill('#shipRecipient', 'Test Forager');
    await page.fill('#shipLine1', '1 Test Lane');
    await page.fill('#shipCity', 'Testville');
    await page.click('button[data-action="checkout"]');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({ balance: state.balance, spent: state.spent }));
    assert(after.spent > before.spent, `checkout increased state.spent (before ${before.spent}, after ${after.spent})`);
    assert(after.balance < before.balance, `checkout decreased state.balance (before ${before.balance}, after ${after.balance})`);
    await page.click('#balanceBox');
    const rows = await page.locator('#fundPanel .fund-row').allTextContents();
    const fmt = (n) => Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert(rows.some(r => r.includes('Spent') && r.includes(fmt(after.spent))), `panel's Spent row matches state.spent=${after.spent} (got ${JSON.stringify(rows)})`);
    assert(rows.some(r => r.includes('Remaining') && r.includes(fmt(after.balance))), `panel's Remaining row matches state.balance=${after.balance} (got ${JSON.stringify(rows)})`);
    const startingExpected = Math.max(2000, after.balance + after.spent);
    assert(rows.some(r => r.includes('Starting fund') && r.includes(fmt(startingExpected))), `panel's Starting fund row matches max(2000, balance+spent)=${startingExpected} (got ${JSON.stringify(rows)})`);
  });

  await record('Fund panel does not interfere with the gift modal\'s own Escape-to-close behavior', async () => {
    await fresh();
    await goNav(page, 'shop');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    await page.click('button[data-action="open-gift-modal"]');
    await page.waitForSelector('.modalback');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert(await page.locator('.modalback').count() === 0, 'Escape still closes the gift modal as before');
  });

  await record('Existing header/nav interactions still work with the new balance markup', async () => {
    await fresh();
    await goNav(page, 'cart');
    assert(await page.locator('.empty:has-text("Forage hit a snag.")').count() === 0, 'Cart page renders without error');
    await page.click('.brand-home');
    await page.waitForTimeout(80);
    assert(await page.locator('.hero').count() === 1, 'brand-home logo click still returns to Discover');
  });

  await browser.close();
  server.close();

  console.log('\n=== FORAGE FUND SUITE SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\n=== FAILURES ===');
    failed.forEach(f => console.log(` - ${f.name}\n   ${f.error}`));
    process.exitCode = 1;
  } else {
    console.log('\nALL TESTS PASSED');
  }
}

run();
