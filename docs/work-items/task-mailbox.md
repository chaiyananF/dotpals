# Dotpals — task registry and mailbox v1

- Approval: user requested registry/mailbox implementation and selected
  `feature/task-mailbox` on 2026-10-05.
- Code checkout: `dotpals` within the current Desktop secretary-setup workspace.
- Branch: `feature/task-mailbox`, based on local HEAD
  `1b5c67e57f0789c5a533150acd91d3ae63026844` with the existing prototype changes.
- Remote fetched successfully. `origin/main` advanced to `cecacbe`; this increment
  preserves the user-approved prototype baseline rather than integrating upstream.
- Provider/session: Codex; exact native identity is kept in the ignored local
  `.dotpals-center/work-items/task-mailbox/` checkpoint, not tracked documentation.
- Role/writer: Petros in this session. No other workers dispatched.
- Team context: read-only central team rules; no central journal/STATUS/AGENTS edited.
- This is a code-checkout work item, not a claim of a separate registered team
  context session. Central session note publication is pending a session-owned
  context checkout. Checkpoints remain here for handoff.
- Contract: [task-mailbox.md](../task-mailbox.md), registry/mailbox only. No scheduler,
  MCP installation, agent dispatch, coordinator failover, or cross-machine sync.
- Resource: prototype profile `.dotpals-center/`, loopback port 5176. Original
  installation/profile and port 5175 are outside this increment.

## Write scope

New `bridge/team-store.js`, `bridge/team-api.js`, `bridge/ui/tasks.js`,
`bridge/ui/tasks.css`, `bin/team-center.js` and associated documentation.
Minimal integration in `bridge/server.js` and `bridge/dashboard.html`.
Existing dirty files and native session links are retained.

## Plan / checkpoint

- [x] Read team implementation rules and prototype interfaces.
- [x] Fetch remote and create the approved branch without resetting pending work.
- [x] Add durable task/message store and validated local API.
- [x] Add Tasks dashboard and provider-neutral CLI.
- [x] Document message delivery semantics, schemas and human acceptance actions.
- [ ] Runtime tests, independent QA and human UI acceptance.
- [ ] Integrate the upstream version and commit the complete prototype baseline.

No tests are added or run in this increment because the current request is
implementation only. Creator syntax/diff review, when performed, will be recorded
below and does not certify runtime behavior or independent QA.

## Creator review — 2026-10-05

- `node --check` passed for store, API, task UI, CLI and integrated bridge server.
- Dashboard inline module parsed through `node --input-type=module --check`.
- `git diff --check` passed. No automated tests or model calls performed.
- Prototype desktop restarted from this checkout. Process/port ownership is
  operational evidence only; UI/API behavior remains pending runtime review.
- No commit/push: the prototype depends on pre-existing uncommitted modules, so
  committing this increment alone would omit required baseline code. All files
  remain in the approved branch for review and a later complete integration.

Rollback: remove this increment's new modules and revert only its server/dashboard
integration hunks. Retain local `team-center.json` if any tasks were created.
Do not revert or discard the pre-existing session-center prototype work.
