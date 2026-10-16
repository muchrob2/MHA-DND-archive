#!/usr/bin/env node
/* File the Byakko and Underground cast into one folder per faction on the
 * Characters tab.
 *
 * The companion to import-underground-cast.js. That script puts the cast into
 * CAMPAIGN/villains.json, which is all the Characters tab needs to show them;
 * this one puts them in folders, which villains.json cannot express. Folder
 * membership lives in Firestore as a per-character override document keyed by
 * fbCharacterKey(type, name) — "Villain::<name>" — merged over the static
 * record at load time, with the folders themselves in mha-dnd/character-folders.
 *
 * Unlike the supporting NPCs, these characters have no Firestore document yet:
 * this creates one per character carrying nothing but the folderId. Tags are
 * not written here — the cast carries its "After Hours" tag in villains.json.
 *
 * Folder colours come from FOLDER_COLORS in characters.js. An off-palette hex
 * still renders, but folderColorInfo() falls back to a grey tint for it and
 * loses the tuned text/background pairing, so the factions' own colours from
 * villains.json are deliberately not reused here.
 *
 * Safe to run before the villains.json change is merged and deployed: a
 * folderId for a character the static files do not yet carry simply sits
 * there until it does.
 *
 * Usage:
 *   node scripts/file-underground-cast.js            # dry run
 *   node scripts/file-underground-cast.js --write    # commit
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT = 'mha-dnd-archive';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FOLDERS_DOC = `${ROOT}/mha-dnd/character-folders`;

const doWrite = process.argv.includes('--write');

// faction name in villains.json -> folder name + colour (from FOLDER_COLORS).
const FOLDERS = {
  'Byakko':         { name: 'Byakko',         color: '#8A9BB0' },
  'Scarlet Legion': { name: 'Scarlet Legion', color: '#EF4444' },
  'Astral Court':   { name: 'Astral Court',   color: '#E8A020' },
  'Kuroshiki':      { name: 'Kuroshiki',      color: '#8B47D4' },
};

function encode(v, trail = '$') {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((el, i) => encode(el, `${trail}[${i}]`)) } };
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

// Matches submitCreateFolder() in characters.js.
const newFolderId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const docUrl = id => `${ROOT}/characters/${encodeURIComponent(id)}`;

(async () => {
  const villains = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'CAMPAIGN', 'villains.json'), 'utf8'));

  const targets = [];
  for (const f of villains.factions || []) {
    const spec = FOLDERS[f.name];
    if (!spec) continue;
    for (const v of f.villains || []) {
      targets.push({ docId: `Villain::${v.name}`, name: v.name, faction: f.name, folderName: spec.name });
    }
  }
  if (!targets.length) throw new Error('no Byakko/Underground factions in CAMPAIGN/villains.json — is this running from the right branch?');
  for (const want of Object.keys(FOLDERS)) {
    if (!targets.some(t => t.faction === want)) throw new Error(`faction "${want}" is missing from villains.json`);
  }

  const token = accessToken();
  const auth = { Authorization: `Bearer ${token}` };

  const foldersRes = await fetch(FOLDERS_DOC, { headers: auth });
  if (!foldersRes.ok) throw new Error(`folder read failed: HTTP ${foldersRes.status} ${(await foldersRes.text()).slice(0, 400)}`);
  const foldersRaw = await foldersRes.json();
  const liveFolders = decode(foldersRaw.fields.folders);

  // Read any document that already exists for these characters.
  for (const t of targets) {
    const res = await fetch(docUrl(t.docId), { headers: auth });
    if (res.ok) {
      const raw = await res.json();
      t.live = Object.fromEntries(Object.entries(raw.fields || {}).map(([a, b]) => [a, decode(b)]));
      t.existed = true;
    } else if (res.status === 404) {
      t.live = {};
      t.existed = false;
    } else {
      throw new Error(`read of "${t.docId}" failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, '..', `.firestore-backup-underground-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    takenAt: new Date().toISOString(),
    foldersDoc: { updateTime: foldersRaw.updateTime, folders: liveFolders },
    characters: targets.filter(t => t.existed).map(t => ({ docId: t.docId, data: t.live })),
  }, null, 1));

  // Preconditions: don't collide with a folder that exists, and don't move a
  // character somebody has already filed somewhere.
  for (const spec of Object.values(FOLDERS)) {
    const clash = Object.entries(liveFolders).find(([, f]) => f.name === spec.name);
    if (clash) throw new Error(`refusing to write: a folder named "${spec.name}" already exists (${clash[0]})`);
  }
  for (const t of targets) {
    const current = (t.live.fields || {}).folderId;
    if (current) throw new Error(`refusing to write: "${t.docId}" is already filed in folder ${current}`);
  }

  const nameToId = {};
  const merged = Object.assign({}, liveFolders);
  for (const spec of Object.values(FOLDERS)) {
    const id = newFolderId();
    nameToId[spec.name] = id;
    merged[id] = { name: spec.name, color: spec.color };
  }
  for (const [id, f] of Object.entries(liveFolders)) {
    if (JSON.stringify(merged[id]) !== JSON.stringify(f)) throw new Error(`refusing to write: folder "${f.name}" would change`);
  }

  console.log(`folders doc updateTime : ${foldersRaw.updateTime}`);
  console.log(`backup written to      : ${path.relative(process.cwd(), backupPath)}`);
  console.log(`\nfolders before : ${Object.values(liveFolders).map(f => f.name).sort().join(', ')}`);
  console.log(`folders after  : ${Object.values(merged).map(f => f.name).sort().join(', ')}`);
  console.log(`characters     : ${targets.length} (${targets.filter(t => t.existed).length} already have a Firestore doc)`);
  for (const spec of Object.values(FOLDERS)) {
    const mine = targets.filter(t => t.folderName === spec.name);
    console.log(`\n${spec.name} (${mine.length})`);
    for (const t of mine) console.log(`  ${t.docId}`);
  }

  if (!doWrite) {
    console.log('\nDRY RUN — nothing written. Re-run with --write to commit.');
    return;
  }

  const fRes = await fetch(`${FOLDERS_DOC}?updateMask.fieldPaths=folders`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { folders: encode(merged, '$.folders') } }),
  });
  if (!fRes.ok) throw new Error(`folder write failed: HTTP ${fRes.status} ${(await fRes.text()).slice(0, 600)}`);
  console.log(`\nfolders written (${Object.keys(FOLDERS).length} new)`);

  for (const t of targets) {
    const res = await fetch(`${docUrl(t.docId)}?updateMask.fieldPaths=fields.folderId`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { fields: encode({ folderId: nameToId[t.folderName] }, `$.${t.docId}`) } }),
    });
    if (!res.ok) throw new Error(`write of "${t.docId}" failed: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    console.log(`  filed ${t.docId.padEnd(42)} -> ${t.folderName}`);
  }

  const checkFolders = decode((await (await fetch(FOLDERS_DOC, { headers: auth })).json()).fields.folders);
  for (const spec of Object.values(FOLDERS)) {
    if (!Object.values(checkFolders).some(f => f.name === spec.name)) throw new Error(`verification failed — folder "${spec.name}" is missing`);
  }
  for (const t of targets) {
    const raw = await (await fetch(docUrl(t.docId), { headers: auth })).json();
    const live = Object.fromEntries(Object.entries(raw.fields || {}).map(([a, b]) => [a, decode(b)]));
    if ((live.fields || {}).folderId !== nameToId[t.folderName]) throw new Error(`verification failed — "${t.docId}" folderId is ${(live.fields||{}).folderId}`);
  }

  console.log('\nWRITTEN and verified.');
  console.log(`folders now: ${Object.values(checkFolders).map(f => f.name).sort().join(', ')}`);
})().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
