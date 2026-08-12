#!/usr/bin/env node
// Regression check for auth.js's fsMergeSave — there's no test runner in
// this project (static HTML/JS, no package.json), so this is a standalone,
// dependency-free script instead of a proper test suite. Run it with any JS
// engine: `node scripts/verify-merge-safety.js`, or on macOS without Node,
// `osascript -l JavaScript scripts/verify-merge-safety.js` (this file
// intentionally avoids Node-only APIs beyond readFileSync/process, so it
// runs under both — see the readFile() shim below).
//
// What it guards against: fsMergeSave is the one thing standing between
// concurrent editors and silent data loss (see the "Merge-save for shared
// documents" comment in auth.js). This script re-runs the exact scenario
// that used to fail — two clients save around the same time, one adds an
// item to a nested array, the other edits something unrelated on a stale
// local copy — and fails loudly if the fix ever regresses.

const fs = typeof require === 'function' ? require('fs') : null;
const path = typeof require === 'function' ? require('path') : null;

function readFile(p) {
  if (fs) return fs.readFileSync(p, 'utf8');
  // JXA fallback (osascript -l JavaScript), no `require` available.
  const url = $.NSURL.fileURLWithPath(p);
  return ObjC.unwrap($.NSString.stringWithContentsOfURLEncodingError(url, $.NSUTF8StringEncoding, null));
}

const repoRoot = path ? path.join(__dirname, '..') : (typeof $ !== 'undefined' ? '.' : '.');
const authPath = (path ? path.join(repoRoot, 'auth.js') : 'auth.js');
const authSrc = readFile(authPath);

const helpers = {};
for (const name of ['isPlainObject', 'getAtPath', 'setAtPath', 'deepMergeLocalOverServer', 'cloneDoc']) {
  const m = authSrc.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}'));
  if (!m) throw new Error('Could not find ' + name + '() in auth.js — has fsMergeSave changed shape?');
  eval(m[0]);
  helpers[name] = eval(name);
}

// Mirrors fsMergeSave's transaction-body logic (the part that matters here;
// the surrounding db.runTransaction plumbing needs a live Firestore to test
// and isn't what these scenarios are checking).
function mergeCompute(server, localDoc, lastSyncedDoc, idArrays) {
  const result = helpers.deepMergeLocalOverServer(server, localDoc);
  for (const { path: p, idKey } of idArrays) {
    const serverArr = Array.isArray(helpers.getAtPath(server, p)) ? helpers.getAtPath(server, p) : [];
    const localArr = Array.isArray(helpers.getAtPath(localDoc, p)) ? helpers.getAtPath(localDoc, p) : [];
    const lastArr = Array.isArray(helpers.getAtPath(lastSyncedDoc, p)) ? helpers.getAtPath(lastSyncedDoc, p) : [];
    const lastById = new Map(lastArr.map((item) => [item[idKey], item]));
    const localById = new Map(localArr.map((item) => [item[idKey], item]));
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

const results = [];

// Scenario 1: nested path (relationships.html's per-character shape —
// filenames contain literal dots, which is why path must be an array of
// segments, not a dotted string).
(function nestedPathScenario() {
  const initial = { characters: { 'ren_suzuki.json': { HP: 24, quirk_mechanics: { abilities: [{ id: 'ab1', name: 'Punch' }] } } } };
  const idArrays = [{ path: ['characters', 'ren_suzuki.json', 'quirk_mechanics', 'abilities'], idKey: 'id' }];
  const a = JSON.parse(JSON.stringify(initial));
  a.characters['ren_suzuki.json'].quirk_mechanics.abilities.push({ id: 'ab2', name: 'Kick' });
  let server = mergeCompute(initial, a, initial, idArrays);
  const b = JSON.parse(JSON.stringify(initial));
  b.characters['ren_suzuki.json'].HP = 18;
  server = mergeCompute(server, b, initial, idArrays);
  const abilities = server.characters['ren_suzuki.json'].quirk_mechanics.abilities;
  const ok = abilities.some(x => x.name === 'Kick') && abilities.some(x => x.name === 'Punch') && server.characters['ren_suzuki.json'].HP === 18;
  results.push(['nested per-character array path', ok]);
})();

// Scenario 2: backward compat — existing top-level string-path callers
// (board.html/encounter.html combatants, campaigns.html campaigns, etc.)
// must behave identically after the nested-path generalization.
(function topLevelPathScenario() {
  const initial = { round: 1, combatants: [{ id: 'c1', hp: 20 }] };
  const idArrays = [{ path: 'combatants', idKey: 'id' }];
  const dm = JSON.parse(JSON.stringify(initial));
  dm.combatants.push({ id: 'c2', hp: 30 });
  let server = mergeCompute(initial, dm, initial, idArrays);
  const player = JSON.parse(JSON.stringify(initial));
  player.combatants[0].hp = 15;
  server = mergeCompute(server, player, initial, idArrays);
  const ids = server.combatants.map(c => c.id).sort().join(',');
  const ok = ids === 'c1,c2' && server.combatants[0].hp === 15 && server.round === 1;
  results.push(['top-level string path (backward compat)', ok]);
})();

// ── Apply-remote path (CLASS-1A/relationships.js) ───────────────────────────
// fsMergeSave above guards the *write* path. The bug where a user's typing got
// silently reverted lived on the *apply* path — an incoming live snapshot
// overwriting local state — which had no coverage at all, which is why three
// separate fixes to fsMergeSave never made the symptom go away. These extract
// the two pure helpers from relationships.html and pin that behaviour down.
const relPath = (path ? path.join(repoRoot, 'CLASS-1A', 'relationships.js') : 'CLASS-1A/relationships.js');
const relSrc = readFile(relPath);
const relHelpers = {};
for (const name of ['mergeRemoteRels', 'nextSyncBaseline']) {
  // Top-level (unindented) functions, so these end at a column-0 brace —
  // unlike auth.js's 2-space-indented helpers above.
  const m = relSrc.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('Could not find ' + name + '() in relationships.js — has the live-sync code changed shape?');
  eval(m[0]);
  relHelpers[name] = eval(name);
}

// Scenario 3: a live snapshot must not overwrite a note the user is still
// typing, while everything else on it still syncs through. This is the exact
// "what I just typed gets instantly undone" report.
(function dirtyRelKeyScenario() {
  const local = { '1:2': { score: 3, note: 'typed but not saved yet' }, '1:3': { score: 0, note: 'old' } };
  const incoming = { '1:2': { score: 3, note: '' }, '1:3': { score: 5, note: 'someone else edited this' } };
  const merged = relHelpers.mergeRemoteRels(local, incoming, new Set(['1:2']));
  const ok = merged['1:2'].note === 'typed but not saved yet'
          && merged['1:3'].note === 'someone else edited this';
  results.push(['dirty rel key survives an incoming snapshot', ok]);
})();

// Scenario 4: a relationship another client created, that this client has
// never seen, must appear rather than being dropped by the merge.
(function remoteAddedRelScenario() {
  const local = { '1:2': { score: 1, note: 'mine' } };
  const incoming = { '1:2': { score: 1, note: 'mine' }, '4:5': { score: -2, note: 'theirs' } };
  const merged = relHelpers.mergeRemoteRels(local, incoming, new Set(['1:2']));
  const ok = merged['4:5'] && merged['4:5'].note === 'theirs' && merged['1:2'].note === 'mine';
  results.push(['remote-added rel key is preserved', ok]);
})();

// Scenario 5: the 3-way baseline must NOT advance for a character we skipped
// because it had unsaved local edits. If it did, fsMergeSave would next see an
// ability present in the baseline but absent locally, read that as "this client
// deleted it", and drop another player's newly added attack.
(function baselineSkipsDirtyCharScenario() {
  const prev = { characters: { 'a.json': { HP: 10, quirk_mechanics: { abilities: [{ id: 'ab1' }] } } } };
  const incoming = { characters: {
    'a.json': { HP: 10, quirk_mechanics: { abilities: [{ id: 'ab1' }, { id: 'ab2' }] } }, // dirty locally — skipped
    'b.json': { HP: 22 }                                                                  // clean — applied
  } };
  const baseline = relHelpers.nextSyncBaseline(incoming, prev, new Set(['a.json']));
  const ok = baseline.characters['a.json'].quirk_mechanics.abilities.length === 1  // held at prev
          && baseline.characters['b.json'].HP === 22;                              // advanced
  results.push(['sync baseline holds back for a dirty character', ok]);
})();

// Scenario 6: a dirty character with no previous baseline entry must be absent
// from the new baseline, not carried in from the snapshot we didn't apply.
(function baselineDropsUnseenDirtyCharScenario() {
  const incoming = { characters: { 'new.json': { HP: 5 } } };
  const baseline = relHelpers.nextSyncBaseline(incoming, null, new Set(['new.json']));
  const ok = !('new.json' in baseline.characters);
  results.push(['sync baseline omits an unseen dirty character', ok]);
})();

// ── Baseline aliasing (the "edit an attack, hit Save, it reverts" bug) ──────
// Scenarios 1-2 above deep-copy their inputs, so they never exercised the way
// the *page* builds its baseline: relationships.js shallow-copies each
// character out of the loaded bundle and then kept that same bundle as
// _lastSyncedRel. Local and baseline were one object graph, so editing an
// attack edited the baseline too, mergeCompute's changedLocally test read
// "unchanged", and the server's older copy was written back over the edit.
// These two build the baseline exactly the way the page does — sharing
// sub-objects with the live copy unless cloneDoc() detaches it.
const abilitiesPath = [{ path: ['characters', 'a.json', 'quirk_mechanics', 'abilities'], idKey: 'id' }];

// Mirrors relationships.js's init: the client receives its own copy of the
// server document, shallow-copies each character out of it (so sub-objects
// stay shared with the received bundle), and takes a *cloned* baseline.
// `server` stays a separate object graph throughout, as it really is.
function loadLikeThePage(server) {
  const bundle = JSON.parse(JSON.stringify(server)); // what Firestore handed this client
  const live = Object.assign({}, bundle.characters['a.json']);
  return { local: { characters: { 'a.json': live } }, baseline: helpers.cloneDoc(bundle), live };
}
function serverWithOneAttack() {
  return { characters: { 'a.json': { quirk_mechanics: { abilities: [{ id: 'ab1', name: 'Punch' }] } } } };
}

// Scenario 7: an edit to an existing attack must reach the server, not be
// reverted to the server's copy.
(function editedAttackSurvivesSaveScenario() {
  const server = serverWithOneAttack();
  const { local, baseline, live } = loadLikeThePage(server);
  live.quirk_mechanics.abilities[0].name = 'Super Punch';
  const saved = mergeCompute(server, local, baseline, abilitiesPath);
  const ok = saved.characters['a.json'].quirk_mechanics.abilities[0].name === 'Super Punch';
  results.push(['edited attack survives its own save', ok]);
})();

// Scenario 8: a newly added attack must not be swallowed by the "only truly
// new items get added" rule because it also appeared in an aliased baseline.
(function addedAttackSurvivesSaveScenario() {
  const server = serverWithOneAttack();
  const { local, baseline, live } = loadLikeThePage(server);
  live.quirk_mechanics.abilities.push({ id: 'ab2', name: 'Kick' });
  const saved = mergeCompute(server, local, baseline, abilitiesPath);
  const names = saved.characters['a.json'].quirk_mechanics.abilities.map(a => a.name).sort().join(',');
  results.push(['newly added attack survives its own save', names === 'Kick,Punch']);
})();

// Scenario 9: fsMergeSave's return value is what every caller stores as its
// next baseline, so it must not alias the local doc it was built from —
// otherwise the *second* edit-then-save on a page hits scenario 7's bug again.
(function returnedBaselineIsDetachedScenario() {
  const src = readFile(authPath);
  const returnsClone = /tx\.set\(docRef, result\);[\s\S]*?return cloneDoc\(result\);/.test(src);
  results.push(['fsMergeSave returns a detached baseline', returnsClone]);
})();

let allPass = true;
for (const [name, ok] of results) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) allPass = false;
}
if (typeof process !== 'undefined') process.exit(allPass ? 0 : 1);
undefined; // avoid osascript auto-printing a trailing true/false after the PASS/FAIL lines
