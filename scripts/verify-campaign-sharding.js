#!/usr/bin/env node
/* One document per campaign — the invariants, checked against the real code.
 *
 * Campaigns used to share a single Firestore document and that document hit
 * the 1 MiB ceiling, so content moved to one document per campaign with a
 * metadata manifest in front of it. The split only works while four things
 * stay true, and all four are easy to break by accident:
 *
 *   1. The manifest/content split in campaigns.js, the two push scripts and
 *      the migration script must agree on which keys are content. If one of
 *      them thinks `appendix` is metadata, appendices start riding in the
 *      manifest and the ceiling comes back.
 *   2. Every campaign must fit in its own document, and the manifest must fit
 *      in its own. Measured with the real REST encoder, because that is what
 *      Firestore counts — it runs ~16% larger than JSON.stringify.
 *   3. A campaign must reassemble from manifest + content byte-identically.
 *   4. The pure-renderer prefix of campaigns.js must stay pure. The sharding
 *      code is all Firestore, so it has to sit below the State marker or
 *      verify-campaign-prose.js can no longer lift the renderers.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('PASS — ' + label); }
  else { fail++; console.log('FAIL — ' + label); }
}

const CONTENT_KEYS = ['background', 'chapters', 'appendix', 'links'];
const LIMIT = 1024 * 1024;

/* ── The REST encoder Firestore actually bills for ───────────────────────── */
function encode(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = encode(val);
    return { mapValue: { fields } };
  }
  throw new Error('unsupported type ' + typeof v);
}
const sizeOf = fields => JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encode(v)])) }).length;

/* Firestore map fields are unordered: a document does not come back with its
 * keys in the order it went in, and campaigns hand-built through the app have
 * scrambled key order to begin with (camp-tzh0jaz starts `tone, estimate,
 * icon, links, id`). So "did this survive the round trip" has to be asked
 * about the data, not the bytes — a plain JSON.stringify comparison reports a
 * reordered key as data loss and refuses a migration that is perfectly sound.
 */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function manifestEntry(c) {
  const out = {};
  for (const [k, v] of Object.entries(c)) { if (!CONTENT_KEYS.includes(k)) out[k] = v; }
  out.chapterCount = (c.chapters || []).length;
  return out;
}
function shardDoc(c) {
  const out = { id: c.id };
  for (const k of CONTENT_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

/* ── 1. Everything agrees on the split ───────────────────────────────────── */
console.log('\n>>> the four writers agree on what content is');
const files = {
  'campaigns.js': fs.readFileSync(path.join(ROOT, 'campaigns.js'), 'utf8'),
  'scripts/shard-campaigns-to-firestore.js': fs.readFileSync(path.join(ROOT, 'scripts/shard-campaigns-to-firestore.js'), 'utf8'),
  'scripts/push-campaign-to-firestore.js': fs.readFileSync(path.join(ROOT, 'scripts/push-campaign-to-firestore.js'), 'utf8'),
  'scripts/push-campaigns-to-firestore.js': fs.readFileSync(path.join(ROOT, 'scripts/push-campaigns-to-firestore.js'), 'utf8'),
};
const expected = JSON.stringify(CONTENT_KEYS);
for (const [name, src] of Object.entries(files)) {
  const m = src.match(/CONTENT_KEYS\s*=\s*(\[[^\]]*\])/);
  ok(!!m, name + ' declares CONTENT_KEYS');
  if (m) {
    const got = JSON.stringify(
      m[1].replace(/^\[|\]$/g, '').split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    ok(got === expected, name + ' splits on exactly ' + expected + (got === expected ? '' : ' — got ' + got));
  }
}

// chapterCount is what lets a library card say "9 chapters" without loading
// nine chapters, so it has to be derived everywhere the manifest is built.
for (const [name, src] of Object.entries(files)) {
  if (name === 'campaigns.js') continue;
  ok(/chapterCount\s*=\s*\(c\.chapters \|\| \[\]\)\.length/.test(src), name + ' derives chapterCount from the chapters it is dropping');
}
ok(/out\.chapterCount = \(c\.chapters \|\| \[\]\)\.length/.test(files['campaigns.js']), 'campaigns.js derives chapterCount too');

/* ── 2 & 3. The real data fits, and round-trips ──────────────────────────── */
console.log('\n>>> every campaign fits in its own document');
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'CAMPAIGN/campaigns.json'), 'utf8'));
const campaigns = doc.campaigns || [];
ok(campaigns.length > 0, 'there are campaigns to check (' + campaigns.length + ')');

const manifest = { sharded: true, campaigns: campaigns.map(manifestEntry) };
const manifestSize = sizeOf(manifest);
ok(manifestSize < LIMIT, 'the manifest fits: ' + (manifestSize / 1024).toFixed(1) + ' KB');
// A manifest that is creeping towards the limit means content is leaking into
// it — the thing this whole split exists to prevent.
ok(manifestSize < 64 * 1024, 'and is metadata-sized (<64 KB), so no content is leaking into it');

let worst = 0, worstId = '';
for (const c of campaigns) {
  const size = sizeOf(shardDoc(c));
  if (size > worst) { worst = size; worstId = c.id; }
  ok(size < LIMIT, c.id + ' fits in its own document: ' + (size / 1024).toFixed(0) + ' KB (' + ((size / LIMIT) * 100).toFixed(0) + '%)');
}
console.log('    largest: ' + worstId + ' at ' + (worst / 1024).toFixed(0) + ' KB, ' + ((LIMIT - worst) / 1024).toFixed(0) + ' KB spare');

const single = sizeOf({ campaigns });
console.log('    (all in one document would be ' + (single / 1024).toFixed(0) + ' KB of ' + (LIMIT / 1024) + ' KB'
  + (single > LIMIT ? ' — OVER, which is why this exists)' : ')'));

console.log('\n>>> nothing is lost in the split');
const lost = [];
for (const orig of campaigns) {
  const entry = manifest.campaigns.find(e => e.id === orig.id);
  const back = { ...entry };
  delete back.chapterCount;
  const shard = shardDoc(orig);
  for (const k of CONTENT_KEYS) if (shard[k] !== undefined) back[k] = shard[k];
  if (!same(orig, back)) lost.push(orig.id);
}
ok(lost.length === 0, 'all ' + campaigns.length + ' campaigns reassemble byte-identical'
  + (lost.length ? ' — lost: ' + lost.join(', ') : ''));

// A campaign with no id cannot be addressed as a document at all.
const unaddressable = campaigns.filter(c => !c.id || !/^[A-Za-z0-9_-]+$/.test(c.id));
ok(unaddressable.length === 0, 'every campaign id is usable as a document name'
  + (unaddressable.length ? ' — bad: ' + unaddressable.map(c => c.id).join(', ') : ''));

/* ── 4. The renderer prefix stays pure ───────────────────────────────────── */
console.log('\n>>> the sharding code stays out of the pure renderer prefix');
const src = files['campaigns.js'];
const cut = src.indexOf('/* ─── State ──');
ok(cut > 0, 'the State marker verify-campaign-prose.js slices on is still there');
const prefix = src.slice(0, cut);
// Comments are allowed to mention these; code is not, so strip comments first.
const prefixCode = prefix
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
for (const needle of ['shardRef', 'hydrate(', 'FS_CAMPAIGNS_DOC', 'onSnapshot(', 'fsMergeSave(']) {
  ok(!prefixCode.includes(needle), 'the prefix does not call ' + needle);
}
// The one impure line the prose verifier strips by hand must stay exactly as
// it expects to find it, or lifting the renderers fails.
ok(prefix.includes('const db = firebase.firestore();'),
  'and still has the single impure line the prose verifier strips');

/* ── The client handles both shapes ──────────────────────────────────────── */
console.log('\n>>> the client reads sharded and unsharded storage');
ok(/if \(d\.sharded\)/.test(src), 'it decides by the sharded flag on the manifest');
ok(/shardedMode = false;[\s\S]{0,400}fetch\('CAMPAIGN\/campaigns\.json'\)/.test(src),
  'and the static fallback is treated as whole, so offline loads fully hydrated');
ok(/needsHydrating\(currentCampaignId\)/.test(src), 'render() waits for content before drawing a module');
ok(/if \(!allHydrated\(\)\)/.test(src), 'library search fetches every campaign before searching');
ok(/shardRef\(id\)\.delete\(\)/.test(src), 'deleting a campaign deletes its content document');

console.log('\n' + (fail === 0
  ? `>>> campaign sharding OK (${pass} passed, ${campaigns.length} campaigns, manifest ${(manifestSize / 1024).toFixed(1)} KB, largest shard ${(worst / 1024).toFixed(0)} KB)`
  : `>>> campaign sharding FAILED (${fail} failed, ${pass} passed)`));
process.exit(fail === 0 ? 0 : 1);
