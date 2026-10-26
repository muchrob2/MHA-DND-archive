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
    terrain: 'clear', note: 'A way through. Select it on the board to shut it — a shut door is a wall, and blocks sight',
    // The only prefab that reads the fifth argument: the prop itself, so a
    // door that has been shut looks shut. Nothing (the palette chip, a map
    // being built) means open, which is how every door starts.
    draw(ctx, x, y, w, h, prop) {
      const lw = pfInkW(Math.min(w, h));
      if (prop && prop.shut) {
        // Filling the frame rather than leaning on the jamb: a shut door is
        // the wall now, and it should read as one at a glance.
        pfRect(ctx, x + w * 0.08, y + h * 0.04, w * 0.84, h * 0.92, '#A98B63', w * 0.06, lw * 1.4);
        pfLines(ctx, [
          [x + w * 0.22, y + h * 0.18, x + w * 0.22, y + h * 0.82],
          [x + w * 0.5, y + h * 0.18, x + w * 0.5, y + h * 0.82],
          [x + w * 0.78, y + h * 0.18, x + w * 0.78, y + h * 0.82],
        ], 'rgba(0,0,0,0.30)', lw * 0.8);
        pfCircle(ctx, x + w * 0.84, y + h * 0.5, Math.min(w, h) * 0.07, '#E8D9B8', lw * 0.6);
        return;
      }
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

  {
    key: 'pillar', label: 'Pillar', cat: 'Structures', w: 1, h: 1,
    terrain: 'wall', note: 'Impassable; full cover, and it holds the roof up',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      pfRect(ctx, x + w * 0.16, y + h * 0.16, w * 0.68, h * 0.68, '#8B919B', w * 0.06, lw * 1.4);
      pfRect(ctx, x + w * 0.30, y + h * 0.30, w * 0.40, h * 0.40, '#6B7280', 0, lw * 0.7);
      pfLines(ctx, [[x + w * 0.20, y + h * 0.80, x + w * 0.80, y + h * 0.20]], 'rgba(0,0,0,0.25)', lw * 0.8);
    },
  },
  {
    key: 'container', label: 'Shipping container', cat: 'Structures', w: 3, h: 2,
    terrain: 'wall', note: 'Impassable; climb on top for high ground',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.02, y + h * 0.06, w * 0.96, h * 0.88, '#B2562F', w * 0.015, lw * 1.4);
      const segs = [];
      for (let i = 1; i < 12; i++) segs.push([x + (w * i) / 12, y + h * 0.06, x + (w * i) / 12, y + h * 0.94]);
      pfLines(ctx, segs, 'rgba(0,0,0,0.22)', lw * 0.6);
      pfRect(ctx, x + w * 0.74, y + h * 0.12, w * 0.22, h * 0.76, '#9C4826', 0, lw * 0.8);
      pfRect(ctx, x + w * 0.10, y + h * 0.36, w * 0.24, h * 0.28, 'rgba(255,255,255,0.18)', 0, 0);
    },
  },
  {
    key: 'tank', label: 'Storage tank', cat: 'Structures', w: 2, h: 2,
    terrain: 'wall', note: 'Impassable; ask what is in it before you shoot it',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfCircle(ctx, cx, cy, s * 0.46, '#7C848F', lw * 1.4);
      pfCircle(ctx, cx, cy, s * 0.30, '#646C78', lw * 0.7);
      pfLines(ctx, [
        [cx - s * 0.46, cy, cx + s * 0.46, cy],
        [cx, cy - s * 0.46, cx, cy + s * 0.46],
      ], 'rgba(0,0,0,0.25)', lw * 0.7);
      pfRect(ctx, cx - w * 0.04, cy + s * 0.32, w * 0.08, h * 0.16, '#E8A020', 0, 0);
    },
  },
  {
    key: 'railing', label: 'Railing / fence', cat: 'Structures', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; vault it, climb it, or shove someone over it',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfLines(ctx, [
        [x, y + h * 0.38, x + w, y + h * 0.38],
        [x, y + h * 0.62, x + w, y + h * 0.62],
      ], '#9DA5B0', lw * 1.6);
      for (let i = 0; i <= 4; i++) {
        pfRect(ctx, x + (w * i) / 4 - w * 0.02, y + h * 0.26, w * 0.04, h * 0.48, '#6E7682', 0, 0);
      }
    },
  },

  {
    key: 'elevator', label: 'Lift', cat: 'Structures', w: 2, h: 2,
    terrain: 'wall', note: 'Impassable until the doors open — ask the DM',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x, y, w, h, '#5C6472', Math.min(w, h) * 0.04, lw * 1.5);
      pfRect(ctx, x + w * 0.12, y + h * 0.12, w * 0.76, h * 0.76, '#3C4350', 0, lw * 0.8);
      pfLines(ctx, [[x + w * 0.5, y + h * 0.12, x + w * 0.5, y + h * 0.88]], 'rgba(255,255,255,0.22)', lw);
      pfPoly(ctx, [[x + w * 0.30, y + h * 0.42], [x + w * 0.38, y + h * 0.30], [x + w * 0.46, y + h * 0.42]], '#E8A020', 0);
      pfPoly(ctx, [[x + w * 0.54, y + h * 0.58], [x + w * 0.62, y + h * 0.70], [x + w * 0.70, y + h * 0.58]], '#E8A020', 0);
    },
  },
  {
    key: 'helipad', label: 'Helipad', cat: 'Structures', w: 3, h: 3,
    terrain: null, note: 'Open ground, and a very obvious place to stand',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfCircle(ctx, cx, cy, s * 0.46, 'rgba(32,38,48,0.55)', lw * 1.6);
      pfCircle(ctx, cx, cy, s * 0.34, null, lw * 1.2);
      const bar = w * 0.07;
      pfRect(ctx, cx - s * 0.17, cy - s * 0.20, bar, s * 0.40, '#E8E3D4', 0, 0);
      pfRect(ctx, cx + s * 0.10, cy - s * 0.20, bar, s * 0.40, '#E8E3D4', 0, 0);
      pfRect(ctx, cx - s * 0.17, cy - s * 0.035, s * 0.34, s * 0.07, '#E8E3D4', 0, 0);
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

  {
    key: 'hedge', label: 'Hedge', cat: 'Nature', w: 3, h: 1,
    terrain: 'cover', note: 'Half cover; blocks sight but not a determined shoulder',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x, y + h * 0.18, w, h * 0.64, '#2C6236', h * 0.2, lw);
      for (let i = 0; i < 6; i++) {
        pfBlob(ctx, x + w * (0.09 + i * 0.166), y + h * 0.46, h * 0.26, 8, 0.16, '#39773F', 0);
      }
    },
  },
  {
    key: 'pond', label: 'Pond', cat: 'Nature', w: 2, h: 2,
    terrain: 'water', note: 'Shallow water; difficult going, and it puts fires out',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfBlob(ctx, cx, cy, s * 0.48, 18, 0.08, 'rgba(32,86,156,0.78)', lw);
      pfBlob(ctx, cx, cy, s * 0.32, 14, 0.10, 'rgba(58,126,196,0.70)', 0);
      pfLines(ctx, [
        [cx - s * 0.22, cy - s * 0.10, cx + s * 0.06, cy - s * 0.10],
        [cx - s * 0.06, cy + s * 0.14, cx + s * 0.22, cy + s * 0.14],
      ], 'rgba(220,240,255,0.5)', lw * 0.9);
    },
  },

  {
    key: 'torii', label: 'Torii gate', cat: 'Nature', w: 3, h: 1,
    terrain: null, note: 'Walk straight under it; the posts are the only cover',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x + w * 0.02, y + h * 0.10, w * 0.96, h * 0.16, '#B33A2B', 0, lw);
      pfRect(ctx, x + w * 0.08, y + h * 0.32, w * 0.84, h * 0.12, '#B33A2B', 0, lw * 0.8);
      pfRect(ctx, x + w * 0.12, y + h * 0.10, w * 0.08, h * 0.80, '#8E2E22', 0, lw * 0.8);
      pfRect(ctx, x + w * 0.80, y + h * 0.10, w * 0.08, h * 0.80, '#8E2E22', 0, lw * 0.8);
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

  {
    key: 'truck', label: 'Box truck', cat: 'Vehicles', w: 5, h: 2,
    terrain: 'cover', note: 'Full cover; the trailer is a room if the DM says so',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfWheels(ctx, x, y, w, h, 3);
      pfRect(ctx, x + w * 0.01, y + h * 0.08, w * 0.70, h * 0.84, '#D4D8DE', w * 0.01, lw * 1.4);
      pfRect(ctx, x + w * 0.08, y + h * 0.22, w * 0.42, h * 0.24, 'rgba(0,0,0,0.12)', 0, 0);
      pfLines(ctx, [[x + w * 0.04, y + h * 0.50, x + w * 0.67, y + h * 0.50]], 'rgba(0,0,0,0.20)', lw * 0.8);
      pfRect(ctx, x + w * 0.72, y + h * 0.14, w * 0.27, h * 0.72, '#2F6EA8', h * 0.08, lw * 1.2);
      pfRect(ctx, x + w * 0.87, y + h * 0.22, w * 0.10, h * 0.56, 'rgba(190,225,255,0.5)', 0, lw * 0.6);
      pfRect(ctx, x + w * 0.98, y + h * 0.26, w * 0.02, h * 0.14, '#FFE9A8', 0, 0);
    },
  },
  {
    key: 'train', label: 'Train car', cat: 'Vehicles', w: 6, h: 2,
    terrain: 'wall', note: 'Full cover; the doors and the roof are the ways in',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.01, y + h * 0.10, w * 0.98, h * 0.80, '#C9CED6', h * 0.14, lw * 1.5);
      pfRect(ctx, x + w * 0.01, y + h * 0.44, w * 0.98, h * 0.12, '#2E7D4F', 0, 0);
      for (let i = 0; i < 6; i++) {
        const fx = 0.07 + i * 0.15;
        pfRect(ctx, x + w * fx, y + h * 0.16, w * 0.08, h * 0.22, 'rgba(190,225,255,0.55)', 0, lw * 0.5);
        pfRect(ctx, x + w * fx, y + h * 0.62, w * 0.08, h * 0.22, 'rgba(190,225,255,0.55)', 0, lw * 0.5);
      }
      for (const fx of [0.22, 0.52, 0.82]) {
        pfRect(ctx, x + w * fx, y + h * 0.10, w * 0.05, h * 0.80, 'rgba(40,46,56,0.55)', 0, lw * 0.6);
      }
      pfRect(ctx, x, y + h * 0.36, w * 0.015, h * 0.28, '#3A4049', 0, 0);
      pfRect(ctx, x + w * 0.985, y + h * 0.36, w * 0.015, h * 0.28, '#3A4049', 0, 0);
    },
  },

  {
    key: 'foodcart', label: 'Food cart', cat: 'Vehicles', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; a hot plate and a gas bottle under it',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x + w * 0.06, y + h * 0.26, w * 0.88, h * 0.52, '#7A4F33', h * 0.1, lw * 1.2);
      pfRect(ctx, x + w * 0.06, y + h * 0.10, w * 0.88, h * 0.18, '#D9B23A', h * 0.06, lw * 0.8);
      for (let i = 0; i < 4; i++) {
        pfRect(ctx, x + w * (0.08 + i * 0.22), y + h * 0.10, w * 0.11, h * 0.18, 'rgba(180,40,36,0.75)', 0, 0);
      }
      pfCircle(ctx, x + w * 0.22, y + h * 0.84, h * 0.12, '#23262D', lw * 0.6);
      pfCircle(ctx, x + w * 0.74, y + h * 0.84, h * 0.12, '#23262D', lw * 0.6);
    },
  },
  {
    key: 'forklift', label: 'Forklift', cat: 'Vehicles', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; drivable, and the forks are a weapon',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfWheels(ctx, x, y, w, h, 2);
      pfRect(ctx, x + w * 0.08, y + h * 0.18, w * 0.52, h * 0.64, '#D9941F', h * 0.1, lw * 1.2);
      pfRect(ctx, x + w * 0.20, y + h * 0.28, w * 0.26, h * 0.44, '#9A6A14', 0, lw * 0.6);
      pfRect(ctx, x + w * 0.62, y + h * 0.10, w * 0.06, h * 0.80, '#5A626E', 0, 0);
      pfRect(ctx, x + w * 0.68, y + h * 0.22, w * 0.28, h * 0.08, '#C3C8CF', 0, 0);
      pfRect(ctx, x + w * 0.68, y + h * 0.70, w * 0.28, h * 0.08, '#C3C8CF', 0, 0);
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
  {
    key: 'counter', label: 'Counter', cat: 'Scatter', w: 3, h: 1,
    terrain: 'cover', note: 'Half cover; duck behind it, serve drinks over it',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x, y + h * 0.22, w, h * 0.56, '#6B4A2E', h * 0.12, lw * 1.2);
      pfRect(ctx, x + w * 0.02, y + h * 0.26, w * 0.96, h * 0.14, '#8A6238', 0, 0);
      pfLines(ctx, [
        [x + w * 0.34, y + h * 0.22, x + w * 0.34, y + h * 0.78],
        [x + w * 0.67, y + h * 0.22, x + w * 0.67, y + h * 0.78],
      ], 'rgba(0,0,0,0.28)', lw * 0.8);
      pfRect(ctx, x + w * 0.74, y + h * 0.34, w * 0.14, h * 0.30, '#C3C8CF', 0, lw * 0.6);
    },
  },
  {
    key: 'bench', label: 'Bench', cat: 'Scatter', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover lying behind it; a seat otherwise',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x + w * 0.04, y + h * 0.30, w * 0.92, h * 0.40, '#8A6A47', h * 0.08, lw);
      pfLines(ctx, [[x + w * 0.04, y + h * 0.50, x + w * 0.96, y + h * 0.50]], 'rgba(0,0,0,0.25)', lw * 0.8);
      pfRect(ctx, x + w * 0.12, y + h * 0.68, w * 0.08, h * 0.16, '#4B5058', 0, 0);
      pfRect(ctx, x + w * 0.80, y + h * 0.68, w * 0.08, h * 0.16, '#4B5058', 0, 0);
    },
  },
  {
    key: 'stall', label: 'Market stall', cat: 'Scatter', w: 2, h: 2,
    terrain: 'cover', note: 'Half cover; the awning hides whoever is under it',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.08, y + h * 0.08, w * 0.84, h * 0.84, '#C94F3C', w * 0.05, lw * 1.3);
      for (let i = 0; i < 4; i++) {
        pfRect(ctx, x + w * (0.08 + i * 0.21), y + h * 0.08, w * 0.105, h * 0.84, 'rgba(255,255,255,0.32)', 0, 0);
      }
      pfRect(ctx, x + w * 0.22, y + h * 0.58, w * 0.56, h * 0.28, '#6B4A2E', w * 0.03, lw * 0.9);
    },
  },
  {
    key: 'pipes', label: 'Pipe run', cat: 'Scatter', w: 3, h: 1,
    terrain: 'cover', note: 'Half cover; crawl over it or squeeze under it',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      for (const fy of [0.32, 0.66]) {
        pfRect(ctx, x, y + h * (fy - 0.11), w, h * 0.22, '#7E8794', h * 0.1, lw);
        pfLines(ctx, [[x, y + h * (fy - 0.05), x + w, y + h * (fy - 0.05)]], 'rgba(255,255,255,0.22)', lw * 0.8);
      }
      for (const fx of [0.24, 0.74]) {
        pfRect(ctx, x + w * fx, y + h * 0.14, w * 0.05, h * 0.72, '#5A626E', 0, 0);
      }
    },
  },
  {
    key: 'fountain', label: 'Fountain', cat: 'Scatter', w: 2, h: 2,
    terrain: 'water', note: 'Ankle-deep water; the basin wall is half cover',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfCircle(ctx, cx, cy, s * 0.46, '#8F96A1', lw * 1.4);
      pfCircle(ctx, cx, cy, s * 0.36, 'rgba(37,99,235,0.55)', lw * 0.7);
      pfCircle(ctx, cx, cy, s * 0.12, '#C3C8CF', lw * 0.6);
      const segs = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        segs.push([cx + Math.cos(a) * s * 0.14, cy + Math.sin(a) * s * 0.14,
                   cx + Math.cos(a) * s * 0.30, cy + Math.sin(a) * s * 0.30]);
      }
      pfLines(ctx, segs, 'rgba(220,240,255,0.6)', lw * 0.9);
    },
  },
  {
    key: 'scaffold', label: 'Scaffold', cat: 'Scatter', w: 2, h: 2,
    terrain: 'difficult', note: 'Difficult terrain; climbable, and it comes down',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.06, y + h * 0.06, w * 0.88, h * 0.88, 'rgba(120,128,140,0.22)', 0, lw);
      const segs = [];
      for (let i = 0; i <= 3; i++) {
        const f = 0.06 + i * 0.293;
        segs.push([x + w * 0.06, y + h * f, x + w * 0.94, y + h * f]);
        segs.push([x + w * f, y + h * 0.06, x + w * f, y + h * 0.94]);
      }
      pfLines(ctx, segs, '#A8AFB9', lw * 1.1);
      pfRect(ctx, x + w * 0.06, y + h * 0.40, w * 0.88, h * 0.14, '#A5793F', 0, lw * 0.6);
    },
  },

  {
    key: 'generator', label: 'Generator', cat: 'Scatter', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; the lights go out if it does',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x + w * 0.04, y + h * 0.18, w * 0.92, h * 0.64, '#E8A020', h * 0.08, lw * 1.3);
      pfRect(ctx, x + w * 0.12, y + h * 0.28, w * 0.40, h * 0.44, '#9A6A14', 0, lw * 0.7);
      const segs = [];
      for (let i = 0; i < 5; i++) segs.push([x + w * (0.58 + i * 0.07), y + h * 0.26, x + w * (0.58 + i * 0.07), y + h * 0.74]);
      pfLines(ctx, segs, 'rgba(0,0,0,0.38)', lw * 0.9);
      pfRect(ctx, x + w * 0.46, y + h * 0.06, w * 0.07, h * 0.14, '#5A626E', 0, 0);
    },
  },
  {
    key: 'awning', label: 'Awning', cat: 'Scatter', w: 3, h: 1,
    terrain: null, note: 'Overhead cover only — hides you from above, not from across the street',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x + w * 0.02, y + h * 0.20, w * 0.96, h * 0.56, 'rgba(46,125,79,0.55)', h * 0.06, lw);
      for (let i = 0; i < 6; i++) {
        pfRect(ctx, x + w * (0.02 + i * 0.163), y + h * 0.20, w * 0.082, h * 0.56, 'rgba(240,244,250,0.22)', 0, 0);
      }
      pfLines(ctx, [[x + w * 0.02, y + h * 0.76, x + w * 0.98, y + h * 0.76]], 'rgba(0,0,0,0.3)', lw * 0.9);
    },
  },

  /* ── Interiors ──
     Furniture, for the maps that happen inside a building. Everything here
     is waist-height unless the note says otherwise, so most of it is cover
     you can see over and none of it stops a Quirk. */
  {
    key: 'bed', label: 'Bed', cat: 'Interiors', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; someone may be in it',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x + w * 0.04, y + h * 0.12, w * 0.92, h * 0.76, '#C7CCD4', h * 0.08, lw * 1.2);
      pfRect(ctx, x + w * 0.06, y + h * 0.16, w * 0.24, h * 0.68, '#EDF1F6', h * 0.06, lw * 0.6);
      pfRect(ctx, x + w * 0.34, y + h * 0.16, w * 0.60, h * 0.68, '#5E8FBF', 0, lw * 0.6);
      pfLines(ctx, [[x + w * 0.52, y + h * 0.16, x + w * 0.52, y + h * 0.84]], 'rgba(255,255,255,0.30)', lw * 0.8);
    },
  },
  {
    key: 'desk', label: 'Desk', cat: 'Interiors', w: 1, h: 1,
    terrain: 'cover', note: 'Half cover crouched behind it; flip it for more',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.10, y + h * 0.22, w * 0.80, h * 0.50, '#A5793F', w * 0.05, lw * 1.2);
      pfRect(ctx, x + w * 0.14, y + h * 0.26, w * 0.72, h * 0.16, '#C1914F', 0, 0);
      pfRect(ctx, x + w * 0.26, y + h * 0.74, w * 0.48, h * 0.16, '#4B5058', 0, lw * 0.6);
    },
  },
  {
    key: 'sofa', label: 'Sofa', cat: 'Interiors', w: 2, h: 1,
    terrain: 'cover', note: 'Half cover; tip it on its back for three-quarters',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x + w * 0.04, y + h * 0.14, w * 0.92, h * 0.72, '#6E5A8C', h * 0.16, lw * 1.2);
      pfRect(ctx, x + w * 0.10, y + h * 0.34, w * 0.80, h * 0.46, '#8873A8', h * 0.1, lw * 0.6);
      pfLines(ctx, [[x + w * 0.50, y + h * 0.34, x + w * 0.50, y + h * 0.80]], 'rgba(0,0,0,0.25)', lw * 0.8);
    },
  },
  {
    key: 'table', label: 'Table', cat: 'Interiors', w: 2, h: 2,
    terrain: 'cover', note: 'Half cover; full if someone upends it',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      const cx = x + w / 2, cy = y + h / 2;
      pfCircle(ctx, cx, cy, s * 0.42, '#8A6A47', lw * 1.3);
      pfCircle(ctx, cx, cy, s * 0.30, '#A5793F', lw * 0.6);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        pfRect(ctx, cx + Math.cos(a) * s * 0.44 - w * 0.06, cy + Math.sin(a) * s * 0.44 - h * 0.06,
               w * 0.12, h * 0.12, '#6B4A2E', w * 0.03, 0);
      }
    },
  },
  {
    key: 'lockers', label: 'Lockers', cat: 'Interiors', w: 2, h: 1,
    terrain: 'wall', note: 'Full cover; impassable, and loud when hit',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfRect(ctx, x, y + h * 0.16, w, h * 0.68, '#55707E', 0, lw * 1.3);
      const segs = [];
      for (let i = 1; i < 6; i++) segs.push([x + (w * i) / 6, y + h * 0.16, x + (w * i) / 6, y + h * 0.84]);
      pfLines(ctx, segs, 'rgba(0,0,0,0.35)', lw * 0.9);
      for (let i = 0; i < 6; i++) {
        pfRect(ctx, x + (w * (i + 0.72)) / 6, y + h * 0.44, w * 0.025, h * 0.12, '#D9DDE3', 0, 0);
      }
    },
  },
  {
    key: 'bars', label: 'Cell bars', cat: 'Interiors', w: 2, h: 1,
    terrain: 'cover', note: 'Impassable to bodies, not to sight or reach',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(h);
      pfLines(ctx, [
        [x, y + h * 0.20, x + w, y + h * 0.20],
        [x, y + h * 0.80, x + w, y + h * 0.80],
      ], '#6E7682', lw * 1.4);
      const segs = [];
      for (let i = 0; i <= 8; i++) segs.push([x + (w * i) / 8, y + h * 0.16, x + (w * i) / 8, y + h * 0.84]);
      pfLines(ctx, segs, '#9DA5B0', lw * 1.3);
    },
  },
  {
    key: 'bath', label: 'Bath', cat: 'Interiors', w: 3, h: 2,
    terrain: 'water', note: 'Waist-deep water; difficult going, and everyone is unarmed',
    draw(ctx, x, y, w, h) {
      const lw = pfInkW(Math.min(w, h));
      pfRect(ctx, x + w * 0.03, y + h * 0.08, w * 0.94, h * 0.84, '#8F96A1', Math.min(w, h) * 0.08, lw * 1.4);
      pfRect(ctx, x + w * 0.08, y + h * 0.18, w * 0.84, h * 0.64, 'rgba(37,99,235,0.45)', Math.min(w, h) * 0.06, lw * 0.7);
      pfLines(ctx, [
        [x + w * 0.16, y + h * 0.38, x + w * 0.52, y + h * 0.38],
        [x + w * 0.44, y + h * 0.62, x + w * 0.84, y + h * 0.62],
      ], 'rgba(220,240,255,0.55)', lw * 0.9);
    },
  },
  {
    key: 'turnstile', label: 'Turnstile', cat: 'Interiors', w: 1, h: 1,
    terrain: 'cover', note: 'Squeeze through one at a time, or jump it',
    draw(ctx, x, y, w, h) {
      const s = Math.min(w, h), lw = pfInkW(s);
      pfRect(ctx, x + w * 0.10, y + h * 0.12, w * 0.26, h * 0.76, '#55707E', w * 0.05, lw);
      pfRect(ctx, x + w * 0.64, y + h * 0.12, w * 0.26, h * 0.76, '#55707E', w * 0.05, lw);
      pfLines(ctx, [
        [x + w * 0.36, y + h * 0.42, x + w * 0.64, y + h * 0.42],
        [x + w * 0.36, y + h * 0.62, x + w * 0.64, y + h * 0.62],
      ], '#C3C8CF', lw * 1.2);
      pfRect(ctx, x + w * 0.18, y + h * 0.22, w * 0.10, h * 0.14, '#5FD08A', 0, 0);
    },
  },

];

const BOARD_PREFABS_BY_KEY = Object.fromEntries(BOARD_PREFABS.map(p => [p.key, p]));
const BOARD_PREFAB_CATS = ['Structures', 'Interiors', 'Nature', 'Vehicles', 'Scatter'];

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
      const elevCells = new Map();
      const notes = [];
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
        // A label pinned to a square — the same layer the DM's Label tool
        // writes to, so a preset can hand over a board that already says
        // which room is which. That is the difference between a two-floor map
        // and two rooms drawn next to each other for no stated reason.
        note(c, r, text) {
          if (inBounds(c, r) && text) notes.push({ col: c, row: r, text: String(text).slice(0, 40) });
        },
        // Elevation, for a map with more than one floor on it. A building
        // whose upstairs matters is laid out beside its downstairs on the
        // same grid with the upper rooms marked, which is how this board
        // expresses height: a number per square and the DM's judgement.
        elev(c, r, level) {
          if (inBounds(c, r) && level) elevCells.set(c + ',' + r, level);
        },
        elevRect(c, r, cw, ch, level) {
          for (let r2 = r; r2 < r + ch; r2++) for (let c2 = c; c2 < c + cw; c2++) api.elev(c2, r2, level);
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
        // Only present when a map actually has a second floor; boardApplyPresetMap
        // reads a missing layer as empty, which is also what clears the last
        // map's elevation off the board.
        elev: [...elevCells].map(([id, level]) => ({ id, level })),
        notes,
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

// A row of frontages laid left to right from (c,r), cycling the kinds so no
// two neighbours match and stopping before one would overhang c+w. The
// single-square gaps it leaves between them are the alley mouths.
function pfFrontage(m, c, r, w, start) {
  const kinds = ['building', 'house', 'highrise', 'warehouse', 'house', 'highrise'];
  let x = c, i = start || 0;
  while (x < c + w) {
    const key = kinds[i % kinds.length];
    const pf = BOARD_PREFABS_BY_KEY[key];
    if (x + pf.w > c + w) break;
    m.prop(key, x, r);
    x += pf.w + 1;
    i++;
  }
}

// A whole city block: frontages every four rows, so the block is a mass of
// buildings with one-square lanes between them rather than two rows and a
// field, plus bins down the service lane in the middle. `seed` shifts which
// building each row starts on, so neighbouring blocks don't come out
// identical. Blocks read best 4n+3 rows deep (15, 19) — a shallower
// remainder is left as pavement.
function pfBlockDense(m, c, r, w, h, seed) {
  const rows = [];
  for (let dr = 0; dr + 3 <= h; dr += 4) rows.push(dr);
  rows.forEach((dr, i) => pfFrontage(m, c, r + dr, w, seed + i * 3));
  const lane = r + rows[Math.max(0, Math.ceil(rows.length / 2) - 1)] + 3;
  const bins = ['dumpster', 'crate', 'barrel', 'rubble', 'vending'];
  for (let i = 0; i * 4 + 4 <= w; i++) m.prop(bins[(i + seed) % bins.length], c + 1 + i * 4, lane);
}

// Container stacks in a grid, one square of aisle between them — the aisles
// are the whole point, so this takes a count rather than a rect.
function pfContainerYard(m, c, r, cols, rows) {
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) m.prop('container', c + i * 4, r + j * 3);
  }
}

// A row of rooms along a corridor: `count` rooms, each `w` wide and `h` deep,
// sharing their side walls so the partitions are one square thick. Returns
// the doorway squares rather than placing them, because doors have to go in
// after every wall on the map — anything outlined later would brick them up.
function pfRoomRow(m, c, r, w, h, count, doorSide) {
  const doors = [];
  for (let i = 0; i < count; i++) {
    const c0 = c + i * (w - 1);
    m.outline(c0, r, w, h, 'wall');
    const mid = c0 + Math.floor(w / 2);
    const dr = doorSide === 'south' ? r + h - 1 : r;
    doors.push([mid, dr]);
    if (w >= 8) doors.push([mid + 1, dr]);
  }
  return doors;
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
    // Radius 11, not 12: at 12 the ring runs right off the edge of the map on
    // all four gate axes, so the gates opened into the boundary and the bowl
    // was a sealed box. One square in, and they open onto a ring road.
    m.ring(13, 13, 11, 'wall', 2);
    m.repeat('boulder', [[7, 7], [18, 7], [7, 18], [18, 18]]);
    m.repeat('crate', [[8, 8], [17, 8], [8, 17], [17, 17]]);
    m.prop('statue', 12, 12);
    m.repeat('barricade', [[11, 5], [11, 20]]);
    m.prop('barricade', 5, 12, 90);
    m.prop('barricade', 20, 12, 90);
    // Gates, last — they open the wall ring. The ring is two squares thick,
    // so each gate needs both of them: cutting only the inner layer left the
    // bowl sealed and the four corners outside it sealed from each other.
    m.repeat('door', [[12, 1], [13, 1], [12, 2], [13, 2],
                      [12, 23], [13, 23], [12, 24], [13, 24],
                      [1, 12], [1, 13], [2, 12], [2, 13],
                      [23, 12], [23, 13], [24, 12], [24, 13]]);
  }),
  pfMap('chop-shop', 'The Chop Shop', 'A two-bay lock-up: vans, plates, no questions. The counter a man with a scar bled on, the pit, and a shutter that is always open.', 24, 16, m => {
    m.outline(0, 0, 24, 16, 'wall');
    m.outline(16, 0, 8, 7, 'wall');      // the office, sharing the back and side walls

    // Two bays. The pit is between them — difficult going, and a place to be
    // shoved into.
    m.fill(7, 9, 2, 5, 'difficult');
    m.propOnly('van', 2, 4);
    m.propOnly('van', 11, 4);
    m.propOnly('car', 11, 12);
    m.repeat('railing', [[6, 8], [6, 14]]);

    // The bench down the back wall, the parts, and the counter at the front
    // that a man with a scar bled on in the spring.
    m.repeat('counter', [[1, 1], [4, 1]]);
    m.prop('counter', 12, 14);
    m.repeat('lockers', [[14, 1], [14, 3]]);
    m.repeat('crate', [[1, 7], [4, 7], [14, 8], [14, 11]]);
    m.repeat('barrel', [[1, 13], [3, 13]]);
    m.prop('generator', 14, 6);
    m.prop('pipes', 9, 1);

    // The office: her desk, the plates nobody asks about, the kettle.
    m.prop('desk', 18, 2);
    m.prop('counter', 20, 4);
    m.prop('crate', 22, 2);

    // The shutter is always open, which is the joke; the side door into the
    // alley and the office door are the other two ways through.
    m.repeat('door', [[10, 15], [11, 15], [12, 15]]);
    m.prop('door', 0, 10);
    m.repeat('door', [[16, 4], [16, 5]]);
  }),

  pfMap('noodle-bar', 'The Noodle Bar & Lucky Seven', 'Neutral ground downstairs, the house upstairs. Two floors side by side, the stairwell between them, and the upper room marked +1.', 28, 14, m => {
    // Two floors on one grid, which is how a board does height: the rooms are
    // laid out beside each other, the stairwell between them is the actual
    // connection, and the upper floor carries its elevation and a label so
    // nobody has to be told which is which.
    m.outline(0, 0, 13, 14, 'wall');     // the shop
    m.outline(15, 0, 13, 14, 'wall');    // the room above it
    m.fill(13, 0, 2, 14, 'wall');        // between them
    m.clearRect(13, 1, 2, 2);            // except the stairwell
    m.elevRect(16, 1, 11, 12, 1);        // upstairs is one floor up

    // DOWNSTAIRS — a counter, six stools, and the kitchen behind it.
    m.prop('counter', 2, 5);
    m.prop('counter', 6, 5);
    m.repeat('desk', [[2, 7], [4, 7], [6, 7], [8, 7], [3, 9], [7, 9]]);
    m.repeat('crate', [[1, 1], [3, 1], [11, 8]]);
    m.repeat('barrel', [[5, 1], [7, 1]]);
    m.prop('vending', 11, 11);
    m.prop('bench', 9, 11);
    m.note(6, 12, 'NOODLE BAR — neutral');

    // UPSTAIRS — the dice floor. The table in the middle, Madame Tsuru's
    // corner, benches round the walls, and the window nobody uses.
    m.prop('table', 20, 6);
    m.prop('counter', 24, 3);
    m.repeat('bench', [[17, 2], [17, 5], [17, 8], [17, 11], [25, 8], [25, 11]]);
    m.repeat('desk', [[19, 3], [22, 3], [19, 10], [22, 10]]);
    m.prop('crate', 25, 6);
    m.prop('lockers', 23, 12);
    m.note(21, 12, 'LUCKY SEVEN — the house');

    // The stairs themselves, and the ways in: the street door, the stair
    // mouth at each end, and the window at the back of the upper room.
    m.repeat('stairs', [[13, 1], [13, 2]]);
    m.repeat('door', [[6, 13], [7, 13]]);
    m.repeat('door', [[12, 1], [12, 2], [15, 1], [15, 2]]);
    m.prop('door', 27, 9);
  }),

  pfMap('swing-town', 'Swing Town', 'Byakko’s front door: six batting cages, the stands, the back cage where Friday’s fights happen, and Imai’s office behind it.', 30, 22, m => {
    m.outline(0, 0, 30, 22, 'wall');
    // The back cage and the back office share the south and east walls with
    // the building, so the partitions are one square thick.
    m.outline(12, 12, 10, 10, 'wall');   // the back cage — rows 13-20 inside
    m.outline(21, 14, 9, 8, 'wall');     // the back office, sharing the cage's east wall

    // Six cages along the front, netting between them. The dividers are
    // railings turned on their side: half cover you can see through, which is
    // what netting is.
    for (const c of [5, 9, 13, 17, 21]) {
      for (const r of [1, 3, 5]) m.prop('railing', c, r, 90);
    }
    // A pitching machine at the far end of each cage, and the taped-up speed
    // dial is the DM's business rather than the board's.
    for (const c of [2, 6, 10, 14, 18, 22]) m.prop('generator', c, 1);
    m.repeat('crate', [[25, 1], [25, 4]]);

    // The counter, the chalk wall behind it, and the vending wall everybody
    // actually talks at.
    m.prop('counter', 10, 9);
    m.prop('counter', 14, 9);
    m.repeat('vending', [[28, 2], [28, 3], [28, 4], [28, 6]]);
    m.prop('bench', 26, 8);

    // The stands: four rows of plastic seats facing the back cage.
    m.repeat('bench', [[2, 13], [5, 13], [8, 13], [2, 15], [5, 15], [8, 15],
                       [2, 17], [5, 17], [8, 17], [2, 19], [5, 19], [8, 19]]);
    m.prop('dumpster', 1, 11);

    // The back cage itself is bare — it is a cage with a ball machine in it
    // nobody has plugged in since spring.
    m.prop('generator', 19, 19);
    m.prop('crate', 13, 13);

    // The office: Imai's table, the safe, and the kettle's corner.
    m.prop('counter', 24, 16);
    m.prop('crate', 23, 19);
    m.prop('desk', 27, 18);
    m.prop('lockers', 26, 15);

    // Doors last: the way in off the street, the STAFF door, the cage mouth
    // and the fire exit nobody is supposed to use.
    m.repeat('door', [[0, 9], [0, 10]]);
    m.repeat('door', [[12, 16], [12, 17]]);
    m.prop('door', 25, 14);
    m.prop('door', 29, 20);
  }),

  /* ── the big ones ──────────────────────────────────────
     Everything above is a single location you can take in at a glance. The
     maps below are two to three times the area — a district rather than a
     street, a building with rooms rather than one room — for fights that
     move, chases, and sessions where the party splits up. They cost a bit
     of zooming out; that's the trade. */

  pfMap('hosu-district', 'Hosu District', 'Six city blocks around a crossroads \u2014 four built up, a park, and a building site. Sight lines down every street.', 48, 35, m => {
    // Blocks sit at columns 0-12 / 17-30 / 35-47 and rows 0-14 / 20-34; the
    // avenues are the gaps left between them.
    pfBlockDense(m, 0, 0, 13, 15, 0);
    pfBlockDense(m, 17, 0, 14, 15, 2);
    pfBlockDense(m, 0, 20, 13, 15, 1);
    pfBlockDense(m, 35, 20, 13, 15, 4);

    // north-east block: the park
    m.repeat('tree', [[36, 1], [39, 0], [43, 1], [46, 2], [36, 6], [46, 7], [37, 13], [41, 14], [45, 13]]);
    m.prop('bigtree', 42, 3);
    m.prop('pond', 39, 8);
    m.repeat('bench', [[36, 4], [44, 10], [40, 12]]);
    m.prop('hedge', 43, 6);
    m.prop('statue', 38, 5);
    m.prop('streetlight', 41, 2);

    // south-centre block: half-built, hoarded off
    for (let i = 0; i < 4; i++) m.prop('scaffold', 18 + i * 3, 22);
    m.repeat('pillar', [[19, 27], [23, 27], [27, 27], [19, 31], [23, 31], [27, 31]]);
    m.repeat('rubble', [[21, 29], [25, 33], [18, 34]]);
    m.prop('crate', 29, 28);
    m.prop('barrel', 29, 32);
    m.propOnly('truck', 21, 33);
    m.repeat('cone', [[17, 26], [20, 26], [24, 26], [28, 26]]);
    m.prop('barricade', 17, 25);

    // the avenues \u2014 traffic placed with propOnly so the road stays open ground
    m.repeat('streetlight', [[13, 2], [16, 8], [13, 25], [16, 32], [31, 3], [34, 10],
                             [31, 27], [34, 33], [2, 17], [9, 15], [27, 18], [38, 16], [45, 19]]);
    m.propOnly('bus', 14, 5, 90);
    m.propOnly('car', 15, 12, 90);
    m.propOnly('van', 32, 7, 90);
    m.propOnly('car', 33, 23, 90);
    m.propOnly('car', 4, 18);
    m.propOnly('van', 21, 16);
    m.propOnly('bus', 39, 17);
    m.propOnly('bike', 30, 19);
    m.repeat('cone', [[12, 16], [12, 17]]);
    m.prop('barricade', 43, 17);
    m.prop('crater', 15, 16);
  }),

  pfMap('ua-campus', 'U.A. Campus Grounds', 'The main building, the plaza, Gym Gamma and the training field, all inside the perimeter wall.', 50, 40, m => {
    m.outline(0, 0, 50, 40, 'wall');

    // main building: three north rooms off a corridor that runs the width
    m.outline(13, 1, 24, 12, 'wall');
    for (let r = 1; r <= 8; r++) { m.cell(21, r, 'wall'); m.cell(29, r, 'wall'); }
    for (let c = 13; c <= 36; c++) m.cell(c, 8, 'wall');
    m.prop('counter', 15, 10);
    m.repeat('crate', [[18, 3], [26, 5], [33, 3]]);
    m.repeat('bench', [[24, 11], [31, 11]]);
    m.prop('vending', 34, 10);
    m.prop('stairs', 19, 11);

    // the plaza in front of it
    m.prop('fountain', 23, 17);
    m.prop('statue', 20, 18);
    m.repeat('bench', [[17, 15], [28, 15], [17, 21], [28, 21]]);
    m.repeat('tree', [[15, 14], [31, 14], [15, 22], [31, 22]]);
    m.repeat('streetlight', [[19, 14], [27, 14], [19, 22], [27, 22]]);
    m.prop('hedge', 21, 23);

    // Gym Gamma — a round shell with four doors, cut in after the ring
    m.ring(7, 29, 6, 'wall', 1);
    m.repeat('crate', [[5, 27], [9, 31]]);
    m.repeat('pillar', [[4, 29], [10, 29]]);
    m.prop('boulder', 7, 28);

    // the training field, east and south
    m.repeat('boulder', [[22, 26], [29, 30], [36, 25], [43, 31], [26, 36], [40, 36]]);
    m.repeat('rubble', [[24, 31], [33, 34], [45, 27], [20, 34]]);
    m.prop('crater', 30, 26);
    m.repeat('barricade', [[24, 28], [38, 33]]);
    m.prop('scaffold', 34, 29);
    m.repeat('bigtree', [[46, 34], [44, 22]]);

    // grounds: the pond and the tree lines either side of the approach
    m.prop('pond', 43, 6);
    m.repeat('tree', [[39, 3], [41, 9], [46, 3], [47, 10], [40, 12],
                      [2, 2], [6, 4], [10, 2], [3, 8], [9, 9], [5, 12], [11, 14], [2, 17]]);
    m.prop('bigtree', 45, 13);
    m.repeat('hedge', [[39, 16], [44, 18], [8, 21]]);
    m.prop('bigtree', 7, 18);
    m.prop('bench', 4, 20);

    // doors and gates, last — they cut back through everything above
    m.repeat('door', [[24, 12], [25, 12], [17, 8], [25, 8], [33, 8], [21, 5], [29, 5]]);
    m.repeat('door', [[7, 23], [7, 34], [1, 29], [12, 29]]);
    m.repeat('door', [[24, 39], [25, 39], [0, 20], [0, 21], [49, 19], [49, 20]]);
  }),

  pfMap('mall', 'Kiyashi Ward Mall', 'Eight shop units, a food court and a stockroom around a fountain atrium. No outside to run to \u2014 only four exits.', 44, 34, m => {
    m.outline(0, 0, 44, 34, 'wall');
    // Units share their side walls with each other and with the perimeter,
    // so the shop walls are one square thick rather than two.
    for (let i = 0; i < 4; i++) {
      m.outline(i * 8, 0, 9, 9, 'wall');     // north row, interior rows 1-7
      m.outline(i * 8, 25, 9, 9, 'wall');    // south row, interior rows 26-32
    }
    m.outline(32, 0, 12, 14, 'wall');        // food court
    m.outline(32, 21, 12, 13, 'wall');       // stockroom and loading bay

    // inside the units
    for (let i = 0; i < 4; i++) {
      m.prop('counter', i * 8 + 2, 6);
      m.prop('crate', i * 8 + 1, 2);
      m.prop('counter', i * 8 + 2, 27);
      m.prop('crate', i * 8 + 6, 31);
    }
    // food court: two serveries and the tables
    m.repeat('counter', [[35, 2], [39, 2]]);
    m.repeat('bench', [[35, 6], [39, 6], [35, 9], [39, 9], [35, 12], [39, 12]]);
    m.prop('vending', 41, 4);
    // stockroom
    m.repeat('crate', [[33, 22], [35, 22], [37, 22], [33, 25], [35, 25]]);
    m.repeat('barrel', [[41, 23], [33, 31]]);
    m.prop('container', 37, 29);
    m.prop('dumpster', 40, 31);

    // the concourse
    m.prop('fountain', 15, 16);
    m.repeat('railing', [[13, 14], [15, 14], [17, 14], [13, 19], [15, 19], [17, 19]]);
    m.repeat('stairs', [[10, 12], [20, 20]]);
    m.repeat('bench', [[6, 12], [24, 12], [6, 21], [24, 21], [15, 11], [15, 22]]);
    m.repeat('stall', [[3, 11], [3, 21], [28, 11], [28, 21]]);
    m.repeat('vending', [[9, 16], [26, 16]]);
    m.repeat('tree', [[8, 13], [8, 19], [27, 13], [27, 19]]);
    m.repeat('pillar', [[12, 10], [23, 10], [12, 23], [23, 23], [30, 15], [30, 18]]);
    m.prop('counter', 29, 16);

    // every doorway, last
    for (let i = 0; i < 4; i++) {
      m.prop('door', i * 8 + 3, 8);  m.prop('door', i * 8 + 4, 8);
      m.prop('door', i * 8 + 3, 25); m.prop('door', i * 8 + 4, 25);
    }
    m.repeat('door', [[32, 10], [32, 11], [36, 21], [37, 21]]);
    m.repeat('door', [[0, 16], [0, 17], [43, 17], [43, 18], [43, 28], [43, 29]]);
  }),

  pfMap('overpass', 'Expressway Overpass', 'Four lanes above the city: a pileup, a span that came down, and a very long drop off either side.', 56, 26, m => {
    m.fill(0, 0, 56, 6, 'hazard');    // open air, north
    m.fill(0, 20, 56, 6, 'hazard');   // and south
    m.fill(27, 6, 3, 14, 'hazard');   // the missing span
    // crash barriers along both edges, and none where the deck is gone
    for (let c = 0; c < 56; c += 4) {
      if (c + 1 >= 26 && c <= 30) continue;
      m.prop('railing', c, 6);
      m.prop('railing', c, 19);
    }
    // central reservation
    for (let c = 2; c < 54; c += 8) {
      if (c + 1 >= 26 && c <= 30) continue;
      m.prop('barricade', c, 12);
    }
    // the pileup, west of the gap — vehicles left as cover, not as walls
    m.propOnly('bus', 8, 9);
    m.repeat('cone', [[25, 8], [25, 11], [25, 15], [25, 18]]);
    m.propOnly('car', 13, 8);
    m.propOnly('car', 6, 16);
    m.propOnly('van', 15, 15);
    m.propOnly('truck', 18, 9);
    m.propOnly('car', 22, 17, 90);
    m.repeat('fire', [[14, 12], [20, 16]]);
    m.repeat('rubble', [[12, 14], [17, 7], [23, 13], [33, 10], [36, 17]]);
    m.prop('barricade', 23, 9);
    m.prop('crater', 33, 14);
    // east of the gap: the jackknifed truck and the gantry legs
    m.propOnly('truck', 44, 12, 90);
    m.repeat('pillar', [[40, 6], [40, 19]]);
    m.repeat('streetlight', [[4, 7], [16, 7], [36, 7], [48, 7], [10, 18], [32, 18], [44, 18]]);
    m.prop('stairs', 52, 7);
    m.prop('stairs', 2, 18);
    // the planks somebody has already thrown across, last
    m.prop('bridge', 27, 9);
    m.prop('bridge', 27, 16);
  }),

  pfMap('factory', 'Abandoned Factory', 'A pillared main hall, flooded vats, two offices and a loading dock. Corners everywhere and one way out the back.', 46, 34, m => {
    m.outline(0, 0, 46, 34, 'wall');
    for (let r = 1; r < 33; r++) m.cell(30, r, 'wall');   // hall / east wing
    for (let c = 1; c < 30; c++) m.cell(c, 23, 'wall');   // hall / loading dock
    // The offices borrow the divider and the outside wall for two of their
    // own sides, so the east wing isn't two squares of wall thick.
    m.outline(30, 0, 16, 10, 'wall');    // office, upper — interior rows 1-8
    m.outline(30, 12, 16, 10, 'wall');   // office, lower — interior rows 13-20

    // the hall: a pillar grid, the vats, and the plant around them
    for (let r = 5; r <= 19; r += 7) for (let c = 5; c <= 26; c += 7) m.prop('pillar', c, r);
    m.fill(14, 15, 7, 5, 'water');
    m.repeat('railing', [[14, 14], [16, 14], [18, 14], [14, 20], [16, 20], [18, 20]]);
    m.repeat('tank', [[2, 18], [6, 18], [2, 2], [25, 2]]);
    m.repeat('pipes', [[9, 3], [9, 8], [22, 8], [22, 19]]);
    m.repeat('crate', [[12, 2], [17, 3], [27, 11], [4, 11], [8, 21]]);
    m.repeat('barrel', [[13, 10], [19, 11], [24, 15], [3, 15]]);
    m.repeat('fire', [[20, 5], [11, 18]]);
    m.repeat('rubble', [[16, 7], [23, 12], [7, 14], [26, 20]]);
    m.prop('stairs', 28, 21);
    m.prop('crater', 10, 12);

    // east wing: two offices off a cross corridor, stairwell below
    m.repeat('counter', [[33, 3], [38, 3], [33, 14], [38, 14]]);
    m.repeat('crate', [[32, 7], [43, 7], [32, 18], [43, 18]]);
    m.prop('vending', 43, 2);
    m.prop('bench', 36, 17);
    m.prop('stairs', 32, 24);
    m.repeat('rubble', [[36, 26], [41, 30]]);
    m.prop('barrel', 43, 25);
    m.prop('pipes', 40, 28);

    // loading dock
    m.propOnly('truck', 4, 26);
    m.propOnly('van', 12, 30);
    m.repeat('crate', [[2, 25], [3, 31], [10, 25], [17, 26], [18, 30], [25, 25]]);
    m.repeat('barrel', [[16, 32], [27, 31]]);
    m.prop('dumpster', 21, 32);
    m.prop('container', 24, 28);
    m.prop('pipes', 6, 32);

    // doors, last
    m.repeat('door', [[30, 10], [30, 11], [30, 28], [30, 29]]);
    m.repeat('door', [[33, 9], [34, 9], [33, 12], [34, 12], [38, 21]]);
    m.repeat('door', [[14, 23], [15, 23], [24, 23], [25, 23]]);
    m.repeat('door', [[0, 11], [0, 12], [12, 33], [13, 33], [45, 26], [45, 27]]);
  }),

  pfMap('harbor', 'Dockside Container Yard', 'Container stacks with aisles between them, two piers over open water, and the sheds behind the fence.', 52, 36, m => {
    m.fill(0, 0, 52, 9, 'water');
    m.fill(0, 9, 52, 1, 'difficult');   // the quay edge, wet and slick
    // piers — planked last-but-not-least so they clear the water beneath
    for (let r = 1; r < 9; r++) { m.prop('bridge', 9, r); m.prop('bridge', 33, r); }
    m.repeat('crate', [[9, 2], [35, 5]]);
    m.repeat('barrel', [[11, 6], [33, 2]]);

    // the yard
    pfContainerYard(m, 2, 12, 5, 3);
    pfContainerYard(m, 24, 12, 6, 2);
    m.repeat('crate', [[22, 13], [22, 18], [48, 14], [1, 21], [19, 21]]);
    m.repeat('barrel', [[21, 15], [49, 19], [12, 22]]);
    m.prop('container', 47, 22);
    m.prop('crater', 36, 21);
    m.prop('fire', 31, 20);
    m.propOnly('truck', 27, 24);
    m.propOnly('van', 4, 23);
    m.propOnly('car', 44, 23);

    // chain-link across the back of the yard, with the gate left open
    for (let c = 1; c < 51; c += 2) { if (c >= 23 && c <= 26) continue; m.prop('railing', c, 26); }

    // the sheds behind it
    m.prop('warehouse', 2, 29);
    m.prop('warehouse', 8, 29);
    m.prop('building', 14, 29);
    m.prop('warehouse', 20, 29);
    m.prop('highrise', 26, 29);
    m.prop('warehouse', 30, 29);
    m.prop('building', 36, 29);
    m.prop('house', 41, 29);
    m.prop('highrise', 45, 29);
    m.prop('watertower', 24, 32);
    m.prop('dumpster', 34, 33);
    m.prop('stall', 44, 33);
    m.prop('pipes', 13, 33);
    m.repeat('rubble', [[16, 24], [38, 25], [8, 33]]);
    m.repeat('streetlight', [[0, 11], [17, 11], [30, 11], [51, 11], [10, 27], [40, 27]]);
  }),

  pfMap('station', 'Station Platforms', 'Two tracks, the island platform between them, and the concourse behind the gates. Trains for cover, rails for danger.', 50, 28, m => {
    m.fill(0, 0, 50, 4, 'difficult');    // track bed, north
    m.fill(0, 13, 50, 4, 'difficult');   // track bed, south
    m.prop('train', 3, 1);
    m.prop('train', 10, 1);
    m.prop('train', 31, 1);
    m.prop('train', 6, 14);
    m.prop('train', 20, 14);
    m.prop('train', 38, 14);

    // the island platform, rows 4-12
    m.repeat('pillar', [[6, 5], [14, 5], [22, 5], [30, 5], [38, 5], [46, 5],
                        [6, 11], [14, 11], [22, 11], [30, 11], [38, 11], [46, 11]]);
    m.repeat('bench', [[9, 8], [18, 8], [27, 8], [36, 8], [43, 8]]);
    m.repeat('vending', [[12, 7], [33, 9]]);
    m.repeat('railing', [[2, 4], [16, 4], [24, 4], [40, 4], [2, 12], [24, 12], [40, 12]]);
    m.prop('stall', 20, 6);
    m.prop('counter', 25, 10);

    // the concourse below the platform
    m.outline(0, 17, 50, 11, 'wall');
    m.repeat('counter', [[4, 20], [10, 20], [40, 24]]);
    m.repeat('bench', [[6, 24], [14, 24], [22, 25], [30, 24]]);
    m.repeat('stall', [[18, 19], [27, 19], [35, 19]]);
    m.repeat('pillar', [[8, 22], [16, 22], [24, 22], [32, 22], [41, 22]]);
    m.prop('vending', 3, 25);
    m.prop('fountain', 45, 19);
    m.repeat('rubble', [[12, 26], [37, 26]]);

    // the stairs down and the gates, last
    m.repeat('stairs', [[10, 12], [36, 12], [10, 18], [36, 18]]);
    m.repeat('door', [[10, 17], [11, 17], [36, 17], [37, 17]]);
    m.repeat('door', [[0, 21], [0, 22], [49, 21], [49, 22], [20, 27], [21, 27], [29, 27], [30, 27]]);
  }),

  pfMap('hideout', 'Underground Hideout', 'A front bar, a back office, a storeroom and the sewer the crew leaves by. Four rooms, two ways out.', 40, 30, m => {
    m.outline(0, 0, 40, 30, 'wall');
    for (let r = 1; r <= 17; r++) m.cell(18, r, 'wall');   // bar, east wall
    for (let c = 1; c <= 18; c++) m.cell(c, 17, 'wall');   // bar, south wall
    for (let c = 19; c <= 31; c++) m.cell(c, 11, 'wall');  // office, south wall
    for (let r = 1; r <= 16; r++) m.cell(31, r, 'wall');   // storeroom, west wall
    for (let c = 32; c <= 38; c++) m.cell(c, 17, 'wall');  // storeroom, south wall
    for (let c = 1; c < 39; c++) m.cell(c, 22, 'wall');    // corridor / sewer

    // the bar
    m.repeat('counter', [[2, 3], [5, 3], [8, 3]]);
    m.repeat('barrel', [[2, 1], [11, 2]]);
    m.repeat('bench', [[3, 7], [8, 7], [13, 7], [3, 11], [8, 11], [13, 11]]);
    m.repeat('stall', [[15, 2], [15, 14]]);
    m.prop('vending', 1, 15);
    m.prop('dumpster', 11, 15);
    m.prop('fire', 16, 9);
    m.prop('pillar', 9, 9);

    // the office, and the back room under it
    m.prop('counter', 22, 2);
    m.prop('crate', 29, 2);
    m.prop('bench', 26, 8);
    m.prop('vending', 29, 9);
    m.repeat('crate', [[20, 13], [28, 15]]);
    m.prop('pipes', 24, 13);

    // the storeroom
    m.repeat('crate', [[32, 2], [34, 2], [36, 2], [32, 5], [34, 5], [36, 5], [33, 9], [36, 9]]);
    m.repeat('barrel', [[38, 3], [38, 12], [32, 13]]);
    m.prop('container', 34, 13);
    m.prop('pipes', 32, 16);

    // the corridor
    m.repeat('crate', [[20, 19], [28, 20], [35, 19]]);
    m.repeat('rubble', [[5, 20], [13, 19]]);
    m.prop('vending', 24, 18);
    m.prop('bench', 9, 21);

    // the sewer out the bottom
    m.fill(1, 25, 38, 3, 'water');
    m.repeat('pipes', [[2, 23], [30, 23], [10, 29], [34, 29]]);
    m.repeat('rubble', [[6, 24], [25, 24], [14, 28], [33, 28]]);
    m.repeat('barrel', [[4, 29], [22, 29]]);
    m.prop('fire', 28, 24);
    m.prop('stairs', 36, 23);
    for (let r = 25; r <= 27; r++) m.prop('bridge', 18, r);

    // doors, last — including the two hatches down to the water
    m.repeat('door', [[18, 8], [18, 9], [12, 17], [13, 17], [25, 11], [26, 11], [31, 6], [31, 14], [34, 17]]);
    m.repeat('door', [[18, 22], [19, 22], [33, 22]]);
    m.repeat('door', [[0, 10], [20, 0], [21, 0]]);
  }),

  pfMap('hospital', 'Hospital Ward', 'Eight ward rooms off a long corridor, a nurse station and a theatre. Beds, lifts and nowhere to take cover that isn’t someone’s.', 46, 32, m => {
    m.outline(0, 0, 46, 32, 'wall');
    const doors = [];
    doors.push(...pfRoomRow(m, 0, 0, 8, 9, 4, 'south'));    // wards, north — rows 0-8
    doors.push(...pfRoomRow(m, 0, 23, 8, 9, 4, 'north'));   // wards, south — rows 23-31
    m.outline(28, 0, 18, 14, 'wall');    // nurse station and the lifts
    m.outline(28, 18, 18, 14, 'wall');   // theatre

    // two beds and a bedside table per ward
    for (let i = 0; i < 4; i++) {
      const c = i * 7;
      m.prop('bed', c + 1, 2);  m.prop('bed', c + 1, 6);  m.prop('desk', c + 5, 4);
      m.prop('bed', c + 1, 25); m.prop('bed', c + 1, 29); m.prop('desk', c + 5, 27);
    }
    // nurse station
    m.prop('counter', 30, 3);
    m.repeat('desk', [[30, 6], [33, 6]]);
    m.prop('lockers', 30, 11);
    m.prop('vending', 44, 11);
    m.repeat('elevator', [[40, 2], [43, 2]]);
    m.prop('stairs', 36, 11);
    // theatre
    m.repeat('bed', [[32, 22], [32, 27], [40, 22], [40, 27]]);
    m.repeat('counter', [[36, 20], [36, 30]]);
    m.repeat('lockers', [[30, 25], [43, 25]]);
    // the corridor — gurneys left against the wall, and the drinks machine
    m.repeat('bed', [[10, 10], [20, 21]]);
    m.repeat('bench', [[4, 12], [14, 19], [24, 12]]);
    m.repeat('vending', [[1, 16], [26, 16]]);
    m.prop('stairs', 2, 10);

    m.repeat('door', doors);
    m.repeat('door', [[36, 13], [37, 13], [36, 18], [37, 18]]);
    m.repeat('door', [[0, 15], [0, 16], [45, 15], [45, 16]]);
  }),

  pfMap('classroom', 'U.A. Classroom Block', 'Six classrooms and a staff room off one corridor. Desks for cover, lockers for hiding behind, and a fight that will cost the school money.', 48, 30, m => {
    m.outline(0, 0, 48, 30, 'wall');
    const doors = [];
    doors.push(...pfRoomRow(m, 0, 0, 12, 10, 3, 'south'));    // rows 0-9
    doors.push(...pfRoomRow(m, 0, 20, 12, 10, 3, 'north'));   // rows 20-29
    m.outline(33, 0, 15, 14, 'wall');    // staff room
    m.outline(33, 17, 15, 13, 'wall');   // club room

    // desks, five across and three deep, facing the teacher's own
    for (let i = 0; i < 3; i++) {
      const c = i * 11;
      m.prop('counter', c + 4, 1);
      m.prop('counter', c + 4, 28);
      for (let j = 0; j < 3; j++) for (let k = 0; k < 4; k++) {
        m.prop('desk', c + 2 + k * 2, 3 + j * 2);
        m.prop('desk', c + 2 + k * 2, 22 + j * 2);
      }
    }
    // staff room
    m.repeat('desk', [[35, 2], [38, 2], [41, 2], [35, 5], [38, 5], [41, 5]]);
    m.prop('counter', 44, 8);
    m.prop('lockers', 34, 11);
    m.prop('sofa', 40, 11);
    m.prop('vending', 46, 2);
    // club room
    m.repeat('table', [[35, 19], [40, 19]]);
    m.repeat('sofa', [[35, 25], [40, 25]]);
    m.prop('lockers', 45, 27);
    m.prop('stairs', 34, 23);
    // the corridor
    m.repeat('lockers', [[2, 11], [6, 11], [14, 11], [18, 11], [26, 11], [30, 11]]);
    m.repeat('lockers', [[2, 18], [10, 18], [22, 18], [28, 18]]);
    m.repeat('bench', [[8, 14], [20, 14], [31, 15]]);
    m.repeat('vending', [[12, 11], [24, 18]]);
    m.repeat('stairs', [[1, 14], [31, 18]]);

    m.repeat('door', doors);
    m.repeat('door', [[39, 13], [40, 13], [39, 17], [40, 17]]);
    m.repeat('door', [[0, 14], [0, 15], [47, 15], [47, 16], [16, 29], [17, 29]]);
  }),

  pfMap('apartment', 'Apartment Block', 'Eight flats off a shared corridor, two stair cores, and walls thin enough that everybody hears it.', 44, 34, m => {
    m.outline(0, 0, 44, 34, 'wall');
    const doors = [];
    doors.push(...pfRoomRow(m, 0, 0, 10, 12, 4, 'south'));    // rows 0-11
    doors.push(...pfRoomRow(m, 0, 22, 10, 12, 4, 'north'));   // rows 22-33
    m.outline(36, 0, 8, 12, 'wall');     // stair core, north
    m.outline(36, 22, 8, 12, 'wall');    // stair core, south

    // furnished flat by flat, alternating the layout so they aren't identical
    for (let i = 0; i < 4; i++) {
      const c = i * 9;
      if (i % 2 === 0) {
        m.prop('sofa', c + 2, 2);  m.prop('table', c + 5, 2);  m.prop('bed', c + 2, 8);
        m.prop('counter', c + 5, 9); m.prop('desk', c + 8, 5);
        m.prop('bed', c + 2, 24);  m.prop('sofa', c + 5, 24);  m.prop('table', c + 2, 29);
        m.prop('counter', c + 5, 31); m.prop('desk', c + 8, 27);
      } else {
        m.prop('bath', c + 2, 2);  m.prop('sofa', c + 6, 5);  m.prop('bed', c + 2, 8);
        m.prop('desk', c + 6, 9);
        m.prop('bath', c + 2, 24); m.prop('sofa', c + 6, 27); m.prop('bed', c + 2, 31);
        m.prop('table', c + 6, 30);
      }
    }
    // the cores: a lift, the stairs and the mailboxes
    m.prop('elevator', 37, 1);
    m.prop('stairs', 40, 4);
    m.prop('lockers', 37, 9);
    m.prop('elevator', 37, 23);
    m.prop('stairs', 40, 26);
    m.prop('lockers', 37, 31);
    // the corridor
    m.repeat('bench', [[6, 14], [20, 19], [31, 14]]);
    m.repeat('vending', [[1, 17], [42, 17]]);
    m.repeat('rubble', [[14, 20], [26, 13]]);
    m.prop('dumpster', 17, 16);

    m.repeat('door', doors);
    m.repeat('door', [[39, 11], [40, 11], [39, 22], [40, 22]]);
    m.repeat('door', [[0, 16], [0, 17], [43, 16], [43, 17]]);
  }),

  pfMap('night-market', 'Night Market Street', 'Two rows of stalls under the awnings, carts down the middle, and a shrine gate at the end of it. Cover everywhere, room to swing nowhere.', 52, 22, m => {
    pfFrontage(m, 0, 0, 52, 0);
    pfFrontage(m, 0, 19, 52, 3);
    // stalls either side of the lane, under their awnings
    for (let i = 0; i < 6; i++) {
      const c = 2 + i * 8;
      m.prop('stall', c, 4);     m.propOnly('awning', c, 3);
      m.prop('stall', c + 4, 16); m.propOnly('awning', c + 4, 18);
    }
    // the lane
    m.repeat('foodcart', [[6, 10], [18, 11], [30, 10], [42, 11]]);
    m.repeat('crate', [[10, 9], [23, 12], [35, 9], [47, 12]]);
    m.repeat('barrel', [[13, 12], [27, 9], [39, 12]]);
    m.repeat('bench', [[8, 13], [21, 8], [33, 13], [45, 8]]);
    m.repeat('streetlight', [[4, 8], [16, 13], [28, 8], [40, 13], [50, 10]]);
    m.repeat('vending', [[1, 11], [25, 11]]);
    m.prop('torii', 48, 9);
    m.prop('tree', 48, 13);
    m.repeat('dumpster', [[12, 17], [37, 4]]);
    m.repeat('rubble', [[20, 16], [44, 5]]);
    m.propOnly('bike', 31, 13);
    m.propOnly('van', 15, 5);
  }),

  pfMap('construction', 'Half-Built High-rise', 'One floor plate of a tower that isn’t finished: no outside walls, three open shafts, and a long way down off every edge.', 42, 34, m => {
    // the edges are open air, not walls — the whole hazard of the place
    m.fill(0, 0, 42, 2, 'hazard');
    m.fill(0, 32, 42, 2, 'hazard');
    m.fill(0, 2, 2, 30, 'hazard');
    m.fill(40, 2, 2, 30, 'hazard');
    // and the shafts through the floor
    m.fill(9, 8, 4, 4, 'hazard');
    m.fill(25, 20, 5, 4, 'hazard');
    m.fill(18, 14, 3, 3, 'hazard');
    // the lift core, the only finished thing on the floor
    m.outline(17, 4, 9, 8, 'wall');
    m.prop('elevator', 19, 6);
    m.prop('stairs', 22, 9);
    m.repeat('door', [[21, 11], [22, 11]]);
    // columns on a grid, and the scaffold against the open edges
    for (let r = 5; r <= 29; r += 8) for (let c = 4; c <= 36; c += 8) m.prop('pillar', c, r);
    m.repeat('scaffold', [[2, 2], [2, 14], [2, 28], [38, 6], [38, 20], [20, 2], [32, 30]]);
    m.repeat('crate', [[6, 16], [14, 24], [30, 8], [34, 26]]);
    m.repeat('barrel', [[7, 25], [23, 16], [35, 15]]);
    m.repeat('pipes', [[5, 20], [28, 28], [12, 30]]);
    m.prop('generator', 33, 4);
    m.prop('forklift', 10, 20);
    m.prop('container', 13, 28);
    m.repeat('cone', [[9, 7], [12, 13], [24, 19], [30, 24], [17, 13], [21, 17]]);
    m.repeat('barricade', [[8, 12], [26, 19]]);
    m.repeat('rubble', [[15, 7], [22, 26], [36, 11], [7, 11]]);
    m.repeat('fire', [[31, 17]]);
    // planks across two of the shafts, last so they clear the drop
    m.prop('bridge', 9, 9);
    m.prop('bridge', 26, 21);
  }),

  pfMap('subway', 'Subway Tunnel', 'A stalled three-car train in the tube, walkways either side of the live rail, and the platform at the far end.', 54, 26, m => {
    m.outline(0, 0, 54, 26, 'wall');
    m.fill(1, 10, 52, 6, 'difficult');   // the track bed
    m.prop('train', 4, 11);
    m.prop('train', 11, 11);
    m.prop('train', 18, 11);
    // maintenance rooms off the north walkway
    m.outline(8, 0, 5, 5, 'wall');
    m.outline(30, 0, 5, 5, 'wall');
    m.repeat('crate', [[9, 2], [31, 2]]);
    m.prop('generator', 32, 3);
    // north walkway
    m.repeat('pillar', [[4, 8], [16, 8], [28, 8], [40, 8], [48, 8]]);
    m.repeat('pipes', [[2, 6], [20, 6], [44, 6]]);
    m.repeat('rubble', [[14, 7], [26, 9], [38, 6], [50, 7]]);
    m.repeat('fire', [[24, 7]]);
    m.repeat('barrel', [[6, 6], [36, 9]]);
    // south walkway
    m.repeat('pillar', [[6, 18], [14, 18], [22, 18], [30, 18]]);
    m.repeat('lockers', [[2, 24], [10, 24], [18, 24]]);
    m.repeat('rubble', [[8, 20], [20, 23], [28, 21]]);
    m.prop('pipes', 25, 24);
    // the platform, east end
    m.repeat('railing', [[38, 16], [40, 16], [44, 16], [48, 16]]);
    m.repeat('turnstile', [[42, 21], [44, 21], [46, 21]]);
    m.repeat('bench', [[38, 19], [48, 19]]);
    m.repeat('vending', [[36, 23], [51, 19]]);
    m.prop('stairs', 50, 23);
    m.prop('counter', 39, 23);

    m.repeat('door', [[10, 4], [32, 4], [0, 12], [0, 13], [53, 12], [53, 13]]);
  }),

  pfMap('holding', 'Police Holding Wing', 'Six cells along one side, three interview rooms along the other, and the squad room between you and the door.', 40, 28, m => {
    m.outline(0, 0, 40, 28, 'wall');
    const doors = [];
    // The cells' doorways are their bars, placed at the end — bars stamp cover
    // over the wall, which is both the gap and the thing standing in it — so
    // this row's generated doorways are dropped on the floor.
    pfRoomRow(m, 0, 0, 6, 7, 6, 'south');                    // cells, rows 0-6
    doors.push(...pfRoomRow(m, 0, 21, 9, 7, 3, 'north'));    // interview rooms, rows 21-27
    m.outline(30, 0, 10, 13, 'wall');    // squad room
    m.outline(24, 21, 16, 7, 'wall');    // evidence store

    for (let i = 0; i < 6; i++) m.prop('bed', i * 5 + 1, 2);
    // squad room
    m.repeat('desk', [[32, 2], [35, 2], [32, 5], [35, 5]]);
    m.prop('counter', 32, 9);
    m.prop('lockers', 37, 11);
    m.prop('vending', 38, 2);
    // interview rooms
    m.repeat('table', [[2, 23], [10, 23], [18, 23]]);
    m.repeat('desk', [[5, 25], [13, 25], [21, 25]]);
    // evidence
    m.repeat('crate', [[26, 23], [28, 23], [30, 23], [26, 26], [28, 26]]);
    m.repeat('lockers', [[33, 23], [36, 23]]);
    m.prop('container', 33, 26);
    // the corridor, and the booking desk you have to get past
    m.prop('counter', 26, 15);
    m.repeat('turnstile', [[24, 18], [26, 18]]);
    m.repeat('bench', [[4, 9], [14, 18], [20, 9]]);
    m.repeat('lockers', [[8, 19], [30, 15]]);
    m.repeat('vending', [[1, 13], [38, 17]]);
    m.prop('stairs', 2, 18);

    m.repeat('door', doors);
    m.repeat('door', [[35, 12], [31, 21], [32, 21]]);
    m.repeat('door', [[0, 16], [0, 17], [39, 19], [39, 20]]);
    // the cells are barred, not doored — placed after the doorways they sit in
    for (let i = 0; i < 6; i++) { m.prop('bars', i * 5 + 1, 6); m.prop('bars', i * 5 + 3, 6); }
  }),

  pfMap('onsen', 'Bathhouse', 'Changing rooms, the washing floor, the big bath and the rock pool outside. Everyone starts unarmed and nobody is dressed for this.', 38, 28, m => {
    m.outline(0, 0, 38, 28, 'wall');
    m.outline(0, 0, 12, 10, 'wall');     // changing room, north
    m.outline(0, 18, 12, 10, 'wall');    // changing room, south
    m.outline(11, 0, 27, 10, 'wall');    // the bath hall
    m.outline(11, 18, 27, 10, 'wall');   // the rock pool, open to the sky

    // changing rooms
    m.repeat('lockers', [[1, 1], [4, 1], [7, 1], [1, 4], [4, 4]]);
    m.repeat('bench', [[2, 7], [7, 7]]);
    m.repeat('lockers', [[1, 19], [4, 19], [7, 19], [1, 22], [4, 22]]);
    m.repeat('bench', [[2, 25], [7, 25]]);
    // the bath hall: two baths and the stools along the wall
    m.repeat('bath', [[14, 2], [19, 2], [24, 2], [29, 2]]);
    m.repeat('desk', [[13, 7], [16, 7], [19, 7], [22, 7], [25, 7], [28, 7]]);
    m.prop('counter', 33, 6);
    // the washing floor between them
    m.repeat('desk', [[14, 12], [17, 12], [20, 12], [23, 12]]);
    m.prop('counter', 2, 13);
    m.repeat('bench', [[6, 15], [30, 12]]);
    m.repeat('vending', [[1, 11], [36, 15]]);
    // the rock pool
    m.repeat('bath', [[14, 21], [19, 21], [24, 21]]);
    m.repeat('boulder', [[13, 25], [18, 25], [23, 25], [29, 24], [32, 20]]);
    m.repeat('tree', [[35, 19], [35, 26], [30, 26]]);
    m.prop('torii', 33, 22);
    m.prop('pond', 29, 19);

    m.repeat('door', [[5, 9], [6, 9], [5, 18], [6, 18]]);
    m.repeat('door', [[20, 9], [21, 9], [20, 18], [21, 18]]);
    m.repeat('door', [[11, 4], [11, 23], [0, 13], [0, 14]]);
  }),

  pfMap('mountain-road', 'Mountain Road', 'One switchback with the rock on one side and nothing at all on the other. A tunnel mouth, a tipped van, and no way round.', 52, 24, m => {
    m.fill(0, 0, 52, 5, 'wall');      // the mountainside
    m.fill(0, 19, 52, 5, 'hazard');   // the drop
    m.fill(14, 5, 6, 9, 'wall');      // spurs that make the road snake
    m.fill(33, 10, 7, 9, 'wall');
    m.fill(44, 5, 4, 6, 'wall');
    // the guardrail along the edge, where there still is one
    for (let c = 0; c < 52; c += 2) { if (c >= 26 && c <= 31) continue; m.prop('railing', c, 18); }
    m.repeat('rubble', [[24, 17], [28, 18], [30, 16]]);   // where it went over
    m.repeat('boulder', [[8, 7], [21, 15], [41, 7], [49, 14], [12, 16]]);
    m.repeat('tree', [[3, 6], [11, 6], [25, 7], [31, 6], [43, 16], [50, 6]]);
    m.prop('bigtree', 5, 14);
    m.repeat('bush', [[9, 12], [23, 9], [38, 8], [46, 16]]);
    m.propOnly('van', 20, 10, 90);
    m.propOnly('car', 36, 7);
    m.repeat('cone', [[25, 16], [33, 9], [34, 9]]);
    m.prop('barricade', 29, 15);
    m.repeat('rubble', [[16, 14], [36, 19], [44, 12]]);
    m.prop('torii', 2, 10);
    m.prop('streetlight', 42, 17);
    m.prop('fire', 22, 12);
    // the tunnel mouth, last — it cuts the rock
    m.repeat('door', [[49, 4], [50, 4], [49, 3], [50, 3], [49, 2], [50, 2], [49, 1], [50, 1], [49, 0], [50, 0]]);
  }),

];

const BOARD_MAPS_BY_KEY = Object.fromEntries(BOARD_MAPS.map(mp => [mp.key, mp]));
