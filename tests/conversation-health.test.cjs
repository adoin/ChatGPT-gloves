'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.resolve(__dirname, '../plugins/conversation-lifeboat/scripts/conversation-health.cjs');

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

test('recommends migration when effective context crosses the threshold', (t) => {
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
      session_id: 'context-session',
      transcript_path: item.transcript,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue implementation',
    },
    item.data,
  );
  assert.match(output.systemMessage, /recommend:/);
  assert.match(output.hookSpecificOutput.additionalContext, /ask whether to create a durable handoff/i);
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
