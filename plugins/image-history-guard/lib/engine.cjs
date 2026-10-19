'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');

class FilterEngine {
  constructor(root, options) {
    this.pending = new Map(); this.sequence = 0; this.queuedBytes = 0; this.failed = false;
    this.worker = new Worker(path.join(__dirname, 'filter-worker.cjs'), { workerData: { root, options } });
    this.worker.on('message', ({ id, result, failed }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id); this.queuedBytes -= pending.bytes; clearTimeout(pending.timer);
      pending.resolve(failed ? null : result);
    });
    const fail = () => {
      this.failed = true;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.resolve(null); }
      this.pending.clear(); this.queuedBytes = 0;
    };
    this.worker.on('error', fail); this.worker.on('exit', fail);
  }
  call(operation, args = {}) {
    const bytes = args.buffer?.length || 0;
    if (this.failed || this.pending.size >= 64 || this.queuedBytes + bytes > 256 * 1024 * 1024) return Promise.resolve(null);
    const id = ++this.sequence;
    return new Promise(resolve => {
      // Do not allow a late worker result to seed context after a timed-out,
      // unfiltered request. A timeout disables this worker until proxy restart.
      const timer = setTimeout(() => { this.worker.terminate(); }, 15000);
      this.pending.set(id, { resolve, timer, bytes }); this.queuedBytes += bytes;
      this.worker.postMessage({ id, operation, ...args });
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
  close() { this.failed = true; return this.worker.terminate(); }
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
