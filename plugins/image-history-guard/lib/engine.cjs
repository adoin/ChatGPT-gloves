'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');

class FilterEngine {
  constructor(root, options, recovery = {}) {
    this.root = root; this.options = options;
    this.pending = new Map(); this.sequence = 0; this.queuedBytes = 0;
    this.failed = false; this.ready = false; this.closed = false;
    this.generation = 0; this.restarts = 0; this.lastError = null;
    this.recovery = { requestTimeoutMs: 15000, startupTimeoutMs: 60000, readyWaitMs: 2000,
      restartDelayMs: 1000, maxRestarts: 3, workerPath: path.join(__dirname, 'filter-worker.cjs'),
      onDiagnostic: () => {}, ...recovery };
    this.startWorker();
  }
  diagnostic(event) {
    try { this.recovery.onDiagnostic(event); } catch { /* diagnostics fail open */ }
  }
  startWorker() {
    if (this.closed) return;
    this.generation++; this.ready = false;
    this.worker = null;
    let worker;
    try { worker = new Worker(this.recovery.workerPath, { workerData: { root: this.root, options: this.options } }); }
    catch (error) { this.failWorker(null, 'worker_start_error', error.code || error.name); return; }
    this.worker = worker;
    this.startupTimer = setTimeout(() => this.failWorker(worker, 'startup_timeout', 'STARTUP_TIMEOUT'), this.recovery.startupTimeoutMs);
    worker.on('message', ({ ready, id, result, failed }) => {
      if (worker !== this.worker || this.closed) return;
      if (ready) {
        clearTimeout(this.startupTimer); this.ready = true; this.failed = false;
        this.diagnostic({ event: 'worker_ready', generation: this.generation, restart: this.restarts });
        for (const item of this.pending.values()) if (!item.posted) this.dispatch(item);
        return;
      }
      const item = this.pending.get(id);
      if (!item) return;
      this.settle(id, failed ? null : result);
    });
    worker.on('error', error => this.failWorker(worker, 'worker_error', error.code || error.name));
    worker.on('exit', code => this.failWorker(worker, 'worker_exit', String(code)));
  }
  failWorker(worker, kind, code, operation) {
    if (this.closed || worker !== this.worker) return;
    clearTimeout(this.startupTimer);
    this.worker = null; this.ready = false; this.failed = true;
    this.lastError = { at: new Date().toISOString(), kind, code: String(code).slice(0, 96), ...(operation ? { operation } : {}) };
    this.diagnostic({ event: 'worker_failed', ...this.lastError, generation: this.generation, restart: this.restarts });
    for (const id of [...this.pending.keys()]) this.settle(id, null);
    if (worker) worker.terminate();
    if (this.restarts < this.recovery.maxRestarts) {
      this.restarts++;
      this.restartTimer = setTimeout(() => { this.restartTimer = null; this.startWorker(); }, this.recovery.restartDelayMs);
    }
  }
  settle(id, result) {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id); this.queuedBytes -= item.bytes;
    clearTimeout(item.timer); item.resolve(result);
  }
  dispatch(item) {
    if (!this.ready || !this.worker || item.posted || !this.pending.has(item.id)) return;
    item.posted = true; clearTimeout(item.timer);
    const worker = this.worker;
    item.timer = setTimeout(() => this.failWorker(worker, 'request_timeout', 'REQUEST_TIMEOUT', item.operation), this.recovery.requestTimeoutMs);
    try { worker.postMessage({ id: item.id, operation: item.operation, ...item.args }); }
    catch (error) { this.failWorker(worker, 'worker_send_error', error.code || error.name, item.operation); }
  }
  call(operation, args = {}) {
    const bytes = args.buffer?.length || 0;
    if (this.closed || !this.worker || (operation === 'stats' && !this.ready) || this.pending.size >= 64 ||
      this.queuedBytes + bytes > 256 * 1024 * 1024) return Promise.resolve(null);
    const id = ++this.sequence;
    return new Promise(resolve => {
      // A short startup grace is separate from the processing deadline. If it
      // expires, forward the original without ever dispatching this transaction.
      const item = { id, resolve, bytes, operation, args, posted: false,
        timer: setTimeout(() => this.settle(id, null), this.recovery.readyWaitMs) };
      this.pending.set(id, item); this.queuedBytes += bytes;
      if (this.ready) this.dispatch(item);
    });
  }
  async prepare(buffer, context) {
    const result = await this.call('prepare', { buffer, context });
    return result ? { ...result, buffer: result.changed ? Buffer.from(result.buffer) : buffer } : { buffer, stats: { filterBypassed: true } };
  }
  observe(connection, buffer, ticket) { return this.call('observe', { connection, buffer, ticket }); }
  closeConnection(connection) { return this.call('close', { connection }); }
  fail(ticket) { return this.call('fail', { ticket }); }
  stats() { return this.call('stats'); }
  status() {
    return { workerFiltering: this.ready && !this.closed,
      workerState: this.closed ? 'stopped' : this.ready ? 'ready' : this.worker ? 'starting' : this.restartTimer ? 'recovering' : 'disabled',
      workerRestarts: this.restarts, lastWorkerError: this.lastError };
  }
  async close() {
    this.closed = true; this.ready = false;
    clearTimeout(this.startupTimer); clearTimeout(this.restartTimer);
    for (const id of [...this.pending.keys()]) this.settle(id, null);
    const worker = this.worker; this.worker = null;
    if (worker) await worker.terminate();
  }
}

// Parse only bounded SSE event lines. The HTTP stream itself is never changed.
class EventObserver {
  constructor(onEvent, limit = 2 * 1024 * 1024) {
    this.onEvent = onEvent; this.limit = limit; this.buffer = ''; this.skipping = false;
  }
  push(chunk) {
    const text = chunk.toString('utf8');
    for (const fragment of text.split(/(?<=\n)/)) {
      if (!this.skipping) this.buffer += fragment;
      if (this.buffer.length > this.limit) { this.buffer = ''; this.skipping = true; }
      if (fragment.endsWith('\n')) {
        if (!this.skipping && this.buffer.startsWith('data:')) {
          const data = this.buffer.slice(5).trim();
          if (data && data !== '[DONE]') this.onEvent(Buffer.from(data));
        }
        this.buffer = ''; this.skipping = false;
      }
    }
  }
}
module.exports = { FilterEngine, EventObserver };
