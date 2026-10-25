/* Shared tactical-board engine for the MHA D&D archive.
   Used by both encounter.html (DM — full read/write, drawing tools) and
   board.html (players — pan/zoom/measure only; the same code paths just
   never get reached there since nothing in board.html's DOM ever calls
   boardSetTool() away from 'move', and boardCanEdit gates the rest — see
   below).

   boardCanEdit (module-level, default true) gates every *mutation*: placing
   a token, dragging one, right-click/long-press removal. Pan, zoom, and the
   local-only distance/range selection always work regardless. encounter.html
   never touches this flag, so the DM keeps full read/write unconditionally.
   board.html sets it to false until an admin check resolves (fail-closed),
   then flips it based on window.isAdmin() from auth.js. A touch that lands
   on a token while boardCanEdit is false falls through to panning instead
   of starting a drag, which is also what fixes that gesture being
   ambiguous on mobile for read-only viewers.

   Previously this ~800-line engine was pasted into both pages verbatim.
   That worked but meant every fix (like the boardTerrain/boardStrokes save
   bug) had to be applied twice by hand, which is exactly how bugs like that
   slip through. One copy, one bug surface.

   The prop catalog and the preset maps live in board-prefabs.js, which both
   pages load alongside this file — see the header there for the prop data
   model. This file owns the interaction (place, select, drag, rotate, erase);
   that one owns the content (what a car looks like, which squares a city
   street covers).

   Contract — the host page must, before this <script> tag runs any of its
   functions (i.e. before DOMContentLoaded / its own init sequence, script
   tag order relative to this file doesn't matter beyond that):
     - declare `let encounter = { combatants: [], boardStrokes: [], boardTerrain: [], boardProps: [], ... }`
     - define `function encSave() { ... }` (persists + syncs `encounter`)
     - merge boardProps per-item in that save, the same way boardTerrain and
       boardStrokes are — see encounter.js's fsMergeSave call
     - call `boardBumpArtVersion()` whenever it replaces `encounter` wholesale
       (i.e. inside its own `applyRemoteEncounter`), so the cached terrain/
       drawing layer doesn't keep showing stale art after a remote update.
   The host's markup must include #board-canvas, #board-grid-wrap,
   #board-tray-list, #board-hint, #board-distance-label, #board-range-input,
   #board-zoom-label. Drawing-tool markup (.board-tool-btn[data-tool], the
   pen color input), the prefab palette (#board-props-list, #board-prop-filter,
   #board-prop-actions) and the map picker (#board-map-select) are optional —
   only encounter.html has them.
*/

const TEAM_COLORS = [
  { name: 'Red',    bg: '#D94040', light: 'rgba(217,64,64,0.12)'  },
  { name: 'Blue',   bg: '#2563EB', light: 'rgba(37,99,235,0.10)'  },
  { name: 'Green',  bg: '#2D9F4E', light: 'rgba(45,159,78,0.10)'  },
  { name: 'Orange', bg: '#E07020', light: 'rgba(224,112,32,0.10)' },
  { name: 'Purple', bg: '#8B47D4', light: 'rgba(139,71,212,0.10)' },
  { name: 'Teal',   bg: '#0E9E85', light: 'rgba(14,158,133,0.10)' },
  { name: 'Pink',   bg: '#C4438C', light: 'rgba(196,67,140,0.10)' },
  { name: 'Yellow', bg: '#C49A0A', light: 'rgba(196,154,10,0.10)' },
  { name: 'Cyan',   bg: '#0891B2', light: 'rgba(8,145,178,0.10)'  },
  { name: 'Lime',   bg: '#65A30D', light: 'rgba(101,163,13,0.10)' },
];

/* ── Duplicate combatant ids ──────────────────────────────
   Every lookup on this board resolves a token through
   `encounter.combatants.find(c => c.id === id)` — the drag drop, the tray
   placement, the team dot, the HP row. find() returns the *first* match, so
   two combatants sharing an id means edits aimed at the second one land on
   the first: the token you dragged redraws at the cell it started in (its own
   boardX never changed) and the team dot you clicked flips back, while some
   other row silently moves or changes colour. fsMergeSave has the same blind
   spot on the way out — it keys the array by id — so the edit reverts again
   from the server for good measure.

   Duplicates got into the live document two ways, both now closed: encId()
   used to restart its counter at 1 on every page load and hand out ids the
   document was already using, and the save path before the merge existed was
   a plain .set() of whatever the page held, duplicates and all.

   So repair on the way in, wherever encounter state enters a page. The new id
   is derived from the document (max + 1, + 2, …) rather than drawn at random,
   deliberately: two tabs repairing the same document independently have to
   arrive at the *same* id, or the merge sees two different new combatants and
   the duplicate comes back as two rows. Returns the number of ids changed, so
   the caller can persist the repair.

   Callers must take their fsMergeSave baseline from the raw incoming data
   *before* calling this — the baseline is "what the server holds", which is
   still the duplicated version until a save lands. */
function encRepairDuplicateIds(enc) {
  const cs = (enc && enc.combatants) || [];
  let nextId = cs.reduce((max, c) => (Number.isFinite(c.id) && c.id > max ? c.id : max), 0);
  const seen = new Set();
  let repaired = 0;
  for (const c of cs) {
    if (!seen.has(c.id)) { seen.add(c.id); continue; }
    c.id = ++nextId;
    seen.add(c.id);
    repaired++;
  }
  if (repaired) console.warn(`[board] repaired ${repaired} duplicate combatant id(s)`);
  return repaired;
}

/* ── Board Mode ───────────────────────────────────────── */
const BOARD_COLS = 100;
const BOARD_ROWS = 100;
const CELL_BASE = 16; // base px per square at zoom 1.0
let boardZoom = 0.5;  // start zoomed out to fit the full grid
let boardState = {
  pendingId: null, selectedIds: [], rangeFt: 0, dragging: null, _wasDragging: false,
  tool: 'move', penColor: '#E8A020', drawingStroke: null,
  // Props (see the Props section below): pendingProp is a prefab armed for
  // stamping, selectedPropId the placed prop that rotate/remove/drag act on,
  // propPreview the translucent footprint showing where one would land.
  pendingProp: null, selectedPropId: null, draggingProp: null, propPreview: null,
};
// Gates every board *mutation* (placing/moving/removing tokens, drawing).
// Pan, zoom, and the local-only distance/range selection always work
// regardless of this flag. Defaults true so encounter.html (DM — full
// read/write, never touches this flag) is unaffected; board.html (players)
// sets it to false until an admin check resolves. See boardHitTest callers
// below for how this also fixes touch-near-a-token being misread as a drag
// instead of a pan when editing is off.
let boardCanEdit = true;
let boardHoverInfo = null; // { combatant, col, row }
let boardPan = null;        // { startX, startY, scrollLeft, scrollTop } while panning
let _boardWasPanning = false;
let _boardPainting = false; // mid-drag while painting terrain/erasing
// The prefab key of an in-flight HTML5 drag out of the palette. dragover/drop
// on the canvas can't read dataTransfer's payload until the drop itself
// (browsers hide it during the drag for security), so the preview needs its
// own copy of what's being dragged.
let _boardDragPrefab = null;

// Terrain marker styles: fill colour + a small glyph drawn at cell centre.
const TERRAIN_STYLES = {
  wall:      { fill: 'rgba(148,152,164,0.55)', label: '▦' },
  difficult: { fill: 'rgba(168,120,46,0.38)',  label: '≋' },
  hazard:    { fill: 'rgba(239,68,68,0.38)',   label: '⚠' },
  water:     { fill: 'rgba(37,99,235,0.34)',   label: '〰' },
  cover:     { fill: 'rgba(34,197,94,0.34)',   label: '⛊' },
  // Fog is terrain so it paints, erases and saves like the rest of it; what
  // makes it fog is that the players' board redraws these squares opaque at
  // the very end of the frame. See paintFogLayer.
  fog:       { fill: 'rgba(104,78,152,0.45)',  label: '✦' },
};

const BOARD_TOOL_HINTS = {
  move: 'Click a unit in the tray, then click a grid square to place it. Drag placed tokens to move them. Drag a prefab from the palette to add scenery.',
  pen: 'Click and drag on the grid to draw.',
  wall: 'Click or drag across squares to mark walls.',
  difficult: 'Click or drag across squares to mark difficult terrain.',
  hazard: 'Click or drag across squares to mark a hazard.',
  water: 'Click or drag across squares to mark water.',
  cover: 'Click or drag across squares to mark cover.',
  fog: 'Click or drag to hide squares from the players. You still see what is under them; they see nothing.',
  note: 'Click a square to label it. Click a label again to change it, or clear the text to remove it.',
  template: 'Click to drop the area shape set above. Click inside one to take it away.',
  elev: 'Click or drag to mark squares as that many squares up (or down, with a negative number). Zero clears.',
  tint: 'Click or drag to colour squares in. Pick the colour next to the tool; the eraser takes it off again.',
  eraser: 'Click drawings, terrain, labels, elevation or scenery to erase them.',
};

// Tools that paint a terrain type of the same name, as opposed to the ones
// with their own behaviour (pen, eraser, note, template, elev).
const BOARD_TERRAIN_TOOLS = ['wall', 'difficult', 'hazard', 'water', 'cover', 'fog'];

// Only encounter.html renders the .board-tool-btn toolbar, so this is a
// no-op (and boardState.tool never leaves 'move') on board.html.
function boardSetTool(tool) {
  boardState.tool = tool;
  boardState.pendingId = null;
  boardState.selectedIds = [];
  // Placing, selecting and dragging props all live under the move tool, so
  // picking up a pen or a terrain brush puts them down.
  boardState.pendingProp = null;
  boardState.selectedPropId = null;
  boardState.propPreview = null;
  document.querySelectorAll('.board-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  renderPrefabPaletteSelection();
  updateBoardHint();
  renderBoardCanvas();
}

function boardClearArt() {
  if (!BOARD_LAYERS.some(k => (encounter[k] || []).length)) return;
  if (!confirm('Clear everything on the board — drawings, terrain, fog, scenery, labels, elevation and area shapes? Unit positions are kept.')) return;
  for (const k of BOARD_LAYERS) encounter[k] = [];
  boardState.selectedPropId = null;
  boardState.propPreview = null;
  boardBumpArtVersion();
  encSave();
  renderPrefabPaletteSelection();
  renderBoardCanvas();
}


/* ── Props: drag-and-drop scenery ──────────────────────────
   Buildings, trees, cars and the rest, from the BOARD_PREFABS catalog in
   board-prefabs.js. Stored in encounter.boardProps as
       { id, type, col, row, rot, t }
   — a flat, id-keyed array for the same reason boardTerrain/boardStrokes are
   (see boardPaintTerrainAt): encSave merges those per item, so a player
   nudging a token can't stomp scenery the DM just laid down.

   `t: 1` records that this prop stamped the terrain under itself (the
   "Auto-terrain" toggle was on when it was placed), which is what lets
   removing or moving it take that terrain back out again without touching
   walls the DM painted by hand. Prefabs whose terrain is 'clear' (doorways,
   bridge planks) delete terrain instead, and that is not reversible — pulling
   a door out does not rebuild the wall it opened.

   Unlike terrain and drawings, props are NOT baked into the cached art layer.
   There are tens of them at most, and drawing a few dozen vector shapes per
   frame costs far less than invalidating and rebuilding a full-canvas layer
   every time one is dragged a square. */

function boardPrefab(type) {
  return (typeof BOARD_PREFABS_BY_KEY !== 'undefined' && BOARD_PREFABS_BY_KEY[type]) || null;
}

// Footprint in squares. Derived from the catalog rather than stored on the
// prop, so retuning a prefab's size updates props already on the board.
function boardPropFootprint(p) {
  const pf = boardPrefab(p.type);
  const w = pf ? pf.w : 1, h = pf ? pf.h : 1;
  return (p.rot === 90 || p.rot === 270) ? { w: h, h: w } : { w, h };
}

// Topmost prop covering a square, or null. Later entries win, so the most
// recently placed thing is the one you grab.
function boardPropAt(col, row) {
  const props = encounter.boardProps || [];
  for (let i = props.length - 1; i >= 0; i--) {
    const p = props[i];
    const fp = boardPropFootprint(p);
    if (col >= p.col && col < p.col + fp.w && row >= p.row && row < p.row + fp.h) return p;
  }
  return null;
}

function boardSelectedProp() {
  return (encounter.boardProps || []).find(p => p.id === boardState.selectedPropId) || null;
}

function boardAutoTerrainOn() {
  const el = document.getElementById('board-autoterrain');
  return !el || el.checked;
}

function boardPropCellIds(p) {
  const fp = boardPropFootprint(p);
  const ids = [];
  for (let r = p.row; r < p.row + fp.h; r++) {
    for (let c = p.col; c < p.col + fp.w; c++) {
      if (c >= 0 && r >= 0 && c < BOARD_COLS && r < BOARD_ROWS) ids.push(c + ',' + r);
    }
  }
  return ids;
}

// Stamp the terrain a prefab implies over the prop's footprint.
function boardApplyPropTerrain(p) {
  const pf = boardPrefab(p.type);
  if (!pf || !pf.terrain) return false;
  encounter.boardTerrain = encounter.boardTerrain || [];
  const ids = boardPropCellIds(p);
  if (!ids.length) return false;
  if (pf.terrain === 'clear') {
    const before = encounter.boardTerrain.length;
    const drop = new Set(ids);
    encounter.boardTerrain = encounter.boardTerrain.filter(t => !drop.has(t.id));
    return encounter.boardTerrain.length !== before;
  }
  const byId = new Map(encounter.boardTerrain.map(t => [t.id, t]));
  for (const id of ids) {
    const existing = byId.get(id);
    if (existing) existing.type = pf.terrain;
    else encounter.boardTerrain.push({ id, type: pf.terrain });
  }
  return true;
}

// The inverse, and deliberately conservative: only squares still holding
// exactly what this prop stamped are cleared, so a building removed from on
// top of a wall the DM drew by hand leaves that wall alone.
function boardStripPropTerrain(p) {
  const pf = boardPrefab(p.type);
  if (!pf || !pf.terrain || pf.terrain === 'clear') return false;
  encounter.boardTerrain = encounter.boardTerrain || [];
  const ids = new Set(boardPropCellIds(p));
  const before = encounter.boardTerrain.length;
  encounter.boardTerrain = encounter.boardTerrain.filter(t => !(ids.has(t.id) && t.type === pf.terrain));
  return encounter.boardTerrain.length !== before;
}

function boardClampPropPos(fp, col, row) {
  return {
    col: Math.max(0, Math.min(BOARD_COLS - fp.w, col)),
    row: Math.max(0, Math.min(BOARD_ROWS - fp.h, row)),
  };
}

// col/row is the square the cursor is over; a multi-square prefab is centred
// on it rather than hung off it to the south-east, which is where you expect
// a 4x3 warehouse to land when you drop it.
function boardPlaceProp(type, col, row, rot) {
  if (!boardCanEdit) return null;
  const pf = boardPrefab(type);
  if (!pf) return null;
  rot = rot || 0;
  const fp = (rot === 90 || rot === 270) ? { w: pf.h, h: pf.w } : { w: pf.w, h: pf.h };
  const at = boardClampPropPos(fp, col - Math.floor((fp.w - 1) / 2), row - Math.floor((fp.h - 1) / 2));
  const prop = { id: boardNextArtId(), type, col: at.col, row: at.row, rot };
  encounter.boardProps = encounter.boardProps || [];
  encounter.boardProps.push(prop);
  if (boardAutoTerrainOn() && boardApplyPropTerrain(prop)) prop.t = 1;
  boardBumpArtVersion();
  encSave();
  return prop;
}

function boardRemoveProp(id) {
  if (!boardCanEdit) return false;
  const props = encounter.boardProps || [];
  const p = props.find(x => x.id === id);
  if (!p) return false;
  if (p.t) boardStripPropTerrain(p);
  encounter.boardProps = props.filter(x => x.id !== id);
  if (boardState.selectedPropId === id) boardState.selectedPropId = null;
  boardBumpArtVersion();
  encSave();
  return true;
}

function boardMoveProp(p, col, row) {
  const fp = boardPropFootprint(p);
  const at = boardClampPropPos(fp, col, row);
  if (at.col === p.col && at.row === p.row) return false;
  if (p.t) boardStripPropTerrain(p);
  p.col = at.col; p.row = at.row;
  if (p.t) boardApplyPropTerrain(p);
  boardBumpArtVersion();
  encSave();
  return true;
}

function boardRotateSelectedProp() {
  const p = boardSelectedProp();
  if (!p || !boardCanEdit) return;
  if (p.t) boardStripPropTerrain(p);
  p.rot = ((p.rot || 0) + 90) % 360;
  const fp = boardPropFootprint(p);
  const at = boardClampPropPos(fp, p.col, p.row);
  p.col = at.col; p.row = at.row;
  if (p.t) boardApplyPropTerrain(p);
  boardBumpArtVersion();
  encSave();
  renderBoard();
}

function boardDeleteSelectedProp() {
  const p = boardSelectedProp();
  if (!p) return;
  boardRemoveProp(p.id);
  renderBoard();
}

function boardSelectProp(id) {
  boardState.selectedPropId = id;
  boardState.pendingProp = null;
  boardState.pendingId = null;
  boardState.selectedIds = [];
  renderPrefabPaletteSelection();
  renderBoard();
  updateBoardHint();
}

// Arm a prefab for stamping. It stays armed after each placement — laying a
// row of trees is the common case — until the same chip is clicked again,
// Escape is pressed, or the tool changes.
function boardSelectPrefab(type) {
  if (!boardCanEdit) return;
  const next = boardState.pendingProp === type ? null : type;
  // Before the assignment, not after: boardSetTool clears pendingProp (props
  // are a move-tool concern), so arming first and switching second would
  // disarm the chip the moment it was clicked.
  if (next && boardState.tool !== 'move') boardSetTool('move');
  boardState.pendingProp = next;
  boardState.pendingId = null;
  boardState.selectedIds = [];
  boardState.selectedPropId = null;
  renderPrefabPaletteSelection();
  renderBoard();
  updateBoardHint();
}

// Escape's first job inside board mode is putting the prop tools down; only
// once there's nothing armed or selected does it close the modal. Returns
// whether it consumed the key — see the keydown handler in encounter.js.
function boardCancelPropMode() {
  let consumed = false;
  if (boardState.pendingProp)    { boardState.pendingProp = null;    consumed = true; }
  if (boardState.selectedPropId) { boardState.selectedPropId = null; consumed = true; }
  if (boardState.propPreview)    { boardState.propPreview = null;    consumed = true; }
  if (consumed) {
    renderPrefabPaletteSelection();
    updateBoardHint();
    renderBoardCanvas();
  }
  return consumed;
}

/* ── prop rendering ── */

// Draws one prefab into the footprint at col,row. Rotation happens about the
// footprint centre, and the prefab itself always draws into its own
// unrotated w x h box — so a 3x1 car defined pointing right comes out
// pointing down at rot 90 without every draw() needing to know about angles.
function boardPaintProp(ctx, p, SZ, col, row) {
  const pf = boardPrefab(p.type);
  const fp = boardPropFootprint(p);
  const cx = col * SZ + (fp.w * SZ) / 2;
  const cy = row * SZ + (fp.h * SZ) / 2;
  ctx.save();
  ctx.translate(cx, cy);
  if (p.rot) ctx.rotate((p.rot * Math.PI) / 180);
  if (pf) {
    const dw = pf.w * SZ, dh = pf.h * SZ;
    pf.draw(ctx, -dw / 2, -dh / 2, dw, dh);
  } else {
    // A prop whose prefab no longer exists still has to render as something.
    pfRect(ctx, -SZ / 2 + 1, -SZ / 2 + 1, SZ - 2, SZ - 2, 'rgba(148,152,164,0.5)', 0, 1);
    if (SZ >= 12) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = `bold ${Math.max(7, SZ * 0.5)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 0);
    }
  }
  ctx.restore();
}

function paintPropsLayer(ctx, SZ) {
  const props = encounter.boardProps || [];
  const dragId = boardState.draggingProp ? boardState.draggingProp.id : null;
  for (const p of props) {
    if (p.id === dragId) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      boardPaintProp(ctx, p, SZ, p.col, p.row);
      ctx.restore();
      continue;
    }
    boardPaintProp(ctx, p, SZ, p.col, p.row);
  }

  // Selected prop: bracketed outline, so it reads differently from a token's
  // round glow.
  const sel = boardSelectedProp();
  if (sel && sel.id !== dragId) {
    const fp = boardPropFootprint(sel);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,194,32,0.95)';
    ctx.lineWidth = Math.max(1.5, SZ / 10);
    ctx.setLineDash([Math.max(3, SZ / 3), Math.max(2, SZ / 5)]);
    ctx.strokeRect(sel.col * SZ + 1, sel.row * SZ + 1, fp.w * SZ - 2, fp.h * SZ - 2);
    ctx.restore();
  }

  // The prop being dragged, drawn at the square it would land on.
  if (boardState.draggingProp) {
    const d = boardState.draggingProp;
    const p = props.find(x => x.id === d.id);
    if (p) {
      const ghost = { type: p.type, rot: p.rot, col: d.curCol, row: d.curRow };
      ctx.save();
      ctx.globalAlpha = 0.8;
      boardPaintProp(ctx, ghost, SZ, d.curCol, d.curRow);
      ctx.restore();
      const fp = boardPropFootprint(ghost);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(d.curCol * SZ + 1, d.curRow * SZ + 1, fp.w * SZ - 2, fp.h * SZ - 2);
      ctx.restore();
    }
  }

  // Where an armed prefab (palette click, or a drag hovering the canvas)
  // would land.
  const preview = boardState.propPreview;
  if (preview) {
    const pf = boardPrefab(preview.type);
    if (pf) {
      const rot = preview.rot || 0;
      const base = (rot === 90 || rot === 270) ? { w: pf.h, h: pf.w } : { w: pf.w, h: pf.h };
      const at = boardClampPropPos(base,
        preview.col - Math.floor((base.w - 1) / 2),
        preview.row - Math.floor((base.h - 1) / 2));
      ctx.save();
      ctx.globalAlpha = 0.55;
      boardPaintProp(ctx, { type: preview.type, rot }, SZ, at.col, at.row);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = 'rgba(14,158,133,0.9)';
      ctx.lineWidth = Math.max(1.5, SZ / 10);
      ctx.strokeRect(at.col * SZ + 1, at.row * SZ + 1, base.w * SZ - 2, base.h * SZ - 2);
      ctx.restore();
    }
  }
}

/* ── prefab palette (encounter.html only) ── */

function renderPrefabPalette() {
  const list = document.getElementById('board-props-list');
  if (!list || typeof BOARD_PREFABS === 'undefined') return;
  const raw = document.getElementById('board-prop-filter');
  const filter = (raw ? raw.value : '').trim().toLowerCase();
  let html = '';
  for (const cat of BOARD_PREFAB_CATS) {
    const items = BOARD_PREFABS.filter(p => p.cat === cat &&
      (!filter || p.label.toLowerCase().includes(filter) || cat.toLowerCase().includes(filter)));
    if (!items.length) continue;
    html += `<div class="board-prop-cat">${cat}</div><div class="board-prop-grid">`;
    for (const p of items) {
      const selected = boardState.pendingProp === p.key ? ' selected' : '';
      html += `<div class="board-prop-chip${selected}" draggable="true" data-prop="${p.key}"
        title="${p.label} — ${p.w}×${p.h} squares. ${p.note}"
        onclick="boardSelectPrefab('${p.key}')">
        <canvas class="board-prop-icon" width="44" height="44" data-prop-icon="${p.key}"></canvas>
        <span class="board-prop-label">${p.label}</span></div>`;
    }
    html += '</div>';
  }
  list.innerHTML = html || '<div class="board-prop-none">Nothing matches that.</div>';
  list.querySelectorAll('canvas[data-prop-icon]').forEach(boardPaintPrefabIcon);
}

// Chips draw their own icon with the same draw() the board uses, so a prefab
// can never look like one thing in the palette and another on the grid.
function boardPaintPrefabIcon(cv) {
  const pf = boardPrefab(cv.dataset.propIcon);
  if (!pf) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const pad = 3;
  const s = Math.min((cv.width - pad * 2) / pf.w, (cv.height - pad * 2) / pf.h);
  const w = pf.w * s, h = pf.h * s;
  pf.draw(ctx, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}

// Selection is a class toggle, not a rebuild: renderBoard runs on every drop
// and remote update, and repainting 28 icon canvases each time is waste.
function renderPrefabPaletteSelection() {
  document.querySelectorAll('.board-prop-chip').forEach(el => {
    el.classList.toggle('selected', el.dataset.prop === boardState.pendingProp);
  });
  renderBoardPropActions();
}

function renderBoardPropActions() {
  const wrap = document.getElementById('board-prop-actions');
  if (!wrap) return;
  const p = boardSelectedProp();
  wrap.style.display = p ? '' : 'none';
  if (!p) return;
  const pf = boardPrefab(p.type);
  const name = document.getElementById('board-prop-name');
  if (name) name.textContent = pf ? pf.label : p.type;
}

// One place that decides what the footer says, instead of six call sites
// each setting it to their own idea of the current mode.
function updateBoardHint() {
  const hint = document.getElementById('board-hint');
  if (!hint) return;
  if (!boardCanEdit) {
    hint.textContent = 'View only — pan and zoom to see the battle. The DM controls the board.';
    return;
  }
  if (boardState.pendingProp) {
    const pf = boardPrefab(boardState.pendingProp);
    hint.textContent = `Placing ${pf ? pf.label : boardState.pendingProp} — click the grid to drop one (Esc to stop). `
      + 'Click a placed prop to select it, then drag to move, R to rotate, Delete to remove.';
    return;
  }
  if (boardState.pendingId !== null) {
    hint.textContent = 'Click a grid square to place the selected unit.';
    return;
  }
  if (boardState.selectedPropId) {
    hint.textContent = 'Prop selected — drag it to move, R to rotate, Delete to remove. Click empty ground to deselect.';
    return;
  }
  hint.textContent = BOARD_TOOL_HINTS[boardState.tool] || BOARD_TOOL_HINTS.move;
}

/* ── preset maps (encounter.html only) ── */

// Split into two groups by area rather than by a hand-kept flag on each map:
// the list is long enough now that a DM after somewhere big shouldn't have to
// read every label's dimensions to find one.
function boardPopulateMapSelect() {
  const sel = document.getElementById('board-map-select');
  if (!sel || typeof BOARD_MAPS === 'undefined') return;
  const opt = mp => `<option value="${mp.key}" title="${mp.desc}">${mp.label} · ${mp.w}×${mp.h}</option>`;
  const group = (label, maps) => (maps.length
    ? `<optgroup label="${label}">${maps.map(opt).join('')}</optgroup>` : '');
  // Repopulating must not drop a selection: this runs on board-mode init and
  // again after saving or deleting one of the DM's own maps, and adding an
  // encounter group pre-selects the map it was written for before the board
  // has ever been opened.
  const previous = sel.value;
  const saved = Object.entries(boardReadSavedMaps())
    .map(([name, data]) => boardSavedMapAsPreset(name, data))
    .sort((a, b) => a.label.localeCompare(b.label));
  sel.innerHTML = '<option value="">— preset map —</option>'
    + group('One location', BOARD_MAPS.filter(mp => mp.w * mp.h < 1000))
    + group('Big maps', BOARD_MAPS.filter(mp => mp.w * mp.h >= 1000))
    + group('Saved in this browser', saved);
  if (previous) sel.value = previous;
}

// Resolves both halves of the picker: a built-in key, or 'saved:<name>' for
// one of the DM's own.
function boardMapByKey(key) {
  if (!key) return null;
  if (key.startsWith('saved:')) {
    const name = key.slice(6);
    const data = boardReadSavedMaps()[name];
    return data ? boardSavedMapAsPreset(name, data) : null;
  }
  return (typeof BOARD_MAPS_BY_KEY !== 'undefined' && BOARD_MAPS_BY_KEY[key]) || null;
}

function boardLoadPresetMap() {
  if (!boardCanEdit) return;
  const sel = document.getElementById('board-map-select');
  const note = document.getElementById('board-map-note');
  const mp = sel ? boardMapByKey(sel.value) : null;
  if (!mp) {
    if (note) note.textContent = 'Pick a map first.';
    return;
  }
  const hasArt = BOARD_LAYERS.some(k => (encounter[k] || []).length);
  if (hasArt && !confirm(`Load "${mp.label}"?\n\nThis replaces everything on the board — terrain, fog, scenery, drawings, labels, elevation and area shapes. Unit positions are kept.`)) return;
  boardApplyPresetMap(mp);
  if (note) note.textContent = `${mp.label} loaded.`;
}

// Maps are built in their own 0,0-based coordinates and dropped into the
// middle of the 100x100 grid, which is also where boardComputeBBox's
// nothing-placed-yet fallback looks — so a freshly loaded map is on screen
// without having to go hunting for it.
function boardApplyPresetMap(mp) {
  if (!boardCanEdit) return;
  const built = mp.build();
  const offC = Math.max(0, Math.floor((BOARD_COLS - built.w) / 2));
  const offR = Math.max(0, Math.floor((BOARD_ROWS - built.h) / 2));
  encounter.boardProps = built.props.map(p => ({
    id: boardNextArtId(), type: p.type,
    col: p.col + offC, row: p.row + offR, rot: p.rot || 0, t: 1,
  }));
  encounter.boardNotes = (built.notes || []).map(n => ({
    id: boardNextArtId(), col: n.col + offC, row: n.row + offR, text: n.text,
  }));
  // Terrain, elevation and colour are all cell-keyed, so one loop shifts all
  // three onto the grid. A preset builder emits only terrain and a map the DM
  // saved emits all of them; a layer missing from the file comes out empty,
  // which is also what clears the last map's off the board.
  for (const [key, layer] of Object.entries(BOARD_MAP_CELL_KEYS)) {
    encounter[layer] = (built[key] || []).map(e => {
      const parts = String(e.id).split(',');
      return Object.assign({}, e, { id: (+parts[0] + offC) + ',' + (+parts[1] + offR) });
    });
  }
  encounter.boardTemplates = [];
  encounter.boardStrokes = [];
  boardState.pendingProp = null;
  boardState.selectedPropId = null;
  boardBumpArtVersion();
  encSave();
  renderPrefabPaletteSelection();
  boardFitZoom();
  renderBoard();
  updateBoardHint();
}

/* ── Board layers ──────────────────────────────────────────
   Every piece of board state that is a flat, id-keyed array, in one list.
   Both pages default these on load and merge them per item on save, and both
   used to do it by hand: three identical lines per field at each of three
   arrival points, in two files, which is how boardProps came to need a
   regression test asking whether anybody had remembered. Adding a layer is
   one entry here now.

   Per-item merge matters for all of them for the same reason it mattered for
   props: a player nudging a token writes the whole encounter document, and
   without it their possibly-stale copy of a field overwrites whatever the DM
   changed a second earlier. */
const BOARD_LAYERS = ['boardStrokes', 'boardTerrain', 'boardProps',
                      'boardNotes', 'boardElev', 'boardTemplates', 'boardTint'];

// Scene state that isn't a layer: a switch rather than a thing on a square.
// Kept by a reset along with the layers, because the map surviving a reset is
// the point and how the map is lit is part of the map.
const BOARD_SETTINGS = ['boardLos'];

// Map-file key → the layer it loads into, for the layers keyed by a "c,r"
// cell id. Preset builders emit the short names; so does a map the DM saves.
// Listing them keeps save, load and the preset builders speaking one
// vocabulary instead of three copies of the same three lines.
const BOARD_MAP_CELL_KEYS = { terrain: 'boardTerrain', elev: 'boardElev', tint: 'boardTint' };

function boardEnsureLayers(enc) {
  if (!enc) return enc;
  for (const k of BOARD_LAYERS) if (!Array.isArray(enc[k])) enc[k] = [];
  return enc;
}

// The fsMergeSave spec for the layers, spread into the call beside
// combatants — so a layer listed above is merged per item without anyone
// having to go and say so twice more.
function boardLayerMergePaths() {
  return BOARD_LAYERS.map(path => ({ path, idKey: 'id' }));
}

/* ── Fog of war ────────────────────────────────────────────
   A terrain type rather than a layer of its own, because that is what it is:
   a square the players cannot see into. The DM paints it and sees a
   translucent veil along with the rest of the terrain. On the players' board
   the same squares are painted *last* and opaque, over scenery and tokens
   alike — so fog hides whatever is standing in it without any code having to
   filter the token list, which is the only version of this that can't leak a
   position through some other path that forgot to check.

   This is why the art-layer cache key carries boardCanEdit: board.html opens
   with it true and flips it when the admin check resolves, and the baked
   layer has to be rebuilt when it does. */
function paintFogLayer(ctx, SZ, isDark) {
  // The cell list rather than the id set: this runs on every frame of a pan,
  // and splitting a thousand "c,r" strings per frame is work for nothing.
  const cells = boardSightState().cells;
  if (!cells.length) return;
  ctx.save();
  ctx.fillStyle = isDark ? '#10131a' : '#e9e9ec';
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 1;
  for (const [c, r] of cells) {
    ctx.fillRect(c * SZ, r * SZ, SZ, SZ);
    ctx.strokeRect(c * SZ + 0.5, r * SZ + 0.5, SZ - 1, SZ - 1);
  }
  ctx.restore();
}

/* ── Labels ────────────────────────────────────────────────
   Text pinned to a square: EXIT, ALARM, WHOSE ROOM THIS IS. Public, because
   a label only the DM can read is a note in their own file rather than a
   thing on the map — fog still covers them, being painted after. */
function boardNoteAt(col, row) {
  return (encounter.boardNotes || []).find(n => n.col === col && n.row === row) || null;
}

function boardPlaceNote(col, row) {
  if (!boardCanEdit) return;
  if (col < 0 || col >= BOARD_COLS || row < 0 || row >= BOARD_ROWS) return;
  encounter.boardNotes = encounter.boardNotes || [];
  const existing = boardNoteAt(col, row);
  const text = prompt(existing ? 'Label (blank to remove):' : 'Label for this square:',
                      existing ? existing.text : '');
  if (text === null) return;
  const clean = text.trim().slice(0, 40);
  if (!clean) {
    if (existing) encounter.boardNotes = encounter.boardNotes.filter(n => n !== existing);
  } else if (existing) {
    existing.text = clean;
  } else {
    encounter.boardNotes.push({ id: boardNextArtId(), col, row, text: clean });
  }
  encSave();
  renderBoardCanvas();
}

function paintNotesLayer(ctx, SZ) {
  const notes = encounter.boardNotes || [];
  if (!notes.length || SZ < 9) return;
  const fontSize = Math.max(8, Math.min(13, SZ * 0.6));
  ctx.save();
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const n of notes) {
    const text = String(n.text || '');
    if (!text) continue;
    const w = ctx.measureText(text).width + fontSize * 0.8;
    const h = fontSize * 1.6;
    const cx = n.col * SZ + SZ / 2, cy = n.row * SZ + SZ / 2;
    pfRect(ctx, cx - w / 2, cy - h / 2, w, h, 'rgba(12,16,24,0.84)', h * 0.3, 1);
    ctx.fillStyle = '#F2D08A';
    ctx.fillText(text, cx, cy);
  }
  ctx.restore();
}

/* ── Measured templates ────────────────────────────────────
   The shape of an area attack, left on the board so everybody can see who is
   inside it instead of the DM counting squares out loud twice. Distance is
   Chebyshev, matching the range overlay and the way the rest of this board
   measures. A cone widens by one square either side per square of length,
   which is the usual grid approximation and, more to the point, the one a
   table can check by eye. */
const BOARD_TEMPLATE_KINDS = ['burst', 'cone', 'line'];

function boardTemplateCells(t) {
  const out = new Set();
  const size = Math.max(1, Math.min(30, t.size || 2));
  const rot = (((t.rot || 0) % 360) + 360) % 360;
  const fwd = rot === 90 ? [0, 1] : rot === 180 ? [-1, 0] : rot === 270 ? [0, -1] : [1, 0];
  const side = [-fwd[1], fwd[0]];
  const add = (c, r) => {
    if (c >= 0 && r >= 0 && c < BOARD_COLS && r < BOARD_ROWS) out.add(c + ',' + r);
  };
  if (t.kind === 'line') {
    for (let d = 0; d < size; d++) add(t.col + fwd[0] * d, t.row + fwd[1] * d);
  } else if (t.kind === 'cone') {
    for (let d = 0; d < size; d++) {
      for (let s = -d; s <= d; s++) {
        add(t.col + fwd[0] * d + side[0] * s, t.row + fwd[1] * d + side[1] * s);
      }
    }
  } else {
    for (let dr = -size; dr <= size; dr++) {
      for (let dc = -size; dc <= size; dc++) add(t.col + dc, t.row + dr);
    }
  }
  return out;
}

// Topmost template covering a square, or null — the same last-one-wins rule
// as props, so clicking takes away the one you just put down.
function boardTemplateAt(col, row) {
  const list = encounter.boardTemplates || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (boardTemplateCells(list[i]).has(col + ',' + row)) return list[i];
  }
  return null;
}

function boardTemplateOptions() {
  const el = id => document.getElementById(id);
  const kindEl = el('board-template-kind'), sizeEl = el('board-template-size'), rotEl = el('board-template-rot');
  const kind = kindEl && BOARD_TEMPLATE_KINDS.includes(kindEl.value) ? kindEl.value : 'burst';
  const size = Math.max(1, Math.min(30, parseInt((sizeEl && sizeEl.value) || '2', 10) || 2));
  const rot = parseInt((rotEl && rotEl.value) || '0', 10) || 0;
  return { kind, size, rot };
}

function boardPlaceTemplate(col, row) {
  if (!boardCanEdit) return;
  // The cells of a shape are clipped to the grid, but its anchor has to be on
  // the grid too, or it saves a shape nobody can ever click to remove.
  if (col < 0 || col >= BOARD_COLS || row < 0 || row >= BOARD_ROWS) return;
  encounter.boardTemplates = encounter.boardTemplates || [];
  const hit = boardTemplateAt(col, row);
  if (hit) {
    encounter.boardTemplates = encounter.boardTemplates.filter(t => t.id !== hit.id);
  } else {
    const { kind, size, rot } = boardTemplateOptions();
    encounter.boardTemplates.push({ id: boardNextArtId(), kind, col, row, size, rot });
  }
  encSave();
  renderBoardCanvas();
}

function boardClearTemplates() {
  if (!boardCanEdit || !(encounter.boardTemplates || []).length) return;
  encounter.boardTemplates = [];
  encSave();
  renderBoardCanvas();
}

function paintTemplatesLayer(ctx, SZ) {
  for (const t of encounter.boardTemplates || []) {
    const cells = boardTemplateCells(t);
    if (!cells.size) continue;
    ctx.save();
    ctx.fillStyle = 'rgba(224,112,32,0.24)';
    for (const id of cells) {
      const parts = id.split(',');
      ctx.fillRect(+parts[0] * SZ, +parts[1] * SZ, SZ, SZ);
    }
    // Outline only the edges facing out of the shape, so overlapping
    // templates still read as two shapes rather than one blob.
    ctx.strokeStyle = 'rgba(232,160,32,0.9)';
    ctx.lineWidth = Math.max(1, SZ / 14);
    ctx.beginPath();
    for (const id of cells) {
      const parts = id.split(',');
      const c = +parts[0], r = +parts[1];
      if (!cells.has((c - 1) + ',' + r)) { ctx.moveTo(c * SZ, r * SZ); ctx.lineTo(c * SZ, (r + 1) * SZ); }
      if (!cells.has((c + 1) + ',' + r)) { ctx.moveTo((c + 1) * SZ, r * SZ); ctx.lineTo((c + 1) * SZ, (r + 1) * SZ); }
      if (!cells.has(c + ',' + (r - 1))) { ctx.moveTo(c * SZ, r * SZ); ctx.lineTo((c + 1) * SZ, r * SZ); }
      if (!cells.has(c + ',' + (r + 1))) { ctx.moveTo(c * SZ, (r + 1) * SZ); ctx.lineTo((c + 1) * SZ, (r + 1) * SZ); }
    }
    ctx.stroke();
    ctx.restore();
  }
}

/* ── Elevation ─────────────────────────────────────────────
   A signed number of squares up or down: rooftops, catwalks, the sunken
   floor of a vat room. Nothing enforces it — it is a table aid, so the DM can
   say "he's two above you" without everyone squinting at the scenery to work
   out whether the roof counts. Baked into the cached art layer along with the
   terrain, because it changes about as often. */
function boardElevLevel(col, row) {
  const e = (encounter.boardElev || []).find(x => x.id === col + ',' + row);
  return e ? e.level : 0;
}

function boardElevOption() {
  const el = document.getElementById('board-elev-level');
  const n = parseInt((el && el.value) || '1', 10);
  return Math.max(-9, Math.min(9, isNaN(n) ? 1 : n));
}

function boardPaintElevAt(p, level) {
  if (!boardCanEdit) return;
  if (p.col < 0 || p.col >= BOARD_COLS || p.row < 0 || p.row >= BOARD_ROWS) return;
  encounter.boardElev = encounter.boardElev || [];
  const id = p.col + ',' + p.row;
  const existing = encounter.boardElev.find(e => e.id === id);
  if (!level) {
    if (!existing) return;
    encounter.boardElev = encounter.boardElev.filter(e => e.id !== id);
  } else if (existing) {
    if (existing.level === level) return;
    existing.level = level;
  } else {
    encounter.boardElev.push({ id, level });
  }
  boardBumpArtVersion();
  encSave();
}

function paintElevLayer(ctx, SZ, elev) {
  if (!elev.length) return;
  const showNumber = SZ >= 12;
  ctx.save();
  if (showNumber) {
    ctx.font = `700 ${Math.max(7, Math.min(11, SZ * 0.42))}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }
  for (const e of elev) {
    const level = e.level || 0;
    if (!level) continue;
    const parts = e.id.split(',');
    const c = +parts[0], r = +parts[1];
    const strength = Math.min(0.34, 0.1 + Math.abs(level) * 0.07);
    ctx.fillStyle = level > 0 ? `rgba(232,160,32,${strength})` : `rgba(80,140,220,${strength})`;
    ctx.fillRect(c * SZ, r * SZ, SZ, SZ);
    if (showNumber) {
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.fillText((level > 0 ? '+' : '') + level, c * SZ + SZ * 0.1, r * SZ + SZ * 0.06);
    }
  }
  ctx.restore();
}

/* ── Grid colour ───────────────────────────────────────────
   Any colour on any square, painted like a terrain brush. Its own layer
   rather than another terrain type because terrain types carry a ruling —
   wall, difficult, cover all mean something at the table — and this means
   nothing except what the DM says it means: the red team's half, the inside
   of the barrier, where the gas has got to. Painted underneath the terrain
   markers so a wall still reads as a wall on top of it. */
function boardTintColor() {
  const el = document.getElementById('board-tint-color');
  const raw = (el && el.value) || '#3B82F6';
  // A colour that came from anywhere but the picker gets dropped rather than
  // written into the document and then into every player's canvas.
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : '#3B82F6';
}

function boardPaintTintAt(p, color) {
  if (!boardCanEdit) return;
  if (p.col < 0 || p.col >= BOARD_COLS || p.row < 0 || p.row >= BOARD_ROWS) return;
  encounter.boardTint = encounter.boardTint || [];
  const id = p.col + ',' + p.row;
  const existing = encounter.boardTint.find(t => t.id === id);
  if (existing) {
    if (existing.color === color) return;
    existing.color = color;
  } else {
    encounter.boardTint.push({ id, color });
  }
  boardBumpArtVersion();
  encSave();
}

function paintTintLayer(ctx, SZ, tint) {
  if (!tint.length) return;
  ctx.save();
  // Not solid: the grid lines and the alternating squares have to stay
  // readable through it, or a coloured area stops being part of the board.
  ctx.globalAlpha = 0.5;
  for (const t of tint) {
    const parts = t.id.split(',');
    ctx.fillStyle = t.color || '#3B82F6';
    ctx.fillRect(+parts[0] * SZ, +parts[1] * SZ, SZ, SZ);
  }
  ctx.restore();
}

/* ── Line of sight ─────────────────────────────────────────
   One switch instead of painting fog by hand: with it on, the players' board
   hides every square none of their own characters can see, and keeps up as
   they move. Manual fog still applies on top, for the things sight has no
   opinion about — a dark room, a floor they haven't been told exists.

   WHAT BLOCKS IT. Wall squares, which is the terrain every impassable
   prefab stamps under itself, so buildings, containers, trains, lockers and
   anything else solid block sight by being what they are. Cover
   deliberately does not: crates, railings, cars and hedges are half cover
   you can see over, and a DM who wants a sight blocker paints a wall. One
   source of truth, and it is the one already on the board.

   WHO SEES. The placed player characters. With none of them on the board
   there is no vantage point to compute from, and blacking out the whole map
   would read as a bug rather than as darkness, so sight simply does nothing
   until a PC is standing somewhere.

   The honest limitation: rays run centre-to-corner on a square grid, so two
   walls meeting at a diagonal leak a sliver of vision between them. Every
   grid implementation of this has to pick something; this one errs towards
   showing a square rather than hiding it, which is the error you can see and
   correct with the fog brush rather than the one that hides a monster you
   meant the players to be looking at. */
// Walls, as a flat grid indexed by cell rather than a set of "c,r" strings.
// The ray walker below touches a few hundred thousand cells per computation,
// and at that volume building a string per step to look it up was most of the
// cost — this is the same data, five times faster to ask.
const BOARD_SIGHT_STRIDE = BOARD_ROWS;
function boardSightBlockerGrid() {
  const grid = new Uint8Array(BOARD_COLS * BOARD_ROWS);
  for (const t of encounter.boardTerrain || []) {
    if (t.type !== 'wall') continue;
    const parts = t.id.split(',');
    const c = +parts[0], r = +parts[1];
    if (c >= 0 && c < BOARD_COLS && r >= 0 && r < BOARD_ROWS) grid[c * BOARD_SIGHT_STRIDE + r] = 1;
  }
  return grid;
}

function boardSightViewers() {
  return (encounter.combatants || []).filter(c => c.isPC && c.boardX != null);
}

// Exact cell-by-cell traversal of the segment (Amanatides & Woo): steps from
// cell to cell rather than sampling points along the line, so a one-square
// wall can never be stepped over however the ray is angled. Returns true if
// something solid stands strictly between the two ends.
function boardRayBlocked(x0, y0, x1, y1, blocked) {
  let cx = Math.floor(x0), cy = Math.floor(y0);
  const ex = Math.floor(x1), ey = Math.floor(y1);
  if (cx === ex && cy === ey) return false;
  const dx = x1 - x0, dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const invX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const invY = dy === 0 ? Infinity : Math.abs(1 / dy);
  let tx = dx === 0 ? Infinity : (dx > 0 ? (cx + 1 - x0) : (x0 - cx)) * invX;
  let ty = dy === 0 ? Infinity : (dy > 0 ? (cy + 1 - y0) : (y0 - cy)) * invY;
  for (let guard = 0; guard < 512; guard++) {
    if (tx < ty) { cx += stepX; tx += invX; } else { cy += stepY; ty += invY; }
    if (cx === ex && cy === ey) return false;     // got there
    if (tx > 1 && ty > 1) return false;           // ran off the end of the segment
    if (blocked[cx * BOARD_SIGHT_STRIDE + cy]) return true;
  }
  return true;
}

// Everything one viewer can see, within the box given, written into `out`.
// Pulled in off the corners: a square you can only see the very edge of is
// still a square you can see, but a ray through the exact corner point where
// two walls touch is ambiguous, and this picks a side.
function boardMarkVisibleFrom(vx, vy, blocked, bb, out) {
  const IN = 0.08;
  const ox = vx + 0.5, oy = vy + 0.5;
  out[vx * BOARD_SIGHT_STRIDE + vy] = 1;
  for (let r = bb.minR; r <= bb.maxR; r++) {
    for (let c = bb.minC; c <= bb.maxC; c++) {
      const i = c * BOARD_SIGHT_STRIDE + r;
      if (out[i]) continue;
      if (!boardRayBlocked(ox, oy, c + 0.5, r + 0.5, blocked)
        || !boardRayBlocked(ox, oy, c + IN, r + IN, blocked)
        || !boardRayBlocked(ox, oy, c + 1 - IN, r + IN, blocked)
        || !boardRayBlocked(ox, oy, c + IN, r + 1 - IN, blocked)
        || !boardRayBlocked(ox, oy, c + 1 - IN, r + 1 - IN, blocked)) out[i] = 1;
    }
  }
}

/* Cached in two tiers, because the two things that invalidate it cost very
   different amounts:

   · per viewer, keyed on where that viewer stands — so one character moving
     recomputes one character's sight and not the whole party's;
   · per scene, the union of those plus the painted fog, which is what the
     renderer asks for every frame of every pan, hover and drag.

   Walls changing clears both, since every ray has to be re-walked. That is
   also why nothing recomputes while a brush is down: painting a wall bumps
   the art version on every square the cursor crosses, and recomputing sight
   per square would make the wall brush crawl. The stale shading stands until
   the mouse comes up, which is one frame of being slightly wrong about a
   square the DM is in the middle of drawing anyway. */
let _boardSightViewerCache = new Map();
let _boardSightVersion = -1;
let _boardSightCache = { key: '', state: null };

function boardSightState() {
  const fogOnly = () => {
    const hidden = new Set();
    for (const t of encounter.boardTerrain || []) if (t.type === 'fog') hidden.add(t.id);
    return { vis: null, hidden, cells: [...hidden].map(id => id.split(',').map(Number)) };
  };
  if (!encounter.boardLos) {
    // Fog alone is cheap enough to build on demand, and the common case is
    // that there isn't any.
    return fogOnly();
  }
  const viewers = boardSightViewers();
  if (!viewers.length) return fogOnly();

  const key = _boardArtVersion + '|' + viewers.map(v => v.boardX + ',' + v.boardY).join(';');
  if (_boardSightCache.key === key && _boardSightCache.state) return _boardSightCache.state;
  // Mid-brush: hold the last answer rather than recompute per painted square.
  if (_boardPainting && _boardSightCache.state) return _boardSightCache.state;

  if (_boardSightVersion !== _boardArtVersion) {
    _boardSightViewerCache.clear();
    _boardSightVersion = _boardArtVersion;
  }
  const blocked = boardSightBlockerGrid();
  const bb = boardComputeBBox();
  const vis = new Uint8Array(BOARD_COLS * BOARD_ROWS);
  for (const v of viewers) {
    const vk = v.boardX + ',' + v.boardY;
    let own = _boardSightViewerCache.get(vk);
    if (!own) {
      own = new Uint8Array(BOARD_COLS * BOARD_ROWS);
      boardMarkVisibleFrom(v.boardX, v.boardY, blocked, bb, own);
      _boardSightViewerCache.set(vk, own);
    }
    for (let i = 0; i < vis.length; i++) if (own[i]) vis[i] = 1;
  }
  const hidden = new Set();
  const cells = [];
  for (let r = bb.minR; r <= bb.maxR; r++) {
    for (let c = bb.minC; c <= bb.maxC; c++) {
      if (vis[c * BOARD_SIGHT_STRIDE + r]) continue;
      hidden.add(c + ',' + r);
      cells.push([c, r]);
    }
  }
  // Painted fog on top, wherever it falls — including outside the box sight
  // was computed over.
  for (const t of encounter.boardTerrain || []) {
    if (t.type !== 'fog' || hidden.has(t.id)) continue;
    hidden.add(t.id);
    cells.push(t.id.split(',').map(Number));
  }
  const state = { vis, hidden, cells };
  _boardSightCache = { key, state };
  return state;
}

// Every square at least one player character can see, or null when sight
// isn't being applied at all — switched off, or nobody to see with — which
// the callers read as "hide nothing" rather than "hide everything".
function boardVisibleCells() {
  return boardSightState().vis;
}

// Squares hidden from the players: painted fog, plus everything out of sight
// when the switch is on.
function boardHiddenCells() {
  return boardSightState().hidden;
}

function boardLosEnabled() { return !!encounter.boardLos; }

function boardToggleLos(on) {
  if (!boardCanEdit) return;
  encounter.boardLos = !!on;
  encSave();
  renderBoardCanvas();
  updateBoardHint();
}

// The switch is shared state, not a local preference — it governs what every
// player's board draws — so it has to follow a remote change as well as a
// local click.
function boardSyncLosToggle() {
  const el = document.getElementById('board-los');
  if (el) el.checked = !!encounter.boardLos;
  const note = document.getElementById('board-los-note');
  if (note) {
    note.textContent = !encounter.boardLos ? ''
      : boardSightViewers().length ? `Hiding what the players can't see from ${boardSightViewers().length} PC${boardSightViewers().length === 1 ? '' : 's'}.`
      : 'No player characters placed yet — nothing is hidden until there are.';
  }
}

// On the DM's own board the hidden squares are only shaded, so they can see
// both what is there and what the players are missing.
function paintSightShadow(ctx, SZ) {
  const cells = boardSightState().cells;
  if (!cells.length) return;
  ctx.save();
  ctx.fillStyle = 'rgba(104,78,152,0.26)';
  for (const [c, r] of cells) ctx.fillRect(c * SZ, r * SZ, SZ, SZ);
  ctx.restore();
}

/* ── The DM's own maps ─────────────────────────────────────
   A board built by hand, kept so it can be used again next week. Stored in
   this browser, not in the encounter document: that document is the live
   battle, every player's board reads it on every change, and a map library
   living in there would sit growing against the 1 MiB document limit for the
   benefit of exactly one person. The cost is that the library is per-browser,
   which is what Export is for — and why the button says so rather than
   leaving the DM to find out in the middle of a session on a different
   laptop. */
const BOARD_SAVED_MAPS_KEY = 'mha_board_maps_v1';

function boardReadSavedMaps() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BOARD_SAVED_MAPS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function boardWriteSavedMaps(maps) {
  try {
    localStorage.setItem(BOARD_SAVED_MAPS_KEY, JSON.stringify(maps));
    return true;
  } catch {
    // Quota, or storage blocked outright in a private window. Saying so beats
    // a button that looks like it worked.
    alert('Could not save: this browser refused to store the map (storage full or blocked).');
    return false;
  }
}

// The board as it stands, in map coordinates: everything shifted so the
// top-left of what's actually on the board becomes 0,0, exactly like a preset
// builder's output, so loading one back goes through the same path.
function boardSerializeCurrent() {
  const props = encounter.boardProps || [];
  const notes = encounter.boardNotes || [];
  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
  const stretch = (c, r, w, h) => {
    minC = Math.min(minC, c); minR = Math.min(minR, r);
    maxC = Math.max(maxC, c + (w || 1) - 1); maxR = Math.max(maxR, r + (h || 1) - 1);
  };
  const cellOf = (id) => String(id).split(',').map(Number);
  for (const layer of Object.values(BOARD_MAP_CELL_KEYS)) {
    for (const e of encounter[layer] || []) { const [c, r] = cellOf(e.id); stretch(c, r); }
  }
  for (const n of notes) stretch(n.col, n.row);
  for (const p of props) { const fp = boardPropFootprint(p); stretch(p.col, p.row, fp.w, fp.h); }
  if (!isFinite(minC)) return null;
  const out = {
    w: maxC - minC + 1,
    h: maxR - minR + 1,
    props: props.map(p => ({ type: p.type, col: p.col - minC, row: p.row - minR, rot: p.rot || 0 })),
    notes: notes.map(n => ({ col: n.col - minC, row: n.row - minR, text: n.text })),
  };
  for (const [key, layer] of Object.entries(BOARD_MAP_CELL_KEYS)) {
    out[key] = (encounter[layer] || []).map(e => {
      const [c, r] = cellOf(e.id);
      return Object.assign({}, e, { id: (c - minC) + ',' + (r - minR) });
    });
  }
  return out;
}

// A saved map dressed as a preset, so boardApplyPresetMap doesn't need to
// know the difference.
function boardSavedMapAsPreset(name, data) {
  return {
    key: 'saved:' + name,
    label: name,
    desc: `Your own map — ${data.w}×${data.h}, saved in this browser.`,
    w: data.w, h: data.h,
    build() { return data; },
  };
}

function boardSaveCurrentMap() {
  if (!boardCanEdit) return;
  const note = document.getElementById('board-map-note');
  const data = boardSerializeCurrent();
  if (!data) {
    if (note) note.textContent = 'Nothing on the board to save yet.';
    return;
  }
  const name = (prompt('Save this board as:', '') || '').trim().slice(0, 40);
  if (!name) return;
  const maps = boardReadSavedMaps();
  if (maps[name] && !confirm(`"${name}" already exists. Replace it?`)) return;
  maps[name] = data;
  if (!boardWriteSavedMaps(maps)) return;
  boardPopulateMapSelect();
  const sel = document.getElementById('board-map-select');
  if (sel) sel.value = 'saved:' + name;
  if (note) note.textContent = `Saved "${name}" (${data.w}×${data.h}) in this browser.`;
}

function boardDeleteSavedMap() {
  const sel = document.getElementById('board-map-select');
  const note = document.getElementById('board-map-note');
  const value = sel ? sel.value : '';
  if (!value.startsWith('saved:')) {
    if (note) note.textContent = 'Pick one of your own saved maps to delete.';
    return;
  }
  const name = value.slice(6);
  if (!confirm(`Delete your saved map "${name}"? This cannot be undone.`)) return;
  const maps = boardReadSavedMaps();
  delete maps[name];
  if (!boardWriteSavedMaps(maps)) return;
  boardPopulateMapSelect();
  if (note) note.textContent = `Deleted "${name}".`;
}

function boardExportSavedMaps() {
  const maps = boardReadSavedMaps();
  const note = document.getElementById('board-map-note');
  const names = Object.keys(maps);
  if (!names.length) {
    if (note) note.textContent = 'No saved maps in this browser to export.';
    return;
  }
  const blob = new Blob([JSON.stringify(maps, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'board-maps.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can race the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (note) note.textContent = `Exported ${names.length} map(s).`;
}

function boardImportSavedMaps(input) {
  const file = input && input.files && input.files[0];
  const note = document.getElementById('board-map-note');
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    input.value = '';
    let incoming;
    try { incoming = JSON.parse(String(reader.result)); } catch { incoming = null; }
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      if (note) note.textContent = 'That file is not a board-maps export.';
      return;
    }
    const maps = boardReadSavedMaps();
    let added = 0;
    for (const [name, data] of Object.entries(incoming)) {
      // Only shapes this page can actually load — a file that is JSON but
      // not a map library shouldn't half-import.
      if (!data || !Array.isArray(data.terrain) || !Array.isArray(data.props)) continue;
      // Older exports predate the colour and elevation layers; the loader
      // treats a missing one as empty, so they import as what they were.
      maps[name] = data;
      added++;
    }
    if (!added) {
      if (note) note.textContent = 'Nothing in that file looked like a saved map.';
      return;
    }
    if (!boardWriteSavedMaps(maps)) return;
    boardPopulateMapSelect();
    if (note) note.textContent = `Imported ${added} map(s).`;
  };
  reader.readAsText(file);
}

function boardCanvasPoint(e) {
  const canvas = document.getElementById('board-canvas');
  const rect = canvas.getBoundingClientRect();
  const SZ = boardCell();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width) / SZ;
  const y = (e.clientY - rect.top) * (canvas.height / rect.height) / SZ;
  return { x, y, col: Math.floor(x), row: Math.floor(y) };
}

let _boardArtIdSeq = 0;
function boardNextArtId() { return 'art-' + Date.now().toString(36) + '-' + (++_boardArtIdSeq); }

// Terrain cells and drawing strokes are stored as flat, id-keyed arrays
// (like combatants) rather than nested inside a plain object, so encSave's
// per-item merge can apply — otherwise a plain top-level "board" field is
// local-wins-whole-field, and any client that saves for an unrelated reason
// (a player nudging a token) would stomp the DM's terrain with its own
// possibly-stale local copy.
function boardPaintTerrainAt(p, type) {
  if (p.col < 0 || p.col >= BOARD_COLS || p.row < 0 || p.row >= BOARD_ROWS) return;
  encounter.boardTerrain = encounter.boardTerrain || [];
  const id = p.col + ',' + p.row;
  const existing = encounter.boardTerrain.find(t => t.id === id);
  if (existing) {
    if (existing.type === type) return;
    existing.type = type;
  } else {
    encounter.boardTerrain.push({ id, type });
  }
  boardBumpArtVersion();
  encSave();
}

function boardEraseAt(p) {
  encounter.boardTerrain = encounter.boardTerrain || [];
  encounter.boardStrokes = encounter.boardStrokes || [];
  const cellId = p.col + ',' + p.row;
  const ERASE_RADIUS = 0.5; // cell units
  let changed = false;

  const beforeTerrainLen = encounter.boardTerrain.length;
  encounter.boardTerrain = encounter.boardTerrain.filter(t => t.id !== cellId);
  if (encounter.boardTerrain.length !== beforeTerrainLen) changed = true;

  // Labels, elevation and area shapes come up under the eraser as well —
  // anything the DM can put on a square, they can take off it the same way.
  const beforeNotes = (encounter.boardNotes || []).length;
  encounter.boardNotes = (encounter.boardNotes || []).filter(n => !(n.col === p.col && n.row === p.row));
  if (encounter.boardNotes.length !== beforeNotes) changed = true;

  const beforeElev = (encounter.boardElev || []).length;
  encounter.boardElev = (encounter.boardElev || []).filter(e => e.id !== cellId);
  if (encounter.boardElev.length !== beforeElev) changed = true;

  const beforeTint = (encounter.boardTint || []).length;
  encounter.boardTint = (encounter.boardTint || []).filter(t => t.id !== cellId);
  if (encounter.boardTint.length !== beforeTint) changed = true;

  const hitTemplate = boardTemplateAt(p.col, p.row);
  if (hitTemplate) {
    encounter.boardTemplates = (encounter.boardTemplates || []).filter(t => t.id !== hitTemplate.id);
    changed = true;
  }

  const nextStrokes = [];
  for (const s of encounter.boardStrokes) {
    const points = s.points.filter(pt => Math.hypot(pt.x - p.x, pt.y - p.y) > ERASE_RADIUS);
    if (points.length !== s.points.length) changed = true;
    if (points.length > 1) nextStrokes.push({ id: s.id, color: s.color, width: s.width, points });
  }
  encounter.boardStrokes = nextStrokes;

  // The eraser lifts a prop off the square as well, along with the terrain
  // that prop stamped (see boardStripPropTerrain) — erasing a building and
  // leaving an invisible wall standing where it was would be worse than not
  // erasing it at all.
  const erasedProp = boardPropAt(p.col, p.row);
  if (erasedProp) {
    if (erasedProp.t) boardStripPropTerrain(erasedProp);
    encounter.boardProps = (encounter.boardProps || []).filter(x => x.id !== erasedProp.id);
    if (boardState.selectedPropId === erasedProp.id) boardState.selectedPropId = null;
    changed = true;
  }

  if (changed) {
    boardBumpArtVersion();
    encSave();
  }
}

function boardDrawStart(e) {
  const p = boardCanvasPoint(e);
  if (boardState.tool === 'pen') {
    boardState.drawingStroke = { id: boardNextArtId(), color: boardState.penColor, width: 3, points: [{ x: p.x, y: p.y }] };
  } else if (boardState.tool === 'eraser') {
    _boardPainting = true;
    boardEraseAt(p);
  } else if (boardState.tool === 'note') {
    // One square at a time and a prompt to answer — nothing to drag.
    boardPlaceNote(p.col, p.row);
    return;
  } else if (boardState.tool === 'template') {
    boardPlaceTemplate(p.col, p.row);
    return;
  } else if (boardState.tool === 'elev') {
    _boardPainting = true;
    boardPaintElevAt(p, boardElevOption());
  } else if (boardState.tool === 'tint') {
    _boardPainting = true;
    boardPaintTintAt(p, boardTintColor());
  } else if (BOARD_TERRAIN_TOOLS.includes(boardState.tool)) {
    _boardPainting = true;
    boardPaintTerrainAt(p, boardState.tool);
  }
  boardRequestRender();
}

function boardDrawMove(e) {
  const p = boardCanvasPoint(e);
  if (boardState.tool === 'pen') {
    if (!boardState.drawingStroke) return;
    boardState.drawingStroke.points.push({ x: p.x, y: p.y });
    boardRequestRender();
  } else if (boardState.tool === 'eraser') {
    if (!_boardPainting) return;
    boardEraseAt(p);
    boardRequestRender();
  } else if (boardState.tool === 'elev') {
    if (!_boardPainting) return;
    boardPaintElevAt(p, boardElevOption());
    boardRequestRender();
  } else if (boardState.tool === 'tint') {
    if (!_boardPainting) return;
    boardPaintTintAt(p, boardTintColor());
    boardRequestRender();
  } else if (_boardPainting && BOARD_TERRAIN_TOOLS.includes(boardState.tool)) {
    boardPaintTerrainAt(p, boardState.tool);
    boardRequestRender();
  }
}

function boardDrawEnd() {
  if (boardState.tool === 'pen' && boardState.drawingStroke) {
    if (boardState.drawingStroke.points.length > 1) {
      encounter.boardStrokes = encounter.boardStrokes || [];
      encounter.boardStrokes.push(boardState.drawingStroke);
      boardBumpArtVersion();
      encSave();
    }
    boardState.drawingStroke = null;
  }
  _boardPainting = false;
  renderBoardCanvas();
}

const BOARD_IS_TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
function boardCell() {
  const min = BOARD_IS_TOUCH ? 20 : 6;
  // While actively pinch-zooming, boardZoom changes on nearly every touchmove,
  // which — left unquantized — changes the cell size every frame and forces a
  // full canvas resize + background-layer rebuild (all ~10,000 cells) each
  // time. Snapping to coarse 4px steps during the gesture keeps most frames
  // sharing a cache hit; boardHandleTouchEnd re-renders at the exact size
  // once the gesture settles.
  if (_boardPinch) return Math.max(min, Math.round((CELL_BASE * boardZoom) / 4) * 4);
  return Math.max(min, Math.round(CELL_BASE * boardZoom));
}

// Coalesce the flood of mousemove/touchmove events fired during drag/hover/pinch
// into at most one redraw per animation frame, instead of one per event.
let _boardRenderQueued = false;
function boardRequestRender() {
  if (_boardRenderQueued) return;
  _boardRenderQueued = true;
  requestAnimationFrame(() => { _boardRenderQueued = false; renderBoardCanvas(); });
}

function boardZoomIn()  { boardZoom = Math.min(+(boardZoom * 1.25).toFixed(4), 3);   renderBoardCanvas(); updateZoomLabel(); }
function boardZoomOut() { boardZoom = Math.max(+(boardZoom / 1.25).toFixed(4), 0.25); renderBoardCanvas(); updateZoomLabel(); }
function updateZoomLabel() {
  const el = document.getElementById('board-zoom-label');
  if (el) el.textContent = Math.round(boardZoom * 100) + '%';
}

// The board is a fixed 100x100 grid so there's room to lay out a big map, but
// almost every encounter only uses a small corner of it. Fitting/centering on
// the *entire* grid (the old behaviour) meant "Fit" could never actually fit
// on a phone screen, and there was nothing to anchor the initial scroll
// position to — you'd land on an arbitrary, likely-empty corner. Fit to the
// bounding box of what's in play instead, padded a bit, and scroll to it.
//
// "In play" is everything on the board, not just the tokens: a freshly loaded
// preset map has terrain and props but no units yet, and fitting to tokens
// alone would drop the DM on empty grid next to the map they just loaded.
function boardComputeBBox() {
  const PAD = 4;
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  const include = (c1, r1, c2, r2) => {
    minC = Math.min(minC, c1); maxC = Math.max(maxC, c2);
    minR = Math.min(minR, r1); maxR = Math.max(maxR, r2);
  };
  for (const c of encounter.combatants) {
    if (c.boardX != null) include(c.boardX, c.boardY, c.boardX, c.boardY);
  }
  for (const p of encounter.boardProps || []) {
    const fp = boardPropFootprint(p);
    include(p.col, p.row, p.col + fp.w - 1, p.row + fp.h - 1);
  }
  for (const t of encounter.boardTerrain || []) {
    const parts = t.id.split(',');
    include(+parts[0], +parts[1], +parts[0], +parts[1]);
  }
  for (const s of encounter.boardStrokes || []) {
    for (const pt of s.points || []) include(Math.floor(pt.x), Math.floor(pt.y), Math.floor(pt.x), Math.floor(pt.y));
  }
  if (minC === Infinity) {
    const midC = Math.floor(BOARD_COLS / 2), midR = Math.floor(BOARD_ROWS / 2);
    return { minC: midC - 10, maxC: midC + 10, minR: midR - 10, maxR: midR + 10 };
  }
  return {
    minC: Math.max(0, minC - PAD), maxC: Math.min(BOARD_COLS - 1, maxC + PAD),
    minR: Math.max(0, minR - PAD), maxR: Math.min(BOARD_ROWS - 1, maxR + PAD),
  };
}

function boardScrollToBBox(bbox, SZ) {
  const wrap = document.getElementById('board-grid-wrap');
  if (!wrap) return;
  const cx = ((bbox.minC + bbox.maxC + 1) / 2) * SZ;
  const cy = ((bbox.minR + bbox.maxR + 1) / 2) * SZ;
  wrap.scrollLeft = Math.max(0, cx - wrap.clientWidth / 2);
  wrap.scrollTop  = Math.max(0, cy - wrap.clientHeight / 2);
}

function boardFitZoom() {
  const wrap = document.getElementById('board-grid-wrap');
  const bbox = boardComputeBBox();
  if (wrap) {
    // Measure the wrapper's actual padding rather than assuming 16px a side.
    // This was hardcoded as `- 32`, which silently mis-fit on mobile, where
    // css/board.css drops #board-grid-wrap to 8px of padding.
    const cs = getComputedStyle(wrap);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight)  || 0);
    const padY = (parseFloat(cs.paddingTop)  || 0) + (parseFloat(cs.paddingBottom) || 0);
    const availW = wrap.clientWidth  - padX;
    const availH = wrap.clientHeight - padY;
    const cols = bbox.maxC - bbox.minC + 1, rows = bbox.maxR - bbox.minR + 1;
    const fit = Math.min(availW / (cols * CELL_BASE), availH / (rows * CELL_BASE));
    boardZoom = Math.max(Math.min(+fit.toFixed(4), 3), 0.25);
  }
  updateZoomLabel();
  renderBoardCanvas();
  boardScrollToBBox(bbox, boardCell());
}

function boardClearRange() {
  boardState.rangeFt = 0;
  const inp = document.getElementById('board-range-input');
  if (inp) inp.value = '';
  renderBoardCanvas();
}

function boardClearPositions() {
  if (!boardCanEdit) return;
  if (!encounter.combatants.some(c => c.boardX != null)) return;
  if (!confirm('Remove all units from the grid?')) return;
  encounter.combatants.forEach(c => { c.boardX = null; c.boardY = null; });
  // Field-by-field, not a fresh object literal: replacing boardState wholesale
  // here dropped `tool` and `penColor` on the floor, and an undefined tool is
  // read as "not move" by every handler below — so clearing the grid quietly
  // left the board in a drawing mode it never showed in the toolbar.
  boardState.pendingId = null;
  boardState.selectedIds = [];
  boardState.selectedPropId = null;
  boardState.propPreview = null;
  encSave();
  renderBoard();
}

function boardInitCanvas() {
  const canvas = document.getElementById('board-canvas');
  const SZ = boardCell();
  const W = BOARD_COLS * SZ;
  const H = BOARD_ROWS * SZ;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  return canvas;
}

function boardTokenColor(c) {
  if (c.team !== null && c.team !== undefined && TEAM_COLORS[c.team]) {
    return TEAM_COLORS[c.team].bg;
  }
  return '#8B47D4'; // default purple
}

function boardInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function renderBoard() {
  renderBoardTray();
  renderBoardCanvas();
  renderBoardDistance();
  renderBoardPropActions();
  // The sight switch is shared state, so the checkbox has to follow a remote
  // change as well as a local click — this is the one place both paths meet.
  boardSyncLosToggle();
}

function renderBoardTray() {
  const list = document.getElementById('board-tray-list');
  const unplaced = encounter.combatants.filter(c => c.boardX == null);
  if (unplaced.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px 4px;font-style:italic;">All placed</div>';
    return;
  }
  list.innerHTML = unplaced.map(c => {
    const isDead = c.hp === 0;
    const color = boardTokenColor(c);
    const isPending = boardState.pendingId === c.id;
    const title = boardCanEdit ? `${c.name} — HP: ${c.hp}/${c.maxHp}` : `${c.name} — the DM places tokens`;
    return `<div class="board-tray-item${isDead ? ' is-dead' : ''}${isPending ? ' selected' : ''}${boardCanEdit ? '' : ' read-only'}"
      ${boardCanEdit ? `onclick="boardSelectTrayItem(${c.id})"` : ''} title="${title}">
      <div class="board-tray-token" style="background:${color};color:#fff;">${boardInitials(c.name)}</div>
      <div class="board-tray-name">${c.name}</div>
    </div>`;
  }).join('');
}

// The grid background (fill + alternating squares + grid lines + labels) never
// changes between frames unless zoom, theme, or canvas size changes — redrawing
// all ~10,000 cells of it on every mousemove during a drag was the main source
// of board-mode jank. Cache it on an offscreen canvas and blit it instead.
let _boardBgCache = { key: '', canvas: null };

function boardBuildBgLayer(width, height, SZ, isDark, showLabels) {
  const bg = document.createElement('canvas');
  bg.width = width; bg.height = height;
  const ctx = bg.getContext('2d');

  // Background
  ctx.fillStyle = isDark ? '#141820' : '#f0f0f0';
  ctx.fillRect(0, 0, width, height);

  // Alternating squares
  ctx.fillStyle = isDark ? '#1a1f2a' : '#e4e4e4';
  for (let r = 0; r < BOARD_ROWS; r++) {
    for (let c = 0; c < BOARD_COLS; c++) {
      if ((r + c) % 2 === 1) ctx.fillRect(c * SZ, r * SZ, SZ, SZ);
    }
  }

  // Grid lines — batched into a single path instead of one stroke() call per line
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= BOARD_COLS; c++) { ctx.moveTo(c * SZ, 0); ctx.lineTo(c * SZ, height); }
  for (let r = 0; r <= BOARD_ROWS; r++) { ctx.moveTo(0, r * SZ); ctx.lineTo(width, r * SZ); }
  ctx.stroke();

  // Row/col labels (skip at very small zoom)
  if (showLabels) {
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.25)';
    const fontSize = Math.max(6, Math.min(9, SZ - 4));
    ctx.font = `${fontSize}px sans-serif`;
    // Only label every Nth column/row to avoid clutter
    const step = SZ < 14 ? 5 : SZ < 20 ? 2 : 1;
    ctx.textAlign = 'center';
    for (let c = 0; c < BOARD_COLS; c++) {
      if ((c + 1) % step === 0 || c === 0) ctx.fillText(c + 1, c * SZ + SZ / 2, fontSize + 1);
    }
    ctx.textAlign = 'right';
    for (let r = 0; r < BOARD_ROWS; r++) {
      if ((r + 1) % step === 0 || r === 0) ctx.fillText(r + 1, SZ - 2, r * SZ + SZ / 2 + fontSize / 2 - 1);
    }
  }
  return bg;
}

// Which palette the grid paints itself in.
//
// This used to sniff the theme by string-matching the first character of
// the --bg custom property:
//     getComputedStyle(document.body).getPropertyValue('--bg').startsWith('#0')
// which silently rendered the board unreadable the moment --bg changed to a
// hex not beginning with 0, or to rgb()/hsl()/oklch()/color-mix(). The theme
// now states its intent explicitly via the --board-scheme token (see
// css/tokens.css), so any future palette change is safe.
function boardIsDarkScheme() {
  const scheme = getComputedStyle(document.body)
    .getPropertyValue('--board-scheme').trim().toLowerCase();
  if (scheme === 'light') return false;
  if (scheme === 'dark') return true;
  // Token missing entirely (page not yet migrated) — fall back to the OS.
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

// The bg-layer cache key includes isDark, so flipping the scheme invalidates
// it on its own. What was missing was anything to trigger a repaint at all:
// the board never reacted to an OS theme change until the next unrelated
// render. This wires that up.
if (window.matchMedia) {
  const _boardSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const _onBoardSchemeChange = function () {
    if (typeof renderBoardCanvas === 'function' && document.getElementById('board-canvas')) {
      renderBoardCanvas();
    }
  };
  if (_boardSchemeQuery.addEventListener) {
    _boardSchemeQuery.addEventListener('change', _onBoardSchemeChange);
  } else if (_boardSchemeQuery.addListener) {
    _boardSchemeQuery.addListener(_onBoardSchemeChange);   // Safari < 14
  }
}

function boardGetBgLayer(width, height, SZ, isDark, showLabels) {
  const key = [width, height, SZ, isDark, showLabels].join('|');
  if (_boardBgCache.key !== key) {
    _boardBgCache = { key, canvas: boardBuildBgLayer(width, height, SZ, isDark, showLabels) };
  }
  return _boardBgCache.canvas;
}

function paintTerrainLayer(ctx, SZ, terrain) {
  const showLabel = SZ >= 14;
  for (const t of terrain) {
    const style = TERRAIN_STYLES[t.type];
    if (!style) continue;
    // Fog is painted opaque over everything at the end of the frame instead,
    // on the boards that aren't allowed to see through it.
    if (t.type === 'fog' && !boardCanEdit) continue;
    const parts = t.id.split(',');
    const c = +parts[0], r = +parts[1];
    ctx.fillStyle = style.fill;
    ctx.fillRect(c * SZ, r * SZ, SZ, SZ);
    if (showLabel) {
      ctx.save();
      ctx.font = `${Math.max(8, Math.min(16, SZ * 0.5))}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(style.label, c * SZ + SZ / 2, r * SZ + SZ / 2);
      ctx.restore();
    }
  }
}

// Freehand drawings, stored in cell-fraction units so they stay put across zoom levels.
function paintStrokesLayer(ctx, SZ, strokes) {
  for (const s of strokes) {
    if (!s.points || s.points.length < 2) continue;
    ctx.save();
    ctx.strokeStyle = s.color || '#E8A020';
    ctx.lineWidth = Math.max(1, (s.width || 3) * (SZ / CELL_BASE));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x * SZ, s.points[0].y * SZ);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * SZ, s.points[i].y * SZ);
    ctx.stroke();
    ctx.restore();
  }
}

// Committed terrain + strokes are cached to an offscreen layer, keyed on a
// version counter bumped only when that data actually changes (paint/erase/
// finish-a-stroke/clear-art/apply-a-remote-update). Board mode re-renders on
// every mousemove of a token drag, pan, or hover — before this cache, each of
// those frames re-looped every terrain cell and every point of every stroke
// even though none of it had changed since the last frame. Only the
// still-in-progress stroke (if any) is repainted live on top each frame.
let _boardArtCache = { key: '', canvas: null };
let _boardArtVersion = 0;
function boardBumpArtVersion() { _boardArtVersion++; }

function boardBuildArtLayer(width, height, SZ) {
  const layer = document.createElement('canvas');
  layer.width = width; layer.height = height;
  const ctx = layer.getContext('2d');
  paintTintLayer(ctx, SZ, encounter.boardTint || []);
  paintTerrainLayer(ctx, SZ, encounter.boardTerrain || []);
  paintElevLayer(ctx, SZ, encounter.boardElev || []);
  paintStrokesLayer(ctx, SZ, encounter.boardStrokes || []);
  return layer;
}

function boardGetArtLayer(width, height, SZ) {
  // boardCanEdit is in the key because fog renders differently either side of
  // it, and board.html flips it from true to false once the admin check comes
  // back — a layer baked before that must not be reused after.
  const key = [width, height, SZ, _boardArtVersion, boardCanEdit].join('|');
  if (_boardArtCache.key !== key) {
    _boardArtCache = { key, canvas: boardBuildArtLayer(width, height, SZ) };
  }
  return _boardArtCache.canvas;
}

function renderBoardCanvas() {
  const canvas = boardInitCanvas();
  const ctx = canvas.getContext('2d');
  const SZ = boardCell();
  const isDark = boardIsDarkScheme();
  const showLabels = SZ >= 10;

  ctx.drawImage(boardGetBgLayer(canvas.width, canvas.height, SZ, isDark, showLabels), 0, 0);
  ctx.drawImage(boardGetArtLayer(canvas.width, canvas.height, SZ), 0, 0);
  if (boardState.drawingStroke) paintStrokesLayer(ctx, SZ, [boardState.drawingStroke]);
  // Above terrain and drawings, below tokens — units stand on the scenery.
  paintPropsLayer(ctx, SZ);
  // Area shapes go over the scenery and under the tokens, so you can see who
  // is caught in one; labels go over the scenery so they stay readable.
  paintTemplatesLayer(ctx, SZ);
  paintNotesLayer(ctx, SZ);

  // Range overlay
  if (boardState.rangeFt > 0 && boardState.selectedIds.length >= 1) {
    const origin = encounter.combatants.find(c => c.id === boardState.selectedIds[0]);
    if (origin && origin.boardX != null) {
      const rangeSquares = Math.round(boardState.rangeFt / 5);
      const ox = origin.boardX, oy = origin.boardY;
      // Distance here is Chebyshev (max of dx, dy), so every cell within range
      // lies inside this box -- looping the full 100x100 grid to find them was
      // 20,000 iterations/frame even for a small range, and this ran on every
      // frame of a drag/pan/pinch while a range was active.
      const rMin = Math.max(0, oy - rangeSquares), rMax = Math.min(BOARD_ROWS - 1, oy + rangeSquares);
      const cMin = Math.max(0, ox - rangeSquares), cMax = Math.min(BOARD_COLS - 1, ox + rangeSquares);
      ctx.save();
      for (let r = rMin; r <= rMax; r++) {
        for (let c = cMin; c <= cMax; c++) {
          const dist = Math.max(Math.abs(c - ox), Math.abs(r - oy));
          if (dist > 0 && dist <= rangeSquares) {
            ctx.fillStyle = 'rgba(14,158,133,0.18)';
            ctx.fillRect(c * SZ + 1, r * SZ + 1, SZ - 2, SZ - 2);
          }
        }
      }
      ctx.strokeStyle = 'rgba(14,158,133,0.85)';
      ctx.lineWidth = Math.max(1, SZ / 16);
      for (let r = rMin; r <= rMax; r++) {
        for (let c = cMin; c <= cMax; c++) {
          const dx = Math.abs(c - ox), dy = Math.abs(r - oy);
          if (Math.max(dx, dy) === rangeSquares) {
            const edges = [
              { cond: Math.max(Math.abs(c-1-ox), dy) > rangeSquares, x1: c*SZ,     y1: r*SZ,     x2: c*SZ,     y2: (r+1)*SZ },
              { cond: Math.max(Math.abs(c+1-ox), dy) > rangeSquares, x1: (c+1)*SZ, y1: r*SZ,     x2: (c+1)*SZ, y2: (r+1)*SZ },
              { cond: Math.max(dx, Math.abs(r-1-oy)) > rangeSquares, x1: c*SZ,     y1: r*SZ,     x2: (c+1)*SZ, y2: r*SZ     },
              { cond: Math.max(dx, Math.abs(r+1-oy)) > rangeSquares, x1: c*SZ,     y1: (r+1)*SZ, x2: (c+1)*SZ, y2: (r+1)*SZ },
            ];
            for (const e of edges) {
              if (e.cond) { ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke(); }
            }
          }
        }
      }
      ctx.restore();
    }
  }

  // Distance line between two selected units
  const sel = boardState.selectedIds;
  if (sel.length === 2) {
    const a = encounter.combatants.find(c => c.id === sel[0]);
    const b = encounter.combatants.find(c => c.id === sel[1]);
    if (a && b && a.boardX != null && b.boardX != null) {
      const ax = a.boardX * SZ + SZ / 2, ay = a.boardY * SZ + SZ / 2;
      const bx = b.boardX * SZ + SZ / 2, by = b.boardY * SZ + SZ / 2;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(232,160,32,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.restore();
    }
  }

  // Ghost token + drag-distance label
  if (boardState.dragging) {
    const { id, originX, originY, curCol, curRow } = boardState.dragging;
    const dc = encounter.combatants.find(c => c.id === id);
    if (dc) {
      const color = boardTokenColor(dc);
      const occupied = encounter.combatants.some(c => c.boardX === curCol && c.boardY === curRow && c.id !== id);
      // Origin dashed outline
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 2;
      ctx.strokeRect(originX * SZ + 2, originY * SZ + 2, SZ - 4, SZ - 4);
      ctx.restore();
      // On touch, a fingertip sits right on top of (and hides) the cell being
      // targeted. Mark the real landing cell with an outline, but draw the
      // ghost token itself lifted above it so it's actually visible while dragging.
      const touchLift = BOARD_IS_TOUCH ? Math.max(34, SZ * 1.3) : 0;
      if (touchLift) {
        ctx.save();
        ctx.strokeStyle = occupied ? 'rgba(239,68,68,0.85)' : 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(curCol * SZ + 2, curRow * SZ + 2, SZ - 4, SZ - 4);
        ctx.restore();
      }
      // Ghost circle
      const cx = curCol * SZ + SZ / 2, cy = curRow * SZ + SZ / 2 - touchLift;
      const tr = Math.max(3, SZ / 2 - 3);
      ctx.save();
      ctx.globalAlpha = occupied ? 0.3 : 0.65;
      ctx.beginPath(); ctx.arc(cx, cy, tr, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = occupied ? '#EF4444' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = occupied ? 2.5 : 1.5; ctx.stroke();
      if (!occupied && SZ >= 10) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(6, SZ <= 16 ? 7 : 9)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(boardInitials(dc.name), cx, cy);
      }
      ctx.restore();
      // Move-distance pill above ghost
      const moveSq = Math.max(Math.abs(curCol - originX), Math.abs(curRow - originY));
      if (moveSq > 0) {
        const label = `${moveSq} sq · ${moveSq * 5} ft`;
        ctx.save();
        ctx.font = 'bold 10px sans-serif';
        const tw = ctx.measureText(label).width;
        const pillW = tw + 12, pillH = 16;
        const px = cx - pillW / 2;
        const py = cy - tr - pillH - 6;
        ctx.fillStyle = 'rgba(10,14,22,0.82)';
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(px, py, pillW, pillH, 4); } else { ctx.rect(px, py, pillW, pillH); }
        ctx.fill();
        ctx.fillStyle = occupied ? '#FCA5A5' : '#E8A020';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, py + pillH / 2);
        ctx.restore();
      }
    }
  }

  // Tokens
  const placed = encounter.combatants.filter(c => c.boardX != null);
  for (const c of placed) {
    const isDraggingThis = boardState.dragging?.id === c.id;
    const cx = c.boardX * SZ + SZ / 2, cy = c.boardY * SZ + SZ / 2;
    const r = Math.max(3, SZ / 2 - 3);
    const isDead = c.hp === 0;
    const color = boardTokenColor(c);
    const isSelected = boardState.selectedIds.includes(c.id);

    ctx.save();
    if (isDraggingThis) ctx.globalAlpha = 0.25;
    else if (isDead) ctx.globalAlpha = 0.35;

    if (isSelected) {
      // Glow is applied only to selected tokens — usually one, occasionally
      // two. shadowBlur is the expensive part of a canvas fill, so it is
      // deliberately not used for the token body below, which runs for every
      // combatant on every frame of a drag.
      ctx.save();
      ctx.shadowColor = 'rgba(255,194,32,0.85)';
      ctx.shadowBlur = Math.max(6, SZ / 2);
      ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,194,32,0.30)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,194,32,0.95)';
      ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }

    // Dark rim under the body reads as a comic ink outline and lifts the
    // token off the grid. A stroke costs far less than a shadow here.
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = 'rgba(5,6,10,0.55)'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1; ctx.stroke();

    const hpPct = c.maxHp > 0 ? c.hp / c.maxHp : 0;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, -Math.PI / 2, -Math.PI / 2 + hpPct * Math.PI * 2);
    ctx.strokeStyle = hpPct > 0.5 ? '#2D9F4E' : hpPct > 0.25 ? '#C49A0A' : '#EF4444';
    ctx.lineWidth = Math.max(2, SZ / 12); ctx.stroke();

    if (SZ >= 10) {
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(6, SZ <= 16 ? 7 : 9)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(boardInitials(c.name), cx, cy);
    }
    ctx.restore();
  }

  // Hover tooltip
  if (boardHoverInfo && !boardState.dragging) {
    const { combatant: hc, col: hCol, row: hRow } = boardHoverInfo;
    const hpPct = hc.maxHp > 0 ? hc.hp / hc.maxHp : 0;
    const hpColor = hpPct > 0.5 ? '#2D9F4E' : hpPct > 0.25 ? '#C49A0A' : '#EF4444';
    const conds = (hc.conditions || []).join(', ') || 'None';
    const lines = [
      hc.name,
      `HP ${hc.hp}/${hc.maxHp}  ·  AC ${hc.ac}`,
      `Conditions: ${conds}`,
    ];
    const ttX = hCol * SZ + SZ / 2;
    const ttY = hRow * SZ - 6;
    ctx.save();
    ctx.font = 'bold 11px sans-serif';
    const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
    const ttW = maxW + 18, ttH = lines.length * 15 + 10;
    let tx = ttX - ttW / 2;
    let ty = ttY - ttH;
    tx = Math.max(2, Math.min(canvas.width - ttW - 2, tx));
    if (ty < 2) ty = hRow * SZ + SZ + 6;
    ctx.fillStyle = 'rgba(10,14,22,0.92)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(tx, ty, ttW, ttH, 5); else ctx.rect(tx, ty, ttW, ttH);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? '#fff' : i === 1 ? hpColor : 'rgba(255,255,255,0.6)';
      ctx.font = i === 0 ? 'bold 11px sans-serif' : '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(line, tx + 9, ty + 6 + i * 15);
    });
    ctx.restore();
  }

  // Last of all: on a board that can't edit, the fog closes over tokens,
  // scenery, labels and terrain alike. On the DM's it is only shaded, so they
  // can see both what is there and what the players are missing.
  if (!boardCanEdit) paintFogLayer(ctx, SZ, isDark);
  else if (boardLosEnabled()) paintSightShadow(ctx, SZ);

  if (boardState.pendingId !== null) {
    const hint = document.getElementById('board-hint');
    if (hint) hint.textContent = 'Click a grid square to place the selected unit.';
  }
}

function renderBoardDistance() {
  const label = document.getElementById('board-distance-label');
  const sel = boardState.selectedIds;
  if (sel.length === 2) {
    const a = encounter.combatants.find(c => c.id === sel[0]);
    const b = encounter.combatants.find(c => c.id === sel[1]);
    if (a && b && a.boardX != null && b.boardX != null) {
      const dx = Math.abs(a.boardX - b.boardX);
      const dy = Math.abs(a.boardY - b.boardY);
      const squares = Math.max(dx, dy); // Chebyshev (D&D diagonal = 5ft)
      const feet = squares * 5;
      label.textContent = `${squares} sq · ${feet} ft`;
      label.style.display = 'block';
      return;
    }
  }
  label.textContent = '';
}

function boardSelectTrayItem(id) {
  if (!boardCanEdit) return;
  boardState.pendingId = boardState.pendingId === id ? null : id;
  boardState.selectedIds = [];
  // Picking a unit puts any armed prefab down. The click handler checks
  // pendingProp first, so leaving both set would stamp scenery every time the
  // DM tried to place the unit they'd just chosen.
  boardState.pendingProp = null;
  boardState.selectedPropId = null;
  boardState.propPreview = null;
  renderPrefabPaletteSelection();
  renderBoard();
  updateBoardHint();
}

function boardCanvasCell(e) {
  const canvas = document.getElementById('board-canvas');
  const rect = canvas.getBoundingClientRect();
  const SZ = boardCell();
  const col = Math.floor((e.clientX - rect.left) * (canvas.width  / rect.width)  / SZ);
  const row = Math.floor((e.clientY - rect.top)  * (canvas.height / rect.height) / SZ);
  return { col, row };
}

function boardHandleMouseDown(e) {
  if (boardState.tool !== 'move') {
    if (e.button !== 0) return;
    boardDrawStart(e);
    e.preventDefault();
    return;
  }
  // Middle-click OR left-click on empty space → pan
  if (e.button === 1) {
    const wrap = document.getElementById('board-grid-wrap');
    boardPan = { startX: e.clientX, startY: e.clientY, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop };
    document.getElementById('board-canvas').style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  const { col, row } = boardCanvasCell(e);
  if (col < 0 || col >= BOARD_COLS || row < 0 || row >= BOARD_ROWS) return;
  const hit = boardHitTest(col, row);
  // Only the *already selected* prop drags. A loaded preset map covers most of
  // the visible grid in buildings, and dragging any prop under the cursor
  // would leave almost nowhere to grab for a pan — so it's click-to-select,
  // then drag, and an unselected prop passes the gesture through to the pan
  // below exactly like empty ground.
  const propHit = hit ? null : boardPropAt(col, row);
  if (hit && boardCanEdit) {
    boardState.dragging = { id: hit.id, originX: col, originY: row, curCol: col, curRow: row };
    document.getElementById('board-canvas').style.cursor = 'grabbing';
  } else if (propHit && boardCanEdit && propHit.id === boardState.selectedPropId) {
    boardState.draggingProp = {
      id: propHit.id,
      grabC: col - propHit.col, grabR: row - propHit.row,
      originC: propHit.col, originR: propHit.row,
      curCol: propHit.col, curRow: propHit.row,
    };
    document.getElementById('board-canvas').style.cursor = 'grabbing';
  } else {
    // Left-click/touch drag on empty space — or on a token when this viewer
    // can't edit — pans the view instead of trying to move anything.
    const wrap = document.getElementById('board-grid-wrap');
    boardPan = { startX: e.clientX, startY: e.clientY, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop };
    document.getElementById('board-canvas').style.cursor = 'grabbing';
  }
  e.preventDefault();
}

function boardHandleMouseMove(e) {
  const canvas = document.getElementById('board-canvas');
  if (boardState.tool !== 'move') {
    boardDrawMove(e);
    return;
  }
  if (boardPan) {
    const wrap = document.getElementById('board-grid-wrap');
    wrap.scrollLeft = boardPan.scrollLeft - (e.clientX - boardPan.startX);
    wrap.scrollTop  = boardPan.scrollTop  - (e.clientY - boardPan.startY);
    return;
  }
  if (boardState.draggingProp) {
    const d = boardState.draggingProp;
    const p = (encounter.boardProps || []).find(x => x.id === d.id);
    if (!p) { boardState.draggingProp = null; return; }
    const { col, row } = boardCanvasCell(e);
    const at = boardClampPropPos(boardPropFootprint(p), col - d.grabC, row - d.grabR);
    if (at.col !== d.curCol || at.row !== d.curRow) {
      d.curCol = at.col; d.curRow = at.row;
      boardRequestRender();
    }
    return;
  }
  if (!boardState.dragging) {
    const { col, row } = boardCanvasCell(e);
    // With a prefab armed, the cursor is a stamp: show the footprint it would
    // drop rather than hover tooltips for whatever is underneath.
    if (boardState.pendingProp && col >= 0 && col < BOARD_COLS && row >= 0 && row < BOARD_ROWS) {
      const prev = boardState.propPreview;
      if (!prev || prev.col !== col || prev.row !== row || prev.type !== boardState.pendingProp) {
        boardState.propPreview = { type: boardState.pendingProp, col, row };
        boardRequestRender();
      }
      boardHoverInfo = null;
      canvas.style.cursor = 'copy';
      return;
    }
    if (boardState.propPreview && !_boardDragPrefab) {
      boardState.propPreview = null;
      boardRequestRender();
    }
    const hit = col >= 0 && col < BOARD_COLS && row >= 0 && row < BOARD_ROWS
      ? encounter.combatants.find(c => c.boardX === col && c.boardY === row) : null;
    canvas.style.cursor = hit ? 'grab' : 'crosshair';
    const prev = boardHoverInfo;
    boardHoverInfo = hit ? { combatant: hit, col, row } : null;
    if ((prev == null) !== (boardHoverInfo == null) || prev?.combatant?.id !== boardHoverInfo?.combatant?.id) {
      boardRequestRender();
    }
    return;
  }
  const { col, row } = boardCanvasCell(e);
  const cc = Math.max(0, Math.min(BOARD_COLS - 1, col));
  const cr = Math.max(0, Math.min(BOARD_ROWS - 1, row));
  if (cc !== boardState.dragging.curCol || cr !== boardState.dragging.curRow) {
    boardState.dragging.curCol = cc;
    boardState.dragging.curRow = cr;
    boardRequestRender();
  }
}

function boardHandleMouseUp(e) {
  if (boardState.tool !== 'move') {
    boardDrawEnd(e);
    return;
  }
  if (boardPan) {
    const moved = Math.abs(e.clientX - boardPan.startX) + Math.abs(e.clientY - boardPan.startY) > 4;
    boardPan = null;
    document.getElementById('board-canvas').style.cursor = 'crosshair';
    if (moved) _boardWasPanning = true;
    return;
  }
  if (boardState.draggingProp) {
    const d = boardState.draggingProp;
    boardState.draggingProp = null;
    document.getElementById('board-canvas').style.cursor = 'crosshair';
    const p = (encounter.boardProps || []).find(x => x.id === d.id);
    if (p && (d.curCol !== d.originC || d.curRow !== d.originR)) {
      boardMoveProp(p, d.curCol, d.curRow);
      boardState._wasDragging = true; // so the click that follows doesn't re-handle it
    }
    renderBoard();
    return;
  }
  if (!boardState.dragging) return;
  const { id, originX, originY, curCol, curRow } = boardState.dragging;
  boardState.dragging = null;
  document.getElementById('board-canvas').style.cursor = 'crosshair';
  const moved = curCol !== originX || curRow !== originY;
  if (moved) {
    const occupant = encounter.combatants.find(c => c.boardX === curCol && c.boardY === curRow && c.id !== id);
    if (!occupant) {
      const c = encounter.combatants.find(x => x.id === id);
      if (c) { c.boardX = curCol; c.boardY = curRow; }
      encSave();
    }
    boardState._wasDragging = true;
  }
  renderBoard();
}

function boardHandleCanvasClick(e) {
  if (boardState.tool !== 'move') return;
  if (_boardWasPanning) { _boardWasPanning = false; return; }
  if (boardState._wasDragging) { boardState._wasDragging = false; return; }
  const { col, row } = boardCanvasCell(e);
  if (col < 0 || col >= BOARD_COLS || row < 0 || row >= BOARD_ROWS) return;

  // Stamping scenery. Stays armed afterwards — laying a row of trees or a
  // line of crates is the common case — so this returns before any of the
  // token rules below get a look at the click.
  if (boardCanEdit && boardState.pendingProp) {
    boardPlaceProp(boardState.pendingProp, col, row);
    renderBoard();
    return;
  }

  // Check if click lands on an existing placed token. Placement-occupancy
  // must use the exact cell; selecting a token for measurement can use touch
  // tolerance since that's just picking which token you meant to tap.
  const exactHit = encounter.combatants.find(c => c.boardX === col && c.boardY === row);

  if (boardCanEdit && boardState.pendingId !== null) {
    // Placing a tray item
    if (exactHit && exactHit.id !== boardState.pendingId) return; // occupied
    const c = encounter.combatants.find(x => x.id === boardState.pendingId);
    if (c) { c.boardX = col; c.boardY = row; }
    boardState.pendingId = null;
    encSave();
    document.getElementById('board-hint').textContent = BOARD_TOOL_HINTS.move;
    renderBoard();
    return;
  }

  const hit = boardHitTest(col, row);
  if (hit) {
    // Select / deselect token for distance measurement
    const idx = boardState.selectedIds.indexOf(hit.id);
    if (idx !== -1) {
      boardState.selectedIds.splice(idx, 1);
    } else {
      boardState.selectedIds.push(hit.id);
      if (boardState.selectedIds.length > 2) boardState.selectedIds.shift();
    }
    renderBoard();
    return;
  }

  // Click on empty cell while a placed token is selected (move it)
  if (boardCanEdit && boardState.selectedIds.length === 1) {
    const c = encounter.combatants.find(x => x.id === boardState.selectedIds[0]);
    if (c && c.boardX != null) {
      c.boardX = col; c.boardY = row;
      encSave();
      renderBoard();
      return;
    }
  }

  // A prop under the click gets selected, which is what arms rotate, remove
  // and drag for it. Deliberately after the token rules above: moving a unit
  // onto the square a car occupies has to keep working.
  if (boardCanEdit) {
    const propHit = boardPropAt(col, row);
    if (propHit) { boardSelectProp(propHit.id); return; }
  }

  // Clear selection on empty click
  boardState.selectedIds = [];
  boardState.selectedPropId = null;
  renderBoard();
  updateBoardHint();
}

function boardHandleCanvasRightClick(e) {
  e.preventDefault();
  if (boardState.tool !== 'move' || !boardCanEdit) return;
  const { col, row } = boardCanvasCell(e);
  const hit = encounter.combatants.find(c => c.boardX === col && c.boardY === row);
  if (hit) {
    hit.boardX = null; hit.boardY = null;
    boardState.selectedIds = boardState.selectedIds.filter(id => id !== hit.id);
    encSave();
    renderBoard();
    return;
  }
  const propHit = boardPropAt(col, row);
  if (propHit && boardRemoveProp(propHit.id)) {
    renderBoard();
    updateBoardHint();
  }
}

// ── Touch support (mobile board mode) ───────────────────────
let _boardPinch = null; // { dist, zoom, midX, midY, scrollLeft, scrollTop }
function boardPointFromTouch(t) { return { clientX: t.clientX, clientY: t.clientY, button: 0, preventDefault(){} }; }
function boardTouchDistance(t1, t2) { return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY); }
function boardTouchMidpoint(t1, t2) { return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 }; }

// A fingertip is much less precise than a mouse cursor, so a touch aimed at a
// small token easily lands on the cell next to it. Fall back to the nearest
// occupied neighboring cell (touch input only) instead of requiring a
// pixel-exact hit -- this is for "which token did they mean to touch", not
// for placement-occupancy checks, which stay pixel-exact.
function boardHitTest(col, row) {
  const exact = encounter.combatants.find(c => c.boardX === col && c.boardY === row);
  if (exact || !BOARD_IS_TOUCH) return exact || null;
  let best = null, bestDist = Infinity;
  for (const c of encounter.combatants) {
    if (c.boardX == null) continue;
    const d = Math.max(Math.abs(c.boardX - col), Math.abs(c.boardY - row));
    if (d <= 1 && d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

// Long-press on a placed token or prop = touch equivalent of desktop
// right-click (remove it), since touch has no separate right-click gesture.
let _boardLongPressTimer = null;
let _boardLongPressStart = null; // { x, y, id, kind: 'token' | 'prop' }
const BOARD_LONG_PRESS_MS = 500;
const BOARD_LONG_PRESS_SLOP = 10; // px of finger movement that cancels the hold

function boardCancelLongPress() {
  if (_boardLongPressTimer) { clearTimeout(_boardLongPressTimer); _boardLongPressTimer = null; }
  _boardLongPressStart = null;
}

function boardHandleTouchStart(e) {
  if (e.touches.length === 2) {
    e.preventDefault();
    boardCancelLongPress();
    boardState.dragging = null;
    boardPan = null;
    // Two fingers is always "move the camera" (pan + pinch-zoom together),
    // regardless of what's underneath them — a dedicated gesture so panning
    // never gets misread as trying to drag a token, which one finger alone
    // is ambiguous about when it lands near/on a piece.
    const wrap = document.getElementById('board-grid-wrap');
    const mid = boardTouchMidpoint(e.touches[0], e.touches[1]);
    _boardPinch = {
      dist: boardTouchDistance(e.touches[0], e.touches[1]), zoom: boardZoom,
      midX: mid.x, midY: mid.y, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop,
    };
    return;
  }
  if (e.touches.length !== 1) return;
  e.preventDefault();
  const t = e.touches[0];
  const { col, row } = boardCanvasCell(boardPointFromTouch(t));
  const canGrab = boardState.tool === 'move' && boardCanEdit;
  const hit = canGrab ? boardHitTest(col, row) : null;
  const propHit = (canGrab && !hit) ? boardPropAt(col, row) : null;
  if (hit || propHit) {
    _boardLongPressStart = {
      x: t.clientX, y: t.clientY,
      id: hit ? hit.id : propHit.id,
      kind: hit ? 'token' : 'prop',
    };
    _boardLongPressTimer = setTimeout(() => {
      _boardLongPressTimer = null;
      if (!_boardLongPressStart) return;
      const { id, kind } = _boardLongPressStart;
      _boardLongPressStart = null;
      boardState.dragging = null;
      boardState.draggingProp = null;
      if (kind === 'prop') {
        if (boardRemoveProp(id)) { renderBoard(); updateBoardHint(); }
        return;
      }
      const c = encounter.combatants.find(x => x.id === id);
      if (c && c.boardX != null) {
        c.boardX = null; c.boardY = null;
        boardState.selectedIds = boardState.selectedIds.filter(cid => cid !== c.id);
        encSave();
        renderBoard();
      }
    }, BOARD_LONG_PRESS_MS);
  }
  boardHandleMouseDown(boardPointFromTouch(t));
}

function boardHandleTouchMove(e) {
  if (e.touches.length === 2 && _boardPinch) {
    e.preventDefault();
    boardCancelLongPress();
    const dist = boardTouchDistance(e.touches[0], e.touches[1]);
    boardZoom = Math.max(0.25, Math.min(3, +(_boardPinch.zoom * (dist / _boardPinch.dist)).toFixed(4)));
    updateZoomLabel();
    const mid = boardTouchMidpoint(e.touches[0], e.touches[1]);
    const wrap = document.getElementById('board-grid-wrap');
    wrap.scrollLeft = _boardPinch.scrollLeft - (mid.x - _boardPinch.midX);
    wrap.scrollTop  = _boardPinch.scrollTop  - (mid.y - _boardPinch.midY);
    boardRequestRender();
    return;
  }
  if (e.touches.length !== 1) return;
  e.preventDefault();
  if (_boardLongPressStart) {
    const t = e.touches[0];
    const moved = Math.hypot(t.clientX - _boardLongPressStart.x, t.clientY - _boardLongPressStart.y);
    if (moved > BOARD_LONG_PRESS_SLOP) boardCancelLongPress();
  }
  boardHandleMouseMove(boardPointFromTouch(e.touches[0]));
}

function boardHandleTouchEnd(e) {
  boardCancelLongPress();
  if (_boardPinch) {
    _boardPinch = null;
    boardRequestRender(); // snap from the quantized in-gesture cell size to the exact one
    return;
  }
  const t = e.changedTouches && e.changedTouches[0];
  if (!t) return;
  const point = boardPointFromTouch(t);
  boardHandleMouseUp(point);
  boardHandleCanvasClick(point);
}

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('board-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown', boardHandleMouseDown);
    canvas.addEventListener('mousemove', boardHandleMouseMove);
    canvas.addEventListener('mouseup',   boardHandleMouseUp);
    canvas.addEventListener('mouseleave', e => { boardHoverInfo = null; boardState.propPreview = null; boardPan = null; boardHandleMouseUp(e); document.getElementById('board-canvas').style.cursor = 'crosshair'; renderBoardCanvas(); });
    canvas.addEventListener('mouseup', e => { if (e.button === 1 && boardPan) { boardPan = null; document.getElementById('board-canvas').style.cursor = 'crosshair'; } });
    canvas.addEventListener('auxclick', e => e.preventDefault());
    canvas.addEventListener('click', boardHandleCanvasClick);
    canvas.addEventListener('contextmenu', boardHandleCanvasRightClick);
    canvas.addEventListener('wheel', e => { e.preventDefault(); e.deltaY < 0 ? boardZoomIn() : boardZoomOut(); }, { passive: false });
    canvas.addEventListener('touchstart', boardHandleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', boardHandleTouchMove, { passive: false });
    canvas.addEventListener('touchend', boardHandleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', boardHandleTouchEnd, { passive: false });

    // Dropping a prefab straight from the palette onto the grid. dragover has
    // to preventDefault() on every event or the browser refuses the drop.
    canvas.addEventListener('dragover', e => {
      if (!_boardDragPrefab || !boardCanEdit) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const { col, row } = boardCanvasCell(e);
      const prev = boardState.propPreview;
      if (!prev || prev.col !== col || prev.row !== row || prev.type !== _boardDragPrefab) {
        boardState.propPreview = { type: _boardDragPrefab, col, row };
        boardRequestRender();
      }
    });
    canvas.addEventListener('dragleave', () => {
      if (boardState.propPreview && !boardState.pendingProp) {
        boardState.propPreview = null;
        boardRequestRender();
      }
    });
    canvas.addEventListener('drop', e => {
      e.preventDefault();
      const type = (e.dataTransfer.getData('text/plain') || _boardDragPrefab || '').trim();
      _boardDragPrefab = null;
      boardState.propPreview = null;
      if (!boardCanEdit || !boardPrefab(type)) { boardRequestRender(); return; }
      const { col, row } = boardCanvasCell(e);
      boardPlaceProp(type, col, row);
      renderBoard();
    });
  }

  // Prefab palette and preset-map picker — encounter.html only; board.html has
  // neither in its markup and every one of these is a no-op there.
  const propList = document.getElementById('board-props-list');
  if (propList) {
    renderPrefabPalette();
    propList.addEventListener('dragstart', e => {
      const chip = e.target.closest && e.target.closest('.board-prop-chip');
      if (!chip || !boardCanEdit) return;
      _boardDragPrefab = chip.dataset.prop;
      e.dataTransfer.setData('text/plain', chip.dataset.prop);
      e.dataTransfer.effectAllowed = 'copy';
    });
    propList.addEventListener('dragend', () => {
      _boardDragPrefab = null;
      if (boardState.propPreview && !boardState.pendingProp) {
        boardState.propPreview = null;
        boardRequestRender();
      }
    });
  }
  const propFilter = document.getElementById('board-prop-filter');
  if (propFilter) propFilter.addEventListener('input', renderPrefabPalette);
  boardPopulateMapSelect();
  const mapSelect = document.getElementById('board-map-select');
  if (mapSelect) {
    mapSelect.addEventListener('change', () => {
      const note = document.getElementById('board-map-note');
      const mp = boardMapByKey(mapSelect.value);
      if (note) note.textContent = mp ? mp.desc : '';
    });
  }

  // R rotates the selected prop, Delete removes it. Guarded on the board
  // actually being on screen (the modal is display:none when closed) and on
  // nothing text-like having focus, so these never steal a keystroke from the
  // encounter list's inputs.
  document.addEventListener('keydown', e => {
    if (!boardCanEdit || !boardState.selectedPropId) return;
    const canvas = document.getElementById('board-canvas');
    if (!canvas || !canvas.offsetParent) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); boardRotateSelectedProp(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); boardDeleteSelectedProp(); }
  });
  const rangeInp = document.getElementById('board-range-input');
  if (rangeInp) {
    rangeInp.addEventListener('input', () => {
      const v = parseInt(rangeInp.value);
      boardState.rangeFt = (v > 0) ? v : 0;
      renderBoardCanvas();
    });
  }
});
