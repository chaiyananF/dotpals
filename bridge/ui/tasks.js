// Task mailbox UI. All user/agent content is text, never HTML.
const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const names = { raphael: 'ราฟาเอล', matthew: 'มัทธิว', thomas: 'โธมัส', philip: 'ฟิลิป', petros: 'เปโตร', andrew: 'อันดรูว์', nathaniel: 'นาธาเนียล', user: 'นายท่าน' };
const typeNames = { assignment: 'งาน', question: 'คำถาม', answer: 'คำตอบ', result: 'ผลการทำงาน', blocker: 'อุปสรรค', note: 'บันทึก' };
const statusNames = { intake: 'รับงาน', requirements: 'ข้อกำหนด', design: 'ออกแบบ', 'contract-locked': 'ล็อกข้อกำหนด', development: 'พัฒนา', 'ready-for-review': 'พร้อมส่งตรวจ', 'independent-qa': 'ตรวจ QA', uat: 'ตรวจรับ', release: 'เตรียมปล่อย', done: 'เสร็จ', 'changes-requested': 'รอแก้ไข', blocked: 'ติดอุปสรรค', 'paused-capacity': 'พักเพราะโควตา' };
const input = (value = '', multi = false) => { const el = node(multi ? 'textarea' : 'input'); el.value = value; return el; };
const field = (label, control) => { const el = node('label', '', label); el.append(control); return el; };
const select = (options, value) => { const el = node('select'); for (const [id, label] of options) { const option = node('option', '', label); option.value = id; el.append(option); } if (value != null) el.value = value; return el; };
const button = (label, handler, cls = '') => { const el = node('button', cls, label); el.type = 'button'; el.onclick = handler; return el; };
const pair = (...children) => { const el = node('div', 'team-pair'); el.append(...children); return el; };
const chatName = (session, fallback = 'แชทยังไม่มีชื่อ') => String(session?.title || session?.taskTitle || fallback).replace(/\s+/g, ' ').trim().slice(0, 120);
const coordinationNames = { analyzing: 'ราฟาเอลกำลังวิเคราะห์ในแชท', 'waiting-for-workers': 'รอผลผู้ช่วย', 'ready-to-summarize': 'ราฟาเอลรอสรุปผลในแชท', 'awaiting-user': 'สรุปแล้ว — รอคำสั่งถัดไปจากคุณ' };

export function mountTasks(host, { api, toast }) {
  let metadata = null;
  let tasks = [];
  let selected = null;
  let detail = null;
  let generation = 0;
  let composer = null;
  let dispatchOptions = null;
  let quick = null;
  let runs = [];
  let runSignature = '';
  let refreshTimer;
  const head = node('div', 'head');
  head.append(node('h1', '', 'Tasks'), node('span', 'spacer'), button('รีเฟรช', () => refresh()), button('ลงทะเบียนงานเอง', () => { selected = null; generation++; detail = null; composer = null; location.hash = 'tasks/new'; showCreate(); }), button('เริ่มงานใหม่', () => { selected = null; generation++; detail = null; composer = null; location.hash = 'tasks'; showEmpty(); updateQuick(); quick?.prompt.focus(); }, 'primary'));
  const error = node('div', 'team-error'); error.setAttribute('role', 'alert');
  const layout = node('div', 'team-layout');
  const list = node('div', 'team-list');
  const panel = node('div', 'team-detail');
  const search = input(); search.type = 'search'; search.placeholder = 'ค้นหางาน'; search.setAttribute('aria-label', 'ค้นหางาน'); search.oninput = renderList;
  const datalist = node('datalist'); datalist.id = 'team-native-sessions';
  const quickSlot = node('div');
  layout.append(list, panel); host.append(head, error, datalist, quickSlot, layout);

  async function run(action, control) {
    if (control) control.disabled = true;
    error.textContent = '';
    try { return await action(); }
    catch (err) { error.textContent = err.message; return null; }
    finally { if (control) control.disabled = false; }
  }
  async function loadMetadata() {
    [metadata, dispatchOptions] = await Promise.all([api('/api/team/sessions'), api('/api/team/dispatch/options')]);
    datalist.replaceChildren(...metadata.sessions.map((session) => { const option = node('option'); option.value = session.session; option.label = `${chatName(session)} · ${session.agent ?? session.provider}`; return option; }));
    if (!quick) buildQuick();
    updateQuick();
  }
  function buildQuick() {
    const form = node('form', 'card team-form');
    const title = node('h2', '', 'สั่งราฟาเอล');
    const context = node('p', 'team-hint');
    const agent = select(dispatchOptions.providers.map((provider) => [provider.id, `${provider.name}${provider.installed ? '' : ' (ยังไม่ได้ติดตั้ง)'}`]), 'claude');
    const target = select([['new', 'เปิด session ใหม่']]);
    const prompt = input('', true); prompt.required = true; prompt.maxLength = 8000; prompt.placeholder = 'เช่น อ่านโครงสร้าง Dotpals แล้วเลือกว่าจะทำเองหรือส่งงานให้ AGY ช่วย';
    const advanced = node('details'); advanced.append(node('summary', '', 'โฟลเดอร์ โมเดล และขอบเขตงาน'));
    const settings = node('div', 'team-form');
    const codeDir = input(dispatchOptions.codeDir);
    const branch = input();
    const model = select([]);
    const effort = select([]);
    const role = select(metadata.roles.filter((id) => id !== 'raphael').map((id) => [id, names[id]]), 'petros');
    const writes = node('input'); writes.type = 'checkbox'; writes.className = 'team-write-toggle';
    const writeLabel = node('label', 'team-write-label'); writeLabel.append(writes, 'อนุญาตแก้โค้ดตามคำสั่งในโฟลเดอร์นี้');
    settings.append(field('โฟลเดอร์โค้ด', codeDir), field('Branch ที่อนุมัติให้ทำงาน (งานอ่านเว้นได้)', branch), pair(field('โมเดล', model), field('Effort', effort)), field('บทบาทผู้รับเมื่อส่งต่อในงานเดิม', role), writeLabel);
    advanced.append(settings);
    const send = node('button', 'primary', 'ส่งให้ agent'); send.type = 'submit';
    const chosenSession = node('small', 'team-hint');
    quick = { title, context, agent, target, prompt, codeDir, branch, model, effort, role, writes, chosenSession, send, targetScope: null, pending: null };
    agent.onchange = () => updateQuick(true);
    target.onchange = () => updateQuick();
    form.append(title, context, pair(field('Agent ผู้รับ', agent), field('แชทที่จะคุยต่อ', target)), chosenSession, field('คำสั่ง', prompt), advanced, send);
    form.onsubmit = (event) => { event.preventDefault(); run(async () => {
      if (selected && !detail) throw new Error('รอโหลดงานที่เลือกก่อนส่งคำสั่ง');
      const payload = { agent: agent.value, prompt: prompt.value, model: model.value, effort: effort.value, allowCodeWrites: writes.checked, codeDir: codeDir.value, branch: branch.value };
      if (selected && detail) { payload.taskId = selected; payload.from = 'user'; payload.role = role.value; }
      if (target.value.startsWith('participant:')) payload.participantId = target.value.slice(12);
      if (target.value.startsWith('session:')) payload.session = target.value.slice(8);
      const fingerprint = JSON.stringify(payload);
      if (quick.pending?.fingerprint !== fingerprint) quick.pending = { fingerprint, key: crypto.randomUUID() };
      const result = await api('/api/team/dispatch', { ...payload, idempotencyKey: quick.pending.key });
      quick.pending = null; prompt.value = ''; toast('ส่งคำสั่งเข้าคิวแล้ว');
      if (selected === result.run.taskId) await refresh(); else location.hash = `tasks/${result.run.taskId}`;
    }, send); };
    if (dispatchOptions.coordinationMode === 'external') {
      const notice = node('div', 'card'); notice.append(node('h2', '', 'สั่งงานในแชททีม แล้วติดตามผลที่นี่'), node('p', 'team-hint', 'ราฟาเอลในแชท Codex/Claude จะจัดงาน ส่งให้ผู้ช่วย และสรุปกลับในแชทเดิม เปิด Dotpals ค้างไว้ระหว่างทำงาน ข้อความที่บันทึกที่นี่จะรอให้ราฟาเอลอ่านเมื่อทำงานต่อ'));
      const manual = node('details', 'card'); manual.append(node('summary', '', 'ส่งงานให้ผู้ช่วยโดยตรง (ขั้นสูง)'), form);
      quickSlot.replaceChildren(notice, manual);
    } else quickSlot.replaceChildren(form);
  }
  function updateQuick(agentChanged = false) {
    if (!quick || !metadata) return;
    if (!detail?.task && !selected && quick.agent.value === 'antigravity') { quick.agent.value = 'claude'; agentChanged = true; }
    for (const option of quick.agent.options) {
      const entry = dispatchOptions.providers.find((item) => item.id === option.value);
      option.disabled = dispatchOptions.coordinationMode !== 'external' && !selected && option.value === 'antigravity';
      const main = dispatchOptions.coordinationMode !== 'external' && !selected ? { claude: 'Claude — Opus 5.5 (ราฟาเอล)', codex: 'Codex — Sol 6.1 (ราฟาเอล)' }[option.value] : null;
      option.textContent = `${main || entry.name}${entry.installed ? '' : ' (ยังไม่ได้ติดตั้ง)'}`;
    }
    const provider = quick.agent.value;
    const scope = `${detail?.task.id ?? (selected ? `loading:${selected}` : 'new')}:${provider}`;
    const previous = quick.target.value;
    const task = detail?.task;
    quick.title.textContent = dispatchOptions.coordinationMode === 'external' ? 'ส่งงานให้ผู้ช่วย' : task ? 'ส่งคำสั่งหรือส่งต่องาน' : 'สั่งราฟาเอล';
    quick.context.textContent = task ? `งาน: ${task.title} — เลือกผู้รับแล้วส่งคำสั่งเพิ่มได้ เปิด Dotpals ค้างไว้ระหว่างทำงาน` : 'พิมพ์คำสั่งแล้วเลือก agent ระบบสร้างงานและจำ session ให้ ผู้รับเริ่มจากบริบททีม เปิด Dotpals ค้างไว้ระหว่างทำงาน';
    if (dispatchOptions.coordinationMode === 'external') quick.context.textContent = task ? `งาน: ${task.title} — ราฟาเอลรับคำสั่งหลักในแชททีม ช่องนี้ส่งงานให้ผู้ช่วยโดยตรง` : 'เริ่มงานในแชททีม ราฟาเอลจะผูกแชทกับทะเบียนงานให้ แล้วเลือกงานนั้นเพื่อส่งงานให้ผู้ช่วย';
    quick.send.disabled = dispatchOptions.coordinationMode === 'external' && !task;
    const choices = [['new', task || dispatchOptions.coordinationMode === 'external' ? `เปิด ${provider} ใหม่เป็นผู้รับงาน` : 'เปิด session ใหม่เป็นราฟาเอล']];
    for (const person of task?.participants ?? []) if (person.provider === provider && person.nativeId && person.execution !== 'external' && person.role !== 'raphael') {
      const session = metadata.sessions.find((row) => row.session === person.session);
      choices.push([`participant:${person.id}`, `${chatName(session, task.title)} · ${names[person.role]}`, person.session]);
    }
    const registered = new Set((task?.participants ?? []).map((person) => person.session));
    if (!task) for (const session of metadata.sessions) if ((session.agent ?? session.provider) === provider && !registered.has(session.session)) {
      const folder = (session.cwd ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
      choices.push([`session:${session.session}`, `${chatName(session)}${folder ? ` · ${folder}` : ''}`, session.session]);
    }
    quick.target.replaceChildren(...choices.map(([value, name, session]) => { const el = node('option', '', name); el.value = value; if (session) el.dataset.session = session; return el; }));
    if (quick.targetScope === scope && choices.some(([value]) => value === previous)) quick.target.value = previous;
    else {
      const coordinator = dispatchOptions.coordinationMode !== 'external' && task?.participants.find((person) => person.id === task.coordinatorId && person.provider === provider && person.nativeId);
      quick.target.value = coordinator ? `participant:${coordinator.id}` : 'new';
      if (task) { quick.codeDir.value = task.codeDir || dispatchOptions.codeDir; quick.branch.value = task.branch; }
    }
    quick.targetScope = scope;
    quick.chosenSession.textContent = quick.target.value === 'new' ? '' : `แชทที่เลือก: ${quick.target.selectedOptions[0]?.textContent ?? ''}`;
    const recipient = task?.participants.find((person) => `participant:${person.id}` === quick.target.value);
    const isCoordinator = dispatchOptions.coordinationMode !== 'external' && (!task || recipient?.role === 'raphael');
    const modelScope = `${scope}:${isCoordinator ? 'coordinator' : 'worker'}`;
    const modelChanged = quick.modelScope !== modelScope;
    const mainModel = dispatchOptions.coordinatorModels[provider];
    const modelOptions = isCoordinator && mainModel ? [[mainModel, mainModel]] : provider === 'claude' ? [...new Set([dispatchOptions.claudeModel, dispatchOptions.coordinatorModels.claude])].map((id) => [id, id]) : provider === 'antigravity' ? dispatchOptions.antigravityModels.map((id) => [id, id]) : [['', 'ใช้ค่าที่ตั้งไว้ใน Codex CLI']];
    const selectedModel = quick.model.value;
    quick.model.replaceChildren(...modelOptions.map(([id, name]) => { const el = node('option', '', name); el.value = id; return el; }));
    quick.model.disabled = isCoordinator;
    if (isCoordinator && mainModel) quick.model.value = mainModel;
    else if (!agentChanged && !modelChanged && modelOptions.some(([id]) => id === selectedModel)) quick.model.value = selectedModel;
    else if (provider === 'antigravity' && modelOptions.some(([id]) => id === 'gemini-3.8-flash-medium')) quick.model.value = 'gemini-3.8-flash-medium';
    const efforts = provider === 'claude' ? dispatchOptions.efforts : provider === 'codex' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'max'];
    const selectedEffort = quick.effort.value;
    quick.effort.replaceChildren(...[['', 'ใช้ค่าเริ่มต้น'], ...efforts.map((id) => [id, id])].map(([id, name]) => { const el = node('option', '', name); el.value = id; return el; }));
    quick.effort.value = !agentChanged && !modelChanged && ['', ...efforts].includes(selectedEffort) ? selectedEffort : isCoordinator ? dispatchOptions.coordinatorEffort : provider === 'claude' ? dispatchOptions.claudeEffort : '';
    quick.modelScope = modelScope;
    if (isCoordinator) quick.chosenSession.textContent = `${quick.chosenSession.textContent ? `${quick.chosenSession.textContent} · ` : ''}ราฟาเอลใช้ ${mainModel} และสรุปผลก่อนรอคำสั่งถัดไป`;
    if (task && quick.target.value.startsWith('participant:')) {
      const target = task.participants.find((person) => `participant:${person.id}` === quick.target.value);
      if (provider === 'antigravity' && target?.model && modelOptions.some(([id]) => id === target.model)) quick.model.value = target.model;
    }
  }
  function sessionInput() { const el = input(); el.setAttribute('list', datalist.id); el.placeholder = 'codex:UUID / claude:UUID / antigravity:UUID'; el.required = true; return el; }
  function renderList() {
    const query = search.value.toLowerCase();
    const matches = tasks.filter((task) => `${task.title} ${task.goal} ${task.id}`.toLowerCase().includes(query));
    list.replaceChildren(search, ...matches.map((task) => {
      const el = button('', () => { location.hash = `tasks/${task.id}`; }); el.className = 'team-task'; el.setAttribute('aria-current', String(task.id === selected));
      el.append(node('strong', '', task.title), node('small', '', `${statusNames[task.status] ?? task.status} · ${task.unreadMessages} ข้อความรออ่าน`)); return el;
    }));
    if (!matches.length) list.append(node('div', 'team-empty', query ? 'ไม่พบงานที่ค้นหา' : 'พิมพ์คำสั่งด้านบนเพื่อเริ่มงานแรก'));
  }
  async function refresh() {
    const ticket = generation;
    await run(async () => {
      await loadMetadata();
      const result = await api('/api/team/tasks');
      tasks = result.tasks; renderList();
      if (selected) {
        const id = selected;
        const [result, activity] = await Promise.all([api(`/api/team/tasks/${id}`), api(`/api/team/dispatch?task=${id}`)]);
        if (ticket !== generation || id !== selected) return;
        detail = result; runs = activity.runs;
        // Refresh messages without replacing drafts or silently updating edit revisions.
        if (panel.querySelector('.team-thread')) { renderHeader(); renderThread(); renderPeople(); renderRuns(); updateQuick(); }
        else showDetail();
      } else if (!panel.childElementCount) showEmpty();
    });
  }
  function showEmpty() { panel.replaceChildren(node('div', 'team-empty', 'พิมพ์คำสั่งด้านบน หรือเลือกงานเดิมเพื่อดูผู้รับและข้อความ')); }
  function taskFields(task = {}) {
    const controls = {};
    const fields = node('div', 'team-form');
    for (const [key, label, max, multi] of [['title', 'ชื่องาน', 160], ['goal', 'เป้าหมาย', 32000, true], ['scope', 'ขอบเขตงาน', 32000, true], ['acceptance', 'เกณฑ์รับงาน', 32000, true], ['contextDir', 'โฟลเดอร์บริบททีม', 4096], ['codeDir', 'โฟลเดอร์โค้ด / worktree', 4096], ['branch', 'Branch', 240], ['contractVersion', 'เวอร์ชันข้อกำหนด', 240]]) {
      const control = input(task[key] ?? (key === 'contextDir' ? metadata.contextDir : ''), multi); control.maxLength = max; control.required = ['title', 'goal'].includes(key); controls[key] = control; fields.append(field(label, control));
    }
    return { fields, value: () => Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value])) };
  }
  function showCreate() {
    if (!metadata) return;
    const form = node('form', 'card team-form');
    form.append(node('h2', '', 'สร้างงานใหม่'));
    const task = taskFields();
    const session = sessionInput();
    const teamId = input(); const cwd = input(metadata.contextDir);
    const submit = node('button', 'primary', 'บันทึกงาน'); submit.type = 'submit';
    form.append(task.fields, field('Session ที่รับบทราฟาเอล', session), pair(field('Team session ID (ถ้ามี)', teamId), field('โฟลเดอร์ของ session', cwd)), submit);
    form.onsubmit = (event) => { event.preventDefault(); run(async () => {
      const known = metadata.sessions.find((row) => row.session === session.value.trim());
      const result = await api('/api/team/tasks', { ...task.value(), coordinator: { session: session.value, cwd: cwd.value, teamSessionId: teamId.value, model: known?.model ?? '' } });
      toast('บันทึกงานแล้ว'); location.hash = `tasks/${result.task.id}`;
    }, submit); };
    panel.replaceChildren(form);
  }
  function label(id) { const person = detail.task.participants.find((p) => p.id === id); return person ? `${names[person.role]} (${person.provider})` : names[id] ?? id; }
  function renderHeader() {
    const header = panel.querySelector('.team-heading'); if (!header) return;
    const task = detail.task;
    header.replaceChildren(node('h2', '', task.title), node('span', 'team-state', statusNames[task.status]), node('div', 'team-id', `Task ${task.id}`), node('p', 'team-content', task.goal));
    if (task.coordination === 'external') header.append(node('span', 'team-state', coordinationNames[task.coordinationState] ?? 'ประสานงานในแชททีม'));
    const paths = node('dl', 'team-paths');
    for (const [name, value] of [['ราฟาเอล', label(task.coordinatorId)], ['บริบททีม', task.contextDir], ['โค้ด', task.codeDir], ['Branch', task.branch], ['ข้อกำหนด', task.contractVersion]]) { paths.append(node('dt', '', name), node('dd', '', value || 'ยังไม่ระบุ')); }
    header.append(paths, button('โหลดงานใหม่', () => open(task.id)), node('small', 'team-hint', 'โหลดงานใหม่เพื่อแก้ข้อมูลรุ่นล่าสุด ร่างที่ยังไม่บันทึกจะถูกแทนที่'));
  }
  function showDetail() {
    composer = null;
    const task = detail.task;
    const header = node('div', 'team-heading');
    const edit = node('details', 'card'); edit.append(node('summary', '', 'ขอบเขต เกณฑ์รับงาน และ checkpoint'));
    const form = node('form', 'team-form'); const values = taskFields(task);
    const status = select(metadata.statuses.map((id) => [id, statusNames[id] ?? id]), task.status);
    const checkpoint = input(task.checkpoint, true); checkpoint.maxLength = 64000;
    const save = node('button', '', 'บันทึกการเปลี่ยนแปลง'); save.type = 'submit';
    form.append(values.fields, field('สถานะ', status), field('Checkpoint / สิ่งที่ต้องทำต่อ', checkpoint), save);
    form.onsubmit = (event) => { event.preventDefault(); run(async () => {
      await api(`/api/team/tasks/${task.id}/update`, { ...values.value(), status: status.value, checkpoint: checkpoint.value, expectedRevision: task.revision });
      toast('บันทึกการเปลี่ยนแปลงแล้ว'); if (selected === task.id) await open(task.id);
    }, save); }; edit.append(form);
    const people = node('details', 'card'); people.append(node('summary', '', 'ผู้ร่วมงานและ session'), node('div', 'team-people'));
    const thread = node('div', 'team-thread'); thread.setAttribute('aria-label', 'ข้อความของงาน');
    const threadCard = node('section', 'card'); threadCard.append(node('h2', '', 'ข้อความ'), node('p', 'team-hint', 'คำสั่งจากช่องด้านบนเรียก CLI ส่วนกล่องด้านล่างใช้ฝากข้อความในงาน'), thread);
    const runCard = node('section', 'card team-runs');
    panel.replaceChildren(header, runCard, edit, people, threadCard, makeComposer());
    runSignature = ''; renderHeader(); renderPeople(); renderThread(); renderRuns(); updateQuick();
  }
  function renderPeople() {
    const box = panel.querySelector('.team-people'); if (!box) return;
    const task = detail.task;
    box.replaceChildren(...task.participants.map((person) => {
      const el = node('div', 'team-person'); el.append(node('strong', '', label(person.id)), node('div', 'team-id', person.session || 'รอ CLI ยืนยัน session ID'));
      if (person.teamSessionId) el.append(node('small', 'team-hint', `Team session: ${person.teamSessionId}`));
      if (person.cwd) el.append(node('div', 'team-id', person.cwd));
      if (person.writePaths.length) el.append(node('div', 'team-id', `เขียนได้: ${person.writePaths.join(', ')}`));
      return el;
    }));
    const join = node('form', 'team-form'); const session = sessionInput();
    const role = select(metadata.roles.filter((id) => id !== 'raphael').map((id) => [id, names[id]]), 'petros');
    const teamId = input(); const cwd = input(task.contextDir); const writePaths = input('', true);
    const submit = node('button', '', 'เพิ่มผู้ร่วมงาน'); submit.type = 'submit';
    join.append(field('Session ผู้รับงาน', session), pair(field('บทบาท', role), field('Team session ID (ถ้ามี)', teamId)), field('โฟลเดอร์ของ session', cwd), field('ไฟล์หรือโฟลเดอร์ที่เขียนได้ (หนึ่งรายการต่อบรรทัด)', writePaths), submit);
    join.onsubmit = (event) => { event.preventDefault(); run(async () => {
      const known = metadata.sessions.find((row) => row.session === session.value.trim());
      await api(`/api/team/tasks/${task.id}/participants`, { expectedRevision: detail.task.revision, participant: { session: session.value, role: role.value, teamSessionId: teamId.value, cwd: cwd.value, model: known?.model ?? '', writePaths: writePaths.value.split('\n').map((line) => line.trim()).filter(Boolean) } });
      join.reset(); toast('เพิ่มผู้ร่วมงานแล้ว'); await refresh();
    }, submit); };
    // Leave the join form intact on incoming messages so its draft is preserved.
    let joinSlot = panel.querySelector('.team-join');
    if (!joinSlot) { joinSlot = node('div', 'team-join'); joinSlot.append(join); box.after(joinSlot); }
    let linkSlot = panel.querySelector('.team-links');
    if (!linkSlot) { linkSlot = node('div', 'team-links team-form'); joinSlot.after(linkSlot); }
    const sessions = new Set(task.participants.map((person) => person.session));
    const related = metadata.links.filter((link) => [link.source, link.target].some((person) => person.session && sessions.has(person.session.toLowerCase())));
    const linkChoice = select(related.map((link) => [link.id, `${link.source.agent} → ${link.target.agent}: ${link.target.nativeId ?? 'รอ session ID'} (${link.status})`]));
    const bind = button('ผูกประวัติส่งต่องาน', (event) => run(async () => {
      await api(`/api/team/tasks/${task.id}/links`, { expectedRevision: detail.task.revision, linkId: linkChoice.value }); toast('ผูกประวัติแล้ว'); await refresh();
    }, event.currentTarget)); bind.disabled = !related.length;
    linkSlot.replaceChildren(field('ประวัติ handoff ที่เกี่ยวข้อง', linkChoice), bind, ...task.linkIds.map((id) => node('div', 'team-id', `Handoff ${id}`)));
    if (composer) syncActors();
  }
  function syncActors() {
    const options = [['user', names.user], ...detail.task.participants.map((person) => [person.id, label(person.id)])];
    for (const control of [composer.from, composer.to]) {
      const value = control.value;
      control.replaceChildren(...options.map(([id, name]) => { const el = node('option', '', name); el.value = id; return el; }));
      if (options.some(([id]) => id === value)) control.value = value;
    }
  }
  function makeComposer() {
    const taskId = detail.task.id;
    const form = node('form', 'card team-form'); form.append(node('h2', '', 'ส่งข้อความ'));
    const from = select([['user', names.user]]); const to = select([['user', names.user]]);
    const type = select(metadata.messageTypes.map((id) => [id, typeNames[id]]), 'assignment');
    const body = input('', true); body.required = true; body.maxLength = 64000;
    const reply = node('div', 'team-reply'); const submit = node('button', 'primary', 'บันทึกข้อความ'); submit.type = 'submit';
    composer = { from, to, type, body, reply, replyTo: null, pending: null };
    syncActors(); to.value = detail.task.coordinatorId;
    form.append(pair(field('ส่งในนาม', from), field('ถึง', to)), field('ประเภท', type), reply, field('ข้อความ', body), submit);
    const state = composer;
    form.onsubmit = (event) => { event.preventDefault(); run(async () => {
      const payload = { from: from.value, to: to.value, type: type.value, body: body.value, replyTo: state.replyTo };
      const fingerprint = JSON.stringify(payload);
      if (state.pending?.fingerprint !== fingerprint) state.pending = { fingerprint, key: crypto.randomUUID() };
      await api(`/api/team/tasks/${taskId}/messages`, { ...payload, idempotencyKey: state.pending.key });
      body.value = ''; state.replyTo = null; state.pending = null; reply.replaceChildren(); toast('บันทึกข้อความแล้ว'); await refresh();
    }, submit); };
    return form;
  }
  function renderThread() {
    const thread = panel.querySelector('.team-thread'); if (!thread) return;
    thread.replaceChildren(...detail.messages.map((message) => {
      const el = node('article', 'team-message'); el.dataset.type = message.type;
      const head = node('div', 'team-message-head'); head.append(node('strong', '', `${label(message.from)} → ${label(message.to)}`), node('small', '', typeNames[message.type]), node('small', '', new Date(message.createdAt).toLocaleString()));
      el.append(head, node('p', 'team-content', message.body));
      if (message.id === detail.task.lastSummaryId) el.prepend(node('h3', '', 'สรุปจากราฟาเอล — รอคำสั่งถัดไป'));
      if (message.replyTo) el.append(node('small', '', `ตอบข้อความ ${message.replyTo}`));
      el.append(node('small', '', message.readAt ? `ผู้รับยืนยันอ่าน ${new Date(message.readAt).toLocaleString()}` : 'รอผู้รับยืนยันอ่าน'));
      const actions = node('div', 'team-message-actions');
      actions.append(button('ตอบกลับ', () => {
        composer.from.value = message.to; composer.to.value = message.from; composer.type.value = message.type === 'question' ? 'answer' : 'note'; composer.replyTo = message.id;
        composer.reply.replaceChildren(node('span', '', `ตอบกลับ ${typeNames[message.type]} จาก ${label(message.from)}`), button('ยกเลิกการตอบกลับ', () => { composer.replyTo = null; composer.reply.replaceChildren(); composer.type.value = 'note'; }));
        composer.body.focus();
      }));
      if (!message.readAt) actions.append(button(`ยืนยันอ่านในนาม ${label(message.to)}`, (event) => run(async () => {
        await api(`/api/team/tasks/${message.taskId}/messages/${message.id}/read`, { recipientId: message.to }); await refresh();
      }, event.currentTarget)));
      el.append(actions); return el;
    }));
    if (!detail.messages.length) thread.append(node('p', 'team-hint', 'ยังไม่มีข้อความ เริ่มส่งงานหรือคำถามด้านล่าง'));
  }
  function renderRuns() {
    const box = panel.querySelector('.team-runs'); if (!box) return;
    const signature = JSON.stringify(runs.map((job) => [job.id, job.status, job.updatedAt])); if (signature === runSignature) return; runSignature = signature;
    box.replaceChildren(node('h2', '', 'การส่งงานและผลตอบกลับ'));
    if (!runs.length) box.append(node('p', 'team-hint', 'ส่งคำสั่งจากช่องด้านบนเพื่อเริ่มเรียก agent'));
    const states = { queued: 'รอเรียก CLI', running: 'กำลังทำงาน', succeeded: 'CLI ส่งผลกลับแล้ว', failed: 'เรียกไม่สำเร็จ / ติดข้อจำกัด', interrupted: 'การเรียกถูกขัดจังหวะ', cancelled: 'หยุดแล้ว' };
    for (const job of [...runs].reverse()) {
      const row = node('article', 'team-run');
      row.append(node('strong', '', `${names[job.role]} (${job.provider} · ${job.model || 'ค่าเริ่มต้น CLI'} · effort ${job.effort || 'ค่าเริ่มต้น CLI'})`), node('span', 'team-state', states[job.status] ?? job.status));
      const details = node('details'); details.append(node('summary', '', 'คำสั่งและ session'), node('p', 'team-content', job.prompt), node('p', 'team-id', job.nativeId ? `${job.provider}:${job.nativeId}` : 'ยังไม่มี session ID ที่ยืนยันแล้ว')); row.append(details);
      if (job.response) row.append(node('h3', '', job.role === 'raphael' ? 'สรุปจากราฟาเอล — รอคำสั่งถัดไป' : 'ผลจากผู้รับงาน'), node('p', 'team-content', job.response));
      if (job.error) row.append(node('p', 'team-error', job.error));
      const actions = node('div', 'team-message-actions');
      if (['queued', 'running'].includes(job.status)) actions.append(button('หยุดการเรียกนี้', (event) => run(async () => { await api(`/api/team/dispatch/${job.id}/cancel`, {}); await refresh(); }, event.currentTarget)));
      if (job.status === 'interrupted') actions.append(button('ปลด run ที่ค้าง', (event) => run(async () => { await api(`/api/team/dispatch/${job.id}/release`, {}); await refresh(); }, event.currentTarget)));
      if (job.response) actions.append(button('นำผลไปส่งต่อ', () => { quick.prompt.value = `ใช้ผลด้านล่างทำงานต่อ โดยยึดคำสั่งปัจจุบันและกติกาทีม\n\nผลจาก ${job.provider} (บริบท):\n${job.response.slice(0, 5000)}${job.response.length > 5000 ? `\n\nผลเต็มอยู่ที่ ${job.artifactDir}\\response.txt` : ''}`; quick.prompt.focus(); quickSlot.scrollIntoView({ block: 'start' }); }));
      row.append(actions); box.append(row);
    }
  }
  async function open(id) {
    const ticket = ++generation; selected = id; detail = null; composer = null; renderList(); panel.replaceChildren(node('p', 'team-hint', 'กำลังอ่านงาน…'));
    await run(async () => { const [result, activity] = await Promise.all([api(`/api/team/tasks/${id}`), api(`/api/team/dispatch?task=${id}`)]); if (ticket !== generation) return; detail = result; runs = activity.runs; showDetail(); });
  }
  return {
    async activate(id) {
      if (!metadata) { await run(loadMetadata); if (!metadata) return; }
      tasks = (await run(() => api('/api/team/tasks')))?.tasks ?? tasks; renderList();
      if (id === 'new') { if (!panel.querySelector('form') || selected) { selected = null; generation++; detail = null; composer = null; showCreate(); } updateQuick(); }
      else if (id && id !== selected) await open(id);
      else if (!selected && !panel.childElementCount) showEmpty();
      else if (selected) await refresh();
    },
    refresh,
    changed() { if (host.hidden) return; clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 120); },
  };
}
