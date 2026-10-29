// Page logic for lab.html. Extracted from the HTML so it can be linted,
// diffed and tested directly rather than regex-scraped out of markup.
// Loaded as a CLASSIC script, not a module: the page wires controls with
// inline onclick= handlers that resolve against globals.
//
// Runs after auth.js, so fbAuthReady is already defined.
//
// ── What this page is ───────────────────────────────────────────────
// Two halves, both for players.
//
// THE WORKBENCH — build an ability and see what it actually does before it
// reaches the table. Type a damage expression and the page tells you the
// lowest, the average and the highest it can roll, how often it hits an AC
// you choose, and what it is worth per use once misses are counted. That
// last number is the one nobody works out by hand, and it is why two
// abilities that look similar on paper are not.
//
// The averages are measured, not derived: the expression is rolled a few
// thousand times through dice.js rather than put through a formula. A
// formula would have to special-case advantage and keep-highest and would
// quietly be wrong for "4d6kh3"; rolling it cannot be.
//
// THE QUIRK DATABASE — every quirk the campaign knows about, from all seven
// places a character can be hiding, searchable and filterable. See
// quirk-data.js for why that is seven places and not one.
//
// Nobody is named in it. The cast it is assembled from includes the gang,
// the Underground and the villains, so "Alucard Chosoji — BLACK" on a page
// a player can open is a spoiler. Entries are keyed and merged by the quirk
// instead, which also means a quirk two people share is one entry — and the
// prose is scrubbed, because it is written about people. quirk-data.js has
// the details.
//
// Nothing here is saved to the campaign. Drafts live in this browser only,
// and the Copy button hands over JSON in the exact shape a character file's
// quirk_mechanics.abilities takes, so the DM can paste it in if they agree.

const db = firebase.firestore();
const LS_LAB = 'mha-lab-drafts-v1';

// Enough rolls that the average is stable to a tenth, few enough that the
// page never visibly pauses. Measured at about 4ms for 4,000.
const LAB_SAMPLES = 4000;

let labView = 'bench';          // 'bench' | 'quirks'
let labDrafts = [];
let labQuirks = [];
let labQuirkSources = { sources: [], failed: [] };
let labQuirkQuery = '';
let labQuirkType = null;
let labQuirkFrom = null;
let labOpenQuirk = null;
let labQuirksLoaded = false;

// The ability being built. Deliberately the same field names a character
// file uses where there is one, so the Copy output needs no translation.
let ability = {
  name: '',
  type: 'Action',
  range: '',
  target: '',
  hitMode: 'attack',     // 'attack' | 'save' | 'none'
  attackBonus: '+5',
  saveAbility: 'DEX',
  saveDC: '13',
  damage: '2d6',
  onSave: 'half',        // 'half' | 'none' | 'nothing'
  uses: '',
  description: '',
  targetAc: '14',
  advantage: 'none',     // 'none' | 'adv' | 'dis'
};

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ACTION_TYPES = ['Action', 'Bonus action', 'Reaction', 'Passive', 'Free', 'Ritual'];
const SAVE_ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

/* ── The maths ──────────────────────────────────────────────────────
   Four numbers, and every one of them is a question a player actually asks.
   ─────────────────────────────────────────────────────────────────── */

// P(hit) for d20 + bonus against an AC. A natural 1 always misses and a
// natural 20 always hits, which is why this is clamped rather than letting
// a +12 against AC 10 read as a certainty.
function hitChance(bonus, ac, mode) {
  const need = Number(ac) - Number(bonus);
  // Faces that hit: need..20, bounded so 1 never hits and 20 always does.
  const faces = Math.max(1, Math.min(19, 21 - need));
  const p = faces / 20;
  if (mode === 'adv') return 1 - (1 - p) * (1 - p);
  if (mode === 'dis') return p * p;
  return p;
}

function critChance(mode) {
  if (mode === 'adv') return 1 - (19 / 20) * (19 / 20);
  if (mode === 'dis') return (1 / 20) * (1 / 20);
  return 1 / 20;
}

/* Measured rather than derived: a closed form for the average of "4d6kh3"
 * exists but a closed form for every expression dice.js accepts does not,
 * and a formula that is quietly wrong for keep-highest is worse than a
 * number with a ±0.1 wobble on it.
 */
function damageProfile(expr, samples) {
  const parsed = diceParse(expr);
  if (!parsed) return null;
  const n = samples || LAB_SAMPLES;
  const range = diceRange(parsed);
  let total = 0;
  for (let i = 0; i < n; i++) total += diceRoll(parsed).total;
  return {
    text: parsed.text,
    min: range.min,
    max: range.max,
    avg: Math.round((total / n) * 10) / 10,
    samples: n,
  };
}

/* What the ability is worth per use, with misses counted.
 *
 * For an attack: P(hit) × average, plus the crit's extra dice. A critical
 * rolls the damage dice twice and the flat modifier once, so the extra is
 * the dice half of the average — which is why the flat part is separated
 * out rather than the whole average being doubled.
 *
 * For a save: everyone rolls, so the question is what a failed save costs
 * and what a successful one still does.
 */
function expectedDamage() {
  const dmg = damageProfile(ability.damage);
  if (!dmg) return null;
  const parsed = diceParse(ability.damage);
  const flat = parsed.terms.filter(t => !t.sides).reduce((n, t) => n + t.sign * t.flat, 0);
  const dicePart = dmg.avg - flat;

  if (ability.hitMode === 'attack') {
    const p = hitChance(Number(ability.attackBonus) || 0, ability.targetAc, ability.advantage);
    const c = critChance(ability.advantage);
    // A crit is already inside p — it is one of the faces that hits — so
    // only the EXTRA dice are added on top, not a second whole hit.
    return { kind: 'attack', hit: p, crit: c, perUse: Math.round((p * dmg.avg + c * dicePart) * 10) / 10, dmg, flat };
  }
  if (ability.hitMode === 'save') {
    const onSave = ability.onSave === 'half' ? 0.5 : 0;
    // Without the target's modifier there is no save chance to quote, so
    // the page gives both ends instead of inventing a middle.
    return { kind: 'save', perUse: null, failed: dmg.avg,
      saved: Math.round(dmg.avg * onSave * 10) / 10, dmg, flat };
  }
  return { kind: 'none', perUse: dmg.avg, dmg, flat };
}

/* ── The draft ── */

function setField(key, value) {
  if (!Object.prototype.hasOwnProperty.call(ability, key)) return;
  ability[key] = value;
  renderBench();
}

function labReset() {
  ability = {
    name: '', type: 'Action', range: '', target: '', hitMode: 'attack',
    attackBonus: '+5', saveAbility: 'DEX', saveDC: '13', damage: '2d6',
    onSave: 'half', uses: '', description: '', targetAc: '14', advantage: 'none',
  };
  render();
}

// The shape a character file's quirk_mechanics.abilities takes, and nothing
// else — the workbench's own fields (targetAc, advantage) are for working
// out the numbers and have no business in a character record.
function abilityJson() {
  const out = { name: ability.name || 'Unnamed', type: ability.type };
  if (ability.hitMode === 'attack' && ability.attackBonus) out.attackBonus = ability.attackBonus;
  if (ability.damage && diceParse(ability.damage)) out.damage = diceParse(ability.damage).text;
  out.description = abilityProse();
  return out;
}

// The description, assembled from the fields so a player does not have to
// write "Range 30 feet, DEX save DC 13, 2d6 on a failure" by hand every time
// and get a different order every time.
function abilityProse() {
  const bits = [];
  if (ability.range) bits.push('Range ' + ability.range + '.');
  if (ability.target) bits.push(ability.target + '.');
  if (ability.hitMode === 'attack' && ability.attackBonus) {
    bits.push('Attack ' + ability.attackBonus + ' to hit' + (ability.damage ? ', ' + ability.damage + ' on a hit.' : '.'));
  } else if (ability.hitMode === 'save') {
    bits.push(ability.saveAbility + ' save DC ' + ability.saveDC + (ability.damage ? ', ' + ability.damage + ' on a failure' : ''));
    bits.push(ability.onSave === 'half' ? 'half as much on a success.'
      : ability.onSave === 'none' ? 'nothing on a success.' : '');
  } else if (ability.damage) {
    bits.push(ability.damage + '.');
  }
  if (ability.uses) bits.push(ability.uses + '.');
  if (ability.description) bits.push(ability.description);
  return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function saveDraft() {
  if (!ability.name.trim()) {
    const f = document.getElementById('lab-save-feedback');
    if (f) f.textContent = 'Give it a name first.';
    return;
  }
  labDrafts = [{ id: Date.now().toString(36), at: Date.now(), ability: { ...ability } }]
    .concat(labDrafts.filter(d => d.ability.name !== ability.name))
    .slice(0, 30);
  persistDrafts();
  render();
}

function loadDraft(id) {
  const d = labDrafts.find(x => x.id === id);
  if (!d) return;
  ability = Object.assign({}, ability, d.ability);
  labView = 'bench';
  render();
}

function deleteDraft(id) {
  labDrafts = labDrafts.filter(d => d.id !== id);
  persistDrafts();
  render();
}

function persistDrafts() {
  try { localStorage.setItem(LS_LAB, JSON.stringify(labDrafts)); } catch {}
}

function loadDrafts() {
  try {
    const raw = localStorage.getItem(LS_LAB);
    if (raw) labDrafts = JSON.parse(raw) || [];
  } catch { labDrafts = []; }
}

// Written into a field the player can select, rather than the clipboard API,
// which needs a permission and fails silently in several browsers.
function showJson() {
  const el = document.getElementById('lab-json');
  if (!el) return;
  el.value = JSON.stringify(abilityJson(), null, 2);
  el.style.display = '';
  if (el.select) { el.focus(); el.select(); }
}

/* ── Render: the workbench ── */

function field(label, key, attrs) {
  const a = attrs || {};
  return `<label class="lb-field">
      <span class="lb-label">${escHtml(label)}</span>
      <input type="${a.type || 'text'}" value="${escHtml(ability[key])}"
        placeholder="${escHtml(a.placeholder || '')}"
        oninput="setField('${escHtml(key)}', this.value)" aria-label="${escHtml(label)}">
      ${a.hint ? `<span class="lb-hint">${escHtml(a.hint)}</span>` : ''}
    </label>`;
}

function choice(label, key, options) {
  return `<label class="lb-field">
      <span class="lb-label">${escHtml(label)}</span>
      <select onchange="setField('${escHtml(key)}', this.value)" aria-label="${escHtml(label)}">
        ${options.map(([value, text]) =>
          `<option value="${escHtml(value)}"${ability[key] === value ? ' selected' : ''}>${escHtml(text)}</option>`).join('')}
      </select>
    </label>`;
}

function mathsHtml() {
  const e = expectedDamage();
  if (!e) {
    return `<div class="lb-maths is-bad">
      <div class="lb-bad">Can't read "${escHtml(ability.damage)}".</div>
      <div class="lb-bad-hint">Try 2d6, 2d6+3, 1d8+1d4, or 4d6kh3. The roller on the toolkit reads the same notation.</div>
    </div>`;
  }
  const stat = (num, label, note) => `<div class="lb-stat">
      <div class="lb-stat-num">${escHtml(num)}</div>
      <div class="lb-stat-label">${escHtml(label)}</div>
      ${note ? `<div class="lb-stat-note">${escHtml(note)}</div>` : ''}
    </div>`;

  const rows = [
    stat(`${e.dmg.min}–${e.dmg.max}`, 'Range', e.dmg.text),
    stat(e.dmg.avg, 'Average roll', `measured over ${e.dmg.samples.toLocaleString()} rolls`),
  ];
  if (e.kind === 'attack') {
    rows.push(stat(Math.round(e.hit * 100) + '%', `Hits AC ${escHtml(ability.targetAc)}`,
      ability.advantage === 'adv' ? 'with advantage' : ability.advantage === 'dis' ? 'with disadvantage' : ''));
    rows.push(stat(e.perUse, 'Per use', 'misses and crits counted'));
  } else if (e.kind === 'save') {
    rows.push(stat(e.failed, 'On a failed save', ''));
    rows.push(stat(e.saved, 'On a successful one',
      ability.onSave === 'half' ? 'half' : 'nothing'));
  } else {
    rows.push(stat(e.perUse, 'Per use', 'nothing to miss with'));
  }
  return `<div class="lb-maths">${rows.join('')}</div>
    ${e.kind === 'save' ? '<p class="lb-maths-note">No "per use" for a save: that needs the target\'s modifier, and inventing one would make the number worse than no number.</p>' : ''}`;
}

function previewHtml() {
  const prose = abilityProse();
  return `<div class="lb-preview">
      <div class="lb-preview-head">
        <span class="lb-preview-name">${escHtml(ability.name || 'Unnamed ability')}</span>
        <span class="lb-preview-type">${escHtml(ability.type)}</span>
        ${ability.hitMode === 'attack' && ability.attackBonus ? `<span class="lb-preview-stat">to hit ${escHtml(ability.attackBonus)}</span>` : ''}
        ${ability.damage && diceParse(ability.damage) ? `<span class="lb-preview-stat">${escHtml(diceParse(ability.damage).text)}</span>` : ''}
      </div>
      <p class="lb-preview-text">${prose ? escHtml(prose) : '<span class="lb-preview-empty">Fill in the fields and this is what it will read like on a character sheet.</span>'}</p>
    </div>`;
}

function draftsHtml() {
  if (!labDrafts.length) {
    return '<p class="lb-empty">No drafts yet. They are kept in this browser only — nothing here reaches the campaign.</p>';
  }
  return `<div class="lb-drafts">${labDrafts.map(d => `<div class="lb-draft">
      <button class="lb-draft-name" onclick="loadDraft('${escHtml(d.id)}')" title="Load this draft">
        ${escHtml(d.ability.name)}<span>${escHtml(d.ability.type)}${d.ability.damage ? ' · ' + escHtml(d.ability.damage) : ''}</span>
      </button>
      <button class="lb-draft-del" onclick="deleteDraft('${escHtml(d.id)}')" title="Delete this draft">✕</button>
    </div>`).join('')}</div>`;
}

function renderBench() {
  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  set('lab-maths', mathsHtml());
  set('lab-preview', previewHtml());
  const roll = document.getElementById('lab-roll-out');
  if (roll && !roll.dataset.held) roll.textContent = '';
}

function rollIt() {
  const out = document.getElementById('lab-roll-out');
  if (!out) return;
  const parsed = diceParse(ability.damage);
  if (!parsed) { out.textContent = 'Nothing to roll.'; return; }
  const r = diceRoll(parsed);
  out.textContent = `${r.total}  (${r.breakdown})`;
  out.dataset.held = '1';
}

function benchHtml() {
  return `<div class="lb-bench">
      <div class="lb-form">
        <div class="lb-row">
          ${field('Name', 'name', { placeholder: 'Laser Beam' })}
          ${choice('Costs', 'type', ACTION_TYPES.map(t => [t, t]))}
        </div>
        <div class="lb-row">
          ${field('Range', 'range', { placeholder: '80 feet' })}
          ${field('Target', 'target', { placeholder: 'One creature you can see' })}
        </div>
        <div class="lb-row">
          ${choice('Resolved by', 'hitMode', [['attack', 'An attack roll'], ['save', 'A saving throw'], ['none', 'Neither — it just happens']])}
          ${ability.hitMode === 'attack'
            ? field('To hit', 'attackBonus', { placeholder: '+5' })
            : ability.hitMode === 'save'
              ? choice('Save', 'saveAbility', SAVE_ABILITIES.map(a => [a, a]))
              : '<span class="lb-field"></span>'}
          ${ability.hitMode === 'save' ? field('DC', 'saveDC', { placeholder: '13' }) : ''}
        </div>
        <div class="lb-row">
          ${field('Damage', 'damage', { placeholder: '2d6+3', hint: 'Reads 2d6+3, 1d8+1d4, 4d6kh3 — the same notation as the roller' })}
          ${ability.hitMode === 'save'
            ? choice('On a success', 'onSave', [['half', 'Half damage'], ['none', 'No damage'], ['nothing', 'No effect at all']])
            : '<span class="lb-field"></span>'}
        </div>
        <div class="lb-row">
          ${field('How often', 'uses', { placeholder: 'Three times per short rest' })}
        </div>
        <label class="lb-field lb-wide">
          <span class="lb-label">Anything else it does</span>
          <textarea rows="3" oninput="setField('description', this.value)"
            placeholder="The part the numbers cannot say."
            aria-label="Anything else it does">${escHtml(ability.description)}</textarea>
        </label>

        <div class="lb-against">
          <span class="lb-label">Work the numbers against</span>
          <div class="lb-row">
            ${field('Target AC', 'targetAc', { type: 'number' })}
            ${choice('Rolling with', 'advantage', [['none', 'Neither'], ['adv', 'Advantage'], ['dis', 'Disadvantage']])}
          </div>
          <p class="lb-hint">Your party's spread is on the Party page. The Rules page has the DC scale.</p>
        </div>
      </div>

      <div class="lb-side">
        <h2 class="lb-h2">What it does</h2>
        <div id="lab-maths">${mathsHtml()}</div>
        <h2 class="lb-h2">How it reads</h2>
        <div id="lab-preview">${previewHtml()}</div>
        <div class="lb-actions">
          <button onclick="rollIt()">🎲 Roll the damage</button>
          <button onclick="saveDraft()">Save draft</button>
          <button onclick="showJson()">Show as JSON</button>
          <button onclick="labReset()">Clear</button>
          <span id="lab-save-feedback" class="lb-feedback"></span>
        </div>
        <div id="lab-roll-out" class="lb-roll-out"></div>
        <textarea id="lab-json" class="lb-json" rows="9" readonly style="display:none;"
          aria-label="The ability as JSON"></textarea>
        <h2 class="lb-h2">Drafts</h2>
        <div id="lab-drafts">${draftsHtml()}</div>
      </div>
    </div>`;
}

/* ── Render: the quirk database ── */

function setQuirkQuery(v) { labQuirkQuery = v; renderQuirks(); }
function filterQuirkType(t) { labQuirkType = labQuirkType === t ? null : t; renderQuirks(); }
function filterQuirkFrom(f) { labQuirkFrom = labQuirkFrom === f ? null : f; renderQuirks(); }
function openQuirk(name) {
  labOpenQuirk = labOpenQuirk === name ? null : name;
  renderQuirks();
}

function visibleQuirks() {
  return labQuirks.filter(q =>
    (!labQuirkType || q.type === labQuirkType)
    && (!labQuirkFrom || q.from === labQuirkFrom || (q.alsoFrom || []).includes(labQuirkFrom))
    && quirkMatches(q, labQuirkQuery));
}

function quirkCardHtml(q) {
  const open = labOpenQuirk === q.quirk;
  return `<div class="lb-quirk${open ? ' is-open' : ''}">
      <button class="lb-quirk-head" onclick="openQuirk('${escHtml(q.quirk)}')"
        aria-expanded="${open ? 'true' : 'false'}">
        <span class="lb-quirk-name">${escHtml(q.quirk)}</span>
        <span class="lb-quirk-who">${q.held > 1 ? escHtml(q.held) + ' people have it' : ''}</span>
        <span class="lb-quirk-tags">
          <span class="lb-tag type-${escHtml(q.type.toLowerCase())}">${escHtml(q.type)}</span>
          ${q.rarity ? `<span class="lb-tag">${escHtml(q.rarity)}</span>` : ''}
          ${q.abilities.length ? `<span class="lb-tag lb-tag-n">${q.abilities.length}</span>` : ''}
        </span>
      </button>
      ${open ? `<div class="lb-quirk-body">
        ${q.summary ? `<p class="lb-quirk-summary">${escHtml(q.summary)}</p>` : ''}
        ${q.weakness ? `<p class="lb-quirk-weak"><span>Weakness</span>${escHtml(q.weakness)}</p>` : ''}
        ${q.abilities.length ? `<div class="lb-quirk-abilities">
          ${q.abilities.map(a => `<div class="lb-qa">
            <div class="lb-qa-head">
              <span class="lb-qa-name">${escHtml(a.name)}</span>
              ${a.type ? `<span class="lb-tag">${escHtml(a.type)}</span>` : ''}
              ${a.damage ? `<span class="lb-tag">${escHtml(a.damage)}</span>` : ''}
              ${a.damage && diceParse(a.damage) ? `<button class="lb-qa-bench" onclick="benchFrom('${escHtml(q.quirk)}','${escHtml(a.name)}')" title="Open this on the workbench">→ workbench</button>` : ''}
            </div>
            ${a.text ? `<p class="lb-qa-text">${escHtml(a.text)}</p>` : ''}
          </div>`).join('')}
        </div>` : '<p class="lb-empty">No abilities recorded for this one.</p>'}
        <div class="lb-quirk-from">Recorded in ${escHtml(q.from)}${(q.alsoFrom || []).length ? ' and ' + escHtml(q.alsoFrom.join(', ')) : ''}${q.source ? ' · ' + escHtml(q.source) : ''}</div>
      </div>` : ''}
    </div>`;
}

// Takes a recorded ability onto the workbench, which is the whole point of
// having both halves on one page: the fastest way to build something
// balanced is to start from something that already is.
function benchFrom(quirkName, abilityName) {
  const q = labQuirks.find(x => x.quirk === quirkName);
  const a = q && q.abilities.find(x => x.name === abilityName);
  if (!a) return;
  ability = Object.assign({}, ability, {
    name: a.name,
    type: ACTION_TYPES.includes(a.type) ? a.type : 'Action',
    damage: a.damage && diceParse(a.damage) ? a.damage : ability.damage,
    attackBonus: a.attackBonus || ability.attackBonus,
    hitMode: a.attackBonus ? 'attack' : ability.hitMode,
    description: a.text || '',
  });
  labView = 'bench';
  render();
}

function renderQuirks() {
  const wrap = document.getElementById('lab-quirks-list');
  const shown = visibleQuirks();
  if (wrap) {
    wrap.innerHTML = labQuirksLoaded
      ? (shown.length ? shown.map(quirkCardHtml).join('')
        : '<p class="lb-empty">Nothing in the database matches that.</p>')
      : '<p class="lb-empty">Reading every character in the campaign…</p>';
  }
  const facets = document.getElementById('lab-facets');
  if (facets && labQuirksLoaded) {
    const f = quirkFacets(labQuirks);
    facets.innerHTML = `
      <div class="lb-facet-row">
        <button class="lb-facet${labQuirkType ? '' : ' sel'}" onclick="filterQuirkType(null)">All types</button>
        ${f.types.map(([t, n]) => `<button class="lb-facet${labQuirkType === t ? ' sel' : ''}"
          onclick="filterQuirkType('${escHtml(t)}')">${escHtml(t)} <b>${n}</b></button>`).join('')}
      </div>
      <div class="lb-facet-row">
        <button class="lb-facet${labQuirkFrom ? '' : ' sel'}" onclick="filterQuirkFrom(null)">Everywhere</button>
        ${f.froms.map(([s, n]) => `<button class="lb-facet${labQuirkFrom === s ? ' sel' : ''}"
          onclick="filterQuirkFrom('${escHtml(s)}')">${escHtml(s)} <b>${n}</b></button>`).join('')}
      </div>`;
  }
  const count = document.getElementById('lab-quirk-count');
  if (count) {
    count.textContent = labQuirksLoaded
      ? (shown.length === labQuirks.length ? `${labQuirks.length} quirks` : `${shown.length} of ${labQuirks.length}`)
      : 'loading…';
  }
  const srcNote = document.getElementById('lab-sources');
  if (srcNote && labQuirksLoaded) {
    // Said out loud: a database that quietly lost two of its seven sources
    // looks exactly like a database that is complete.
    srcNote.innerHTML = `Read from ${escHtml(labQuirkSources.sources.join(', ') || 'nothing')}.`
      + (labQuirkSources.failed.length
        ? ` <span class="lb-src-bad">Could not reach ${escHtml(labQuirkSources.failed.join(', '))}, so this list may be short.</span>`
        : '');
  }
}

function quirksHtml() {
  return `<div class="lb-quirks">
      <div class="lb-quirk-controls">
        <input id="lab-quirk-search" type="search" value="${escHtml(labQuirkQuery)}"
          placeholder="Search every quirk, ability and weakness…"
          oninput="setQuirkQuery(this.value)" aria-label="Search the quirk database">
      </div>
      <div id="lab-facets"></div>
      <p id="lab-sources" class="lb-sources"></p>
      <div id="lab-quirks-list"></div>
    </div>`;
}

/* ── Render ── */

function setView(view) {
  labView = view;
  render();
}

function render() {
  const tabs = document.getElementById('lab-tabs');
  if (tabs) {
    tabs.innerHTML = [['bench', 'Workbench'], ['quirks', 'Quirk database']].map(([id, label]) =>
      `<button class="lb-tab${labView === id ? ' sel' : ''}" onclick="setView('${id}')">${label}</button>`).join('');
  }
  const body = document.getElementById('lab-body');
  if (body) body.innerHTML = labView === 'bench' ? benchHtml() : quirksHtml();
  if (labView === 'quirks') {
    renderQuirks();
    if (!labQuirksLoaded) loadQuirkDatabase();
  }
  const count = document.getElementById('lab-quirk-count');
  if (count && labView === 'bench') count.textContent = '';
}

let _quirkLoadStarted = false;
async function loadQuirkDatabase() {
  if (_quirkLoadStarted) return;
  _quirkLoadStarted = true;
  const res = await quirkLoadAll(db, { authReady: fbAuthReady });
  labQuirks = res.quirks;
  labQuirkSources = { sources: res.sources, failed: res.failed };
  labQuirksLoaded = true;
  renderQuirks();
}

(() => {
  loadDrafts();
  render();
})();
