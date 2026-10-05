// Machine-local launch preferences. The explicit team folder is a context root,
// not an inferred replacement for every source project's checkout.
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { home } from './config.js';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
export function claudePolicy({ directory = home(), effort } = {}) {
  let policy = {};
  try { policy = JSON.parse(readFileSync(join(directory, 'claude-dispatch.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (policy.workingDirectory != null && (typeof policy.workingDirectory !== 'string' || !isAbsolute(policy.workingDirectory))) throw new Error('Claude working directory must be an absolute path.');
  if (policy.model != null && (typeof policy.model !== 'string' || !/^[a-z\d._:-]{1,100}$/i.test(policy.model))) throw new Error('Invalid Claude model.');
  const selected = effort ?? policy.defaultEffort;
  if (selected != null && !CLAUDE_EFFORTS.includes(selected)) throw new Error('Choose a supported Claude effort level.');
  return { ...(policy.workingDirectory ? { workingDirectory: policy.workingDirectory } : {}), ...(policy.model ? { model: policy.model } : {}), ...(selected ? { effort: selected } : {}) };
}
