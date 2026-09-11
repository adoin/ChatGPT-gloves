'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const deployScript = path.resolve(__dirname, '../plugins/local-ssh-deploy/scripts/deploy.ps1');
const profilesScript = path.resolve(__dirname, '../plugins/local-ssh-deploy/scripts/profiles.ps1');
const moduleScript = path.resolve(__dirname, '../plugins/local-ssh-deploy/scripts/LocalSshDeploy.psm1');
const pwshCommand = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const pwshProbe = spawnSync(pwshCommand, [
  '-NoLogo', '-NoProfile', '-Command', '(Get-Process -Id $PID).Path',
], { encoding: 'utf8' });
assert.equal(pwshProbe.status, 0, 'PowerShell 7 (pwsh) is required to run deployment tests.');
const pwsh = pwshProbe.stdout.trim();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ssh-deploy-test-'));
  const project = path.join(root, 'project');
  const identity = path.join(root, 'deploy_ed25519');
  const localAppData = path.join(root, 'local-app-data');
  fs.mkdirSync(project);
  fs.mkdirSync(localAppData);
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>hello</h1>', 'utf8');
  fs.writeFileSync(identity, 'PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR', 'utf8');
  return { root, project, identity, localAppData };
}

function testEnv(item, additions = {}) {
  return { ...process.env, LOCALAPPDATA: item.localAppData, ...additions };
}

function runDeploy(item, options = {}) {
  const {
    hostName = 'deploy.example.com',
    username = 'release_bot',
    identity = item.identity,
    remoteDirectory = '/srv/www/example',
    deploymentCommand = 'npm ci && npm run build',
    profileName,
    mode,
    planHash,
    cwd = item.project,
    env = testEnv(item),
  } = options;
  const connectionArgs = profileName
    ? ['-ProfileName', profileName]
    : [
      '-HostName', hostName,
      '-Port', '2222',
      '-Username', username,
      '-IdentityFilePath', identity,
      '-RemoteDirectory', remoteDirectory,
      '-DeploymentCommand', deploymentCommand,
    ];
  return spawnSync(pwsh, [
    '-NoLogo', '-NoProfile', '-File', deployScript,
    ...connectionArgs,
    ...(mode ? [mode] : []),
    ...(planHash ? ['-PlanHash', planHash] : []),
  ], { cwd, encoding: 'utf8', env });
}

function runProfiles(item, args) {
  return spawnSync(pwsh, [
    '-NoLogo', '-NoProfile', '-File', profilesScript, ...args,
  ], { cwd: item.root, encoding: 'utf8', env: testEnv(item) });
}

function saveProfile(item, profileName = 'production', extraArgs = []) {
  return runProfiles(item, [
    '-Save',
    '-ProfileName', profileName,
    '-HostName', 'deploy.example.com',
    '-Port', '2222',
    '-Username', 'release_bot',
    '-IdentityFilePath', item.identity,
    '-RemoteDirectory', '/srv/www/example',
    '-DeploymentCommand', 'npm ci && npm run build',
    ...extraArgs,
  ]);
}

test('the native macOS Keychain bridge compiles', () => {
  const result = spawnSync(pwsh, [
    '-NoLogo', '-NoProfile', '-Command',
    'Import-Module $env:LOCAL_SSH_DEPLOY_MODULE -Force; $module = Get-Module LocalSshDeploy; & $module { Initialize-MacKeychainBridge }',
  ], {
    encoding: 'utf8',
    env: { ...process.env, LOCAL_SSH_DEPLOY_MODULE: moduleScript },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('dry run validates and renders a hashed non-mutating deployment plan', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const result = runDeploy(item, { mode: '-DryRun', env: testEnv(item, { PATH: '' }) });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dryRun, true);
  assert.match(output.planHash, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(output.plan.projectRoot, 'index.html'), 'utf8'), '<h1>hello</h1>');
  assert.equal(output.plan.host, 'deploy.example.com');
  assert.equal(output.plan.port, 2222);
  assert.equal(output.plan.username, 'release_bot');
  assert.equal(output.plan.remoteDirectory, '/srv/www/example');
  assert.equal(output.plan.deploymentCommand, 'npm ci && npm run build');
  assert.deepEqual(output.plan.archiveExclusions, ['.git', '.codex']);
  assert.doesNotMatch(result.stdout, /PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR/);
});

test('real execution requires confirmation and the approved plan hash', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const unconfirmed = runDeploy(item);
  assert.notEqual(unconfirmed.status, 0);
  assert.match(unconfirmed.stderr, /Refusing to deploy without -ConfirmDeployment/);

  const missingHash = runDeploy(item, { mode: '-ConfirmDeployment' });
  assert.notEqual(missingHash.status, 0);
  assert.match(missingHash.stderr, /requires the 64-character -PlanHash/);

  const changedPlan = runDeploy(item, {
    mode: '-ConfirmDeployment',
    planHash: '0'.repeat(64),
    env: testEnv(item, { PATH: '' }),
  });
  assert.notEqual(changedPlan.status, 0);
  assert.match(changedPlan.stderr, /do not match the approved dry-run plan hash/);
});

test('rejects an identity file inside the project archive', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  item.identity = path.join(item.project, 'deploy_ed25519');
  fs.writeFileSync(item.identity, 'secret', 'utf8');

  const result = runDeploy(item, { mode: '-DryRun' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be outside the project directory/);
});

test('rejects remote path and command control-character injection', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const badPath = runDeploy(item, { remoteDirectory: '/srv/www;reboot', mode: '-DryRun' });
  assert.notEqual(badPath.status, 0);
  assert.match(badPath.stderr, /RemoteDirectory must be a non-root absolute POSIX path/);

  const badCommand = runDeploy(item, { deploymentCommand: 'npm ci\nreboot', mode: '-DryRun' });
  assert.notEqual(badCommand.status, 0);
  assert.match(badCommand.stderr, /must not contain control characters/);
});

test('rejects unsafe connection and local identity inputs', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const badHost = runDeploy(item, { hostName: '-oProxyCommand=calc', mode: '-DryRun' });
  assert.notEqual(badHost.status, 0);
  assert.match(badHost.stderr, /HostName must be a plain DNS name/);

  const badUser = runDeploy(item, { username: 'deploy@root', mode: '-DryRun' });
  assert.notEqual(badUser.status, 0);
  assert.match(badUser.stderr, /Username must start with/);

  const relativeIdentity = runDeploy(item, { identity: 'deploy_ed25519', mode: '-DryRun' });
  assert.notEqual(relativeIdentity.status, 0);
  assert.match(relativeIdentity.stderr, /IdentityFilePath must be an absolute/);
});

test('rejects ambiguous execution modes and remote filesystem root', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const direct = spawnSync(pwsh, [
    '-NoLogo', '-NoProfile', '-File', deployScript,
    '-HostName', 'deploy.example.com', '-Port', '22', '-Username', 'deploy',
    '-IdentityFilePath', item.identity, '-RemoteDirectory', '/srv/www/example',
    '-DeploymentCommand', 'true', '-DryRun', '-ConfirmDeployment',
  ], { cwd: item.project, encoding: 'utf8', env: testEnv(item) });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /Choose either -DryRun or -ConfirmDeployment/);

  const rootTarget = runDeploy(item, { remoteDirectory: '/', mode: '-DryRun' });
  assert.notEqual(rootTarget.status, 0);
  assert.match(rootTarget.stderr, /RemoteDirectory must be a non-root absolute POSIX path/);
});

test('encrypted profiles survive a deleted project and a new process', { skip: process.platform !== 'win32' }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  const saved = saveProfile(item);
  assert.equal(saved.status, 0, saved.stderr);
  const savedOutput = JSON.parse(saved.stdout);
  assert.equal(savedOutput.storeBackend, 'Windows DPAPI CurrentUser');
  assert.ok(savedOutput.storeLocation.startsWith(item.localAppData));

  const encrypted = fs.readFileSync(savedOutput.storeLocation);
  assert.equal(encrypted.includes(Buffer.from('deploy.example.com')), false);
  assert.equal(encrypted.includes(Buffer.from(item.identity)), false);
  assert.equal(encrypted.includes(Buffer.from('npm ci && npm run build')), false);
  const acl = spawnSync('icacls.exe', [savedOutput.storeLocation], { encoding: 'utf8' });
  assert.equal(acl.status, 0, acl.stderr);
  assert.doesNotMatch(acl.stdout, /\(I\)/, 'profile store must not inherit broader filesystem ACLs');

  fs.rmSync(item.project, { recursive: true, force: true });
  const listed = runProfiles(item, ['-List']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).profiles, ['production']);

  const shown = runProfiles(item, ['-Show', '-ProfileName', 'production']);
  assert.equal(shown.status, 0, shown.stderr);
  const shownOutput = JSON.parse(shown.stdout);
  assert.equal(shownOutput.connection.host, 'deploy.example.com');
  assert.equal(fs.readFileSync(shownOutput.connection.identityFilePath, 'utf8'), 'PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR');
  assert.doesNotMatch(shown.stdout, /PRIVATE-KEY-CONTENT-MUST-NOT-APPEAR/);

  const otherProject = path.join(item.root, 'another-project');
  fs.mkdirSync(otherProject);
  fs.writeFileSync(path.join(otherProject, 'site.txt'), 'new project', 'utf8');
  const plan = runDeploy(item, { profileName: 'production', mode: '-DryRun', cwd: otherProject });
  assert.equal(plan.status, 0, plan.stderr);
  const planOutput = JSON.parse(plan.stdout);
  assert.equal(planOutput.plan.profileName, 'production');
  assert.equal(planOutput.plan.host, 'deploy.example.com');
});

test('profile overwrite and deletion require explicit confirmation', { skip: process.platform !== 'win32' }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));

  assert.equal(saveProfile(item).status, 0);
  const overwrite = saveProfile(item);
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /already exists.*-ConfirmOverwrite/);
  assert.equal(saveProfile(item, 'production', ['-ConfirmOverwrite']).status, 0);

  const unconfirmedDelete = runProfiles(item, ['-Delete', '-ProfileName', 'production']);
  assert.notEqual(unconfirmedDelete.status, 0);
  assert.match(unconfirmedDelete.stderr, /without -ConfirmDelete/);

  const deleted = runProfiles(item, ['-Delete', '-ProfileName', 'production', '-ConfirmDelete']);
  assert.equal(deleted.status, 0, deleted.stderr);
  const listed = runProfiles(item, ['-List']);
  assert.deepEqual(JSON.parse(listed.stdout).profiles, []);
});
