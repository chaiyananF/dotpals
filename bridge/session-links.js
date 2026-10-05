// Durable source/destination IDs. Kept separately from the expiring activity feed.
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { home } from './config.js';
import { CLAUDE_EFFORTS } from './claude-policy.js';

export const isSessionId = (id) => typeof id === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id);
// The existing Claude adapter uses a bare UUID; the registry includes the agent.
export const sessionKey = (id) => isSessionId(id) ? `claude:${id}` : id;
export const sameSession = (a, b) => !!a && !!b && sessionKey(a) === sessionKey(b);
export const isSessionModel = (model) => model == null || (typeof model === 'string' && /^[a-z\d._:-]{1,100}$/i.test(model));
const AGENTS = new Set(['claude', 'codex', 'gemini', 'antigravity']);
const endpoint = (e, required = true) => {
  if (!e || !AGENTS.has(e.agent) || (required || e.nativeId != null) && !isSessionId(e.nativeId) || !isSessionModel(e.model) || e.effort != null && !CLAUDE_EFFORTS.includes(e.effort)) throw new Error('Invalid agent session identity.');
  return { agent: e.agent, ...(e.nativeId ? { nativeId: e.nativeId, session: `${e.agent}:${e.nativeId}` } : {}), ...(e.model ? { model: e.model } : {}), ...(e.effort ? { effort: e.effort } : {}), ...(e.cwd ? { cwd: e.cwd } : {}) };
};

export function createSessionLinks({ directory = home() } = {}) {
  const file = join(directory, 'session-links.json');
  let rows = [];
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.links)) throw new Error('Unsupported session-links file.');
    rows = saved.links;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const copy = (v) => JSON.parse(JSON.stringify(v));
  function commit(next) {
    mkdirSync(directory, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, links: next }, null, 2), { mode: 0o600 });
      renameSync(temp, file);
      rows = next;
    } finally { try { unlinkSync(temp); } catch {} }
  }
  return {
    file,
    list(session) { return copy(rows.filter((r) => !session || sameSession(r.source.session, session) || sameSession(r.target.session, session)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); },
    get(id) { const row = rows.find((r) => r.id === id); return row ? copy(row) : null; },
    add({ source, target, assignment = '', noteFile, conversationFile, evidence = 'terminal-launch', action = 'handoff' }) {
      const now = new Date().toISOString();
      const row = { id: randomUUID(), source: endpoint(source), target: endpoint(target, false), action, status: target.nativeId ? 'confirmed' : 'pending', createdAt: now, updatedAt: now, assignment, evidence, ...(noteFile ? { noteFile } : {}), ...(conversationFile ? { conversationFile } : {}) };
      commit([...rows, row]);
      return copy(row);
    },
    result(id, { nativeId, outcome, response, turns, assignment, evidence = 'cli-json' }) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error('Session link not found.');
      if (nativeId != null && (!isSessionId(nativeId) || row.target.nativeId && nativeId !== row.target.nativeId)) throw new Error('Destination session ID does not match the saved link.');
      if (!['success', 'failed', 'launched'].includes(outcome)) throw new Error('Invalid session outcome.');
      const target = nativeId ? endpoint({ ...row.target, nativeId }) : row.target;
      const updated = { ...row, target, status: target.nativeId ? 'confirmed' : outcome === 'failed' ? 'launch-failed' : 'pending', lastOutcome: outcome, updatedAt: new Date().toISOString(), evidence,
        ...(typeof response === 'string' ? { lastResponse: response.slice(0, 8000) } : {}),
        ...(Number.isInteger(turns) && turns >= 0 ? { turns } : {}),
        ...(typeof assignment === 'string' ? { assignment: assignment.slice(0, 8000) } : {}),
      };
      commit(rows.map((r) => r.id === id ? updated : r));
      return copy(updated);
    },
  };
}
