// The bridge owns CLI processes. Agents submit delegation requests through this API.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AGY_RECORD_RULE, agyArgs, agyChannel, agyOutcome, agyWorkRule, validateAgyEffort } from './agy-worker.js';
import { CLAUDE_EFFORTS, claudePolicy } from './claude-policy.js';
import { home } from './config.js';
import { isFolder } from './handoff.js';
import { isSessionId, isSessionModel } from './session-links.js';
import { TEAM_ROLES, TeamError, teamSession } from './team-store.js';

const providers = ['claude', 'codex', 'antigravity'];
const coordinatorModels = { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol' };
const clean = (value, name, max = 8000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TeamError(`${name} is required (up to ${max} characters).`);
  return value.trim();
};
const alive = (pid) => { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
function executable(provider) {
  const options = {
    claude: [process.env.DOTPALS_CLAUDE, join(homedir(), '.local', 'bin', 'claude.exe')],
    antigravity: [process.env.DOTPALS_AGY, join(homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe')],
    codex: [process.env.DOTPALS_CODEX_CLI, join(homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')],
  };
  for (const file of options[provider]) if (file && existsSync(file)) return file;
  for (const dir of String(process.env.PATH ?? process.env.Path ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const file = join(dir.replace(/^"|"$/g, ''), `${provider === 'antigravity' ? 'agy' : provider}${process.platform === 'win32' ? '.exe' : ''}`);
    if (existsSync(file)) return file;
  }
  return null;
}

export function createTeamDispatch({ store, links, catalog, send, root, port }) {
  const children = new Map();
  let stopped = false;
  let pumping = false;
  const changed = (job) => { send('team-dispatch', { taskId: job.taskId, dispatchId: job.id }); send('team-task', { taskId: job.taskId }); };
  const status = (id, patch) => { const job = store.dispatchState(id, patch); changed(job); return job; };
  for (const job of store.dispatches()) {
    if (['queued', 'running'].includes(job.status) && !alive(job.ownerPid)) status(job.id, { status: 'interrupted', error: 'The previous bridge stopped. Inspect the original CLI before resuming; this run was not retried.', finishedAt: new Date().toISOString() });
  }
  function options() {
    const policy = claudePolicy();
    let models = [];
    try { models = JSON.parse(readFileSync(join(home(), 'dispatch-models.json'), 'utf8')).antigravity ?? []; } catch {}
    if (!models.length) models = [...new Set([...store.dispatches().filter((job) => job.provider === 'antigravity' && job.model).map((job) => job.model), ...links.list().filter((link) => link.target.agent === 'antigravity' && link.target.model).map((link) => link.target.model)])];
    return { providers: providers.map((id) => ({ id, name: { claude: 'Claude Code', codex: 'Codex', antigravity: 'AGY / Gemini' }[id], installed: !!executable(id) })), contextDir: policy.workingDirectory ?? root, codeDir: root,
      coordinationMode: 'external', coordinatorModels, coordinatorEffort: 'high', claudeModel: policy.model ?? 'claude-sonnet-5-5', claudeEffort: policy.effort ?? 'medium', efforts: CLAUDE_EFFORTS, antigravityModels: models };
  }
  function submit(input) {
    if (stopped) throw new TeamError('Bridge is stopping.', 409);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TeamError('Expected a dispatch object.');
    const provider = input.agent;
    if (!providers.includes(provider)) throw new TeamError('Choose Claude, Codex or Antigravity.');
    if (!executable(provider)) throw new TeamError('This CLI is not installed on this machine.');
    const prompt = clean(input.prompt, 'Instruction');
    const key = clean(input.idempotencyKey, 'idempotencyKey', 160);
    if (input.allowCodeWrites != null && typeof input.allowCodeWrites !== 'boolean') throw new TeamError('allowCodeWrites must be boolean.');
    const allowCodeWrites = input.allowCodeWrites === true;
    const allowedCommands = input.allowedCommands ?? [];
    if (!Array.isArray(allowedCommands) || allowedCommands.length > 8 || allowedCommands.some((command) => typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\r\n\0*?()]/.test(command))) throw new TeamError('allowedCommands must contain up to eight exact commands, without wildcards or multiline rules.');
    if (allowedCommands.length && (provider !== 'claude' || !allowCodeWrites)) throw new TeamError('Exact command grants require an authorized Claude code-write assignment.');
    if (input.title != null && (typeof input.title !== 'string' || input.title.length > 160)) throw new TeamError('Title must be text of at most 160 characters.');
    if (input.branch != null && (typeof input.branch !== 'string' || input.branch.length > 240)) throw new TeamError('Branch must be text of at most 240 characters.');
    if (input.codeDir != null && typeof input.codeDir !== 'string') throw new TeamError('codeDir must be a folder path.');
    const task = input.taskId ? store.get(input.taskId).task : null;
    const from = input.from ?? 'user';
    if (task && from !== 'user' && from !== task.coordinatorId) throw new TeamError('Workers return results to Raphael; only the coordinator can delegate.');
    if (!task && from !== 'user') throw new TeamError('Select your existing task before delegating.');
    const recipient = task?.participants.find((person) => person.id === input.participantId);
    if (recipient?.execution === 'external') throw new TeamError('Continue with Raphael in the existing app chat. Dotpals does not launch that coordinator.', 409);
    if (input.participantId && !recipient) throw new TeamError('Task recipient not found.');
    if (recipient && recipient.provider !== provider) throw new TeamError('Resume must use the recipient’s original provider.');
    const nativeId = recipient?.nativeId ?? (input.session ? teamSession(input.session).split(':')[1] : null);
    if (input.session && teamSession(input.session).split(':')[0] !== provider) throw new TeamError('Session provider does not match the selected agent.');
    if (recipient && !nativeId) throw new TeamError('This recipient has no confirmed native session yet. Wait for its original run.', 409);
    if (provider === 'claude' && input.effort && !CLAUDE_EFFORTS.includes(input.effort)) throw new TeamError('Choose a supported Claude effort level.');
    const policy = claudePolicy({ effort: provider === 'claude' ? input.effort || undefined : undefined });
    const cwd = policy.workingDirectory ?? task?.contextDir ?? root;
    const codeDir = resolve(input.codeDir || task?.codeDir || root);
    if (!isAbsolute(cwd) || !isFolder(cwd) || !isFolder(codeDir)) throw new TeamError('The configured team folder or code checkout is unavailable.');
    if (from !== 'user' && allowCodeWrites) {
      const source = task.participants.find((person) => person.id === from);
      const permitted = source.writePaths.some((path) => { const rel = relative(resolve(path), codeDir); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); });
      if (!permitted) throw new TeamError('Delegation cannot expand the coordinator’s approved write paths.');
    }
    const parent = input.parentRunId ? store.dispatch(input.parentRunId) : null;
    if (input.parentRunId && (!parent || parent.taskId !== task?.id || parent.participantId !== from || parent.role !== 'raphael')) throw new TeamError('Delegation parent must be the coordinator’s run in this task.');
    if (parent && !parent.allowCodeWrites && allowCodeWrites) throw new TeamError('A read-only coordinator run cannot delegate code edits.');
    const role = recipient?.role ?? (task ? input.role ?? 'petros' : 'raphael');
    if (role === 'raphael') throw new TeamError('Raphael works in the app chat. Attach that chat with team-center coordinate, then delegate a worker.', 409);
    if (!TEAM_ROLES.includes(role) || task && !recipient && role === 'raphael') throw new TeamError('This task already has Raphael. Choose a worker role.');
    if (role === 'raphael' && !coordinatorModels[provider]) throw new TeamError('Choose Claude Opus 5.5 or Codex Sol 6.1 for Raphael. AGY is available for delegated work.');
    const known = nativeId ? catalog().find((row) => row.agent === provider && row.nativeId === nativeId) : null;
    const saved = store.list().flatMap((row) => row.participants).find((person) => person.provider === provider && person.nativeId === nativeId);
    const model = role === 'raphael' ? coordinatorModels[provider] : input.model || recipient?.model || known?.model || saved?.model || (provider === 'claude' ? policy.model ?? 'claude-sonnet-5-5' : '');
    if (!isSessionModel(model || null)) throw new TeamError('Invalid model ID.');
    if (provider === 'antigravity' && !model) throw new TeamError('Select an AGY model.');
    if (provider === 'antigravity' && nativeId && saved?.model && model !== saved.model) throw new TeamError('AGY resume uses the model already saved for that session.');
    const effort = input.effort || (role === 'raphael' ? 'high' : provider === 'claude' ? policy.effort : '');
    if (provider === 'codex' && effort && !['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new TeamError('Unsupported Codex reasoning effort.');
    if (provider === 'antigravity' && effort && !['low', 'medium', 'high', 'max'].includes(effort)) throw new TeamError('Unsupported AGY effort.');
    if (provider === 'antigravity') validateAgyEffort(model, effort);
    const plan = { taskId: task?.id ?? null, from, participantId: recipient?.id ?? null, parentRunId: parent?.id ?? null, provider, nativeId, role, prompt, cwd, codeDir, model, effort, allowCodeWrites, allowedCommands, idempotencyKey: key,
      task: { title: input.title?.trim() || prompt.split('\n')[0].slice(0, 140), goal: prompt, scope: allowCodeWrites ? 'Code work within the selected checkout and current instruction.' : 'Read-only analysis and coordination.', acceptance: 'Return a result with evidence, blockers and the next action.', contextDir: cwd, codeDir, branch: input.branch || task?.branch || '', contractVersion: 'app-dispatch-v1' } };
    plan.fingerprint = JSON.stringify({ taskId: input.taskId ?? null, from, participantId: input.participantId ?? null, parentRunId: input.parentRunId ?? null, provider, prompt, session: input.session ?? null, role: input.role ?? null, model: input.model ?? '', effort: input.effort ?? '', allowCodeWrites, codeDir: input.codeDir ?? '', title: input.title ?? '', branch: input.branch ?? '', ...(allowedCommands.length ? { allowedCommands } : {}) });
    const previous = store.dispatches().find((job) => job.idempotencyKey === key && job.from === from);
    if (previous) {
      if (previous.fingerprint !== plan.fingerprint) throw new TeamError('Dispatch key already has different content.', 409);
      return previous;
    }
    if (known?.busy) throw new TeamError('That native session is currently working. Use its current window or wait.', 409);
    if (nativeId && store.dispatches().some((job) => job.provider === provider && job.nativeId === nativeId && ['queued', 'running', 'interrupted'].includes(job.status))) throw new TeamError('A run already owns this native session. Inspect the saved run first.', 409);
    if (store.dispatches().filter((job) => ['queued', 'running'].includes(job.status)).length >= 20) throw new TeamError('Dispatch queue is full. Wait for current runs.', 409);
    const prepared = store.prepareDispatch(plan);
    changed(prepared.job);
    if (!prepared.existing) setImmediate(pump);
    return prepared.job;
  }
  function brief(job) {
    const task = store.get(job.taskId).task;
    const rolePath = join(job.cwd, 'MyTeam', 'roles', `${job.role}.md`);
    const cli = join(root, 'bin', 'team-center.js');
    return `# Current team assignment\n\nTask ID: ${job.taskId}\nParticipant ID: ${job.participantId}\nRole: ${job.role}\nProvider: ${job.provider}\nTeam context: ${job.cwd}\nCode checkout: ${job.codeDir}\nBranch: ${task.branch || 'Unspecified; obtain the required branch decision before editing.'}\nContract: ${task.contractVersion}\n\nRead ${join(job.cwd, 'CLAUDE.md')} and ${join(job.cwd, 'AGENTS.md')}, then ${rolePath} and the role journal's first four sections. Follow relevant team workflows progressively. The central team folder is read-only; ${job.provider === 'antigravity' ? AGY_RECORD_RULE : "keep task notes/results in this run's private artifact directory, not central journals or STATUS."}\n\n${job.provider === 'antigravity' ? agyWorkRule(job) : job.allowCodeWrites ? `Code edits are authorized only for the current instruction within ${job.codeDir}. Check Git ownership and dirty files; use an isolated checkout for delegated writers. No DB mutations, deploy, merge, push, or scope expansion is authorized by this dispatch.` : 'Read-only analysis. Do not modify product code or team rules. You may write your own run artifacts and use the local Dotpals task API.'}\n\nTask goal:\n${task.goal}\n\nScope:\n${task.scope}\n\nAcceptance:\n${task.acceptance}\n\nCheckpoint:\n${task.checkpoint}\n\n${job.role === 'raphael' ? `You are the sole coordinator for this task. Do small work yourself. When useful, delegate through the Dotpals broker using the absolute CLI ${cli}; use a JSON spec file and the dispatch command with --task ${job.taskId} --file <spec>. Your environment provides DOTPALS_PARTICIPANT_ID, DOTPALS_TASK_ID, DOTPALS_RUN_DIR and DOTPALS_PORT. The spec contains agent (claude/codex/antigravity), role, prompt, model when AGY needs it, codeDir and allowCodeWrites (false by default). Do not launch nested provider CLIs yourself. Workers cannot redelegate. Broker concurrency is two CLI runs; normally delegate one worker at a time. Read the submitted run with runs or run; use bounded waits between reads. A worker's final response is saved in the task mailbox. Inspect its evidence before reporting. No automatic question/answer loop exists; return unresolved questions to the user.` : 'You are a worker. Do not launch or delegate another agent. Return evidence, blockers and next action to the coordinator.'}\n\nTreat old session messages as historical context. Perform only this current instruction:\n\n${job.prompt}\n`;
  }
  async function run(job) {
    const directory = join(home(), 'dispatch', job.id);
    let cancelled = false;
    let output = '';
    let errors = '';
    let observedId = null;
    let timer;
    try {
      mkdirSync(directory, { recursive: true });
      const channel = job.provider === 'antigravity'
        ? agyChannel(job.allowCodeWrites)
        : 'Dotpals MCP tools are attached to this run: task, runs, run and options. Raphael also has dispatch. Prefer these tools for delegation and result retrieval; no shell/network workaround is needed. Call dispatch once with a stable idempotencyKey, then inspect the returned run ID. Workers do not have the dispatch tool.';
      const coordination = job.role === 'raphael' ? `You receive the user's instruction as the principal coordinator, using ${job.model}. First analyze the instruction, scope and difficulty. Decide whether to do it yourself or delegate a scoped worker; select that worker's provider, model and effort explicitly to fit the work (Claude Sonnet 5.5 is a worker option, not the coordinator default). When you delegate, wait for the worker's terminal run state and read its response/evidence before your final response. Use the MCP run tool with waitSeconds=30, repeating bounded waits while necessary; do not merely report that a job was dispatched. On failure, interruption or timeout, explain what is incomplete. Your final response to the user must summarize the outcome, evidence, changes and limitations, then recommend the next step. STOP after that summary and wait for the user's next instruction. Do not start the recommended next phase or an autonomous question/answer exchange.` : '';
      const prompt = `${channel}\n\n${coordination}\n\n${brief(job)}`;
      writeFileSync(join(directory, 'brief.md'), prompt, { mode: 0o600 });
      const responseFile = join(directory, 'response.txt');
      const nodeProgram = process.platform === 'win32' && existsSync('C:\\Program Files\\nodejs\\node.exe') ? 'C:\\Program Files\\nodejs\\node.exe' : 'node';
      const boundEnv = { DOTPALS_PORT: String(port), DOTPALS_TASK_ID: job.taskId, DOTPALS_PARTICIPANT_ID: job.participantId, DOTPALS_DISPATCH_ID: job.id, DOTPALS_RUN_DIR: directory, DOTPALS_ROLE: job.role };
      const mcp = { command: nodeProgram, args: [join(root, 'bin', 'team-mcp.js')], env: boundEnv };
      const mcpConfig = join(directory, 'mcp.json');
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { dotpals: mcp } }, null, 2), { mode: 0o600 });
      const args = [];
      if (job.provider === 'claude') args.push(...(job.nativeId ? ['--resume', job.nativeId] : []), ...(job.model ? ['--model', job.model] : []), ...(job.effort ? ['--effort', job.effort] : []), ...(!job.allowCodeWrites ? ['--permission-mode', 'plan'] : []), '--mcp-config', mcpConfig, '--allowedTools', 'mcp__dotpals__*', ...(job.allowedCommands ?? []).map((command) => `Bash(${command})`), '--add-dir', job.codeDir, directory, '--output-format', 'json', '--print');
      if (job.provider === 'antigravity') args.push(...agyArgs(job, directory));
      if (job.provider === 'codex') {
        args.push('exec', '-s', job.allowCodeWrites ? 'workspace-write' : 'read-only', '-C', job.codeDir, ...(job.effort ? ['-c', `model_reasoning_effort="${job.effort}"`] : []), ...(job.model ? ['-m', job.model] : []));
        for (const [name, value] of Object.entries(mcp)) {
          const toml = name === 'env' ? `{ ${Object.entries(value).map(([key, val]) => `${key} = ${JSON.stringify(val)}`).join(', ')} }` : JSON.stringify(value);
          args.push('-c', `mcp_servers.dotpals.${name}=${toml}`);
        }
        args.push('-c', 'mcp_servers.dotpals.default_tools_approval_mode="approve"', ...(job.allowCodeWrites ? ['--add-dir', directory] : []), ...(job.nativeId ? ['resume', job.nativeId] : []), '--json', '-o', responseFile, '-');
      }
      status(job.id, { status: 'running', artifactDir: directory, startedAt: new Date().toISOString() });
      const code = await new Promise((resolveRun, rejectRun) => {
        const child = spawn(executable(job.provider), args, { cwd: job.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...boundEnv } });
        const control = { child, cancel: () => { cancelled = true; child.kill(); } };
        children.set(job.id, control);
        if (child.pid) status(job.id, { childPid: child.pid });
        child.stdin.on('error', () => {});
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          if (output.length + chunk.length > 8 * 1024 * 1024) { errors = 'CLI output exceeded 8 MB.'; child.kill(); return; }
          output += chunk;
          try { appendFileSync(join(directory, 'stdout.log'), chunk, { mode: 0o600 }); }
          catch (err) { errors = `Could not save CLI output: ${err.message}`; child.kill(); }
        });
        child.stderr.on('data', (chunk) => { if (errors.length < 1024 * 1024) { errors += chunk; try { appendFileSync(join(directory, 'stderr.log'), chunk, { mode: 0o600 }); } catch (err) { errors = `Could not save CLI diagnostics: ${err.message}`; child.kill(); } } });
        child.once('error', rejectRun);
        child.once('close', resolveRun);
        timer = setTimeout(() => { errors += '\nCLI timed out after 30 minutes.'; child.kill(); }, 30 * 60 * 1000);
        if (job.provider === 'antigravity') child.stdin.end(); else child.stdin.end(prompt);
      });
      const records = output.trim().split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      try { const whole = JSON.parse(output); if (whole && typeof whole === 'object' && !Array.isArray(whole)) records.push(whole); } catch {}
      let response = '';
      let successful = false;
      let providerError = '';
      if (job.provider === 'claude') {
        const result = records.findLast((row) => row.session_id);
        observedId = result?.session_id ?? null;
        response = String(result?.result ?? '');
        successful = code === 0 && result?.subtype === 'success' && !result?.is_error;
      } else if (job.provider === 'antigravity') {
        const result = records.findLast((row) => row.conversation_id);
        observedId = result?.conversation_id ?? null;
        ({ response, successful, error: providerError } = agyOutcome(code, result));
      } else {
        observedId = records.find((row) => row.type === 'thread.started')?.thread_id ?? null;
        try { response = readFileSync(responseFile, 'utf8'); } catch {}
        if (!response) response = records.filter((row) => row.type === 'item.completed' && row.item?.type === 'agent_message').map((row) => row.item.text).join('\n');
        successful = code === 0 && records.some((row) => row.type === 'turn.completed');
      }
      if (observedId && isSessionId(observedId)) store.confirmDispatch(job.id, observedId);
      if (!observedId || !isSessionId(observedId)) successful = false;
      if (cancelled) successful = false;
      if (response) writeFileSync(responseFile, response, { mode: 0o600 });
      const error = successful ? '' : cancelled ? 'Stopped by the user. Inspect the checkout before continuing.' : (!observedId ? `CLI did not return a confirmed session ID (exit ${code}). ${errors.trim().slice(-2000)}` : providerError || response || errors.trim().slice(-4000) || `CLI failed (exit ${code}).`);
      status(job.id, { status: cancelled ? 'cancelled' : successful ? 'succeeded' : 'failed', response: response.slice(0, 64000), error: error.slice(0, 8000), finishedAt: new Date().toISOString() });
      if (successful) store.read(job.taskId, job.assignmentId, { recipientId: job.participantId });
      store.send(job.taskId, { from: job.participantId, to: job.from, type: successful ? 'result' : 'blocker', body: (successful ? response || 'CLI completed with no final text.' : error).slice(0, 64000), idempotencyKey: `dispatch-result:${job.id}` });
      changed(store.dispatch(job.id));
    } catch (err) {
      const control = children.get(job.id); if (control && control.child.exitCode === null) control.child.kill();
      status(job.id, { status: cancelled ? 'cancelled' : 'failed', error: err.message.slice(0, 8000), artifactDir: directory, finishedAt: new Date().toISOString() });
      try { store.send(job.taskId, { from: job.participantId, to: job.from, type: 'blocker', body: err.message.slice(0, 64000), idempotencyKey: `dispatch-result:${job.id}` }); } catch {}
    } finally { clearTimeout(timer); children.delete(job.id); setImmediate(pump); }
  }
  function pump() {
    if (stopped || pumping) return;
    pumping = true;
    try {
      for (const job of store.dispatches().filter((row) => row.status === 'queued' && row.ownerPid === process.pid)) {
        if (children.size >= 2) break;
        // run() reaches spawn synchronously before its first awaited completion.
        run(job).catch((err) => console.error('Dispatch persistence failure:', err.message));
      }
    } finally { pumping = false; }
  }
  const publicJob = (job) => { const { fingerprint, idempotencyKey, ...visible } = job; return visible; };
  return { options, submit: (input) => publicJob(submit(input)),
    list: (taskId) => store.dispatches(taskId).map(publicJob),
    get: (id) => { const job = store.dispatch(id); if (!job) throw new TeamError('Dispatch not found.', 404); return publicJob(job); },
    cancel(id) {
      const job = store.dispatch(id); if (!job) throw new TeamError('Dispatch not found.', 404);
      if (job.status === 'queued') { const updated = status(id, { status: 'cancelled', error: 'Stopped before CLI launch.', finishedAt: new Date().toISOString() }); return publicJob(updated); }
      const control = children.get(id);
      if (!control) throw new TeamError('Only a CLI owned by this bridge can be stopped here. Inspect the original process.', 409);
      control.cancel(); return publicJob(store.dispatch(id));
    },
    stop() { stopped = true; for (const control of children.values()) control.cancel(); },
  };
}
