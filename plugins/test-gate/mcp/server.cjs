#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { projectState, realDirectory } = require('../scripts/test-gate-core.cjs');
const { listProjectGates, skipProjectGate } = require('../scripts/test-gate-gates.cjs');
const { resolveExecutable } = require('../scripts/spawn-command.cjs');

const SERVER_NAME = 'test-gate';
const SERVER_VERSION = '0.1.0';
const DASHBOARD_URI = 'ui://test-gate/dashboard-v1.html';
const DASHBOARD_MIME_TYPE = 'text/html;profile=mcp-app';
const dashboardPath = path.resolve(__dirname, 'test-gate.html');
const workerPath = path.resolve(__dirname, '../scripts/run-job.cjs');
const browserToken = crypto.randomBytes(24).toString('hex');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 256 * 1024;

let dashboardServer;
let dashboardServerReady;

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

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

function ensureDataDirectory() {
  const directory = dataDirectory();
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Refusing to use a symbolic-link Test Gate data directory.');
  }
  fs.mkdirSync(path.join(directory, 'jobs'), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACLs are inherited from the user profile. */ }
  return directory;
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

function projectKey(projectRoot) {
  return crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 24);
}

function projectJobsDirectory(projectRoot) {
  const directory = path.join(ensureDataDirectory(), 'jobs', projectKey(projectRoot));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function validateJobId(jobId) {
  if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/.test(jobId)) throw new Error('Invalid Test Gate job id.');
  return jobId;
}

function jobPaths(projectRoot, jobId) {
  const id = validateJobId(jobId);
  const directory = path.join(projectJobsDirectory(projectRoot), id);
  return {
    directory,
    spec: path.join(directory, 'spec.json'),
    status: path.join(directory, 'status.json'),
    stdout: path.join(directory, 'stdout.log'),
    stderr: path.join(directory, 'stderr.log'),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function publicSuite(suite) {
  let resolvedExecutable = null;
  let resolutionError = null;
  try {
    resolvedExecutable = resolveExecutable(suite.executable, { cwd: suite.cwd, env: process.env });
  } catch (error) {
    resolutionError = error.message;
  }
  return {
    id: suite.id,
    label: suite.label,
    command: [suite.executable, ...suite.args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '),
    cwd: suite.relativeCwd,
    timeoutMinutes: Math.round(suite.timeoutMs / 60_000),
    source: suite.source,
    executableAvailable: Boolean(resolvedExecutable),
    resolvedExecutable,
    resolutionError,
  };
}

function publicJob(status) {
  return {
    jobId: status.jobId,
    suiteId: status.suiteId,
    suiteLabel: status.suiteLabel,
    status: status.status,
    createdAt: status.createdAt,
    startedAt: status.startedAt || null,
    finishedAt: status.finishedAt || null,
    exitCode: status.exitCode ?? null,
    signal: status.signal || null,
    error: status.error || null,
  };
}

function listJobs(projectRoot) {
  const directory = projectJobsDirectory(projectRoot);
  const jobs = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^[0-9a-f-]{36}$/.test(item.name)) continue;
    const statusPath = path.join(directory, item.name, 'status.json');
    try { jobs.push(publicJob(readJson(statusPath))); } catch { /* Ignore incomplete/corrupt job entries. */ }
  }
  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50);
}

function stateForProject(projectPath) {
  const state = projectState(projectPath);
  return {
    projectRoot: state.projectRoot,
    configPath: state.configPath,
    configExists: state.configExists,
    suites: state.suites.map(publicSuite),
    jobs: listJobs(state.projectRoot),
    gates: listProjectGates(state.projectRoot),
  };
}

function startSuite(value) {
  const state = projectState(value?.projectPath);
  const suite = state.suites.find((candidate) => candidate.id === value?.suiteId);
  if (!suite) throw new Error(`Unknown Test Gate suite: ${value?.suiteId || '(missing)'}.`);
  resolveExecutable(suite.executable, { cwd: suite.cwd, env: process.env });
  const jobId = crypto.randomUUID();
  const paths = jobPaths(state.projectRoot, jobId);
  fs.mkdirSync(paths.directory, { recursive: false, mode: 0o700 });
  fs.writeFileSync(paths.stdout, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.writeFileSync(paths.stderr, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const createdAt = new Date().toISOString();
  atomicWrite(paths.spec, {
    jobId,
    projectRoot: state.projectRoot,
    suiteId: suite.id,
    suiteLabel: suite.label,
    executable: suite.executable,
    args: suite.args,
    cwd: suite.cwd,
    timeoutMs: suite.timeoutMs,
  });
  atomicWrite(paths.status, {
    jobId,
    projectRoot: state.projectRoot,
    suiteId: suite.id,
    suiteLabel: suite.label,
    status: 'queued',
    createdAt,
    startedAt: null,
    finishedAt: null,
    workerPid: null,
    processPid: null,
    exitCode: null,
    signal: null,
    error: null,
  });
  const worker = spawn(process.execPath, [workerPath, paths.status], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, TEST_GATE_DATA_DIR: dataDirectory() },
  });
  worker.unref();
  return publicJob(readJson(paths.status));
}

function cancelJob(value) {
  const projectRoot = projectState(value?.projectPath).projectRoot;
  const paths = jobPaths(projectRoot, value?.jobId);
  if (!fs.existsSync(paths.status)) throw new Error('Test Gate job does not exist.');
  const status = readJson(paths.status);
  if (['passed', 'failed', 'cancelled', 'timed-out'].includes(status.status)) return publicJob(status);
  atomicWrite(paths.status, { ...status, cancelRequestedAt: new Date().toISOString() });
  if (Number.isInteger(status.processPid)) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(status.processPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-status.processPid, 'SIGTERM'); } catch { /* Worker also polls cancellation. */ }
    }
  }
  return publicJob(readJson(paths.status));
}

function readTail(filePath, maxBytes = MAX_LOG_BYTES) {
  if (!fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const handle = fs.openSync(filePath, 'r');
  try { fs.readSync(handle, buffer, 0, length, start); } finally { fs.closeSync(handle); }
  const text = buffer.toString('utf8');
  return start > 0 ? `[earlier output omitted]\n${text}` : text;
}

function readJobLog(value) {
  const projectRoot = projectState(value?.projectPath).projectRoot;
  const paths = jobPaths(projectRoot, value?.jobId);
  if (!fs.existsSync(paths.status)) throw new Error('Test Gate job does not exist.');
  return {
    job: publicJob(readJson(paths.status)),
    stdout: readTail(paths.stdout),
    stderr: readTail(paths.stderr),
  };
}

function jobSummary(value) {
  const result = readJobLog(value);
  const job = result.job;
  const durationStart = job.startedAt ? new Date(job.startedAt).getTime() : new Date(job.createdAt).getTime();
  const durationEnd = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
  const durationSeconds = Math.max(0, Math.round((durationEnd - durationStart) / 1000));
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  const tail = output.length > 12_000 ? `[output tail]\n${output.slice(-12_000)}` : output;
  return {
    ...job,
    durationSeconds,
    summary: `${job.suiteLabel}: ${job.status}${job.exitCode === null ? '' : ` (exit ${job.exitCode})`} after ${durationSeconds}s`,
    outputTail: tail,
  };
}

function validateProjectArgument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object.');
  return realDirectory(value.projectPath);
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds 64 KiB.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Request body must be valid JSON.')); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, body) {
  const content = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(content);
}

async function callTool(name, args) {
  switch (name) {
    case 'open_test_gate': return openDashboard(args || {});
    case 'get_test_gate_state': {
      validateProjectArgument(args);
      const state = stateForProject(args.projectPath);
      return { content: [{ type: 'text', text: `Test Gate found ${state.suites.length} suite(s).` }], structuredContent: state };
    }
    case 'start_test_suite': {
      validateProjectArgument(args);
      const job = startSuite(args);
      return { content: [{ type: 'text', text: `Started ${job.suiteLabel} as Test Gate job ${job.jobId}.` }], structuredContent: { job } };
    }
    case 'cancel_test_job': {
      validateProjectArgument(args);
      const job = cancelJob(args);
      return { content: [{ type: 'text', text: `Cancellation requested for ${job.suiteLabel}.` }], structuredContent: { job } };
    }
    case 'skip_test_gate': {
      validateProjectArgument(args);
      if (args.confirmSkip !== true) throw new Error('Skipping a completion gate requires confirmSkip: true.');
      const projectRoot = projectState(args.projectPath).projectRoot;
      const gate = skipProjectGate(projectRoot, args.gateId);
      return { content: [{ type: 'text', text: 'The pending validation gate was explicitly skipped.' }], structuredContent: { gate } };
    }
    case 'read_test_job_log': {
      validateProjectArgument(args);
      const result = readJobLog(args);
      return { content: [{ type: 'text', text: `Loaded local logs for ${result.job.suiteLabel}.` }], structuredContent: result };
    }
    case 'get_test_job_summary': {
      validateProjectArgument(args);
      const result = jobSummary(args);
      return { content: [{ type: 'text', text: `${result.summary}\n\n${result.outputTail}` }], structuredContent: result };
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleDashboardRequest(request, response) {
  const basePath = `/${browserToken}/`;
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  const address = dashboardServer.address();
  const expectedHost = `127.0.0.1:${address.port}`;
  const expectedOrigin = `http://${expectedHost}`;
  if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== expectedOrigin)) {
    sendJson(response, 403, { error: 'Loopback dashboard origin rejected.' });
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === basePath) {
    const content = Buffer.from(fs.readFileSync(dashboardPath, 'utf8'));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(content);
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname.startsWith(`${basePath}tool/`)) {
    const name = requestUrl.pathname.slice(`${basePath}tool/`.length);
    try {
      const args = await readRequestJson(request);
      const result = await callTool(name, args);
      sendJson(response, result.isError ? 400 : 200, result);
    } catch (error) {
      sendJson(response, 400, { content: [{ type: 'text', text: error.message }], isError: true });
    }
    return;
  }
  sendJson(response, 404, { error: 'Not found.' });
}

function ensureDashboardServer() {
  if (dashboardServerReady) return dashboardServerReady;
  dashboardServer = http.createServer((request, response) => {
    handleDashboardRequest(request, response).catch((error) => sendJson(response, 500, { error: error.message }));
  });
  dashboardServerReady = new Promise((resolve, reject) => {
    dashboardServer.once('error', reject);
    dashboardServer.listen(0, '127.0.0.1', () => {
      dashboardServer.removeListener('error', reject);
      resolve(`http://127.0.0.1:${dashboardServer.address().port}/${browserToken}/`);
    });
  });
  return dashboardServerReady;
}

function openInSystemBrowser(url) {
  if (process.env.TEST_GATE_SKIP_BROWSER_OPEN === '1') return Promise.resolve(false);
  let launcher;
  if (process.platform === 'win32') {
    const edgeCandidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
      .filter(Boolean)
      .map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
    launcher = edgePath ? { command: edgePath, args: [`--app=${url}`, '--new-window', '--no-first-run'] } : { command: 'explorer.exe', args: [url] };
  } else {
    launcher = process.platform === 'darwin' ? { command: 'open', args: [url] } : { command: 'xdg-open', args: [url] };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, launcher.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => reject(new Error(`Could not open Test Gate: ${error.message}`)));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}

async function openDashboard(value) {
  validateProjectArgument(value);
  const state = stateForProject(value.projectPath);
  const baseUrl = await ensureDashboardServer();
  const dashboardUrl = `${baseUrl}?projectPath=${encodeURIComponent(state.projectRoot)}`;
  const browserOpened = await openInSystemBrowser(dashboardUrl);
  return {
    content: [{
      type: 'text',
      text: `Test Gate is ready for ${state.projectRoot}. ${state.suites.length} non-interactive suite(s) can be run outside the Codex turn. Do not poll their status from the model.`,
    }],
    structuredContent: { projectRoot: state.projectRoot, suiteCount: state.suites.length, browserOpened },
    _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/outputTemplate': DASHBOARD_URI, dashboardUrl },
  };
}

const projectPathProperty = {
  type: 'string',
  title: 'Project path',
  description: 'Absolute local path of the project whose non-interactive tests should be managed.',
  minLength: 1,
  maxLength: 2048,
};

const tools = [
  {
    name: 'open_test_gate',
    title: 'Open Test Gate',
    description: 'Open the local Test Gate panel. Set createCompletionGate true only when implementation work is complete and non-interactive validation is now required before a new task begins; leave it false for ordinary panel inspection or when a gate already exists. This does not run a test and must not be followed by model polling.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
        createCompletionGate: {
          type: 'boolean',
          title: 'Create completion gate',
          description: 'Require discovered suites to pass or be explicitly skipped before the next ordinary prompt reaches the model.',
          default: false,
        },
      },
      required: ['projectPath', 'createCompletionGate'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { projectRoot: { type: 'string' }, suiteCount: { type: 'integer' }, browserOpened: { type: 'boolean' } },
      required: ['projectRoot', 'suiteCount', 'browserOpened'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: DASHBOARD_URI }, 'openai/outputTemplate': DASHBOARD_URI },
  },
  {
    name: 'get_test_gate_state',
    title: 'Refresh Test Gate',
    description: 'UI-only state refresh for suites and local test jobs.',
    inputSchema: { type: 'object', properties: { projectPath: projectPathProperty }, required: ['projectPath'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
  },
  {
    name: 'start_test_suite',
    title: 'Run test suite',
    description: 'UI-only action that starts one configured non-interactive test suite in a detached local worker.',
    inputSchema: {
      type: 'object',
      properties: { projectPath: projectPathProperty, suiteId: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['projectPath', 'suiteId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
  },
  {
    name: 'cancel_test_job',
    title: 'Cancel test job',
    description: 'UI-only action that stops one Test Gate process tree.',
    inputSchema: {
      type: 'object',
      properties: { projectPath: projectPathProperty, jobId: { type: 'string', minLength: 36, maxLength: 36 } },
      required: ['projectPath', 'jobId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
  },
  {
    name: 'read_test_job_log',
    title: 'Read test log',
    description: 'UI-only action that reads a bounded tail of a local Test Gate job log.',
    inputSchema: {
      type: 'object',
      properties: { projectPath: projectPathProperty, jobId: { type: 'string', minLength: 36, maxLength: 36 } },
      required: ['projectPath', 'jobId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
  },
  {
    name: 'skip_test_gate',
    title: 'Skip pending validation',
    description: 'UI-only action that explicitly resolves one pending completion gate as skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
        gateId: { type: 'string', minLength: 36, maxLength: 36 },
        confirmSkip: { type: 'boolean' }
      },
      required: ['projectPath', 'gateId', 'confirmSkip'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
  },
  {
    name: 'get_test_job_summary',
    title: 'Bring completed test result into Codex',
    description: 'Read one completed Test Gate result only after the user explicitly asks Codex to analyze that job. Never call this repeatedly or use it to poll a running job.',
    inputSchema: {
      type: 'object',
      properties: { projectPath: projectPathProperty, jobId: { type: 'string', minLength: 36, maxLength: 36 } },
      required: ['projectPath', 'jobId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(message) {
  switch (message.method) {
    case 'initialize':
      sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: SERVER_NAME, title: 'Test Gate', version: SERVER_VERSION },
        instructions: 'Never run or poll non-interactive automated tests from a Codex turn. Keep interactive browser, Computer Use, screenshot, and UI verification available. Use open_test_gate once to hand deferred suites to the user. Only use get_test_job_summary after the user explicitly asks to analyze a completed job.',
      });
      return;
    case 'ping': sendResult(message.id, {}); return;
    case 'tools/list': sendResult(message.id, { tools }); return;
    case 'resources/list':
      sendResult(message.id, { resources: [{ uri: DASHBOARD_URI, name: 'Test Gate dashboard', title: 'Test Gate', description: 'Run non-interactive tests without keeping Codex active.', mimeType: DASHBOARD_MIME_TYPE }] });
      return;
    case 'resources/read':
      if (message.params?.uri !== DASHBOARD_URI) { sendError(message.id, -32602, `Unknown resource URI: ${message.params?.uri}`); return; }
      sendResult(message.id, { contents: [{ uri: DASHBOARD_URI, mimeType: DASHBOARD_MIME_TYPE, text: fs.readFileSync(dashboardPath, 'utf8'), _meta: { ui: { prefersBorder: true } } }] });
      return;
    case 'tools/call':
      try { sendResult(message.id, await callTool(message.params?.name, message.params?.arguments || {})); }
      catch (error) { sendResult(message.id, { content: [{ type: 'text', text: error.message }], isError: true }); }
      return;
    default: sendError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (message && Object.hasOwn(message, 'id')) sendError(message.id, -32600, 'Invalid Request');
      return;
    }
    if (Object.hasOwn(message, 'id')) handleRequest(message).catch((error) => sendError(message.id, -32603, error.message));
  } catch {
    sendError(null, -32700, 'Parse error');
  }
});
input.on('close', () => {
  if (dashboardServer) dashboardServer.close();
});
