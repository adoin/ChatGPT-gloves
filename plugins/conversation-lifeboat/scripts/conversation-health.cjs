'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function numberFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const config = {
  warnBytes: numberFromEnv('CONVERSATION_LIFEBOAT_WARN_MIB', 512) * MIB,
  recommendBytes: numberFromEnv('CONVERSATION_LIFEBOAT_RECOMMEND_MIB', 2048) * MIB,
  criticalBytes: numberFromEnv('CONVERSATION_LIFEBOAT_CRITICAL_MIB', 5120) * MIB,
  warnContextRatio: numberFromEnv('CONVERSATION_LIFEBOAT_WARN_CONTEXT_RATIO', 0.6),
  recommendContextRatio: numberFromEnv('CONVERSATION_LIFEBOAT_RECOMMEND_CONTEXT_RATIO', 0.8),
  criticalContextRatio: numberFromEnv('CONVERSATION_LIFEBOAT_CRITICAL_CONTEXT_RATIO', 0.9),
  compactionWindowMs: numberFromEnv('CONVERSATION_LIFEBOAT_COMPACTION_WINDOW_HOURS', 24) * 60 * 60 * 1000,
  recommendCompactions: numberFromEnv('CONVERSATION_LIFEBOAT_RECOMMEND_COMPACTIONS', 4),
  tailBytes: numberFromEnv('CONVERSATION_LIFEBOAT_TAIL_MIB', 8) * MIB,
};

const ranks = { healthy: 0, warning: 1, recommend: 2, critical: 3 };

function readHookInput() {
  const raw = fs.readFileSync(0, 'utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function safeSessionId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function statePathFor(input) {
  const root = process.env.PLUGIN_DATA || path.join(os.tmpdir(), 'conversation-lifeboat');
  const directory = path.join(root, 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${safeSessionId(input.session_id)}.json`);
}

function loadState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { compactions: [] };
  }
}

function saveState(filePath, state) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function transcriptSize(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    return fs.statSync(transcriptPath).size;
  } catch {
    return 0;
  }
}

function readTail(filePath, maximumBytes) {
  if (!filePath || maximumBytes <= 0) return '';
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, maximumBytes);
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(descriptor, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (size > length) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } catch {
    return '';
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function latestTokenUsage(transcriptPath) {
  const lines = readTail(transcriptPath, config.tailBytes).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('token_count') || !line.includes('model_context_window')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type !== 'event_msg' || event?.payload?.type !== 'token_count') continue;
      const info = event.payload.info || {};
      const usage = info.last_token_usage || {};
      const inputTokens = Number(usage.input_tokens || 0);
      const contextWindow = Number(info.model_context_window || 0);
      return {
        inputTokens,
        contextWindow,
        contextRatio: contextWindow > 0 ? inputTokens / contextWindow : 0,
      };
    } catch {
      // The transcript is an intentionally unstable interface. Ignore unknown lines.
    }
  }
  return { inputTokens: 0, contextWindow: 0, contextRatio: 0 };
}

function recordCompaction(input, state, now) {
  if (input.hook_event_name !== 'PostCompact') return;
  const key = `${input.turn_id || 'unknown'}:${input.trigger || 'unknown'}`;
  if (!state.compactions.some((item) => item.key === key)) {
    state.compactions.push({ key, at: now, trigger: input.trigger || 'unknown' });
  }
}

function recentCompactions(state, now) {
  const cutoff = now - config.compactionWindowMs;
  state.compactions = (state.compactions || []).filter((item) => Number(item.at) >= cutoff);
  return state.compactions.length;
}

function classify(bytes, contextRatio, compactions) {
  if (bytes >= config.criticalBytes || contextRatio >= config.criticalContextRatio) return 'critical';
  if (
    bytes >= config.recommendBytes ||
    contextRatio >= config.recommendContextRatio ||
    compactions >= config.recommendCompactions
  ) return 'recommend';
  if (bytes >= config.warnBytes || contextRatio >= config.warnContextRatio) return 'warning';
  return 'healthy';
}

function formatSize(bytes) {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`;
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function isLikelyDecline(prompt) {
  const text = prompt || '';
  return /(^|\s)(no|not now|later|cancel)(\s|$|[,!.?])/iu.test(text) ||
    /(不用|不要|暂不|稍后|取消|不迁移)/u.test(text);
}

function isLikelyConfirmation(prompt) {
  const text = prompt || '';
  return /(^|\s)(yes|confirm|confirmed|proceed|migrate|new task|new conversation)(\s|$|[,!.?])/iu.test(text) ||
    /(确认|同意|迁移|新对话|新任务|开始迁移)/u.test(text);
}

function shouldNotify(state, level, now) {
  const previousRank = ranks[state.lastNotifiedLevel || 'healthy'];
  if (ranks[level] > previousRank) return true;
  const elapsed = now - Number(state.lastNotifiedAt || 0);
  const cooldown = level === 'critical' ? 15 * 60 * 1000 : level === 'recommend' ? 2 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  return elapsed >= cooldown;
}

function healthSummary(level, bytes, usage, compactions) {
  const parts = [`transcript ${formatSize(bytes)}`];
  if (usage.contextWindow > 0) {
    parts.push(`context ${(usage.contextRatio * 100).toFixed(1)}% (${usage.inputTokens}/${usage.contextWindow} tokens)`);
  }
  if (compactions > 0) parts.push(`${compactions} compactions in the monitoring window`);
  return `${level}: ${parts.join(', ')}`;
}

function migrationContext(summary, pending) {
  return [
    `Conversation Lifeboat reports ${summary}.`,
    pending
      ? 'A migration offer is pending. Interpret the current user prompt in conversation context. If it explicitly confirms migration, invoke $conversation-handoff now; otherwise do not migrate.'
      : 'Before continuing substantial implementation, tell the user that this task is large enough to impair reliability or responsiveness and ask whether to create a durable handoff specification and continue in a fresh task.',
    'Do not create a new task, modify project specifications, or archive this task without explicit user confirmation.',
  ].join(' ');
}

function outputWarning(input, state, level, summary, now) {
  const prompt = String(input.prompt || '');
  if (state.migrationOfferPending && isLikelyDecline(prompt)) {
    state.migrationOfferPending = false;
    return null;
  }

  if (state.migrationOfferPending && isLikelyConfirmation(prompt)) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: migrationContext(summary, true),
      },
    };
  }

  if (!shouldNotify(state, level, now)) return null;

  state.lastNotifiedAt = now;
  state.lastNotifiedLevel = level;
  if (ranks[level] >= ranks.recommend) state.migrationOfferPending = true;

  const eventSupportsContext = input.hook_event_name === 'SessionStart' || input.hook_event_name === 'UserPromptSubmit';
  const result = {
    continue: true,
    systemMessage: `Conversation health ${summary}.`,
  };
  if (eventSupportsContext && ranks[level] >= ranks.recommend) {
    result.hookSpecificOutput = {
      hookEventName: input.hook_event_name,
      additionalContext: migrationContext(summary, false),
    };
  }
  return result;
}

function main() {
  const input = readHookInput();
  const now = Date.now();
  const stateFile = statePathFor(input);
  const state = loadState(stateFile);

  recordCompaction(input, state, now);
  const compactions = recentCompactions(state, now);
  const bytes = transcriptSize(input.transcript_path);
  const usage = latestTokenUsage(input.transcript_path);
  const level = classify(bytes, usage.contextRatio, compactions);

  state.lastCheck = {
    at: now,
    level,
    transcriptBytes: bytes,
    inputTokens: usage.inputTokens,
    contextWindow: usage.contextWindow,
    contextRatio: usage.contextRatio,
    recentCompactions: compactions,
  };

  let output = null;
  if (
    level !== 'healthy' &&
    (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'UserPromptSubmit')
  ) {
    output = outputWarning(input, state, level, healthSummary(level, bytes, usage, compactions), now);
  }

  saveState(stateFile, state);
  if (output) process.stdout.write(JSON.stringify(output));
}

try {
  main();
} catch (error) {
  process.stderr.write(`Conversation Lifeboat hook failed safely: ${error.message}\n`);
  process.exitCode = 0;
}
