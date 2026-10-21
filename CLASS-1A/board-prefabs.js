/* Prop prefabs and preset maps for the tactical board.

   Split out of board-shared.js — that file is the grid/token/drag engine and
   was already 1100 lines; this is pure content (what a car looks like, what
   squares a city street occupies) with no interaction logic in it. Loaded by
   both encounter.html (DM — places props, loads maps) and board.html
   (players — needs the draw functions to render what the DM placed, and
   simply never shows the palette or the map picker).

   Everything is drawn with canvas paths rather than images: the board is a
   static-file site with no asset pipeline, and vector shapes stay crisp at
   every zoom step while an icon sprite would not.

   PROP DATA MODEL — encounter.boardProps holds
       { id, type, col, row, rot }
   and nothing else. Footprint (w/h) is read back out of BOARD_PREFABS at
   render time instead of being stored, so retuning a prefab's size here
   updates props already on the board. `rot` is 0/90/180/270; 90 and 270 swap
   the footprint. An unknown `type` (a prefab renamed out from under saved
   data) falls back to a 1x1 "?" tile rather than throwing mid-render.
*/

const PF_INK = 'rgba(6,8,14,0.78)';

/* ── tiny drawing helpers ─────────────────────────────────
   All draw() functions below get pixel-space (x, y, w, h) for the prop's
   footprint and size every feature as a fraction of it, so one definition
   renders correctly at any cell size — the 34px palette chip included. */
function pfInkW(px) { return Math.max(0.7, px * 0.035); }

function pfRect(ctx, x, y, w, h, fill, radius, lw) {
  ctx.beginPath();
  if (radius > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
  else ctx.rect(x, y, w, h);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (lw)   { ctx.strokeStyle = PF_INK; ctx.lineWidth = lw; ctx.stroke(); }
}

function pfCircle(ctx, cx, cy, r, fill, lw) {
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0.4, r), 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (lw)   { ctx.strokeStyle = PF_INK; ctx.lineWidth = lw; ctx.stroke(); }
}

function pfPoly(ctx, pts, fill, lw) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (lw)   { ctx.strokeStyle = PF_INK; ctx.lineWidth = lw; ctx.stroke(); }
}

function pfLines(ctx, segs, color, lw) {
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.beginPath();
  for (const s of segs) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
  ctx.stroke();
}

// Blob with a wobbly edge — canopies, bushes, rubble. Deterministic per
// prop so a tree doesn't shimmer differently on every repaint.
function pfBlob(ctx, cx, cy, r, lobes, jitter, fill, lw) {
  ctx.beginPath();
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const rr = r * (1 - (i % 2 ? jitter : 0));
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (lw)   { ctx.strokeStyle = PF_INK; ctx.lineWidth = lw; ctx.stroke(); }
}

// Wheels for the vehicle set — rot 0 always points right, so wheels sit on
// the long (horizontal) axis.
function pfWheels(ctx, x, y, w, h, count) {
  const wheelW = w * 0.09, wheelH = h * 0.16;
  for (let i = 0; i < count; i++) {
    const cx = x + w * (0.2 + (i / Math.max(1, count - 1)) * 0.6) - wheelW / 2;
    pfRect(ctx, cx, y - wheelH * 0.35, wheelW, wheelH, '#16181E', wheelW * 0.3, 0);
    pfRect(ctx, cx, y + h - wheelH * 0.65, wheelW, wheelH, '#16181E', wheelW * 0.3, 0);
  }
}

/* ── the catalog ──────────────────────────────────────────
   cat      — palette grouping
   w / h    — footprint in squares at rot 0
   terrain  — what the square(s) under it become when "Auto-terrain" is on:
              a TERRAIN_STYLES key, 'clear' to wipe terrain (doors, bridges —
              a doorway's whole point is that the wall isn't there), or null
              to leave the squares alone.
   note     — the table ruling the prop implies, shown on the chip tooltip. */
const BOARD_PREFABS = [
  /* ── Structures ── */
  {
    key: 'building', label: 'Building', cat: 'Structures', w: 3, h: 3,
    terrain: 'wall', note: 'Impassable, blocks line of sight',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x, y, w, h, '#7E8794', Math.min(w, h) * 0.04, lw * 1.5);
      pfRect(ctx, x + w * 0.11, y + h * 0.11, w * 0.78, h * 0.78, '#6A7381', 0, lw * 0.7);
      pfRect(ctx, x + w * 0.60, y + h * 0.60, w * 0.26, h * 0.26, '#535B68', 0, lw * 0.7);
      pfLines(ctx, [
        [x + w * 0.11, y + h * 0.44, x + w * 0.89, y + h * 0.44],
        [x + w * 0.44, y + h * 0.11, x + w * 0.44, y + h * 0.89],
      ], 'rgba(255,255,255,0.10)', lw * 0.8);
    },
  },
  {
    key: 'highrise', label: 'High-rise', cat: 'Structures', w: 2, h: 2,
    terrain: 'wall', note: 'Impassable, blocks line of sight',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x, y, w, h, '#5C6472', Math.min(w, h) * 0.04, lw * 1.5);
      pfRect(ctx, x + w * 0.14, y + h * 0.14, w * 0.72, h * 0.72, '#4A5260', 0, lw * 0.7);
      pfRect(ctx, x + w * 0.26, y + h * 0.26, w * 0.48, h * 0.48, '#3C4350', 0, lw * 0.6);
      pfCircle(ctx, x + w / 2, y + h / 2, Math.min(w, h) * 0.13, null, lw);
      ctx.strokeStyle = 'rgba(232,160,32,0.55)'; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x + w / 2 - w * 0.07, y + h / 2); ctx.lineTo(x + w / 2 + w * 0.07, y + h / 2);
      ctx.stroke();
    },
  },
  {
    key: 'house', label: 'House', cat: 'Structures', w: 2, h: 2,
    terrain: 'wall', note: 'Impassable, blocks line of sight',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x, y, w, h, '#8D6A4E', Math.min(w, h) * 0.04, lw * 1.5);
      // hip roof read top-down: four slopes meeting at a ridge
      pfPoly(ctx, [[x, y], [x + w, y], [x + w * 0.66, y + h * 0.5], [x + w * 0.34, y + h * 0.5]], '#9C7757', lw * 0.7);
      pfPoly(ctx, [[x, y + h], [x + w, y + h], [x + w * 0.66, y + h * 0.5], [x + w * 0.34, y + h * 0.5]], '#7E5D43', lw * 0.7);
      pfLines(ctx, [[x + w * 0.34, y + h * 0.5, x + w * 0.66, y + h * 0.5]], 'rgba(255,255,255,0.22)', lw);
      pfRect(ctx, x + w * 0.70, y + h * 0.12, w * 0.16, h * 0.16, '#4E5563', 0, lw * 0.6);
    },
  },
  {
    key: 'warehouse', label: 'Warehouse', cat: 'Structures', w: 4, h: 3,
    terrain: 'wall', note: 'Impassable, blocks line of sight',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x, y, w, h, '#6E7684', Math.min(w, h) * 0.03, lw * 1.5);
      const segs = [];
      for (let i = 1; i < 8; i++) segs.push([x + (w * i) / 8, y + h * 0.06, x + (w * i) / 8, y + h * 0.94]);
      pfLines(ctx, segs, 'rgba(0,0,0,0.20)', lw * 0.7);
      for (let i = 0; i < 3; i++) {
        pfRect(ctx, x + w * (0.18 + i * 0.26), y + h * 0.40, w * 0.14, h * 0.20, 'rgba(180,215,255,0.35)', 0, lw * 0.5);
      }
    },
  },
  {
    key: 'watertower', label: 'Water tower', cat: 'Structures', w: 2, h: 2,
    terrain: 'wall', note: 'Impassable; a classic rooftop landmark',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) * 0.40;
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        pfCircle(ctx, cx + dx * r * 0.95, cy + dy * r * 0.95, Math.min(w, h) * 0.07, '#3A414D', 0);
      }
      pfCircle(ctx, cx, cy, r, '#8A705A', lw * 1.4);
      pfCircle(ctx, cx, cy, r * 0.62, '#9C8067', 0);
      pfCircle(ctx, cx, cy, r * 0.18, '#4C4136', lw * 0.6);
    },
  },
  {
    key: 'acunit', label: 'AC unit', cat: 'Structures', w: 1, h: 1,
    terrain: null, note: 'Half cover if you crouch behind it',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.12, y + h * 0.14, w * 0.76, h * 0.72, '#99A1AE', w * 0.06, lw);
      pfCircle(ctx, x + w * 0.5, y + h * 0.5, Math.min(w, h) * 0.22, '#6B7481', lw * 0.7);
      pfLines(ctx, [
        [x + w * 0.34, y + h * 0.5, x + w * 0.66, y + h * 0.5],
        [x + w * 0.5, y + h * 0.34, x + w * 0.5, y + h * 0.66],
      ], 'rgba(255,255,255,0.45)', lw * 0.7);
    },
  },
  {
    key: 'door', label: 'Doorway', cat: 'Structures', w: 1, h: 1,
    terrain: 'clear', note: 'Clears the wall under it — a way through',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.06, y + h * 0.52, w * 0.88, h * 0.22, '#A98B63', 0, lw);
      // Swing arc, kept inside the square — a door drawn overhanging its own
      // cell paints over the wall squares either side of it.
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(x + w * 0.08, y + h * 0.63, w * 0.44, -Math.PI / 2, 0);
      ctx.stroke();
    },
  },
  {
    key: 'stairs', label: 'Stairs', cat: 'Structures', w: 2, h: 1,
    terrain: null, note: 'Changes elevation; costs movement to climb',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x, y + h * 0.10, w, h * 0.80, '#7A8290', 0, lw);
      const segs = [];
      for (let i = 1; i < 6; i++) segs.push([x + (w * i) / 6, y + h * 0.10, x + (w * i) / 6, y + h * 0.90]);
      pfLines(ctx, segs, 'rgba(0,0,0,0.35)', lw * 0.8);
      pfPoly(ctx, [[x + w * 0.80, y + h * 0.32], [x + w * 0.94, y + h * 0.5], [x + w * 0.80, y + h * 0.68]], 'rgba(232,160,32,0.8)', 0);
    },
  },
  {
    key: 'bridge', label: 'Bridge / plank', cat: 'Structures', w: 3, h: 1,
    terrain: 'clear', note: 'Crossable footing over water or a drop',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x, y + h * 0.14, w, h * 0.72, '#8A6A47', 0, lw);
      const segs = [];
      for (let i = 1; i < 7; i++) segs.push([x + (w * i) / 7, y + h * 0.14, x + (w * i) / 7, y + h * 0.86]);
      pfLines(ctx, segs, 'rgba(0,0,0,0.28)', lw * 0.7);
      pfLines(ctx, [
        [x, y + h * 0.14, x + w, y + h * 0.14],
        [x, y + h * 0.86, x + w, y + h * 0.86],
      ], 'rgba(255,255,255,0.35)', lw);
    },
  },

  /* ── Nature ── */
  {
    key: 'tree', label: 'Tree', cat: 'Nature', w: 1, h: 1,
    terrain: 'cover', note: 'Half cover; blocks sight through the square',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfBlob(ctx, cx, cy, s * 0.44, 14, 0.13, '#2F6B3A', lw);
      pfCircle(ctx, cx - s * 0.08, cy - s * 0.08, s * 0.18, 'rgba(120,200,130,0.35)', 0);
      pfCircle(ctx, cx, cy, s * 0.09, '#5A3C22', 0);
    },
  },
  {
    key: 'bigtree', label: 'Large tree', cat: 'Nature', w: 2, h: 2,
    terrain: 'cover', note: 'Half cover; blocks sight; climbable',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfBlob(ctx, cx, cy, s * 0.48, 13, 0.16, '#275C33', lw * 1.2);
      pfBlob(ctx, cx - s * 0.10, cy - s * 0.10, s * 0.28, 9, 0.2, '#356F42', 0);
      pfCircle(ctx, cx, cy, s * 0.10, '#4E3520', lw * 0.6);
    },
  },
  {
    key: 'bush', label: 'Bush', cat: 'Nature', w: 1, h: 1,
    terrain: 'difficult', note: 'Difficult terrain; light concealment',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      pfBlob(ctx, x + w * 0.40, y + h * 0.58, s * 0.28, 11, 0.20, '#3E7A46', lw * 0.8);
      pfBlob(ctx, x + w * 0.62, y + h * 0.44, s * 0.24, 11, 0.20, '#498A51', lw * 0.8);
      pfBlob(ctx, x + w * 0.54, y + h * 0.66, s * 0.18, 9, 0.22, '#54994F', lw * 0.6);
    },
  },
  {
    key: 'boulder', label: 'Boulder', cat: 'Nature', w: 1, h: 1,
    terrain: 'cover', note: 'Half cover; blocks sight',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfPoly(ctx, [
        [cx - s * 0.36, cy + s * 0.10], [cx - s * 0.22, cy - s * 0.30],
        [cx + s * 0.14, cy - s * 0.38], [cx + s * 0.38, cy - s * 0.02],
        [cx + s * 0.26, cy + s * 0.34], [cx - s * 0.18, cy + s * 0.36],
      ], '#8A8F98', lw);
      pfLines(ctx, [
        [cx - s * 0.10, cy - s * 0.30, cx + s * 0.02, cy + s * 0.20],
        [cx + s * 0.02, cy + s * 0.20, cx + s * 0.32, cy + s * 0.04],
      ], 'rgba(0,0,0,0.30)', lw * 0.8);
    },
  },
  {
    key: 'log', label: 'Fallen log', cat: 'Nature', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; low enough to climb over',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x, y + h * 0.24, w, h * 0.52, '#6E5030', h * 0.2, lw);
      pfCircle(ctx, x + w * 0.06, y + h * 0.5, h * 0.22, '#8A6A42', lw * 0.7);
      pfCircle(ctx, x + w * 0.06, y + h * 0.5, h * 0.10, '#6E5030', 0);
      pfLines(ctx, [[x + w * 0.2, y + h * 0.40, x + w * 0.92, y + h * 0.40]], 'rgba(255,255,255,0.18)', lw * 0.8);
    },
  },

  /* ── Vehicles (rot 0 points right) ── */
  {
    key: 'car', label: 'Car', cat: 'Vehicles', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; three-quarters behind the engine block',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfWheels(ctx, x, y, w, h, 2);
      pfRect(ctx, x + w * 0.02, y + h * 0.16, w * 0.96, h * 0.68, '#C2413C', h * 0.25, lw * 1.2);
      pfRect(ctx, x + w * 0.30, y + h * 0.24, w * 0.34, h * 0.52, 'rgba(190,225,255,0.55)', h * 0.12, lw * 0.7);
      pfRect(ctx, x + w * 0.66, y + h * 0.28, w * 0.10, h * 0.44, 'rgba(190,225,255,0.35)', 0, lw * 0.5);
      pfRect(ctx, x + w * 0.90, y + h * 0.28, w * 0.07, h * 0.16, '#FFE9A8', 0, 0);
      pfRect(ctx, x + w * 0.90, y + h * 0.56, w * 0.07, h * 0.16, '#FFE9A8', 0, 0);
    },
  },
  {
    key: 'van', label: 'Van', cat: 'Vehicles', w: 3, h: 1,
    terrain: 'cover', note: 'Half cover; full cover from directly behind',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfWheels(ctx, x, y, w, h, 2);
      pfRect(ctx, x + w * 0.02, y + h * 0.14, w * 0.96, h * 0.72, '#4B6EA8', h * 0.18, lw * 1.2);
      pfRect(ctx, x + w * 0.06, y + h * 0.22, w * 0.52, h * 0.56, '#3C5C90', 0, lw * 0.6);
      pfRect(ctx, x + w * 0.76, y + h * 0.22, w * 0.18, h * 0.56, 'rgba(190,225,255,0.5)', 0, lw * 0.6);
      pfRect(ctx, x + w * 0.95, y + h * 0.26, w * 0.04, h * 0.18, '#FFE9A8', 0, 0);
    },
  },
  {
    key: 'bus', label: 'Bus', cat: 'Vehicles', w: 4, h: 1,
    terrain: 'cover', note: 'Full cover; climb on top for high ground',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfWheels(ctx, x, y, w, h, 3);
      pfRect(ctx, x + w * 0.01, y + h * 0.12, w * 0.98, h * 0.76, '#D8B23A', h * 0.14, lw * 1.2);
      const segs = [];
      for (let i = 1; i < 8; i++) segs.push([x + (w * i) / 8, y + h * 0.12, x + (w * i) / 8, y + h * 0.88]);
      pfLines(ctx, segs, 'rgba(0,0,0,0.22)', lw * 0.6);
      pfRect(ctx, x + w * 0.04, y + h * 0.26, w * 0.88, h * 0.16, 'rgba(190,225,255,0.45)', 0, 0);
    },
  },
  {
    key: 'bike', label: 'Motorbike', cat: 'Vehicles', w: 1, h: 1,
    terrain: null, note: 'Ridable; no cover worth the name',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.12, y + h * 0.40, w * 0.18, h * 0.20, '#23262D', h * 0.07, lw * 0.6);  // rear wheel
      pfRect(ctx, x + w * 0.70, y + h * 0.40, w * 0.18, h * 0.20, '#23262D', h * 0.07, lw * 0.6);  // front wheel
      pfRect(ctx, x + w * 0.24, y + h * 0.44, w * 0.52, h * 0.12, '#3A4049', h * 0.05, 0);  // frame
      pfRect(ctx, x + w * 0.32, y + h * 0.36, w * 0.26, h * 0.28, '#B8402F', h * 0.06, lw * 0.7); // tank + seat
      pfRect(ctx, x + w * 0.64, y + h * 0.26, w * 0.06, h * 0.48, '#2E3238', 0, 0);         // handlebars
    },
  },

  /* ── Scatter ── */
  {
    key: 'crate', label: 'Crate', cat: 'Scatter', w: 1, h: 1,
    terrain: 'cover', note: 'Half cover; breakable',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.10, y + h * 0.10, w * 0.80, h * 0.80, '#A5793F', w * 0.04, lw * 1.2);
      pfLines(ctx, [
        [x + w * 0.10, y + h * 0.10, x + w * 0.90, y + h * 0.90],
        [x + w * 0.90, y + h * 0.10, x + w * 0.10, y + h * 0.90],
      ], 'rgba(0,0,0,0.30)', lw * 0.9);
    },
  },
  {
    key: 'barrel', label: 'Barrel', cat: 'Scatter', w: 1, h: 1,
    terrain: 'cover', note: 'Half cover; ask the DM what is in it',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      pfCircle(ctx, x + w / 2, y + h / 2, s * 0.36, '#3E7E6A', lw * 1.2);
      pfCircle(ctx, x + w / 2, y + h / 2, s * 0.22, '#2F6555', lw * 0.6);
      pfCircle(ctx, x + w / 2, y + h / 2, s * 0.07, '#8FD8C2', 0);
    },
  },
  {
    key: 'dumpster', label: 'Dumpster', cat: 'Scatter', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; climbable, hideable',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x + w * 0.04, y + h * 0.14, w * 0.92, h * 0.72, '#2F7150', h * 0.08, lw * 1.2);
      pfLines(ctx, [[x + w * 0.5, y + h * 0.14, x + w * 0.5, y + h * 0.86]], 'rgba(0,0,0,0.35)', lw);
      pfLines(ctx, [
        [x + w * 0.12, y + h * 0.30, x + w * 0.44, y + h * 0.30],
        [x + w * 0.56, y + h * 0.30, x + w * 0.88, y + h * 0.30],
      ], 'rgba(255,255,255,0.20)', lw * 0.8);
    },
  },
  {
    key: 'rubble', label: 'Rubble', cat: 'Scatter', w: 1, h: 1,
    terrain: 'difficult', note: 'Difficult terrain',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const chunks = [
        [0.30, 0.34, 0.17], [0.62, 0.30, 0.13], [0.44, 0.62, 0.15],
        [0.72, 0.66, 0.11], [0.22, 0.70, 0.10],
      ];
      for (const [fx, fy, fr] of chunks) {
        pfBlob(ctx, x + w * fx, y + h * fy, s * fr, 7, 0.18, '#8A8F98', lw * 0.7);
      }
    },
  },
  {
    key: 'crater', label: 'Crater', cat: 'Scatter', w: 2, h: 2,
    terrain: 'difficult', note: 'Difficult terrain; something big landed here',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfBlob(ctx, cx, cy, s * 0.50, 16, 0.08, 'rgba(96,78,60,0.8)', lw);
      pfBlob(ctx, cx, cy, s * 0.38, 14, 0.10, 'rgba(52,40,30,0.92)', 0);
      pfBlob(ctx, cx, cy, s * 0.20, 12, 0.14, 'rgba(18,14,11,0.95)', 0);
      const segs = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        segs.push([cx + Math.cos(a) * s * 0.44, cy + Math.sin(a) * s * 0.44,
                   cx + Math.cos(a) * s * 0.60, cy + Math.sin(a) * s * 0.60]);
      }
      pfLines(ctx, segs, 'rgba(40,30,24,0.6)', lw);
    },
  },
  {
    key: 'cone', label: 'Traffic cone', cat: 'Scatter', w: 1, h: 1,
    terrain: null, note: 'Decoration; no mechanical effect',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      pfCircle(ctx, x + w / 2, y + h / 2, s * 0.28, '#D9631F', lw);
      pfCircle(ctx, x + w / 2, y + h / 2, s * 0.17, '#F2F2F2', 0);
      pfCircle(ctx, x + w / 2, y + h / 2, s * 0.08, '#D9631F', 0);
    },
  },
  {
    key: 'barricade', label: 'Barricade', cat: 'Scatter', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; police line',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x, y + h * 0.34, w, h * 0.32, '#E6E6E6', 0, lw);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y + h * 0.34, w, h * 0.32); ctx.clip();
      ctx.fillStyle = '#C2413C';
      for (let i = 0; i < 8; i++) {
        pfPoly(ctx, [
          [x + (w * i) / 8, y + h * 0.66], [x + (w * (i + 0.5)) / 8, y + h * 0.66],
          [x + (w * (i + 1)) / 8, y + h * 0.34], [x + (w * (i + 0.5)) / 8, y + h * 0.34],
        ], '#C2413C', 0);
      }
      ctx.restore();
      pfLines(ctx, [[x + w * 0.1, y + h * 0.72, x + w * 0.1, y + h * 0.9],
                    [x + w * 0.9, y + h * 0.72, x + w * 0.9, y + h * 0.9]], PF_INK, lw);
    },
  },
  {
    key: 'streetlight', label: 'Street light', cat: 'Scatter', w: 1, h: 1,
    terrain: null, note: 'Lights a 20 ft radius; knock it over for a ramp',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      pfCircle(ctx, x + w * 0.60, y + h * 0.40, s * 0.34, 'rgba(255,225,150,0.20)', 0);
      pfLines(ctx, [[x + w * 0.26, y + h * 0.76, x + w * 0.60, y + h * 0.40]], '#2B313B', lw * 2.2);
      pfCircle(ctx, x + w * 0.26, y + h * 0.76, s * 0.12, '#4A515C', lw * 0.8);
      pfCircle(ctx, x + w * 0.60, y + h * 0.40, s * 0.13, '#FFE9A8', lw * 0.8);
    },
  },
  {
    key: 'vending', label: 'Vending machine', cat: 'Scatter', w: 1, h: 1,
    terrain: 'wall', note: 'Full cover; heavy, but a strong Quirk can throw it',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.16, y + h * 0.10, w * 0.68, h * 0.80, '#B8402F', w * 0.05, lw * 1.2);
      pfRect(ctx, x + w * 0.24, y + h * 0.18, w * 0.38, h * 0.64, 'rgba(190,225,255,0.45)', 0, lw * 0.6);
      pfLines(ctx, [
        [x + w * 0.24, y + h * 0.40, x + w * 0.62, y + h * 0.40],
        [x + w * 0.24, y + h * 0.60, x + w * 0.62, y + h * 0.60],
      ], 'rgba(0,0,0,0.25)', lw * 0.7);
      pfRect(ctx, x + w * 0.68, y + h * 0.22, w * 0.10, h * 0.20, '#2E3238', 0, 0);
    },
  },
  {
    key: 'fire', label: 'Fire', cat: 'Scatter', w: 1, h: 1,
    terrain: 'hazard', note: 'Hazard — damage on entry or ending a turn here',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2;
      // Licking outer flame: up the right side, over the tip, back down the
      // left with a kick-out, so it reads as fire rather than a diamond.
      pfPoly(ctx, [
        [cx - s * 0.06, y + h * 0.08], [cx + s * 0.14, y + h * 0.30],
        [cx + s * 0.12, y + h * 0.44], [cx + s * 0.30, y + h * 0.38],
        [cx + s * 0.32, y + h * 0.66], [cx + s * 0.16, y + h * 0.88],
        [cx - s * 0.16, y + h * 0.88], [cx - s * 0.32, y + h * 0.64],
        [cx - s * 0.24, y + h * 0.36], [cx - s * 0.12, y + h * 0.42],
      ], '#E0631A', lw * 0.8);
      pfPoly(ctx, [
        [cx - s * 0.02, y + h * 0.36], [cx + s * 0.16, y + h * 0.62],
        [cx + s * 0.06, y + h * 0.84], [cx - s * 0.10, y + h * 0.82],
        [cx - s * 0.16, y + h * 0.60],
      ], '#F5C33B', 0);
    },
  },
  {
    key: 'statue', label: 'Statue', cat: 'Scatter', w: 1, h: 1,
    terrain: 'cover', note: 'Half cover; blocks sight',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      pfRect(ctx, x + w * 0.16, y + h * 0.16, w * 0.68, h * 0.68, '#9AA0A8', w * 0.04, lw);
      pfCircle(ctx, x + w * 0.5, y + h * 0.5, s * 0.20, '#C3C8CF', lw * 0.7);
      pfCircle(ctx, x + w * 0.5, y + h * 0.5, s * 0.08, '#7C838C', 0);
    },
  },
];

const BOARD_PREFABS_BY_KEY = Object.fromEntries(BOARD_PREFABS.map(p => [p.key, p]));
const BOARD_PREFAB_CATS = ['Structures', 'Nature', 'Vehicles', 'Scatter'];

/* ── Preset maps ──────────────────────────────────────────
   Each map is a *builder* rather than a literal list of squares: a city
   street is ~700 terrain cells and hand-listing them would make this file
   unreadable and unmaintainable. Builders run at load-a-map time and produce
   { w, h, cells, props } in local 0,0-based coordinates; boardApplyPresetMap()
   in board-shared.js offsets that onto the middle of the 100x100 grid.

   ORDER MATTERS inside a builder. `prop()` also stamps the prefab's terrain
   (see the `terrain` field above), and prefabs marked 'clear' — doorways,
   bridge planks — *remove* terrain. So paint walls/water/hazard first and
   place the things that cut through them last, or the wall wins and the door
   leads nowhere. */
function pfMap(key, label, desc, w, h, build) {
  return {
    key, label, desc, w, h,
    build() {
      const cells = new Map();
      const props = [];
      const inBounds = (c, r) => c >= 0 && r >= 0 && c < w && r < h;
      const api = {
        W: w, H: h,
        cell(c, r, type) { if (inBounds(c, r)) cells.set(c + ',' + r, type); },
        clear(c, r) { cells.delete(c + ',' + r); },
        fill(c, r, cw, ch, type) {
          for (let r2 = r; r2 < r + ch; r2++) for (let c2 = c; c2 < c + cw; c2++) api.cell(c2, r2, type);
        },
        clearRect(c, r, cw, ch) {
          for (let r2 = r; r2 < r + ch; r2++) for (let c2 = c; c2 < c + cw; c2++) api.clear(c2, r2);
        },
        outline(c, r, cw, ch, type) {
          for (let i = 0; i < cw; i++) { api.cell(c + i, r, type); api.cell(c + i, r + ch - 1, type); }
          for (let j = 0; j < ch; j++) { api.cell(c, r + j, type); api.cell(c + cw - 1, r + j, type); }
        },
        ring(cx, cy, rad, type, thickness) {
          const t = thickness || 1;
          for (let r2 = 0; r2 < h; r2++) for (let c2 = 0; c2 < w; c2++) {
            const d = Math.hypot(c2 + 0.5 - cx, r2 + 0.5 - cy);
            if (d <= rad + t / 2 && d >= rad - t / 2) api.cell(c2, r2, type);
          }
        },
        disc(cx, cy, rad, type) {
          for (let r2 = 0; r2 < h; r2++) for (let c2 = 0; c2 < w; c2++) {
            if (Math.hypot(c2 + 0.5 - cx, r2 + 0.5 - cy) <= rad) api.cell(c2, r2, type);
          }
        },
        // Places a prop and stamps whatever terrain the prefab implies, so a
        // building laid down by a map is impassable without the builder
        // having to say so twice.
        prop(type, c, r, rot) {
          const pf = BOARD_PREFABS_BY_KEY[type];
          props.push({ type, col: c, row: r, rot: rot || 0 });
          if (!pf || !pf.terrain) return;
          const fw = (rot === 90 || rot === 270) ? pf.h : pf.w;
          const fh = (rot === 90 || rot === 270) ? pf.w : pf.h;
          if (pf.terrain === 'clear') api.clearRect(c, r, fw, fh);
          else api.fill(c, r, fw, fh, pf.terrain);
        },
        // Same, minus the terrain — for dressing that shouldn't change how
        // the square plays (a car parked on a road you want left open).
        propOnly(type, c, r, rot) { props.push({ type, col: c, row: r, rot: rot || 0 }); },
        repeat(type, coords, rot) { for (const [c, r] of coords) api.prop(type, c, r, rot); },
      };
      build(api);
      return {
        w, h,
        terrain: [...cells].map(([id, type]) => ({ id, type })),
        props,
      };
    },
  };
}

// A standard 9x9 city block, reused by every street map so the four corners
// of an intersection don't have to be spelled out four times.
function pfCityBlock(m, c, r) {
  m.prop('building', c, r);
  m.prop('highrise', c + 4, r);
  m.prop('building', c + 6, r);
  m.prop('warehouse', c, r + 4);
  m.prop('house', c + 5, r + 4);
  m.prop('highrise', c + 7, r + 4);
  m.prop('crate', c + 1, r + 8);
  m.prop('tree', c + 4, r + 8);
  m.prop('dumpster', c + 6, r + 8);
}

// A blown-out building: walls with gaps where they've collapsed, rubble
// inside. The modulo gaps are deliberate rather than random so the same map
// looks the same every time the DM loads it.
function pfRuin(m, c, r, w, h) {
  for (let i = 0; i < w; i++) {
    if (i % 4 !== 2) { m.cell(c + i, r, 'wall'); }
    if (i % 5 !== 3) { m.cell(c + i, r + h - 1, 'wall'); }
  }
  for (let j = 0; j < h; j++) {
    if (j % 3 !== 1) { m.cell(c, r + j, 'wall'); }
    if (j % 4 !== 2) { m.cell(c + w - 1, r + j, 'wall'); }
  }
  m.prop('rubble', c + 1, r + 1);
  m.prop('rubble', c + w - 2, r + h - 2);
}

const BOARD_MAPS = [
  pfMap('city-street', 'City Street', 'Two rows of shopfronts, a four-lane road and an alley behind.', 32, 20, m => {
    // north side
    m.prop('building', 1, 1);   m.prop('house', 5, 1);     m.prop('highrise', 8, 1);
    m.prop('building', 11, 1);  m.prop('warehouse', 15, 1); m.prop('building', 20, 1);
    m.prop('house', 24, 1);     m.prop('highrise', 27, 1);
    // back alley
    m.prop('dumpster', 2, 5);   m.prop('crate', 6, 5);     m.prop('barrel', 7, 6);
    m.prop('rubble', 13, 5);    m.prop('crate', 19, 6);    m.prop('dumpster', 22, 5);
    m.prop('vending', 26, 5);
    // south side
    m.prop('highrise', 1, 14);  m.prop('building', 4, 14);  m.prop('house', 8, 14);
    m.prop('warehouse', 11, 14); m.prop('building', 16, 14); m.prop('house', 20, 14);
    m.prop('building', 23, 14); m.prop('highrise', 27, 14);
    // street furniture — propOnly so the road stays open ground
    m.repeat('streetlight', [[3, 7], [12, 7], [21, 7], [29, 7], [5, 12], [14, 12], [24, 12]]);
    m.repeat('tree', [[6, 7], [18, 12], [26, 12]]);
    m.propOnly('car', 4, 9);   m.propOnly('van', 10, 10);  m.propOnly('bus', 16, 9);
    m.propOnly('car', 23, 10); m.propOnly('bike', 27, 9);
    m.repeat('cone', [[8, 10], [9, 10]]);
    m.prop('barricade', 20, 10);
    // south back alley, mirroring the north one
    m.prop('dumpster', 4, 18);  m.prop('crate', 9, 18);   m.prop('rubble', 17, 18);
    m.prop('barrel', 23, 18);   m.prop('vending', 28, 18); m.prop('tree', 13, 18);
  }),

  pfMap('intersection', 'Downtown Intersection', 'A crossroads with four city blocks — long sight lines down both streets.', 26, 26, m => {
    pfCityBlock(m, 1, 1);
    pfCityBlock(m, 16, 1);
    pfCityBlock(m, 1, 16);
    pfCityBlock(m, 16, 16);
    m.repeat('streetlight', [[10, 10], [15, 10], [10, 15], [15, 15]]);
    m.propOnly('car', 5, 12);   m.propOnly('van', 18, 13);
    m.propOnly('car', 12, 5, 90); m.propOnly('bus', 13, 17, 90);
    m.repeat('cone', [[11, 11], [14, 14]]);
    m.prop('barricade', 20, 12);
    m.prop('vending', 9, 10);
  }),

  pfMap('ground-beta', 'U.A. Ground Beta', 'The training cityscape after a rough exercise — collapsed shells and rubble.', 30, 24, m => {
    pfRuin(m, 1, 1, 7, 6);
    pfRuin(m, 11, 2, 8, 5);
    pfRuin(m, 22, 1, 7, 7);
    pfRuin(m, 2, 10, 6, 6);
    pfRuin(m, 12, 11, 7, 6);
    pfRuin(m, 22, 10, 7, 5);
    pfRuin(m, 5, 18, 8, 5);
    pfRuin(m, 17, 18, 9, 5);
    m.prop('crater', 9, 7);  m.prop('crater', 19, 16);
    m.repeat('rubble', [[9, 3], [10, 12], [20, 8], [8, 16], [15, 8], [21, 22], [3, 8], [27, 17]]);
    m.repeat('fire', [[20, 9], [8, 17]]);
    m.prop('building', 9, 20);
    m.propOnly('car', 14, 8);
    m.prop('boulder', 26, 8);
    m.prop('watertower', 16, 8);
  }),

  pfMap('warehouse', 'Warehouse Interior', 'Four walls, three aisles of crates and a foreman’s office.', 24, 18, m => {
    m.outline(0, 0, 24, 18, 'wall');
    // office in the corner
    m.outline(1, 1, 6, 5, 'wall');
    // aisles
    for (let c = 9; c <= 21; c += 2) { m.prop('crate', c, 3); m.prop('crate', c, 8); m.prop('crate', c, 13); }
    m.repeat('barrel', [[8, 6], [8, 11], [21, 6], [21, 11]]);
    m.prop('dumpster', 2, 15);
    m.prop('crate', 5, 15);
    m.prop('stairs', 20, 16);
    m.prop('vending', 2, 7);
    m.propOnly('van', 12, 16);
    // last: the ways in and out cut back through the walls above
    m.prop('door', 3, 5);
    m.prop('door', 0, 8);  m.prop('door', 0, 9);
    m.prop('door', 23, 8); m.prop('door', 23, 9);
    m.prop('door', 11, 17); m.prop('door', 12, 17);
  }),

  pfMap('rooftops', 'Rooftop Chase', 'Four rooftops with open air between them — plank the gaps or make the jump.', 28, 20, m => {
    m.fill(0, 9, 28, 2, 'hazard');   // the drop, east–west
    m.fill(12, 0, 3, 20, 'hazard');  // the drop, north–south
    m.prop('watertower', 2, 1);   m.prop('acunit', 6, 2);  m.prop('acunit', 7, 5);
    m.prop('stairs', 9, 6);       m.prop('crate', 4, 6);
    m.prop('acunit', 17, 1);      m.prop('acunit', 18, 4);  m.prop('watertower', 24, 2);
    m.prop('crate', 21, 6);       m.prop('vending', 16, 7);
    m.prop('acunit', 3, 13);      m.prop('stairs', 8, 17);  m.prop('crate', 5, 16);
    m.prop('watertower', 9, 12);
    m.prop('acunit', 19, 13);     m.prop('acunit', 22, 16); m.prop('crate', 17, 17);
    m.prop('statue', 25, 13);
    // planks across the gaps, placed last so they clear the hazard beneath
    m.prop('bridge', 12, 4);
    m.prop('bridge', 12, 15);
    m.prop('bridge', 5, 8, 90);
    m.prop('bridge', 22, 8, 90);
  }),

  pfMap('riverside', 'Riverside Park', 'A river cuts the field in two; one bridge, plenty of tree cover.', 28, 20, m => {
    m.fill(0, 8, 28, 4, 'water');
    m.repeat('tree', [[2, 2], [5, 4], [9, 1], [13, 3], [17, 2], [22, 4], [25, 1],
                      [3, 16], [7, 14], [11, 17], [16, 15], [20, 17], [24, 14]]);
    m.prop('bigtree', 6, 1);
    m.prop('bigtree', 19, 15);
    m.repeat('bush', [[4, 6], [11, 6], [19, 6], [8, 13], [15, 13], [23, 17]]);
    m.repeat('log', [[13, 6], [5, 13]]);
    m.prop('statue', 14, 16);
    m.repeat('streetlight', [[9, 7], [21, 7], [9, 12], [21, 12]]);
    m.prop('boulder', 25, 7);
    // the crossing, last — it planks over the water
    for (let r = 8; r < 12; r++) m.prop('bridge', 12, r);
  }),

  pfMap('sewers', 'Sewer Tunnels', 'Two flooded corridors and the shafts that link them. Tight sight lines.', 30, 16, m => {
    const wallRow = (r) => { for (let c = 0; c < 30; c++) m.cell(c, r, 'wall'); };
    const wallCol = (c, r1, r2) => { for (let r = r1; r <= r2; r++) m.cell(c, r, 'wall'); };
    // corridor A runs rows 1-4, corridor B rows 11-14, each walled top and
    // bottom and capped at both ends
    wallRow(0); wallRow(5); wallRow(10); wallRow(15);
    wallCol(0, 0, 5);  wallCol(29, 0, 5);
    wallCol(0, 10, 15); wallCol(29, 10, 15);
    // Everything between the two corridors is solid rock, not open floor —
    // without this the gap reads as walkable and the map has no shape.
    m.fill(0, 6, 30, 4, 'wall');
    // Two shafts cut down through it, punching both corridor walls on the way.
    for (const c of [8, 19]) m.clearRect(c, 5, 3, 6);
    m.fill(1, 2, 28, 2, 'water');   // channel down corridor A, walkway either side
    m.fill(1, 12, 28, 2, 'water');  // and corridor B
    for (const c of [8, 19]) m.fill(c + 1, 6, 1, 4, 'water');
    m.repeat('rubble', [[3, 1], [14, 4], [24, 1], [6, 14], [17, 11], [26, 14]]);
    m.repeat('barrel', [[11, 1], [22, 14]]);
    m.prop('crate', 15, 1);
    m.prop('fire', 27, 4);
    m.prop('stairs', 2, 11);
  }),

  pfMap('forest', 'Forest Clearing', 'A ring of old trees around open ground. Cover everywhere but the middle.', 26, 26, m => {
    // tree ring
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      const c = Math.round(12.5 + Math.cos(a) * 11) - 0;
      const r = Math.round(12.5 + Math.sin(a) * 11) - 0;
      m.prop('tree', c, r);
    }
    m.repeat('bigtree', [[1, 1], [23, 1], [1, 23], [23, 23], [12, 0], [12, 24]]);
    m.repeat('bush', [[6, 8], [9, 5], [17, 7], [20, 11], [7, 18], [16, 20], [11, 22], [4, 13]]);
    m.repeat('boulder', [[8, 12], [17, 14], [12, 8], [14, 18]]);
    m.repeat('log', [[9, 16], [15, 10]]);
    m.prop('fire', 12, 13);
    m.prop('crater', 19, 18);
  }),

  pfMap('beach', 'Dagobah Beach', 'Sand, surf and a mountain of dumped junk. Open ground with hard cover.', 30, 20, m => {
    m.fill(0, 0, 30, 5, 'water');
    m.fill(0, 5, 30, 1, 'difficult');   // wet sand at the tide line
    m.fill(21, 12, 7, 6, 'difficult');  // the trash mound
    m.repeat('rubble', [[22, 13], [25, 14], [23, 16], [26, 12]]);
    m.repeat('crate', [[21, 12], [24, 12], [27, 15], [22, 17]]);
    m.repeat('barrel', [[26, 17], [20, 15]]);
    m.prop('dumpster', 24, 17);
    m.prop('vending', 27, 13);
    m.propOnly('car', 6, 8);
    m.prop('car', 11, 15);
    m.prop('bus', 3, 12);
    m.prop('van', 15, 9, 90);
    m.repeat('rubble', [[9, 7], [13, 13], [5, 17], [17, 16]]);
    m.prop('boulder', 8, 11);
    m.prop('fire', 19, 16);
  }),

  pfMap('arena', 'Festival Arena', 'A walled bowl with four cover clusters and four gates. Nowhere to hide in the middle.', 26, 26, m => {
    m.ring(13, 13, 12, 'wall', 2);
    m.repeat('boulder', [[7, 7], [18, 7], [7, 18], [18, 18]]);
    m.repeat('crate', [[8, 8], [17, 8], [8, 17], [17, 17]]);
    m.prop('statue', 12, 12);
    m.repeat('barricade', [[11, 5], [11, 20]]);
    m.prop('barricade', 5, 12, 90);
    m.prop('barricade', 20, 12, 90);
    // gates, last — they open the wall ring
    m.prop('door', 12, 1);  m.prop('door', 13, 1);
    m.prop('door', 12, 24); m.prop('door', 13, 24);
    m.prop('door', 1, 12);  m.prop('door', 1, 13);
    m.prop('door', 24, 12); m.prop('door', 24, 13);
  }),
];

const BOARD_MAPS_BY_KEY = Object.fromEntries(BOARD_MAPS.map(mp => [mp.key, mp]));
