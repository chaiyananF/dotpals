import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityLog } from '../bridge/activity.js';
import { applyHook, backfillTranscript, describeTool, lastReply } from '../bridge/adapters/claude.js';

const CWD = 'C:\\work\\proj';
let n = 0;
// The adapter remembers each session's first cwd, so every test gets its own session.
const newSession = () => `claude-test-${process.pid}-${n++}`;

const patchLinesOk = (patch) => patch.split('\n').every((l) => l.startsWith('-') || l.startsWith('+'));

test('describeTool: Read', () => {
  const d = describeTool('Read', { file_path: 'C:\\work\\proj\\src\\a.js' }, CWD);
  assert.equal(d.kind, 'read');
  assert.equal(d.title, 'src/a.js');
  assert.deepEqual(d.files, [{ path: 'C:\\work\\proj\\src\\a.js', change: 'read' }]);
});

test('describeTool: Edit gives a -/+ patch', () => {
  const d = describeTool('Edit', { file_path: '/work/proj/src/a.js', old_string: 'a\nb', new_string: 'c' }, '/work/proj');
  assert.equal(d.kind, 'edit');
  assert.equal(d.title, 'src/a.js');
  assert.equal(d.files[0].change, 'edit');
  assert.equal(d.body.patch, '-a\n-b\n+c');
  assert.ok(patchLinesOk(d.body.patch));
});

test('describeTool: Write gives an all-+ patch', () => {
  const d = describeTool('Write', { file_path: '/work/proj/README.md', content: 'hi\nthere' }, '/work/proj');
  assert.equal(d.kind, 'write');
  assert.equal(d.title, 'README.md');
  assert.equal(d.files[0].change, 'write');
  assert.equal(d.body.patch, '+hi\n+there');
  assert.ok(patchLinesOk(d.body.patch));
});

test('describeTool: Bash', () => {
  const d = describeTool('Bash', { command: 'npm test -- --watch=false', description: 'Run the tests' }, CWD);
  assert.equal(d.kind, 'run');
  assert.equal(d.title, 'Run the tests');
  assert.equal(d.detail, 'npm test -- --watch=false');
  assert.equal(d.body.command, 'npm test -- --watch=false');

  const bare = describeTool('Bash', { command: 'ls' }, CWD);
  assert.equal(bare.title, 'ls');
});

test('describeTool: Grep', () => {
  const d = describeTool('Grep', { pattern: 'TODO', glob: '*.js', path: 'C:\\work\\proj\\src' }, CWD);
  assert.equal(d.kind, 'search');
  assert.equal(d.title, 'TODO');
  assert.equal(d.detail, '*.js in src');
});

test('describeTool: MCP tools', () => {
  const d = describeTool('mcp__server__do_thing', { q: 1 }, CWD);
  assert.equal(d.kind, 'mcp');
  assert.equal(d.title, 'do thing');
  assert.equal(d.detail, 'server');
  assert.match(d.body.args, /"q": 1/);
});

test('describeTool: unknown tools', () => {
  const d = describeTool('Mystery', { a: 1 }, CWD);
  assert.equal(d.kind, 'tool');
  assert.equal(d.title, 'Mystery');
});

test('applyHook: PreToolUse then PostToolUse is one ok entry with ms', () => {
  const log = createActivityLog();
  const session = newSession();
  const ctx = { session, label: 'proj' };
  const common = { session_id: session, cwd: CWD, tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test' } };

  const [started] = applyHook({ ...common, hook_event_name: 'PreToolUse' }, log, ctx);
  assert.equal(started.status, 'running');
  applyHook({ ...common, hook_event_name: 'PostToolUse', tool_response: { stdout: 'passed', stderr: '' } }, log, ctx);

  const entries = log.all();
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.id, `${session}:toolu_1`);
  assert.equal(e.kind, 'run');
  assert.equal(e.harness, 'claude');
  assert.equal(e.status, 'ok');
  assert.equal(typeof e.ms, 'number');
  assert.ok(e.ms >= 0);
  assert.equal(e.body.command, 'npm test');
  assert.equal(e.body.output, 'passed');
});

test('applyHook: PostToolUse arriving before PreToolUse still ends ok', () => {
  const log = createActivityLog();
  const session = newSession();
  const ctx = { session, label: 'proj' };
  const common = { session_id: session, cwd: CWD, tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: { file_path: 'C:\\work\\proj\\a.js' } };

  applyHook({ ...common, hook_event_name: 'PostToolUse', tool_response: {} }, log, ctx);
  applyHook({ ...common, hook_event_name: 'PreToolUse' }, log, ctx);

  const entries = log.all();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'ok');
  assert.equal(entries[0].kind, 'read');
  assert.equal(entries[0].title, 'a.js');
});

test('applyHook: PostToolUseFailure marks the entry failed', () => {
  const log = createActivityLog();
  const session = newSession();
  const ctx = { session, label: 'proj' };
  const common = { session_id: session, cwd: CWD, tool_name: 'Bash', tool_use_id: 'toolu_f', tool_input: { command: 'false' } };
  applyHook({ ...common, hook_event_name: 'PreToolUse' }, log, ctx);
  applyHook({ ...common, hook_event_name: 'PostToolUseFailure', error: 'exit 1' }, log, ctx);
  const e = log.get(`${session}:toolu_f`);
  assert.equal(e.status, 'failed');
  assert.equal(e.error, 'exit 1');
});

test('applyHook: Stop settles running entries and adds a done entry', () => {
  const log = createActivityLog();
  const session = newSession();
  const ctx = { session, label: 'proj' };
  applyHook({ session_id: session, cwd: CWD, hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' }, log, ctx);
  applyHook({ session_id: session, cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: { command: 'sleep 100' } }, log, ctx);

  const changed = applyHook({ session_id: session, cwd: CWD, hook_event_name: 'Stop', last_assistant_message: 'All done.' }, log, ctx);

  assert.equal(log.get(`${session}:toolu_3`).status, 'stopped');
  const done = log.findLast(session, (x) => x.kind === 'done');
  assert.ok(done);
  assert.equal(done.status, 'ok');
  assert.equal(done.summary, 'All done.');
  assert.ok(changed.some((e) => e.id === `${session}:toolu_3`));
  assert.ok(log.findLast(session, (x) => x.kind === 'prompt' && x.title === 'fix the bug'));
});

test('applyHook: injected messages are not prompts', () => {
  const log = createActivityLog();
  const session = newSession();
  applyHook({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: '<system-reminder>x</system-reminder>' }, log, { session });
  assert.deepEqual(log.all(), []);
});

test('applyHook: pasted text becomes a placeholder; only a paste shows its first line', () => {
  const log = createActivityLog();
  const session = newSession();
  const paste = '<pasted_content id="37a9">\n### where is the summary\nIt is here.\n</pasted_content id="37a9">';
  applyHook({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: `${paste}\n\nmy last prompt and here it is` }, log, { session });
  assert.ok(log.findLast(session, (x) => x.kind === 'prompt' && x.title === 'my last prompt and here it is [pasted text]'));
  const other = newSession();
  applyHook({ session_id: other, hook_event_name: 'UserPromptSubmit', prompt: paste }, log, { session: other });
  assert.ok(log.findLast(other, (x) => x.kind === 'prompt' && x.title === 'Pasted: where is the summary'));
  // A paste of a copied recap that had a paste in it: Claude Code escapes the inner tags.
  const nested = newSession();
  applyHook({ session_id: nested, hook_event_name: 'UserPromptSubmit', prompt: '<pasted_content id="37a9">\n### <\\pasted_content id="37a9"> ### my last prompt and here it is\n</pasted_content id="37a9">' }, log, { session: nested });
  assert.ok(log.findLast(nested, (x) => x.kind === 'prompt' && x.title === 'Pasted: my last prompt and here it is'));
});

test('backfillTranscript rebuilds prompt, tool call and closing message', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-claude-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = newSession();
  const cwd = '/work/proj';
  const ts = (s) => `2026-09-30T10:00:0${s}.000Z`;
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: ts(0), cwd, message: { role: 'user', content: 'fix the bug' } },
    { type: 'assistant', uuid: 'a1', timestamp: ts(1), cwd, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', uuid: 'u2', timestamp: ts(3), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'passed' }] }, toolUseResult: { stdout: 'passed', stderr: '' } },
    { type: 'assistant', uuid: 'a2', timestamp: ts(4), cwd, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixed the bug.' }] } },
  ];
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const log = createActivityLog();
  const changed = await backfillTranscript(path, log, { session });
  assert.ok(changed.length >= 3);

  const entries = log.all();
  assert.deepEqual(entries.map((e) => e.kind), ['prompt', 'run', 'done']);
  const [prompt, run, done] = entries;
  assert.equal(prompt.title, 'fix the bug');
  assert.equal(prompt.label, 'proj');
  assert.equal(run.id, `${session}:toolu_9`);
  assert.equal(run.status, 'ok');
  assert.equal(run.ms, 2000);
  assert.equal(run.body.output, 'passed');
  assert.equal(done.status, 'ok');
  assert.equal(done.summary, 'Fixed the bug.');

  // Replaying the same transcript doesn't duplicate anything.
  await backfillTranscript(path, log, { session });
  assert.equal(log.all().length, 3);

  assert.equal(await lastReply(path), 'Fixed the bug.');
  assert.equal(await lastReply(path, Date.parse(ts(5))), null);
});

test('backfillTranscript on a missing file returns nothing', async () => {
  const log = createActivityLog();
  assert.deepEqual(await backfillTranscript(join(tmpdir(), 'dotpals-does-not-exist.jsonl'), log, { session: newSession() }), []);
});

test('watchClaude follows sessions that have no hooks, and skips ones that do', async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const { watchClaude } = await import('../bridge/adapters/claude.js');
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-claude-'));
  let stop = () => {};
  t.after(async () => {
    stop();
    await new Promise((r) => setTimeout(r, 150));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await mkdir(join(dir, 'C--work-proj'));
  const ts = (s) => new Date(Date.now() - 10_000 + s * 1000).toISOString();
  const cwd = '/work/proj';
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: ts(0), cwd, message: { role: 'user', content: 'rename the helper' } },
    { type: 'assistant', uuid: 'a1', timestamp: ts(1), cwd, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: `${cwd}/src/a.js`, old_string: 'a', new_string: 'b' } }] } },
    { type: 'user', uuid: 'u2', timestamp: ts(2), cwd, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
  ];
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await writeFile(join(dir, 'C--work-proj', 'free.jsonl'), text);
  await writeFile(join(dir, 'C--work-proj', 'hooked.jsonl'), text);

  const log = createActivityLog();
  const states = [];
  stop = watchClaude(log, { dir, interval: 50, emit: () => {}, state: (s, label, next) => states.push({ s, label, ...next }), skip: (s) => s === 'hooked' });
  await new Promise((r) => setTimeout(r, 300));

  const free = log.all().filter((e) => e.session === 'free');
  assert.deepEqual(free.map((e) => e.kind), ['prompt', 'edit']);
  assert.equal(free[1].status, 'ok');
  assert.equal(free[1].label, 'proj');
  assert.equal(log.all().filter((e) => e.session === 'hooked').length, 0);
  assert.equal(states.at(-1).s, 'free');
  assert.equal(states.at(-1).state, 'thinking');
});

test('contextOf: tokens in the window, and when its size is known', async () => {
  const { contextOf } = await import('../bridge/adapters/claude.js');
  const reply = (input, cacheRead) => ({ type: 'assistant', sessionId: 's1', timestamp: '2026-09-30T10:00:00Z', message: { usage: { input_tokens: input, cache_creation_input_tokens: 1000, cache_read_input_tokens: cacheRead, output_tokens: 50 } } });
  assert.deepEqual(contextOf(reply(10, 49_000)), { used: 50_010, size: 200_000, known: false, at: Date.parse('2026-09-30T10:00:00Z'), model: null, effort: null });
  const tuned = { ...reply(10, 49_000), effort: 'low', message: { ...reply(10, 49_000).message, model: 'claude-sonnet-5-5' } };
  assert.deepEqual([contextOf(tuned).model, contextOf(tuned).effort], ['claude-sonnet-5-5', 'low']);
  // Past 200k it must be a 1M window.
  assert.equal(contextOf(reply(10, 300_000)).size, 1_000_000);
  assert.equal(contextOf(reply(10, 300_000)).known, true);
  // The status line told us the size.
  assert.equal(contextOf(reply(10, 49_000), () => 1_000_000).known, true);
  assert.equal(contextOf({ type: 'user', message: {} }), null);
});

const reminder = (text) => ({ type: 'attachment', rendered: [{ content: `<system-reminder>\n${text}\n</system-reminder>`, renderedRole: 'system' }] });

test('ultracodeSwitch: only the on/off system-reminder counts', async () => {
  const { ultracodeSwitch } = await import('../bridge/adapters/claude.js');
  assert.equal(ultracodeSwitch(reminder('Ultracode is on: optimize for the most exhaustive answer')), true);
  assert.equal(ultracodeSwitch(reminder('Ultracode is off: use the Workflow tool only on request')), false);
  // The same words inside a prompt snapshot or a user message are documentation, not a switch.
  assert.equal(ultracodeSwitch({ type: 'attachment', attachment: { type: 'prompt_snapshot' }, rendered: [{ content: 'Ultracode is on for the session (a system-reminder confirms it)' }] }), null);
  assert.equal(ultracodeSwitch({ type: 'user', message: { content: 'Ultracode is on' } }), null);
  assert.equal(ultracodeSwitch({ type: 'attachment' }), null);
});

test('contextOf: ultracode relabels only the xhigh effort it is logged as', async () => {
  const { contextOf } = await import('../bridge/adapters/claude.js');
  const reply = (effort) => ({ type: 'assistant', sessionId: 's1', timestamp: '2026-09-30T10:00:00Z', effort, message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 } } });
  assert.equal(contextOf(reply('xhigh'), () => null, true).effort, 'ultracode');
  assert.equal(contextOf(reply('xhigh'), () => null, false).effort, 'xhigh');
  assert.equal(contextOf(reply('low'), () => null, true).effort, 'low');
});

test('watchClaude shows ultracode from the reminder until it is turned off', async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const { watchClaude } = await import('../bridge/adapters/claude.js');
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-claude-'));
  let stop = () => {};
  t.after(async () => {
    stop();
    await new Promise((r) => setTimeout(r, 150));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await mkdir(join(dir, 'C--work-proj'));
  const file = join(dir, 'C--work-proj', 'ultra.jsonl');
  const ts = (s) => new Date(Date.now() - 10_000 + s * 1000).toISOString();
  const reply = (id, s, effort) => ({ type: 'assistant', uuid: id, sessionId: 'ultra', timestamp: ts(s), cwd: '/work/proj', effort, message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10 + s, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 } } });
  const write = (rows) => writeFile(file, `${rows.map((l) => JSON.stringify(l)).join('\n')}\n`);

  const contexts = [];
  stop = watchClaude(createActivityLog(), { dir, interval: 50, emit: () => {}, state: () => {}, context: (session, label, next) => contexts.push(next.effort) });
  const settle = () => new Promise((r) => setTimeout(r, 300));

  const first = [
    { type: 'attachment', rendered: [{ content: '<system-reminder>\nUse the Workflow tool. Ultracode is on for the session.\n</system-reminder>' }] },
    reply('a0', 0, 'low'),
  ];
  await write(first);
  await settle();
  assert.equal(contexts.at(-1), 'low', 'prose that merely mentions ultracode does not switch it on');

  const on = [...first, reminder('Ultracode is on: optimize for the most exhaustive answer'), reply('a1', 1, 'xhigh')];
  await write(on);
  await settle();
  assert.equal(contexts.at(-1), 'ultracode');

  await write([...on, reminder('Ultracode is off: back to the opt-in rule'), reply('a2', 2, 'xhigh')]);
  await settle();
  assert.equal(contexts.at(-1), 'xhigh', 'turned off, so the logged effort shows again');
});
