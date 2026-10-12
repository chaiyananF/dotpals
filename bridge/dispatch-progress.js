import { DISPATCH_TIMEOUT_MS } from '../src/run-progress.js';

// Only fixed categories leave this parser. Never expose tool args/text/reasoning.
function kindOf(record) {
  if (record.type === 'thread.started' || record.type === 'system' && record.subtype === 'init') return 'session-start';
  if (record.type === 'turn.completed' || record.type === 'result') return 'provider-finished';
  if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
    const content = record.message.content;
    if (content.some((block) => block?.type === 'tool_use')) return 'tool-start';
    if (content.some((block) => block?.type === 'text')) return 'message';
    if (content.some((block) => ['thinking', 'redacted_thinking'].includes(block?.type))) return 'thinking';
  }
  if (record.type === 'user' && Array.isArray(record.message?.content) && record.message.content.some((block) => block.type === 'tool_result')) return 'tool-finished';
  if (['item.started', 'item.completed'].includes(record.type)) {
    if (record.item?.type === 'reasoning') return 'thinking';
    if (record.item?.type === 'agent_message') return 'message';
    if (['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(record.item?.type)) return record.type === 'item.started' ? 'tool-start' : 'tool-finished';
  }
  return 'output';
}

export function createRunProgress({ publish, onError = () => {}, now = Date.now, throttleMs = 1000 }) {
  let carry = '', dropping = false, timer, closed = false, dirty = true, lastPublished = -Infinity;
  const progress = { timeoutMs: DISPATCH_TIMEOUT_MS, lastActivityAt: new Date(now()).toISOString(), lastActivityKind: 'launch', lastActivitySource: 'broker', stdoutBytes: 0, stderrBytes: 0 };
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (closed || !dirty) return;
    dirty = false; lastPublished = now();
    try { publish({ ...progress }); }
    catch (error) { closed = true; onError(error); }
  };
  const schedule = () => {
    dirty = true;
    if (now() - lastPublished >= throttleMs) flush();
    else if (!timer) { timer = setTimeout(flush, throttleMs - (now() - lastPublished)); timer.unref?.(); }
  };
  function push(source, chunk) {
    if (closed) return;
    progress[source === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += Buffer.byteLength(chunk, 'utf8');
    progress.lastActivityAt = new Date(now()).toISOString();
    progress.lastActivitySource = source;
    progress.lastActivityKind = source === 'stdout' ? 'output' : 'stderr';
    if (source === 'stdout') {
      const parts = chunk.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (!dropping) {
          carry += parts[i];
          if (carry.length > 64 * 1024) { carry = ''; dropping = true; }
        }
        if (i < parts.length - 1) {
          if (!dropping) { try { progress.lastActivityKind = kindOf(JSON.parse(carry)); } catch {} }
          carry = ''; dropping = false;
        }
      }
    }
    schedule();
  }
  return { stdout: (chunk) => push('stdout', chunk), stderr: (chunk) => push('stderr', chunk), flush,
    close() { flush(); closed = true; clearTimeout(timer); carry = ''; },
  };
}
