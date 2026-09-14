#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const SERVER_NAME = 'local-ssh-deploy';
const SERVER_VERSION = '0.1.0';
const profileEditorPath = path.resolve(__dirname, 'profile-editor.html');
const pickerScript = path.resolve(__dirname, '../scripts/pick-identity-file.ps1');
const PROFILE_EDITOR_URI = 'ui://local-ssh-deploy/connection-editor-v2.html';
const PROFILE_EDITOR_MIME_TYPE = 'text/html;profile=mcp-app';
const editorSessionToken = crypto.randomBytes(24).toString('hex');

let editorHttpServer;
let editorServerReady;

function platformDetails() {
  if (process.platform === 'win32') {
    return { platform: 'windows', sshExecutable: 'ssh.exe' };
  }
  if (process.platform === 'darwin') {
    return { platform: 'macos', sshExecutable: 'ssh' };
  }
  if (process.platform === 'linux') {
    return { platform: 'linux', sshExecutable: 'ssh' };
  }
  return { platform: process.platform, sshExecutable: 'ssh' };
}

function storeInfo() {
  let directory;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData || !path.isAbsolute(localAppData)) {
      throw new Error('LOCALAPPDATA must identify an absolute user-level directory.');
    }
    directory = path.join(localAppData, 'OpenAI', 'Codex', 'local-ssh-deploy');
  } else if (process.platform === 'darwin') {
    directory = path.join(os.homedir(), 'Library', 'Application Support', 'OpenAI', 'Codex', 'local-ssh-deploy');
  } else {
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    if (!path.isAbsolute(configRoot)) {
      throw new Error('XDG_CONFIG_HOME must be an absolute directory when set.');
    }
    directory = path.join(configRoot, 'openai-codex', 'local-ssh-deploy');
  }
  return {
    directory,
    file: path.join(directory, 'connections.json'),
    sshConfigFile: path.join(directory, 'ssh_config'),
  };
}

function assertNoControlCharacters(name, value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }
}

function assertConnectionName(connectionName) {
  const characterCount = typeof connectionName === 'string' ? Array.from(connectionName).length : 0;
  const validCharacters = typeof connectionName === 'string'
    && /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N} ._-]*[\p{L}\p{M}\p{N}])?$/u.test(connectionName);
  if (characterCount < 1 || characterCount > 64 || !validCharacters) {
    throw new Error('连接名称须为 1–64 个字符，支持中文、其他语言文字、数字、空格、点、下划线和连字符；不能以空格或标点开头或结尾。');
  }
}

function assertHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
    throw new Error('host must be a non-empty DNS name, IPv4 address, or IPv6 address.');
  }
  assertNoControlCharacters('host', host);
  if (host.startsWith('-') || /[@/\\\[\]]/.test(host)) {
    throw new Error('host must not contain user, port, path, bracket, or option syntax.');
  }
  if (net.isIP(host)) {
    return;
  }
  const labels = host.split('.');
  if (labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new Error('host is not a valid DNS name, IPv4 address, or IPv6 address.');
  }
}

function normalizeConnection(value, options = {}) {
  const { requireIdentityFile = false } = options;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Connection data must be an object.');
  }
  assertHost(value.host);
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('port must be an integer between 1 and 65535.');
  }
  if (typeof value.username !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value.username)) {
    throw new Error('username must start with a letter or underscore and contain only letters, digits, underscore, dot, or hyphen.');
  }
  if (typeof value.identityFilePath !== 'string' || value.identityFilePath.length === 0 || value.identityFilePath.length > 1024) {
    throw new Error('identityFilePath must be a non-empty absolute local path.');
  }
  assertNoControlCharacters('identityFilePath', value.identityFilePath);
  if (value.identityFilePath.includes('BEGIN ') && value.identityFilePath.includes('PRIVATE KEY')) {
    throw new Error('Private key contents are forbidden. Select or enter only an absolute local file path.');
  }
  if (!path.isAbsolute(value.identityFilePath)) {
    throw new Error('identityFilePath must be an absolute local filesystem path.');
  }

  let identityFilePath = path.normalize(value.identityFilePath);
  if (requireIdentityFile) {
    const item = fs.statSync(identityFilePath);
    if (!item.isFile()) {
      throw new Error('identityFilePath must identify a file, not a directory.');
    }
    identityFilePath = fs.realpathSync(identityFilePath);
  }
  return {
    host: value.host,
    port: value.port,
    username: value.username,
    identityFilePath,
  };
}

function emptyStore() {
  return { schemaVersion: 1, connections: {} };
}

function readStore() {
  const store = storeInfo();
  if (!fs.existsSync(store.file)) {
    return emptyStore();
  }
  if (fs.lstatSync(store.file).isSymbolicLink()) {
    throw new Error('Refusing to read a symbolic-link connection store.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  } catch (error) {
    throw new Error(`The SSH connection store is invalid: ${error.message}`);
  }
  if (parsed?.schemaVersion !== 1 || !parsed.connections || typeof parsed.connections !== 'object' || Array.isArray(parsed.connections)) {
    throw new Error('The SSH connection store has an unsupported schema.');
  }
  const connections = {};
  for (const [name, value] of Object.entries(parsed.connections)) {
    assertConnectionName(name);
    connections[name] = normalizeConnection(value);
  }
  return { schemaVersion: 1, connections };
}

function windowsSid() {
  const result = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = result.stdout?.match(/S-\d+(?:-\d+)+/)?.[0];
  if (result.status !== 0 || !sid) {
    throw new Error('Could not determine the current Windows user SID for connection-store permissions.');
  }
  return sid;
}

function restrictPath(target, directory) {
  if (process.platform !== 'win32') {
    fs.chmodSync(target, directory ? 0o700 : 0o600);
    return;
  }
  const sid = windowsSid();
  const userGrant = directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  const systemGrant = directory ? '*S-1-5-18:(OI)(CI)F' : '*S-1-5-18:F';
  const result = spawnSync('icacls.exe', [
    target, '/inheritance:r', '/grant:r', userGrant, systemGrant, '/Q',
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`Could not restrict connection-store permissions: ${(result.stderr || result.stdout).trim()}`);
  }
}

function ensureStoreDirectory() {
  const store = storeInfo();
  if (fs.existsSync(store.directory) && fs.lstatSync(store.directory).isSymbolicLink()) {
    throw new Error('Refusing to use a symbolic-link connection-store directory.');
  }
  fs.mkdirSync(store.directory, { recursive: true, mode: 0o700 });
  restrictPath(store.directory, true);
  return store;
}

function writeStore(document) {
  const store = ensureStoreDirectory();
  const temporary = path.join(store.directory, `.connections-${crypto.randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    restrictPath(temporary, false);
    fs.renameSync(temporary, store.file);
    restrictPath(store.file, false);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
    }
  }
  writeSshConfig(document, store);
  return store;
}

function connectionAlias(connectionName) {
  return `codex-${crypto.createHash('sha256').update(connectionName, 'utf8').digest('hex').slice(0, 24)}`;
}

function quoteSshConfigValue(value) {
  const portable = process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  return `"${portable.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function renderSshConfig(document) {
  const lines = [
    '# Managed by Local SSH Remote. Do not edit.',
    '# Connection names are represented by opaque aliases.',
    '',
  ];
  for (const connectionName of Object.keys(document.connections).sort()) {
    const connection = document.connections[connectionName];
    lines.push(
      `Host ${connectionAlias(connectionName)}`,
      `  HostName ${connection.host}`,
      `  Port ${connection.port}`,
      `  User ${connection.username}`,
      `  IdentityFile ${quoteSshConfigValue(connection.identityFilePath)}`,
      '  BatchMode yes',
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking yes',
      '  ConnectTimeout 15',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function writeSshConfig(document, store = ensureStoreDirectory()) {
  const temporary = path.join(store.directory, `.ssh-config-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, renderSshConfig(document), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    restrictPath(temporary, false);
    fs.renameSync(temporary, store.sshConfigFile);
    restrictPath(store.sshConfigFile, false);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
    }
  }
  return store.sshConfigFile;
}

const connectionSchema = {
  type: 'object',
  properties: {
    connectionName: {
      type: 'string',
      title: '连接名称',
      description: '用于以后唤起，例如“生产服务器”。支持中文、其他语言文字、数字、空格、点、下划线和连字符。',
      minLength: 1,
      maxLength: 64,
    },
    host: {
      type: 'string',
      title: '服务器地址',
      description: 'DNS 名称、IPv4 或 IPv6；不要包含用户名或端口。',
      minLength: 1,
      maxLength: 253,
    },
    port: {
      type: 'integer',
      title: 'SSH 端口',
      minimum: 1,
      maximum: 65535,
      default: 22,
    },
    username: {
      type: 'string',
      title: 'SSH 用户名',
      minLength: 1,
      maxLength: 64,
    },
    identityFilePath: {
      type: 'string',
      title: '本机私钥绝对路径',
      description: '只填写文件路径，绝不要粘贴私钥正文。',
      minLength: 1,
      maxLength: 1024,
    },
    overwriteExisting: {
      type: 'boolean',
      title: '覆盖同名连接',
      default: false,
    },
  },
  required: ['connectionName', 'host', 'port', 'username', 'identityFilePath', 'overwriteExisting'],
  additionalProperties: false,
};

const tools = [
  {
    name: 'add_remote_server_connection',
    title: '添加 SSH 远程连接',
    description: 'Use this when the user asks to add or replace a reusable SSH remote-server connection. Opens the bundled connection editor. Stores connection fields only and never reads private key contents.',
    inputSchema: {
      type: 'object',
      properties: {
        suggestedConnectionName: { type: 'string', minLength: 1, maxLength: 64 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        suggestedConnectionName: { type: 'string' },
        browserOpened: { type: 'boolean' },
      },
      required: ['suggestedConnectionName', 'browserOpened'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: PROFILE_EDITOR_URI }, 'openai/outputTemplate': PROFILE_EDITOR_URI },
  },
  {
    name: 'save_connection',
    title: '保存 SSH 远程连接',
    description: 'Save connection fields submitted by the bundled editor into the current user’s durable connection store. Never accepts passwords, commands, or private key contents.',
    inputSchema: connectionSchema,
    outputSchema: {
      type: 'object',
      properties: {
        connectionName: { type: 'string' },
      },
      required: ['connectionName'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
  },
  {
    name: 'pick_identity_file',
    title: '选择本机 SSH 私钥文件',
    description: 'Open the operating system file picker and return only the selected absolute path. The file contents are never read or uploaded.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['selected', 'cancelled'] },
      },
      required: ['status'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
  },
  {
    name: 'list_connections',
    title: '列出 SSH 远程连接',
    description: 'Use this when the user asks which SSH server connections are remembered. Returns connection names only. Never call get_connection merely to describe or enumerate saved connections.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        connections: { type: 'array', items: { type: 'string' } },
      },
      required: ['connections'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_connection',
    title: '读取 SSH 远程连接',
    description: 'Use this only immediately before an actual user-requested task on a saved SSH connection. Returns an opaque SSH alias and dedicated config path so Codex can use native ssh, scp, or rsync without receiving the host, username, port, or identity-file path. Never use it just to list or describe saved connections.',
    inputSchema: {
      type: 'object',
      properties: { connectionName: { type: 'string', minLength: 1, maxLength: 64 } },
      required: ['connectionName'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        connectionName: { type: 'string' },
        sshAlias: { type: 'string' },
        sshConfigPath: { type: 'string' },
        platform: { type: 'string' },
        sshExecutable: { type: 'string' },
      },
      required: ['connectionName', 'sshAlias', 'sshConfigPath', 'platform', 'sshExecutable'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_connection',
    title: '删除 SSH 远程连接',
    description: 'Delete one saved SSH connection only when the user explicitly confirms that exact connection name.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionName: { type: 'string', minLength: 1, maxLength: 64 },
        confirmDelete: { type: 'boolean' },
      },
      required: ['connectionName', 'confirmDelete'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        connectionName: { type: 'string' },
        deleted: { type: 'boolean' },
      },
      required: ['connectionName', 'deleted'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

function saveConnection(value) {
  const expected = new Set(['connectionName', 'host', 'port', 'username', 'identityFilePath', 'overwriteExisting']);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Connection form data must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new Error(`Unsupported connection field: ${key}.`);
    }
  }
  assertConnectionName(value.connectionName);
  if (typeof value.overwriteExisting !== 'boolean') {
    throw new Error('overwriteExisting must be boolean.');
  }
  const connection = normalizeConnection(value, { requireIdentityFile: true });
  const document = readStore();
  if (Object.hasOwn(document.connections, value.connectionName) && !value.overwriteExisting) {
    throw new Error(`Connection "${value.connectionName}" already exists. Select the overwrite control to replace it.`);
  }
  document.connections[value.connectionName] = connection;
  const store = writeStore(document);
  return {
    content: [{ type: 'text', text: `Saved SSH remote connection "${value.connectionName}".` }],
    structuredContent: { connectionName: value.connectionName },
    _meta: { storeLocation: store.file },
  };
}

function listConnections() {
  const document = readStore();
  const connections = Object.keys(document.connections).sort();
  return {
    content: [{
      type: 'text',
      text: connections.length ? `Saved SSH connections: ${connections.join(', ')}` : 'No SSH connections are saved.',
    }],
    structuredContent: { connections },
  };
}

function getConnection(value) {
  assertConnectionName(value?.connectionName);
  const document = readStore();
  const connection = document.connections[value.connectionName];
  if (!connection) {
    throw new Error(`Connection "${value.connectionName}" does not exist.`);
  }
  try {
    if (!fs.statSync(connection.identityFilePath).isFile()) {
      throw new Error('not a file');
    }
  } catch {
    throw new Error(`The authentication file configured for connection "${value.connectionName}" is unavailable. Edit the connection before using it.`);
  }
  const runtime = platformDetails();
  const sshConfigPath = writeSshConfig(document);
  const output = {
    connectionName: value.connectionName,
    sshAlias: connectionAlias(value.connectionName),
    sshConfigPath,
    platform: runtime.platform,
    sshExecutable: runtime.sshExecutable,
  };
  return {
    content: [{ type: 'text', text: `Prepared an opaque SSH handle for connection "${value.connectionName}" on ${runtime.platform}. Raw connection fields and private key contents were not returned.` }],
    structuredContent: output,
  };
}

function deleteConnection(value) {
  assertConnectionName(value?.connectionName);
  if (value.confirmDelete !== true) {
    throw new Error(`Refusing to delete connection "${value.connectionName}" without confirmDelete: true.`);
  }
  const document = readStore();
  if (!Object.hasOwn(document.connections, value.connectionName)) {
    throw new Error(`Connection "${value.connectionName}" does not exist.`);
  }
  delete document.connections[value.connectionName];
  const store = writeStore(document);
  return {
    content: [{ type: 'text', text: `Deleted SSH connection "${value.connectionName}".` }],
    structuredContent: { connectionName: value.connectionName, deleted: true },
    _meta: { storeLocation: store.file },
  };
}

function validateSuggestedName(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'suggestedConnectionName') {
      throw new Error(`Unsupported tool argument: ${key}.`);
    }
  }
  if (Object.hasOwn(value, 'suggestedConnectionName')) {
    assertConnectionName(value.suggestedConnectionName);
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error('Request body exceeds 16 KiB.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function sendHttpJson(response, statusCode, body) {
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

async function handleEditorHttpRequest(request, response) {
  const basePath = `/${editorSessionToken}/`;
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  const address = editorHttpServer.address();
  const expectedHost = `127.0.0.1:${address.port}`;
  const expectedOrigin = `http://${expectedHost}`;
  if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== expectedOrigin)) {
    sendHttpJson(response, 403, { error: 'Loopback editor origin rejected.' });
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === basePath) {
    const content = Buffer.from(fs.readFileSync(profileEditorPath, 'utf8'));
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
    const toolName = requestUrl.pathname.slice(`${basePath}tool/`.length);
    if (!['save_connection', 'pick_identity_file'].includes(toolName)) {
      sendHttpJson(response, 404, { error: 'Unknown editor action.' });
      return;
    }
    try {
      const argumentsValue = await readJsonBody(request);
      const result = toolName === 'save_connection' ? saveConnection(argumentsValue) : pickIdentityFile();
      sendHttpJson(response, result.isError ? 400 : 200, result);
    } catch (error) {
      sendHttpJson(response, 400, { content: [{ type: 'text', text: error.message }], isError: true });
    }
    return;
  }
  sendHttpJson(response, 404, { error: 'Not found.' });
}

function ensureEditorServer() {
  if (editorServerReady) {
    return editorServerReady;
  }
  editorHttpServer = http.createServer((request, response) => {
    handleEditorHttpRequest(request, response).catch((error) => sendHttpJson(response, 500, { error: error.message }));
  });
  editorServerReady = new Promise((resolve, reject) => {
    editorHttpServer.once('error', reject);
    editorHttpServer.listen(0, '127.0.0.1', () => {
      editorHttpServer.removeListener('error', reject);
      resolve(`http://127.0.0.1:${editorHttpServer.address().port}/${editorSessionToken}/`);
    });
  });
  return editorServerReady;
}

function openEditorInSystemBrowser(editorUrl) {
  if (process.env.LOCAL_SSH_DEPLOY_SKIP_BROWSER_OPEN === '1') {
    return Promise.resolve(false);
  }
  let launcher;
  if (process.platform === 'win32') {
    const edgeCandidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
      .filter(Boolean)
      .map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
    launcher = edgePath
      ? { command: edgePath, args: [`--app=${editorUrl}`, '--new-window', '--no-first-run'] }
      : { command: 'explorer.exe', args: [editorUrl] };
  } else {
    launcher = process.platform === 'darwin'
      ? { command: 'open', args: [editorUrl] }
      : { command: 'xdg-open', args: [editorUrl] };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(launcher.command, launcher.args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', (error) => reject(new Error(`Could not open the system browser: ${error.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function openConnectionEditor(value) {
  validateSuggestedName(value);
  const suggestedConnectionName = value.suggestedConnectionName || '';
  const baseEditorUrl = await ensureEditorServer();
  const editorUrl = suggestedConnectionName
    ? `${baseEditorUrl}?suggestedConnectionName=${encodeURIComponent(suggestedConnectionName)}`
    : baseEditorUrl;
  const browserOpened = await openEditorInSystemBrowser(editorUrl);
  return {
    content: [{
      type: 'text',
      text: browserOpened
        ? 'SSH connection editor opened in the system browser.'
        : 'SSH connection editor is ready for the UI host.',
    }],
    structuredContent: { suggestedConnectionName, browserOpened },
    _meta: {
      ui: { resourceUri: PROFILE_EDITOR_URI },
      'openai/outputTemplate': PROFILE_EDITOR_URI,
      editorUrl,
    },
  };
}

function runPathPicker() {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = ['-NoLogo', '-NoProfile', '-STA', '-File', pickerScript];
  } else if (process.platform === 'darwin') {
    command = 'osascript';
    args = ['-e', 'POSIX path of (choose file with prompt "Choose an SSH private key file")'];
  } else {
    const zenity = spawnSync('sh', ['-c', 'command -v zenity'], { encoding: 'utf8' });
    if (zenity.status === 0) {
      command = 'zenity';
      args = ['--file-selection', '--title=Choose an SSH private key file'];
    } else {
      const kdialog = spawnSync('sh', ['-c', 'command -v kdialog'], { encoding: 'utf8' });
      if (kdialog.status !== 0) {
        throw new Error('No graphical file picker was found. Install zenity or kdialog, or enter the absolute path manually.');
      }
      command = 'kdialog';
      args = ['--getopenfilename', '', 'All files (*)'];
    }
  }
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: false,
    timeout: 5 * 60_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error) {
    throw new Error(`File picker failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    return { status: 'cancelled', path: '' };
  }
  if (process.platform === 'win32') {
    return JSON.parse(result.stdout);
  }
  const selectedPath = result.stdout.trim();
  return selectedPath ? { status: 'selected', path: path.resolve(selectedPath) } : { status: 'cancelled', path: '' };
}

function pickIdentityFile() {
  const selected = runPathPicker();
  return {
    content: [{
      type: 'text',
      text: selected.status === 'selected'
        ? 'Selected a local SSH private key path. The file contents were not read.'
        : 'File selection was cancelled.',
    }],
    structuredContent: { status: selected.status },
    _meta: { selectedPath: selected.path },
  };
}

async function callTool(params) {
  if (!params || typeof params.name !== 'string') {
    throw new Error('Tool name is required.');
  }
  switch (params.name) {
    case 'add_remote_server_connection':
      return openConnectionEditor(params.arguments || {});
    case 'save_connection':
      return saveConnection(params.arguments || {});
    case 'pick_identity_file':
      return pickIdentityFile();
    case 'list_connections':
      return listConnections();
    case 'get_connection':
      return getConnection(params.arguments || {});
    case 'delete_connection':
      return deleteConnection(params.arguments || {});
    default:
      throw new Error(`Unknown tool: ${params.name}`);
  }
}

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
        serverInfo: { name: SERVER_NAME, title: 'Local SSH Connections', version: SERVER_VERSION },
        instructions: 'Treat “添加一个远程服务器连接” as a request for this plugin unless the user explicitly asks for a Codex remote worker. list_connections returns names only; never call get_connection merely to enumerate or describe saved connections. Call get_connection only immediately before an actual requested server task. It returns an opaque SSH alias and dedicated config path, never raw host, username, port, or identity-file path. Use native ssh/scp/rsync with -F <sshConfigPath> <sshAlias>. Never read the connection store, generated SSH config, or private key contents.',
      });
      return;
    case 'ping':
      sendResult(message.id, {});
      return;
    case 'tools/list':
      sendResult(message.id, { tools });
      return;
    case 'resources/list':
      sendResult(message.id, {
        resources: [{
          uri: PROFILE_EDITOR_URI,
          name: 'SSH remote connection editor',
          title: 'SSH 远程连接',
          description: 'Interactive editor for a reusable local SSH connection.',
          mimeType: PROFILE_EDITOR_MIME_TYPE,
        }],
      });
      return;
    case 'resources/read':
      if (message.params?.uri !== PROFILE_EDITOR_URI) {
        sendError(message.id, -32602, `Unknown resource URI: ${message.params?.uri}`);
        return;
      }
      sendResult(message.id, {
        contents: [{
          uri: PROFILE_EDITOR_URI,
          mimeType: PROFILE_EDITOR_MIME_TYPE,
          text: fs.readFileSync(profileEditorPath, 'utf8'),
          _meta: { ui: { prefersBorder: true } },
        }],
      });
      return;
    case 'tools/call':
      try {
        sendResult(message.id, await callTool(message.params));
      } catch (error) {
        sendResult(message.id, { content: [{ type: 'text', text: error.message }], isError: true });
      }
      return;
    default:
      sendError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message && Object.hasOwn(message, 'id')) {
      sendError(message.id, -32600, 'Invalid Request');
    }
    return;
  }
  if (!Object.hasOwn(message, 'id')) {
    return;
  }
  handleRequest(message).catch((error) => sendError(message.id, -32603, error.message));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  try {
    handleMessage(JSON.parse(line));
  } catch {
    sendError(null, -32700, 'Parse error');
  }
});
input.on('close', () => {
  if (editorHttpServer) {
    editorHttpServer.close();
  }
});
