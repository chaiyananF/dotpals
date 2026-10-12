import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountTasks } from '../bridge/ui/tasks.js';

// A small DOM test double, not a browser or visual acceptance test.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.className = ''; this.hidden = false; this.isConnected = true; this.replacements = 0; }
  append(...children) { for (const child of children) { const el = typeof child === 'string' ? Object.assign(new Element('#text'), { textContent: child }) : child; el.parent = this; this.children.push(el); } }
  replaceChildren(...children) { this.children = []; this.replacements++; this.append(...children); }
  prepend(...children) { const old = this.children; this.children = []; this.append(...children); this.children.push(...old); }
  after(child) { child.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, child); }
  setAttribute() {}
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return (this.text ?? '') + this.children.map((child) => child.textContent).join(''); }
  set value(value) { this.storedValue = value; }
  get value() { return this.storedValue ?? (this.tag === 'select' ? this.children[0]?.value : '') ?? ''; }
  get options() { return this.children; }
  get selectedOptions() { return this.children.filter((child) => child.value === this.value); }
  get childElementCount() { return this.children.length; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tag === selector) ? [child] : [],
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

test('Tasks progress updates preserve expanded run details and drafts without API reads; clock ticks locally', async (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
  let tick, clock = 20_000;
  t.mock.method(globalThis, 'setInterval', (fn) => { tick = fn; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(Date, 'now', () => clock);
  const host = new Element('main');
  const job = { id: 'run-1', status: 'running', role: 'petros', provider: 'claude', model: 'fixture', prompt: 'Fixture command', startedAt: new Date(0).toISOString(), progress: { lastActivityAt: new Date(10_000).toISOString(), lastActivityKind: 'launch', available: true } };
  const task = { id: 'task-1', title: 'Fixture task', goal: 'Observe progress', status: 'development', coordinatorId: 'coordinator', coordination: 'external', codeDir: '/fixture', branch: 'fixture', contractVersion: 'progress-v1', checkpoint: '', linkIds: [], participants: [{ id: 'coordinator', role: 'raphael', provider: 'codex', writePaths: [] }] };
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    const replies = {
      '/api/team/sessions': { sessions: [], roles: ['raphael', 'petros'], statuses: ['development'], messageTypes: ['assignment', 'note'], links: [], contextDir: '/fixture' },
      '/api/team/dispatch/options': { providers: [{ id: 'claude', name: 'Claude', installed: true }], coordinatorModels: { claude: 'fixture' }, claudeModel: 'fixture', efforts: ['medium'], coordinationMode: 'external' },
      '/api/team/tasks': { tasks: [{ ...task, unreadMessages: 0 }] },
      '/api/team/tasks/task-1': { task, messages: [] },
      '/api/team/dispatch?task=task-1': { runs: [job] },
    };
    assert.ok(path in replies, path);
    return structuredClone(replies[path]);
  };
  const panel = mountTasks(host, { api, toast() {} });
  await panel.activate(task.id);
  const box = host.querySelector('.team-runs');
  const details = box.querySelector('details'); details.open = true;
  const draft = host.querySelector('textarea'); draft.value = 'Unsent draft';
  const label = box.querySelector('.team-run-progress');
  const reads = calls.length, replacements = box.replacements;
  panel.progress({ taskId: task.id, dispatchId: job.id, progress: { lastActivityKind: 'tool-start', lastActivityAt: new Date(19_000).toISOString() } });
  assert.equal(calls.length, reads);
  assert.equal(box.replacements, replacements);
  assert.equal(box.querySelector('details'), details);
  assert.equal(details.open, true);
  assert.equal(draft.value, 'Unsent draft');
  assert.match(label.textContent, /ผู้ช่วยใช้เครื่องมือ/);
  clock += 1000; tick();
  assert.match(label.textContent, /ใช้เวลา 0:21 · เหลือก่อน timeout 29:39/);
  assert.equal(calls.length, reads);
  const text = label.textContent;
  panel.progress({ taskId: 'other-task', dispatchId: job.id, progress: { lastActivityKind: 'message' } });
  assert.equal(label.textContent, text);
  job.updatedAt = new Date(clock).toISOString();
  await panel.refresh(); // unrelated refresh with only updatedAt changed
  assert.equal(box.querySelector('details'), details);
  assert.equal(details.open, true);
  assert.equal(draft.value, 'Unsent draft');
  panel.progress({ taskId: task.id, dispatchId: job.id, progress: { available: false } });
  assert.match(label.textContent, /ข้อมูลกิจกรรมใช้ไม่ได้/);
});
