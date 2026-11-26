#!/usr/bin/env node
// Maintainer command only. Runtime queries never contact GitHub.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function githubClient({ spawn = spawnSync, request = fetch } = {}) {
  const run = args => spawn('gh', args, { encoding: null, windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  const version = run(['--version']);
  let authenticated = false;
  if (version.error?.code !== 'ENOENT') {
    if (version.error || version.status !== 0) throw new Error('GitHub CLI could not run.');
    const auth = run(['auth', 'status', '--hostname', 'github.com']);
    if (!auth.error && auth.status === 0) authenticated = true;
    else if (auth.error || !/not logged|no accounts|gh auth login|invalid token|token.*invalid/i.test(String(auth.stderr)))
      throw new Error(`GitHub authentication check failed: ${String(auth.stderr).trim()}`);
  }
  return async file => {
    if (file.private && !authenticated) throw new Error('Synchronizing the canonical skill requires gh auth login.');
    if (authenticated) {
      const args = file.assetId
        ? ['api', `repos/${file.repository}/releases/assets/${file.assetId}`, '-H', 'Accept: application/octet-stream']
        : ['api', `repos/${file.repository}/contents/${file.source}?ref=${file.revision}`];
      const result = run(args);
      if (result.error || result.status !== 0)
        throw new Error(`Authenticated GitHub request failed (${file.target}): ${String(result.stderr).trim() || result.error?.message}. No anonymous retry was made.`);
      return file.assetId ? Buffer.from(result.stdout) : Buffer.from(JSON.parse(String(result.stdout)).content, 'base64');
    }
    const url = file.assetId ? file.downloadUrl
      : `https://api.github.com/repos/${file.repository}/contents/${file.source}?ref=${file.revision}`;
    const response = await request(url, { headers: { 'User-Agent': 'chatgpt-gloves-fgda-sync', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Public GitHub request returned HTTP ${response.status}; check connectivity/limits or run gh auth login.`);
    return file.assetId ? Buffer.from(await response.arrayBuffer()) : Buffer.from((await response.json()).content, 'base64');
  };
}

export function targetPath(relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root) || !relative || path.isAbsolute(relative)) throw new Error('Invalid upstream target path.');
  return resolved;
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] || '--check';
  if (argv.length > 1 || !['--check', '--sync', '--record-hashes'].includes(mode))
    throw new Error('Usage: node scripts/sync-upstream.mjs [--check|--sync|--record-hashes]');
  const lockFile = path.join(root, 'upstream-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  if (!lock.files.length) throw new Error('No pinned files are configured.');
  if (mode === '--check') {
    for (const file of lock.files) if (sha256(fs.readFileSync(targetPath(file.target))) !== file.sha256)
      throw new Error(`Pinned content differs: ${file.target}`);
    console.log(`Verified ${lock.files.length} pinned upstream files.`);
    return;
  }
  const read = githubClient();
  // Fetch and validate everything before touching the installed snapshot.
  const downloaded = [];
  for (const file of lock.files) {
    const bytes = await read(file);
    const digest = sha256(bytes);
    if (file.sha256 && file.sha256 !== digest) throw new Error(`Upstream checksum mismatch: ${file.target}`);
    if (!file.sha256 && mode !== '--record-hashes') throw new Error(`Missing checksum: ${file.target}`);
    downloaded.push({ file, bytes, digest });
  }
  for (const { file, bytes, digest } of downloaded) {
    const target = targetPath(file.target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    file.sha256 = digest;
  }
  if (mode === '--record-hashes') fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  console.log(`Synchronized ${downloaded.length} pinned upstream files.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
