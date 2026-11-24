// Regression coverage for date-based order status progression.
//
// Restores the fix for the production bug where an order (e.g. FG-T59C3U)
// stayed stuck on "Processing" long after its estimated delivery date had
// passed, and extends it to four statuses - Processing, Shipped, Out for
// delivery, Delivered - derived purely from elapsed calendar time against
// each order's own placed->deliveryAt window, scaled to its shipping speed
// (Express 1 day, Standard 3 days, Slow & scenic 5 days).
//
// Run with: node tests/order-status-progression.js (or via `npm test`)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8990;
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

function legacyDeliveryString(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function baseOrder(overrides) {
  return Object.assign({
    id: 'FG-TEST01',
    items: [{ id: 'test-item', qty: 1, option: null }],
    total: 42,
    placed: new Date().toISOString(),
    delivery: 'Thursday, January 1',
    status: 'Processing',
    shippingAddress: { recipient: 'Test Forager', line1: '1 Test Lane', line2: '', city: 'Testville', region: 'NC', postal: '27514' },
    gift: false,
    giftMessage: '',
    paymentId: 'pm1',
  }, overrides);
}
function baseState(orders) {
  return {
    balance: 2000, spent: 0, monthlySpent: 0, fundMonth: null, cart: [], wishlist: [], orders, purchases: 0,
    filter: 'All', query: '', sort: 'daily', pageNo: 1, readingList: [], giftIdeas: [],
  };
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  async function fresh(seed) {
    // Re-syncs the browser's clock to the real current time on every call,
    // undoing any freeze left behind by a prior freshAt() in this same
    // page/browser context - otherwise a later fresh() would silently run
    // against a stale mocked "now" instead of the real wall clock.
    await page.clock.setFixedTime(new Date());
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate((s) => localStorage.setItem('forageV2State', JSON.stringify(s)), seed);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }
  // For sub-day (hour-level) assertions, where relying on the real wall
  // clock would be imprecise: mocks the browser's Date via Playwright's
  // clock API before the app's own startup code runs.
  async function freshAt(fixedTime, seed) {
    await page.clock.setFixedTime(fixedTime);
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate((s) => localStorage.setItem('forageV2State', JSON.stringify(s)), seed);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }
  async function orderEyebrowText(i = 0) {
    await goNav(page, 'orders');
    return (await page.locator('.order .eyebrow').nth(i).innerText()).toLowerCase();
  }

  await record('A freshly placed Standard (3-day) order starts at Processing', async () => {
    const placed = new Date();
    const deliveryAt = new Date(placed); deliveryAt.setDate(deliveryAt.getDate() + 3);
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), deliveryAt: deliveryAt.toISOString(), status: 'Processing' })]));
    assert((await orderEyebrowText()).includes('processing'), 'day 0 of a 3-day order reads Processing');
  });

  await record('A Standard order 1 day in progresses to Shipped', async () => {
    const placed = daysAgo(1);
    const deliveryAt = new Date(placed); deliveryAt.setDate(deliveryAt.getDate() + 3);
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), deliveryAt: deliveryAt.toISOString(), status: 'Processing' })]));
    assert((await orderEyebrowText()).includes('shipped'), 'day 1 of a 3-day order reads Shipped');
  });

  await record('A Standard order 2 days in progresses to Out for delivery', async () => {
    const placed = daysAgo(2);
    const deliveryAt = new Date(placed); deliveryAt.setDate(deliveryAt.getDate() + 3);
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), deliveryAt: deliveryAt.toISOString(), status: 'Processing' })]));
    assert((await orderEyebrowText()).includes('out for delivery'), 'day 2 of a 3-day order reads Out for delivery');
  });

  await record('A Standard order past its 3-day window is Delivered, with a Delivered-dated label', async () => {
    const placed = daysAgo(3);
    const deliveryAt = new Date(placed); deliveryAt.setDate(deliveryAt.getDate() + 3);
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), deliveryAt: deliveryAt.toISOString(), status: 'Processing' })]));
    const text = await orderEyebrowText();
    assert(text.includes('delivered'), 'day 3 of a 3-day order reads Delivered');
    assert(!text.includes('estimated'), 'a Delivered order shows a Delivered date, not an Estimated one');
  });

  await record('Express (1-day) orders progress through all four statuses at hour-level milestones, not just Processing/Delivered', async () => {
    const placed = new Date('2026-05-01T08:00:00');
    const deliveryAt = new Date('2026-05-02T08:00:00'); // exactly 24h later - the promised delivery date
    const order = baseOrder({ placed: placed.toISOString(), deliveryAt: deliveryAt.toISOString(), status: 'Processing' });

    async function statusAtHour(hoursElapsed) {
      const now = new Date(placed.getTime() + hoursElapsed * 3600000);
      await freshAt(now, baseState([order]));
      return orderEyebrowText();
    }
    assert((await statusAtHour(2)).includes('processing'), '2h into a 24h Express window reads Processing');
    assert((await statusAtHour(10)).includes('shipped'), '10h in (>33%) reads Shipped, not stuck on Processing');
    assert((await statusAtHour(20)).includes('out for delivery'), '20h in (>66%) reads Out for delivery');
    assert((await statusAtHour(24)).includes('delivered'), '24h in, right at the promised deliveryAt, reads Delivered');
  });

  await record('An Express order\'s promised deliveryAt is unaffected by hour-level status milestones', async () => {
    const placed = new Date('2026-05-10T08:00:00');
    const deliveryAt = new Date('2026-05-11T08:00:00');
    const order = baseOrder({ placed: placed.toISOString(), deliveryAt: deliveryAt.toISOString(), status: 'Processing' });
    await freshAt(new Date(placed.getTime() + 10 * 3600000), baseState([order]));
    const stored = await page.evaluate(() => state.orders[0].deliveryAt);
    assert(stored === deliveryAt.toISOString(), `deliveryAt is never altered by status progression (got ${stored})`);
  });

  await record('Slow & scenic (5-day) orders progress through all four statuses across the window', async () => {
    async function statusAt(elapsedDays) {
      const placed = daysAgo(elapsedDays);
      const deliveryAt = new Date(placed); deliveryAt.setDate(deliveryAt.getDate() + 5);
      await fresh(baseState([baseOrder({ placed: placed.toISOString(), deliveryAt: deliveryAt.toISOString(), status: 'Processing' })]));
      return orderEyebrowText();
    }
    assert((await statusAt(0)).includes('processing'), 'day 0 of a 5-day order reads Processing');
    assert((await statusAt(2)).includes('shipped'), 'day 2 of a 5-day order reads Shipped');
    assert((await statusAt(4)).includes('out for delivery'), 'day 4 of a 5-day order reads Out for delivery');
    assert((await statusAt(5)).includes('delivered'), 'day 5 of a 5-day order reads Delivered');
  });

  await record('The exact reported bug: a legacy overdue order (no deliveryAt, no year in its delivery string) becomes Delivered', async () => {
    const placed = daysAgo(60);
    const deliveryDisplay = new Date(placed); deliveryDisplay.setDate(deliveryDisplay.getDate() + 3);
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), delivery: legacyDeliveryString(deliveryDisplay), status: 'Processing' })]));
    assert((await orderEyebrowText()).includes('delivered'), 'a long-overdue legacy order migrates to Delivered');
  });

  await record('A legacy order placed near a year boundary resolves its delivery date to the correct (next) year', async () => {
    const placed = new Date(new Date().getFullYear() - 1, 11, 28); // Dec 28, last year
    const deliveryDisplay = new Date(placed.getFullYear() + 1, 0, 3); // Jan 3, rolled into next year
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), delivery: legacyDeliveryString(deliveryDisplay), status: 'Processing' })]));
    const deliveryAt = await page.evaluate(() => state.orders[0].deliveryAt);
    assert(new Date(deliveryAt).getFullYear() === placed.getFullYear() + 1, `derived deliveryAt rolls into ${placed.getFullYear() + 1} (got ${deliveryAt})`);
    assert(new Date(deliveryAt).getTime() >= placed.getTime(), 'derived deliveryAt is on or after the order was placed');
  });

  await record('Legacy reconstruction compares calendar dates, not raw timestamps: a same-day candidate ordered late in the day is not wrongly rolled into next year', async () => {
    // Placed late at night; the legacy display string is for the SAME calendar day, which parses
    // to local midnight - earlier than `placed` by raw timestamp, even though it's the same date.
    const placed = new Date(); placed.setHours(23, 0, 0, 0);
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), delivery: legacyDeliveryString(placed), status: 'Processing' })]));
    const deliveryAt = await page.evaluate(() => state.orders[0].deliveryAt);
    const resolved = new Date(deliveryAt);
    assert(resolved.getFullYear() === placed.getFullYear() && resolved.getMonth() === placed.getMonth() && resolved.getDate() === placed.getDate(),
      `a same-calendar-day candidate resolves to that same day, not rolled forward a year just because midnight < placed's time-of-day (placed ${placed.toISOString()}, got ${deliveryAt})`);
  });

  await record('An implausibly distant reconstructed date (corrupted legacy data) is rejected and falls back safely, rather than trusted literally', async () => {
    const placed = new Date('2026-01-05T09:00:00'); // every real shipping option is 1-5 days; "December 20" the same year is ~349 days out
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), delivery: 'Sunday, December 20', status: 'Processing' })]));
    const deliveryAt = await page.evaluate(() => state.orders[0].deliveryAt);
    const daysOut = Math.round((new Date(deliveryAt) - placed) / 86400000);
    assert(daysOut >= 0 && daysOut <= 10, `an implausible ~349-day-out candidate is rejected in favor of the safe near-term fallback, not trusted literally (got ${daysOut} days out)`);
  });

  await record('A non-English legacy delivery string (locale limitation) does not crash and falls back safely', async () => {
    const placed = new Date('2026-02-01T09:00:00');
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), delivery: 'jeudi, 3 janvier', status: 'Processing' })]));
    assert(await page.locator('.empty:has-text("hit a snag")').count() === 0, 'a non-English (unparseable) legacy date string does not crash the app');
    const deliveryAt = await page.evaluate(() => state.orders[0].deliveryAt);
    assert(!isNaN(new Date(deliveryAt).getTime()), 'a real, valid deliveryAt is still produced via the safe fallback');
  });

  await record("A persisted legacy order's migrated deliveryAt and status are actually saved back to localStorage", async () => {
    const placed = daysAgo(30);
    const deliveryDisplay = new Date(placed); deliveryDisplay.setDate(deliveryDisplay.getDate() + 3);
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), delivery: legacyDeliveryString(deliveryDisplay), status: 'Processing' })]));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('forageV2State')).orders[0]);
    assert(typeof stored.deliveryAt === 'string' && !isNaN(new Date(stored.deliveryAt)), 'a real deliveryAt was persisted');
    assert(stored.status === 'Delivered', 'the migrated Delivered status was persisted');
  });

  await record('Order item contents and all other fields are preserved exactly through migration', async () => {
    const placed = daysAgo(10);
    const order = baseOrder({
      placed: placed.toISOString(), delivery: legacyDeliveryString(new Date()),
      items: [{ id: 'test-item', qty: 3, option: 'Large' }], total: 123.45, gift: true, giftMessage: 'Enjoy!',
    });
    await fresh(baseState([order]));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('forageV2State')).orders[0]);
    assert(stored.id === order.id, 'order id preserved');
    assert(stored.total === order.total, 'order total preserved');
    assert(JSON.stringify(stored.items) === JSON.stringify(order.items), 'order items preserved exactly');
    assert(stored.gift === true && stored.giftMessage === 'Enjoy!', 'gift fields preserved');
    assert(JSON.stringify(stored.shippingAddress) === JSON.stringify(order.shippingAddress), 'shipping address preserved');
  });

  await record('Status never regresses even if the stored status is ahead of a (clock-skewed) computed status', async () => {
    const placed = daysAgo(1);
    const futureDeliveryAt = new Date(); futureDeliveryAt.setDate(futureDeliveryAt.getDate() + 10);
    await fresh(baseState([baseOrder({ placed: placed.toISOString(), deliveryAt: futureDeliveryAt.toISOString(), status: 'Delivered' })]));
    assert((await orderEyebrowText()).includes('delivered'), 'a previously-Delivered order is never walked back to an earlier status');
  });

  await record('A malformed legacy order (missing placed date) does not crash and resolves to a safe, non-overdue status', async () => {
    const order = baseOrder({ placed: 'not-a-date', delivery: 'Garbled Date String', status: 'Processing' });
    delete order.deliveryAt;
    await fresh(baseState([order]));
    assert(await page.locator('.empty:has-text("hit a snag")').count() === 0, 'app does not crash on a malformed legacy order');
    assert((await orderEyebrowText()).includes('processing'), 'malformed order resolves safely to Processing rather than crashing or guessing Delivered');
  });

  await record('Multiple orders progress independently based on their own elapsed time', async () => {
    const o1 = baseOrder({ id: 'FG-NEW01', placed: new Date().toISOString() });
    const placedOverdue = daysAgo(10);
    const deliverOverdue = new Date(placedOverdue); deliverOverdue.setDate(deliverOverdue.getDate() + 3);
    const o2 = baseOrder({ id: 'FG-OLD02', placed: placedOverdue.toISOString(), deliveryAt: deliverOverdue.toISOString(), status: 'Processing' });
    await fresh(baseState([o1, o2]));
    const texts = await Promise.all([0, 1].map(i => orderEyebrowText(i)));
    assert(texts.some(t => t.includes('processing')), 'the fresh order stays Processing');
    assert(texts.some(t => t.includes('delivered')), 'the overdue order moves to Delivered');
  });

  await record('Placing a fresh order today stores a deliveryAt matching the displayed estimate, for every shipping speed', async () => {
    for (const [shipValue, days] of [['express', 1], ['standard', 3], ['slow', 5]]) {
      await fresh(baseState([]));
      await goNav(page, 'shop');
      await page.locator('.card').first().click();
      await page.waitForSelector('.detail');
      await page.click('button[data-action="add-cart"]');
      await goNav(page, 'cart');
      await page.selectOption('#ship', shipValue);
      await page.fill('#shipRecipient', 'Test Forager');
      await page.fill('#shipLine1', '1 Test Lane');
      await page.fill('#shipCity', 'Testville');
      await page.click('button[data-action="checkout"]');
      await page.waitForTimeout(150);
      const order = await page.evaluate(() => state.orders[0]);
      const placed = new Date(order.placed), deliveredAt = new Date(order.deliveryAt);
      const expectedDays = Math.round((deliveredAt.setHours(0, 0, 0, 0) - new Date(placed).setHours(0, 0, 0, 0)) / 86400000);
      assert(expectedDays === days, `${shipValue} order's deliveryAt is ${days} day(s) out (got ${expectedDays})`);
      assert(order.status === 'Processing', `${shipValue} order starts life as Processing`);
    }
  });

  await record('No interference with existing cart/checkout/nav behavior', async () => {
    await fresh(baseState([]));
    await goNav(page, 'shop');
    assert(await page.locator('.hero').count() === 1, 'shop page still renders');
    await goNav(page, 'cart');
    assert(await page.locator('.empty:has-text("empty")').count() === 1, 'empty cart renders normally');
    await goNav(page, 'stats');
    assert(await page.locator('h2:has-text("Forage stats")').count() === 1, 'stats page still renders');
  });

  await browser.close();
  server.close();

  console.log('\n=== ORDER STATUS PROGRESSION SUITE SUMMARY ===');
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
