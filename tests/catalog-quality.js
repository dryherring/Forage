// Data-quality regression coverage for issue #15 (catalog copy coherence).
//
// These checks are deliberately structural, not a snapshot of any specific
// sentence: future copy editing should stay possible without breaking this
// suite. What they guard against is the actual failure mode issue #15 fixed —
// a small pool of generic, category-level paragraphs getting reused across
// genuinely different product types (or even across categories), and a small
// set of formulaic ecommerce phrasings creeping back in.
//
// Run with: node tests/catalog-quality.js  (or via `npm test`)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const catalogMd = fs.readFileSync(path.join(ROOT, 'CATALOG.md'), 'utf8');

const results = [];
function record(name, fn) {
  try { fn(); results.push({ name, pass: true }); console.log('  PASS:', name); }
  catch (err) { results.push({ name, pass: false, error: err.message }); console.log('  FAIL:', name, '-', err.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Same name -> product-type derivation used to assign issue #15's descriptions:
// strip a trailing " {Color} {digit}" variant suffix (e.g. "... Fog 2").
function baseName(name) { return name.replace(/\s+[A-Z][a-z]+\s\d+$/, '').trim(); }

const TEMPLATE_CATEGORIES = ['Pottery', 'Craft', 'Korea', 'Music', 'Style', 'Home', 'Kitchen', 'Travel', 'Adventure', 'Cats', 'Stationery & Paper'];

// --- No empty or malformed descriptions -------------------------------------
record('Every product has a non-empty, substantive description', () => {
  const bad = catalog.filter(p => !p.desc || typeof p.desc !== 'string' || p.desc.trim().length < 10);
  assert(bad.length === 0, `${bad.length} product(s) with empty/too-short desc: ${bad.slice(0, 5).map(p => p.id).join(', ')}`);
});

record('No description contains leftover template/placeholder artifacts', () => {
  const badArtifacts = /\{\{|\}\}|TODO|Lorem ipsum|\bXXX\b|undefined|\[object Object\]/;
  const bad = catalog.filter(p => badArtifacts.test(p.desc));
  assert(bad.length === 0, `${bad.length} product(s) with placeholder artifacts: ${bad.slice(0, 5).map(p => p.id).join(', ')}`);
});

// --- No formulaic ecommerce phrasing (the pattern #15 was written against) --
record('No description uses formulaic ecommerce phrasing', () => {
  const badPhrases = [
    /Designed for [^.]+ who value/i,
    /\bPerfect for\b/i,
    /\bIdeal for\b/i,
    /Whether you.?re/i,
    /Elevate your/i,
    /This version pairs [^.]+ with [^.]+ finish/i,
    /There are \d+ variants to compare before choosing/i,
    /This is a small batch, so it may disappear from the market/i,
    /It comes in \d+ size options?/i,
  ];
  const offenders = [];
  catalog.forEach(p => { badPhrases.forEach(re => { if (re.test(p.desc)) offenders.push(`${p.id} matched ${re}`); }); });
  assert(offenders.length === 0, `formulaic phrasing found: ${offenders.slice(0, 5).join(' | ')}`);
});

// --- No description text shared across different categories -----------------
// A single paragraph describing products in two different categories is the
// clearest sign of a generic, not-actually-specific-to-this-product blurb.
record('No non-book description is reused across more than one category', () => {
  const nonBooks = catalog.filter(p => !p.realBook);
  const byDesc = new Map();
  nonBooks.forEach(p => { if (!byDesc.has(p.desc)) byDesc.set(p.desc, new Set()); byDesc.get(p.desc).add(p.cat); });
  const crossCategory = [...byDesc.entries()].filter(([, cats]) => cats.size > 1);
  assert(crossCategory.length === 0,
    `${crossCategory.length} description(s) shared across categories: ${crossCategory.slice(0, 3).map(([d, cats]) => `"${d.slice(0, 40)}..." in [${[...cats].join(', ')}]`).join(' | ')}`);
});

// --- Same product type -> same description, consistently -------------------
// Within the 11 categories built from (flavor-prefix x product-type)
// combinations, every product sharing the same real-world type (e.g. every
// "Ramen Pot" regardless of its flavor prefix or color) should carry the same
// description. Color/variant siblings and flavor-prefix siblings of one type
// are allowed to share text (that's the same product); this catches the type
// getting split across two inconsistent descriptions, or a type accidentally
// drifting from its siblings during a future edit.
record('Products of the same real-world type share one consistent description', () => {
  const inconsistent = [];
  TEMPLATE_CATEGORIES.forEach(catName => {
    const items = catalog.filter(p => p.cat === catName && !p.realBook);
    const byBase = new Map();
    items.forEach(p => {
      // Group by base name with the flavor-prefix left in; we only need to
      // detect *within-type* drift, so group by the description-bearing
      // suffix using the longest common suffix among items is overkill here —
      // instead, rely on: any two items whose base names end with the same
      // last 2+ words should match. We approximate "type" as the base name
      // with the first word stripped, which holds for every prefix pattern
      // used in this catalog (single-word or multi-word prefixes both leave
      // the type as a stable multi-word tail).
      const base = baseName(p.name);
      const words = base.split(' ');
      // try suffixes of length 2..4 words as candidate type keys, and bucket
      // by the LONGEST suffix that at least one other item also has.
      byBase.set(p.id, { p, words });
    });
    const all = [...byBase.values()];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        for (let len = 2; len <= Math.min(a.words.length, b.words.length, 4); len++) {
          const aSuffix = a.words.slice(-len).join(' ');
          const bSuffix = b.words.slice(-len).join(' ');
          if (aSuffix === bSuffix && a.p.desc !== b.p.desc) {
            inconsistent.push(`${catName}: "${a.p.name}" (${a.p.id}) vs "${b.p.name}" (${b.p.id}) share type suffix "${aSuffix}" but differ in description`);
          }
        }
      }
    }
  });
  assert(inconsistent.length === 0, `inconsistent same-type descriptions: ${inconsistent.slice(0, 5).join(' | ')}`);
});

// --- catalog.json / CATALOG.md drift -----------------------------------------
record('CATALOG.md descriptions match catalog.json for every p#### product', () => {
  const drift = [];
  catalog.filter(p => /^p\d{4}$/.test(p.id)).forEach(p => {
    const anchorIdx = catalogMd.indexOf('`' + p.id + '`');
    if (anchorIdx === -1) { drift.push(`${p.id}: not found in CATALOG.md`); return; }
    const afterAnchor = catalogMd.slice(anchorIdx);
    const lines = afterAnchor.split('\n');
    // line 0 is the `pXXXX` metadata line itself; line 1 is the description line.
    const descLine = (lines[1] || '').replace(/ {2}$/, '');
    if (descLine !== p.desc) drift.push(`${p.id}: CATALOG.md desc does not match catalog.json`);
  });
  assert(drift.length === 0, `${drift.length} drifted description(s): ${drift.slice(0, 5).join(' | ')}`);
});

// --- Moto: no fabricated safety/certification claims ------------------------
record('Moto descriptions do not claim specific safety certifications or ratings', () => {
  const badClaims = [/\bCE[\s-]?(rated|certified|approved)\b/i, /\bIPX?\d/i, /\bISO\s?\d/i, /\bmil-?spec\b/i, /certified\s+(water|impact|abrasion)proof/i, /\brating of \d/i, /\bANSI\b/i, /\bASTM\b/i];
  const moto = catalog.filter(p => p.cat === 'Moto');
  const offenders = [];
  moto.forEach(p => badClaims.forEach(re => { if (re.test(p.desc)) offenders.push(`${p.id} matched ${re}`); }));
  assert(offenders.length === 0, `fabricated certification language found: ${offenders.join(' | ')}`);
});

// --- Real books: description untouched by this pass, still book-specific ----
record('Real book descriptions remain present and are not generic templates', () => {
  const books = catalog.filter(p => p.realBook);
  assert(books.length > 0, 'catalog has real books');
  const badPhrases = [/This version pairs/i, /Designed for [^.]+ who value/i, /\bPerfect for\b/i];
  const offenders = books.filter(p => badPhrases.some(re => re.test(p.desc)));
  assert(offenders.length === 0, `real book(s) with templated desc: ${offenders.map(p => p.id).join(', ')}`);
});

console.log('\n=== CATALOG QUALITY SUITE SUMMARY ===');
const failed = results.filter(r => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\n=== FAILURES ===');
  failed.forEach(f => console.log(` - ${f.name}\n   ${f.error}`));
  process.exitCode = 1;
} else {
  console.log('\nALL TESTS PASSED');
}
