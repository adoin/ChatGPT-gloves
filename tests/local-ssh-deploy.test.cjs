'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.resolve(__dirname, '../plugins/local-ssh-deploy/scripts/deploy.ps1');
const wherePwsh = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8' });
assert.equal(wherePwsh.status, 0, 'PowerShell 7 (pwsh.exe) is required to run deployment tests.');
const pwsh = wherePwsh.stdout.trim().split(/\r?\n/)[0];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ssh-deploy-test-'));
  const project = path.join(root, 'project');
  const identity = path.join(root, 'deploy_ed25519');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>hello</h1>', 'utf8');
  fs.writeFileSync(identity, 'PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR', 'utf8');
  return { root, project, identity };
}

function run(item, options = {}) {
  const {
    hostName = 'deploy.example.com',
    username = 'release_bot',
    identity = item.identity,
    remoteDirectory = '/srv/www/example',
    deploymentCommand = 'npm ci && npm run build',
    mode,
    env = process.env,
  } = options;
  return spawnSync(pwsh, [
    '-NoLogo',
    '-NoProfile',
    '-File', script,
    '-HostName', hostName,
    '-Port', '2222',
    '-Username', username,
    '-IdentityFilePath', identity,
    '-RemoteDirectory', remoteDirectory,
    '-DeploymentCommand', deploymentCommand,
    ...(mode ? [mode] : []),
  ], {
    cwd: item.project,
    encoding: 'utf8',
    env,
  });
}

test('dry run validates and renders a non-mutating deployment plan', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const result = run(item, { mode: '-DryRun', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(fs.readFileSync(path.join(plan.projectRoot, 'index.html'), 'utf8'), '<h1>hello</h1>');
  assert.equal(plan.destination, 'release_bot@deploy.example.com:2222');
  assert.equal(plan.remoteDirectory, '/srv/www/example');
  assert.equal(plan.deploymentCommand, 'npm ci && npm run build');
  assert.deepEqual(plan.archiveExclusions, ['.git', '.codex']);
  assert.doesNotMatch(result.stdout, /PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR/);
});

test('real execution is refused without the confirmation flag', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const result = run(item);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to deploy without -ConfirmDeployment/);
});

test('rejects an identity file inside the project archive', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  item.identity = path.join(item.project, 'deploy_ed25519');
  fs.writeFileSync(item.identity, 'secret', 'utf8');

  const result = run(item, { mode: '-DryRun' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be outside the project directory/);
});

test('rejects remote path and command control-character injection', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const badPath = run(item, { remoteDirectory: '/srv/www;reboot', mode: '-DryRun' });
  assert.notEqual(badPath.status, 0);
  assert.match(badPath.stderr, /RemoteDirectory must be a non-root absolute POSIX path/);

  const badCommand = run(item, { deploymentCommand: 'npm ci\nreboot', mode: '-DryRun' });
  assert.notEqual(badCommand.status, 0);
  assert.match(badCommand.stderr, /must not contain control characters/);
});

test('rejects unsafe connection and local identity inputs', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const badHost = run(item, { hostName: '-oProxyCommand=calc.exe', mode: '-DryRun' });
  assert.notEqual(badHost.status, 0);
  assert.match(badHost.stderr, /HostName must be a plain DNS name/);

  const badUser = run(item, { username: 'deploy@root', mode: '-DryRun' });
  assert.notEqual(badUser.status, 0);
  assert.match(badUser.stderr, /Username must start with/);

  const relativeIdentity = run(item, { identity: 'deploy_ed25519', mode: '-DryRun' });
  assert.notEqual(relativeIdentity.status, 0);
  assert.match(relativeIdentity.stderr, /IdentityFilePath must be an absolute/);
});

test('rejects ambiguous execution modes and remote filesystem root', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const bothModes = run(item, { mode: '-DryRun' });
  const direct = spawnSync(pwsh, [
    '-NoLogo', '-NoProfile', '-File', script,
    '-HostName', 'deploy.example.com', '-Port', '22', '-Username', 'deploy',
    '-IdentityFilePath', item.identity, '-RemoteDirectory', '/srv/www/example',
    '-DeploymentCommand', 'true', '-DryRun', '-ConfirmDeployment',
  ], { cwd: item.project, encoding: 'utf8' });
  assert.equal(bothModes.status, 0, bothModes.stderr);
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /Choose either -DryRun or -ConfirmDeployment/);

  const rootTarget = run(item, { remoteDirectory: '/', mode: '-DryRun' });
  assert.notEqual(rootTarget.status, 0);
  assert.match(rootTarget.stderr, /RemoteDirectory must be a non-root absolute POSIX path/);
});
