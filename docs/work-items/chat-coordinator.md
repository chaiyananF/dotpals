# Existing app chat as coordinator

User approval: 2026-10-05, restructure according to the accepted app-chat workflow.
Continuation of approved `feature/task-mailbox`; preserve existing prototype work.
Code writer: current Codex session, Petros duty; Raphael coordination in the same
app chat. No live helper assignment is needed to implement this change.

Contract: [chat-coordinator.md](../chat-coordinator.md).
Dependencies: durable task store/API, dispatch broker, common CLI and Tasks UI.
Resource: profile `.dotpals-center/`, port 5176. Team root remains read-only.
Session-owned evidence is in the ignored profile; no central notes/STATUS write or
independent QA is claimed. No complete prototype commit is made in this increment.

## Plan and delivery

- [x] Add exact external session binding and current task/context lookup.
- [x] Add scoped worker delegation from the bound app chat, without a parent CLI.
- [x] Add summary publication and awaiting-user coordination status.
- [x] Prevent launching the external coordinator as a CLI or worker.
- [x] Make Tasks a tracking view with advanced direct worker controls collapsed.
- [x] Document coordinator operations in local AGENTS and the runbook.
- [x] Creator syntax/diff review and reload idle prototype.
- [x] Register this chat and its implementation task in the running center.
- [x] Publish this increment's evidence summary into the bound task; awaiting-user.
- [ ] Live helper dispatch/resume and human acceptance C1–C6.
- [ ] Independent QA / release / complete baseline commit.

Rollback: revert only the current integration hunks/new runbook. Keep saved external
bindings, tasks, messages and previous native run history. Runtime proof of provider
availability and completed delegation remains pending; tests are not added/run
without a request to test/verify implementation.
