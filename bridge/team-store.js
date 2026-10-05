// Durable task and message state, separate from activity retention and native chats.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { home } from './config.js';
import { isSessionId, sessionKey } from './session-links.js';

export const TASK_STATUSES = ['intake', 'requirements', 'design', 'contract-locked', 'development', 'ready-for-review', 'independent-qa', 'uat', 'release', 'done', 'changes-requested', 'blocked', 'paused-capacity'];
export const TEAM_ROLES = ['raphael', 'matthew', 'thomas', 'philip', 'petros', 'andrew', 'nathaniel'];
export const MESSAGE_TYPES = ['assignment', 'question', 'answer', 'result', 'blocker', 'note'];
const PROVIDERS = ['codex', 'claude', 'gemini', 'antigravity'];
const copy = (value) => structuredClone(value);
export class TeamError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new TeamError(message, status); };
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a JSON object.');
  return value;
}
function text(value, name, max = 32000, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`${name} must be text of at most ${max} characters.`);
  const result = value.trim();
  if (required && !result) fail(`${name} is required.`);
  return result;
}
export function teamSession(value) {
  const key = sessionKey(text(value, 'session', 200, true)).toLowerCase();
  const [provider, nativeId, extra] = key.split(':');
  if (!PROVIDERS.includes(provider) || !isSessionId(nativeId) || extra) fail('Use a native session identity: provider:UUID.');
  return key;
}
function participant(input, coordinator = false) {
  object(input);
  const role = coordinator ? 'raphael' : input.role;
  if (!TEAM_ROLES.includes(role) || !coordinator && role === 'raphael') fail('Only the task coordinator has the Raphael role.');
  const session = teamSession(input.session);
  const writePaths = input.writePaths ?? [];
  if (!Array.isArray(writePaths) || writePaths.length > 100) fail('writePaths must be an array of at most 100 paths.');
  return { id: randomUUID(), role, session, provider: session.split(':')[0], nativeId: session.split(':')[1],
    label: text(input.label, 'label', 160) || role,
    teamSessionId: text(input.teamSessionId, 'teamSessionId', 160), model: text(input.model, 'model', 160),
    cwd: text(input.cwd, 'cwd', 4096), writePaths: writePaths.map((path) => text(path, 'write path', 4096, true)) };
}
const taskFields = { title: [160, true], goal: [32000, true], scope: [32000], acceptance: [32000], contextDir: [4096], codeDir: [4096], branch: [240], contractVersion: [240], checkpoint: [64000] };
function fields(input, creating = false) {
  const result = {};
  for (const [name, [max, required]] of Object.entries(taskFields)) {
    if (creating || Object.hasOwn(input, name)) result[name] = text(input[name], name, max, creating && required);
  }
  // Required fields stay required when editing, too.
  if (!creating) for (const name of ['title', 'goal']) if (Object.hasOwn(result, name) && !result[name]) fail(`${name} is required.`);
  return result;
}

export function createTeamStore({ directory = home() } = {}) {
  const file = join(directory, 'team-center.json');
  const lock = `${file}.lock`;
  function load() {
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.messages) || !Number.isSafeInteger(state.sequence)) throw new Error('Unsupported or damaged team-center data.');
      return state;
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, sequence: 0, tasks: [], messages: [] };
      throw err; // Never replace unreadable state with an empty registry.
    }
  }
  load();
  function transact(change) {
    mkdirSync(directory, { recursive: true });
    let handle;
    try { handle = openSync(lock, 'wx', 0o600); }
    catch (err) { if (err.code === 'EEXIST') fail('Team registry is locked by another write. Retry; a leftover lock after a crash requires manual inspection.', 409); throw err; }
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      const state = load(); // Read under the lock, including writes from another bridge.
      const result = change(state);
      let tempHandle;
      try {
        tempHandle = openSync(temp, 'wx', 0o600);
        writeFileSync(tempHandle, JSON.stringify(state, null, 2));
        fsyncSync(tempHandle);
      } finally { if (tempHandle !== undefined) closeSync(tempHandle); }
      renameSync(temp, file);
      return copy(result);
    } finally {
      closeSync(handle);
      if (existsSync(temp)) unlinkSync(temp);
      unlinkSync(lock);
    }
  }
  function taskOf(state, id) {
    const task = state.tasks.find((row) => row.id === id);
    if (!task) fail('Task not found.', 404);
    return task;
  }
  function revision(task, expected) {
    if (!Number.isSafeInteger(expected)) fail('expectedRevision is required.');
    if (expected !== task.revision) fail('Task changed. Reload it before saving.', 409);
  }
  function actor(task, id) {
    if (id !== 'user' && !task.participants.some((person) => person.id === id)) fail('Sender and recipient must belong to this task.');
  }
  function touch(task) { task.updatedAt = new Date().toISOString(); task.revision++; }
  return {
    file,
    coordinatorContext(session) {
      const key = teamSession(session);
      const state = load();
      const binding = (state.coordinatorBindings ?? []).find((row) => row.session === key) ?? null;
      if (!binding) return { binding: null, task: null, messages: [], runs: [] };
      const task = taskOf(state, binding.taskId);
      return copy({ binding, task, messages: state.messages.filter((row) => row.taskId === task.id), runs: (state.dispatches ?? []).filter((row) => row.taskId === task.id).map(({ fingerprint, idempotencyKey, ...run }) => run) });
    },
    attachCoordinator(input) {
      object(input);
      const session = teamSession(input.session);
      const key = text(input.idempotencyKey, 'idempotencyKey', 160, true);
      const normalized = { ...input, session };
      const fingerprint = JSON.stringify(Object.keys(normalized).sort().map((name) => [name, normalized[name]]));
      return transact((state) => {
        state.coordinatorRequests ??= [];
        state.coordinatorBindings ??= [];
        const previous = state.coordinatorRequests.find((row) => row.session === session && row.key === key);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail('Coordinator key already has another instruction.', 409);
          return { task: taskOf(state, previous.taskId), participantId: previous.participantId, existing: true };
        }
        if (state.coordinatorRequests.length >= 5000) fail('Coordinator request registry is full.', 409);
        const at = new Date().toISOString();
        let task;
        let person;
        if (input.taskId) {
          task = taskOf(state, input.taskId);
          person = task.participants.find((row) => row.id === task.coordinatorId);
          if (person?.session !== session || person.execution !== 'external') fail('This task belongs to another coordinator. Its ownership was not changed.', 409);
          if (input.prompt && (state.dispatches ?? []).some((row) => row.taskId === task.id && ['queued', 'running', 'interrupted'].includes(row.status))) fail('Inspect outstanding worker runs before starting the next instruction.', 409);
          // Existing write grants are changed only through an explicit task revision.
          if (input.writePaths != null) fail('Use the existing approved write paths or create a separately scoped task.');
        } else {
          if (state.tasks.length >= 1000) fail('Task registry is full.', 409);
          person = { ...participant({ session, label: input.label || 'Raphael in app chat', cwd: input.contextDir, model: input.model, writePaths: input.writePaths ?? [] }, true), execution: 'external' };
          task = { id: randomUUID(), ...fields(input, true), status: 'intake', coordination: 'external', coordinationState: 'analyzing', coordinatorId: person.id, participants: [person], linkIds: [], revision: 1, createdAt: at, updatedAt: at };
          state.tasks.push(task);
        }
        if (input.prompt) {
          if (state.messages.length >= 20000) fail('Message registry is full.', 409);
          state.messages.push({ id: randomUUID(), taskId: task.id, from: 'user', to: person.id, type: 'assignment', body: text(input.prompt, 'instruction', 32000, true), replyTo: null, idempotencyKey: `coordinator:${key}`, sequence: ++state.sequence, createdAt: at, readAt: null });
          task.coordinationState = 'analyzing'; touch(task);
        }
        const binding = state.coordinatorBindings.find((row) => row.session === session);
        const value = { session, taskId: task.id, participantId: person.id, updatedAt: at };
        if (binding) Object.assign(binding, value); else state.coordinatorBindings.push(value);
        state.coordinatorRequests.push({ session, key, fingerprint, taskId: task.id, participantId: person.id });
        return { task, participantId: person.id, existing: false };
      });
    },
    coordinatorSummary(input) {
      object(input);
      const session = teamSession(input.session);
      const body = text(input.body, 'summary', 64000, true);
      const key = text(input.idempotencyKey, 'idempotencyKey', 160, true);
      const type = input.type ?? 'result';
      if (!['result', 'blocker'].includes(type)) fail('Summary type must be result or blocker.');
      return transact((state) => {
        const task = taskOf(state, input.taskId);
        const person = task.participants.find((row) => row.id === task.coordinatorId);
        if (person?.session !== session || person.execution !== 'external') fail('Only this task’s external coordinator can publish its summary.', 409);
        const previous = state.messages.find((row) => row.taskId === task.id && row.from === person.id && row.idempotencyKey === key);
        if (previous) {
          if (previous.body !== body || previous.type !== type || previous.to !== 'user') fail('Summary key already has different content.', 409);
          return { task, message: previous, existing: true };
        }
        if ((state.dispatches ?? []).some((row) => row.taskId === task.id && ['queued', 'running', 'interrupted'].includes(row.status)) && type !== 'blocker') fail('Worker results are outstanding. Wait or publish an explicit blocker.', 409);
        if (state.messages.length >= 20000) fail('Message registry is full.', 409);
        const message = { id: randomUUID(), taskId: task.id, from: person.id, to: 'user', type, body, replyTo: null, idempotencyKey: key, sequence: ++state.sequence, createdAt: new Date().toISOString(), readAt: null };
        state.messages.push(message);
        task.coordinationState = 'awaiting-user'; task.lastSummaryId = message.id; task.checkpoint = body; touch(task);
        return { task, message, existing: false };
      });
    },
    dispatches(taskId) { return copy((load().dispatches ?? []).filter((job) => !taskId || job.taskId === taskId)); },
    dispatch(id) { return copy((load().dispatches ?? []).find((job) => job.id === id) ?? null); },
    prepareDispatch(plan) {
      return transact((state) => {
        state.dispatches ??= [];
        const previous = state.dispatches.find((job) => job.idempotencyKey === plan.idempotencyKey && job.from === plan.from);
        if (previous) {
          if (previous.fingerprint !== plan.fingerprint) fail('Dispatch key was already used for another instruction.', 409);
          return { job: previous, existing: true };
        }
        if (state.dispatches.length >= 2000) fail('Dispatch registry is full. Export before adding runs.', 409);
        let task;
        let recipient;
        const at = new Date().toISOString();
        if (plan.taskId) {
          task = taskOf(state, plan.taskId);
          actor(task, plan.from);
          if (plan.from !== 'user' && plan.from !== task.coordinatorId) fail('Only the user or Raphael can dispatch work.');
          recipient = task.participants.find((person) => person.id === plan.participantId);
          if (plan.participantId && !recipient) fail('Recipient not found in this task.');
        } else {
          if (plan.from !== 'user') fail('Only a human instruction can create a coordinator run.');
          if (state.tasks.length >= 1000) fail('Task registry is full.', 409);
          task = { id: randomUUID(), ...fields(plan.task, true), status: 'intake', coordinatorId: null, participants: [], linkIds: [], revision: 1, createdAt: at, updatedAt: at };
          state.tasks.push(task);
        }
        if (!recipient) {
          if (task.participants.length >= 30) fail('A task supports at most 30 participants.');
          if (plan.role === 'raphael' && task.coordinatorId) fail('This task already has a Raphael coordinator.');
          recipient = { id: randomUUID(), role: plan.role, label: plan.role, provider: plan.provider, session: plan.nativeId ? `${plan.provider}:${plan.nativeId}` : null, nativeId: plan.nativeId ?? null,
            model: plan.model ?? '', cwd: plan.cwd, teamSessionId: '', writePaths: plan.allowCodeWrites ? [plan.codeDir] : [] };
          if (recipient.session && task.participants.some((p) => p.session === recipient.session)) fail('Select the existing participant to resume this session.');
          task.participants.push(recipient);
          if (!task.coordinatorId) task.coordinatorId = recipient.id;
          touch(task);
        }
        if (task.coordination === 'external' && task.participants.find((row) => row.id === task.coordinatorId)?.session === (plan.nativeId ? `${plan.provider}:${plan.nativeId}` : null)) fail('The app coordinator cannot also be launched as a worker.', 409);
        if (plan.from === recipient.id) fail('A session cannot dispatch to itself.');
        if (recipient.execution === 'external') fail('The coordinator lives in the app chat; it cannot be launched by the broker.', 409);
        if (recipient.cwd !== plan.cwd || recipient.model !== plan.model) {
          recipient.cwd = plan.cwd; recipient.model = plan.model; touch(task);
        }
        if ((plan.from === 'user' || plan.from === task.coordinatorId) && plan.allowCodeWrites && !recipient.writePaths.includes(plan.codeDir)) { recipient.writePaths.push(plan.codeDir); touch(task); }
        const message = { id: randomUUID(), taskId: task.id, from: plan.from, to: recipient.id, type: 'assignment', body: plan.prompt, replyTo: null, idempotencyKey: `dispatch:${plan.idempotencyKey}`, sequence: ++state.sequence, createdAt: at, readAt: null };
        if (state.messages.length >= 20000) fail('Message registry is full.', 409);
        state.messages.push(message); task.updatedAt = at;
        const job = { ...plan, id: randomUUID(), taskId: task.id, participantId: recipient.id, assignmentId: message.id, nativeId: recipient.nativeId, role: recipient.role, status: 'queued', createdAt: at, updatedAt: at, ownerPid: process.pid, response: '', error: '' };
        delete job.task;
        state.dispatches.push(job);
        if (task.coordination === 'external') { task.coordinationState = 'waiting-for-workers'; touch(task); }
        return { job, existing: false };
      });
    },
    dispatchState(id, patch) {
      return transact((state) => {
        const job = (state.dispatches ?? []).find((row) => row.id === id);
        if (!job) fail('Dispatch not found.', 404);
        for (const key of ['status', 'error', 'response', 'childPid', 'artifactDir', 'startedAt', 'finishedAt']) if (Object.hasOwn(patch, key)) job[key] = patch[key];
        job.updatedAt = new Date().toISOString();
        const task = taskOf(state, job.taskId);
        if (task.coordination === 'external' && ['succeeded', 'failed', 'cancelled'].includes(job.status) && !(state.dispatches ?? []).some((row) => row.taskId === task.id && ['queued', 'running', 'interrupted'].includes(row.status))) {
          task.coordinationState = 'ready-to-summarize'; touch(task);
        }
        return job;
      });
    },
    confirmDispatch(id, nativeId) {
      if (!isSessionId(nativeId)) fail('CLI returned an invalid native session ID.');
      return transact((state) => {
        const job = (state.dispatches ?? []).find((row) => row.id === id);
        if (!job) fail('Dispatch not found.', 404);
        const task = taskOf(state, job.taskId);
        const person = task.participants.find((p) => p.id === job.participantId);
        const canonicalId = nativeId.toLowerCase();
        if (person.nativeId && person.nativeId !== canonicalId) fail('CLI returned another native ID. Saved session identity was not changed.', 409);
        const session = `${job.provider}:${canonicalId}`;
        if (task.participants.some((p) => p.id !== person.id && p.session === session)) fail('Returned session already belongs to another participant.', 409);
        if (!person.nativeId) { person.nativeId = canonicalId; person.session = session; touch(task); }
        job.nativeId = canonicalId;
        job.updatedAt = new Date().toISOString();
        return job;
      });
    },
    list({ session, status } = {}) {
      if (session) session = teamSession(session);
      const state = load();
      return copy(state.tasks.filter((task) => (!session || task.participants.some((person) => person.session === session)) && (!status || task.status === status))
        .map((task) => ({ ...task, unreadMessages: state.messages.filter((m) => m.taskId === task.id && !m.readAt).length }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    },
    get(id) {
      const state = load();
      return copy({ task: taskOf(state, id), messages: state.messages.filter((m) => m.taskId === id) });
    },
    create(input) {
      object(input);
      const values = fields(input, true);
      const coordinator = participant(input.coordinator, true);
      return transact((state) => {
        if (state.tasks.length >= 1000) fail('Task registry is full. Export and archive before adding tasks.', 409);
        const at = new Date().toISOString();
        const task = { id: randomUUID(), ...values, status: 'intake', coordinatorId: coordinator.id, participants: [coordinator], linkIds: [], revision: 1, createdAt: at, updatedAt: at };
        state.tasks.push(task);
        return task;
      });
    },
    update(id, input) {
      object(input);
      const values = fields(input);
      if (input.status !== undefined) {
        if (!TASK_STATUSES.includes(input.status)) fail('Unknown task status.');
        values.status = input.status;
      }
      return transact((state) => {
        const task = taskOf(state, id); revision(task, input.expectedRevision);
        if (['blocked', 'paused-capacity'].includes(values.status ?? task.status) && !(values.checkpoint ?? task.checkpoint)) fail('Record the reason and next action in checkpoint before pausing or blocking a task.');
        Object.assign(task, values); touch(task); return task;
      });
    },
    join(id, input) {
      object(input);
      const person = participant(input.participant);
      return transact((state) => {
        const task = taskOf(state, id); revision(task, input.expectedRevision);
        if (task.participants.some((p) => p.session === person.session)) fail('This native session already belongs to the task.', 409);
        if (task.participants.length >= 30) fail('A task supports at most 30 participants.');
        task.participants.push(person); touch(task); return task;
      });
    },
    bind(id, input, link) {
      object(input);
      if (!link) fail('Saved handoff link not found.', 404);
      return transact((state) => {
        const task = taskOf(state, id); revision(task, input.expectedRevision);
        const sessions = new Set(task.participants.map((p) => p.session));
        if (![link.source, link.target].some((p) => p.session && sessions.has(teamSession(p.session)))) fail('The handoff must involve a participant of this task.');
        if (!task.linkIds.includes(link.id)) { task.linkIds.push(link.id); touch(task); }
        return task;
      });
    },
    send(id, input) {
      object(input);
      if (!MESSAGE_TYPES.includes(input.type)) fail('Unknown message type.');
      const body = text(input.body, 'message', 64000, true);
      const key = text(input.idempotencyKey, 'idempotencyKey', 160, true);
      return transact((state) => {
        const task = taskOf(state, id);
        actor(task, input.from); actor(task, input.to);
        if (input.from === input.to) fail('Choose a different recipient.');
        if (input.type === 'assignment' && input.from !== 'user' && input.from !== task.coordinatorId) fail('Assignments must come from the user or task coordinator.');
        const replyTo = input.replyTo ?? null;
        if (replyTo !== null) {
          const parent = state.messages.find((m) => m.id === replyTo && m.taskId === id);
          if (!parent) fail('Reply message not found in this task.');
          if (input.from !== parent.to || input.to !== parent.from) fail('Replies must return to the original sender.');
          if (input.type === 'answer' && parent.type !== 'question') fail('An answer must reply to a question.');
        } else if (input.type === 'answer') fail('An answer requires replyTo.');
        const content = { taskId: id, type: input.type, from: input.from, to: input.to, body, replyTo };
        const existing = state.messages.find((m) => m.taskId === id && m.from === input.from && m.idempotencyKey === key);
        if (existing) {
          if (Object.entries(content).some(([name, value]) => existing[name] !== value)) fail('Idempotency key was already used for a different message.', 409);
          return existing;
        }
        if (state.messages.length >= 20000) fail('Message registry is full. Export and archive before adding messages.', 409);
        const message = { id: randomUUID(), ...content, idempotencyKey: key, sequence: ++state.sequence, createdAt: new Date().toISOString(), readAt: null };
        state.messages.push(message); task.updatedAt = message.createdAt;
        return message;
      });
    },
    read(id, messageId, input) {
      object(input);
      return transact((state) => {
        const task = taskOf(state, id); actor(task, input.recipientId);
        const message = state.messages.find((m) => m.id === messageId && m.taskId === id);
        if (!message) fail('Message not found.', 404);
        if (message.to !== input.recipientId) fail('Only the declared recipient can acknowledge this message.');
        message.readAt ??= new Date().toISOString();
        return message;
      });
    },
    inbox({ session, user = false, unread = true } = {}) {
      if (!user) session = teamSession(session);
      const state = load();
      return copy(state.messages.filter((message) => {
        const task = taskOf(state, message.taskId);
        return (!unread || !message.readAt) && (user ? message.to === 'user' : task.participants.some((p) => p.id === message.to && p.session === session));
      }).map((message) => ({ ...message, taskTitle: taskOf(state, message.taskId).title })));
    },
  };
}
