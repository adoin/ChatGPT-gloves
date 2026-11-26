'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../plugins/free-game-dev-assets');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'upstream-lock.json')));
const noFetch = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("Network access forbidden in offline test"); };');

function rpc(messages, packageRoot = root, cwd = os.tmpdir()) {
  const config = JSON.parse(fs.readFileSync(path.join(packageRoot, '.mcp.json'))).mcpServers['free-game-dev-assets'];
  const args = config.args.map(arg => path.isAbsolute(arg) || arg.startsWith('-') ? arg : path.resolve(packageRoot, arg));
  const result = spawnSync(process.execPath, ['--import', noFetch, ...args], {
    cwd, env: { ...process.env, FGDA_DATA: 'https://invalid.example/not-the-bundled-catalog' },
    input: messages.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n',
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });
const textResult = response => JSON.parse(response.result.content[0].text);

test('installed-style stdio handshake and real catalog queries run offline outside the plugin cwd', () => {
  const replies = rpc([
    request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    request(2, 'tools/list', {}),
    call(3, 'search_assets', { query: 'interface sounds', category: 'audio', license: 'CC0', commercial: true, no_attribution: true, limit: 3 }),
    call(4, 'get_asset', { id: 'kenney-interface-sounds' }),
    call(5, 'check_license', { id: 'kenney-interface-sounds', commercial: true, engine: 'godot' }),
    call(6, 'list_stacks'),
    call(7, 'get_asset', { id: 'missing-catalog-entry' }),
  ]);
  assert.equal(replies.length, 7, 'notifications produce no response');
  assert.equal(replies[0].result.serverInfo.name, 'free-game-dev-assets');
  assert.match(replies[0].result.instructions, /v2026\.11\.01.*preliminary/);
  assert.deepEqual(replies[1].result.tools.map(x => x.name), ['search_assets', 'get_asset', 'check_license', 'list_stacks']);
  for (const tool of replies[1].result.tools) assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const results = textResult(replies[2]);
  assert.ok(results.length > 0 && results.length <= 3);
  assert.ok(results.every(x => x.license === 'CC0' && x.commercial === true && x.attribution_required === false));
  assert.equal(textResult(replies[3]).url, 'https://kenney.nl/assets/interface-sounds');
  assert.equal(textResult(replies[4]).ok, true, 'catalog-level screening only');
  assert.ok(textResult(replies[5]).length > 0);
  assert.equal(replies[6].result.isError, true);
});

test('malformed or out-of-range requests do not kill the stdio server', () => {
  const replies = rpc(['not JSON', null, call(1, 'search_assets', { limit: 101 }), call(2, 'get_asset', {}), request(3, 'ping', {})]);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].error.code, -32600);
  assert.equal(replies[2].error.code, -32602);
  assert.equal(replies[3].error.code, -32602);
  assert.deepEqual(replies[4].result, {});
});

test('per-item and engine-locked entries remain unresolved instead of receiving blanket license approval', () => {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data/catalog.json')));
  const perItem = data.entries.find(x => x.status === 'per-item' || x.commercial === 'varies');
  const locked = data.entries.find(x => x.engine_lock === 'unreal');
  assert.ok(perItem); assert.ok(locked);
  const replies = rpc([call(1, 'check_license', { id: perItem.id }), call(2, 'check_license', { id: locked.id, engine: 'godot' })]);
  assert.equal(textResult(replies[0]).ok, false);
  assert.ok(textResult(replies[0]).problems.length);
  assert.equal(textResult(replies[1]).ok, false);
});

test('vendored sources, canonical skill and data match their pinned checksums', async () => {
  const { sha256, targetPath } = await import(pathToFileURL(path.join(root, 'scripts/sync-upstream.mjs')));
  for (const file of lock.files) assert.equal(sha256(fs.readFileSync(targetPath(file.target))), file.sha256, file.target);
  assert.throws(() => targetPath('../outside-package'), /Invalid/);
  assert.equal(lock.files.filter(x => x.private).length, 2);
});

test('package can relocate to a path with spaces; optional CLI uses the same offline snapshot', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fgda-package-'));
  t.after(() => {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const relocated = path.join(temporary, 'plugin with spaces');
  fs.cpSync(root, relocated, { recursive: true });
  assert.equal(rpc([request(1, 'initialize', {})], relocated)[0].result.serverInfo.name, 'free-game-dev-assets');
  const result = spawnSync(process.execPath, ['--import', noFetch, path.join(relocated, 'scripts/fgda.mjs'), 'get', 'kenney-interface-sounds', '--json'], {
    cwd: temporary, env: { ...process.env, FGDA_DATA: 'https://invalid.example' }, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).id, 'kenney-interface-sounds');
  const stacks = spawnSync(process.execPath, ['--import', noFetch, path.join(relocated, 'scripts/fgda.mjs'), '--json', 'stacks'], {
    cwd: temporary, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(stacks.status, 0, stacks.stderr);
  assert.equal(JSON.parse(stacks.stdout).length, 9);
});

test('maintainer GitHub access uses authenticated gh and never masks its failure with anonymous requests', async () => {
  const { githubClient } = await import(pathToFileURL(path.join(root, 'scripts/sync-upstream.mjs')));
  const calls = [];
  let anonymousCalls = 0;
  const spawn = (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'api') return { status: 1, stderr: Buffer.from('HTTP 403 API rate limit exceeded'), stdout: Buffer.alloc(0) };
    return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  };
  const client = githubClient({ spawn, request: async () => { anonymousCalls++; } });
  await assert.rejects(client(lock.files[0]), /403.*No anonymous retry/);
  assert.deepEqual(calls.slice(0, 2), [['--version'], ['auth', 'status', '--hostname', 'github.com']]);
  assert.equal(anonymousCalls, 0);
});

test('only public files may use anonymous fallback when gh is absent', async () => {
  const { githubClient } = await import(pathToFileURL(path.join(root, 'scripts/sync-upstream.mjs')));
  let calls = 0;
  const client = githubClient({ spawn: () => ({ error: { code: 'ENOENT' } }), request: async () => {
    calls++; return { ok: true, json: async () => ({ content: Buffer.from('fixture').toString('base64') }) };
  } });
  assert.equal((await client(lock.files[0])).toString(), 'fixture');
  await assert.rejects(client(lock.files.find(x => x.private)), /requires gh auth login/);
  assert.equal(calls, 1);
});

test('authenticated private-source reads stay inside gh; authentication network errors do not downgrade', async () => {
  const { githubClient } = await import(pathToFileURL(path.join(root, 'scripts/sync-upstream.mjs')));
  const spawn = (_cmd, args) => ({ status: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(args[0] === 'api' ? JSON.stringify({ content: Buffer.from('private fixture').toString('base64') }) : '') });
  const client = githubClient({ spawn, request: async () => { throw new Error('Unexpected anonymous access'); } });
  assert.equal((await client(lock.files.find(x => x.private))).toString(), 'private fixture');
  assert.throws(() => githubClient({ spawn: (_cmd, args) => args[0] === 'auth'
    ? { status: 1, stderr: Buffer.from('could not connect to github.com'), stdout: Buffer.alloc(0) }
    : { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) } }), /authentication check failed/);
});
