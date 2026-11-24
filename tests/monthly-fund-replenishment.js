// Regression coverage for automatic monthly Forage Fund replenishment:
// flat reset to Ƶ2,000 on the first of each calendar month, no rollover,
// monthly spending tracked separately from lifetime spending, and a safe
// migration path for installs that predate month-tracking entirely.
//
// Uses Playwright's clock API to deterministically exercise month/year
// boundaries rather than depending on the real current date.
//
// Run with: node tests/monthly-fund-replenishment.js (or via `npm test`)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8991;
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

function baseState(overrides) {
  return Object.assign({
    balance: 2000, spent: 0, monthlySpent: 0, fundMonth: null, cart: [], wishlist: [], orders: [], purchases: 0,
    filter: 'All', query: '', sort: 'daily', pageNo: 1, readingList: [], giftIdeas: [],
  }, overrides);
}
function monthKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Navigates at a fixed mocked "now", seeding localStorage first so app.js's
  // own startup code (migration + reconciliation) runs against that seed.
  async function freshAt(fixedTime, seed) {
    await page.clock.setFixedTime(fixedTime);
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate((s) => localStorage.setItem('forageV2State', JSON.stringify(s)), seed);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }
  async function reloadAt(fixedTime) {
    await page.clock.setFixedTime(fixedTime);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }
  const getState = () => page.evaluate(() => JSON.parse(localStorage.getItem('forageV2State')));

  await record('A pre-existing install with no fundMonth migrates safely: balance is left untouched, fundMonth is stamped, and monthlySpent is reconstructed from this month\'s orders only', async () => {
    const now = new Date('2026-06-15T10:00:00');
    const thisMonthOrder = { id: 'FG-THISMO', items: [], total: 300, placed: new Date('2026-06-02T09:00:00').toISOString(), delivery: 'x', deliveryAt: new Date('2026-06-05T09:00:00').toISOString(), status: 'Processing', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    const lastMonthOrder = { id: 'FG-LASTMO', items: [], total: 9999, placed: new Date('2026-05-20T09:00:00').toISOString(), delivery: 'x', deliveryAt: new Date('2026-05-23T09:00:00').toISOString(), status: 'Delivered', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    await freshAt(now, baseState({ balance: 750, spent: 10299, monthlySpent: 0, fundMonth: null, orders: [thisMonthOrder, lastMonthOrder] }));
    const s = await getState();
    assert(s.fundMonth === '2026-06', `fundMonth stamped to the current month (got ${s.fundMonth})`);
    assert(s.balance === 750, `balance is left exactly as-is on first migration, not reset (got ${s.balance})`);
    assert(s.monthlySpent === 300, `monthlySpent reconstructed only from this month's order total (got ${s.monthlySpent})`);
    assert(s.spent === 10299, 'lifetime spent is untouched by migration');
    assert(s.orders.length === 2, 'both orders are preserved through migration');
  });

  await record('A user returning after the calendar month has turned over is replenished to a flat 2,000, with monthlySpent reset (no rollover of leftover funds)', async () => {
    await freshAt(new Date('2026-07-20T10:00:00'), baseState({ balance: 1850, monthlySpent: 150, fundMonth: '2026-06' }));
    const s = await getState();
    assert(s.fundMonth === '2026-07', `fundMonth advances to the new month (got ${s.fundMonth})`);
    assert(s.balance === 2000, `balance resets to the flat monthly amount, not 2000+leftover (got ${s.balance})`);
    assert(s.monthlySpent === 0, `monthlySpent resets to 0 for the new month (got ${s.monthlySpent})`);
  });

  await record('No rollover in either direction: a nearly-full balance still snaps to exactly 2,000, never 2,000+leftover', async () => {
    await freshAt(new Date('2026-08-05T10:00:00'), baseState({ balance: 1950, monthlySpent: 50, fundMonth: '2026-07' }));
    const s = await getState();
    assert(s.balance === 2000, `even a barely-spent prior balance snaps to the flat 2,000 (got ${s.balance})`);
  });

  await record('Returning after several skipped months still replenishes only once, to the flat amount - never accumulated per skipped month', async () => {
    await freshAt(new Date('2026-11-01T10:00:00'), baseState({ balance: 40, monthlySpent: 1960, fundMonth: '2026-06' }));
    const s = await getState();
    assert(s.fundMonth === '2026-11', `fundMonth jumps straight to the current month (got ${s.fundMonth})`);
    assert(s.balance === 2000, `balance is exactly 2,000, not multiplied across the 5 skipped months (got ${s.balance})`);
    assert(s.monthlySpent === 0, 'monthlySpent resets once, not per skipped month');
  });

  await record('Month keys correctly roll over a year boundary: December -> January replenishes', async () => {
    await freshAt(new Date('2026-12-15T10:00:00'), baseState({ balance: 2000, monthlySpent: 0, fundMonth: '2026-12' }));
    let s = await getState();
    assert(s.fundMonth === '2026-12' && s.balance === 2000, 'no replenishment yet, still within December');
    await reloadAt(new Date('2027-01-03T10:00:00'));
    s = await getState();
    assert(s.fundMonth === '2027-01', `fundMonth rolls into the new year (got ${s.fundMonth})`);
    assert(s.balance === 2000, 'fund replenished across the year boundary');
  });

  await record('Repeated reconciliation within the same month is idempotent - no double replenishment, no drift', async () => {
    await freshAt(new Date('2026-09-10T10:00:00'), baseState({ balance: 2000, monthlySpent: 0, fundMonth: null }));
    let s = await getState();
    assert(s.fundMonth === '2026-09', 'migrated to September on first load');
    await reloadAt(new Date('2026-09-10T10:00:00'));
    s = await getState();
    assert(s.fundMonth === '2026-09' && s.balance === 2000, 'reloading again the same day changes nothing');
    const changed = await page.evaluate(() => reconcileTimeState());
    assert(changed === false, 'calling reconcileTimeState() again with no time having passed reports no change');
  });

  await record('A device clock that jumps backward within the same month cannot trigger a second replenishment', async () => {
    await freshAt(new Date('2026-10-05T10:00:00'), baseState({ balance: 2000, monthlySpent: 0, fundMonth: '2026-09' }));
    let s = await getState();
    assert(s.fundMonth === '2026-10' && s.balance === 2000, 'replenished once into October');
    // Spend some of this month's fund, then simulate the clock jumping backward into September.
    await page.evaluate(() => { state.balance = 1200; state.monthlySpent = 800; save(); });
    await reloadAt(new Date('2026-09-20T10:00:00'));
    s = await getState();
    assert(s.fundMonth === '2026-10', `fundMonth never regresses even if the clock does (got ${s.fundMonth})`);
    assert(s.balance === 1200 && s.monthlySpent === 800, 'balance/monthlySpent are untouched by a backward clock jump, not re-replenished');
  });

  await record('Starting fund, Spent, and Remaining in the Fund panel reflect the corrected monthly figures, not lifetime ones', async () => {
    await freshAt(new Date('2026-04-12T10:00:00'), baseState({ balance: 1100, spent: 55000, monthlySpent: 900, fundMonth: '2026-04' }));
    await page.click('#balanceBox');
    const rows = await page.locator('#fundPanel .fund-row').allTextContents();
    assert(rows.some(r => r.includes('Starting fund') && r.includes('2,000')), `Starting fund is the flat monthly allotment (got ${JSON.stringify(rows)})`);
    assert(rows.some(r => r.includes('Spent') && r.includes('900')), `Spent shows monthlySpent=900, not lifetime spent=55,000 (got ${JSON.stringify(rows)})`);
    assert(rows.some(r => r.includes('Remaining') && r.includes('1,100')), `Remaining shows balance=1,100 (got ${JSON.stringify(rows)})`);
  });

  await record('The manual "Refresh to 2,000" fund reset has been removed from the UI', async () => {
    await freshAt(new Date('2026-04-12T10:00:00'), baseState({}));
    await page.click('#nav button[data-action="go"][data-page="stats"]');
    await page.waitForTimeout(80);
    assert(await page.locator('button[data-action="reset-funds"]').count() === 0, 'no unrestricted manual replenishment control remains');
  });

  await record('Existing orders, cart, wishlist, collections and profile survive a replenishment untouched', async () => {
    const order = { id: 'FG-KEEPME', items: [{ id: 'x', qty: 1, option: null }], total: 10, placed: new Date('2026-05-01').toISOString(), delivery: 'x', deliveryAt: new Date('2026-05-04').toISOString(), status: 'Delivered', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    const seed = baseState({
      balance: 1850, monthlySpent: 150, fundMonth: '2026-05', orders: [order],
      cart: [{ id: 'cart-item', qty: 2, option: null }], wishlist: ['wish-item'],
      giftIdeas: [{ id: 'gift-item', name: 'Something nice', person: 'Sam', occasion: '', note: '', status: 'Idea' }],
      profile: { displayName: 'Julz Test', defaultAddress: { label: 'Home base', recipient: 'Julz Test', line1: '9 Keep St', line2: '', city: 'Durham', region: 'NC', postal: '27701' }, addresses: [], paymentMethods: [{ id: 'pm1', brand: 'Visa', label: 'Forage Visa', last4: '4242', default: true }] },
    });
    await freshAt(new Date('2026-06-02T10:00:00'), seed);
    const s = await getState();
    assert(s.balance === 2000, 'fund was replenished for the new month');
    assert(s.orders.length === 1 && s.orders[0].id === 'FG-KEEPME', 'order preserved');
    assert(s.cart.length === 1 && s.cart[0].id === 'cart-item', 'cart preserved');
    assert(s.wishlist.includes('wish-item'), 'wishlist preserved');
    assert(s.giftIdeas.length === 1 && s.giftIdeas[0].name === 'Something nice', 'gift cabinet preserved');
    assert(s.profile.displayName === 'Julz Test', 'profile preserved');
  });

  await browser.close();
  server.close();

  console.log('\n=== MONTHLY FUND REPLENISHMENT SUITE SUMMARY ===');
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
