// Class 1-A toolkit page logic. Extracted from relationships.html so it can be
// linted, diffed and tested directly instead of regex-scraped out of HTML.
// Loaded as a CLASSIC script (not a module) on purpose: the page wires buttons
// with inline onclick= handlers, which resolve against globals, and top-level
// function declarations here become globals exactly as they did inline. Loading
// this as type="module" would scope them and silently break every handler.
// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.

const db = firebase.firestore();

const STAT_KEYS = ['STR','DEX','CON','INT','WIS','CHA','TECH'];
let CHARACTERS = [];
let selected = null;
let activeTab = 'personality';
let rels = {};
let currentView = 'character';

/* ── Categories ────────────────────────────────────────────
   Every person sits in exactly one category, and that category is the
   heading they appear under in the sidebar. The page used to have two,
   spelled as a boolean: is_pc true meant "Player Characters", false meant
   "Class 1-A". Anything else — teachers, villains, a rival class — had no
   way to exist here at all.

   The category is now a label on the character (`_group`), and the list of
   categories is whatever labels are in use, so typing a new one on the way
   in is all it takes to create it. The two originals stay pinned to the top
   in their old order; the rest sort alphabetically underneath.

   `is_pc` survives as the derived twin of the Players category. It is what
   draws the PC badge and the accent avatar, it is stored in the bundle, and
   other pages read it — so setGroup keeps the two in step rather than
   leaving a second, disagreeing answer to "is this a player?".
   ───────────────────────────────────────────────────────── */
const PLAYERS_GROUP = 'Players';
const CLASS_GROUP   = 'Class 1-A';
const DEFAULT_GROUPS = [PLAYERS_GROUP, CLASS_GROUP];

// Derived, never backfilled onto every character at load: writing _group to
// all twenty at startup would mark the whole roster dirty and put a field in
// the bundle for people who never needed one. Only an actual choice writes it.
function groupOf(c) {
  if (c && c._group) return c._group;
  return (c && c.is_pc) ? PLAYERS_GROUP : CLASS_GROUP;
}

// The two defaults first, then everything in use, alphabetically. Order is
// deliberately not "first seen": the sidebar would then reshuffle its
// headings depending on who happened to load first.
function allGroups() {
  const seen = new Set(DEFAULT_GROUPS);
  const extra = [];
  for (const c of CHARACTERS) {
    const g = groupOf(c);
    if (!seen.has(g)) { seen.add(g); extra.push(g); }
  }
  extra.sort((a, b) => a.localeCompare(b));
  return DEFAULT_GROUPS.concat(extra);
}

function setGroup(c, group) {
  if (!c || !group) return;
  c._group = group;
  c.is_pc = group === PLAYERS_GROUP;
  sortCharacters();
  scheduleCharSave(c);
}

// Avatar colours follow the category. The classes already existed for the
// sections this page used to show; unknown categories share the neutral one
// rather than being handed a colour that means something else.
const GROUP_AV = {
  [PLAYERS_GROUP]: 'av-pc',
  [CLASS_GROUP]:   'av-npc',
  'Class 1-B':     'av-1b',
  'Teachers':      'av-teacher',
  'Villains':      'av-villain',
};
const AV_COLORS = {
  'av-pc':         ['var(--accent-light)',  'var(--accent-text)'],
  'av-npc':        ['var(--teal-light)',    'var(--teal-text)'],
  'av-1b':         ['var(--amber-light)',   'var(--amber-text)'],
  'av-teacher':    ['var(--green-light)',   'var(--green-text)'],
  'av-villain':    ['var(--red-light)',     'var(--red-text)'],
  'av-supporting': ['var(--primary-light)', 'var(--primary-text)'],
};
function avClassOf(c) { return GROUP_AV[groupOf(c)] || 'av-supporting'; }

/* ── Save status ──────────────────────────────────────── */
function setSaveStatus(state, text) {
  const el = document.getElementById('save-status');
  el.className = state;
  el.textContent = text;
}

/* ── Firestore storage ────────────────────────────────── */
const FS_COLLECTION = 'mha-dnd';
const FS_DOC        = 'relationships-bundle';

let canWrite = false;

/* ── Money is not editable here; items are ──────────────────────────
   The Inventory tab holds two different kinds of thing, and they get two
   different answers.

   MONEY — currency, crafting parts, points — is not the players' to move.
   It arrives by being earned, granted from the admin page, or bought in
   the Shop, and every one of those routes leaves a line on the Bank
   statement. A player typing themselves ¥10,000 skips all three. So those
   inputs stay disabled for everyone, DM included: the grant panel writes
   the inventory and its ledger entry in one transaction, and a second
   write path here would be a way to change someone's money without any
   record of it. canEditInventory is that gate, and nothing sets it true.

   ITEMS are. A player picking up a rope, using the last of a medkit or
   noting where something came from is bookkeeping, not economy: no
   handbook price, nothing to reconcile against the ledger, and the only
   alternative is the DM typing twenty people's kit for them. Item rows
   are editable by anyone who can edit sheets at all, and they are written
   straight to the inventories collection — the items array on its own,
   never the purse beside it (see saveInventoryItems).

   ⚠ canEditItems is a UI gate; firestore.rules is the boundary. The rule
   there refuses any write that leaves a purse worth more than it was, and
   an items-only update leaves it worth exactly what it was. Items
   themselves are unvalued and unguarded — which is the right trade, since
   an item is worth nothing the database could count anyway. */
let canEditInventory = false;

// Whether the signed-in user may add, edit and remove item rows on `c`.
// Needs a document in the inventories collection to write to: only the DM
// can create one (the migration on the admin page does it), so a character
// who was never migrated shows the tab read-only rather than offering an
// Add button whose write the database would refuse.
function canEditItems(c) {
  return canWrite && !!c && !!c._file && inventoryDocs.has(c._file);
}

document.addEventListener('auth-state-changed', (e) => {
  canWrite = e.detail.role === 'admin' || e.detail.role === 'editor';
  refreshAddPersonBtn();
  // renderProfile rather than showTab: the Remove button for an added person
  // lives in the profile header, and it is gated on canWrite too.
  if (selected) renderProfile();
});

function buildBundle() {
  const characters = {};
  for (const c of CHARACTERS) {
    if (!c._file) continue;
    // Inventory is dropped from every save. It lives in its own collection
    // now, and carrying a stale copy along in a sheet save is how a purchase
    // made thirty seconds ago would quietly come back.
    const { inventory, ...rest } = c;
    characters[c._file] = rest;
  }
  return { version: 1, exported_at: new Date().toISOString(), relationships: rels, characters };
}

// Inventories are fetched separately and hung onto the character objects, so
// the Inventory tab and its totals keep working unchanged. The only thing
// this page ever writes back is the items array (see saveInventoryItems).
const FS_INVENTORIES = db.collection('inventories');

// Which characters actually have a document in that collection. Only the DM's
// migration creates one, so this doubles as the answer to "is there anything
// here for an item edit to be written to".
const inventoryDocs = new Set();

// Item rows with unsaved local edits: file -> edit seq, the same shape and the
// same job as _dirtyCharFiles. It keeps an incoming snapshot from overwriting
// rows that have not been written yet.
const _dirtyItemFiles = new Map();
// What this client last saw on the server, per file — the third input to the
// merge below.
const _lastSyncedItems = new Map();

/* The merge fsMergeSave does for the bundle's id-keyed arrays, over one items
   array. Three inputs, because two cannot tell "they added this" apart from
   "I deleted it":

     server  what is in the collection right now
     local   what this tab is showing
     last    what this tab last saw on the server

   A row on the server we have never seen is someone else's purchase, and is
   kept. A row we have seen and no longer hold was deleted here, and stays
   deleted. A row we hold and changed beats the server's copy; one we hold but
   did not touch does not. Pure and top-level so the verification scripts can
   drive it directly. */
function mergeItemsById(server, local, last) {
  const lastById  = new Map((last  || []).map(i => [i.id, i]));
  const localById = new Map((local || []).map(i => [i.id, i]));
  const merged = [], seen = new Set();
  for (const item of (server || [])) {
    const id = item.id;
    seen.add(id);
    if (!localById.has(id)) { if (!lastById.has(id)) merged.push(item); continue; }
    const changedLocally =
      JSON.stringify(localById.get(id)) !== JSON.stringify(lastById.get(id));
    merged.push(changedLocally ? localById.get(id) : item);
  }
  for (const item of (local || [])) {
    if (!seen.has(item.id) && !lastById.has(item.id)) merged.push(item);
  }
  return merged;
}

function applyInventorySnapshot(snap) {
  const byFile = {};
  snap.forEach(doc => { byFile[doc.id] = doc.data(); });
  for (const c of CHARACTERS) {
    const file = c._file;
    if (!file || !byFile[file]) continue;
    const incoming = byFile[file];
    const serverItems = Array.isArray(incoming.items) ? incoming.items : [];
    // A row with no id can be neither addressed by a handler nor matched by
    // the merge. Everything that writes items gives them one; this covers a
    // document written before they did.
    for (const it of serverItems) if (!it.id) it.id = genId('item');
    incoming.items = serverItems;

    if (_dirtyItemFiles.has(file)) {
      // An unsaved add, rename or delete is still in this tab's hands. Merge
      // rather than overwrite — and leave the baseline where it is, because
      // advancing it here would make the next save read those unwritten rows
      // as deletions.
      incoming.items = mergeItemsById(serverItems, c.inventory?.items, _lastSyncedItems.get(file));
    } else {
      _lastSyncedItems.set(file, fsCloneDoc(serverItems));
    }
    c.inventory = incoming;
    inventoryDocs.add(file);
  }
}

/* ── Writing item rows back ─────────────────────────────────────────
   Items are the one thing on this tab that leaves the page. They go to
   the inventories collection — never the bundle, which strips inventory
   from every save — as an update carrying `items` and nothing else. The
   purse in the same document is therefore untouched by construction, and
   the rule guarding it has nothing to object to.

   Written on a short debounce rather than by the Save button: that button
   flushes the bundle, this is a different document with a different
   merge, and a player who adds an item and closes the tab should not lose
   it for want of a click. The transaction re-reads the server's copy and
   merges by id, so a purchase landing from the Shop mid-edit is not
   flattened by a rename typed here. ─────────────────────────────────── */
const ITEM_SAVE_DEBOUNCE_MS = 600;
const _itemSaveTimers = new Map();   // file -> timeout id

function scheduleItemsSave(c) {
  const file = c?._file;
  if (!file) return;
  _dirtyItemFiles.set(file, ++_editSeq);
  setSaveStatus('dirty', 'Unsaved changes');
  clearTimeout(_itemSaveTimers.get(file));
  _itemSaveTimers.set(file, setTimeout(() => saveInventoryItems(file), ITEM_SAVE_DEBOUNCE_MS));
}

async function saveInventoryItems(file) {
  clearTimeout(_itemSaveTimers.get(file));
  _itemSaveTimers.delete(file);
  const c = CHARACTERS.find(x => x._file === file);
  if (!c) return;
  // Captured before the round-trip, the way manualSaveRelationships does it:
  // a keystroke landing mid-flight must stay dirty rather than be marked
  // clean by a save that did not carry it.
  const seq = _dirtyItemFiles.get(file);
  const local = fsCloneDoc(c.inventory?.items || []);
  setSaveStatus('saving', 'Saving…');
  try {
    await fbAuthReady;
    const ref = FS_INVENTORIES.doc(file);
    const written = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new Error('No inventory for this character yet — the DM needs to run the migration on the admin page.');
      }
      const serverItems = Array.isArray(snap.data().items) ? snap.data().items : [];
      const items = mergeItemsById(serverItems, local, _lastSyncedItems.get(file));
      // `items` alone: currency, parts and points are not in this write, so
      // the purse cannot move even by accident.
      tx.update(ref, { items });
      return items;
    });
    _lastSyncedItems.set(file, fsCloneDoc(written));
    if (_dirtyItemFiles.get(file) === seq) _dirtyItemFiles.delete(file);
    if (isDirty() || _dirtyItemFiles.size) setSaveStatus('dirty', 'Unsaved changes');
    else setSaveStatus('saved', 'Saved ' + new Date().toLocaleTimeString());
  } catch (e) {
    // Left dirty on purpose: the rows are still on screen, and the next edit
    // schedules another attempt.
    setSaveStatus('error', e.message || 'Could not save items');
  }
}

async function loadInventories() {
  try {
    applyInventorySnapshot(await FS_INVENTORIES.get());
  } catch {
    // Falls back to whatever the bundle still holds, which during the
    // migration is exactly right.
  }
}

/* A grant from the admin page and a purchase from the Shop both land in the
   inventories collection, not in the bundle this page listens to — so without
   a listener of its own the Inventory tab showed whatever was true when the
   page opened and nothing after that. The DM would grant an item, switch to
   this tab, see no change, and reasonably conclude the grant had failed.

   Money is read-only here, so the server's copy of the purse is always the
   right one to show. Item rows can now be edited, so they do have a dirty
   window — applyInventorySnapshot merges those by id instead of taking the
   server's array wholesale. Same fromCache guard the bundle listener uses: a
   replayed cache is this tab's own stale copy, not news. */
async function startInventoryLiveSync() {
  await fbAuthReady;
  FS_INVENTORIES.onSnapshot((snap) => {
    if (snap.metadata?.fromCache) return;
    applyInventorySnapshot(snap);
    renderSynced();
  }, err => console.error('[relationships] inventory sync stopped:', err));
}

// Attacks and inventory items are edited live by whoever has this character
// open, so two people saving around the same time is routine, not an edge
// case — one player adds an attack, the DM tweaks that PC's HP a moment
// later, both from a snapshot that predates the other's change. Firestore's
// own merge:true only merges *object* fields recursively; an array field
// (abilities, inventory items) is always replaced wholesale, so whichever
// save lands second would silently erase whatever the other person added to
// that array. genId()/ensureCharIds() give every item a stable id so
// fsMergeSave can merge those arrays by item instead of overwriting them —
// same mechanism the battle board already uses for combatants/strokes.
// Migration note: existing (pre-fix) attacks/items have no id yet. If two
// clients both load the same un-migrated character before either of them
// saves, each backfills that item with a *different* generated id, and the
// next merge sees two distinct items instead of one edited one — a visible,
// harmless duplicate card, not data loss. It's a one-time, self-resolving
// window: the first save of any kind persists real ids to Firestore, and
// every client after that loads the already-migrated ids instead of
// generating its own.
function genId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function ensureCharIds(c) {
  const abilities = c.quirk_mechanics?.abilities;
  if (Array.isArray(abilities)) for (const a of abilities) if (!a.id) a.id = genId('atk');
  const items = c.inventory?.items;
  if (Array.isArray(items)) for (const it of items) if (!it.id) it.id = genId('item');
  const pools = c.inventory?.pools;
  if (Array.isArray(pools)) for (const p of pools) if (!p.id) p.id = genId('pool');
}

const FS_REL_DOC = db.collection(FS_COLLECTION).doc(FS_DOC);
let _lastSyncedRel = null;
// True only while a manual save triggered by the Save button is actually in
// flight (not while edits are merely pending).
let _relSavePending = false;

// What has unsaved local edits, tracked per field rather than as one global
// "dirty" boolean. Saving here is manual (the Save button), so this window is
// unbounded — it lasts however long the user takes to click Save. A single
// boolean couldn't express "this one note is unsaved, everything else is safe
// to sync", so any incoming snapshot had to be either applied wholesale
// (reverting the edit) or blocked wholesale (going stale). Tracking per field
// lets applyRemoteRelBundle take remote data for everything *except* the exact
// fields the user is still working on.
//
// Each entry maps to a monotonic edit sequence number rather than being a bare
// set member. That matters: if you edit the same note twice — once before
// clicking Save and once while the save is still in flight — a set has no way
// to tell those apart, so clearing the key on completion would mark the second,
// never-written edit clean. The sequence number lets manualSaveRelationships
// clear only entries that haven't been touched since it captured them.
let _editSeq = 0;
let _dirtyRelKeys   = new Map();  // "fromId:toId" -> edit seq
let _dirtyCharFiles = new Map();  // c._file       -> edit seq
function isDirty() { return _dirtyRelKeys.size > 0 || _dirtyCharFiles.size > 0; }

async function saveToFirestore() {
  await fbAuthReady;
  for (const c of CHARACTERS) ensureCharIds(c);
  const idArrays = [];
  for (const c of CHARACTERS) {
    if (!c._file) continue;
    idArrays.push({ path: ['characters', c._file, 'quirk_mechanics', 'abilities'], idKey: 'id' });
    idArrays.push({ path: ['characters', c._file, 'inventory', 'items'], idKey: 'id' });
    idArrays.push({ path: ['characters', c._file, 'inventory', 'pools'], idKey: 'id' });
  }
  _lastSyncedRel = await fsMergeSave(FS_REL_DOC, buildBundle(), _lastSyncedRel, idArrays);
}

async function loadFromFirestore() {
  await fbAuthReady;
  const snap = await FS_REL_DOC.get();
  if (!snap.exists) return null;
  const parsed = snap.data();
  return (parsed.version === 1 && parsed.characters) ? parsed : null;
}

// Live feed: pull in other tabs' character/relationship saves so this tab's
// local copy never goes stale and clobbers them on its own next save.
//
// Incoming snapshots used to be parked in a "pending" variable while the user
// was editing, then applied once that guard cleared. That was the bug: the
// parked bundle was never invalidated when a local save superseded it, so
// clicking Save (which cleared the guard) applied a bundle that predated the
// save and reverted the edit. There is no parking any more — the merge below
// is safe to run at any time because it never overwrites a field listed in
// _dirtyRelKeys/_dirtyCharFiles, so a snapshot can be applied the moment it
// arrives. Only the *render* is deferred, and only to protect the caret.
let _pendingRender = false;

// Re-rendering replaces innerHTML, which destroys the caret and any half-typed
// text in the field being edited. This gates rendering only, never the data
// merge. (The old version tested for '#view-relationships', an id that exists
// nowhere in this repo — so for the relationship notes, which live in
// #rel-section, this check silently always returned false.)
function isFieldFocused() {
  const el = document.activeElement;
  const tag = el?.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  return !!el.closest('#profile, #rel-section');
}

// Remote wins for every key except the ones holding unsaved local edits.
// `dirtyKeys` is any iterable of key strings (callers pass a Map's .keys()).
// Kept as a pure top-level function so scripts/verify-merge-safety.js can
// extract and test it: this apply-remote path is where the "my typing gets
// undone" bug lived, and it previously had no test coverage at all.
function mergeRemoteRels(localRels, incomingRels, dirtyKeys) {
  const merged = Object.assign({}, incomingRels);
  for (const k of dirtyKeys) {
    if (Object.prototype.hasOwnProperty.call(localRels, k)) merged[k] = localRels[k];
  }
  return merged;
}

// _lastSyncedRel is fsMergeSave's 3-way baseline — "what this client has seen
// on the server". It must only advance for characters we actually applied. If
// it claimed we'd seen a remote-added ability that our (skipped, still dirty)
// local copy lacks, the next merge would read that absence as "this client
// deleted it" and drop another player's attack. `dirtyCharFiles` is any
// iterable of filenames. Pure + top-level so scripts/verify-merge-safety.js
// can test that edge case.
function nextSyncBaseline(data, prevBaseline, dirtyCharFiles) {
  const characters = Object.assign({}, data.characters);
  for (const f of dirtyCharFiles) {
    const prev = prevBaseline?.characters?.[f];
    if (prev === undefined) delete characters[f];
    else characters[f] = prev;
  }
  return Object.assign({}, data, { characters });
}

/* ── The bundle's inventory is a fossil ─────────────────────────────
   Every character in mha-dnd/relationships-bundle still carries an
   `inventory` key: the migration deliberately left those copies in place
   so a bad day could be undone (see migrateInventories in admin.js), and
   buildBundle() has stripped inventory from every save since, so they
   have not moved an inch. Today they all still read ¥20,000 / no items.

   That makes them actively dangerous on the way *in*. loadInventories()
   hangs the real inventory off each character at startup, and then the
   first bundle snapshot — which arrives seconds later, and again whenever
   anyone saves anything — used to Object.assign the fossil straight over
   it. The Inventory tab would show the correct purse and items for a
   moment, then silently revert to the pre-migration numbers: a granted
   item or a shop purchase would land in Firestore correctly and vanish
   off the screen, which is indistinguishable from the write having
   failed.

   So inventory is stripped on the way in exactly as buildBundle strips it
   on the way out. The collection is the only source; the bundle's copy is
   never read. stripInventory() also guards the day someone finally
   deletes those keys — an absent key is simply nothing to strip. */
function stripInventory(remoteChar) {
  if (!remoteChar || remoteChar.inventory === undefined) return remoteChar;
  const { inventory, ...rest } = remoteChar;
  return rest;
}

function applyRemoteRelBundle(data) {
  rels = mergeRemoteRels(rels, data.relationships || {}, _dirtyRelKeys.keys());

  for (const c of CHARACTERS) {
    if (!c._file || !data.characters?.[c._file]) continue;
    // Unsaved local edits — the sheet is left alone. There is nothing to
    // rescue out of the bundle for inventory any more: grants and purchases
    // go to the inventories collection, which startInventoryLiveSync watches
    // independently of whether the sheet is dirty.
    if (_dirtyCharFiles.has(c._file)) continue;
    const f = c._file, rid = c._roster_id, sec = c._section;
    Object.assign(c, stripInventory(data.characters[c._file]));
    c._file = f; c._roster_id = rid; c._section = sec;
    ensureCharIds(c); // backfill in case this remote copy predates the id fix
  }
  syncCustomRoster(data);
  // Cloned because the Object.assign above hands `data`'s sub-objects to the
  // live characters — an uncloned baseline would alias them from here on.
  _lastSyncedRel = fsCloneDoc(nextSyncBaseline(data, _lastSyncedRel, _dirtyCharFiles.keys()));
  renderSynced();
}

/* Someone added or removed from another tab changes the *list*, which the
   loop above cannot express: it only updates characters this tab already
   knows about, so a new classmate would stay invisible until a reload and a
   removed one would linger.

   Removal needs the same care as an edit. A person added here and not yet
   saved is missing from the bundle for exactly the same reason a person
   deleted elsewhere is — so anything still dirty, and anything at all while a
   save is in flight, is left alone. Only roster people and saved additions
   are ever matched against the bundle. */
function syncCustomRoster(data) {
  const known = new Set(CHARACTERS.map(c => c._file));
  const added = customCharsFromBundle(data, known);
  if (added.length) CHARACTERS.push(...added);

  let removed = 0;
  if (!_relSavePending) {
    const remote = data.characters || {};
    const before = CHARACTERS.length;
    CHARACTERS = CHARACTERS.filter(c =>
      !c._custom || remote[c._file] !== undefined || _dirtyCharFiles.has(c._file));
    removed = before - CHARACTERS.length;
    if (removed && selected && !CHARACTERS.includes(selected)) selected = CHARACTERS[0] || null;
  }
  if (added.length || removed) sortCharacters();
}

function renderSynced() {
  if (isFieldFocused()) { _pendingRender = true; return; }
  _pendingRender = false;
  if (!selected) return;
  renderProfile();
  renderRelationships();
  refreshSidebar();
}

// Split out of the listener so scripts/verify-relationship-sync.js can drive
// it directly, without needing a live Firestore connection.
function handleRelSnapshot(snap) {
  if (!snap.exists) return;
  // A cached snapshot is this tab's own stale copy, not news from the server,
  // and must never be applied as if it were. When Firestore's streaming
  // channel is blocked (Safari tracking protection, content blockers, some
  // proxies) the write transport keeps working while the listener goes offline
  // and replays cache — so a save would commit successfully and then be
  // visibly "undone" by data older than the write. Wait for a server-confirmed
  // snapshot instead.
  if (snap.metadata?.fromCache) return;
  const data = snap.data();
  if (data.version !== 1 || !data.characters) return;
  applyRemoteRelBundle(data);
}

async function startRelLiveSync() {
  await fbAuthReady;
  FS_REL_DOC.onSnapshot(handleRelSnapshot, err => {
    // Previously swallowed, which made a dead listener indistinguishable from
    // a working one. Say so: edits still save, they just won't stream in.
    console.error('[relationships] live sync stopped:', err);
    if (!isDirty()) setSaveStatus('error', 'Live sync offline — saving still works');
  });
}

// Flush a render that was deferred while the user was typing. focusout catches
// the common case immediately; the interval is the backstop for focus moving
// somewhere without a focusout we hear about (e.g. the window losing focus).
document.addEventListener('focusout', () => {
  setTimeout(() => { if (_pendingRender) renderSynced(); }, 0);
});
setInterval(() => { if (_pendingRender) renderSynced(); }, 1500);

// Called by every field/score edit. Saving here is manual (the Save button in
// #save-bar), not automatic — these just record *what* changed and let the user
// decide when to write it, instead of a timer racing a background sync that
// could revert the edit before it's sent.
function markRelDirty(key)   { _dirtyRelKeys.set(key, ++_editSeq); onDirtyChanged(); }
function markCharDirty(file) { if (!file) return; _dirtyCharFiles.set(file, ++_editSeq); onDirtyChanged(); }
function onDirtyChanged() { setSaveStatus('dirty', 'Unsaved changes'); refreshSaveBar(); }

// Button state only — deliberately does not touch the status text, so it can be
// called after a failed save without wiping the error message off the bar.
function refreshSaveBar() {
  const btn = document.getElementById('rel-save-btn');
  if (!btn || _relSavePending) return;
  const dirty = isDirty();
  btn.disabled = !dirty;
  btn.classList.toggle('dirty', dirty);
  btn.title = dirty ? 'Save unsaved changes' : 'No unsaved changes';
}

async function manualSaveRelationships() {
  if (!isDirty() || _relSavePending) return;
  const btn = document.getElementById('rel-save-btn');
  // Capture exactly what this save is flushing, before the await. Anything
  // typed during the round-trip must stay dirty: buildBundle() snapshots the
  // data when the save *starts*, so later keystrokes aren't in this write.
  // Clearing the whole dirty set on completion (what the previous version did)
  // marked those edits clean without ever writing them — losing both the data
  // and the protection that keeps an incoming snapshot from overwriting them.
  //
  // Deliberate asymmetry: an edit landing between this capture and
  // buildBundle() is written *and* stays dirty, so it simply saves twice.
  // That's harmless. The reverse — clean but unwritten — is data loss.
  const sentRelKeys   = new Map(_dirtyRelKeys);
  const sentCharFiles = new Map(_dirtyCharFiles);
  _relSavePending = true;
  setSaveStatus('saving', 'Saving…');
  if (btn) btn.disabled = true;
  try {
    await saveToFirestore();
    // Clear only what hasn't been re-edited since the capture above; a bumped
    // sequence number means this field changed after the bundle was built and
    // is therefore still unsaved.
    for (const [k, seq] of sentRelKeys)   if (_dirtyRelKeys.get(k)   === seq) _dirtyRelKeys.delete(k);
    for (const [f, seq] of sentCharFiles) if (_dirtyCharFiles.get(f) === seq) _dirtyCharFiles.delete(f);
    _relSavePending = false;
    // Edits that arrived mid-flight are legitimately still unsaved — say so
    // rather than flashing "Saved" over them.
    if (isDirty()) setSaveStatus('dirty', 'Unsaved changes');
    else setSaveStatus('saved', 'Saved ' + new Date().toLocaleTimeString());
    refreshSaveBar();
  } catch (e) {
    _relSavePending = false;
    setSaveStatus('error', e.message);
    refreshSaveBar(); // still dirty — let them retry
  }
}

// Warn before leaving the tab with unsaved edits sitting in memory — there's
// no auto-save left to fall back on now that saving is manual. Item rows do
// save themselves, but on a debounce: one typed in the last half-second is
// still sitting in a timer, and is just as lost.
window.addEventListener('beforeunload', (e) => {
  if (!isDirty() && !_itemSaveTimers.size) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ── View switching ───────────────────────────────────── */
function setView(view) {
  currentView = view;
  document.querySelectorAll('.main-view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['character','dice'][i] === view);
  });
}

/* ── Relationships persistence ────────────────────────── */
function relKey(from, to) { return from + ':' + to; }
function getRel(fromId, toId) { return rels[relKey(fromId, toId)] || { score: 0, note: '' }; }

function setRelScore(fromId, toId, score) {
  const k = relKey(fromId, toId);
  rels[k] = rels[k] || { score: 0, note: '' };
  rels[k].score = Math.max(-10, Math.min(10, parseInt(score) || 0));
  updateScoreDisplay(fromId, toId, score);
  markRelDirty(k);
}
function setRelNote(fromId, toId, note) {
  const k = relKey(fromId, toId);
  rels[k] = rels[k] || { score: 0, note: '' };
  rels[k].note = note;
  markRelDirty(k);
}
function updateScoreDisplay(fromId, toId, score) {
  const el = document.getElementById('score-'+fromId+'-'+toId);
  if (!el) return;
  score = parseInt(score);
  el.textContent = score > 0 ? '+'+score : ''+score;
  el.className = 'rel-score '+(score<0?'score-neg':score>0?'score-pos':'score-zero');
}

/* ── Character persistence ────────────────────────────── */
function scheduleCharSave(c) { markCharDirty(c?._file); }

function onStatChange(field, value, isFloat) {
  const c = selected;
  const num = isFloat ? parseFloat(value) : parseInt(value);
  if (isNaN(num)) return;
  c[field] = num;
  scheduleCharSave(c);
}
function onAbilityScoreChange(key, value) {
  const c = selected;
  const num = parseInt(value);
  if (isNaN(num)) return;
  // Not every character arrives with these. A sheet that reached the bundle as
  // a stub — name and quirk and little else — has neither object, and
  // renderProfile still draws seven editable inputs for it because it falls
  // back to 10 per stat. Without this, the first edit throws here, nothing is
  // marked dirty, and the next render puts 10 back: it looks from the outside
  // like the page is refusing to save stats.
  if (!c.ability_scores) c.ability_scores = {};
  if (!c.modifiers) c.modifiers = {};
  c.ability_scores[key] = num;
  const mod = Math.floor((num - 10) / 2);
  c.modifiers[key] = mod;
  const modEl = document.getElementById('mod-'+key);
  if (modEl) modEl.textContent = (mod>=0?'+':'')+mod;
  scheduleCharSave(c);
}
function onClassChange(value) { selected.suggested_class = value; scheduleCharSave(selected); }

function refreshSidebar() {
  renderSidebar();
  filterList(document.getElementById('search').value);
}

function onNameChange(value) {
  const v = value.trim();
  if (!v) { renderProfile(); return; }
  selected.name = v;
  scheduleCharSave(selected);
  document.getElementById('profile-avatar').textContent = initials(selected.name);
  refreshSidebar();
}
function onSubFieldChange(field, value) {
  selected[field] = value;
  scheduleCharSave(selected);
  if (field === 'quirk') refreshSidebar();
}
function onGroupChange(value) {
  let group = value;
  if (group === NEW_GROUP_OPTION) {
    group = (prompt('New category name?') || '').trim();
    // Cancelled or blank: re-render so the dropdown snaps back to the
    // category the character is actually in, rather than sitting on "+ New".
    if (!group) { renderProfile(); return; }
  }
  setGroup(selected, group);
  refreshSidebar();
  renderProfile();
  renderRelationships();
}

/* ── Adding people ─────────────────────────────────────────
   The class list is built from roster.json, a file in the repo — which the
   browser cannot write to. So a person added here is stored in the Firestore
   bundle instead, alongside everyone's sheet data, and carries `_custom: true`
   to say where they came from.

   That flag is a whitelist, not a description. The bundle also holds fossil
   entries for people deliberately removed from the roster (Zaro Brando, for
   one), and reading in "every character the bundle has that roster.json
   doesn't" would walk them all straight back in. Only entries this page
   created are picked up.
   ───────────────────────────────────────────────────────── */

// _roster_id is the identity used in relationship keys ("3:17") and in DOM
// ids, so it must never collide with a roster id — including one added to
// roster.json later. Added people are numbered from 1000 up, well clear of a
// class of twenty.
const CUSTOM_ID_BASE = 1000;

function nextCustomRosterId(chars) {
  let max = CUSTOM_ID_BASE - 1;
  for (const c of (chars || CHARACTERS)) {
    if (Number.isFinite(c._roster_id) && c._roster_id > max) max = c._roster_id;
  }
  return max + 1;
}

// Two tabs adding someone before either has saved allocate the same id from
// the same highest-in-use number. The bundle keys people by _file (unique per
// add, so both survive as separate people), but a shared _roster_id would make
// them share relationships as well — every note about one showing up on the
// other. Whoever loses the race gets renumbered on the way in instead.
function dedupeRosterIds(chars) {
  const seen = new Set();
  for (const c of chars) {
    while (seen.has(c._roster_id)) c._roster_id = nextCustomRosterId(chars);
    seen.add(c._roster_id);
  }
}

// Every field is optional everywhere it is read (`c.HP || 10`, `c.personality
// || {}` and so on), so a new person needs only enough to render a sheet; the
// rest is filled in by editing the tabs like any other character.
function newCustomCharacter(name, group) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const g = String(group || '').trim() || CLASS_GROUP;
  const ability_scores = {}, modifiers = {};
  for (const k of STAT_KEYS) { ability_scores[k] = 10; modifiers[k] = 0; }
  return {
    name: clean, quirk: '', _group: g, is_pc: g === PLAYERS_GROUP,
    level: 1, HP: 10, AC: 10,
    ability_scores, modifiers,
    // Unique per add rather than derived from the name or the id: it is the
    // bundle's key for this person, and a collision would merge two people
    // into one document.
    _file: genId('custom') + '.json',
    _roster_id: nextCustomRosterId(),
    _section: 'class-1a',
    _custom: true,
  };
}

// Split from the add panel so the verification script can add a person
// without driving a form.
function addPerson(name, group) {
  const c = newCustomCharacter(name, group);
  if (!c) return null;
  CHARACTERS.push(c);
  dedupeRosterIds(CHARACTERS);
  sortCharacters();
  // Unsaved until the Save button is clicked, exactly like every other edit on
  // this page — and being dirty is also what stops an incoming snapshot (which
  // knows nothing about this person yet) from treating them as deleted.
  markCharDirty(c._file);
  selected = c;
  renderSidebar();
  renderProfile();
  renderRelationships();
  return c;
}

/* ── The add panel ─────────────────────────────────────────
   Two fields rather than a prompt(): a name and a category are one decision
   made together, and prompt() can only ask for one thing at a time — asking
   twice in a row would also mean typing a category that already exists
   instead of picking it.
   ───────────────────────────────────────────────────────── */
const NEW_GROUP_OPTION = '__new';

function groupOptionsHtml(current) {
  const opts = allGroups().map(g =>
    `<option value="${escHtml(g)}"${g === current ? ' selected' : ''}>${escHtml(g)}</option>`);
  opts.push(`<option value="${NEW_GROUP_OPTION}">+ New category…</option>`);
  return opts.join('');
}

function openAddPerson() {
  if (!canWrite) return;
  const panel = document.getElementById('add-person-panel');
  const sel   = document.getElementById('add-person-group');
  const name  = document.getElementById('add-person-name');
  if (!panel || !sel || !name) return;
  // Defaults to the category of whoever is open: adding three teachers in a
  // row shouldn't mean choosing "Teachers" three times.
  sel.innerHTML = groupOptionsHtml(groupOf(selected));
  name.value = '';
  panel.style.display = '';
  const btn = document.getElementById('add-person-btn');
  if (btn) btn.style.display = 'none';
  name.focus();
}

function closeAddPerson() {
  const panel = document.getElementById('add-person-panel');
  if (panel) panel.style.display = 'none';
  const name = document.getElementById('add-person-name');
  if (name) name.value = '';
  refreshAddPersonBtn();
}

// "+ New category…" is an item in the menu rather than a second text box, so
// the common case — a category that already exists — stays one click.
function onAddGroupPick(value) {
  const sel = document.getElementById('add-person-group');
  if (!sel || value !== NEW_GROUP_OPTION) return;
  const group = (prompt('New category name?') || '').trim();
  if (!group) { sel.value = groupOf(selected); return; }
  addGroupOption(sel, group);
}

// A category exists because somebody is in it, so one invented here has
// nowhere to live until the person using it is actually added — it waits in
// the dropdown, in front of the "+ New category…" item.
function addGroupOption(sel, group) {
  const already = Array.from(sel.options).some(o => o.value === group);
  if (!already) {
    const opt = document.createElement('option');
    opt.value = group;
    opt.textContent = group;
    sel.insertBefore(opt, sel.options[sel.options.length - 1]);
  }
  sel.value = group;
}

function submitAddPerson() {
  const nameEl = document.getElementById('add-person-name');
  const sel    = document.getElementById('add-person-group');
  const name   = (nameEl && nameEl.value || '').trim();
  if (!name) { if (nameEl) nameEl.focus(); return; }
  let group = sel && sel.value;
  if (!group || group === NEW_GROUP_OPTION) group = CLASS_GROUP;
  addPerson(name, group);
  closeAddPerson();
  if (isMobileLayout()) document.getElementById('app').classList.add('mobile-main');
}

function refreshAddPersonBtn() {
  const btn = document.getElementById('add-person-btn');
  if (btn) btn.style.display = canWrite ? '' : 'none';
  // Signing out with the panel open would otherwise leave it there.
  if (!canWrite) {
    const panel = document.getElementById('add-person-panel');
    if (panel) panel.style.display = 'none';
  }
}

async function onDeletePerson() {
  const c = selected;
  if (!c || !c._custom || !canWrite) return;
  if (!confirm(`Remove ${c.name}? Their sheet and every relationship note about them go with them, for everyone.`)) return;
  const file = c._file, id = c._roster_id;

  const orphanKeys = Object.keys(rels).filter(k => {
    const [from, to] = k.split(':');
    return Number(from) === id || Number(to) === id;
  });
  for (const k of orphanKeys) { delete rels[k]; _dirtyRelKeys.delete(k); }
  _dirtyCharFiles.delete(file);
  CHARACTERS = CHARACTERS.filter(o => o._file !== file);
  selected = CHARACTERS[0] || null;

  renderSidebar();
  if (selected) { renderProfile(); renderRelationships(); }
  refreshSaveBar();
  await deletePersonRemotely(file, orphanKeys);
}

// Leaving someone out of the next save does NOT delete them. fsMergeSave
// merges local over server and keeps server keys the local copy lacks — that
// is what makes two people editing different characters safe, and it would
// resurrect this person on the next save anybody made. The key has to be
// removed explicitly.
//
// FieldPath (rather than a dotted 'characters.foo.json' string) because both
// halves of the key contain dots and colons: a dotted path would be read as
// four nested fields instead of one name.
async function deletePersonRemotely(file, relKeys) {
  if (!_lastSyncedRel || !_lastSyncedRel.characters || _lastSyncedRel.characters[file] === undefined) {
    // Never reached the server — added and removed inside one sitting, or the
    // page is running on the local-JSON fallback. Nothing to delete.
    return;
  }
  setSaveStatus('saving', 'Removing…');
  try {
    await fbAuthReady;
    const del = firebase.firestore.FieldValue.delete();
    const args = [new firebase.firestore.FieldPath('characters', file), del];
    for (const k of relKeys) args.push(new firebase.firestore.FieldPath('relationships', k), del);
    await FS_REL_DOC.update(...args);
    // Keep the merge baseline honest about what the server now holds.
    delete _lastSyncedRel.characters[file];
    if (_lastSyncedRel.relationships) for (const k of relKeys) delete _lastSyncedRel.relationships[k];
    if (isDirty()) setSaveStatus('dirty', 'Unsaved changes');
    else setSaveStatus('saved', 'Removed ' + new Date().toLocaleTimeString());
  } catch (e) {
    setSaveStatus('error', 'Remove failed: ' + e.message);
  }
}

// Added people out of a bundle. `skipFiles` is whatever is already accounted
// for — the roster's files at startup, the whole current list on a live
// snapshot.
function customCharsFromBundle(bundle, skipFiles) {
  const out = [];
  for (const [file, raw] of Object.entries((bundle && bundle.characters) || {})) {
    if (!raw || !raw._custom || skipFiles.has(file)) continue;
    const c = Object.assign({}, stripInventory(raw));
    c._file = file;
    c._section = 'class-1a';
    c._custom = true;
    c._roster_id = Number(raw._roster_id);
    // A nameless or unnumbered entry has no identity to render or to key
    // relationships by; skipping it is better than showing a blank row.
    if (!c.name || !Number.isFinite(c._roster_id)) continue;
    ensureCharIds(c);
    out.push(c);
  }
  return out;
}

// Category order first (the same order the sidebar prints its headings in),
// then roster order within a category — which puts added people, numbered
// from 1000, after the twenty. Named because startup, every add and every
// category change all need it.
function sortCharacters() {
  const order = allGroups();
  CHARACTERS.sort((a, b) => {
    const gi = order.indexOf(groupOf(a)) - order.indexOf(groupOf(b));
    if (gi !== 0) return gi;
    return a._roster_id - b._roster_id;
  });
}

/* ── Sidebar ──────────────────────────────────────────── */
function initials(name) { return name.split(' ').slice(0,2).map(w=>w[0]).join(''); }

/* Collapse state is per category and lives in localStorage, so shutting the
   twenty-strong class to get at the four teachers underneath survives a
   reload. Same storage-per-thing shape the relationship list already uses.

   Collapsed members are still rendered, just hidden — see filterList, where a
   search has to be able to reach into a shut category. */
function groupCollapseKey(group) { return 'relGroupCollapsed-' + group; }
function isGroupCollapsed(group) { return localStorage.getItem(groupCollapseKey(group)) === '1'; }

// Takes the category's index rather than its name: the name is free text the
// DM typed, and threading a string with an apostrophe in it through an inline
// onclick= is how that button quietly stops working. Both ends read the same
// allGroups() ordering, and any change to it re-renders these handlers.
function toggleGroup(index) {
  const group = allGroups()[index];
  if (!group) return;
  localStorage.setItem(groupCollapseKey(group), isGroupCollapsed(group) ? '0' : '1');
  refreshSidebar();
}

function renderSidebar() {
  let html = '';
  allGroups().forEach((g, i) => {
    const members = CHARACTERS.filter(c => groupOf(c) === g);
    // An empty category is one nobody is in any more — it stops existing
    // rather than leaving a bare heading behind.
    if (!members.length) return;
    const collapsed = isGroupCollapsed(g);
    html += `<div class="char-group${collapsed ? ' collapsed' : ''}">
      <button class="section-label group-header" onclick="toggleGroup(${i})"
        title="Show or hide this category" aria-expanded="${!collapsed}">
        <span class="group-caret">▾</span>
        <span class="group-name">${escHtml(g)}</span>
        <span class="group-count">${members.length}</span>
      </button>
      ${members.map(c => charItem(c)).join('')}
    </div>`;
  });
  document.getElementById('char-list').innerHTML = html;
}

function charItem(c) {
  const av = avClassOf(c);
  const active = selected && c._roster_id === selected._roster_id ? ' active' : '';
  const sub = c._alias ? c._alias : c.quirk;
  return `<div class="char-item${active}" onclick="selectChar(${c._roster_id})" id="item-${c._roster_id}">
    <div class="char-avatar ${av}">${initials(c.name)}</div>
    <div class="char-info"><div class="char-name">${c.name}</div><div class="char-quirk">${sub}</div></div>
  </div>`;
}

function selectChar(id) {
  selected = CHARACTERS.find(c => c._roster_id === id);
  document.querySelectorAll('.char-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById('item-'+id);
  if (item) item.classList.add('active');
  activeTab = 'personality';
  renderProfile();
  renderRelationships();
  setView('character');
  // Matches the same query the stylesheet uses for the mobile pane slide,
  // rather than re-deriving it from innerWidth — innerWidth includes the
  // scrollbar, so the two could disagree by a few px right at the boundary.
  if (isMobileLayout()) document.getElementById('app').classList.add('mobile-main');
}

// Single source of truth for "are we in the stacked mobile layout", kept in
// step with the `@media (max-width: 640px)` block in relationships.html.
// Falls back to innerWidth where matchMedia is unavailable — notably the
// scripts/verify-relationship-sync.js harness, whose window stub provides
// only addEventListener and innerWidth.
function isMobileLayout() {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(max-width: 640px)').matches;
  }
  return window.innerWidth <= 640;
}

function mobileBack() {
  document.getElementById('app').classList.remove('mobile-main');
}

function mobileFwd(view) {
  setView(view);
  document.getElementById('app').classList.add('mobile-main');
}

function filterList(q) {
  const query = q.toLowerCase();
  // A search reaches into collapsed categories. Leaving a match hidden
  // because its heading happens to be shut is indistinguishable, from the
  // other side of the screen, from there being no such person.
  const list = document.getElementById('char-list');
  if (list) list.classList.toggle('searching', !!q);
  document.querySelectorAll('.char-item').forEach(el => {
    const name = el.querySelector('.char-name').textContent.toLowerCase();
    const quirk = el.querySelector('.char-quirk').textContent.toLowerCase();
    el.style.display = (name.includes(query)||quirk.includes(query)) ? '' : 'none';
  });
  document.querySelectorAll('.section-label').forEach(el => el.style.display = q ? 'none' : '');
}

/* ── Profile ──────────────────────────────────────────── */
function renderProfile() {
  const c = selected;
  const avEl = document.getElementById('profile-avatar');
  avEl.textContent = initials(c.name);
  const [avBg, avColor] = AV_COLORS[avClassOf(c)] || AV_COLORS['av-npc'];
  avEl.style.background = avBg; avEl.style.color = avColor;
  document.getElementById('profile-name').innerHTML =
    `<input class="name-input" type="text" value="${escHtml(c.name||'')}" onchange="onNameChange(this.value)" title="Character name">`;

  document.getElementById('profile-sub').innerHTML = `
    <input class="sub-input sub-input-quirk" type="text" value="${escHtml(c.quirk||'')}" placeholder="Quirk" onchange="onSubFieldChange('quirk',this.value)" title="Quirk">
    <span class="sub-sep">·</span>
    <select class="sub-select" onchange="onGroupChange(this.value)" title="Category">${groupOptionsHtml(groupOf(c))}</select>
    <span class="sub-sep">·</span>
    <input class="sub-input" type="text" value="${escHtml(c.physiology||'')}" placeholder="Physiology" onchange="onSubFieldChange('physiology',this.value)" title="Physiology">
    <span class="sub-sep">·</span>
    <input class="sub-input sub-input-narrow" type="text" value="${escHtml(c.height||'')}" placeholder="Height" onchange="onSubFieldChange('height',this.value)" title="Height">
    <span class="sub-sep">·</span>
    <input class="sub-input sub-input-narrow" type="text" value="${escHtml(c.gender||'')}" placeholder="Gender" onchange="onSubFieldChange('gender',this.value)" title="Gender">
  `;

  const tags = document.getElementById('tags-row');
  const lv = c.level || 1;
  const prof = Math.floor((lv - 1) / 4) + 2;
  const wisMod = (c.modifiers || {}).WIS ?? Math.floor(((c.ability_scores || {}).WIS ?? 10) - 10) / 2 | 0;
  const passivePerc = 10 + wisMod + prof;
  let tagHtml = '';
  if (c.is_pc) tagHtml += '<span class="tag tag-pc">PC</span>';
  tagHtml += `<div class="edit-wrap"><label>Lv</label><input class="stat-input" type="number" min="1" max="20" value="${lv}" onchange="onStatChange('level',this.value,false)" title="Level"></div>`;
  tagHtml += `<div class="edit-wrap"><label>HP</label><input class="stat-input" type="number" min="1" value="${c.HP||10}" onchange="onStatChange('HP',this.value,false)" title="Max HP"></div>`;
  tagHtml += `<div class="edit-wrap"><label>AC</label><input class="stat-input" type="number" min="1" value="${c.AC||10}" onchange="onStatChange('AC',this.value,false)" title="Armour Class"></div>`;
  tagHtml += `<div class="edit-wrap"><label>Class</label><input class="class-input" type="text" value="${escHtml(c.suggested_class||'')}" onchange="onClassChange(this.value)" title="Class"></div>`;
  tagHtml += `<div class="stat-chip" title="Proficiency bonus (level ${lv})">Prof +${prof}</div>`;
  tagHtml += `<div class="stat-chip" title="Passive Perception = 10 + WIS mod + Prof">Passive ${passivePerc}</div>`;
  tagHtml += `<button class="profile-action-btn" onclick="copyStatBlock()" title="Copy stat block to clipboard">⧉ Copy</button>`;
  // Only people added from this page can be removed here. Deleting a roster
  // student would leave roster.json disagreeing with the bundle, and they'd
  // reappear on the next load anyway.
  if (c._custom && canWrite) {
    tagHtml += `<button class="profile-action-btn danger" onclick="onDeletePerson()" title="Remove this person">✕ Remove</button>`;
  }
  tags.innerHTML = tagHtml;

  const sc = c.ability_scores || {};
  const mo = c.modifiers || {};
  document.getElementById('scores-row').innerHTML = STAT_KEYS.map(k => {
    const val = sc[k] ?? 10;
    const mod = mo[k] ?? Math.floor((val-10)/2);
    return `<div class="score-block">
      <span class="score-label">${k}</span>
      <input class="score-val-input" type="number" min="1" max="30" value="${val}" onchange="onAbilityScoreChange('${k}',this.value)" title="${k}">
      <span class="score-mod" id="mod-${k}">${(mod>=0?'+':'')+mod}</span>
    </div>`;
  }).join('');

  showTab(activeTab);
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function copyStatBlock() {
  const c = selected;
  if (!c) return;
  const lv = c.level || 1;
  const prof = Math.floor((lv - 1) / 4) + 2;
  const mo = c.modifiers || {};
  const sc = c.ability_scores || {};
  const fmt = k => { const v = sc[k] ?? 10; const m = mo[k] ?? (Math.floor((v-10)/2)); return `${k} ${m>=0?'+':''}${m}`; };
  const line = `${c.name} — Lv ${lv} ${c.suggested_class||''} | HP: ${c.HP||10}  AC: ${c.AC||10}  Prof: +${prof} | ${['STR','DEX','CON','INT','WIS','CHA'].map(fmt).join('  ')}`;
  navigator.clipboard.writeText(line).then(() => {
    const btn = document.querySelector('.profile-action-btn');
    if (btn && btn.textContent.includes('Copy')) { btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = '⧉ Copy', 1500); }
  });
}

function showTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.trim().toLowerCase().replace(/\s+/g,'')===tab.replace(/\s+/g,''));
  });
  const c = selected;
  if (tab==='personality') {
    return renderEditableTab((c.personality||{}).summary||'', v => { c.personality = c.personality||{}; c.personality.summary = v; });
  }
  if (tab==='appearance') {
    const app = c.appearance||{};
    return renderEditableTab([app.hair,app.build,app.other].filter(Boolean).join(' — '), v => { c.appearance = { hair: null, build: null, other: v }; });
  }
  if (tab==='combat') {
    return renderEditableTab((c.dm_notes||{}).combat_role||'', v => { c.dm_notes = c.dm_notes||{}; c.dm_notes.combat_role = v; });
  }
  if (tab==='social') {
    return renderEditableTab((c.dm_notes||{}).social_role||'', v => { c.dm_notes = c.dm_notes||{}; c.dm_notes.social_role = v; });
  }
  if (tab==='background') {
    return renderEditableTab(c.backstory||'', v => { c.backstory = v; });
  }
  if (tab==='attacks') {
    return renderAttacksTab(c);
  }
  if (tab==='inventory') {
    return renderInventoryTab(c);
  }
  if (tab==='additionalfeatures') {
    return renderEditableTab(c.additional_features||'', v => { c.additional_features = v; });
  }
}

function renderAttacksTab(c) {
  const tabContent = document.getElementById('tab-content');
  tabContent.classList.remove('tab-quirk', 'tab-inventory');
  tabContent.classList.add('tab-attacks');
  c.quirk_mechanics = c.quirk_mechanics || {};
  const abilities = c.quirk_mechanics.abilities = c.quirk_mechanics.abilities || [];

  const cards = abilities.map((a) => canWrite ? attackEditHtml(a) : attackReadHtml(a));

  if (!abilities.length) {
    cards.push(`<div class="ability-card locked"><div class="ability-name">No attacks recorded</div></div>`);
  }

  if (canWrite) {
    cards.push(`<button class="add-attack-btn" onclick="onAttackAdd()">+ Add attack</button>`);
    cards.push(attackDatalists());
  }

  tabContent.innerHTML = cards.join('');
}

/* ── Attack cards ──────────────────────────────────────────
   Every structured field below is optional and additive. Older
   attacks carry all of this inside `description` as prose, and are
   left exactly as written — an attack with no range/damage renders
   the same way it always did, just without the chip row.

   `type` stays a free-text input rather than becoming a <select>:
   real entries look like "Action; costs 2 Heat Points", which a
   fixed option list would silently discard. The datalist offers the
   common values without constraining what can be typed.
   ───────────────────────────────────────────────────────────── */

const ATTACK_COSTS = ['Action', 'Bonus Action', 'Reaction', 'Free Action', 'Full-turn Action', 'Passive'];
const DAMAGE_TYPES = ['bludgeoning','piercing','slashing','fire','cold','lightning','thunder',
                      'acid','poison','radiant','necrotic','force','psychic'];
const SAVE_ABILITIES = ['STR','DEX','CON','INT','WIS','CHA','TECH'];

function attackDatalists() {
  // Emitted once per render, shared by every card on the page.
  return `
    <datalist id="dl-attack-cost">${ATTACK_COSTS.map(v => `<option value="${v}">`).join('')}</datalist>
    <datalist id="dl-damage-type">${DAMAGE_TYPES.map(v => `<option value="${v}">`).join('')}</datalist>`;
}

function attackEditHtml(a) {
  const id = escHtml(a.id);
  const hitMode = a.hitMode || (a.saveAbility ? 'save' : a.attackBonus ? 'attack' : '');
  const f = (field, val) => `oninput="onAttackEdit('${id}','${field}',this.value)"` + ` value="${escHtml(val || '')}"`;
  return `
    <div class="ability-card ability-card-editable">
      <div class="ability-edit-row">
        <input class="ability-input ability-input-name" placeholder="Attack name" ${f('name', a.name)}>
        <button class="icon-btn ability-delete-btn" title="Delete attack" aria-label="Delete attack" onclick="onAttackDelete('${id}')">✕</button>
      </div>

      <div class="atk-grid">
        <label class="atk-field">
          <span>Cost</span>
          <input class="ability-input" list="dl-attack-cost" placeholder="Action" ${f('type', a.type)}>
        </label>
        <label class="atk-field">
          <span>Range</span>
          <input class="ability-input" placeholder="80 ft / Melee" ${f('range', a.range)}>
        </label>
        <label class="atk-field">
          <span>Damage</span>
          <input class="ability-input atk-dice" placeholder="3d8" ${f('damage', a.damage)}>
        </label>
        <label class="atk-field">
          <span>Damage type</span>
          <input class="ability-input" list="dl-damage-type" placeholder="radiant" ${f('damageType', a.damageType)}>
        </label>
      </div>

      <div class="atk-grid atk-grid-hit">
        <label class="atk-field">
          <span>Resolves as</span>
          <select class="ability-input" onchange="onAttackEdit('${id}','hitMode',this.value)">
            <option value=""       ${hitMode === ''       ? 'selected' : ''}>— none —</option>
            <option value="attack" ${hitMode === 'attack' ? 'selected' : ''}>Attack roll</option>
            <option value="save"   ${hitMode === 'save'   ? 'selected' : ''}>Saving throw</option>
          </select>
        </label>
        ${hitMode === 'attack' ? `
        <label class="atk-field">
          <span>To hit</span>
          <input class="ability-input atk-dice" placeholder="+5" ${f('attackBonus', a.attackBonus)}>
        </label>` : ''}
        ${hitMode === 'save' ? `
        <label class="atk-field">
          <span>Save</span>
          <select class="ability-input" onchange="onAttackEdit('${id}','saveAbility',this.value)">
            <option value="">—</option>
            ${SAVE_ABILITIES.map(s => `<option value="${s}" ${a.saveAbility === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <label class="atk-field">
          <span>DC</span>
          <input class="ability-input atk-dice" placeholder="15" ${f('saveDC', a.saveDC)}>
        </label>` : ''}
      </div>

      <textarea class="ability-input ability-input-desc" rows="2" placeholder="Description — anything the fields above don't cover" oninput="onAttackEdit('${id}','description',this.value)">${escHtml(a.description||'')}</textarea>
    </div>`;
}

function attackReadHtml(a) {
  const id = escHtml(a.id);
  const chips = [];
  if (a.range)  chips.push(`<span class="atk-chip">▸ ${escHtml(a.range)}</span>`);
  if (a.damage) chips.push(`<span class="atk-chip atk-chip-dmg">▸ ${escHtml(a.damage)}${a.damageType ? ' ' + escHtml(a.damageType) : ''}</span>`);
  if (a.hitMode === 'attack' && a.attackBonus) chips.push(`<span class="atk-chip">▸ ${escHtml(a.attackBonus)} to hit</span>`);
  if (a.hitMode === 'save' && (a.saveAbility || a.saveDC)) {
    chips.push(`<span class="atk-chip">▸ ${escHtml(a.saveAbility || '')} save${a.saveDC ? ' DC ' + escHtml(a.saveDC) : ''}</span>`);
  }

  // Roll buttons appear only where there is something valid to roll, so an
  // attack that only carries prose looks exactly as it did before.
  const rolls = [];
  if (a.hitMode === 'attack' && a.attackBonus && parseAttackBonus(a.attackBonus) !== null) {
    rolls.push(`<button class="atk-roll" onclick="rollAttackToHit('${id}')" title="Roll d20 to hit">⬡ To hit</button>`);
  }
  if (a.damage && parseDiceExpr(a.damage)) {
    rolls.push(`<button class="atk-roll atk-roll-dmg" onclick="rollAttackDamage('${id}')" title="Roll damage">⬡ ${escHtml(a.damage)}</button>`);
  }

  return `
    <div class="ability-card">
      <div class="ability-name">${escHtml(a.name||'')}${a.type ? `<span class="ability-type">${escHtml(a.type)}</span>` : ''}</div>
      ${chips.length ? `<div class="atk-chips">${chips.join('')}</div>` : ''}
      ${a.description ? `<div class="ability-desc">${escHtml(a.description)}</div>` : ''}
      ${rolls.length ? `<div class="atk-rolls">${rolls.join('')}</div>` : ''}
    </div>`;
}

// Attacks and inventory items are addressed by their stable id, never by array
// position. fsMergeSave rebuilds these arrays in *server* order and appends
// genuinely-new local items at the end, so the order after any save or remote
// merge need not match the order the DOM was rendered from. Handlers baked with
// a render-time index therefore write into whichever item happens to occupy
// that slot afterwards — so an edit lands on the wrong attack and the one you
// were editing appears to revert on the next render. The ids already exist for
// exactly this reason: they are what fsMergeSave merges on (see genId /
// ensureCharIds).
function findAbility(id) {
  return (selected.quirk_mechanics?.abilities || []).find(a => a.id === id);
}

function onAttackEdit(id, field, value) {
  const ability = findAbility(id);
  if (!ability) return;
  ability[field] = value;
  scheduleCharSave(selected);
  // Changing how an attack resolves swaps which inputs are relevant, so the
  // card has to be rebuilt. Safe to re-render here and nowhere else in this
  // handler: hitMode is driven by a <select>'s change event, which fires on
  // commit rather than per keystroke, so no caret is lost.
  if (field === 'hitMode') renderAttacksTab(selected);
}

/* ── Rolling an attack ─────────────────────────────────────
   These reuse the page's existing dice pipeline rather than
   duplicating it: the same history list, the same result panel,
   and the same tumble animation the manual roller uses.
   ───────────────────────────────────────────────────────────── */

// "3d8", "2d6+3", "1d10 - 1" -> {count, sides, mod}, or null if unparseable.
// Deliberately strict: anything it cannot read gets no Roll button at all,
// rather than a button that silently rolls something wrong.
function parseDiceExpr(raw) {
  const m = String(raw || '').replace(/\s+/g, '').match(/^(\d{1,3})d(\d{1,3})([+-]\d{1,3})?$/i);
  if (!m) return null;
  const count = parseInt(m[1], 10), sides = parseInt(m[2], 10);
  if (count < 1 || count > 100 || sides < 2) return null;
  return { count, sides, mod: m[3] ? parseInt(m[3], 10) : 0 };
}

// "+5", "5", "-1" -> number, or null.
function parseAttackBonus(raw) {
  const m = String(raw || '').replace(/\s+/g, '').match(/^([+-]?\d{1,3})$/);
  return m ? parseInt(m[1], 10) : null;
}

// Rolls a parsed expression through the shared result/history path.
// `label` is what shows in the history row, so an attack roll reads as
// "Laser Beam — damage" rather than an anonymous "1d8".
function rollParsed({ count, sides, mod }, label) {
  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const isCrit   = sides === 20 && count === 1 && rolls[0] === 20;
  const isFumble = sides === 20 && count === 1 && rolls[0] === 1;
  const entry = { label, rolls, mod, total, isCrit, isFumble };
  diceHistory.unshift(entry);
  if (diceHistory.length > 12) diceHistory.pop();
  renderDiceResult(entry);
  renderDiceHistory();
  return entry;
}

function rollAttackToHit(id) {
  const a = findAbility(id);
  if (!a) return;
  const bonus = parseAttackBonus(a.attackBonus);
  if (bonus === null) return;
  setView('dice');
  rollParsed({ count: 1, sides: 20, mod: bonus }, `${a.name || 'Attack'} — to hit`);
}

function rollAttackDamage(id) {
  const a = findAbility(id);
  if (!a) return;
  const expr = parseDiceExpr(a.damage);
  if (!expr) return;
  setView('dice');
  rollParsed(expr, `${a.name || 'Attack'} — damage`);
}

function onAttackAdd() {
  selected.quirk_mechanics.abilities.push({ id: genId('atk'), name: '', type: '', description: '' });
  scheduleCharSave(selected);
  renderAttacksTab(selected);
}

function onAttackDelete(id) {
  const abilities = selected.quirk_mechanics.abilities;
  const idx = abilities.findIndex(a => a.id === id);
  if (idx === -1) return;
  abilities.splice(idx, 1);
  scheduleCharSave(selected);
  renderAttacksTab(selected);
}

/* ── Inventory ─────────────────────────────────────────
   Currency denominations & Yen (¥) conversion rates are from
   the MHA D&D Official Handbook, Chapter 4: Equipment.

   Alongside coin, the handbook runs several parallel economies that a
   character accumulates and spends between sessions, and which the DM
   hands out as mission rewards. They are tracked here rather than as
   free-text items because they are counters the DM grants in bulk (see
   the grant panel in admin.js), and because several have hard caps that
   only mean something if the number is a number:

     · Crafting parts (Ch. 4) — the two part economies that gate suit and
       support-item construction. Deliberately kept as six separate
       counters, not three: a Pro Suit needs "6 Pro Parts" while an
       Advanced Tool needs "4 Advanced Parts", and though both cost
       ¥5,000 the handbook never lets one substitute for the other.
     · Points (Ch. 5 & 6) — Plus Ultra, Free Time Points, Awakening
       Points, and the two per-long-rest pools whose size is derived
       from the proficiency bonus.

   Specialization pools (Fury/Speed/Protective Points) and quirk-specific
   ones (Hot/Cold Points) are NOT in the fixed list: only one of the 13
   specializations grants any given pool, so showing all of them to all
   20 characters would be noise. They live in `pools` instead — free-form
   named counters, with the handbook's own pool names offered as a
   datalist so the common ones are still one click away.
   ───────────────────────────────────────────────────────────── */
const CURRENCY_KEYS = ['yen','pp','gp','ep','sp','cp'];
const CURRENCY_LABELS = { yen: '¥ Yen', pp: 'PP', gp: 'GP', ep: 'EP', sp: 'SP', cp: 'CP' };
const CURRENCY_TO_YEN = { yen: 1, cp: 10, sp: 100, ep: 500, gp: 1000, pp: 10000 };

// Ch. 4 — "Gather Your Suit Parts" and "Gather Your Parts" (support items).
const PART_DEFS = [
  { key: 'basic',     label: 'Basic',     group: 'Suit parts',    yen: 2000,  hint: 'DIY 3 · Starter 5' },
  { key: 'pro',       label: 'Pro',       group: 'Suit parts',    yen: 5000,  hint: 'Pro 6 · Elite 8 · Prototype 10' },
  { key: 'advMod',    label: 'Adv. Mod',  group: 'Suit parts',    yen: 10000, hint: 'Prototype suit 5' },
  { key: 'basicTech', label: 'Basic Tech',group: 'Support parts', yen: 2000,  hint: 'Basic Gadget 2 · Enhanced Gear 4' },
  { key: 'advanced',  label: 'Advanced',  group: 'Support parts', yen: 5000,  hint: 'Advanced Tool 4 · Elite 6 · Prototype 8' },
  { key: 'uniqueMod', label: 'Unique Mod',group: 'Support parts', yen: 10000, hint: 'Boss drops · black market' },
];
const PART_KEYS = PART_DEFS.map(p => p.key);

// `max` is a function of the character (or null for uncapped) so the two
// per-long-rest pools track the proficiency bonus as the character levels,
// instead of freezing whatever the number was when it was first written.
const POINT_DEFS = [
  { key: 'plusUltra',     label: 'Plus Ultra',       max: () => 1,           note: 'Ch. 6 — only one may be held at a time' },
  { key: 'ftp',           label: 'Free Time',        max: null,              note: 'Ch. 5 — 1 (D-rank) to 5 (S-rank) per mission' },
  { key: 'awakening',     label: 'Awakening',        max: () => 3,           note: 'Ch. 6 — 3 forces a Quirk Awakening' },
  { key: 'tacticalSurge', label: 'Tactical Surge',   max: c => 1 + profOf(c),note: 'Ch. 3 — 1 + proficiency, regained on a long rest' },
  { key: 'impactFrame',   label: 'Impact Frame',     max: c => profOf(c),    note: 'Ch. 6 — proficiency bonus, per long rest' },
];
const POINT_KEYS = POINT_DEFS.map(p => p.key);

// Handbook pool names offered by the custom-pool datalist. Each comes from
// exactly one specialization (or one quirk), which is why none of them are
// in POINT_DEFS above.
const POOL_SUGGESTIONS = [
  'Fury Points', 'Speed Points', 'Protective Points',
  'Hot Points', 'Cold Points', 'Quirk Charges', 'Charges', 'Smash %',
];

// The character sheets carry an explicit proficiency_bonus, but it is not
// guaranteed to be in step with `level` (it is hand-entered, and some
// entries predate the level field). Prefer it when present, otherwise
// derive it the 5e way.
function profOf(c) {
  const stored = parseInt(c?.proficiency_bonus, 10);
  if (!isNaN(stored) && stored > 0) return stored;
  return Math.floor(((parseInt(c?.level, 10) || 1) - 1) / 4) + 2;
}

function renderInventoryTab(c) {
  const tabContent = document.getElementById('tab-content');
  tabContent.classList.remove('tab-quirk', 'tab-attacks');
  tabContent.classList.add('tab-inventory');
  c.inventory = c.inventory || {};
  const currency = c.inventory.currency = c.inventory.currency || { yen: 0, cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const parts  = c.inventory.parts  = c.inventory.parts  || {};
  const points = c.inventory.points = c.inventory.points || {};
  const pools  = c.inventory.pools  = c.inventory.pools  || [];
  const items = c.inventory.items = c.inventory.items || [];

  const totalYen = CURRENCY_KEYS.reduce((sum, k) => sum + (currency[k]||0) * CURRENCY_TO_YEN[k], 0);

  const currencyBlocks = CURRENCY_KEYS.map(k => `
    <div class="inv-currency-block">
      <label>${CURRENCY_LABELS[k]}</label>
      <input class="inv-currency-input" type="number" min="0" value="${currency[k]||0}"
        ${canEditInventory ? `onchange="onCurrencyChange('${k}',this.value)"` : 'disabled'} title="${CURRENCY_LABELS[k]}">
    </div>`).join('');

  const partsYen = PART_DEFS.reduce((sum, p) => sum + (parts[p.key]||0) * p.yen, 0);
  const partGroups = ['Suit parts', 'Support parts'].map(group => `
    <div class="inv-part-group">
      <div class="inv-part-group-label">${group}</div>
      <div class="inv-currency-row">
        ${PART_DEFS.filter(p => p.group === group).map(p => `
        <div class="inv-currency-block" title="¥${p.yen.toLocaleString()} each — ${p.hint}">
          <label>${p.label}</label>
          <input class="inv-currency-input" type="number" min="0" value="${parts[p.key]||0}"
            ${canEditInventory ? `onchange="onPartChange('${p.key}',this.value)"` : 'disabled'}>
        </div>`).join('')}
      </div>
    </div>`).join('');

  const pointBlocks = POINT_DEFS.map(p => {
    const max = p.max ? p.max(c) : null;
    const val = points[p.key] || 0;
    const over = max !== null && val > max;
    return `
    <div class="inv-currency-block inv-point-block${over ? ' over-cap' : ''}" title="${escHtml(p.note)}">
      <label>${p.label}</label>
      <input class="inv-currency-input" type="number" min="0" value="${val}"
        ${canEditInventory ? `onchange="onPointChange('${p.key}',this.value)"` : 'disabled'}>
      <span class="inv-point-max">${max !== null ? 'of ' + max : '—'}</span>
    </div>`;
  }).join('');

  const poolCards = pools.map(p => canEditInventory ? `
    <div class="inv-pool-row">
      <input class="ability-input inv-pool-name" placeholder="Pool name" list="dl-pool-name"
        value="${escHtml(p.name||'')}" oninput="onPoolEdit('${escHtml(p.id)}','name',this.value)">
      <input class="ability-input inv-pool-num" type="number" min="0" title="Current"
        value="${p.value ?? 0}" oninput="onPoolEdit('${escHtml(p.id)}','value',this.value)">
      <span class="inv-pool-sep">/</span>
      <input class="ability-input inv-pool-num" type="number" min="0" placeholder="max" title="Maximum (optional)"
        value="${p.max ?? ''}" oninput="onPoolEdit('${escHtml(p.id)}','max',this.value)">
      <button class="icon-btn ability-delete-btn" title="Delete pool" aria-label="Delete pool" onclick="onPoolDelete('${escHtml(p.id)}')">✕</button>
    </div>` : `
    <div class="inv-pool-row inv-pool-row-read">
      <span class="inv-pool-name-read">${escHtml(p.name||'')}</span>
      <span class="inv-pool-val-read">${p.value ?? 0}${p.max ? ' / ' + p.max : ''}</span>
    </div>`).join('');

  const mayEditItems = canEditItems(c);
  const itemCards = items.map((it, i) => {
    if (mayEditItems) {
      return `
    <div class="ability-card ability-card-editable">
      <div class="ability-edit-row">
        <input class="ability-input ability-input-name" placeholder="Item name" value="${escHtml(it.name||'')}" oninput="onItemEdit('${escHtml(it.id)}','name',this.value)">
        <input class="ability-input inv-item-qty" type="number" min="0" placeholder="Qty" value="${it.qty ?? 1}" oninput="onItemEdit('${escHtml(it.id)}','qty',this.value)" title="Quantity">
        <button class="icon-btn ability-delete-btn" title="Delete item" aria-label="Delete item" onclick="onItemDelete('${escHtml(it.id)}')">✕</button>
      </div>
      <textarea class="ability-input ability-input-desc" rows="2" placeholder="Notes (e.g. weight, effect, where it came from)" oninput="onItemEdit('${escHtml(it.id)}','notes',this.value)">${escHtml(it.notes||'')}</textarea>
    </div>`;
    }
    return `
    <div class="ability-card">
      <div class="ability-name">${escHtml(it.name||'')}${(it.qty ?? 1) !== 1 ? `<span class="ability-type">×${it.qty ?? 1}</span>` : ''}</div>
      ${it.notes ? `<div class="ability-desc">${escHtml(it.notes)}</div>` : ''}
    </div>`;
  });

  if (!items.length) {
    itemCards.push(`<div class="inv-empty">No items yet.</div>`);
  }
  if (mayEditItems) {
    itemCards.push(`<button class="add-attack-btn" onclick="onItemAdd()">+ Add item</button>`);
  }

  tabContent.innerHTML = `
    <div class="inv-locked-note">
      ${mayEditItems
        ? `Items are yours — add, edit and delete them as you like; they save
           themselves. Money, parts and points are not: they arrive by being
           earned, granted from the admin page, or bought in the
           <a href="../shop.html">Shop</a>, and every change lands on the Bank
           statement. The database itself refuses any write that would make a
           purse worth more, so nobody can top themselves up.`
        : `This is a view. Money and gear arrive by being earned, granted from
           the admin page, or bought in the <a href="../shop.html">Shop</a> —
           and every change lands on the Bank statement. The database itself
           refuses any write that would make a purse worth more, so nobody can
           top themselves up.`}
    </div>
    <div class="inv-currency-panel">
      <div class="inv-currency-title">Currency</div>
      <div class="inv-currency-row">${currencyBlocks}</div>
      <div class="inv-currency-total">Total value: <strong>¥${totalYen.toLocaleString()}</strong> <span title="1cp=¥10 · 1sp=¥100 · 1ep=¥500 · 1gp=¥1,000 · 1pp=¥10,000">(handbook conversion)</span></div>
    </div>

    <div class="inv-currency-panel">
      <div class="inv-currency-title">Crafting parts</div>
      ${partGroups}
      <div class="inv-currency-total">Stock value: <strong>¥${partsYen.toLocaleString()}</strong> <span title="Basic ¥2,000 · Pro/Advanced ¥5,000 · Mods ¥10,000">(handbook prices)</span></div>
    </div>

    <div class="inv-currency-panel">
      <div class="inv-currency-title">Points &amp; resources</div>
      <div class="inv-currency-row">${pointBlocks}</div>
      ${pools.length || canEditInventory ? `
      <div class="inv-part-group">
        <div class="inv-part-group-label">Specialization &amp; quirk pools</div>
        ${poolCards || '<div class="inv-empty">None tracked.</div>'}
        ${canEditInventory ? `
        <button class="add-attack-btn inv-add-pool" onclick="onPoolAdd()">+ Add pool</button>
        <datalist id="dl-pool-name">${POOL_SUGGESTIONS.map(v => `<option value="${v}">`).join('')}</datalist>` : ''}
      </div>` : ''}
    </div>

    <div class="inv-items-title">Items</div>
    ${itemCards.join('')}
  `;
}

function onCurrencyChange(key, value) {
  if (!canEditInventory) return;
  const num = Math.max(0, parseInt(value) || 0);
  selected.inventory.currency[key] = num;
  scheduleCharSave(selected);
  renderInventoryTab(selected);
}

function onPartChange(key, value) {
  if (!canEditInventory) return;
  selected.inventory.parts = selected.inventory.parts || {};
  selected.inventory.parts[key] = Math.max(0, parseInt(value) || 0);
  scheduleCharSave(selected);
  renderInventoryTab(selected);
}

function onPointChange(key, value) {
  if (!canEditInventory) return;
  selected.inventory.points = selected.inventory.points || {};
  selected.inventory.points[key] = Math.max(0, parseInt(value) || 0);
  scheduleCharSave(selected);
  // Re-rendered so the over-cap highlight updates. Safe here (and not in
  // onPoolEdit below) because these are onchange, which fires on commit
  // rather than per keystroke, so there is no caret to lose.
  renderInventoryTab(selected);
}

/* Custom pools are an id-keyed array for the same reason attacks and items
   are: fsMergeSave merges them by id, and handlers must address them by id
   rather than by render-time index. See the note above findAbility. */
function onPoolEdit(id, field, value) {
  if (!canEditInventory) return;
  const pool = (selected.inventory?.pools || []).find(p => p.id === id);
  if (!pool) return;
  if (field === 'name') pool.name = value;
  else if (field === 'max') pool.max = value === '' ? null : Math.max(0, parseInt(value) || 0);
  else pool.value = Math.max(0, parseInt(value) || 0);
  scheduleCharSave(selected);
}

function onPoolAdd() {
  if (!canEditInventory) return;
  selected.inventory.pools = selected.inventory.pools || [];
  selected.inventory.pools.push({ id: genId('pool'), name: '', value: 0, max: null });
  scheduleCharSave(selected);
  renderInventoryTab(selected);
}

function onPoolDelete(id) {
  if (!canEditInventory) return;
  const pools = selected.inventory?.pools || [];
  const idx = pools.findIndex(p => p.id === id);
  if (idx === -1) return;
  pools.splice(idx, 1);
  scheduleCharSave(selected);
  renderInventoryTab(selected);
}

/* Items are the editable half of this tab, and they save themselves — to the
   inventories collection, not the bundle, so scheduleItemsSave rather than
   scheduleCharSave. Calling the latter here would mark the whole *sheet*
   dirty, holding back everyone else's edits behind a Save button press for a
   change that never travels in that document anyway.

   Addressed by id, not index — same reasoning as onAttackEdit above. */
function onItemEdit(id, field, value) {
  if (!canEditItems(selected)) return;
  const item = (selected.inventory?.items || []).find(it => it.id === id);
  if (!item) return;
  item[field] = field === 'qty' ? Math.max(0, parseInt(value) || 0) : value;
  scheduleItemsSave(selected);
}

function onItemAdd() {
  if (!canEditItems(selected)) return;
  selected.inventory.items = selected.inventory.items || [];
  selected.inventory.items.push({ id: genId('item'), name: '', qty: 1, notes: '' });
  scheduleItemsSave(selected);
  renderInventoryTab(selected);
}

function onItemDelete(id) {
  if (!canEditItems(selected)) return;
  const items = selected.inventory?.items || [];
  const idx = items.findIndex(it => it.id === id);
  if (idx === -1) return;
  items.splice(idx, 1);
  scheduleItemsSave(selected);
  renderInventoryTab(selected);
}

/* ── Editable tab content ────────────────────────────── */
let currentTabSave = null;

function renderEditableTab(value, onSave) {
  currentTabSave = onSave;
  const tabContent = document.getElementById('tab-content');
  tabContent.classList.remove('tab-quirk', 'tab-attacks', 'tab-inventory');
  if (canWrite) {
    tabContent.innerHTML = `<textarea class="tab-editable" rows="4" placeholder="Nothing here yet — click to add." oninput="onTabEdit(this.value)">${escHtml(value)}</textarea>`;
  } else {
    tabContent.textContent = value;
  }
}

function onTabEdit(value) {
  if (currentTabSave) currentTabSave(value);
  scheduleCharSave(selected);
}

/* ── Relationships ────────────────────────────────────── */
function renderRelationships() {
  const c = selected;
  document.getElementById('rel-heading').textContent = c.name+"'s view of the cast";
  const others = CHARACTERS.filter(o => o._roster_id !== c._roster_id && o._section === 'class-1a');
  let html = '';
  for (const o of others) {
    const rel = getRel(c._roster_id, o._roster_id);
    const score = rel.score||0;
    const scoreStr = score>0?'+'+score:''+score;
    const scoreClass = score<0?'score-neg':score>0?'score-pos':'score-zero';
    const av = avClassOf(o);
    // Their category, except for the class itself — which is the default and
    // would just repeat the same three words down the whole list.
    const og = groupOf(o);
    const sub = [o.quirk, og === CLASS_GROUP ? '' : og].filter(Boolean).join(' · ');
    html += `<div class="rel-row">
      <div><div style="display:flex;align-items:center;gap:6px">
        <div class="char-avatar ${av}" style="width:24px;height:24px;font-size:9px;flex-shrink:0">${initials(o.name)}</div>
        <div><div class="rel-char-name">${o.name}</div><div class="rel-char-quirk">${escHtml(sub)}</div></div>
      </div></div>
      <div class="rel-controls">
        <div class="slider-wrap"><input type="range" class="rel-slider" min="-10" max="10" step="1" value="${score}" oninput="setRelScore(${c._roster_id},${o._roster_id},this.value)"></div>
        <div class="rel-labels"><span>hate −10</span><span>0</span><span>love +10</span></div>
        <textarea class="rel-note" rows="1" placeholder="Add a note…" oninput="setRelNote(${c._roster_id},${o._roster_id},this.value)">${escHtml(rel.note||'')}</textarea>
      </div>
      <div class="rel-score ${scoreClass}" id="score-${c._roster_id}-${o._roster_id}">${scoreStr}</div>
    </div>`;
  }
  document.getElementById('rel-list').innerHTML = html;
  applyRelCollapseState();
}

function getRelCollapseKey() {
  return 'relCollapsed-' + selected._roster_id;
}
function applyRelCollapseState() {
  const collapsed = localStorage.getItem(getRelCollapseKey()) === '1';
  document.getElementById('rel-list').classList.toggle('collapsed', collapsed);
  document.getElementById('rel-toggle-btn').classList.toggle('collapsed', collapsed);
  document.getElementById('rel-section').classList.toggle('collapsed', collapsed);
  document.getElementById('profile').classList.toggle('expanded', collapsed);
}
function toggleRelCollapse() {
  const key = getRelCollapseKey();
  const collapsed = localStorage.getItem(key) === '1';
  localStorage.setItem(key, collapsed ? '0' : '1');
  applyRelCollapseState();
}

/* ══════════════════════════════════════════════════════════
   DICE ROLLER
══════════════════════════════════════════════════════════ */
let diceState = { sides: 4, count: 1, mod: 0, advMode: null }; // advMode: null | 'adv' | 'dis'
let diceHistory = [];

function toggleAdvMode(mode) {
  diceState.advMode = diceState.advMode === mode ? null : mode;
  document.getElementById('dice-adv-btn').classList.toggle('active', diceState.advMode === 'adv');
  document.getElementById('dice-dis-btn').classList.toggle('active', diceState.advMode === 'dis');
  updateRollBtn();
}

function selectDie(sides, btn) {
  diceState.sides = sides;
  document.querySelectorAll('.die-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  // Adv/Dis only applies to d20
  const hint = document.getElementById('adv-hint');
  if (sides !== 20 && diceState.advMode) { diceState.advMode = null; document.getElementById('dice-adv-btn').classList.remove('active'); document.getElementById('dice-dis-btn').classList.remove('active'); }
  if (hint) hint.style.display = sides === 20 ? 'none' : (diceState.advMode ? 'inline' : 'none');
  updateRollBtn();
}
function adjustDice(delta) {
  diceState.count = Math.max(1, Math.min(20, diceState.count + delta));
  document.getElementById('dice-count').textContent = diceState.count;
  updateRollBtn();
}
function adjustMod(delta) {
  diceState.mod = Math.max(-20, Math.min(20, diceState.mod + delta));
  const el = document.getElementById('dice-mod');
  el.textContent = diceState.mod >= 0 ? '+'+diceState.mod : ''+diceState.mod;
  updateRollBtn();
}
function updateRollBtn() {
  const { count, sides, mod } = diceState;
  let label = `Roll ${count}d${sides}`;
  if (mod > 0) label += ` +${mod}`;
  else if (mod < 0) label += ` ${mod}`;
  document.getElementById('roll-btn').textContent = label;
}

function rollDice() {
  const { count, sides, mod, advMode } = diceState;

  if (advMode && sides === 20) {
    const r1 = Math.floor(Math.random() * 20) + 1;
    const r2 = Math.floor(Math.random() * 20) + 1;
    const kept = advMode === 'adv' ? Math.max(r1, r2) : Math.min(r1, r2);
    const dropped = advMode === 'adv' ? Math.min(r1, r2) : Math.max(r1, r2);
    const total = kept + mod;
    const isCrit = kept === 20;
    const isFumble = kept === 1;
    const modeLabel = advMode === 'adv' ? 'Advantage' : 'Disadvantage';
    const modStr = mod !== 0 ? (mod > 0 ? ` +${mod}` : ` ${mod}`) : '';
    const label = `d20 (${modeLabel})${modStr}`;
    const entry = { label, rolls: [kept], mod, total, isCrit, isFumble, advRolls: [r1, r2], dropped, advMode };
    diceHistory.unshift(entry);
    if (diceHistory.length > 12) diceHistory.pop();
    renderDiceResult(entry);
    renderDiceHistory();
    return;
  }

  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const isCrit = sides === 20 && count === 1 && rolls[0] === 20;
  const isFumble = sides === 20 && count === 1 && rolls[0] === 1;
  const label = `${count}d${sides}${mod>=0?'+'+mod:mod!==0?mod:''}`.replace('+0','');

  const entry = { label, rolls, mod, total, isCrit, isFumble };
  diceHistory.unshift(entry);
  if (diceHistory.length > 12) diceHistory.pop();

  renderDiceResult(entry);
  renderDiceHistory();
}

function rollExpr() {
  const inp = document.getElementById('dice-expr-inp');
  const raw = (inp?.value || '').trim();
  if (!raw) return;
  // Shares parseDiceExpr with the attack Roll buttons, so the two cannot
  // drift on what counts as a valid expression.
  const expr = parseDiceExpr(raw);
  if (!expr) {
    document.getElementById('dice-result').innerHTML = `<div style="color:var(--red-text);font-size:13px;">Invalid expression — try "2d6+3"</div>`;
    return;
  }
  const { count, sides, mod } = expr;
  rollParsed(expr, `${count}d${sides}${mod > 0 ? '+' + mod : mod < 0 ? mod : ''}`);
  inp.value = '';
}

function renderDiceResult(e) {
  const modStr = e.mod > 0 ? ` + ${e.mod}` : e.mod < 0 ? ` − ${Math.abs(e.mod)}` : '';
  const numClass = e.isCrit ? 'crit' : e.isFumble ? 'fumble' : '';
  const badge = e.isCrit ? '<div class="crit-label">★ Critical!</div>' : e.isFumble ? '<div class="fumble-label">☠ Fumble!</div>' : '';
  let rollStr;
  if (e.advRolls) {
    const [a, b] = e.advRolls;
    const keptStr = `<span style="font-weight:700;color:var(--text)">${e.rolls[0]}</span>`;
    const dropStr = `<span style="text-decoration:line-through;color:var(--text-dim)">${e.dropped}</span>`;
    rollStr = e.advMode === 'adv'
      ? (a >= b ? `${keptStr}, ${dropStr}` : `${dropStr}, ${keptStr}`)
      : (a <= b ? `${keptStr}, ${dropStr}` : `${dropStr}, ${keptStr}`);
    if (e.mod !== 0) rollStr += modStr;
  } else {
    rollStr = escHtml(e.rolls.join(', ') + modStr);
  }
  // The crit/fumble class is applied AFTER the tumble settles rather than in
  // this markup, so the impact burst in css/manga.css fires on the landing
  // frame instead of playing against a number that is still changing.
  document.getElementById('dice-result').innerHTML = `
    <div class="result-number" data-final="${e.total}">${e.total}</div>
    <div class="result-detail">
      <div class="result-label">${e.label}</div>
      <div class="result-breakdown">${rollStr}</div>
      <div class="result-badge-slot">${badge}</div>
    </div>`;
  tumbleToResult(document.querySelector('#dice-result .result-number'), e.total, numClass);
}

// Spins the total through plausible values before landing on the real one.
// Purely cosmetic: the number is already decided before this runs, so the
// result never depends on the animation completing.
//
// Degrades to an instant result if requestAnimationFrame is unavailable (the
// scripts/verify-relationship-sync.js harness) or the reader has asked for
// reduced motion — in both cases the final value and class are applied
// immediately, which is exactly what the old code did.
function tumbleToResult(el, finalTotal, numClass) {
  if (!el) return;
  const settle = () => {
    el.textContent = finalTotal;
    if (numClass) el.classList.add(numClass);
    const slot = document.querySelector('#dice-result .result-badge-slot');
    if (slot) slot.classList.add('show');
  };

  const reduced = typeof window.matchMedia === 'function' &&
                  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof requestAnimationFrame !== 'function') { settle(); return; }

  const DURATION = 460;
  const start = (typeof performance === 'object' && performance.now)
    ? performance.now() : Date.now();
  const spread = Math.max(4, Math.abs(finalTotal));
  el.classList.add('tumbling');

  const step = (now) => {
    const t = Math.min(1, (now - start) / DURATION);
    if (t < 1) {
      // ease out: samples get slower and cluster nearer the real value
      const jitter = Math.round((1 - t * t) * spread);
      const guess = finalTotal + (Math.floor(Math.random() * (jitter * 2 + 1)) - jitter);
      el.textContent = guess;
      requestAnimationFrame(step);
    } else {
      el.classList.remove('tumbling');
      settle();
    }
  };
  requestAnimationFrame(step);
}

function renderDiceHistory() {
  const el = document.getElementById('dice-history');
  if (!diceHistory.length) { el.innerHTML = ''; return; }
  el.innerHTML = diceHistory.map(e => {
    const modStr = e.mod > 0 ? ` +${e.mod}` : e.mod < 0 ? ` ${e.mod}` : '';
    const breakdown = e.rolls.join(', ') + modStr;
    const badge = e.isCrit ? '<span class="history-crit">★ Crit</span>' : e.isFumble ? '<span class="history-fumble">☠ Fumble</span>' : '';
    return `<div class="history-row">
      <span class="history-die">${e.label}</span>
      <span class="history-total">${e.total}</span>
      <span class="history-breakdown">${escHtml(breakdown)}</span>
      ${badge}
    </div>`;
  }).join('');
}

/* ── Init ──────────────────────────────────────────────── */
(async () => {
  const rosterRes = await fetch('roster.json');
  const roster = await rosterRes.json();

  // Try Firestore first, fall back to bundled JSON files
  setSaveStatus('saving', 'Loading…');
  let fsBundle = null;
  try { fsBundle = await loadFromFirestore(); } catch {}

  if (fsBundle) {
    rels = fsBundle.relationships || {};
    CHARACTERS = (roster.students || []).filter(s => s.file).map(s => {
      const c = Object.assign({}, fsBundle.characters?.[s.file] || {});
      c._file = s.file; c._roster_id = s.id; c._section = 'class-1a';
      c.name = c.name || s.name; c.quirk = c.quirk || s.quirk;
      return c;
    }).filter(c => c.name);
    // People added from this page — they exist only in the bundle, because
    // roster.json is a repo file the browser cannot write to.
    const rosterFiles = new Set(CHARACTERS.map(c => c._file));
    CHARACTERS.push(...customCharsFromBundle(fsBundle, rosterFiles));
    dedupeRosterIds(CHARACTERS);
    setSaveStatus('saved', 'Loaded from Firestore ✓');
  } else {
    const [relsRes, ...charResults] = await Promise.all([
      fetch('relationships.json'),
      ...(roster.students || []).filter(s => s.file).map(s =>
        fetch(s.file).then(r => r.json()).then(c => { c._file = s.file; c._roster_id = s.id; c._section = 'class-1a'; return c; }).catch(() => null)
      )
    ]);
    rels = await relsRes.json();
    CHARACTERS = charResults.filter(Boolean);
    setSaveStatus('saved', 'Firestore unreachable — loaded local');
  }

  for (const c of CHARACTERS) ensureCharIds(c);
  // Baseline for saveToFirestore's 3-way merge — a *copy*, never fsBundle
  // itself. The Object.assign above is a shallow copy, so every character's
  // quirk_mechanics/inventory (and the attack and item objects inside them)
  // are shared with fsBundle. Keeping fsBundle as the baseline would mean
  // editing an attack also edits the baseline, and fsMergeSave would read that
  // as "nothing changed here" and write the server's old copy back over it.
  if (fsBundle) _lastSyncedRel = fsCloneDoc(fsBundle);

  sortCharacters();
  selected = CHARACTERS[0];
  await loadInventories();
  startInventoryLiveSync();
  if (fsBundle) startRelLiveSync();
  refreshAddPersonBtn();
  renderSidebar();
  renderProfile();
  renderRelationships();
})();
// ── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (inInput) return;

  if (e.key === '1') { e.preventDefault(); setView('character'); }
  else if (e.key === '2') { e.preventDefault(); setView('dice'); }
  else if ((e.key === ' ' || e.key === 'Enter') && currentView === 'dice') {
    e.preventDefault(); rollDice();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && currentView === 'character') {
    e.preventDefault();
    const idx = CHARACTERS.findIndex(c => c._roster_id === selected?._roster_id);
    if (idx === -1) return;
    const next = e.key === 'ArrowRight'
      ? CHARACTERS[(idx + 1) % CHARACTERS.length]
      : CHARACTERS[(idx - 1 + CHARACTERS.length) % CHARACTERS.length];
    selectChar(next._roster_id);
  }
});

/* ── Export / Import ──────────────────────────────────── */
function exportData() {
  setSaveStatus('saving', 'Exporting…');
  try {
    const blob = new Blob([JSON.stringify(buildBundle(), null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mha-dnd-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    setSaveStatus('saved', 'Exported ✓');
  } catch { setSaveStatus('error', 'Export failed'); }
}

async function importData(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (!confirm(`Import "${file.name}"? This will overwrite all current character data and relationships.`)) return;
  setSaveStatus('saving', 'Importing…');
  try {
    const data = JSON.parse(await file.text());
    if (data.version !== 1) throw new Error('Unsupported version');
    if (data.relationships) rels = data.relationships;
    if (data.characters) {
      for (const c of CHARACTERS) {
        if (c._file && data.characters[c._file]) {
          const f = c._file, rid = c._roster_id;
          Object.assign(c, data.characters[c._file]);
          c._file = f; c._roster_id = rid;
        }
      }
    }
    await saveToFirestore();
    setSaveStatus('saved', 'Imported ✓ — reloading…');
    setTimeout(() => location.reload(), 800);
  } catch (e) { setSaveStatus('error', 'Import failed: ' + e.message); }
}
