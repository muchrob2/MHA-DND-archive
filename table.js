// Page logic for table.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// Runs after auth.js, so fbAuthReady/isAdmin/canEdit are already defined.
//
// ── What this page is ───────────────────────────────────────────────
// The fight, from a player's seat. Whose turn it is, who is next, the order,
// and what is wrong with everybody — live, on your own phone, while the DM
// runs the Encounter Manager on theirs.
//
// The board already shows where everyone is standing. It does not show the
// turn order, and "am I next?" is the question a player asks most often at a
// table and the one nobody can answer by looking at a grid.
//
// ── What it deliberately does NOT show ─────────────────────────────
// An enemy's exact hit points. The DM has those in the Encounter Manager; a
// player screen printing "14 of 30" turns every fight into arithmetic and
// takes the guessing out of it. Enemies get a band — Untouched, Hurt,
// Bloodied, Down — and the page says that is what it is doing. Your own side
// gets real numbers, because those are yours.
//
// ── Read-only, and not by convention ───────────────────────────────
// encounter-state is admin-only to write in firestore.rules, the same as
// masaranking and heat. This page has no write path at all, and could not
// have one that worked.

const db = firebase.firestore();
const FS_ENCOUNTER = db.collection('mha-dnd').doc('encounter-state');

let enc = { round: 1, currentIndex: 0, combatants: [], attackLog: [] };
let loaded = false;
let mineNames = [];     // the characters this viewer owns, by name
let isDm = false;
let showExact = false;  // the DM, or a toggle for a table that wants it

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── The order ──────────────────────────────────────────────────────
   The Encounter Manager keeps `combatants` sorted by initiative and points
   `currentIndex` into it, so the order on this page is the array as it
   arrives. It is NOT re-sorted here: re-sorting would renumber the turns and
   the index would then point at somebody else.
   ─────────────────────────────────────────────────────────────────── */

function order() {
  return Array.isArray(enc.combatants) ? enc.combatants : [];
}

function currentIdx() {
  const n = order().length;
  if (!n) return -1;
  const i = Number(enc.currentIndex);
  return Number.isFinite(i) ? ((i % n) + n) % n : 0;
}

function current() {
  const i = currentIdx();
  return i >= 0 ? order()[i] : null;
}

// Who goes after the current turn, wrapping round the table.
function upNext() {
  const list = order();
  if (list.length < 2) return null;
  return list[(currentIdx() + 1) % list.length];
}

function isMine(c) {
  if (!c || !c.name) return false;
  return mineNames.includes(String(c.name));
}

/* ── Health, without giving the game away ───────────────────────────
   A band rather than a number for anybody who is not yours. The thresholds
   are the ones a table already uses out loud: bloodied is half, and "down"
   is nothing left.
   ─────────────────────────────────────────────────────────────────── */
const HP_BANDS = [
  { at: 0, id: 'down', label: 'Down' },
  { at: 0.25, id: 'critical', label: 'Critical' },
  { at: 0.5, id: 'bloodied', label: 'Bloodied' },
  { at: 0.999, id: 'grazed', label: 'Grazed' },
  { at: Infinity, id: 'untouched', label: 'Untouched' },
];

function hpFraction(c) {
  const max = Number(c.maxHp);
  const hp = Number(c.hp);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(hp)) return null;
  return Math.max(0, Math.min(1, hp / max));
}

function hpBand(c) {
  const f = hpFraction(c);
  if (f == null) return { id: 'unknown', label: 'Unknown' };
  if (f === 0) return HP_BANDS[0];
  return HP_BANDS.find(b => f <= b.at) || HP_BANDS[HP_BANDS.length - 1];
}

// Exact numbers for your own side and for the DM; a band for everybody else.
function hpText(c) {
  if (showExact || isMine(c) || c.isPC) {
    const hp = Number(c.hp);
    const max = Number(c.maxHp);
    if (!Number.isFinite(hp) || !Number.isFinite(max)) return hpBand(c).label;
    return hp + ' / ' + max + (Number(c.tempHp) ? ' +' + c.tempHp : '');
  }
  return hpBand(c).label;
}

/* ── What the conditions mean for you ───────────────────────────────
   The payoff of the conditions being mechanics rather than decoration: this
   page can say what an attack on somebody would roll with, from the same
   table the DM's tracker rolls against and the Rules page prints.

   It answers it from the CURRENT character's point of view where that
   character is yours, because "would MY attack have advantage" is the
   question, not "would anybody's".
   ─────────────────────────────────────────────────────────────────── */
function attackAdviceOn(target) {
  if (typeof rulesAttackMode !== 'function') return null;
  const attacker = current();
  if (!attacker || !target || attacker.id === target.id) return null;
  // Same team, so it is not a target.
  if (attacker.team != null && target.team != null && attacker.team === target.team) return null;
  const mode = rulesAttackMode(attacker.conditions || [], target.conditions || []);
  if (mode.mode === 'none' && !mode.asks.length && !mode.cancelled) return null;
  return mode;
}

function conditionTitle(name) {
  if (typeof rulesConditionMap !== 'function') return name;
  const text = rulesConditionMap()[name];
  return text ? name + ' — ' + text : name;
}

/* ── Load and stay in step ── */

async function load() {
  try {
    await fbAuthReady;
    const snap = await FS_ENCOUNTER.get();
    if (snap.exists) enc = snap.data();
  } catch (e) {
    console.error('[table] could not read the encounter:', e);
  }
  loaded = true;
}

function liveSync() {
  FS_ENCOUNTER.onSnapshot(snap => {
    if (!snap.exists) return;
    // A cached snapshot is this tab's own stale copy rather than news from
    // the server — the same guard the board and the Heat page use.
    if (snap.metadata && snap.metadata.fromCache) return;
    enc = snap.data();
    loaded = true;
    render();
  }, err => console.error('[table] live sync stopped:', err));
}

async function whoAmI() {
  await fbAuthReady;
  isDm = !!(window.isAdmin && window.isAdmin());
  showExact = isDm;
  // Which characters are yours, by name, so the page can say "your turn"
  // rather than making you find your own row. Same ownership check as the
  // Lab and the Class 1-A toolkit.
  try {
    const roster = await fetch('CLASS-1A/roster.json').then(r => r.json());
    mineNames = ((roster && roster.students) || [])
      .map(s => s.name)
      .filter(name => name && window.canEdit
        && window.canEdit(fbCharacterKey('Student (1-A)', name)));
  } catch {}
}

function toggleExact() {
  showExact = !showExact;
  render();
}

/* ── Render ── */

function headerHtml() {
  const list = order();
  if (!list.length) {
    return `<div class="tb-idle">
      <div class="tb-idle-title">No fight running</div>
      <div class="tb-idle-text">When the DM starts an encounter it appears here, live. Leave this open on your phone.</div>
    </div>`;
  }
  const now = current();
  const next = upNext();
  const yours = isMine(now);
  const yoursNext = isMine(next);

  return `<div class="tb-now${yours ? ' is-yours' : ''}">
      <div class="tb-round">Round ${escHtml(enc.round == null ? 1 : enc.round)}</div>
      <div class="tb-now-label">${yours ? 'Your turn' : 'Up now'}</div>
      <div class="tb-now-name">${escHtml((now && now.name) || '—')}</div>
      ${next ? `<div class="tb-next${yoursNext ? ' is-yours' : ''}">
        ${yoursNext ? 'You are next' : 'Next'} · ${escHtml(next.name || '—')}
      </div>` : ''}
    </div>`;
}

function conditionsHtml(c) {
  const conds = Array.isArray(c.conditions) ? c.conditions : [];
  if (!conds.length) return '';
  return `<div class="tb-conds">${conds.map(n =>
    `<span class="tb-cond" title="${escHtml(conditionTitle(n))}">${escHtml(n)}</span>`).join('')}</div>`;
}

function adviceHtml(c) {
  const mode = attackAdviceOn(c);
  if (!mode) return '';
  const label = mode.mode === 'adv' ? 'attacks on them have advantage'
    : mode.mode === 'dis' ? 'attacks on them have disadvantage'
    : mode.mode === 'cannot' ? mode.reasons[0]
    : mode.cancelled ? 'advantage and disadvantage cancel'
    : '';
  const bits = [];
  if (label) bits.push(label);
  for (const ask of (mode.asks || [])) bits.push(ask);
  if (!bits.length) return '';
  return `<div class="tb-advice mode-${escHtml(mode.mode)}">${escHtml(bits.join(' · '))}</div>`;
}

function rowHtml(c, i) {
  const isNow = i === currentIdx();
  const band = hpBand(c);
  const f = hpFraction(c);
  const mine = isMine(c);
  return `<div class="tb-row${isNow ? ' is-now' : ''}${mine ? ' is-mine' : ''}${band.id === 'down' ? ' is-down' : ''}"
      ${c.team != null ? `data-team="${escHtml(c.team)}"` : ''}>
      <div class="tb-init" title="Initiative">${escHtml(c.initiative == null ? '—' : c.initiative)}</div>
      <div class="tb-body">
        <div class="tb-name-row">
          <span class="tb-name">${escHtml(c.name || 'Unnamed')}</span>
          ${mine ? '<span class="tb-you">you</span>' : ''}
          ${c.isPC && !mine ? '<span class="tb-pc">class</span>' : ''}
          ${c.ac != null ? `<span class="tb-ac" title="Armour class">AC ${escHtml(c.ac)}</span>` : ''}
        </div>
        <div class="tb-hp">
          <div class="tb-hp-bar band-${escHtml(band.id)}">
            <span style="width:${f == null ? 0 : Math.round(f * 100)}%"></span>
          </div>
          <span class="tb-hp-text">${escHtml(hpText(c))}</span>
        </div>
        ${conditionsHtml(c)}
        ${adviceHtml(c)}
      </div>
    </div>`;
}

function logHtml() {
  const log = Array.isArray(enc.attackLog) ? enc.attackLog : [];
  if (!log.length) return '<p class="tb-empty">No attacks yet.</p>';
  return log.slice(0, 6).map(e => {
    if (!e.target) {
      return `<div class="tb-log"><span class="tb-log-who">${escHtml(e.attacker)}</span> — no valid targets</div>`;
    }
    if (e.cannot) {
      return `<div class="tb-log"><span class="tb-log-who">${escHtml(e.attacker)}</span>
        <span class="tb-log-res">no attack</span>
        <span class="tb-log-why">${escHtml(e.cannot)}</span></div>`;
    }
    const hit = e.roll >= e.ac;
    const crit = e.roll === 20;
    const fumble = e.roll === 1;
    const word = crit ? 'crit' : fumble ? 'fumble' : hit ? 'hit' : 'miss';
    const die = e.advMode
      ? `${e.advMode === 'adv' ? 'adv' : 'dis'} ${e.roll}${e.dropped == null ? '' : ' / ' + e.dropped}`
      : `d20 ${e.roll}`;
    return `<div class="tb-log">
      <span class="tb-log-who">${escHtml(e.attacker)}</span>
      <span style="color:var(--text-dim)">→</span>
      <span class="tb-log-who">${escHtml(e.target)}</span>
      <span class="tb-log-res is-${word}">${escHtml(die)} · ${word}</span>
      ${e.reasons && e.reasons.length ? `<span class="tb-log-why">${escHtml(e.reasons.join(' and '))}</span>` : ''}
    </div>`;
  }).join('');
}

function render() {
  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  if (!loaded) {
    set('tb-header', '<p class="tb-empty">Looking for a fight…</p>');
    return;
  }
  set('tb-header', headerHtml());
  const list = order();
  set('tb-order', list.length ? list.map(rowHtml).join('') : '');
  set('tb-log', list.length ? logHtml() : '');

  const note = document.getElementById('tb-hp-note');
  if (note) {
    note.textContent = showExact
      ? 'Showing exact hit points for everybody.'
      : 'Your side shows real numbers. Everybody else shows a band — the DM has their hit points, and this page is not going to do the arithmetic for you.';
  }
  const btn = document.getElementById('tb-exact-btn');
  if (btn) {
    btn.textContent = showExact ? 'Hide enemy hit points' : 'Show enemy hit points';
    btn.style.display = isDm ? '' : 'none';
  }
  const count = document.getElementById('tb-count');
  if (count) count.textContent = list.length ? `${list.length} in the fight` : '';
}

(async () => {
  render();
  await load();
  await whoAmI();
  render();
  liveSync();
})();
