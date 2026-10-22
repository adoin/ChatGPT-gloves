'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../plugins/conversation-lifeboat');

test('manual plugin registers no automatic hooks and retains both requested workflows', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks, {});
  for (const skill of ['conversation-handoff', 'spec-update']) {
    assert.ok(fs.existsSync(path.join(root, 'skills', skill, 'SKILL.md')));
  }
});

test('stale health hooks remain silent without reading transcripts or updating legacy state', t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeboat-manual-'));
  t.after(() => {
    assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(data, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(data, 'sessions'));
  const stateFile = path.join(data, 'sessions/test.json');
  const prior = JSON.stringify({ migrationOfferPending: true, lastNotifiedLevel: 'critical' });
  fs.writeFileSync(stateFile, prior);
  for (const input of ['not JSON', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'test',
    prompt: '一直重连，请检查', transcript_path: path.join(data, 'missing-transcript') })]) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/conversation-health.cjs')], {
      input, encoding: 'utf8', timeout: 2000, env: { ...process.env, PLUGIN_DATA: data },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), prior);
  }
  assert.deepEqual(fs.readdirSync(data), ['sessions']);
  assert.deepEqual(fs.readdirSync(path.join(data, 'sessions')), ['test.json']);
});
