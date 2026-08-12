#!/usr/bin/env node
// Parse-check every page's JavaScript.
//
// This check was impossible before the page logic was extracted out of the
// HTML: a syntax error inside a <script> block is invisible to any tool that
// isn't a browser, so a typo could reach production and simply break the page
// on load. Now that each page's code is a real .js file, parsing it is trivial
// and cheap -- so it runs on every deploy.
//
// It parses; it does not execute. Nothing here touches Firestore or the DOM.
//
//   node scripts/verify-js-syntax.js

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

// Every .js the site actually ships, excluding this tooling directory.
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'scripts') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = collect(repoRoot).sort();
if (!files.length) {
  console.error('FAIL — no .js files found; has the layout changed?');
  process.exit(1);
}

let bad = 0;
for (const file of files) {
  const rel = path.relative(repoRoot, file);
  const src = fs.readFileSync(file, 'utf8');
  try {
    // new Function parses without running. Page scripts are classic scripts,
    // which is exactly the grammar this validates against.
    new Function(src);
    console.log(`PASS — ${rel} (${src.length.toLocaleString()} chars)`);
  } catch (e) {
    bad++;
    console.log(`FAIL — ${rel}: ${e.message}`);
  }
}

console.log(bad ? `>>> ${bad} file(s) failed to parse` : `>>> all ${files.length} shipped .js files parse`);
process.exit(bad ? 1 : 0);
