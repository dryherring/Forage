// Regression coverage for the Gift Cabinet lifecycle (issue #8) and its
// follow-up acceptance-testing fixes: the lightweight gift-capture modal
// (recipient/occasion/note, all optional), editing metadata later, changing
// status, persistence across navigation and reload, removal, tolerance of
// legacy/malformed Gift Cabinet state, and keyboard navigation (Tab/Escape)
// through both the capture modal and the Gift Cabinet edit form.
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
  async function openProductDetail(cardIndex = 0) {
    await goNav(page, 'shop');
    await page.click('[data-filter="All"]');
    await page.waitForTimeout(80);
    await page.locator('.card').nth(cardIndex).click();
    await page.waitForSelector('.detail');
    return (await page.locator('.detail h1').textContent()).trim();
  }
  async function openGiftModalFromDetail() {
    await page.click('button[data-action="open-gift-modal"]');
    await page.waitForSelector('#giftModal');
  }
  async function saveGiftModal() {
    await page.click('#giftModal button[data-action="confirm-gift-modal"]');
    await page.waitForTimeout(100);
  }
  async function cancelGiftModal() {
    await page.click('#giftModal button[data-action="close-gift-modal"]');
    await page.waitForTimeout(100);
  }
  async function saveFirstProductToGifts(meta) {
    const name = await openProductDetail();
    await openGiftModalFromDetail();
    if (meta?.person) await page.fill('#giftModalRecipient', meta.person);
    if (meta?.occasion) await page.fill('#giftModalOccasion', meta.occasion);
    if (meta?.note) await page.fill('#giftModalNote', meta.note);
    await saveGiftModal();
    return name;
  }

  await fresh();

  // --- Opening the capture modal ------------------------------------------------
  await record('Clicking Gift idea opens a modal with empty, optional Recipient/Occasion/Note fields', async () => {
    let dialogFired = false;
    page.once('dialog', d => { dialogFired = true; d.dismiss(); });
    await openProductDetail();
    await openGiftModalFromDetail();
    assert(!dialogFired, 'no native prompt() dialog appears');
    assert(await page.locator('#giftModal input#giftModalRecipient').count() === 1, 'Recipient field present');
    assert(await page.locator('#giftModal input#giftModalOccasion').count() === 1, 'Occasion field present');
    assert(await page.locator('#giftModal textarea#giftModalNote').count() === 1, 'Note field present');
    assert((await page.locator('#giftModalRecipient').inputValue()) === '', 'Recipient starts empty');
    assert((await page.locator('#giftModalOccasion').inputValue()) === '', 'Occasion starts empty');
    assert((await page.locator('#giftModalNote').inputValue()) === '', 'Note starts empty');
    assert(await page.locator('#giftModal button[data-action="close-gift-modal"]').count() === 1, 'Cancel action present');
    assert(await page.locator('#giftModal button[data-action="confirm-gift-modal"]').count() === 1, 'Save action present');
    const giftCount = await page.evaluate(() => JSON.parse(localStorage.getItem('forageV2State') || '{}').giftIdeas?.length || 0);
    assert(giftCount === 0, 'Gift Cabinet has nothing saved yet, before confirming');
    await cancelGiftModal();
  });

  // --- Cancel ---------------------------------------------------------------------
  await record('Cancel closes the modal, creates nothing, and returns focus to the Gift idea button', async () => {
    await openProductDetail();
    await openGiftModalFromDetail();
    await page.fill('#giftModalRecipient', 'Should be discarded');
    await cancelGiftModal();
    assert(await page.locator('#giftModal').count() === 0, 'modal is closed');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-action'));
    assert(focused === 'open-gift-modal', `focus returns to the Gift idea button (got data-action="${focused}")`);
    await goNav(page, 'gifts');
    assert(await page.locator('.empty').count() === 1, 'Cancel created no Gift Cabinet item');
  });

  // --- Save with everything empty ---------------------------------------------------
  await record('Saving with all fields empty creates an item with no metadata', async () => {
    const name = await saveFirstProductToGifts();
    assert(await page.locator('#giftModal').count() === 0, 'modal closes after saving');
    await goNav(page, 'gifts');
    assert(await page.locator('.cartline').count() === 1, 'Gift Cabinet shows the saved item');
    const title = (await page.locator('.cartline strong').first().textContent()).trim();
    assert(title === name, `saved item shows the right product name (expected "${name}", got "${title}")`);
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('No details yet'), `friendly placeholder shown for no metadata (got "${eyebrow}")`);
  });

  // --- Save with recipient only ------------------------------------------------------
  await record('Saving with only a recipient filled captures just that field', async () => {
    await fresh();
    await saveFirstProductToGifts({ person: 'Alex' });
    await goNav(page, 'gifts');
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('For Alex'), `summary shows the recipient (got "${eyebrow}")`);
    assert(await page.locator('.cartline p').count() === 0, 'no note preview when no note was given');
  });

  // --- Save with all three fields -----------------------------------------------------
  await record('Saving with recipient, occasion, and note captures all three', async () => {
    await fresh();
    await saveFirstProductToGifts({ person: 'Alex', occasion: 'Birthday', note: 'She mentioned wanting one.' });
    await goNav(page, 'gifts');
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('For Alex') && eyebrow.includes('Birthday'), `summary shows recipient and occasion (got "${eyebrow}")`);
    const note = (await page.locator('.cartline p').first().textContent());
    assert(note.includes('mentioned wanting'), `note preview shows the saved note (got "${note}")`);
  });

  // --- Duplicate behavior ------------------------------------------------------------
  await record('Opening Gift idea again for an already-saved product skips the modal and behaves sensibly', async () => {
    await openProductDetail();
    await page.click('button[data-action="open-gift-modal"]');
    await page.waitForTimeout(150);
    assert(await page.locator('#giftModal').count() === 0, 'no modal opens for a product already in the Gift Cabinet');
    assert((await page.locator('.toast').textContent()).includes('Already in Gift Cabinet'), 'a toast explains why nothing happened');
    await goNav(page, 'gifts');
    assert(await page.locator('.cartline').count() === 1, 'still exactly one entry, no duplicate created');
  });

  // --- Metadata remains editable afterward --------------------------------------------
  await record('Metadata captured at save time remains editable afterward in the Gift Cabinet', async () => {
    await goNav(page, 'gifts');
    await page.click('button[data-action="gift-edit-toggle"]');
    await page.waitForTimeout(80);
    assert((await page.locator('input[data-action="gift-recipient"]').inputValue()) === 'Alex', 'recipient field is pre-filled with the captured value');
    assert((await page.locator('input[data-action="gift-occasion"]').inputValue()) === 'Birthday', 'occasion field is pre-filled with the captured value');
    await page.fill('input[data-action="gift-recipient"]', 'Sam');
    await page.locator('input[data-action="gift-recipient"]').blur();
    await page.waitForTimeout(100);
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('Sam') && !eyebrow.includes('Alex'), `edited recipient replaces the captured one (got "${eyebrow}")`);
  });

  // --- Status lifecycle ----------------------------------------------------------------
  await record('Gift status offers the simplified Idea/Purchased/Given lifecycle and can be changed', async () => {
    const options = await page.locator('select[data-action="gift-status"]').first().locator('option').allTextContents();
    assert(JSON.stringify(options) === JSON.stringify(['Idea', 'Purchased', 'Given']), `status options are Idea/Purchased/Given (got ${JSON.stringify(options)})`);
    await page.selectOption('select[data-action="gift-status"]', 'Purchased');
    await page.waitForTimeout(100);
    assert((await page.locator('select[data-action="gift-status"]').first().inputValue()) === 'Purchased', 'status updated to Purchased');
  });

  await record('Marking a gift Given keeps it in the Gift Cabinet (no auto-delete) and visually de-emphasizes it', async () => {
    await page.selectOption('select[data-action="gift-status"]', 'Given');
    await page.waitForTimeout(100);
    assert(await page.locator('.cartline').count() === 1, 'the given gift is still present, not deleted');
    const opacity = await page.locator('.cartline').first().evaluate(el => getComputedStyle(el).opacity);
    assert(parseFloat(opacity) < 1, `a Given gift is visually de-emphasized (opacity was ${opacity})`);
  });

  // --- Persistence across navigation and reload -----------------------------------------
  await record('Metadata and status persist after navigating away and back', async () => {
    await goNav(page, 'wishlist');
    await goNav(page, 'gifts');
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('Sam') && eyebrow.includes('Birthday'), 'recipient/occasion survive navigating away and back');
    assert((await page.locator('select[data-action="gift-status"]').first().inputValue()) === 'Given', 'status survives navigating away and back');
  });

  await record('Metadata and status persist after a full page reload', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.hero');
    await goNav(page, 'gifts');
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('Sam') && eyebrow.includes('Birthday'), 'recipient/occasion survive a reload');
    assert((await page.locator('select[data-action="gift-status"]').first().inputValue()) === 'Given', 'status survives a reload');
    const note = (await page.locator('.cartline p').first().textContent());
    assert(note.includes('mentioned wanting'), 'note survives a reload');
  });

  // --- Remove and empty state -----------------------------------------------------------
  await record('Removing the item empties the Gift Cabinet with the correct empty state', async () => {
    await page.click('.cartline button.danger');
    await page.waitForTimeout(100);
    assert(await page.locator('.empty:has-text("No gift ideas yet.")').count() === 1, 'empty message shown after removing the only item');
    await goNav(page, 'wishlist');
    await goNav(page, 'gifts');
    assert(await page.locator('.empty:has-text("No gift ideas yet.")').count() === 1, 'empty state persists after navigating away and back');
  });

  // --- Keyboard: Tab through the capture modal -------------------------------------------
  await record('Tab moves Recipient -> Occasion -> Note -> Cancel -> Save inside the capture modal, and wraps (focus trap)', async () => {
    await openProductDetail();
    await openGiftModalFromDetail();
    await page.locator('#giftModalRecipient').focus();
    const seq = [];
    for (let i = 0; i < 5; i++) {
      seq.push(await page.evaluate(() => {
        const el = document.activeElement;
        return el.id || el.getAttribute('data-action') || el.tagName;
      }));
      await page.keyboard.press('Tab');
    }
    assert(JSON.stringify(seq) === JSON.stringify(['giftModalRecipient', 'giftModalOccasion', 'giftModalNote', 'close-gift-modal', 'confirm-gift-modal']),
      `Tab order is Recipient -> Occasion -> Note -> Cancel -> Save (got ${JSON.stringify(seq)})`);
    const afterLast = await page.evaluate(() => document.activeElement.id || document.activeElement.getAttribute('data-action'));
    assert(afterLast === 'giftModalRecipient', `Tab from the last control wraps back to Recipient, trapped inside the modal (got "${afterLast}")`);
    await cancelGiftModal();
  });

  await record('Shift+Tab from the first field in the capture modal wraps to the last control', async () => {
    await openProductDetail();
    await openGiftModalFromDetail();
    await page.locator('#giftModalRecipient').focus();
    await page.keyboard.press('Shift+Tab');
    const el = await page.evaluate(() => document.activeElement.getAttribute('data-action'));
    assert(el === 'confirm-gift-modal', `Shift+Tab from Recipient wraps to Save (got "${el}")`);
    await cancelGiftModal();
  });

  // --- Keyboard: Escape closes the capture modal -------------------------------------------
  await record('Escape closes the capture modal, creates nothing, and returns focus sensibly', async () => {
    await fresh();
    await openProductDetail();
    await openGiftModalFromDetail();
    await page.fill('#giftModalRecipient', 'Should be discarded');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert(await page.locator('#giftModal').count() === 0, 'Escape closes the modal');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-action'));
    assert(focused === 'open-gift-modal', `focus returns to the Gift idea button (got data-action="${focused}")`);
    await goNav(page, 'gifts');
    assert(await page.locator('.empty').count() === 1, 'Escape created no Gift Cabinet item');
  });

  // --- THE REGRESSION TEST: Tab through the Gift Cabinet edit form -------------------------
  await record('Tab moves through the Gift Cabinet edit form fields without jumping to page navigation (regression for the Tab bug)', async () => {
    await fresh();
    await saveFirstProductToGifts({ person: 'Alex', occasion: 'Birthday', note: 'A note' });
    await goNav(page, 'gifts');
    await page.click('button[data-action="gift-edit-toggle"]');
    await page.waitForTimeout(80);
    await page.locator('input[data-action="gift-recipient"]').focus();
    await page.keyboard.type('Jordan');
    // Exactly 4 real form controls follow Recipient in this single-item fixture
    // (Occasion, Note, Status, Remove); a 5th Tab press runs off the end of the
    // document, which is normal browser behavior unrelated to the bug, so it's
    // intentionally not probed here.
    const stops = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (el === document.body) return 'BODY';
        return el.getAttribute('data-action') || el.tagName;
      }));
    }
    assert(!stops.includes('BODY'), `focus never falls back to <body> mid-sequence (got ${JSON.stringify(stops)})`);
    assert(!stops.includes('go'), `Tab never lands on a nav pill while moving through the edit form (got ${JSON.stringify(stops)})`);
    assert(JSON.stringify(stops) === JSON.stringify(['gift-occasion', 'gift-note', 'gift-status', 'remove-gift']),
      `Tab order is Occasion -> Note -> Status -> Remove (got ${JSON.stringify(stops)})`);
    // the recipient edit committed correctly despite no full re-render on change
    const eyebrow = (await page.locator('.cartline .eyebrow').first().textContent());
    assert(eyebrow.includes('Jordan'), `the typed recipient was actually saved (got "${eyebrow}")`);
    assert(page.url() && (await page.locator('h2:has-text("Gift Cabinet")').count()) === 1, 'still on the Gift Cabinet page after tabbing through the form');
  });

  // --- XSS safety on the new free-text fields -----------------------------------------
  await record('Recipient/occasion/note fields render injected markup as inert text', async () => {
    await fresh();
    let xssFired = false;
    await page.exposeFunction('__giftXssMarker', () => { xssFired = true; });
    const payload = `"><img src=x onerror="window.__giftXssMarker()">`;
    await saveFirstProductToGifts({ person: payload, occasion: payload, note: payload });
    await goNav(page, 'gifts');
    assert(!xssFired, 'no injected script executed from recipient/occasion/note captured via the modal');
    let html = await page.locator('.cartline').first().innerHTML();
    assert(!/<img[^>]*onerror=/i.test(html), 'no live <img onerror> tag exists after saving via the modal');
    // also re-verify editing the fields afterward stays safe
    await page.click('button[data-action="gift-edit-toggle"]');
    await page.waitForTimeout(80);
    await page.fill('input[data-action="gift-recipient"]', payload);
    await page.locator('input[data-action="gift-recipient"]').blur();
    await page.waitForTimeout(100);
    assert(!xssFired, 'no injected script executed from editing recipient afterward');
    html = await page.locator('.cartline').first().innerHTML();
    assert(!/<img[^>]*onerror=/i.test(html), 'no live <img onerror> tag exists after editing');
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
