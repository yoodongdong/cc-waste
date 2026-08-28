import fs from 'node:fs';
import readline from 'node:readline';

// Heuristic thresholds — tuned to flag clearly-oversized reads/pastes, not
// every large-ish message. All "waste" numbers this module produces are
// estimates (chars / 4 ~= tokens), never exact.
const CHARS_PER_TOKEN = 4;
const LARGE_RESULT_CHARS = 20000; // ~5,000 tokens in one tool result
const LARGE_PASTE_CHARS = 8000; // ~2,000 tokens pasted directly into a user turn
const REPEATED_READ_THRESHOLD = 2; // same file re-read (no offset/limit) this many times+
const MIN_TURNS_FOR_CACHE_CHECK = 3;
const LOW_CACHE_HIT_RATE = 0.4;

function estimateTokens(chars) {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function textLenOfToolResultContent(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        return sum + block.text.length;
      }
      return sum;
    }, 0);
  }
  return 0;
}

function summarizeToolInput(name, input) {
  if (!input) return name;
  if (name === 'Read' && input.file_path) return input.file_path;
  if (name === 'Bash' && input.command) return truncate(input.command, 100);
  if ((name === 'Grep' || name === 'Glob') && (input.pattern || input.glob)) {
    return truncate(input.pattern || input.glob, 100);
  }
  try {
    return truncate(JSON.stringify(input), 100);
  } catch {
    return name;
  }
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function addUsage(target, delta) {
  target.inputTokens += delta.input_tokens || delta.inputTokens || 0;
  target.outputTokens += delta.output_tokens || delta.outputTokens || 0;
  target.cacheCreationTokens += delta.cache_creation_input_tokens || delta.cacheCreationTokens || 0;
  target.cacheReadTokens += delta.cache_read_input_tokens || delta.cacheReadTokens || 0;
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

export async function parseSessionFile(filePath, projectSlug) {
  const session = {
    projectSlug,
    filePath,
    sessionId: null,
    cwd: null,
    startTime: null,
    endTime: null,
    messageCount: 0,
    usage: emptyUsage(),
    perModel: new Map(),
    findings: [],
    skillInvocations: new Map(), // skill name -> call count
  };

  const pendingToolUses = new Map(); // tool_use_id -> { name, input }
  const readFileStats = new Map(); // file_path -> { count, lastChars }
  let assistantTurnsWithUsage = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, 'utf8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (session.sessionId === null && entry.sessionId) session.sessionId = entry.sessionId;
    if (session.cwd === null && entry.cwd) session.cwd = entry.cwd;
    if (entry.timestamp) {
      if (!session.startTime || entry.timestamp < session.startTime) session.startTime = entry.timestamp;
      if (!session.endTime || entry.timestamp > session.endTime) session.endTime = entry.timestamp;
    }
    session.messageCount++;

    if (entry.type === 'assistant' && entry.message) {
      const msg = entry.message;
      const model = msg.model || 'unknown';

      if (msg.usage) {
        assistantTurnsWithUsage++;
        addUsage(session.usage, msg.usage);
        if (!session.perModel.has(model)) session.perModel.set(model, emptyUsage());
        addUsage(session.perModel.get(model), msg.usage);
      }

      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use' && block.id) {
            pendingToolUses.set(block.id, { name: block.name, input: block.input || {} });
            if (block.name === 'Skill' && block.input && block.input.skill) {
              const skillName = block.input.skill;
              session.skillInvocations.set(skillName, (session.skillInvocations.get(skillName) || 0) + 1);
            }
          }
        }
      }
    } else if (entry.type === 'user' && entry.message) {
      const msg = entry.message;
      const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];

      for (const block of blocks) {
        if (!block) continue;

        if (block.type === 'tool_result' && block.tool_use_id) {
          const toolUse = pendingToolUses.get(block.tool_use_id);
          const chars = textLenOfToolResultContent(block.content);
          if (toolUse) {
            if (
              toolUse.name === 'Read' &&
              toolUse.input &&
              toolUse.input.file_path &&
              !toolUse.input.offset &&
              !toolUse.input.limit
            ) {
              const fp = toolUse.input.file_path;
              const rec = readFileStats.get(fp) || { count: 0, lastChars: 0 };
              rec.count++;
              rec.lastChars = chars;
              readFileStats.set(fp, rec);
            }

            if (chars > LARGE_RESULT_CHARS) {
              session.findings.push({
                type: 'large-tool-result',
                tool: toolUse.name,
                detail: summarizeToolInput(toolUse.name, toolUse.input),
                chars,
                estTokens: estimateTokens(chars),
                timestamp: entry.timestamp,
              });
            }
            pendingToolUses.delete(block.tool_use_id);
          }
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > LARGE_PASTE_CHARS) {
          session.findings.push({
            type: 'large-user-paste',
            detail: truncate(block.text.replace(/\s+/g, ' ').trim(), 100),
            chars: block.text.length,
            estTokens: estimateTokens(block.text.length),
            timestamp: entry.timestamp,
          });
        }
      }
    }
  }

  for (const [filePathRead, rec] of readFileStats) {
    if (rec.count >= REPEATED_READ_THRESHOLD) {
      const wastedChars = rec.lastChars * (rec.count - 1);
      session.findings.push({
        type: 'repeated-full-read',
        detail: filePathRead,
        count: rec.count,
        chars: wastedChars,
        estTokens: estimateTokens(wastedChars),
        timestamp: session.endTime,
      });
    }
  }

  const totalInputSide = session.usage.inputTokens + session.usage.cacheCreationTokens + session.usage.cacheReadTokens;
  if (assistantTurnsWithUsage >= MIN_TURNS_FOR_CACHE_CHECK && totalInputSide > 0) {
    const cacheHitRate = session.usage.cacheReadTokens / totalInputSide;
    session.cacheHitRate = cacheHitRate;
    if (cacheHitRate < LOW_CACHE_HIT_RATE) {
      session.findings.push({
        type: 'low-cache-hit-rate',
        detail: `${(cacheHitRate * 100).toFixed(0)}% cache hit rate over ${assistantTurnsWithUsage} turns`,
        rate: cacheHitRate,
        timestamp: session.endTime,
      });
    }
  }

  return session;
}
