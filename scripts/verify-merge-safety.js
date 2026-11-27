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
for (const name of ['isPlainObject', 'getAtPath', 'setAtPath', 'deepMergeLocalOverServer', 'cloneDoc', 'orderMergedLikeLocal']) {
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
    const localCount = new Map();
    for (const item of localArr) localCount.set(item[idKey], (localCount.get(item[idKey]) || 0) + 1);
    const merged = [], seen = new Set();
    for (const item of serverArr) {
      const id = item[idKey];
      // A duplicate already in the stored array: keep it if this client holds a
      // duplicate too (it has not repaired), drop it if this client holds one.
      if (seen.has(id)) { if ((localCount.get(id) || 0) > 1) merged.push(item); continue; }
      seen.add(id);
      const hadLocally = localById.has(id), wasSyncedBefore = lastById.has(id);
      if (!hadLocally) { if (!wasSyncedBefore) merged.push(item); continue; }
      const changedLocally = JSON.stringify(localById.get(id)) !== JSON.stringify(lastById.get(id));
      merged.push(changedLocally ? localById.get(id) : item);
    }
    for (const item of localArr) { const id = item[idKey]; if (!seen.has(id) && !lastById.has(id)) merged.push(item); }
    helpers.setAtPath(result, p, helpers.orderMergedLikeLocal(merged, localArr, lastArr, idKey));
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

// Scenario 9b: mergeCompute above is a hand-written mirror of fsMergeSave, so
// the duplicate-id skip that scenarios 17-22 turn on has to actually be in
// auth.js and not just in the mirror.
(function mergeSkipsDuplicateServerIdsScenario() {
  const src = readFile(authPath);
  const skips = /for \(const item of serverArr\) \{[\s\S]*?if \(seen\.has\(id\)\) \{[\s\S]*?localCount\.get\(id\)[\s\S]*?\}[\s\S]*?seen\.add\(id\);/.test(src);
  results.push(['fsMergeSave skips a duplicate id in the stored array', skips]);
})();

// Scenario 9: fsMergeSave's return value is what every caller stores as its
// next baseline, so it must not alias the local doc it was built from —
// otherwise the *second* edit-then-save on a page hits scenario 7's bug again.
(function returnedBaselineIsDetachedScenario() {
  const src = readFile(authPath);
  const returnsClone = /tx\.set\(docRef, result\);[\s\S]*?return cloneDoc\(result\);/.test(src);
  results.push(['fsMergeSave returns a detached baseline', returnsClone]);
})();

// ── Array order (the "the initiative sort undoes itself" bug) ──────────────
// Sorting moves items without changing them, so scenarios 1-2's content merge
// has nothing to notice: every combatant compares equal to its baseline and
// the server's copy is taken for each. Before orderMergedLikeLocal the merged
// array therefore came back in the server's order, the sorted list was written
// back unsorted, and the live listener replayed that over the DM's screen a
// second or two after they pressed Sort.
const combatantsPath = [{ path: 'combatants', idKey: 'id' }];
function rosterInInitiativeOrder() {
  return { round: 1, currentIndex: 0, combatants: [
    { id: 'c1', name: 'Ren', initiative: 4 },
    { id: 'c2', name: 'Kinji', initiative: 19 },
    { id: 'c3', name: 'Nomu', initiative: 11 },
  ] };
}

// Scenario 10: a pure reorder — no item's contents change at all — must reach
// the server, because the order *is* the change.
(function sortSurvivesItsOwnSaveScenario() {
  const server = rosterInInitiativeOrder();
  const baseline = helpers.cloneDoc(server);
  const local = helpers.cloneDoc(server);
  local.combatants.sort((a, b) => b.initiative - a.initiative);
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const order = saved.combatants.map(c => c.id).join(',');
  results.push(['initiative sort survives its own save', order === 'c2,c3,c1']);
})();

// Scenario 11: a client that did NOT reorder must not push its own stale order
// back over somebody else's sort — the mirror image of scenario 10, and the
// reason the local order only wins when it differs from the baseline.
(function remoteSortIsNotUndoneScenario() {
  const baseline = rosterInInitiativeOrder();
  const server = helpers.cloneDoc(baseline);
  server.combatants.sort((a, b) => b.initiative - a.initiative); // the DM sorted
  const local = helpers.cloneDoc(baseline);                      // a player, still unsorted
  local.combatants[0].name = 'Ren Suzuki';                       // editing something unrelated
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const order = saved.combatants.map(c => c.id).join(',');
  const ok = order === 'c2,c3,c1' && saved.combatants[2].name === 'Ren Suzuki';
  results.push(['a remote sort is not undone by an unrelated edit', ok]);
})();

// Scenario 12: a combatant somebody else added while this client was sorting
// must still arrive, and must not be sorted out of existence for having no
// place in the local order.
(function sortKeepsRemotelyAddedCombatantScenario() {
  const baseline = rosterInInitiativeOrder();
  const server = helpers.cloneDoc(baseline);
  server.combatants.push({ id: 'c4', name: 'Thug', initiative: 7 }); // added elsewhere
  const local = helpers.cloneDoc(baseline);
  local.combatants.sort((a, b) => b.initiative - a.initiative);
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const order = saved.combatants.map(c => c.id).join(',');
  results.push(['a remotely added combatant survives a local sort', order === 'c2,c3,c1,c4']);
})();

// Scenario 13: rolling initiative changes every item *and* reorders them, so
// the two halves of the merge have to agree — the new numbers and the order
// they imply must both land.
(function rollAllInitiativeScenario() {
  const server = rosterInInitiativeOrder();
  const baseline = helpers.cloneDoc(server);
  const local = helpers.cloneDoc(server);
  local.combatants[0].initiative = 20; // Ren rolled high
  local.combatants[1].initiative = 2;
  local.combatants[2].initiative = 9;
  local.combatants.sort((a, b) => b.initiative - a.initiative);
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const order = saved.combatants.map(c => c.id).join(',');
  const ok = order === 'c1,c3,c2' && saved.combatants[0].initiative === 20;
  results.push(['roll-all-initiative lands values and order together', ok]);
})();

// ── Combatant ids (the "I add a character and it's instantly removed" bug) ──
// The merge above keys the combatants array by id, which only works if an id
// means one combatant. encounter.js used a plain ++counter that started over at
// 1 on every page load, so the first combatant added after a reload was handed
// an id the server was already using: the two collapsed into one item, the
// roster came back no longer than it went in, and a row vanished seconds after
// the DM added someone.
const encPath = (path ? path.join(repoRoot, 'CLASS-1A', 'encounter.js') : 'CLASS-1A/encounter.js');
const encSrc = readFile(encPath);
{
  // A one-line function, body and all, so match it on a single line.
  const m = encSrc.match(/^function encId\(\).*$/m);
  if (!m) throw new Error('Could not find encId() in encounter.js — has the id generator changed shape?');
  eval(m[0]);
}

// Scenario 14: the report itself. An encounter saved in an earlier session,
// reloaded (so the id generator starts from scratch), plus one combatant added
// — every combatant that was there must still be there, and the new one too.
(function addedCombatantSurvivesAfterReloadScenario() {
  const server = { round: 3, currentIndex: 0, combatants: [
    { id: 1, name: 'Ren' }, { id: 2, name: 'Kinji' }, { id: 3, name: 'Nomu' },
  ] };
  const baseline = helpers.cloneDoc(server); // encLoad(): what the server handed this page
  const local = helpers.cloneDoc(server);
  local.combatants.push({ id: encId(), name: 'Toga' }); // encAddFromRoster()
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const names = saved.combatants.map(c => c.name).sort().join(',');
  results.push(['a combatant added after a reload survives its own save', names === 'Kinji,Nomu,Ren,Toga']);
})();

// Scenario 15: and again for a run of adds — the enemy picker pushes a whole
// squad in one go, each of which used to land on a successive legacy id.
(function addedSquadSurvivesAfterReloadScenario() {
  const server = { round: 1, currentIndex: 0, combatants: [
    { id: 1, name: 'Ren' }, { id: 2, name: 'Kinji' },
  ] };
  const baseline = helpers.cloneDoc(server);
  const local = helpers.cloneDoc(server);
  for (let i = 1; i <= 4; i++) local.combatants.push({ id: encId(), name: 'Thug #' + i }); // encAddEnemy(), qty 4
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const ids = new Set(saved.combatants.map(c => c.id));
  results.push(['a squad added after a reload keeps every member and every original',
    saved.combatants.length === 6 && ids.size === 6]);
})();

// Scenario 16: the generator itself must carry no per-load state to restart —
// that's what makes two page loads (or the encounter tab and the board tab,
// the normal way this gets run) safe from handing out the same id, which a
// counter starting at 1 in each of them guarantees they do. Drawing a run of
// ids and requiring them all distinct, and all outside the range of the legacy
// sequential ids, pins both halves of that down.
(function idsAreGloballyUniqueScenario() {
  const all = new Set();
  for (let i = 0; i < 1000; i++) all.add(encId());
  const clearOfLegacyIds = all.size === 1000 && [...all].every(id => Number.isSafeInteger(id) && id > 1000);
  results.push(['ids are unique across page loads and clear of legacy ids', clearOfLegacyIds]);
})();

// ── Duplicate ids already in the document (the "I move a token and it moves
// ── back, I change a team and it changes back" bug) ────────────────────────
// Two combatants sharing an id defeats both halves of the system: every board
// lookup is a find(c => c.id === id), which returns the first match, so an edit
// aimed at the second one lands on the first and the thing you touched redraws
// unchanged; and the merge keys the array by id, so it reverts from the server
// too. Duplicates reached the live document from encId()'s restarting counter
// and, before the merge existed, from a plain .set() of whatever a page held.
// encRepairDuplicateIds() re-ids them on the way in; fsMergeSave has to carry
// that repair through rather than multiplying the duplicate on every save.
const boardSharedPath = (path ? path.join(repoRoot, 'CLASS-1A', 'board-shared.js') : 'CLASS-1A/board-shared.js');
{
  const m = readFile(boardSharedPath).match(/function encRepairDuplicateIds\([\s\S]*?\n\}/);
  if (!m) throw new Error('Could not find encRepairDuplicateIds() in board-shared.js — has the repair changed shape?');
  eval(m[0].replace(/console\.warn\([^;]*\);/, '')); // no console in osascript
}

// A document holding two combatants on id 1, as the pre-merge .set() path left
// it. `enc` is what a page loads; the baseline is the raw server copy.
function docWithDuplicateIds() {
  return { round: 2, currentIndex: 0, combatants: [
    { id: 1, name: 'Ren',  boardX: 3, boardY: 4, team: null },
    { id: 1, name: 'Toga', boardX: 7, boardY: 2, team: null },
    { id: 2, name: 'Nomu', boardX: 5, boardY: 5, team: null },
  ] };
}

// Scenario 17: the repair itself — every combatant survives with an id of its
// own, and the ids are derived from the document, not drawn at random, so two
// tabs repairing the same document independently agree.
(function repairGivesEveryCombatantItsOwnIdScenario() {
  const a = docWithDuplicateIds(), b = docWithDuplicateIds();
  const n = encRepairDuplicateIds(a);
  encRepairDuplicateIds(b);
  const ids = a.combatants.map(c => c.id);
  const ok = n === 1
          && a.combatants.length === 3
          && new Set(ids).size === 3
          && a.combatants.map(c => c.name).join(',') === 'Ren,Toga,Nomu'
          && JSON.stringify(ids) === JSON.stringify(b.combatants.map(c => c.id)); // deterministic
  results.push(['duplicate ids are repaired deterministically, losing nobody', ok]);
})();

// Scenario 18: a move and a team change on the *first* of a duplicated pair —
// the copy whose edits used to be silently dropped — must now reach the server,
// and the repair must go with them.
(function editOnFirstDuplicateLandsScenario() {
  const server = docWithDuplicateIds();
  const baseline = helpers.cloneDoc(server); // taken before the repair, as the pages do
  const local = helpers.cloneDoc(server);
  encRepairDuplicateIds(local);
  local.combatants[0].boardX = 9; local.combatants[0].boardY = 9; local.combatants[0].team = 0;
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const ren = saved.combatants.find(c => c.name === 'Ren');
  const ok = saved.combatants.length === 3
          && new Set(saved.combatants.map(c => c.id)).size === 3
          && ren.boardX === 9 && ren.boardY === 9 && ren.team === 0;
  results.push(['a move+team edit on the first of a duplicated pair lands', ok]);
})();

// Scenario 19: the same edit on the *second* copy, which used to be the one
// that worked — it must keep working, and must not drag the first one with it.
(function editOnSecondDuplicateLandsScenario() {
  const server = docWithDuplicateIds();
  const baseline = helpers.cloneDoc(server);
  const local = helpers.cloneDoc(server);
  encRepairDuplicateIds(local);
  local.combatants[1].boardX = 9; local.combatants[1].boardY = 9; local.combatants[1].team = 0;
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const toga = saved.combatants.find(c => c.name === 'Toga');
  const ren = saved.combatants.find(c => c.name === 'Ren');
  const ok = saved.combatants.length === 3
          && toga.boardX === 9 && toga.team === 0
          && ren.boardX === 3 && ren.team === null;
  results.push(['a move+team edit on the second of a duplicated pair lands', ok]);
})();

// Scenario 20: the repair on its own, with nothing else changed, must persist —
// otherwise the document stays broken and the next load repairs it again.
(function bareRepairPersistsScenario() {
  const server = docWithDuplicateIds();
  const baseline = helpers.cloneDoc(server);
  const local = helpers.cloneDoc(server);
  encRepairDuplicateIds(local);
  const saved = mergeCompute(server, local, baseline, combatantsPath);
  const ok = saved.combatants.length === 3
          && new Set(saved.combatants.map(c => c.id)).size === 3
          && saved.combatants.map(c => c.name).sort().join(',') === 'Nomu,Ren,Toga';
  results.push(['the repair persists through a save of its own', ok]);
})();

// Scenario 21: the trap this was nearly written into — walking both copies of a
// duplicated id makes each of them look up the same single local item and push
// it, so one combatant comes back as two and multiplies on every save. A second
// save must be a fixed point.
(function duplicateDoesNotMultiplyScenario() {
  const server = docWithDuplicateIds();
  const stale = helpers.cloneDoc(server); // a tab that has not repaired anything
  const saved = mergeCompute(server, stale, helpers.cloneDoc(server), combatantsPath);
  const again = mergeCompute(saved, helpers.cloneDoc(saved), helpers.cloneDoc(saved), combatantsPath);
  const names = (arr) => arr.map(c => c.name).sort().join(',');
  const ok = names(saved.combatants) === 'Nomu,Ren,Toga' && names(again.combatants) === 'Nomu,Ren,Toga';
  results.push(['a stored duplicate does not multiply across saves', ok]);
})();

// Scenario 22: two tabs that repaired the same document independently must not
// turn the repaired combatant into two rows — the reason the new id is derived
// from the document rather than random.
(function twoTabsRepairToTheSameIdScenario() {
  const server = docWithDuplicateIds();
  const baseline = helpers.cloneDoc(server);
  const tabA = helpers.cloneDoc(server); encRepairDuplicateIds(tabA);
  const tabB = helpers.cloneDoc(server); encRepairDuplicateIds(tabB);
  let saved = mergeCompute(server, tabA, baseline, combatantsPath);
  tabB.combatants[2].team = 1;                                   // tab B then edits Nomu
  saved = mergeCompute(saved, tabB, baseline, combatantsPath);
  const ok = saved.combatants.filter(c => c.name === 'Toga').length === 1
          && saved.combatants.length === 3
          && saved.combatants.find(c => c.name === 'Nomu').team === 1;
  results.push(['two tabs repairing the same document agree on the new id', ok]);
})();

// ── The apply path: "it refreshes before I've finished and undoes it" ──────
// Everything above guards the *write* path. This last group guards the other
// half — what happens when a live snapshot lands while a local change has
// not reached the server yet — which is where the surviving report lived:
// a change made on the battle board reverting itself a second later.
//
// The pages deferred snapshots "while a save is pending", and pendingness was
// a boolean set by encSave() and cleared in that save's own `finally`. A
// second change made after the first save's timer fired but before its write
// resolved therefore had its pendingness cleared by the *first* save, and
// the first save's own echo — which the listener always delivers — arrived
// with nothing to defer it and replaced the change with the state before it.
// boardMakeSaveGate's header in board-shared.js has the full timeline.
const gateHelpers = {};
for (const name of ['boardMakeSaveGate', 'boardGateDirty', 'boardGateSettled', 'boardGateWrote',
                    'boardGateSavePending', 'boardGateStampSnapshot', 'boardGateSnapshotIsStale',
                    'boardStableJson', 'boardSameDoc']) {
  const m = readFile(boardSharedPath).match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('Could not find ' + name + '() in board-shared.js — has the save gate changed shape?');
  eval(m[0]);
  gateHelpers[name] = eval(name);
}

// Scenario 23: an older write settling must not clear a newer change's claim
// on the gate. This is the boolean bug reduced to three lines.
(function olderWriteDoesNotClearNewerEditScenario() {
  const gate = boardMakeSaveGate();
  const a = boardGateDirty(gate);  // edit A, save A armed
  const b = boardGateDirty(gate);  // edit B, made while save A is mid-write
  boardGateWrote(gate, a);         // save A lands — the old boolean cleared here
  const stillPending = boardGateSavePending(gate);
  boardGateWrote(gate, b);
  results.push(['an older write settling does not clear a newer edit',
    stillPending && !boardGateSavePending(gate)]);
})();

// Scenario 24: a write that failed (encounter-state is admin-only, so a
// non-admin tab's writes are rejected outright) must settle too. If it didn't
// the gate would stay shut and the page would never take another update.
// It must not pretend anything landed, either: the next snapshot is the one
// that corrects the screen, so it cannot be dated away as stale.
(function failedWriteDoesNotWedgeTheGateScenario() {
  const gate = boardMakeSaveGate();
  const seq = boardGateDirty(gate);
  boardGateSettled(gate, seq); // the catch branch
  const ok = !boardGateSavePending(gate)
          && gate.lastWriteAt === 0
          && !boardGateSnapshotIsStale(gate, boardGateStampSnapshot(gate));
  results.push(['a failed write settles the gate without dating snapshots away', ok]);
})();

// Scenario 25: a snapshot that arrived while our write was in flight carries
// nothing that write's own transaction didn't already merge, so applying it
// afterwards would only undo the write. One that arrives after it must still
// go through.
(function deferredSnapshotFromBeforeOurWriteIsStaleScenario() {
  const gate = boardMakeSaveGate();
  const seq = boardGateDirty(gate);
  const early = boardGateStampSnapshot(gate); // held back by the pending save
  boardGateWrote(gate, seq);
  const late = boardGateStampSnapshot(gate);
  results.push(['a snapshot predating our own write is stale, a later one is not',
    boardGateSnapshotIsStale(gate, early) && !boardGateSnapshotIsStale(gate, late)]);
})();

// Scenario 26: the listener delivers a snapshot for every commit, this tab's
// own included, and re-applying one replaces `encounter` wholesale and
// re-renders — throwing the initiative list's scroll position and open rows
// away for a document the page already has. Firestore returns the document in
// its own key order, so the comparison has to sort keys; insertion-order
// JSON.stringify would call every echo a change and re-render on all of them.
(function ourOwnEchoIsRecognisedScenario() {
  const mine = { round: 2, currentIndex: 1, combatants: [{ id: 'c1', boardX: 5, team: null }] };
  const echo = { combatants: [{ team: null, boardX: 5, id: 'c1' }], currentIndex: 1, round: 2 };
  const news = { round: 2, currentIndex: 1, combatants: [{ id: 'c1', boardX: 6, team: null }] };
  results.push(['our own echo is recognised regardless of key order',
    boardSameDoc(mine, echo) && !boardSameDoc(mine, news)]);
})();

// A fake page and a fake server, stepped by hand so the interleaving is
// reproducible rather than a matter of network timing. The client mirrors
// encounter.js: encSave() claims a seq and arms the debounce, the debounce's
// write merges through mergeCompute (what fsMergeSave runs) and settles the
// gate, and the listener either applies a snapshot or defers it with the
// stamp it arrived on. Commit and resolution are separate steps because they
// really are: the echo is generated when the write lands on the server, which
// is before the client hears back about it.
function makeWorld(doc) {
  return { doc: helpers.cloneDoc(doc), feed: [] }; // feed: snapshots not yet handed to the listener
}
function makeClient(world, opts) {
  const writeFails = !!(opts && opts.writeFails);
  const c = {
    enc: helpers.cloneDoc(world.doc),
    baseline: helpers.cloneDoc(world.doc),
    gate: boardMakeSaveGate(),
    armed: null,    // the debounced save, waiting to fire
    writing: null,  // the write, in flight
    deferred: null,
  };
  c.busy = () => boardGateSavePending(c.gate); // the real pages also defer mid-drag/mid-typing
  c.encSave = () => { c.armed = boardGateDirty(c.gate); }; // clearTimeout: only the latest timer survives
  c.debounceFires = () => {
    if (c.armed === null) return;
    c.writing = { seq: c.armed, local: helpers.cloneDoc(c.enc), baseline: helpers.cloneDoc(c.baseline) };
    c.armed = null;
  };
  c.writeCommits = () => {
    if (writeFails) return;
    const w = c.writing;
    w.merged = mergeCompute(world.doc, w.local, w.baseline, combatantsPath);
    world.doc = helpers.cloneDoc(w.merged);
    world.feed.push(helpers.cloneDoc(w.merged)); // the echo, on its way to every listener
  };
  c.writeResolves = () => {
    const w = c.writing;
    c.writing = null;
    if (writeFails) { boardGateSettled(c.gate, w.seq); return; }
    c.baseline = helpers.cloneDoc(w.merged);
    boardGateWrote(c.gate, w.seq);
  };
  c.deliver = () => { // onSnapshot
    if (!world.feed.length) return;
    const data = world.feed.shift();
    const stamp = boardGateStampSnapshot(c.gate);
    if (c.busy()) { c.deferred = { data, stamp }; return; }
    c.apply(data);
  };
  c.drain = () => { // the 800ms interval
    if (!c.deferred || c.busy()) return;
    const { data, stamp } = c.deferred;
    c.deferred = null;
    if (boardGateSnapshotIsStale(c.gate, stamp)) return;
    c.apply(data);
  };
  c.apply = (data) => { // applyRemoteEncounter
    if (boardSameDoc(data, c.baseline)) return;
    c.enc = data;
    c.baseline = helpers.cloneDoc(data);
  };
  return c;
}
function twoTokensAtOne() {
  return { round: 1, currentIndex: 0, combatants: [
    { id: 'c1', name: 'Ren', boardX: 1, boardY: 1 },
    { id: 'c2', name: 'Nomu', boardX: 1, boardY: 2 },
  ] };
}

// Scenario 27: the report itself, at the pace it actually happens — two moves
// about three quarters of a second apart, the second landing while the first
// is still being written. The second must stay on screen and must reach the
// server.
(function editDuringAnInFlightSaveSurvivesScenario() {
  const world = makeWorld(twoTokensAtOne());
  const dm = makeClient(world);

  dm.enc.combatants[0].boardX = 5; dm.encSave(); // t=0    drag Ren
  dm.debounceFires();                            // t=600  save A starts writing
  dm.enc.combatants[1].boardX = 9; dm.encSave(); // t=650  drag Nomu
  dm.writeCommits();                             // t=790  save A lands; its echo is queued
  dm.writeResolves();                            // t=800  save A resolves
  dm.deliver();                                  // t=850  the echo — predates Nomu's move
  dm.drain();
  const keptOnScreen = dm.enc.combatants[1].boardX === 9;

  dm.debounceFires(); dm.writeCommits(); dm.writeResolves(); // t=1250 save B
  dm.deliver(); dm.drain();
  const onServer = world.doc.combatants.find(c => c.id === 'c2').boardX === 9;
  const renToo = world.doc.combatants.find(c => c.id === 'c1').boardX === 5;
  results.push(['a move made while the previous save is in flight is not reverted',
    keptOnScreen && onServer && renToo]);
})();

// Scenario 28: the mirror image — the deferral must not swallow news. A move
// somebody else makes has to reach the screen, including when it arrives
// while a save of this tab's own is pending (it waits, then applies).
(function remoteMoveStillReachesTheScreenScenario() {
  const world = makeWorld(twoTokensAtOne());
  const dm = makeClient(world);

  world.doc.combatants[0].boardX = 7;                  // a player moves Ren in their tab
  world.feed.push(helpers.cloneDoc(world.doc));
  dm.deliver(); dm.drain();
  const appliedIdle = dm.enc.combatants[0].boardX === 7;

  dm.enc.combatants[1].boardX = 4; dm.encSave();       // this tab is now mid-save
  world.doc.combatants[0].boardY = 8;                  // and the player moves Ren again
  world.feed.push(helpers.cloneDoc(world.doc));
  dm.deliver();                                        // deferred, not dropped
  const held = dm.enc.combatants[0].boardY === 1 && !!dm.deferred;
  dm.debounceFires(); dm.writeCommits(); dm.writeResolves();
  dm.drain();                                          // stale now — save B merged it in
  const mergedIn = world.doc.combatants.find(c => c.id === 'c1').boardY === 8
                && world.doc.combatants.find(c => c.id === 'c2').boardX === 4;
  results.push(['a remote move reaches the screen, and survives a concurrent local save',
    appliedIdle && held && mergedIn]);
})();

// Scenario 29: a tab whose writes are rejected (a player's, under
// firestore.rules) must keep taking updates rather than freezing on the gate.
(function rejectedWriteStillTakesUpdatesScenario() {
  const world = makeWorld(twoTokensAtOne());
  const player = makeClient(world, { writeFails: true });
  player.enc.combatants[0].boardX = 5; player.encSave();
  player.debounceFires(); player.writeCommits(); player.writeResolves(); // rejected

  world.doc.combatants[1].boardX = 6;                  // the DM moves Nomu
  world.feed.push(helpers.cloneDoc(world.doc));
  player.deliver(); player.drain();
  results.push(['a tab whose writes are rejected still takes live updates',
    player.enc.combatants[1].boardX === 6]);
})();

// Scenario 30: both pages have to actually drive the gate — the scenarios
// above test the mechanism, not its wiring, and the bug was in the wiring.
// Nothing may still be keeping the boolean, either.
(function bothPagesDriveTheSaveGateScenario() {
  const boardPath = (path ? path.join(repoRoot, 'CLASS-1A', 'board.js') : 'CLASS-1A/board.js');
  for (const [label, src] of [['encounter.js', encSrc], ['board.js', readFile(boardPath)]]) {
    const ok = /const encSaveGate = boardMakeSaveGate\(\)/.test(src)
            && /const seq = boardGateDirty\(encSaveGate\)/.test(src)
            && /boardGateWrote\(encSaveGate, seq\)/.test(src)
            && /boardGateSettled\(encSaveGate, seq\)/.test(src)
            && /boardGateSavePending\(encSaveGate\)/.test(src)
            && /boardGateStampSnapshot\(encSaveGate\)/.test(src)
            && /boardGateSnapshotIsStale\(encSaveGate, stamp\)/.test(src)
            && /boardSameDoc\(data, _lastSyncedEncounter\)/.test(src)
            && !/_encSavePending/.test(src);
    results.push([label + ' drives the save gate on every path', ok]);
  }
})();

let allPass = true;
for (const [name, ok] of results) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) allPass = false;
}
if (typeof process !== 'undefined') process.exit(allPass ? 0 : 1);
undefined; // avoid osascript auto-printing a trailing true/false after the PASS/FAIL lines
