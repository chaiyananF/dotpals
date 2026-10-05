# Dotpals — app command and delegation increment

- Approval: user on 2026-10-05 requested commands through the app and agent delegation,
  deferring autonomous inter-agent question/answer trials.
- Continuation of the approved `feature/task-mailbox` branch and existing prototype.
- Writer: Petros / Codex in the current code checkout; no live worker dispatched.
- Contract: [app-dispatch.md](../app-dispatch.md).
- Team context is referenced read-only. Native IDs and run evidence remain in the
  ignored profile; no central journal or STATUS edit is claimed.
- Resource: prototype profile `.dotpals-center/`, port 5176.

## Scope / acceptance

Primary command form creates task/recipient automatically, launches a provider CLI
through the bridge, records its actual session and response, and allows continuation
or forwarding from the app. Raphael can delegate one scoped worker using task-bound
MCP tools or the CLI. Workers return results to Raphael and cannot redelegate.
No autonomous question/answer loop, quota failover or central team configuration
installation is included. Native auth/approval remains with the provider.

Changed modules: `team-store`, `team-api`, `team-dispatch`, server, Tasks UI, CLI,
task-bound stdio MCP adapter, prototype launcher/dashboard initial route and docs.
Local AGY model cache reflects the authenticated CLI listing on this date.
Follow-up user correction: the first recipient is Raphael on Opus 5.5 / Sol 6.1.
The broker pins coordinator models; workers can use task-selected models/effort.
The coordinator brief requires waiting for worker results, reviewing evidence,
summarizing for the user and stopping for the next instruction. MCP run polling has
an optional bounded wait. This follow-up has syntax/diff review only, with no live
provider availability or delegation check.

## Checkpoint

- [x] Inspect installed CLI command flags and account-visible AGY model IDs.
- [x] Add durable dispatch queue, pending/confirmed recipients and result messages.
- [x] Add task-bound MCP / common CLI delegation access.
- [x] Add command form, native resume choices, run cards and result-forward draft.
- [x] Keep old manual registry/mailbox available.
- [x] Creator syntax/diff checks; restart prototype on port 5176 at the Tasks route.
- [ ] Live CLI submission, native resume and delegated-worker acceptance.
- [ ] Independent QA / human UI acceptance.
- [ ] Commit complete prototype baseline and integrate upstream under a separate review.

Current implementation has creator syntax/diff review only. Tests are not added or
run without a request to test/verify, and no live model job is sent in this increment.
Runtime acceptance remains explicit. Local per-session checkpoint contains content
hashes and dirty paths. Rollback: remove this increment's dispatch/MCP modules and
integration hunks; retain profile task/message/run data and previous prototype work.
