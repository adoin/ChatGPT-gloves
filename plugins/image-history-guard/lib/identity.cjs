'use strict';
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveIdentity(payload, headers = {}, upstream = '') {
  const metadata = payload?.client_metadata || {};
  const candidates = [];
  function add(value) {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'string' || !UUID.test(value)) return false;
    candidates.push(value.toLowerCase());
    return true;
  }
  if (!add(metadata.thread_id) || !add(headers['x-client-request-id'])) return null;
  for (const value of [metadata['x-codex-turn-metadata'], headers['x-codex-turn-metadata']]) {
    if (value === undefined) continue;
    let parsed;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
    if (!parsed || !add(parsed.thread_id)) return null;
  }
  if (!candidates.length || new Set(candidates).size !== 1) return null;
  // Cache affinity (session-id/prompt_cache_key), turn IDs and socket identity
  // are deliberately excluded. Forks can share affinity with their parent.
  const principal = headers['chatgpt-account-id'] || headers.authorization;
  if (typeof principal !== 'string' || !principal) return null;
  return { scope: hash(`${upstream}\0${principal}\0${candidates[0]}`) };
}

// Send only identity metadata to the worker, never bearer tokens.
function identityHeaders(headers = {}, upstream = '') {
  const principal = headers['chatgpt-account-id'] || headers.authorization;
  return {
    'x-client-request-id': headers['x-client-request-id'],
    'x-codex-turn-metadata': headers['x-codex-turn-metadata'],
    authorization: typeof principal === 'string' && principal ? hash(`${upstream}\0${principal}`) : undefined,
  };
}
module.exports = { resolveIdentity, identityHeaders };
