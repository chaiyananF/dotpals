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

The same field is accepted by CLI `delegate`, the HTTP dispatch endpoint and the
coordinator's MCP `dispatch` tool, with identical validation. Worker MCP sessions
do not have a `dispatch` tool.

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

## Watching worker activity

`run`, `runs`, their HTTP endpoints and task-bound MCP tools include `progress`:
`lastActivityAt`, `lastActivityKind`, `lastActivitySource`, `stdoutBytes`,
`stderrBytes`, `elapsedMs`, `remainingMs`, `quietForMs`, `deadlineAt`, `timeoutMs`,
`available` (true when saved, null for legacy runs, false after a progress write failure).
Times use milliseconds; timestamps are ISO strings. Activity timestamps record
when this broker received data, not the provider's clock. Only fixed activity
categories are published; prompts, tool arguments, reasoning and diagnostic text
are never copied into progress. Claude's private `stdout.log` now retains only
the bounded final result record at exit, discarding verbose intermediate tool/text
records. There is no intermediate Claude stdout artifact; saved progress metadata
and stderr remain available for diagnosing an interrupted run.
Other providers' stdout artifacts, stderr artifacts and final response remain.

Metadata is persisted at most once a second during a run and flushed at exit.
A separate `team-progress` SSE event updates existing labels without API refetches
or replacing run details/drafts. If saving progress fails, the worker continues;
API/SSE reports `available: false` for the lifetime of that broker. This warning
cannot be guaranteed across restart when the failed storage cannot record it.
Execution clocks start at launch; queued runs have no deadline. Terminal
elapsed time freezes at `finishedAt`, with no remaining countdown. Legacy runs
without activity metadata expose nulls. The existing 30-minute timeout still
applies; progress does not extend it or prove process liveness.

The Tasks run row shows elapsed time, time left and age of the last observed
activity, with a local one-second clock while visible. Claude now uses the locally
verified `--output-format stream-json --verbose` mode so complete message/tool
events can arrive before its final result. Codex JSONL is followed incrementally.
Buffered providers may produce no intermediate events; quiet output is shown as
no new observed activity, never asserted to be a hung worker or percent complete.
Native IDs are still confirmed only at completion: a valid result ID is preferred;
otherwise a genuine `system/init` ID is retained for resuming failed work. Init
alone never implies success. Missing-result failures retain exit code, stderr and
timeout diagnostics, separately identifying skipped malformed/oversized records.
Claude retains one line up to
8 MiB and only its final result, so total intermediate traffic may exceed 8 MiB.
Oversized/malformed records are discarded; no valid bounded final result means
failure. Other providers' output limits, permission modes, concurrency guards and
cancellation controls remain in effect.

## Diagnosing a refused native resume

The session catalog (`GET /api/team/sessions`) includes `state`, `stateAt`
(epoch milliseconds), `stateSource` and `stateEvent`. `stateAt` is the event time
used for the current in-memory state; the activity row's `at` is separate.
Missing state provenance is reported as `unknown`/`null`, never inferred from the
latest activity. Codex transcript updates identify their record type; bridge hook
and generic-event updates identify their input channel. HTTP event names use the
hook name or `type`/`event`, accept strings only, normalize whitespace/control
characters and are limited to 80 characters. These are recorded
observations, not a process-liveness probe or a persistent state-transition log.

A native-busy dispatch refusal remains HTTP 409 and includes those diagnostics
in `error`, so CLI/MCP callers retain them. An owned-run refusal includes its run
ID and status. Keep that response and the catalog snapshot when investigating a
suspected stale state, then compare the native transcript and saved run. Do not
clear a busy state merely because no broker run owns it: the native app may be
working independently. Idempotent retries still return the already saved request.

`test/session-lifecycle.test.js` replays a sanitized observed completion tail
through the Codex watcher, catalog and dispatch preparation. Its synthetic ID,
text and turn keys contain no private conversation data; the final record order
and relative timing are retained. It covers incremental/split JSONL, watcher
restart, a subsequent busy turn, failed completion and broker ownership guards.
The bridge-level test also checks transcript provenance through the real state
store and HTTP catalog. Tests use a non-executable CLI stub for busy HTTP requests.
They do not establish the cause of a past refusal or launch a real provider CLI.

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
