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
function uid(prefix) { return (prefix||'id') + '-' + Math.random().toString(36).slice(2, 9); }

function renderProse(text) {
  if (!text) return '';
  const paragraphs = String(text).split(/\n\n+/);
  return paragraphs.map(p => {
    const lines = p.split('\n').filter(l => l.length);
    if (lines.length > 1 && lines.every(l => l.trim().startsWith('•'))) {
      return '<ul>' + lines.map(l => `<li>${escHtml(l.replace(/^•\s*/,''))}</li>`).join('') + '</ul>';
    }
    if (lines.length === 1 && lines[0].trim().startsWith('•')) {
      return '<ul><li>' + escHtml(lines[0].replace(/^•\s*/,'')) + '</li></ul>';
    }
    return `<p>${lines.map(l=>escHtml(l)).join('<br>')}</p>`;
  }).join('');
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
  btn.textContent = editMode ? '👁 Done' : '✏️ Edit';
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
  document.getElementById('view-library').style.display = '';
  document.getElementById('view-campaign').style.display = 'none';
  document.getElementById('crumb-campaign').innerHTML = '';

  const grid = document.getElementById('camp-grid');
  const camps = campaignsData.campaigns || [];
  let html = camps.map(c => `
    <div class="camp-card${editMode?' editing':''}" onclick="openCampaign('${c.id}')" tabindex="0" role="button" onkeydown="if(event.key==='Enter')openCampaign('${c.id}')">
      <div class="camp-card-icon">${escHtml(c.icon||'📘')}</div>
      <div class="camp-card-title">${escHtml(c.title)}</div>
      <div class="camp-card-tagline">${escHtml(c.tagline||'')}</div>
      <div class="camp-card-meta">${[c.levelRange, (c.chapters?.length ? c.chapters.length+' chapter'+(c.chapters.length===1?'':'s') : null)].filter(Boolean).map(escHtml).join(' · ')}</div>
      <div class="camp-card-actions edit-only">
        <button class="mini-btn danger" onclick="event.stopPropagation();deleteCampaign('${c.id}')">🗑 Delete</button>
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
      <button class="mini-btn" onclick="submitNewCampaign()">✓ Create Campaign</button>
      <button class="mini-btn ghost" onclick="closeEdit()">Cancel</button>
    </div>
  </div>`;
}

/* ─── Render: campaign detail ────────────────────────── */
function renderCampaignView() {
  const c = findCampaign(currentCampaignId);
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
  html += `<div class="module${editingClass}">`;
  html += renderBanner(c);
  html += renderToc(c);
  html += renderProseSection(c, 'background', 'Adventure Background', true);
  html += renderChapters(c);
  html += renderProseSection(c, 'appendix', 'Appendix — Running Notes', false);
  html += renderLinksSection(c);
  html += `</div>`;
  view.innerHTML = html;
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
        <button class="mini-btn" onclick="updateCampaignMeta('${c.id}')">✓ Save</button>
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
      <button class="mini-btn" onclick="openEdit('meta')">✏️ Edit Details</button>
      <button class="mini-btn danger" onclick="deleteCampaign('${c.id}')">🗑 Delete Campaign</button>
    </div>
  </div>`;
}

function renderToc(c) {
  let html = `<div class="module-toc"><div class="module-toc-title">Table of Contents</div>`;
  if (c.background?.length) html += `<a href="#toc-background">Adventure Background</a>`;
  (c.chapters||[]).forEach(ch => {
    html += `<a href="#${ch.id}">Chapter ${ch.number}: ${escHtml(ch.title)}<span class="toc-sub"> — ${escHtml(ch.levels||'')}</span></a>`;
  });
  if (c.appendix?.length) html += `<a href="#toc-appendix">Appendix — Running Notes</a>`;
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
      html += `<div class="prose-item">
        <div class="prose-item-heading">${escHtml(item.heading)}</div>
        ${renderProse(item.body)}
        <div class="mini-row edit-only">
          <button class="mini-btn ghost" ${i===0?'disabled':''} onclick="moveProse('${c.id}','${key}','${item.id}',-1)">▲</button>
          <button class="mini-btn ghost" ${i===items.length-1?'disabled':''} onclick="moveProse('${c.id}','${key}','${item.id}',1)">▼</button>
          <button class="mini-btn" onclick="openEdit('${key}:${item.id}')">✏️ Edit</button>
          <button class="mini-btn danger" onclick="deleteProse('${c.id}','${key}','${item.id}')">🗑 Delete</button>
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
      <button class="mini-btn" onclick="${action}">✓ Save</button>
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
      <button class="mini-btn" onclick="openEdit('ch:${ch.id}')">✏️ Edit Chapter</button>
      <button class="mini-btn danger" onclick="deleteChapter('${c.id}','${ch.id}')">🗑 Delete Chapter</button>
    </div>`;

  (ch.sections||[]).forEach((s, i) => { html += renderSection(c, ch, s, i, ch.sections.length); });

  if (editMode) {
    if (openEditId === `new-section:${ch.id}`) {
      html += sectionEditFormHtml(c.id, ch.id, null);
    } else {
      html += `<button type="button" class="add-block-btn" onclick="openEdit('new-section:${ch.id}')">+ Add Subheading</button>`;
    }
  }

  if (ch.closing?.body) {
    html += `<div class="callout callout-closing"><div class="callout-label">${escHtml(ch.closing.label||'Closing Note')}</div>${renderProse(ch.closing.body)}</div>`;
  }
  if (ch.milestone) {
    html += `<div class="callout callout-milestone"><div class="callout-label">🏅 Milestone</div>${renderProse(ch.milestone)}</div>`;
  }
  html += `</div>`;
  return html;
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
  let html = `<div class="section-block">
    <div class="section-heading-row">
      <span class="section-heading-text">${SECTION_ICON[s.type]||'📄'} ${escHtml(s.heading)}</span>
      ${s.tag ? `<span class="section-tag">${escHtml(s.tag)}</span>` : ''}
    </div>`;
  if (s.readAloud) html += `<div class="callout callout-readaloud"><div class="callout-label">📖 Read Aloud</div>${renderProse(s.readAloud)}</div>`;
  if (s.body) html += `<div class="prose">${renderProse(s.body)}</div>`;
  if (s.developments) html += `<div class="callout callout-developments"><div class="callout-label">🔀 Developments</div>${renderProse(s.developments)}</div>`;
  if (s.treasure) html += `<div class="callout callout-treasure"><div class="callout-label">💰 Treasure</div>${renderProse(s.treasure)}</div>`;
  if (s.dmNote) html += `<div class="callout callout-dm"><div class="callout-label">🎲 DM Note</div>${renderProse(s.dmNote)}</div>`;
  if (s.aside?.body) html += `<div class="callout callout-aside"><div class="callout-label">${escHtml(s.aside.label||'Note')}</div>${renderProse(s.aside.body)}</div>`;
  html += `<div class="mini-row edit-only section-controls">
      <button class="mini-btn ghost" ${idx===0?'disabled':''} onclick="moveSection('${c.id}','${ch.id}','${s.id}',-1)">▲</button>
      <button class="mini-btn ghost" ${idx===total-1?'disabled':''} onclick="moveSection('${c.id}','${ch.id}','${s.id}',1)">▼</button>
      <button class="mini-btn" onclick="openEdit('sec:${s.id}')">✏️ Edit</button>
      <button class="mini-btn danger" onclick="deleteSection('${c.id}','${ch.id}','${s.id}')">🗑 Delete</button>
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
