// "Continue in ▾": hand a session to another agent, from the pal, the notch and the
// dashboard. Resume keeps a native Claude/Codex ID. Hand-off can open a recorded
// destination or a new session with the source context and an optional assignment.
// An agent opens in a terminal; the menu cannot type into its already-open window.
//
//   continueMenu(session, { copy?, inline? }) → an element to put in a header
//   copy:   (text) => void, the page's own clipboard (the desktop app's, say)
//   inline: the menu opens in place instead of floating (inside a scrolling box)

const CSS = `
.dp-handoff { position: relative; display: inline-flex; flex-direction: column; align-items: flex-end; -webkit-app-region: no-drag; }
.dp-handoff.inline { align-items: stretch; }
.dp-handoff .dp-ho-toggle { white-space: nowrap; }
.dp-ho-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 60; min-width: 220px; max-width: 300px; display: grid; gap: 1px; padding: 4px; border-radius: 10px; background: var(--raise, #1c1c22); border: 1px solid var(--line, #2a2a31); box-shadow: 0 10px 28px rgb(0 0 0 / .5); text-align: left; }
.dp-handoff.inline .dp-ho-menu { position: static; margin-top: 6px; max-width: none; box-shadow: none; }
.dp-ho-menu[hidden] { display: none; }
.dp-ho-menu button { all: unset; box-sizing: border-box; display: block; padding: 6px 10px; border-radius: 7px; cursor: pointer; font-family: inherit; font-weight: 600; font-size: 12.5px; line-height: 1.3; color: var(--text, #f2f2f5); }
.dp-ho-menu button:hover, .dp-ho-menu button:focus-visible { background: rgb(255 255 255 / .08); }
.dp-ho-menu button span { display: block; font-weight: 400; font-size: 11px; color: var(--muted, #8b8b96); }
.dp-ho-menu small { display: block; padding: 4px 10px; font-size: 11px; line-height: 1.35; color: var(--muted, #8b8b96); }
.dp-ho-menu small.bad { color: var(--bad, #f2555a); }
.dp-ho-menu label { display: grid; gap: 4px; padding: 6px 10px; font-size: 11px; }
.dp-ho-menu select, .dp-ho-menu textarea { box-sizing: border-box; width: 100%; min-width: 0; color: var(--text, #f2f2f5); background: var(--bg, #0b0b0e); border: 1px solid var(--line, #2a2a31); border-radius: 5px; padding: 6px; font: inherit; }
.dp-ho-menu textarea { resize: vertical; min-height: 56px; }
.dp-ho-menu .dp-transcript { display: flex; align-items: center; }
.dp-ho-menu { max-height: 72vh; overflow-y: auto; }
.dp-ho-menu button:disabled { opacity: .5; cursor: default; }
.dp-ho-menu hr { border: 0; border-top: 1px solid var(--line, #2a2a31); margin: 3px 0; }
body.compact .dp-handoff { display: none; }
`;

function injectCss() {
  if (document.getElementById('dp-handoff-css')) return;
  const style = document.createElement('style');
  style.id = 'dp-handoff-css';
  style.textContent = CSS;
  document.head.append(style);
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const sessionKey = (id) => typeof id === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id) ? `claude:${id}` : id;

let installed = null; // { at, list }: GET /api/handoff/agents, kept for a minute
async function agents() {
  if (installed && Date.now() - installed.at < 60_000) return installed.list;
  const res = await fetch('/api/handoff/agents');
  const { agents: list = [] } = await res.json();
  installed = { at: Date.now(), list };
  return list;
}

async function ask(session, agent, options = {}) {
  try {
    const res = await fetch('/api/handoff', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dotpals': '1' }, body: JSON.stringify({ session, agent, ...options }) });
    const body = await res.json().catch(() => ({}));
    return { ...body, ok: res.ok };
  } catch {
    return { ok: false, error: 'Couldn’t reach the dotpals bridge.' };
  }
}

// Throws when it can't copy (no clipboard, or the browser said no), so the menu never says "Copied" for nothing.
const defaultCopy = async (text) => {
  if (window.dotpalsDesktop?.copy) return window.dotpalsDesktop.copy(text);
  if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
  return navigator.clipboard.writeText(text);
};

export function continueMenu(session, { copy = defaultCopy, inline = false } = {}) {
  injectCss();
  const box = el('span', `dp-handoff${inline ? ' inline' : ''}`);
  const toggle = el('button', 'dp-ho-toggle', 'Continue in ▾');
  toggle.type = 'button';
  toggle.title = 'Resume this saved session, or send its context and a next task to another session';
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  const menu = el('div', 'dp-ho-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  box.append(toggle, menu);
  let note = null; // a note that came back with an error, to copy instead
  let includeTranscript = true;
  let assignment = '';
  let effort = '';
  let destination = '';
  let generation = 0;

  const flash = (text) => {
    toggle.textContent = text;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { toggle.textContent = 'Continue in ▾'; }, 2200);
  };
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', outside, true);
  };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  const item = (label, sub, onclick) => {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (sub) b.append(el('span', '', sub));
    b.onclick = (e) => { e.stopPropagation(); onclick(); };
    return b;
  };
  async function doCopy() {
    const text = note ?? (await ask(session, 'copy')).note;
    if (!text) return render('Couldn’t make the note (is the bridge running?).');
    try { await copy(text); } catch { return render('Couldn’t copy it: the clipboard isn’t available here. Try again from the dashboard.', false, true); }
    close();
    flash('Copied ✓');
  }
  async function start(a, options = {}) {
    render(`Opening ${a.name}…`, true);
    const r = await ask(session, a.id, { includeTranscript, assignment, ...(a.id === 'claude' && effort ? { effort } : {}), ...options });
    if (r.ok) { note = null; close(); flash(`Opened ${a.name} ✓`); return; }
    note = r.note ?? null;
    render(r.error ?? 'That didn’t work.', false, true);
  }
  async function render(status, busy = false, bad = false) {
    const version = ++generation;
    const [list, catalog] = await Promise.all([
      agents().catch(() => null),
      fetch(`/api/handoff/sessions?session=${encodeURIComponent(session)}`).then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);
    if (version !== generation) return;
    const items = [];
    const source = catalog?.source;
    if (source && list?.some((a) => a.id === source.agent)) {
      const name = list.find((a) => a.id === source.agent).name;
      const resume = item(`Resume this ${name} session`, source.busy ? 'Still active: use its current window' : 'Open the saved conversation in a terminal', () => !busy && start({ id: source.agent, name }, { action: 'resume', includeTranscript: false }));
      resume.disabled = busy || source.busy;
      items.push(resume);
      items.push(item('Copy original conversation', 'User and assistant messages from the native log', async () => {
        if (busy) return;
        try {
          const res = await fetch(`/api/sessions/${encodeURIComponent(session)}/conversation`);
          const chat = await res.json();
          if (!res.ok) return render(chat.error ?? 'Conversation unavailable.', false, true);
          await copy(chat.text); close(); flash('Conversation copied ✓');
        } catch { render('Couldn’t copy the original conversation.', false, true); }
      }));
      items.push(el('hr'));
    }
    const task = el('label', '', 'Next task (optional)');
    const input = el('textarea'); input.value = assignment; input.maxLength = 8000; input.disabled = busy;
    input.oninput = () => { assignment = input.value; }; task.append(input); items.push(task);
    if (list?.some((a) => a.id === 'claude')) {
      const effortLabel = el('label', '', 'Claude effort');
      const effortInput = el('select'); effortInput.disabled = busy;
      for (const level of ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
        const option = el('option', '', level || `Default (${catalog?.claude?.effort ?? 'Claude setting'})`);
        option.value = level; effortInput.append(option);
      }
      effortInput.value = effort; effortInput.onchange = () => { effort = effortInput.value; };
      effortLabel.append(effortInput); items.push(effortLabel);
      if (catalog?.claude?.model || catalog?.claude?.workingDirectory) items.push(el('small', '', `Claude: ${catalog.claude.model ?? 'default model'}${catalog.claude.workingDirectory ? ` · ${catalog.claude.workingDirectory}` : ''}`));
    }
    const transcript = el('label', 'dp-transcript');
    const check = el('input'); check.type = 'checkbox'; check.checked = !!source && includeTranscript; check.disabled = busy || !source;
    check.onchange = () => { includeTranscript = check.checked; };
    transcript.append(check, document.createTextNode('Include original conversation')); items.push(transcript);
    const targets = (catalog?.targets ?? []).filter((s) => list?.some((a) => a.id === s.agent));
    items.push(el('small', '', 'Send to an existing session in this project:'));
    if (targets.length) {
      const label = el('label', '', 'Destination session');
      const select = el('select'); select.disabled = busy;
      for (const s of targets) {
        const option = el('option', '', `${s.agent === 'claude' ? 'Claude' : 'Codex'} · ${(s.title || s.nativeId).slice(0, 85)}${s.busy ? ' (active)' : ''}`);
        option.value = s.session; option.disabled = s.busy; select.append(option);
      }
      destination = targets.find((s) => s.session === destination && !s.busy)?.session ?? targets.find((s) => !s.busy)?.session ?? '';
      select.value = destination;
      select.onchange = () => { destination = select.value; };
      label.append(select); items.push(label);
      const send = item('Send to selected session', 'Resume it with the hand-off context and next task', () => {
        const target = targets.find((s) => s.session === destination);
        if (!busy && target && !target.busy) start({ id: target.agent, name: list.find((a) => a.id === target.agent).name }, { targetSession: target.session });
      });
      send.disabled = busy || !destination; items.push(send);
    } else items.push(el('small', '', 'No other recorded Claude or Codex sessions in this project yet.'));
    items.push(el('hr'), el('small', '', 'Or start a new session:'));
    if (list === null) items.push(el('small', 'bad', 'Couldn’t reach the dotpals bridge.'));
    else if (!list.length) items.push(el('small', '', 'No Codex, Claude Code or Gemini CLI found on this computer.'));
    for (const a of list ?? []) items.push(item(`New ${a.name} session`, 'in a new terminal, in this project', () => !busy && start(a, { includeTranscript: !!source && includeTranscript })));
    items.push(el('hr'), item(note ? 'Copy the note instead' : 'Copy', 'the hand-off note, as Markdown', doCopy));
    const links = (catalog?.links ?? []).filter((r) => sessionKey(r.source.session) !== sessionKey(r.target.session));
    if (links.length) {
      items.push(el('hr'), el('small', '', 'Saved hand-off sessions:'));
      for (const link of links.slice(0, 8)) {
        const target = sessionKey(link.target.session) === sessionKey(session) ? link.source : link.target;
        const name = target.agent === 'antigravity' ? `Antigravity${target.model ? ` · ${target.model}` : ''}` : target.agent;
        const stamp = new Date(link.updatedAt).toLocaleString();
        if (!target.nativeId) {
          items.push(el('small', link.status === 'launch-failed' ? 'bad' : '', `${name}: ${link.status === 'launch-failed' ? 'launch failed' : 'waiting for native session ID'} · ${stamp}`));
          continue;
        }
        let command = target.agent === 'antigravity' ? `agy --conversation ${target.nativeId}${target.model ? ` --model ${target.model}` : ''}`
          : target.agent === 'codex' ? `codex resume ${target.nativeId}` : `${target.agent} --resume ${target.nativeId}`;
        if (target.agent === 'claude') {
          const model = catalog?.claude?.model ?? target.model;
          const level = effort || catalog?.claude?.effort || target.effort;
          if (model) command += ` --model ${model}`;
          if (level) command += ` --effort ${level}`;
          const directory = catalog?.claude?.workingDirectory;
          if (directory && /^[a-z]:[\\/]/i.test(directory)) command = `Set-Location -LiteralPath '${directory.replace(/'/g, "''")}'\n${command}`;
        }
        items.push(item(`Copy ${name} resume command`, `${target.nativeId} · ${stamp}`, async () => {
          if (busy) return;
          try { await copy(command); close(); flash('Resume command copied ✓'); }
          catch { render('Couldn’t copy the resume command.', false, true); }
        }));
      }
    }
    if (status) items.push(el('small', bad ? 'bad' : '', status));
    menu.replaceChildren(...items);
  }
  toggle.onclick = async (e) => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    note = null;
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    addEventListener('pointerdown', outside, true);
    menu.replaceChildren(el('small', '', 'Looking for your agents…'));
    await render();
    menu.querySelector('button')?.focus();
  };
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); close(); toggle.focus(); } });
  return box;
}
