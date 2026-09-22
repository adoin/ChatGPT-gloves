'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { prepareSpawn } = require('./spawn-command.cjs');

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readStatus(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already stopped */ }
  }
}

function finish(statusPath, changes) {
  let current;
  try {
    current = readStatus(statusPath);
  } catch {
    current = {};
  }
  atomicWrite(statusPath, { ...current, ...changes, finishedAt: new Date().toISOString(), workerPid: null, processPid: null });
}

function main() {
  const statusPath = process.argv[2];
  if (!statusPath || !path.isAbsolute(statusPath)) process.exit(2);
  const jobDirectory = path.dirname(statusPath);
  const specPath = path.join(jobDirectory, 'spec.json');
  const stdoutPath = path.join(jobDirectory, 'stdout.log');
  const stderrPath = path.join(jobDirectory, 'stderr.log');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const stdoutFd = fs.openSync(stdoutPath, 'a', 0o600);
  const stderrFd = fs.openSync(stderrPath, 'a', 0o600);
  const childEnvironment = { ...process.env, TEST_GATE_JOB_ID: spec.jobId };
  const invocation = prepareSpawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: childEnvironment,
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: spec.cwd,
    env: childEnvironment,
    detached: process.platform !== 'win32',
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  atomicWrite(statusPath, {
    ...readStatus(statusPath),
    status: 'running',
    startedAt: new Date().toISOString(),
    workerPid: process.pid,
    processPid: child.pid,
    resolvedExecutable: invocation.resolvedExecutable,
    invocationMode: invocation.via,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, spec.timeoutMs);
  timer.unref();

  const cancellationPoll = setInterval(() => {
    try {
      if (readStatus(statusPath).cancelRequestedAt) killTree(child);
    } catch {
      // A transient read failure should not terminate the test process.
    }
  }, 750);
  cancellationPoll.unref();

  child.on('error', (error) => {
    clearTimeout(timer);
    clearInterval(cancellationPoll);
    fs.writeSync(stderrFd, `\nTest Gate could not start the process: ${error.message}\n`);
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    finish(statusPath, { status: 'failed', exitCode: null, signal: null, error: error.message });
  });

  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    clearInterval(cancellationPoll);
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    let current = {};
    try { current = readStatus(statusPath); } catch { /* use empty status */ }
    const cancelled = Boolean(current.cancelRequestedAt);
    finish(statusPath, {
      status: timedOut ? 'timed-out' : cancelled ? 'cancelled' : code === 0 ? 'passed' : 'failed',
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal || null,
      timedOut,
    });
  });
}

try {
  main();
} catch (error) {
  try {
    const statusPath = process.argv[2];
    if (statusPath && path.isAbsolute(statusPath) && fs.existsSync(statusPath)) {
      const stderrPath = path.join(path.dirname(statusPath), 'stderr.log');
      try { fs.appendFileSync(stderrPath, `\nTest Gate could not start the process: ${error.message}\n`, 'utf8'); } catch { /* status still records the error */ }
      finish(statusPath, { status: 'failed', exitCode: null, signal: null, error: error.message });
    }
  } finally {
    process.exitCode = 1;
  }
}
