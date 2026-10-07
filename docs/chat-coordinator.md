# Coordinate from the existing team chat

Default workflow: the human instructs Raphael in the existing Codex or Claude app
chat. Dotpals is the durable task registry, worker broker and mailbox. It launches
workers only; it never starts or resumes the external coordinator as another CLI.
The principal model is supplied by the app chat. An app model name does not prove
that the same identifier works in a separately authenticated CLI.

## The coordinator's routine

1. Read this file and the canonical team rules/role. Keep the team context read-only.
2. Run `context` using the real current session identity. A Codex chat uses its
   `CODEX_THREAD_ID`; Claude must supply its confirmed `--session claude:UUID`.
   Never infer an identity from a title, another agent's environment or “latest”.
3. Reuse the bound task when the user is continuing it. For a new authorized scope,
   use `coordinate` to register a new task and bind this existing chat. To record a
   follow-up on an external task, pass its exact `--task` and a new instruction/key.
4. Analyze the work. Do small work in this chat. Delegate only when authorized and
   useful, explicitly choosing provider, model, effort and bounded scope. Normally
   delegate one worker at a time. For code
   writers, provide an isolated checkout and stay inside approved write paths.
5. Read `run --wait 30` repeatedly while active, or inspect `context` on resumption.
   Worker results are addressed to the external coordinator's participant in the
   task mailbox. Read the evidence and acknowledge messages only after reading.
6. Publish `summary` in Dotpals, then give the same outcome in this app chat. Include
   evidence, limitations and the proposed next action. Stop for the human's next
   instruction. A suggested next phase is not permission to launch it.

The bridge continues launched workers while the app remains open. It does not wake
an idle coordinator chat or automatically post a message into Codex/Claude. Reading
results and reporting require an active chat turn; unattended monitoring is separate.
Saving an assignment in the web mailbox also does not wake the chat automatically.

## Commands

Run the provider-neutral CLI from the installed code checkout, using its absolute
path if the shell is in the team context folder. Default loopback port is 5176.
No global MCP/skill configuration or provider authentication changes are required.

```powershell
node bin/team-center.js context
node bin/team-center.js coordinate --file task.json
node bin/team-center.js delegate --file worker.json
node bin/team-center.js run --run <returned-run-id> --wait 30
node bin/team-center.js summary --file summary.json
```

Codex obtains the exact current session from its environment. Other providers add
`--session provider:UUID`. `delegate` and `summary` use this chat's active binding
unless `--task` selects another task owned by this same external coordinator.
Workers cannot use these coordinator commands. The service uses declared local
identities, not authenticated agent accounts; this is not a hostile-agent boundary.

Task payload:

```json
{
  "title": "Scoped human request",
  "goal": "The requested outcome",
  "prompt": "The current human instruction",
  "scope": "Approved scope only",
  "acceptance": "Evidence to return",
  "codeDir": "<absolute-code-checkout>",
  "branch": "<approved-branch>",
  "contractVersion": "chat-coordinator-v1",
  "writePaths": [],
  "idempotencyKey": "<stable-key-for-this-instruction>"
}
```

`writePaths` is empty for read-only tasks. Supply only human-approved code roots
when registering a code task; binding a chat itself grants no new write authority.
The canonical context directory comes from the bridge's configured team root.
An existing task's coordinator cannot be replaced by attach. Old failed CLI tasks
and their session history remain unchanged; register the new external task explicitly.

Worker payload:

```json
{
  "agent": "antigravity",
  "role": "petros",
  "model": "gemini-3.8-flash-medium",
  "effort": "medium",
  "prompt": "Read the requested flow and return evidence. Do not edit.",
  "allowCodeWrites": false,
  "idempotencyKey": "<stable-key-for-this-worker-instruction>"
}
```

`delegate` supplies the source participant from the binding; there is no parent
CLI run because Raphael is already in the app. For a worker follow-up specify its
confirmed `participantId`; the broker resumes only that native ID. Use `options`
for provider settings. Claude workers default to the existing Sonnet policy, AGY
needs an account-visible model, and Codex workers can use their CLI configuration.
Do not copy an app-only model ID to a CLI or silently switch models after rejection.
Gemini model variants ending in `low`, `medium` or `high` must agree with an explicit
effort, or leave effort blank. AGY's soft-denied tools and empty final responses
are incomplete runs even if the native CLI reports SUCCESS/exit zero.

For an explicitly authorized Claude code assignment, `allowedCommands` may provide
up to eight exact Bash commands for that invocation only, with a maximum of 2000
characters per command. The characters `*`, `?`, `(`, `)` and CR, LF or NUL are
rejected. Use this only for commands already covered by the human task (for
example, a guarded scaffolding script), within the approved write scope. No global
provider permissions are changed and there is no all-tools approval bypass. It is
not a substitute for user authorization.

Summary payload:

```json
{
  "body": "Outcome, evidence, limitations and next proposed action.",
  "type": "result",
  "idempotencyKey": "<stable-summary-key>"
}
```

`result` is rejected while worker runs are queued/running/interrupted. An explicit
`blocker` may report incomplete work. Summary saves the task checkpoint and moves
coordination to `awaiting-user`; it does not mark independent QA or SDLC completion.

## Delivery and human acceptance

| ID | Action | Expected |
| --- | --- | --- |
| C1 | Open Tasks | Chat coordination notice; direct worker form is collapsed |
| C2 | Register this existing chat | External Raphael appears without a coordinator CLI |
| C3 | Delegate one authorized read-only worker | Task records worker session, assignment and run |
| C4 | Worker returns | Mailbox addresses result to Raphael; status is ready to summarize |
| C5 | Publish summary | Summary/checkpoint visible; waits for the next human instruction |
| C6 | Continue in the same app chat | Exact binding restores task and previous worker sessions |

These are pending runtime/human acceptance steps, not completed tests.
