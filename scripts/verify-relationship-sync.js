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
var localStorage = { getItem() { return null; }, setItem() {} };
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

  // Same for inventory.
  selected.inventory.items.reverse();
  onItemEdit('item-2', 'name', 'Lantern');
  check('item edit follows the id after a reorder',
        selected.inventory.items.find(i => i.id === 'item-2').name === 'Lantern');
  check('item edit does not touch the neighbour',
        selected.inventory.items.find(i => i.id === 'item-1').name === 'Rope');

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
