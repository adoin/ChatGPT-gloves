'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../plugins/local-ssh-deploy');
const mcpConfigPath = path.join(pluginRoot, '.mcp.json');
const serverPath = path.join(pluginRoot, 'mcp', 'server.cjs');
const editorPath = path.join(pluginRoot, 'mcp', 'profile-editor.html');
const pickerPath = path.join(pluginRoot, 'scripts', 'pick-identity-file.ps1');
const editorUri = 'ui://local-ssh-deploy/connection-editor-v2.html';

test('host confirmation requires explicit yes and never replaces changed or revoked keys', async t => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const localRequire = createRequire(path.join(pluginRoot, 'package.json'));
  const { utils } = localRequire('ssh2');
  const { confirmHost, knownKeys } = require(path.join(pluginRoot, 'scripts/ssh-password.cjs'));
  const generate = () => utils.parseKey(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' })).getPublicSSH();
  const key = generate(), changed = generate();
  const file = path.join(item.root, '.ssh/known_hosts');
  const connection = { host: 'example.test', port: 2222 };
  assert.equal(await confirmHost(connection, key, [file], async () => 'no'), false);
  assert.equal(fs.existsSync(file), false);
  let prompt;
  assert.equal(await confirmHost(connection, key, [file], async value => { prompt = value; return 'yes'; }), true);
  assert.match(prompt, /SHA256:/);
  assert.equal(knownKeys(connection.host, connection.port, [file])(key), true);
  const before = fs.readFileSync(file, 'utf8');
  let asked = false;
  const mustNotPrompt = async () => { asked = true; return 'yes'; };
  assert.equal(await confirmHost(connection, key, [file], mustNotPrompt), true);
  await assert.rejects(confirmHost(connection, changed, [file], mustNotPrompt), /SSH_HOST_KEY_CHANGED/);
  assert.equal(asked, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.appendFileSync(file, `@revoked [example.test]:2222 ssh-rsa ${key.toString('base64')}\n`);
  await assert.rejects(confirmHost(connection, key, [file], mustNotPrompt), /SSH_HOST_KEY_REVOKED/);
  assert.equal(asked, false);
});

test('password editor saves only credential references and authenticates without model-visible secrets', { skip: process.platform !== 'win32' }, async t => {
  const item = fixture();
  const client = startServer(item);
  const localRequire = createRequire(path.join(pluginRoot, 'package.json'));
  const { Server, utils } = localRequire('ssh2');
  const { Entry } = localRequire('@napi-rs/keyring');
  const secret = 'fixture-password-!$"空格 secret';
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  let authenticated = 0;
  let remoteFile = Buffer.alloc(0);
  const sshServer = new Server({ hostKeys: [hostKey] }, socket => {
    socket.on('error', () => {});
    socket.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === secret) { authenticated++; ctx.accept(); }
      else ctx.reject(['password']);
    });
    socket.on('ready', () => socket.on('session', accept => {
      const session = accept();
      session.on('exec', accept => { const stream = accept(); stream.write('fixture connected\n'); stream.exit(7); stream.end(); });
      session.on('sftp', accept => {
        const sftp = accept();
        const attributes = () => ({ mode: 0o100600, uid: 0, gid: 0, size: remoteFile.length, atime: 0, mtime: 0 });
        sftp.on('OPEN', (id, name, flags) => {
          if (name !== '/fixture-file') return sftp.status(id, 2);
          if (flags & 0x10) remoteFile = Buffer.alloc(0);
          sftp.handle(id, Buffer.from('fixture'));
        });
        sftp.on('FSTAT', id => sftp.attrs(id, attributes()));
        sftp.on('STAT', id => sftp.attrs(id, attributes()));
        sftp.on('WRITE', (id, _handle, offset, data) => {
          const next = Buffer.alloc(Math.max(remoteFile.length, offset + data.length));
          remoteFile.copy(next); data.copy(next, offset); remoteFile = next; sftp.status(id, 0);
        });
        sftp.on('READ', (id, _handle, offset, length) => {
          if (offset >= remoteFile.length) sftp.status(id, 1);
          else sftp.data(id, remoteFile.subarray(offset, offset + length));
        });
        sftp.on('CLOSE', id => sftp.status(id, 0));
      });
    }));
  });
  await new Promise(resolve => sshServer.listen(0, '127.0.0.1', resolve));
  const port = sshServer.address().port;
  const storePath = path.join(item.localAppData, 'OpenAI/Codex/local-ssh-deploy/connections.json');
  t.after(() => {
    if (fs.existsSync(storePath)) for (const value of Object.values(JSON.parse(fs.readFileSync(storePath)).connections))
      if (value.passwordRef) new Entry('codex.local-ssh-deploy', value.passwordRef).deleteCredential();
    client.stop(); sshServer.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  });
  await initialize(client);
  const opened = await call(client, 2, 'add_remote_server_connection', {});
  const saveUrl = new URL('tool/save_connection', opened._meta.editorUrl);
  const payload = { connectionName: 'password-fixture', host: '127.0.0.1', port, username: 'fixture',
    authType: 'password', password: secret, overwriteExisting: false };
  const blocked = await call(client, 3, 'save_connection', payload);
  assert.equal(blocked.isError, true);
  assert.doesNotMatch(JSON.stringify(blocked), /fixture-password/);
  const response = await fetch(saveUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /fixture-password|passwordRef/);
  const stored = JSON.parse(fs.readFileSync(storePath));
  const reference = stored.connections['password-fixture'].passwordRef;
  assert.doesNotMatch(fs.readFileSync(storePath, 'utf8'), /fixture-password/);
  assert.equal(new Entry('codex.local-ssh-deploy', reference).getPassword(), secret);
  const handle = (await call(client, 4, 'get_connection', { connectionName: 'password-fixture' })).structuredContent;
  assert.ok(handle.passwordClientPath);
  const terminal = await call(client, 40, 'open_connection_terminal', { connectionName: 'password-fixture' });
  assert.deepEqual(terminal.structuredContent, { connectionName: 'password-fixture', windowOpened: false });
  assert.doesNotMatch(JSON.stringify(terminal), /fixture-password|127\.0\.0\.1|passwordRef/);
  assert.doesNotMatch(JSON.stringify(handle), /fixture-password|127\.0\.0\.1|passwordRef/);
  const knownFile = path.join(item.root, '.ssh/known_hosts');
  fs.mkdirSync(path.dirname(knownFile));
  const run = (action = 'exec', args = ['fixture-command']) => new Promise(resolve => {
    const child = spawn(process.execPath, [handle.passwordClientPath, handle.sshAlias, action, ...args], {
      env: { ...process.env, LOCALAPPDATA: item.localAppData, USERPROFILE: item.root, HOME: item.root }, windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  const untrusted = await run();
  assert.equal(untrusted.code, 1); assert.match(untrusted.stderr, /host key/); assert.equal(authenticated, 0);
  fs.writeFileSync(knownFile, `[127.0.0.1]:${port} ssh-rsa ${utils.parseKey(hostKey).getPublicSSH().toString('base64')}\n`);
  const success = await run();
  assert.equal(success.code, 7, success.stderr); assert.equal(success.stdout, 'fixture connected\n');
  assert.doesNotMatch(success.stderr, /fixture-password/);
  const upload = path.join(item.root, 'upload.txt'), download = path.join(item.root, 'download.txt');
  fs.writeFileSync(upload, 'file-transfer-fixture');
  const uploaded = await run('upload', [upload, '/fixture-file']);
  assert.equal(uploaded.code, 0, uploaded.stderr);
  assert.equal(remoteFile.toString(), 'file-transfer-fixture');
  const downloaded = await run('download', ['/fixture-file', download]);
  assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.equal(fs.readFileSync(download, 'utf8'), 'file-transfer-fixture');
  new Entry('codex.local-ssh-deploy', reference).setPassword('wrong-fixture');
  const wrong = await run(); assert.equal(wrong.code, 1); assert.match(wrong.stderr, /authentication failed/);
  const replacement = await fetch(saveUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, overwriteExisting: true }) });
  assert.equal(replacement.status, 200);
  assert.equal(new Entry('codex.local-ssh-deploy', reference).getPassword(), null);
  const replacementRef = JSON.parse(fs.readFileSync(storePath)).connections['password-fixture'].passwordRef;
  assert.notEqual(replacementRef, reference);
  assert.equal((await run()).code, 7);
  const deleted = await call(client, 5, 'delete_connection', { connectionName: 'password-fixture', confirmDelete: true });
  assert.equal(deleted.isError, undefined);
  assert.equal(new Entry('codex.local-ssh-deploy', reference).getPassword(), null);
  assert.equal(new Entry('codex.local-ssh-deploy', replacementRef).getPassword(), null);
});

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
      LOCAL_SSH_DEPLOY_SKIP_TERMINAL_OPEN: '1',
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
    'open_connection_terminal',
    'add_remote_server_connection',
    'save_connection',
    'pick_identity_file',
    'list_connections',
    'get_connection',
    'delete_connection',
  ]);
  assert.equal(listed.result.tools.some((tool) => /command|deploy/i.test(tool.name)), false);
  const editorTool = listed.result.tools.find(tool => tool.name === 'add_remote_server_connection');
  assert.equal(editorTool._meta.ui.resourceUri, editorUri);
  assert.deepEqual(listed.result.tools.find(tool => tool.name === 'save_connection')._meta.ui.visibility, ['app']);
  assert.deepEqual(listed.result.tools.find(tool => tool.name === 'pick_identity_file')._meta.ui.visibility, ['app']);

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

test('platform-specific UI adapters preserve native file selection', () => {
  const server = fs.readFileSync(serverPath, 'utf8');
  assert.match(server, /platform: 'windows'/);
  assert.match(server, /platform: 'macos'/);
  assert.match(server, /platform: 'linux'/);
  assert.match(server, /XDG_CONFIG_HOME/);
  assert.match(server, /command = 'osascript'/);
  assert.match(server, /command = 'zenity'/);
  assert.match(server, /command = 'kdialog'/);
  assert.doesNotMatch(server, /profiles\.ps1|remote\.ps1|deploy\.ps1/);
  assert.match(server, /command = 'powershell\.exe'/);

  const picker = fs.readFileSync(pickerPath, 'utf8');
  assert.match(picker, /OpenFileDialog/);
  assert.doesNotMatch(picker, /Get-Content|ReadAll|OpenRead|ReadToEnd/);
});
