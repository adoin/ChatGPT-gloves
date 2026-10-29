#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { readStore, connectionAlias } = require('../mcp/server.cjs');
const credentials = require('../mcp/credentials.cjs');

function knownKeys(host, port, files) {
  const lookup = port === 22 ? host : `[${host}]:${port}`;
  const allowed = new Set(), revoked = new Set();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const result = spawnSync('ssh-keygen', ['-F', lookup, '-f', file], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
    if (result.error || ![0, 1].includes(result.status)) throw new Error('Could not read trusted SSH host keys.');
    for (const line of result.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (line.startsWith('#') || parts.length < 3) continue;
      if (parts[0] === '@revoked') revoked.add(parts[3]);
      else if (!parts[0].startsWith('@')) allowed.add(parts[2]);
    }
  }
  return key => allowed.has(key.toString('base64')) && !revoked.has(key.toString('base64'));
}

async function run(alias, action, args) {
  if (!/^codex-[a-f0-9]{24}$/.test(alias || '') || !['exec', 'upload', 'download'].includes(action) ||
      args.length !== (action === 'exec' ? 1 : 2) || args.some(x => !x || x.includes('\0')))
    throw new Error('Usage: node ssh-password.cjs ALIAS exec "COMMAND" | upload LOCAL REMOTE | download REMOTE LOCAL');
  const connection = Object.entries(readStore().connections).find(([name]) => connectionAlias(name) === alias)?.[1];
  if (connection?.authType !== 'password') throw new Error('Saved password connection not found.');
  const systemRoot = process.platform === 'win32' ? path.join(process.env.PROGRAMDATA || 'C:/ProgramData', 'ssh') : '/etc/ssh';
  const files = [path.join(os.homedir(), '.ssh/known_hosts'), path.join(os.homedir(), '.ssh/known_hosts2'), path.join(systemRoot, 'ssh_known_hosts')];
  const verify = knownKeys(connection.host, connection.port, files);
  const { Client } = require('ssh2');
  const client = new Client();
  let untrusted = false;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code = 0) => {
      if (settled) return;
      settled = true;
      client.end();
      if (error) reject(error); else resolve(code);
    };
    client.once('error', error => finish(new Error(untrusted ? 'SSH host key is unknown, changed or revoked. Verify its fingerprint and add it through a trusted process before retrying.' :
      error.level === 'client-authentication' ? 'SSH password authentication failed. Edit the saved connection.' : 'SSH connection or transport failed.')));
    client.once('close', () => { if (!settled) finish(new Error('SSH connection closed before the operation completed.')); });
    client.once('ready', () => {
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
      password: credentials.get(connection.passwordRef), authHandler: ['password'],
      hostVerifier: key => { const trusted = verify(key); untrusted = !trusted; return trusted; },
      readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3 });
  });
}
if (require.main === module) {
  const [alias, action, ...args] = process.argv.slice(2);
  run(alias, action, args).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
module.exports = { knownKeys };
