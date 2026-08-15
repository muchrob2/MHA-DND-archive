#!/usr/bin/env node
// Regression check for the shop's money handling (shop.js) and the catalogue
// it sells from (CAMPAIGN/shop-catalog.json). Run with either engine (same
// dual-runtime shim as the other verify scripts — no test runner here):
//
//   node scripts/verify-shop-purchases.js
//   osascript -l JavaScript scripts/verify-shop-purchases.js
//
// Why this exists: this is the only code in the project that destroys player
// resources. A grant that misfires is annoying and obvious; a purchase that
// miscounts a six-denomination purse is quiet and unfair, and by the time
// anyone notices, the session has moved on. Three things are load-bearing:
//
//   1. Conservation. Value leaving the purse must equal the price paid —
//      exactly, including when change is made by breaking a larger coin.
//   2. Refusal. An unaffordable purchase must deduct NOTHING. A partial
//      deduction that then throws would bill a player for an item they
//      never received.
//   3. Catalogue integrity. A part entry whose partKey does not match the
//      Inventory tab's counters would take the money and credit a counter
//      nothing renders — the same silent class of bug verify-inventory-
//      grants.js guards on the admin side, so the key check is repeated
//      here against the catalogue file.

const fs = typeof require === 'function' ? require('fs') : null;
const path = typeof require === 'function' ? require('path') : null;

function readFile(p) {
  if (fs) return fs.readFileSync(p, 'utf8');
  const url = $.NSURL.fileURLWithPath(p);
  return ObjC.unwrap($.NSString.stringWithContentsOfURLEncodingError(url, $.NSUTF8StringEncoding, null));
}
if (!fs) ObjC.import('Foundation');

const repoRoot = path ? path.join(__dirname, '..') : '.';
const join = (...p) => (path ? path.join(repoRoot, ...p) : p.join('/'));

const shopSrc = readFile(join('shop.js'));
const catalog = JSON.parse(readFile(join('CAMPAIGN', 'shop-catalog.json')));
const toolkitSrc = readFile(join('CLASS-1A', 'relationships.js'));

// ── Browser / Firebase stubs ────────────────────────────────────────────────
function mkEl(id) {
  return { id, className: '', textContent: '', disabled: false, readOnly: false, title: '',
           value: '', style: {}, innerHTML: '', tagName: 'DIV', dataset: {},
           classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
           closest() { return null; },
           querySelector() { return null; }, querySelectorAll() { return []; },
           addEventListener() {}, prepend() {} };
}
var els = {};
var document = {
  getElementById(id) { return (els[id] = els[id] || mkEl(id)); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener() {},
  createElement() { return mkEl('tmp'); },
};
var window = { addEventListener() {} };
var setTimeout = function () { return 0; };
var setInterval = function () { return 0; };
// The page's init IIFE awaits fetch; a never-settling promise parks it so the
// module-level functions are defined without the loader running.
var fetch = function () { return new Promise(function () {}); };
var fbAuthReady = new Promise(function () {});
var _dbStub = { collection() { return { doc() { return { get() { return new Promise(function () {}); },
                                                        onSnapshot() {} }; } }; },
                runTransaction() { return new Promise(function () {}); } };
var firebase = { firestore: function () { return _dbStub; } };
var console_ = typeof console !== 'undefined' ? console : { error() {} };

var results = [];
function check(name, ok) { results.push([name, ok]); }

var shared = {};

const shopTests = `
// ── Totalling a mixed purse ────────────────────────────────────────────────
(function () {
  check('an empty purse totals zero', walletTotalYen({}) === 0);
  check('a missing purse totals zero', walletTotalYen(undefined) === 0);
  // 1pp=10,000 · 1gp=1,000 · 1ep=500 · 1sp=100 · 1cp=10
  check('every denomination is counted at the handbook rate',
        walletTotalYen({ yen: 5, pp: 1, gp: 1, ep: 1, sp: 1, cp: 1 }) === 11615);
})();

// ── Conservation: value out always equals price paid ──────────────────────
(function () {
  // Plain Yen, no coins involved.
  let purse = { yen: 10000, pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  check('a cash purchase deducts exactly', spendFromWallet(purse, 3500) && purse.yen === 6500);

  // Spending the purse to precisely empty must work, not round off.
  purse = { yen: 250, cp: 5 };
  check('a purse can be spent to exactly zero', spendFromWallet(purse, 300));
  check('an exactly-spent purse is empty', walletTotalYen(purse) === 0);

  // The interesting case: no loose Yen, so a coin has to be broken and the
  // change handed back.
  purse = { yen: 0, pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 };
  const before = walletTotalYen(purse);
  check('a big coin is broken when nothing smaller covers the cost',
        spendFromWallet(purse, 500));
  check('breaking a coin conserves value exactly',
        walletTotalYen(purse) === before - 500);
  check('the change comes back as Yen', purse.yen === 9500 && purse.pp === 0);

  // Whole coins that fit are spent before anything is broken, so the purse
  // does not needlessly melt down into small change.
  purse = { yen: 0, pp: 1, gp: 3, ep: 0, sp: 0, cp: 0 };
  check('whole coins that fit are spent first', spendFromWallet(purse, 2000));
  check('the platinum was left intact', purse.pp === 1 && purse.gp === 1);
  check('no change was needed', purse.yen === 0);

  // A cost that straddles both: some whole coins, then a break for the rest.
  purse = { yen: 0, pp: 0, gp: 2, ep: 0, sp: 0, cp: 0 };
  const start = walletTotalYen(purse);
  check('a straddling cost is settled', spendFromWallet(purse, 1200));
  check('a straddling cost conserves value', walletTotalYen(purse) === start - 1200);
})();

// ── Refusal must be total, never partial ──────────────────────────────────
(function () {
  const purse = { yen: 100, pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 };
  const before = JSON.stringify(purse);
  check('an unaffordable purchase is refused', spendFromWallet(purse, 99999) === false);
  check('a refused purchase deducts nothing', JSON.stringify(purse) === before);

  // Total value is what counts, not the Yen field: 1gp covers a 900 cost
  // even with only 100 loose Yen in hand.
  const mixed = { yen: 100, gp: 1 };
  check('affordability is judged on total purse value, not loose Yen',
        spendFromWallet(mixed, 900) === true);

  const neg = { yen: 500 };
  check('a negative price is refused outright', spendFromWallet(neg, -100) === false);
  check('a refused negative price changes nothing', neg.yen === 500);
})();

// ── What a purchase actually does, per kind ───────────────────────────────
(function () {
  // item -> an inventory row
  const inv = { currency: { yen: 50000 } };
  const katana = { id: 'katana', name: 'Katana', kind: 'item', price: 85000,
                   damage: '2d6 slashing', properties: 'Two-handed, Heavy, Finesse' };
  const poor = applyPurchase(inv, katana, 1, 85000);
  check('an unaffordable item purchase reports failure', poor.ok === false);
  check('an unaffordable item purchase adds no row', !inv.items || inv.items.length === 0);
  check('an unaffordable item purchase spends nothing', inv.currency.yen === 50000);

  inv.currency.yen = 200000;
  const ok = applyPurchase(inv, katana, 2, 85000);
  check('an affordable item purchase succeeds', ok.ok === true);
  check('quantity multiplies the price', ok.cost === 170000 && inv.currency.yen === 30000);
  check('the item lands in the inventory with its quantity',
        inv.items.length === 1 && inv.items[0].qty === 2);
  check('the bought item carries a stable id for the merge layer',
        typeof inv.items[0].id === 'string' && inv.items[0].id.indexOf('item-') === 0);
  check('the handbook stats are written into the notes',
        inv.items[0].notes.indexOf('2d6 slashing') !== -1 &&
        inv.items[0].notes.indexOf('Bought from the shop.') !== -1);

  // part -> a counter, not a row
  const inv2 = { currency: { yen: 30000 } };
  const proPart = { id: 'part-pro', name: 'Pro Part', kind: 'part', partKey: 'pro', price: 5000 };
  applyPurchase(inv2, proPart, 6, 5000);
  check('a crafting part increments its counter', inv2.parts.pro === 6);
  check('a crafting part does not create an inventory row', inv2.items === undefined);
  check('a crafting part is paid for', inv2.currency.yen === 0);

  // service -> money only
  const inv3 = { currency: { yen: 20000 }, items: [] };
  const stay = { id: 'hospital-stay', name: 'Hospital Stay', kind: 'service', price: 6000 };
  applyPurchase(inv3, stay, 2, 6000);
  check('a service deducts money', inv3.currency.yen === 8000);
  check('a service adds nothing to the backpack', inv3.items.length === 0);
})();

// ── Price labels for the handbook's ranged and open-ended entries ─────────
(function () {
  check('a fixed price renders plainly', priceLabel({ price: 18000 }) === '¥18,000');
  check('a ranged price shows both ends', priceLabel({ price: 10000, priceMax: 40000 }) === '¥10,000–40,000');
  check('an open-ended price keeps its plus', priceLabel({ price: 250000, priceOpen: true }) === '¥250,000+');
  check('a free student suit is not shown as ¥0', priceLabel({ price: 0 }) === 'School-issued');
})();

// ── Filtering ──────────────────────────────────────────────────────────────
// visibleItems() is the single source of truth for both what the grid shows
// and what the count claims — applyFilter derives the visibility toggle AND
// the "N items" label from this one list, so the two cannot drift apart.
(function () {
  CATALOG = {
    categories: [{ id: 'melee', label: 'Melee' }, { id: 'gear', label: 'Gear' }],
    items: [
      { id: 'a', name: 'Katana', category: 'melee', kind: 'item', price: 1, damage: '2d6 slashing' },
      { id: 'b', name: 'Combat Knife', category: 'melee', kind: 'item', price: 1, properties: 'Light, Finesse' },
      { id: 'c', name: 'Hero Medkit', category: 'gear', kind: 'item', price: 1, effect: 'Stabilize a downed ally' },
    ],
  };

  activeCategory = 'all'; searchTerm = '';
  check('no filter shows everything', visibleItems().length === 3);

  activeCategory = 'melee';
  check('a category filter narrows the list', visibleItems().length === 2);

  activeCategory = 'all'; searchTerm = 'katana';
  check('search matches on name', visibleItems().length === 1);

  searchTerm = 'KATANA';
  check('search is case-insensitive', visibleItems().length === 1);

  searchTerm = '  katana  ';
  check('search ignores surrounding whitespace', visibleItems().length === 1);

  searchTerm = 'finesse';
  check('search reaches properties', visibleItems()[0].id === 'b');

  searchTerm = 'downed';
  check('search reaches the effect text', visibleItems()[0].id === 'c');

  searchTerm = 'slashing';
  check('search reaches the damage line', visibleItems()[0].id === 'a');

  // Category and query compose rather than one overriding the other.
  activeCategory = 'gear'; searchTerm = 'katana';
  check('category and search are combined, not either/or', visibleItems().length === 0);

  activeCategory = 'all'; searchTerm = 'nothing here matches';
  check('an unmatched query yields nothing', visibleItems().length === 0);

  // Every card carries a data-id, which is how applyFilter maps a rendered
  // card back to its catalogue entry. No id, no filtering.
  searchTerm = '';
  check('each rendered card is tagged with its id',
        CATALOG.items.every(it => cardHtml(it).indexOf('data-id="' + it.id + '"') !== -1));
})();

shared.shopCurrencyKeys = CURRENCY_KEYS.slice();
`;

eval(shopSrc + '\n;' + shopTests);

// ── Catalogue integrity ────────────────────────────────────────────────────
const items = catalog.items || [];
const catIds = new Set((catalog.categories || []).map(c => c.id));
const seen = new Set();
let dupes = 0, unknownCat = 0, badPrice = 0, badKind = 0, orphanPart = 0;

// The counter keys the Inventory tab actually renders, read straight out of
// the toolkit so this cannot drift.
const partKeyMatch = toolkitSrc.match(/const PART_DEFS = \[([\s\S]*?)\];/);
const toolkitPartKeys = new Set(
  (partKeyMatch ? partKeyMatch[1].match(/key:\s*'([^']+)'/g) || [] : [])
    .map(s => s.replace(/key:\s*'/, '').replace(/'$/, ''))
);

for (const it of items) {
  if (seen.has(it.id)) dupes++;
  seen.add(it.id);
  if (!catIds.has(it.category)) unknownCat++;
  if (typeof it.price !== 'number' || it.price < 0) badPrice++;
  if (['item', 'part', 'service'].indexOf(it.kind) === -1) badKind++;
  if (it.kind === 'part' && !toolkitPartKeys.has(it.partKey)) orphanPart++;
}

check('the catalogue has entries', items.length > 0);
check('every catalogue id is unique', dupes === 0);
check('every entry sits in a declared category', unknownCat === 0);
check('every entry has a usable price', badPrice === 0);
check('every entry has a known kind', badKind === 0);
check('every part entry maps to a real Inventory counter', orphanPart === 0);
check('the toolkit part keys were actually found', toolkitPartKeys.size === 6);

// A ranged price must not be inverted, or the buy dialog offers a floor above
// its own ceiling.
check('no ranged price is inverted',
      items.every(it => !it.priceMax || it.priceMax >= it.price));

// shop.js and the toolkit must agree on the purse denominations.
const toolkitCurrency = (toolkitSrc.match(/const CURRENCY_KEYS = \[([^\]]*)\]/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
check('shop.js and the toolkit agree on currency keys',
      shared.shopCurrencyKeys.slice().sort().join() === toolkitCurrency.join());

let allPass = true;
for (const [name, ok] of results) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) allPass = false;
}
if (typeof process !== 'undefined') process.exit(allPass ? 0 : 1);
undefined; // avoid osascript auto-printing a trailing value
