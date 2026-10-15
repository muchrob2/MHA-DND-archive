#!/usr/bin/env node
/* File the CAMPAIGN/npcs.json supporting cast into per-category folders on the
 * Characters tab, and tag each one "AI made".
 *
 * Why this exists: characters.js fetches CAMPAIGN/npcs.json statically, so the
 * 13 supporting NPCs already render on the tab — but a character's folder and
 * tags are not in the JSON. They live in Firestore as per-character override
 * documents (`characters/<_staticId>`, where _staticId is
 * fbCharacterKey(type, name) === "Supporting::<name>"), merged over the static
 * record at load time. Folders themselves live in mha-dnd/character-folders as
 * a map of id -> { name, color }.
 *
 * All 13 currently sit in the "AI made" folder. A character has exactly one
 * folderId, so filing them by category necessarily moves them out of it; the
 * "AI made" tag preserves that grouping, because the sidebar filters on tags
 * but not on category.
 *
 * Safety: the live folder map and all 13 character documents are backed up
 * before anything is written. The script refuses to run if an existing folder
 * would change, if a folder of the same name already exists, or if any NPC has
 * been re-filed somewhere other than "AI made" since this plan was made — any
 * of those means the live state is not what this script was written for.
 * Each character is patched with a field mask covering only fields.folderId and
 * fields.tags, so hand-edited overrides (Alucard's, for one) survive untouched.
 *
 * Auth comes from the Firebase CLI's own stored credentials, read at run time —
 * the same mechanism push-campaign-to-firestore.js uses.
 *
 * Usage:
 *   node scripts/file-supporting-npcs.js            # dry run
 *   node scripts/file-supporting-npcs.js --write     # commit
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT = 'mha-dnd-archive';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const FOLDERS_DOC = `${ROOT}/mha-dnd/character-folders`;

const doWrite = process.argv.includes('--write');

// The folder these 13 are expected to be in now. Anything else means someone
// has re-filed them and this plan no longer describes the live site.
const EXPECTED_FOLDER_NAME = 'AI made';
const TAG = 'AI made';

// category (from npcs.json) -> folder name + colour. Gold/Teal/Red/Blue/Gray are
// already spoken for by Class 1-A, Class 1-B, Villains, Teachers and AI made;
// Commission reuses Teachers' blue and Wildcard reuses grey, both deliberately.
const CATEGORY_FOLDERS = {
  'Pro Hero':                { name: 'Pro Heroes', color: '#F97316' },
  'Civilian':                { name: 'Civilians',  color: '#8B47D4' },
  'Student':                 { name: 'Students',   color: '#EC4899' },
  'Commission Official':     { name: 'Commission', color: '#3B82F6' },
  'Unaffiliated / Wildcard': { name: 'Wildcard',   color: '#8A9BB0' },
};

// ── Firestore REST value codec ─────────────────────────────────────────────
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

// Matches submitCreateFolder() in characters.js so ids look native to the app.
function newFolderId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const docUrl = id => `${ROOT}/characters/${encodeURIComponent(id)}`;

(async () => {
  const npcs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'CAMPAIGN', 'npcs.json'), 'utf8')).characters || [];
  if (!npcs.length) throw new Error('CAMPAIGN/npcs.json has no characters');

  const token = accessToken();
  const auth = { Authorization: `Bearer ${token}` };

  // ── Read live state ──────────────────────────────────────────────────────
  const foldersRes = await fetch(FOLDERS_DOC, { headers: auth });
  if (!foldersRes.ok) throw new Error(`folder read failed: HTTP ${foldersRes.status} ${(await foldersRes.text()).slice(0, 400)}`);
  const foldersRaw = await foldersRes.json();
  const liveFolders = decode(foldersRaw.fields.folders);

  const targets = [];
  for (const npc of npcs) {
    const spec = CATEGORY_FOLDERS[npc.category];
    if (!spec) throw new Error(`no folder mapping for category "${npc.category}" (${npc.name})`);
    const id = `Supporting::${npc.name}`;
    const res = await fetch(docUrl(id), { headers: auth });
    if (!res.ok) throw new Error(`read of "${id}" failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const raw = await res.json();
    const live = Object.fromEntries(Object.entries(raw.fields || {}).map(([a, b]) => [a, decode(b)]));
    targets.push({ docId: id, name: npc.name, category: npc.category, folderName: spec.name, live, updateTime: raw.updateTime });
  }

  // ── Back everything up before proposing a change ─────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(__dirname, '..', `.firestore-backup-characters-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    takenAt: new Date().toISOString(),
    foldersDoc: { updateTime: foldersRaw.updateTime, folders: liveFolders },
    characters: targets.map(t => ({ docId: t.docId, updateTime: t.updateTime, data: t.live })),
  }, null, 1));

  // ── Preconditions ────────────────────────────────────────────────────────
  const expected = Object.entries(liveFolders).find(([, f]) => f.name === EXPECTED_FOLDER_NAME);
  if (!expected) throw new Error(`refusing to write: no folder named "${EXPECTED_FOLDER_NAME}" exists any more`);
  const expectedId = expected[0];

  for (const t of targets) {
    const current = (t.live.fields || {}).folderId;
    if (current !== expectedId) {
      throw new Error(`refusing to write: "${t.docId}" is in folder ${current || '(unfiled)'}, not "${EXPECTED_FOLDER_NAME}" — live state has changed`);
    }
  }

  const wanted = [...new Set(targets.map(t => t.folderName))];
  for (const name of wanted) {
    const clash = Object.entries(liveFolders).find(([, f]) => f.name === name);
    if (clash) throw new Error(`refusing to write: a folder named "${name}" already exists (${clash[0]})`);
  }

  // ── Build the new folder map ─────────────────────────────────────────────
  const nameToId = {};
  const merged = Object.assign({}, liveFolders);
  for (const [category, spec] of Object.entries(CATEGORY_FOLDERS)) {
    if (!targets.some(t => t.category === category)) continue;
    const id = newFolderId();
    nameToId[spec.name] = id;
    merged[id] = { name: spec.name, color: spec.color };
  }

  // Every pre-existing folder must come through untouched.
  for (const [id, f] of Object.entries(liveFolders)) {
    if (JSON.stringify(merged[id]) !== JSON.stringify(f)) throw new Error(`refusing to write: folder "${f.name}" would change`);
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log(`folders doc updateTime : ${foldersRaw.updateTime}`);
  console.log(`backup written to      : ${path.relative(process.cwd(), backupPath)}`);
  console.log(`\nfolders before : ${Object.values(liveFolders).map(f => f.name).sort().join(', ')}`);
  console.log(`folders after  : ${Object.values(merged).map(f => f.name).sort().join(', ')}`);
  console.log(`new folders    : ${wanted.map(n => `${n} (${targets.filter(t => t.folderName === n).length})`).join(', ')}`);
  const aiMadeBefore = Object.values(liveFolders).filter(f => f.name === EXPECTED_FOLDER_NAME).length;
  console.log(`\nmoving ${targets.length} characters out of "${EXPECTED_FOLDER_NAME}"`);
  console.log('\nper-character plan:');
  for (const t of targets) {
    const tags = [...new Set([...((t.live.fields || {}).tags || []), TAG])];
    console.log(`  ${t.docId.padEnd(32)} ${t.category.padEnd(24)} -> ${t.folderName.padEnd(11)} tags=[${tags.join(', ')}]`);
  }

  if (!doWrite) {
    console.log('\nDRY RUN — nothing written. Re-run with --write to commit.');
    return;
  }

  // ── Write: folders first, so no character points at a missing folder ─────
  const fRes = await fetch(`${FOLDERS_DOC}?updateMask.fieldPaths=folders`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { folders: encode(merged, '$.folders') } }),
  });
  if (!fRes.ok) throw new Error(`folder write failed: HTTP ${fRes.status} ${(await fRes.text()).slice(0, 600)}`);
  console.log(`\nfolders written (${wanted.length} new)`);

  for (const t of targets) {
    const tags = [...new Set([...((t.live.fields || {}).tags || []), TAG])];
    const mask = 'updateMask.fieldPaths=fields.folderId&updateMask.fieldPaths=fields.tags';
    const res = await fetch(`${docUrl(t.docId)}?${mask}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: { fields: encode({ folderId: nameToId[t.folderName], tags }, `$.${t.docId}`) },
      }),
    });
    if (!res.ok) throw new Error(`write of "${t.docId}" failed: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    console.log(`  filed ${t.docId.padEnd(32)} -> ${t.folderName}`);
  }

  // ── Verify from a fresh read ─────────────────────────────────────────────
  const checkFolders = decode((await (await fetch(FOLDERS_DOC, { headers: auth })).json()).fields.folders);
  for (const name of wanted) {
    if (!Object.values(checkFolders).some(f => f.name === name)) throw new Error(`verification failed — folder "${name}" is missing`);
  }
  for (const t of targets) {
    const raw = await (await fetch(docUrl(t.docId), { headers: auth })).json();
    const live = Object.fromEntries(Object.entries(raw.fields || {}).map(([a, b]) => [a, decode(b)]));
    const f = live.fields || {};
    if (f.folderId !== nameToId[t.folderName]) throw new Error(`verification failed — "${t.docId}" folderId is ${f.folderId}`);
    if (!(f.tags || []).includes(TAG)) throw new Error(`verification failed — "${t.docId}" is missing the "${TAG}" tag`);
  }

  console.log('\nWRITTEN and verified.');
  console.log(`folders now: ${Object.values(checkFolders).map(f => f.name).sort().join(', ')}`);
  for (const name of wanted) {
    console.log(`  ${name}: ${targets.filter(t => t.folderName === name).map(t => t.name).join(', ')}`);
  }
})().catch(e => { console.error('\nERROR:', e.message); process.exit(1); });
