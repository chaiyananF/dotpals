import { join } from 'node:path';
import { TeamError } from './team-store.js';

// Headless AGY cannot ask for a permission and has no per-run allow list or MCP flag, so any
// command (or a write in plan mode) is auto-denied and the run ends with an empty response.
export const agyChannel = (allowCodeWrites) => `This AGY run has no Dotpals tools and no shell. Do not run commands, scripts, tests, Git or the Dotpals CLI: those calls are denied and end the run with no result. Use only file view, list and search tools${allowCodeWrites ? ', plus file edits inside the code checkout' : ''}. Your final text response is the result; Dotpals saves it to the task mailbox. Always finish with a final text answer (findings with file:line evidence, blockers and next action), even when the work is incomplete.`;
export const AGY_RECORD_RULE = 'put task notes and results in your final response, not in files, central journals or STATUS.';
export const agyWorkRule = (job) => job.allowCodeWrites
  ? `Code edits are authorized only for the current instruction within ${job.codeDir}. Git and test commands cannot run here: list what the coordinator must check or run in your final response. No DB mutations, deploy, merge, push, or scope expansion is authorized by this dispatch.`
  : 'Read-only analysis. Do not write any file and do not modify product code or team rules.';
export function agyArgs(job, directory) {
  return [...(job.nativeId ? ['--conversation', job.nativeId] : []), '--model', job.model, ...(job.effort ? ['--effort', job.effort] : []),
    '--mode', job.allowCodeWrites ? 'accept-edits' : 'plan', '--add-dir', job.codeDir, '--add-dir', directory, '--output-format', 'json', '--print-timeout', '30m',
    '--print', `Read ${join(directory, 'brief.md')} and perform only its current assignment. Return the result as your final text response.`];
}
export function validateAgyEffort(model, effort) {
  const variant = /^gemini-.*-(low|medium|high)$/i.exec(model)?.[1]?.toLowerCase();
  if (variant && effort && variant !== effort) throw new TeamError(`AGY model ${model} requires effort=${variant}, or leave effort blank.`);
}
export function agyOutcome(code, result) {
  const response = typeof result?.response === 'string' ? result.response : '';
  const denied = Array.isArray(result?.denied_actions) ? result.denied_actions : [];
  const error = denied.length ? `AGY could not complete the task: tool permission denied (${denied.map((item) => item.action || item.display_name || 'tool').join(', ')}). No approval bypass was attempted.` : !response.trim() ? 'AGY returned no final result. Inspect its diagnostics before treating this task as completed.' : result?.error || '';
  return { response, successful: code === 0 && result?.status === 'SUCCESS' && !denied.length && !!response.trim(), error };
}
