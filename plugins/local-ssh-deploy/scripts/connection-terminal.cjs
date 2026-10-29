#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readStore, connectionAlias, storeInfo } = require('../mcp/server.cjs');
const alias = process.argv[2];
if (!/^codex-[a-f0-9]{24}$/.test(alias || '')) throw new Error('Invalid connection handle.');
const connection = Object.entries(readStore().connections).find(([name]) => connectionAlias(name) === alias)?.[1];
if (!connection) throw new Error('Saved connection not found.');
const result = connection.authType === 'password'
  ? spawnSync(process.execPath, [path.join(__dirname, 'ssh-password.cjs'), alias, 'connect'], { stdio: 'inherit' })
  : spawnSync('ssh.exe', ['-F', storeInfo().sshConfigFile, '-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask',
    '-o', 'UpdateHostKeys=no', alias, 'exit'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
if (result.error) console.error('Could not start SSH connection.');
