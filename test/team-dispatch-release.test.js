import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamDispatch } from '../bridge/team-dispatch.js';

const DEAD_PID = 2 ** 30;
const jobs = [];
const messages = [];
const store = {
  dispatches: () => jobs,
  dispatch: (id) => jobs.find((job) => job.id === id),
  dispatchState(id, patch) { const job = jobs.find((row) => row.id === id); Object.assign(job, patch); return job; },
  send(taskId, message) { messages.push({ taskId, ...message }); return message; },
  list: () => [],
  get: () => ({ task: {} }),
};
const dispatch = createTeamDispatch({ store, links: { list: () => [] }, catalog: () => [], send() {}, root: process.cwd(), port: 0 });
const add = (patch) => { const job = { id: `run-${jobs.length}`, taskId: 'task-1', participantId: 'worker-1', from: 'coordinator-1', status: 'interrupted', error: 'The previous bridge stopped.', ...patch }; jobs.push(job); return job; };

test('release cancels an interrupted run whose CLI has stopped and tells the coordinator', () => {
  const job = add({ childPid: DEAD_PID });
  const run = dispatch.release(job.id);
  assert.equal(run.status, 'cancelled');
  assert.match(run.error, /no longer running/);
  assert.deepEqual(messages.at(-1), { taskId: 'task-1', from: 'worker-1', to: 'coordinator-1', type: 'blocker', body: run.error, idempotencyKey: `dispatch-result:${job.id}` });
});
test('release refuses while the original CLI process is still alive', () => {
  const job = add({ childPid: process.pid });
  assert.throws(() => dispatch.release(job.id), (err) => err.status === 409 && /still running/.test(err.message));
  assert.equal(job.status, 'interrupted');
});
test('release only applies to interrupted runs', () => {
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) {
    const job = add({ status, ownerPid: process.pid });
    assert.throws(() => dispatch.release(job.id), (err) => err.status === 409 && /Only an interrupted run/.test(err.message));
  }
});
test('release of an unknown run is a 404', () => {
  assert.throws(() => dispatch.release('missing'), (err) => err.status === 404);
});
test('an interrupted run that never started a CLI can be released', () => {
  assert.equal(dispatch.release(add({}).id).status, 'cancelled');
});
