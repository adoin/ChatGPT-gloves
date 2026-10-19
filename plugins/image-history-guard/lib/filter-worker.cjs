'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { SessionFilter, compactionOutput } = require('./filter.cjs');
const filter = new SessionFilter(workerData.root, workerData.options);
const waiting = new Map();
const active = new Map();
function streamKey(connection, stream) { return `${connection}:${stream || ''}`; }

parentPort.on('message', message => {
  const { id, operation } = message;
  try {
    let result = {};
    if (operation === 'prepare') {
      const original = Buffer.from(message.buffer);
      result = filter.prepare(original, message.context);
      result.changed = result.buffer !== original;
      if (result.ticket && message.context.websocket) {
        const key = streamKey(message.context.connection, result.streamId);
        const queue = waiting.get(key) || [];
        queue.push(result.ticket); waiting.set(key, queue);
      }
    } else if (operation === 'observe') {
      const event = JSON.parse(Buffer.from(message.buffer).toString('utf8'));
      const connection = message.connection;
      const key = streamKey(connection, event.stream_id);
      const responseId = event.response?.id || event.response_id;
      if (event.type === 'response.created' && responseId) {
        const queue = waiting.get(key) || [];
        const ticket = message.ticket || queue.shift();
        if (!queue.length) waiting.delete(key);
        if (ticket) active.set(`${connection}:${responseId}`, { ticket, compacted: false, streamKey: key });
        while (active.size > 256) { const oldest = active.keys().next().value; filter.fail(active.get(oldest).ticket); active.delete(oldest); }
      }
      const candidates = [...active].filter(([activeKey, item]) => activeKey.startsWith(`${connection}:`) && item.streamKey === key);
      const record = active.get(`${connection}:${responseId}`) || (message.ticket ? { ticket: message.ticket, compacted: false } :
        !responseId && candidates.length === 1 ? candidates[0][1] : null);
      if (record && event.type === 'response.output_item.done') filter.noteOutput(record.ticket, event.item);
      if (record && compactionOutput(event)) record.compacted = true;
      if (record && event.type === 'response.completed' && event.response?.status === 'completed') {
        for (const item of event.response.output || []) filter.noteOutput(record.ticket, item);
        filter.complete(record.ticket, responseId, record.compacted || compactionOutput(event));
        active.delete(`${connection}:${responseId}`);
        const usage = event.response.usage || {};
        result.usage = { inputTokens: Number(usage.input_tokens || 0), cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens || 0),
          outputTokens: Number(usage.output_tokens || 0) };
      } else if (record && ['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
        filter.fail(record.ticket); active.delete(`${connection}:${responseId}`);
      }
      if (event.type === 'error' && (!responseId || !record)) {
        // An error without a created response must not leave a stale queue head
        // that could attribute the next success to a different request.
        for (const [waitingKey, queue] of waiting) if (waitingKey.startsWith(`${connection}:`) &&
          (!event.stream_id || waitingKey === key)) {
          for (const ticket of queue) filter.fail(ticket); waiting.delete(waitingKey);
        }
        for (const [activeKey, item] of active) if (activeKey.startsWith(`${connection}:`) &&
          (!event.stream_id || item.streamKey === key)) {
          filter.fail(item.ticket); active.delete(activeKey);
        }
      }
      // Mid-stream compaction output events sometimes omit response_id.
      if (compactionOutput(event.item)) for (const [activeKey, item] of active) if (activeKey.startsWith(`${connection}:`)) item.compacted = true;
    } else if (operation === 'close') {
      for (const [key, queue] of waiting) if (key.startsWith(`${message.connection}:`)) {
        for (const ticket of queue) filter.fail(ticket); waiting.delete(key);
      }
      for (const [key, item] of active) if (key.startsWith(`${message.connection}:`)) {
        filter.fail(item.ticket); active.delete(key);
      }
    } else if (operation === 'fail') filter.fail(message.ticket);
    else if (operation === 'stats') result = filter.store.stats();
    parentPort.postMessage({ id, result });
  } catch {
    // No raw parsing errors: those may include image or prompt contents.
    parentPort.postMessage({ id, failed: true });
  }
});
