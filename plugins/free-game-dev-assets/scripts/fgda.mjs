#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { data } from '../mcp/catalog.mjs';
import { searchAssets, getAsset, checkLicense, listStacks } from '../vendor/fgda/site/lib/catalog-query.mjs';

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Free Game Dev Assets requires Node.js 22 or newer.');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    category: { type: 'string' }, license: { type: 'string' }, engine: { type: 'string' }, format: { type: 'string' }, limit: { type: 'string' },
    commercial: { type: 'boolean' }, 'no-attribution': { type: 'boolean' }, 'non-commercial': { type: 'boolean' },
  } });
  const [command, ...words] = positionals;
  if (values.help || !command) {
    console.log('Usage: node scripts/fgda.mjs search WORDS [--category C --license L --commercial --no-attribution --engine E --format F --limit N --json]\n       get ID | check ID [--engine E --non-commercial --json] | stacks [--json]\nUses the pinned local catalog.');
  } else {
    let result;
    if (command === 'search') {
      const limit = values.limit === undefined ? 20 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100.');
      result = searchAssets(data, { q: words.join(' '), category: values.category, license: values.license,
        engine: values.engine, format: values.format, limit, commercial: values.commercial, noAttribution: values['no-attribution'] });
    } else if (command === 'get' || command === 'check') {
      if (words.length !== 1) throw new Error(`${command} requires one entry ID.`);
      result = command === 'get' ? getAsset(data, words[0]) : checkLicense(data, words[0], { commercial: !values['non-commercial'], engine: values.engine });
      if (!result || command === 'check' && !result.ok) process.exitCode = 1;
    } else if (command === 'stacks' && !words.length) result = listStacks(data);
    else throw new Error('Unknown command. Use --help.');
    console.log(JSON.stringify(result, null, values.json ? 2 : 0));
  }
} catch (error) { console.error(error.message); process.exitCode = 2; }
