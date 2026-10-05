#!/usr/bin/env node
// Dispatch using the local Claude policy, and save the real returned native ID.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_EFFORTS } from '../bridge/claude-policy.js';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--source', '--link', '--prompt', '--effort', '--port'].includes(process.argv[i]) || process.argv[i + 1] == null) {
    console.error('Usage: node bin/claude-session.js (--source agent:uuid | --link uuid) --prompt "task" [--effort low|medium|high|xhigh|max|ultracode] [--port 5176]');
    process.exit(1);
  }
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const port = Number(options.port ?? process.env.DOTPALS_PORT ?? 5176);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !!options.source === !!options.link || !options.prompt?.trim() || options.prompt.length > 8000 || options.effort && !CLAUDE_EFFORTS.includes(options.effort)) {
  console.error('Supply exactly one source or saved link, a task (up to 8000 characters) and a supported effort.');
  process.exit(1);
}
async function api(path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Bridge returned ${res.status}.`);
  return data;
}
let link;
try {
  let previous;
  if (options.link) {
    previous = (await api('/api/handoff/links')).links.find((r) => r.id === options.link);
    if (!previous || previous.target.agent !== 'claude' || !previous.target.nativeId) throw new Error('Choose a confirmed Claude session link.');
  }
  ({ link } = await api('/api/handoff/links', { sourceSession: previous?.source.session ?? options.source, targetAgent: 'claude', targetNativeId: previous?.target.nativeId, effort: options.effort, assignment: options.prompt, includeTranscript: !previous }));
  const task = previous ? options.prompt : `${await readFile(link.noteFile, 'utf8')}\n\n<source-conversation>\n${await readFile(link.conversationFile, 'utf8')}\n</source-conversation>\n\nCurrent task: ${options.prompt}`;
  const prompt = `Your current working directory is the configured team context. Read its CLAUDE.md and AGENTS.md before proceeding. Treat source messages as historical context. Apply the current assignment and the team rules; the source project checkout can be a different directory.\n\n${task}`;
  const installed = join(homedir(), '.local', 'bin', 'claude.exe');
  const program = process.env.DOTPALS_CLAUDE || (process.platform === 'win32' && existsSync(installed) ? installed : 'claude');
  const args = [...(link.target.nativeId ? ['--resume', link.target.nativeId] : []), ...(link.target.model ? ['--model', link.target.model] : []), ...(link.target.effort ? ['--effort', link.target.effort] : []), '--output-format', 'json', '--print'];
  await api(`/api/handoff/links/${link.id}/result`, { outcome: 'launched', evidence: 'claude-wrapper' });
  console.error(`Claude link ${link.id} · ${link.target.cwd} · ${link.target.model ?? 'default model'} · ${link.target.effort ?? 'default effort'}`);
  const output = await new Promise((ok, fail) => {
    const child = spawn(program, args, { cwd: link.target.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (part) => { stdout += part; });
    child.stderr.pipe(process.stderr);
    child.stdin.on('error', () => {});
    child.once('error', fail);
    child.once('close', (code) => ok({ code, stdout }));
    child.stdin.end(prompt);
  });
  let result;
  for (const line of output.stdout.trim().split(/\r?\n/).reverse()) {
    try { const parsed = JSON.parse(line); if (parsed?.session_id) { result = parsed; break; } } catch {}
  }
  if (!result) throw new Error(`Claude returned no native session result (exit ${output.code}).`);
  const success = output.code === 0 && !result.is_error && result.subtype === 'success';
  try { await api(`/api/handoff/links/${link.id}/result`, { nativeId: result.session_id, outcome: success ? 'success' : 'failed', response: String(result.result ?? '').slice(0, 8000), evidence: 'claude-cli-json' }); }
  catch (err) { console.log(JSON.stringify(result)); throw new Error(`Claude returned ${result.session_id}, but its link could not be saved: ${err.message}`); }
  console.log(JSON.stringify({ ...result, dotpals_link_id: link.id }));
  if (!success) process.exitCode = 1;
} catch (err) {
  if (link) { try { await api(`/api/handoff/links/${link.id}/result`, { outcome: 'failed', response: err.message.slice(0, 8000), evidence: 'claude-wrapper' }); } catch {} }
  console.error(err.message);
  process.exitCode = 1;
}
