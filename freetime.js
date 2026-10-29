// Page logic for freetime.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// Runs after auth.js, so fbAuthReady/isAdmin/canEdit are already defined.
//
// ── What this page is ───────────────────────────────────────────────
// The campaign's whole between-sessions economy runs on slots — "one slot,
// one check, one wage", "half a training slot", "three slots each" — and
// nothing has ever tracked them. This does. Pick your character, see how
// many slots the DM has given you this window, spend them, and keep the
// record of what you did and what it paid.
//
// ── The jobs are the campaign's, not a copy of them ────────────────
// The menu is parsed out of the "Free Time — odd jobs" appendix at load,
// not retyped here. Every line in that section has the same shape —
//
//     · KONBINI NIGHT SHIFT — any. CON DC 10. ¥6,000. On a failure you are
//       wrecked next session (no Inspiration). In Kōenji, your co-worker
//       has a pompadour.
//
// — so the parser reads the name, the check, the wage and the rest of the
// line as its note, and scripts/verify-freetime.js holds it to parsing
// every single one. If the appendix is rewritten and a line stops parsing,
// the build fails rather than the page quietly dropping a job.
//
// ── What it will not do ─────────────────────────────────────────────
// Pay you. firestore.rules refuses any write to an inventory that increases
// the purse, which is the rule that stops a player giving themselves ten
// thousand yen — and it is a good rule. So this page works out what a job
// owes, writes it in the log, and tells you to go and ask. The DM pays out
// from the admin page, as they always have.

const db = firebase.firestore();
const FS_CAMPAIGNS = db.collection('mha-dnd').doc('campaigns');
const LS_FT = 'mha-freetime-v1';

let jobs = [];
let jobSource = '';
let chars = [];
let mine = [];
let charFile = null;
let charsLoaded = false;
let jobsLoaded = false;
let canWrite = false;
let isDm = false;
let sheet = { slots: 3, window: '', entries: [] };
let lastRoll = null;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ftId() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/* ── Reading the jobs out of the campaign ───────────────────────────
   One parser, one shape, and it refuses a line it cannot read rather than
   guessing — a job with the wrong wage on it is worse than a job that is
   missing, because nobody checks a number that is already there.
   ─────────────────────────────────────────────────────────────────── */

// "· ★ EVENT SECURITY — WIS DC 12. ¥10,000. A civilian job; …"
const FT_LINE = /^·\s*(★\s*)?([^—]+?)\s*—\s*(.+)$/;

function freetimeParseJobs(body) {
  const out = [];
  let block = 'first';
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // The appendix splits into two blocks and the second is second-years
    // only, from Chapter 7. A first-year seeing those as available is the
    // one thing this page could get wrong that the campaign would notice.
    if (/^THE SECOND BLOCK/i.test(line)) { block = 'second'; continue; }
    if (!/^·/.test(line)) continue;
    const m = line.match(FT_LINE);
    if (!m) continue;
    const rest = m[3];
    const check = (rest.match(/((?:STR|DEX|CON|INT|WIS|CHA|any)[^.]*?DC\s*\d+|no check|a fight)/i) || [])[1] || '';
    const pay = (rest.match(/¥[\d,]+(?:\s*to\s*¥[\d,]+)?|no pay/i) || [])[0] || '';
    out.push({
      id: m[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: m[2].trim(),
      fame: !!m[1],
      block,
      check,
      pay,
      raw: rest,
    });
  }
  return out;
}

// "DEX or CHA DC 11" → { abilities: ['DEX','CHA'], dc: 11 }; "no check" and
// "a fight" give no roll at all, which the page says rather than inventing
// a DC for a boxing match.
function freetimeCheckOf(job) {
  const text = String((job && job.check) || '');
  const dc = Number((text.match(/DC\s*(\d+)/i) || [])[1]);
  if (!Number.isFinite(dc)) return null;
  const abilities = (text.match(/STR|DEX|CON|INT|WIS|CHA/gi) || []).map(a => a.toUpperCase());
  return { abilities, dc, any: /^any\b/i.test(text) && !abilities.length };
}

// The wage, as a number, so a halved one can be worked out. "¥25,000 to
// ¥85,000" takes the low end — the purse it is written into is the DM's to
// decide and this is the honest floor.
function freetimePayOf(job) {
  const m = String((job && job.pay) || '').match(/¥([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/* ── The sheet ──────────────────────────────────────────────────────
   One document per character, like the Heropad's pads — so two players
   logging a slot at the same time cannot write over each other, and the
   document stays small.
   ─────────────────────────────────────────────────────────────────── */

function sheetDoc(file) {
  return db.collection('mha-dnd').doc('freetime-' + String(file || '').replace(/\.json$/, ''));
}

function emptySheet() {
  return { slots: 3, window: '', entries: [] };
}

function spent() {
  return (sheet.entries || []).reduce((n, e) => n + (Number(e.cost) || 0), 0);
}

function left() {
  return Math.max(0, (Number(sheet.slots) || 0) - spent());
}

function earned() {
  return (sheet.entries || []).reduce((n, e) => n + (Number(e.pay) || 0), 0);
}

let saveTimer = null;
function saveSheet() {
  try { localStorage.setItem(LS_FT + '-' + charFile, JSON.stringify(sheet)); } catch {}
  if (!canWrite || !charFile) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await sheetDoc(charFile).set(sheet, { merge: true });
    } catch (e) {
      console.error('[freetime] could not save — it is still in this browser:', e);
      const el = document.getElementById('ft-save-state');
      if (el) el.textContent = 'Could not save to the server. Still saved here.';
    }
  }, 600);
}

async function loadSheet() {
  sheet = emptySheet();
  if (!charFile) return;
  try {
    const raw = localStorage.getItem(LS_FT + '-' + charFile);
    if (raw) sheet = Object.assign(emptySheet(), JSON.parse(raw));
  } catch {}
  try {
    const snap = await sheetDoc(charFile).get();
    if (snap.exists) sheet = Object.assign(emptySheet(), snap.data());
  } catch {}
}

/* ── Spending a slot ────────────────────────────────────────────────
   A job with a check rolls it through the shared engine, and the campaign's
   own rule about a failure is applied: "a failed check halves the pay."
   Nothing is paid out here — see the note at the top of this file.
   ─────────────────────────────────────────────────────────────────── */

const FT_EXTRA = [
  { id: 'training', name: 'Training', cost: 1, kind: 'training',
    text: 'A full training slot. What it is worth is between you and the DM.' },
  { id: 'training-half', name: 'Half a training slot', cost: 0.5, kind: 'training',
    text: 'What the gym cleaning shift and an open sparring session are worth.' },
  { id: 'hangout', name: 'A hangout', cost: 1, kind: 'hangout',
    text: 'One slot with one person, and there is nothing to roll. Say who, and your DM runs it.' },
  { id: 'other', name: 'Something else', cost: 1, kind: 'other',
    text: 'Write what you did. The DM decides what it was worth.' },
];

function charModFor(c, ability) {
  return typeof charModifier === 'function' ? charModifier(c, ability) : null;
}

// The best of the abilities a job offers, because "DEX or CHA" means your
// choice and a player would always pick the better one.
function bestModFor(c, abilities) {
  const mods = (abilities || []).map(a => charModFor(c, a)).filter(m => m != null);
  return mods.length ? Math.max(...mods) : null;
}

function currentChar() {
  return mine.find(c => c._file === charFile) || mine[0] || null;
}

function doJob(jobId) {
  const job = jobs.find(j => j.id === jobId);
  if (!job) return;
  if (left() < 1) { flash('No slots left this window.'); return; }
  const c = currentChar();
  const check = freetimeCheckOf(job);
  const pay = freetimePayOf(job);
  let roll = null;
  let passed = null;

  if (check && c) {
    const mod = check.any ? 0 : bestModFor(c, check.abilities);
    const expr = '1d20' + (mod == null || mod === 0 ? '' : (mod > 0 ? '+' : '-') + Math.abs(mod));
    const r = diceRoll(diceParse(expr));
    roll = { expr, total: r.total, breakdown: r.breakdown, dc: check.dc };
    passed = r.total >= check.dc;
  }

  // "A failed check halves the pay" — the appendix's own rule, applied here
  // rather than left for somebody to remember.
  const earnedNow = pay == null ? null : (passed === false ? Math.floor(pay / 2) : pay);

  sheet.entries = [{
    id: ftId(), at: Date.now(), cost: 1, kind: 'job',
    name: job.name, check: job.check, roll, passed, pay: earnedNow,
  }].concat(sheet.entries || []);
  lastRoll = { name: job.name, roll, passed, pay: earnedNow };
  saveSheet();
  render();
}

function doExtra(id, note) {
  const extra = FT_EXTRA.find(e => e.id === id);
  if (!extra) return;
  if (left() < extra.cost) { flash('Not enough slots left for that.'); return; }
  const written = String(note == null ? '' : note).trim();
  sheet.entries = [{
    id: ftId(), at: Date.now(), cost: extra.cost, kind: extra.kind,
    name: extra.name + (written ? ' — ' + written : ''), pay: null,
  }].concat(sheet.entries || []);
  lastRoll = null;
  saveSheet();
  render();
}

function doWritten() {
  const el = document.getElementById('ft-written');
  const text = el ? el.value : '';
  if (!String(text).trim()) { flash('Write what you did first.'); return; }
  doExtra('other', text);
  if (el) el.value = '';
}

function undoEntry(id) {
  sheet.entries = (sheet.entries || []).filter(e => e.id !== id);
  saveSheet();
  render();
}

function setSlots(value) {
  if (!isDm) return;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return;
  sheet.slots = Math.min(20, Math.round(n * 2) / 2);
  saveSheet();
  render();
}

function setWindow(value) {
  if (!isDm) return;
  sheet.window = String(value || '').slice(0, 60);
  saveSheet();
  render();
}

// Clearing the log is how a new window starts, so it is the DM's and it
// warns, because a player who has logged six slots would lose the lot.
function newWindow() {
  if (!isDm) return;
  if (typeof confirm === 'function'
    && !confirm('Clear this character\'s log and start a new window?')) return;
  sheet.entries = [];
  saveSheet();
  render();
}

function flash(message) {
  const el = document.getElementById('ft-flash');
  if (el) el.textContent = message;
}

function pickChar(file) {
  charFile = file;
  lastRoll = null;
  loadSheet().then(render);
}

/* ── Load ── */

async function loadJobs() {
  // The campaign lives in Firestore and the repo copy is the fallback — the
  // same order every other page reads it in.
  let campaignDoc = null;
  try {
    await fbAuthReady;
    const snap = await FS_CAMPAIGNS.get();
    const d = snap.exists ? snap.data() : null;
    if (d && Array.isArray(d.campaigns)) { campaignDoc = d; jobSource = 'live'; }
  } catch {}
  if (!campaignDoc) {
    try {
      campaignDoc = await fetch('CAMPAIGN/campaigns.json').then(r => r.json());
      jobSource = 'bundled';
    } catch { jobSource = 'none'; }
  }
  const section = ((campaignDoc && campaignDoc.campaigns) || [])
    .flatMap(c => c.appendix || [])
    .find(a => /Free Time — odd jobs/.test(a.heading || ''));
  jobs = section ? freetimeParseJobs(section.body) : [];
  jobsLoaded = true;
}

async function loadChars() {
  const { chars: all } = await charLoadAll(db, { authReady: fbAuthReady });
  chars = all;
  await fbAuthReady;
  isDm = !!(window.isAdmin && window.isAdmin());
  canWrite = isDm || !!(window.canEdit && chars.some(c =>
    window.canEdit(fbCharacterKey('Student (1-A)', c.name))));
  mine = isDm ? all : all.filter(c =>
    window.canEdit && window.canEdit(fbCharacterKey('Student (1-A)', c.name)));
  if (!charFile && mine.length) charFile = mine[0]._file;
  charsLoaded = true;
  await loadSheet();
}

/* ── Render ── */

function money(n) {
  return n == null ? '—' : '¥' + Number(n).toLocaleString();
}

function slotsHtml() {
  const c = currentChar();
  const used = spent();
  const total = Number(sheet.slots) || 0;
  const pips = [];
  for (let i = 0; i < Math.ceil(total); i++) {
    pips.push(`<span class="ft-pip${i < used ? ' is-spent' : ''}"></span>`);
  }
  return `<div class="ft-slots">
      <div class="ft-slots-num">${left()}<span>of ${total}</span></div>
      <div class="ft-slots-body">
        <div class="ft-pips">${pips.join('') || '<span class="ft-empty">No slots set</span>'}</div>
        <div class="ft-slots-meta">
          ${sheet.window ? escHtml(sheet.window) + ' · ' : ''}${money(earned())} earned so far
        </div>
      </div>
      ${isDm ? `<div class="ft-dm">
        <label>Slots
          <input type="number" min="0" max="20" step="0.5" value="${escHtml(total)}"
            onchange="setSlots(this.value)" aria-label="Slots this window">
        </label>
        <label>Window
          <input type="text" value="${escHtml(sheet.window || '')}" placeholder="The week after the festival"
            onchange="setWindow(this.value)" aria-label="What this window is called">
        </label>
        <button onclick="newWindow()">New window</button>
      </div>` : ''}
    </div>
    ${c ? '' : '<p class="ft-empty">Pick a character.</p>'}`;
}

function jobRowHtml(job) {
  const c = currentChar();
  const check = freetimeCheckOf(job);
  const pay = freetimePayOf(job);
  const mod = check && !check.any ? bestModFor(c, check.abilities) : null;
  const canDo = left() >= 1 && canWrite && !!c;
  return `<div class="ft-job${job.fame ? ' is-fame' : ''}">
      <div class="ft-job-head">
        <span class="ft-job-name">${job.fame ? '<span class="ft-star" title="Needs the fame you get from Chapter 3 onwards">★</span> ' : ''}${escHtml(job.name)}</span>
        ${job.check ? `<span class="ft-tag">${escHtml(job.check)}${mod == null ? '' : ' · you roll ' + charSigned(mod)}</span>` : ''}
        ${job.pay ? `<span class="ft-tag ft-pay">${escHtml(job.pay)}</span>` : ''}
        ${job.block === 'second' ? '<span class="ft-tag ft-second">Second years</span>' : ''}
        <button class="ft-do" onclick="doJob('${escHtml(job.id)}')" ${canDo ? '' : 'disabled'}
          title="${canDo ? 'Spend a slot on this' : 'No slots left, or no character to spend them for'}">Spend a slot</button>
      </div>
      <p class="ft-job-line">${escHtml(job.raw)}</p>
    </div>`;
}

function jobsHtml() {
  if (!jobsLoaded) return '<p class="ft-empty">Reading the job board…</p>';
  if (!jobs.length) {
    return `<p class="ft-empty">The job board could not be read${jobSource === 'none'
      ? ' — neither the live campaign nor the bundled copy.' : '.'}</p>`;
  }
  const blocks = [['first', 'Open to everybody'], ['second', 'Second years, from Chapter 7']];
  return blocks.map(([id, label]) => {
    const list = jobs.filter(j => j.block === id);
    if (!list.length) return '';
    return `<div class="ft-block">
      <div class="ft-block-name">${escHtml(label)}</div>
      ${list.map(jobRowHtml).join('')}
    </div>`;
  }).join('');
}

function extrasHtml() {
  const canDo = left() >= 0.5 && canWrite && !!currentChar();
  return `<div class="ft-extras">
      ${FT_EXTRA.filter(e => e.id !== 'other').map(e => `<div class="ft-extra">
        <div class="ft-extra-head">
          <span class="ft-extra-name">${escHtml(e.name)}</span>
          <span class="ft-tag">${e.cost === 1 ? 'one slot' : 'half a slot'}</span>
          <button class="ft-do" onclick="doExtra('${escHtml(e.id)}')" ${canDo && left() >= e.cost ? '' : 'disabled'}>Spend</button>
        </div>
        <p class="ft-job-line">${escHtml(e.text)}</p>
      </div>`).join('')}
      <div class="ft-extra">
        <div class="ft-extra-head">
          <span class="ft-extra-name">Something else</span>
          <span class="ft-tag">one slot</span>
        </div>
        <div class="ft-written-row">
          <input type="text" id="ft-written" placeholder="What you did with the slot" aria-label="What you did">
          <button class="ft-do" onclick="doWritten()" ${canDo ? '' : 'disabled'}>Log it</button>
        </div>
      </div>
    </div>`;
}

function rollHtml() {
  if (!lastRoll) return '';
  const r = lastRoll.roll;
  return `<div class="ft-roll${lastRoll.passed === false ? ' is-fail' : lastRoll.passed ? ' is-pass' : ''}">
      <strong>${escHtml(lastRoll.name)}</strong>
      ${r ? `<span class="ft-roll-num">${r.total}</span>
        <span class="ft-roll-detail">${escHtml(r.breakdown)} against DC ${escHtml(r.dc)}</span>
        <span class="ft-roll-word">${lastRoll.passed ? 'passed' : 'failed'}</span>` : ''}
      ${lastRoll.pay == null ? '' : `<span class="ft-roll-pay">${money(lastRoll.pay)}${lastRoll.passed === false ? ' — halved' : ''}</span>`}
      <span class="ft-roll-note">Tell your DM. This page does not pay you.</span>
    </div>`;
}

function logHtml() {
  const entries = sheet.entries || [];
  if (!entries.length) return '<p class="ft-empty">Nothing spent yet this window.</p>';
  return `<div class="ft-log">${entries.map(e => `<div class="ft-log-row kind-${escHtml(e.kind)}">
      <span class="ft-log-cost">${e.cost === 0.5 ? '½' : escHtml(e.cost)}</span>
      <span class="ft-log-name">${escHtml(e.name)}</span>
      ${e.roll ? `<span class="ft-tag">${escHtml(e.roll.total)} v DC ${escHtml(e.roll.dc)}</span>` : ''}
      ${e.passed === false ? '<span class="ft-tag ft-failed">failed</span>' : ''}
      ${e.pay == null ? '' : `<span class="ft-tag ft-pay">${money(e.pay)}</span>`}
      ${canWrite ? `<button class="ft-undo" onclick="undoEntry('${escHtml(e.id)}')" title="Take it back">✕</button>` : ''}
    </div>`).join('')}</div>`;
}

function charTabsHtml() {
  if (!charsLoaded) return '<p class="ft-empty">Looking up your character…</p>';
  if (!mine.length) {
    return `<div class="ft-nochar">
      <p><strong>No character is assigned to you yet.</strong></p>
      <p>This page keeps your free-time slots, so it needs to know which character is yours —
      the same assignment the Lab and the Class 1-A toolkit use. Ask your DM; it is one
      checkbox on the admin page. The job board below is worth reading either way.</p>
    </div>`;
  }
  if (mine.length === 1) return '';
  return `<div class="ft-char-tabs">${mine.map(c =>
    `<button class="ft-char-tab${c._file === charFile ? ' sel' : ''}"
      onclick="pickChar('${escHtml(c._file)}')">${escHtml(charLabel(c))}</button>`).join('')}</div>`;
}

function render() {
  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  set('ft-chars', charTabsHtml());
  set('ft-slots', mine.length ? slotsHtml() : '');
  set('ft-roll', rollHtml());
  set('ft-jobs', jobsHtml());
  set('ft-extras', mine.length ? extrasHtml() : '');
  set('ft-log', mine.length ? logHtml() : '');

  const state = document.getElementById('ft-save-state');
  if (state && !state.textContent) {
    state.textContent = canWrite ? '' : 'Signed out — anything you log stays in this browser';
  }
  const src = document.getElementById('ft-source');
  if (src) {
    src.textContent = jobSource === 'live' ? 'Job board read from the live campaign.'
      : jobSource === 'bundled' ? 'Job board read from the bundled copy — the live campaign could not be reached.'
      : '';
  }
}

(async () => {
  render();
  await Promise.all([loadJobs(), loadChars()]);
  render();
})();
