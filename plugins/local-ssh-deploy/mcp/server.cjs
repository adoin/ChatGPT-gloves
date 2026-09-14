#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const SERVER_NAME = 'local-ssh-deploy';
const SERVER_VERSION = '0.1.0';
const profilesScript = path.resolve(__dirname, '../scripts/profiles.ps1');
const pickerScript = path.resolve(__dirname, '../scripts/pick-identity-file.ps1');
const profileEditorPath = path.resolve(__dirname, 'profile-editor.html');
const PROFILE_EDITOR_URI = 'ui://local-ssh-deploy/profile-editor.html';
const PROFILE_EDITOR_MIME_TYPE = 'text/html;profile=mcp-app';

let clientCapabilities = {};
let nextServerRequestId = 1;
const pendingClientRequests = new Map();
let editorHttpServer;
let editorServerReady;
const editorSessionToken = crypto.randomBytes(24).toString('hex');

const profileFormSchema = {
  type: 'object',
  properties: {
    profileName: {
      type: 'string',
      title: '连接名称',
      description: '用于以后唤起，例如 production。只能使用字母、数字、点、下划线和连字符。',
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
      description: '只填写文件路径，绝不要粘贴私钥正文。私钥必须位于待部署项目之外。',
      minLength: 1,
      maxLength: 1024,
    },
    overwriteExisting: {
      type: 'boolean',
      title: '覆盖同名连接',
      description: '只有明确希望替换已有连接时才勾选。',
      default: false,
    },
  },
  required: [
    'profileName',
    'host',
    'port',
    'username',
    'identityFilePath',
    'overwriteExisting',
  ],
};

const tools = [
  {
    name: 'add_remote_server_connection',
    title: '添加 SSH 远程连接',
    description: 'Start the bundled editor for a reusable SSH remote-server connection and open its randomized loopback URL in the system browser. The saved profile contains connection fields only, works without MCP elicitation, and never reads private key contents.',
    inputSchema: {
      type: 'object',
      properties: {
        suggestedProfileName: {
          type: 'string',
          description: 'Optional profile name to prefill in the editor.',
          minLength: 1,
          maxLength: 64,
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        suggestedProfileName: { type: 'string' },
        editorUrl: { type: 'string' },
        browserOpened: { type: 'boolean' },
      },
      required: ['suggestedProfileName', 'editorUrl', 'browserOpened'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: PROFILE_EDITOR_URI },
      'openai/outputTemplate': PROFILE_EDITOR_URI,
    },
  },
  {
    name: 'save_profile',
    title: '保存 SSH 连接档案',
    description: 'Validate and securely save reusable SSH connection fields submitted by the bundled editor. Commands and remote directories are task-specific and are not stored. Accepts an absolute private-key path only, never private key contents.',
    inputSchema: {
      ...profileFormSchema,
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        profileName: { type: 'string' },
        storeBackend: { type: 'string' },
        storeLocation: { type: 'string' },
      },
      required: ['profileName', 'storeBackend', 'storeLocation'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'pick_identity_file',
    title: '选择本机 SSH 私钥文件',
    description: 'Open the operating system file picker and return only the selected absolute path. The file contents are never read or uploaded.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['selected', 'cancelled'] },
        path: { type: 'string' },
      },
      required: ['status', 'path'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'save_profile_with_form',
    title: '打开 SSH 连接兼容表单',
    description: 'Compatibility fallback that collects reusable SSH connection fields and saves them in the current user secure store. Never accepts private key contents.',
    inputSchema: {
      type: 'object',
      properties: {
        suggestedProfileName: {
          type: 'string',
          description: 'Optional profile name to prefill in the form.',
          minLength: 1,
          maxLength: 64,
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        profileName: { type: 'string' },
        storeBackend: { type: 'string' },
        storeLocation: { type: 'string' },
      },
      required: ['profileName', 'storeBackend', 'storeLocation'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'list_profiles',
    title: '列出 SSH 远程连接',
    description: 'List the names of securely saved reusable SSH connections without exposing private key contents.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        profiles: { type: 'array', items: { type: 'string' } },
        storeBackend: { type: 'string' },
        storeLocation: { type: 'string' },
      },
      required: ['profiles', 'storeBackend', 'storeLocation'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
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

function requestClient(method, params) {
  const id = `server-${nextServerRequestId++}`;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
  });
}

function powershellCommand() {
  return process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
}

function runProfilesScript(args) {
  const result = spawnSync(powershellCommand(), [
    '-NoLogo',
    '-NoProfile',
    '-File',
    profilesScript,
    ...args,
  ], {
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Profile storage command failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'unknown error').trim();
    throw new Error(`Profile storage rejected the form: ${detail}`);
  }
  return JSON.parse(result.stdout);
}

function assertFormContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('The submitted profile form is invalid.');
  }
  const expectedKeys = new Set([
    'profileName', 'host', 'port', 'username', 'identityFilePath', 'overwriteExisting',
  ]);
  for (const key of Object.keys(content)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`The submitted profile form contains an unsupported field: ${key}.`);
    }
  }
  for (const key of [
    'profileName', 'host', 'username', 'identityFilePath',
  ]) {
    if (typeof content[key] !== 'string' || content[key].length === 0) {
      throw new Error(`The submitted profile form field ${key} must be a non-empty string.`);
    }
  }
  const maximumLengths = {
    profileName: 64,
    host: 253,
    username: 64,
    identityFilePath: 1024,
  };
  for (const [key, maximum] of Object.entries(maximumLengths)) {
    if (content[key].length > maximum) {
      throw new Error(`The submitted profile form field ${key} exceeds ${maximum} characters.`);
    }
  }
  if (!Number.isInteger(content.port) || content.port < 1 || content.port > 65535) {
    throw new Error('The submitted profile form port must be an integer between 1 and 65535.');
  }
  if (typeof content.overwriteExisting !== 'boolean') {
    throw new Error('The submitted profile form overwriteExisting field must be boolean.');
  }
  if (content.identityFilePath.includes('BEGIN ') && content.identityFilePath.includes('PRIVATE KEY')) {
    throw new Error('Private key contents are forbidden. Select or enter only an absolute local file path.');
  }
}

function validateSuggestedName(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new Error('Tool arguments must be an object.');
  }
  for (const key of Object.keys(argumentsValue)) {
    if (key !== 'suggestedProfileName') {
      throw new Error(`Unsupported tool argument: ${key}.`);
    }
  }
  if (Object.hasOwn(argumentsValue, 'suggestedProfileName')
      && (typeof argumentsValue.suggestedProfileName !== 'string'
        || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(argumentsValue.suggestedProfileName))) {
    throw new Error('suggestedProfileName must be a valid profile name.');
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
  if (request.headers.host !== expectedHost
      || (request.headers.origin && request.headers.origin !== expectedOrigin)) {
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
    if (!['save_profile', 'pick_identity_file'].includes(toolName)) {
      sendHttpJson(response, 404, { error: 'Unknown editor action.' });
      return;
    }
    try {
      const argumentsValue = await readJsonBody(request);
      const result = toolName === 'save_profile'
        ? saveProfile(argumentsValue)
        : pickIdentityFile();
      sendHttpJson(response, result.isError ? 400 : 200, result);
    } catch (error) {
      sendHttpJson(response, 400, {
        content: [{ type: 'text', text: error.message }],
        isError: true,
      });
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
    handleEditorHttpRequest(request, response).catch((error) => {
      sendHttpJson(response, 500, { error: error.message });
    });
  });
  editorServerReady = new Promise((resolve, reject) => {
    editorHttpServer.once('error', reject);
    editorHttpServer.listen(0, '127.0.0.1', () => {
      editorHttpServer.removeListener('error', reject);
      const address = editorHttpServer.address();
      resolve(`http://127.0.0.1:${address.port}/${editorSessionToken}/`);
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
    const edgeCandidates = [
      process.env['ProgramFiles(x86)'],
      process.env.ProgramFiles,
    ].filter(Boolean).map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
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
    const child = spawn(launcher.command, launcher.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', (error) => {
      reject(new Error(`Could not open the system browser: ${error.message}`));
    });
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function openProfileEditor(argumentsValue) {
  validateSuggestedName(argumentsValue);
  const suggestedProfileName = argumentsValue.suggestedProfileName || '';
  const baseEditorUrl = await ensureEditorServer();
  const editorUrl = suggestedProfileName
    ? `${baseEditorUrl}?suggestedProfileName=${encodeURIComponent(suggestedProfileName)}`
    : baseEditorUrl;
  const browserOpened = await openEditorInSystemBrowser(editorUrl);
  return {
    content: [{
      type: 'text',
      text: browserOpened
        ? `SSH remote connection editor opened in the system browser at ${editorUrl}. Complete the form and choose Save connection.`
        : `SSH remote connection editor is ready at ${editorUrl}.`,
    }],
    structuredContent: { suggestedProfileName, editorUrl, browserOpened },
    _meta: {
      ui: { resourceUri: PROFILE_EDITOR_URI },
      'openai/outputTemplate': PROFILE_EDITOR_URI,
    },
  };
}

function saveProfile(content) {
  assertFormContent(content);
  const args = [
    '-Save',
    '-ProfileName', content.profileName,
    '-HostName', content.host,
    '-Port', String(content.port),
    '-Username', content.username,
    '-IdentityFilePath', content.identityFilePath,
  ];
  if (content.overwriteExisting) {
    args.push('-ConfirmOverwrite');
  }

  const saved = runProfilesScript(args);
  return {
    content: [{
      type: 'text',
      text: `Saved SSH remote connection "${saved.profileName}" in ${saved.storeBackend}.`,
    }],
    structuredContent: {
      profileName: saved.profileName,
      storeBackend: saved.storeBackend,
      storeLocation: saved.storeLocation,
    },
  };
}

function runPathPicker() {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = powershellCommand();
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
        throw new Error('No supported graphical file picker was found. Install zenity or kdialog, or enter the absolute path manually.');
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
  return selectedPath
    ? { status: 'selected', path: path.resolve(selectedPath) }
    : { status: 'cancelled', path: '' };
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
    structuredContent: selected,
  };
}

async function saveProfileWithForm(argumentsValue) {
  validateSuggestedName(argumentsValue);
  if (!clientCapabilities?.elicitation?.form) {
    return {
      content: [{
        type: 'text',
        text: 'This Codex client does not support MCP form elicitation. Update Codex and start a new task.',
      }],
      isError: true,
    };
  }

  const requestedSchema = JSON.parse(JSON.stringify(profileFormSchema));
  const suggestedName = argumentsValue?.suggestedProfileName;
  if (typeof suggestedName === 'string') {
    requestedSchema.properties.profileName.default = suggestedName;
  }

  const response = await requestClient('elicitation/create', {
    mode: 'form',
    message: '填写 SSH 远程连接。私钥字段只允许本机绝对路径，不要粘贴私钥正文。',
    requestedSchema,
  });

  if (response.action === 'decline') {
    return {
      content: [{
        type: 'text',
        text: 'Codex declined the profile form because the current permission policy does not allow MCP elicitations. Switch the task from Full Access to an approval-enabled permission mode, then try again.',
      }],
      isError: true,
    };
  }
  if (response.action === 'cancel') {
    return {
      content: [{ type: 'text', text: 'SSH connection profile form was cancelled; nothing was saved.' }],
    };
  }
  if (response.action !== 'accept') {
    throw new Error(`Unsupported profile form response action: ${response.action}.`);
  }

  return saveProfile(response.content);
}

function listProfiles() {
  const listed = runProfilesScript(['-List']);
  return {
    content: [{
      type: 'text',
      text: listed.profiles.length > 0
        ? `Saved SSH remote connections: ${listed.profiles.join(', ')}`
        : 'No SSH remote connections are saved.',
    }],
    structuredContent: {
      profiles: listed.profiles,
      storeBackend: listed.storeBackend,
      storeLocation: listed.storeLocation,
    },
  };
}

async function callTool(params) {
  if (!params || typeof params.name !== 'string') {
    throw new Error('Tool name is required.');
  }
  switch (params.name) {
    case 'add_remote_server_connection':
      return openProfileEditor(params.arguments || {});
    case 'save_profile':
      return saveProfile(params.arguments || {});
    case 'pick_identity_file':
      return pickIdentityFile();
    case 'save_profile_with_form':
      return saveProfileWithForm(params.arguments || {});
    case 'list_profiles':
      return listProfiles();
    default:
      throw new Error(`Unknown tool: ${params.name}`);
  }
}

async function handleRequest(message) {
  switch (message.method) {
    case 'initialize':
      clientCapabilities = message.params?.capabilities || {};
      sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: SERVER_NAME,
          title: 'Local SSH Remote',
          version: SERVER_VERSION,
        },
        instructions: 'Treat requests such as "添加一个远程服务器连接" as requests for a reusable general-purpose SSH connection unless the user explicitly says Codex remote worker or remote execution host. Use add_remote_server_connection for new or replacement profiles. Store connection fields only; commands and directories belong to the later task. It starts the bundled loopback editor and opens it in the system browser without MCP elicitation. Report an error if the call fails; do not claim success before it completes. Use save_profile_with_form only as a compatibility fallback. Never request private key contents.',
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
          description: 'Interactive editor for a securely stored reusable SSH connection.',
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
        sendResult(message.id, {
          content: [{ type: 'text', text: error.message }],
          isError: true,
        });
      }
      return;
    default:
      sendError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function handleMessage(message) {
  if (message && !message.method && Object.hasOwn(message, 'id')) {
    const pending = pendingClientRequests.get(message.id);
    if (!pending) {
      return;
    }
    pendingClientRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || 'Client request failed.'));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message && Object.hasOwn(message, 'id')) {
      sendError(message.id, -32600, 'Invalid Request');
    }
    return;
  }
  if (!Object.hasOwn(message, 'id')) {
    return;
  }
  handleRequest(message).catch((error) => {
    sendError(message.id, -32603, error.message);
  });
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
  for (const pending of pendingClientRequests.values()) {
    pending.reject(new Error('MCP client disconnected.'));
  }
  pendingClientRequests.clear();
  if (editorHttpServer) {
    editorHttpServer.close();
  }
});
