'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const MIB = 1024 * 1024;
const validId = /^IMG-[a-f0-9]{64}$/;

class ImageStore {
  constructor(root, { maxBytes = 256 * MIB, maxImageBytes = 32 * MIB, maxImages = 512, maxAgeMs = 7 * 86400000 } = {}) {
    this.root = path.resolve(root);
    this.limits = { maxBytes, maxImageBytes, maxImages, maxAgeMs };
    this.entries = new Map();
    this.hashes = new Map();
    this.hashBytes = 0;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error('Image store root must be a real directory');
    // This directory belongs exclusively to the guard. Never enumerate transcripts.
    for (const scope of fs.readdirSync(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(scope)) continue;
      const directory = path.join(this.root, scope);
      let names;
      try {
        if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) continue;
        names = fs.readdirSync(directory);
      } catch { continue; } // Another runtime can evict an old directory.
      for (const name of names) {
        if (!/^IMG-[a-f0-9]{64}\.(png|jpeg|webp|gif)$/.test(name)) continue;
        const file = path.join(directory, name);
        let stat;
        try {
          if (fs.lstatSync(file).isSymbolicLink()) continue;
          stat = fs.statSync(file);
        } catch { continue; }
        if (stat.size > this.limits.maxImageBytes) continue;
        // Validate content on first use, not by reading every cached image before
        // accepting the first request. Metadata alone never authorizes a reference.
        this.entries.set(file, { bytes: stat.size, at: stat.mtimeMs, modified: null });
      }
    }
    this.prune();
  }
  identify(part) {
    if (part?.type !== 'input_image' || typeof part.image_url !== 'string') return null;
    const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(part.image_url);
    if (!match || match[2].length % 4 || match[2].length > this.limits.maxImageBytes * 4 / 3 + 4) return null;
    const cached = this.hashes.get(part.image_url);
    if (cached) {
      this.hashes.delete(part.image_url); this.hashes.set(part.image_url, cached);
      return { ...cached, cached: true };
    }
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > this.limits.maxImageBytes || bytes.toString('base64') !== match[2]) return null;
    const identity = { id: `IMG-${createHash('sha256').update(bytes).digest('hex')}`,
      extension: match[1].toLowerCase().replace('jpg', 'jpeg'), bytes: bytes.length };
    if (part.image_url.length <= 2 * MIB) {
      while (this.hashes.size && this.hashBytes + part.image_url.length > 8 * MIB) {
        const first = this.hashes.keys().next().value;
        this.hashBytes -= first.length; this.hashes.delete(first);
      }
      this.hashes.set(part.image_url, identity); this.hashBytes += part.image_url.length;
    }
    return identity;
  }
  locate(scope, identity) {
    if (!/^[a-f0-9]{64}$/.test(scope) || !validId.test(identity.id)) return null;
    // Same image bytes may arrive with a different declared MIME type.
    for (const ext of ['png', 'jpeg', 'webp', 'gif']) {
      const file = path.join(this.root, scope, `${identity.id}.${ext}`);
      if (!this.entries.has(file) || !fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) continue;
      const stat = fs.statSync(file);
      const entry = this.entries.get(file);
      if (stat.size !== entry.bytes || stat.mtimeMs !== entry.modified) {
        if (stat.size > this.limits.maxImageBytes || `IMG-${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` !== identity.id) {
          this.entries.delete(file); continue;
        }
        entry.modified = stat.mtimeMs; entry.bytes = stat.size;
      }
      return file;
    }
    return null;
  }
  put(scope, identity, dataUrl) {
    let file = this.locate(scope, identity);
    if (file) { this.entries.get(file).at = Date.now(); return file; }
    if (identity.bytes > this.limits.maxBytes || this.limits.maxImages < 1) return null;
    const directory = path.join(this.root, scope);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) return null;
    file = path.join(directory, `${identity.id}.${identity.extension}`);
    const temporary = path.join(directory, `${randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
      this.entries.set(file, { bytes: identity.bytes, at: Date.now(), modified: fs.statSync(file).mtimeMs });
      this.prune(file);
      return fs.existsSync(file) ? file : null;
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* no blob created */ }
      return null;
    }
  }
  prune(protectedFile) {
    let total = [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0);
    const cutoff = Date.now() - this.limits.maxAgeMs;
    for (const [file, item] of [...this.entries].sort((a, b) => a[1].at - b[1].at)) {
      if (file === protectedFile) continue;
      if (item.at >= cutoff && total <= this.limits.maxBytes && this.entries.size <= this.limits.maxImages) continue;
      // Validated own-directory paths only; do not recursively delete directories.
      try { fs.unlinkSync(file); } catch { continue; }
      this.entries.delete(file); total -= item.bytes;
      try { fs.rmdirSync(path.dirname(file)); } catch { /* other images remain */ }
    }
    if (protectedFile && (total > this.limits.maxBytes || this.entries.size > this.limits.maxImages)) {
      fs.unlinkSync(protectedFile); this.entries.delete(protectedFile);
    }
  }
  stats() {
    return { storedImages: this.entries.size, storedBytes: [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0) };
  }
}
module.exports = { ImageStore };
