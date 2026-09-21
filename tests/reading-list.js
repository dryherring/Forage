// Regression coverage for issue #9 (Books/Reading List: real books, formats,
// Amazon handoff, discovery improvements): the Books filter and its data,
// book detail facts, saving/removing from the Reading List, the simplified
// Want to Read/Read status, the Amazon search handoff from both the detail
// page and the Reading List, persistence, and tolerance of legacy/malformed
// Reading List state.
//
// Run with: node tests/reading-list.js  (or via `npm test`, which runs this
// after run.js, phase2-hardening.js, and gift-cabinet.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8982;
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

  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  const realBooks = catalog.filter(p => p.realBook === true);
  const nonBooks = catalog.filter(p => p.realBook !== true);

  async function fresh() {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }
  async function openBooksFilter() {
    await goNav(page, 'shop');
    await page.click('[data-filter="Books"]');
    await page.waitForTimeout(80);
  }
  async function openFirstBookDetail() {
    await openBooksFilter();
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    return (await page.locator('.detail h1').textContent()).trim();
  }
  async function saveFirstBookToReadingList() {
    const name = await openFirstBookDetail();
    await page.click('button[data-action="save-reading"]');
    await page.waitForTimeout(80);
    return name;
  }
  async function filteredResultsCount() {
    const meta = (await page.locator('#resultsMeta').textContent()) || '';
    const match = meta.match(/^([\d,]+)\s+products/);
    assert(match, `resultsMeta text is parseable (got "${meta}")`);
    return Number(match[1].replace(/,/g, ''));
  }
  // Searches the currently rendered page of cards for one matching `name`,
  // advancing through pagination (Discover shows 24 per page) if not found.
  async function clickCardByName(name) {
    for (let i = 0; i < 20; i++) {
      const cards = await page.locator('.card').all();
      for (const c of cards) {
        const h3 = (await c.locator('h3').textContent()).trim();
        if (h3 === name) { await c.click(); return true; }
      }
      const nextBtn = page.locator('[data-action="page-next"]');
      if (await nextBtn.count() === 0 || (await nextBtn.getAttribute('disabled')) !== null) return false;
      await nextBtn.click();
      await page.waitForTimeout(80);
    }
    return false;
  }

  // --- Catalog data sanity (backs the BOOK DATA AUDIT in the PR report) ---------
  await record('Catalog contains real books with author/topic/formats and no duplicate titles', async () => {
    assert(realBooks.length > 0, 'at least one real book exists in the catalog');
    for (const b of realBooks) {
      assert(typeof b.author === 'string' && b.author, `book ${b.id} has an author`);
      assert(typeof b.bookTopic === 'string' && b.bookTopic, `book ${b.id} has a topic`);
      assert(Array.isArray(b.formats) && b.formats.length > 0, `book ${b.id} has known formats`);
    }
    const names = realBooks.map(b => b.name);
    assert(new Set(names).size === names.length, 'no duplicate book titles in the catalog');
  });

  // --- Discovery: Books filter -------------------------------------------------
  await record('Books filter displays real books', async () => {
    await fresh();
    await openBooksFilter();
    const count = await filteredResultsCount();
    assert(count === realBooks.length, `Books filter shows exactly the ${realBooks.length} real books (got ${count})`);
  });

  await record('Non-book products do not appear under the Books filter', async () => {
    await openBooksFilter();
    const titles = await page.locator('.card h3').allTextContents();
    for (const p of nonBooks.slice(0, 50)) {
      assert(!titles.includes(p.name), `non-book "${p.name}" does not appear under Books`);
    }
  });

  await record('Book cards in Discover show a Books label (not the raw category) and author/topic', async () => {
    await openBooksFilter();
    const label = (await page.locator('.card .art-label').first().textContent()).trim();
    assert(label === 'Books', `book card art-label reads "Books" (got "${label}")`);
    const sub = (await page.locator('.card p.sub').first().textContent()).trim();
    assert(sub.includes('·'), `book card shows an author · topic line (got "${sub}")`);
  });

  // --- Book detail page ---------------------------------------------------------
  await record('Book detail shows title, author, and topic', async () => {
    await openFirstBookDetail();
    const h1 = (await page.locator('.detail h1').textContent()).trim();
    assert(h1.length > 0, 'title renders');
    const sub = (await page.locator('.detail p.sub').textContent()).trim();
    assert(sub.includes('·'), `author/topic subtitle renders (got "${sub}")`);
    const eyebrow = (await page.locator('.detail .eyebrow').first().textContent()).trim();
    assert(eyebrow.startsWith('Books'), `eyebrow category reads "Books" (got "${eyebrow}")`);
  });

  await record('Book detail specs surface known format availability', async () => {
    await openFirstBookDetail();
    const specsText = (await page.locator('.specs').textContent());
    assert(/Formats/i.test(specsText), 'a Formats spec is present when known');
  });

  // --- Saving to Reading List ----------------------------------------------------
  await record('Save book to Reading List', async () => {
    await fresh();
    const name = await saveFirstBookToReadingList();
    await goNav(page, 'reading');
    assert(await page.locator('.cartline').count() === 1, 'exactly one entry in the Reading List');
    const entryName = (await page.locator('.cartline strong').first().textContent()).trim();
    assert(entryName === name, `Reading List entry shows the saved book (expected "${name}", got "${entryName}")`);
  });

  await record('Duplicate save shows a toast and does not create a second entry', async () => {
    await openFirstBookDetail();
    await page.click('button[data-action="save-reading"]');
    await page.waitForTimeout(80);
    const toastText = await page.locator('.toast, #toast, [class*="toast"]').first().textContent().catch(() => '');
    await goNav(page, 'reading');
    assert(await page.locator('.cartline').count() === 1, 'still exactly one entry after saving the same book twice');
    void toastText;
  });

  // --- Reading List empty/populated states ---------------------------------------
  await record('Reading List remains navigable when empty', async () => {
    await fresh();
    await goNav(page, 'reading');
    assert(await page.locator('h2:has-text("Reading List")').count() === 1, 'heading renders');
    assert(await page.locator('.empty').count() === 1, 'empty-state message renders');
    assert(pageErrors.length === 0, `no page errors on empty Reading List (got: ${pageErrors.join(' | ')})`);
  });

  await record('Reading List displays saved book correctly with author, topic, and known formats', async () => {
    await fresh();
    const name = await saveFirstBookToReadingList();
    const book = realBooks.find(b => b.name === name);
    assert(book, `saved book "${name}" is a known real book in the catalog`);
    await goNav(page, 'reading');
    const line = await page.locator('.cartline').first().textContent();
    assert(line.includes(name), 'entry shows the book name');
    assert(line.includes(book.author), 'entry shows the author');
    assert(line.includes(book.bookTopic), 'entry shows the topic');
    for (const f of book.formats) assert(line.includes(f), `entry shows known format "${f}"`);
  });

  // --- Navigation back to detail ---------------------------------------------------
  await record('Navigate from Reading List to book detail', async () => {
    await fresh();
    const name = await saveFirstBookToReadingList();
    await goNav(page, 'reading');
    await page.click('.cartline button[data-action="open-product"]');
    await page.waitForSelector('.detail');
    const h1 = (await page.locator('.detail h1').textContent()).trim();
    assert(h1 === name, `detail page reopens the correct book (expected "${name}", got "${h1}")`);
  });

  // --- Amazon handoff --------------------------------------------------------------
  await record('Amazon handoff remains present and safe from the book detail page', async () => {
    await openFirstBookDetail();
    const opensWithNoopener = await page.evaluate(() => {
      const original = window.open;
      let captured = null;
      window.open = (url, target, features) => { captured = { url, features }; return null; };
      try { document.querySelector('button[data-action="amazon-book"]').click(); }
      finally { window.open = original; }
      return captured;
    });
    assert(opensWithNoopener, 'clicking View on Amazon calls window.open');
    assert(opensWithNoopener.features.includes('noopener') && opensWithNoopener.features.includes('noreferrer'),
      `Amazon link opens with noopener/noreferrer (got "${opensWithNoopener.features}")`);
    assert(opensWithNoopener.url.startsWith('https://www.amazon.com/s?k='), 'Amazon handoff is a search URL, not a fabricated product link');
  });

  await record('Amazon handoff is present and safe from the Reading List', async () => {
    await fresh();
    await saveFirstBookToReadingList();
    await goNav(page, 'reading');
    const opensWithNoopener = await page.evaluate(() => {
      const original = window.open;
      let captured = null;
      window.open = (url, target, features) => { captured = { url, features }; return null; };
      try { document.querySelector('.cartline button[data-action="amazon-book"]').click(); }
      finally { window.open = original; }
      return captured;
    });
    assert(opensWithNoopener, 'Reading List Amazon button calls window.open');
    assert(opensWithNoopener.features.includes('noopener') && opensWithNoopener.features.includes('noreferrer'),
      `Reading List Amazon link opens with noopener/noreferrer (got "${opensWithNoopener.features}")`);
  });

  // --- Removal and empty state -----------------------------------------------------
  await record('Remove book from Reading List', async () => {
    await fresh();
    await saveFirstBookToReadingList();
    await goNav(page, 'reading');
    await page.click('.cartline button[data-action="remove-reading"]');
    await page.waitForTimeout(80);
    assert(await page.locator('.cartline').count() === 0, 'entry removed');
  });

  await record('Removing the final book produces the correct empty state', async () => {
    await goNav(page, 'reading');
    assert(await page.locator('.empty').count() === 1, 'empty state shown after removing the only entry');
    assert((await page.locator('h2:has-text("Reading List")').count()) === 1, 'Reading List remains navigable after removal');
  });

  // --- Persistence -------------------------------------------------------------------
  await record('Reading List persists across navigation and reload', async () => {
    await fresh();
    const name = await saveFirstBookToReadingList();
    await goNav(page, 'shop');
    await goNav(page, 'reading');
    assert(await page.locator('.cartline').count() === 1, 'entry survives navigation');
    await page.reload({ waitUntil: 'networkidle' });
    await goNav(page, 'reading');
    const entryName = (await page.locator('.cartline strong').first().textContent()).trim();
    assert(entryName === name, 'entry survives a full page reload');
  });

  // --- Status simplification ---------------------------------------------------------
  await record('Reading List status offers only Want to Read / Read', async () => {
    await fresh();
    await saveFirstBookToReadingList();
    await goNav(page, 'reading');
    const options = await page.locator('select[data-action="reading-status"] option').allTextContents();
    assert(JSON.stringify(options) === JSON.stringify(['Want to Read', 'Read']), `status dropdown is Want to Read/Read only (got ${JSON.stringify(options)})`);
    await page.selectOption('select[data-action="reading-status"]', 'Read');
    await page.waitForTimeout(80);
    const status = await page.evaluate(() => JSON.parse(localStorage.getItem('forageV2State')).readingList[0].status);
    assert(status === 'Read', 'status change persists');
  });

  // --- Legacy / malformed state tolerance ---------------------------------------------
  await record('Legacy Reading List entries with old merchandise-style statuses and per-item formats still load safely', async () => {
    const book = realBooks[0];
    await page.evaluate((id) => {
      localStorage.setItem('forageV2State', JSON.stringify({
        balance: 2000, cart: [], wishlist: [], orders: [], purchases: 0, spent: 0,
        filter: 'All', query: '', sort: 'daily', pageNo: 1, giftIdeas: [],
        readingList: [
          { id, name: 'Legacy Book', format: 'Print', formats: ['Print', 'eBook'], status: 'Already Own' },
          { id: 'not-a-real-id', name: 'Ghost Book', status: 'Fictionally Purchased' },
        ],
      }));
    }, book.id);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero');
    assert(pageErrors.length === 0, `no page errors loading legacy Reading List state (got: ${pageErrors.join(' | ')})`);
    await goNav(page, 'reading');
    assert(await page.locator('.cartline').count() === 2, 'both legacy entries load');
    const statuses = await page.locator('select[data-action="reading-status"]').evaluateAll(els => els.map(el => el.value));
    assert(statuses.every(s => s === 'Want to Read'), `legacy non-book statuses normalize to "Want to Read" (got ${JSON.stringify(statuses)})`);
  });

  await record('Stale/malformed Reading List entries do not crash the page', async () => {
    await page.evaluate(() => {
      localStorage.setItem('forageV2State', JSON.stringify({
        balance: 2000, cart: [], wishlist: [], orders: [], purchases: 0, spent: 0,
        filter: 'All', query: '', sort: 'daily', pageNo: 1, giftIdeas: [],
        readingList: [
          { notAValidEntry: true },
          null,
          'garbage-string-entry',
          42,
          { id: 'missing-product-id', name: 'Untraceable', status: 'Orbiting' },
        ],
      }));
    });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero');
    await goNav(page, 'reading');
    assert(await page.locator('.empty:has-text("Forage hit a snag.")').count() === 0, 'Reading List renders normally, not the generic error fallback');
    assert(await page.locator('.cartline').count() === 1, 'the one recoverable entry renders; unrecoverable garbage is dropped');
    assert(errors.length === 0, `no uncaught page errors (got: ${errors.join(' | ')})`);
  });

  // --- Format label rendering ------------------------------------------------------
  await record('Format labels render correctly when metadata exists', async () => {
    await fresh();
    const book = realBooks.find(b => b.formats.length > 1) || realBooks[0];
    await goNav(page, 'shop');
    await page.click('[data-filter="Books"]');
    await page.waitForTimeout(80);
    const found = await clickCardByName(book.name);
    assert(found, 'the target book is present in Discover');
    await page.waitForSelector('.detail');
    await page.click('button[data-action="save-reading"]');
    await goNav(page, 'reading');
    const line = await page.locator('.cartline').first().textContent();
    for (const f of book.formats) assert(line.includes(f), `known format "${f}" renders in the Reading List`);
  });

  await record('Missing format metadata renders gracefully and does not imply availability', async () => {
    await page.evaluate(() => {
      localStorage.setItem('forageV2State', JSON.stringify({
        balance: 2000, cart: [], wishlist: [], orders: [], purchases: 0, spent: 0,
        filter: 'All', query: '', sort: 'daily', pageNo: 1, giftIdeas: [],
        readingList: [{ id: 'no-such-book-at-all', name: 'Unlisted Book', status: 'Want to Read' }],
      }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero');
    await goNav(page, 'reading');
    const line = await page.locator('.cartline').first().textContent();
    assert(!/\bAny\b/.test(line), 'no fabricated "Any" format is shown when formats are unknown');
    assert(await page.locator('.cartline button[data-action="amazon-book"]').count() === 0,
      'no Amazon handoff is offered for an entry whose product cannot be found (nothing to link to)');
  });

  // --- Sibling navigation still intact -------------------------------------------------
  await record('Wishlist, Gift Cabinet, Cart, Orders, Stats, and Profile navigation still work', async () => {
    await fresh();
    for (const [id, heading] of [
      ['wishlist', 'Wishlist'], ['gifts', 'Gift Cabinet'], ['cart', 'Your basket'],
      ['orders', 'Orders'], ['stats', 'Forage stats'], ['profile', 'Profile'],
    ]) {
      await goNav(page, id);
      assert(await page.locator(`h2:has-text("${heading}")`).count() === 1, `${id} still navigates and renders its heading`);
    }
  });

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.pass);
  console.log('\n=== READING LIST SUITE SUMMARY ===');
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\n=== FAILURES ===');
    failed.forEach(f => console.log(` - ${f.name}\n   ${f.error}`));
    process.exitCode = 1;
  } else {
    console.log('\nALL TESTS PASSED');
  }
}

run().catch(err => { console.error('Suite crashed:', err); process.exitCode = 1; });
