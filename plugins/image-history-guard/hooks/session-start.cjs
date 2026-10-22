'use strict';

// Start an already-enabled installation before the first model request after a
// reboot. Never install dependencies, change routing, or grant hook trust here.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
try {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const stateFile = path.join(home, 'plugins/data/image-history-guard-chatgpt-gloves/installation.json');
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    if (state.baseUrl && config.includes(`openai_base_url = ${JSON.stringify(state.baseUrl)}`)) {
      const result = spawnSync(process.execPath, [path.join(state.runtime, 'scripts/guard.cjs'), 'start', '--hook', '--codex-home', home], {
        windowsHide: true, encoding: 'utf8', timeout: 12000,
      });
      if (result.status !== 0) process.stdout.write(JSON.stringify({ continue: true,
        systemMessage: 'Image History Guard could not start. Restore the listener or disable its managed route before making model requests.' }));
    }
  }
} catch {
  process.stderr.write('Image History Guard startup check failed safely.\n');
}
process.exitCode = 0;
