'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectState } = require('./test-gate-core.cjs');

function dataDirectory() {
  const overridden = process.env.TEST_GATE_DATA_DIR || process.env.PLUGIN_DATA;
  if (overridden) {
    if (!path.isAbsolute(overridden)) throw new Error('Test Gate data directory must be absolute.');
    return path.resolve(overridden);
  }
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA || !path.isAbsolute(process.env.LOCALAPPDATA)) {
      throw new Error('LOCALAPPDATA must identify an absolute directory.');
    }
    return path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'test-gate');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'OpenAI', 'Codex', 'test-gate');
  }
  const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(stateRoot)) throw new Error('XDG_STATE_HOME must be absolute when set.');
  return path.join(stateRoot, 'openai-codex', 'test-gate');
}

function ensureDirectory(directory) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Refusing to use a symbolic-link Test Gate directory.');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function atomicWrite(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

function projectKey(projectRoot) {
  return crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 24);
}

function sessionKey(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Test Gate requires a session id.');
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

function gatesDirectory() {
  return ensureDirectory(path.join(dataDirectory(), 'gates'));
}

function gatePathForSession(sessionId) {
  return path.join(gatesDirectory(), `${sessionKey(sessionId)}.json`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchingSuiteIds(command, suites) {
  const normalized = normalizeCommand(command);
  const matches = [];
  for (const suite of suites) {
    const rendered = normalizeCommand([suite.executable, ...suite.args].join(' '));
    const executableName = path.basename(suite.executable).replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase();
    const firstArgument = normalizeCommand(suite.args[0] || '');
    const scriptPattern = new RegExp(`(?:^|[;&|]\\s*|\\s)(?:npm|pnpm|yarn|bun)(?:\\.cmd|\\.exe)?\\s+(?:(?:run|run-script)\\s+)?${escapeRegex(suite.label)}(?:\\s|$)`, 'i');
    const directPattern = firstArgument
      ? new RegExp(`(?:^|[;&|]\\s*|\\s)${escapeRegex(executableName)}(?:\\.cmd|\\.exe)?\\s+${escapeRegex(firstArgument)}(?:\\s|$)`, 'i')
      : null;
    if (normalized.includes(rendered) || scriptPattern.test(command) || directPattern?.test(command)) matches.push(suite.id);
  }
  return matches;
}

function publicGate(gate, evaluation) {
  return {
    gateId: gate.gateId,
    projectRoot: gate.projectRoot,
    createdAt: gate.createdAt,
    updatedAt: gate.updatedAt,
    status: evaluation.status,
    requiredSuiteIds: [...gate.requiredSuiteIds],
    blockedKinds: [...gate.blockedKinds],
    resolution: gate.resolution || null,
    jobs: evaluation.jobs,
  };
}

function readSessionGate(sessionId) {
  const filePath = gatePathForSession(sessionId);
  if (!fs.existsSync(filePath)) return null;
  const gate = readJson(filePath);
  if (!gate || gate.version !== 1 || gate.sessionKey !== sessionKey(sessionId)) return null;
  return gate;
}

function recordPendingGate({ sessionId, cwd, turnId, command, kind }) {
  const state = projectState(cwd);
  const filePath = gatePathForSession(sessionId);
  const now = new Date().toISOString();
  let gate = null;
  if (fs.existsSync(filePath)) {
    try { gate = readJson(filePath); } catch { /* Replace an invalid gate file. */ }
  }
  if (!gate || gate.version !== 1 || gate.projectRoot !== state.projectRoot || gate.resolution) {
    gate = {
      version: 1,
      gateId: crypto.randomUUID(),
      sessionKey: sessionKey(sessionId),
      projectRoot: state.projectRoot,
      createdAt: now,
      updatedAt: now,
      createdTurnId: typeof turnId === 'string' ? turnId : null,
      requiredSuiteIds: [],
      blockedKinds: [],
      resolution: null,
    };
  }
  gate.updatedAt = now;
  gate.requiredSuiteIds = [...new Set([...gate.requiredSuiteIds, ...matchingSuiteIds(command, state.suites)])];
  gate.blockedKinds = [...new Set([...gate.blockedKinds, kind || 'non-interactive test'])];
  atomicWrite(filePath, gate);
  return gate;
}

function recordCompletionGate({ sessionId, projectPath, turnId, kind = 'deferred non-interactive validation' }) {
  const state = projectState(projectPath);
  const filePath = gatePathForSession(sessionId);
  const now = new Date().toISOString();
  let gate = null;
  if (fs.existsSync(filePath)) {
    try { gate = readJson(filePath); } catch { /* Replace an invalid gate file. */ }
  }
  if (!gate || gate.version !== 1 || gate.projectRoot !== state.projectRoot || gate.resolution) {
    gate = {
      version: 1,
      gateId: crypto.randomUUID(),
      sessionKey: sessionKey(sessionId),
      projectRoot: state.projectRoot,
      createdAt: now,
      updatedAt: now,
      createdTurnId: typeof turnId === 'string' ? turnId : null,
      requiredSuiteIds: state.suites.map((suite) => suite.id),
      blockedKinds: [kind],
      resolution: null,
    };
  } else {
    gate.updatedAt = now;
    if (!gate.requiredSuiteIds.length) gate.requiredSuiteIds = state.suites.map((suite) => suite.id);
    gate.blockedKinds = [...new Set([...gate.blockedKinds, kind])];
  }
  atomicWrite(filePath, gate);
  return gate;
}

function jobsForProject(projectRoot) {
  const directory = path.join(dataDirectory(), 'jobs', projectKey(projectRoot));
  if (!fs.existsSync(directory)) return [];
  const jobs = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^[0-9a-f-]{36}$/.test(item.name)) continue;
    try {
      const status = readJson(path.join(directory, item.name, 'status.json'));
      jobs.push({
        jobId: status.jobId,
        suiteId: status.suiteId,
        suiteLabel: status.suiteLabel,
        status: status.status,
        createdAt: status.createdAt,
        startedAt: status.startedAt || null,
        finishedAt: status.finishedAt || null,
        exitCode: status.exitCode ?? null,
      });
    } catch { /* Ignore incomplete/corrupt jobs. */ }
  }
  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function evaluateGate(gate) {
  if (gate.resolution?.status === 'skipped') return { status: 'skipped', jobs: [] };
  if (gate.resolution?.status === 'passed') return { status: 'passed', jobs: gate.resolution.jobs || [] };
  const jobs = jobsForProject(gate.projectRoot).filter((job) => job.createdAt >= gate.createdAt);
  if (!jobs.length) return { status: 'pending', jobs: [] };
  const relevant = [];
  if (gate.requiredSuiteIds.length) {
    for (const suiteId of gate.requiredSuiteIds) {
      const latest = jobs.find((job) => job.suiteId === suiteId);
      if (!latest) return { status: 'pending', jobs: relevant };
      relevant.push(latest);
    }
  } else {
    relevant.push(jobs[0]);
  }
  if (relevant.some((job) => job.status === 'queued' || job.status === 'running')) return { status: 'running', jobs: relevant };
  if (relevant.every((job) => job.status === 'passed')) return { status: 'passed', jobs: relevant };
  return { status: 'failed', jobs: relevant };
}

function persistPassedGate(sessionId, gate, evaluation) {
  if (evaluation.status !== 'passed' || gate.resolution) return gate;
  const resolved = {
    ...gate,
    updatedAt: new Date().toISOString(),
    resolution: { status: 'passed', at: new Date().toISOString(), jobs: evaluation.jobs },
  };
  atomicWrite(gatePathForSession(sessionId), resolved);
  return resolved;
}

function skipSessionGate(sessionId) {
  const gate = readSessionGate(sessionId);
  if (!gate) return null;
  const skipped = {
    ...gate,
    updatedAt: new Date().toISOString(),
    resolution: { status: 'skipped', at: new Date().toISOString(), explicitlyConfirmed: true },
  };
  atomicWrite(gatePathForSession(sessionId), skipped);
  return skipped;
}

function listProjectGates(projectRoot) {
  const directory = gatesDirectory();
  const result = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!item.isFile() || !/^[0-9a-f]{32}\.json$/.test(item.name)) continue;
    try {
      const gate = readJson(path.join(directory, item.name));
      if (gate.projectRoot !== projectRoot) continue;
      const evaluation = evaluateGate(gate);
      result.push(publicGate(gate, evaluation));
    } catch { /* Ignore invalid gate files in dashboard listings. */ }
  }
  return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 20);
}

function skipProjectGate(projectRoot, gateId) {
  if (typeof gateId !== 'string' || !/^[0-9a-f-]{36}$/.test(gateId)) throw new Error('Invalid Test Gate gate id.');
  const directory = gatesDirectory();
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith('.json')) continue;
    const filePath = path.join(directory, item.name);
    let gate;
    try { gate = readJson(filePath); } catch { continue; }
    if (gate.projectRoot !== projectRoot || gate.gateId !== gateId) continue;
    const skipped = {
      ...gate,
      updatedAt: new Date().toISOString(),
      resolution: { status: 'skipped', at: new Date().toISOString(), explicitlyConfirmed: true },
    };
    atomicWrite(filePath, skipped);
    return publicGate(skipped, { status: 'skipped', jobs: [] });
  }
  throw new Error('Test Gate completion gate does not exist.');
}

function unresolvedSuiteIds(gate) {
  const state = projectState(gate.projectRoot);
  const ids = gate.requiredSuiteIds.length ? gate.requiredSuiteIds : state.suites.map((suite) => suite.id);
  const jobs = jobsForProject(gate.projectRoot).filter((job) => job.createdAt >= gate.createdAt);
  return ids.filter((suiteId) => {
    const latest = jobs.find((job) => job.suiteId === suiteId);
    return !latest || !['queued', 'running', 'passed'].includes(latest.status);
  });
}

module.exports = {
  dataDirectory,
  evaluateGate,
  jobsForProject,
  listProjectGates,
  persistPassedGate,
  publicGate,
  readSessionGate,
  recordCompletionGate,
  recordPendingGate,
  skipProjectGate,
  skipSessionGate,
  unresolvedSuiteIds,
};
