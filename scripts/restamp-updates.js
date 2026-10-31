#!/usr/bin/env node
/* Repair update entries that a squash merge invalidated.
 *
 * ── WHY THIS IS NEEDED AT ALL ───────────────────────────────────────────
 * add-update.js stamps version, build, date and commit out of git at the
 * moment the note is written, and verify-updates.js checks them back against
 * the history. That is the right design — it makes a version an auditable
 * fact rather than a claim — but it has one hole that cannot be closed from
 * the writing side:
 *
 *   A squash merge replaces the commits the note was written against with a
 *   single new one. The SHA stops existing, the commit count drops by
 *   however many commits were collapsed, and the date becomes the merge
 *   date. The entry was correct on the branch and is wrong the moment it
 *   lands.
 *
 * So no pre-merge check can catch it: CI passes on the branch, and the
 * breakage happens afterwards. It had to be fixed by hand three times
 * (4877a82, and twice more while doing exactly that). This does it instead.
 *
 * ── HOW IT IDENTIFIES THE REPLACEMENT ───────────────────────────────────
 * Two signals, strongest first, and it refuses rather than guesses:
 *
 *   1. the PR number. A squash merge's subject ends in "(#N)" by GitHub's
 *      own convention, which this repo's history follows throughout. If the
 *      entry records `pr`, the commit whose subject ends in that number is
 *      the answer and there is no ambiguity.
 *   2. the title. Every note's title was written to describe its commit, and
 *      in practice the squash subject contains it. Accepted only when
 *      exactly ONE commit matches.
 *
 * It never rewrites an entry whose commit still resolves correctly, and it
 * never writes anything without --write.
 *
 * Usage:
 *   node scripts/restamp-updates.js            # report what it would change
 *   node scripts/restamp-updates.js --write    # change it
 *   node scripts/restamp-updates.js --base origin/main
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
// stdio inherit would print git's own "fatal:" lines, and this asks git about
// SHAs that deliberately may not exist.
const gitSafe = (...args) => {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
// ⚠ `merge-base --is-ancestor` answers with its EXIT CODE and prints nothing,
// so it succeeds with an empty string. Treating that output as a boolean —
// which the first version of this file did — reports every correct entry as
// broken, because '' is falsy.
const gitOk = (...args) => {
  try { execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' }); return true; }
  catch { return false; }
};

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const baseIdx = argv.indexOf('--base');
const base = baseIdx !== -1 ? argv[baseIdx + 1] : 'HEAD';

if (!gitOk('rev-parse', '--verify', base)) {
  console.error(`ERROR: "${base}" is not a ref in this repository`);
  process.exit(2);
}

const docPath = path.join(repoRoot, 'updates.json');
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const updates = doc.updates || [];

/* Every commit on the base branch, newest first, with its subject. One pass
   rather than a git call per entry per candidate. */
// Tab-delimited, and the subject last: a commit subject contains spaces,
// so a space-delimited format cannot be split back apart.
const history = git('log', '--format=%h%x09%ad%x09%s', '--date=short', base)
  .split('\n')
  .filter(Boolean)
  .map((line, i, all) => {
    const [sha, date, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    // rev-list --count of a commit on a linear branch is its distance from
    // the root, which is (total - index).
    return { sha, subject, date, build: all.length - i };
  });

const byPr = new Map();
for (const c of history) {
  const m = c.subject.match(/\(#(\d+)\)\s*$/);
  if (m) byPr.set(Number(m[1]), c);
}

function stillCorrect(u) {
  const sha = gitSafe('rev-parse', '--short', u.commit);
  if (!sha) return false;
  if (!gitOk('merge-base', '--is-ancestor', u.commit, base)) return false;
  const build = Number(git('rev-list', '--count', u.commit));
  const date = git('log', '-1', '--format=%ad', '--date=short', u.commit);
  return build === u.build && date === u.date && u.version === `1.0.${build}`;
}

/* Find the commit on `base` that this entry's work actually shipped in. */
function locate(u) {
  if (u.pr && byPr.has(u.pr)) {
    return { commit: byPr.get(u.pr), how: `its PR number (#${u.pr})` };
  }
  const needle = String(u.title || '').toLowerCase().trim();
  if (needle.length >= 8) {
    const hits = history.filter(c => c.subject.toLowerCase().includes(needle));
    if (hits.length === 1) return { commit: hits[0], how: 'its title, matched in one commit subject' };
    if (hits.length > 1) {
      return { ambiguous: `title matches ${hits.length} commits: ${hits.map(h => h.sha).join(' ')}` };
    }
  }
  return { ambiguous: 'no commit on ' + base + ' carries its PR number or its title' };
}

const planned = [];
const stuck = [];

for (const u of updates) {
  if (stillCorrect(u)) continue;
  const found = locate(u);
  if (found.ambiguous) { stuck.push({ u, why: found.ambiguous }); continue; }
  const c = found.commit;
  // A replacement has to satisfy the same invariant the verifier checks, or
  // this would simply move the failure.
  if (`1.0.${c.build}` === u.version && c.sha === u.commit && c.date === u.date) continue;
  planned.push({
    u,
    how: found.how,
    from: { version: u.version, build: u.build, date: u.date, commit: u.commit },
    to: { version: `1.0.${c.build}`, build: c.build, date: c.date, commit: c.sha },
    subject: c.subject,
  });
}

if (!planned.length && !stuck.length) {
  console.log(`Nothing to do — all ${updates.length} entries match the history of ${base}.`);
  process.exit(0);
}

for (const p of planned) {
  console.log(`${p.from.version}  ->  ${p.to.version}`);
  console.log(`   commit ${p.from.commit} -> ${p.to.commit}   (${p.how})`);
  if (p.from.date !== p.to.date) console.log(`   date   ${p.from.date} -> ${p.to.date}`);
  console.log(`   "${p.u.title}"`);
  console.log(`   lands in: ${p.subject}\n`);
}

for (const s of stuck) {
  console.error(`CANNOT PLACE ${s.u.version} — "${s.u.title}"`);
  console.error(`   ${s.why}`);
  console.error('   fix it by hand, or give the entry a "pr" field and re-run.\n');
}

// A version collision would make two notes claim one release.
const seen = new Map(updates.map(u => [u.version, u]));
for (const p of planned) seen.delete(p.from.version);
for (const p of planned) {
  if (seen.has(p.to.version)) {
    console.error(`ERROR: ${p.from.version} would become ${p.to.version}, which "${seen.get(p.to.version).title}" already claims.`);
    process.exit(1);
  }
  seen.set(p.to.version, p.u);
}

if (!write) {
  console.log(`DRY RUN — ${planned.length} entr${planned.length === 1 ? 'y' : 'ies'} would change, nothing written.`);
  console.log('Re-run with --write to apply.');
  process.exit(stuck.length ? 1 : 0);
}

for (const p of planned) Object.assign(p.u, p.to);
doc.updates = updates.sort((a, b) => b.build - a.build);
fs.writeFileSync(docPath, JSON.stringify(doc, null, 2) + '\n');

console.log(`Re-stamped ${planned.length} entr${planned.length === 1 ? 'y' : 'ies'} against ${base}.`);
console.log('Run `node scripts/verify-updates.js` to confirm.');
process.exit(stuck.length ? 1 : 0);
