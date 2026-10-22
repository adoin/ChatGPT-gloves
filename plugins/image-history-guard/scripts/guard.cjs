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
const VERSION = require('../package.json').version;
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
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function failure(code) { return Object.assign(new Error(code), { code }); }
async function stopAndWait(state) {
  const info = await health(state);
  const pid = info?.pid || state.pid;
  if (info) await stop(state);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!alive(pid) && !await health(state)) return;
    await sleep(100);
  }
  // A saved PID is only a reason to refuse replacement, never authority to kill.
  throw failure('GUARD_STOP_TIMEOUT');
}
async function stopAll(state) {
  for (const old of state.retired || []) if (old.baseUrl !== state.baseUrl) await stopAndWait(old);
  await stopAndWait(state);
}
async function serve(file) {
  return withLock({ data: path.join(path.dirname(file), 'service') }, async () => {
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
  await new Promise(resolve => server.once('close', resolve));
  await server.guardClose();
  });
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
    if (info && info.pid === child.pid && info.workerFiltering !== false) return state;
    if (child.exitCode !== null) throw failure('GUARD_START_FAILED');
  }
  throw new Error('Proxy did not become ready.');
}
function prepareRuntime(data) {
  const root = path.resolve(__dirname, '..');
  const digest = crypto.createHash('sha256');
  const files = ['package.json', 'npm-shrinkwrap.json', 'lib/filter.cjs', 'lib/proxy.cjs', 'lib/identity.cjs',
    'lib/image-store.cjs', 'lib/engine.cjs', 'lib/filter-worker.cjs', 'lib/diagnostics.cjs', 'scripts/guard.cjs'];
  for (const file of files) digest.update(fs.readFileSync(path.join(root, file)));
  const runtime = path.join(data, 'runtime', digest.digest('hex').slice(0, 16));
  if (fs.existsSync(path.join(runtime, '.ready'))) return runtime;
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(runtime, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(runtime, file));
  }
  // npm.cmd cannot be execFile'd on Windows without a shell. Use the npm CLI
  // with Node instead, avoiding shell interpolation of paths or environment data.
  const [executable, prefix] = npmCommand();
  const result = spawnSync(executable, [...prefix, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Runtime dependency installation failed. Run npm ci in the plugin directory and ensure npm is available.');
  fs.writeFileSync(path.join(runtime, '.ready'), VERSION);
  return runtime;
}
function npmCommand() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  if (process.platform === 'win32') candidates.push(path.join(process.env.APPDATA || '', 'npm/node_modules/npm/bin/npm-cli.js'));
  const npm = candidates.find(file => file && fs.existsSync(file));
  return npm ? [process.execPath, [npm]] : ['npm', []];
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

async function control(command, home, { confirm = async () => true, hook = false } = {}) {
  const paths = settings(home);
  if (command === 'status') {
    if (!fs.existsSync(paths.state)) return { installed: false, running: false };
    const state = readState(paths.state);
    const info = await health(state);
    const config = parse(fs.readFileSync(paths.config, 'utf8'));
    return { installed: true, cliVersion: VERSION, installedVersion: state.version,
      manuallyStopped: Boolean(state.manuallyStopped), retiredRecords: (state.retired || []).length,
      transitionPending: fs.existsSync(path.join(paths.data, 'transition.json')),
      enabled: config.openai_base_url === state.baseUrl, running: Boolean(info), ...info };
  }
  return withLock(paths, async () => {
    const journal = path.join(paths.data, 'transition.json');
    // An interrupted replacement always recovers its saved version first.
    // A failed recovery keeps the journal for the next explicit repair attempt.
    if (fs.existsSync(journal)) {
      const transaction = readState(journal);
      await stopAll(readState(paths.state));
      save(paths.state, transaction.prior);
      if (transaction.wasRunning) await launch(paths.state, transaction.prior.runtime);
      fs.unlinkSync(journal);
    }
    if (command === 'upgrade' || command === 'restart') {
      const prior = readState(paths.state);
      const original = fs.readFileSync(paths.config, 'utf8');
      const config = parse(original);
      if (config.openai_base_url === prior.baseUrl) detachConfig(original, prior.baseUrl);
      else if (config.openai_base_url) throw failure('GUARD_ROUTING_CONFLICT');
      const runtime = command === 'upgrade' ? prepareRuntime(paths.data) : prior.runtime;
      const running = await health(prior);
      if (command === 'upgrade' && prior.runtime === runtime && running?.version === VERSION && running.workerFiltering && !(prior.retired || []).length)
        return { upgraded: false, running: true, version: VERSION };
      if (!await confirm(command)) return { cancelled: true, running: Boolean(running), version: running?.version || prior.version };
      if (fs.readFileSync(paths.config, 'utf8') !== original) throw failure('GUARD_CONFIG_CHANGED');
      save(journal, { prior, wasRunning: Boolean(running) });
      try {
        await stopAll(prior);
        save(paths.state, { ...prior, runtime, pid: null, retired: [], manuallyStopped: false });
        const next = await launch(paths.state, runtime);
        fs.unlinkSync(journal);
        return { [command === 'upgrade' ? 'upgraded' : 'restarted']: true, running: true,
          version: next.version, addressPreserved: next.baseUrl === prior.baseUrl, retiredRecords: 0 };
      } catch (error) {
        await stopAll(readState(paths.state));
        save(paths.state, prior);
        if (running) await launch(paths.state, prior.runtime);
        fs.unlinkSync(journal);
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
      if (!await confirm(command)) return { cancelled: true };
      save(paths.state, { ...state, manuallyStopped: true });
      await stopAll(state);
      save(paths.state, { ...state, pid: null, retired: [], manuallyStopped: true });
      return { stopped: true };
    }
    if (command === 'start') {
      const state = readState(paths.state);
      const config = parse(fs.readFileSync(paths.config, 'utf8'));
      if (hook && (state.manuallyStopped || config.openai_base_url !== state.baseUrl))
        return { skipped: true, manuallyStopped: Boolean(state.manuallyStopped) };
      if ((state.retired || []).length) throw failure('GUARD_UPGRADE_REQUIRED');
      if (state.manuallyStopped) save(paths.state, { ...state, manuallyStopped: false });
      let running = await health(state);
      if (!running) {
        if (alive(state.pid)) throw failure('GUARD_EXISTING_PROCESS_UNHEALTHY');
        running = await health(await launch(paths.state, state.runtime));
      }
      return { running: Boolean(running), cliVersion: VERSION, ...running };
    }
    if (command !== 'enable') throw failure('GUARD_UNKNOWN_COMMAND');
    if (fs.existsSync(paths.state)) {
      const state = readState(paths.state);
      const config = parse(fs.readFileSync(paths.config, 'utf8'));
      if (config.openai_base_url === state.baseUrl) {
        if ((state.retired || []).length) throw failure('GUARD_UPGRADE_REQUIRED');
        if (state.manuallyStopped) save(paths.state, { ...state, manuallyStopped: false });
        if (!await health(state)) {
          if (alive(state.pid)) throw failure('GUARD_EXISTING_PROCESS_UNHEALTHY');
          save(paths.state, { ...state, manuallyStopped: false });
          await launch(paths.state, state.runtime);
        }
        return { enabled: true, running: true, restartCodex: true };
      }
    }
    const original = fs.existsSync(paths.config) ? fs.readFileSync(paths.config, 'utf8') : '';
    attachConfig(original, 'http://127.0.0.1:1'); // Validate before starting anything.
    if (process.env.OPENAI_BASE_URL || process.env.CODEX_API_ENDPOINT) throw new Error('Environment routing override found; resolve it before enabling.');
    const previousState = fs.existsSync(paths.state) ? fs.readFileSync(paths.state) : null;
    // Keep the same listener across disable/re-enable; do not strand a running
    // Codex process that still uses the prior endpoint.
    let state = previousState ? JSON.parse(previousState) : null;
    if ((state?.retired || []).length) throw failure('GUARD_UPGRADE_REQUIRED');
    if (!state || !await health(state)) {
      if (state && alive(state.pid)) throw failure('GUARD_EXISTING_PROCESS_UNHEALTHY');
      state = state ? { ...state, manuallyStopped: false } : {
        upstream: 'https://chatgpt.com/backend-api/codex', capability: crypto.randomBytes(24).toString('hex'), runtime: prepareRuntime(paths.data) };
      save(paths.state, state);
      state = await launch(paths.state, state.runtime);
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
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(`Image History Guard ${VERSION}
Usage: image-history-guard <command> [--codex-home DIR] [--yes]
  enable    Enable Codex routing and start an isolated local service
  status    Report CLI, installed and running versions (JSON)
  start     Start/reuse the selected runtime; no implicit upgrade
  stop      Stop the service; startup hooks respect this until start
  restart   Confirm, stop completely, restart the selected version
  upgrade   Prepare the latest npm release, confirm, replace the service
  disable   Remove managed routing; restart Codex to use its default route
Options: --yes (authorize interruption); --local (upgrade to this CLI version)
Use npm install -g image-history-guard, or npx image-history-guard@latest.
Active requests can be interrupted by stop/restart/upgrade.`);
    return;
  }
  if (command === '--version' || command === '-v') { console.log(VERSION); return; }
  if (!['enable', 'status', 'start', 'stop', 'restart', 'upgrade', 'disable', 'serve'].includes(command))
    throw failure('GUARD_UNKNOWN_COMMAND');
  for (let index = 0; index < args.length; index++) {
    if (['--codex-home', '--state'].includes(args[index])) {
      if (!args[++index] || args[index].startsWith('--')) throw failure('GUARD_INVALID_ARGUMENT');
    } else if (!['--yes', '--local', '--hook'].includes(args[index])) throw failure('GUARD_INVALID_ARGUMENT');
  }
  const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  if (command === 'serve') return serve(option('--state'));
  if (command === 'upgrade' && !args.includes('--local')) {
    const [executable, prefix] = npmCommand();
    const child = spawn(executable, [...prefix, 'exec', '--yes', '--ignore-scripts', '--package=image-history-guard@latest', '--',
      'image-history-guard', 'upgrade', '--local', ...args], { stdio: 'inherit', windowsHide: true });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    process.exitCode = code ?? 1;
    return;
  }
  const home = path.resolve(option('--codex-home') || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const confirm = async action => {
    if (args.includes('--yes')) return true;
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw failure('GUARD_CONFIRMATION_REQUIRED');
    const readline = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await readline.question(`${action}: stop existing services and interrupt active requests? [y/N] `);
      return /^(y|yes)$/i.test(answer.trim());
    } finally { readline.close(); }
  };
  console.log(JSON.stringify(await control(command, home, { confirm, hook: args.includes('--hook') })));
}
if (require.main === module) main().catch(error => {
  // Errors can include request headers/URLs in dependency messages. Do not dump them.
  const code = /^GUARD_[A-Z_]+$/.test(error.code || '') ? ` (${error.code})` : '';
  const advice = {
    GUARD_CONFIRMATION_REQUIRED: 'Run in an interactive PowerShell terminal, or pass --yes to authorize interruption.',
    GUARD_UPGRADE_REQUIRED: 'Legacy listener records exist. Run image-history-guard upgrade to migrate them with confirmation.',
    GUARD_STOP_TIMEOUT: 'A previous process has not exited. Replacement was refused; inspect status before retrying.',
    GUARD_EXISTING_PROCESS_UNHEALTHY: 'The existing process is not healthy. Run restart to replace it with confirmation.',
  };
  process.stderr.write(`Image History Guard operation failed${code}. ${advice[error.code] || 'Check routing conflicts, npm availability, and proxy status; configuration was not forcibly overwritten.'}\n`);
  process.exitCode = 1;
});
module.exports = { attachConfig, detachConfig, control };
