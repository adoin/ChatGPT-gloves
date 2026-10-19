'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionFilter } = require('../plugins/image-history-guard/lib/filter.cjs');
const { resolveIdentity, identityHeaders } = require('../plugins/image-history-guard/lib/identity.cjs');
const { FilterEngine, EventObserver } = require('../plugins/image-history-guard/lib/engine.cjs');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const image = (value = 'A', size = 6000) => ({ type: 'input_image', image_url: 'data:image/png;base64,' + Buffer.alloc(size, value.charCodeAt(0)).toString('base64'), detail: 'high' });
const msg = (...content) => ({ role: 'user', content });
const request = (input, extra = {}) => ({ client_metadata: { thread_id: A }, input, ...extra });
const context = (id = A, account = 'account-A') => ({ upstream: 'https://test.invalid', headers: { 'x-client-request-id': id, 'chatgpt-account-id': account } });
function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-session-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, filter: new SessionFilter(root, options) };
}
function prepare(filter, payload, ctx = context()) {
  const before = Buffer.from(JSON.stringify(payload));
  const result = filter.prepare(before, ctx);
  return { ...result, payload: JSON.parse(result.buffer), changed: !result.buffer.equals(before) };
}
const images = payload => payload.input.reduce((sum, item) => sum + (item.content || item.output || []).filter(part => part.type === 'input_image').length, 0);

test('first occurrence is immutable when a later full request repeats the image', t => {
  const { filter } = fixture(t);
  const source = request([msg(image())]);
  const snapshot = JSON.stringify(source);
  const first = prepare(filter, source);
  assert.equal(images(first.payload), 1);
  const later = prepare(filter, request([...source.input, msg(image())]));
  assert.deepEqual(later.payload.input[0], first.payload.input[0]);
  assert.equal(images(later.payload), 1);
  assert.match(later.payload.input[1].content[0].text, /reference IMG-/);
  assert.equal(JSON.stringify(source), snapshot);
  const again = prepare(filter, later.payload);
  assert.deepEqual(again.payload, later.payload, 'already transformed anchors stay stable');
});

test('incremental deduplication requires a confirmed successful ancestor', t => {
  const { filter } = fixture(t);
  const first = prepare(filter, request([msg(image())]));
  const failed = prepare(filter, request([msg(image())], { previous_response_id: 'response-unknown' }));
  assert.equal(images(failed.payload), 1);
  filter.fail(first.ticket);
  const unconfirmed = prepare(filter, request([msg(image())], { previous_response_id: 'response-first' }));
  assert.equal(images(unconfirmed.payload), 1);
  filter.complete(unconfirmed.ticket, 'response-confirmed');
  const next = prepare(filter, request([msg(image())], { previous_response_id: 'response-confirmed' }));
  assert.equal(images(next.payload), 0);
  assert.equal(next.stats.removedImages, 1);
  assert.equal(next.payload.previous_response_id, 'response-confirmed');
  filter.complete(next.ticket, 'response-next');
  assert.equal(images(prepare(filter, request([msg(image())], { previous_response_id: 'response-next' })).payload), 0);
});

test('thread/account/fork isolation does not depend on shared cache affinity', t => {
  const { filter } = fixture(t);
  const first = prepare(filter, request([msg(image())], { prompt_cache_key: 'shared-parent' }));
  filter.complete(first.ticket, 'same-response-id');
  for (const [thread, account] of [[B, 'account-A'], [A, 'account-B']]) {
    const other = prepare(filter, request([msg(image())], { client_metadata: { thread_id: thread },
      prompt_cache_key: 'shared-parent', previous_response_id: 'same-response-id' }), context(thread, account));
    assert.equal(images(other.payload), 1);
    assert.equal(other.stats.removedImages, 0);
    assert.notEqual(other.payload.input[0].content[0].text, first.payload.input[0].content[0].text);
  }
});

test('missing or conflicting identity is forwarded byte-for-byte without storage', t => {
  const { filter } = fixture(t);
  for (const [payload, ctx] of [
    [{ input: [msg(image(), image())] }, {}],
    [request([msg(image(), image())]), context(B)],
    [request([msg(image())], { client_metadata: { thread_id: 'not-a-thread-id' } }), context()],
    [request([msg(image())]), { headers: { 'x-client-request-id': A } }],
    [{ input: [msg(image())] }, { ...context(), websocket: true }],
  ]) assert.equal(prepare(filter, payload, ctx).changed, false);
  assert.equal(filter.store.stats().storedImages, 0);
  const safe = identityHeaders({ authorization: 'Bearer do-not-transfer' }, 'https://test.invalid');
  assert.ok(!JSON.stringify(safe).includes('do-not-transfer'));
  assert.equal(resolveIdentity(request([]), { ...context().headers, 'x-codex-turn-metadata': '{bad' }), null);
});

test('restarting the proxy preserves blobs and paths, but never assumes old lineage survived', t => {
  const { filter, root } = fixture(t);
  const first = prepare(filter, request([msg(image())])); filter.complete(first.ticket, 'old-response');
  const restarted = new SessionFilter(root);
  const next = prepare(restarted, request([msg(image())], { previous_response_id: 'old-response' }));
  assert.equal(images(next.payload), 1);
  assert.equal(next.stats.unknownLineage, true);
  assert.equal(next.payload.input[0].content[0].text, first.payload.input[0].content[0].text);
  const fullReplay = prepare(restarted, request([msg(image()), msg(image())]));
  assert.equal(images(fullReplay.payload), 1);
  assert.deepEqual(fullReplay.payload.input[0], first.payload.input[0]);
});

test('explicit view_image restoration is not deduplicated away', t => {
  const { filter } = fixture(t);
  const first = prepare(filter, request([msg(image())])); filter.complete(first.ticket, 'old-response');
  const label = first.payload.input[0].content[0].text;
  const file = label.match(/Local copy: (.+?)\. If/)[1];
  assert.equal(fs.existsSync(file), true);
  for (const nativePath of [file, file.replace(/\//g, '\\')]) {
    const restored = prepare(filter, request([
      { type: 'function_call', name: 'view_image', call_id: 'restore', arguments: JSON.stringify({ path: nativePath }) },
      { type: 'function_call_output', call_id: 'restore', output: [image()] },
    ], { previous_response_id: 'old-response' }));
    assert.equal(images(restored.payload), 1);
  }
  const toolRequest = prepare(filter, request([msg({ type: 'input_text', text: 'reload' })], { previous_response_id: 'old-response' }));
  filter.noteOutput(toolRequest.ticket, { type: 'function_call', name: 'view_image', call_id: 'incremental-restore', arguments: JSON.stringify({ path: file }) });
  filter.complete(toolRequest.ticket, 'tool-request-response');
  const outputOnly = prepare(filter, request([
    { type: 'function_call_output', call_id: 'incremental-restore', output: [image()] },
  ], { previous_response_id: 'tool-request-response' }));
  assert.equal(images(outputOnly.payload), 1, 'incremental tool outputs may omit the preceding model call');
  assert.equal(outputOnly.stats.restoredImages, 1);
});

test('compaction invalidates known lineage and automatic compaction disables inherited references', t => {
  const { filter } = fixture(t);
  const first = prepare(filter, request([msg(image())])); filter.complete(first.ticket, 'old');
  const compact = prepare(filter, request([msg(image())]), { ...context(), compact: true });
  assert.equal(compact.changed, false);
  assert.equal(images(prepare(filter, request([msg(image())], { previous_response_id: 'old' })).payload), 1);
  const seeded = prepare(filter, request([msg(image())])); filter.complete(seeded.ticket, 'new');
  const auto = prepare(filter, request([msg(image())], { previous_response_id: 'new', context_management: [{ type: 'compaction' }] }));
  assert.equal(images(auto.payload), 1);
  filter.complete(auto.ticket, 'after-auto');
  assert.equal(images(prepare(filter, request([msg(image())], { previous_response_id: 'after-auto' })).payload), 1);
});

test('bounded blob eviction falls back to originals and hashing caches repeated images', t => {
  const { filter } = fixture(t, { maxBytes: 9000, maxImages: 2 });
  const first = prepare(filter, request([msg(image('A'))])); filter.complete(first.ticket, 'old');
  const repeat = prepare(filter, request([msg(image('A'))]));
  assert.equal(repeat.stats.hashCacheHits, 1);
  prepare(filter, request([msg(image('B'))]));
  assert.ok(filter.store.stats().storedBytes <= 9000);
  const evicted = prepare(filter, request([msg(image('A'))], { previous_response_id: 'old' }));
  assert.equal(images(evicted.payload), 1);
});

test('opaque inputs and non-image fields remain untouched', t => {
  const { filter } = fixture(t);
  const payload = request([{ type: 'function_call', arguments: JSON.stringify(image()) },
    { type: 'function_call_output', output: JSON.stringify([image()]) },
    { type: 'image_generation_call', result: image().image_url }]);
  assert.equal(prepare(filter, payload).changed, false);
  const cancelled = Buffer.from(JSON.stringify({ ...request([msg(image(), image())]), type: 'response.cancel' }));
  assert.strictEqual(filter.prepare(cancelled, { ...context(), websocket: true }).buffer, cancelled);
});

test('worker completes only the matching request and response; errors cannot poison a later queue', async t => {
  const { root } = fixture(t); const engine = new FilterEngine(root);
  t.after(() => engine.close());
  const ctx = { ...context(), websocket: true, connection: 'one' };
  async function send(payload) { return engine.prepare(Buffer.from(JSON.stringify({ type: 'response.create', ...payload })), ctx); }
  async function event(type, response) { return engine.observe('one', Buffer.from(JSON.stringify({ type, response }))); }
  await send(request([msg(image('A'))]));
  await engine.observe('one', Buffer.from('{"type":"error","error":{"code":"failed"}}'));
  await send(request([msg(image('B'))]));
  await event('response.created', { id: 'B' }); await event('response.completed', { id: 'B', status: 'completed', output: [] });
  const a = await send(request([msg(image('A'))], { previous_response_id: 'B' }));
  assert.equal(images(JSON.parse(a.buffer)), 1);
  const b = await send(request([msg(image('B'))], { previous_response_id: 'B' }));
  assert.equal(images(JSON.parse(b.buffer)), 0);
});

test('SSE observation handles chunk boundaries and skips oversized events', () => {
  const observed = [];
  const observer = new EventObserver(buffer => observed.push(buffer.toString()), 30);
  observer.push(Buffer.from('da')); observer.push(Buffer.from('ta: {"ok":1}\n\n'));
  observer.push(Buffer.from('data: ' + 'x'.repeat(40))); observer.push(Buffer.from('\n\ndata: {"ok":2}\n\n'));
  assert.deepEqual(observed, ['{"ok":1}', '{"ok":2}']);
});
