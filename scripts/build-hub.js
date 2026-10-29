#!/usr/bin/env node
/* Writes the dashboard's <main> block from the table below.
 *
 * Twenty-one tiles by hand is twenty-one chances to mistype an href, forget
 * a group, or let one blurb run to a paragraph while its neighbours are four
 * words. Here the groups, the copy and the icons are one table you can read
 * top to bottom, and rearranging the hub is moving a line.
 *
 * Run it after editing the table:  node scripts/build-hub.js
 *
 * It rewrites only what is between <main> and </main> in index.html — the
 * role screen, the PIN pad and the header are left alone. scripts/verify-
 * dashboard.js then holds the result to the things this shape is for: every
 * destination grouped once and reachable, a blurb of a few words rather than
 * a sentence, one lead tile per group, and no emoji.
 */
const fs = require('fs');

// One consistent set: 24px box, 1.5 stroke, currentColor, round caps. The
// emoji they replace were at wildly different weights and brought their own
// colours into a frame that was already tinted.
const I = {
  swords: '<path d="M5 3 3 5l8.5 8.5M19 3l2 2-8.5 8.5"/><path d="M3 19l4-4M21 19l-4-4M14 14l5 5-2 2-5-5"/><path d="M10 14l-5 5 2 2 5-5"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  flask: '<path d="M9 3h6M10 3v5.5L4.8 18A2 2 0 0 0 6.6 21h10.8a2 2 0 0 0 1.8-3L14 8.5V3"/><path d="M7 15h10"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a5.6 5.6 0 0 0-2-4.3"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10.5 18.5h3"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="1.5"/><path d="M7 17h10v4H7z"/>',
  bag: '<path d="M6 7h12l1.2 13a1.5 1.5 0 0 1-1.5 1.6H6.3A1.5 1.5 0 0 1 4.8 20z"/><path d="M9 7V5.5a3 3 0 0 1 6 0V7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h3M8 17.5h3"/>',
  flame: '<path d="M12 2.5s5.5 4.3 5.5 9.5a5.5 5.5 0 0 1-11 0C6.5 9 9 7 9 7s-.5 2.5 1 3.5c0-3.5 2-6.5 2-8z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  rows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14.5h18M9.5 9v11"/>',
  gem: '<path d="M6 3h12l3 6-9 12L3 9z"/><path d="M3 9h18M9 3l3 18M15 3l-3 18"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H10a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5z"/><path d="M20 4.5A1.5 1.5 0 0 0 18.5 3H14a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h4.5A1.5 1.5 0 0 0 20 15.5z"/>',
  map: '<path d="M9 3 3 5.5v15L9 18l6 3 6-2.5v-15L15 6z"/><path d="M9 3v15M15 6v15"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v8.5A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  notebook: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 8h14M9 12h6M9 16h4"/><path d="M8 3v18"/>',
  scale: '<path d="M4 20h16M12 20V4"/><path d="M6 9h12M6 9l-2.5 5h5zM18 9l-2.5 5h5z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 16.5h4"/>',
  spark: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M18 17l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.2 8.8 13.4 13.4 8.8 15.2l1.8-4.6z"/>',
};

const icon = (name) =>
  `<svg class="tile-icon" viewBox="0 0 24 24" aria-hidden="true">${I[name]}</svg>`;

/* Each tile: href, icon, accent, name, and a blurb of a few words. The old
 * descriptions ran to twenty words each and seventeen of those is a page of
 * prose pretending to be a menu. `lead` marks the one tile per group that
 * carries the group — it spans two columns and says a little more.
 */
const GROUPS = [
  { section: 'Class 1-A', sectionSub: 'Everything a student can open.', dm: false, groups: [
    { name: 'At the table', hint: 'Open while you are playing.', tiles: [
      { href: 'table.html', icon: 'swords', accent: 'crimson', name: 'At the Table',
        blurb: 'Whose turn it is, live', lead: true,
        more: 'The order, everyone’s conditions, and whether you are next.' },
      { href: 'CLASS-1A/board.html', icon: 'grid', accent: 'purple', name: 'Battle Board',
        blurb: 'Where everyone is standing' },
      { href: 'lab.html', icon: 'flask', accent: 'teal', name: 'The Lab',
        blurb: 'Build, craft, look up' },
    ] },
    { name: 'Your character', hint: 'Who they are, what they carry, what they can do.', tiles: [
      { href: 'CLASS-1A/relationships.html', icon: 'people', accent: 'gold', name: 'Class 1-A',
        blurb: 'Profiles, stats and the roller', lead: true,
        more: 'Every student, their quirk mechanics, and who gets on with whom.' },
      { href: 'heropad.html', icon: 'phone', accent: 'blue', name: 'Heropad',
        blurb: 'The phone they carry' },
      { href: 'sheet.html', icon: 'printer', accent: 'teal', name: 'Sheet',
        blurb: 'One page, printable' },
      { href: 'shop.html', icon: 'bag', accent: 'green', name: 'Shop',
        blurb: 'Spend their yen' },
    ] },
    { name: 'Between sessions', hint: 'What you do with the time, and what it earns you.', tiles: [
      { href: 'freetime.html', icon: 'calendar', accent: 'green', name: 'Free Time',
        blurb: 'Jobs, training, slots' },
      { href: 'heat.html', icon: 'flame', accent: 'crimson', name: 'Heat',
        blurb: 'How hard Byakko are looking' },
    ] },
  ] },
  { section: 'Campaign', sectionSub: 'Yours. Players see none of this.', dm: true, groups: [
    { name: 'Running a session', hint: 'The screens you want open on the night.', tiles: [
      { href: 'tonight.html', icon: 'clock', accent: 'gold', name: 'Run Sheet',
        blurb: 'Tonight, on one screen', lead: true,
        more: 'Where you left off, the running order, the Heat, and somewhere to write.' },
      { href: 'CLASS-1A/encounter.html', icon: 'dice', accent: 'crimson', name: 'Encounter',
        blurb: 'Initiative and the board' },
      { href: 'party.html', icon: 'rows', accent: 'teal', name: 'Party',
        blurb: 'Every number, side by side' },
      { href: 'loot.html', icon: 'gem', accent: 'purple', name: 'Loot',
        blurb: '194 things to hand out' },
    ] },
    { name: 'The campaign', hint: 'Everything written down, and everything that happened.', tiles: [
      { href: 'campaigns.html', icon: 'book', accent: 'gold', name: 'Campaigns',
        blurb: 'The text, chapter by chapter', lead: true,
        more: 'Laid out like a published module — read-aloud, DM notes, side quests.' },
      { href: 'campaign-overview.html', icon: 'map', accent: 'blue', name: 'Overview',
        blurb: 'Arcs, world and scripts' },
      { href: 'characters.html', icon: 'folder', accent: 'green', name: 'Characters',
        blurb: 'The whole cast, filed' },
      { href: 'session-log.html', icon: 'notebook', accent: 'amber', name: 'Session Log',
        blurb: 'What actually happened' },
    ] },
  ] },
  { section: 'Reference', sectionSub: 'The rules, summarised and in full.', dm: false, groups: [
    { name: null, hint: null, tiles: [
      { href: 'rules.html', icon: 'scale', accent: 'blue', name: 'Rules',
        blurb: '108 rules, searchable', lead: true,
        more: 'Conditions, cover, death saves — the lookups, not the whole book.' },
      { href: 'RULEBOOKS/-%20My%20Hero%20Academia_%20Offical%20Handbook%20-%20The%20Homebrewery.pdf',
        icon: 'file', accent: 'gold', name: 'Handbook', blurb: 'MHA5e core · PDF', external: true },
      { href: 'RULEBOOKS/-%20My%20Hero%20Academia_%20Quirk%20Compedium%20-%20The%20Homebrewery.pdf',
        icon: 'compass', accent: 'gold', name: 'Compendium', blurb: '160 quirks · PDF', external: true },
      { href: 'updates.html', icon: 'spark', accent: 'purple', name: "What's New",
        blurb: 'Every change, dated' },
    ] },
  ] },
];

function tile(t, indent) {
  const pad = ' '.repeat(indent);
  const ext = t.external ? ' target="_blank" rel="noopener noreferrer"' : '';
  return [
    `${pad}<a class="tile${t.lead ? ' is-lead' : ''}" data-accent="${t.accent}" href="${t.href}"${ext}>`,
    `${pad}  ${icon(t.icon)}`,
    `${pad}  <span class="tile-name">${t.name}</span>`,
    `${pad}  <span class="tile-blurb">${t.blurb}</span>`,
    t.more ? `${pad}  <span class="tile-more">${t.more}</span>` : null,
    `${pad}</a>`,
  ].filter(Boolean).join('\n');
}

function group(g, indent) {
  const pad = ' '.repeat(indent);
  const head = g.name ? [
    `${pad}<div class="hub-group-head">`,
    `${pad}  <h3 class="hub-group-name">${g.name}</h3>`,
    `${pad}  <p class="hub-group-hint">${g.hint}</p>`,
    `${pad}</div>`,
  ].join('\n') : null;
  return [
    `${pad}<div class="hub-group">`,
    head,
    `${pad}  <div class="tile-grid">`,
    g.tiles.map(t => tile(t, indent + 4)).join('\n'),
    `${pad}  </div>`,
    `${pad}</div>`,
  ].filter(Boolean).join('\n');
}

function section(s) {
  const inner = [
    `    <div class="hub-head">`,
    `      <p class="section-label">${s.section}${s.dm ? ' <span class="dm-flag">DM only</span>' : ''}</p>`,
    `      <p class="section-sub">${s.sectionSub}</p>`,
    `    </div>`,
    s.groups.map(g => group(g, 4)).join('\n'),
  ].join('\n');
  return `  <section class="hub-section">\n${inner}\n  </section>`;
}

const players = section(GROUPS[0]);
const dm = section(GROUPS[1]).split('\n').map(l => '  ' + l).join('\n');
const reference = section(GROUPS[2]);

const main = `<main>
  <!-- A live glance at the table's state, filled over the REST API like the
       session strip below it. Every row hides itself if there is nothing to
       say, so a quiet dashboard is a dashboard with nothing happening rather
       than one that failed to load. -->
  <div id="glance" class="glance hidden"></div>

${players}

  <div id="dm-only">
    <!-- Filled from the session log over the REST API; stays hidden if that
         fails or the log is empty. Inside #dm-only on purpose — "next time"
         is the DM's note to themselves. -->
    <div id="last-session" class="hidden"></div>
${dm}
  </div>
  <!-- /dm-only — the end of the DM block, marked so a check does not have to
       guess it. Four verifiers slice the page here to prove a player card is
       outside this block; two of them used to anchor on the LABEL of the
       section below, and renaming it broke all of them at once. -->

${reference}
</main>`;

const page = fs.readFileSync('index.html', 'utf8');
const start = page.indexOf('<main>');
const end = page.indexOf('</main>') + '</main>'.length;
fs.writeFileSync('index.html', page.slice(0, start) + main + page.slice(end));

const count = GROUPS.flatMap(s => s.groups).flatMap(g => g.tiles).length;
console.log('wrote', count, 'tiles in', GROUPS.flatMap(s => s.groups).length, 'groups');
console.log('icons used:', new Set(GROUPS.flatMap(s => s.groups).flatMap(g => g.tiles).map(t => t.icon)).size, 'of', Object.keys(I).length, 'defined');
