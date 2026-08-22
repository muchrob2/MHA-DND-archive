#!/usr/bin/env node
// Regression check for the DM grant path in admin.js and the resource
// counters it writes into, which the toolkit renders on its Inventory tab
// (CLASS-1A/relationships.js). Run with either engine (same dual-runtime shim
// as the other verify scripts — this project has no test runner):
//
//   node scripts/verify-inventory-grants.js
//   osascript -l JavaScript scripts/verify-inventory-grants.js
//
// Why this exists: a grant is the one write in the app that fans out across
// many characters at once and is issued by someone who is not looking at the
// sheet being changed. Two failure modes are silent and expensive:
//
//   1. Key drift. admin.js and relationships.js each carry their own copy of
//      the currency/part/point key lists. If they diverge, a grant writes a
//      counter that the Inventory tab never renders — the DM sees "granted ✓",
//      the player sees nothing, and nothing throws. The last block below
//      compares the two lists directly.
//   2. Clamping. "Add" is also how a DM deducts (a negative amount), so the
//      floor at 0 is load-bearing: without it a counter goes negative and the
//      handbook caps stop meaning anything.
//
// Like verify-relationship-sync.js this is integration-flavoured: it evals the
// real files and drives the real functions rather than reimplementing them.

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

const adminSrc = readFile(join('admin.js'));
const toolkitSrc = readFile(join('CLASS-1A', 'relationships.js'));

// ── Browser / Firebase stubs ────────────────────────────────────────────────
function mkEl(id) {
  return { id, className: '', textContent: '', disabled: false, title: '', value: '',
           style: {}, innerHTML: '', tagName: 'DIV', dataset: {},
           classList: { add() {}, remove() {}, toggle() {} },
           closest() { return null; },
           querySelector() { return null; }, querySelectorAll() { return []; },
           addEventListener() {}, prepend() {} };
}
var els = {};
var document = {
  _active: null,
  get activeElement() { return this._active; },
  getElementById(id) { return (els[id] = els[id] || mkEl(id)); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener() {},
  createElement() { return mkEl('tmp'); },
};
var window = { addEventListener() {}, innerWidth: 1200, matchMedia: null };
var setInterval = function () { return 0; };
var setTimeout = function () { return 0; };
var fetch = function () { return new Promise(function () {}); };
var fbAuthReady = new Promise(function () {});
var _dbStub = { collection() { return { doc() { return { get() { return new Promise(function () {}); },
                                                        onSnapshot() {} }; },
                                        get() { return new Promise(function () {}); } }; },
                runTransaction() { return new Promise(function () {}); } };
var firebase = { firestore: function () { return _dbStub; } };
var fsCloneDoc = function (doc) { return doc == null ? doc : JSON.parse(JSON.stringify(doc)); };
var fsMergeSave = function (ref, local) { return Promise.resolve(fsCloneDoc(local)); };
var navigator = { clipboard: { writeText() { return Promise.resolve(); } } };
var confirm = function () { return true; };
var location = { reload() {} };
var alert = function () {};

var results = [];
function check(name, ok) { results.push([name, ok]); }

// admin.js and relationships.js both declare a top-level `db`, `genId` and
// `escHtml`, so they cannot share one eval scope. Each is evaluated with its
// own test block; findings cross the boundary through `results` and the two
// captured key lists on `shared`.
var shared = {};

const adminTests = `
// ── Currency / parts / points: add, set, and the floor at 0 ────────────────
(function () {
  const inv = {};
  applyGrantToInventory(inv, { kind: 'currency', key: 'yen', amount: 5000, mode: 'add' });
  applyGrantToInventory(inv, { kind: 'currency', key: 'yen', amount: 2500, mode: 'add' });
  check('add accumulates onto an existing total', inv.currency.yen === 7500);

  applyGrantToInventory(inv, { kind: 'currency', key: 'yen', amount: 100, mode: 'set' });
  check('set replaces rather than adds', inv.currency.yen === 100);

  // "Add" doubles as the deduct path — the DM types a negative amount.
  applyGrantToInventory(inv, { kind: 'currency', key: 'yen', amount: -40, mode: 'add' });
  check('a negative amount deducts', inv.currency.yen === 60);

  applyGrantToInventory(inv, { kind: 'currency', key: 'yen', amount: -999, mode: 'add' });
  check('deducting past empty floors at 0', inv.currency.yen === 0);

  applyGrantToInventory(inv, { kind: 'parts', key: 'pro', amount: 6, mode: 'add' });
  check('parts land in inventory.parts', inv.parts.pro === 6);

  applyGrantToInventory(inv, { kind: 'points', key: 'ftp', amount: 3, mode: 'add' });
  check('points land in inventory.points', inv.points.ftp === 3);

  // Each kind writes its own sub-object; a part grant must not touch coin.
  check('grant kinds stay in separate sub-objects',
        inv.currency.yen === 0 && inv.parts.pro === 6 && inv.points.ftp === 3);
})();

// ── Items always append, and never collide with an existing entry ──────────
(function () {
  const inv = { items: [{ id: 'item-1', name: 'Katana', qty: 1 }] };
  applyGrantToInventory(inv, { kind: 'item', amount: 2, itemName: 'Hero Medkit', itemNotes: 'Ch. 6' });
  check('item is appended, not merged', inv.items.length === 2);
  check('granted item keeps its quantity and notes',
        inv.items[1].qty === 2 && inv.items[1].notes === 'Ch. 6');
  check('granted item gets an id for the merge layer',
        typeof inv.items[1].id === 'string' && inv.items[1].id.indexOf('item-') === 0);
  check('the pre-existing item is untouched', inv.items[0].name === 'Katana');
})();

// ── Named pools: find-or-create, case/space insensitively ─────────────────
// Two DMs typing "Fury Points" and "fury points" must not produce two pools.
(function () {
  const inv = {};
  applyGrantToInventory(inv, { kind: 'pool', poolName: 'Fury Points', amount: 3, mode: 'add', poolMax: 5 });
  check('a new pool is created with its max', inv.pools.length === 1 && inv.pools[0].max === 5);
  check('a new pool has an id', typeof inv.pools[0].id === 'string');

  applyGrantToInventory(inv, { kind: 'pool', poolName: '  fury points ', amount: 2, mode: 'add', poolMax: null });
  check('a differently-cased name reuses the same pool', inv.pools.length === 1);
  check('pool value accumulated', inv.pools[0].value === 5);
  check('a blank max leaves the existing max alone', inv.pools[0].max === 5);

  applyGrantToInventory(inv, { kind: 'pool', poolName: 'Fury Points', amount: -99, mode: 'add', poolMax: null });
  check('pool deduction floors at 0', inv.pools[0].value === 0);

  applyGrantToInventory(inv, { kind: 'pool', poolName: 'Speed Points', amount: 4, mode: 'set', poolMax: null });
  check('a second, distinct pool is added', inv.pools.length === 2 && inv.pools[1].value === 4);
})();

// ── The receipt line the DM reads back ─────────────────────────────────────
(function () {
  check('summary reads as a grant',
        grantSummary({ kind: 'currency', key: 'yen', amount: 500, mode: 'add' }).indexOf('granted 500') !== -1);
  check('summary reads as a deduction for negatives',
        grantSummary({ kind: 'currency', key: 'yen', amount: -500, mode: 'add' }).indexOf('deducted 500') !== -1);
  check('summary reads as a set',
        grantSummary({ kind: 'points', key: 'ftp', amount: 2, mode: 'set' }).indexOf('set to 2') !== -1);
})();

shared.adminKeys = {
  currency: GRANT_CURRENCIES.map(p => p[0]),
  parts:    GRANT_PARTS.map(p => p[0]),
  points:   GRANT_POINTS.map(p => p[0]),
};
`;

eval(adminSrc + '\n;' + adminTests);

// Reset the shared DOM stub — the toolkit reaches for different element ids.
els = {};

const toolkitTests = `
// ── Derived per-long-rest caps ─────────────────────────────────────────────
(function () {
  check('proficiency comes from the sheet when present', profOf({ proficiency_bonus: 4, level: 1 }) === 4);
  check('proficiency is derived from level otherwise', profOf({ level: 9 }) === 4);
  check('proficiency defaults to +2 for an empty sheet', profOf({}) === 2);

  // The two derived caps must track the character, not a frozen number.
  const surge = POINT_DEFS.find(p => p.key === 'tacticalSurge');
  const frame = POINT_DEFS.find(p => p.key === 'impactFrame');
  check('Tactical Surge cap is 1 + proficiency', surge.max({ level: 9 }) === 5);
  check('Impact Frame cap is the proficiency bonus', frame.max({ level: 9 }) === 4);
  check('Plus Ultra is capped at 1', POINT_DEFS.find(p => p.key === 'plusUltra').max() === 1);
  check('Awakening Points are capped at 3', POINT_DEFS.find(p => p.key === 'awakening').max() === 3);
  check('Free Time Points are uncapped', POINT_DEFS.find(p => p.key === 'ftp').max === null);
})();

// ── Pools join the id-keyed merge layer ────────────────────────────────────
// Without an id, fsMergeSave replaces the pools array wholesale and a
// concurrent grant and player edit lose one of the two.
(function () {
  const c = { inventory: { items: [{ name: 'x' }], pools: [{ name: 'Fury Points', value: 2 }] } };
  ensureCharIds(c);
  check('ensureCharIds backfills a pool id', typeof c.inventory.pools[0].id === 'string');
  check('ensureCharIds still backfills an item id', typeof c.inventory.items[0].id === 'string');

  // A pool that already has an id keeps it — regenerating would fork the row
  // into two on the next merge.
  const kept = c.inventory.pools[0].id;
  ensureCharIds(c);
  check('an existing pool id is left alone', c.inventory.pools[0].id === kept);
})();

// ── The bundle must never speak for inventory again ───────────────────────
// The expensive failure, and the one this replaced: mha-dnd/relationships-
// bundle still carries an 'inventory' key for all twenty characters, frozen
// at migration time (¥20,000, no items) because buildBundle has stripped
// inventory from every save since. applyRemoteRelBundle used to Object.assign
// that fossil straight over the live inventory loaded from the collection —
// so a grant or a purchase landed in Firestore correctly and then vanished
// off the Inventory tab the moment any bundle snapshot arrived, which is
// exactly what a failed write looks like from the DM's chair.
(function () {
  renderProfile = function () {}; renderRelationships = function () {}; refreshSidebar = function () {};

  const live = { currency: { yen: 8000 }, points: { ftp: 4 },
                 items: [{ id: 'item-1', name: 'Wallet', qty: 1, notes: '' }] };
  CHARACTERS = [{ _file: 'a.json', _roster_id: 1, _section: 'class-1a', name: 'A',
                  HP: 30, inventory: live }];
  selected = CHARACTERS[0];
  rels = {};
  _dirtyRelKeys = new Map();
  _dirtyCharFiles = new Map();
  _lastSyncedRel = null;
  document._active = null;

  // A snapshot of the bundle as it actually is today: stale inventory and all.
  applyRemoteRelBundle({ version: 1, relationships: {}, characters: { 'a.json': {
    name: 'A', HP: 31,
    inventory: { currency: { yen: 20000 }, points: {}, items: [] } } } });

  check('a bundle snapshot does not overwrite the purse',
        CHARACTERS[0].inventory.currency.yen === 8000);
  check('a bundle snapshot does not wipe granted items',
        CHARACTERS[0].inventory.items.length === 1);
  check('a bundle snapshot does not reset point counters',
        CHARACTERS[0].inventory.points.ftp === 4);
  check('the rest of the sheet still takes the remote update',
        CHARACTERS[0].HP === 31);
})();

// Same again while the sheet has unsaved edits. The dirty branch skips the
// character entirely, so inventory is safe there for a different reason —
// but it must stay safe, because that branch used to reach into the bundle
// for grant counters and would now be pulling in fossils.
(function () {
  CHARACTERS = [{ _file: 'a.json', _roster_id: 1, _section: 'class-1a', name: 'A',
                  HP: 25, inventory: { currency: { yen: 8000 } } }];
  selected = CHARACTERS[0];
  _lastSyncedRel = { characters: { 'a.json': { inventory: { currency: { yen: 8000 } } } } };
  _dirtyCharFiles = new Map([['a.json', 1]]);

  applyRemoteRelBundle({ version: 1, relationships: {}, characters: { 'a.json': {
    name: 'A', HP: 30, inventory: { currency: { yen: 20000 } } } } });

  check('a dirty sheet keeps its real purse too',
        CHARACTERS[0].inventory.currency.yen === 8000);
  check('the unsaved local edit is still protected', CHARACTERS[0].HP === 25);
})();

// ── The collection is the only thing that may move inventory ──────────────
// And it must land whether or not the sheet has unsaved edits: inventory is
// read-only on this page, so there is never a local edit to protect.
(function () {
  const mkSnap = (byFile) => ({
    metadata: { fromCache: false },
    forEach(fn) { for (const id of Object.keys(byFile)) fn({ id, data: () => byFile[id] }); },
  });

  CHARACTERS = [{ _file: 'a.json', _roster_id: 1, _section: 'class-1a', name: 'A',
                  inventory: { currency: { yen: 100 }, items: [] } }];
  selected = CHARACTERS[0];
  _dirtyCharFiles = new Map();

  applyInventorySnapshot(mkSnap({ 'a.json': {
    currency: { yen: 5100 }, parts: { pro: 6 },
    items: [{ id: 'item-9', name: 'Hero Medkit', qty: 1, notes: '' }] } }));

  check('a grant arriving on the collection lands',
        CHARACTERS[0].inventory.currency.yen === 5100);
  check('a first-ever counter arrives with it',
        CHARACTERS[0].inventory.parts.pro === 6);
  check('a granted item arrives with it',
        CHARACTERS[0].inventory.items.length === 1);

  // Dirty sheet, same result.
  _dirtyCharFiles = new Map([['a.json', 1]]);
  applyInventorySnapshot(mkSnap({ 'a.json': { currency: { yen: 7000 }, items: [] } }));
  check('the collection reaches a dirty sheet as well',
        CHARACTERS[0].inventory.currency.yen === 7000);

  // A character with no document of its own is left alone rather than blanked.
  CHARACTERS.push({ _file: 'b.json', _roster_id: 2, _section: 'class-1a', name: 'B',
                    inventory: { currency: { yen: 42 } } });
  applyInventorySnapshot(mkSnap({ 'a.json': { currency: { yen: 7000 }, items: [] } }));
  check('a character absent from the snapshot keeps what it had',
        CHARACTERS[1].inventory.currency.yen === 42);
})();

shared.toolkitKeys = {
  currency: CURRENCY_KEYS.slice(),
  parts:    PART_KEYS.slice(),
  points:   POINT_KEYS.slice(),
};
`;

eval(toolkitSrc + '\n;' + toolkitTests);

// ── The two files must agree on every key ──────────────────────────────────
// This is the check that catches a grant writing a counter nothing renders.
for (const group of ['currency', 'parts', 'points']) {
  const a = shared.adminKeys[group].slice().sort();
  const t = shared.toolkitKeys[group].slice().sort();
  check('admin.js and the toolkit agree on ' + group + ' keys',
        a.length === t.length && a.every((k, i) => k === t[i]));
}

// saveToFirestore must name the pools array in idArrays, or the merge layer
// never sees the ids ensureCharIds just backfilled.
check('saveToFirestore registers inventory.pools with fsMergeSave',
      /'inventory',\s*'pools'/.test(toolkitSrc));

let allPass = true;
for (const [name, ok] of results) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) allPass = false;
}
if (typeof process !== 'undefined') process.exit(allPass ? 0 : 1);
undefined; // avoid osascript auto-printing a trailing value
