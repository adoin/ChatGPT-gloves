#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { parse } = require('smol-toml');

const BEGIN = '# BEGIN image-history-guard (managed)';
const END = '# END image-history-guard (managed)';
const VERSION = '0.2.3';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function settings(home) {
  const data = path.join(home, 'plugins', 'data', 'image-history-guard-chatgpt-gloves');
  return { home, data, config: path.join(home, 'config.toml'), state: path.join(data, 'installation.json') };
}
function readState(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
function save(file, value) { atomic(file, JSON.stringify(value, null, 2) + '\n'); }
function attachConfig(text, baseUrl) {
  const config = parse(text);
  if (config.openai_base_url || (config.model_provider && config.model_provider !== 'openai') ||
    config.model_providers?.openai?.base_url || text.includes(BEGIN)) {
    throw new Error('Existing provider override found; refusing to overwrite routing.');
  }
  // Insert before all TOML tables, preserving comments, credentials and settings.
  return `${BEGIN}\nopenai_base_url = ${JSON.stringify(baseUrl)}\n${END}\n${text}`;
}
function detachConfig(text, baseUrl) {
  const block = `${BEGIN}\nopenai_base_url = ${JSON.stringify(baseUrl)}\n${END}\n`;
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(block)) throw new Error('Managed routing changed; refusing to overwrite user edits.');
  return normalized.slice(block.length);
}
async function health(state) {
  try {
    const response = await fetch(`${state.baseUrl}/_guard/status`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const info = await response.json();
    return info.service === 'image-history-guard' ? info : null;
  } catch { return null; }
}
async function stop(state) {
  try { await fetch(`${state.baseUrl}/_guard/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }); }
  catch { /* Already stopped; do not kill by potentially recycled PID. */ }
}
async function reapRetired(state, file) {
  const retained = [];
  let retiredListeners = 0;
  for (const old of state.retired || []) {
    if (old.baseUrl === state.baseUrl) continue;
    const info = await health(old);
    if (info) {
      try {
        // Legacy runtimes have no graceful retirement endpoint. The user's
        // startup cleanup policy permits retiring these via authenticated stop.
        if (!info.retirementSupported) await stop(old);
        else {
          const response = await fetch(`${old.baseUrl}/_guard/retire`, { method: 'POST', signal: AbortSignal.timeout(2000) });
          if (!response.ok) { retained.push(old); continue; }
        }
        retiredListeners++;
      } catch { retained.push(old); continue; }
    }
    // A retired listener can still be draining active WebSockets. Keep its
    // record until the process exits; never kill a potentially recycled PID.
    if (Number.isSafeInteger(old.pid) && old.pid > 0) {
      try { process.kill(old.pid, 0); retained.push(old); } catch (error) {
        if (error.code !== 'ESRCH') retained.push(old);
      }
    }
  }
  save(file, { ...state, retired: retained });
  return { retiredListeners, retainedProcesses: retained.length };
}
async function serve(file) {
  const state = readState(file);
  const { createProxy } = require('../lib/proxy.cjs');
  const { diagnosticWriter } = require('../lib/diagnostics.cjs');
  const server = createProxy({ upstream: state.upstream, capability: state.capability,
    imageRoot: path.join(path.dirname(file), 'images'),
    onDiagnostic: diagnosticWriter(path.join(path.dirname(file), 'diagnostics')) });
  const port = state.port || 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  save(file, { ...state, version: VERSION, pid: process.pid, port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}${server.guardPrefix}` });
  const close = () => server.guardClose();
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
async function launch(file, runtime) {
  const child = spawn(process.execPath, [path.join(runtime, 'scripts', 'guard.cjs'), 'serve', '--state', file], {
    detached: true, windowsHide: true, stdio: 'ignore', cwd: runtime,
  });
  let error;
  child.on('error', e => { error = e; });
  child.unref();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (error) throw new Error('Proxy process could not start.');
    await sleep(100);
    const state = readState(file);
    const info = state.baseUrl ? await health(state) : null;
    if (info && info.workerFiltering !== false) return state;
  }
  throw new Error('Proxy did not become ready.');
}
function prepareRuntime(data) {
  const root = path.resolve(__dirname, '..');
  const digest = crypto.createHash('sha256');
  const files = ['package.json', 'package-lock.json', 'lib/filter.cjs', 'lib/proxy.cjs', 'lib/identity.cjs',
    'lib/image-store.cjs', 'lib/engine.cjs', 'lib/filter-worker.cjs', 'lib/diagnostics.cjs', 'scripts/guard.cjs'];
  for (const file of files) digest.update(fs.readFileSync(path.join(root, file)));
  const runtime = path.join(data, 'runtime', digest.digest('hex').slice(0, 16));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(runtime, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(runtime, file));
  }
  // npm.cmd cannot be execFile'd on Windows without a shell. Use the npm CLI
  // with Node instead, avoiding shell interpolation of paths or environment data.
  const npmCandidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  if (process.platform === 'win32') npmCandidates.push(path.join(process.env.APPDATA || '', 'npm/node_modules/npm/bin/npm-cli.js'));
  const npm = npmCandidates.find(file => file && fs.existsSync(file));
  const result = npm
    ? spawnSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime, windowsHide: true, encoding: 'utf8' })
    : spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Runtime dependency installation failed. Run npm ci in the plugin directory and ensure npm is available.');
  return runtime;
}

async function withLock(paths, action) {
  fs.mkdirSync(paths.data, { recursive: true });
  const lock = path.join(paths.data, 'operation.lock');
  const ownerFile = path.join(lock, 'owner.json');
  const busy = () => Object.assign(new Error('Another operation is in progress or a legacy lock needs review.'), { code: 'GUARD_LOCK_BUSY' });
  try { fs.mkdirSync(lock); } catch {
    const recoveryLock = path.join(paths.data, 'operation-recovery.lock');
    try { fs.mkdirSync(recoveryLock); } catch { throw busy(); }
    try {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { throw busy(); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.nonce !== 'string') throw busy();
      try { process.kill(owner.pid, 0); throw busy(); }
      catch (error) { if (error.code !== 'ESRCH') throw busy(); }
      // Serialize stale-owner recovery so two cleaners cannot remove the new
      // owner's metadata. Ownerless legacy locks always require review.
      const current = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      if (current.nonce !== owner.nonce || current.pid !== owner.pid) throw busy();
      fs.unlinkSync(ownerFile); fs.rmdirSync(lock); fs.mkdirSync(lock);
    } finally { fs.rmdirSync(recoveryLock); }
  }
  const owner = { pid: process.pid, nonce: crypto.randomBytes(16).toString('hex') };
  try {
    fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return await action();
  } finally {
    let current;
    try { current = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { /* interrupted acquisition */ }
    if (current?.nonce === owner.nonce && current.pid === owner.pid) {
      fs.unlinkSync(ownerFile); fs.rmdirSync(lock);
    }
  }
}

async function control(command, home) {
  const paths = settings(home);
  if (command === 'status') {
    if (!fs.existsSync(paths.state)) return { installed: false, running: false };
    const state = readState(paths.state);
    const info = await health(state);
    const config = parse(fs.readFileSync(paths.config, 'utf8'));
    return { installed: true, enabled: config.openai_base_url === state.baseUrl, running: Boolean(info), ...info };
  }
  return withLock(paths, async () => {
    if (command === 'upgrade') {
      const prior = readState(paths.state);
      const original = fs.readFileSync(paths.config, 'utf8');
      const withoutRoute = detachConfig(original, prior.baseUrl);
      const runtime = prepareRuntime(paths.data);
      const running = await health(prior);
      if (prior.runtime === runtime && running?.version === VERSION && running.workerFiltering) return { upgraded: false, running: true, version: VERSION };
      const staged = path.join(paths.data, `installation-${crypto.randomBytes(8).toString('hex')}.json`);
      let next;
      try {
        save(staged, { upstream: prior.upstream, runtime, capability: crypto.randomBytes(24).toString('hex') });
        next = await launch(staged, runtime);
        if (fs.readFileSync(paths.config, 'utf8') !== original) throw new Error('Configuration changed concurrently.');
        fs.writeFileSync(path.join(paths.data, `config-before-upgrade-${Date.now()}.toml`), original, { mode: 0o600, flag: 'wx' });
        atomic(paths.config, attachConfig(withoutRoute, next.baseUrl));
        save(paths.state, { ...next, retired: [...(prior.retired || []), { baseUrl: prior.baseUrl, runtime: prior.runtime, pid: prior.pid }] });
        try { fs.unlinkSync(staged); } catch { /* promotion is already committed */ }
        // Old app processes may still use the previous route; keep that listener
        // alive. New app processes use the new runtime after restart.
        return { upgraded: true, enabled: true, running: true, version: VERSION, restartCodex: true, previousListenerRetained: true };
      } catch (error) {
        if (next) await stop(next);
        // Restore only our own route if a promotion failed; preserve user edits.
        if (next && fs.readFileSync(paths.config, 'utf8') === attachConfig(withoutRoute, next.baseUrl)) atomic(paths.config, original);
        try { fs.unlinkSync(staged); } catch { /* no staged runtime */ }
        throw error;
      }
    }
    if (command === 'disable') {
      const state = readState(paths.state);
      const original = fs.readFileSync(paths.config, 'utf8');
      const updated = detachConfig(original, state.baseUrl);
      if (fs.readFileSync(paths.config, 'utf8') !== original) throw new Error('Configuration changed concurrently.');
      atomic(paths.config, updated);
      // Existing app processes may still have this route in memory. Keep the
      // proxy alive until Codex restarts; explicit `stop` is a separate action.
      return { enabled: false, running: Boolean(await health(state)), restartCodex: true };
    }
    if (command === 'stop') {
      const state = readState(paths.state);
      const config = parse(fs.readFileSync(paths.config, 'utf8'));
      if (config.openai_base_url === state.baseUrl) throw new Error('Disable routing and restart Codex before stopping the proxy.');
      await stop(state);
      for (const retired of state.retired || []) await stop(retired);
      return { stopped: true };
    }
    if (command === 'start') {
      const state = readState(paths.state);
      const running = await health(state) || await health(await launch(paths.state, state.runtime));
      const cleanup = running ? await reapRetired(readState(paths.state), paths.state) : {};
      return { running: Boolean(running), ...running, ...cleanup };
    }
    if (command !== 'enable') throw new Error('Expected enable, upgrade, disable, start, stop, or status.');
    if (fs.existsSync(paths.state)) {
      const state = readState(paths.state);
      const config = parse(fs.readFileSync(paths.config, 'utf8'));
      if (config.openai_base_url === state.baseUrl) {
        if (!await health(state)) await launch(paths.state, state.runtime);
        return { enabled: true, running: true, restartCodex: true };
      }
    }
    const original = fs.existsSync(paths.config) ? fs.readFileSync(paths.config, 'utf8') : '';
    attachConfig(original, 'http://127.0.0.1:1'); // Validate before starting anything.
    if (process.env.OPENAI_BASE_URL || process.env.CODEX_API_ENDPOINT) throw new Error('Environment routing override found; resolve it before enabling.');
    const runtime = prepareRuntime(paths.data);
    const previousState = fs.existsSync(paths.state) ? fs.readFileSync(paths.state) : null;
    // Keep the same listener across disable/re-enable; do not strand a running
    // Codex process that still uses the prior endpoint.
    let state = previousState ? JSON.parse(previousState) : null;
    if (!state || !await health(state)) {
      state = { upstream: 'https://chatgpt.com/backend-api/codex', capability: crypto.randomBytes(24).toString('hex'), runtime };
      save(paths.state, state);
      state = await launch(paths.state, runtime);
    }
    const updated = attachConfig(original, state.baseUrl);
    try {
      if ((fs.existsSync(paths.config) ? fs.readFileSync(paths.config, 'utf8') : '') !== original) throw new Error('Configuration changed concurrently.');
      const backup = path.join(paths.data, `config-before-${Date.now()}.toml`);
      fs.writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
      atomic(paths.config, updated);
    } catch (error) {
      if (!previousState) { await stop(state); fs.unlinkSync(paths.state); }
      throw error;
    }
    return { enabled: true, running: true, restartCodex: true };
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  if (command === 'serve') return serve(option('--state'));
  const home = path.resolve(option('--codex-home') || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  console.log(JSON.stringify(await control(command, home)));
}
if (require.main === module) main().catch(error => {
  // Errors can include request headers/URLs in dependency messages. Do not dump them.
  const code = /^GUARD_[A-Z_]+$/.test(error.code || '') ? ` (${error.code})` : '';
  process.stderr.write(`Image History Guard operation failed${code}. Check routing conflicts, npm availability, and proxy status; configuration was not forcibly overwritten.\n`);
  process.exitCode = 1;
});
module.exports = { attachConfig, detachConfig, control };
