'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '../plugins/local-ssh-deploy');
const mcpConfigPath = path.join(pluginRoot, '.mcp.json');
const serverPath = path.resolve(__dirname, '../plugins/local-ssh-deploy/mcp/server.cjs');
const editorPath = path.resolve(__dirname, '../plugins/local-ssh-deploy/mcp/profile-editor.html');
const pickerPath = path.resolve(__dirname, '../plugins/local-ssh-deploy/scripts/pick-identity-file.ps1');
const editorUri = 'ui://local-ssh-deploy/profile-editor.html';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ssh-deploy-mcp-test-'));
  const identity = path.join(root, 'deploy_ed25519');
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
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'local-ssh-deploy-test', version: '1.0.0' },
    },
  });
  const response = await client.receive();
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'local-ssh-deploy');
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

test('bundled MCP config launches the server from the plugin root', () => {
  const config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers['local-ssh-deploy'];
  assert.deepEqual(config, {
    command: 'node',
    args: ['mcp/server.cjs'],
    cwd: '.',
  });

  const result = spawnSync(config.command, config.args, {
    cwd: pluginRoot,
    input: `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'manifest-launch-test', version: '1.0.0' },
      },
    })}\n`,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'local-ssh-deploy');
});

test('MCP server advertises the embedded editor and legacy form fallback', async (t) => {
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
    'save_profile',
    'pick_identity_file',
    'save_profile_with_form',
    'list_profiles',
  ]);
  const editorTool = listed.result.tools.find((tool) => tool.name === 'add_remote_server_connection');
  assert.equal(editorTool._meta.ui.resourceUri, editorUri);
  assert.equal(editorTool._meta['openai/outputTemplate'], editorUri);
  assert.match(editorTool.description, /system browser/);

  client.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'save_profile_with_form',
      arguments: { suggestedProfileName: 'production' },
    },
  });
  const elicitation = await client.receive();
  assert.equal(elicitation.method, 'elicitation/create');
  assert.equal(elicitation.params.mode, 'form');
  assert.equal(elicitation.params.requestedSchema.properties.profileName.default, 'production');
  assert.equal(elicitation.params.requestedSchema.properties.identityFilePath.title, '本机私钥绝对路径');
  assert.deepEqual(elicitation.params.requestedSchema.required, [
    'profileName', 'host', 'port', 'username', 'identityFilePath',
    'remoteDirectory', 'deploymentCommand', 'overwriteExisting',
  ]);

  client.send({
    jsonrpc: '2.0',
    id: elicitation.id,
    result: { action: 'cancel', content: null },
  });
  const cancelled = await client.receive();
  assert.equal(cancelled.id, 3);
  assert.equal(cancelled.result.isError, undefined);
  assert.match(cancelled.result.content[0].text, /cancelled/);
  assert.equal(fs.existsSync(path.join(item.localAppData, 'OpenAI', 'Codex', 'local-ssh-deploy', 'profiles.dat')), false);

  client.send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'save_profile_with_form', arguments: {} },
  });
  const policyForm = await client.receive();
  assert.equal(policyForm.method, 'elicitation/create');
  client.send({
    jsonrpc: '2.0',
    id: policyForm.id,
    result: { action: 'decline', content: null },
  });
  const declined = await client.receive();
  assert.equal(declined.id, 4);
  assert.equal(declined.result.isError, true);
  assert.match(declined.result.content[0].text, /permission policy.*Full Access/i);
});

test('MCP App resource has the intended field order and a path-only picker', async (t) => {
  const item = fixture();
  const client = startServer(item);
  t.after(() => {
    client.stop();
    fs.rmSync(item.root, { recursive: true, force: true });
  });
  await initialize(client);

  client.send({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} });
  const listed = await client.receive();
  assert.equal(listed.result.resources[0].uri, editorUri);
  assert.equal(listed.result.resources[0].mimeType, 'text/html;profile=mcp-app');

  client.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'resources/read',
    params: { uri: editorUri },
  });
  const resource = await client.receive();
  const content = resource.result.contents[0];
  assert.equal(content.mimeType, 'text/html;profile=mcp-app');
  assert.equal(content._meta.ui.prefersBorder, true);
  assert.equal(content.text, fs.readFileSync(editorPath, 'utf8'));
  assert.ok(content.text.indexOf('name="profileName"') < content.text.indexOf('name="host"'));
  assert.ok(content.text.indexOf('name="profileName"') < content.text.indexOf('name="deploymentCommand"'));
  assert.match(content.text, /id="pick-file"/);
  assert.match(content.text, /callTool\('pick_identity_file'/);
  assert.match(content.text, /location\.hostname === '127\.0\.0\.1'/);
  assert.doesNotMatch(content.text, /type="file"/);
  assert.doesNotMatch(content.text, /selectFiles|uploadFile/);

  client.send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'add_remote_server_connection', arguments: { suggestedProfileName: 'production' } },
  });
  const opened = await client.receive();
  assert.equal(opened.result.structuredContent.suggestedProfileName, 'production');
  assert.equal(opened.result.structuredContent.browserOpened, false);
  assert.match(opened.result.structuredContent.editorUrl, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/?\?suggestedProfileName=production$/);
  assert.equal(opened.result._meta.ui.resourceUri, editorUri);

  const editorResponse = await fetch(opened.result.structuredContent.editorUrl);
  assert.equal(editorResponse.status, 200);
  assert.match(editorResponse.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(editorResponse.headers.get('cache-control'), 'no-store');
  const editorHtml = await editorResponse.text();
  assert.equal(editorHtml, fs.readFileSync(editorPath, 'utf8'));

  const unknownAction = await fetch(new URL('tool/not_allowed', opened.result.structuredContent.editorUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(unknownAction.status, 404);

  const wrongOrigin = await fetch(opened.result.structuredContent.editorUrl, {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(wrongOrigin.status, 403);
});

test('Windows picker asks for a path without reading the selected file', { skip: process.platform !== 'win32' }, () => {
  const script = fs.readFileSync(pickerPath, 'utf8');
  assert.match(script, /OpenFileDialog/);
  assert.match(script, /GetFullPath/);
  assert.doesNotMatch(script, /Get-Content|ReadAll|OpenRead|ReadToEnd/);

  const parsed = spawnSync('pwsh.exe', [
    '-NoLogo', '-NoProfile', '-Command',
    `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${pickerPath.replaceAll("'", "''")}', [ref]$null, [ref]$errors) > $null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('accepted MCP form writes an encrypted profile without key contents', { skip: process.platform !== 'win32' }, async (t) => {
  const item = fixture();
  const client = startServer(item);
  t.after(() => {
    client.stop();
    fs.rmSync(item.root, { recursive: true, force: true });
  });
  await initialize(client);

  client.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'save_profile_with_form', arguments: {} },
  });
  const elicitation = await client.receive();
  client.send({
    jsonrpc: '2.0',
    id: elicitation.id,
    result: {
      action: 'accept',
      content: {
        profileName: 'production',
        host: 'deploy.example.com',
        port: 22,
        username: 'deploy',
        identityFilePath: item.identity,
        remoteDirectory: '/srv/www/example',
        deploymentCommand: 'npm ci && npm run build',
        overwriteExisting: false,
      },
    },
  });
  const saved = await client.receive();
  assert.equal(saved.id, 2);
  assert.equal(saved.result.isError, undefined);
  assert.equal(saved.result.structuredContent.profileName, 'production');
  assert.equal(saved.result.structuredContent.storeBackend, 'Windows DPAPI CurrentUser');

  const encrypted = fs.readFileSync(saved.result.structuredContent.storeLocation);
  assert.equal(encrypted.includes(Buffer.from('deploy.example.com')), false);
  assert.equal(encrypted.includes(Buffer.from(item.identity)), false);
  assert.equal(encrypted.includes(Buffer.from('PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR')), false);

  client.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_profiles', arguments: {} },
  });
  const listed = await client.receive();
  assert.deepEqual(listed.result.structuredContent.profiles, ['production']);
});

test('embedded editor can save directly in Full Access without elicitation', { skip: process.platform !== 'win32' }, async (t) => {
  const item = fixture();
  const client = startServer(item);
  t.after(() => {
    client.stop();
    fs.rmSync(item.root, { recursive: true, force: true });
  });

  client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'full-access-test', version: '1.0.0' },
    },
  });
  const initialized = await client.receive();
  assert.deepEqual(initialized.result.capabilities, { tools: {}, resources: {} });

  client.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'save_profile',
      arguments: {
        profileName: 'production',
        host: 'deploy.example.com',
        port: 22,
        username: 'deploy',
        identityFilePath: item.identity,
        remoteDirectory: '/srv/www/example',
        deploymentCommand: 'npm ci && npm run build',
        overwriteExisting: false,
      },
    },
  });
  const saved = await client.receive();
  assert.equal(saved.id, 2);
  assert.equal(saved.result.isError, undefined);
  assert.equal(saved.result.structuredContent.profileName, 'production');

  const encrypted = fs.readFileSync(saved.result.structuredContent.storeLocation);
  assert.equal(encrypted.includes(Buffer.from('deploy.example.com')), false);
  assert.equal(encrypted.includes(Buffer.from(item.identity)), false);
  assert.equal(encrypted.includes(Buffer.from('PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR')), false);
});
