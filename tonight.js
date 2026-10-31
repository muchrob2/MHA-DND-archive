// Page logic for tonight.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// Runs after auth.js, so fbAuthReady/isAdmin are already defined.
//
// ── What this page is ───────────────────────────────────────────────
// The run sheet. One screen to have open while actually running a session,
// stitched out of five things that already exist on this site and were in
// five different places:
//
//   WHERE WE LEFT OFF   the last session's recap, who was there, and the
//                       note to yourself about what comes next
//   THE RUNNING ORDER   the chapter's sections in order, with the tag that
//                       says how long each is meant to take and whether it
//                       is an encounter
//   SIDE QUESTS         what is on offer this chapter, with the giver, the
//                       slots it costs and what it pays
//   HEAT                where the Byakko track is and who turns up at that
//                       level, so a wandering party can be answered without
//                       opening another tab
//   THE ENCOUNTERS      the arc's steps from the encounter presets, each
//                       with the preset map it is built for
//
// Plus a scratch pad for tonight, which saves, because the thing you write
// at 9pm is the thing you need at the start of the next session.
//
// ── DM side ─────────────────────────────────────────────────────────
// Linked from the DM block, and the notes save for the DM only. Everybody
// can read mha-dnd/run-sheet, as everybody can read every mha-dnd document,
// but there is nothing on this page a player would want and plenty they
// should not see — the "next time" note out of the session log in
// particular, which verify-heropad.js exists to keep off their Heropad.
//
// A signed-out or player session still gets the page, with the notes kept in
// that browser only, because a page that refuses to render is worse than one
// that cannot save.

const db = firebase.firestore();
const FS_CAMPAIGNS = db.collection('mha-dnd').doc('campaigns');
const FS_SESSIONS = db.collection('mha-dnd').doc('session-log');
const FS_HEAT = db.collection('mha-dnd').doc('heat');
const FS_RUN = db.collection('mha-dnd').doc('run-sheet');
const LS_RUN = 'mha-run-sheet-v1';

let campaigns = [];
let sessions = [];
let heat = null;
let groups = [];
let maps = {};
let runDoc = { campaignId: '', chapterId: '', notes: '' };
let canWrite = false;
let loaded = false;
let sources = { campaigns: '', encounters: '' };

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* The preset board maps, by key. Read when this file loads rather than inside
 * loadAll: BOARD_MAPS is a script tag away and has nothing to do with the
 * network, and burying it in the loader meant the label lookup could not be
 * used — or tested — without running the whole load.
 *
 * Falls back to the key, which is still a useful thing to show: "rooftops"
 * tells a DM more than a blank.
 */
if (typeof BOARD_MAPS !== 'undefined' && Array.isArray(BOARD_MAPS)) {
  for (const m of BOARD_MAPS) maps[m.key] = m;
}

function mapLabel(key) {
  if (!key) return '';
  return (maps[key] && maps[key].label) || key;
}

/* ── Picking where you are ── */

function currentCampaign() {
  if (runDoc.campaignId) {
    const picked = campaigns.find(c => c.id === runDoc.campaignId);
    if (picked) return picked;
  }
  // First visit: the campaign with the most written sections is the one being
  // run. NOT the most chapters — the full campaign and its short summary have
  // eight each, and on that measure the summary won the tie and a first visit
  // opened the four-sentence version. Sections tell them apart: 57 against 8.
  const weight = (c) => (c.chapters || []).reduce((n, ch) => n + ((ch.sections || []).length), 0);
  return campaigns.slice().sort((a, b) => weight(b) - weight(a))[0] || null;
}

function currentChapter() {
  const c = currentCampaign();
  if (!c) return null;
  const list = c.chapters || [];
  return list.find(ch => ch.id === runDoc.chapterId) || list[0] || null;
}

function pickCampaign(id) {
  runDoc.campaignId = id;
  const c = currentCampaign();
  // A chapter id from the old campaign would resolve to nothing, so move to
  // the new campaign's first chapter rather than leaving the page blank.
  runDoc.chapterId = ((c && c.chapters) || [])[0] ? c.chapters[0].id : '';
  saveRun();
  render();
}

function pickChapter(id) {
  runDoc.chapterId = id;
  saveRun();
  render();
}

/* ── Storage ────────────────────────────────────────────────────────
   localStorage always, so the page remembers where you were even signed
   out; Firestore when there is write access, so the notes you take on the
   laptop are there on the tablet.
   ─────────────────────────────────────────────────────────────────── */
let runSaveTimer = null;
function saveRun() {
  try { localStorage.setItem(LS_RUN, JSON.stringify(runDoc)); } catch {}
  if (!canWrite) return;
  clearTimeout(runSaveTimer);
  runSaveTimer = setTimeout(async () => {
    try {
      await FS_RUN.set(runDoc, { merge: true });
    } catch (e) {
      // Said out loud: a failed write here loses the notes you took during a
      // session, which is the worst thing this page could do quietly.
      console.error('[tonight] could not save — your notes are still in this browser:', e);
      const el = document.getElementById('rs-save-state');
      if (el) el.textContent = 'Could not save to the server. Still saved in this browser.';
    }
  }, 700);
}

function setNotes(value) {
  runDoc.notes = String(value == null ? '' : value);
  saveRun();
  const el = document.getElementById('rs-save-state');
  if (el) el.textContent = canWrite ? 'Saved' : 'Saved in this browser only';
}

/* ── Load ── */

async function loadAll() {
  try {
    const raw = localStorage.getItem(LS_RUN);
    if (raw) runDoc = Object.assign(runDoc, JSON.parse(raw));
  } catch {}

  // The campaigns live in Firestore and the repo copy is a fallback — the
  // same order campaigns.html reads them in, because editing the repo file
  // does not publish anything.
  try {
    await fbAuthReady;
    const snap = await FS_CAMPAIGNS.get();
    const d = snap.exists ? snap.data() : null;
    if (!d || !Array.isArray(d.campaigns)) throw new Error('empty');
    campaigns = d.campaigns;
    sources.campaigns = 'live';
  } catch {
    try {
      campaigns = (await fetch('CAMPAIGN/campaigns.json').then(r => r.json())).campaigns || [];
      sources.campaigns = 'bundled';
    } catch { sources.campaigns = 'none'; }
  }

  try {
    const snap = await FS_SESSIONS.get();
    sessions = (snap.exists && snap.data().sessions) || [];
  } catch {}

  try {
    const snap = await FS_HEAT.get();
    heat = snap.exists ? snap.data() : null;
  } catch {}

  try {
    const snap = await FS_RUN.get();
    if (snap.exists) runDoc = Object.assign({}, runDoc, snap.data());
  } catch {}

  // The encounter presets are a static file — no Firestore copy of them
  // exists, which is why this one is a plain fetch.
  try {
    const d = await fetch('CAMPAIGN/enemies.json').then(r => r.json());
    groups = d.groups || [];
    sources.encounters = 'bundled';
  } catch { sources.encounters = 'none'; }

  loaded = true;
}

/* ── Render ── */

function pickersHtml() {
  const c = currentCampaign();
  const ch = currentChapter();
  if (!campaigns.length) {
    return `<p class="rs-empty">No campaigns could be read${sources.campaigns === 'none'
      ? ' — neither the live copy nor the bundled one.' : '.'}</p>`;
  }
  return `<div class="rs-pickers">
      <label class="rs-pick">
        <span>Campaign</span>
        <select onchange="pickCampaign(this.value)" aria-label="Which campaign">
          ${campaigns.map(x => `<option value="${escHtml(x.id)}"${c && x.id === c.id ? ' selected' : ''}>${escHtml(x.title || x.id)}</option>`).join('')}
        </select>
      </label>
      <label class="rs-pick">
        <span>Chapter</span>
        <select onchange="pickChapter(this.value)" aria-label="Which chapter">
          ${((c && c.chapters) || []).map(x => `<option value="${escHtml(x.id)}"${ch && x.id === ch.id ? ' selected' : ''}>${escHtml((x.number ? x.number + '. ' : '') + (x.title || x.id))}</option>`).join('')}
        </select>
      </label>
      ${c ? `<a class="rs-open" href="campaigns.html#/campaign/${encodeURIComponent(c.id)}">Open the full text →</a>` : ''}
    </div>`;
}

function lastTimeHtml() {
  const last = sessions[0];
  if (!last) {
    return `<p class="rs-empty">Nothing in the session log yet. Write one up on the
      <a href="session-log.html">Session Log</a> and it appears here next time.</p>`;
  }
  const bits = [];
  if (last.recap) bits.push(`<p class="rs-recap">${escHtml(last.recap)}</p>`);
  if (Array.isArray(last.present) && last.present.length) {
    bits.push(`<p class="rs-meta"><span>There</span>${escHtml(last.present.join(', '))}</p>`);
  }
  for (const [label, value] of [['NPCs', last.npcs], ['Places', last.places]]) {
    const list = Array.isArray(value) ? value.join(', ') : value;
    if (list) bits.push(`<p class="rs-meta"><span>${escHtml(label)}</span>${escHtml(list)}</p>`);
  }
  // The one field that must never reach a player — see verify-heropad.js,
  // which keeps it off the Heropad. This page is the DM's, so it belongs here
  // and nowhere else.
  if (last.next) bits.push(`<div class="rs-next"><span>Next time</span>${escHtml(last.next)}</div>`);
  return `<div class="rs-last">
      <div class="rs-last-head">
        <span class="rs-last-title">${escHtml(last.title || 'Last session')}</span>
        ${last.number ? `<span class="rs-tag">Session ${escHtml(last.number)}</span>` : ''}
        ${last.date ? `<span class="rs-tag">${escHtml(last.date)}</span>` : ''}
        ${last.xp ? `<span class="rs-tag">${escHtml(last.xp)} XP</span>` : ''}
      </div>
      ${bits.join('')}
    </div>`;
}

// The section `type` is the one field that says what a block IS, and the
// `tag` is where the campaign records how long it should take. Both are
// printed, because "Encounter · pursuit · 1 session" is the whole plan.
const RS_TYPE_LABELS = {
  encounter: 'Fight', location: 'Place', npc: 'Someone', dmnote: 'For you', general: '—',
};

function runningOrderHtml() {
  const ch = currentChapter();
  if (!ch) return '<p class="rs-empty">No chapter selected.</p>';
  const sections = ch.sections || [];
  const fights = sections.filter(s => s.type === 'encounter').length;
  return `
    ${ch.dmNote ? `<div class="rs-dmnote"><span>Before you start</span>${escHtml(ch.dmNote)}</div>` : ''}
    <div class="rs-chapter-meta">
      ${ch.estimate ? `<span class="rs-tag">${escHtml(ch.estimate)}</span>` : ''}
      ${ch.levels ? `<span class="rs-tag">${escHtml(ch.levels)}</span>` : ''}
      <span class="rs-tag">${sections.length} section${sections.length === 1 ? '' : 's'}</span>
      <span class="rs-tag">${fights} fight${fights === 1 ? '' : 's'}</span>
    </div>
    ${sections.length ? `<ol class="rs-order">
      ${sections.map(s => `<li class="rs-step type-${escHtml(s.type || 'general')}">
        <div class="rs-step-head">
          <span class="rs-step-name">${escHtml(s.heading || 'Untitled')}</span>
          <span class="rs-step-type">${escHtml(RS_TYPE_LABELS[s.type] || s.type || '')}</span>
        </div>
        ${s.tag ? `<div class="rs-step-tag">${escHtml(s.tag)}</div>` : ''}
        ${s.readAloud ? `<div class="rs-step-read">▶ ${escHtml(String(s.readAloud).slice(0, 180))}${String(s.readAloud).length > 180 ? '…' : ''}</div>` : ''}
      </li>`).join('')}
    </ol>` : '<p class="rs-empty">This chapter has no sections written yet.</p>'}
    ${ch.milestone ? `<div class="rs-milestone"><span>Milestone</span>${escHtml(ch.milestone)}</div>` : ''}`;
}

function sideQuestsHtml() {
  const ch = currentChapter();
  const quests = (ch && ch.sidequests) || [];
  if (!quests.length) return '<p class="rs-empty">No side quests in this chapter.</p>';
  // `name`, not `title` — the campaign records them under name, and reading
  // the wrong one prints "undefined" for every row.
  return `<div class="rs-quests">${quests.map(q => `<div class="rs-quest">
      <div class="rs-quest-head">
        <span class="rs-quest-name">${escHtml(q.name || 'Untitled')}</span>
        ${q.giver ? `<span class="rs-tag">${escHtml(q.giver)}</span>` : ''}
        ${q.slots ? `<span class="rs-tag">${escHtml(q.slots)}</span>` : ''}
      </div>
      ${q.hook ? `<p class="rs-quest-hook">${escHtml(q.hook)}</p>` : ''}
      ${q.body ? `<p class="rs-quest-body">${escHtml(q.body)}</p>` : ''}
      ${q.reward ? `<p class="rs-quest-reward"><span>Pays</span>${escHtml(q.reward)}</p>` : ''}
    </div>`).join('')}</div>`;
}

function heatHtml() {
  if (!heat) {
    return `<p class="rs-empty">The Heat track has not been used yet.
      <a href="heat.html">Open it</a> and it appears here.</p>`;
  }
  const level = typeof heatClamp === 'function'
    ? heatClamp(heat.heat, heat.chapter) : Number(heat.heat) || 0;
  const band = typeof heatBandFor === 'function' ? heatBandFor(level) : null;
  const next = typeof heatNextBand === 'function' ? heatNextBand(level) : null;
  const beaten = Object.keys(heat.beaten || {}).length;
  return `<div class="rs-heat mood-${escHtml(band ? band.mood : 'quiet')}">
      <div class="rs-heat-num">${level}<span>/10</span></div>
      <div class="rs-heat-body">
        <div class="rs-heat-who">${escHtml(band ? band.who : '')}</div>
        ${next ? `<div class="rs-heat-next">At ${next.from} — ${escHtml(next.who)}</div>` : ''}
        <div class="rs-heat-meta">${beaten} named Byakko beaten · <a href="heat.html">the full track →</a></div>
      </div>
    </div>`;
}

function encountersHtml() {
  const withArc = groups.filter(g => g.arc);
  if (!withArc.length) {
    return `<p class="rs-empty">No encounter presets carry an arc${sources.encounters === 'none'
      ? ' — the presets could not be read.' : '.'}</p>`;
  }
  const byArc = {};
  for (const g of withArc) (byArc[g.arc] = byArc[g.arc] || []).push(g);
  return Object.entries(byArc).map(([arc, list]) => `<div class="rs-arc">
      <div class="rs-arc-name">${escHtml(arc)}</div>
      ${list.slice().sort((a, b) => (a.step || 0) - (b.step || 0)).map(g => `<div class="rs-enc">
        <span class="rs-enc-step">${escHtml(g.step == null ? '—' : g.step)}</span>
        <span class="rs-enc-name">${escHtml(g.name || g.id)}</span>
        ${g.map ? `<span class="rs-tag" title="A preset board map">${escHtml(mapLabel(g.map))}</span>` : ''}
        <span class="rs-enc-n">${((g.members || []).length)} in it</span>
      </div>`).join('')}
    </div>`).join('')
    + `<p class="rs-note">Load any of these from the group picker in the
       <a href="CLASS-1A/encounter.html">Encounter Manager</a>, which keeps the same step numbers.</p>`;
}

function notesHtml() {
  return `<textarea id="rs-notes" rows="7" oninput="setNotes(this.value)"
      placeholder="What you want to remember at nine o'clock tonight."
      aria-label="Notes for tonight">${escHtml(runDoc.notes || '')}</textarea>
    <div class="rs-save-row">
      <span id="rs-save-state" class="rs-save-state" role="status" aria-live="polite">${canWrite ? '' : 'Signed out — notes stay in this browser'}</span>
    </div>`;
}

function render() {
  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  if (!loaded) {
    set('rs-pickers', '<p class="rs-empty">Reading the campaign…</p>');
    return;
  }
  set('rs-pickers', pickersHtml());
  set('rs-last', lastTimeHtml());
  set('rs-order', runningOrderHtml());
  set('rs-quests', sideQuestsHtml());
  set('rs-heat', heatHtml());
  set('rs-encounters', encountersHtml());

  // The notes box is only re-rendered when it is not being typed in, because
  // replacing innerHTML destroys the caret and anything half-typed.
  const box = document.getElementById('rs-notes');
  if (!box || document.activeElement !== box) set('rs-notes-wrap', notesHtml());

  const src = document.getElementById('rs-source');
  if (src) {
    src.textContent = sources.campaigns === 'live'
      ? 'Campaign read from the live copy.'
      : sources.campaigns === 'bundled'
        ? 'Campaign read from the bundled file — the live copy could not be reached, so this may be behind.'
        : 'The campaign could not be read at all.';
  }
}

(async () => {
  render();
  await loadAll();
  await fbAuthReady;
  canWrite = !!(window.isAdmin && window.isAdmin());
  render();
})();
