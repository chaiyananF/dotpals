import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamDispatch } from '../bridge/team-dispatch.js';

// executable() only checks existsSync, so pointing every CLI at node keeps the
// "not installed" guard from masking the command checks. submit throws before pump/spawn.
const cliEnv = ['DOTPALS_CLAUDE', 'DOTPALS_CODEX_CLI', 'DOTPALS_AGY'];
const saved = Object.fromEntries(cliEnv.map((name) => [name, process.env[name]]));
for (const name of cliEnv) process.env[name] = process.execPath;
// claudePolicy() reads <DOTPALS_HOME>/claude-dispatch.json; an empty temp home keeps the real profile out.
const savedHome = process.env.DOTPALS_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'dotpals-commands-'));
process.env.DOTPALS_HOME = tempHome;
test.after(() => {
  for (const name of cliEnv) saved[name] === undefined ? delete process.env[name] : (process.env[name] = saved[name]);
  savedHome === undefined ? delete process.env.DOTPALS_HOME : (process.env.DOTPALS_HOME = savedHome);
  rmSync(tempHome, { recursive: true, force: true });
});

class StoppedBeforeSpawn extends Error {}
const root = process.cwd();
const task = { id: 'task-1', coordinatorId: 'coordinator-1', participants: [], contextDir: root, codeDir: root, branch: '' };
const plans = [];
const jobs = [];
// prepareDispatch is the last step before pump/spawn, so throwing there proves validation passed without launching.
const store = {
  dispatches: () => jobs,
  list: () => [],
  get: () => ({ task }),
  dispatchState() { throw new Error('store must not be written'); },
  prepareDispatch(plan) { plans.push(plan); throw new StoppedBeforeSpawn('stop before spawn'); },
};
const dispatch = createTeamDispatch({ store, links: { list: () => [] }, catalog: () => [], send() {}, root, port: 0 });
const submit = (overrides) => () => dispatch.submit({ agent: 'claude', prompt: 'check', idempotencyKey: 'commands-test', allowCodeWrites: true, ...overrides });
const rules = /allowedCommands must contain up to eight exact commands, without wildcards or multiline rules\./;
const grant = /Exact command grants require an authorized Claude code-write assignment\./;

test('more than eight commands is rejected', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `git status ${i}`);
  assert.throws(submit({ allowedCommands: nine }), rules);
});

for (const [label, command] of [['*', 'git add *'], ['?', 'git log ?'], ['(', 'echo (x'], [')', 'echo x)'], ['LF', 'git status\ngit push'], ['CR', 'git status\rgit push'], ['NUL', 'git status\0']]) {
  test(`command containing ${label} is rejected`, () => {
    assert.throws(submit({ allowedCommands: [command] }), rules);
  });
}

test('blank, non-string and over-long commands are rejected', () => {
  assert.throws(submit({ allowedCommands: ['   '] }), rules);
  assert.throws(submit({ allowedCommands: [42] }), rules);
  assert.throws(submit({ allowedCommands: ['x'.repeat(2001)] }), rules);
  assert.throws(submit({ allowedCommands: 'git status' }), rules);
});

test('command grants for a non-Claude provider are rejected', () => {
  assert.throws(submit({ agent: 'codex', allowedCommands: ['git status'] }), grant);
  assert.throws(submit({ agent: 'antigravity', allowedCommands: ['git status'] }), grant);
});

test('command grants without allowCodeWrites=true are rejected', () => {
  assert.throws(submit({ allowCodeWrites: false, allowedCommands: ['git status'] }), grant);
  assert.throws(submit({ allowCodeWrites: undefined, allowedCommands: ['git status'] }), grant);
});

test('pattern check runs before the provider and write checks', () => {
  assert.throws(submit({ agent: 'codex', allowCodeWrites: false, allowedCommands: ['git *'] }), rules);
});

const eight = Array.from({ length: 8 }, (_, i) => `git status ${i}`);
const accepted = (overrides) => ({ agent: 'claude', prompt: 'check', taskId: task.id, role: 'petros', allowCodeWrites: true, ...overrides });
// The public submit() hides fingerprint and idempotencyKey, so a replay equals the stored job minus those.
const visible = ({ fingerprint, idempotencyKey, ...rest }) => rest;
const reachPrepare = (payload) => {
  assert.throws(() => dispatch.submit(payload), StoppedBeforeSpawn);
  const plan = plans.at(-1);
  jobs.push(plan);
  return plan;
};

test('claude with allowCodeWrites and exactly eight valid commands reaches prepareDispatch', () => {
  plans.length = 0;
  assert.throws(() => dispatch.submit(accepted({ idempotencyKey: 'positive-control', allowedCommands: eight })), StoppedBeforeSpawn);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].allowedCommands, eight);
  assert.equal(plans[0].provider, 'claude');
  assert.equal(plans[0].allowCodeWrites, true);
});

test('same idempotency key and payload returns the existing job', () => {
  const payload = accepted({ idempotencyKey: 'replay-same', allowedCommands: ['git status'] });
  const job = reachPrepare(payload);
  assert.deepEqual(dispatch.submit(payload), visible(job));
});

test('same idempotency key with different allowedCommands is a 409 conflict', () => {
  const key = 'replay-different';
  reachPrepare(accepted({ idempotencyKey: key, allowedCommands: ['git status'] }));
  assert.throws(() => dispatch.submit(accepted({ idempotencyKey: key, allowedCommands: ['git diff'] })), (err) => {
    assert.match(err.message, /Dispatch key already has different content\./);
    assert.equal(err.status, 409);
    return true;
  });
});

test('payload without allowedCommands replays its existing job', () => {
  const payload = accepted({ idempotencyKey: 'replay-none' });
  const job = reachPrepare(payload);
  assert.deepEqual(dispatch.submit(payload), visible(job));
  assert.deepEqual(dispatch.submit({ ...payload, allowedCommands: [] }), visible(job));
});
