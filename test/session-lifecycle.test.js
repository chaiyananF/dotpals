import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createActivityLog } from '../bridge/activity.js';
import { watchCodex } from '../bridge/adapters/codex.js';
import { sessionCatalog } from '../bridge/session-center.js';
import { createTeamDispatch } from '../bridge/team-dispatch.js';

// No live profiles or provider CLIs: submit stops at the preparation boundary.
const home = mkdtempSync(join(tmpdir(), 'dotpals-lifecycle-'));
const saved = { DOTPALS_HOME: process.env.DOTPALS_HOME, DOTPALS_CODEX_CLI: process.env.DOTPALS_CODEX_CLI };
process.env.DOTPALS_HOME = home;
process.env.DOTPALS_CODEX_CLI = process.execPath;
after(async () => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const nativeId = '019ab123-1234-7000-8123-123456789abc';
const session = `codex:${nativeId}`;
const tail = JSON.parse(await readFile(new URL('./fixtures/codex-completion-tail.json', import.meta.url), 'utf8'));
class Prepared extends Error {}
const encode = (records) => records.map((row) => JSON.stringify(row)).join('\n') + '\n';
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(20); }
  assert.ok(predicate(), 'watcher reached the expected state within 2 seconds');
}
async function fixture(t) {
  const dir = mkdtempSync(join(home, 'logs-'));
  const now = new Date();
  const folder = join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'rollout-fixture.jsonl');
  const at = Date.now() - 10_000;
  const event = (offset, type, payload) => ({ timestamp: new Date(at + offset).toISOString(), type, payload });
  await writeFile(file, encode([
    event(-1000, 'session_meta', { id: nativeId, cwd: dir }),
    event(-900, 'event_msg', { type: 'task_started', turn_id: 'fixture-turn' }),
  ]));
  const log = createActivityLog();
  const states = new Map();
  const meta = new Map();
  const stops = [];
  const start = () => {
    const stop = watchCodex(log, { dir, interval: 10, emit() {},
      state: (id, label, next, at) => states.set(id, { ...next, at }),
      cwd: (id, cwd) => meta.set(id, { cwd }),
    });
    stops.push(stop);
    return stop;
  };
  const stop = start();
  t.after(async () => { for (const stop of stops) stop(); await sleep(60); });
  await stop.ready;
  const catalog = () => sessionCatalog(log.all(), meta, states);
  // task_started changes state but does not itself add an activity catalog row.
  await appendFile(file, encode([event(-800, 'event_msg', { type: 'user_message', message: 'Fixture request.' })]));
  await until(() => catalog().length === 1);
  const jobs = [];
  const plans = [];
  const task = { id: 'fixture-task', coordinatorId: 'fixture-coordinator', participants: [], contextDir: dir, codeDir: dir };
  const store = { dispatches: () => jobs, list: () => [], get: () => ({ task }),
    dispatchState() { throw new Error('unexpected store write'); },
    prepareDispatch(plan) { plans.push(plan); throw new Prepared(); },
  };
  const dispatch = createTeamDispatch({ store, catalog, links: { list: () => [] }, send() {}, root: dir, port: 0 });
  t.after(() => dispatch.stop());
  const payload = { agent: 'codex', taskId: task.id, role: 'petros', session, prompt: 'Fixture follow-up.', idempotencyKey: 'fixture-follow-up' };
  const submit = () => dispatch.submit(payload);
  const complete = tail.map(({ offsetMs, ...record }) => ({ ...record, timestamp: new Date(at + offsetMs).toISOString() }));
  return { file, at, event, catalog, states, jobs, plans, submit, complete, start, stop, payload };
}

test('observed completion tail admits the same native ID, then the next turn is busy again', async (t) => {
  const f = await fixture(t);
  assert.throws(f.submit, (err) => err.status === 409 && /state=thinking/.test(err.message) && /source=codex-transcript/.test(err.message));
  await appendFile(f.file, encode(f.complete));
  await until(() => f.states.get(session)?.state === 'done');
  const finished = f.states.get(session);
  f.states.set(session, { state: 'waiting' });
  assert.throws(f.submit, (err) => err.status === 409 && /state=waiting; stateAt=unknown; source=unknown; event=unknown/.test(err.message));
  f.states.set(session, finished);
  assert.deepEqual({ state: f.catalog()[0].state, at: f.catalog()[0].stateAt, source: f.catalog()[0].stateSource, event: f.catalog()[0].stateEvent, busy: f.catalog()[0].busy },
    { state: 'done', at: f.at, source: 'codex-transcript', event: 'event_msg/task_complete', busy: false });
  assert.throws(f.submit, Prepared);
  assert.equal(f.plans.at(-1).nativeId, nativeId);
  for (const [offset, type, payload, expected] of [
    [100, 'event_msg', { type: 'task_started', turn_id: 'fixture-next' }, 'thinking'],
    [200, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'fixture-call', arguments: '{"cmd":"echo fixture"}' }, 'working'],
    [300, 'response_item', { type: 'function_call_output', call_id: 'fixture-call', output: 'fixture' }, 'thinking'],
    [400, 'response_item', { type: 'message', role: 'assistant', content: [] }, 'speaking'],
  ]) {
    await appendFile(f.file, encode([f.event(offset, type, payload)]));
    await until(() => f.states.get(session)?.at === f.at + offset);
    assert.throws(f.submit, (err) => err.status === 409 && err.message.includes(`state=${expected}; stateAt=${new Date(f.at + offset).toISOString()}`) && err.message.includes(`event=${type}/${payload.type}`));
  }
  await appendFile(f.file, encode([f.event(500, 'event_msg', { type: 'task_complete', turn_id: 'fixture-next', error: { message: 'Fixture failure.' } })]));
  await until(() => f.states.get(session)?.state === 'error');
  assert.equal(f.catalog()[0].busy, false);
  assert.throws(f.submit, Prepared);
  assert.equal(f.plans.at(-1).nativeId, nativeId);
});

test('split completion waits for the complete JSONL record and restart replays it as idle', async (t) => {
  const f = await fixture(t);
  await appendFile(f.file, encode(f.complete.slice(0, -1)));
  await until(() => f.states.get(session)?.state === 'speaking');
  const last = JSON.stringify(f.complete.at(-1));
  await appendFile(f.file, last.slice(0, 30));
  await sleep(80); // let the watcher consume the partial line
  assert.throws(f.submit, (err) => err.status === 409 && /state=speaking/.test(err.message));
  await appendFile(f.file, last.slice(30) + '\n');
  await until(() => f.states.get(session)?.state === 'done');
  assert.throws(f.submit, Prepared);
  f.stop();
  await sleep(60);
  f.states.clear();
  await f.start().ready;
  assert.equal(f.catalog()[0].state, 'done');
  assert.equal(f.catalog()[0].busy, false);
  assert.throws(f.submit, Prepared);
});

test('owned queued/running/interrupted runs still block idle native sessions; idempotent replay wins', async (t) => {
  const f = await fixture(t);
  await appendFile(f.file, encode(f.complete));
  await until(() => f.states.get(session)?.state === 'done');
  for (const status of ['queued', 'running', 'interrupted']) {
    f.jobs.splice(0, f.jobs.length, { id: 'fixture-owned-run', provider: 'codex', nativeId, status, ownerPid: process.pid });
    assert.throws(f.submit, (err) => err.status === 409 && err.message.includes(`Run=fixture-owned-run; status=${status}`));
  }
  await appendFile(f.file, encode([f.event(50, 'event_msg', { type: 'task_complete', turn_id: 'fixture-error', error: { message: 'Fixture failure.' } })]));
  await until(() => f.states.get(session)?.state === 'error');
  assert.throws(f.submit, (err) => err.status === 409 && /status=interrupted/.test(err.message));
  f.jobs.length = 0;
  assert.throws(f.submit, Prepared);
  const previous = { ...f.plans.at(-1), id: 'fixture-returned-run', status: 'running' };
  f.jobs.push(previous);
  await appendFile(f.file, encode([f.event(100, 'event_msg', { type: 'task_started' })]));
  await until(() => f.states.get(session)?.state === 'thinking');
  assert.equal(f.submit().id, previous.id);
  assert.equal(f.plans.length, 1);
});
