// Playwright regression suite for Forage collection navigation (Wishlist, Reading List,
// Gift Cabinet) plus smoke coverage for Cart, Orders, Stats, and Profile.
//
// Run with: node tests/run.js
// Requires the `playwright` package (with a chromium browser installed) to be resolvable,
// e.g. `npm install -D playwright && npx playwright install chromium`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8974;
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

// Collects results instead of throwing on first failure, so a full report can be
// printed at the end (implementation and failures are kept separate from each other).
const results = [];
function record(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, pass: true }); console.log('  PASS:', name); },
    err => { results.push({ name, pass: false, error: err.message }); console.log('  FAIL:', name, '-', err.message); }
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// nav helpers -----------------------------------------------------------
const navSel = id => `#nav button[data-action="go"][data-page="${id}"]`;
async function goNav(page, id) { await page.click(navSel(id)); await page.waitForTimeout(80); }
async function activeNavLabel(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('#nav button.active');
    return btn ? btn.textContent.replace(/\s+/g, ' ').trim() : null;
  });
}
async function activeNavCount(page) {
  return page.evaluate(() => document.querySelectorAll('#nav button.active').length);
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });

  async function fresh() {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }

  await fresh();

  // --- Wishlist: empty state ------------------------------------------------
  await record('Wishlist opens empty with correct heading, empty message, and active pill', async () => {
    await goNav(page, 'wishlist');
    assert(await page.locator('h2:has-text("Wishlist")').count() === 1, 'Wishlist heading present');
    assert(await page.locator('.empty:has-text("Nothing saved yet.")').count() === 1, 'empty-state message shown');
    assert(await page.locator('.card').count() === 0, 'no product cards in empty wishlist');
    assert((await activeNavLabel(page)) === 'Wishlist', 'active pill is Wishlist');
  });

  // --- Wishlist: populated state --------------------------------------------
  let wishedProductName = null;
  await record('Wishlist opens populated with the saved product', async () => {
    await goNav(page, 'shop');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    wishedProductName = (await page.locator('.detail h1').textContent()).trim();
    await page.click('button[data-action="toggle-wish"]');
    await page.waitForTimeout(80);
    await goNav(page, 'wishlist');
    assert(await page.locator('.card').count() === 1, 'exactly one card in populated wishlist');
    const cardTitle = (await page.locator('.card h3').first().textContent()).trim();
    assert(cardTitle === wishedProductName, `wishlist card shows saved product (expected "${wishedProductName}", got "${cardTitle}")`);
    assert((await activeNavLabel(page)) === 'Wishlist', 'active pill is Wishlist');
  });

  // --- Reading List: empty state --------------------------------------------
  await record('Reading List opens empty with correct heading, empty message, and active pill', async () => {
    await goNav(page, 'reading');
    assert(await page.locator('h2:has-text("Reading List")').count() === 1, 'Reading List heading present');
    assert(await page.locator('.empty:has-text("No books saved yet.")').count() === 1, 'empty-state message shown');
    assert((await activeNavLabel(page)) === '📚 Reading List', 'active pill is Reading List');
  });

  // --- Reading List: populated state -----------------------------------------
  let bookName = null;
  await record('Reading List opens populated with the saved book', async () => {
    await goNav(page, 'shop');
    await page.click('[data-filter="Books"]');
    await page.waitForTimeout(80);
    assert(await page.locator('.card').count() > 0, 'at least one book found under the Books filter');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    bookName = (await page.locator('.detail h1').textContent()).trim();
    const readingBtn = page.locator('button[data-action="save-reading"]');
    assert(await readingBtn.count() === 1, 'detail page for a book shows the Reading List button');
    await readingBtn.click();
    await page.waitForTimeout(80);
    await goNav(page, 'reading');
    assert(await page.locator('.cartline').count() === 1, 'exactly one entry in populated reading list');
    const entryName = (await page.locator('.cartline strong').first().textContent()).trim();
    assert(entryName === bookName, `reading list entry shows saved book (expected "${bookName}", got "${entryName}")`);
    assert((await activeNavLabel(page)) === '📚 Reading List', 'active pill is Reading List');
  });

  // --- Gift Cabinet: empty state ---------------------------------------------
  await record('Gift Cabinet opens empty with correct heading, empty message, and active pill', async () => {
    await goNav(page, 'gifts');
    assert(await page.locator('h2:has-text("Gift Cabinet")').count() === 1, 'Gift Cabinet heading present');
    assert(await page.locator('.empty:has-text("No gift ideas yet.")').count() === 1, 'empty-state message shown');
    assert((await activeNavLabel(page)) === '🎁 Gift Cabinet', 'active pill is Gift Cabinet');
  });

  // --- Gift Cabinet: populated state ------------------------------------------
  // Saving to the Gift Cabinet is a single click with no dialogs and no
  // required metadata (see tests/gift-cabinet.js for the full lifecycle).
  await record('Gift Cabinet opens populated with the saved gift idea', async () => {
    await goNav(page, 'shop');
    await page.click('[data-filter="All"]');
    await page.waitForTimeout(80);
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    let dialogFired = false;
    page.once('dialog', d => { dialogFired = true; d.dismiss(); });
    await page.click('button[data-action="open-gift-modal"]');
    await page.waitForSelector('#giftModal');
    await page.click('button[data-action="confirm-gift-modal"]');
    await page.waitForTimeout(120);
    assert(!dialogFired, 'saving to the Gift Cabinet does not prompt for any metadata');
    assert(await page.locator('#giftModal').count() === 0, 'the capture modal closes after saving');
    await goNav(page, 'gifts');
    assert(await page.locator('.cartline').count() === 1, 'exactly one entry in populated gift cabinet');
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.length > 0, `gift entry shows a status/summary line even with no metadata yet (got "${eyebrow}")`);
    assert((await activeNavLabel(page)) === '🎁 Gift Cabinet', 'active pill is Gift Cabinet');
  });

  // --- Profile -> each collection ---------------------------------------------
  await record('Profile -> Wishlist navigation works', async () => {
    await goNav(page, 'profile');
    assert(await page.locator('h2:has-text("Profile")').count() === 1, 'landed on Profile');
    await goNav(page, 'wishlist');
    assert(await page.locator('h2:has-text("Wishlist")').count() === 1, 'landed on Wishlist from Profile');
    assert((await activeNavLabel(page)) === 'Wishlist', 'active pill is Wishlist');
  });
  await record('Profile -> Reading List navigation works', async () => {
    await goNav(page, 'profile');
    await goNav(page, 'reading');
    assert(await page.locator('h2:has-text("Reading List")').count() === 1, 'landed on Reading List from Profile');
    assert((await activeNavLabel(page)) === '📚 Reading List', 'active pill is Reading List');
  });
  await record('Profile -> Gift Cabinet navigation works', async () => {
    await goNav(page, 'profile');
    await goNav(page, 'gifts');
    assert(await page.locator('h2:has-text("Gift Cabinet")').count() === 1, 'landed on Gift Cabinet from Profile');
    assert((await activeNavLabel(page)) === '🎁 Gift Cabinet', 'active pill is Gift Cabinet');
  });

  // --- Collection -> collection navigation -------------------------------------
  await record('Wishlist -> Reading List -> Gift Cabinet -> Wishlist navigation preserves content', async () => {
    await goNav(page, 'wishlist');
    assert(await page.locator('.card').count() === 1, 'wishlist still populated');
    await goNav(page, 'reading');
    assert(await page.locator('.cartline').count() === 1, 'reading list still populated');
    await goNav(page, 'gifts');
    assert(await page.locator('.cartline').count() === 1, 'gift cabinet still populated');
    await goNav(page, 'wishlist');
    assert(await page.locator('.card').count() === 1, 'wishlist still populated after round trip');
    assert((await activeNavLabel(page)) === 'Wishlist', 'active pill is Wishlist after round trip');
  });

  // --- Removing the last item leaves each collection navigable -----------------
  await record('Removing the last Wishlist item leaves Wishlist navigable', async () => {
    await goNav(page, 'wishlist');
    assert(await page.locator('.card').count() === 1, 'one item present before removal');
    await page.click('.card .heart');
    await page.waitForTimeout(80);
    assert(await page.locator('.empty:has-text("Nothing saved yet.")').count() === 1, 'empty message shows right after removal');
    await goNav(page, 'shop');
    await goNav(page, 'wishlist');
    assert(await page.locator('.empty:has-text("Nothing saved yet.")').count() === 1, 'empty message persists after navigating away and back');
    assert((await activeNavLabel(page)) === 'Wishlist', 'active pill is Wishlist');
  });
  await record('Removing the last Reading List item leaves Reading List navigable', async () => {
    await goNav(page, 'reading');
    assert(await page.locator('.cartline').count() === 1, 'one item present before removal');
    await page.click('.cartline button.danger');
    await page.waitForTimeout(80);
    assert(await page.locator('.empty:has-text("No books saved yet.")').count() === 1, 'empty message shows right after removal');
    await goNav(page, 'shop');
    await goNav(page, 'reading');
    assert(await page.locator('.empty:has-text("No books saved yet.")').count() === 1, 'empty message persists after navigating away and back');
    assert((await activeNavLabel(page)) === '📚 Reading List', 'active pill is Reading List');
  });
  await record('Removing the last Gift Cabinet item leaves Gift Cabinet navigable', async () => {
    await goNav(page, 'gifts');
    assert(await page.locator('.cartline').count() === 1, 'one item present before removal');
    await page.click('.cartline button.danger');
    await page.waitForTimeout(80);
    assert(await page.locator('.empty:has-text("No gift ideas yet.")').count() === 1, 'empty message shows right after removal');
    await goNav(page, 'shop');
    await goNav(page, 'gifts');
    assert(await page.locator('.empty:has-text("No gift ideas yet.")').count() === 1, 'empty message persists after navigating away and back');
    assert((await activeNavLabel(page)) === '🎁 Gift Cabinet', 'active pill is Gift Cabinet');
  });

  // --- Refresh while a collection is empty --------------------------------------
  await record('Refreshing while on an empty collection does not break navigation', async () => {
    await goNav(page, 'wishlist');
    assert(await page.locator('.empty').count() === 1, 'wishlist is empty before refresh');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card, .empty, .hero');
    assert(await page.locator('.hero').count() === 1, 'reload lands back on Discover (page state is not persisted)');
    assert((await activeNavLabel(page)) === 'Discover', 'active pill is Discover after reload');
    for (const [id, label, emptyText] of [
      ['wishlist', 'Wishlist', 'Nothing saved yet.'],
      ['reading', '📚 Reading List', 'No books saved yet.'],
      ['gifts', '🎁 Gift Cabinet', 'No gift ideas yet.'],
    ]) {
      await goNav(page, id);
      assert(await page.locator(`.empty:has-text("${emptyText}")`).count() === 1, `${label} still shows its empty state after reload`);
      assert((await activeNavLabel(page)) === label, `active pill is ${label}`);
    }
  });

  // --- Logo/header returns to Discover + All ------------------------------------
  await record('Forage logo/header returns to Discover with the All filter selected', async () => {
    await goNav(page, 'shop');
    await page.click('[data-filter="Pottery"]');
    await page.waitForTimeout(80);
    await goNav(page, 'cart');
    await page.click('.brand-home');
    await page.waitForTimeout(80);
    assert(await page.locator('.hero').count() === 1, 'logo click lands on Discover');
    assert((await activeNavLabel(page)) === 'Discover', 'active pill is Discover');
    await goNav(page, 'shop'); // ensure shop area is rendered fresh for the filter check below
    const allActive = await page.evaluate(() => {
      const b = document.querySelector('[data-filter="All"]');
      return b ? b.classList.contains('active') : false;
    });
    assert(allActive, 'the All category chip is active after returning home');
  });

  // --- Active pill follows the page actually displayed --------------------------
  await record('Active pill follows the page actually displayed, for every destination', async () => {
    const destinations = [
      ['shop', 'Discover'], ['cart', 'Cart'], ['orders', 'Orders'], ['stats', 'Stats'],
      ['gifts', '🎁 Gift Cabinet'], ['wishlist', 'Wishlist'], ['reading', '📚 Reading List'], ['profile', 'Profile'],
    ];
    for (const [id, label] of destinations) {
      await goNav(page, id);
      assert((await activeNavCount(page)) === 1, `exactly one active pill while on ${label}`);
      assert((await activeNavLabel(page)) === label, `active pill matches displayed page (${label})`);
    }
  });

  // --- Smoke: Cart -----------------------------------------------------------
  await record('Cart navigation and basic flow remain intact', async () => {
    await goNav(page, 'shop');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    await page.click('button[data-action="add-cart"]');
    await page.waitForTimeout(80);
    await goNav(page, 'cart');
    assert(await page.locator('h2:has-text("Your basket")').count() === 1, 'Cart heading present');
    assert(await page.locator('.cartline').count() === 1, 'cart shows the added item');
    assert((await activeNavLabel(page)).replace(/\d+$/, '').trim() === 'Cart', 'active pill is Cart');
  });

  // --- Smoke: Orders -----------------------------------------------------------
  await record('Orders navigation and checkout flow remain intact', async () => {
    await goNav(page, 'cart');
    await page.fill('#shipRecipient', 'Test Recipient');
    await page.fill('#shipLine1', '1 Test Way');
    await page.fill('#shipCity', 'Testville');
    await page.click('button[data-action="checkout"]');
    await page.waitForTimeout(150);
    assert(await page.locator('h2:has-text("Orders")').count() === 1, 'checkout navigates to Orders');
    assert(await page.locator('.order').count() >= 1, 'order recorded');
    assert((await activeNavLabel(page)) === 'Orders', 'active pill is Orders');
  });

  // --- Smoke: Stats ------------------------------------------------------------
  await record('Stats navigation and fund reset remain intact', async () => {
    await goNav(page, 'stats');
    assert(await page.locator('h2:has-text("Forage stats")').count() === 1, 'Stats heading present');
    await page.click('button[data-action="reset-funds"]');
    await page.waitForTimeout(80);
    assert((await page.locator('#balanceBox').textContent()).includes('2,000'), 'reset funds sets balance back to 2,000');
    assert((await activeNavLabel(page)) === 'Stats', 'active pill is Stats');
  });

  // --- Smoke: Profile ------------------------------------------------------------
  await record('Profile navigation and save remain intact', async () => {
    await goNav(page, 'profile');
    assert(await page.locator('h2:has-text("Profile")').count() === 1, 'Profile heading present');
    await page.fill('#profileName', 'Test Forager');
    await page.click('button[data-action="save-profile"]');
    await page.waitForTimeout(80);
    await goNav(page, 'shop');
    await goNav(page, 'profile');
    assert((await page.locator('#profileName').inputValue()) === 'Test Forager', 'profile name change persisted');
    assert((await activeNavLabel(page)) === 'Profile', 'active pill is Profile');
  });

  await browser.close();
  server.close();

  // --- Final report --------------------------------------------------------
  const failed = results.filter(r => !r.pass);
  console.log('\n=== SUITE SUMMARY ===');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (consoleErrors.length) {
    console.log('\n=== Unexpected browser console/page errors ===');
    consoleErrors.forEach(e => console.log(' -', e));
  }
  if (failed.length) {
    console.log('\n=== FAILURES ===');
    failed.forEach(f => console.log(` - ${f.name}\n   ${f.error}`));
    process.exitCode = 1;
  } else {
    console.log('\nALL TESTS PASSED');
  }
}

run().catch(e => { console.error('Suite crashed:', e); process.exitCode = 1; });
