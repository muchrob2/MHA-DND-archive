#!/usr/bin/env node
// End-to-end check that a purchase or a grant is never eaten by someone
// editing a character sheet. Run with either engine:
//
//   node scripts/verify-purchase-survival.js
//   osascript -l JavaScript scripts/verify-purchase-survival.js
//
// Why this exists, specifically:
//
// Money and items are now written by THREE separate pages — the toolkit
// (fsMergeSave, manual Save button), the admin grant panel (transaction),
// and the shop (transaction). The two transactional writers always win
// their own write, so the risk is not in them. The risk is the toolkit's
// *next* save afterwards: it builds its write from a local copy that may
// predate the purchase, and for plain values fsMergeSave resolves
// local-wins. If that local copy is stale in the wrong way, clicking Save
// on an unrelated field silently rolls the purchase back — the item
// vanishes, or the money comes back, with no error anywhere.
//
// The other scripts test each writer in isolation. This one wires the real
// pieces together — shop.js's applyPurchase, relationships.js's live-apply
// and save path, and auth.js's actual merge algorithm — and replays the
// sequences that would produce that loss. It drives saveToFirestore() itself
// rather than a reimplementation, so the idArrays the toolkit really
// registers are what gets tested.

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

const authSrc = readFile(join('auth.js'));
const shopSrc = readFile(join('shop.js'));
const toolkitSrc = readFile(join('CLASS-1A', 'relationships.js'));

// ── The real merge algorithm, lifted out of auth.js ────────────────────────
const helpers = {};
for (const name of ['isPlainObject', 'getAtPath', 'setAtPath', 'deepMergeLocalOverServer', 'cloneDoc']) {
  const m = authSrc.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}'));
  if (!m) throw new Error('Could not find ' + name + '() in auth.js — has fsMergeSave changed shape?');
  eval(m[0]);
  helpers[name] = eval(name);
}
// Mirrors fsMergeSave's transaction body (the surrounding runTransaction
// plumbing needs a live Firestore and is not what these scenarios test).
function mergeCompute(server, localDoc, lastSyncedDoc, idArrays) {
  const result = helpers.deepMergeLocalOverServer(server, localDoc);
  for (const { path: p, idKey } of idArrays) {
    const serverArr = Array.isArray(helpers.getAtPath(server, p)) ? helpers.getAtPath(server, p) : [];
    const localArr = Array.isArray(helpers.getAtPath(localDoc, p)) ? helpers.getAtPath(localDoc, p) : [];
    const lastArr = Array.isArray(helpers.getAtPath(lastSyncedDoc, p)) ? helpers.getAtPath(lastSyncedDoc, p) : [];
    const lastById = new Map(lastArr.map((i) => [i[idKey], i]));
    const localById = new Map(localArr.map((i) => [i[idKey], i]));
    const merged = [], seen = new Set();
    for (const item of serverArr) {
      const id = item[idKey]; seen.add(id);
      const hadLocally = localById.has(id), wasSyncedBefore = lastById.has(id);
      if (!hadLocally) { if (!wasSyncedBefore) merged.push(item); continue; }
      const changedLocally = JSON.stringify(localById.get(id)) !== JSON.stringify(lastById.get(id));
      merged.push(changedLocally ? localById.get(id) : item);
    }
    for (const item of localArr) { const id = item[idKey]; if (!seen.has(id) && !lastById.has(id)) merged.push(item); }
    helpers.setAtPath(result, p, merged);
  }
  return result;
}

// ── Browser / Firebase stubs ───────────────────────────────────────────────
function mkEl(id) {
  return { id, className: '', textContent: '', disabled: false, readOnly: false, title: '',
           value: '', style: {}, innerHTML: '', tagName: 'DIV', dataset: {},
           classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
           closest() { return null; }, querySelector() { return null; },
           querySelectorAll() { return []; }, addEventListener() {}, prepend() {} };
}
var els = {};
var document = {
  _active: null,
  get activeElement() { return this._active; },
  getElementById(id) { return (els[id] = els[id] || mkEl(id)); },
  querySelectorAll() { return []; }, querySelector() { return null; },
  addEventListener() {}, createElement() { return mkEl('t'); },
};
var window = { addEventListener() {}, innerWidth: 1200 };
var setInterval = function () { return 0; };
var setTimeout = function (fn) { return 0; };
var fetch = function () { return new Promise(function () {}); }; // parks each page's init IIFE
var fbAuthReady = Promise.resolve({});
var _dbStub = { collection() { return { doc() { return { get() { return new Promise(function () {}); },
                                                        onSnapshot() {} }; } }; },
                runTransaction() { return new Promise(function () {}); } };
var firebase = { firestore: function () { return _dbStub; } };
var fsCloneDoc = function (d) { return d == null ? d : JSON.parse(JSON.stringify(d)); };
var navigator = { clipboard: { writeText() { return Promise.resolve(); } } };
var confirm = function () { return true; };
var location = { reload() {} };
var alert = function () {};

var results = [];
function check(name, ok) { results.push([name, ok]); }
var shared = {};

// THE SERVER. Both the shop and the toolkit act on this one object, exactly
// as they act on one Firestore document.
var SERVER = null;

// Stands in for fsMergeSave, running the genuine merge against SERVER and
// committing the result — so the toolkit's real save path is exercised,
// including whichever idArrays saveToFirestore actually registers.
var fsMergeSave = function (ref, localDoc, lastSyncedDoc, idArrays) {
  const merged = mergeCompute(SERVER, localDoc, lastSyncedDoc, idArrays || []);
  SERVER = JSON.parse(JSON.stringify(merged));
  return Promise.resolve(JSON.parse(JSON.stringify(merged)));
};

// ── shop.js: capture applyPurchase for the scenarios below ────────────────
eval(shopSrc + '\n;shared.applyPurchase = applyPurchase; shared.walletTotalYen = walletTotalYen;');

// ── relationships.js + the scenarios ──────────────────────────────────────
const KATANA = { id: 'katana', name: 'Katana', kind: 'item', price: 85000,
                 damage: '2d6 slashing', properties: 'Two-handed, Heavy, Finesse' };

const scenarios = `
renderProfile = function () {};
renderRelationships = function () {};
refreshSidebar = function () {};

const FILE = 'ren_suzuki.json';

// Puts both the server and this "tab" into a known, freshly-synced state.
function boot(startingYen) {
  SERVER = { version: 1, relationships: {}, characters: { [FILE]: {
    name: 'Ren', backstory: 'original', HP: 30,
    quirk_mechanics: { abilities: [{ id: 'atk-1', name: 'Slash' }] },
    inventory: { currency: { yen: startingYen, pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
                 items: [{ id: 'item-1', name: 'Rope', qty: 1 }], pools: [] },
  } } };
  CHARACTERS = [Object.assign({ _file: FILE, _roster_id: 1, _section: 'class-1a' },
                              JSON.parse(JSON.stringify(SERVER.characters[FILE])))];
  selected = CHARACTERS[0];
  rels = {};
  _dirtyRelKeys = new Map(); _dirtyCharFiles = new Map();
  _lastSyncedRel = fsCloneDoc(SERVER);
  document._active = null;
}

// Someone buys something on the server, from another page/device.
function buyOnServer(entry, qty, unitPrice) {
  const inv = SERVER.characters[FILE].inventory;
  return shared.applyPurchase(inv, entry, qty, unitPrice);
}
function serverItems() { return SERVER.characters[FILE].inventory.items; }
function serverYen()   { return shared.walletTotalYen(SERVER.characters[FILE].inventory.currency); }
function hasItem(name) { return serverItems().some(i => i.name === name); }

shared.run = async function () {

  // ── 1. The headline fear: edit a sheet, a purchase lands, then Save ─────
  boot(200000);
  onSubFieldChange('backstory', 'I have been typing this for ten minutes');   // marks dirty
  buyOnServer(${JSON.stringify(KATANA)}, 1, 85000);                            // shop, elsewhere
  handleRelSnapshot({ exists: true, metadata: { fromCache: false }, data: () => fsCloneDoc(SERVER) });
  await manualSaveRelationships();

  check('a purchase survives the player saving an edited sheet', hasItem('Katana'));
  check('the edit that was being made survives too',
        SERVER.characters[FILE].backstory === 'I have been typing this for ten minutes');
  check('the money spent stays spent', serverYen() === 115000);
  check('pre-existing items are untouched', hasItem('Rope'));

  // ── 2. Same, but the tab never saw the snapshot (blocked live channel) ──
  // Firestore's streaming transport is refused by some browsers/blockers
  // while writes keep working, so a tab can save from a copy that never
  // learned about the purchase at all.
  boot(200000);
  onSubFieldChange('backstory', 'typed while offline');
  buyOnServer(${JSON.stringify(KATANA)}, 1, 85000);
  // no handleRelSnapshot — the listener is dead
  await manualSaveRelationships();

  check('a purchase survives a save from a tab that never saw it', hasItem('Katana'));
  check('the offline tab still lands its own edit',
        SERVER.characters[FILE].backstory === 'typed while offline');

  // ── 3. A cached (stale) snapshot must not resurrect the old inventory ───
  boot(200000);
  buyOnServer(${JSON.stringify(KATANA)}, 1, 85000);
  const fresh = fsCloneDoc(SERVER);
  handleRelSnapshot({ exists: true, metadata: { fromCache: false }, data: () => fresh });
  check('a clean tab picks the purchase up live', selected.inventory.items.some(i => i.name === 'Katana'));
  // now a cached replay of the pre-purchase document arrives
  handleRelSnapshot({ exists: true, metadata: { fromCache: true },
                      data: () => ({ version: 1, relationships: {}, characters: { [FILE]: {
                        inventory: { currency: { yen: 200000 }, items: [{ id: 'item-1', name: 'Rope', qty: 1 }] } } } }) });
  check('a cached replay does not un-buy it', selected.inventory.items.some(i => i.name === 'Katana'));

  // ── 4. Deleting still deletes — the protection must not be a ratchet ────
  // If "keep anything the server has that we lack" were unconditional, no
  // one could ever throw an item away.
  boot(200000);
  onItemDelete('item-1');
  await manualSaveRelationships();
  check('deleting an item really deletes it', !hasItem('Rope'));

  // ── 5. Editing one item while another is bought ─────────────────────────
  boot(200000);
  onItemEdit('item-1', 'name', 'Silk Rope');
  scheduleCharSave(selected);
  buyOnServer(${JSON.stringify(KATANA)}, 1, 85000);
  handleRelSnapshot({ exists: true, metadata: { fromCache: false }, data: () => fsCloneDoc(SERVER) });
  await manualSaveRelationships();
  check('renaming one item keeps the rename', hasItem('Silk Rope'));
  check('renaming one item does not eat a concurrent purchase', hasItem('Katana'));

  // ── 6. Several purchases back to back, then a save ──────────────────────
  boot(500000);
  onSubFieldChange('backstory', 'mid-edit');
  buyOnServer(${JSON.stringify(KATANA)}, 1, 85000);
  buyOnServer({ id: 'medkit', name: 'Standard Hero Medkit', kind: 'item', price: 7500 }, 2, 7500);
  buyOnServer({ id: 'part-pro', name: 'Pro Part', kind: 'part', partKey: 'pro', price: 5000 }, 6, 5000);
  handleRelSnapshot({ exists: true, metadata: { fromCache: false }, data: () => fsCloneDoc(SERVER) });
  await manualSaveRelationships();
  check('every item from a shopping spree survives', hasItem('Katana') && hasItem('Standard Hero Medkit'));
  check('a bought crafting part survives the save',
        SERVER.characters[FILE].inventory.parts.pro === 6);
  check('the whole spree is paid for exactly', serverYen() === 500000 - 85000 - 15000 - 30000);

  // ── 7. The known conflict, asserted rather than assumed ────────────────
  // If the player is editing the purse ITSELF when a purchase lands, one of
  // the two must lose; the merge resolves that last-writer-wins, like every
  // other field. Pinned here so the behaviour is a documented choice and
  // any future change to it is visible.
  boot(200000);
  // Inventory editing is admin-only now (canEditInventory in relationships.js),
  // so the person hand-editing a purse mid-purchase is the DM, not the player.
  onCurrencyChange('yen', 199000);            // DM hand-edits the purse
  buyOnServer(${JSON.stringify(KATANA)}, 1, 85000);
  handleRelSnapshot({ exists: true, metadata: { fromCache: false }, data: () => fsCloneDoc(SERVER) });
  await manualSaveRelationships();
  check('a hand-edited purse wins over a concurrent deduction (documented)',
        serverYen() === 199000);
  check('the bought item is still delivered even then', hasItem('Katana'));
};
`;

// Inventory handlers refuse unless the actor is an admin; these scenarios
// exercise the merge, not the permission, so run them as the DM. The gate
// itself is covered in verify-relationship-sync.js.
eval(toolkitSrc + '\n;canEditInventory = true;\n' + scenarios);

shared.run().then(() => {
  let allPass = true;
  for (const [name, ok] of results) {
    console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
    if (!ok) allPass = false;
  }
  if (typeof process !== 'undefined') process.exit(allPass ? 0 : 1);
}).catch((e) => {
  console.log('FAIL — scenarios threw: ' + (e && e.message));
  if (typeof process !== 'undefined') process.exit(1);
});
undefined; // avoid osascript auto-printing a trailing value
