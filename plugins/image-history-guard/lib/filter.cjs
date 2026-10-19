'use strict';
const { randomBytes } = require('node:crypto');
const { resolveIdentity } = require('./identity.cjs');
const { ImageStore } = require('./image-store.cjs');

function contentField(item) {
  if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) return 'output';
  if ((!item?.type || item.type === 'message') && item.role === 'user') return 'content';
  return null;
}
function anchor(id, file) {
  return `[Image History Guard: ${id}; original image follows. Local copy: ${file}. If the image is no longer visible in context, use view_image on that exact local path before judging its pixels.]`;
}
function reference(id, file) {
  return `[Image History Guard: reference ${id}; identical to its earlier image in this response chain. Preserve prior observations. If the original is not visible, use view_image on ${file} before judging its pixels.]`;
}
const textPart = text => ({ type: 'input_text', text });
function compactionOutput(payload) {
  return ['compaction', 'context_compaction'].includes(payload?.type) ||
    payload?.response?.output?.some(item => ['compaction', 'context_compaction'].includes(item.type));
}

class SessionFilter {
  constructor(root, options = {}) {
    this.store = new ImageStore(root, options);
    this.responses = new Map();
    this.pending = new Map();
  }
  prepare(buffer, { headers = {}, upstream = '', websocket = false, compact = false } = {}) {
    let payload;
    try { payload = JSON.parse(buffer.toString('utf8')); } catch { return { buffer, stats: null }; }
    if ((websocket && payload?.type !== 'response.create') || !Array.isArray(payload?.input)) return { buffer, stats: null };
    const identity = websocket && !payload.client_metadata?.thread_id ? null : resolveIdentity(payload, headers, upstream);
    const stats = { images: 0, removedImages: 0, restoredImages: 0, inlineBytes: 0, removedInlineBytes: 0, hashCacheHits: 0,
      incremental: Boolean(payload.previous_response_id), scopeSkipped: !identity, unknownLineage: false };
    if (!identity) return { buffer, stats };
    const scope = identity.scope;
    const lineageKey = id => `${scope}:${id}`;
    if (compact) {
      // Normal Codex summary owns context replacement. Do not alter its input.
      for (const key of this.responses.keys()) if (key.startsWith(`${scope}:`)) this.responses.delete(key);
      return { buffer, stats: { ...stats, compactionBypass: true } };
    }
    const ancestor = payload.previous_response_id ? this.responses.get(lineageKey(payload.previous_response_id)) : null;
    const automaticCompaction = Boolean(payload.context_management?.length);
    const known = new Set(automaticCompaction ? [] : (ancestor?.images || []));
    stats.unknownLineage = Boolean(payload.previous_response_id && !ancestor);
    const input = payload.input.slice();
    let changed = false;
    const reloadCalls = new Map(automaticCompaction ? [] : (ancestor?.reloads || []));
    for (const item of payload.input) {
      if (!['function_call', 'custom_tool_call'].includes(item?.type) || !item.call_id) continue;
      const source = `${item.name || ''} ${item.arguments || item.input || ''}`.replace(/\\+/g, '/');
      if (/view_image/.test(source)) reloadCalls.set(item.call_id, source);
    }
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const field = contentField(item);
      if (!field || !Array.isArray(item[field])) continue;
      const content = [];
      let itemChanged = false;
      for (let j = 0; j < item[field].length; j++) {
        const part = item[field][j];
        const image = this.store.identify(part);
        if (!image) { content.push(part); continue; }
        stats.images++; stats.inlineBytes += Buffer.byteLength(part.image_url);
        if (image.cached) stats.hashCacheHits++;
        const existing = this.store.locate(scope, image);
        const file = this.store.put(scope, image, part.image_url)?.replace(/\\/g, '/');
        if (!file) { content.push(part); continue; }
        const explicitReload = reloadCalls.get(item.call_id)?.includes(file);
        if (explicitReload) stats.restoredImages++;
        const originalLabel = anchor(image.id, file);
        // Existing annotations are left stable if a client ever replays them.
        const alreadyLabelled = item[field][j - 1]?.type === 'input_text' && item[field][j - 1].text === originalLabel;
        if (alreadyLabelled) {
          content.push(part); known.add(image.id); continue;
        }
        if (known.has(image.id) && existing && !explicitReload) {
          content.push(textPart(reference(image.id, file)));
          stats.removedImages++; stats.removedInlineBytes += Buffer.byteLength(part.image_url);
        } else {
          content.push(textPart(originalLabel), part);
          known.add(image.id);
        }
        itemChanged = true;
      }
      if (itemChanged) { input[i] = { ...item, [field]: content }; changed = true; }
    }
    // A stored blob is not proof of upstream context. Commit only on a valid,
    // successful response.completed event; aborted/failed requests never seed it.
    const ticket = randomBytes(16).toString('hex');
    this.pending.set(ticket, { scope, known: automaticCompaction ? new Set() : known, reloads: reloadCalls, at: Date.now() });
    for (const [key, item] of this.pending) if (Date.now() - item.at > 600000 || this.pending.size > 128) this.pending.delete(key);
    return { buffer: changed ? Buffer.from(JSON.stringify({ ...payload, input })) : buffer, stats: { ...stats, ...this.store.stats() }, ticket,
      streamId: typeof payload.stream_id === 'string' ? payload.stream_id : undefined };
  }
  noteOutput(ticket, item) {
    const pending = this.pending.get(ticket);
    if (!pending || !['function_call', 'custom_tool_call'].includes(item?.type) || !item.call_id) return;
    const source = `${item.name || ''} ${item.arguments || item.input || ''}`.replace(/\\+/g, '/');
    if (/view_image/.test(source)) pending.reloads.set(item.call_id, source);
  }
  complete(ticket, responseId, compacted = false) {
    const pending = this.pending.get(ticket);
    this.pending.delete(ticket);
    if (!pending || typeof responseId !== 'string' || !responseId || responseId.length > 512) return;
    const key = `${pending.scope}:${responseId}`;
    this.responses.set(key, { images: compacted ? new Set() : new Set([...pending.known].slice(-512)),
      reloads: compacted ? new Map() : new Map([...pending.reloads].slice(-128)) });
    while (this.responses.size > 512) this.responses.delete(this.responses.keys().next().value);
  }
  fail(ticket) { this.pending.delete(ticket); }
}
module.exports = { SessionFilter, contentField, anchor, reference, compactionOutput };
