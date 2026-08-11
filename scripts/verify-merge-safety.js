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
for (const name of ['isPlainObject', 'getAtPath', 'setAtPath', 'deepMergeLocalOverServer']) {
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

let allPass = true;
for (const [name, ok] of results) {
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!ok) allPass = false;
}
if (typeof process !== 'undefined') process.exit(allPass ? 0 : 1);
undefined; // avoid osascript auto-printing a trailing true/false after the PASS/FAIL lines
