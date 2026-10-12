import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCommand } from '../bridge/handoff.js';
import { conversationMessages, findTranscript, nativeSession, readConversation, sameProject, sessionCatalog } from '../bridge/session-center.js';

const C = '019ab123-1234-7000-8123-123456789abc';
const A = '019ab456-1234-7000-8123-123456789abc';
const B = '019ab789-1234-7000-8123-123456789abc';
const home = await mkdtemp(join(tmpdir(), 'dotpals-center-'));
after(() => rm(home, { recursive: true, force: true }));
process.env.DOTPALS_HOME = home;
process.env.DOTPALS_CODEX = '0';
process.env.DOTPALS_CLAUDE_LOGS = '0';
process.env.DOTPALS_HISTORY = '0';
const { startBridge } = await import('../bridge/server.js');

test('native session IDs and full project paths select the correct destination', () => {
  assert.deepEqual(nativeSession(`codex:${C}`, 'codex'), { agent: 'codex', nativeId: C });
  assert.deepEqual(nativeSession(A, 'claude'), { agent: 'claude', nativeId: A });
  assert.equal(nativeSession(`codex:${C}`, 'claude'), null);
  assert.equal(nativeSession('x & echo hello', 'codex'), null);
  assert.equal(nativeSession(C, 'generic'), null);
  assert.equal(sameProject('C:\\Work\\Shop\\', 'c:/work/shop', 'win32'), true);
  assert.equal(sameProject('/a/shop', '/b/shop', 'linux'), false);
  const rows = sessionCatalog([
    { session: `codex:${C}`, harness: 'codex', at: 2, kind: 'prompt', title: 'latest request' },
    { session: `codex:${C}`, harness: 'codex', at: 1, kind: 'prompt', title: 'old request' },
    { session: A, harness: 'claude', at: 3, kind: 'done' },
  ], new Map([[A, { cwd: '/w/shop' }]]), new Map([[A, { state: 'working' }]]));
  assert.equal(rows[0].busy, true);
  assert.equal(rows[1].title, 'latest request');
  assert.equal(sessionCatalog([{ session: `codex:${C}`, harness: 'codex' }], new Map([[`codex:${C}`, { internal: true }]])).length, 0, 'approval-review sessions are not hand-off destinations');
});

test('catalog diagnostics distinguish state time from activity time and preserve legacy busy states', () => {
  const entries = [{ session: `codex:${C}`, harness: 'codex', at: 9000, kind: 'prompt', title: 'request' }];
  const states = new Map([[`codex:${C}`, { state: 'waiting', at: 1234, source: 'codex-transcript', event: 'fixture-event' }]]);
  const row = sessionCatalog(entries, new Map(), states)[0];
  assert.deepEqual({ state: row.state, at: row.stateAt, source: row.stateSource, event: row.stateEvent, busy: row.busy },
    { state: 'waiting', at: 1234, source: 'codex-transcript', event: 'fixture-event', busy: true });
  states.set(`codex:${C}`, 'working');
  const legacy = sessionCatalog(entries, new Map(), states)[0];
  assert.equal(legacy.busy, true);
  assert.equal(legacy.state, 'working');
  assert.equal(legacy.stateAt, null);
  assert.equal(legacy.stateSource, 'unknown');
  assert.equal(legacy.stateEvent, null);
  states.clear();
  assert.equal(sessionCatalog(entries, new Map(), states)[0].state, 'unknown');
});

test('team API exposes recorded diagnostics and keeps native-busy dispatch at HTTP 409', async (t) => {
  const previous = process.env.DOTPALS_CODEX_CLI;
  // Exists for executable discovery but cannot launch a process even if the guard regresses.
  process.env.DOTPALS_CODEX_CLI = join(home, 'stub-codex-not-executable');
  await writeFile(process.env.DOTPALS_CODEX_CLI, '');
  t.after(() => previous === undefined ? delete process.env.DOTPALS_CODEX_CLI : (process.env.DOTPALS_CODEX_CLI = previous));
  const server = await startBridge({ port: 0, log: () => {} });
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const before = Date.now();
  const response = await fetch(`${url}/event`, { method: 'POST', body: JSON.stringify({ session: `codex:${C}`, harness: 'codex', state: 'working', type: 'fixture-event', cwd: home,
    activity: { id: 'fixture-api-prompt', kind: 'prompt', title: 'Fixture API request.' } }) });
  assert.equal(response.status, 200);
  const catalog = await (await fetch(`${url}/api/team/sessions`)).json();
  const row = catalog.sessions.find((entry) => entry.session === `codex:${C}`);
  assert.equal(row.state, 'working');
  assert.equal(row.busy, true);
  assert.equal(row.stateSource, 'generic-event');
  assert.equal(row.stateEvent, 'fixture-event');
  assert.ok(row.stateAt >= before && row.stateAt <= Date.now());
  const created = await fetch(`${url}/api/team/tasks`, { method: 'POST', headers: { 'x-dotpals': '1' }, body: JSON.stringify({ title: 'Fixture busy diagnostics', goal: 'Check refusal.', contextDir: home, codeDir: home, coordinator: { session: `claude:${A}` } }) });
  assert.equal(created.status, 201);
  const { task } = await created.json();
  const blocked = await fetch(`${url}/api/team/dispatch`, { method: 'POST', headers: { 'x-dotpals': '1' }, body: JSON.stringify({ agent: 'codex', taskId: task.id, session: row.session, role: 'petros', prompt: 'Fixture resume.', idempotencyKey: 'fixture-busy-api', codeDir: home }) });
  assert.equal(blocked.status, 409);
  const { error } = await blocked.json();
  assert.ok(error.includes(`state=working; stateAt=${new Date(row.stateAt).toISOString()}; source=generic-event; event=fixture-event`), error);
  for (const [extra, expected] of [
    [{ event: 'message_start' }, 'message_start'],
    [{ state: 'working', type: { unexpected: 'object' } }, null],
    [{ state: 'working', type: 'x'.repeat(5000) }, 'x'.repeat(79) + '…'],
    [{ state: 'working', type: 'line\nbreak\r\0' }, 'line break'],
  ]) {
    await fetch(`${url}/event`, { method: 'POST', body: JSON.stringify({ session: row.session, harness: 'codex', ...extra }) });
    const updated = (await (await fetch(`${url}/api/team/sessions`)).json()).sessions.find((entry) => entry.session === row.session);
    assert.equal(updated.stateEvent, expected);
  }
  const runs = await (await fetch(`${url}/api/team/dispatch`)).json();
  assert.equal(runs.runs.length, 0, 'no native run was prepared');
});

test('bridge stores Codex transcript provenance through completion and the next turn', async (t) => {
  const saved = { DOTPALS_CODEX: process.env.DOTPALS_CODEX, DOTPALS_CODEX_DIR: process.env.DOTPALS_CODEX_DIR };
  delete process.env.DOTPALS_CODEX;
  const dir = await mkdtemp(join(home, 'bridge-codex-'));
  process.env.DOTPALS_CODEX_DIR = dir;
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value); });
  const now = new Date();
  const folder = join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'rollout-bridge-fixture.jsonl');
  const at = Date.now() - 1000;
  const record = (offset, type, payload) => JSON.stringify({ timestamp: new Date(at + offset).toISOString(), type, payload }) + '\n';
  await writeFile(file, record(-100, 'session_meta', { id: C, cwd: dir }) + record(-90, 'event_msg', { type: 'user_message', message: 'Fixture bridge request.' }) + record(0, 'event_msg', { type: 'task_complete', turn_id: 'fixture-bridge' }));
  const server = await startBridge({ port: 0, log: () => {} });
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await sleep(80); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const current = async () => (await (await fetch(`${url}/api/team/sessions`)).json()).sessions.find((entry) => entry.session === `codex:${C}`);
  const done = await current();
  assert.equal(done.state, 'done');
  assert.equal(done.busy, false);
  assert.equal(done.stateAt, at);
  assert.equal(done.stateSource, 'codex-transcript');
  assert.equal(done.stateEvent, 'event_msg/task_complete');
  await appendFile(file, record(100, 'event_msg', { type: 'task_started', turn_id: 'fixture-next' }));
  let working;
  for (let i = 0; i < 100; i++) { working = await current(); if (working.state === 'thinking') break; await sleep(25); }
  assert.equal(working.state, 'thinking');
  assert.equal(working.busy, true);
  assert.equal(working.stateAt, at + 100);
  assert.equal(working.stateSource, 'codex-transcript');
  assert.equal(working.stateEvent, 'event_msg/task_started');
});

test('resume commands retain a native ID without creating a new prompt', () => {
  const has = (c) => c === 'wt';
  assert.deepEqual(launchCommand({ platform: 'win32', agent: 'codex', dir: 'C:\\work', resumeId: C, has }).args,
    ['-d', '"C:\\work"', 'cmd', '/k', 'codex', '"resume"', `"${C}"`]);
  const resumed = launchCommand({ platform: 'linux', agent: 'claude', dir: '/w', resumeId: A, prompt: 'Read the hand-off note', has: () => true });
  assert.deepEqual(resumed.args, ['--working-directory=/w', '--', 'claude', '--resume', A, 'Read the hand-off note']);
  assert.ok(launchCommand({ agent: 'claude', dir: '/w', resumeId: 'id;run-command' }).error);
  assert.ok(launchCommand({ agent: 'gemini', dir: '/w', resumeId: A }).error);
});

const codexRecords = [
  { type: 'session_meta', payload: { id: C } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'Full user request' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Full user request' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'analysis', content: [{ type: 'output_text', text: 'internal reasoning' }] } },
  { type: 'response_item', payload: { type: 'function_call_output', output: 'tool-only data' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Final answer without clipping' }] } },
];
test('conversation export keeps visible user/assistant text without duplicate events or tool/internal records', () => {
  const messages = conversationMessages(codexRecords, 'codex', C);
  assert.deepEqual(messages.map((m) => m.text), ['Full user request', 'Final answer without clipping']);
  assert.throws(() => conversationMessages(codexRecords, 'codex', A), /does not match/);
  const claude = [
    { sessionId: A, type: 'user', message: { content: 'request' } },
    { sessionId: A, type: 'user', message: { content: [{ type: 'tool_result', content: 'secret tool result' }] } },
    { sessionId: A, type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'helper' }] } },
    { sessionId: A, type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'answer' }] } },
  ];
  assert.deepEqual(conversationMessages(claude, 'claude', A).map((m) => m.text), ['request', 'answer']);
  assert.throws(() => conversationMessages([], 'codex', C), /verify/);
});

test('original conversation lookup stays inside native log roots and verifies the recorded ID', async () => {
  const directories = { codex: join(home, 'codex'), claude: join(home, 'claude') };
  const folder = join(directories.codex, '2026', '10', '02');
  await mkdir(folder, { recursive: true });
  const file = join(folder, `rollout-2026-${C}.jsonl`);
  await writeFile(file, codexRecords.map((r) => JSON.stringify(r)).join('\n'));
  assert.equal(await findTranscript('codex', C, { directories }), file);
  const chat = await readConversation({ agent: 'codex', nativeId: C }, { directories });
  assert.equal(chat.messages, 2);
  assert.match(chat.text, /Final answer without clipping/);
  const outside = join(home, `rollout-${C}.jsonl`);
  await writeFile(outside, '{}');
  await assert.rejects(findTranscript('codex', C, { directories, hint: outside }), /outside/);
  await assert.rejects(findTranscript('codex', A, { directories }), /no longer available/);
});

test('session API resumes the recorded session, hands off to an existing peer, and rejects busy/cross-project targets', async (t) => {
  const launched = [];
  let conversationError;
  let targetGone = false;
  const server = await startBridge({ port: 0, log: () => {}, handoff: {
    platform: 'linux', has: () => true, isFolder: (d) => ['/w/shop', '/other/shop'].includes(d),
    launch: async (cmd) => launched.push(cmd), findTranscript: async () => { if (targetGone) throw new Error('Native session file is gone'); return '/native/session.jsonl'; },
    readConversation: async () => { if (conversationError) throw new Error(conversationError); return { text: '# Full source conversation\nUser request', messages: 2 }; },
  } });
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const event = (id, harness, cwd, state = 'done') => fetch(`${url}/event`, { method: 'POST', body: JSON.stringify({ session: id, harness, cwd, state, activity: { id: `${id}:prompt`, kind: 'prompt', title: `Work from ${harness}` } }) });
  const call = (body, headers = { 'x-dotpals': '1' }) => fetch(`${url}/api/handoff`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  await event(`codex:${C}`, 'codex', '/w/shop');
  await event(A, 'claude', '/w/shop');
  await event(B, 'claude', '/other/shop');
  const catalog = await (await fetch(`${url}/api/handoff/sessions?session=codex:${C}`)).json();
  assert.equal(catalog.source.nativeId, C);
  assert.deepEqual(catalog.targets.map((s) => s.session), [A]);
  const claudeCatalog = await (await fetch(`${url}/api/handoff/sessions?session=claude:${A}`)).json();
  assert.equal(claudeCatalog.source.session, A, 'the canonical registry ID resolves the existing bare Claude activity ID');
  assert.equal(claudeCatalog.targets.some((s) => s.session === A), false, 'aliases never include the source as its own destination');
  assert.equal((await call({ session: `codex:${C}`, agent: 'codex', action: 'resume' }, {})).status, 403);
  const resumed = await call({ session: `codex:${C}`, agent: 'codex', action: 'resume' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.file, undefined, 'resume needs no synthetic hand-off');
  assert.deepEqual(launched[0].args, ['--working-directory=/w/shop', '--', 'codex', 'resume', C]);
  const handoff = await call({ session: `codex:${C}`, agent: 'claude', targetSession: A, includeTranscript: true, assignment: 'Review the latest changes' });
  assert.equal(handoff.status, 200, JSON.stringify(handoff.body));
  assert.equal(handoff.body.targetSession, A);
  assert.deepEqual(launched[1].args.slice(0, 5), ['--working-directory=/w/shop', '--', 'claude', '--resume', A]);
  assert.match(await readFile(handoff.body.file, 'utf8'), /Review the latest changes/);
  assert.match(await readFile(handoff.body.conversationFile, 'utf8'), /Full source conversation/);
  const bareLinks = await (await fetch(`${url}/api/handoff/links?session=${A}`)).json();
  const namedLinks = await (await fetch(`${url}/api/handoff/links?session=claude:${A}`)).json();
  assert.equal(bareLinks.links[0].id, handoff.body.link.id);
  assert.deepEqual(bareLinks.links, namedLinks.links);
  assert.equal((await call({ session: `codex:${C}`, agent: 'claude', targetSession: B })).status, 409);
  assert.equal((await call({ session: `codex:${C}`, agent: 'codex', targetSession: A })).status, 409);
  await event(A, 'claude', '/w/shop', 'working');
  assert.equal((await call({ session: `codex:${C}`, agent: 'claude', targetSession: A })).status, 409);
  assert.equal(launched.length, 2, 'rejected requests never launch agents');
  const chat = await (await fetch(`${url}/api/sessions/codex:${C}/conversation`)).json();
  assert.equal(chat.messages, 2);
  await event(A, 'claude', '/w/shop', 'done');
  conversationError = 'Source conversation is gone';
  assert.equal((await call({ session: `codex:${C}`, agent: 'claude', targetSession: A, includeTranscript: true })).status, 409);
  targetGone = true;
  assert.equal((await call({ session: `codex:${C}`, agent: 'codex', action: 'resume' })).status, 409);
  assert.equal((await call({ session: `codex:${C}`, agent: 'claude', assignment: {} })).status, 400);
  assert.equal(launched.length, 2, 'missing conversation files do not silently launch a fresh session');
});

test('restored internal approval history is absent from the center and cannot be dispatched', async (t) => {
  await writeFile(join(home, 'history.json'), JSON.stringify({
    sessions: { [`codex:${C}`]: { cwd: '/w/shop' }, [`codex:${B}`]: { cwd: '/w/shop', internal: true } },
    entries: [
      { id: 'real-user', session: `codex:${C}`, harness: 'codex', kind: 'prompt', title: 'Real work', status: 'info', at: Date.now() },
      { id: 'internal-review', session: `codex:${B}`, harness: 'codex', kind: 'prompt', title: 'Internal approval', status: 'info', at: Date.now() },
    ],
  }));
  process.env.DOTPALS_HISTORY = '1';
  const server = await startBridge({ port: 0, log: () => {} });
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); process.env.DOTPALS_HISTORY = '0'; });
  const url = `http://127.0.0.1:${server.address().port}`;
  const activity = await (await fetch(`${url}/api/activity`)).json();
  assert.deepEqual(activity.entries.map((e) => e.id), ['real-user']);
  const res = await fetch(`${url}/api/handoff`, { method: 'POST', headers: { 'x-dotpals': '1' }, body: JSON.stringify({ session: `codex:${B}`, agent: 'copy' }) });
  assert.equal(res.status, 404);
});
