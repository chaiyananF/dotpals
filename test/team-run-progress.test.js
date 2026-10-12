import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTeamStore } from '../bridge/team-store.js';
import { createTeamDispatch } from '../bridge/team-dispatch.js';
import { createTeamApi } from '../bridge/team-api.js';

const home = mkdtempSync(join(tmpdir(), 'dotpals-run-progress-'));
const names = ['DOTPALS_HOME', 'DOTPALS_CLAUDE', 'DOTPALS_CODEX_CLI', 'DOTPALS_AGY'];
const saved = Object.fromEntries(names.map((key) => [key, process.env[key]]));
process.env.DOTPALS_HOME = home;
for (const key of names.slice(1)) process.env[key] = process.execPath; // discovery only: injected spawn never executes it
after(() => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  rmSync(home, { recursive: true, force: true });
});
const nativeId = '019ab123-1234-7000-8123-123456789abc';
const coordinator = '019ab456-1234-7000-8123-123456789abc';
const line = (record) => JSON.stringify(record) + '\n';
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await sleep(20); }
  assert.ok(check(), 'broker reached expected state');
}
async function setup(t, agent, { failProgress = false, failProgressSend = false } = {}) {
  const directory = mkdtempSync(join(home, 'store-'));
  const store = createTeamStore({ directory });
  if (failProgress) {
    const saveState = store.dispatchState;
    store.dispatchState = (id, patch) => { if (patch.progress) throw new Error('fixture progress write failure'); return saveState(id, patch); };
  }
  const task = store.create({ title: 'Fixture progress', goal: 'Observe fake process.', contextDir: directory, codeDir: directory, coordinator: { session: `claude:${coordinator}` } });
  const calls = [], notifications = [];
  const dispatch = createTeamDispatch({ store, root: directory, port: 0, links: { list: () => [] }, catalog: () => [], send: (...args) => { notifications.push(args); if (failProgressSend && args[0] === 'team-progress') throw new Error('fixture SSE disconnected'); },
    spawnProcess(command, args, options) {
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null,
        kill() { this.exitCode = 1; this.emit('close', 1); return true; },
      });
      calls.push({ command, args, options, child });
      return child;
    },
  });
  t.after(() => dispatch.stop());
  const queued = dispatch.submit({ agent, taskId: task.id, role: 'petros', prompt: 'Synthetic fixture assignment.', model: agent === 'antigravity' ? 'gemini-fixture' : undefined, idempotencyKey: 'fixture-run' });
  assert.equal(queued.progress.elapsedMs, null);
  assert.equal(queued.progress.remainingMs, null);
  await until(() => calls.length === 1 || store.dispatch(queued.id).status === 'failed');
  const child = calls[0]?.child;
  const finish = async (code = 0) => { child.exitCode = code; child.emit('close', code); await until(() => ['succeeded', 'failed', 'cancelled'].includes(store.dispatch(queued.id).status)); };
  return { dispatch, store, task, id: queued.id, calls, notifications, child, finish, directory };
}

test('Claude streaming progress persists before completion, keeps final result/identity and flushes on close', async (t) => {
  const f = await setup(t, 'claude');
  assert.ok(f.calls[0].args.includes('stream-json'));
  assert.ok(f.calls[0].args.includes('--verbose'));
  const init = line({ type: 'system', subtype: 'init', session_id: nativeId });
  f.child.stdout.write(init.slice(0, 9));
  f.child.stdout.write(init.slice(9));
  f.child.stdout.write(line({ type: 'assistant', session_id: nativeId, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'private-path' } }] } }));
  await until(() => f.dispatch.get(f.id).progress.lastActivityKind === 'tool-start');
  const running = f.dispatch.get(f.id);
  assert.equal(running.status, 'running');
  assert.equal(running.nativeId, null, 'stream identity is not guessed/confirmed early');
  assert.ok(running.progress.elapsedMs >= 0);
  assert.ok(running.progress.remainingMs > 0);
  assert.ok(running.progress.stdoutBytes > 0);
  assert.doesNotMatch(JSON.stringify(running.progress), /private-path|Read/);
  assert.equal(createTeamStore({ directory: f.directory }).dispatch(f.id).progress.lastActivityKind, 'tool-start');
  assert.deepEqual(f.dispatch.list(f.task.id)[0].progress.lastActivityAt, running.progress.lastActivityAt);
  f.child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, session_id: nativeId, result: 'Fixture final result.' }));
  await f.finish();
  const done = f.dispatch.get(f.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.response, 'Fixture final result.');
  assert.equal(done.nativeId, nativeId);
  assert.equal(done.progress.lastActivityKind, 'provider-finished');
  assert.equal(done.progress.remainingMs, null);
  assert.equal(f.store.get(f.task.id).messages.find((row) => row.type === 'result').body, 'Fixture final result.');
  const elapsed = done.progress.elapsedMs;
  await sleep(30);
  assert.equal(f.dispatch.get(f.id).progress.elapsedMs, elapsed);
});

test('Codex JSONL progress preserves successful final text and confirmed session', async (t) => {
  const f = await setup(t, 'codex');
  f.child.stdout.write(line({ type: 'thread.started', thread_id: nativeId }) + line({ type: 'item.completed', item: { type: 'agent_message', text: 'Fixture Codex final.' } }) + line({ type: 'turn.completed' }));
  await f.finish();
  assert.equal(f.dispatch.get(f.id).status, 'succeeded');
  assert.equal(f.dispatch.get(f.id).response, 'Fixture Codex final.');
  assert.equal(f.dispatch.get(f.id).nativeId, nativeId);
  assert.equal(f.dispatch.get(f.id).progress.lastActivityKind, 'provider-finished');
});

test('buffered AGY output stays compatible and cancellation flushes diagnostics without success', async (t) => {
  const f = await setup(t, 'antigravity');
  f.child.stdout.write(JSON.stringify({ status: 'SUCCESS', conversation_id: nativeId, response: 'Fixture AGY final.' }));
  await f.finish();
  assert.equal(f.dispatch.get(f.id).status, 'succeeded');
  assert.equal(f.dispatch.get(f.id).progress.lastActivityKind, 'output');
  const g = await setup(t, 'claude');
  g.child.stderr.write('sensitive fixture diagnostic');
  g.dispatch.cancel(g.id);
  await until(() => g.store.dispatch(g.id).status === 'cancelled');
  const cancelled = g.dispatch.get(g.id);
  assert.equal(cancelled.progress.lastActivityKind, 'stderr');
  assert.equal(cancelled.progress.stderrBytes, Buffer.byteLength('sensitive fixture diagnostic'));
  assert.doesNotMatch(JSON.stringify(cancelled.progress), /sensitive/);
  assert.equal(cancelled.progress.remainingMs, null);
});

test('Claude legacy result JSON and failed streaming results retain outcome behavior', async (t) => {
  for (const failed of [false, true]) {
    const f = await setup(t, 'claude');
    f.child.stdout.write(JSON.stringify({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, session_id: nativeId, result: failed ? 'Fixture error.' : 'Legacy fixture result.' }));
    await f.finish(failed ? 1 : 0);
    assert.equal(f.dispatch.get(f.id).status, failed ? 'failed' : 'succeeded');
    assert.equal(f.dispatch.get(f.id).nativeId, nativeId);
  }
});

test('progress storage failure warns callers but preserves the provider result and mailbox', async (t) => {
  const f = await setup(t, 'claude', { failProgress: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.dispatch.get(f.id).progress.available, false);
  assert.equal(f.notifications.find(([event]) => event === 'team-progress')[1].progress.available, false);
  f.child.stdout.write(line({ type: 'result', subtype: 'success', session_id: nativeId, result: 'Still valid.' }));
  await f.finish();
  assert.equal(f.dispatch.get(f.id).status, 'succeeded');
  assert.equal(f.dispatch.get(f.id).response, 'Still valid.');
  assert.equal(f.dispatch.get(f.id).progress.available, false);
  assert.equal(f.store.get(f.task.id).messages.filter((row) => row.type === 'result').length, 1);
});

test('Claude verbose traffic over 8 MiB retains only its bounded final result artifact', async (t) => {
  const f = await setup(t, 'claude');
  const tool = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'private-tool-content'.repeat(60_000) }] } });
  for (let i = 0; i < 9; i++) f.child.stdout.write(tool);
  // Also skip an individual oversized record split across chunks.
  f.child.stdout.write('{"type":"user","message":"private-tool-content');
  for (let i = 0; i < 9; i++) f.child.stdout.write('x'.repeat(1024 * 1024));
  f.child.stdout.write('"}\n');
  const final = line({ type: 'result', subtype: 'success', session_id: nativeId, result: 'Bounded final result.' });
  f.child.stdout.write(final.slice(0, 17)); f.child.stdout.write(final.slice(17));
  await f.finish();
  const done = f.dispatch.get(f.id);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.progress.stdoutBytes > 16 * 1024 * 1024);
  assert.equal(done.response, 'Bounded final result.');
  const artifact = join(done.artifactDir, 'stdout.log');
  assert.ok(statSync(artifact).size < 1024);
  assert.doesNotMatch(readFileSync(artifact, 'utf8'), /private-tool-content/);
});

test('a mid-run progress write failure retains last saved metadata and does not cancel valid work', async (t) => {
  const f = await setup(t, 'claude');
  const savedState = f.store.dispatchState;
  f.store.dispatchState = (id, patch) => { if (patch.progress) throw new Error('transient fixture progress failure'); return savedState(id, patch); };
  f.child.stdout.write(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'private intermediate' }] } }));
  await until(() => f.dispatch.get(f.id).progress.available === false);
  assert.equal(f.dispatch.get(f.id).status, 'running');
  assert.equal(f.child.exitCode, null);
  assert.equal(f.dispatch.get(f.id).progress.lastActivityKind, 'launch');
  f.child.stdout.write(line({ type: 'result', subtype: 'success', session_id: nativeId, result: 'Final survives.' }));
  await f.finish();
  assert.equal(f.dispatch.get(f.id).status, 'succeeded');
  assert.equal(f.dispatch.get(f.id).response, 'Final survives.');
  assert.doesNotMatch(JSON.stringify(f.dispatch.get(f.id).progress), /private intermediate/);
});

test('Claude oversized or malformed final output cannot become a successful run from init identity', async (t) => {
  for (const final of ['{"type":"result",broken}', line({ type: 'result', subtype: 'success', session_id: nativeId, result: 'x'.repeat(8 * 1024 * 1024) })]) {
    const f = await setup(t, 'claude');
    f.child.stdout.write(line({ type: 'system', subtype: 'init', session_id: nativeId }));
    f.child.stdout.write(final);
    await f.finish();
    assert.equal(f.dispatch.get(f.id).status, 'failed');
    assert.equal(f.dispatch.get(f.id).nativeId, nativeId, 'genuine init identity remains resumable after failure');
    assert.match(f.dispatch.get(f.id).error, /did not return a valid final result/);
    assert.match(f.dispatch.get(f.id).error, final.includes('broken') ? /Malformed/ : /exceeding 8 MiB/);
  }
});

test('missing Claude result preserves crash diagnostics and genuine init identity without claiming success', async (t) => {
  const f = await setup(t, 'claude');
  f.child.stdout.write(line({ type: 'system', subtype: 'init', session_id: nativeId }));
  f.child.stderr.write('Fixture argument failure.');
  await f.finish(2);
  const done = f.dispatch.get(f.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.nativeId, nativeId);
  assert.match(done.error, /exit 2.*Fixture argument failure/s);
  assert.doesNotMatch(done.error, /8 MiB/);
  assert.equal(f.store.get(f.task.id).messages.find((row) => row.type === 'blocker').body, done.error);
});

test('Claude timeout without result retains the real 30-minute timeout diagnostic', async (t) => {
  const original = globalThis.setTimeout;
  let timeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => { if (delay === 30 * 60_000) timeout = fn; return original(fn, delay, ...args); });
  const f = await setup(t, 'claude');
  f.child.stdout.write(line({ type: 'system', subtype: 'init', session_id: nativeId }));
  assert.equal(typeof timeout, 'function');
  timeout();
  await until(() => f.dispatch.get(f.id).status === 'failed');
  assert.match(f.dispatch.get(f.id).error, /CLI timed out after 30 minutes/);
  assert.equal(f.dispatch.get(f.id).nativeId, nativeId);
  assert.equal(f.dispatch.get(f.id).progress.remainingMs, null);
});

test('disconnected progress SSE does not disable saved metadata or successful provider completion', async (t) => {
  const f = await setup(t, 'claude', { failProgressSend: true });
  assert.equal(f.dispatch.get(f.id).progress.available, true);
  f.child.stdout.write(line({ type: 'result', subtype: 'success', session_id: nativeId, result: 'Observer independent.' }));
  await f.finish();
  assert.equal(f.dispatch.get(f.id).status, 'succeeded');
  assert.equal(f.dispatch.get(f.id).progress.available, true);
  assert.equal(f.dispatch.get(f.id).progress.lastActivityKind, 'provider-finished');
});

test('progress events carry metadata without task/dispatch invalidations that trigger API refetches', async (t) => {
  const f = await setup(t, 'codex');
  f.notifications.length = 0; // initial running transition is allowed to refresh
  f.child.stdout.write(line({ type: 'item.started', item: { type: 'command_execution', command: 'private command' } }));
  await until(() => f.dispatch.get(f.id).progress.lastActivityKind === 'tool-start');
  assert.deepEqual(f.notifications.map(([event]) => event), ['team-progress']);
  const event = f.notifications[0][1];
  assert.equal(event.dispatchId, f.id);
  assert.equal(event.taskId, f.task.id);
  assert.equal(event.progress.lastActivityKind, 'tool-start');
  assert.doesNotMatch(JSON.stringify(event), /private command/);
  f.dispatch.cancel(f.id);
});

test('HTTP run/list and actual team-center CLI read live progress from the same broker', async (t) => {
  const f = await setup(t, 'codex');
  const api = createTeamApi({ store: f.store, dispatch: f.dispatch, links: { list: () => [] }, catalog: () => [], send() {}, contextDirectory: () => f.directory,
    json: (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)),
  });
  const server = createServer((req, res) => api(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); });
  f.child.stdout.write(line({ type: 'item.started', item: { type: 'command_execution', command: 'private fixture command' } }));
  await until(() => f.dispatch.get(f.id).progress.lastActivityKind === 'tool-start');
  const port = server.address().port;
  const read = await (await fetch(`http://127.0.0.1:${port}/api/team/dispatch/${f.id}`)).json();
  const list = await (await fetch(`http://127.0.0.1:${port}/api/team/dispatch?task=${f.task.id}`)).json();
  assert.equal(read.run.progress.lastActivityKind, 'tool-start');
  assert.equal(list.runs[0].progress.lastActivityAt, read.run.progress.lastActivityAt);
  const cli = fileURLToPath(new URL('../bin/team-center.js', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [cli, 'run', '--run', f.id, '--port', String(port)], { windowsHide: true });
  const actual = JSON.parse(result.stdout).run;
  assert.equal(actual.status, 'running');
  assert.equal(actual.progress.lastActivityKind, 'tool-start');
  assert.ok(actual.progress.elapsedMs >= read.run.progress.elapsedMs);
  f.dispatch.cancel(f.id);
  await until(() => f.store.dispatch(f.id).status === 'cancelled');
});
