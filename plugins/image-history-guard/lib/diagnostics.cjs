'use strict';
const fs = require('node:fs');
const path = require('node:path');

function diagnosticWriter(directory, maxBytes = 1024 * 1024) {
  const file = path.join(directory, 'events.jsonl');
  // Fixed metadata fields only. Never record URLs, query strings, headers,
  // worker exception messages, stacks, prompt text, paths or image identities.
  const allowed = ['event', 'kind', 'code', 'operation', 'generation', 'restart', 'route', 'status', 'version'];
  return event => {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const record = { at: new Date().toISOString() };
      for (const key of allowed) if (['string', 'number', 'boolean'].includes(typeof event[key])) record[key] = String(event[key]).slice(0, 96);
      const line = JSON.stringify(record) + '\n';
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        const previous = path.join(directory, 'events.previous.jsonl');
        try { fs.unlinkSync(previous); } catch { /* no older segment */ }
        fs.renameSync(file, previous);
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch { /* Diagnostic failure must not block requests. */ }
  };
}
module.exports = { diagnosticWriter };
