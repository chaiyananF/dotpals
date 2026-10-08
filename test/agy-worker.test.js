import test from 'node:test';
import assert from 'node:assert/strict';
import { agyArgs, agyChannel, agyOutcome, agyWorkRule, validateAgyEffort } from '../bridge/agy-worker.js';

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
const job = { model: 'gemini-3.8-flash-medium', effort: '', nativeId: null, codeDir: 'D:\\code', allowCodeWrites: false };
const optionAfter = (args, flag) => args[args.indexOf(flag) + 1];
test('read-only AGY runs in plan mode and is told to answer in text, not files', () => {
  const args = agyArgs(job, 'D:\\run');
  assert.equal(optionAfter(args, '--mode'), 'plan');
  assert.match(optionAfter(args, '--print'), /final text response/);
  assert.doesNotMatch(optionAfter(args, '--print'), /artifacts directory/);
  assert.match(agyWorkRule(job), /Do not write any file/);
});
test('AGY code writers auto-accept edits because headless mode cannot prompt', () => {
  assert.equal(optionAfter(agyArgs({ ...job, allowCodeWrites: true }, 'D:\\run'), '--mode'), 'accept-edits');
  assert.match(agyWorkRule({ ...job, allowCodeWrites: true }), /Git and test commands cannot run here/);
});
test('AGY resume passes the confirmed conversation ID', () => {
  assert.equal(optionAfter(agyArgs({ ...job, nativeId: 'abc' }, 'D:\\run'), '--conversation'), 'abc');
});
test('AGY channel forbids shell and the Dotpals CLI and allows edits only for writers', () => {
  assert.match(agyChannel(false), /no shell/);
  assert.match(agyChannel(false), /Do not run commands, scripts, tests, Git or the Dotpals CLI/);
  assert.doesNotMatch(agyChannel(false), /file edits/);
  assert.match(agyChannel(true), /file edits inside the code checkout/);
});
test('AGY channel forbids web search for every run', () => {
  for (const writes of [false, true]) assert.match(agyChannel(writes), /Do not search the web or fetch URLs/);
});