#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");
const marketplacePath = path.join(packageRoot, ".agents", "plugins", "marketplace.json");
const pluginPath = path.join(packageRoot, "plugins", "conversation-lifeboat");
const pluginManifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function verify() {
  const marketplace = readJson(marketplacePath);
  const manifest = readJson(pluginManifestPath);
  const entry = marketplace.plugins?.find((plugin) => plugin.name === manifest.name);

  if (!entry) {
    throw new Error(`Marketplace does not reference plugin ${manifest.name}.`);
  }

  const resolvedSource = path.resolve(packageRoot, entry.source.path);
  if (resolvedSource !== pluginPath) {
    throw new Error(`Marketplace source resolves to an unexpected path: ${resolvedSource}`);
  }

  for (const required of [
    path.join(pluginPath, "hooks", "hooks.json"),
    path.join(pluginPath, "skills", "conversation-handoff", "SKILL.md"),
    path.join(pluginPath, "scripts", "conversation-health.cjs")
  ]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Required plugin file is missing: ${required}`);
    }
  }

  process.stdout.write(`Verified ${marketplace.name}/${manifest.name} v${manifest.version}.\n`);
}

function extract(targetArg) {
  const target = path.resolve(targetArg || "chatgpt-gloves-marketplace");
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`Refusing to overwrite non-empty directory: ${target}`);
  }

  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(packageRoot, ".agents"), path.join(target, ".agents"), { recursive: true });
  fs.cpSync(path.join(packageRoot, "plugins"), path.join(target, "plugins"), { recursive: true });
  process.stdout.write(`Extracted ChatGPT Gloves marketplace to ${target}\n`);
  process.stdout.write("In ChatGPT, add this local folder as a plugin marketplace.\n");
}

function printHelp() {
  process.stdout.write(`ChatGPT Gloves\n\n`);
  process.stdout.write(`Add the hosted marketplace in ChatGPT Desktop:\n`);
  process.stdout.write(`  Source:      https://github.com/adoin/ChatGPT-gloves\n`);
  process.stdout.write(`  Git ref:     main (or leave blank)\n`);
  process.stdout.write(`  Sparse path: leave blank\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  chatgpt-gloves verify            Validate the bundled marketplace\n`);
  process.stdout.write(`  chatgpt-gloves extract [folder]  Extract a local marketplace copy\n`);
}

try {
  const [command, argument] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "verify") {
    verify();
  } else if (command === "extract") {
    extract(argument);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`chatgpt-gloves: ${error.message}\n`);
  process.exitCode = 1;
}
