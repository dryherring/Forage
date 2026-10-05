// Regression coverage for variant-aware pricing: the optionPrice() resolver,
// live price updates on the detail page, per-option cart lines/totals,
// checkout totals, quantity multiplication, backward compatibility with
// existing plain-string variants/sizes and option-less products, and
// graceful fallback for malformed/missing/stale option-price data.
//
// Run with: node tests/variant-pricing.js  (or via `npm test`, which runs
// this after catalog-quality.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8983;
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
  const chocolateObsession = catalog.find(p => p.id === 'chocolate-obsession');
  const rugbrod = catalog.find(p => p.id === 'rugbrod');
  const eggTart = catalog.find(p => p.id === 'cantonese-egg-tart');
  // Any existing plain-string-variant product not touched by this feature.
  const stringVariantProduct = catalog.find(p => Array.isArray(p.variants) && p.variants.length && typeof p.variants[0] === 'string' && p.cat !== 'Deli');
  const noOptionProduct = catalog.find(p => (!p.variants || !p.variants.length) && (!p.sizes || !p.sizes.length) && p.cat !== 'Deli' && !p.realBook);

  async function fresh() {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }
  async function openProductById(id) {
    // Called right after fresh(), which already lands on Discover with cards visible.
    await goNav(page, 'shop');
    const p = catalog.find(x => x.id === id);
    await page.fill('#searchInput', p.name);
    await page.waitForTimeout(200);
    const cards = await page.locator('.card').all();
    for (const c of cards) {
      const h3 = (await c.locator('h3').textContent()).trim();
      if (h3 === p.name) { await c.click(); return true; }
    }
    return false;
  }

  // --- Resolver correctness (data-level, via the live page's own logic) -----
  await record('Live detail-price update: selecting a different priced option updates the shown price without reload', async () => {
    await fresh();
    const found = await openProductById('chocolate-obsession');
    assert(found, 'Chocolate Obsession is reachable from Discover');
    await page.waitForSelector('.detail');
    const initial = (await page.locator('#detailPrice').textContent()).trim();
    assert(initial.includes('9.50'), `initial price shows the base (slice) price (got "${initial}")`);
    await page.selectOption('#variantSelect', { label: 'Whole cake — Ƶ 62' });
    await page.waitForTimeout(80);
    const updated = (await page.locator('#detailPrice').textContent()).trim();
    assert(updated.includes('62'), `price updates to the whole-cake price after selection (got "${updated}")`);
    assert(!updated.includes('9.5'), 'the old slice price no longer shows');
  });

  await record('Dropdown choices show label and price; the underlying option value stays the plain label', async () => {
    await fresh();
    await openProductById('chocolate-obsession');
    await page.waitForSelector('.detail');
    const optionTexts = await page.locator('#variantSelect option').allTextContents();
    assert(optionTexts.some(t => t.includes('Slice') && t.includes('9.50')), 'Slice option shows its price');
    assert(optionTexts.some(t => t.includes('Whole cake') && t.includes('62')), 'Whole cake option shows its price');
    const optionValues = await page.locator('#variantSelect option').evaluateAll(els => els.map(e => e.value));
    assert(optionValues.includes('Slice') && optionValues.includes('Whole cake'), `option values are plain labels, not label+price strings (got ${JSON.stringify(optionValues)})`);
  });

  await record('Differently priced options of the same product become distinct cart lines with correct totals', async () => {
    await fresh();
    await openProductById('chocolate-obsession');
    await page.waitForSelector('.detail');
    await page.click('button[data-action="add-cart"]'); // default selection: Slice, Ƶ9.50
    await page.selectOption('#variantSelect', { label: 'Whole cake — Ƶ 62' });
    await page.waitForTimeout(80);
    await page.click('button[data-action="add-cart"]');
    await goNav(page, 'cart');
    const lines = await page.locator('.cartline').all();
    assert(lines.length === 2, `two distinct cart lines for two priced options (got ${lines.length})`);
    const lineTexts = await page.locator('.cartline').allTextContents();
    assert(lineTexts.some(t => t.includes('Slice') && t.includes('9.50')), 'slice line shows its own price');
    assert(lineTexts.some(t => t.includes('Whole cake') && t.includes('62')), 'whole cake line shows its own price');
    const total = (await page.locator('.summary-row.total strong, .summary-row.total span').last().textContent()) || '';
    assert(total.includes('71.5') || total.includes('71.50'), `cart total is the sum of both real prices, 9.5+62=71.5 (got "${total}")`);
  });

  await record('Quantity multiplies the resolved option price, not the base price', async () => {
    await fresh();
    await openProductById('cantonese-egg-tart');
    await page.waitForSelector('.detail');
    await page.selectOption('#variantSelect', { label: 'Box of 6 — Ƶ 16' });
    await page.selectOption('#qtySelect', '2');
    await page.click('button[data-action="add-cart"]');
    await goNav(page, 'cart');
    const lineText = await page.locator('.cartline').first().textContent();
    assert(lineText.includes('32'), `2 x box-of-6 (Ƶ16) = Ƶ32, not 2 x base price (got "${lineText}")`);
  });

  await record('Checkout total matches the priced-option cart total, not the base price', async () => {
    await fresh();
    await openProductById('rugbrod');
    await page.waitForSelector('.detail');
    await page.selectOption('#variantSelect', { label: 'Half loaf — Ƶ 5' });
    await page.click('button[data-action="add-cart"]');
    await goNav(page, 'cart');
    await page.fill('#shipRecipient', 'Test Forager');
    await page.fill('#shipLine1', '1 Test Lane');
    await page.fill('#shipCity', 'Testville');
    await page.click('button[data-action="checkout"]');
    await page.waitForTimeout(150);
    const orderText = await page.locator('.order').first().textContent();
    assert(orderText.includes('Ƶ 5'), `order total reflects the half-loaf price (Ƶ 5) (got "${orderText}")`);
    assert(!orderText.includes('Ƶ 9'), `order total does not reflect the whole-loaf base price (Ƶ 9) (got "${orderText}")`);
  });

  // --- Backward compatibility -------------------------------------------------
  await record('Existing plain-string variants are unaffected: price stays constant across options', async () => {
    assert(stringVariantProduct, 'a non-Deli plain-string-variant product exists in the catalog to test against');
    await fresh();
    const found = await openProductById(stringVariantProduct.id);
    assert(found, `${stringVariantProduct.name} is reachable from Discover`);
    await page.waitForSelector('.detail');
    const before = (await page.locator('#detailPrice').textContent()).trim();
    const otherOption = stringVariantProduct.variants.find(v => v !== stringVariantProduct.variants[0]) || stringVariantProduct.variants[0];
    await page.selectOption('#variantSelect', otherOption);
    await page.waitForTimeout(80);
    const after = (await page.locator('#detailPrice').textContent()).trim();
    assert(before === after, `price is unchanged when switching plain-string variants (before "${before}", after "${after}")`);
  });

  await record('Products with no variants/sizes render and price normally', async () => {
    assert(noOptionProduct, 'a Deli/realBook-free option-less product exists to test against');
    await fresh();
    const found = await openProductById(noOptionProduct.id);
    assert(found, `${noOptionProduct.name} is reachable from Discover`);
    await page.waitForSelector('.detail');
    const priceText = (await page.locator('#detailPrice').textContent()).trim();
    assert(priceText.length > 0, 'a price renders with no option selector present');
    assert(await page.locator('#variantSelect').count() === 0 && await page.locator('#sizeSelect').count() === 0, 'no option selector is rendered for an option-less product');
  });

  // --- Graceful degradation ----------------------------------------------------
  await record('Malformed option-price data falls back to the base price at runtime without crashing', async () => {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    const result = await page.evaluate((p) => {
      const malformed = { ...p, variants: [{ label: 'Slice' }, { label: 'Whole cake', price: 'not-a-number' }, { label: 'Broken', price: -5 }] };
      return {
        missingPrice: optionPrice(malformed, 'Slice'),
        nonNumericPrice: optionPrice(malformed, 'Whole cake'),
        negativePrice: optionPrice(malformed, 'Broken'),
        unmatchedOption: optionPrice(malformed, 'Does not exist anywhere'),
      };
    }, chocolateObsession);
    assert(result.missingPrice === chocolateObsession.price, 'missing price on a variant falls back to base price');
    assert(result.nonNumericPrice === chocolateObsession.price, 'non-numeric price falls back to base price');
    assert(result.negativePrice === chocolateObsession.price, 'non-positive price falls back to base price');
    assert(result.unmatchedOption === chocolateObsession.price, 'an unmatched/stale option label falls back to base price');
  });

  await record('A cart line persisted with a stale/unmatched option still renders and totals at the base price', async () => {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate((id) => {
      localStorage.setItem('forageV2State', JSON.stringify({
        balance: 2000, cart: [{ id, qty: 1, option: 'This Option No Longer Exists' }], wishlist: [], orders: [], purchases: 0, spent: 0,
        filter: 'All', query: '', sort: 'daily', pageNo: 1, readingList: [], giftIdeas: [],
      }));
    }, chocolateObsession.id);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero');
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await goNav(page, 'cart');
    assert(await page.locator('.empty:has-text("Forage hit a snag.")').count() === 0, 'cart renders normally, not the generic error fallback');
    const lineText = await page.locator('.cartline').first().textContent();
    assert(lineText.includes('9.50'), `stale option falls back to the base price, Ƶ9.50 (got "${lineText}")`);
    assert(errors.length === 0, `no uncaught page errors (got: ${errors.join(' | ')})`);
  });

  // --- money() formatting -------------------------------------------------------
  await record('money() preserves two decimals for fractional prices and leaves whole numbers unchanged', async () => {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    const formatted = await page.evaluate(() => ({
      fractional: money(9.5),
      wholeSmall: money(179),
      wholeLarge: money(2000),
      alreadyTwoDecimals: money(2.5),
    }));
    assert(formatted.fractional === 'Ƶ 9.50', `fractional price gets a trailing zero (got "${formatted.fractional}")`);
    assert(formatted.wholeSmall === 'Ƶ 179', `whole number unchanged (got "${formatted.wholeSmall}")`);
    assert(formatted.wholeLarge === 'Ƶ 2,000', `whole number keeps its thousands separator (got "${formatted.wholeLarge}")`);
    assert(formatted.alreadyTwoDecimals === 'Ƶ 2.50', `fractional price formats to two decimals (got "${formatted.alreadyTwoDecimals}")`);
  });

  await record('Wishlist, Gift Cabinet, Reading List, Orders, Stats, and Profile navigation still work', async () => {
    await fresh();
    for (const id of ['wishlist', 'gifts', 'reading', 'orders', 'stats', 'profile']) {
      await goNav(page, id);
      assert(await page.locator('.empty:has-text("Forage hit a snag.")').count() === 0, `${id} page renders without error`);
    }
  });

  await browser.close();
  server.close();

  console.log('\n=== VARIANT PRICING SUITE SUMMARY ===');
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
