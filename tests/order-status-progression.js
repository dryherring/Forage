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

  await record('Express (1-day) orders jump straight from Processing to Delivered with no intermediate status', async () => {
    const placedToday = new Date();
    const deliverToday = new Date(placedToday); deliverToday.setDate(deliverToday.getDate() + 1);
    await fresh(baseState([baseOrder({ placed: placedToday.toISOString(), deliveryAt: deliverToday.toISOString(), status: 'Processing' })]));
    assert((await orderEyebrowText()).includes('processing'), 'day 0 of a 1-day order reads Processing');

    const placedYesterday = daysAgo(1);
    const deliverToday2 = new Date(placedYesterday); deliverToday2.setDate(deliverToday2.getDate() + 1);
    await fresh(baseState([baseOrder({ placed: placedYesterday.toISOString(), deliveryAt: deliverToday2.toISOString(), status: 'Processing' })]));
    assert((await orderEyebrowText()).includes('delivered'), 'day 1 of a 1-day order reads Delivered');
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
