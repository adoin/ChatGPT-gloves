'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const script = path.resolve(__dirname, '../plugins/conversation-lifeboat/scripts/conversation-health.cjs');
const token = (count = 800000, window = 828400, timestamp = new Date().toISOString()) =>
  JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { input_tokens: count }, model_context_window: window } } });
function image(value = 'A', length = 4096, timestamp = new Date().toISOString()) {
  return JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'custom_tool_call_output',
    output: [{ type: 'input_image', image_url: 'data:image/png;base64,' + value.repeat(length) }] } });
}
function fixture(t, lines = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeboat-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  return { root, transcript, data: path.join(root, 'data') };
}
function run(item, prompt = 'continue', extra = {}, env = {}) {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8',
    input: JSON.stringify({ session_id: 'session', transcript_path: item.transcript,
      hook_event_name: 'UserPromptSubmit', prompt, ...extra }),
    env: { ...process.env, PLUGIN_DATA: item.data, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}
const state = item => JSON.parse(fs.readFileSync(path.join(item.data, 'sessions/session.json'), 'utf8'));
const tinyLimits = { CONVERSATION_LIFEBOAT_WARN_IMAGE_MIB: '0.001', CONVERSATION_LIFEBOAT_RECOMMEND_IMAGE_MIB: '0.02',
  CONVERSATION_LIFEBOAT_CRITICAL_IMAGE_MIB: '0.04', CONVERSATION_LIFEBOAT_DUPLICATE_IMAGE_MIB: '0.008' };

test('high tokens and context percentage never notify, including retired environment limits', t => {
  for (const [count, window] of [[306550, 828400], [452341, 828400], [990000, 1000000]]) {
    const item = fixture(t, [token(count, window)]);
    assert.equal(run(item, 'fix this', {}, { CONVERSATION_LIFEBOAT_CRITICAL_INPUT_TOKENS: '1',
      CONVERSATION_LIFEBOAT_CRITICAL_CONTEXT_RATIO: '0.01', CONVERSATION_LIFEBOAT_WARN_MIB: '0' }), null);
    assert.equal(state(item).lastCheck.level, 'healthy');
    assert.equal(state(item).lastCheck.inputTokens, count);
  }
});
test('missing, stale usage and unavailable transcript do not create unsolicited handoff offers', t => {
  for (const lines of [[], [token(800000, 828400, '2026-01-01T00:00:00Z')]]) {
    const item = fixture(t, lines); assert.equal(run(item), null);
  }
  const item = fixture(t); fs.unlinkSync(item.transcript);
  assert.equal(run(item), null);
  const review = run(item, '重连');
  assert.equal(review.continue, true);
  assert.match(review.hookSpecificOutput.additionalContext, /payload is unknown/);
  assert.ok(!state(item).migrationOfferPending);
});
test('ordinary repeated compaction alone does not offer handoff', t => {
  const item = fixture(t);
  for (let i = 0; i < 5; i++) assert.equal(run(item, '', { hook_event_name: 'PostCompact', turn_id: `t-${i}` }), null);
  assert.equal(run(item), null);
  assert.equal(state(item).lastCheck.recentCompactions, 5);
});
test('image retention and repeated payloads create evidence-based nonblocking offers', t => {
  const item = fixture(t, [image('A', 15000), image('A', 15000)]);
  const output = run(item, 'fix this', {}, tinyLimits);
  assert.match(output.systemMessage, /recommend/);
  assert.match(output.hookSpecificOutput.additionalContext, /Keep working/);
  assert.equal(state(item).lastCheck.imageCount, 2);
  assert.ok(state(item).lastCheck.duplicateImageBytes > 15000);
  assert.equal(state(item).migrationOfferPending, true);
  assert.ok(!JSON.stringify(state(item)).includes('data:image'));
});
test('one connection failure forces review; persistence or image risk supports offering handoff', t => {
  const plain = fixture(t, [token()]);
  const review = run(plain, 'idle timeout sending websocket request');
  assert.match(review.hookSpecificOutput.additionalContext, /Reassess/);
  assert.equal(state(plain).lastCheck.level, 'warning');
  assert.ok(!state(plain).migrationOfferPending);
  const repeated = run(plain, '还是一直重连');
  assert.match(repeated.systemMessage, /recommend/);
  assert.equal(state(plain).migrationOfferPending, true);
  const images = fixture(t, [image()]);
  assert.match(run(images, '重连', {}, tinyLimits).systemMessage, /recommend/);
});
test('declining persists across cooldown; connection reports still review without nagging', t => {
  const item = fixture(t, [image('A', 30000)]);
  assert.ok(run(item, 'fix this', {}, tinyLimits));
  assert.equal(run(item, '不用 就当前的吧', {}, tinyLimits), null);
  const saved = state(item); saved.lastNotifiedAt = 0;
  fs.writeFileSync(path.join(item.data, 'sessions/session.json'), JSON.stringify(saved));
  assert.equal(run(item, 'continue', {}, tinyLimits), null);
  const review = run(item, '重连', {}, tinyLimits);
  assert.match(review.hookSpecificOutput.additionalContext, /user chose to stay/);
  assert.match(review.hookSpecificOutput.additionalContext, /without offering migration/);
  fs.appendFileSync(item.transcript, image('B', 30000) + '\n');
  assert.match(run(item, 'continue', {}, tinyLimits).systemMessage, /critical/);
});
test('explicit confirmation is routed only for an outstanding offer', t => {
  const item = fixture(t, [image('A', 30000)]);
  run(item, 'continue', {}, tinyLimits);
  assert.match(run(item, '确认迁移', {}, tinyLimits).hookSpecificOutput.additionalContext, /invoke \$conversation-handoff/);
  const healthy = fixture(t, [token()]);
  assert.equal(run(healthy, '确认'), null);
});
test('image samples exclude mirrored events, and compaction resets the active segment', t => {
  const line = image();
  const mirrored = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: JSON.parse(line).payload } });
  const item = fixture(t, [line, mirrored]); run(item, 'continue', {}, tinyLimits);
  assert.equal(state(item).lastCheck.imageCount, 1);
  fs.appendFileSync(item.transcript, JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), type: 'compacted', payload: {} }) + '\n');
  assert.equal(run(item, 'continue', {}, tinyLimits), null);
  assert.equal(state(item).lastCheck.retainedImageBytes, 0);
});
test('bounded tail accumulation avoids double counting across checks', t => {
  const item = fixture(t, [image('A', 4096)]);
  const env = { ...tinyLimits, CONVERSATION_LIFEBOAT_TAIL_MIB: '0.01' };
  run(item, 'continue', {}, env);
  const first = state(item).lastCheck.retainedImageBytes;
  run(item, 'continue', {}, env);
  assert.equal(state(item).lastCheck.retainedImageBytes, first);
  fs.appendFileSync(item.transcript, image('B', 4096) + '\n' + image('C', 4096) + '\n');
  run(item, 'continue', {}, env);
  const after = state(item).lastCheck;
  assert.equal(after.partialSample, true);
  assert.equal(after.retainedImageBytes, first * 3);
  run(item, 'continue', {}, env);
  assert.equal(state(item).lastCheck.retainedImageBytes, first * 3);
});
test('large partial records stay bounded and cannot be mistaken for healthy image-free history', t => {
  const item = fixture(t, [image('A', 20000)]);
  const output = run(item, 'continue', {}, { ...tinyLimits, CONVERSATION_LIFEBOAT_TAIL_MIB: '0.01' });
  assert.equal(state(item).lastCheck.sampledBytes, Math.floor(0.01 * 1024 * 1024));
  assert.match(output.systemMessage, /warning/);
  assert.ok(!state(item).migrationOfferPending);
});
test('structured recent failures are reviewed; success clears old failures; command text is ignored', t => {
  const now = Date.now();
  const error = JSON.stringify({ timestamp: new Date(now - 1000).toISOString(), type: 'event_msg',
    payload: { type: 'error', message: 'stream disconnected before completion' } });
  const item = fixture(t, [error]);
  assert.match(run(item).systemMessage, /warning/);
  fs.appendFileSync(item.transcript, token(1000, 828400, new Date(now + 1000).toISOString()) + '\n');
  assert.equal(run(item), null);
  assert.equal(state(item).lastCheck.recentFailures, 0);
  const logs = fixture(t, [JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'example: stream disconnected' } })]);
  assert.equal(run(logs), null);
});
test('legacy token-based pending offers are discarded on policy upgrade', t => {
  const item = fixture(t, [token()]);
  fs.mkdirSync(path.join(item.data, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(item.data, 'sessions/session.json'), JSON.stringify({ migrationOfferPending: true,
    lastNotifiedLevel: 'critical', compactions: [] }));
  assert.equal(run(item, '确认'), null);
  assert.equal(state(item).migrationOfferPending, false);
});
