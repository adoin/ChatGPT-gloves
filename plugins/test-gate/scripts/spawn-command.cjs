'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat', ''];
const WINDOWS_BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;
const NODE_MODULES_CMD_SHIM = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

function executableCandidates(executable, platform) {
  if (platform !== 'win32' || path.extname(executable)) return [executable];
  return WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${executable}${extension}`);
}

function isExecutableFile(filePath, platform) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchDirectories(cwd, env, platform) {
  const directories = [path.join(cwd, 'node_modules', '.bin')];
  for (const entry of String(env.PATH || env.Path || '').split(path.delimiter)) {
    const trimmed = entry.trim().replace(/^"|"$/g, '');
    if (trimmed) directories.push(path.resolve(trimmed));
  }
  const key = platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  return directories.filter((directory, index, all) => all.findIndex((candidate) => key(candidate) === key(directory)) === index);
}

function resolveExecutable(executable, options = {}) {
  const platform = options.platform || process.platform;
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  if (typeof executable !== 'string' || !executable || /[\u0000-\u001f\u007f]/.test(executable)) {
    throw new Error('Test Gate received an invalid executable name.');
  }
  const containsPath = path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\');
  const directories = containsPath ? [''] : searchDirectories(cwd, env, platform);
  const base = containsPath ? (path.isAbsolute(executable) ? path.normalize(executable) : path.resolve(cwd, executable)) : executable;
  for (const directory of directories) {
    for (const candidate of executableCandidates(base, platform)) {
      const filePath = directory ? path.join(directory, candidate) : candidate;
      if (isExecutableFile(filePath, platform)) return fs.realpathSync(filePath);
    }
  }
  const pathValue = String(env.PATH || env.Path || '');
  throw new Error(`Test Gate could not resolve executable "${executable}" from the project-local node_modules/.bin directory or its inherited PATH${pathValue ? '.' : ' (PATH is empty).'}`);
}

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META_CHARACTERS, '^$1');
}

function escapeCmdArgument(value, doubleEscapeMetaCharacters) {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARACTERS, '^$1');
  if (doubleEscapeMetaCharacters) escaped = escaped.replace(CMD_META_CHARACTERS, '^$1');
  return escaped;
}

function prepareSpawn(executable, args, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const resolvedExecutable = resolveExecutable(executable, { ...options, platform, env });
  const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
  if (platform !== 'win32' || !WINDOWS_BATCH_EXTENSIONS.has(path.extname(resolvedExecutable).toLowerCase())) {
    return {
      command: resolvedExecutable,
      args: normalizedArgs,
      windowsVerbatimArguments: false,
      resolvedExecutable,
      via: 'direct',
    };
  }
  const commandProcessor = env.ComSpec || env.COMSPEC || path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const shellCommand = [
    escapeCmdCommand(resolvedExecutable),
    ...normalizedArgs.map((value) => escapeCmdArgument(value, NODE_MODULES_CMD_SHIM.test(resolvedExecutable))),
  ].join(' ');
  return {
    command: env.comspec || commandProcessor,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
    resolvedExecutable,
    via: 'cmd-shim',
  };
}

module.exports = {
  prepareSpawn,
  resolveExecutable,
};
