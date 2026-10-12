// Stream-json can contain arbitrarily many tool records. Keep one bounded line,
// then retain only the final result; intermediate tool/text content is discarded.
export function createClaudeResult({ maxBytes = 8 * 1024 * 1024 } = {}) {
  let carry = '', bytes = 0, dropping = false, result, sessionId, oversizedRecords = 0, malformedRecords = 0;
  function consume() {
    if (!dropping && carry.trim()) {
      try {
        const row = JSON.parse(carry);
        if (row?.type === 'system' && row.subtype === 'init' && typeof row.session_id === 'string') sessionId = row.session_id;
        if (row && typeof row === 'object' && !Array.isArray(row) && row.session_id && (row.type === 'result' || row.subtype && row.type == null)) result = row;
      } catch { malformedRecords++; }
    }
    carry = ''; bytes = 0; dropping = false;
  }
  return {
    push(chunk) {
      let start = 0;
      for (;;) {
        const end = chunk.indexOf('\n', start);
        const part = chunk.slice(start, end < 0 ? undefined : end);
        if (!dropping) {
          bytes += Buffer.byteLength(part, 'utf8');
          if (bytes > maxBytes) { carry = ''; dropping = true; oversizedRecords++; }
          else carry += part;
        }
        if (end < 0) break;
        consume(); start = end + 1;
      }
    },
    finish() { consume(); return result; },
    diagnostics() { return { sessionId, oversizedRecords, malformedRecords }; },
  };
}
