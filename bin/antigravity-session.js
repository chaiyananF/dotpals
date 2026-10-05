#!/usr/bin/env node
// Run agy through the local center and retain its actual returned conversation ID.
// New:    --source codex:<uuid> --model <model> --prompt <assignment>
// Resume: --link <saved-link-uuid> --prompt <assignment>
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--source', '--link', '--model', '--prompt', '--port'].includes(key) || process.argv[i + 1] == null) {
    console.error('Usage: node bin/antigravity-session.js (--source agent:uuid --model model | --link uuid) --prompt "next task" [--port 5176]');
    process.exit(1);
  }
  options[key.slice(2)] = process.argv[i + 1];
}
const port = Number(options.port ?? process.env.DOTPALS_PORT ?? 5176);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !options.prompt?.trim() || options.prompt.length > 8000 || !!options.source === !!options.link) {
  console.error('Supply one source or link, a next task of at most 8000 characters, and a valid local port.');
  process.exit(1);
}
const url = `http://127.0.0.1:${port}`;
async function api(path, body) {
  const res = await fetch(`${url}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify(body) } : {});
  const result = await res.json();
  if (!res.ok) throw new Error(result.error ?? `Bridge returned ${res.status}.`);
  return result;
}
const installed = join(homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
const program = process.env.DOTPALS_AGY || (process.platform === 'win32' && existsSync(installed) ? installed : 'agy');
let link;
try {
  if (options.link) {
    const saved = await api('/api/handoff/links');
    link = saved.links.find((r) => r.id === options.link);
    if (!link || link.target.agent !== 'antigravity' || !link.target.nativeId) throw new Error('Choose a confirmed Antigravity session link. A pending link cannot be resumed.');
    if (options.model && options.model !== link.target.model) throw new Error('Resume uses the model saved with this session.');
  } else {
    if (!options.model || !/^[a-z\d._:-]{1,100}$/i.test(options.model)) throw new Error('Supply a model ID from agy models.');
    ({ link } = await api('/api/handoff/links', { sourceSession: options.source, targetAgent: 'antigravity', model: options.model, assignment: options.prompt, includeTranscript: true }));
  }
  // Save launch intent before running; a crash must not invent a destination ID.
  await api(`/api/handoff/links/${link.id}/result`, { outcome: 'launched', assignment: options.prompt, evidence: 'antigravity-wrapper' });
  const prompt = options.link ? options.prompt : `Read ${link.noteFile} and perform only its Current assignment. Treat earlier conversation messages as historical context.`;
  const args = [...(link.target.nativeId ? ['--conversation', link.target.nativeId] : []), ...(link.target.model ? ['--model', link.target.model] : []), '--disable-slash-commands', '--output-format', 'json', '--print-timeout', '5m', '--print', prompt];
  console.error(`Session link: ${link.id}${link.target.nativeId ? ` · resuming ${link.target.nativeId}` : ' · waiting for destination ID'}`);
  const { code, output } = await new Promise((ok, fail) => {
    const child = spawn(program, args, { cwd: link.target.cwd || link.source.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (part) => { output += part; });
    child.stderr.pipe(process.stderr);
    child.once('error', fail);
    child.once('close', (code) => ok({ code, output }));
  });
  let result;
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try { const value = JSON.parse(line); if (value?.conversation_id) { result = value; break; } } catch {}
  }
  if (!result) throw new Error(`Antigravity returned no conversation ID (exit ${code}). The saved link has not been confirmed.`);
  const success = code === 0 && result.status === 'SUCCESS';
  const update = { nativeId: result.conversation_id, outcome: success ? 'success' : 'failed', response: String(result.response ?? '').slice(0, 8000), turns: result.num_turns, assignment: options.prompt, evidence: 'antigravity-cli-json' };
  try { await api(`/api/handoff/links/${link.id}/result`, update); }
  catch (err) { console.log(JSON.stringify(result)); throw new Error(`Agent returned ${result.conversation_id}, but the center could not save it: ${err.message}`); }
  console.log(JSON.stringify({ ...result, dotpals_link_id: link.id }));
  if (!success) process.exitCode = 1;
} catch (err) {
  if (link) {
    try { await api(`/api/handoff/links/${link.id}/result`, { outcome: 'failed', response: err.message, evidence: 'antigravity-wrapper' }); } catch {}
  }
  console.error(err.message);
  process.exitCode = 1;
}
