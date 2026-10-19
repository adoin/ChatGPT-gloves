'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.resolve(__dirname, '../plugins/conversation-lifeboat/scripts/conversation-health.cjs');

function tokenLine(inputTokens, timestamp = new Date().toISOString()) {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { input_tokens: inputTokens }, model_context_window: 828400 } } });
}

test('absolute token limits protect large windows independently of percentage', (t) => {
  for (const [tokens, level] of [[199999, null], [200000, 'warning'], [300000, 'recommend'], [452341, 'critical']]) {
    const item = fixture([tokenLine(tokens)]);
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const output = run({ session_id: 'absolute', transcript_path: item.transcript,
      hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, item.data);
    if (!level) assert.equal(output, null);
    else assert.match(output.systemMessage, new RegExp(`${level}:`));
  }
});

test('stale or missing usage does not establish healthy status', (t) => {
  for (const lines of [[], [tokenLine(1000, '2026-01-01T00:00:00Z')]]) {
    const item = fixture(lines);
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const output = run({ session_id: 'stale', transcript_path: item.transcript,
      hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, item.data);
    assert.match(output.systemMessage, /current health is unknown/);
    assert.equal(output.hookSpecificOutput, undefined);
  }
});

test('connection reports bypass cooldown and force review without automatic migration', (t) => {
  const item = fixture([tokenLine(250000)]);
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const input = { session_id: 'reconnect', transcript_path: item.transcript,
    hook_event_name: 'UserPromptSubmit', prompt: 'continue' };
  assert.ok(run(input, item.data));
  assert.equal(run(input, item.data), null);
  for (const prompt of ['一直重连怎么办', 'idle timeout sending websocket request', 'Reconnecting 2/5']) {
    const output = run({ ...input, prompt }, item.data);
    assert.match(output.hookSpecificOutput.additionalContext, /Reassess conversation health/);
    assert.match(output.hookSpecificOutput.additionalContext, /explicit user confirmation/);
  }
  assert.equal(run(input, item.data), null);
});

test('unreadable transcript fails open and reports uncertainty', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const output = run({ session_id: 'missing', transcript_path: path.join(item.root, 'missing'),
    hook_event_name: 'UserPromptSubmit', prompt: '重连' }, item.data);
  assert.equal(output.continue, true);
  assert.match(output.systemMessage, /unknown/);
});

function fixture(lines = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-lifeboat-test-'));
  const transcript = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf8');
  return { root, transcript, data: path.join(root, 'data') };
}

function run(input, data, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGIN_DATA: data,
      CONVERSATION_LIFEBOAT_WARN_MIB: '9999',
      CONVERSATION_LIFEBOAT_RECOMMEND_MIB: '9999',
      CONVERSATION_LIFEBOAT_CRITICAL_MIB: '9999',
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('warns without requesting migration at the warning threshold', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const output = run(
    {
      session_id: 'warning-session',
      transcript_path: item.transcript,
      hook_event_name: 'SessionStart',
      source: 'resume',
    },
    item.data,
    { CONVERSATION_LIFEBOAT_WARN_MIB: '0' },
  );
  assert.match(output.systemMessage, /warning:/);
  assert.equal(output.hookSpecificOutput, undefined);
});

test('warns without requesting migration at 80 percent context', (t) => {
  const tokenEvent = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 80 },
        model_context_window: 100,
      },
    },
  };
  const item = fixture([JSON.stringify(tokenEvent)]);
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const output = run(
    {
      session_id: 'context-warning-session',
      transcript_path: item.transcript,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue implementation',
    },
    item.data,
  );
  assert.match(output.systemMessage, /warning:/);
  assert.equal(output.hookSpecificOutput, undefined);
});

test('recommends migration at 85 percent context', (t) => {
  const tokenEvent = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 85 },
        model_context_window: 100,
      },
    },
  };
  const item = fixture([JSON.stringify(tokenEvent)]);
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const output = run(
    {
      session_id: 'context-recommend-session',
      transcript_path: item.transcript,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue implementation',
    },
    item.data,
  );
  assert.match(output.systemMessage, /recommend:/);
  assert.match(output.hookSpecificOutput.additionalContext, /ask whether to update durable project specifications/i);
});

test('counts distinct compactions and routes explicit confirmation to the skill', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const env = { CONVERSATION_LIFEBOAT_RECOMMEND_COMPACTIONS: '2' };

  for (const turn of ['turn-1', 'turn-2']) {
    const output = run(
      {
        session_id: 'compact-session',
        transcript_path: item.transcript,
        hook_event_name: 'PostCompact',
        turn_id: turn,
        trigger: 'auto',
      },
      item.data,
      env,
    );
    assert.equal(output, null);
  }

  const offer = run(
    {
      session_id: 'compact-session',
      transcript_path: item.transcript,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'what next?',
    },
    item.data,
    env,
  );
  assert.match(offer.systemMessage, /2 compactions/);

  const confirmation = run(
    {
      session_id: 'compact-session',
      transcript_path: item.transcript,
      hook_event_name: 'UserPromptSubmit',
      prompt: '确认迁移到新任务',
    },
    item.data,
    env,
  );
  assert.match(confirmation.hookSpecificOutput.additionalContext, /\$conversation-handoff/);
});
