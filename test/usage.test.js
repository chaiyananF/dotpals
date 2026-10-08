import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const limits = (used, updatedAt) => JSON.stringify({ rate_limits: { five_hour: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 } }, sizes: { 'session-a': used * 1000 }, updatedAt });

test('a center profile still shows Claude limits saved by the status line in the default home', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dotpals-usage-home-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.DOTPALS_HOME = join(dir, 'center');
  process.env.HOME = process.env.USERPROFILE = join(dir, 'user');
  await mkdir(process.env.DOTPALS_HOME, { recursive: true });
  await mkdir(join(dir, 'user', '.dotpals'), { recursive: true });
  await writeFile(join(process.env.DOTPALS_HOME, 'claude-limits.json'), limits(10, Date.now() - 60_000));
  await writeFile(join(dir, 'user', '.dotpals', 'claude-limits.json'), limits(42, Date.now()));
  const { claudeContextSize, readUsage } = await import('../bridge/usage.js');
  const { agents } = await readUsage({ codexDir: join(dir, 'no-codex') });
  const claude = agents.find((agent) => agent.harness === 'claude');
  assert.equal(claude.window.used_percent, 42);
  assert.deepEqual(claude.limits.map((limit) => limit.label), ['5-hour']);
  assert.equal(claudeContextSize('session-a'), 42000);
});
