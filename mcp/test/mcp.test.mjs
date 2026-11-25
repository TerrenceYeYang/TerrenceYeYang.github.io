import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker, { PROJECTS, PROTOCOL_VERSIONS } from '../src/index.mjs';

const ENDPOINT = 'https://mcp.example/';

async function rpc(body, { method = 'POST' } = {}) {
  const response = await worker.fetch(
    new Request(ENDPOINT, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

const call = async (name, args = {}) => {
  const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return JSON.parse(body.result.content[0].text);
};

test('initialize echoes a supported protocol version', async () => {
  const { body } = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.ok(body.result.serverInfo.name);
  assert.ok(body.result.capabilities.tools);
});

test('initialize falls back to the newest version for an unknown one', async () => {
  const { body } = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01', capabilities: {} },
  });
  assert.equal(body.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('notifications are acknowledged with 202 and no body', async () => {
  const { response, body } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response.status, 202);
  assert.equal(body, null);
});

test('tools/list advertises every tool with a schema', async () => {
  const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = body.result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['get_profile', 'get_project', 'list_projects', 'search']);
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 0);
  }
});

test('list_projects returns every project, and filters by stack', async () => {
  const all = await call('list_projects');
  assert.equal(all.count, PROJECTS.length);

  const filtered = await call('list_projects', { stack: 'cloudflare' });
  assert.equal(filtered.count, 1);
  assert.equal(filtered.projects[0].id, 'chipspot');
});

test('get_project accepts id, DOM id, and display name', async () => {
  for (const ref of ['chipspot', 'proj-chipspot', 'ChipSpot Cloud']) {
    const project = await call('get_project', { project: ref });
    assert.equal(project.name, 'ChipSpot Cloud', `lookup by ${ref}`);
    assert.equal(project.liveUrl, 'https://app.chipspot.workers.dev');
  }
});

test('get_project reports the available ids when the name is wrong', async () => {
  const miss = await call('get_project', { project: 'nope' });
  assert.match(miss.error, /No project matching/);
  assert.ok(miss.available.includes('chipspot'));
});

test('search matches on description text, not just names', async () => {
  const hits = await call('search', { query: 'knowledge graph' });
  assert.equal(hits.count, 1);
  assert.equal(hits.matches[0].name, 'PossOnto');

  assert.equal((await call('search', { query: 'zzzz' })).count, 0);
});

test('get_profile carries the bio and focus areas', async () => {
  const profile = await call('get_profile');
  assert.equal(profile.name, 'Terrence Ye Yang');
  assert.ok(profile.about.length >= 1);
  assert.ok(profile.focusAreas.length >= 1);
  assert.equal(profile.projectCount, PROJECTS.length);
});

test('resources list and read round-trip', async () => {
  const { body: list } = await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  const uris = list.result.resources.map((r) => r.uri);
  assert.ok(uris.includes('homepage://profile'));
  assert.ok(uris.includes('homepage://news'));
  assert.ok(uris.includes('homepage://projects/chipspot'));
  assert.ok(uris.includes('homepage://projects/bwxpixel'));

  const { body: newsRead } = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'resources/read',
    params: { uri: 'homepage://news' },
  });
  const newsItems = JSON.parse(newsRead.result.contents[0].text);
  assert.ok(Array.isArray(newsItems) && newsItems.length >= 1);
  assert.equal(newsItems[0].project, 'bwxPixel');

  const { body: read } = await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'resources/read',
    params: { uri: 'homepage://projects/chipspot' },
  });
  assert.equal(read.result.contents[0].mimeType, 'application/json');
  assert.equal(JSON.parse(read.result.contents[0].text).name, 'ChipSpot Cloud');
});

test('prompts/get builds messages', async () => {
  const { body } = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'prompts/get',
    params: { name: 'project_pitch', arguments: { project: 'chipspot' } },
  });
  assert.equal(body.result.messages[0].role, 'user');
  assert.match(body.result.messages[0].content.text, /chipspot/);
});

test('unknown tool, resource, and method are protocol errors', async () => {
  const tool = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(tool.body.error.code, -32602);

  const resource = await rpc({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'homepage://nope' } });
  assert.equal(resource.body.error.code, -32602);

  const method = await rpc({ jsonrpc: '2.0', id: 3, method: 'nope/nope' });
  assert.equal(method.body.error.code, -32601);
});

test('malformed JSON is a parse error, not a crash', async () => {
  const response = await worker.fetch(
    new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, -32700);
});

test('GET explains itself instead of returning a bare 405', async () => {
  const response = await worker.fetch(new Request(ENDPOINT, { method: 'GET' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
  assert.match(await response.text(), /MCP server/);
});

test('CORS preflight is allowed', async () => {
  const response = await worker.fetch(new Request(ENDPOINT, { method: 'OPTIONS' }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});
