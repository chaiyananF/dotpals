import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
