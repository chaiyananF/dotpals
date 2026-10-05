#!/usr/bin/env node
// Per-run stdio MCP adapter. It exposes only the current task, never arbitrary URLs.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const port = Number(process.env.DOTPALS_PORT);
const taskId = process.env.DOTPALS_TASK_ID;
const participantId = process.env.DOTPALS_PARTICIPANT_ID;
const parentRunId = process.env.DOTPALS_DISPATCH_ID;
const coordinator = process.env.DOTPALS_ROLE === 'raphael';
if (!Number.isInteger(port) || port < 1 || port > 65535 || !taskId || !participantId) { console.error('Dotpals MCP requires a bound local task/run environment.'); process.exit(1); }
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
const tool = (name, description, inputSchema, readOnly = true) => ({ name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly } });
const tools = [
  tool('task', 'Read the current task, its participants and message history.', schema()),
  tool('runs', 'List dispatch progress for this task. Read one run for its complete response.', schema()),
  tool('run', 'Read one task run; optionally wait up to 30 seconds for its terminal result before reading again.', schema({ runId: str, waitSeconds: { type: 'integer', minimum: 0, maximum: 30 } }, ['runId'])),
  tool('options', 'Read installed providers, models and the configured team folder.', schema()),
  ...(coordinator ? [tool('dispatch', 'Delegate one scoped assignment through Dotpals. Returns a queued run; inspect it with run. Workers cannot redelegate.', schema({ agent: { enum: ['claude', 'codex', 'antigravity'] }, role: { enum: ['petros', 'nathaniel', 'thomas', 'matthew', 'philip', 'andrew'] }, prompt: { type: 'string', maxLength: 8000 }, participantId: str, model: str, effort: str, codeDir: str, allowCodeWrites: { type: 'boolean' }, idempotencyKey: str }, ['agent', 'prompt']), false)] : []),
];
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(15000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`); return data;
}
async function call(name, args = {}) {
  if (!tools.some((entry) => entry.name === name)) throw new Error('Tool is unavailable for this role.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected tool arguments object.');
  if (name === 'task') return api(`/api/team/tasks/${encodeURIComponent(taskId)}`);
  if (name === 'options') return api('/api/team/dispatch/options');
  if (name === 'runs') {
    const data = await api(`/api/team/dispatch?task=${encodeURIComponent(taskId)}`);
    return { runs: data.runs.map(({ response, prompt, ...progress }) => progress) };
  }
  if (name === 'run') {
    if (typeof args.runId !== 'string') throw new Error('runId is required.');
    const waitSeconds = args.waitSeconds ?? 0;
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) throw new Error('waitSeconds must be an integer from 0 to 30.');
    const deadline = Date.now() + waitSeconds * 1000;
    while (true) {
      const data = await api(`/api/team/dispatch/${encodeURIComponent(args.runId)}`);
      if (data.run.taskId !== taskId) throw new Error('Run belongs to a different task.');
      if (!['queued', 'running'].includes(data.run.status) || Date.now() >= deadline) return data;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    }
  }
  if (name === 'dispatch') {
    // Explicit allow-list: callers cannot replace bound task/from/parent identities.
    const payload = Object.fromEntries(['agent', 'role', 'prompt', 'participantId', 'model', 'effort', 'codeDir', 'allowCodeWrites', 'idempotencyKey'].filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]]));
    return api('/api/team/dispatch', { ...payload, taskId, from: participantId, parentRunId, idempotencyKey: payload.idempotencyKey ?? randomUUID() });
  }
}
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let initialized = false;
async function handle(message) {
  const hasId = Object.hasOwn(message, 'id');
  if (message.method === 'notifications/initialized') { initialized = true; return; }
  if (!hasId) return;
  const id = message.id;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return write({ id, error: { code: -32600, message: 'Invalid JSON-RPC request.' } });
  if (message.method === 'initialize') return write({ id, result: { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dotpals-team', version: '0.1.0' }, instructions: 'Task-bound local tools. Only Raphael may dispatch. Results are not independent QA.' } });
  if (message.method === 'ping') return write({ id, result: {} });
  if (!initialized) return write({ id, error: { code: -32000, message: 'Initialize the MCP session first.' } });
  if (message.method === 'tools/list') return write({ id, result: { tools } });
  if (message.method === 'tools/call') {
    try { const data = await call(message.params?.name, message.params?.arguments); write({ id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } }); }
    catch (err) { write({ id, result: { content: [{ type: 'text', text: err.message }], isError: true } }); }
    return;
  }
  write({ id, error: { code: -32601, message: 'Method not supported.' } });
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (Buffer.byteLength(line) > 1024 * 1024) { write({ id: null, error: { code: -32600, message: 'Message exceeds 1 MB.' } }); return; }
  let message;
  try { message = JSON.parse(line); } catch { write({ id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) { write({ id: null, error: { code: -32600, message: 'Invalid request.' } }); return; }
  handle(message).catch((err) => console.error('Dotpals MCP:', err.message));
});
