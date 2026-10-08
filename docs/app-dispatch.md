# Earlier CLI coordinator design (historical)

The latest approved default is [coordination from the existing app chat](chat-coordinator.md).
Dotpals now launches workers only. The coordinator CLI launch and primary form
described below have been superseded. The old failed runs remain in the registry;
they are not retried. This document records the previous implementation and its
runtime limits; use the current runbook for operation.

The prototype opens **Tasks**. The primary form is now **สั่งราฟาเอล**:

1. Write the current instruction.
2. Choose Claude Opus 5.5 or Codex Sol 6.1 as Raphael.
3. Choose a new session, or a recorded session to continue.
4. Click **ส่งให้ agent**. Keep Dotpals open while it works.

There is no need to enter UUIDs or manually register a task first. A new task gets
one Raphael coordinator. When a task is selected, the form sends another instruction
to its coordinator or another participant; choosing a different agent can create a
worker in the same task. **เริ่มงานใหม่** clears the selected task. **ลงทะเบียนงานเอง**
keeps the earlier manual registration form for advanced use.

The advanced section selects code checkout, approved branch, model, effort and
whether the current instruction permits code edits. The default is read-only
analysis. All CLI processes launch from the configured team context folder and
receive the canonical team rules and role file in a saved brief. Codex uses the
selected code checkout as its sandbox working root while reading the team context
explicitly. Central team rules/journals remain read-only; run artifacts are local.

Raphael is pinned by the broker to `claude-opus-5-5` or `gpt-6.1-sol`, including
continuation of an older coordinator session. These are the user's requested model
IDs; live provider availability has not been verified by a model call. If unavailable,
the run reports failure rather than silently downgrading. Coordinator effort defaults
to high and remains selectable. Claude workers default to the configured Sonnet 5.5
policy; a delegated instruction may choose its model and effort explicitly.
AGY is available as a worker. Its model choices
come from the ignored local `dispatch-models.json` cache (or saved run/link models).
The cache was populated from authenticated `agy models`, not from guessed model
availability. Refresh that cache when the account's model availability changes.
Codex workers use their CLI setting unless the delegation selects a model.

Raphael analyzes the instruction, chooses whether to work or delegate, waits for the
worker's terminal result, reviews the evidence and returns a summary to the user.
The MCP `run` tool can wait up to 30 seconds per call. The final summary includes
outcome, evidence, limitations and a suggested next step. Raphael then waits for the
user's next instruction; a suggestion never automatically launches the next phase.

## What is launched

The bridge owns a queue with at most two provider CLI processes at a time, intended
for one coordinator and one worker. API submission returns a queued run, not a
completed assignment. Programs are invoked with argument arrays and files/stdin;
conversation text is never inserted into shell commands. No permission-bypass flags
are used. Native approval, account and model limits still apply; a blocked print
request is shown as a result/error for the user to resolve.

CLI adapters use local, installed commands:

- Claude: `--print --output-format json`, optional exact `--resume`.
- AGY: `--print --output-format json`, optional exact `--conversation`.
- Codex: `exec --json`, optional exact `exec resume`.

The returned native ID confirms the participant. Until a real ID is observed, the
participant stays pending. A resume returning another ID is rejected; there is no
fallback to “latest” or a silent new chat. Observed busy native sessions and sessions
already owned by a queued/running/interrupted dispatch cannot be resumed again.
This checks recorded state, not every possible idle native window/process lock.

The run card shows queued/running/succeeded/failed/cancelled/interrupted states.
“CLI ส่งผลกลับแล้ว” means the provider returned successfully, not that independent
QA or acceptance passed. Responses are also saved in the task mailbox. Full final
text and bounded native output are under `<profile>/dispatch/<run-id>/`:
`brief.md`, `response.txt`, `stdout.log`, `stderr.log`, and per-run MCP configuration.
The UI/mailbox keep up to 64,000 response characters; the response file preserves
the full final text within the CLI output bound.

**นำผลไปส่งต่อ** puts the previous result into the command draft. Choose the next
recipient and provide the next instruction before sending. Long results use a
bounded excerpt plus the full response-file path. This action does not send until
the user clicks **ส่งให้ agent**.

## Agent delegation

Claude and Codex receive a task-bound stdio MCP adapter, configured for this
invocation only. It exposes `task`, `runs`, `run`, `options`, and (Raphael only)
`dispatch`. Tool approval is limited to this local adapter. Its dispatch identity
is bound to the coordinator's task/participant/run, and workers do not get dispatch.
The coordinator can delegate and inspect a worker's result without relying on
sandboxed shell access to the bridge. Global MCP settings are not edited.

References: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [initialization](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).

AGY uses the provider-neutral CLI, with explicit task and participant identities.
All agents can use the same CLI when their own shell permissions allow it:

```powershell
node <absolute-path-to-team-center.js> options
node <absolute-path-to-team-center.js> dispatch --task <task-id> --file dispatch.json
node <absolute-path-to-team-center.js> run --run <run-id> --wait 30
```

Example coordinator spec:

```json
{
  "agent": "antigravity",
  "role": "petros",
  "prompt": "Read the code and report the handoff flow with file references. Do not edit.",
  "model": "gemini-3.8-flash-medium",
  "allowCodeWrites": false,
  "from": "<coordinator-participant-id>",
  "parentRunId": "<coordinator-run-id>",
  "idempotencyKey": "<stable-key-for-this-delegation>"
}
```

The bridge supplies `DOTPALS_TASK_ID`, `DOTPALS_PARTICIPANT_ID`,
`DOTPALS_DISPATCH_ID`, `DOTPALS_RUN_DIR` and `DOTPALS_PORT` to each CLI; the CLI
adapter can use them as defaults. When an agent's shell filters inherited variables,
use the literal IDs/port from its brief in the spec/options.

`runs` lists dispatches for a task. `run --wait 30` waits at most 30 seconds before
returning the current state. A coordinator inspects the worker's evidence, then
continues or reports to the user. Workers cannot delegate. A read-only parent run
cannot grant a child code-write permission; delegated write paths cannot expand
past the coordinator's approved paths. The local HTTP service still uses declared
identities rather than authenticated agent accounts; this is not a hostile-agent
security boundary or a multi-machine service.

## Recovery and limits

Run state and session IDs are durable in `team-center.json`. The queue is owned by
one bridge for the profile. Previous queued/running jobs whose owner process stopped
become interrupted when a new bridge starts. They are not auto-retried. Inspect the
old CLI and checkout before resuming; native tools/child processes may still have
work in progress. The stop button signals only a CLI owned by this bridge.
Once the old CLI has stopped, release the run with the run card's release button or
`node bin/team-center.js release --run RUN_UUID`. Release refuses while the saved CLI
PID is still alive; otherwise it marks the run cancelled, sends a blocker to the
coordinator, and frees the native session and task for the next instruction.

Provider output is bounded (8 million stdout characters / limited diagnostics),
each run times out at 30 minutes, and at most 20 live queue entries are accepted.
No autonomous question/answer loop, quota failover, coordinator transfer or release
approval is included in this increment. Questions can be returned in a final result
and answered by a human command in the app using the confirmed session.

## Human acceptance

| ID | Action | Expected |
| --- | --- | --- |
| A1 | Open the prototype | Tasks opens with the command form |
| A2 | Choose Claude, send a small read-only task | Task and queued/running card appear without manual IDs |
| A3 | Wait for a successful result | Response and confirmed session appear; read/QA status remains distinct |
| A4 | Send a follow-up to that participant | The returned native ID stays the same |
| A5 | Use “นำผลไปส่งต่อ”, select AGY and send | Result context goes to a worker in the same task |
| A6 | Ask Raphael to delegate one read-only job | Broker records worker, source/parent run, response and mailbox result |

These are review steps, not a claim of live agent or browser tests having run.
