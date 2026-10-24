#!/usr/bin/env node
// Regression check for the tactical board's prop prefabs and preset maps
// (CLASS-1A/board-prefabs.js + the Props section of CLASS-1A/board-shared.js).
// Same shape as the other verify-* scripts here: no test runner, no
// dependencies, run it with `node scripts/verify-board-props.js`.
//
// What it guards:
//   1. Every prefab in the catalog is well formed and its draw() actually runs
//      — a prop nobody can render is a prop that blanks the board mid-session,
//      and these only ever run inside a canvas nothing tests by hand.
//   2. Every preset map builds, stays inside its own declared bounds, and only
//      names prefabs and terrain types that exist.
//   3. Loading a map lands entirely on the 100x100 grid.
//   4. The auto-terrain bookkeeping is reversible: a prop that stamped walls
//      takes exactly those walls back out when it moves, rotates or is
//      removed, and terrain the DM painted by hand is left alone.
//   5. boardProps is merged per-item on both save paths. Without that, a
//      player nudging a token on board.html writes its whole local boardProps
//      array over the DM's, and scenery placed seconds earlier disappears.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS — ' + label); return; }
  failures++;
  console.error('FAIL — ' + label + (detail ? '\n        ' + detail : ''));
}

/* ── a canvas/DOM stub thin enough to run the real engine against ──
   Every context method is accepted and recorded, so a draw() that calls
   something unexpected still runs and still gets counted. */
function makeCtx(calls) {
  return new Proxy({}, {
    get(target, key) {
      if (key === 'measureText') return () => ({ width: 8 });
      if (key in target) return target[key];
      return (...args) => { calls.push([key, args]); };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function makeCanvas(calls) {
  return {
    width: 0, height: 0, style: {}, dataset: {},
    getContext: () => makeCtx(calls),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1600 }),
    addEventListener() {}, offsetParent: {},
  };
}

function makeEl() {
  return {
    style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', checked: true,
    clientWidth: 900, clientHeight: 620, scrollLeft: 0, scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelectorAll: () => [], appendChild() {}, focus() {},
  };
}

function boot({ autoTerrain = true } = {}) {
  const calls = [];
  const els = new Map();
  const canvas = makeCanvas(calls);
  els.set('board-canvas', canvas);
  for (const id of ['board-grid-wrap', 'board-tray-list', 'board-hint', 'board-distance-label',
                    'board-range-input', 'board-zoom-label', 'board-map-select', 'board-map-note',
                    'board-props-list', 'board-prop-filter', 'board-prop-actions', 'board-prop-name']) {
    els.set(id, makeEl());
  }
  const autoEl = makeEl();
  autoEl.checked = autoTerrain;
  els.set('board-autoterrain', autoEl);

  // A promptable, storable sandbox: labels ask for their text, and the DM's
  // own saved maps live in localStorage.
  let promptReply = '';
  const store = new Map();

  const sandbox = {
    prompt: () => promptReply,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: {
      getElementById: (id) => els.get(id) || null,
      createElement: () => makeCanvas(calls),
      querySelectorAll: () => [],
      addEventListener() {},
      activeElement: null,
      body: {},
    },
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    },
    getComputedStyle: () => ({
      getPropertyValue: () => 'dark',
      paddingLeft: '16px', paddingRight: '16px', paddingTop: '16px', paddingBottom: '16px',
    }),
    requestAnimationFrame: (fn) => fn(),
    confirm: () => true,
    alert() {},
    console,
  };

  const factory = new Function('sandbox', `
    const { document, window, getComputedStyle, requestAnimationFrame, confirm, alert, console,
            prompt, localStorage } = sandbox;
    let _saves = 0;
    function encSave() { _saves++; }
    ${read('CLASS-1A/board-prefabs.js')}
    ${read('CLASS-1A/board-shared.js')}
    // Declared after the engine, exactly as the pages do it (encounter.js and
    // board.js both load last), and defaulted through the same registry — so
    // a layer added to BOARD_LAYERS is present here without this stub having
    // to be told about it.
    let encounter = boardEnsureLayers({ round: 1, currentIndex: 0, combatants: [], attackLog: [] });
    return {
      get encounter() { return encounter; },
      get saves() { return _saves; },
      get boardState() { return boardState; },
      BOARD_PREFABS, BOARD_PREFABS_BY_KEY, BOARD_MAPS, BOARD_MAPS_BY_KEY,
      BOARD_COLS, BOARD_ROWS, TERRAIN_STYLES,
      boardPlaceProp, boardRemoveProp, boardMoveProp, boardRotateSelectedProp,
      boardSelectProp, boardPropAt, boardPropFootprint, boardApplyPresetMap, boardGetArtLayer,
      boardEraseAt, boardClearArt, boardComputeBBox, boardCell,
      renderBoardCanvas, renderBoard, paintPropsLayer, boardPaintProp,
      boardSelectPrefab, boardCancelPropMode, boardHandleMouseDown,
      boardHandleMouseMove, boardHandleMouseUp, boardHandleCanvasClick,
      boardHandleCanvasRightClick, boardSelectTrayItem,
      BOARD_LAYERS, boardEnsureLayers, boardLayerMergePaths, BOARD_TERRAIN_TOOLS, BOARD_TOOL_HINTS,
      boardTemplateCells, boardTemplateAt, boardPlaceTemplate, boardClearTemplates,
      boardNoteAt, boardPlaceNote, boardElevLevel, boardPaintElevAt,
      paintTerrainLayer, paintFogLayer, paintNotesLayer, paintTemplatesLayer, paintElevLayer,
      boardSerializeCurrent, boardSaveCurrentMap, boardReadSavedMaps, boardMapByKey,
      boardPopulateMapSelect, boardSetTool, boardDrawStart,
      get boardPan() { return boardPan; },
      set canEdit(v) { boardCanEdit = v; },
      get canEdit() { return boardCanEdit; },
    };
  `);
  const api = factory(sandbox);
  api._setPrompt = (v) => { promptReply = v; };
  api._store = store;
  api._calls = calls;
  api._canvas = canvas;
  return api;
}

const B = boot();

/* ── 1. the catalog ── */
{
  const keys = B.BOARD_PREFABS.map(p => p.key);
  check('every prefab has a unique key', new Set(keys).size === keys.length,
    'duplicates: ' + keys.filter((k, i) => keys.indexOf(k) !== i).join(', '));

  const validTerrain = new Set([...Object.keys(B.TERRAIN_STYLES), 'clear']);
  const bad = B.BOARD_PREFABS.filter(p =>
    !p.key || !p.label || !p.cat || typeof p.draw !== 'function' ||
    !Number.isInteger(p.w) || !Number.isInteger(p.h) || p.w < 1 || p.h < 1 ||
    (p.terrain != null && !validTerrain.has(p.terrain)));
  check('every prefab is well formed (key/label/cat/size/draw/terrain)', bad.length === 0,
    bad.map(p => p.key || '(no key)').join(', '));

  // Rendering at a range of cell sizes: a draw() that divides by a zero-width
  // footprint or reaches for a context method that doesn't exist only shows up
  // once it's actually called.
  const broken = [];
  for (const pf of B.BOARD_PREFABS) {
    for (const SZ of [6, 16, 48]) {
      const calls = [];
      try {
        pf.draw(makeCtx(calls), 0, 0, pf.w * SZ, pf.h * SZ);
      } catch (e) {
        broken.push(`${pf.key} @${SZ}px: ${e.message}`);
        continue;
      }
      // A draw that paints nothing renders an invisible prop.
      if (!calls.some(([m]) => m === 'fill' || m === 'stroke' || m === 'fillRect' || m === 'fillText')) {
        broken.push(`${pf.key} @${SZ}px painted nothing`);
      }
    }
  }
  check('every prefab draws at 6px, 16px and 48px cells', broken.length === 0, broken.join('\n        '));
}

/* ── 2. the preset maps ── */
{
  const problems = [];
  for (const mp of B.BOARD_MAPS) {
    if (!mp.key || !mp.label || !mp.desc) problems.push(`${mp.key}: missing key/label/desc`);
    const built = mp.build();
    if (!built.terrain.length && !built.props.length) problems.push(`${mp.key}: builds an empty map`);
    for (const t of built.terrain) {
      if (!B.TERRAIN_STYLES[t.type]) { problems.push(`${mp.key}: unknown terrain "${t.type}"`); break; }
      const [c, r] = t.id.split(',').map(Number);
      if (!(c >= 0 && r >= 0 && c < mp.w && r < mp.h)) {
        problems.push(`${mp.key}: terrain ${t.id} outside its declared ${mp.w}x${mp.h}`);
        break;
      }
    }
    for (const p of built.props) {
      const pf = B.BOARD_PREFABS_BY_KEY[p.type];
      if (!pf) { problems.push(`${mp.key}: unknown prefab "${p.type}"`); break; }
      const fp = B.boardPropFootprint(p);
      if (p.col < 0 || p.row < 0 || p.col + fp.w > mp.w || p.row + fp.h > mp.h) {
        problems.push(`${mp.key}: ${p.type} at ${p.col},${p.row} hangs off its declared ${mp.w}x${mp.h}`);
        break;
      }
    }
  }
  check('there are preset maps to load', B.BOARD_MAPS.length >= 6, B.BOARD_MAPS.length + ' found');
  check('every preset map builds inside its own bounds with known prefabs and terrain',
    problems.length === 0, problems.join('\n        '));

  const keys = B.BOARD_MAPS.map(mp => mp.key);
  check('every preset map has a unique key', new Set(keys).size === keys.length,
    'duplicates: ' + keys.filter((k, i) => keys.indexOf(k) !== i).join(', '));

  // The big interior maps live or die on this one: a room walled in on all
  // four sides, or a doorway cut through only one layer of a two-thick wall,
  // looks completely fine in the builder and is obvious the moment a DM tries
  // to walk a token into it. Flood the non-wall squares — hazard and water
  // included, since a token can fall into those — and insist the whole map
  // comes out as a single region.
  const split = [];
  for (const mp of B.BOARD_MAPS) {
    const walls = new Set();
    for (const t of mp.build().terrain) if (t.type === 'wall') walls.add(t.id);
    const open = (c, r) => c >= 0 && r >= 0 && c < mp.w && r < mp.h && !walls.has(c + ',' + r);
    const seen = new Set();
    const regions = [];
    for (let r0 = 0; r0 < mp.h; r0++) for (let c0 = 0; c0 < mp.w; c0++) {
      if (!open(c0, r0) || seen.has(c0 + ',' + r0)) continue;
      const stack = [[c0, r0]];
      seen.add(c0 + ',' + r0);
      let size = 0;
      while (stack.length) {
        const [c, r] = stack.pop();
        size++;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const id = (c + dc) + ',' + (r + dr);
          if (open(c + dc, r + dr) && !seen.has(id)) { seen.add(id); stack.push([c + dc, r + dr]); }
        }
      }
      regions.push(size + ' squares from ' + c0 + ',' + r0);
    }
    if (regions.length !== 1) split.push(`${mp.key}: ${regions.length} separate spaces — ${regions.join('; ')}`);
  }
  check('every preset map is one connected space — no sealed rooms, no door that opens into a wall',
    split.length === 0, split.join('\n        '));

  // The other half of that: a doorway that cuts no wall. Those are silent —
  // the map still works, the door just isn't a door, which is how two of
  // Gym Gamma's four gates sat one square outside their own wall ring. Build
  // each map a second time with the doorway prefab's terrain disabled, so
  // nothing gets cut, and every door must land on a wall in that version.
  const idle = [];
  const doorPf = B.BOARD_PREFABS_BY_KEY['door'];
  const doorTerrain = doorPf.terrain;
  try {
    for (const mp of B.BOARD_MAPS) {
      const placed = mp.build().props.filter(p => p.type === 'door');
      doorPf.terrain = null;
      const uncut = mp.build();
      doorPf.terrain = doorTerrain;
      const walls = new Set();
      for (const t of uncut.terrain) if (t.type === 'wall') walls.add(t.id);
      const nowhere = placed.filter(p => !walls.has(p.col + ',' + p.row))
                            .map(p => p.col + ',' + p.row);
      if (nowhere.length) idle.push(`${mp.key}: ${nowhere.length} at ${nowhere.join(' ')}`);
    }
  } finally {
    doorPf.terrain = doorTerrain;
  }
  check('every doorway on a preset map is cut through an actual wall',
    idle.length === 0, idle.join('\n        '));
}

/* ── 3. loading a map lands on the grid ── */
{
  const offGrid = [];
  for (const mp of B.BOARD_MAPS) {
    const env = boot();
    env.boardApplyPresetMap(mp);
    const enc = env.encounter;
    for (const t of enc.boardTerrain) {
      const [c, r] = t.id.split(',').map(Number);
      if (!(c >= 0 && r >= 0 && c < env.BOARD_COLS && r < env.BOARD_ROWS)) {
        offGrid.push(`${mp.key}: terrain ${t.id}`); break;
      }
    }
    for (const p of enc.boardProps) {
      const fp = env.boardPropFootprint(p);
      if (p.col < 0 || p.row < 0 || p.col + fp.w > env.BOARD_COLS || p.row + fp.h > env.BOARD_ROWS) {
        offGrid.push(`${mp.key}: ${p.type} at ${p.col},${p.row}`); break;
      }
    }
    const ids = enc.boardProps.map(p => p.id);
    if (new Set(ids).size !== ids.length) offGrid.push(`${mp.key}: duplicate prop ids`);
    if (!enc.boardProps.length) offGrid.push(`${mp.key}: loaded no props`);
  }
  check('every preset map loads fully inside the 100x100 grid, with unique prop ids',
    offGrid.length === 0, offGrid.join('\n        '));

  // A loaded map has to be somewhere Fit will actually look.
  const env = boot();
  env.boardApplyPresetMap(env.BOARD_MAPS_BY_KEY['city-street']);
  const bbox = env.boardComputeBBox();
  check('Fit frames a freshly loaded map instead of empty grid',
    bbox.maxC - bbox.minC > 20 && bbox.maxR - bbox.minR > 10,
    JSON.stringify(bbox));

  // And it has to render without throwing, which is the one thing a DM
  // notices instantly.
  let renderErr = null;
  try { env.renderBoardCanvas(); } catch (e) { renderErr = e.message; }
  check('a loaded map renders', renderErr === null, renderErr);
}

/* ── 4. auto-terrain is reversible ── */
{
  const env = boot({ autoTerrain: true });
  const enc = env.encounter;
  // A wall the DM painted by hand, next door to where the building goes.
  enc.boardTerrain.push({ id: '20,20', type: 'wall' });

  const b = env.boardPlaceProp('building', 11, 11); // 3x3, centred on 11,11 → 10,10
  const walls = () => enc.boardTerrain.filter(t => t.type === 'wall').map(t => t.id).sort();
  check('placing a building stamps a wall on each of its squares',
    walls().length === 10 && walls().includes('10,10') && walls().includes('12,12'),
    walls().join(' '));
  check('a multi-square prefab is centred on the square you clicked',
    b.col === 10 && b.row === 10, `${b.col},${b.row}`);
  check('the stamp is recorded on the prop so it can be undone', b.t === 1);

  env.boardMoveProp(b, 40, 40);
  check('moving it takes the old walls out and stamps new ones',
    !walls().includes('10,10') && walls().includes('42,42') && walls().length === 10,
    walls().join(' '));

  env.boardRemoveProp(b.id);
  check('removing it takes its walls back out', walls().length === 1, walls().join(' '));
  check('and leaves the wall the DM painted by hand alone',
    enc.boardTerrain.some(t => t.id === '20,20' && t.type === 'wall'));
  check('the prop itself is gone', enc.boardProps.length === 0);
}

{
  const env = boot({ autoTerrain: true });
  const enc = env.encounter;
  const van = env.boardPlaceProp('van', 50, 50); // 3x1 → 49,50
  const footprintIds = () => enc.boardTerrain.map(t => t.id).sort();
  check('a 3x1 prefab stamps three squares in a row',
    footprintIds().join(' ') === '49,50 50,50 51,50', footprintIds().join(' '));

  env.boardSelectProp(van.id);
  env.boardRotateSelectedProp();
  check('rotating swaps the footprint', JSON.stringify(env.boardPropFootprint(van)) === '{"w":1,"h":3}',
    JSON.stringify(env.boardPropFootprint(van)));
  check('and the terrain follows the rotation, with nothing left behind',
    footprintIds().length === 3 && footprintIds()[0].startsWith('49,'),
    footprintIds().join(' '));

  // The eraser has to lift the prop as well, or an invisible wall stays put.
  env.boardEraseAt({ x: van.col + 0.5, y: van.row + 0.5, col: van.col, row: van.row });
  check('the eraser lifts a prop and the terrain it stamped together',
    enc.boardProps.length === 0 && enc.boardTerrain.length === 0,
    `${enc.boardProps.length} props / ${enc.boardTerrain.length} terrain`);
}

{
  const env = boot({ autoTerrain: false });
  const enc = env.encounter;
  enc.boardTerrain.push({ id: '30,30', type: 'hazard' });
  const p = env.boardPlaceProp('building', 31, 31);
  check('with auto-terrain off, placing a prop marks no squares',
    enc.boardTerrain.length === 1 && !p.t, JSON.stringify(enc.boardTerrain));
  env.boardRemoveProp(p.id);
  check('and removing it leaves the terrain that was already there',
    enc.boardTerrain.length === 1 && enc.boardTerrain[0].type === 'hazard');
}

{
  // A doorway's whole job is cutting a hole in a wall.
  const env = boot({ autoTerrain: true });
  const enc = env.encounter;
  for (let c = 10; c < 15; c++) enc.boardTerrain.push({ id: c + ',10', type: 'wall' });
  env.boardPlaceProp('door', 12, 10);
  check('a doorway clears the wall it is placed on',
    enc.boardTerrain.length === 4 && !enc.boardTerrain.some(t => t.id === '12,10'),
    JSON.stringify(enc.boardTerrain.map(t => t.id)));
}

{
  // Clear Art is the one button that should take everything down.
  const env = boot();
  env.boardApplyPresetMap(env.BOARD_MAPS_BY_KEY['warehouse']);
  env.encounter.boardStrokes.push({ id: 's1', color: '#fff', width: 3, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
  env.boardClearArt();
  const enc = env.encounter;
  check('Clear Art removes props along with terrain and drawings',
    enc.boardProps.length === 0 && enc.boardTerrain.length === 0 && enc.boardStrokes.length === 0,
    `${enc.boardProps.length}/${enc.boardTerrain.length}/${enc.boardStrokes.length}`);
}

{
  // Hit-testing is what makes select/drag/erase land on the right thing.
  const env = boot();
  const house = env.boardPlaceProp('house', 60, 60);   // 2x2 → 60,60 (centred: 60-0=60)
  check('a prop is found anywhere inside its footprint',
    env.boardPropAt(house.col, house.row) === house &&
    env.boardPropAt(house.col + 1, house.row + 1) === house);
  check('and not outside it',
    env.boardPropAt(house.col + 2, house.row) === null &&
    env.boardPropAt(house.col, house.row - 1) === null);
  const crate = env.boardPlaceProp('crate', house.col + 1, house.row + 1);
  check('the most recently placed prop is the one you grab',
    env.boardPropAt(crate.col, crate.row) === crate);
}

/* ── 5. the gestures ──
   The handlers are where a prop feature actually lives or dies: stamping has
   to beat the token rules to the click, an unselected prop has to fall
   through to a pan, and a selected one has to drag. None of that is visible
   from the state functions above. */
{
  const env = boot();
  // boardCanvasCell maps client px -> cell through the canvas's own pixel
  // size; with the stub's 1600px rect and a 100-square grid this works out to
  // cell = clientX / (1600 / (100 * SZ)) — resolve it once and reuse.
  const SZ = env.boardCell();
  const canvasW = 100 * SZ;
  const at = (col, row) => ({
    clientX: (col + 0.5) * SZ * (1600 / canvasW),
    clientY: (row + 0.5) * SZ * (1600 / canvasW),
    button: 0, preventDefault() {},
  });
  // A browser fires click after the mouseup of *every* left-button gesture,
  // drags included — and boardHandleCanvasClick's `_wasDragging` guard is
  // built around exactly that. Leaving the trailing click out of a simulated
  // drag desynchronises the flag and makes the next click vanish, so every
  // helper here ends with one.
  const click = (col, row) => {
    env.boardHandleMouseDown(at(col, row));
    env.boardHandleMouseUp(at(col, row));
    env.boardHandleCanvasClick(at(col, row));
  };
  const endGesture = (col, row) => {
    env.boardHandleMouseUp(at(col, row));
    env.boardHandleCanvasClick(at(col, row));
  };

  env.boardSelectPrefab('tree');
  click(20, 20);
  click(21, 20);
  check('clicking the grid with a prefab armed stamps it',
    env.encounter.boardProps.length === 2, env.encounter.boardProps.length + ' placed');
  check('and the prefab stays armed, so a row of trees is one pick and N clicks',
    env.boardState.pendingProp === 'tree');

  check('Escape disarms the prefab before anything else', env.boardCancelPropMode() === true);
  check('and once nothing is armed it stops consuming the key',
    env.boardState.pendingProp === null && env.boardCancelPropMode() === false);

  // A unit in the tray has to win the next click, not the prefab.
  env.encounter.combatants.push({ id: 1, name: 'Deku', hp: 30, maxHp: 30, ac: 15, boardX: null, boardY: null });
  env.boardSelectPrefab('crate');
  env.boardSelectTrayItem(1);
  check('picking a unit from the tray puts an armed prefab down',
    env.boardState.pendingProp === null && env.boardState.pendingId === 1);
  click(30, 30);
  check('so the click places the unit, not scenery',
    env.encounter.combatants[0].boardX === 30 && env.encounter.boardProps.length === 2);

  // Select, then drag.
  const tree = env.boardPropAt(20, 20);
  click(20, 20);
  check('clicking a placed prop selects it', env.boardState.selectedPropId === tree.id);

  env.boardHandleMouseDown(at(20, 20));
  check('mousedown on the selected prop starts a drag, not a pan',
    env.boardState.draggingProp !== null && env.boardPan === null);
  env.boardHandleMouseMove(at(25, 24));
  endGesture(25, 24);
  check('and dragging moves it', tree.col === 25 && tree.row === 24, `${tree.col},${tree.row}`);
  check('the click ending a drag is swallowed, not read as a fresh selection',
    env.boardState.selectedPropId === tree.id);

  // An unselected prop must stay grabbable ground for panning — a loaded map
  // covers most of the view in props.
  const other = env.boardPropAt(21, 20);
  env.boardState.selectedPropId = null;
  env.boardHandleMouseDown(at(21, 20));
  check('mousedown on an unselected prop pans instead of dragging it',
    env.boardState.draggingProp === null && env.boardPan !== null);
  endGesture(21, 20);

  env.boardHandleCanvasRightClick({ ...at(21, 20), preventDefault() {} });
  check('right-click removes a prop',
    !env.encounter.boardProps.some(p => p.id === other.id), env.encounter.boardProps.length + ' left');

  // A unit standing on scenery still has to be movable onto the next square.
  env.encounter.combatants[0].boardX = 25; env.encounter.combatants[0].boardY = 23;
  env.boardState.selectedPropId = null;
  click(25, 23);                 // select the unit
  click(25, 24);                 // the square the tree is on
  check('a selected unit can still be moved onto a square a prop occupies',
    env.encounter.combatants[0].boardX === 25 && env.encounter.combatants[0].boardY === 24,
    `${env.encounter.combatants[0].boardX},${env.encounter.combatants[0].boardY}`);
}

/* ── 6. the save paths ── */
{
  // One registry (BOARD_LAYERS) is what makes adding a layer a one-line
  // change instead of six copies of the same three lines across two files.
  // These check the registry is honoured rather than that any one field is
  // named — the field-by-field version of this test was the thing that kept
  // having to be updated.
  check('every board layer gets a per-item merge path',
    JSON.stringify(B.boardLayerMergePaths())
      === JSON.stringify(B.BOARD_LAYERS.map(path => ({ path, idKey: 'id' }))),
    JSON.stringify(B.boardLayerMergePaths()));
  check('the registry covers the layers that existed before it',
    ['boardStrokes', 'boardTerrain', 'boardProps'].every(k => B.BOARD_LAYERS.includes(k)),
    B.BOARD_LAYERS.join(' '));

  const bare = B.boardEnsureLayers({});
  check('boardEnsureLayers defaults every layer to an array',
    B.BOARD_LAYERS.every(k => Array.isArray(bare[k])), JSON.stringify(bare));
  const alreadyThere = [{ id: 'x' }];
  check('and leaves a layer that already has data alone',
    B.boardEnsureLayers({ boardProps: alreadyThere }).boardProps === alreadyThere);
  check('and replaces a layer a stale document stored as something other than an array',
    Array.isArray(B.boardEnsureLayers({ boardTerrain: null }).boardTerrain));

  for (const file of ['CLASS-1A/encounter.js', 'CLASS-1A/board.js']) {
    const src = read(file);
    check(`${file} spreads the layer merge paths into fsMergeSave`,
      /\.\.\.boardLayerMergePaths\(\)/.test(src));
    // Four: the initial declaration, the Firestore load, the local-cache
    // fallback and the remote-update path. Miss one and a document written
    // before a layer existed arrives with that field undefined.
    check(`${file} defaults the layers everywhere state arrives`,
      (src.match(/boardEnsureLayers\(/g) || []).length >= 4,
      (src.match(/boardEnsureLayers\(/g) || []).length + ' calls');
    check(`${file} no longer defaults board fields one at a time`,
      !/encounter\.board\w+ = encounter\.board\w+ \|\| \[\]/.test(src));
  }
  // Both pages have to load the catalog or props render as "?" tiles.
  for (const page of ['CLASS-1A/encounter.html', 'CLASS-1A/board.html']) {
    const src = read(page);
    const iProps = src.indexOf('board-prefabs.js');
    const iShared = src.indexOf('board-shared.js');
    check(`${page} loads board-prefabs.js`, iProps !== -1);
    check(`${page} loads it before the engine`, iProps !== -1 && iProps < iShared);
  }
}

/* ── 7. the layers that aren't terrain or scenery ──
   Fog, labels, area shapes and elevation. These are what a DM actually
   touches mid-session, and all four are invisible to every check above. */
{
  const env = boot();
  const cells = (t) => [...env.boardTemplateCells(t)].sort();

  check('every terrain brush names a real terrain style, and every style has a brush',
    JSON.stringify([...env.BOARD_TERRAIN_TOOLS].sort()) === JSON.stringify(Object.keys(env.TERRAIN_STYLES).sort()),
    env.BOARD_TERRAIN_TOOLS.join(' ') + '  vs  ' + Object.keys(env.TERRAIN_STYLES).join(' '));

  check('a burst covers every square within its radius',
    cells({ kind: 'burst', col: 10, row: 10, size: 1 }).length === 9,
    cells({ kind: 'burst', col: 10, row: 10, size: 1 }).join(' '));
  check('a line runs its length along its facing',
    cells({ kind: 'line', col: 10, row: 10, size: 3, rot: 0 }).join(' ') === '10,10 11,10 12,10',
    cells({ kind: 'line', col: 10, row: 10, size: 3, rot: 0 }).join(' '));
  check('and turns with it',
    cells({ kind: 'line', col: 10, row: 10, size: 3, rot: 90 }).join(' ') === '10,10 10,11 10,12',
    cells({ kind: 'line', col: 10, row: 10, size: 3, rot: 90 }).join(' '));
  check('a cone widens one square either side for every square of length',
    cells({ kind: 'cone', col: 10, row: 10, size: 3, rot: 0 }).length === 1 + 3 + 5,
    cells({ kind: 'cone', col: 10, row: 10, size: 3, rot: 0 }).join(' '));
  check('a shape hanging off the edge of the grid keeps only the squares on it',
    cells({ kind: 'burst', col: 0, row: 0, size: 2 }).length === 9,
    cells({ kind: 'burst', col: 0, row: 0, size: 2 }).join(' '));

  env.boardPlaceTemplate(20, 20);
  check('clicking the grid drops an area shape', env.encounter.boardTemplates.length === 1);
  env.boardPlaceTemplate(20, 21);
  check('and clicking inside one takes it away instead of stacking another on it',
    env.encounter.boardTemplates.length === 0);
}

{
  const env = boot();
  env._setPrompt('EXIT');
  env.boardPlaceNote(5, 5);
  check('a label is placed with the text you type',
    env.encounter.boardNotes.length === 1 && env.encounter.boardNotes[0].text === 'EXIT',
    JSON.stringify(env.encounter.boardNotes));
  env._setPrompt('FIRE EXIT');
  env.boardPlaceNote(5, 5);
  check('clicking the same square edits that label instead of adding a second',
    env.encounter.boardNotes.length === 1 && env.encounter.boardNotes[0].text === 'FIRE EXIT',
    JSON.stringify(env.encounter.boardNotes));
  env._setPrompt('   ');
  env.boardPlaceNote(5, 5);
  check('and clearing the text removes it', env.encounter.boardNotes.length === 0);

  // 'note' and 'template' are tools that aren't terrain brushes. Before the
  // dispatch knew the difference, boardDrawStart's else branch would have
  // painted a terrain type literally called "note" onto the square.
  const env2 = boot();
  env2.boardSetTool('note');
  env2._setPrompt('');
  env2.boardDrawStart({ clientX: 100, clientY: 100, button: 0, preventDefault() {} });
  check('a tool that is not a terrain brush paints no terrain',
    env2.encounter.boardTerrain.length === 0, JSON.stringify(env2.encounter.boardTerrain));

  // And the two that do have their own behaviour have to actually reach it
  // through the same gesture the DM makes, not just when called directly.
  const env3 = boot();
  const press = (col, row) => {
    const SZ = env3.boardCell();
    const scale = 1600 / (100 * SZ);
    env3.boardDrawStart({ clientX: (col + 0.5) * SZ * scale, clientY: (row + 0.5) * SZ * scale,
                          button: 0, preventDefault() {} });
  };
  env3.boardSetTool('elev');
  press(30, 30);
  check('the elevation tool marks the square it was clicked on',
    env3.encounter.boardElev.length === 1, JSON.stringify(env3.encounter.boardElev));
  env3.boardSetTool('template');
  press(60, 60);
  check('the area tool drops a shape on the square it was clicked on',
    env3.encounter.boardTemplates.length === 1, JSON.stringify(env3.encounter.boardTemplates));
  env3.boardSetTool('fog');
  press(70, 70);
  check('and the fog brush paints fog, which is terrain like any other',
    env3.encounter.boardTerrain.some(t => t.type === 'fog'),
    JSON.stringify(env3.encounter.boardTerrain));
}

{
  const env = boot();
  env.boardPaintElevAt({ col: 7, row: 7 }, 2);
  check('elevation marks a square', env.boardElevLevel(7, 7) === 2);
  env.boardPaintElevAt({ col: 7, row: 7 }, 0);
  check('and zero takes the mark off rather than storing a zero',
    env.boardElevLevel(7, 7) === 0 && env.encounter.boardElev.length === 0,
    JSON.stringify(env.encounter.boardElev));
  env.boardPaintElevAt({ col: 101, row: 7 }, 1);
  check('elevation painted off the grid is ignored', env.encounter.boardElev.length === 0);

  // Same for the two tools that place a single thing per click: a label or a
  // shape anchored off the grid is saved where nobody can ever click it again.
  env._setPrompt('OFF');
  env.boardPlaceNote(101, 5);
  env.boardPlaceNote(5, -1);
  env.boardPlaceTemplate(-2, 5);
  check('labels and area shapes anchored off the grid are ignored too',
    env.encounter.boardNotes.length === 0 && env.encounter.boardTemplates.length === 0,
    `${env.encounter.boardNotes.length} labels / ${env.encounter.boardTemplates.length} shapes`);
}

{
  // One square, four kinds of mark on it, one eraser.
  const env = boot();
  env._setPrompt('ALARM');
  env.boardPlaceNote(9, 9);
  env.boardPaintElevAt({ col: 9, row: 9 }, 1);
  env.boardPlaceTemplate(9, 9);
  env.encounter.boardTerrain.push({ id: '9,9', type: 'fog' });
  env.boardEraseAt({ x: 9.5, y: 9.5, col: 9, row: 9 });
  check('the eraser lifts the label, the elevation, the area shape and the fog together',
    !env.encounter.boardNotes.length && !env.encounter.boardElev.length
    && !env.encounter.boardTemplates.length && !env.encounter.boardTerrain.length,
    `${env.encounter.boardNotes.length}/${env.encounter.boardElev.length}/${env.encounter.boardTemplates.length}/${env.encounter.boardTerrain.length}`);
}

{
  const env = boot();
  env._setPrompt('ROOF');
  env.boardPlaceNote(3, 3);
  env.boardPaintElevAt({ col: 3, row: 3 }, 1);
  env.boardPlaceTemplate(12, 12);
  env.boardPlaceProp('crate', 15, 15);
  env.encounter.boardTerrain.push({ id: '1,1', type: 'wall' });
  env.encounter.boardStrokes.push({ id: 's', color: '#fff', width: 3, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] });
  check('every layer has something on it before Clear Art',
    env.BOARD_LAYERS.every(k => env.encounter[k].length > 0),
    env.BOARD_LAYERS.filter(k => !env.encounter[k].length).join(' ') + ' empty');
  env.boardClearArt();
  check('Clear Art empties every layer, not just the three it used to name',
    env.BOARD_LAYERS.every(k => env.encounter[k].length === 0),
    env.BOARD_LAYERS.filter(k => env.encounter[k].length).join(' ') + ' left');
}

{
  /* Fog is the one layer where the two boards must disagree, so it is the one
     worth proving: the DM's veil must not render on a board that can't edit,
     and that board must get an opaque pass of its own after the tokens. */
  const env = boot();
  env.encounter.boardTerrain.push({ id: '12,12', type: 'fog' });
  const dmCalls = [];
  env.paintTerrainLayer(makeCtx(dmCalls), 20, env.encounter.boardTerrain);
  check('the DM sees fog painted in with the rest of the terrain',
    dmCalls.some(([m]) => m === 'fillRect'));

  env.canEdit = false;
  const playerCalls = [];
  env.paintTerrainLayer(makeCtx(playerCalls), 20, env.encounter.boardTerrain);
  check('a board that cannot edit gets no see-through veil in the terrain layer',
    !playerCalls.some(([m]) => m === 'fillRect'),
    playerCalls.map(c => c[0]).join(' '));
  const fogCalls = [];
  env.paintFogLayer(makeCtx(fogCalls), 20, true);
  check('it gets an opaque one of its own instead',
    fogCalls.some(([m]) => m === 'fillRect'));

  // board.html opens with edit rights true and flips them when the admin
  // check resolves. A layer baked before that must not be reused after.
  const env2 = boot();
  env2.encounter.boardTerrain.push({ id: '5,5', type: 'fog' });
  const before = env2.boardGetArtLayer(200, 200, 20);
  env2.canEdit = false;
  check('flipping edit rights rebuilds the cached art layer',
    env2.boardGetArtLayer(200, 200, 20) !== before);
}

{
  // Every tool needs a button, and the two tools with settings need the
  // controls those settings are read from: boardTemplateOptions and
  // boardElevOption both fall back to a default when their input is missing,
  // so a mistyped id degrades silently into "always a burst of 2" rather
  // than failing where anyone would notice.
  const page = read('CLASS-1A/encounter.html');
  const noButton = Object.keys(B.BOARD_TOOL_HINTS).filter(t => !page.includes(`data-tool="${t}"`));
  check('every board tool has a button on the DM page', noButton.length === 0, noButton.join(', '));
  const controls = ['board-template-kind', 'board-template-size', 'board-template-rot', 'board-elev-level'];
  const missing = controls.filter(id => !page.includes(`id="${id}"`));
  check('the area-shape and elevation controls the engine reads are on the page',
    missing.length === 0, missing.join(', '));
  check('the players\' board has no tool buttons at all', !read('CLASS-1A/board.html').includes('data-tool='));
}

/* ── 8. the DM's own saved maps ── */
{
  const env = boot();
  env.boardPlaceProp('crate', 40, 40);
  env.encounter.boardTerrain.push({ id: '41,41', type: 'wall' });
  env._setPrompt('My alley');
  env.boardSaveCurrentMap();
  const saved = env.boardReadSavedMaps()['My alley'];
  check('saving the board stores it normalised to its own top-left corner',
    saved && saved.w === 2 && saved.h === 2
    && saved.props.length === 1 && saved.props[0].col === 0 && saved.props[0].row === 0,
    JSON.stringify(saved));
  check('and it resolves out of the picker like a preset',
    env.boardMapByKey('saved:My alley') !== null);
  check('while a name nobody saved resolves to nothing',
    env.boardMapByKey('saved:not a map') === null);

  const env2 = boot();
  env2.encounter.boardTerrain.push({ id: '50,50', type: 'wall' });
  env2.encounter.boardNotes.push({ id: 'n1', col: 51, row: 50, text: 'DOOR' });
  env2.encounter.boardElev.push({ id: '52,50', level: 2 });
  env2._setPrompt('Round trip');
  env2.boardSaveCurrentMap();
  env2.boardApplyPresetMap(env2.boardMapByKey('saved:Round trip'));
  const wall = env2.encounter.boardTerrain.find(t => t.type === 'wall');
  const wc = wall ? +wall.id.split(',')[0] : null;
  const note = env2.encounter.boardNotes[0];
  const elev = env2.encounter.boardElev[0];
  check('loading a saved map brings back its labels and elevation',
    env2.encounter.boardNotes.length === 1 && note.text === 'DOOR'
    && env2.encounter.boardElev.length === 1 && elev.level === 2,
    JSON.stringify({ notes: env2.encounter.boardNotes, elev: env2.encounter.boardElev }));
  check('with the geometry between them intact',
    wc !== null && note.col === wc + 1 && +elev.id.split(',')[0] === wc + 2,
    `wall ${wall && wall.id}, label ${note && note.col}, elev ${elev && elev.id}`);

  // A preset has no labels or elevation of its own, so loading one has to
  // take the old map's away rather than leave them floating over the new one.
  const env3 = boot();
  env3._setPrompt('STALE');
  env3.boardPlaceNote(1, 1);
  env3.boardPaintElevAt({ col: 1, row: 1 }, 1);
  env3.boardPlaceTemplate(5, 5);
  env3.boardApplyPresetMap(env3.BOARD_MAPS_BY_KEY['warehouse']);
  check('loading a preset clears the labels, elevation and shapes from the last map',
    !env3.encounter.boardNotes.length && !env3.encounter.boardElev.length
    && !env3.encounter.boardTemplates.length,
    `${env3.encounter.boardNotes.length}/${env3.encounter.boardElev.length}/${env3.encounter.boardTemplates.length}`);
}

/* ── 9. the campaign's encounter groups ──
   CAMPAIGN/enemies.json's groups each name a line-up and the preset map it
   was written for. Both halves of that can rot without anything complaining:
   a retired stat block makes a group quietly add fewer units than it says,
   and a renamed map key leaves the picker sitting on whatever was selected
   before, which is the sort of thing a DM discovers at the table. */
{
  const data = JSON.parse(read('CAMPAIGN/enemies.json'));
  const groups = data.groups || [];
  const enemyIds = new Set((data.enemies || []).map(e => e.id));
  const categories = new Set(data.categories || []);

  check('the campaign file carries encounter groups', groups.length >= 6, groups.length + ' found');

  const ids = groups.map(g => g.id);
  check('every group has a unique id', new Set(ids).size === ids.length,
    ids.filter((k, i) => ids.indexOf(k) !== i).join(', '));

  const malformed = groups.filter(g =>
    !g.id || !g.name || !g.note || !Array.isArray(g.members) || !g.members.length);
  check('every group has an id, a name, a note and members',
    malformed.length === 0, malformed.map(g => g.id || '(no id)').join(', '));

  const strayCat = groups.filter(g => !categories.has(g.category));
  check('every group sits in one of the file\'s own categories',
    strayCat.length === 0, strayCat.map(g => `${g.id} → ${g.category}`).join(', '));

  const missingMembers = [];
  for (const g of groups) {
    for (const m of g.members || []) {
      if (!enemyIds.has(m.id)) missingMembers.push(`${g.id} → ${m.id}`);
      else if (m.count != null && (!Number.isInteger(m.count) || m.count < 1 || m.count > 20)) {
        missingMembers.push(`${g.id} → ${m.id} count ${m.count}`);
      }
    }
  }
  check('every group member is a stat block that exists, in a sane quantity',
    missingMembers.length === 0, missingMembers.join('\n        '));

  const missingMaps = groups.filter(g => g.map && !B.BOARD_MAPS_BY_KEY[g.map])
                            .map(g => `${g.id} → ${g.map}`);
  check('every group\'s suggested map is a preset that still exists',
    missingMaps.length === 0, missingMaps.join(', '));

  // The picker is built from the file, and encAddGroup is what reads it.
  const encSrc = read('CLASS-1A/encounter.js');
  check('encounter.js loads the groups and builds their picker',
    /ENEMY_GROUPS = ed\.groups/.test(encSrc) && /buildGroupSelect\(\)/.test(encSrc));
  check('and the DM page has somewhere to pick one',
    read('CLASS-1A/encounter.html').includes('id="enc-group-select"'));
}

console.log(failures ? `\n>>> board props FAILED (${failures})` : '\n>>> board props OK');
process.exit(failures ? 1 : 0);
