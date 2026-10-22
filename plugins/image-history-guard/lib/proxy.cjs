'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { WebSocket, WebSocketServer } = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getProxyForUrl } = require('proxy-from-env');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { FilterEngine, EventObserver } = require('./engine.cjs');
const { identityHeaders } = require('./identity.cjs');
const VERSION = '0.2.1';

const MAX_BYTES = 128 * 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
function headersFor(headers, websocket = false) {
  const blocked = new Set(HOP);
  for (const name of String(headers.connection || '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !blocked.has(name.toLowerCase()) && (!websocket || !name.toLowerCase().startsWith('sec-websocket-'))));
}
function proxyAgent(url) {
  const proxy = getProxyForUrl(url.toString().replace(/^ws/, 'http'));
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}
async function readBody(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('body_limit'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function decodeBody(body, encoding, limit) {
  const options = { maxOutputLength: limit };
  if (encoding === 'gzip') return promisify(zlib.gunzip)(body, options);
  if (encoding === 'deflate') return promisify(zlib.inflate)(body, options);
  if (encoding === 'br') return promisify(zlib.brotliDecompress)(body, options);
  if (encoding === 'zstd' && zlib.zstdDecompress) return promisify(zlib.zstdDecompress)(body, options);
  if (!encoding || encoding === 'identity') return body;
  return null;
}

function createProxy({ upstream = 'https://chatgpt.com/backend-api/codex', capability,
  maxBytes = MAX_BYTES, onMetric = () => {}, allowLocalUpstream = false, imageRoot, storeOptions,
  onDiagnostic = () => {}, engineOptions } = {}) {
  const origin = new URL(upstream);
  if (!capability || !/^[a-f0-9]{32,}$/.test(capability)) throw new Error('A random capability is required');
  if (origin.username || origin.password || origin.search || origin.hash ||
    (origin.protocol !== 'https:' && !(allowLocalUpstream && origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) throw new Error('Invalid upstream');
  const prefix = `/${capability}${origin.pathname.replace(/\/$/, '')}`;
  const responsePath = `${origin.pathname.replace(/\/$/, '')}/responses`;
  const storageRoot = imageRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'image-guard-blobs-'));
  const diagnostic = event => { try { onDiagnostic(event); } catch { /* diagnostics fail open */ } };
  const engine = new FilterEngine(storageRoot, storeOptions, { ...engineOptions, onDiagnostic: diagnostic });
  const sockets = new Set();
  let draining = false;
  const totals = { requests: 0, passthroughRequests: 0, removedImages: 0, restoredImages: 0, savedBytes: 0, failures: 0, skippedIdentity: 0, unknownLineageRequests: 0, hashCacheHits: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  function metric(transport, before, after, stats) {
    totals.requests++;
    if (stats?.scopeSkipped) totals.skippedIdentity++;
    if (stats?.unknownLineage) totals.unknownLineageRequests++;
    totals.hashCacheHits += stats?.hashCacheHits || 0;
    totals.removedImages += stats?.removedImages || 0;
    totals.restoredImages += stats?.restoredImages || 0;
    totals.savedBytes += before - after;
    try { onMetric({ transport, beforeBytes: before, afterBytes: after, ...stats }); } catch { /* diagnostics never block */ }
  }
  function usageMetric(transport, result) {
    if (!result?.usage) return;
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens']) totals[key] += result.usage[key];
    try { onMetric({ transport, usage: result.usage }); } catch { /* diagnostics never block */ }
  }
  function target(req) {
    // Browser origins are never clients; no CORS, forwarding proxy, or redirects.
    if (req.headers.origin || draining) return null;
    if (req.url === `${prefix}/_guard/status`) return 'status';
    if (req.url === `${prefix}/_guard/shutdown`) return 'shutdown';
    if (!req.url?.startsWith(`${prefix}/`)) return null;
    const suffix = req.url.slice(prefix.length);
    const url = new URL(origin);
    const queryAt = suffix.indexOf('?');
    const pathname = queryAt < 0 ? suffix : suffix.slice(0, queryAt);
    // Unknown API paths are not errors. Keep them under the fixed upstream base
    // rather than interpreting absolute URLs, encoded slashes or traversal.
    try {
      if (pathname.includes('#') || pathname.split('/').some(segment => {
        const decoded = decodeURIComponent(segment);
        return decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f]/.test(decoded);
      })) return null;
    } catch { return null; }
    const base = origin.pathname.replace(/\/$/, '');
    url.pathname = base + pathname;
    if (!url.pathname.startsWith(`${base}/`)) return null;
    url.search = queryAt < 0 ? '' : suffix.slice(queryAt);
    return url;
  }
  const server = http.createServer(async (req, res) => {
    const url = target(req);
    if (!url) { res.writeHead(404).end(); return; }
    if (url === 'status') {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ service: 'image-history-guard', version: VERSION, pid: process.pid, ...totals, ...(await engine.stats()), ...engine.status() }));
      return;
    }
    if (url === 'shutdown') {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      res.writeHead(200).end('{}');
      setImmediate(() => server.guardClose());
      return;
    }
    let ticket;
    const connection = randomBytes(12).toString('hex');
    try {
      let body;
      const headers = headersFor(req.headers);
      const filterable = req.method === 'POST' && [responsePath, `${responsePath}/compact`].includes(url.pathname) &&
        /^application\/json(?:;|$)/i.test(String(headers['content-type'] || ''));
      if (filterable) {
        body = await readBody(req, maxBytes);
        const decoded = await decodeBody(body, String(headers['content-encoding'] || '').toLowerCase(), maxBytes);
        if (decoded) {
          const result = await engine.prepare(decoded, { headers: identityHeaders(req.headers, origin.origin), upstream: origin.origin,
            compact: /\/responses\/compact$/.test(url.pathname), connection });
          ticket = result.ticket;
          // Do not reserialize or recompress untouched requests.
          metric('http', decoded.length, result.buffer.length, result.stats);
          if (result.buffer !== decoded) {
            body = result.buffer;
            delete headers['content-encoding'];
            delete headers['content-md5'];
            delete headers.digest;
            delete headers['content-digest'];
          }
        }
      } else {
        totals.passthroughRequests++;
      }
      if (body) headers['content-length'] = String(body.length);
      const upstreamReq = (url.protocol === 'https:' ? https : http).request(url, {
        method: req.method, headers, agent: proxyAgent(url),
      }, (upstreamRes) => {
        if (upstreamRes.statusCode >= 400) diagnostic({ event: 'upstream_error', route: /\/images\/(generations|edits)$/.test(url.pathname) ? 'images' : /\/responses(?:\/compact)?$/.test(url.pathname) ? 'responses' : 'other', status: upstreamRes.statusCode });
        if (ticket && upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300) {
          const observer = new EventObserver(event => engine.observe(connection, event, ticket).then(result => usageMetric('http', result)));
          const encoding = upstreamRes.headers['content-encoding'];
          const decoder = !encoding || encoding === 'identity' ? null : encoding === 'gzip' ? zlib.createGunzip() :
            encoding === 'br' ? zlib.createBrotliDecompress() : encoding === 'deflate' ? zlib.createInflate() :
            encoding === 'zstd' && zlib.createZstdDecompress ? zlib.createZstdDecompress() : undefined;
          if (decoder === null) {
            upstreamRes.on('data', chunk => observer.push(chunk));
            upstreamRes.on('end', () => engine.closeConnection(connection));
          } else if (decoder) {
            decoder.on('data', chunk => observer.push(chunk));
            decoder.on('error', () => engine.fail(ticket));
            decoder.on('end', () => engine.closeConnection(connection));
            upstreamRes.pipe(decoder);
          } else engine.fail(ticket);
          // Streaming observation is registered before piping bytes to the client.
        } else if (ticket) engine.fail(ticket);
        res.writeHead(upstreamRes.statusCode, headersFor(upstreamRes.headers));
        upstreamRes.on('error', () => res.destroy());
        upstreamRes.pipe(res);
      });
      upstreamReq.setTimeout(10 * 60 * 1000, () => upstreamReq.destroy(new Error('upstream_timeout')));
      upstreamReq.on('error', () => {
        totals.failures++;
        if (ticket) engine.fail(ticket);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"image_guard_upstream_unavailable"}');
        else res.destroy();
      });
      res.on('close', () => upstreamReq.destroy());
      if (body) upstreamReq.end(body);
      else {
        req.on('error', () => upstreamReq.destroy());
        req.on('aborted', () => upstreamReq.destroy());
        req.pipe(upstreamReq);
      }
    } catch (error) {
      totals.failures++;
      if (ticket) engine.fail(ticket);
      if (!res.headersSent) res.writeHead(error.status || (error.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400)).end('{"error":"image_guard_invalid_or_oversized_body"}');
      else res.destroy();
    }
  });
  server.requestTimeout = 10 * 60 * 1000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    const url = target(req);
    if (!(url instanceof URL)) { socket.destroy(); return; }
    const filterSocket = url.pathname === responsePath;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const remote = new WebSocket(url, protocols, { headers: headersFor(req.headers, true),
      agent: proxyAgent(url), maxPayload: maxBytes, perMessageDeflate: false, handshakeTimeout: 30000 });
    const connection = randomBytes(12).toString('hex');
    let local;
    let upgradeHeaders = {};
    remote.on('upgrade', response => { upgradeHeaders = headersFor(response.headers, true); });
    const stop = () => { if (local) local.terminate(); remote.terminate(); socket.destroy(); };
    socket.on('close', () => { remote.terminate(); engine.closeConnection(connection); });
    remote.on('error', () => { totals.failures++; stop(); });
    remote.on('unexpected-response', (_request, response) => {
      // Preserve HTTP status (including auth/rate-limit failures) for Codex recovery.
      const headers = headersFor(response.headers);
      socket.write(`HTTP/1.1 ${response.statusCode} Upstream\r\n`);
      for (const [key, value] of Object.entries(headers)) {
        for (const part of Array.isArray(value) ? value : [value]) socket.write(`${key}: ${part}\r\n`);
      }
      socket.write('Connection: close\r\n\r\n');
      response.pipe(socket);
    });
    remote.on('open', () => {
      remote.pause();
      const wss = new WebSocketServer({ noServer: true, maxPayload: maxBytes, perMessageDeflate: false,
        handleProtocols: () => remote.protocol || false });
      // Forward non-handshake metadata without forging ws extension negotiation.
      wss.on('headers', headers => {
        for (const [name, value] of Object.entries(upgradeHeaders)) {
          if (name.toLowerCase() === 'content-length') continue;
          for (const part of Array.isArray(value) ? value : [value]) headers.push(`${name}: ${part}`);
        }
      });
      remote.once('close', () => wss.close());
      wss.handleUpgrade(req, socket, head, ws => {
        local = ws;
        ws.on('error', stop);
        function bridge(from, to, transform) {
          from.on('message', async (data, binary) => {
            from.pause();
            let out = data;
            if (transform && filterSocket && !binary) {
              const result = await engine.prepare(data, { headers: identityHeaders(req.headers, origin.origin), upstream: origin.origin, websocket: true, connection });
              out = result.buffer;
              metric('websocket', data.length, out.length, result.stats);
            }
            if (!transform && filterSocket && !binary) usageMetric('websocket', await engine.observe(connection, data));
            if (to.readyState !== WebSocket.OPEN) { stop(); return; }
            to.send(out, { binary }, error => { if (error) stop(); else from.resume(); });
          });
          from.on('close', (code, reason) => {
            if (to.readyState === WebSocket.OPEN) {
              if (code === 1005 || code === 1006 || code === 1015) to.terminate();
              else to.close(code, reason);
            }
          });
        }
        bridge(ws, remote, true);
        bridge(remote, ws, false);
        remote.resume();
      });
    });
  });
  server.guardClose = () => {
    diagnostic({ event: 'proxy_stopped', version: VERSION });
    draining = true;
    for (const socket of sockets) socket.destroy();
    server.close();
    return engine.close();
  };
  server.guardPrefix = prefix;
  diagnostic({ event: 'proxy_created', version: VERSION });
  return server;
}

module.exports = { createProxy, headersFor };
