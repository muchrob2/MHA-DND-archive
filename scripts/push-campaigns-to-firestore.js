#!/usr/bin/env node
/* Push and/or remove SEVERAL campaigns in the live Firestore doc in one write.
 *
 * Why this exists alongside push-campaign-to-firestore.js: that script does
 * exactly one campaign and refuses to write if any other entry would change,
 * which is the right guarantee for a routine content update. It cannot express
 * a restructure — splitting one campaign into two, or retiring a superseded one
 * — because those touch more than one entry at once and have to land together
 * or not at all. This script does that, and keeps the same safety properties
 * where they still apply: it names every change before making it, refuses to
 * touch an entry nobody asked about, and backs the whole live doc up first.
 *
 * Every campaign named with --push must exist in CAMPAIGN/campaigns.json and is
 * written from there. Every campaign named with --delete must NOT exist there,
 * so that "deleted from the repo" and "deleted from the site" cannot drift
 * apart. Anything not named either way must come out byte-identical.
 *
 * Auth comes from the Firebase CLI's own stored credentials. Run any firebase
 * command (`firebase projects:list`) first if the token has expired.
 *
 * Usage:
 *   node scripts/push-campaigns-to-firestore.js --push a,b --delete c
 *   node scripts/push-campaigns-to-firestore.js --push a,b --delete c --write
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT = 'mha-dnd-archive';
const DOC = 'mha-dnd/campaigns';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${DOC}`;

function listArg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return [];
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${flag} needs a comma-separated list of campaign ids`);
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

const pushIds = listArg('--push');
const deleteIds = listArg('--delete');
const doWrite = process.argv.includes('--write');

if (!pushIds.length && !deleteIds.length) {
  console.error('usage: node scripts/push-campaigns-to-firestore.js --push <id,...> [--delete <id,...>] [--write]');
  process.exit(2);
}
const both = pushIds.filter(id => deleteIds.includes(id));
if (both.length) throw new Error(`cannot push and delete the same id: ${both.join(', ')}`);

// ── Firestore REST value codec (shared shape with the single-campaign script) ─
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
    case 'nullValue': return null;
    default: return x;
  }
}

function accessToken() {
  const p = path.join(os.homedir(), '.config/configstore/firebase-tools.json');
  if (!fs.existsSync(p)) throw new Error('firebase-tools credentials not found — run `firebase login`');
  const t = JSON.parse(fs.readFileSync(p, 'utf8')).tokens || {};
  if (!t.access_token) throw new Error('no access token — run `firebase login`');
  if (t.expires_at && t.expires_at < Date.now()) {
    throw new Error('access token expired — run any firebase command (e.g. `firebase projects:list`) to refresh it, then retry');
  }
  return t.access_token;
}

(async () => {
  const repoPath = path.join(__dirname, '..', 'CAMPAIGN', 'campaigns.json');
  const local = JSON.parse(fs.readFileSync(repoPath, 'utf8'));
  const localCampaigns = local.campaigns || [];

  const entries = pushIds.map(id => {
    const e = localCampaigns.find(c => c.id === id);
    if (!e) throw new Error(`no campaign with id "${id}" in CAMPAIGN/campaigns.json`);
    return e;
  });

  // A delete that is still in the repo would be undone by the next push, and
  // the static fallback would keep serving it. Make the two agree first.
  const stillLocal = deleteIds.filter(id => localCampaigns.some(c => c.id === id));
  if (stillLocal.length) {
    throw new Error(`refusing to delete: still present in CAMPAIGN/campaigns.json — ${stillLocal.join(', ')}. Remove it from the repo file first.`);
  }

  const token = accessToken();
  const auth = { Authorization: `Bearer ${token}` };

  const getRes = await fetch(BASE, { headers: auth });
  if (!getRes.ok) throw new Error(`read failed: HTTP ${getRes.status} ${(await getRes.text()).slice(0, 400)}`);
  const raw = await getRes.json();
  const live = Object.fromEntries(Object.entries(raw.fields || {}).map(([a, b]) => [a, decode(b)]));
  const liveCampaigns = live.campaigns || [];

  // Back the live document up before proposing to change it.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(__dirname, '..', `.firestore-backup-campaigns-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(live, null, 1));

  const before = liveCampaigns.map(c => c.id);
  const missingDeletes = deleteIds.filter(id => !before.includes(id));

  // Replace in place where the id already exists, so unrelated ordering holds.
  const merged = liveCampaigns
    .filter(c => !deleteIds.includes(c.id))
    .map(c => entries.find(e => e.id === c.id) || c);
  for (const e of entries) {
    if (!merged.some(c => c.id === e.id)) merged.push(e);
  }

  // Every campaign nobody named must come out byte-identical.
  const named = new Set([...pushIds, ...deleteIds]);
  for (const c of merged) {
    if (named.has(c.id)) continue;
    const orig = liveCampaigns.find(o => o.id === c.id);
    if (JSON.stringify(orig) !== JSON.stringify(c)) throw new Error(`refusing to write: "${c.id}" would change`);
  }

  const body = { fields: { campaigns: encode(merged, '$.campaigns') } };
  const payload = JSON.stringify(body);

  const action = id => (before.includes(id) ? 'REPLACE' : 'APPEND ');
  console.log(`live doc updateTime  : ${raw.updateTime}`);
  console.log(`backup written to    : ${path.relative(process.cwd(), backup)}`);
  console.log(`live campaigns before: ${before.join(', ')}`);
  console.log(`live campaigns after : ${merged.map(c => c.id).join(', ')}`);
  for (const id of pushIds) console.log(`  ${action(id)}          : "${id}"`);
  for (const id of deleteIds) console.log(`  DELETE           : "${id}"`);
  if (missingDeletes.length) console.log(`  (already absent) : ${missingDeletes.join(', ')}`);
  console.log(`payload              : ${(payload.length / 1024).toFixed(0)} KB (Firestore doc limit is 1 MiB)`);
  if (payload.length > 1024 * 1024) throw new Error('payload exceeds the 1 MiB document limit');

  if (!doWrite) {
    console.log('\nDRY RUN — nothing written. Re-run with --write to commit.');
    return;
  }

  const res = await fetch(`${BASE}?updateMask.fieldPaths=campaigns`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: payload,
  });
  if (!res.ok) throw new Error(`write failed: HTTP ${res.status} ${(await res.text()).slice(0, 600)}`);

  const check = await (await fetch(BASE, { headers: auth })).json();
  const after = decode(check.fields.campaigns).map(c => c.id);
  console.log(`\nWRITTEN. updateTime now ${check.updateTime}`);
  console.log(`live campaigns: ${after.join(', ')}`);

  const notWritten = pushIds.filter(id => !after.includes(id));
  if (notWritten.length) throw new Error(`verification failed — not in the document: ${notWritten.join(', ')}`);
  const notRemoved = deleteIds.filter(id => after.includes(id));
  if (notRemoved.length) throw new Error(`verification failed — still in the document: ${notRemoved.join(', ')}`);
})().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
