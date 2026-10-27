// Page logic for heat.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// Runs after auth.js, so fbAuthReady/isAdmin are already defined.
//
// ── What this page is ───────────────────────────────────────────────
// The Heat track, which the campaign says should be "on a strip of paper the
// players can see." This is that strip, plus the two things paper cannot do:
// it tells the class what is coming before it arrives, and it keeps the
// record that Heat is supposed to be a consequence of.
//
// Three parts:
//   1. THE TRACK — 0 to 10, the current band, the chapter's cap, and who is
//      home at this level.
//   2. WHAT IS COMING — the next band, named, and from Heat 7 an explicit
//      warning, because the point of Heat is that the class can see it
//      rising. At 9 the page says what lands on the doormat at 10.
//   3. THE RECORD — every Byakko the campaign names, who has beaten whom,
//      and a win-loss line per character. "You are what you have beaten" is
//      the first rule of the Law, so this is the Law as a scoreboard.
//
// ── Who can change it ───────────────────────────────────────────────
// Everybody can read it; only an admin can move it. That is deliberate and
// it matches masaranking: Heat decides whether a Corner comes down, and a
// player nudging it to 10 to summon the White Tiger is not a thing the
// campaign should allow. firestore.rules enforces it rather than this page —
// hiding the buttons would not be enough, because every player holds an
// editor role.
//
// Anybody may roll the d6, because a die is a die.

const db = firebase.firestore();
const FS_HEAT_DOC = db.collection('mha-dnd').doc('heat');
const LS_HEAT = 'mha-heat-v1';

// The shape of the document. A fresh table starts at Chapter 6, because that
// is where Heat carries over from and where the caps stop.
function emptyHeat() {
  return {
    heat: 0,
    chapter: 6,
    seventhRule: '',
    log: [],        // newest first: { id, at, delta, from, to, reason }
    beaten: {},     // byakko member id -> { at, by }
    fights: [],     // newest first: { id, at, pc, opponent, rank, result, where }
    ranks: [],      // { pc, rank, street, since }
  };
}

let heatDoc = emptyHeat();
let heatCanEdit = false;      // fail closed until the admin check resolves
let _lastSyncedHeat = null;
let heatSaveTimer = null;
let heatSavePending = false;
let heatD6 = null;            // the last "do Byakko find them" roll

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function heatId() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/* ── Storage ────────────────────────────────────────────────────────
   localStorage always and synchronously, so the strip paints instantly and
   works signed out; Firestore when there is write access, so the whole table
   sees the same number. Per-item merge on the three arrays, the same as the
   encounter board, so two tabs logging different fights cannot clobber each
   other's.
   ─────────────────────────────────────────────────────────────────── */
function heatSave() {
  try { localStorage.setItem(LS_HEAT, JSON.stringify(heatDoc)); } catch {}
  if (!heatCanEdit) return;
  heatSavePending = true;
  clearTimeout(heatSaveTimer);
  heatSaveTimer = setTimeout(async () => {
    try {
      _lastSyncedHeat = await fsMergeSave(FS_HEAT_DOC, heatDoc, _lastSyncedHeat, [
        { path: 'log', idKey: 'id' },
        { path: 'fights', idKey: 'id' },
      ]);
    } catch (e) {
      // Said out loud rather than swallowed: writes to this doc are
      // admin-only, so a failed one is invisible — the change stays on
      // screen until the next snapshot replaces it with the server's copy.
      console.error('[heat] save failed — this change will revert on the next sync:', e);
    } finally {
      heatSavePending = false;
    }
  }, 500);
}

async function heatLoad() {
  try {
    const raw = localStorage.getItem(LS_HEAT);
    if (raw) heatDoc = Object.assign(emptyHeat(), JSON.parse(raw));
  } catch {}
  try {
    await fbAuthReady;
    const snap = await FS_HEAT_DOC.get();
    if (snap.exists) {
      heatDoc = Object.assign(emptyHeat(), snap.data());
      _lastSyncedHeat = fsCloneDoc(heatDoc); // cloned: a baseline must never alias live state
    }
  } catch {}
}

async function heatLiveSync() {
  try {
    await fbAuthReady;
    FS_HEAT_DOC.onSnapshot(snap => {
      if (!snap.exists) return;
      // A cached snapshot is this tab's own stale copy, not news from the
      // server — see the same guard on the board and in relationships.html.
      if (snap.metadata && snap.metadata.fromCache) return;
      if (heatSavePending) return;
      heatDoc = Object.assign(emptyHeat(), snap.data());
      _lastSyncedHeat = fsCloneDoc(heatDoc);
      render();
    }, err => console.error('[heat] live sync stopped:', err));
  } catch {}
}

/* ── Moving the needle ── */

function heatLevel() {
  return heatClamp(heatDoc.heat, heatDoc.chapter);
}

// Every change is logged with what caused it, because a number that moved
// for a reason nobody wrote down is a number the table stops trusting.
function applyDelta(delta, reason) {
  if (!heatCanEdit) return;
  const from = heatLevel();
  const to = heatClamp(from + delta, heatDoc.chapter);
  heatDoc.heat = to;
  heatDoc.log = [{
    id: heatId(), at: Date.now(), delta: to - from, from, to, reason: String(reason || ''),
  }].concat(heatDoc.log || []).slice(0, 60);
  heatSave();
  render();
}

function trigger(id) {
  const t = HEAT_TRIGGERS.find(x => x.id === id);
  if (t) applyDelta(t.delta, t.label);
}

function nudge(delta) {
  applyDelta(delta, delta > 0 ? 'Set by hand, up' : 'Set by hand, down');
}

function setChapter(value) {
  if (!heatCanEdit) return;
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  heatDoc.chapter = n;
  // A cap can only ever lower Heat, and if it does the log should say so
  // rather than leaving the players wondering where two points went.
  const clamped = heatClamp(heatDoc.heat, n);
  if (clamped !== heatDoc.heat) {
    const from = heatDoc.heat;
    heatDoc.heat = clamped;
    heatDoc.log = [{
      id: heatId(), at: Date.now(), delta: clamped - from, from, to: clamped,
      reason: `Chapter ${n} caps Heat at ${heatCapFor(n)}`,
    }].concat(heatDoc.log || []).slice(0, 60);
  }
  heatSave();
  render();
}

function undoLast() {
  if (!heatCanEdit) return;
  const log = heatDoc.log || [];
  if (!log.length) return;
  const last = log[0];
  heatDoc.heat = heatClamp(last.from, heatDoc.chapter);
  heatDoc.log = log.slice(1);
  heatSave();
  render();
}

/* ── The record ── */

function toggleBeaten(memberId) {
  if (!heatCanEdit) return;
  heatDoc.beaten = heatDoc.beaten || {};
  if (heatDoc.beaten[memberId]) {
    delete heatDoc.beaten[memberId];
  } else {
    heatDoc.beaten[memberId] = { at: Date.now(), by: '' };
  }
  heatSave();
  render();
}

function logFight(result) {
  if (!heatCanEdit) return;
  const pc = (document.getElementById('heat-fight-pc') || {}).value || '';
  const opponent = (document.getElementById('heat-fight-opp') || {}).value || '';
  const where = (document.getElementById('heat-fight-where') || {}).value || '';
  if (!pc.trim()) {
    const f = document.getElementById('heat-fight-feedback');
    if (f) f.textContent = 'Who fought?';
    return;
  }
  const hit = byakkoMember(opponent);
  heatDoc.fights = [{
    id: heatId(), at: Date.now(), pc: pc.trim(),
    opponent: hit ? hit.member.name : opponent.trim(),
    rank: hit ? hit.rank.name : '',
    ranked: !!hit,
    result,
    where: where.trim(),
  }].concat(heatDoc.fights || []).slice(0, 200);

  // Beating a ranked member is both a record and a Heat trigger, and the
  // campaign is explicit that Strays do not count — so the page only offers
  // the Heat change when the opponent is somebody it recognises.
  if (result === 'win' && hit) {
    heatDoc.beaten = heatDoc.beaten || {};
    if (!heatDoc.beaten[hit.member.id]) {
      heatDoc.beaten[hit.member.id] = { at: Date.now(), by: pc.trim() };
    }
  }
  const opp = document.getElementById('heat-fight-opp');
  if (opp) opp.value = '';
  const feedback = document.getElementById('heat-fight-feedback');
  if (feedback) {
    feedback.textContent = result === 'win' && hit
      ? `Logged. That is +1 Heat if it was witnessed.`
      : 'Logged.';
  }
  heatSave();
  render();
}

function deleteFight(id) {
  if (!heatCanEdit) return;
  heatDoc.fights = (heatDoc.fights || []).filter(f => f.id !== id);
  heatSave();
  render();
}

// Overall and per character. Draws are counted and kept out of the ratio,
// because a ratio that silently treats a draw as half a win is a ratio
// nobody can check.
function fightRecord(pc) {
  const fights = (heatDoc.fights || []).filter(f => !pc || f.pc === pc);
  const wins = fights.filter(f => f.result === 'win').length;
  const losses = fights.filter(f => f.result === 'loss').length;
  const draws = fights.filter(f => f.result === 'draw').length;
  const decided = wins + losses;
  return {
    wins, losses, draws, decided,
    ranked: fights.filter(f => f.result === 'win' && f.ranked).length,
    ratio: decided ? wins / decided : null,
  };
}

function pcNames() {
  return [...new Set((heatDoc.fights || []).map(f => f.pc).filter(Boolean))].sort();
}

function beatenCount() {
  return Object.keys(heatDoc.beaten || {}).length;
}

/* ── The d6 ──────────────────────────────────────────────────────────
   "A PC who wanders into Byakko turf rolls a d6 at the start of the slot: on
   1–3, Byakko find them, at the current Heat. Outside the turf, once Heat is
   4 or more, a 1 on a d6 means Byakko come to them."

   Rolled through the shared engine, like every other die on the site.
   ─────────────────────────────────────────────────────────────────── */
function rollFind(where) {
  const roll = diceRoll(diceParse('1d6')).total;
  const inTurf = where === 'turf';
  const threshold = inTurf ? 3 : (heatLevel() >= 4 ? 1 : 0);
  heatD6 = {
    roll, inTurf, threshold,
    found: threshold > 0 && roll <= threshold,
    // Outside the turf below Heat 4 there is no roll to make, and saying so
    // is more use than printing a die nobody should have thrown.
    noRoll: !inTurf && heatLevel() < 4,
  };
  render();
}

/* ── Render ── */

function trackHtml() {
  const level = heatLevel();
  const cap = heatCapFor(heatDoc.chapter);
  const band = heatBandFor(level);
  const cells = [];
  for (let n = HEAT_MIN; n <= HEAT_MAX; n++) {
    const b = heatBandFor(n);
    const capped = cap != null && n > cap;
    cells.push(`<div class="ht-cell mood-${escHtml(b.mood)}${n === level ? ' is-now' : ''}${n < level ? ' is-past' : ''}${capped ? ' is-capped' : ''}"
      title="${escHtml(b.who)}">${n}</div>`);
  }
  return `<div class="ht-track" role="img" aria-label="Heat ${level} of ${HEAT_MAX}">${cells.join('')}</div>
    <div class="ht-track-foot">
      <span class="ht-now mood-${escHtml(band.mood)}">Heat ${level}</span>
      ${cap != null ? `<span class="ht-cap">Chapter ${escHtml(heatDoc.chapter)} caps it at ${cap}</span>`
        : `<span class="ht-cap">No cap in Chapter ${escHtml(heatDoc.chapter)}</span>`}
    </div>`;
}

function whoHtml() {
  const band = heatBandFor(heatLevel());
  return `<div class="ht-who mood-${escHtml(band.mood)}">
      <div class="ht-who-label">Who shows up at Heat ${heatLevel()}</div>
      <div class="ht-who-text">${escHtml(band.who)}</div>
      ${band.extended ? `<div class="ht-who-ext"><span>From Chapter 7</span>${escHtml(band.extended)}</div>` : ''}
    </div>`;
}

// The tease. This is the part paper cannot do: the class can see the next
// band named before they are standing in it, which is the whole reason the
// campaign says to put the track where the players can see it.
function comingHtml() {
  const level = heatLevel();
  const next = heatNextBand(level);
  const cap = heatCapFor(heatDoc.chapter);
  const blocked = cap != null && next && next.from > cap;

  if (!next) {
    return `<div class="ht-coming is-max">
      <div class="ht-coming-label">The top of the track</div>
      <div class="ht-coming-text">A note on the Heights Alliance doormat, in white paint. The roof, at one in the morning, and a choice that is the encounter.</div>
    </div>`;
  }
  const away = next.from - level;
  const tone = level >= 8 ? 'is-hot' : level >= 6 ? 'is-warm' : 'is-cool';
  return `<div class="ht-coming ${tone}">
      <div class="ht-coming-label">${away === 1 ? 'One more point' : away + ' more points'} and</div>
      <div class="ht-coming-text">${escHtml(next.who)}</div>
      ${blocked ? `<div class="ht-coming-note">Not this chapter — the cap holds it at ${cap}.</div>`
        : level >= 8 ? '<div class="ht-coming-note">Then the note on the doormat.</div>'
        : level >= 6 ? '<div class="ht-coming-note">The Corners come down at 8, and each one asks for somebody by name.</div>' : ''}
    </div>`;
}

function triggersHtml() {
  if (!heatCanEdit) {
    return `<p class="ht-readonly">The track is the DM's to move. Everything on this page updates for everybody the moment they do.</p>`;
  }
  return `<div class="ht-triggers">
      ${HEAT_TRIGGERS.map(t => `<button class="ht-trigger ${t.delta > 0 ? 'up' : 'down'}"
        onclick="trigger('${escHtml(t.id)}')" title="${escHtml(t.note)}">
        <span class="ht-trigger-delta">${t.delta > 0 ? '+' + t.delta : t.delta}</span>
        <span class="ht-trigger-label">${escHtml(t.label)}</span>
      </button>`).join('')}
    </div>
    <div class="ht-manual">
      <button onclick="nudge(-1)" title="Down one, by hand">−1</button>
      <button onclick="nudge(1)" title="Up one, by hand">+1</button>
      <button onclick="undoLast()" ${(heatDoc.log || []).length ? '' : 'disabled'}>Undo last</button>
      <label class="ht-chapter">Chapter
        <select onchange="setChapter(this.value)">
          ${[2, 3, 4, 5, 6, 7, 8].map(n =>
            `<option value="${n}"${Number(heatDoc.chapter) === n ? ' selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
    </div>`;
}

function d6Html() {
  const level = heatLevel();
  const out = !heatD6 ? '' : heatD6.noRoll
    ? `<div class="ht-d6-out">No roll outside the turf below Heat 4 — Byakko do not come to you yet.</div>`
    : `<div class="ht-d6-out ${heatD6.found ? 'is-found' : ''}">
        <strong>${heatD6.roll}</strong>
        ${heatD6.found
          ? `Byakko find you, at Heat ${level}. ${escHtml(heatBandFor(level).who)}`
          : `Nothing today. (${heatD6.inTurf ? '1–3' : '1'} would have found you.)`}
      </div>`;
  return `<div class="ht-d6">
      <button onclick="rollFind('turf')">Roll d6 — in the turf</button>
      <button onclick="rollFind('out')">Roll d6 — outside it</button>
      <span class="ht-d6-rule">In the turf: 1–3 and they find you. Outside: only from Heat 4, and only on a 1.</span>
    </div>${out}`;
}

function recordHtml() {
  const all = fightRecord(null);
  const names = pcNames();
  return `<div class="ht-record">
      <div class="ht-stat">
        <div class="ht-stat-num">${all.wins}–${all.losses}${all.draws ? '–' + all.draws : ''}</div>
        <div class="ht-stat-label">Record${all.draws ? ' (W–L–D)' : ' (W–L)'}</div>
      </div>
      <div class="ht-stat">
        <div class="ht-stat-num">${all.ratio == null ? '—' : Math.round(all.ratio * 100) + '%'}</div>
        <div class="ht-stat-label">Win rate${all.draws ? ', draws excluded' : ''}</div>
      </div>
      <div class="ht-stat">
        <div class="ht-stat-num">${beatenCount()}<span class="ht-stat-of">/${byakkoAllMembers().length}</span></div>
        <div class="ht-stat-label">Named Byakko beaten</div>
      </div>
      <div class="ht-stat">
        <div class="ht-stat-num">${all.ranked}</div>
        <div class="ht-stat-label">Ranked wins, witnessed or not</div>
      </div>
    </div>
    ${names.length ? `<table class="ht-pcs">
      <thead><tr><th>Character</th><th>W</th><th>L</th>${all.draws ? '<th>D</th>' : ''}<th>Rate</th><th>Ranked</th></tr></thead>
      <tbody>${names.map(n => {
        const r = fightRecord(n);
        return `<tr><td class="ht-pc-name">${escHtml(n)}</td><td>${r.wins}</td><td>${r.losses}</td>${all.draws ? `<td>${r.draws}</td>` : ''}
          <td>${r.ratio == null ? '—' : Math.round(r.ratio * 100) + '%'}</td><td>${r.ranked}</td></tr>`;
      }).join('')}</tbody>
    </table>` : '<p class="ht-empty">No fights logged yet.</p>'}`;
}

function gangHtml() {
  return BYAKKO_RANKS.map(rank => `<section class="ht-rank">
      <header class="ht-rank-head">
        <h3 class="ht-rank-name">${escHtml(rank.name)}</h3>
        <span class="ht-rank-stripes" title="${escHtml(rank.stripes)} stripe${rank.stripes === 1 ? '' : 's'} on the inside of the left forearm">${'▌'.repeat(rank.stripes)}</span>
        <span class="ht-rank-count">${rank.members.filter(m => (heatDoc.beaten || {})[m.id]).length}/${rank.members.length}</span>
      </header>
      <p class="ht-rank-about">${escHtml(rank.about)}</p>
      <div class="ht-members">
        ${rank.members.map(m => {
          const beaten = (heatDoc.beaten || {})[m.id];
          return `<div class="ht-member${beaten ? ' is-beaten' : ''}"
            ${heatCanEdit ? `onclick="toggleBeaten('${escHtml(m.id)}')" role="button" tabindex="0"
              onkeydown="if(event.key==='Enter'||event.key===' ')toggleBeaten('${escHtml(m.id)}')"` : ''}>
            <div class="ht-member-top">
              <span class="ht-member-name">${escHtml(m.name)}</span>
              ${m.alias ? `<span class="ht-member-alias">"${escHtml(m.alias)}"</span>` : ''}
              ${beaten ? '<span class="ht-member-tick">beaten</span>' : ''}
            </div>
            <div class="ht-member-note">${escHtml(m.note)}</div>
            ${beaten && beaten.by ? `<div class="ht-member-by">by ${escHtml(beaten.by)}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </section>`).join('');
}

function fightFormHtml() {
  if (!heatCanEdit) return '';
  const opts = byakkoAllMembers()
    .map(m => `<option value="${escHtml(m.id)}">${escHtml(m.name)}${m.alias ? ' — "' + escHtml(m.alias) + '"' : ''} (${escHtml(m.rank.name)})</option>`)
    .join('');
  return `<div class="ht-fight-form">
      <input id="heat-fight-pc" type="text" placeholder="Which character" aria-label="Which character fought">
      <select id="heat-fight-opp" aria-label="Who they fought">
        <option value="">Opponent — unranked or a Stray</option>
        ${opts}
      </select>
      <input id="heat-fight-where" type="text" placeholder="Where (optional)" aria-label="Where the fight happened">
      <button class="ht-win" onclick="logFight('win')">Won</button>
      <button class="ht-loss" onclick="logFight('loss')">Lost</button>
      <button onclick="logFight('draw')">Draw</button>
      <span id="heat-fight-feedback" class="ht-feedback"></span>
    </div>`;
}

function when(ts) {
  const d = new Date(Number(ts) || 0);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString() : '';
}

function logHtml() {
  const log = heatDoc.log || [];
  const fights = heatDoc.fights || [];
  return `<div class="ht-logs">
      <div class="ht-log-col">
        <h3 class="ht-h3">Why Heat is where it is</h3>
        ${log.length ? log.slice(0, 20).map(e => `<div class="ht-log-row">
          <span class="ht-log-delta ${e.delta > 0 ? 'up' : e.delta < 0 ? 'down' : ''}">${e.delta > 0 ? '+' + e.delta : e.delta}</span>
          <span class="ht-log-reason">${escHtml(e.reason)}</span>
          <span class="ht-log-to">${e.from} → ${e.to}</span>
          <span class="ht-log-when">${escHtml(when(e.at))}</span>
        </div>`).join('') : '<p class="ht-empty">Nothing has moved it yet.</p>'}
      </div>
      <div class="ht-log-col">
        <h3 class="ht-h3">Fights</h3>
        ${fights.length ? fights.slice(0, 20).map(f => `<div class="ht-log-row">
          <span class="ht-log-res is-${escHtml(f.result)}">${escHtml(f.result)}</span>
          <span class="ht-log-reason">${escHtml(f.pc)} v ${escHtml(f.opponent || 'unranked')}${f.rank ? ' (' + escHtml(f.rank) + ')' : ''}</span>
          <span class="ht-log-when">${escHtml(f.where || '')} ${escHtml(when(f.at))}</span>
          ${heatCanEdit ? `<button class="ht-del" onclick="deleteFight('${escHtml(f.id)}')" title="Remove this fight">✕</button>` : ''}
        </div>`).join('') : '<p class="ht-empty">No fights logged yet.</p>'}
      </div>
    </div>`;
}

function lawHtml() {
  const seventh = (heatDoc.seventhRule || '').trim();
  return `<ol class="ht-law">
      ${BYAKKO_LAW.map((r, i) => `<li${i === 5 ? ' class="ht-law-sixth"' : ''}>${escHtml(r)}</li>`).join('')}
      ${seventh ? `<li class="ht-law-seventh">${escHtml(seventh)}</li>` : ''}
    </ol>
    <p class="ht-law-note">
      The sixth is in a different hand — Hakuro Mitsuki wrote it herself.
      ${seventh ? 'The seventh is in your class\'s handwriting, on the wall inside the Cage\'s front door.'
        : 'If the class write a seventh in Chapter 7, Madame Tsuru\'s suggested wording is ' + escHtml(BYAKKO_SEVENTH_SUGGESTION)}
    </p>
    ${heatCanEdit ? `<div class="ht-seventh-edit">
      <input id="heat-seventh" type="text" placeholder="${escHtml(BYAKKO_SEVENTH_SUGGESTION)}"
        value="${escHtml(seventh)}" aria-label="The seventh rule, if the class wrote one">
      <button onclick="saveSeventh()">Save the seventh rule</button>
    </div>` : ''}`;
}

function saveSeventh() {
  if (!heatCanEdit) return;
  const el = document.getElementById('heat-seventh');
  heatDoc.seventhRule = el ? String(el.value || '').slice(0, 120) : '';
  heatSave();
  render();
}

function render() {
  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  set('heat-track', trackHtml());
  set('heat-who', whoHtml());
  set('heat-coming', comingHtml());
  set('heat-controls', triggersHtml());
  set('heat-d6', d6Html());
  set('heat-record', recordHtml());
  set('heat-fight-form', fightFormHtml());
  set('heat-gang', gangHtml());
  set('heat-log', logHtml());
  set('heat-law', lawHtml());

  const badge = document.getElementById('heat-level-badge');
  if (badge) {
    badge.textContent = 'Heat ' + heatLevel();
    badge.className = 'heat-badge mood-' + heatBandFor(heatLevel()).mood;
  }
}

(async () => {
  await heatLoad();
  render();
  await fbAuthReady;
  // Fail closed until this resolves: the buttons are not rendered at all
  // until the admin check says otherwise, and firestore.rules refuses the
  // write regardless of what this page shows.
  heatCanEdit = !!(window.isAdmin && window.isAdmin());
  render();
  heatLiveSync();
})();
