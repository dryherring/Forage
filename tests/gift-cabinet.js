// Regression coverage for the Gift Cabinet lifecycle (issue #8): saving with
// no required metadata, adding/editing recipient/occasion/notes later,
// changing status, persistence across navigation and reload, removal, and
// tolerance of legacy/malformed Gift Cabinet state.
//
// Run with: node tests/gift-cabinet.js  (or via `npm test`, which runs this
// after run.js and phase2-hardening.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8981;
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
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  async function fresh() {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }
  async function saveFirstProductToGifts() {
    await goNav(page, 'shop');
    await page.click('[data-filter="All"]');
    await page.waitForTimeout(80);
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    const name = (await page.locator('.detail h1').textContent()).trim();
    await page.click('button[data-action="save-gift-idea"]');
    await page.waitForTimeout(100);
    return name;
  }

  await fresh();

  // --- Save with no dialogs and no required metadata --------------------------
  let productName = null;
  await record('Saving to the Gift Cabinet is a single click, no dialogs, no required metadata', async () => {
    let dialogFired = false;
    page.once('dialog', d => { dialogFired = true; d.dismiss(); });
    productName = await saveFirstProductToGifts();
    assert(!dialogFired, 'no native dialog appeared while saving');
    await goNav(page, 'gifts');
    assert(await page.locator('.cartline').count() === 1, 'Gift Cabinet shows the saved item');
    const title = (await page.locator('.cartline strong').first().textContent()).trim();
    assert(title === productName, `saved item shows the right product name (expected "${productName}", got "${title}")`);
  });

  // --- Item exists without metadata, with a friendly placeholder ---------------
  await record('A Gift Cabinet item can exist with no recipient/occasion/notes', async () => {
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent()).trim();
    assert(eyebrow.length > 0, 'a summary line is shown even with nothing filled in');
    assert(await page.locator('.cartline p').count() === 0, 'no empty note paragraph is rendered when there is no note');
  });

  // --- Saving the same product twice does not duplicate it ---------------------
  await record('Saving the same product to the Gift Cabinet again does not create a duplicate', async () => {
    await goNav(page, 'shop');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    await page.click('button[data-action="save-gift-idea"]');
    await page.waitForTimeout(100);
    await goNav(page, 'gifts');
    assert(await page.locator('.cartline').count() === 1, 'still exactly one entry after saving the same product twice');
  });

  // --- Edit details toggle: add recipient/occasion/notes -----------------------
  await record('Edit details toggle reveals recipient/occasion/notes fields', async () => {
    assert(await page.locator('input[data-action="gift-recipient"]').count() === 0, 'edit fields are hidden by default');
    await page.click('button[data-action="gift-edit-toggle"]');
    await page.waitForTimeout(80);
    assert(await page.locator('input[data-action="gift-recipient"]').count() === 1, 'recipient field appears after toggling edit');
    assert(await page.locator('input[data-action="gift-occasion"]').count() === 1, 'occasion field appears after toggling edit');
    assert(await page.locator('textarea[data-action="gift-note"]').count() === 1, 'notes field appears after toggling edit');
  });

  await record('Adding a recipient updates the Gift Cabinet summary', async () => {
    await page.fill('input[data-action="gift-recipient"]', 'Alex');
    await page.locator('input[data-action="gift-recipient"]').blur();
    await page.waitForTimeout(100);
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('Alex'), `summary shows the new recipient (got "${eyebrow}")`);
  });

  await record('Adding an occasion updates the Gift Cabinet summary', async () => {
    // re-open edit (blur's re-render preserves open state, but confirm defensively)
    if (await page.locator('input[data-action="gift-occasion"]').count() === 0) {
      await page.click('button[data-action="gift-edit-toggle"]');
      await page.waitForTimeout(80);
    }
    await page.fill('input[data-action="gift-occasion"]', 'Birthday');
    await page.locator('input[data-action="gift-occasion"]').blur();
    await page.waitForTimeout(100);
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('Alex') && eyebrow.includes('Birthday'), `summary shows recipient and occasion (got "${eyebrow}")`);
  });

  await record('Adding a note shows a note preview when the edit panel is collapsed', async () => {
    if (await page.locator('textarea[data-action="gift-note"]').count() === 0) {
      await page.click('button[data-action="gift-edit-toggle"]');
      await page.waitForTimeout(80);
    }
    await page.fill('textarea[data-action="gift-note"]', 'She mentioned wanting one of these.');
    await page.locator('textarea[data-action="gift-note"]').blur();
    await page.waitForTimeout(100);
    await page.click('button[data-action="gift-edit-toggle"]'); // collapse
    await page.waitForTimeout(80);
    assert(await page.locator('input[data-action="gift-recipient"]').count() === 0, 'edit panel collapsed');
    const noteText = (await page.locator('.cartline p').first().textContent());
    assert(noteText.includes('mentioned wanting'), `note preview shows saved text (got "${noteText}")`);
  });

  // --- Change lifecycle/status ---------------------------------------------------
  await record('Gift status can be changed and offers the simplified Idea/Purchased/Given lifecycle', async () => {
    const options = await page.locator('select[data-action="gift-status"]').first().locator('option').allTextContents();
    assert(JSON.stringify(options) === JSON.stringify(['Idea', 'Purchased', 'Given']), `status options are Idea/Purchased/Given (got ${JSON.stringify(options)})`);
    await page.selectOption('select[data-action="gift-status"]', 'Purchased');
    await page.waitForTimeout(100);
    const selected = await page.locator('select[data-action="gift-status"]').first().inputValue();
    assert(selected === 'Purchased', 'status updated to Purchased');
  });

  await record('Marking a gift Given keeps it in the Gift Cabinet (no auto-delete) and visually de-emphasizes it', async () => {
    await page.selectOption('select[data-action="gift-status"]', 'Given');
    await page.waitForTimeout(100);
    assert(await page.locator('.cartline').count() === 1, 'the given gift is still present, not deleted');
    const opacity = await page.locator('.cartline').first().evaluate(el => getComputedStyle(el).opacity);
    assert(parseFloat(opacity) < 1, `a Given gift is visually de-emphasized (opacity was ${opacity})`);
  });

  // --- Persistence across navigation and reload -----------------------------------
  await record('Metadata and status persist after navigating away and back', async () => {
    await goNav(page, 'wishlist');
    await goNav(page, 'gifts');
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('Alex') && eyebrow.includes('Birthday'), 'recipient/occasion survive navigating away and back');
    const status = await page.locator('select[data-action="gift-status"]').first().inputValue();
    assert(status === 'Given', 'status survives navigating away and back');
  });

  await record('Metadata and status persist after a full page reload', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero');
    await goNav(page, 'gifts');
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('Alex') && eyebrow.includes('Birthday'), 'recipient/occasion survive a reload');
    const status = await page.locator('select[data-action="gift-status"]').first().inputValue();
    assert(status === 'Given', 'status survives a reload');
    const noteText = (await page.locator('.cartline p').first().textContent());
    assert(noteText.includes('mentioned wanting'), 'note survives a reload');
  });

  // --- Remove and empty state -------------------------------------------------------
  await record('Removing the item empties the Gift Cabinet with the correct empty state', async () => {
    await page.click('.cartline button.danger');
    await page.waitForTimeout(100);
    assert(await page.locator('.empty:has-text("No gift ideas yet.")').count() === 1, 'empty message shown after removing the only item');
    await goNav(page, 'wishlist');
    await goNav(page, 'gifts');
    assert(await page.locator('.empty:has-text("No gift ideas yet.")').count() === 1, 'empty state persists after navigating away and back');
  });

  // --- XSS safety on the new free-text fields -----------------------------------------
  await record('Recipient/occasion/note fields render injected markup as inert text', async () => {
    await fresh();
    let xssFired = false;
    await page.exposeFunction('__giftXssMarker', () => { xssFired = true; });
    const payload = `"><img src=x onerror="window.__giftXssMarker()">`;
    await saveFirstProductToGifts();
    await goNav(page, 'gifts');
    await page.click('button[data-action="gift-edit-toggle"]');
    await page.waitForTimeout(80);
    await page.fill('input[data-action="gift-recipient"]', payload);
    await page.locator('input[data-action="gift-recipient"]').blur();
    await page.waitForTimeout(100);
    if (await page.locator('input[data-action="gift-occasion"]').count() === 0) {
      await page.click('button[data-action="gift-edit-toggle"]');
      await page.waitForTimeout(80);
    }
    await page.fill('input[data-action="gift-occasion"]', payload);
    await page.locator('input[data-action="gift-occasion"]').blur();
    await page.waitForTimeout(100);
    if (await page.locator('textarea[data-action="gift-note"]').count() === 0) {
      await page.click('button[data-action="gift-edit-toggle"]');
      await page.waitForTimeout(80);
    }
    await page.fill('textarea[data-action="gift-note"]', payload);
    await page.locator('textarea[data-action="gift-note"]').blur();
    await page.waitForTimeout(100);
    assert(!xssFired, 'no injected script executed from recipient/occasion/note');
    const html = await page.locator('.cartline').first().innerHTML();
    assert(!/<img[^>]*onerror=/i.test(html), 'no live <img onerror> tag exists in the rendered Gift Cabinet card');
  });

  // --- Legacy state tolerance --------------------------------------------------------
  await record('Legacy 4-status Gift Cabinet state (Idea/Fictionally Purchased/Actually Purchased/Given) still loads safely', async () => {
    await page.evaluate(() => {
      localStorage.setItem('forageV2State', JSON.stringify({
        balance: 2000, cart: [], wishlist: [], orders: [], purchases: 0, spent: 0,
        filter: 'All', query: '', sort: 'daily', pageNo: 1, readingList: [],
        giftIdeas: [
          { id: 'p0002', name: 'Legacy Fictional', person: 'Sam', occasion: 'Housewarming', note: '', status: 'Fictionally Purchased' },
          { id: 'p0003', name: 'Legacy Actual', person: '', occasion: '', note: '', status: 'Actually Purchased' },
        ],
      }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero');
    assert(pageErrors.length === 0, `no page errors loading legacy state (got: ${pageErrors.join(' | ')})`);
    await goNav(page, 'gifts');
    assert(await page.locator('.cartline').count() === 2, 'both legacy entries load');
    const statuses = await page.locator('select[data-action="gift-status"]').evaluateAll(els => els.map(el => el.value));
    assert(statuses.every(s => s === 'Purchased'), `legacy purchased variants both normalize to "Purchased" (got ${JSON.stringify(statuses)})`);
  });

  // --- Malformed metadata tolerance ---------------------------------------------------
  await record('Malformed optional Gift Cabinet metadata does not crash the page', async () => {
    await page.evaluate(() => {
      localStorage.setItem('forageV2State', JSON.stringify({
        balance: 2000, cart: [], wishlist: [], orders: [], purchases: 0, spent: 0,
        filter: 'All', query: '', sort: 'daily', pageNo: 1, readingList: [],
        giftIdeas: [
          { id: 'p0002', name: 'Fine Entry', person: 123, occasion: null, note: { nested: true }, status: 'Orbiting' },
          { notAValidEntry: true },
          null,
          'garbage-string-entry',
          42,
          { id: 'p0004', status: 'Given' },
        ],
      }));
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero');
    await goNav(page, 'gifts');
    assert(await page.locator('.empty:has-text("Forage hit a snag.")').count() === 0, 'Gift Cabinet renders normally, not the generic error fallback');
    assert(await page.locator('.cartline').count() === 2, 'the two recoverable entries render; unrecoverable garbage is dropped');
    assert(errors.length === 0, `no uncaught page errors (got: ${errors.join(' | ')})`);
  });

  // --- Sibling navigation still intact -------------------------------------------------
  await record('Wishlist, Reading List, Cart, Orders, Stats, and Profile navigation still work', async () => {
    await fresh();
    for (const [id, heading] of [
      ['wishlist', 'Wishlist'], ['reading', 'Reading List'], ['cart', 'Your basket'],
      ['orders', 'Orders'], ['stats', 'Forage stats'], ['profile', 'Profile'],
    ]) {
      await goNav(page, id);
      assert(await page.locator(`h2:has-text("${heading}")`).count() === 1, `${id} still navigates and renders its heading`);
    }
  });

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.pass);
  console.log('\n=== GIFT CABINET SUITE SUMMARY ===');
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
