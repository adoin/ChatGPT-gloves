'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_RELATIVE_PATH = path.join('.codex', 'test-gate.json');

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function realDirectory(value) {
  if (typeof value !== 'string' || !value || hasControlCharacters(value)) {
    throw new Error('Project path must be a non-empty directory path.');
  }
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error('Project path must identify a directory.');
  }
  return resolved;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findProjectRoot(startPath) {
  let current = realDirectory(startPath);
  const original = current;
  while (true) {
    if (
      fs.existsSync(path.join(current, CONFIG_RELATIVE_PATH))
      || fs.existsSync(path.join(current, '.git'))
      || fs.existsSync(path.join(current, 'package.json'))
      || fs.existsSync(path.join(current, 'Cargo.toml'))
      || fs.existsSync(path.join(current, 'go.mod'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return original;
    current = parent;
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validatePatternList(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length > 500)) {
    throw new Error(`${fieldName} must be an array of regular-expression strings.`);
  }
  return value.map((source) => ({ source, expression: new RegExp(source, 'i') }));
}

function validateSuite(projectRoot, suite, index) {
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
    throw new Error(`suites[${index}] must be an object.`);
  }
  const id = typeof suite.id === 'string' ? suite.id : '';
  const label = typeof suite.label === 'string' ? suite.label.trim() : '';
  const executable = typeof suite.executable === 'string' ? suite.executable.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error(`suites[${index}].id must use lowercase letters, digits, and hyphens.`);
  }
  if (!label || label.length > 80 || hasControlCharacters(label)) {
    throw new Error(`suites[${index}].label must be 1-80 printable characters.`);
  }
  if (!executable || executable.length > 512 || hasControlCharacters(executable)) {
    throw new Error(`suites[${index}].executable must be a printable executable name or path.`);
  }
  if (!Array.isArray(suite.args) || suite.args.some((arg) => typeof arg !== 'string' || arg.length > 2000 || hasControlCharacters(arg))) {
    throw new Error(`suites[${index}].args must be an array of printable strings.`);
  }
  const relativeCwd = suite.cwd === undefined ? '.' : suite.cwd;
  if (typeof relativeCwd !== 'string' || !relativeCwd || hasControlCharacters(relativeCwd)) {
    throw new Error(`suites[${index}].cwd must be a relative directory.`);
  }
  const cwd = path.resolve(projectRoot, relativeCwd);
  if (!isInside(projectRoot, cwd)) {
    throw new Error(`suites[${index}].cwd must stay inside the project.`);
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`suites[${index}].cwd does not exist.`);
  }
  const timeoutMinutes = suite.timeoutMinutes === undefined ? 60 : suite.timeoutMinutes;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) {
    throw new Error(`suites[${index}].timeoutMinutes must be an integer from 1 to 1440.`);
  }
  return {
    id,
    label,
    executable,
    args: [...suite.args],
    cwd,
    relativeCwd: path.relative(projectRoot, cwd) || '.',
    timeoutMs: timeoutMinutes * 60_000,
    source: 'config',
  };
}

function loadProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(configPath)) {
    return {
      configPath,
      exists: false,
      suites: [],
      allowedPatterns: [],
      blockedPatterns: [],
    };
  }
  const value = readJsonFile(configPath);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new Error('Test Gate config must be an object with version: 1.');
  }
  const suites = value.suites === undefined ? [] : value.suites;
  if (!Array.isArray(suites)) throw new Error('suites must be an array.');
  const validatedSuites = suites.map((suite, index) => validateSuite(projectRoot, suite, index));
  if (new Set(validatedSuites.map((suite) => suite.id)).size !== validatedSuites.length) {
    throw new Error('Suite ids must be unique.');
  }
  const policy = value.policy === undefined ? {} : value.policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('policy must be an object.');
  }
  return {
    configPath,
    exists: true,
    suites: validatedSuites,
    allowedPatterns: validatePatternList(policy.allowedPatterns, 'policy.allowedPatterns'),
    blockedPatterns: validatePatternList(policy.blockedPatterns, 'policy.blockedPatterns'),
  };
}

function packageManager(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb')) || fs.existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
  return 'npm';
}

function autoSuite(id, label, executable, args, projectRoot, timeoutMinutes = 60) {
  return {
    id,
    label,
    executable,
    args,
    cwd: projectRoot,
    relativeCwd: '.',
    timeoutMs: timeoutMinutes * 60_000,
    source: 'discovered',
  };
}

function discoverSuites(projectRoot) {
  const suites = [];
  const packagePath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packagePath)) {
    const packageJson = readJsonFile(packagePath);
    const scripts = packageJson && typeof packageJson.scripts === 'object' && packageJson.scripts ? packageJson.scripts : {};
    const manager = packageManager(projectRoot);
    for (const scriptName of Object.keys(scripts).sort()) {
      if (!/^(?:test(?::|$)|e2e(?::|$)|acceptance(?::|$)|integration(?::|$)|bench(?:mark)?(?::|$))/i.test(scriptName)) continue;
      const idBase = scriptName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'test';
      const digest = crypto.createHash('sha256').update(scriptName).digest('hex').slice(0, 8);
      const args = manager === 'npm' ? ['run', scriptName] : ['run', scriptName];
      suites.push(autoSuite(`${idBase}-${digest}`, scriptName, manager, args, projectRoot));
    }
  }
  if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
    suites.push(autoSuite('cargo-test', 'Cargo tests', 'cargo', ['test'], projectRoot));
    if (fs.existsSync(path.join(projectRoot, 'benches'))) {
      suites.push(autoSuite('cargo-bench', 'Cargo benchmarks', 'cargo', ['bench'], projectRoot, 120));
    }
  }
  if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
    suites.push(autoSuite('go-test', 'Go tests', 'go', ['test', './...'], projectRoot));
  }
  if (
    fs.existsSync(path.join(projectRoot, 'pytest.ini'))
    || fs.existsSync(path.join(projectRoot, 'pyproject.toml'))
    || fs.existsSync(path.join(projectRoot, 'tox.ini'))
  ) {
    const hasPythonTests = fs.existsSync(path.join(projectRoot, 'tests'));
    if (hasPythonTests) suites.push(autoSuite('pytest', 'Pytest', 'pytest', [], projectRoot));
  }
  return suites;
}

function projectState(projectPath) {
  const projectRoot = findProjectRoot(projectPath);
  const config = loadProjectConfig(projectRoot);
  const discovered = discoverSuites(projectRoot);
  const configuredIds = new Set(config.suites.map((suite) => suite.id));
  return {
    projectRoot,
    configPath: config.configPath,
    configExists: config.exists,
    suites: [...config.suites, ...discovered.filter((suite) => !configuredIds.has(suite.id))],
    allowedPatterns: config.allowedPatterns,
    blockedPatterns: config.blockedPatterns,
  };
}

const INTERACTIVE_ALLOW_PATTERNS = [
  /(?:^|\s)(?:playwright|npx\s+(?:--yes\s+)?playwright|pnpm\s+(?:exec\s+)?playwright|yarn\s+playwright|bunx\s+playwright)\s+(?:codegen|open|show-report|screenshot)\b/i,
  /(?:^|\s)cypress\s+open\b/i,
  /(?:^|\s)(?:start|open|xdg-open)\s+(?:https?:\/\/|[^;&|]*\.html\b)/i,
  /(?:^|\s)(?:chrome|chrome\.exe|chromium|chromium-browser|msedge|msedge\.exe|firefox|firefox\.exe)\b/i,
];

const BUILTIN_TEST_PATTERNS = [
  { kind: 'Node test runner', expression: /(?:^|[;&|]\s*|\s)node(?:\.exe)?\s+--test(?:\s|$)/i },
  { kind: 'package test script', expression: /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:(?:run|run-script)\s+)?(?:test(?::[\w:.-]+)?|e2e(?::[\w:.-]+)?|acceptance(?::[\w:.-]+)?|integration(?::[\w:.-]+)?|bench(?:mark)?(?::[\w:.-]+)?)(?:\s|$)/i },
  { kind: 'JavaScript test runner', expression: /(?:^|[;&|]\s*|\s)(?:(?:npx|bunx)\s+(?:--yes\s+)?|pnpm\s+(?:exec\s+)?|yarn\s+)?(?:jest|vitest|mocha|ava|tap)(?:\.cmd|\.exe)?(?:\s|$)/i },
  { kind: 'Playwright test', expression: /(?:^|[;&|]\s*|\s)(?:(?:npx|bunx)\s+(?:--yes\s+)?|pnpm\s+(?:exec\s+)?|yarn\s+)?playwright(?:\.cmd|\.exe)?\s+test(?:\s|$)/i },
  { kind: 'Cypress run', expression: /(?:^|[;&|]\s*|\s)(?:(?:npx|bunx)\s+(?:--yes\s+)?|pnpm\s+(?:exec\s+)?|yarn\s+)?cypress(?:\.cmd|\.exe)?\s+run(?:\s|$)/i },
  { kind: 'Python tests', expression: /(?:^|[;&|]\s*|\s)(?:pytest|py\.test|python(?:3|\.exe)?\s+-m\s+(?:pytest|unittest))(?:\s|$)/i },
  { kind: 'Rust tests or benchmarks', expression: /(?:^|[;&|]\s*|\s)cargo(?:\.exe)?\s+(?:test|bench)(?:\s|$)/i },
  { kind: 'Go tests', expression: /(?:^|[;&|]\s*|\s)go(?:\.exe)?\s+test(?:\s|$)/i },
  { kind: '.NET tests', expression: /(?:^|[;&|]\s*|\s)dotnet(?:\.exe)?\s+test(?:\s|$)/i },
  { kind: 'JVM tests', expression: /(?:^|[;&|]\s*|\s)(?:mvnw?|gradlew?)(?:\.cmd|\.bat|\.exe)?(?:\s+[^;&|]*)?\s+(?:test|verify|check)(?:\s|$)/i },
  { kind: 'native test runner', expression: /(?:^|[;&|]\s*|\s)(?:ctest|rspec|phpunit)(?:\.exe)?(?:\s|$)/i },
  { kind: 'language test runner', expression: /(?:^|[;&|]\s*|\s)(?:mix|flutter|dart|swift)(?:\.exe)?\s+test(?:\s|$)/i },
  { kind: 'Bazel tests', expression: /(?:^|[;&|]\s*|\s)bazel(?:isk)?(?:\.exe)?\s+test(?:\s|$)/i },
  { kind: 'Make test target', expression: /(?:^|[;&|]\s*|\s)(?:make|nmake|mingw32-make)(?:\.exe)?\s+(?:test|check|e2e|acceptance|bench|benchmark)(?:\s|$)/i },
];

function classifyNonInteractiveTest(command, cwd) {
  if (typeof command !== 'string' || !command.trim()) return { blocked: false };
  let state;
  try {
    state = projectState(cwd || process.cwd());
  } catch {
    return { blocked: false, reason: 'policy unavailable; failed open' };
  }
  if (state.allowedPatterns.some(({ expression }) => expression.test(command))) {
    return { blocked: false, reason: 'project allow rule' };
  }
  if (INTERACTIVE_ALLOW_PATTERNS.some((expression) => expression.test(command))) {
    return { blocked: false, reason: 'interactive browser or screenshot workflow' };
  }
  const custom = state.blockedPatterns.find(({ expression }) => expression.test(command));
  if (custom) {
    return { blocked: true, kind: 'project-configured non-interactive test', matchedPattern: custom.source };
  }
  const builtIn = BUILTIN_TEST_PATTERNS.find(({ expression }) => expression.test(command));
  return builtIn ? { blocked: true, kind: builtIn.kind } : { blocked: false };
}

module.exports = {
  CONFIG_RELATIVE_PATH,
  classifyNonInteractiveTest,
  findProjectRoot,
  isInside,
  loadProjectConfig,
  projectState,
  realDirectory,
};
