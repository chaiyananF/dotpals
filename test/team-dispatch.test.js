import test from 'node:test';
import assert from 'node:assert/strict';
import { agyOutcome, validateAgyEffort } from '../bridge/team-dispatch.js';

test('AGY soft-denied tools never count as a successful worker result', () => {
  const result = agyOutcome(0, { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
  assert.equal(result.successful, false);
  assert.match(result.error, /permission denied \(command\)/);
});
test('AGY empty result is incomplete even with exit zero and SUCCESS', () => {
  assert.equal(agyOutcome(0, { status: 'SUCCESS', response: '  ' }).successful, false);
});
test('AGY final text requires a successful native exit/status and no denied actions', () => {
  const result = { status: 'SUCCESS', response: 'Created the requested files.', denied_actions: [] };
  assert.equal(agyOutcome(0, result).successful, true);
  assert.equal(agyOutcome(1, result).successful, false);
  assert.equal(agyOutcome(0, { ...result, denied_actions: [{ action: 'write_file' }] }).successful, false);
});
test('Gemini model variant and explicitly selected effort must agree', () => {
  assert.throws(() => validateAgyEffort('gemini-3.8-flash-medium', 'low'), /requires effort=medium/);
  assert.doesNotThrow(() => validateAgyEffort('gemini-3.8-flash-medium', 'medium'));
  assert.doesNotThrow(() => validateAgyEffort('gemini-3.8-flash-medium', ''));
});
