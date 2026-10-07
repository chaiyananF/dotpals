#!/usr/bin/env node
// App chats coordinate through the registry; only dispatch/delegate launch workers.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const HELP = `Dotpals task registry and mailbox

Read:
  node bin/team-center.js tasks [--session provider:UUID]
  node bin/team-center.js sessions
  node bin/team-center.js show --task TASK_UUID
  node bin/team-center.js inbox --session provider:UUID [--all]
  node bin/team-center.js inbox --user [--all]
  node bin/team-center.js options
  node bin/team-center.js runs [--task TASK_UUID]
  node bin/team-center.js run --run RUN_UUID [--wait 30]
  node bin/team-center.js context [--session provider:UUID]

Write (JSON payload from a file or explicitly from stdin):
  node bin/team-center.js create --file task.json
  node bin/team-center.js join --task TASK_UUID --file participant.json
  node bin/team-center.js update --task TASK_UUID --file update.json
  node bin/team-center.js bind --task TASK_UUID --file link.json
  node bin/team-center.js send --task TASK_UUID --file message.json
  node bin/team-center.js read --task TASK_UUID --message MESSAGE_UUID --file receipt.json
  node bin/team-center.js dispatch [--task TASK_UUID] --file dispatch.json
  node bin/team-center.js coordinate [--task TASK_UUID] [--session provider:UUID] --file task.json
  node bin/team-center.js delegate [--task TASK_UUID] [--session provider:UUID] --file worker.json
  node bin/team-center.js summary [--task TASK_UUID] [--session provider:UUID] --file summary.json

Use --stdin instead of --file to read JSON from stdin.
Default port: 5176. Override with --port PORT or DOTPALS_PORT.
Payload schemas and limitations: docs/task-mailbox.md
App chat coordination: docs/chat-coordinator.md
coordinate/context/delegate/summary use CODEX_THREAD_ID when --session is omitted.
`;
try {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(HELP); process.exit(0); }
  const command = args.shift();
  const options = {};
  const flags = new Set(['stdin', 'all', 'user']);
  const values = new Set(['file', 'task', 'message', 'session', 'port', 'run', 'wait']);
  while (args.length) {
    const argument = args.shift();
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const name = argument.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${argument}`);
    if (flags.has(name)) options[name] = true;
    else if (values.has(name) && args.length && !args[0].startsWith('--')) options[name] = args.shift();
    else throw new Error(`Unknown option or missing value: ${argument}`);
  }
  const port = Number(options.port ?? (process.env.DOTPALS_PORT || 5176));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local bridge port.');
  if (options.wait && (command !== 'run' || !Number.isFinite(Number(options.wait)) || Number(options.wait) < 0 || Number(options.wait) > 30)) throw new Error('--wait is available for run only, between 0 and 30 seconds.');
  const need = (name) => { if (!options[name]) throw new Error(`--${name} is required.`); return encodeURIComponent(options[name]); };
  const currentSession = () => {
    if (process.env.DOTPALS_ROLE && process.env.DOTPALS_ROLE !== 'raphael') throw new Error('Workers cannot act as the app coordinator. Return results to Raphael.');
    const session = options.session || (process.env.CODEX_THREAD_ID ? `codex:${process.env.CODEX_THREAD_ID}` : null);
    if (!session) throw new Error('Provide --session provider:UUID or run in the real Codex chat with CODEX_THREAD_ID.');
    return session;
  };
  const request = async (path, payload) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(15000), ...(payload ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(payload) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${data.error ?? 'Request failed.'}`);
    return data;
  };
  let path;
  let write = false;
  if (command === 'tasks') path = `/api/team/tasks${options.session ? `?session=${encodeURIComponent(options.session)}` : ''}`;
  else if (command === 'sessions') path = '/api/team/sessions';
  else if (command === 'options') path = '/api/team/dispatch/options';
  else if (command === 'runs') path = `/api/team/dispatch${options.task || process.env.DOTPALS_TASK_ID ? `?task=${encodeURIComponent(options.task || process.env.DOTPALS_TASK_ID)}` : ''}`;
  else if (command === 'run') path = `/api/team/dispatch/${need('run')}`;
  else if (command === 'context') path = `/api/team/coordinator?session=${encodeURIComponent(currentSession())}`;
  else if (command === 'show') path = `/api/team/tasks/${need('task')}`;
  else if (command === 'inbox') path = `/api/team/inbox?${options.user ? 'recipient=user' : `session=${need('session')}`}&unread=${options.all ? '0' : '1'}`;
  else if (['create', 'join', 'update', 'bind', 'send', 'read', 'dispatch', 'coordinate', 'delegate', 'summary'].includes(command)) {
    write = true;
    const action = { join: 'participants', update: 'update', bind: 'links', send: 'messages' };
    path = ['dispatch', 'delegate'].includes(command) ? '/api/team/dispatch' : command === 'coordinate' ? '/api/team/coordinator/attach' : command === 'summary' ? '/api/team/coordinator/summary' : command === 'create' ? '/api/team/tasks' : `/api/team/tasks/${need('task')}/${command === 'read' ? `messages/${need('message')}/read` : action[command]}`;
  } else throw new Error(`Unknown command: ${command}`);
  if (options.file && options.stdin) throw new Error('Choose --file or --stdin.');
  if (!write && (options.file || options.stdin)) throw new Error('Read commands do not accept a payload.');
  let payload;
  if (write) {
    if (!options.file && !options.stdin) throw new Error('Provide a JSON payload with --file or --stdin.');
    const raw = readFileSync(options.stdin ? 0 : options.file, 'utf8').replace(/^\uFEFF/, '');
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Payload exceeds 1 MB.');
    payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload must be a JSON object.');
    if (['coordinate', 'delegate', 'summary'].includes(command)) {
      const session = currentSession();
      if (payload.session && payload.session !== session) throw new Error('Payload session does not match the current app chat.');
      if (command !== 'delegate') payload.session = session;
      payload.taskId ??= options.task;
      if (command !== 'coordinate' && !payload.taskId) {
        const context = await request(`/api/team/coordinator?session=${encodeURIComponent(session)}`);
        if (!context.binding) throw new Error('Attach this chat to a task with coordinate first.');
        payload.taskId = context.binding.taskId;
      }
      if (command === 'delegate') {
        const { task } = await request(`/api/team/tasks/${encodeURIComponent(payload.taskId)}`);
        const person = task.participants.find((row) => row.id === task.coordinatorId);
        if (person?.session !== session || person.execution !== 'external') throw new Error('This chat is not the external coordinator of that task.');
        if (payload.from && payload.from !== person.id) throw new Error('Delegation sender cannot replace the bound coordinator.');
        if (payload.parentRunId) throw new Error('An app coordinator has no parent CLI run.');
        payload.from = person.id;
      }
      payload.idempotencyKey ??= randomUUID();
    }
    if (command === 'dispatch') {
      payload.taskId ??= options.task || process.env.DOTPALS_TASK_ID || undefined;
      payload.from ??= process.env.DOTPALS_PARTICIPANT_ID || 'user';
      payload.parentRunId ??= process.env.DOTPALS_DISPATCH_ID || undefined;
      payload.idempotencyKey ??= randomUUID();
    }
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(15000), ...(write ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(payload) } : {}) });
  let result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error ?? 'Request failed.'}`);
  if (options.wait) {
    const seconds = Number(options.wait);
    if (command !== 'run' || !Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw new Error('--wait is available for run only, between 0 and 30 seconds.');
    const deadline = Date.now() + seconds * 1000;
    while (['queued', 'running'].includes(result.run.status) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
      const next = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(15000) });
      result = await next.json(); if (!next.ok) throw new Error(result.error ?? 'Run read failed.');
    }
  }
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Dotpals: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`);
  process.exitCode = 1;
}
