import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../bin/team-center.js', import.meta.url));

test('empty DOTPALS_PORT falls back to the default without making a request', () => {
  const result = spawnSync(process.execPath, [script, 'invalid-command'], {
    encoding: 'utf8',
    env: { ...process.env, DOTPALS_PORT: '' },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: invalid-command/);
  assert.doesNotMatch(result.stderr, /Invalid local bridge port/);
});

const runCli = (args, env = {}) => new Promise((resolveRun) => {
  execFile(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }, (error, stdout, stderr) => resolveRun({ status: error ? error.code : 0, stdout, stderr }));
});
test('release posts an empty payload to the run release endpoint', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { requests.push({ method: req.method, url: req.url, body }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ run: { status: 'cancelled' } })); });
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const run = '11111111-2222-3333-4444-555555555555';
    const result = await runCli(['release', '--run', run, '--port', String(server.address().port)]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests, [{ method: 'POST', url: `/api/team/dispatch/${run}/release`, body: '{}' }]);
  } finally { server.close(); }
});
test('release refuses a payload file', async () => {
  const result = await runCli(['release', '--run', 'x', '--file', 'payload.json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release does not accept a payload/);
});