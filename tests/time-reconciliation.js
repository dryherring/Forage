// Regression coverage for shared time-based state reconciliation: the
// single reconcileTimeState() path that keeps the Forage Fund and order
// statuses in sync, run both at startup and when the app returns to the
// foreground (tab switch, app resume) - without ever disrupting an
// in-progress checkout form, and without double-applying itself.
//
// Run with: node tests/time-reconciliation.js (or via `npm test`)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8992;
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

function baseState(overrides) {
  return Object.assign({
    balance: 2000, spent: 0, monthlySpent: 0, fundMonth: null, cart: [], wishlist: [], orders: [], purchases: 0,
    filter: 'All', query: '', sort: 'daily', pageNo: 1, readingList: [], giftIdeas: [],
  }, overrides);
}
async function sendToBackground(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
async function returnToForeground(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  async function freshAt(fixedTime, seed) {
    await page.clock.setFixedTime(fixedTime);
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate((s) => localStorage.setItem('forageV2State', JSON.stringify(s)), seed);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }

  await record('Reconciliation runs at startup: an order that was already overdue when the app loads shows as Delivered immediately, no interaction required', async () => {
    const placed = new Date('2026-03-01T09:00:00');
    const order = { id: 'FG-STARTUP', items: [], total: 10, placed: placed.toISOString(), delivery: 'x', deliveryAt: new Date('2026-03-04T09:00:00').toISOString(), status: 'Processing', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    await freshAt(new Date('2026-03-20T09:00:00'), baseState({ orders: [order] }));
    await goNav(page, 'orders');
    const text = (await page.locator('.order .eyebrow').first().innerText()).toLowerCase();
    assert(text.includes('delivered'), 'overdue order is already Delivered on first render, with no extra action');
  });

  await record('Returning to the foreground re-syncs fund and order state without requiring a reload', async () => {
    const placed = new Date('2026-04-01T09:00:00');
    const order = { id: 'FG-FOREGROUND', items: [], total: 10, placed: placed.toISOString(), delivery: 'x', deliveryAt: new Date('2026-04-04T09:00:00').toISOString(), status: 'Processing', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    await freshAt(new Date('2026-04-01T10:00:00'), baseState({ balance: 2000, monthlySpent: 0, fundMonth: '2026-04', orders: [order] }));
    await goNav(page, 'orders');
    assert((await page.locator('.order .eyebrow').first().innerText()).toLowerCase().includes('processing'), 'order starts out Processing, not yet due');

    await sendToBackground(page);
    await page.clock.setFixedTime(new Date('2026-05-05T09:00:00')); // weeks later, crosses both the order's delivery date and a month boundary
    await returnToForeground(page);
    await page.waitForTimeout(80);

    const text = (await page.locator('.order .eyebrow').first().innerText()).toLowerCase();
    assert(text.includes('delivered'), 'order status updates to Delivered on foreground return, no reload needed');
    const s = await page.evaluate(() => state);
    assert(s.fundMonth === '2026-05' && s.balance === 2000, 'fund also replenishes for the new month on foreground return');
  });

  await record('Returning to the foreground never disrupts an in-progress checkout form, even when it triggers a fund replenishment and an order delivery', async () => {
    const placed = new Date('2026-06-01T09:00:00');
    const order = { id: 'FG-MIDTYPE', items: [], total: 10, placed: placed.toISOString(), delivery: 'x', deliveryAt: new Date('2026-06-04T09:00:00').toISOString(), status: 'Processing', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    await freshAt(new Date('2026-06-02T09:00:00'), baseState({ balance: 2000, monthlySpent: 0, fundMonth: '2026-06', orders: [order] }));
    await goNav(page, 'shop');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    await page.click('button[data-action="add-cart"]');
    await goNav(page, 'cart');

    await page.selectOption('#ship', 'express');
    await page.check('#giftToggle'); // clears/reveals the address fields for a gift address, by design - fill after
    await page.fill('#shipRecipient', 'Mid Typing Forager');
    await page.fill('#shipLine1', '42 Partly Typed Lane');
    await page.fill('#giftMessage', 'Still writing this note...');

    await sendToBackground(page);
    await page.clock.setFixedTime(new Date('2026-07-10T09:00:00')); // crosses the order's delivery date and a month boundary
    await returnToForeground(page);
    await page.waitForTimeout(80);

    assert(await page.locator('#shipRecipient').inputValue() === 'Mid Typing Forager', 'recipient field untouched by reconciliation');
    assert(await page.locator('#shipLine1').inputValue() === '42 Partly Typed Lane', 'address field untouched by reconciliation');
    assert(await page.locator('#ship').inputValue() === 'express', 'shipping speed selection untouched by reconciliation');
    assert(await page.locator('#giftToggle').isChecked() === true, 'gift toggle untouched by reconciliation');
    assert(await page.locator('#giftMessage').inputValue() === 'Still writing this note...', 'gift message untouched by reconciliation');

    const s = await page.evaluate(() => state);
    assert(s.balance === 2000 && s.fundMonth === '2026-07', 'the fund did genuinely replenish in the background');
    const headerBalance = await page.locator('#balanceBox').textContent();
    assert(headerBalance.includes('2,000'), 'the header balance pill reflects the reconciled balance even while the form is untouched');
  });

  await record('Returning to the foreground never disrupts unsaved Profile edits either, even when reconciliation has real changes to apply', async () => {
    const placed = new Date('2026-08-01T09:00:00');
    const order = { id: 'FG-PROFILE', items: [], total: 10, placed: placed.toISOString(), delivery: 'x', deliveryAt: new Date('2026-08-04T09:00:00').toISOString(), status: 'Processing', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    await freshAt(new Date('2026-08-02T09:00:00'), baseState({ balance: 2000, monthlySpent: 0, fundMonth: '2026-08', orders: [order] }));
    await goNav(page, 'profile');
    await page.fill('#profileName', 'Mid Edit Forager');
    await page.fill('#profileCity', 'Half-Typed City');

    await sendToBackground(page);
    await page.clock.setFixedTime(new Date('2026-09-15T09:00:00')); // crosses the order's delivery date and a month boundary
    await returnToForeground(page);
    await page.waitForTimeout(80);

    assert(await page.locator('#profileName').inputValue() === 'Mid Edit Forager', 'unsaved display name untouched by reconciliation');
    assert(await page.locator('#profileCity').inputValue() === 'Half-Typed City', 'unsaved city field untouched by reconciliation');
    const s = await page.evaluate(() => state);
    assert(s.fundMonth === '2026-09' && s.balance === 2000, 'the fund still genuinely replenished in the background');
    assert(s.orders[0].status === 'Delivered', 'the order still genuinely progressed in the background');
  });

  await record('Foreground reconciliation does nothing to the DOM at all when nothing has changed', async () => {
    await freshAt(new Date('2026-10-20T09:00:00'), baseState({ balance: 2000, monthlySpent: 0, fundMonth: '2026-10' }));
    await goNav(page, 'orders');
    // A sentinel only survives if #main's innerHTML is never rebuilt. render() always
    // replaces it wholesale, so this proves whether a render actually happened.
    await page.evaluate(() => { const s = document.createElement('div'); s.id = 'no-render-sentinel'; document.getElementById('main').appendChild(s); });
    await sendToBackground(page);
    // No clock change at all - nothing for reconciliation to do.
    await returnToForeground(page);
    await page.waitForTimeout(80);
    assert(await page.locator('#no-render-sentinel').count() === 1, 'the sentinel survives: no unnecessary render() ran when reconciliation found nothing to change');
  });

  await record('Reconciliation is idempotent: calling it twice back-to-back with no time elapsed changes nothing the second time', async () => {
    await freshAt(new Date('2026-08-15T09:00:00'), baseState({ balance: 2000, monthlySpent: 0, fundMonth: '2026-08' }));
    const first = await page.evaluate(() => reconcileTimeState());
    const second = await page.evaluate(() => reconcileTimeState());
    assert(first === false, 'nothing to reconcile immediately after a fresh, already-consistent load');
    assert(second === false, 'a repeated call is a true no-op');
  });

  await record('A window focus event also triggers reconciliation (desktop app-switch path, alongside visibilitychange)', async () => {
    const placed = new Date('2026-09-01T09:00:00');
    const order = { id: 'FG-FOCUS', items: [], total: 10, placed: placed.toISOString(), delivery: 'x', deliveryAt: new Date('2026-09-04T09:00:00').toISOString(), status: 'Processing', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    await freshAt(new Date('2026-09-02T09:00:00'), baseState({ orders: [order] }));
    await page.clock.setFixedTime(new Date('2026-09-10T09:00:00'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await goNav(page, 'orders');
    const text = (await page.locator('.order .eyebrow').first().innerText()).toLowerCase();
    assert(text.includes('delivered'), 'a window focus event alone is enough to reconcile and show the updated status');
  });

  await record('Leap year day math resolves correctly across a February 29th', async () => {
    const placed = new Date('2028-02-27T09:00:00'); // 2028 is a leap year
    const order = { id: 'FG-LEAP', items: [], total: 10, placed: placed.toISOString(), delivery: 'x', deliveryAt: new Date('2028-03-01T09:00:00').toISOString(), status: 'Processing', shippingAddress: {}, gift: false, giftMessage: '', paymentId: 'pm1' };
    await freshAt(new Date('2028-02-28T09:00:00'), baseState({ orders: [order] }));
    await goNav(page, 'orders');
    assert((await page.locator('.order .eyebrow').first().innerText()).toLowerCase().includes('shipped'), 'day 1 of 3 (Feb 28) reads Shipped, counting correctly toward the leap day');
    await page.clock.setFixedTime(new Date('2028-02-29T09:00:00'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(80);
    assert((await page.locator('.order .eyebrow').first().innerText()).toLowerCase().includes('out for delivery'), 'Feb 29th itself is counted as a real elapsed day, advancing status correctly');
    await page.clock.setFixedTime(new Date('2028-03-01T09:00:00'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(80);
    assert((await page.locator('.order .eyebrow').first().innerText()).toLowerCase().includes('delivered'), 'March 1st after the leap day resolves to Delivered on schedule');
  });

  await browser.close();
  server.close();

  console.log('\n=== TIME RECONCILIATION SUITE SUMMARY ===');
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
