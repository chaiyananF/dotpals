import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const teamMcp = fileURLToPath(new URL('../bin/team-mcp.js', import.meta.url));
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

async function withMcp(role, body) {
  const posts = [];
  const bridge = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      posts.push({ path: req.url, header: req.headers['x-dotpals'], body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ run: { id: RUN_ID, status: 'queued' } }));
    });
  });
  await new Promise((ok) => bridge.listen(0, '127.0.0.1', ok));
  const child = spawn(process.execPath, [teamMcp], {
    env: { ...process.env, DOTPALS_PORT: String(bridge.address().port), DOTPALS_TASK_ID: TASK_ID, DOTPALS_PARTICIPANT_ID: PARTICIPANT_ID, DOTPALS_DISPATCH_ID: RUN_ID, DOTPALS_ROLE: role },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  let nextId = 0;
  const rpc = (method, params) => new Promise((ok) => { const id = ++nextId; pending.set(id, ok); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18' });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return await body({ rpc, posts });
  } finally {
    child.kill();
    await new Promise((ok) => bridge.close(ok));
  }
}

test('coordinator dispatch tool advertises allowedCommands; workers get no dispatch tool', async () => {
  const coordinatorTools = await withMcp('raphael', async ({ rpc }) => (await rpc('tools/list')).result.tools);
  const dispatch = coordinatorTools.find((entry) => entry.name === 'dispatch');
  assert.deepEqual(dispatch.inputSchema.properties.allowedCommands, { type: 'array', items: { type: 'string' }, maxItems: 8 });
  const workerTools = await withMcp('nathaniel', async ({ rpc }) => (await rpc('tools/list')).result.tools);
  assert.equal(workerTools.some((entry) => entry.name === 'dispatch'), false);
});

test('MCP dispatch forwards allowedCommands while keeping the bound task, sender and parent run', async () => {
  const allowedCommands = ['npm run build', 'git status --short'];
  const { result, posts } = await withMcp('raphael', async ({ rpc, posts }) => ({
    result: await rpc('tools/call', { name: 'dispatch', arguments: { agent: 'claude', prompt: 'Build the approved checkout.', allowCodeWrites: true, allowedCommands, idempotencyKey: 'mcp-key', taskId: 'other-task', from: 'user', parentRunId: null } }),
    posts,
  }));
  assert.equal(result.result.isError, undefined);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/team/dispatch');
  assert.equal(posts[0].header, '1');
  assert.deepEqual(posts[0].body, { agent: 'claude', prompt: 'Build the approved checkout.', allowCodeWrites: true, allowedCommands, idempotencyKey: 'mcp-key', taskId: TASK_ID, from: PARTICIPANT_ID, parentRunId: RUN_ID });
});
