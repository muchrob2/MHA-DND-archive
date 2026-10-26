#!/usr/bin/env node
// Regression check for the update notes (updates.json + updates.html/js).
//
// The notes are hand-written prose about releases that really happened, and
// the whole value of them is that the second half of that sentence stays
// true. So:
//   1. Every entry's version, build, date and commit are checked against the
//      actual git history — the deploy stamps version.json as
//      1.0.<commit count>, so an entry's version is checkable, not a claim.
//   2. Newest first, no duplicates, no gaps in the shape.
//   3. Every tag is one the file declares, so the filter row can never offer
//      a tag nothing carries or miss one that something does.
//   4. The page escapes what it prints and reads the file it says it reads.
//   5. The dashboard links to it, since a page nothing links to is a page
//      nobody opens.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS — ' + label); return; }
  failures++;
  console.error('FAIL — ' + label + (detail ? '\n        ' + detail : ''));
}

const doc = JSON.parse(read('updates.json'));
const updates = doc.updates || [];

/* ── 1. the shape ── */
{
  check('there are update notes to read', updates.length >= 5, updates.length + ' entries');
  check('the file declares the tags it uses', Array.isArray(doc.tags) && doc.tags.length >= 3);

  const bad = updates.filter(u =>
    !u.version || !Number.isInteger(u.build) || !u.date || !u.commit || !u.title
    || !Array.isArray(u.items) || !u.items.length || !Array.isArray(u.tags) || !u.tags.length);
  check('every entry has a version, a build, a date, a commit, a title, tags and at least one line',
    bad.length === 0, bad.map(u => u.version || '(no version)').join(', '));

  const versions = updates.map(u => u.version);
  check('no two entries claim the same release', new Set(versions).size === versions.length,
    versions.filter((v, i) => versions.indexOf(v) !== i).join(', '));

  const builds = updates.map(u => u.build);
  check('they are newest first', builds.every((b, i) => i === 0 || b < builds[i - 1]),
    builds.join(' '));

  const strayTag = updates.flatMap(u => u.tags.filter(t => !doc.tags.includes(t)));
  check('every tag on an entry is one the file declares',
    strayTag.length === 0, [...new Set(strayTag)].join(', '));
  const unusedTag = doc.tags.filter(t => !updates.some(u => u.tags.includes(t)));
  check('and every declared tag is carried by something',
    unusedTag.length === 0, unusedTag.join(', '));

  const longLine = updates.flatMap(u => u.items.filter(i => i.length > 320));
  check('each line is a summary rather than a commit message',
    longLine.length === 0, longLine.map(l => l.slice(0, 60) + '…').join('\n        '));
  const emptyLine = updates.flatMap(u => u.items.filter(i => i.trim().length < 15));
  check('and none of them is empty', emptyLine.length === 0, JSON.stringify(emptyLine));
}

/* ── 2. against the history ── */
{
  const wrong = [];
  for (const u of updates) {
    let sha, build, date;
    try {
      sha = git('rev-parse', '--short', u.commit);
      build = Number(git('rev-list', '--count', u.commit));
      date = git('log', '-1', '--format=%ad', '--date=short', u.commit);
    } catch {
      wrong.push(`${u.version}: commit ${u.commit} is not in this repository`);
      continue;
    }
    if (!u.commit.startsWith(sha) && !sha.startsWith(u.commit)) wrong.push(`${u.version}: commit ${u.commit} resolves to ${sha}`);
    if (build !== u.build) wrong.push(`${u.version}: build says ${u.build}, git says ${build}`);
    if (`1.0.${build}` !== u.version) wrong.push(`${u.version}: the deploy would have stamped 1.0.${build}`);
    if (date !== u.date) wrong.push(`${u.version}: date says ${u.date}, commit is ${date}`);
  }
  check('every entry matches the commit it claims to have shipped in',
    wrong.length === 0, wrong.join('\n        '));

  // The newest entry should be the tip, or the notes are behind the code.
  const head = Number(git('rev-list', '--count', 'HEAD'));
  check('the newest entry is no newer than HEAD',
    updates[0].build <= head, `newest 1.0.${updates[0].build}, HEAD is 1.0.${head}`);
  /* Deliberately not a check that the notes are up to date. A changelog
     falling a few commits behind is normal, and failing the suite for it
     would turn every unrelated commit red and make the obligation somebody
     else's problem. The page says it instead: if the running build is newer
     than the newest note, it says so at the top, which is information rather
     than an error. */
  const updJs = read('updates.js');
  check('the page tells the reader when the running build is newer than the newest note',
    /Number\(v\.build\) > Number\(top\.build\)/.test(updJs) && /upd-ahead/.test(updJs)
      && /These notes stop at/.test(updJs),
    'it compares the stamped build with the newest entry and says so');
}

/* ── 3. the page ── */
{
  const js = read('updates.js');
  const html = read('updates.html');
  check('the page reads the notes file', /fetch\('updates\.json'/.test(js));
  check('and shows the running version from version.json', /fetch\('version\.json'/.test(js));
  check('every field it prints is escaped',
    (js.match(/escHtml\(/g) || []).length >= 8, (js.match(/escHtml\(/g) || []).length + ' calls');
  check('a line of notes is never written into the page unescaped',
    /items \|\| \[\]\)\.map\(i => `<li>\$\{escHtml\(i\)\}/.test(js));
  check('it loads no Firebase — the notes are a static file',
    !/firebasejs/.test(html) && !/auth\.js/.test(html));
  check('a failed load says so rather than showing an empty page',
    /load-error-banner/.test(js) && /load-error-banner/.test(html));

  for (const id of [...js.matchAll(/getElementById\('([^'${]+)'\)/g)].map(m => m[1])) {
    check(`#${id} exists in the page`, html.includes(`id="${id}"`));
  }
  const css = read('css/pages/updates.css');
  for (const sel of ['.upd-card', '.upd-items', '.upd-tag', '.upd-chip', '#upd-filters']) {
    check(`${sel} is styled`, css.includes(sel));
  }
}

/* ── 4. somebody can find it ── */
{
  const index = read('index.html');
  check('the dashboard links to the notes', index.includes('href="updates.html"'));
  check('and the version badge is one of the ways in',
    /<a class="version-badge[^>]*href="updates\.html"/.test(index),
    'the badge is the most natural place to click for "what changed"');
}

console.log(failures ? `\n>>> update notes FAILED (${failures})` : '\n>>> update notes OK');
process.exit(failures ? 1 : 0);
