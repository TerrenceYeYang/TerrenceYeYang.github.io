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
const DATA = join(root, 'src', 'site.json');

// src/site.json is the single source of truth for the projects: the page renders
// them from here, and the MCP server (mcp/src/index.mjs) serves the same file, so
// what an agent is told and what a visitor reads can't drift apart.
const REGION =
  /(^[ \t]*\/\/ ── generated from src\/site\.json.*$)([\s\S]*?)(^[ \t]*\/\/ ── end generated ──$)/m;

// Prose lives in the markup rather than the JSON — injecting it would mean
// escaping HTML into a JS string for no gain. It is still checked below, so a
// rewritten headline can't silently leave the MCP server describing the old one.
const PROSE = ['headline', 'summary'];

function literal(value, indent) {
  const pad = ' '.repeat(indent);
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

function injectData(template, site) {
  if (!REGION.test(template)) {
    throw new Error('no "generated from src/site.json" region in src/home.html');
  }
  const body =
    `\n    const projects = ${literal(site.projects, 4)};\n` +
    `    const focusAreas = ${literal(site.focusAreas, 4)};\n`;
  return template.replace(REGION, (_, open, __, close) => open + body + close);
}

// Whitespace and <br> are layout, not content — compare the words only.
const words = (s) => s.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();

function checkProse(template, site) {
  const haystack = words(template);
  const missing = [];
  for (const key of PROSE) {
    if (!haystack.includes(words(site.profile[key]))) missing.push(`profile.${key}`);
  }
  site.profile.about.forEach((para, i) => {
    if (!haystack.includes(words(para))) missing.push(`profile.about[${i}]`);
  });
  return missing;
}

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

const site = JSON.parse(readFileSync(DATA, 'utf8'));
const authored = readFileSync(SOURCE, 'utf8');
const template = injectData(authored, site);

const drifted = checkProse(template, site);
if (drifted.length) {
  console.error(
    `src/site.json prose no longer appears in src/home.html: ${drifted.join(', ')}\n` +
      'The MCP server serves these strings — update the JSON to match the page.',
  );
  process.exit(1);
}

// Keep the authored file in sync too, so the data you read in src/home.html is
// the data that shipped.
if (template !== authored && mode !== '--check') writeFileSync(SOURCE, template);

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
