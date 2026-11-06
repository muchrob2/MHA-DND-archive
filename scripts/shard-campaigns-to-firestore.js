#!/usr/bin/env node
/* One-time migration: split the single `mha-dnd/campaigns` document into a
 * manifest plus one content document per campaign.
 *
 * Why: all campaigns shared one document and that document hit Firestore's
 * 1 MiB ceiling. The third season took the encoded payload to 1015 KB of
 * 1024, so the next chapter could not be published at all. The limit is per
 * document, so splitting the array inside it would have bought nothing.
 *
 * After this runs:
 *   mha-dnd/campaigns              { sharded: true, campaigns: [ metadata ] }
 *   mha-dnd/campaign-<id>          { id, background, chapters, appendix, links }
 *
 * Each campaign then has its own 1 MiB. The largest today is 640 KB.
 *
 * firestore.rules needs no change: `match /mha-dnd/{doc}` already grants
 * read-to-all and admin-or-editor write to any document directly under
 * mha-dnd/, and these are siblings. (A subcollection would NOT be covered.)
 *
 * Order matters. The shards are written first and verified, and the manifest
 * — which is what flips the client into sharded mode — is written last. Until
 * that final write the site keeps reading the old fat document and nothing
 * has changed for anybody. If this script dies halfway, the shards are
 * unreferenced and harmless, and re-running it is safe.
 *
 * Usage:
 *   node scripts/shard-campaigns-to-firestore.js            # dry run
 *   node scripts/shard-campaigns-to-firestore.js --write
 *   node scripts/shard-campaigns-to-firestore.js --rollback [--write]
 *
 * Auth comes from the Firebase CLI's own stored credentials. Run any firebase
 * command (`firebase projects:list`) first if the token has expired.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT = 'mha-dnd-archive';
const COLLECTION = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/mha-dnd`;
const DOC = `${COLLECTION}/campaigns`;

const doWrite = process.argv.includes('--write');
const rollback = process.argv.includes('--rollback');

const CONTENT_KEYS = ['background', 'chapters', 'appendix', 'links'];
const LIMIT = 1024 * 1024;

/* ── Firestore REST value codec (same shape as the push scripts) ─────────── */
function encode(v, trail = '$') {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) {
    v.forEach((el, i) => {
      if (Array.isArray(el)) throw new Error(`nested array at ${trail}[${i}] — Firestore cannot store this`);
    });
    return { arrayValue: { values: v.map((el, i) => encode(el, `${trail}[${i}]`)) } };
  }
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = encode(val, `${trail}.${k}`);
    return { mapValue: { fields } };
  }
  throw new Error(`unsupported type ${typeof v} at ${trail}`);
}
function decode(v) {
  const k = Object.keys(v)[0];
  const x = v[k];
  switch (k) {
    case 'mapValue': return Object.fromEntries(Object.entries(x.fields || {}).map(([a, b]) => [a, decode(b)]));
    case 'arrayValue': return (x.values || []).map(decode);
    case 'integerValue': return Number(x);
    case 'doubleValue': return Number(x);
    case 'booleanValue': return x;
    case 'nullValue': return null;
    default: return x;
  }
}

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

/* ── Auth: reuse the Firebase CLI's stored token ─────────────────────────── */
function accessToken() {
  const cfg = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(cfg)) throw new Error('no Firebase CLI credentials found — run `firebase login`');
  const tokens = JSON.parse(fs.readFileSync(cfg, 'utf8')).tokens || {};
  if (!tokens.access_token) throw new Error('no access token — run `firebase projects:list` to refresh it');
  return tokens.access_token;
}

/* ── Shape helpers, mirroring campaigns.js ───────────────────────────────── */
function manifestEntry(c) {
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (CONTENT_KEYS.includes(k)) continue;
    out[k] = v;
  }
  out.chapterCount = (c.chapters || []).length;
  return out;
}
function shardDoc(c) {
  const out = { id: c.id };
  for (const k of CONTENT_KEYS) if (c[k] !== undefined) out[k] = c[k];
  return out;
}
const payloadSize = obj => JSON.stringify({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encode(v)])) }).length;

async function main() {
  const auth = { Authorization: `Bearer ${accessToken()}` };

  const getRes = await fetch(DOC, { headers: auth });
  if (!getRes.ok) throw new Error(`read failed: HTTP ${getRes.status} ${(await getRes.text()).slice(0, 400)}`);
  const raw = await getRes.json();
  const live = Object.fromEntries(Object.entries(raw.fields || {}).map(([a, b]) => [a, decode(b)]));
  const campaigns = live.campaigns || [];
  if (!campaigns.length) throw new Error('the live document has no campaigns — refusing to do anything');

  console.log(`live doc updateTime  : ${raw.updateTime}`);
  console.log(`live campaigns       : ${campaigns.length}`);
  console.log(`currently sharded    : ${live.sharded ? 'yes' : 'no'}`);

  // Always back the whole live document up first, in both directions.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(__dirname, '..', `.firestore-backup-campaigns-${stamp}.json`);

  /* ── Rollback: reassemble the fat document from the shards ────────────── */
  if (rollback) {
    if (!live.sharded) throw new Error('the live document is not sharded — nothing to roll back');
    const whole = [];
    for (const entry of campaigns) {
      const r = await fetch(`${COLLECTION}/campaign-${entry.id}`, { headers: auth });
      if (!r.ok) throw new Error(`cannot read content for "${entry.id}" (HTTP ${r.status}) — refusing a lossy rollback`);
      const content = Object.fromEntries(Object.entries((await r.json()).fields || {}).map(([a, b]) => [a, decode(b)]));
      const c = { ...entry };
      delete c.chapterCount;
      for (const k of CONTENT_KEYS) if (content[k] !== undefined) c[k] = content[k];
      whole.push(c);
    }
    const size = payloadSize({ campaigns: whole });
    console.log(`reassembled payload  : ${(size / 1024).toFixed(0)} KB${size > LIMIT ? '  *** OVER THE 1 MiB LIMIT — rollback would be rejected ***' : ''}`);
    if (size > LIMIT) throw new Error('the content no longer fits in one document; rollback is not possible');
    fs.writeFileSync(backup, JSON.stringify(live, null, 1));
    console.log(`backup written to    : ${path.relative(process.cwd(), backup)}`);
    if (!doWrite) { console.log('\nDRY RUN — nothing written. Re-run with --write to commit.'); return; }
    const res = await fetch(`${DOC}?updateMask.fieldPaths=campaigns&updateMask.fieldPaths=sharded`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { campaigns: encode(whole) } }),
    });
    if (!res.ok) throw new Error(`rollback failed: HTTP ${res.status} ${(await res.text()).slice(0, 600)}`);
    console.log('\nROLLED BACK — one fat document again. The shards are left in place, unreferenced.');
    return;
  }

  /* ── Migrate ──────────────────────────────────────────────────────────── */
  if (live.sharded) throw new Error('already sharded — the manifest carries sharded:true. Nothing to do.');

  const manifest = { sharded: true, campaigns: campaigns.map(manifestEntry) };
  const shards = campaigns.map(shardDoc);

  const manifestSize = payloadSize(manifest);
  console.log(`\nmanifest             : ${(manifestSize / 1024).toFixed(1)} KB`);
  console.log('content documents    :');
  let worst = 0;
  for (const s of shards) {
    const size = payloadSize(s);
    worst = Math.max(worst, size);
    const pct = ((size / LIMIT) * 100).toFixed(0);
    console.log(`  ${(size / 1024).toFixed(0).padStart(5)} KB  (${pct.padStart(3)}% of its own 1 MiB)  campaign-${s.id}`);
    if (size > LIMIT) throw new Error(`"${s.id}" alone exceeds 1 MiB — it must be split before this can work`);
  }
  console.log(`\nwas                  : ${(payloadSize({ campaigns }) / 1024).toFixed(0)} KB in one document, ${((LIMIT - payloadSize({ campaigns })) / 1024).toFixed(0)} KB spare`);
  console.log(`now                  : largest single document ${(worst / 1024).toFixed(0)} KB, ${((LIMIT - worst) / 1024).toFixed(0)} KB spare in it`);

  // Nothing is lost: every campaign must come back out of manifest + shard
  // byte-identical to what went in.
  const check = manifest.campaigns.map(entry => {
    const c = { ...entry };
    delete c.chapterCount;
    const shard = shards.find(s => s.id === entry.id);
    for (const k of CONTENT_KEYS) if (shard[k] !== undefined) c[k] = shard[k];
    return c;
  });
  const lost = [];
  for (const orig of campaigns) {
    const back = check.find(c => c.id === orig.id);
    if (!same(orig, back)) lost.push(orig.id);
  }
  if (lost.length) throw new Error(`refusing to write: these would not round-trip — ${lost.join(', ')}`);
  console.log(`round-trip           : all ${campaigns.length} campaigns reassemble byte-identical`);

  fs.writeFileSync(backup, JSON.stringify(live, null, 1));
  console.log(`backup written to    : ${path.relative(process.cwd(), backup)}`);

  if (!doWrite) { console.log('\nDRY RUN — nothing written. Re-run with --write to commit.'); return; }

  // Content first. Until the manifest is written the site still reads the old
  // fat document, so a failure here changes nothing for anybody.
  for (const s of shards) {
    const res = await fetch(`${COLLECTION}/campaign-${s.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, encode(v)])) }),
    });
    if (!res.ok) throw new Error(`writing campaign-${s.id} failed: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    console.log(`  wrote campaign-${s.id}`);
  }

  // Read every shard back before committing the switch.
  for (const s of shards) {
    const r = await fetch(`${COLLECTION}/campaign-${s.id}`, { headers: auth });
    if (!r.ok) throw new Error(`verify failed for campaign-${s.id}: HTTP ${r.status}`);
    const back = Object.fromEntries(Object.entries((await r.json()).fields || {}).map(([a, b]) => [a, decode(b)]));
    if (!same(back, s)) throw new Error(`campaign-${s.id} did not come back identical — refusing to switch the manifest over`);
  }
  console.log('  all content documents verified');

  // The switch. `campaigns` is replaced wholesale with the metadata-only
  // array and `sharded` is set in the same write, so no client can ever see a
  // manifest that says sharded without the trimmed array, or vice versa.
  const res = await fetch(`${DOC}?updateMask.fieldPaths=campaigns&updateMask.fieldPaths=sharded`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { campaigns: encode(manifest.campaigns), sharded: encode(true) } }),
  });
  if (!res.ok) throw new Error(`writing the manifest failed: HTTP ${res.status} ${(await res.text()).slice(0, 600)}`);

  console.log('\nMIGRATED. The site is now reading a manifest and one document per campaign.');
  console.log('Roll back with --rollback --write while everything still fits in one document.');
}

main().catch(e => { console.error('\nFAILED — ' + e.message); process.exit(1); });
