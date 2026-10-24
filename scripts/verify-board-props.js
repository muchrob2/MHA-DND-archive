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

  const sandbox = {
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
    const { document, window, getComputedStyle, requestAnimationFrame, confirm, alert, console } = sandbox;
    let _saves = 0;
    let encounter = { round: 1, currentIndex: 0, combatants: [], attackLog: [],
                      boardStrokes: [], boardTerrain: [], boardProps: [] };
    function encSave() { _saves++; }
    ${read('CLASS-1A/board-prefabs.js')}
    ${read('CLASS-1A/board-shared.js')}
    return {
      get encounter() { return encounter; },
      get saves() { return _saves; },
      get boardState() { return boardState; },
      BOARD_PREFABS, BOARD_PREFABS_BY_KEY, BOARD_MAPS, BOARD_MAPS_BY_KEY,
      BOARD_COLS, BOARD_ROWS, TERRAIN_STYLES,
      boardPlaceProp, boardRemoveProp, boardMoveProp, boardRotateSelectedProp,
      boardSelectProp, boardPropAt, boardPropFootprint, boardApplyPresetMap,
      boardEraseAt, boardClearArt, boardComputeBBox, boardCell,
      renderBoardCanvas, renderBoard, paintPropsLayer, boardPaintProp,
      boardSelectPrefab, boardCancelPropMode, boardHandleMouseDown,
      boardHandleMouseMove, boardHandleMouseUp, boardHandleCanvasClick,
      boardHandleCanvasRightClick, boardSelectTrayItem,
      get boardPan() { return boardPan; },
    };
  `);
  const api = factory(sandbox);
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
  for (const file of ['CLASS-1A/encounter.js', 'CLASS-1A/board.js']) {
    const src = read(file);
    check(`${file} merges boardProps per item`,
      /\{\s*path:\s*'boardProps',\s*idKey:\s*'id'\s*\}/.test(src));
    check(`${file} defaults boardProps to an array everywhere state arrives`,
      (src.match(/encounter\.boardProps = encounter\.boardProps \|\| \[\]/g) || []).length >= 3,
      (src.match(/encounter\.boardProps = encounter\.boardProps \|\| \[\]/g) || []).length + ' guards');
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

console.log(failures ? `\n>>> board props FAILED (${failures})` : '\n>>> board props OK');
process.exit(failures ? 1 : 0);
