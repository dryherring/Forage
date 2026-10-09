// Regression coverage for Forage Friend V1 ("Just Wandering"): the lightweight
// discovery guide. Covers mode/candidate selection honesty (no fabricated
// history, excludes invalid/unavailable catalog entries), repeat avoidance
// within a session, graceful behavior when candidates run out, opening a
// suggestion via existing item-detail functionality, dismissal preserving
// browsing context, keyboard interaction, and mobile layout.
//
// Run with: node tests/forage-friend.js (or via `npm test`)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8986;
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

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  async function fresh() {
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
  }
  async function openFriendUI() {
    await page.click('#friendToggle');
    await page.waitForTimeout(100);
  }
  async function startWanderUI() {
    await page.click('[data-action="friend-start-wander"]');
    await page.waitForSelector('.friend-card');
  }

  await record('Friend panel is hidden by default; opening shows the intro line and updates aria-expanded', async () => {
    await fresh();
    const panel = page.locator('#friendPanel');
    assert(await panel.getAttribute('hidden') !== null, 'panel starts hidden');
    const toggle = page.locator('#friendToggle');
    assert((await toggle.getAttribute('aria-expanded')) === 'false', 'aria-expanded starts false');
    await openFriendUI();
    assert(await panel.getAttribute('hidden') === null, 'panel visible after click');
    assert((await toggle.getAttribute('aria-expanded')) === 'true', 'aria-expanded becomes true');
    const intro = (await panel.locator('.friend-intro-line').textContent()).trim();
    assert(intro === 'Oh, lovely. No particular destination, then.', `shows the approved opening line (got "${intro}")`);
    assert(await page.locator('[data-action="friend-start-wander"]').count() === 1, '"I\'m just wandering" option is offered');
  });

  await record('Starting a wander shows a real catalog item with a truthful, non-generic observation', async () => {
    await fresh();
    await openFriendUI();
    await startWanderUI();
    const name = (await page.locator('.friend-card strong').textContent()).trim();
    const cat = (await page.locator('.friend-eyebrow').textContent()).trim();
    const note = (await page.locator('.friend-note').textContent()).trim();
    const matches = await page.evaluate(({ name, cat }) => PRODUCTS.some(p => p.name === name && (p.cat === cat || (p.realBook && cat === 'Books'))), { name, cat });
    assert(matches, `suggested item "${name}" (${cat}) is a real catalog product`);
    assert(note.length > 0, 'an observation accompanies the suggestion');
    assert(await page.locator('[data-action="friend-open-suggestion"]').count() === 1, 'offers to open the item');
    assert(await page.locator('[data-action="friend-next"]').count() === 1, 'offers another discovery');
    assert(await page.locator('[data-action="friend-dismiss"]').count() === 1, 'offers to dismiss Friend');
  });

  await record('Repeated "show me another" never suggests the same item twice in one session', async () => {
    await fresh();
    await openFriendUI();
    await startWanderUI();
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      const id = await page.evaluate(() => friendCurrent && friendCurrent.product.id);
      assert(id, `iteration ${i} produced a suggestion`);
      assert(!seen.has(id), `item ${id} was not already suggested this session (iteration ${i})`);
      seen.add(id);
      await page.click('[data-action="friend-next"]');
      await page.waitForTimeout(30);
    }
    assert(seen.size === 25, 'collected 25 distinct suggestions with zero repeats');
  });

  await record('Only valid, available catalog entries are ever candidates (missing metadata / unavailable stock excluded)', async () => {
    await fresh();
    const outcome = await page.evaluate(() => {
      const realProducts = PRODUCTS;
      const fakeInvalid = [
        { id: 'fake-no-desc', name: 'No Description', cat: 'Kitchen', price: 10, stock: 5 },
        { id: 'fake-zero-price', name: 'Zero Price', desc: 'x', cat: 'Kitchen', price: 0, stock: 5 },
        { id: 'fake-out-of-stock', name: 'Out Of Stock', desc: 'x', cat: 'Kitchen', price: 10, stock: 0 },
        { id: 'fake-no-id', name: 'No Id', desc: 'x', cat: 'Kitchen', price: 10, stock: 5, id: '' },
        { id: null, name: 'Null Id', desc: 'x', cat: 'Kitchen', price: 10, stock: 5 },
      ];
      const onlyOneValid = [realProducts[0], ...fakeInvalid];
      PRODUCTS = onlyOneValid;
      friendSeenIds = new Set();
      const picks = [];
      for (let i = 0; i < 20; i++) {
        friendSeenIds = new Set(); // allow repeats of the single valid item across trials
        const result = pickFriendSuggestion(() => Math.random());
        picks.push(result ? result.product.id : null);
      }
      PRODUCTS = realProducts;
      return picks;
    });
    assert(outcome.every(id => id === outcome[0] && id !== null), `every pick was the sole valid candidate, never a fake/invalid one (got ${JSON.stringify(outcome)})`);
  });

  await record('An empty candidate set (everything already shown) is handled gracefully, not as an error', async () => {
    await fresh();
    await openFriendUI();
    await startWanderUI();
    await page.evaluate(() => {
      friendSeenIds = new Set(PRODUCTS.map(p => p.id));
      friendCurrent = pickFriendSuggestion();
      renderFriendPanel();
    });
    await page.waitForTimeout(50);
    const text = (await page.locator('#friendPanel').innerText());
    assert(/everything/i.test(text) || /for now/i.test(text), `shows a graceful "nothing left" message instead of crashing (got "${text}")`);
    assert(await page.locator('[data-action="friend-next"]').count() === 0, 'does not offer "show me another" when exhausted');
    assert(await page.locator('[data-action="friend-dismiss"]').count() === 1, 'still offers to dismiss when exhausted');
    const pageErrors = [];
    page.once('pageerror', e => pageErrors.push(e));
    assert(pageErrors.length === 0, 'no uncaught page error from the empty-candidate state');
  });

  await record('Weight reallocation: when only the wildcard pool has candidates, selection still succeeds every time', async () => {
    await fresh();
    const allPicksValid = await page.evaluate(() => {
      // No wishlist/cart/orders/filter signal (fresh state, filter='All') and
      // no limited items in a constrained catalog -> adjacent, change-of-
      // scenery, unexpected, and rediscovery pools are all empty; only
      // wildcard remains. Weight reallocation must still pick something.
      const realProducts = PRODUCTS;
      const constrained = realProducts.slice(0, 3).map(p => ({ ...p, limited: false }));
      PRODUCTS = constrained;
      const results = [];
      for (let i = 0; i < 10; i++) {
        friendSeenIds = new Set();
        const r = pickFriendSuggestion(() => Math.random());
        results.push(r && constrained.some(p => p.id === r.product.id));
      }
      PRODUCTS = realProducts;
      return results;
    });
    assert(allPicksValid.every(Boolean), 'every trial produced a valid suggestion despite only one mode having candidates');
  });

  await record('Opening a suggestion uses existing item-detail functionality and closes Friend', async () => {
    await fresh();
    await openFriendUI();
    await startWanderUI();
    const expectedId = await page.evaluate(() => friendCurrent.product.id);
    await page.click('[data-action="friend-open-suggestion"]');
    await page.waitForSelector('.detail');
    const detailId = await page.evaluate(() => selected && selected.id);
    assert(detailId === expectedId, 'the detail page shows the exact item Friend suggested');
    assert(await page.locator('#friendPanel').getAttribute('hidden') !== null, 'Friend panel closes after opening an item');
  });

  await record('Dismissing Friend preserves the visitor\'s existing page, filter, and scroll position', async () => {
    await fresh();
    await page.click('[data-filter="Kitchen"]');
    await page.waitForTimeout(80);
    await page.fill('#searchInput', 'bowl');
    await page.waitForTimeout(80);
    await page.evaluate(() => window.scrollTo(0, 260));
    await page.waitForTimeout(60);
    const before = await page.evaluate(() => ({ page, filter: state.filter, query: state.query, scrollY: window.scrollY }));
    assert(before.scrollY > 0, 'test actually scrolled before opening Friend, so preservation is meaningfully checked');
    await openFriendUI();
    await startWanderUI();
    await page.click('[data-action="friend-dismiss"]');
    await page.waitForTimeout(80);
    const after = await page.evaluate(() => ({ page, filter: state.filter, query: state.query, scrollY: window.scrollY }));
    assert(after.page === before.page, 'current page unchanged after dismissing Friend');
    assert(after.filter === before.filter, 'active category filter unchanged after dismissing Friend');
    assert(after.query === before.query, 'search query unchanged after dismissing Friend');
    assert(after.scrollY === before.scrollY, `scroll position unchanged after dismissing Friend (before ${before.scrollY}, after ${after.scrollY})`);
    assert(await page.locator('#friendPanel').getAttribute('hidden') !== null, 'Friend panel is closed');
    assert(await page.locator('.card').count() > 0, 'the filtered product grid is still showing, untouched');
  });

  await record('Dismissing does NOT end the discovery session: reopening resumes the same suggestion, not the intro', async () => {
    await fresh();
    await openFriendUI();
    await startWanderUI();
    const shownId = await page.evaluate(() => friendCurrent.product.id);
    await page.click('[data-action="friend-dismiss"]');
    await page.waitForTimeout(60);
    await openFriendUI();
    assert(await page.locator('.friend-intro-line').count() === 1, 'a line of Friend copy is showing');
    const intro = (await page.locator('.friend-intro-line').textContent()).trim();
    assert(intro !== 'Oh, lovely. No particular destination, then.', 'reopening after dismissal does NOT show the initial intro');
    assert(await page.locator('.friend-card').count() === 1, 'the same discovery card is still showing');
    const stillShowingId = await page.evaluate(() => friendCurrent.product.id);
    assert(stillShowingId === shownId, `reopening resumes the exact suggestion shown before dismissal (expected ${shownId}, got ${stillShowingId})`);
  });

  await record('Previously suggested items remain excluded across a dismiss/reopen, until explicitly restarted', async () => {
    await fresh();
    await openFriendUI();
    await startWanderUI();
    const seenBeforeDismiss = await page.evaluate(() => [...friendSeenIds]);
    await page.click('[data-action="friend-dismiss"]');
    await page.waitForTimeout(60);
    await openFriendUI();
    await page.click('[data-action="friend-next"]');
    await page.waitForTimeout(40);
    const seenAfterReopenAndNext = await page.evaluate(() => [...friendSeenIds]);
    assert(seenBeforeDismiss.every(id => seenAfterReopenAndNext.includes(id)), 'items suggested before dismissal are still excluded after reopening and asking for another');
    assert(seenAfterReopenAndNext.length === seenBeforeDismiss.length + 1, 'exactly one new item was added to the exclusion set, nothing was cleared');
  });

  await record('"Start a new wander" from the exhausted state explicitly restarts the session (history clears)', async () => {
    await fresh();
    await openFriendUI();
    await startWanderUI();
    await page.evaluate(() => {
      friendSeenIds = new Set(PRODUCTS.map(p => p.id));
      friendCurrent = pickFriendSuggestion();
      renderFriendPanel();
    });
    await page.waitForTimeout(50);
    assert(await page.locator('[data-action="friend-start-wander"]').count() === 1, 'exhausted state offers an explicit restart');
    await page.click('[data-action="friend-dismiss"]');
    await page.waitForTimeout(60);
    await openFriendUI();
    assert(await page.locator('[data-action="friend-start-wander"]').count() === 1, 'reopening after dismissal still shows the exhausted state with its restart option (not reset to intro)');
    await page.click('[data-action="friend-start-wander"]');
    await page.waitForSelector('.friend-card');
    const seenAfterRestart = await page.evaluate(() => [...friendSeenIds]);
    assert(seenAfterRestart.length === 1, `explicit restart clears prior history and starts fresh (got ${seenAfterRestart.length} seen items)`);
  });

  await record('A page reload fully resets the wandering session', async () => {
    await fresh();
    await openFriendUI();
    await startWanderUI();
    await page.click('[data-action="friend-next"]');
    await page.waitForTimeout(40);
    const seenBeforeReload = await page.evaluate(() => friendSeenIds.size);
    assert(seenBeforeReload >= 2, 'session has some discovery history before reload');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.card');
    await openFriendUI();
    const intro = (await page.locator('.friend-intro-line').textContent()).trim();
    assert(intro === 'Oh, lovely. No particular destination, then.', 'after a reload, Friend shows the initial intro again');
    const seenAfterReload = await page.evaluate(() => friendSeenIds.size);
    assert(seenAfterReload === 0, 'discovery history is cleared by a page reload');
  });

  await record('Keyboard: Tab reaches the Friend toggle, Enter opens it, and Escape closes it', async () => {
    await fresh();
    await page.locator('#friendToggle').focus();
    const focused = await page.evaluate(() => document.activeElement.id);
    assert(focused === 'friendToggle', 'Friend toggle is focusable directly');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    assert(await page.locator('#friendPanel').getAttribute('hidden') === null, 'Enter activates the toggle and opens the panel');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    assert(await page.locator('#friendPanel').getAttribute('hidden') !== null, 'Escape closes the open Friend panel');
    assert((await page.locator('#friendToggle').getAttribute('aria-expanded')) === 'false', 'aria-expanded resets to false after Escape');
  });

  await record('Clicking outside Friend closes it without disturbing the Fund popover\'s own behavior', async () => {
    await fresh();
    await openFriendUI();
    await page.click('#balanceBox');
    await page.waitForTimeout(80);
    assert(await page.locator('#friendPanel').getAttribute('hidden') !== null, 'opening Fund elsewhere in the header closes Friend');
    assert(await page.locator('#fundPanel').getAttribute('hidden') === null, 'Fund panel itself opens normally');
    await page.click('.hero');
    await page.waitForTimeout(80);
    assert(await page.locator('#fundPanel').getAttribute('hidden') !== null, 'outside click still closes Fund as before');
  });

  await record('Friend does not interfere with the gift modal\'s own Escape-to-close behavior', async () => {
    await fresh();
    await page.click('[data-action="go"][data-page="shop"]');
    await page.locator('.card').first().click();
    await page.waitForSelector('.detail');
    await page.click('button[data-action="open-gift-modal"]');
    await page.waitForSelector('.modalback');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    assert(await page.locator('.modalback').count() === 0, 'Escape still closes the gift modal as before');
  });

  await record('Mobile viewport: Friend opens, fits on screen without horizontal overflow, and works end to end', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fresh();
    await openFriendUI();
    const panelBox = await page.locator('#friendPanel').boundingBox();
    assert(panelBox.x >= 0 && panelBox.x + panelBox.width <= 390 + 1, `Friend panel fits within the 390px mobile viewport (got x=${panelBox.x}, width=${panelBox.width})`);
    await startWanderUI();
    assert(await page.locator('.friend-card').count() === 1, 'a suggestion renders correctly at mobile width');
    const panelBox2 = await page.locator('#friendPanel').boundingBox();
    assert(panelBox2.x >= 0 && panelBox2.x + panelBox2.width <= 390 + 1, 'panel still fits after showing a discovery card');
    await page.click('[data-action="friend-dismiss"]');
    await page.waitForTimeout(60);
    assert(await page.locator('#friendPanel').getAttribute('hidden') !== null, 'dismissal works at mobile width');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await record('Short/realistic mobile viewport: the panel never runs off-screen and stays reachable', async () => {
    // A full 844px-tall viewport (the previous mobile test) never reproduces
    // this bug: it only shows up once the VISIBLE viewport is short, as on a
    // real phone with Safari's dynamic toolbar expanded, a smaller device,
    // or landscape orientation. 390x300 reliably forces the panel's natural
    // content height past the available space below the header.
    await page.setViewportSize({ width: 390, height: 300 });
    await fresh();
    await openFriendUI();
    await startWanderUI();
    await page.waitForTimeout(100);
    const viewportHeight = 300;
    const panelBox = await page.locator('#friendPanel').boundingBox();
    assert(panelBox.y + panelBox.height <= viewportHeight + 1, `panel bottom edge stays within the ${viewportHeight}px viewport (got bottom=${panelBox.y + panelBox.height})`);
    const isScrollable = await page.locator('#friendPanel').evaluate(el => el.scrollHeight > el.clientHeight);
    assert(isScrollable, 'panel content exceeds its capped height, so it is internally scrollable (not just clipped)');
    const lastButton = page.locator('.friend-actions button').last();
    await lastButton.scrollIntoViewIfNeeded();
    const buttonBox = await lastButton.boundingBox();
    assert(buttonBox.y >= 0 && buttonBox.y + buttonBox.height <= viewportHeight + 1, 'the last action button is reachable within the viewport after scrolling inside the panel');
    await lastButton.click();
    await page.waitForTimeout(60);
    assert(await page.locator('#friendPanel').getAttribute('hidden') !== null, 'the (scrolled-to) dismiss button is actually clickable, not just visible');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await record('The panel re-caps itself when the visible viewport shrinks while it is already open (Safari toolbar / keyboard)', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await fresh();
    await openFriendUI();
    await startWanderUI();
    await page.waitForTimeout(100);
    const tallMaxHeight = await page.locator('#friendPanel').evaluate(el => parseFloat(el.style.maxHeight));
    // Simulate Safari's toolbar expanding (or the keyboard opening), which
    // shrinks window.innerHeight/visualViewport.height without a page
    // navigation - the exact scenario a fixed-viewport test would miss.
    await page.setViewportSize({ width: 390, height: 320 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(100);
    const shortMaxHeight = await page.locator('#friendPanel').evaluate(el => parseFloat(el.style.maxHeight));
    assert(shortMaxHeight < tallMaxHeight, `panel's max-height shrinks when the visible viewport shrinks while open (tall=${tallMaxHeight}, short=${shortMaxHeight})`);
    const panelBox = await page.locator('#friendPanel').boundingBox();
    assert(panelBox.y + panelBox.height <= 320 + 1, 'panel stays within the new, shorter viewport after re-capping');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await browser.close();
  server.close();

  console.log('\n=== FORAGE FRIEND SUITE SUMMARY ===');
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
