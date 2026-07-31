# TerrenceYeYang.github.io

Personal homepage, served by GitHub Pages at <https://terrenceyeyang.github.io/>.

## Layout

```
src/home.html      the page — edit this
index.html         built artifact, served by Pages — do not hand-edit
tools/build.mjs    src/home.html -> index.html
tools/shot.mjs     live page -> assets/full + assets/thumbs
assets/full/       full-page captures (reference, not loaded by the page)
assets/thumbs/     1200px card thumbnails the page actually loads
```

`index.html` is a single-file bundle: the fonts and the x-dc runtime ride along
as base64 inside a manifest, and the page itself is one JSON-encoded line in a
`<script type="__bundler/template">` block. `src/home.html` is that line,
unpacked into an editable file. The build only rewrites that one slot, so the
manifest is never touched and the bundle isn't duplicated on disk.

The `<script type="text/x-dc">` block at the bottom of `src/home.html` holds the
`projects` array — that is where a project card's copy, stack, links, and
thumbnail path live.

## Adding a project

1. Capture the assets from the deployed site:

   ```bash
   node tools/shot.mjs --url https://example.com/ --name my-project-view
   ```

   Add `--lang en` to flip a language switcher, and `--click '.some-button'` to
   put the page into a real state first — a loaded case, an open tab — so the
   thumbnail shows the product working rather than an empty form. Writes
   `assets/full/<name>.webp` and `assets/thumbs/<name>.webp`.

2. Add an entry to the `projects` array in `src/home.html`, pointing
   `thumbSrc` at `assets/thumbs/<name>.webp`. The sidebar index, the hero
   strip, and the Selected Projects grid all render from that one array.

3. Build and check the result:

   ```bash
   node tools/build.mjs
   python3 -m http.server 8000   # then open http://127.0.0.1:8000/
   ```

`node tools/build.mjs --check` verifies `index.html` is current without writing
(useful before committing). `node tools/build.mjs --extract` goes the other way
— pulling the template out of `index.html` into `src/home.html` — which is what
you want after re-exporting the bundle from the design tool.

## Deployment

Pushing to `main` is the deploy. There is no workflow file: GitHub's built-in
`pages-build-deployment` runs on push and publishes in about 40 seconds. Pages
is on the legacy branch build (`main`, `/`), so the site is passed through
Jekyll — if a path starting with an underscore is ever added, it will be
skipped unless a `.nojekyll` file exists.

## Requirements

`tools/build.mjs` needs only Node. `tools/shot.mjs` additionally needs Chrome at
its standard macOS path and `cwebp` (`brew install webp`); it drives headless
Chrome over the DevTools protocol, so there is nothing to `npm install`.
