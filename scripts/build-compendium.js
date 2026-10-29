#!/usr/bin/env node
/* Rebuild CAMPAIGN/compendium.json from the Quirk Compendium PDF.
 *
 * The Lab's quirk database reads the campaign's own cast for the quirks
 * people actually have. This adds the book: every quirk in the Quirk
 * Compendium, so a player can look one up, and a DM can hand one out,
 * without either of them opening a nine-megabyte PDF and scrolling.
 *
 * ── It is an index, not the book ────────────────────────────────────
 * What comes out is the name, the rarity, the type, a sentence or two of
 * description, the weakness, the NAMES and levels of each ability, and the
 * page the full entry is on. The rules for each ability stay in the PDF,
 * which is linked from the dashboard and from every entry in the Lab. That
 * is deliberate: an index makes 160 quirks searchable by effect and then
 * sends you to the book, which is the useful half, and it is not a copy of
 * somebody's rulebook sitting in a repo.
 *
 * ── How the parse works, and where it is fragile ───────────────────
 * pdftotext -raw gives the pages in reading order, which the two-column
 * layout needs — with -layout the right column is interleaved into the left
 * and nothing can be read. Each entry then looks like:
 *
 *     Navel Laser
 *     Quirk, Uncommon
 *     Type: Emitter
 *     Description: ...
 *     Weakness: ...
 *     Navel Laser: At 1st level, ...
 *
 * so an entry is found by its "Quirk, <Rarity>" line with the name above it.
 * Four things in the book break the obvious version of that, and each one
 * is handled below with a comment saying which entry caught it:
 *
 *   · "Nine" is headed "Quirk Legendary" with no comma.
 *   · Several entries run the labels together with their text and with each
 *     other on one line, so fields are split on the labels rather than read
 *     line by line.
 *   · The type is spelled "Emmiter", "Muntant" and "Mutation" in places.
 *   · One quirk printed across three pages repeats its own header on each,
 *     so entries are merged by name afterwards.
 *
 * Needs pdftotext (poppler). Without --write it reports and changes nothing.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const PDF = path.join(repoRoot, 'RULEBOOKS',
  '- My Hero Academia_ Quirk Compedium - The Homebrewery.pdf');
const OUT = path.join(repoRoot, 'CAMPAIGN', 'compendium.json');
const SOURCE = 'My Hero Academia: Quirk Compendium (The Homebrewery)';
const PAGES = 90;

const write = process.argv.includes('--write');

function pdfText() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
  } catch {
    console.error('ERROR: pdftotext is not installed. On macOS: brew install poppler');
    process.exit(2);
  }
  if (!fs.existsSync(PDF)) {
    console.error('ERROR: the Quirk Compendium PDF is not where this expects it:\n  ' + PDF);
    process.exit(2);
  }
  const lines = [];
  for (let p = 1; p <= PAGES; p++) {
    let text = '';
    try {
      text = execFileSync('pdftotext', ['-raw', '-f', String(p), '-l', String(p), PDF, '-'],
        { encoding: 'utf8' });
    } catch { continue; }
    for (const line of text.split('\n')) lines.push({ page: p, text: line });
  }
  return lines;
}

// "Quirk, Uncommon" — and "Quirk Legendary", which is how Nine is headed.
const RARITY = /^Quirk[,:]?\s+(Common|Uncommon|Rare|Very Rare|Legendary(?:\s+Ancient)?)\s*$/i;
const LABELS = /\b(Type|Description|Weakness|Requirement)\s*[:.]?\s*/g;
const TYPE = /^(Emitter|Emmiter|Transformation|Mutant|Muntant|Mutation|Heteromorph|None)\b(\s*\/\s*(Emitter|Transformation|Mutant))?/i;
const TYPE_FIX = { emmiter: 'Emitter', muntant: 'Mutant', mutation: 'Mutant', heteromorph: 'Mutant' };

function cleanType(value) {
  const m = String(value || '').match(TYPE);
  if (!m) return '';
  return m[0].replace(/\./g, '').trim().split(/\s*\/\s*/)
    .map(w => TYPE_FIX[w.toLowerCase()] || w.replace(/\b\w/g, c => c.toUpperCase()))
    .join(' / ');
}

// Labels can be run together with their text and with each other on one
// line — "Emitter DescriptionYou can nullify gravity…" — so the body is
// joined into one string and split on the labels. Reading it line by line
// put an entire quirk into the type column.
function fieldsOf(text) {
  const out = {};
  const marks = [...text.matchAll(LABELS)];
  for (let k = 0; k < marks.length; k++) {
    const label = marks[k][1].toLowerCase();
    if (out[label]) continue;             // the first one wins
    const from = marks[k].index + marks[k][0].length;
    const to = k + 1 < marks.length ? marks[k + 1].index : text.length;
    out[label] = text.slice(from, to).replace(/\s+/g, ' ').trim();
  }
  return out;
}

// Whole sentences up to about three hundred characters. A hard character cap
// is a backstop, not a boundary: twelve descriptions sat exactly on one,
// which is what overrun looks like, and one had the Quirk Creation chapter's
// own text in it.
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|ft|lb|Mr|Mrs|Ms|Dr|St|No)\.$/i;

function sentences(text) {
  const clean = String(text || '')
    .replace(/\bStep\s+\d+\s*:.*$/s, '')
    .replace(/\bChapter\s+\d+\s*:.*$/s, '')
    // A stat table inside a field reads as prose once the layout is gone —
    // "Acid Pressure Effect 0–10 Immune to acid damage. 11–20 …" — so the
    // field stops where the table starts.
    .replace(/\s(?:[A-Z][a-z]+\s){0,3}\d+[–-]\d+\s.*$/s, '')
    // pdftotext drops the space where the PDF had a line break, which ran
    // "produced." into "Acid damage deals" as one word.
    .replace(/([a-z\d,;)])([A-Z])/g, '$1 $2')
    .replace(/([.!?])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (!parts) return clean.slice(0, 300).trim();
  let out = '';
  for (const part of parts) {
    // Never end on an abbreviation: "(e.g." is not the end of a sentence.
    if (out && (out + part).length > 300 && !ABBREVIATIONS.test(out.trim())) break;
    out += part;
    if (out.length > 320) break;
  }
  out = out.replace(/\s+/g, ' ').replace(/\s*\(e\.g\.?$/i, '').trim();
  // A hard cap at a word boundary. The loop takes its first part
  // unconditionally, so one long sentence goes straight through it: Dragon's
  // weakness arrived as a single 405-character run. The ellipsis makes it
  // obvious this is an index entry rather than the whole text.
  if (out.length > 320) {
    const cut = out.slice(0, 300);
    out = cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
  }
  return out;
}

function parse(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].text.trim().match(RARITY);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && (!lines[j].text.trim() || /^\d{1,3}$/.test(lines[j].text.trim()))) j--;
    if (j < 0) continue;
    const name = lines[j].text.trim();
    if (!name || name.length > 44 || RARITY.test(name) || /[.:;]$/.test(name)) continue;
    starts.push({ i, nameIndex: j, name, rarity: m[1], page: lines[i].page });
  }

  const entries = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s].i + 1;
    const to = s + 1 < starts.length ? starts[s + 1].nameIndex : lines.length;
    const body = lines.slice(from, to).map(l => l.text.trim())
      .filter(l => l && !/^\d{1,3}$/.test(l)).join(' ');
    const f = fieldsOf(body);

    const abilities = [];
    for (const m of body.matchAll(/([A-Z][A-Za-z'’\- ]{1,34}?)\s*[:.]?\s*(?:At\s+(\d+)(?:st|nd|rd|th)\s+level|As\s+an?\s+(?:action|bonus action|reaction))/g)) {
      let name = m[1].replace(/\s+/g, ' ').trim();
      // Drop a field value the name has swallowed. Kinetic Booster's
      // weakness is the one word "None", and the ability came out as "None
      // Kinetic Booster" — which then did not match its own signature at a
      // non-zero index, so nothing was cut and the whole ability ran into
      // the weakness.
      name = name.replace(/^(?:None|N\/A)\s+/i, '').trim();
      if (!name || name.length < 3) continue;
      if (/^(Type|Description|Weakness|Requirement|On|If|When|You|The|A|An|At|And|Or|This|That|Each|Once|While|For)$/i.test(name)) continue;
      if (abilities.some(a => a.name === name)) continue;
      abilities.push({ name, level: m[2] ? Number(m[2]) : 1 });
    }

    // Cut the prose at the first ability name actually found: the names came
    // out of the same text, so an ability appearing inside a description
    // means the description has overrun into it.
    const cutAtAbility = (text) => {
      let out = String(text || '');
      for (const a of abilities) {
        const signature = new RegExp(
          a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          + '\\s*(?::|At\\s+\\d+(?:st|nd|rd|th)\\s+level|As\\s+an?\\s+(?:action|bonus action|reaction))');
        const m = out.match(signature);
        if (m && m.index > 0) out = out.slice(0, m.index);
      }
      return out.replace(/\s+/g, ' ').trim();
    };

    entries.push({
      name: starts[s].name.replace(/\s+/g, ' ').trim(),
      rarity: starts[s].rarity.replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      type: cleanType(f.type),
      description: sentences(cutAtAbility(f.description || '')),
      weakness: sentences(cutAtAbility(f.weakness || '')),
      page: starts[s].page,
      abilities: abilities.slice(0, 12),
    });
  }

  /* One quirk printed across several pages repeats its own header, and each
   * repeat reads as a new entry — "Laser Eyes" came out three times, once
   * per page, with the abilities only on the last. Merged by name: the
   * fullest copy wins each field, and the first page is the one to cite
   * because that is where the entry starts.
   */
  const merged = new Map();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    const seen = merged.get(key);
    if (!seen) { merged.set(key, { ...e }); continue; }
    seen.page = Math.min(seen.page, e.page);
    for (const field of ['type', 'description', 'weakness']) {
      if ((e[field] || '').length > (seen[field] || '').length) seen[field] = e[field];
    }
    for (const a of e.abilities) {
      if (!seen.abilities.some(x => x.name === a.name)) seen.abilities.push(a);
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const entries = parse(pdfText());

/* A build that silently produced half the book would be worse than one that
 * failed, so it checks itself before writing. These numbers are what the
 * PDF in this repo yields; a new edition that moves them is worth looking at
 * by hand rather than committing blind.
 */
const problems = [];
if (entries.length < 150) problems.push(`only ${entries.length} entries — expected about 160`);
const noType = entries.filter(e => !e.type);
if (noType.length) problems.push(`no type: ${noType.map(e => e.name).join(', ')}`);
const noDesc = entries.filter(e => !e.description);
if (noDesc.length) problems.push(`no description: ${noDesc.map(e => e.name).join(', ')}`);
const dupes = entries.map(e => e.name).filter((n, i, all) => all.indexOf(n) !== i);
if (dupes.length) problems.push(`repeated names: ${[...new Set(dupes)].join(', ')}`);
const overrun = entries.filter(e => /\bStep \d|\bChapter \d/.test(e.description + e.weakness));
if (overrun.length) problems.push(`chapter text leaked in: ${overrun.map(e => e.name).join(', ')}`);

console.log(`parsed ${entries.length} entries from ${path.basename(PDF)}`);
const byType = {};
const byRarity = {};
for (const e of entries) {
  byType[e.type] = (byType[e.type] || 0) + 1;
  byRarity[e.rarity] = (byRarity[e.rarity] || 0) + 1;
}
console.log('types     :', JSON.stringify(byType));
console.log('rarities  :', JSON.stringify(byRarity));
console.log('abilities :', entries.reduce((n, e) => n + e.abilities.length, 0),
  `(${entries.filter(e => !e.abilities.length).length} entries list none)`);

if (problems.length) {
  console.error('\nREFUSING TO WRITE:');
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}

if (!write) {
  console.log('\nDRY RUN — nothing written. Re-run with --write.');
  process.exit(0);
}

fs.writeFileSync(OUT, JSON.stringify({
  _note: 'The Quirk Compendium, indexed — built by scripts/build-compendium.js from the '
    + 'PDF in RULEBOOKS. This is an INDEX, not the book: the name, rarity, type, a sentence '
    + 'or two of description, the weakness, and the names and levels of each ability, plus '
    + 'the page the full entry is on. The rules for each ability stay in the PDF, which is '
    + 'linked from the dashboard and from every entry in the Lab. Rebuild with: '
    + 'node scripts/build-compendium.js --write',
  source: SOURCE,
  built: new Date().toISOString().slice(0, 10),
  entries,
}, null, 2) + '\n');
console.log(`\nwrote ${path.relative(repoRoot, OUT)} — ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
