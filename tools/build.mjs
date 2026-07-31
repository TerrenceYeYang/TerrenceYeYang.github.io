#!/usr/bin/env node
// Re-encodes src/home.html into the template slot of index.html.
//
// index.html is a single-file bundle: fonts and the x-dc runtime ride along as
// base64 in a manifest, and the page itself is one JSON-encoded line inside
// <script type="__bundler/template">. Editing that line by hand is miserable,
// so src/home.html is the source of truth for the page and everything else in
// the bundle is carried through untouched — the manifest is never rewritten,
// which is also why the bundle isn't duplicated on disk.
//
//   node tools/build.mjs            rebuild index.html from src/home.html
//   node tools/build.mjs --check    verify they agree, write nothing (exit 1 if not)
//   node tools/build.mjs --extract  pull index.html's template back into src/home.html
//
// Use --extract after re-exporting the bundle from the design tool, so hand
// edits and a fresh export meet in the same file.
//
// Two rules the template must respect, both enforced below:
//   - <!DOCTYPE html> stays the first thing in the file. The loader parses the
//     template with DOMParser; anything ahead of the doctype (a comment, a
//     stray blank line) drops the document into quirks mode.
//   - No literal "</" survives into index.html. The template lives inside an
//     inline <script>, where "</script>" would end the block early and split
//     the page in half, so every slash in "</" is written as its JSON unicode
//     escape instead — the same form the original bundler emits.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(root, 'index.html');
const SOURCE = join(root, 'src', 'home.html');

// The template slot. Non-greedy is safe: the encoded payload can never contain
// a literal "</script>" — that is the whole point of the escaping above.
const SLOT = /(<script type="__bundler\/template">\n)([\s\S]*?)(\n[ \t]*<\/script>)/;

function encode(template) {
  return JSON.stringify(template).replaceAll('</', '<\\u002F');
}

function readSlot(bundle) {
  const m = bundle.match(SLOT);
  if (!m) throw new Error('no <script type="__bundler/template"> block in index.html');
  return { match: m, template: JSON.parse(m[2]) };
}

const mode = process.argv[2] ?? '--build';
const bundle = readFileSync(BUNDLE, 'utf8');

if (mode === '--extract') {
  const { template } = readSlot(bundle);
  writeFileSync(SOURCE, template);
  console.log(`extracted ${template.length} chars -> src/home.html`);
  process.exit(0);
}

const template = readFileSync(SOURCE, 'utf8');

if (!template.startsWith('<!DOCTYPE html>')) {
  console.error('src/home.html must begin with <!DOCTYPE html> — anything before it forces quirks mode');
  process.exit(1);
}

const encoded = encode(template);
if (encoded.includes('</')) {
  console.error('encoded template still contains a literal "</" — it would close the inline script early');
  process.exit(1);
}
if (JSON.parse(encoded) !== template) {
  console.error('encode/decode round-trip changed the template');
  process.exit(1);
}

const { match } = readSlot(bundle);
const rebuilt = bundle.replace(SLOT, (_, open, __, close) => open + encoded + close);

if (mode === '--check') {
  if (rebuilt === bundle) {
    console.log('index.html is up to date with src/home.html');
    process.exit(0);
  }
  console.error('index.html is stale — run: node tools/build.mjs');
  process.exit(1);
}

if (rebuilt === bundle) {
  console.log('index.html already up to date (no change)');
  process.exit(0);
}

writeFileSync(BUNDLE, rebuilt);
console.log(`rebuilt index.html — template ${match[2].length} -> ${encoded.length} chars`);
