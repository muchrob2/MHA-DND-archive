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
// YOUR CHARACTER — everything you can do, on one screen, grouped by what it
// costs: actions, bonus actions, reactions, what is always on. Your quirk's
// abilities, the gear you are carrying that states a die, the moves you have
// written and the equipment you have made, and the standard options every
// character has out of the rules reference, with the numbers you roll for
// each one. Every row says where it came from, so a thing out of the
// handbook and a thing you invented on Tuesday never look the same.
//
// YOUR RECORD — the stats you are tracking against what the DM's copy says,
// and the perks you have picked up. See player-record.js for why that is a
// document of its own rather than a write into the character.
//
// "Yours" means the characters the DM has assigned you — canEdit in auth.js,
// the same check the Class 1-A toolkit uses to decide what you may edit. An
// admin sees the whole class. Signed out, the page says so rather than
// showing a stranger's sheet.
//
// Nothing here is saved to the campaign. Drafts live in this browser only,
// and the Copy button hands over JSON in the exact shape a character file's
// quirk_mechanics.abilities takes, so the DM can paste it in if they agree.

const db = firebase.firestore();
const LS_LAB = 'mha-lab-drafts-v1';

// Enough rolls that the average is stable to a tenth, few enough that the
// page never visibly pauses. Measured at about 4ms for 4,000.
const LAB_SAMPLES = 4000;

let labView = 'mine';           // 'mine' | 'bench' | 'record' | 'quirks'
let benchMode = 'ability';      // 'ability' | 'gear'
let record = null;              // the player's own moves, gear, perks and stats
let shopCatalog = null;         // for pricing something crafted against real stock
let gear = {                    // the equipment being made, in the shop's own fields
  name: '', kind: 'melee', damage: '2d6', range: '', properties: '',
  materials: '', price: '', description: '',
};
let labChars = [];              // every character the loader found
let labMine = [];               // the ones this viewer may see
let labCharFile = null;         // which of them is on screen
let labCharsLoaded = false;
let labCharSource = '';
let labRolls = {};              // row id -> the last roll shown beside it
let labCanWrite = false;        // fail closed until the ownership check resolves
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

// The workbench is two benches behind one tab: an ability, or a piece of
// equipment. They share the dice maths and nothing else, so they are two
// forms rather than one form with half its fields hidden.
function benchWrapHtml() {
  return `<div class="lb-modes">
      ${[['ability', 'An ability'], ['gear', 'A piece of equipment']].map(([id, label]) =>
        `<button class="lb-mode${benchMode === id ? ' sel' : ''}" onclick="setBenchMode('${id}')">${label}</button>`).join('')}
    </div>
    ${benchMode === 'gear' ? gearHtml() : benchHtml()}`;
}

function setBenchMode(mode) {
  benchMode = mode;
  render();
}

function renderBench() {
  if (benchMode === 'gear') {
    const set = (id, html) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    };
    set('lab-gear-preview', gearPreviewHtml());
    set('lab-gear-price', pricingHtml());
    return;
  }
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

function gearField(label, key, attrs) {
  const a = attrs || {};
  return `<label class="lb-field">
      <span class="lb-label">${escHtml(label)}</span>
      <input type="text" value="${escHtml(gear[key])}" placeholder="${escHtml(a.placeholder || '')}"
        oninput="setGear('${escHtml(key)}', this.value)" aria-label="${escHtml(label)}">
      ${a.hint ? `<span class="lb-hint">${escHtml(a.hint)}</span>` : ''}
    </label>`;
}

/* What a crafted thing should cost, answered the only honest way: by what
 * the catalogue charges for real items of the same size. A costume part with
 * no dice on it gets no comparison, and the page says so rather than
 * inventing a number.
 */
function pricingHtml() {
  if (!shopCatalog) return '<p class="lb-empty">The catalogue has not loaded, so there is nothing to price it against.</p>';
  const list = recordComparables(shopCatalog, gear.damage, { category: gear.kind });
  if (!list.length) {
    return `<p class="lb-empty">Nothing in the catalogue to compare it to — put a damage
      expression on it, or price it with your DM. Not everything has a number.</p>`;
  }
  const suggested = recordSuggestedPrice(shopCatalog, gear.damage, { category: gear.kind });
  return `<div class="lb-price">
      <div class="lb-price-head">
        <span class="lb-price-num">¥${Number(suggested).toLocaleString()}</span>
        <span class="lb-price-label">what the shop charges for this much damage</span>
      </div>
      <div class="lb-price-list">
        ${list.map(x => `<div class="lb-price-row">
          <span class="lb-price-name">${escHtml(x.item.name)}</span>
          <span class="lb-tag">${escHtml(x.item.damage)}</span>
          <span class="lb-price-cost">¥${Number(x.item.price).toLocaleString()}</span>
        </div>`).join('')}
      </div>
      <p class="lb-hint">The middle of what comparable stock costs. It is a suggestion for
        your DM, not a price you can pay — the <a href="shop.html">Shop</a> sells what it sells.</p>
    </div>`;
}

function gearPreviewHtml() {
  const die = charDiceIn(gear.damage);
  const profile = die ? damageProfile(die) : null;
  return `<div class="lb-preview">
      <div class="lb-preview-head">
        <span class="lb-preview-name">${escHtml(gear.name || 'Unnamed item')}</span>
        <span class="lb-preview-type">${escHtml(kindLabel(gear.kind) || gear.kind)}</span>
        ${gear.damage ? `<span class="lb-preview-stat">${escHtml(gear.damage)}</span>` : ''}
        ${gear.range ? `<span class="lb-preview-stat">${escHtml(gear.range)}</span>` : ''}
      </div>
      <p class="lb-preview-text">${escHtml([gear.properties, gear.description].filter(Boolean).join(' · '))
        || '<span class="lb-preview-empty">Fill in the fields and this is what it will read like in the catalogue.</span>'}</p>
      ${gear.materials ? `<p class="lb-gear-made"><span>Made of</span>${escHtml(gear.materials)}</p>` : ''}
    </div>
    ${profile ? `<div class="lb-maths">
      <div class="lb-stat"><div class="lb-stat-num">${profile.min}–${profile.max}</div>
        <div class="lb-stat-label">Range</div><div class="lb-stat-note">${escHtml(profile.text)}</div></div>
      <div class="lb-stat"><div class="lb-stat-num">${profile.avg}</div>
        <div class="lb-stat-label">Average hit</div>
        <div class="lb-stat-note">measured over ${profile.samples.toLocaleString()} rolls</div></div>
    </div>` : ''}`;
}

function gearHtml() {
  return `<div class="lb-bench">
      <div class="lb-form">
        <div class="lb-row">
          ${gearField('Name', 'name', { placeholder: 'Reinforced tonfa' })}
          <label class="lb-field">
            <span class="lb-label">What it is</span>
            <select onchange="setGear('kind', this.value)" aria-label="What kind of thing it is">
              ${RECORD_GEAR_KINDS.map(k => `<option value="${escHtml(k.id)}"${gear.kind === k.id ? ' selected' : ''}>${escHtml(k.label)}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="lb-row">
          ${gearField('Damage', 'damage', { placeholder: '2d6 bludgeoning', hint: 'Leave it empty for something that is not a weapon' })}
          ${gearField('Range', 'range', { placeholder: '20/60 ft' })}
        </div>
        <div class="lb-row">
          ${gearField('Properties', 'properties', { placeholder: 'Light, Thrown', hint: 'The catalogue\'s own words — Light, Heavy, Two-handed, Thrown, Ammunition' })}
        </div>
        <div class="lb-row">
          ${gearField('Made of', 'materials', { placeholder: 'Scrap from the support lab and a bus handrail' })}
          ${gearField('What you think it cost', 'price', { placeholder: '¥20,000' })}
        </div>
        <label class="lb-field lb-wide">
          <span class="lb-label">What it does and why</span>
          <textarea rows="3" oninput="setGear('description', this.value)"
            placeholder="The part the numbers cannot say."
            aria-label="What it does">${escHtml(gear.description)}</textarea>
        </label>
      </div>

      <div class="lb-side">
        <h2 class="lb-h2">How it reads</h2>
        <div id="lab-gear-preview">${gearPreviewHtml()}</div>
        <h2 class="lb-h2">What it should cost</h2>
        <div id="lab-gear-price">${pricingHtml()}</div>
        <div class="lb-actions">
          <button onclick="rollGear()">🎲 Roll its damage</button>
          <button onclick="saveAsGear()">Save to my equipment</button>
          <span id="lab-record-state" class="lb-feedback"></span>
        </div>
        <div id="lab-gear-roll" class="lb-roll-out"></div>
      </div>
    </div>`;
}

function rollGear() {
  const out = document.getElementById('lab-gear-roll');
  if (!out) return;
  const die = charDiceIn(gear.damage);
  const parsed = die ? diceParse(die) : null;
  if (!parsed) { out.textContent = 'Nothing to roll — no dice in the damage.'; return; }
  const r = diceRoll(parsed);
  out.textContent = `${r.total}  (${r.breakdown})`;
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
          <button onclick="saveAsMove()">Save to my moves</button>
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

/* ── The record: saving what a player writes ────────────────────────
   Everything here is the player's own, in a document of its own. See
   player-record.js for why it is not a write into the character.
   ─────────────────────────────────────────────────────────────────── */

let recordSaveTimer = null;
function saveRecord() {
  if (!record || !labCharFile) return;
  try { localStorage.setItem(recordKey(labCharFile), JSON.stringify(record)); } catch {}
  if (!labCanWrite) return;
  clearTimeout(recordSaveTimer);
  recordSaveTimer = setTimeout(async () => {
    try {
      await recordRef(db, labCharFile).set(record, { merge: true });
    } catch (e) {
      // Said out loud: a failed write here loses a move somebody just
      // invented, which is the worst thing this page could do quietly.
      console.error('[lab] could not save your record — it is still in this browser:', e);
      const el = document.getElementById('lab-record-state');
      if (el) el.textContent = 'Could not save to the server. Still saved here.';
    }
  }, 600);
}

function recordFlash(message) {
  const el = document.getElementById('lab-record-state');
  if (el) el.textContent = message;
}

// The workbench's ability, written into the player's own move list. The
// fields the workbench uses for working out the numbers do not go in — see
// abilityJson, which has the same rule for the same reason.
function saveAsMove() {
  if (!record) { recordFlash('No character to save it to.'); return; }
  if (!ability.name.trim()) { recordFlash('Give it a name first.'); return; }
  const move = {
    id: recordId(),
    at: Date.now(),
    name: ability.name.trim(),
    type: ability.type,
    range: ability.range,
    damage: ability.damage && diceParse(ability.damage) ? diceParse(ability.damage).text : '',
    description: abilityProse(),
  };
  // Same name replaces, so refining a move does not leave six of it.
  record.moves = [move].concat((record.moves || []).filter(m => m.name !== move.name)).slice(0, 60);
  saveRecord();
  recordFlash('Saved to your moves.');
  render();
}

function saveAsGear() {
  if (!record) { recordFlash('No character to save it to.'); return; }
  if (!gear.name.trim()) { recordFlash('Give it a name first.'); return; }
  const item = {
    id: recordId(),
    at: Date.now(),
    name: gear.name.trim(),
    kind: gear.kind,
    damage: gear.damage.trim(),
    range: gear.range.trim(),
    properties: gear.properties.trim(),
    materials: gear.materials.trim(),
    price: gear.price.trim(),
    description: gear.description.trim(),
  };
  record.gear = [item].concat((record.gear || []).filter(g => g.name !== item.name)).slice(0, 60);
  saveRecord();
  recordFlash('Saved to your equipment.');
  render();
}

function setGear(key, value) {
  if (!Object.prototype.hasOwnProperty.call(gear, key)) return;
  gear[key] = value;
  renderBench();
}

function deleteMove(id) {
  if (!record) return;
  record.moves = (record.moves || []).filter(m => m.id !== id);
  saveRecord();
  render();
}

function deleteGear(id) {
  if (!record) return;
  record.gear = (record.gear || []).filter(g => g.id !== id);
  saveRecord();
  render();
}

// Back onto the workbench, so a move can be refined rather than rewritten.
function editMove(id) {
  const m = (record && record.moves || []).find(x => x.id === id);
  if (!m) return;
  ability = Object.assign({}, ability, {
    name: m.name,
    type: ACTION_TYPES.includes(m.type) ? m.type : 'Action',
    range: m.range || '',
    damage: m.damage || ability.damage,
    description: m.description || '',
  });
  benchMode = 'ability';
  labView = 'bench';
  render();
}

function editGear(id) {
  const g = (record && record.gear || []).find(x => x.id === id);
  if (!g) return;
  gear = Object.assign({}, gear, {
    name: g.name, kind: g.kind || 'melee', damage: g.damage || '',
    range: g.range || '', properties: g.properties || '',
    materials: g.materials || '', price: g.price || '',
    description: g.description || '',
  });
  benchMode = 'gear';
  labView = 'bench';
  render();
}

function addPerk() {
  if (!record) { recordFlash('No character to save it to.'); return; }
  const name = (document.getElementById('lab-perk-name') || {}).value || '';
  const from = (document.getElementById('lab-perk-from') || {}).value || '';
  const text = (document.getElementById('lab-perk-text') || {}).value || '';
  if (!name.trim()) { recordFlash('A perk needs a name.'); return; }
  record.perks = [{
    id: recordId(), at: Date.now(),
    name: name.trim(), from: from.trim(), text: text.trim(),
  }].concat(record.perks || []).slice(0, 80);
  saveRecord();
  for (const id of ['lab-perk-name', 'lab-perk-from', 'lab-perk-text']) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  render();
}

function deletePerk(id) {
  if (!record) return;
  record.perks = (record.perks || []).filter(p => p.id !== id);
  saveRecord();
  render();
}

/* The stats a player is tracking. Recorded ALONGSIDE the DM's copy rather
 * than over it: the page shows both and marks a disagreement, because a
 * player whose sheet says 42 HP and a DM whose sheet says 35 is a
 * conversation, not a bug to be resolved silently in either direction.
 */
const RECORD_STAT_KEYS = ['level', 'HP', 'AC', 'speed'];

function setStat(key, value) {
  if (!record) return;
  record.stats = record.stats || {};
  const v = String(value == null ? '' : value).trim();
  if (v === '') delete record.stats[key];
  else record.stats[key] = v;
  saveRecord();
  renderRecord();
}

function setRecordNote(value) {
  if (!record) return;
  record.note = String(value == null ? '' : value).slice(0, 2000);
  saveRecord();
  recordFlash('Saved');
}

function clearStat(key) {
  setStat(key, '');
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

/* ── Render: your character ─────────────────────────────────────────
   A turn sheet. The question it answers is the one a player actually asks —
   "what can I do right now" — so it is grouped by what a thing costs rather
   than by where it came from, and every row that has a die has a button that
   rolls it.
   ─────────────────────────────────────────────────────────────────── */

// The standard options every character has, lifted out of the rules
// reference rather than written again here, so the Lab and the Rules page
// cannot disagree about what Disengage does.
const LAB_UNIVERSAL_NAMES = ['Attack action', 'Dash', 'Disengage', 'Dodge', 'Hide',
  'Search', 'Ready', 'Grapple', 'Shove', 'Free interaction', 'Opportunity attack',
  'Bonus action', 'Reaction', 'Movement'];

function labUniversal() {
  if (typeof rulesSection !== 'function') return [];
  const turn = rulesSection('your-turn');
  const moving = rulesSection('moving');
  const entries = [...((turn && turn.entries) || []), ...((moving && moving.entries) || [])];
  return entries
    .filter(e => LAB_UNIVERSAL_NAMES.includes(e.name))
    .map(e => ({
      name: e.name,
      // The cost is read off the rule's own name where it says one, and
      // defaults to an action, which is what all the named ones cost.
      cost: /^(Bonus action)$/.test(e.name) ? 'Bonus action'
        : /^(Reaction|Opportunity attack)$/.test(e.name) ? 'Reaction'
        : /^(Movement|Free interaction)$/.test(e.name) ? 'Other'
        : 'Action',
      costText: 'Everybody has this',
      text: e.text,
    }));
}

function labPickChar(file) {
  labCharFile = file;
  labRolls = {};
  // Each character has their own record, so switching has to load it.
  recordLoad(db, file).then(r => { record = r; render(); });
  render();
}

function labCurrentChar() {
  return labMine.find(c => c._file === labCharFile) || labMine[0] || null;
}

function rollRow(id, expr) {
  const parsed = diceParse(expr);
  if (!parsed) return;
  const r = diceRoll(parsed);
  labRolls[id] = { total: r.total, breakdown: r.breakdown, crit: r.crit, fumble: r.fumble };
  renderMine();
}

function statStripHtml(c) {
  const stats = [
    ['HP', c.HP], ['AC', c.AC], ['Speed', c.speed],
    ['Prof', charSigned(charProfBonus(c))],
    ['Quirk DC', c.quirk_save_DC],
    ['Passive', charPassive(c, 'WIS')],
  ].filter(([, v]) => v != null && String(v).trim() !== '');
  return `<div class="lb-stats">
      ${stats.map(([k, v]) => `<div class="lb-cstat">
        <div class="lb-cstat-num">${escHtml(v)}</div>
        <div class="lb-cstat-label">${escHtml(k)}</div>
      </div>`).join('')}
    </div>
    <div class="lb-mods">
      ${CHAR_ABILITIES.map(k => {
        const mod = charModifier(c, k);
        const score = charNum((c.ability_scores || {})[k]);
        return `<button class="lb-mod" onclick="rollRow('save-${escHtml(k)}', '1d20${charSigned(mod) === '—' ? '' : (mod >= 0 ? '+' : '-') + Math.abs(mod)}')"
          title="Roll a d20 and add ${escHtml(charSigned(mod))} — a check or a save with ${escHtml(CHAR_ABILITY_NAMES[k])}">
          <span class="lb-mod-key">${escHtml(k)}</span>
          <span class="lb-mod-val">${escHtml(charSigned(mod))}</span>
          <span class="lb-mod-score">${score == null ? '—' : score}</span>
          ${labRolls['save-' + k] ? `<span class="lb-mod-roll">${labRolls['save-' + k].total}</span>
            <span class="lb-mod-raw">${escHtml(labRolls['save-' + k].breakdown)}</span>` : ''}
        </button>`;
      }).join('')}
    </div>
    <p class="lb-mods-note">Tap an ability to roll a d20 against it. These are the plain modifiers — add your proficiency where you are proficient, which the sheet does not record.</p>`;
}

function rowHtml(r, i) {
  const id = (r.from || 'r') + '-' + i + '-' + (r.id || r.name);
  const rolled = labRolls[id];
  return `<div class="lb-do from-${escHtml(r.from)}">
      <div class="lb-do-head">
        <span class="lb-do-name">${escHtml(r.name)}</span>
        ${r.costText ? `<span class="lb-do-cost">${escHtml(r.costText)}</span>` : ''}
        ${r.range ? `<span class="lb-do-tag">${escHtml(r.range)}</span>` : ''}
        ${r.damage ? `<span class="lb-do-tag lb-do-dmg">${escHtml(r.damage)}</span>` : ''}
        ${r.dice ? `<button class="lb-do-roll" onclick="rollRow('${escHtml(id)}','${escHtml(r.dice)}')"
          title="Roll ${escHtml(r.dice)}">🎲</button>` : ''}
        ${r.dice ? `<button class="lb-do-bench" onclick="benchRow('${escHtml(r.name)}','${escHtml(r.dice)}','${escHtml(r.costText)}')"
          title="Open this on the workbench">→</button>` : ''}
      </div>
      ${rolled ? `<div class="lb-do-rolled${rolled.crit ? ' is-crit' : rolled.fumble ? ' is-fumble' : ''}">
        <strong>${rolled.total}</strong>${escHtml(rolled.breakdown)}${rolled.crit ? ' ★' : rolled.fumble ? ' ☠' : ''}
      </div>` : ''}
      ${r.text ? `<p class="lb-do-text">${escHtml(r.text)}</p>` : ''}
    </div>`;
}

// Takes a row onto the workbench. Separate from benchFrom, which comes from
// the quirk database and has a quirk to look up — here the row is already in
// hand.
function benchRow(name, dice, costText) {
  ability = Object.assign({}, ability, {
    name,
    type: ACTION_TYPES.includes(costText) ? costText : 'Action',
    damage: dice,
    hitMode: 'attack',
    description: '',
  });
  labView = 'bench';
  render();
}

function mineHtml() {
  if (!labCharsLoaded) {
    return '<p class="lb-empty">Looking up your character…</p>';
  }
  if (!labMine.length) {
    return `<div class="lb-nochar">
      <p><strong>No character is assigned to you yet.</strong></p>
      <p>This tab shows the characters your DM has given you, the same ones you can edit
      in the Class 1-A toolkit. If you are signed in and this is empty, ask them to add
      you — it takes one checkbox on the admin page. If you are not signed in, sign in
      with the button at the top of the page.</p>
      <p class="lb-empty">Everything else in the Lab works without signing in: the
      workbench, and the quirk database.</p>
    </div>`;
  }
  const c = labCurrentChar();
  if (!c) return '<p class="lb-empty">Pick a character.</p>';
  // The player's own moves and crafted equipment join the quirk's abilities
  // and the standard options, grouped by cost with everything else — which
  // is the whole point of writing a move down.
  const own = recordMoveRows(record).concat(recordGearRows(record));
  const { grouped, rows } = charCanDo(c, labUniversal(), own);

  return `
    ${labMine.length > 1 ? `<div class="lb-char-tabs">
      ${labMine.map(x => `<button class="lb-char-tab${x._file === c._file ? ' sel' : ''}"
        onclick="labPickChar('${escHtml(x._file)}')">${escHtml(charLabel(x))}</button>`).join('')}
    </div>` : ''}

    <div class="lb-char-head">
      <div>
        <h2 class="lb-char-name">${escHtml(charLabel(c))}</h2>
        <p class="lb-char-sub">${escHtml([c.quirk, c.suggested_class, c.level ? 'Level ' + c.level : '']
          .filter(Boolean).join(' · '))}</p>
      </div>
      <a class="lb-char-sheet" href="sheet.html?c=${encodeURIComponent(c._file || '')}">Printable sheet →</a>
    </div>

    ${statStripHtml(c)}

    ${(c.quirk_mechanics || {}).weakness ? `<p class="lb-char-weak">
      <span>Your quirk's weakness</span>${escHtml(c.quirk_mechanics.weakness)}</p>` : ''}

    ${CHAR_COSTS.map(cost => {
      const rows = grouped[cost];
      if (!rows.length) return '';
      return `<section class="lb-do-group">
        <h3 class="lb-h2">${escHtml(CHAR_COST_LABELS[cost])} <span class="lb-do-count">${rows.length}</span></h3>
        ${rows.map((r, i) => rowHtml(r, i)).join('')}
      </section>`;
    }).join('')}

    <p class="lb-foot">
      Your quirk's abilities and your carried gear come from your character as the DM has
      it; the rest are the standard options every character has, out of the
      <a href="rules.html">rules reference</a>. ${escHtml(labCharSource === 'local'
        ? 'Read from the bundled copy — the live one could not be reached, so this may be out of date.'
        : 'Read from the live copy of your character.')}
    </p>`;
}

function renderMine() {
  const el = document.getElementById('lab-mine');
  if (el) el.innerHTML = mineHtml();
}

/* ── Render: your record ────────────────────────────────────────────
   The stats you are tracking against what the DM's copy says, the perks you
   have picked up, the moves you have written and the equipment you have
   made. Nothing here overwrites the character — the point of showing both
   numbers is that a disagreement is a conversation.
   ─────────────────────────────────────────────────────────────────── */

function statRowHtml(c, key) {
  const theirs = key === 'level' ? c.level : c[key];
  const mine = (record.stats || {})[key];
  const differs = mine != null && String(mine).trim() !== '' && String(mine) !== String(theirs == null ? '' : theirs);
  return `<div class="lb-stat-row${differs ? ' is-differs' : ''}">
      <span class="lb-stat-key">${escHtml(key === 'HP' ? 'HP' : key === 'AC' ? 'AC' : key)}</span>
      <span class="lb-stat-theirs">${theirs == null || theirs === '' ? '—' : escHtml(theirs)}</span>
      <input type="text" value="${escHtml(mine == null ? '' : mine)}" placeholder="yours"
        oninput="setStat('${escHtml(key)}', this.value)" aria-label="What you have for ${escHtml(key)}">
      ${differs ? `<span class="lb-stat-flag" title="Your note and the DM's copy disagree">differs</span>
        <button class="lb-x" onclick="clearStat('${escHtml(key)}')" title="Drop your note and use the DM's">✕</button>` : ''}
    </div>`;
}

function abilityRowsHtml(c) {
  return CHAR_ABILITIES.map(k => {
    const theirs = charModifier(c, k);
    const mine = (record.stats || {})['mod' + k];
    const differs = mine != null && String(mine).trim() !== '' && Number(mine) !== theirs;
    return `<div class="lb-stat-row${differs ? ' is-differs' : ''}">
      <span class="lb-stat-key">${escHtml(k)}</span>
      <span class="lb-stat-theirs">${escHtml(charSigned(theirs))}</span>
      <input type="text" value="${escHtml(mine == null ? '' : mine)}" placeholder="yours"
        oninput="setStat('mod${escHtml(k)}', this.value)" aria-label="What you have for ${escHtml(k)}">
      ${differs ? `<span class="lb-stat-flag">differs</span>
        <button class="lb-x" onclick="clearStat('mod${escHtml(k)}')" title="Drop your note">✕</button>` : ''}
    </div>`;
  }).join('');
}

function perksHtml() {
  const perks = (record && record.perks) || [];
  return `${perks.length ? `<div class="lb-perks">${perks.map(p => `<div class="lb-perk">
      <div class="lb-perk-head">
        <span class="lb-perk-name">${escHtml(p.name)}</span>
        ${p.from ? `<span class="lb-tag">${escHtml(p.from)}</span>` : ''}
        <button class="lb-x" onclick="deletePerk('${escHtml(p.id)}')" title="Remove it">✕</button>
      </div>
      ${p.text ? `<p class="lb-perk-text">${escHtml(p.text)}</p>` : ''}
    </div>`).join('')}</div>` : '<p class="lb-empty">Nothing recorded yet.</p>'}
    <div class="lb-perk-form">
      <input type="text" id="lab-perk-name" placeholder="What it is" aria-label="Perk name">
      <input type="text" id="lab-perk-from" placeholder="Where it came from" aria-label="Where the perk came from">
      <input type="text" id="lab-perk-text" placeholder="What it does" aria-label="What the perk does">
      <button onclick="addPerk()">Add</button>
    </div>`;
}

function myMovesHtml() {
  const moves = (record && record.moves) || [];
  if (!moves.length) {
    return `<p class="lb-empty">No moves written yet. Build one on the
      <button class="lb-link" onclick="setView('bench')">workbench</button> and save it.</p>`;
  }
  return `<div class="lb-owned">${moves.map(m => `<div class="lb-own from-move">
      <div class="lb-own-head">
        <span class="lb-own-name">${escHtml(m.name)}</span>
        ${m.type ? `<span class="lb-tag">${escHtml(m.type)}</span>` : ''}
        ${m.damage ? `<span class="lb-tag lb-tag-dmg">${escHtml(m.damage)}</span>` : ''}
        ${m.damage && diceParse(m.damage) ? `<button class="lb-own-roll" onclick="rollOwn('move-${escHtml(m.id)}','${escHtml(m.damage)}')" title="Roll it">🎲</button>` : ''}
        <button class="lb-own-edit" onclick="editMove('${escHtml(m.id)}')" title="Back to the workbench">edit</button>
        <button class="lb-x" onclick="deleteMove('${escHtml(m.id)}')" title="Delete it">✕</button>
      </div>
      ${ownRolls['move-' + m.id] ? `<div class="lb-own-roll-out">${escHtml(ownRolls['move-' + m.id])}</div>` : ''}
      ${m.description ? `<p class="lb-own-text">${escHtml(m.description)}</p>` : ''}
    </div>`).join('')}</div>`;
}

function myGearHtml() {
  const items = (record && record.gear) || [];
  if (!items.length) {
    return `<p class="lb-empty">Nothing made yet. There is an equipment bench on the
      <button class="lb-link" onclick="setView('bench')">workbench</button> tab.</p>`;
  }
  return `<div class="lb-owned">${items.map(g => `<div class="lb-own from-crafted">
      <div class="lb-own-head">
        <span class="lb-own-name">${escHtml(g.name)}</span>
        <span class="lb-tag">${escHtml(kindLabel(g.kind) || g.kind)}</span>
        ${g.damage ? `<span class="lb-tag lb-tag-dmg">${escHtml(g.damage)}</span>` : ''}
        ${g.price ? `<span class="lb-tag">${escHtml(g.price)}</span>` : ''}
        ${charDiceIn(g.damage) ? `<button class="lb-own-roll" onclick="rollOwn('gear-${escHtml(g.id)}','${escHtml(charDiceIn(g.damage))}')" title="Roll it">🎲</button>` : ''}
        <button class="lb-own-edit" onclick="editGear('${escHtml(g.id)}')" title="Back to the bench">edit</button>
        <button class="lb-x" onclick="deleteGear('${escHtml(g.id)}')" title="Delete it">✕</button>
      </div>
      ${ownRolls['gear-' + g.id] ? `<div class="lb-own-roll-out">${escHtml(ownRolls['gear-' + g.id])}</div>` : ''}
      ${g.properties ? `<p class="lb-own-text">${escHtml(g.properties)}</p>` : ''}
      ${g.description ? `<p class="lb-own-text">${escHtml(g.description)}</p>` : ''}
      ${g.materials ? `<p class="lb-own-made"><span>Made of</span>${escHtml(g.materials)}</p>` : ''}
    </div>`).join('')}</div>`;
}

const ownRolls = {};
function rollOwn(id, expr) {
  const die = charDiceIn(expr) || expr;
  const parsed = diceParse(die);
  if (!parsed) return;
  const r = diceRoll(parsed);
  ownRolls[id] = `${r.total}  (${r.breakdown})`;
  renderRecord();
}

function recordHtml() {
  if (!labCharsLoaded) return '<p class="lb-empty">Looking up your character…</p>';
  if (!labMine.length) {
    return `<div class="lb-nochar">
      <p><strong>No character is assigned to you yet.</strong></p>
      <p>This tab is your own record — the stats you are tracking, the perks you have picked
      up, the moves you have written and the equipment you have made. It needs to know which
      character is yours. Ask your DM; it is one checkbox on the admin page.</p>
    </div>`;
  }
  const c = labCurrentChar();
  if (!c || !record) return '<p class="lb-empty">Pick a character.</p>';

  return `
    ${labMine.length > 1 ? `<div class="lb-char-tabs">
      ${labMine.map(x => `<button class="lb-char-tab${x._file === c._file ? ' sel' : ''}"
        onclick="labPickChar('${escHtml(x._file)}')">${escHtml(charLabel(x))}</button>`).join('')}
    </div>` : ''}

    <p class="lb-record-lead">
      Everything on this tab is <strong>yours</strong>. It is kept beside your character rather
      than written into it, so nothing here can overwrite what your DM has — and where your
      note and their copy disagree, the page says so instead of picking a winner.
      <span id="lab-record-state" class="lb-feedback"></span>
    </p>

    <h2 class="lb-h2">The numbers</h2>
    <div class="lb-stats-table">
      <div class="lb-stat-row is-head">
        <span class="lb-stat-key"></span>
        <span class="lb-stat-theirs">DM's copy</span>
        <span class="lb-stat-mine">Yours</span>
      </div>
      ${RECORD_STAT_KEYS.map(k => statRowHtml(c, k)).join('')}
      ${abilityRowsHtml(c)}
    </div>

    <h2 class="lb-h2">Perks and features</h2>
    ${perksHtml()}

    <h2 class="lb-h2">Moves you have written</h2>
    ${myMovesHtml()}

    <h2 class="lb-h2">Equipment you have made</h2>
    ${myGearHtml()}

    <h2 class="lb-h2">Anything else</h2>
    <textarea class="lb-record-note" rows="4" oninput="setRecordNote(this.value)"
      placeholder="Whatever you want to remember about this character."
      aria-label="Notes about this character">${escHtml((record && record.note) || '')}</textarea>`;
}

function renderRecord() {
  const el = document.getElementById('lab-record');
  if (el) el.innerHTML = recordHtml();
}

/* ── Render ── */

function setView(view) {
  labView = view;
  render();
}

function render() {
  const tabs = document.getElementById('lab-tabs');
  if (tabs) {
    tabs.innerHTML = [['mine', 'Your character'], ['bench', 'Workbench'],
      ['record', 'Your record'], ['quirks', 'Quirk database']]
      .map(([id, label]) =>
        `<button class="lb-tab${labView === id ? ' sel' : ''}" onclick="setView('${id}')">${label}</button>`).join('');
  }
  const body = document.getElementById('lab-body');
  if (body) {
    body.innerHTML = labView === 'bench' ? benchWrapHtml()
      : labView === 'quirks' ? quirksHtml()
      : labView === 'record' ? '<div id="lab-record"></div>'
      : '<div id="lab-mine"></div>';
  }
  if (labView === 'quirks') {
    renderQuirks();
    if (!labQuirksLoaded) loadQuirkDatabase();
  }
  if (labView === 'mine') {
    renderMine();
    if (!labCharsLoaded) loadMyCharacters();
  }
  if (labView === 'record') {
    renderRecord();
    if (!labCharsLoaded) loadMyCharacters();
  }
  const count = document.getElementById('lab-quirk-count');
  if (count && labView !== 'quirks') {
    count.textContent = labView === 'mine' && labMine.length
      ? `${labMine.length} character${labMine.length === 1 ? '' : 's'}` : '';
  }
}

/* Which characters are yours.
 *
 * canEdit in auth.js is the same check the Class 1-A toolkit uses to decide
 * what you may edit, and fbCharacterKey is the one definition of the key it
 * is checked against — three files spelling that key out separately is how
 * the Heropad once silently matched nothing for months, so this file does
 * not spell it out a fourth time.
 *
 * An admin gets the whole class, which is what a DM wants from this page.
 */
let _charLoadStarted = false;
async function loadMyCharacters() {
  if (_charLoadStarted) return;
  _charLoadStarted = true;
  const { chars, source } = await charLoadAll(db, { authReady: fbAuthReady });
  labChars = chars;
  labCharSource = source;
  await fbAuthReady;
  const admin = !!(window.isAdmin && window.isAdmin());
  labMine = admin ? chars : chars.filter(c =>
    window.canEdit && window.canEdit(fbCharacterKey('Student (1-A)', c.name)));
  if (!labCharFile && labMine.length) labCharFile = labMine[0]._file;
  labCanWrite = admin || (!!window.canEdit && labMine.length > 0);
  record = await recordLoad(db, labCharFile);
  // The catalogue is a static file, and it is only needed for pricing
  // something crafted — so a failure here costs the price comparison and
  // nothing else.
  try { shopCatalog = await fetch('CAMPAIGN/shop-catalog.json').then(r => r.json()); } catch {}
  labCharsLoaded = true;
  render();
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
