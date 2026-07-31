# homepage-mcp

The homepage as an [MCP](https://modelcontextprotocol.io) server. An agent asks
`search("agentic RAG")` or `get_project("chipspot")` and gets structured data —
instead of scraping a 1 MB bundled HTML page.

It reads `../src/site.json`, the same file `tools/build.mjs` injects into the
page, so what an agent is told and what a visitor reads cannot drift apart.
Everything served is public; there is no authentication and no user data.

## Surface

| Kind | Name | Use |
|---|---|---|
| tool | `list_projects` | Every project, optionally filtered by `stack` |
| tool | `get_project` | One project by id or name |
| tool | `search` | Free text over names, taglines, descriptions, stacks |
| tool | `get_profile` | Bio, focus areas, links |
| resource | `homepage://profile` | Profile as JSON |
| resource | `homepage://projects` | All projects as JSON |
| resource | `homepage://projects/<id>` | One project as JSON |
| prompt | `introduce` | Short intro, optionally aimed at an audience |
| prompt | `project_pitch` | Explain one project |

Transport is **Streamable HTTP, stateless** — every request is a self-contained
JSON-RPC POST, there is no session to resume, and no server-initiated stream, so
`GET` answers `405` (with a plain-text note, since a bare 405 tells a human
nothing). Protocol versions `2025-06-18`, `2025-03-26`, and `2024-11-05` are
accepted; an `initialize` naming anything else is answered in the newest.

## Develop

```bash
npm test            # 15 tests, no install needed — node --test against the module
```

The tests drive the Worker's `fetch` directly with real `Request` objects, so
they cover the HTTP layer (405, CORS preflight, 202 for notifications, parse
errors) as well as the tools.

```bash
npm install         # only needed for wrangler
npm run dev         # local server at the URL wrangler prints
```

## Deploy

GitHub Pages serves static files and cannot answer a JSON-RPC POST, so this
half of the site runs on Cloudflare Workers.

```bash
npm install
npx wrangler login
npm run deploy
```

The Worker name in `wrangler.jsonc` becomes the hostname:
`https://homepage-mcp.<account-subdomain>.workers.dev`. This account's
workers.dev subdomain is `chipspot` (it is one value per account — the same one
`app.chipspot.workers.dev` uses, so don't rename it).

### Custom domain

Add the domain to Cloudflare as a zone, then uncomment `routes` in
`wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "mcp.yourdomain.dev", "custom_domain": true }]
```

`custom_domain: true` makes Cloudflare create the DNS record and issue the
certificate on deploy — no manual CNAME.

## Use it

Point any MCP client at the URL as a remote HTTP server. For Claude Code:

```bash
claude mcp add --transport http homepage https://homepage-mcp.chipspot.workers.dev
```

Then ask it something like *"what has Terrence built with Cloudflare Workers?"*
— it will call `list_projects` with a stack filter rather than guessing.
