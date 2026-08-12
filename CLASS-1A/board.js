// Page logic for board.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.
const db = firebase.firestore();

/* This page is the player-facing twin of the DM's Board Mode in
   encounter.html — same grid, same tokens, same live Firestore document
   (mha-dnd/encounter-state), so moves made here or there sync instantly.
   Terrain/drawings the DM marks render here too, but only the DM can edit
   them (from the Encounter Manager's Board Mode). */

// TEAM_COLORS / TERRAIN_STYLES are defined in board-shared.js (loaded above).

let encounter = { round: 1, currentIndex: 0, combatants: [], attackLog: [], boardStrokes: [], boardTerrain: [] };
// Fail closed: nobody can move tokens here until the admin check below
// resolves and says otherwise (see boardCanEdit's definition in
// board-shared.js). Everyone can still pan/zoom/measure in the meantime.
boardCanEdit = false;

const FS_ENCOUNTER_DOC = db.collection('mha-dnd').doc('encounter-state');
let encSaveTimer = null;
let _lastSyncedEncounter = null;
// True from the moment a change is made (mousedown->drop already ended, so
// boardState.dragging is back to false) until the debounced save actually
// lands. Without this, a remote snapshot arriving during the 600ms debounce
// window would wholesale-replace `encounter` with server data that predates
// this move, snapping the token back before it's ever saved.
let _encSavePending = false;

function encSave() {
  localStorage.setItem('mha_encounter_v1', JSON.stringify(encounter));
  _encSavePending = true;
  clearTimeout(encSaveTimer);
  encSaveTimer = setTimeout(async () => {
    try {
      // boardStrokes/boardTerrain merge per-item (like combatants) so moving
      // a token here can't clobber terrain/drawings the DM painted — this
      // page never edits those arrays, so they always pass through inert.
      const merged = await fsMergeSave(FS_ENCOUNTER_DOC, encounter, _lastSyncedEncounter, [
        { path: 'combatants', idKey: 'id' },
        { path: 'boardStrokes', idKey: 'id' },
        { path: 'boardTerrain', idKey: 'id' },
      ]);
      _lastSyncedEncounter = merged;
    } catch {} finally {
      _encSavePending = false;
    }
  }, 600);
}

async function encLoad() {
  try {
    await fbAuthReady;
    const snap = await FS_ENCOUNTER_DOC.get();
    if (snap.exists) {
      encounter = snap.data();
      encounter.attackLog = encounter.attackLog || [];
      encounter.boardStrokes = encounter.boardStrokes || [];
      encounter.boardTerrain = encounter.boardTerrain || [];
      _lastSyncedEncounter = fsCloneDoc(encounter); // cloned: a baseline must never alias live state (see auth.js cloneDoc)
      return;
    }
  } catch {}
  try {
    const raw = localStorage.getItem('mha_encounter_v1');
    if (raw) encounter = JSON.parse(raw);
  } catch {}
  encounter.attackLog = encounter.attackLog || [];
  encounter.boardStrokes = encounter.boardStrokes || [];
  encounter.boardTerrain = encounter.boardTerrain || [];
}

function isRangeInputFocused() {
  return document.activeElement === document.getElementById('board-range-input');
}
function isBoardBusy() {
  return !!(boardState.dragging || boardPan || isRangeInputFocused() || _encSavePending);
}

let _pendingRemoteEncounter = null;
function applyRemoteEncounter(data) {
  encounter = data;
  encounter.attackLog = encounter.attackLog || [];
  encounter.boardStrokes = encounter.boardStrokes || [];
  encounter.boardTerrain = encounter.boardTerrain || [];
  _lastSyncedEncounter = fsCloneDoc(data); // cloned: a baseline must never alias live state (see auth.js cloneDoc)
  boardBumpArtVersion(); // invalidate the cached terrain/drawing layer — `encounter` was just replaced wholesale
  renderBoard();
}
async function startEncLiveSync() {
  await fbAuthReady;
  FS_ENCOUNTER_DOC.onSnapshot(snap => {
    if (!snap.exists) return;
    // A cached snapshot is this tab's own stale copy, not news from the server.
    // When Firestore's streaming channel is blocked (Safari tracking
    // protection, content blockers, proxies) the write transport keeps working
    // while the listener replays cache — so a save commits and is then visibly
    // "undone" by data older than the write. See relationships.html.
    if (snap.metadata?.fromCache) return;
    const data = snap.data();
    if (isBoardBusy()) { _pendingRemoteEncounter = data; return; }
    applyRemoteEncounter(data);
  }, err => console.error('[board] live sync stopped:', err));
}
setInterval(() => {
  if (_pendingRemoteEncounter && !isBoardBusy()) {
    const data = _pendingRemoteEncounter;
    _pendingRemoteEncounter = null;
    applyRemoteEncounter(data);
  }
}, 800);

// The grid/tokens/drag/touch engine (constants, rendering, event wiring)
// lives in board-shared.js, loaded above — shared with the DM's Board Mode
// in encounter.html instead of a hand-kept-in-sync copy.

(async () => {
  await encLoad();
  startEncLiveSync();
  requestAnimationFrame(() => { boardFitZoom(); renderBoard(); });

  await fbAuthReady;
  boardCanEdit = !!(window.isAdmin && window.isAdmin());
  const hint = document.getElementById('board-hint');
  if (hint) {
    hint.textContent = boardCanEdit
      ? BOARD_TOOL_HINTS.move
      : 'View only — pan and zoom to see the battle. The DM controls token positions.';
  }
  const clearBtn = document.getElementById('board-clear-positions-btn');
  if (clearBtn) clearBtn.style.display = boardCanEdit ? '' : 'none';
  renderBoard(); // also re-renders the tray, now reflecting boardCanEdit
})();
