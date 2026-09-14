'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../plugins/local-ssh-deploy');
const mcpConfigPath = path.join(pluginRoot, '.mcp.json');
const serverPath = path.join(pluginRoot, 'mcp', 'server.cjs');
const editorPath = path.join(pluginRoot, 'mcp', 'profile-editor.html');
const pickerPath = path.join(pluginRoot, 'scripts', 'pick-identity-file.ps1');
const editorUri = 'ui://local-ssh-deploy/connection-editor-v2.html';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ssh-connection-test-'));
  const identity = path.join(root, 'id_ed25519');
  const localAppData = path.join(root, 'local-app-data');
  fs.mkdirSync(localAppData);
  fs.writeFileSync(identity, 'PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR', 'utf8');
  return { root, identity, localAppData };
}

function startServer(item) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LOCALAPPDATA: item.localAppData,
      LOCAL_SSH_DEPLOY_SKIP_BROWSER_OPEN: '1',
    },
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async receive() {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP message. stderr: ${stderr}`)), 10_000);
      });
      try {
        const next = await Promise.race([iterator.next(), timeout]);
        assert.equal(next.done, false, `MCP server exited unexpectedly. stderr: ${stderr}`);
        return JSON.parse(next.value);
      } finally {
        clearTimeout(timer);
      }
    },
    stop() {
      child.stdin.end();
      child.kill();
      lines.close();
    },
  };
}

async function initialize(client) {
  client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'local-ssh-connection-test', version: '1.0.0' },
    },
  });
  const response = await client.receive();
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'local-ssh-deploy');
  assert.match(response.result.instructions, /get_connection.*opaque SSH alias.*Never read/s);
}

async function call(client, id, name, argumentsValue = {}) {
  client.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: argumentsValue },
  });
  const response = await client.receive();
  assert.equal(response.id, id);
  return response.result;
}

test('bundled MCP config launches the Node server from the plugin root', () => {
  const config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers['local-ssh-deploy'];
  assert.deepEqual(config, { command: 'node', args: ['mcp/server.cjs'], cwd: '.' });
  const result = spawnSync(config.command, config.args, {
    cwd: pluginRoot,
    input: `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-test', version: '1' } },
    })}\n`,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).result.serverInfo.name, 'local-ssh-deploy');
});

test('server exposes connection-address-book tools and the bundled editor', async (t) => {
  const item = fixture();
  const client = startServer(item);
  t.after(() => {
    client.stop();
    fs.rmSync(item.root, { recursive: true, force: true });
  });
  await initialize(client);

  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await client.receive();
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'add_remote_server_connection',
    'save_connection',
    'pick_identity_file',
    'list_connections',
    'get_connection',
    'delete_connection',
  ]);
  assert.equal(listed.result.tools.some((tool) => /command|deploy/i.test(tool.name)), false);
  const editorTool = listed.result.tools[0];
  assert.equal(editorTool._meta.ui.resourceUri, editorUri);
  assert.deepEqual(listed.result.tools[1]._meta.ui.visibility, ['app']);
  assert.deepEqual(listed.result.tools[2]._meta.ui.visibility, ['app']);

  const opened = await call(client, 3, 'add_remote_server_connection', { suggestedConnectionName: '生产服务器' });
  assert.equal(opened.structuredContent.suggestedConnectionName, '生产服务器');
  assert.equal(opened.structuredContent.browserOpened, false);
  assert.equal(opened.structuredContent.editorUrl, undefined);
  assert.equal(new URL(opened._meta.editorUrl).searchParams.get('suggestedConnectionName'), '生产服务器');

  const response = await fetch(opened._meta.editorUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await response.text();
  assert.equal(html, fs.readFileSync(editorPath, 'utf8'));
  assert.match(html, /name="connectionName"/);
  assert.match(html, /callTool\('save_connection'/);
  assert.doesNotMatch(html, /deploymentCommand|remoteDirectory|type="file"|uploadFile|selectFiles/);
});

test('save, list, get, overwrite, and delete operate on one durable user store', { skip: process.platform !== 'win32' }, async (t) => {
  const item = fixture();
  const client = startServer(item);
  t.after(() => {
    client.stop();
    fs.rmSync(item.root, { recursive: true, force: true });
  });
  await initialize(client);

  const values = {
    connectionName: '生产服务器',
    host: 'server.example.com',
    port: 2222,
    username: 'deploy',
    identityFilePath: item.identity,
    overwriteExisting: false,
  };
  const saved = await call(client, 2, 'save_connection', values);
  assert.equal(saved.isError, undefined);
  assert.deepEqual(saved.structuredContent, { connectionName: '生产服务器' });
  const storePath = path.join(item.localAppData, 'OpenAI', 'Codex', 'local-ssh-deploy', 'connections.json');
  const sshConfigPath = path.join(item.localAppData, 'OpenAI', 'Codex', 'local-ssh-deploy', 'ssh_config');
  assert.equal(saved._meta.storeLocation, storePath);

  const storedText = fs.readFileSync(storePath, 'utf8');
  const stored = JSON.parse(storedText);
  assert.deepEqual(Object.keys(stored.connections['生产服务器']), ['host', 'port', 'username', 'identityFilePath']);
  assert.equal(stored.connections['生产服务器'].host, 'server.example.com');
  assert.doesNotMatch(storedText, /PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR/);
  const acl = spawnSync('icacls.exe', [storePath], { encoding: 'utf8' });
  assert.equal(acl.status, 0, acl.stderr);
  assert.doesNotMatch(acl.stdout, /\(I\)/);

  const listed = await call(client, 3, 'list_connections');
  assert.deepEqual(listed.structuredContent, { connections: ['生产服务器'] });
  assert.doesNotMatch(JSON.stringify(listed), /server\.example\.com|id_ed25519|"username":"deploy"/);

  const loaded = await call(client, 4, 'get_connection', { connectionName: '生产服务器' });
  const sshAlias = `codex-${crypto.createHash('sha256').update('生产服务器', 'utf8').digest('hex').slice(0, 24)}`;
  assert.deepEqual(loaded.structuredContent, {
    connectionName: '生产服务器',
    sshAlias,
    sshConfigPath,
    platform: 'windows',
    sshExecutable: 'ssh.exe',
  });
  assert.doesNotMatch(JSON.stringify(loaded), /server\.example\.com|id_ed25519|2222|"username":"deploy"/);
  const sshConfig = fs.readFileSync(sshConfigPath, 'utf8');
  assert.match(sshConfig, new RegExp(`Host ${sshAlias}`));
  assert.match(sshConfig, /HostName server\.example\.com/);
  assert.match(sshConfig, /Port 2222/);
  assert.match(sshConfig, /User deploy/);
  assert.match(sshConfig, /IdentityFile .*id_ed25519/);
  const configAcl = spawnSync('icacls.exe', [sshConfigPath], { encoding: 'utf8' });
  assert.equal(configAcl.status, 0, configAcl.stderr);
  assert.doesNotMatch(configAcl.stdout, /\(I\)/);

  const duplicate = await call(client, 5, 'save_connection', values);
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /already exists/);

  const overwritten = await call(client, 6, 'save_connection', {
    ...values,
    host: 'replacement.example.com',
    overwriteExisting: true,
  });
  assert.equal(overwritten.isError, undefined);
  const reloaded = await call(client, 7, 'get_connection', { connectionName: '生产服务器' });
  assert.deepEqual(reloaded.structuredContent, loaded.structuredContent);
  const replacedConfig = fs.readFileSync(sshConfigPath, 'utf8');
  assert.match(replacedConfig, /HostName replacement\.example\.com/);
  assert.doesNotMatch(replacedConfig, /HostName server\.example\.com/);

  const refused = await call(client, 8, 'delete_connection', { connectionName: '生产服务器', confirmDelete: false });
  assert.equal(refused.isError, true);
  const deleted = await call(client, 9, 'delete_connection', { connectionName: '生产服务器', confirmDelete: true });
  assert.deepEqual(deleted.structuredContent, { connectionName: '生产服务器', deleted: true });
  const empty = await call(client, 10, 'list_connections');
  assert.deepEqual(empty.structuredContent.connections, []);
});

test('connection validation rejects task fields and private key contents', async (t) => {
  const item = fixture();
  const client = startServer(item);
  t.after(() => {
    client.stop();
    fs.rmSync(item.root, { recursive: true, force: true });
  });
  await initialize(client);

  const extra = await call(client, 2, 'save_connection', {
    connectionName: 'production',
    host: 'server.example.com',
    port: 22,
    username: 'deploy',
    identityFilePath: item.identity,
    overwriteExisting: false,
    deploymentCommand: 'reboot',
  });
  assert.equal(extra.isError, true);
  assert.match(extra.content[0].text, /Unsupported connection field/);

  const keyText = await call(client, 3, 'save_connection', {
    connectionName: 'production',
    host: 'server.example.com',
    port: 22,
    username: 'deploy',
    identityFilePath: '-----BEGIN OPENSSH PRIVATE KEY-----',
    overwriteExisting: false,
  });
  assert.equal(keyText.isError, true);
  assert.match(keyText.content[0].text, /Private key contents are forbidden/);
});

test('platform branches do not require PowerShell outside the Windows file picker', () => {
  const server = fs.readFileSync(serverPath, 'utf8');
  assert.match(server, /platform: 'windows'/);
  assert.match(server, /platform: 'macos'/);
  assert.match(server, /platform: 'linux'/);
  assert.match(server, /XDG_CONFIG_HOME/);
  assert.match(server, /command = 'osascript'/);
  assert.match(server, /command = 'zenity'/);
  assert.match(server, /command = 'kdialog'/);
  assert.doesNotMatch(server, /pwsh|profiles\.ps1|remote\.ps1|deploy\.ps1/);
  assert.match(server, /command = 'powershell\.exe'/);

  const picker = fs.readFileSync(pickerPath, 'utf8');
  assert.match(picker, /OpenFileDialog/);
  assert.doesNotMatch(picker, /Get-Content|ReadAll|OpenRead|ReadToEnd/);
});
