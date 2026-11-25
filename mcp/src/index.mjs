// The homepage as an MCP server: the same src/site.json the page renders from,
// exposed over the Model Context Protocol so an agent can ask about the work
// instead of scraping a bundled HTML page.
//
// Streamable HTTP transport, stateless: every request is a self-contained
// JSON-RPC POST and nothing is kept between them. There is no session to
// resume and no server-initiated stream, so GET answers 405 as the spec allows.
//
// GitHub Pages can't host this — it serves static files and MCP needs to answer
// POSTs — hence a Worker. Deploy: see mcp/README.md.

// The attribute is required by Node (so `node --test` can run this file
// unbundled); Wrangler's bundler honours it too.
import site from '../../src/site.json' with { type: 'json' };

const SERVER_INFO = { name: 'terrence-ye-yang-homepage', version: '1.0.0' };

// Newest first. An `initialize` naming a version in this list is answered in
// that version; anything else is answered in the newest one and the client
// decides whether it can proceed.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Terrence Ye Yang's portfolio, served as structured data.

Use list_projects for an overview, get_project for the full record of one
project (description, stack, repo and live URLs), search to find projects by
topic or technology, and get_profile for the bio, focus areas and links.
Everything served here is public.`;

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'mcp-protocol-version',
  'cache-control': 'no-store',
};

// ── data ────────────────────────────────────────────────────────────────────
// The page keys projects by DOM id (`proj-possonto`); an agent shouldn't have
// to know that, so tools accept the bare slug, the DOM id, or the display name.

const slug = (p) => p.id.replace(/^proj-/, '');

const publicProject = (p) => ({
  id: slug(p),
  name: p.name,
  tagline: p.tagline,
  description: p.description,
  stack: p.stack,
  stars: p.stars,
  repoUrl: p.repoUrl,
  liveUrl: p.liveUrl ?? null,
  url: `${site.profile.links.homepage}#${p.id}`,
});

const PROJECTS = site.projects.map(publicProject);

function findProject(ref) {
  if (typeof ref !== 'string') return null;
  const needle = ref.trim().toLowerCase();
  return (
    PROJECTS.find((p) => p.id.toLowerCase() === needle) ??
    PROJECTS.find((p) => `proj-${p.id}`.toLowerCase() === needle) ??
    PROJECTS.find((p) => p.name.toLowerCase() === needle) ??
    null
  );
}

const NEWS = site.news ?? [];

const PROFILE = {
  name: site.profile.name,
  title: site.profile.title,
  headline: site.profile.headline,
  summary: site.profile.summary,
  about: site.profile.about,
  focusAreas: site.focusAreas,
  links: site.profile.links,
  projectCount: PROJECTS.length,
  latestNews: NEWS,
};

// ── tools ───────────────────────────────────────────────────────────────────
// Descriptions say when to call, not just what the tool is — that is what the
// model actually selects on.

const TOOLS = [
  {
    name: 'list_projects',
    description:
      'List every project with its tagline and stack. Call this first when asked what Terrence has built, or to get project ids for get_project.',
    inputSchema: {
      type: 'object',
      properties: {
        stack: {
          type: 'string',
          description:
            'Optional: only return projects whose stack contains this technology, e.g. "Cloudflare Workers".',
        },
      },
      additionalProperties: false,
    },
    handler: ({ stack }) => {
      const needle = typeof stack === 'string' ? stack.trim().toLowerCase() : null;
      const matches = needle
        ? PROJECTS.filter((p) => p.stack.some((t) => t.toLowerCase().includes(needle)))
        : PROJECTS;
      return { count: matches.length, projects: matches.map(({ description, ...rest }) => rest) };
    },
  },
  {
    name: 'get_project',
    description:
      'Get the full record of one project — description, stack, repo and live URLs. Call this when the user asks about a specific project by name.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project id or name, e.g. "chipspot-cloud" or "ChipSpot Cloud".',
        },
      },
      required: ['project'],
      additionalProperties: false,
    },
    handler: ({ project }) => {
      const found = findProject(project);
      if (!found) {
        return {
          error: `No project matching ${JSON.stringify(project)}.`,
          available: PROJECTS.map((p) => p.id),
        };
      }
      return found;
    },
  },
  {
    name: 'search',
    description:
      'Free-text search across project names, taglines, descriptions and stacks. Call this when the user asks whether Terrence has worked on a topic — RAG, benchmarking, Cloudflare, genomics — rather than naming a project.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: ({ query }) => {
      const needle = String(query ?? '').trim().toLowerCase();
      if (!needle) return { count: 0, query, matches: [] };
      const matches = PROJECTS.filter((p) =>
        [p.name, p.tagline, p.description, p.stack.join(' ')]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
      return { count: matches.length, query, matches };
    },
  },
  {
    name: 'get_profile',
    description:
      'Get the bio, focus areas and links. Call this when asked who Terrence is, what he works on, or how to reach him.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => PROFILE,
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const listedTools = TOOLS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

// ── resources ───────────────────────────────────────────────────────────────

const RESOURCES = [
  {
    uri: 'homepage://profile',
    name: 'Profile',
    description: 'Bio, focus areas and links.',
    mimeType: 'application/json',
    read: () => PROFILE,
  },
  {
    uri: 'homepage://news',
    name: 'News & releases',
    description: 'Latest release dispatches and benchmark updates.',
    mimeType: 'application/json',
    read: () => NEWS,
  },
  {
    uri: 'homepage://projects',
    name: 'All projects',
    description: 'Every project with full descriptions.',
    mimeType: 'application/json',
    read: () => PROJECTS,
  },
  ...PROJECTS.map((p) => ({
    uri: `homepage://projects/${p.id}`,
    name: p.name,
    description: p.tagline,
    mimeType: 'application/json',
    read: () => p,
  })),
];

const RESOURCES_BY_URI = new Map(RESOURCES.map((r) => [r.uri, r]));

const listedResources = RESOURCES.map(({ uri, name, description, mimeType }) => ({
  uri,
  name,
  description,
  mimeType,
}));

// ── prompts ─────────────────────────────────────────────────────────────────

const PROMPTS = [
  {
    name: 'introduce',
    description: 'Write a short introduction to Terrence and his work.',
    arguments: [
      {
        name: 'audience',
        description: 'Who the introduction is for, e.g. "a hiring manager".',
        required: false,
      },
    ],
    build: ({ audience }) => {
      const who = audience ? String(audience) : 'a technical reader';
      return [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Introduce Terrence Ye Yang and his work to ${who}, in one short paragraph. ` +
              'Use get_profile and list_projects for the facts; do not invent projects or claims.',
          },
        },
      ];
    },
  },
  {
    name: 'project_pitch',
    description: 'Explain one project — what it does and why it was built that way.',
    arguments: [
      { name: 'project', description: 'Project id or name.', required: true },
    ],
    build: ({ project }) => [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Call get_project for ${JSON.stringify(String(project ?? ''))} and explain what it ` +
            'does, the problem it solves, and the notable design decision behind it. Stick to ' +
            'what the record says.',
        },
      },
    ],
  },
];

const PROMPTS_BY_NAME = new Map(PROMPTS.map((p) => [p.name, p]));

const listedPrompts = PROMPTS.map(({ name, description, arguments: args }) => ({
  name,
  description,
  arguments: args,
}));

// ── JSON-RPC ────────────────────────────────────────────────────────────────

const ERR = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  PARSE: -32700,
};

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// Tool results are text so every client can render them; JSON keeps them
// machine-readable for the model that reads them back.
const asToolResult = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

function handleRpc(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return fail(null, ERR.INVALID_REQUEST, 'Expected a JSON-RPC request object.');
  }
  const { id = null, method, params = {} } = message;
  if (typeof method !== 'string') {
    return fail(id, ERR.INVALID_REQUEST, 'Missing "method".');
  }

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion: version,
        // Static data: nothing ever changes mid-session, so no listChanged.
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: listedTools });

    case 'tools/call': {
      const tool = TOOLS_BY_NAME.get(params?.name);
      if (!tool) {
        return fail(id, ERR.INVALID_PARAMS, `Unknown tool: ${params?.name}`);
      }
      try {
        return ok(id, asToolResult(tool.handler(params?.arguments ?? {})));
      } catch (err) {
        // A tool that throws is a failed call, not a broken protocol — report it
        // in the result so the model can read the reason and adjust.
        return ok(id, { ...asToolResult({ error: String(err) }), isError: true });
      }
    }

    case 'resources/list':
      return ok(id, { resources: listedResources });

    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [] });

    case 'resources/read': {
      const resource = RESOURCES_BY_URI.get(params?.uri);
      if (!resource) {
        return fail(id, ERR.INVALID_PARAMS, `Unknown resource: ${params?.uri}`);
      }
      return ok(id, {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: JSON.stringify(resource.read(), null, 2),
          },
        ],
      });
    }

    case 'prompts/list':
      return ok(id, { prompts: listedPrompts });

    case 'prompts/get': {
      const prompt = PROMPTS_BY_NAME.get(params?.name);
      if (!prompt) {
        return fail(id, ERR.INVALID_PARAMS, `Unknown prompt: ${params?.name}`);
      }
      return ok(id, {
        description: prompt.description,
        messages: prompt.build(params?.arguments ?? {}),
      });
    }

    default:
      return fail(id, ERR.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const LANDING = `${SERVER_INFO.name}

An MCP server for ${site.profile.name}'s homepage — ${site.profile.links.homepage}

POST JSON-RPC to this URL to use it. In an MCP client, add it as a remote
server over HTTP; no authentication, everything served is public.

Tools:     ${TOOLS.map((t) => t.name).join(', ')}
Resources: ${RESOURCES.length}
Source:    https://github.com/TerrenceYeYang/TerrenceYeYang.github.io
`;

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id',
          'access-control-max-age': '86400',
        },
      });
    }

    if (request.method === 'GET') {
      // No server-initiated stream to open. The spec's answer for that is 405,
      // but a bare 405 in a browser tells a human nothing — hence the note.
      return new Response(LANDING, {
        status: 405,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'allow': 'POST, OPTIONS',
          'access-control-allow-origin': '*',
        },
      });
    }

    if (request.method !== 'POST') {
      return json(fail(null, ERR.INVALID_REQUEST, 'Use POST.'), 405);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(fail(null, ERR.PARSE, 'Request body is not valid JSON.'), 400);
    }

    // Batches were dropped in 2025-06-18 but older clients still send them.
    if (Array.isArray(payload)) {
      const replies = payload.map(handleRpc).filter((_, i) => payload[i]?.id !== undefined);
      return replies.length ? json(replies) : new Response(null, { status: 202 });
    }

    // A notification (no id) is acknowledged, not answered — this is the path
    // `notifications/initialized` takes right after the handshake.
    if (payload && typeof payload === 'object' && payload.id === undefined) {
      return new Response(null, { status: 202 });
    }

    return json(handleRpc(payload));
  },
};

export { handleRpc, PROJECTS, PROFILE, TOOLS, RESOURCES, PROTOCOL_VERSIONS };
