'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MIB = 1024 * 1024;
const POLICY = 3;
function setting(name, fallback) {
  const value = Number(process.env[`CONVERSATION_LIFEBOAT_${name}`]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const config = {
  tailBytes: Math.floor(Math.min(setting('TAIL_MIB', 16), 64) * MIB),
  warnImages: setting('WARN_IMAGE_MIB', 8) * MIB,
  recommendImages: setting('RECOMMEND_IMAGE_MIB', 24) * MIB,
  criticalImages: setting('CRITICAL_IMAGE_MIB', 48) * MIB,
  duplicateBytes: setting('DUPLICATE_IMAGE_MIB', 4) * MIB,
  growthBytes: setting('IMAGE_GROWTH_MIB', 8) * MIB,
  growthWindow: setting('GROWTH_WINDOW_MINUTES', 10) * 60000,
  failureWindow: setting('FAILURE_WINDOW_MINUTES', 30) * 60000,
  compactionWindow: setting('COMPACTION_WINDOW_HOURS', 24) * 3600000,
  compactions: setting('RECOMMEND_COMPACTIONS', 4),
};
const ranks = { healthy: 0, warning: 1, recommend: 2, critical: 3 };
const connectionPattern = /重连|重新连接|断线|连接中断|请求超时|一直.{0,8}(没响应|不响应|没回复|不回复)|reconnect(?:ing)?|stream disconnected|websocket.{0,40}(?:closed|timeout|1009)|idle timeout|10053|message too (?:big|large)/iu;
const compactFailurePattern = /(?:compact(?:ion)?|压缩).{0,60}(?:fail|error|失败|出错)|(?:fail|error|失败).{0,60}(?:compact|压缩)/iu;
const digest = value => createHash('sha256').update(value).digest('hex');
function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, config.tailBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    let discardedBytes = 0;
    let startOffset = size - length;
    if (size > length) {
      const newline = text.indexOf('\n');
      discardedBytes = newline < 0 ? length : Buffer.byteLength(text.slice(0, newline));
      startOffset += discardedBytes + (newline < 0 ? 0 : 1);
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return { text, size, startOffset, sampledBytes: length, partial: size > length, discardedBytes, readable: true };
  } catch { return { text: '', size: 0, startOffset: 0, sampledBytes: 0, partial: true, discardedBytes: 0, readable: false }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sample(tail, state, now) {
  let images = new Map();
  let imageBytes = 0, imageCount = 0, newImageBytes = 0;
  let recordOffset = tail.startOffset;
  const previousOffset = state.lastCheck?.scanOffset || 0;
  let compactAt = Number(state.lastCompactAt || 0);
  const failures = [];
  let usage = { inputTokens: 0, contextWindow: 0, measuredAt: null };
  for (const rawLine of tail.text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const recordStart = recordOffset;
    recordOffset += Buffer.byteLength(rawLine) + 1;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload || {};
    const at = Date.parse(event.timestamp) || 0;
    if (event.type === 'compacted' || (event.type === 'event_msg' && payload.type === 'context_compacted')) {
      images = new Map(); imageBytes = 0; imageCount = 0; newImageBytes = 0;
      compactAt = Math.max(compactAt, at);
      continue;
    }
    if (event.type === 'event_msg' && payload.type === 'token_count' && payload.info?.last_token_usage) {
      usage = { inputTokens: Number(payload.info.last_token_usage.input_tokens || 0),
        contextWindow: Number(payload.info.model_context_window || 0), measuredAt: at || null };
    }
    // Only explicit error events, not arbitrary assistant text or command logs.
    if (event.type === 'event_msg' && payload.type === 'error' && at >= now - config.failureWindow) {
      const error = JSON.stringify(payload);
      if (connectionPattern.test(error) || compactFailurePattern.test(error)) {
        failures.push({ key: digest(line), at, kind: compactFailurePattern.test(error) ? 'compaction' : 'connection' });
      }
    }
    if (event.type !== 'response_item' || (compactAt && (!at || at <= compactAt))) continue;
    if (!['message', 'function_call_output', 'custom_tool_call_output', 'image_generation_call'].includes(payload.type)) continue;
    // Scan only the actual response item, excluding mirrored item_completed events.
    // Also detects data URLs inside JSON-serialized tool text without recursively
    // parsing or persisting that text. No image bytes/hashes are written to state.
    const content = JSON.stringify(payload.type === 'message' ? payload.content : payload.output ?? payload.result ?? '');
    const urls = content.match(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi) || [];
    if (payload.type === 'image_generation_call' && typeof payload.result === 'string' &&
      /^[a-z0-9+/=]{1024,}$/i.test(payload.result)) urls.push(payload.result);
    for (const url of urls) {
      const bytes = Buffer.byteLength(url);
      imageBytes += bytes; imageCount++;
      if (recordStart >= previousOffset) newImageBytes += bytes;
      const key = digest(url);
      if (!images.has(key)) images.set(key, bytes);
    }
  }
  const uniqueBytes = [...images.values()].reduce((sum, value) => sum + value, 0);
  return { imageBytes, newImageBytes, imageCount, uniqueImages: images.size, duplicateImageBytes: imageBytes - uniqueBytes,
    compactAt, failures, usage };
}
function classify(metrics, failures, compactions) {
  const duplicateRisk = metrics.duplicateImageBytes >= config.duplicateBytes;
  const imageRisk = metrics.imageBytes >= config.warnImages || duplicateRisk || metrics.imageGrowthBytes >= config.growthBytes;
  if (metrics.imageBytes >= config.criticalImages) return 'critical';
  if (metrics.imageBytes >= config.recommendImages ||
    (duplicateRisk && metrics.duplicateImageBytes >= metrics.imageBytes / 2) ||
    (failures > 0 && imageRisk) || failures >= 2 || (failures > 0 && compactions >= config.compactions)) return 'recommend';
  if (imageRisk || failures > 0) return 'warning';
  return 'healthy';
}
function decline(prompt) {
  return /不用|不要|暂不|稍后|取消|不迁移|就.{0,8}(当前|这里|这个)|继续.{0,8}(当前|这里)|(^|\s)(no|not now|later|cancel|stay here)(\s|$|[,!.?])/iu.test(prompt);
}
function confirmation(prompt) {
  return /确认|同意|迁移|新对话|新任务|开始迁移|(^|\s)(yes|confirm|proceed|migrate)(\s|$|[,!.?])/iu.test(prompt);
}
function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const now = Date.now();
  const root = path.join(process.env.PLUGIN_DATA || path.join(os.tmpdir(), 'conversation-lifeboat'), 'sessions');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${String(input.session_id || 'unknown').replace(/[^a-z0-9._-]/gi, '_')}.json`);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  // Discard pending offers/notifications produced by the retired token policy.
  if (state.policyVersion !== POLICY) state = { policyVersion: POLICY, compactions: state.compactions || [] };
  state.compactions = (state.compactions || []).filter(item => item.at >= now - config.compactionWindow);
  if (input.hook_event_name === 'PostCompact') {
    const key = `${input.turn_id || 'unknown'}:${input.trigger || 'unknown'}`;
    if (!state.compactions.some(item => item.key === key)) state.compactions.push({ key, at: now });
    state.lastCompactAt = now;
  }
  const tail = readTail(input.transcript_path);
  const observed = sample(tail, state, now);
  state.lastCompactAt = observed.compactAt;
  let failures = [...(state.failures || []), ...observed.failures];
  failures = [...new Map(failures.map(f => [f.key, f])).values()]
    .filter(f => f.at >= now - config.failureWindow && (!observed.usage.measuredAt || f.at > observed.usage.measuredAt));
  const prompt = input.hook_event_name === 'UserPromptSubmit' ? String(input.prompt || '') : '';
  const reassess = connectionPattern.test(prompt) || compactFailurePattern.test(prompt);
  if (reassess) {
    failures.push({ key: `report:${input.turn_id || now}`, at: now,
      kind: compactFailurePattern.test(prompt) ? 'compaction' : 'connection' });
    // A repeated-failure report is evidence of persistence, not two invented log events.
    if (/一直.{0,20}(重连|超时|没响应)|反复|连续|reconnect(?:ing)?\s+[2-5]\/5|repeated|keeps? reconnecting/iu.test(prompt)) {
      failures.push({ key: `persistent-report:${input.turn_id || now}`, at: now, kind: 'reported-persistence' });
    }
  }
  state.failures = [...new Map(failures.map(f => [f.key, f])).values()].slice(-32);
  const previous = state.lastCheck;
  const sameSegment = previous && previous.compactAt === observed.compactAt;
  const transcriptIdentity = digest(String(input.transcript_path || ''));
  const appendOnly = previous && tail.readable && tail.size >= previous.transcriptBytes && transcriptIdentity === previous.transcriptIdentity;
  const retainedImageBytes = sameSegment && appendOnly
    ? Math.max(observed.imageBytes, (previous.retainedImageBytes || previous.imageBytes || 0) + observed.newImageBytes)
    : observed.imageBytes;
  const imageGrowthBytes = sameSegment && appendOnly && now - previous.at <= config.growthWindow
    ? observed.newImageBytes : 0;
  const metrics = { ...observed, imageBytes: retainedImageBytes, imageGrowthBytes };
  let level = classify(metrics, state.failures.length, state.compactions.length);
  // A partial oversized record cannot be inspected; request a non-migration review.
  if ((reassess || tail.discardedBytes >= config.warnImages) && level === 'healthy') level = 'warning';
  state.lastCheck = { at: now, level, transcriptIdentity, scanOffset: tail.size,
    transcriptBytes: tail.size, sampledBytes: tail.sampledBytes, retainedImageBytes,
    partialSample: tail.partial, transcriptReadable: tail.readable, discardedPartialRecordBytes: tail.discardedBytes,
    imageBytes: observed.imageBytes, imageCount: observed.imageCount, uniqueImages: observed.uniqueImages,
    duplicateImageBytes: observed.duplicateImageBytes, imageGrowthBytes, compactAt: observed.compactAt,
    recentFailures: state.failures.length, recentCompactions: state.compactions.length,
    inputTokens: observed.usage.inputTokens, contextWindow: observed.usage.contextWindow,
    usageMeasuredAt: observed.usage.measuredAt, connectionReassessment: reassess };
  if (level === 'healthy') {
    state.migrationOfferPending = false;
    state.declinedLevel = null;
  }
  let output;
  const supportsContext = ['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name);
  if (supportsContext) {
    if (decline(prompt)) {
      state.migrationOfferPending = false;
      state.declinedLevel = level;
    }
    const suppressed = state.declinedLevel && ranks[level] <= ranks[state.declinedLevel];
    if (state.migrationOfferPending && !decline(prompt) && confirmation(prompt)) {
      output = { continue: true, hookSpecificOutput: { hookEventName: input.hook_event_name,
        additionalContext: 'A migration offer is pending. Interpret the current prompt in context; invoke $conversation-handoff only if the user explicitly confirms migration. Otherwise continue the requested work.' } };
    } else if (level !== 'healthy' && (reassess || (!suppressed &&
      (ranks[level] > ranks[state.lastNotifiedLevel || 'healthy'] || now - (state.lastNotifiedAt || 0) >= 12 * 3600000)))) {
      state.lastNotifiedAt = now; state.lastNotifiedLevel = level;
      const canOffer = ranks[level] >= ranks.recommend && !suppressed;
      if (canOffer) state.migrationOfferPending = true;
      const summary = `${level}: observed retained inline image data at least ${(retainedImageBytes / MIB).toFixed(1)} MiB, sampled duplicate data ${(observed.duplicateImageBytes / MIB).toFixed(1)} MiB, recent failure signals ${state.failures.length}`;
      output = { continue: true, systemMessage: `Conversation Lifeboat ${summary}. This is a bounded history sample, not measured outgoing request size.` };
      output.hookSpecificOutput = { hookEventName: input.hook_event_name, additionalContext: [
        `Conversation Lifeboat evidence: ${summary}.`,
        reassess ? 'Connection or compaction trouble was reported. Reassess recent failures before continuing; do not assume size is the cause.' : 'Assess the image/history evidence before recommending action.',
        tail.readable ? 'The bounded sample may omit older active images.' : 'The transcript is unavailable; current image payload is unknown.',
        'Token count, context-window percentage, transcript total size, missing token usage, and normal automatic compaction alone are never reasons to offer handoff.',
        canOffer ? 'You may briefly offer $conversation-handoff if the evidence supports persistent instability or abnormal image retention. Keep working on the current request; do not stop solely to ask about migration.' : 'Continue the current request without offering migration on these signals alone.',
        suppressed ? 'The user chose to stay. Do not repeat a migration offer at this or a lower severity.' : '',
        'Never create a task, edit specifications, or archive this task without explicit migration authorization. Use the user\'s language. Never claim history image bytes equal actual request bytes.',
      ].filter(Boolean).join(' ') };
    }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temporary, file);
  if (output) process.stdout.write(JSON.stringify(output));
}
try { main(); } catch {
  process.stderr.write('Conversation Lifeboat hook failed safely.\n');
  process.exitCode = 0;
}
