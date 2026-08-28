#!/usr/bin/env node
// Regression check for the live-sync/save interaction in
// CLASS-1A/relationships.html — the "what I just typed gets instantly undone"
// bug. Run with either engine (same dual-runtime shim as
// verify-merge-safety.js, since this project has no test runner):
//
//   node scripts/verify-relationship-sync.js
//   osascript -l JavaScript scripts/verify-relationship-sync.js
//
// Why this exists: three earlier attempts fixed fsMergeSave in auth.js — the
// *write* path — and were verified against verify-merge-safety.js, which only
// covers writes. The actual bug was on the *apply* path (a live snapshot
// overwriting local state), which had no coverage, so the symptom survived
// every "fix". This script loads the page's real script block, stubs the
// browser and Firebase globals, and replays the reported sequence end to end.
//
// It is deliberately integration-flavoured rather than unit-flavoured: it
// drives the actual functions in the actual file, so a regression in how they
// are wired together fails here even if each piece looks right on its own.
// (It caught exactly that during development: per-field dirty tracking held as
// a Set could not distinguish "dirty when the save started" from "edited again
// while the save was in flight", so re-editing the same note during a save
// silently marked it clean. Hence the edit-sequence Map.)

const fs = typeof require === 'function' ? require('fs') : null;
const path = typeof require === 'function' ? require('path') : null;

function readFile(p) {
  if (fs) return fs.readFileSync(p, 'utf8');
  const url = $.NSURL.fileURLWithPath(p);
  return ObjC.unwrap($.NSString.stringWithContentsOfURLEncodingError(url, $.NSUTF8StringEncoding, null));
}
if (!fs) ObjC.import('Foundation');

const repoRoot = path ? path.join(__dirname, '..') : '.';
const pagePath = path ? path.join(repoRoot, 'CLASS-1A', 'relationships.js')
                      : 'CLASS-1A/relationships.js';
// Read the page logic straight from its own file. This used to regex the last
// <script> block out of relationships.html, which broke whenever the page's
// markup shifted; extracting the JS removed the need for that entirely.
const appSrc = readFile(pagePath);

// ── Browser / Firebase stubs ────────────────────────────────────────────────
function mkEl(id) {
  return { id, className: '', textContent: '', disabled: false, title: '', value: '',
           style: {}, innerHTML: '', tagName: 'DIV', _in: null,
           classList: { add() {}, remove() {}, toggle() {} },
           closest(sel) { return this._in && sel.indexOf(this._in) !== -1 ? {} : null; },
           querySelector() { return null; }, querySelectorAll() { return []; },
           addEventListener() {} };
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
var window = { addEventListener() {}, innerWidth: 1200 };
// A real store rather than a black hole: category collapse is persisted
// through it, so a stub that forgets everything would pass whatever it was
// asked.
var localStorage = (function () {
  const store = new Map();
  return { getItem(k) { return store.has(k) ? store.get(k) : null; },
           setItem(k, v) { store.set(k, String(v)); } };
})();
var setInterval = function () { return 0; };
var setTimeout = function () { return 0; };
var fetch = function () { return new Promise(function () {}); }; // never settles: the page's init IIFE just suspends
var fbAuthReady = new Promise(function () {});
// relationships.js opens with `const db = firebase.firestore()`, exactly as the
// browser runs it, so the harness stubs the SDK entry point rather than the
// handle. Scenarios reach the stub through _dbStub.
var _dbStub = { collection() { return { doc() { return { get() { return new Promise(function () {}); },
                                                        onSnapshot() {} }; } }; } };
var firebase = { firestore: function () { return _dbStub; } };
// Both mirror auth.js's contract: a baseline is always a detached copy of the
// document, never a live reference into page state (see cloneDoc there).
var fsCloneDoc = function (doc) { return doc == null ? doc : JSON.parse(JSON.stringify(doc)); };
var fsMergeSave = function (ref, local) { return Promise.resolve(fsCloneDoc(local)); };
var navigator = { clipboard: { writeText() { return Promise.resolve(); } } };
var confirm = function () { return true; };
var location = { reload() {} };

var results = [];
function check(name, ok) { results.push([name, ok]); }

// Scenarios are concatenated into the SAME eval as the page source: `let`
// bindings inside an eval do not escape it, so test code must share that scope
// to touch the real `rels` / `_dirtyRelKeys` instead of shadow copies.
const testSrc = `
// Stub out the render layer; these scenarios exercise the data path.
let renderCount = 0;
renderProfile = function () { renderCount++; };
renderRelationships = function () { renderCount++; };
refreshSidebar = function () { renderCount++; };

// ── Scenario A: the reported bug, end to end ────────────────────────────────
// Type a note, click Save, keep typing into the SAME note while the save is in
// flight, then let a stale pre-save snapshot land. The typing must survive.
(function () {
  CHARACTERS = [{ _file: 'a.json', _roster_id: 1, _section: 'class-1a', name: 'A' },
                { _file: 'b.json', _roster_id: 2, _section: 'class-1a', name: 'B' }];
  selected = CHARACTERS[0];
  rels = {};
  _dirtyRelKeys = new Map(); _dirtyCharFiles = new Map(); _lastSyncedRel = null;

  setRelNote(1, 2, 'first note');
  const sent = new Map(_dirtyRelKeys);   // what clicking Save captures
  // Save is now in flight; buildBundle() already snapshotted 'first note'.
  setRelNote(1, 2, 'first note + typed during save');

  // Save completes — clear only entries not re-edited since the capture.
  for (const [k, seq] of sent) if (_dirtyRelKeys.get(k) === seq) _dirtyRelKeys.delete(k);
  check('mid-flight edit to the same note stays dirty', _dirtyRelKeys.has('1:2'));

  // Cursor is in the note, so the re-render must defer instead of yanking it.
  document._active = Object.assign(mkEl('note'), { tagName: 'TEXTAREA', _in: '#rel-section' });

  applyRemoteRelBundle({ version: 1, relationships: { '1:2': { score: 0, note: '' } },
                         characters: { 'a.json': { name: 'A' }, 'b.json': { name: 'B' } } });

  check('typed note survives a stale snapshot',
        rels['1:2'] && rels['1:2'].note === 'first note + typed during save');
  check('render deferred while a field is focused', _pendingRender === true);
})();

// ── Scenario B: concurrent editors still sync ───────────────────────────────
(function () {
  CHARACTERS = [{ _file: 'a.json', _roster_id: 1, _section: 'class-1a', name: 'A' },
                { _file: 'b.json', _roster_id: 2, _section: 'class-1a', name: 'B', HP: 10 }];
  selected = CHARACTERS[0];
  rels = { '1:2': { score: 0, note: 'mine, unsaved' } };
  _dirtyRelKeys = new Map([['1:2', 1]]);
  _dirtyCharFiles = new Map([['a.json', 2]]);
  _lastSyncedRel = null;
  document._active = null;
  renderCount = 0;

  applyRemoteRelBundle({ version: 1,
    relationships: { '1:2': { score: 0, note: '' }, '3:4': { score: 7, note: 'theirs' } },
    characters: { 'a.json': { name: 'A', HP: 99 }, 'b.json': { name: 'B', HP: 42 } } });

  check('my unsaved note is untouched', rels['1:2'].note === 'mine, unsaved');
  check("another player's new relationship is applied", rels['3:4'] && rels['3:4'].note === 'theirs');
  check('a clean character takes the remote update', CHARACTERS[1].HP === 42);
  check('a dirty character is not clobbered', CHARACTERS[0].HP === undefined);
  check('render runs when nothing is focused', renderCount > 0);
  check('baseline holds back for the dirty character',
        _lastSyncedRel.characters['a.json'] === undefined);
  check('baseline advances for the clean character',
        _lastSyncedRel.characters['b.json'].HP === 42);
})();

// ── Scenario D: cached snapshots must never overwrite live data ─────────────
// When Firestore's streaming channel is blocked (Safari tracking protection,
// content blockers, proxies) the write transport still works, so a save
// commits — but the listener goes offline and replays this tab's own stale
// cache. Applying that as if it were remote truth silently undoes the save.
(function () {
  CHARACTERS = [{ _file: 'a.json', _roster_id: 1, _section: 'class-1a', name: 'A' }];
  selected = CHARACTERS[0];
  rels = { '1:2': { score: 0, note: 'just saved to the server' } };
  _dirtyRelKeys = new Map(); _dirtyCharFiles = new Map(); _lastSyncedRel = null;
  document._active = null;

  const stale = { version: 1, relationships: { '1:2': { score: 0, note: 'pre-save value' } },
                  characters: { 'a.json': { name: 'A' } } };

  handleRelSnapshot({ exists: true, metadata: { fromCache: true }, data: () => stale });
  check('cached snapshot does NOT overwrite a saved value',
        rels['1:2'].note === 'just saved to the server');

  // A server-confirmed snapshot is authoritative and must still apply.
  const fresh = { version: 1, relationships: { '1:2': { score: 0, note: 'from the server' } },
                  characters: { 'a.json': { name: 'A' } } };
  handleRelSnapshot({ exists: true, metadata: { fromCache: false }, data: () => fresh });
  check('server snapshot still applies', rels['1:2'].note === 'from the server');
})();

// ── Scenario E: attacks/items are addressed by id, not array position ───────
// fsMergeSave rebuilds these arrays in server order and appends new local items
// at the end, so the order after a save or remote merge need not match the order
// the DOM was rendered from. Handlers baked with a render-time index would then
// write into whichever item now occupies that slot — the edit lands on the wrong
// attack, and the one being edited appears to revert on the next render.
(function () {
  CHARACTERS = [{ _file: 'a.json', _roster_id: 1, _section: 'class-1a', name: 'A',
                  quirk_mechanics: { abilities: [
                    { id: 'atk-1', name: 'Punch', type: '', description: '' },
                    { id: 'atk-2', name: 'Kick',  type: '', description: '' }] },
                  inventory: { items: [
                    { id: 'item-1', name: 'Rope', qty: 1, notes: '' },
                    { id: 'item-2', name: 'Torch', qty: 1, notes: '' }] } }];
  selected = CHARACTERS[0];
  _dirtyCharFiles = new Map();

  // The DOM was rendered while Kick sat at index 1. A merge now reorders the
  // array (server order), putting Kick at index 0.
  selected.quirk_mechanics.abilities.reverse();

  onAttackEdit('atk-2', 'name', 'Roundhouse');
  const kick  = selected.quirk_mechanics.abilities.find(a => a.id === 'atk-2');
  const punch = selected.quirk_mechanics.abilities.find(a => a.id === 'atk-1');
  check('attack edit follows the id after a reorder', kick.name === 'Roundhouse');
  check('attack edit does not touch the neighbour', punch.name === 'Punch');
  check('editing an attack marks the character dirty', _dirtyCharFiles.has('a.json'));

  // Same for inventory. Item rows are editable by anyone who can edit sheets,
  // and need a document in the inventories collection to write to — so grant
  // both. These cases are about ids surviving a reorder, not permissions;
  // the permissions are the block below.
  canWrite = true;
  inventoryDocs.add('a.json');
  selected.inventory.items.reverse();
  onItemEdit('item-2', 'name', 'Lantern');
  check('item edit follows the id after a reorder',
        selected.inventory.items.find(i => i.id === 'item-2').name === 'Lantern');
  check('item edit does not touch the neighbour',
        selected.inventory.items.find(i => i.id === 'item-1').name === 'Rope');

  // The split that matters: a player may keep their own kit, and may not
  // touch their own money. Both handlers are called directly here, the way a
  // console poke would, because disabling an input is not a rule.
  selected.inventory.currency = { yen: 500 };
  onItemAdd();
  check('a player may add an item', selected.inventory.items.length === 3);
  onItemDelete(selected.inventory.items[2].id);
  check('a player may delete an item', selected.inventory.items.length === 2);
  onCurrencyChange('yen', 999999);
  check('a player cannot grant themselves money', selected.inventory.currency.yen === 500);
  onPartChange('pro', 99);
  check('a player cannot grant themselves crafting parts',
        (selected.inventory.parts || {}).pro === undefined);
  onPointChange('plusUltra', 5);
  check('a player cannot grant themselves points',
        (selected.inventory.points || {}).plusUltra === undefined);

  // An item edit must not mark the *sheet* dirty: items travel in the
  // inventories collection, and holding the bundle's Save button hostage for
  // a change that never rides in it would strand everyone else's edits.
  _dirtyCharFiles = new Map();
  onItemEdit('item-2', 'name', 'Storm Lantern');
  check('an item edit does not mark the sheet dirty', !_dirtyCharFiles.has('a.json'));
  check('an item edit does mark the items dirty', _dirtyItemFiles.has('a.json'));

  // Without a document in the collection there is nothing to write to, so the
  // tab stays read-only rather than offering an edit the database refuses.
  inventoryDocs.delete('a.json');
  onItemAdd();
  check('an unmigrated character cannot have items added',
        selected.inventory.items.length === 2);
  inventoryDocs.add('a.json');

  // Deleting by id must remove the right row, whatever the order.
  onAttackDelete('atk-1');
  const left = selected.quirk_mechanics.abilities;
  check('attack delete removes the right entry',
        left.length === 1 && left[0].id === 'atk-2');

  // Unknown ids (a row deleted by someone else mid-edit) must no-op, not throw.
  onAttackEdit('atk-gone', 'name', 'ghost');
  onAttackDelete('atk-gone');
  onItemEdit('item-gone', 'name', 'ghost');
  check('unknown id is a safe no-op', selected.quirk_mechanics.abilities.length === 1);
})();

// ── Scenario F: people added from this page ────────────────────────────────
// roster.json is a repo file, so someone added here exists only in the
// Firestore bundle. The risk is the list-reconciling path: to a live snapshot,
// a person this tab added and hasn't saved yet is indistinguishable from a
// person another tab deleted — both are simply absent from the bundle.
(function () {
  CHARACTERS = [{ _file: 'a.json', _roster_id: 1, _section: 'class-1a', name: 'A', is_pc: false }];
  selected = CHARACTERS[0];
  rels = {}; _dirtyRelKeys = new Map(); _dirtyCharFiles = new Map();
  _lastSyncedRel = null; _relSavePending = false; document._active = null;

  const added = addPerson('  Nurse Chiyo  ');
  check('added person is named and trimmed', added.name === 'Nurse Chiyo');
  check('added person is numbered clear of the roster', added._roster_id >= 1000);
  check('added person is flagged as custom', added._custom === true);
  check('adding marks them unsaved', _dirtyCharFiles.has(added._file));
  check('added person is in the save bundle',
        buildBundle().characters[added._file].name === 'Nurse Chiyo');

  // The "my new person vanished" failure: a snapshot that predates the save.
  applyRemoteRelBundle({ version: 1, relationships: {}, characters: { 'a.json': { name: 'A' } } });
  check('an unsaved addition survives a snapshot without them', CHARACTERS.includes(added));

  // Saved, and now coming back from the server.
  _dirtyCharFiles.delete(added._file);
  const withThem = { 'a.json': { name: 'A' } };
  withThem[added._file] = { name: 'Nurse Chiyo', _custom: true, _roster_id: added._roster_id };
  applyRemoteRelBundle({ version: 1, relationships: {}, characters: withThem });
  check('a saved addition stays after it round-trips',
        CHARACTERS.some(c => c._file === added._file));

  // Deleted from another tab: gone from the bundle, nothing dirty locally.
  applyRemoteRelBundle({ version: 1, relationships: {}, characters: { 'a.json': { name: 'A' } } });
  check('a remote removal drops them here', !CHARACTERS.some(c => c._file === added._file));
  check('selection falls back to someone real', selected && CHARACTERS.includes(selected));

  // Someone else's addition, and a fossil that must stay dead: the bundle
  // still holds characters removed from the roster on purpose, and they carry
  // no _custom flag precisely so this path ignores them.
  applyRemoteRelBundle({ version: 1, relationships: {}, characters: {
    'a.json': { name: 'A' },
    'custom-zz.json': { name: 'Recovery Girl', _custom: true, _roster_id: 1007 },
    'zaro_brando.json': { name: 'Zaro Brando' } } });
  check("another tab's addition appears here", CHARACTERS.some(c => c.name === 'Recovery Girl'));
  check('a roster fossil does not come back', !CHARACTERS.some(c => c.name === 'Zaro Brando'));

  // Two tabs allocating from the same high-water mark get the same id. The
  // bundle keys people by file so both survive, but a shared _roster_id would
  // mean shared relationship keys — every note about one showing on the other.
  const clash = [{ _file: 'x.json', _roster_id: 1000, name: 'X' },
                 { _file: 'y.json', _roster_id: 1000, name: 'Y' }];
  dedupeRosterIds(clash);
  check('colliding ids are separated', clash[0]._roster_id !== clash[1]._roster_id);
})();

// ── Scenario G: categories ─────────────────────────────────────────────────
// The sidebar heading a person appears under used to be a boolean (is_pc), so
// teachers, villains and rival classes had nowhere to be. It is a label now,
// with is_pc kept as the derived twin of the Players category — the risk being
// the two drifting apart and disagreeing about who is a player.
(function () {
  CHARACTERS = [
    { _file: 'p.json', _roster_id: 1, _section: 'class-1a', name: 'Ren',  is_pc: true },
    { _file: 'a.json', _roster_id: 2, _section: 'class-1a', name: 'Kibi', is_pc: false },
  ];
  selected = CHARACTERS[0];
  rels = {}; _dirtyRelKeys = new Map(); _dirtyCharFiles = new Map();
  _lastSyncedRel = null; _relSavePending = false; document._active = null;

  check('a roster PC reads as Players with no category stored',
        groupOf(CHARACTERS[0]) === PLAYERS_GROUP);
  check('everyone else reads as Class 1-A', groupOf(CHARACTERS[1]) === CLASS_GROUP);
  check('reading a category does not write one', CHARACTERS[0]._group === undefined);
  check('the two defaults are always offered', allGroups().join('|') === 'Players|Class 1-A');

  const teacher = addPerson('Oshiro Daikichi', 'Teachers');
  check('an added person keeps the category they were given', teacher._group === 'Teachers');
  check('a category other than Players is not a PC', teacher.is_pc === false);
  check('a new category exists once someone is in it', allGroups().includes('Teachers'));
  check('the defaults stay pinned in front',
        allGroups()[0] === PLAYERS_GROUP && allGroups()[1] === CLASS_GROUP);
  check('the category is saved with the sheet',
        buildBundle().characters[teacher._file]._group === 'Teachers');
  check('the category picks the avatar colour', avClassOf(teacher) === 'av-teacher');
  check('an unnamed category gets the neutral avatar',
        avClassOf({ _group: 'Support Staff' }) === 'av-supporting');

  const player = addPerson('Kinji Hamakida', PLAYERS_GROUP);
  check('adding into Players marks them a PC', player.is_pc === true);
  check('the list is ordered by category, then roster order',
        CHARACTERS.map(groupOf).join('|') === 'Players|Players|Class 1-A|Teachers');

  const kibi = CHARACTERS.find(c => c.name === 'Kibi');
  setGroup(kibi, PLAYERS_GROUP);
  check('a category change carries is_pc with it', kibi.is_pc === true);
  check('a category change is unsaved until Save is clicked', _dirtyCharFiles.has('a.json'));
  check('a category change re-sorts the list',
        CHARACTERS.indexOf(kibi) < CHARACTERS.findIndex(c => groupOf(c) === 'Teachers'));

  setGroup(teacher, CLASS_GROUP);
  check('a category nobody is in stops existing', !allGroups().includes('Teachers'));

  // A category set in another tab has to arrive like any other sheet field.
  _dirtyCharFiles = new Map();
  const remote = { version: 1, relationships: {}, characters: {
    'p.json': { name: 'Ren', is_pc: false, _group: 'Villains' },
    'a.json': { name: 'Kibi', is_pc: true, _group: PLAYERS_GROUP } } };
  remote.characters[teacher._file] = { name: 'Oshiro Daikichi', _custom: true,
                                       _roster_id: teacher._roster_id, _group: 'Teachers' };
  remote.characters[player._file]  = { name: 'Kinji Hamakida', _custom: true,
                                       _roster_id: player._roster_id, _group: PLAYERS_GROUP };
  applyRemoteRelBundle(remote);
  check("another tab's category change arrives here",
        groupOf(CHARACTERS.find(c => c._file === 'p.json')) === 'Villains');
  check('and it brings the heading back with it', allGroups().includes('Villains'));
})();

// ── Scenario I: editing a character who has no ability_scores ──────────────
// Hiro reached the live bundle as a stub: name, quirk and a couple of fields,
// no ability_scores and no modifiers. The sheet still renders seven inputs for
// him, because renderProfile falls back to 10 per stat — so the score looks
// editable, the edit throws on the way in, nothing is marked dirty, and the
// next render puts 10 back. It reads as "the page refuses to save my stats".
(function () {
  CHARACTERS = [
    { _file: 'hiro.json', _roster_id: 20, _section: 'class-1a', name: 'Hiro', quirk: 'Doll' },
  ];
  selected = CHARACTERS[0];
  _dirtyCharFiles = new Map();

  let threw = null;
  try { onAbilityScoreChange('STR', '14'); } catch (e) { threw = e; }

  check('editing a stat on a scoreless character does not throw', threw === null);
  check('the typed score is kept', (selected.ability_scores || {}).STR === 14);
  check('its modifier is derived', (selected.modifiers || {}).STR === 2);
  check('and the edit is marked dirty so Save can send it',
        _dirtyCharFiles.has('hiro.json'));

  // A second stat must not wipe the first — the lazy create has to be a
  // create-if-missing, not a reset.
  onAbilityScoreChange('CHA', '8');
  check('a second stat leaves the first alone', selected.ability_scores.STR === 14);
  check('the second stat lands too', selected.ability_scores.CHA === 8);
  check('a negative modifier is derived correctly', selected.modifiers.CHA === -1);
})();

// ── Scenario H: collapsing a category ──────────────────────────────────────
// Members of a shut category stay in the DOM on purpose — filterList reaches
// into them — so "collapsed" has to be visible in the markup and in the
// stored state, not inferred from who got rendered.
(function () {
  CHARACTERS = [
    { _file: 'p.json', _roster_id: 1,    _section: 'class-1a', name: 'Ren',    is_pc: true },
    { _file: 'a.json', _roster_id: 2,    _section: 'class-1a', name: 'Kibi',   is_pc: false },
    { _file: 't.json', _roster_id: 1000, _section: 'class-1a', name: 'Oshiro',
      _group: 'Teachers', _custom: true },
  ];
  selected = CHARACTERS[0];
  els['char-list'].innerHTML = '';

  check('categories start open', isGroupCollapsed(CLASS_GROUP) === false);

  toggleGroup(allGroups().indexOf(CLASS_GROUP));
  check('a category can be shut', isGroupCollapsed(CLASS_GROUP) === true);
  check('collapsing one leaves the others alone', isGroupCollapsed('Teachers') === false);
  // toggleGroup repaints through refreshSidebar, which this harness stubs out
  // along with the rest of the render layer — so draw it here.
  renderSidebar();
  check('the shut category says so in the markup',
        /char-group collapsed/.test(els['char-list'].innerHTML));
  check('its heading reports it shut',
        /aria-expanded="false"/.test(els['char-list'].innerHTML));
  check('its members are still rendered, for search to reach',
        els['char-list'].innerHTML.includes('Kibi'));
  check('the heading carries a head-count', /group-count">1</.test(els['char-list'].innerHTML));

  renderSidebar();
  check('the state survives a re-render',
        /char-group collapsed/.test(els['char-list'].innerHTML));

  toggleGroup(allGroups().indexOf(CLASS_GROUP));
  check('and it opens again', isGroupCollapsed(CLASS_GROUP) === false);

  // The index comes from a rendered handler; a list that has since changed
  // must not throw.
  toggleGroup(99);
  check('an index that no longer exists is a safe no-op', isGroupCollapsed(CLASS_GROUP) === false);
})();

// ── Scenario C: dirty state drives the Save button and unload warning ───────
(function () {
  _dirtyRelKeys = new Map(); _dirtyCharFiles = new Map(); _relSavePending = false;
  refreshSaveBar();
  check('isDirty() false when clean', isDirty() === false);
  check('save button disabled when clean', els['rel-save-btn'].disabled === true);
  markCharDirty('a.json');
  check('isDirty() true after a character edit', isDirty() === true);
  check('save button enabled when dirty', els['rel-save-btn'].disabled === false);
})();
`;

eval(appSrc + '\n;' + testSrc);

let allPass = true;
for (const [name, ok] of results) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) allPass = false;
}
if (typeof process !== 'undefined') process.exit(allPass ? 0 : 1);
undefined; // avoid osascript auto-printing a trailing value
