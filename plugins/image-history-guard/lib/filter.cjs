'use strict';

const { createHash } = require('node:crypto');

// Only traverse Responses input messages and structured tool outputs. Do not walk
// arbitrary objects: tool definitions, arguments, encrypted reasoning and results
// are not interchangeable with model input content.
function imageIdentity(part) {
  if (!part || part.type !== 'input_image' || typeof part.image_url !== 'string') return null;
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(part.image_url);
  if (!match || match[1].length % 4 !== 0) return null;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) return null;
  return { id: `IMG-${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length };
}

function filterRequest(payload) {
  const stats = { images: 0, uniqueImages: 0, removedImages: 0, inlineBytes: 0, removedInlineBytes: 0,
    incremental: Boolean(payload?.previous_response_id) };
  if (!payload || !Array.isArray(payload.input)) return { payload, stats, changed: false };
  // An incremental payload is its own deduplication scope. Never infer which
  // images remain upstream or modify previous_response_id to force a replay.
  const groups = new Map();
  const eligible = [];
  for (let itemIndex = 0; itemIndex < payload.input.length; itemIndex++) {
    const item = payload.input[itemIndex];
    if (!item || typeof item !== 'object') continue;
    const field = item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
      ? 'output' : ((!item.type || item.type === 'message') && item.role === 'user' ? 'content' : null);
    if (!field || !Array.isArray(item[field])) continue;
    eligible.push({ item, itemIndex, field });
    item[field].forEach((part, index) => {
      const identity = imageIdentity(part);
      if (!identity) return;
      const occurrence = { ...identity, itemIndex, field, index, part };
      const group = groups.get(identity.id) || [];
      group.push(occurrence);
      groups.set(identity.id, group);
      stats.images++;
      stats.inlineBytes += Buffer.byteLength(part.image_url);
    });
  }
  stats.uniqueImages = groups.size;
  const replacements = new Map();
  const key = (item, field, index) => `${item}:${field}:${index}`;
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    const last = group[group.length - 1];
    for (const occurrence of group.slice(0, -1)) {
      replacements.set(key(occurrence.itemIndex, occurrence.field, occurrence.index), [{
        type: 'input_text',
        text: `[Image History Guard: duplicate ${id} intentionally omitted here. The identical image is retained at its last occurrence later in this request. Preserve conclusions already drawn from it.]`,
      }]);
      stats.removedImages++;
      stats.removedInlineBytes += Buffer.byteLength(occurrence.part.image_url);
    }
    replacements.set(key(last.itemIndex, last.field, last.index), [
      { type: 'input_text', text: `[Image History Guard: ${id}; retained original for earlier duplicate references.]` },
      last.part,
    ]);
  }
  if (!stats.removedImages) return { payload, stats, changed: false };
  const input = payload.input.slice();
  for (const { item, itemIndex, field } of eligible) {
    if (!item[field].some((_, index) => replacements.has(key(itemIndex, field, index)))) continue;
    input[itemIndex] = { ...item, [field]: item[field].flatMap((part, index) =>
      replacements.get(key(itemIndex, field, index)) || [part]) };
  }
  return { payload: { ...payload, input }, stats, changed: true };
}

function transformBuffer(buffer, websocket = false) {
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (websocket && parsed?.type !== 'response.create') return { buffer, stats: null };
    const result = filterRequest(parsed);
    return { buffer: result.changed ? Buffer.from(JSON.stringify(result.payload)) : buffer, stats: result.stats };
  } catch {
    // Unknown shapes and invalid JSON are forwarded byte-for-byte.
    return { buffer, stats: null };
  }
}

module.exports = { filterRequest, transformBuffer, imageIdentity };
