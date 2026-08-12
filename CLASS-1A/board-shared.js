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

   Contract — the host page must, before this <script> tag runs any of its
   functions (i.e. before DOMContentLoaded / its own init sequence, script
   tag order relative to this file doesn't matter beyond that):
     - declare `let encounter = { combatants: [], boardStrokes: [], boardTerrain: [], ... }`
     - define `function encSave() { ... }` (persists + syncs `encounter`)
     - call `boardBumpArtVersion()` whenever it replaces `encounter` wholesale
       (i.e. inside its own `applyRemoteEncounter`), so the cached terrain/
       drawing layer doesn't keep showing stale art after a remote update.
   The host's markup must include #board-canvas, #board-grid-wrap,
   #board-tray-list, #board-hint, #board-distance-label, #board-range-input,
   #board-zoom-label. Drawing-tool markup (.board-tool-btn[data-tool], the
   pen color input) is optional — only encounter.html has it.
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

/* ── Board Mode ───────────────────────────────────────── */
const BOARD_COLS = 100;
const BOARD_ROWS = 100;
const CELL_BASE = 16; // base px per square at zoom 1.0
let boardZoom = 0.5;  // start zoomed out to fit the full grid
let boardState = { pendingId: null, selectedIds: [], rangeFt: 0, dragging: null, _wasDragging: false, tool: 'move', penColor: '#E8A020', drawingStroke: null };
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

// Terrain marker styles: fill colour + a small glyph drawn at cell centre.
const TERRAIN_STYLES = {
  wall:      { fill: 'rgba(148,152,164,0.55)', label: '▦' },
  difficult: { fill: 'rgba(168,120,46,0.38)',  label: '≋' },
  hazard:    { fill: 'rgba(239,68,68,0.38)',   label: '⚠' },
  water:     { fill: 'rgba(37,99,235,0.34)',   label: '〰' },
  cover:     { fill: 'rgba(34,197,94,0.34)',   label: '⛊' },
};

const BOARD_TOOL_HINTS = {
  move: 'Click a unit in the tray, then click a grid square to place it. Drag placed tokens to move them.',
  pen: 'Click and drag on the grid to draw.',
  wall: 'Click or drag across squares to mark walls.',
  difficult: 'Click or drag across squares to mark difficult terrain.',
  hazard: 'Click or drag across squares to mark a hazard.',
  water: 'Click or drag across squares to mark water.',
  cover: 'Click or drag across squares to mark cover.',
  eraser: 'Click drawings or terrain to erase them.',
};

// Only encounter.html renders the .board-tool-btn toolbar, so this is a
// no-op (and boardState.tool never leaves 'move') on board.html.
function boardSetTool(tool) {
  boardState.tool = tool;
  boardState.pendingId = null;
  boardState.selectedIds = [];
  document.querySelectorAll('.board-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  const hint = document.getElementById('board-hint');
  if (hint) hint.textContent = BOARD_TOOL_HINTS[tool] || BOARD_TOOL_HINTS.move;
  renderBoardCanvas();
}

function boardClearArt() {
  if (!(encounter.boardStrokes || []).length && !(encounter.boardTerrain || []).length) return;
  if (!confirm('Clear all drawings and terrain markings from the board?')) return;
  encounter.boardStrokes = [];
  encounter.boardTerrain = [];
  boardBumpArtVersion();
  encSave();
  renderBoardCanvas();
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

  const nextStrokes = [];
  for (const s of encounter.boardStrokes) {
    const points = s.points.filter(pt => Math.hypot(pt.x - p.x, pt.y - p.y) > ERASE_RADIUS);
    if (points.length !== s.points.length) changed = true;
    if (points.length > 1) nextStrokes.push({ id: s.id, color: s.color, width: s.width, points });
  }
  encounter.boardStrokes = nextStrokes;

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
  } else {
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
  } else if (_boardPainting) {
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
// bounding box of the tokens actually in play instead, padded a bit, and
// scroll to it.
function boardComputeBBox() {
  const placed = encounter.combatants.filter(c => c.boardX != null);
  const PAD = 4;
  if (!placed.length) {
    const midC = Math.floor(BOARD_COLS / 2), midR = Math.floor(BOARD_ROWS / 2);
    return { minC: midC - 10, maxC: midC + 10, minR: midR - 10, maxR: midR + 10 };
  }
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const c of placed) {
    minC = Math.min(minC, c.boardX); maxC = Math.max(maxC, c.boardX);
    minR = Math.min(minR, c.boardY); maxR = Math.max(maxR, c.boardY);
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
  boardState = { pendingId: null, selectedIds: [] };
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
  paintTerrainLayer(ctx, SZ, encounter.boardTerrain || []);
  paintStrokesLayer(ctx, SZ, encounter.boardStrokes || []);
  return layer;
}

function boardGetArtLayer(width, height, SZ) {
  const key = [width, height, SZ, _boardArtVersion].join('|');
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
  document.getElementById('board-hint').textContent = boardState.pendingId !== null
    ? 'Click a grid square to place the selected unit.'
    : BOARD_TOOL_HINTS.move;
  renderBoard();
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
  if (hit && boardCanEdit) {
    boardState.dragging = { id: hit.id, originX: col, originY: row, curCol: col, curRow: row };
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
  if (!boardState.dragging) {
    const { col, row } = boardCanvasCell(e);
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

  // Clear selection on empty click
  boardState.selectedIds = [];
  renderBoard();
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

// Long-press on a placed token = touch equivalent of desktop right-click
// (remove from board), since touch has no separate right-click gesture.
let _boardLongPressTimer = null;
let _boardLongPressStart = null; // { x, y, id }
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
  const hit = boardState.tool === 'move' && boardCanEdit ? boardHitTest(col, row) : null;
  if (hit) {
    _boardLongPressStart = { x: t.clientX, y: t.clientY, id: hit.id };
    _boardLongPressTimer = setTimeout(() => {
      _boardLongPressTimer = null;
      if (!_boardLongPressStart) return;
      const c = encounter.combatants.find(x => x.id === _boardLongPressStart.id);
      _boardLongPressStart = null;
      boardState.dragging = null;
      if (c && c.boardX != null) {
        c.boardX = null; c.boardY = null;
        boardState.selectedIds = boardState.selectedIds.filter(id => id !== c.id);
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
    canvas.addEventListener('mouseleave', e => { boardHoverInfo = null; boardPan = null; boardHandleMouseUp(e); document.getElementById('board-canvas').style.cursor = 'crosshair'; renderBoardCanvas(); });
    canvas.addEventListener('mouseup', e => { if (e.button === 1 && boardPan) { boardPan = null; document.getElementById('board-canvas').style.cursor = 'crosshair'; } });
    canvas.addEventListener('auxclick', e => e.preventDefault());
    canvas.addEventListener('click', boardHandleCanvasClick);
    canvas.addEventListener('contextmenu', boardHandleCanvasRightClick);
    canvas.addEventListener('wheel', e => { e.preventDefault(); e.deltaY < 0 ? boardZoomIn() : boardZoomOut(); }, { passive: false });
    canvas.addEventListener('touchstart', boardHandleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', boardHandleTouchMove, { passive: false });
    canvas.addEventListener('touchend', boardHandleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', boardHandleTouchEnd, { passive: false });
  }
  const rangeInp = document.getElementById('board-range-input');
  if (rangeInp) {
    rangeInp.addEventListener('input', () => {
      const v = parseInt(rangeInp.value);
      boardState.rangeFt = (v > 0) ? v : 0;
      renderBoardCanvas();
    });
  }
});
