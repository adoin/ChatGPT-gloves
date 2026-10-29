#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { readStore, connectionAlias } = require('../mcp/server.cjs');
const credentials = require('../mcp/credentials.cjs');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');

function knownHostFiles() {
  const systemRoot = process.platform === 'win32' ? path.join(process.env.PROGRAMDATA || 'C:/ProgramData', 'ssh') : '/etc/ssh';
  return [path.join(os.homedir(), '.ssh/known_hosts'), path.join(os.homedir(), '.ssh/known_hosts2'), path.join(systemRoot, 'ssh_known_hosts')];
}

function knownKeys(host, port, files) {
  const lookup = port === 22 ? host : `[${host}]:${port}`;
  const allowed = new Set(), revoked = new Set();
  let recordsPresent = false;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const result = spawnSync('ssh-keygen', ['-F', lookup, '-f', file], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
    if (result.error || ![0, 1].includes(result.status)) throw new Error('Could not read trusted SSH host keys.');
    for (const line of result.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (line.startsWith('#') || parts.length < 3) continue;
      recordsPresent = true;
      if (parts[0] === '@revoked') revoked.add(parts[3]);
      else if (!parts[0].startsWith('@')) allowed.add(parts[2]);
    }
  }
  const classify = key => revoked.has(key.toString('base64')) ? 'revoked' : allowed.has(key.toString('base64')) ? 'trusted' : recordsPresent ? 'changed' : 'unknown';
  const verify = key => classify(key) === 'trusted';
  verify.classify = classify;
  return verify;
}

async function confirmHost(connection, key, files, ask) {
  const state = knownKeys(connection.host, connection.port, files).classify(key);
  if (state === 'trusted') return true;
  if (state !== 'unknown') throw new Error(`SSH_HOST_KEY_${state.toUpperCase()}: existing trust must be reviewed; no entry was removed.`);
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  const length = key.readUInt32BE(0);
  const algorithm = key.subarray(4, 4 + length).toString('ascii');
  if (!/^[a-zA-Z0-9@._+-]+$/.test(algorithm) || length > 128) throw new Error('Invalid SSH host key.');
  const answer = await ask(`Host: ${connection.host}:${connection.port}\n${algorithm} fingerprint: ${fingerprint}\nVerify this fingerprint with your server provider. Trust this host? (yes/no): `);
  if (answer.trim().toLowerCase() !== 'yes') return false;
  const target = files[0];
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const lock = target + '.codex-trust.lock';
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    const current = knownKeys(connection.host, connection.port, files).classify(key);
    if (current === 'trusted') return true;
    if (current !== 'unknown') throw new Error('SSH host trust changed while confirmation was pending.');
    const lookup = connection.port === 22 ? connection.host : `[${connection.host}]:${connection.port}`;
    fs.appendFileSync(target, `\n${lookup} ${algorithm} ${key.toString('base64')}\n`, { mode: 0o600 });
    return true;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

async function run(alias, action, args) {
  if (!/^codex-[a-f0-9]{24}$/.test(alias || '') || !['exec', 'upload', 'download', 'connect'].includes(action) ||
      args.length !== (action === 'connect' ? 0 : action === 'exec' ? 1 : 2) || args.some(x => !x || x.includes('\0')))
    throw new Error('Usage: node ssh-password.cjs ALIAS exec "COMMAND" | upload LOCAL REMOTE | download REMOTE LOCAL');
  const connection = Object.entries(readStore().connections).find(([name]) => connectionAlias(name) === alias)?.[1];
  if (connection?.authType !== 'password') throw new Error('Saved password connection not found.');
  if (action === 'connect' && !process.stdin.isTTY) throw new Error('Host confirmation requires an interactive terminal.');
  const files = knownHostFiles();
  const verify = knownKeys(connection.host, connection.port, files);
  const { Client } = require('ssh2');
  const client = new Client();
  let untrusted = false;
  let trustError;
  let passwordAttempted = false;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code = 0) => {
      if (settled) return;
      settled = true;
      client.end();
      if (error) reject(error); else resolve(code);
    };
    client.once('error', error => finish(new Error(trustError || (untrusted ? 'SSH host key is unknown, changed or revoked. Open the connection terminal to review its fingerprint.' :
      error.level === 'client-authentication' ? 'SSH password authentication failed. Edit the saved connection.' : 'SSH connection or transport failed.'))));
    client.once('close', () => { if (!settled) finish(new Error('SSH connection closed before the operation completed.')); });
    client.once('ready', () => {
      if (action === 'connect') return finish(null);
      if (action === 'exec') {
        client.exec(args[0], (error, stream) => {
          if (error) return finish(new Error('SSH command could not be started.'));
          stream.pipe(process.stdout, { end: false });
          stream.stderr.pipe(process.stderr, { end: false });
          stream.once('close', code => finish(null, Number.isInteger(code) ? code : 1));
          stream.once('error', () => finish(new Error('SSH command stream failed.')));
        });
      } else {
        client.sftp((error, sftp) => {
          if (error) return finish(new Error('Could not open the SSH file-transfer session.'));
          const callback = error => finish(error ? new Error('SSH file transfer failed.') : null);
          if (action === 'upload') sftp.fastPut(path.resolve(args[0]), args[1], callback);
          else sftp.fastGet(args[0], path.resolve(args[1]), callback);
        });
      }
    });
    client.connect({ host: connection.host, port: connection.port, username: connection.username,
      authHandler: () => {
        if (passwordAttempted) return false;
        passwordAttempted = true;
        try { return { type: 'password', username: connection.username, password: credentials.get(connection.passwordRef) }; }
        catch { trustError = 'Saved password is unavailable. Edit the connection and save its password again.'; return false; }
      },
      hostVerifier: action === 'connect' ? (key, callback) => {
        const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
        confirmHost(connection, key, files, message => prompt.question(message)).then(accepted => {
          prompt.close(); untrusted = !accepted; callback(accepted);
        }).catch(error => { prompt.close(); trustError = error.message; callback(false); });
      } : key => { const trusted = verify(key); untrusted = !trusted; return trusted; },
      readyTimeout: action === 'connect' ? 0 : 20000, keepaliveInterval: 15000, keepaliveCountMax: 3 });
  });
}
if (require.main === module) {
  const [alias, action, ...args] = process.argv.slice(2);
  run(alias, action, args).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
module.exports = { knownKeys, confirmHost };
