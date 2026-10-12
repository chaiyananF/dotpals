import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunProgress } from '../bridge/dispatch-progress.js';
import { DISPATCH_TIMEOUT_MS, runTiming } from '../src/run-progress.js';
import { runProgressText } from '../bridge/ui/run-progress.js';
import { createClaudeResult } from '../bridge/claude-result.js';

test('progress handles split/multiple JSONL, oversized records and stderr without exposing content', () => {
  let clock = 1000;
  const updates = [];
  const tracker = createRunProgress({ publish: (row) => updates.push(row), now: () => clock });
  tracker.flush();
  tracker.stdout('{"type":"assistant","message":{"content":');
  clock = 1500;
  tracker.stdout('[{"type":"tool_use","input":{"secret":"never-expose"}}]}}\n');
  assert.equal(updates.length, 1, 'updates within a second coalesce');
  tracker.flush();
  assert.equal(updates.at(-1).lastActivityKind, 'tool-start');
  assert.equal(updates.at(-1).lastActivityAt, new Date(clock).toISOString());
  tracker.stdout('not json\n' + 'x'.repeat(70_000));
  tracker.stdout('ignored-tail\n{"type":"item.completed","item":{"type":"agent_message","text":"private"}}\n');
  tracker.flush();
  assert.equal(updates.at(-1).lastActivityKind, 'message');
  tracker.stderr('private stderr token');
  tracker.close();
  assert.equal(updates.at(-1).lastActivityKind, 'stderr');
  assert.equal(updates.at(-1).stderrBytes, Buffer.byteLength('private stderr token'));
  assert.ok(updates.at(-1).stdoutBytes > 70_000);
  assert.doesNotMatch(JSON.stringify(updates), /never-expose|private|ignored-tail|not json/);
  const count = updates.length;
  tracker.stdout('after close\n'); tracker.flush();
  assert.equal(updates.length, count);
});

test('progress flushes trailing updates and reports publication failure once', () => {
  const error = new Error('fixture write failure');
  const failures = [];
  const tracker = createRunProgress({ publish() { throw error; }, onError: (err) => failures.push(err) });
  tracker.flush(); tracker.stdout('ignored'); tracker.close();
  assert.deepEqual(failures, [error]);
});

test('thinking, text and typed tool events have accurate categories without exposing their content', () => {
  const updates = [];
  const tracker = createRunProgress({ publish: (row) => updates.push(row), throttleMs: 0 });
  for (const [record, expected] of [
    [{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private reasoning' }] } }, 'thinking'],
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'private message' }] } }, 'message'],
    [{ type: 'item.started', item: { type: 'reasoning' } }, 'thinking'],
    [{ type: 'item.completed', item: { type: 'reasoning' } }, 'thinking'],
    [{ type: 'item.started', item: { type: 'command_execution' } }, 'tool-start'],
    [{ type: 'item.completed', item: { type: 'mcp_tool_call' } }, 'tool-finished'],
    [{ type: 'item.completed', item: { type: 'unknown_future_type' } }, 'output'],
  ]) {
    tracker.stdout(JSON.stringify(record) + '\n');
    assert.equal(updates.at(-1).lastActivityKind, expected);
  }
  tracker.close();
  assert.doesNotMatch(JSON.stringify(updates), /private reasoning|private message/);
});

test('Claude result collector bounds each UTF-8 record, recovers after oversized lines and ignores init/tools', () => {
  const collector = createClaudeResult({ maxBytes: 180 });
  collector.push('{"type":"system","session_id":"not-final"}\n');
  collector.push('{"type":"user","content":"' + 'ก'.repeat(150));
  collector.push('"}\nnull\n["ignored"]\nmalformed\n');
  collector.push('{"type":"result","subtype":"success",');
  collector.push('"session_id":"actual","result":"final"}');
  assert.deepEqual(collector.finish(), { type: 'result', subtype: 'success', session_id: 'actual', result: 'final' });
  const noFinal = createClaudeResult();
  noFinal.push('{"type":"system","subtype":"init","session_id":"init-only"}\n');
  assert.equal(noFinal.finish(), undefined);
});

test('run clocks advance while active and freeze on terminal states; legacy/queued fields stay unknown', () => {
  const job = { status: 'running', startedAt: new Date(1000).toISOString(), progress: { lastActivityAt: new Date(2000).toISOString() } };
  const current = runTiming(job, 31_000);
  assert.equal(current.elapsedMs, 30_000);
  assert.equal(current.remainingMs, DISPATCH_TIMEOUT_MS - 30_000);
  assert.equal(current.quietForMs, 29_000);
  assert.equal(current.deadlineAt, new Date(1000 + DISPATCH_TIMEOUT_MS).toISOString());
  assert.equal(runTiming(job, DISPATCH_TIMEOUT_MS + 5000).remainingMs, 0);
  for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted']) {
    const finished = { ...job, status, finishedAt: new Date(11_000).toISOString() };
    assert.deepEqual(runTiming(finished, 20_000), runTiming(finished, 99_000));
    assert.equal(runTiming(finished).elapsedMs, 10_000);
    assert.equal(runTiming(finished).remainingMs, null);
  }
  assert.equal(runTiming({ status: 'queued' }).elapsedMs, null);
  assert.equal(runTiming({ status: 'queued' }).deadlineAt, null);
  assert.equal(runTiming({ status: 'succeeded' }).quietForMs, null);
});

test('Tasks text distinguishes waiting/quiet activity from completion or a hung worker', () => {
  const job = { status: 'running', startedAt: new Date(0).toISOString(), progress: { lastActivityAt: new Date(10_000).toISOString(), lastActivityKind: 'tool-start' } };
  assert.match(runProgressText(job, 20_000), /ใช้เวลา 0:20 · เหลือก่อน timeout 29:40/);
  assert.match(runProgressText(job, 20_000), /ผู้ช่วยใช้เครื่องมือ · 0:10 ที่แล้ว/);
  assert.match(runProgressText(job, 80_000), /ยังไม่ได้รับกิจกรรมใหม่ ไม่ยืนยันว่าค้าง/);
  assert.match(runProgressText({ status: 'queued' }), /ยังไม่นับเวลา timeout/);
  assert.match(runProgressText({ status: 'running' }), /ยังไม่มีข้อมูลกิจกรรมล่าสุด/);
  assert.match(runProgressText({ ...job, progress: { available: false } }), /ข้อมูลกิจกรรมใช้ไม่ได้/);
});
