import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStack } from '../vendor/fgda/site/lib/stacks.mjs';

// Resolve against the package, never cwd, FGDA_DATA or a remote URL.
export const data = JSON.parse(fs.readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
if (!Array.isArray(data.entries) || !data.entries.length || !data.version) throw new Error('Bundled asset catalog is invalid.');
// The release predates the stacks export. Keep its entry data unchanged and
// supplement the missing index from pinned, unmodified upstream definitions.
if (!Array.isArray(data.stacks)) {
  const directory = fileURLToPath(new URL('../vendor/fgda/stacks/', import.meta.url));
  data.stacks = fs.readdirSync(directory).filter(file => file.endsWith('.md') && file !== 'README.md').sort()
    .map(file => parseStack(fs.readFileSync(path.join(directory, file), 'utf8'), { file }).meta);
}
