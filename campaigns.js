// Page logic for campaigns.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals, and top-level
// declarations here become globals exactly as they did inline. type="module"
// would scope them and silently break every handler.

// Runs after auth.js, so fbAuthReady/fsMergeSave are already defined.
const db = firebase.firestore();

/* ─── Utilities ──────────────────────────────────────── */
function escHtml(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ─── Line icons ─────────────────────────────────────────
   The editing chrome only. Emoji until the dashboard rework replaced its
   own; next to Inter and the module's serif they read as stickers.

   NOT converted, deliberately:
     c.icon          the campaign's own icon, which a DM types into a form
                     (#f-icon, maxlength 4). That is their emoji, not ours.
     SECTION_ICON    and the markers inside the prose. Those are the
                     module's typography and verify-campaign-prose.js
                     checks the shapes they belong to. */
const ICO_PATH = {
  pencil: '<path d="M4 20h4L19.4 8.6a2.05 2.05 0 0 0-2.9-2.9L5 17.2z"/><path d="M14.5 7.5l2.9 2.9"/>',
  trash:  '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13.5h10L18 7"/><path d="M10.5 11v6M13.5 11v6"/>',
  check:  '<path d="M4.5 12.5l5 5 10-11"/>',
  eye:    '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/>',
  books:  '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H10a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5z"/><path d="M20 4.5A1.5 1.5 0 0 0 18.5 3H14a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h4.5A1.5 1.5 0 0 0 20 15.5z"/>',
};
function ico(name) {
  return `<svg class="btn-ico" viewBox="0 0 24 24" aria-hidden="true">${ICO_PATH[name] || ''}</svg>`;
}

function uid(prefix) { return (prefix||'id') + '-' + Math.random().toString(36).slice(2, 9); }

/* ─── Prose rendering ────────────────────────────────────
   Campaign text is authored as plain text in a textarea, so the only
   structure available is line shape. Three conventions are honoured,
   all of them things the existing content already does:

     •  a top-level bullet
     ·  a sub-bullet (stat-block lines, list entries, faction ladders)
     —  a nested bullet under the bullet above it

   Everything else is a paragraph. A line may also open with an
   ALL-CAPS lead-in — like this — or a LEAD-IN: like this, and that
   label gets pulled out and emphasised, because almost every bullet
   in this archive is written that way and a page of undifferentiated
   capitals is the single worst thing for scanning at the table.

   The previous version only made a list when EVERY line in a block
   started with •, so the common mixed block (a bullet with — children,
   or a · list) fell through to one <p> joined by <br> — a wall. */

// Inline enrichment. Runs on already-escaped text.
// Deliberately requires an explicit separator, so a dot-separated stat
// line ("AC 16 · HP 125 · Speed 30 ft") can never match.
// ĀĒĪŌŪ are in the class because romanised Japanese is everywhere in this
// archive — a label like "KŌGA RIN" must still read as a label.
const CAPS = "A-ZĀĒĪŌŪ";
const LEAD_IN = new RegExp(`^([${CAPS}0-9][${CAPS}0-9 ,.'’()/&+×–\\-]{1,58}?)(\\s+—\\s+|:\\s+)`);

function enrich(escaped) {
  const m = escaped.match(LEAD_IN);
  if (!m) return escaped;
  // A lead-in needs at least one real letter; "1962 — " is a date, not a label.
  if (!new RegExp(`[${CAPS}]{2}`).test(m[1])) return escaped;
  const sep = m[2].trim() === ':' ? '<span class="lead-sep">:</span> ' : '<span class="lead-sep">—</span> ';
  return `<b class="lead">${m[1]}</b>${sep}${escaped.slice(m[0].length)}`;
}

function classifyLine(raw) {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('•')) return { kind: 'bullet', text: t.replace(/^•\s*/, '') };
  if (t.startsWith('·')) return { kind: 'dot', text: t.replace(/^·\s*/, '') };
  // Only a nested child when it was indented or follows a bullet — a bare
  // em dash opening a sentence is prose.
  if (/^[—–]\s+/.test(t) && /^\s/.test(raw)) return { kind: 'child', text: t.replace(/^[—–]\s*/, '') };
  return { kind: 'plain', text: t };
}

function renderProse(text) {
  if (!text) return '';
  return String(text).split(/\n\n+/).map(block => {
    const lines = block.split('\n').map(classifyLine).filter(Boolean);
    if (!lines.length) return '';

    const hasList = lines.some(l => l.kind === 'bullet' || l.kind === 'dot');
    if (!hasList) {
      return `<p>${lines.map(l => enrich(escHtml(l.text))).join('<br>')}</p>`;
    }

    let html = '';
    let preamble = [];
    let items = [];       // { text, children: [] }
    let listKind = null;

    for (const l of lines) {
      if (l.kind === 'bullet' || l.kind === 'dot') {
        listKind = listKind || l.kind;
        items.push({ text: l.text, children: [] });
      } else if (items.length) {
        // Anything after the first bullet belongs to it: a — child, or a
        // continuation line that the author wrapped.
        items[items.length - 1].children.push(l.text);
      } else {
        preamble.push(l.text);
      }
    }

    if (preamble.length) html += `<p>${preamble.map(t => enrich(escHtml(t))).join('<br>')}</p>`;
    html += `<ul class="${listKind === 'dot' ? 'p-dots' : 'p-bullets'}">`;
    for (const it of items) {
      html += `<li>${enrich(escHtml(it.text))}`;
      if (it.children.length) {
        html += `<ul class="p-children">${it.children.map(c => `<li>${enrich(escHtml(c))}</li>`).join('')}</ul>`;
      }
      html += `</li>`;
    }
    html += `</ul>`;
    return html;
  }).join('');
}

/* ─── Read-aloud rendering ───────────────────────────────
   A read-aloud is not one speech. The content marks separate moments
   with ▶, and inside a moment a line may be a labelled performance
   beat — WHAT THEY SEE, SOMEBODY SAYS, ASK THEM. Rendering the whole
   thing as one italic slab makes the DM find all of that mid-sentence,
   so each ▶ becomes its own cue card and each labelled line its own
   row. Text with no ▶ in it falls back to ordinary prose. */

// Labels that are a prompt to the table rather than something to read out.
const ASK_LABEL = /^(ASK|THE QUESTION|PUT IT|GIVE THE|ROUND THE TABLE)/;
const BEAT = new RegExp(`^([${CAPS}][${CAPS}0-9 ,.'’()/&+–\\-]{1,44}?)\\s+—\\s+(.+)$`);

function renderReadAloudBody(text) {
  return String(text).split(/\n\n+/).map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    // A block of labelled beats renders as rows; mixed or unlabelled
    // blocks stay as prose so existing content is unaffected.
    const beats = lines.map(l => l.match(BEAT));
    if (beats.every(Boolean)) {
      return beats.map(m => {
        const ask = ASK_LABEL.test(m[1]);
        return `<div class="ra-beat${ask ? ' ra-ask' : ''}">
          <div class="ra-beat-label">${ask ? '❓ ' : ''}${escHtml(m[1])}</div>
          <div class="ra-beat-text">${escHtml(m[2])}</div>
        </div>`;
      }).join('');
    }
    return `<p>${lines.map(l => escHtml(l)).join('<br>')}</p>`;
  }).join('');
}

function renderReadAloud(text) {
  if (!text) return '';
  const src = String(text).trim();
  if (!src.includes('▶')) return renderReadAloudBody(src);

  // Anything before the first ▶ is a standing instruction, not a cue.
  const firstCue = src.indexOf('▶');
  const preamble = src.slice(0, firstCue).trim();
  let html = preamble ? `<div class="ra-note">${renderReadAloudBody(preamble)}</div>` : '';

  const cues = src.slice(firstCue).split(/\n*▶[ \t]*/).filter(s => s.trim());
  html += cues.map(cue => {
    const nl = cue.indexOf('\n');
    const label = (nl === -1 ? cue : cue.slice(0, nl)).trim();
    const body = nl === -1 ? '' : cue.slice(nl).trim();
    return `<div class="ra-cue">
      <div class="ra-cue-label">${escHtml(label)}</div>
      ${body ? `<div class="ra-cue-body">${renderReadAloudBody(body)}</div>` : ''}
    </div>`;
  }).join('');
  return html;
}

/* ── Searching a module ────────────────────────────────────
   Eight chapters, sixty-odd sections and a twenty-three-part appendix is a
   lot of text to find one sentence in, and the contents rail only goes down
   to chapter level. These two functions are pure and live up here with the
   renderers so the verifier can run them over the real campaign file: the
   index is built from the data, and the hits come back with the id of the
   block they are in, which is also that block's DOM id — so a result is a
   link to #id and nothing has to be scrolled for.

   Every authored field is indexed, read-alouds included, because "what was
   the line about the van" is exactly the question this is for. */
function campaignSearchIndex(c) {
  const out = [];
  const add = (id, heading, where, text) => {
    if (id && text) out.push({ id, heading: heading || '(untitled)', where, text: String(text) });
  };
  for (const b of c.background || []) add(b.id, b.heading, 'Background', b.body);
  (c.chapters || []).forEach(ch => {
    const where = ch.number ? `Chapter ${ch.number}` : 'Chapter';
    for (const k of ['intro', 'dmNote', 'milestone']) add(ch.id, ch.title, where, ch[k]);
    if (ch.closing) add(ch.id, ch.title, where, ch.closing.body);
    for (const s of ch.sections || []) {
      const label = `${where} — ${ch.title}`;
      for (const k of ['body', 'developments', 'treasure', 'dmNote', 'readAloud']) add(s.id, s.heading, label, s[k]);
      if (s.aside) add(s.id, s.heading, label, s.aside.body);
    }
    for (const q of ch.sidequests || []) {
      for (const k of ['body', 'reward']) add(q.id, q.title, `${where} — side quests`, q[k]);
    }
  });
  for (const a of c.appendix || []) add(a.id, a.heading, 'Appendix', a.body);
  return out;
}

// Every word has to appear somewhere in the same block, in any order, so
// "van scar" finds the one paragraph about the chop shop. One hit per block —
// the second mention of a word in the same section is not a second answer.
function campaignSearchHits(index, query, limit) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set();
  const hits = [];
  for (const entry of index) {
    if (seen.has(entry.id)) continue;
    const hay = entry.text.toLowerCase();
    if (!words.every(w => hay.includes(w))) continue;
    seen.add(entry.id);
    // Cut around the whole phrase if the block happens to contain it, and
    // around the first word otherwise: matching is word-by-word in any order,
    // but somebody who typed "noodle bar" wants to see "noodle bar" in the
    // result and not the word "noodle" four sentences from the word "bar".
    const phrase = words.length > 1 ? words.join(' ') : '';
    const phraseAt = phrase ? hay.indexOf(phrase) : -1;
    const at = phraseAt > -1 ? phraseAt : hay.indexOf(words[0]);
    const anchorLen = phraseAt > -1 ? phrase.length : words[0].length;
    // On word boundaries where it can be, because a snippet that starts
    // mid-word reads as a typo.
    let from = Math.max(0, at - 70);
    let to = Math.min(entry.text.length, at + anchorLen + 110);
    if (from > 0) { const sp = entry.text.indexOf(' ', from); if (sp > -1 && sp < at) from = sp + 1; }
    if (to < entry.text.length) { const sp = entry.text.lastIndexOf(' ', to); if (sp > at) to = sp; }
    hits.push({
      id: entry.id,
      heading: entry.heading,
      where: entry.where,
      snippet: (from > 0 ? '…' : '') + entry.text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < entry.text.length ? '…' : ''),
      words,
    });
    if (limit && hits.length >= limit) break;
  }
  return hits;
}

// Escaped first, then marked: the other order would let a query turn the
// campaign's own text into markup.
function campaignHighlight(snippet, words) {
  let html = escHtml(snippet);
  for (const w of words) {
    const safe = escHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (safe) html = html.replace(new RegExp('(' + safe + ')', 'gi'), '<mark>$1</mark>');
  }
  return html;
}

// The same search across every module at once, for the question a DM actually
// has mid-session — "which of these has the bit about the white van" — when
// they do not yet know which module to open. Each hit carries the campaign it
// came from, because that is the part that matters when the answer could be in
// any of six.
function campaignLibraryHits(campaigns, query, limit) {
  const out = [];
  for (const c of campaigns || []) {
    const hits = campaignSearchHits(campaignSearchIndex(c), query, limit);
    for (const h of hits) {
      out.push(Object.assign({ campaignId: c.id, campaignTitle: c.title || c.id, campaignIcon: c.icon || '📘' }, h));
      if (limit && out.length >= limit) return out;
    }
  }
  return out;
}

/* ─── State ──────────────────────────────────────────── */
const FS_CAMPAIGNS_DOC = db.collection('mha-dnd').doc('campaigns');
let campaignsData = null;
let currentCampaignId = null;
let editMode = false;
let openEditId = null;
let canWriteCampaigns = false;
// Last campaigns doc this client knows was on the server — diffed against on
// save so concurrent edits to different campaigns don't clobber each other.
let _lastSyncedCampaigns = null;
// True from the moment a save is kicked off until it actually lands (or
// fails). openEditId already flips back to null before this resolves (the
// edit form closes immediately), so isCampaignsEditing() alone isn't enough
// to keep a live snapshot from applying mid-save — this closes that window.
let _campaignSaveInFlight = false;

async function loadCampaigns() {
  try {
    await fbAuthReady;
    const snap = await FS_CAMPAIGNS_DOC.get();
    const d = snap.exists ? snap.data() : null;
    if (!d || !Array.isArray(d.campaigns)) throw new Error('empty');
    return d;
  } catch {
    const res = await fetch('CAMPAIGN/campaigns.json');
    return res.json();
  }
}

async function saveCampaigns() {
  const notice = document.getElementById('saved-notice');
  _campaignSaveInFlight = true;
  try {
    await fbAuthReady;
    const merged = await fsMergeSave(FS_CAMPAIGNS_DOC, campaignsData, _lastSyncedCampaigns, [{ path: 'campaigns', idKey: 'id' }]);
    _lastSyncedCampaigns = merged;
    notice.textContent = 'Saved ✓';
    notice.classList.remove('err');
    notice.classList.add('show');
    setTimeout(() => notice.classList.remove('show'), 1800);
  } catch (e) {
    notice.textContent = 'Save failed — sign in as an editor';
    notice.classList.add('err');
    notice.classList.add('show');
    setTimeout(() => notice.classList.remove('show'), 3000);
  } finally {
    _campaignSaveInFlight = false;
  }
}

// Live feed: reflect other people's changes without a manual refresh. Deferred
// while an edit form is open so a remote update can't blow away in-progress,
// unsaved text in a field.
let _pendingRemoteCampaigns = null;
function isCampaignsEditing() { return openEditId !== null || _campaignSaveInFlight; }
function applyRemoteCampaigns(data) {
  campaignsData = data;
  campaignsData.campaigns = campaignsData.campaigns || [];
  _lastSyncedCampaigns = fsCloneDoc(data); // cloned: a baseline must never alias live state (see auth.js cloneDoc)
  render();
}
async function startCampaignsLiveSync() {
  await fbAuthReady;
  FS_CAMPAIGNS_DOC.onSnapshot(snap => {
    if (!snap.exists) return;
    // A cached snapshot is this tab's own stale copy, not news from the server.
    // When Firestore's streaming channel is blocked (Safari tracking
    // protection, content blockers, proxies) the write transport keeps working
    // while the listener replays cache — so a save commits and is then visibly
    // "undone" by data older than the write. See relationships.html.
    if (snap.metadata?.fromCache) return;
    const data = snap.data();
    if (!Array.isArray(data.campaigns)) return;
    if (isCampaignsEditing()) { _pendingRemoteCampaigns = data; return; }
    applyRemoteCampaigns(data);
  }, err => console.error('[campaigns] live sync stopped:', err));
}
setInterval(() => {
  if (_pendingRemoteCampaigns && !isCampaignsEditing()) {
    const data = _pendingRemoteCampaigns;
    _pendingRemoteCampaigns = null;
    applyRemoteCampaigns(data);
  }
}, 800);

document.addEventListener('auth-state-changed', (e) => {
  canWriteCampaigns = e.detail.role === 'admin' || e.detail.role === 'editor';
  const btn = document.getElementById('edit-toggle-btn');
  btn.style.display = canWriteCampaigns ? '' : 'none';
  if (!canWriteCampaigns) { editMode = false; openEditId = null; }
  render();
});

function toggleEditMode() {
  editMode = !editMode;
  openEditId = null;
  const btn = document.getElementById('edit-toggle-btn');
  btn.innerHTML = editMode ? ico('eye') + 'Done' : ico('pencil') + 'Edit';
  btn.classList.toggle('active', editMode);
  render();
}

function openEdit(id) { openEditId = id; render(); }
function closeEdit() { openEditId = null; render(); }

/* ─── Lookups ────────────────────────────────────────── */
function findCampaign(id) { return (campaignsData.campaigns||[]).find(c => c.id === id); }
function findChapter(c, chId) { return (c.chapters||[]).find(ch => ch.id === chId); }
function findSection(ch, secId) { return (ch.sections||[]).find(s => s.id === secId); }
function findChapterOfSection(c, secId) { return (c.chapters||[]).find(ch => (ch.sections||[]).some(s => s.id === secId)); }
function renumberChapters(c) { (c.chapters||[]).forEach((ch, i) => { ch.number = i + 1; }); }

/* ─── Routing ────────────────────────────────────────── */
function parseHash() {
  const m = location.hash.slice(1).match(/^\/campaign\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (h === '' || h.startsWith('/campaign/')) {
    // Real route change (library <-> a campaign) — anything else is an
    // in-page anchor (TOC / chapter / section) and should just scroll natively.
    currentCampaignId = parseHash();
    openEditId = null;
    render();
  }
});

function openCampaign(id) { location.hash = '/campaign/' + encodeURIComponent(id); }

/* ─── Campaign CRUD ──────────────────────────────────── */
function submitNewCampaign() {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { alert('Title is required.'); return; }
  const c = {
    id: uid('camp'),
    title,
    tagline: document.getElementById('f-tagline').value.trim(),
    icon: document.getElementById('f-icon').value.trim() || '📘',
    levelRange: document.getElementById('f-levels').value.trim(),
    estimate: document.getElementById('f-estimate').value.trim(),
    tone: document.getElementById('f-tone').value.trim(),
    background: [], chapters: [], appendix: [], links: [],
  };
  campaignsData.campaigns.push(c);
  openEditId = null;
  saveCampaigns();
  openCampaign(c.id);
}

function updateCampaignMeta(id) {
  const c = findCampaign(id);
  c.title = document.getElementById('f-title').value.trim() || c.title;
  c.tagline = document.getElementById('f-tagline').value.trim();
  c.icon = document.getElementById('f-icon').value.trim() || '📘';
  c.levelRange = document.getElementById('f-levels').value.trim();
  c.estimate = document.getElementById('f-estimate').value.trim();
  c.tone = document.getElementById('f-tone').value.trim();
  openEditId = null;
  saveCampaigns();
  render();
}

function deleteCampaign(id) {
  const c = findCampaign(id);
  if (!confirm(`Delete "${c.title}"? This removes the entire campaign profile, including every chapter. This cannot be undone.`)) return;
  campaignsData.campaigns = campaignsData.campaigns.filter(x => x.id !== id);
  saveCampaigns();
  if (currentCampaignId === id) { location.hash = ''; } else { render(); }
}

/* ─── Chapter CRUD ───────────────────────────────────── */
function submitNewChapter(campId) {
  const c = findCampaign(campId);
  const title = document.getElementById('f-ch-title').value.trim();
  if (!title) { alert('Chapter title is required.'); return; }
  c.chapters = c.chapters || [];
  c.chapters.push({
    id: uid('ch'), number: c.chapters.length + 1, title,
    levels: document.getElementById('f-ch-levels').value.trim(),
    estimate: document.getElementById('f-ch-estimate').value.trim(),
    intro: document.getElementById('f-ch-intro').value.trim(),
    dmNote: document.getElementById('f-ch-dmnote').value.trim(),
    milestone: document.getElementById('f-ch-milestone').value.trim(),
    sections: [],
  });
  openEditId = null;
  saveCampaigns();
  render();
}

function updateChapter(campId, chId) {
  const ch = findChapter(findCampaign(campId), chId);
  ch.title = document.getElementById('f-ch-title').value.trim() || ch.title;
  ch.levels = document.getElementById('f-ch-levels').value.trim();
  ch.estimate = document.getElementById('f-ch-estimate').value.trim();
  ch.intro = document.getElementById('f-ch-intro').value.trim();
  ch.dmNote = document.getElementById('f-ch-dmnote').value.trim();
  ch.milestone = document.getElementById('f-ch-milestone').value.trim();
  openEditId = null;
  saveCampaigns();
  render();
}

function deleteChapter(campId, chId) {
  const c = findCampaign(campId);
  const ch = findChapter(c, chId);
  if (!confirm(`Delete Chapter "${ch.title}"? This removes every subheading inside it. This cannot be undone.`)) return;
  c.chapters = c.chapters.filter(x => x.id !== chId);
  renumberChapters(c);
  saveCampaigns();
  render();
}

function moveChapter(campId, chId, dir) {
  const c = findCampaign(campId);
  const i = c.chapters.findIndex(x => x.id === chId);
  const j = i + dir;
  if (j < 0 || j >= c.chapters.length) return;
  [c.chapters[i], c.chapters[j]] = [c.chapters[j], c.chapters[i]];
  renumberChapters(c);
  saveCampaigns();
  render();
}

/* ─── Section CRUD ───────────────────────────────────── */
function submitNewSection(campId, chId) {
  const ch = findChapter(findCampaign(campId), chId);
  const heading = document.getElementById('f-sec-heading').value.trim();
  if (!heading) { alert('Subheading is required.'); return; }
  ch.sections = ch.sections || [];
  ch.sections.push({
    id: uid('sec'), heading,
    tag: document.getElementById('f-sec-tag').value.trim(),
    type: document.getElementById('f-sec-type').value,
    readAloud: document.getElementById('f-sec-readaloud').value.trim(),
    body: document.getElementById('f-sec-body').value.trim(),
    developments: document.getElementById('f-sec-developments').value.trim(),
    treasure: document.getElementById('f-sec-treasure').value.trim(),
    dmNote: document.getElementById('f-sec-dmnote').value.trim(),
    aside: (document.getElementById('f-sec-aside-label').value.trim() || document.getElementById('f-sec-aside-body').value.trim())
      ? { label: document.getElementById('f-sec-aside-label').value.trim() || 'Note', body: document.getElementById('f-sec-aside-body').value.trim() }
      : null,
  });
  openEditId = null;
  saveCampaigns();
  render();
}

function updateSection(campId, chId, secId) {
  const s = findSection(findChapter(findCampaign(campId), chId), secId);
  s.heading = document.getElementById('f-sec-heading').value.trim() || s.heading;
  s.tag = document.getElementById('f-sec-tag').value.trim();
  s.type = document.getElementById('f-sec-type').value;
  s.readAloud = document.getElementById('f-sec-readaloud').value.trim();
  s.body = document.getElementById('f-sec-body').value.trim();
  s.developments = document.getElementById('f-sec-developments').value.trim();
  s.treasure = document.getElementById('f-sec-treasure').value.trim();
  s.dmNote = document.getElementById('f-sec-dmnote').value.trim();
  const aLabel = document.getElementById('f-sec-aside-label').value.trim();
  const aBody = document.getElementById('f-sec-aside-body').value.trim();
  s.aside = (aLabel || aBody) ? { label: aLabel || 'Note', body: aBody } : null;
  openEditId = null;
  saveCampaigns();
  render();
}

function deleteSection(campId, chId, secId) {
  const ch = findChapter(findCampaign(campId), chId);
  if (!confirm('Delete this subheading? This cannot be undone.')) return;
  ch.sections = ch.sections.filter(x => x.id !== secId);
  saveCampaigns();
  render();
}

function moveSection(campId, chId, secId, dir) {
  const ch = findChapter(findCampaign(campId), chId);
  const i = ch.sections.findIndex(x => x.id === secId);
  const j = i + dir;
  if (j < 0 || j >= ch.sections.length) return;
  [ch.sections[i], ch.sections[j]] = [ch.sections[j], ch.sections[i]];
  saveCampaigns();
  render();
}

/* ─── Prose-list CRUD (background & appendix share this) ── */
function submitNewProse(campId, key) {
  const c = findCampaign(campId);
  const heading = document.getElementById('f-prose-heading').value.trim();
  const body = document.getElementById('f-prose-body').value.trim();
  if (!heading || !body) { alert('Heading and text are both required.'); return; }
  c[key] = c[key] || [];
  c[key].push({ id: uid(key), heading, body });
  openEditId = null;
  saveCampaigns();
  render();
}

function updateProse(campId, key, itemId) {
  const item = findCampaign(campId)[key].find(x => x.id === itemId);
  item.heading = document.getElementById('f-prose-heading').value.trim() || item.heading;
  item.body = document.getElementById('f-prose-body').value.trim();
  openEditId = null;
  saveCampaigns();
  render();
}

function deleteProse(campId, key, itemId) {
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  const c = findCampaign(campId);
  c[key] = c[key].filter(x => x.id !== itemId);
  saveCampaigns();
  render();
}

function moveProse(campId, key, itemId, dir) {
  const c = findCampaign(campId);
  const i = c[key].findIndex(x => x.id === itemId);
  const j = i + dir;
  if (j < 0 || j >= c[key].length) return;
  [c[key][i], c[key][j]] = [c[key][j], c[key][i]];
  saveCampaigns();
  render();
}

/* ─── Link CRUD ──────────────────────────────────────── */
function submitNewLink(campId) {
  const c = findCampaign(campId);
  const label = document.getElementById('f-link-label').value.trim();
  const href = document.getElementById('f-link-href').value.trim();
  if (!label || !href) { alert('Label and URL are both required.'); return; }
  c.links = c.links || [];
  c.links.push({ id: uid('lnk'), label, href });
  openEditId = null;
  saveCampaigns();
  render();
}

function deleteLink(campId, linkId) {
  const c = findCampaign(campId);
  if (!confirm('Remove this link?')) return;
  c.links = c.links.filter(x => x.id !== linkId);
  saveCampaigns();
  render();
}

/* ─── Render: dispatch ───────────────────────────────── */
function render() {
  if (currentCampaignId) { renderCampaignView(); } else { renderLibrary(); }
}

/* ─── Render: library ────────────────────────────────── */
function renderLibrary() {
  document.body.classList.remove('reading');
  document.getElementById('view-library').style.display = '';
  document.getElementById('view-campaign').style.display = 'none';
  document.getElementById('crumb-campaign').innerHTML = '';

  // The search box lives outside the card grid so hiding the cards while
  // results are up does not take the box with them.
  const slot = document.getElementById('lib-search-slot');
  if (slot && !document.getElementById('lib-search')) slot.innerHTML = librarySearchBoxHtml();

  const grid = document.getElementById('camp-grid');
  const camps = campaignsData.campaigns || [];
  let html = camps.map(c => `
    <div class="camp-card${editMode?' editing':''}" onclick="openCampaign('${c.id}')" tabindex="0" role="button" onkeydown="if(event.key==='Enter')openCampaign('${c.id}')">
      <div class="camp-card-icon">${escHtml(c.icon||'📘')}</div>
      <div class="camp-card-title">${escHtml(c.title)}</div>
      <div class="camp-card-tagline">${escHtml(c.tagline||'')}</div>
      <div class="camp-card-meta">${[c.levelRange, (c.chapters?.length ? c.chapters.length+' chapter'+(c.chapters.length===1?'':'s') : null)].filter(Boolean).map(escHtml).join(' · ')}</div>
      <div class="camp-card-actions edit-only">
        <button class="mini-btn danger" onclick="event.stopPropagation();deleteCampaign('${c.id}')">${ico('trash')}Delete</button>
      </div>
    </div>`).join('');

  if (!camps.length) html += '<div class="empty-note">No campaigns yet.</div>';

  if (editMode) {
    if (openEditId === 'new-campaign') {
      html += `<div class="camp-card-formwrap">${newCampaignFormHtml()}</div>`;
    } else {
      html += `<div class="camp-card camp-card-new" onclick="openEdit('new-campaign')">+ New Campaign</div>`;
    }
  }
  grid.innerHTML = html;
  // A query typed before an edit or a live update has to survive the rerender.
  renderLibrarySearch();
}

function newCampaignFormHtml() {
  return `<div class="form-card">
    <div class="edit-label">Icon (emoji)</div>
    <input class="edit-input icon-input" id="f-icon" type="text" value="📘" maxlength="4">
    <div class="edit-label">Title</div>
    <input class="edit-input" id="f-title" type="text" placeholder="Campaign title" autocomplete="off">
    <div class="edit-label">Tagline</div>
    <input class="edit-input" id="f-tagline" type="text" placeholder="One-line hook" autocomplete="off">
    <div class="row-2">
      <div><div class="edit-label">Level range</div><input class="edit-input" id="f-levels" type="text" placeholder="Levels 1–6"></div>
      <div><div class="edit-label">Length estimate</div><input class="edit-input" id="f-estimate" type="text" placeholder="e.g. 12 sessions"></div>
    </div>
    <div class="edit-label">Premise / tone</div>
    <textarea class="edit-textarea" id="f-tone" placeholder="What this campaign is about, and how it should feel at the table."></textarea>
    <div class="form-actions">
      <button class="mini-btn" onclick="submitNewCampaign()">${ico('check')}Create Campaign</button>
      <button class="mini-btn ghost" onclick="closeEdit()">Cancel</button>
    </div>
  </div>`;
}

/* ─── Render: campaign detail ────────────────────────── */
function renderCampaignView() {
  const c = findCampaign(currentCampaignId);
  document.body.classList.add('reading');
  document.getElementById('view-library').style.display = 'none';
  const view = document.getElementById('view-campaign');
  view.style.display = '';

  if (!c) {
    document.getElementById('crumb-campaign').innerHTML = '';
    view.innerHTML = `<p style="padding:20px 0;color:var(--text-dim);">Campaign not found. <a href="#" onclick="location.hash='';return false;" style="color:var(--primary-text);">Back to library</a></p>`;
    return;
  }
  document.getElementById('crumb-campaign').innerHTML = `<span class="crumb-sep">›</span> ${escHtml(c.title)}`;

  const editingClass = editMode ? ' editing' : '';
  let html = `<a class="module-back" href="#" onclick="location.hash='';return false;">← All Campaigns</a>`;
  html += campaignSearchBoxHtml();
  // The rail is a second, sticky copy of the contents for wide screens. An
  // eight-chapter module is too long to navigate by scrolling back to the top.
  html += `<div class="module-layout">`;
  html += `<div class="module${editingClass}">`;
  html += renderBanner(c);
  html += renderToc(c);
  html += renderProseSection(c, 'background', 'Adventure Background', true);
  html += renderChapters(c);
  html += renderProseSection(c, 'appendix', 'Appendix — Running Notes', false);
  html += renderLinksSection(c);
  html += `</div>`;
  html += renderRail(c);
  html += `</div>`;
  view.innerHTML = html;
  syncRail();
  // The query survives a re-render (an edit, a live update), so the results
  // have to be put back with it.
  renderCampaignSearch();
  // And a result clicked in the library asked for a block that only exists
  // now that this has rendered.
  consumePendingScroll();
}

/* ── Searching the whole library ───────────────────────────
   The module search needs you to have opened the right module first. This one
   does not: it runs over every campaign in the library and each result says
   which one it came from, opens it, and scrolls to the block — so "which of
   these has the bit about the white van" is one search rather than six. */
let libraryQuery = '';
const LIBRARY_SEARCH_LIMIT = 40;

// Set by a result click and consumed once the campaign has rendered: the
// router renders on hashchange, so the scroll target has to survive the gap
// between asking for the campaign and the block existing in the DOM.
let pendingScrollId = null;

function librarySearchBoxHtml() {
  return `<div class="library-search">
    <input id="lib-search" type="search" value="${escHtml(libraryQuery)}"
      placeholder="Search every module — press / to jump here"
      aria-label="Search every campaign" autocomplete="off"
      oninput="onLibrarySearch(this.value)" onkeydown="if(event.key==='Escape')onLibrarySearch('')">
    <span id="lib-search-count"></span>
  </div>
  <div id="lib-search-results"></div>`;
}

function onLibrarySearch(value) {
  libraryQuery = value;
  const box = document.getElementById('lib-search');
  if (box && box.value !== value) box.value = value;
  renderLibrarySearch();
}

function renderLibrarySearch() {
  const wrap = document.getElementById('lib-search-results');
  const count = document.getElementById('lib-search-count');
  const grid = document.getElementById('camp-grid');
  if (!wrap) return;
  const q = libraryQuery.trim();
  if (q.length < 2) {
    wrap.innerHTML = '';
    if (count) count.textContent = '';
    if (grid) grid.style.display = '';
    return;
  }
  const hits = campaignLibraryHits(campaignsData.campaigns || [], q, LIBRARY_SEARCH_LIMIT);
  // The cards are not useful while reading results, and leaving them under a
  // long list means scrolling past the answer to get to them.
  if (grid) grid.style.display = hits.length ? 'none' : '';
  if (count) count.textContent = hits.length ? `${hits.length}${hits.length === LIBRARY_SEARCH_LIMIT ? '+' : ''} found` : 'nothing';
  if (!hits.length) {
    wrap.innerHTML = `<div class="search-none">Nothing in any module matches “${escHtml(q)}”.</div>`;
    return;
  }
  wrap.innerHTML = hits.map(h => `<a class="search-hit" href="#/campaign/${encodeURIComponent(h.campaignId)}"
      onclick="openCampaignAt('${escAttr(h.campaignId)}','${escAttr(h.id)}');return false;">
    <div class="search-hit-head">
      <span class="search-hit-campaign">${escHtml(h.campaignIcon)} ${escHtml(h.campaignTitle)}</span>
      <span class="search-hit-where">${escHtml(h.where)}</span>
      <span class="search-hit-heading">${escHtml(h.heading)}</span></div>
    <div class="search-hit-snippet">${campaignHighlight(h.snippet, h.words)}</div>
  </a>`).join('');
}

// Ids and titles both end up inside a single-quoted onclick attribute.
function escAttr(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

function openCampaignAt(campaignId, blockId) {
  pendingScrollId = blockId;
  if (currentCampaignId === campaignId) {
    // Already here — no route change is coming, so do the scroll now.
    consumePendingScroll();
    return;
  }
  openCampaign(campaignId);
}

function consumePendingScroll() {
  if (!pendingScrollId) return;
  const id = pendingScrollId;
  pendingScrollId = null;
  // After paint: the campaign view is written in one innerHTML assignment, and
  // the element has to exist before it can be scrolled to.
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // A flash, because a smooth scroll into the middle of an eight-chapter
    // module leaves you unsure which paragraph you were sent to.
    el.classList.add('search-target');
    setTimeout(() => el.classList.remove('search-target'), 1800);
  });
}

// Press / to search, from anywhere that is not already a text field.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const box = document.getElementById(currentCampaignId ? 'camp-search' : 'lib-search');
  if (!box) return;
  e.preventDefault();
  box.focus();
  box.select();
});

/* ── The search box ────────────────────────────────────────
   Deliberately not part of render(): typing re-renders only the results
   list, because a full re-render of an eight-chapter module would rebuild the
   input the query is being typed into and take the caret with it. */
let campaignQuery = '';
const CAMPAIGN_SEARCH_LIMIT = 40;

function campaignSearchBoxHtml() {
  return `<div class="module-search">
    <input id="camp-search" type="search" value="${escHtml(campaignQuery)}"
      placeholder="Search this module — chapters, appendix, read-alouds…"
      aria-label="Search this module" autocomplete="off"
      oninput="onCampaignSearch(this.value)" onkeydown="if(event.key==='Escape')onCampaignSearch('')">
    <span id="camp-search-count"></span>
    <button class="module-search-clear" onclick="onCampaignSearch('')" title="Clear the search" aria-label="Clear the search">✕</button>
  </div>
  <div id="camp-search-results"></div>`;
}

function onCampaignSearch(value) {
  campaignQuery = value;
  const box = document.getElementById('camp-search');
  if (box && box.value !== value) box.value = value;
  renderCampaignSearch();
}

function renderCampaignSearch() {
  const wrap = document.getElementById('camp-search-results');
  const count = document.getElementById('camp-search-count');
  if (!wrap) return;
  const c = findCampaign(currentCampaignId);
  const q = campaignQuery.trim();
  if (!c || q.length < 2) {
    wrap.innerHTML = '';
    if (count) count.textContent = '';
    return;
  }
  const hits = campaignSearchHits(campaignSearchIndex(c), q, CAMPAIGN_SEARCH_LIMIT);
  if (count) count.textContent = hits.length ? `${hits.length}${hits.length === CAMPAIGN_SEARCH_LIMIT ? '+' : ''} found` : 'nothing';
  if (!hits.length) {
    wrap.innerHTML = `<div class="search-none">Nothing in this module matches “${escHtml(q)}”.</div>`;
    return;
  }
  wrap.innerHTML = hits.map(h => `<a class="search-hit" href="#${encodeURIComponent(h.id)}" onclick="onCampaignSearchJump()">
    <div class="search-hit-head"><span class="search-hit-where">${escHtml(h.where)}</span>
      <span class="search-hit-heading">${escHtml(h.heading)}</span></div>
    <div class="search-hit-snippet">${campaignHighlight(h.snippet, h.words)}</div>
  </a>`).join('');
}

// Clicking a result leaves the search open — the DM is usually looking for
// the second mention as well — but drops the results out of the way so the
// section they jumped to is what they are looking at.
function onCampaignSearchJump() {
  const wrap = document.getElementById('camp-search-results');
  if (wrap) wrap.innerHTML = '';
  const count = document.getElementById('camp-search-count');
  if (count) count.textContent = '';
}

/* The sticky rail. Chapters only — the inline contents carries the full
   nested index, and a rail long enough to need its own scrollbar is worse
   than no rail. Highlights the chapter currently on screen. */
function renderRail(c) {
  const chapters = c.chapters || [];
  if (!chapters.length && !(c.appendix || []).length) return '';
  let html = `<nav class="module-rail" aria-label="Module contents"><div class="rail-title">Contents</div>`;
  if (c.background?.length) html += `<a class="rail-link" href="#toc-background">Background</a>`;
  chapters.forEach(ch => {
    html += `<a class="rail-link" href="#${ch.id}" data-rail-for="${ch.id}">
      <span class="rail-num">${ch.number}</span><span class="rail-name">${escHtml(ch.title)}</span></a>`;
  });
  if (c.appendix?.length) html += `<a class="rail-link" href="#toc-appendix">Appendix</a>`;
  html += `<a class="rail-link rail-top" href="#" onclick="window.scrollTo({top:0,behavior:'smooth'});return false;">↑ Top</a>`;
  html += `</nav>`;
  return html;
}

/* Marks the rail link for whichever chapter is currently on screen. Rebuilt
   on every render, so the observer is torn down and recreated with it. */
let _railObserver = null;
function syncRail() {
  if (_railObserver) { _railObserver.disconnect(); _railObserver = null; }
  const links = document.querySelectorAll('.rail-link[data-rail-for]');
  if (!links.length || !('IntersectionObserver' in window)) return;
  const byId = {};
  links.forEach(a => { byId[a.dataset.railFor] = a; });
  const targets = Object.keys(byId).map(id => document.getElementById(id)).filter(Boolean);
  if (!targets.length) return;
  _railObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      const a = byId[e.target.id];
      if (a) a.classList.toggle('is-current', e.isIntersecting);
    });
  }, { rootMargin: '-25% 0px -65% 0px' });
  targets.forEach(t => _railObserver.observe(t));
}

function renderBanner(c) {
  if (openEditId === 'meta') {
    return `<div class="module-banner"><div class="form-card">
      <div class="edit-label">Icon (emoji)</div>
      <input class="edit-input icon-input" id="f-icon" type="text" value="${escHtml(c.icon||'📘')}" maxlength="4">
      <div class="edit-label">Title</div>
      <input class="edit-input" id="f-title" type="text" value="${escHtml(c.title)}">
      <div class="edit-label">Tagline</div>
      <input class="edit-input" id="f-tagline" type="text" value="${escHtml(c.tagline||'')}">
      <div class="row-2">
        <div><div class="edit-label">Level range</div><input class="edit-input" id="f-levels" type="text" value="${escHtml(c.levelRange||'')}"></div>
        <div><div class="edit-label">Length estimate</div><input class="edit-input" id="f-estimate" type="text" value="${escHtml(c.estimate||'')}"></div>
      </div>
      <div class="edit-label">Premise / tone</div>
      <textarea class="edit-textarea" id="f-tone">${escHtml(c.tone||'')}</textarea>
      <div class="form-actions">
        <button class="mini-btn" onclick="updateCampaignMeta('${c.id}')">${ico('check')}Save</button>
        <button class="mini-btn ghost" onclick="closeEdit()">Cancel</button>
      </div>
    </div></div>`;
  }
  return `<div class="module-banner">
    <div class="module-icon">${escHtml(c.icon||'📘')}</div>
    <div class="module-title">${escHtml(c.title)}</div>
    ${c.tagline ? `<div class="module-tagline">${escHtml(c.tagline)}</div>` : ''}
    <div class="module-chips">
      ${c.levelRange ? `<span class="module-chip">${escHtml(c.levelRange)}</span>` : ''}
      ${c.estimate ? `<span class="module-chip">${escHtml(c.estimate)}</span>` : ''}
      ${c.chapters?.length ? `<span class="module-chip">${c.chapters.length} chapter${c.chapters.length===1?'':'s'}</span>` : ''}
    </div>
    ${c.tone ? `<div class="module-tone">${renderProse(c.tone)}</div>` : ''}
    <div class="mini-row edit-only">
      <button class="mini-btn" onclick="openEdit('meta')">${ico('pencil')}Edit Details</button>
      <button class="mini-btn danger" onclick="deleteCampaign('${c.id}')">${ico('trash')}Delete Campaign</button>
    </div>
  </div>`;
}

/* Contents. Nested and collapsible, because a flat list of eight chapter
   titles tells a DM nothing about where a given scene is — and the appendix
   is now twenty-odd entries, which is the half people actually look things
   up in. <details> gives the collapse with no JS and no state to keep. */
function renderToc(c) {
  const chapters = c.chapters || [];
  let html = `<div class="module-toc"><div class="module-toc-title">Table of Contents</div>`;

  if (c.background?.length) {
    html += `<details class="toc-group"><summary class="toc-summary">
        <span class="toc-label">Adventure Background</span>
        <span class="toc-count">${c.background.length}</span>
      </summary><div class="toc-children">`;
    c.background.forEach(b => { html += `<a href="#${b.id}">${escHtml(b.heading)}</a>`; });
    html += `</div></details>`;
  }

  chapters.forEach(ch => {
    const secs = ch.sections || [];
    const quests = ch.sidequests || [];
    html += `<details class="toc-group"><summary class="toc-summary">
        <span class="toc-label">Chapter ${ch.number}: ${escHtml(ch.title)}</span>
        <span class="toc-count">${escHtml(ch.levels || '')}</span>
      </summary><div class="toc-children">`;
    html += `<a href="#${ch.id}">Chapter opening${ch.estimate ? ` — ${escHtml(ch.estimate)}` : ''}</a>`;
    secs.forEach(s => {
      html += `<a href="#${s.id}">${SECTION_ICON[s.type] || '📄'} ${escHtml(s.heading)}</a>`;
    });
    if (quests.length) html += `<a href="#quests-${ch.id}">🧭 Side quests <span class="toc-count">${quests.length}</span></a>`;
    html += `</div></details>`;
  });

  if (c.appendix?.length) {
    html += `<details class="toc-group"><summary class="toc-summary">
        <span class="toc-label">Appendix — Running Notes</span>
        <span class="toc-count">${c.appendix.length}</span>
      </summary><div class="toc-children">`;
    c.appendix.forEach(a => { html += `<a href="#${a.id}">${escHtml(a.heading)}</a>`; });
    html += `</div></details>`;
  }

  html += `</div>`;
  return html;
}

function renderProseSection(c, key, title, dropcap) {
  const items = c[key] || [];
  if (!items.length && !editMode) return '';
  let html = `<h2 class="module-h2" id="toc-${key}">${escHtml(title)}</h2>`;
  html += `<div class="prose${dropcap?' dropcap':''}">`;
  items.forEach((item, i) => {
    if (openEditId === `${key}:${item.id}`) {
      html += proseEditFormHtml(c.id, key, item);
    } else {
      html += `<div class="prose-item" id="${item.id}">
        <div class="prose-item-heading">${escHtml(item.heading)}</div>
        ${renderProse(item.body)}
        <div class="mini-row edit-only">
          <button class="mini-btn ghost" ${i===0?'disabled':''} onclick="moveProse('${c.id}','${key}','${item.id}',-1)">▲</button>
          <button class="mini-btn ghost" ${i===items.length-1?'disabled':''} onclick="moveProse('${c.id}','${key}','${item.id}',1)">▼</button>
          <button class="mini-btn" onclick="openEdit('${key}:${item.id}')">${ico('pencil')}Edit</button>
          <button class="mini-btn danger" onclick="deleteProse('${c.id}','${key}','${item.id}')">${ico('trash')}Delete</button>
        </div>
      </div>`;
    }
  });
  html += `</div>`;
  if (editMode) {
    if (openEditId === `new-${key}`) {
      html += proseEditFormHtml(c.id, key, null);
    } else {
      html += `<button type="button" class="add-block-btn" onclick="openEdit('new-${key}')">+ Add Entry</button>`;
    }
  }
  return html;
}

function proseEditFormHtml(campId, key, item) {
  const action = item ? `updateProse('${campId}','${key}','${item.id}')` : `submitNewProse('${campId}','${key}')`;
  return `<div class="form-card">
    <div class="edit-label">Heading</div>
    <input class="edit-input" id="f-prose-heading" type="text" value="${escHtml(item?.heading||'')}" placeholder="e.g. The City">
    <div class="edit-label">Text</div>
    <textarea class="edit-textarea" id="f-prose-body" style="min-height:120px;" placeholder="Separate paragraphs with a blank line.">${escHtml(item?.body||'')}</textarea>
    <div class="form-actions">
      <button class="mini-btn" onclick="${action}">${ico('check')}Save</button>
      <button class="mini-btn ghost" onclick="closeEdit()">Cancel</button>
    </div>
  </div>`;
}

function renderChapters(c) {
  let html = (c.chapters||[]).map((ch, i) => renderChapter(c, ch, i, c.chapters.length)).join('');
  if (editMode) {
    if (openEditId === 'new-chapter') {
      html += `<div class="chapter-block">${chapterEditFormHtml(c.id, null)}</div>`;
    } else {
      html += `<button type="button" class="add-block-btn" onclick="openEdit('new-chapter')">+ Add Chapter</button>`;
    }
  }
  return html;
}

function renderChapter(c, ch, idx, total) {
  if (openEditId === `ch:${ch.id}`) {
    return `<div class="chapter-block" id="${ch.id}">${chapterEditFormHtml(c.id, ch)}</div>`;
  }
  let html = `<div class="chapter-block" id="${ch.id}">
    <div class="chapter-kicker">Chapter ${ch.number}</div>
    <div class="chapter-title">${escHtml(ch.title)}</div>
    <div class="chapter-meta">${[ch.levels, ch.estimate].filter(Boolean).map(escHtml).join(' · ')}</div>
    ${ch.intro ? `<div class="chapter-intro">${renderProse(ch.intro)}</div>` : ''}
    ${ch.dmNote ? `<div class="callout callout-dm"><div class="callout-label">🎲 DM at a Glance</div>${renderProse(ch.dmNote)}</div>` : ''}
    <div class="mini-row edit-only">
      <button class="mini-btn ghost" ${idx===0?'disabled':''} onclick="moveChapter('${c.id}','${ch.id}',-1)">▲ Move Up</button>
      <button class="mini-btn ghost" ${idx===total-1?'disabled':''} onclick="moveChapter('${c.id}','${ch.id}',1)">▼ Move Down</button>
      <button class="mini-btn" onclick="openEdit('ch:${ch.id}')">${ico('pencil')}Edit Chapter</button>
      <button class="mini-btn danger" onclick="deleteChapter('${c.id}','${ch.id}')">${ico('trash')}Delete Chapter</button>
    </div>`;

  (ch.sections||[]).forEach((s, i) => { html += renderSection(c, ch, s, i, ch.sections.length); });

  if (editMode) {
    if (openEditId === `new-section:${ch.id}`) {
      html += sectionEditFormHtml(c.id, ch.id, null);
    } else {
      html += `<button type="button" class="add-block-btn" onclick="openEdit('new-section:${ch.id}')">+ Add Subheading</button>`;
    }
  }

  html += renderSideQuests(c, ch);

  if (ch.closing?.body) {
    html += `<div class="callout callout-closing"><div class="callout-label">${escHtml(ch.closing.label||'Closing Note')}</div>${renderProse(ch.closing.body)}</div>`;
  }
  if (ch.milestone) {
    html += `<div class="callout callout-milestone"><div class="callout-label">🏅 Milestone</div>${renderProse(ch.milestone)}</div>`;
  }
  html += `</div>`;
  return html;
}

/* ─── Side quests ────────────────────────────────────────
   These used to live in two enormous appendix entries sorted by the
   chapter they unlock in, which meant a DM running Chapter 3 had to
   scroll to the back of the book and read past four other chapters'
   quests to find the three that were live. They belong in the chapter
   that opens them. Each quest is { id, name, giver, slots, body,
   reward, hook } — hook being an opening line to say out loud, so a
   quest arrives as a scene rather than as an offer. */
function renderSideQuests(c, ch) {
  const quests = ch.sidequests || [];
  if (!quests.length && !editMode) return '';

  let html = `<div class="quest-block" id="quests-${ch.id}">
    <div class="quest-block-head">
      <span class="quest-block-title">🧭 Side Quests</span>
      <span class="quest-block-sub">${quests.length ? `${quests.length} open from this chapter · offer two or three, casually` : 'none yet'}</span>
    </div>`;

  quests.forEach((q, i) => {
    if (openEditId === `sq:${q.id}`) { html += questEditFormHtml(c.id, ch.id, q); return; }
    const meta = [q.giver, q.slots].filter(Boolean).map(escHtml).join(' · ');
    html += `<div class="quest-card" id="${q.id}">
      <div class="quest-name">${escHtml(q.name)}</div>
      ${meta ? `<div class="quest-meta">${meta}</div>` : ''}
      ${q.hook ? `<div class="quest-hook">${escHtml(q.hook)}</div>` : ''}
      ${q.body ? `<div class="quest-body prose">${renderProse(q.body)}</div>` : ''}
      ${q.reward ? `<div class="quest-reward"><span class="quest-reward-label">Reward</span> ${escHtml(q.reward)}</div>` : ''}
      <div class="mini-row edit-only">
        <button class="mini-btn ghost" ${i===0?'disabled':''} onclick="moveQuest('${c.id}','${ch.id}','${q.id}',-1)">▲</button>
        <button class="mini-btn ghost" ${i===quests.length-1?'disabled':''} onclick="moveQuest('${c.id}','${ch.id}','${q.id}',1)">▼</button>
        <button class="mini-btn" onclick="openEdit('sq:${q.id}')">${ico('pencil')}Edit</button>
        <button class="mini-btn danger" onclick="deleteQuest('${c.id}','${ch.id}','${q.id}')">${ico('trash')}Delete</button>
      </div>
    </div>`;
  });

  if (editMode) {
    if (openEditId === `new-quest:${ch.id}`) {
      html += questEditFormHtml(c.id, ch.id, null);
    } else {
      html += `<button type="button" class="add-block-btn" onclick="openEdit('new-quest:${ch.id}')">+ Add Side Quest</button>`;
    }
  }
  html += `</div>`;
  return html;
}

function questEditFormHtml(campId, chId, q) {
  const action = q ? `updateQuest('${campId}','${chId}','${q.id}')` : `submitNewQuest('${campId}','${chId}')`;
  return `<div class="form-card">
    <div class="edit-label">Quest name</div>
    <input class="edit-input" id="f-sq-name" type="text" value="${escHtml(q?.name||'')}" placeholder="e.g. Hiro's Signs">
    <div class="row-2">
      <div><div class="edit-label">Who brings it</div><input class="edit-input" id="f-sq-giver" type="text" value="${escHtml(q?.giver||'')}" placeholder="e.g. Hiro"></div>
      <div><div class="edit-label">Cost</div><input class="edit-input" id="f-sq-slots" type="text" value="${escHtml(q?.slots||'')}" placeholder="e.g. 2 slots"></div>
    </div>
    <div class="edit-label">Opening line (said out loud, optional)</div>
    <input class="edit-input" id="f-sq-hook" type="text" value="${escHtml(q?.hook||'')}" placeholder="A line of dialogue that starts the scene.">
    <div class="edit-label">What it is</div>
    <textarea class="edit-textarea" id="f-sq-body">${escHtml(q?.body||'')}</textarea>
    <div class="edit-label">Reward</div>
    <textarea class="edit-textarea" id="f-sq-reward" style="min-height:70px;">${escHtml(q?.reward||'')}</textarea>
    <div class="form-actions">
      <button class="mini-btn" onclick="${action}">✓ Save Quest</button>
      <button class="mini-btn ghost" onclick="closeEdit()">Cancel</button>
    </div>
  </div>`;
}

function readQuestForm() {
  return {
    name:   document.getElementById('f-sq-name').value.trim(),
    giver:  document.getElementById('f-sq-giver').value.trim(),
    slots:  document.getElementById('f-sq-slots').value.trim(),
    hook:   document.getElementById('f-sq-hook').value.trim(),
    body:   document.getElementById('f-sq-body').value.trim(),
    reward: document.getElementById('f-sq-reward').value.trim(),
  };
}

// Distinct from findChapter(c, chId) above, which takes a campaign object.
function questChapter(campId, chId) {
  const c = findCampaign(campId);
  return (c?.chapters || []).find(x => x.id === chId);
}

function submitNewQuest(campId, chId) {
  const ch = questChapter(campId, chId);
  if (!ch) return;
  const q = readQuestForm();
  if (!q.name) return;
  ch.sidequests = ch.sidequests || [];
  ch.sidequests.push({ id: uid('sq'), ...q });
  closeEdit(); saveCampaigns();
}

function updateQuest(campId, chId, qId) {
  const ch = questChapter(campId, chId);
  const q = (ch?.sidequests || []).find(x => x.id === qId);
  if (!q) return;
  Object.assign(q, readQuestForm());
  closeEdit(); saveCampaigns();
}

function deleteQuest(campId, chId, qId) {
  if (!confirm('Delete this side quest?')) return;
  const ch = questChapter(campId, chId);
  if (!ch) return;
  ch.sidequests = (ch.sidequests || []).filter(x => x.id !== qId);
  render(); saveCampaigns();
}

function moveQuest(campId, chId, qId, dir) {
  const ch = questChapter(campId, chId);
  const list = ch?.sidequests;
  if (!list) return;
  const i = list.findIndex(x => x.id === qId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  render(); saveCampaigns();
}

function chapterEditFormHtml(campId, ch) {
  const action = ch ? `updateChapter('${campId}','${ch.id}')` : `submitNewChapter('${campId}')`;
  return `<div class="form-card">
    <div class="row-2">
      <div><div class="edit-label">Chapter title</div><input class="edit-input" id="f-ch-title" type="text" value="${escHtml(ch?.title||'')}" placeholder="e.g. Welcome to U.A."></div>
      <div><div class="edit-label">Levels</div><input class="edit-input" id="f-ch-levels" type="text" value="${escHtml(ch?.levels||'')}" placeholder="Levels 1–3"></div>
    </div>
    <div class="edit-label">Length estimate</div>
    <input class="edit-input" id="f-ch-estimate" type="text" value="${escHtml(ch?.estimate||'')}" placeholder="5–6 sessions">
    <div class="edit-label">Chapter intro</div>
    <textarea class="edit-textarea" id="f-ch-intro" placeholder="What this chapter is about, and how it should feel.">${escHtml(ch?.intro||'')}</textarea>
    <div class="edit-label">DM at a glance (optional)</div>
    <textarea class="edit-textarea" id="f-ch-dmnote" placeholder="Running notes for the table.">${escHtml(ch?.dmNote||'')}</textarea>
    <div class="edit-label">Milestone (optional — shown at the end of the chapter)</div>
    <input class="edit-input" id="f-ch-milestone" type="text" value="${escHtml(ch?.milestone||'')}" placeholder="e.g. Reaching Shadowgrange completes a story milestone — Level 2!">
    <div class="form-actions">
      <button class="mini-btn" onclick="${action}">✓ Save Chapter</button>
      <button class="mini-btn ghost" onclick="closeEdit()">Cancel</button>
    </div>
  </div>`;
}

const SECTION_TYPES = [
  ['general','General'], ['encounter','Encounter'], ['npc','NPC'],
  ['location','Location'], ['treasure','Treasure'], ['dmnote','DM Note'],
];
const SECTION_ICON = { general:'📄', encounter:'⚔', npc:'🧑', location:'🗺', treasure:'💰', dmnote:'🎲' };

function renderSection(c, ch, s, idx, total) {
  if (openEditId === `sec:${s.id}`) {
    return `<div class="section-block">${sectionEditFormHtml(c.id, ch.id, s)}</div>`;
  }
  let html = `<div class="section-block" id="${s.id}">
    <div class="section-heading-row">
      <span class="section-heading-text">${SECTION_ICON[s.type]||'📄'} ${escHtml(s.heading)}</span>
      ${s.tag ? `<span class="section-tag">${escHtml(s.tag)}</span>` : ''}
    </div>`;
  if (s.readAloud) html += `<div class="callout callout-readaloud"><div class="callout-label">📖 Read Aloud</div>${renderReadAloud(s.readAloud)}</div>`;
  if (s.body) html += `<div class="prose">${renderProse(s.body)}</div>`;
  if (s.developments) html += `<div class="callout callout-developments"><div class="callout-label">🔀 Developments</div>${renderProse(s.developments)}</div>`;
  if (s.treasure) html += `<div class="callout callout-treasure"><div class="callout-label">💰 Treasure</div>${renderProse(s.treasure)}</div>`;
  if (s.dmNote) html += `<div class="callout callout-dm"><div class="callout-label">🎲 DM Note</div>${renderProse(s.dmNote)}</div>`;
  if (s.aside?.body) html += `<div class="callout callout-aside"><div class="callout-label">${escHtml(s.aside.label||'Note')}</div>${renderProse(s.aside.body)}</div>`;
  html += `<div class="mini-row edit-only section-controls">
      <button class="mini-btn ghost" ${idx===0?'disabled':''} onclick="moveSection('${c.id}','${ch.id}','${s.id}',-1)">▲</button>
      <button class="mini-btn ghost" ${idx===total-1?'disabled':''} onclick="moveSection('${c.id}','${ch.id}','${s.id}',1)">▼</button>
      <button class="mini-btn" onclick="openEdit('sec:${s.id}')">${ico('pencil')}Edit</button>
      <button class="mini-btn danger" onclick="deleteSection('${c.id}','${ch.id}','${s.id}')">${ico('trash')}Delete</button>
    </div>`;
  html += `</div>`;
  return html;
}

function sectionEditFormHtml(campId, chId, s) {
  const action = s ? `updateSection('${campId}','${chId}','${s.id}')` : `submitNewSection('${campId}','${chId}')`;
  return `<div class="form-card">
    <div class="row-2">
      <div><div class="edit-label">Subheading</div><input class="edit-input" id="f-sec-heading" type="text" value="${escHtml(s?.heading||'')}" placeholder="e.g. The Entrance Exam"></div>
      <div><div class="edit-label">Type</div><select class="edit-select" id="f-sec-type">${SECTION_TYPES.map(([v,l])=>`<option value="${v}" ${s?.type===v?'selected':''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="edit-label">Tag / subtitle (optional)</div>
    <input class="edit-input" id="f-sec-tag" type="text" value="${escHtml(s?.tag||'')}" placeholder="e.g. Opening session · 1 session">
    <div class="edit-label">Read-aloud text (optional)</div>
    <textarea class="edit-textarea" id="f-sec-readaloud" placeholder="Scene-setting text to read or paraphrase to players.">${escHtml(s?.readAloud||'')}</textarea>
    <div class="edit-label">Body</div>
    <textarea class="edit-textarea" id="f-sec-body" style="min-height:140px;" placeholder="Beats, details, whatever this subheading needs. Blank line = new paragraph; lines starting with • become a bulleted list.">${escHtml(s?.body||'')}</textarea>
    <div class="edit-label">Developments (optional — what happens as a result of player choices)</div>
    <textarea class="edit-textarea" id="f-sec-developments" placeholder="Branches, consequences, what changes based on what the players did.">${escHtml(s?.developments||'')}</textarea>
    <div class="edit-label">Treasure (optional)</div>
    <textarea class="edit-textarea" id="f-sec-treasure" placeholder="Loot, gear, favors, or recognition earned here.">${escHtml(s?.treasure||'')}</textarea>
    <div class="edit-label">DM note (optional)</div>
    <textarea class="edit-textarea" id="f-sec-dmnote" placeholder="Guidance for running this, not meant to be read aloud.">${escHtml(s?.dmNote||'')}</textarea>
    <div class="edit-label">Extra callout (optional — e.g. villain threads, foreshadowing)</div>
    <input class="edit-input" id="f-sec-aside-label" type="text" value="${escHtml(s?.aside?.label||'')}" placeholder="Callout label, e.g. Villain Threads" style="margin-bottom:6px;">
    <textarea class="edit-textarea" id="f-sec-aside-body" placeholder="Callout text.">${escHtml(s?.aside?.body||'')}</textarea>
    <div class="form-actions">
      <button class="mini-btn" onclick="${action}">✓ Save Subheading</button>
      <button class="mini-btn ghost" onclick="closeEdit()">Cancel</button>
    </div>
  </div>`;
}

function renderLinksSection(c) {
  const links = c.links || [];
  if (!links.length && !editMode) return '';
  let html = `<h2 class="module-h2">Related Pages</h2><div class="module-links">`;
  links.forEach(l => {
    html += `<a class="module-link-card" href="${escHtml(l.href)}">🔗 ${escHtml(l.label)}${editMode?` <span onclick="event.preventDefault();event.stopPropagation();deleteLink('${c.id}','${l.id}')" class="edit-only" style="margin-left:6px;">🗑</span>`:''}</a>`;
  });
  html += `</div>`;
  if (editMode) {
    if (openEditId === 'new-link') {
      html += `<div class="form-card">
        <div class="edit-label">Label</div>
        <input class="edit-input" id="f-link-label" type="text" placeholder="e.g. Full villain, NPC & world database">
        <div class="edit-label">Link (URL or local page)</div>
        <input class="edit-input" id="f-link-href" type="text" placeholder="e.g. campaign-overview.html">
        <div class="form-actions">
          <button class="mini-btn" onclick="submitNewLink('${c.id}')">✓ Add Link</button>
          <button class="mini-btn ghost" onclick="closeEdit()">Cancel</button>
        </div>
      </div>`;
    } else {
      html += `<button type="button" class="add-block-btn" onclick="openEdit('new-link')">+ Add Link</button>`;
    }
  }
  return html;
}

/* ─── Init ───────────────────────────────────────────── */
async function init() {
  campaignsData = await loadCampaigns();
  campaignsData.campaigns = campaignsData.campaigns || [];
  _lastSyncedCampaigns = fsCloneDoc(campaignsData); // cloned: a baseline must never alias live state (see auth.js cloneDoc)
  document.getElementById('loading').style.display = 'none';
  currentCampaignId = parseHash();
  render();
  startCampaignsLiveSync();
}
init();
