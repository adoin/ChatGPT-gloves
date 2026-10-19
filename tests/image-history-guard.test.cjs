'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../plugins/image-history-guard');
const localRequire = createRequire(path.join(root, 'package.json'));
const { WebSocket, WebSocketServer } = localRequire('ws');
const { createProxy } = require(path.join(root, 'lib/proxy.cjs'));
const { attachConfig, detachConfig, control } = require(path.join(root, 'scripts/guard.cjs'));
const image = (value = 'one') => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(value.repeat(2000)).toString('base64')}`, detail: 'high' });
const message = (...content) => ({ role: 'user', content });
const capability = 'a'.repeat(48);
const THREAD = '11111111-1111-4111-8111-111111111111';
const nativeFetch = global.fetch;
const fetch = (url, options = {}) => nativeFetch(url, { ...options, headers: { authorization: 'Bearer test', 'x-client-request-id': THREAD, ...options.headers } });
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  const url = await listen(upstream);
  const imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-http-test-'));
  const guard = createProxy({ upstream: `${url}/backend-api/codex`, capability, allowLocalUpstream: true, imageRoot, ...options });
  const local = await listen(guard);
  t.after(async () => { await guard.guardClose(); upstream.closeAllConnections(); upstream.close(); fs.rmSync(imageRoot, { recursive: true, force: true }); });
  return { upstream, guard, base: `${local}${guard.guardPrefix}` };
}
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }

test('HTTP forwards auth, query, SSE bytes and correct filtered lengths', async t => {
  const input = { input: [message(image()), message(image())] };
  let received;
  const { base } = await setup(t, async (req, res) => {
    const data = await body(req); received = { headers: req.headers, url: req.url, data };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-test': 'ok' });
    res.write('data: {"delta":"hello"}\n\n'); setImmediate(() => res.end('data: [DONE]\n\n'));
  });
  const response = await fetch(`${base}/responses?test=1`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: 'Bearer local-test-only', 'chatgpt-account-id': 'test',
  }, body: JSON.stringify(input) });
  assert.equal(await response.text(), 'data: {"delta":"hello"}\n\ndata: [DONE]\n\n');
  assert.equal(received.headers.authorization, 'Bearer local-test-only');
  assert.equal(received.headers['chatgpt-account-id'], 'test');
  assert.equal(received.url, '/backend-api/codex/responses?test=1');
  assert.equal(Number(received.headers['content-length']), received.data.length);
  assert.equal(JSON.parse(received.data).input[0].content[0].type, 'input_text');
  const status = await (await fetch(`${base}/_guard/status`)).json();
  assert.equal(status.removedImages, 1);
  assert.ok(status.savedBytes > 0);
  assert.ok(!JSON.stringify(status).includes('local-test-only'));
});

test('compressed bodies deduplicate; opaque unknown encodings are byte-preserved', async t => {
  const received = [];
  const { base } = await setup(t, async (req, res) => { received.push({ data: await body(req), headers: req.headers }); res.end('{}'); });
  const raw = Buffer.from(JSON.stringify({ input: [message(image(), image())] }));
  for (const [encoding, encode] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
    await (await fetch(`${base}/responses`, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-encoding': encoding,
    }, body: encode(raw) })).text();
    const result = received.at(-1);
    assert.equal(result.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(result.data).input[0].content.filter(p => p.type === 'input_image').length, 1);
  }
  const unique = zlib.gzipSync(Buffer.from(JSON.stringify({ input: [message({ type: 'input_text', text: 'hello' })] })));
  await (await fetch(`${base}/responses`, { method: 'POST', headers: {
    'content-type': 'application/json', 'content-encoding': 'gzip',
  }, body: unique })).text();
  assert.deepEqual(received.at(-1).data, unique);
  assert.equal(received.at(-1).headers['content-encoding'], 'gzip');
  await (await fetch(`${base}/responses`, { method: 'POST', headers: {
    'content-type': 'application/json', 'content-encoding': 'unknown',
  }, body: raw })).text();
  assert.deepEqual(received.at(-1).data, raw);
});

test('restricted local routing, origin rejection, size bounds and upstream errors', async t => {
  let calls = 0;
  const { base } = await setup(t, (_req, res) => { calls++; res.writeHead(429, { 'retry-after': '3' }).end('rate-limited'); }, { maxBytes: 1024 });
  assert.equal((await fetch(`${base}/responses`, { headers: { origin: 'https://example.com' } })).status, 404);
  assert.equal((await fetch(`${base}/../../evil`)).status, 404);
  assert.equal((await fetch(`${base}/arbitrary`)).status, 404);
  assert.equal((await fetch(base.replace(capability, 'b'.repeat(48)) + '/responses')).status, 404);
  assert.equal(calls, 0);
  const error = await fetch(`${base}/models`);
  assert.equal(error.status, 429); assert.equal(error.headers.get('retry-after'), '3');
  assert.equal(await error.text(), 'rate-limited');
  const oversized = await fetch(`${base}/responses`, { method: 'POST', body: 'x'.repeat(1025) });
  assert.equal(oversized.status, 413); assert.equal(calls, 1);
});

test('HTTP completion enables a later reference, while failures and unknown lineage retain originals', async t => {
  const requests = [];
  let count = 0;
  const { base } = await setup(t, async (req, res) => {
    const payload = JSON.parse(await body(req)); requests.push(payload);
    const id = `response-${++count}`;
    if (count === 3) { res.writeHead(500).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id } }) + '\n\n');
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output: [],
      usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 10 } } }) + '\n\n');
  });
  const send = previous => fetch(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: [message(image())], ...(previous ? { previous_response_id: previous } : {}) }) }).then(r => r.text());
  await send(); await send('response-1');
  assert.equal(requests[0].input[0].content.filter(p => p.type === 'input_image').length, 1);
  assert.equal(requests[1].input[0].content.filter(p => p.type === 'input_image').length, 0);
  await send('missing-response'); await send('response-3');
  assert.equal(requests[3].input[0].content.filter(p => p.type === 'input_image').length, 1);
  const status = await (await fetch(`${base}/_guard/status`)).json();
  assert.equal(status.removedImages, 1);
  assert.equal(status.inputTokens, 6000);
  assert.equal(status.cachedInputTokens, 4500);
});

test('compaction input and unidentified requests remain byte-identical', async t => {
  const requests = [];
  const { base } = await setup(t, async (req, res) => { requests.push(await body(req)); res.end('{}'); });
  const raw = JSON.stringify({ input: [message(image(), image())] });
  await (await fetch(`${base}/responses/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).text();
  await (await nativeFetch(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).text();
  assert.equal(requests[0].toString(), raw); assert.equal(requests[1].toString(), raw);
});

test('WebSocket filters images and preserves incremental lineage, binary, output and close semantics', async t => {
  const { upstream, base } = await setup(t, (_req, res) => res.end('{}'));
  const wss = new WebSocketServer({ server: upstream });
  wss.on('headers', headers => headers.push('x-codex-turn-state: test-turn-state'));
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  let auth;
  const received = [];
  wss.on('connection', (socket, req) => {
    auth = req.headers.authorization;
    socket.on('message', (data, binary) => { received.push(data); socket.send(data, { binary }); });
  });
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/responses`, { headers: { authorization: 'Bearer test', 'x-client-request-id': THREAD } });
  let turnState;
  ws.on('upgrade', response => { turnState = response.headers['x-codex-turn-state']; });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  assert.equal(turnState, 'test-turn-state');
  const full = { type: 'response.create', client_metadata: { thread_id: THREAD }, input: [message(image(), image())] };
  ws.send(JSON.stringify(full));
  let [data] = await once(ws, 'message');
  assert.equal(JSON.parse(data).input[0].content.filter(p => p.type === 'input_image').length, 1);
  assert.equal(auth, 'Bearer test');
  const delta = JSON.stringify({ type: 'response.create', client_metadata: { thread_id: THREAD }, previous_response_id: 'response-previous', input: [message(image())] });
  ws.send(delta); [data] = await once(ws, 'message'); assert.equal(JSON.parse(data).previous_response_id, 'response-previous');
  assert.equal(JSON.parse(data).input[0].content.filter(p => p.type === 'input_image').length, 1);
  ws.send(Buffer.from([1, 2, 3]), { binary: true });
  const [binary, isBinary] = await once(ws, 'message'); assert.equal(isBinary, true); assert.deepEqual(binary, Buffer.from([1, 2, 3]));
  const closed = once(ws, 'close');
  [...wss.clients][0].close(1000, 'finished');
  const [code, reason] = await closed; assert.equal(code, 1000); assert.equal(reason.toString(), 'finished');
  assert.equal(received.length, 3);
});

test('configuration changes preserve unrelated TOML and refuse routing conflicts', () => {
  const text = '# user config\nmodel = "example"\n[projects."D:/work"]\ntrust_level = "trusted"\n';
  const url = 'http://127.0.0.1:9/secret/backend-api/codex';
  const enabled = attachConfig(text, url);
  assert.equal(detachConfig(enabled, url), text);
  const edited = enabled + '\n[features]\napps = true\n';
  assert.equal(detachConfig(edited, url), text + '\n[features]\napps = true\n');
  for (const config of ['openai_base_url = "https://other"', 'model_provider = "other"',
    '[model_providers.openai]\nbase_url = "https://other"']) assert.throws(() => attachConfig(config, url));
  assert.throws(() => detachConfig(enabled.replace(':9/', ':10/'), url));
});

test('controller enables a copied runtime, restarts it, disables without losing edits, and stops', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-lifecycle-'));
  const config = path.join(home, 'config.toml');
  const original = 'model = "test"\n';
  fs.writeFileSync(config, original);
  t.after(async () => {
    try { await control('disable', home); } catch { /* already disabled */ }
    try { await control('stop', home); } catch { /* startup may have failed */ }
    // All targets were created by this fixture under a resolved OS temp root.
    assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal((await control('status', home)).installed, false);
  const enabled = await control('enable', home);
  assert.equal(enabled.enabled, true);
  assert.equal((await control('status', home)).running, true);
  assert.equal((await control('enable', home)).enabled, true, 'idempotent enable');
  const stateFile = path.join(home, 'plugins/data/image-history-guard-chatgpt-gloves/installation.json');
  let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const previousBase = state.baseUrl;
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, runtime: path.join(home, 'old-runtime') }));
  assert.equal((await control('upgrade', home)).upgraded, true);
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.notEqual(state.baseUrl, previousBase);
  assert.equal((await nativeFetch(previousBase + '/_guard/status')).status, 200, 'upgrade keeps old clients connected');
  await fetch(`${state.baseUrl}/_guard/shutdown`, { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await control('status', home)).running, false);
  const hook = spawnSync(process.execPath, [path.join(root, 'hooks/session-start.cjs')], {
    env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 14000,
  });
  assert.equal(hook.status, 0);
  assert.equal((await control('status', home)).running, true, 'trusted startup hook restores an enabled route');
  await assert.rejects(control('stop', home), /Disable routing/);
  fs.appendFileSync(config, '[features]\napps = true\n');
  await control('disable', home);
  assert.equal(fs.readFileSync(config, 'utf8'), original + '[features]\napps = true\n');
  assert.equal((await control('status', home)).running, true, 'old app processes keep their listener');
  await control('stop', home);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await control('status', home)).running, false);
  const inactiveHook = spawnSync(process.execPath, [path.join(root, 'hooks/session-start.cjs')], {
    env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 14000,
  });
  assert.equal(inactiveHook.status, 0);
  assert.equal((await control('status', home)).running, false, 'disabled routes are never restarted by the hook');
  assert.equal((await control('start', home)).running, true);
  assert.equal((await control('enable', home)).enabled, true);
});
