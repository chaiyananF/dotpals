# Session center continuity

## Default: coordinate in the existing app chat

The latest user-approved structure uses this Codex/Claude app chat as Raphael.
Read `docs/chat-coordinator.md` and use `bin/team-center.js context` before team
coordination. Register a new authorized scope with `coordinate`; use `delegate`
for workers and `summary` after reviewing results. Codex uses the real
`CODEX_THREAD_ID`; other apps supply their confirmed native session explicitly.
Dotpals stores the exact binding and mailbox, and launches workers only. It never
starts another coordinator CLI. Do not retry the old failed coordinator run.
Do not infer that a model available in this app is supported by the standalone CLI.
Keep instructions/results in the shared task and report back in this app chat.
After the summary, wait for the user’s next instruction. This setup does not wake
an idle chat or deliver automatic notifications; read results in an active turn.

When continuing cross-agent work in this prototype, read `docs/session-center.md`
and the active profile's `session-links.json` first. The prototype profile is
`.dotpals-center/`; `DOTPALS_HOME` overrides the profile when explicitly configured.

- Use the recorded source and destination native IDs, agent, model and working
  folder. Do not infer a destination from its title or use "latest" to resume.
- Claude activity uses a bare UUID; the registry uses `claude:<uuid>`. Use the
  session identity helpers when matching them rather than comparing strings.
- `pending` means the destination ID has not been confirmed. A terminal opening
  does not establish a new agent conversation ID.
- For Antigravity, `bin/antigravity-session.js --link <id> --prompt <task>` resumes
  a saved destination and records the returned ID. It needs the center running.
  Use `--source` only when a new destination conversation is intended.
- The registry survives activity expiration. Do not remove or replace it when
  clearing activity history.
- Reading a link is not authorization to dispatch work or send conversation data.

## Claude dispatch preferences

Read the active profile's `claude-dispatch.json` before dispatching Claude work.
The user specifies a team context directory. The legacy Claude worker wrapper
defaults to Sonnet 5.5. Raphael uses the principal model of the existing app chat
(the user prefers Opus 5.5 / Sol 6.1). The app and CLI have separate model access;
there is no automatic coordinator CLI launch or forced CLI principal model ID.
Workers use an explicitly chosen provider/model/effort suited to the analyzed task.
Choose effort for the actual task: low for small requests, medium for ordinary
scoped work, high/xhigh for difficult debugging or design, max for the hardest
reasoning, ultracode for tasks benefiting from dynamic workflow orchestration.
The user authorizes choosing among these levels without asking again.
`ultracode` is a supported CLI option, separate from an ordinary reasoning level.
Use `bin/claude-session.js --link <id> --prompt <task> --effort <level>` for a saved
Claude conversation; use `--source` only when a new conversation is intended.
This wrapper uses the configured folder/model, loads team instructions through
normal Claude startup, and records the returned native session ID. It does not
enable permission bypass. The team context folder and the code checkout can differ.

Native session IDs and local profile data are machine-local; keep personal links
in the ignored profile rather than adding more personal IDs to tracked docs.

## App dispatch and team tasks

Read `docs/chat-coordinator.md` for the current workflow; `docs/app-dispatch.md`
records the earlier CLI-coordinator design. Every worker run
has a task, provider, role, participant and (when confirmed) native session ID.
The mailbox composer saves messages; advanced dispatch launches only a worker CLI.
Raphael can delegate with task-bound MCP tools or `bin/team-center.js dispatch`;
workers cannot redelegate. Read-only runs cannot authorize code-editing children.
Raphael waits for delegated results, reviews the evidence and summarizes the outcome
for the user, then stops for the next instruction. Suggested next steps do not grant
permission to start another phase. Do not silently downgrade a coordinator model.
Use a stable idempotency key when retrying the same instruction. A queued or
successfully returned CLI result is not proof of independent QA or completed work.
Keep the center running, do not silently retry interrupted native runs, and do not
replace pending identities with guessed IDs. Common briefs reference canonical
team instructions without writing central journals or duplicating their rules.
