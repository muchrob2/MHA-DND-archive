#!/usr/bin/env node
/* Push one campaign from CAMPAIGN/campaigns.json into the live Firestore doc.
 *
 * Why this exists: campaigns.js:46 reads mha-dnd/campaigns from Firestore and
 * only falls back to the JSON file when that doc is missing. Editing the file
 * therefore has no effect on the live site — the campaign has to be written to
 * the document as well.
 *
 * The live doc is authoritative and is NOT a copy of the repo file: it carries
 * campaigns that exist nowhere else (hand-written ones added through the app)
 * and edited versions of the ones that are in the repo. So this script appends
 * or replaces exactly one campaign by id and leaves every other entry byte-for-
 * byte as it found it. It never uploads the repo's copy of the whole array.
 *
 * Auth comes from the Firebase CLI's own stored credentials — the script reads
 * them at run time; nothing else ever handles the token. Run `firebase login`
 * first if the token has expired.
 *
 * Usage:
 *   node scripts/push-campaign-to-firestore.js <campaign-id>            # dry run
 *   node scripts/push-campaign-to-firestore.js <campaign-id> --write    # commit
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT = 'mha-dnd-archive';
const DOC = 'mha-dnd/campaigns';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${DOC}`;

const campaignId = process.argv[2];
const doWrite = process.argv.includes('--write');
if (!campaignId) {
  console.error('usage: node scripts/push-campaign-to-firestore.js <campaign-id> [--write]');
  process.exit(2);
}

// ── Firestore REST value codec ─────────────────────────────────────────────
// Firestore refuses an array directly inside an array, so this asserts rather
// than silently producing a document the API will reject with a vague error.
function encode(v, trail = '$') {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
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
  const entry = (local.campaigns || []).find(c => c.id === campaignId);
  if (!entry) throw new Error(`no campaign with id "${campaignId}" in CAMPAIGN/campaigns.json`);

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
  const idx = liveCampaigns.findIndex(c => c.id === campaignId);
  const merged = liveCampaigns.slice();
  if (idx >= 0) merged[idx] = entry; else merged.push(entry);

  // Every campaign other than the target must be untouched.
  for (const c of merged) {
    if (c.id === campaignId) continue;
    const orig = liveCampaigns.find(o => o.id === c.id);
    if (JSON.stringify(orig) !== JSON.stringify(c)) throw new Error(`refusing to write: "${c.id}" would change`);
  }

  const body = { fields: { campaigns: encode(merged, '$.campaigns') } };
  const payload = JSON.stringify(body);

  console.log(`live doc updateTime : ${raw.updateTime}`);
  console.log(`backup written to   : ${path.relative(process.cwd(), backup)}`);
  console.log(`live campaigns before: ${before.join(', ')}`);
  console.log(`live campaigns after : ${merged.map(c => c.id).join(', ')}`);
  console.log(`action              : ${idx >= 0 ? 'REPLACE existing' : 'APPEND new'} "${campaignId}"`);
  console.log(`payload             : ${(payload.length / 1024).toFixed(0)} KB (Firestore doc limit is 1 MiB)`);
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
  if (!after.includes(campaignId)) throw new Error('verification failed — campaign is not in the document');
})().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
