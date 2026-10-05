import { MESSAGE_TYPES, TASK_STATUSES, TEAM_ROLES, TeamError } from './team-store.js';
import { createSessionTitleReader } from './session-center.js';

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); });
    req.on('error', reject);
    req.on('end', () => {
      if (size > 1024 * 1024) return reject(new TeamError('Request body exceeds 1 MB.', 413));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new TeamError('Invalid JSON body.')); }
    });
  });
}

export function createTeamApi({ store, links, catalog, send, json, contextDirectory, dispatch }) {
  const readSessionTitles = createSessionTitleReader();
  return async (req, res, url) => {
    const path = url.pathname;
    const q = url.searchParams;
    try {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) throw new TeamError('Forbidden origin.', 403);
      if (req.method === 'GET') {
        if (path === '/api/team/coordinator') return json(res, 200, store.coordinatorContext(q.get('session')));
        if (path === '/api/team/dispatch/options') return json(res, 200, dispatch.options());
        if (path === '/api/team/dispatch') return json(res, 200, { runs: dispatch.list(q.get('task')) });
        const run = /^\/api\/team\/dispatch\/([a-f\d-]{36})$/i.exec(path);
        if (run) return json(res, 200, { run: dispatch.get(run[1]) });
        if (path === '/api/team/tasks') return json(res, 200, { tasks: store.list({ session: q.get('session'), status: q.get('status') }) });
        if (path === '/api/team/inbox') return json(res, 200, { messages: store.inbox({ session: q.get('session'), user: q.get('recipient') === 'user', unread: q.get('unread') !== '0' }) });
        if (path === '/api/team/sessions') {
          const sessions = new Map();
          const titles = await readSessionTitles();
          for (const entry of [...catalog(), ...links.list().flatMap((link) => [link.source, link.target]), ...store.list().flatMap((task) => task.participants.map((person) => ({ ...person, taskTitle: task.title })))]) {
            if (!entry.nativeId || !entry.session) continue;
            const key = entry.session.includes(':') ? entry.session.toLowerCase() : `claude:${entry.session.toLowerCase()}`;
            const previous = sessions.get(key);
            sessions.set(key, { ...previous, ...entry, session: key, title: titles.get(key) || previous?.title || entry.title || entry.taskTitle || '' });
          }
          return json(res, 200, { sessions: [...sessions.values()], links: links.list(), statuses: TASK_STATUSES, roles: TEAM_ROLES, messageTypes: MESSAGE_TYPES, contextDir: contextDirectory() });
        }
        const detail = /^\/api\/team\/tasks\/([a-f\d-]{36})$/i.exec(path);
        if (detail) return json(res, 200, store.get(detail[1]));
      }
      if (req.method !== 'POST') throw new TeamError('Endpoint not found.', 404);
      if (req.headers['x-dotpals'] !== '1') throw new TeamError('The x-dotpals: 1 header is required.', 403);
      const body = await bodyOf(req);
      if (path === '/api/team/coordinator/attach') {
        const result = store.attachCoordinator({ ...body, contextDir: body.taskId ? body.contextDir : contextDirectory() });
        send('team-task', { taskId: result.task.id });
        return json(res, result.existing ? 200 : 201, result);
      }
      if (path === '/api/team/coordinator/summary') {
        const result = store.coordinatorSummary(body);
        send('team-message', { taskId: result.task.id, messageId: result.message.id });
        send('team-task', { taskId: result.task.id });
        return json(res, 200, result);
      }
      if (path === '/api/team/dispatch') return json(res, 202, { run: dispatch.submit(body) });
      const cancel = /^\/api\/team\/dispatch\/([a-f\d-]{36})\/cancel$/i.exec(path);
      if (cancel) return json(res, 200, { run: dispatch.cancel(cancel[1]) });
      if (path === '/api/team/tasks') {
        const task = store.create(body);
        send('team-task', { taskId: task.id });
        return json(res, 201, { task });
      }
      const action = /^\/api\/team\/tasks\/([a-f\d-]{36})\/(update|participants|links|messages)$/i.exec(path);
      if (action) {
        const [, id, verb] = action;
        if (verb === 'messages') {
          const message = store.send(id, body);
          send('team-message', { taskId: id, messageId: message.id });
          return json(res, 200, { message });
        }
        const task = verb === 'update' ? store.update(id, body) : verb === 'participants' ? store.join(id, body) : store.bind(id, body, links.get(body?.linkId));
        send('team-task', { taskId: id });
        return json(res, 200, { task });
      }
      const receipt = /^\/api\/team\/tasks\/([a-f\d-]{36})\/messages\/([a-f\d-]{36})\/read$/i.exec(path);
      if (receipt) {
        const message = store.read(receipt[1], receipt[2], body);
        send('team-message', { taskId: receipt[1], messageId: message.id });
        return json(res, 200, { message });
      }
      throw new TeamError('Endpoint not found.', 404);
    } catch (err) {
      return json(res, err.status ?? 500, { error: err.message });
    }
  };
}
