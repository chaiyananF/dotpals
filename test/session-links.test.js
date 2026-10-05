import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionLinks, sameSession } from '../bridge/session-links.js';

const source = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';

test('Claude activity IDs and stored Claude IDs refer to the same conversation', () => {
  assert.equal(sameSession(target, `claude:${target}`), true);
  assert.equal(sameSession(`codex:${target}`, `claude:${target}`), false);
  assert.equal(sameSession(`codex:${target}`, target), false);
  assert.equal(sameSession('', ''), false);
});

test('saved links resolve from both sides and survive reopening the registry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dotpals-links-'));
  try {
    const store = createSessionLinks({ directory });
    const row = store.add({ source: { agent: 'codex', nativeId: source }, target: { agent: 'claude', nativeId: target } });
    store.result(row.id, { nativeId: target, outcome: 'success', turns: 2 });
    assert.equal(store.list(target)[0].id, row.id);
    assert.equal(store.list(`claude:${target}`)[0].id, row.id);
    assert.equal(store.list(`codex:${source}`)[0].id, row.id);
    assert.equal(store.list(`codex:${target}`).length, 0);
    const reopened = createSessionLinks({ directory });
    assert.equal(reopened.list(target)[0].lastOutcome, 'success');
    assert.equal(reopened.list(target)[0].turns, 2);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'dotpals-links-')), 'cleanup stays inside the generated test directory');
    await rm(directory, { recursive: true, force: true });
  }
});
