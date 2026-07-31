#!/usr/bin/env node
// Screenshots a live page into the pair of assets a project card needs:
// assets/full/<name>.webp (whole page) and assets/thumbs/<name>.webp (1200px
// landscape crop of the top, which is what the card actually renders).
//
//   node tools/shot.mjs --url https://app.chipspot.workers.dev/ \
//     --name chipspot-cloud-9955hx-sourcing-case --lang en --click '.example-button'
//
// Options:
//   --url <url>            page to capture (required)
//   --name <slug>          asset basename (required)
//   --width <px>           CSS width, default 1600
//   --viewport <px>        layout viewport height, default 2600. Keep this well
//                          above the real page: sections sized in vh only lay
//                          out fully when the viewport is taller than they are.
//   --full-height <px>     clip height for the full asset, default: measured
//   --thumb-height <px>    clip height for the thumb, default 1000 (16:10)
//   --thumb-width <px>     output width for the thumb, default 1200
//   --lang <value>         set the page's first <select> to this value (the
//                          language switcher) and fire a change event
//   --click <selector>     click this before capturing — e.g. to open a case
//   --click-index <n>      which match to click, default 0
//   --wait <ms>            settle time after load, default 4000
//   --keep-png             leave the intermediate PNGs next to the assets
//
// Drives headless Chrome over the DevTools protocol using only Node built-ins,
// so there is nothing to install: no Playwright, no puppeteer. Needs Chrome and
// cwebp (brew install webp); sips ships with macOS.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9412;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (f) => process.argv.includes(f);

const url = arg('--url');
const name = arg('--name');
if (!url || !name) {
  console.error('usage: node tools/shot.mjs --url <url> --name <slug> [options]');
  process.exit(1);
}

const width = Number(arg('--width', 1600));
const viewport = Number(arg('--viewport', 2600));
const thumbHeight = Number(arg('--thumb-height', 1000));
const thumbWidth = Number(arg('--thumb-width', 1200));
const settle = Number(arg('--wait', 4000));
const clickSelector = arg('--click');
const clickIndex = Number(arg('--click-index', 0));
const lang = arg('--lang');

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (spawnSync('which', ['cwebp']).status !== 0) {
  console.error('cwebp not found — install it with: brew install webp');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'shot-profile-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--hide-scrollbars',
  `--window-size=${width},${viewport}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.value;
}

async function capture(outPath, clipHeight) {
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: clipHeight, scale: 1 },
  });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} failed`);
}

function toWebp(pngPath, outPath, resampleWidth, quality) {
  const scaled = pngPath.replace(/\.png$/, '.scaled.png');
  run('sips', ['--resampleWidth', String(resampleWidth), pngPath, '--out', scaled]);
  run('cwebp', ['-quiet', '-q', String(quality), scaled, '-o', outPath]);
  unlinkSync(scaled);
}

const fullPng = join(root, 'assets', `${name}.full.png`);
const thumbPng = join(root, 'assets', `${name}.thumb.png`);

try {
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      page = (await res.json()).find((t) => t.type === 'page');
    } catch { /* chrome still starting */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('Chrome never exposed a CDP page target');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const slot = msg.id && pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // deviceScaleFactor 2 so the downscale to final width lands on real pixels
  // rather than resampling a 1x capture.
  await send('Emulation.setDeviceMetricsOverride', {
    width, height: viewport, deviceScaleFactor: 2, mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(settle);

  if (lang) {
    const got = await evaluate(`(() => {
      const sel = document.querySelector('select');
      if (!sel) return null;
      sel.value = ${JSON.stringify(lang)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    console.log(`language -> ${got ?? 'no <select> on page'}`);
    await sleep(1200);
  }

  if (clickSelector) {
    const clicked = await evaluate(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(clickSelector)});
      const el = els[${clickIndex}];
      if (!el) return null;
      el.click();
      return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    })()`);
    if (clicked === null) throw new Error(`nothing matched ${clickSelector}[${clickIndex}]`);
    console.log(`clicked -> ${clicked}`);
    await sleep(3000);
  }

  // Real content bottom, not body height: a body with min-height:100vh reports
  // the whole tall viewport, which would pad the asset with dead space. Only
  // in-flow elements count — decorative glows and other absolutely positioned
  // art are placed against that tall viewport and sit well below the content.
  const measured = await evaluate(`(() => {
    let bottom = 0;
    for (const el of document.body.querySelectorAll('*')) {
      const pos = getComputedStyle(el).position;
      if (pos === 'absolute' || pos === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) bottom = Math.max(bottom, r.bottom + window.scrollY);
    }
    return Math.ceil(bottom) + 24;
  })()`);
  const fullHeight = Math.min(Number(arg('--full-height', measured)), viewport);
  console.log(`content bottom ${measured}px -> full asset ${width}x${fullHeight}`);

  await capture(fullPng, fullHeight);
  await capture(thumbPng, Math.min(thumbHeight, viewport));
} finally {
  try { ws?.close(); } catch { /* already gone */ }
  chrome.kill('SIGTERM');
}

const fullWebp = join(root, 'assets', 'full', `${name}.webp`);
const thumbWebp = join(root, 'assets', 'thumbs', `${name}.webp`);
toWebp(fullPng, fullWebp, width, 88);
toWebp(thumbPng, thumbWebp, thumbWidth, 82);

if (!flag('--keep-png')) {
  unlinkSync(fullPng);
  unlinkSync(thumbPng);
}

for (const p of [fullWebp, thumbWebp]) {
  const dims = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', p], { encoding: 'utf8' })
    .stdout.trim().split('\n').slice(1).map((s) => s.trim().split(': ')[1]);
  console.log(`${p.replace(root + '/', '')}  ${dims.join('x')}`);
}
console.log(`\nreference it from src/home.html as: assets/thumbs/${name}.webp`);
