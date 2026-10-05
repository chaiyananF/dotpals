# Session center prototype

For team work, the current default is [the existing app chat as coordinator](chat-coordinator.md):
give instructions in that chat and use Dotpals to store tasks, launch workers and
receive their results. The handoff menus below are advanced session tools.

Run `./start-center.ps1` in PowerShell. The desktop prototype opens its dashboard at
http://127.0.0.1:5176/dashboard and stores its local profile in `.dotpals-center/`.

In a session's **Continue in** menu:

- **Resume this Claude/Codex session** opens a terminal with the original native
  session ID. It submits no new prompt. The agent reloads its saved conversation.
- **Copy original conversation** reads the native conversation file and copies its
  user and assistant text, rather than the shortened activity summaries.
- **Destination session** lets you select another recorded Claude or Codex session
  in the same project. **Send to selected session** resumes that destination with a
  hand-off note, the optional next task, and a reference to the source conversation.
- **Include original conversation** exports the source chat to a local Markdown
  file when you send work. Turn it off to send only the activity recap.
- **New Claude/Codex session** is available when a new conversation is appropriate.

Claude resumes with `claude --resume <native-id>`. Codex resumes with
`codex resume <native-id>`. These are interactive terminals, with the agent's usual
authentication and permissions. Crossing between agents shares conversation text;
each destination retains its own native conversation and ID.

## Saved hand-off sessions

The center keeps `session-links.json` in its local profile, separately from the
activity feed. It records source and destination agent/session IDs, project folders,
the model (when known), assignment, last outcome and timestamps. Activity expiration
and clearing the activity feed do not delete this registry. Keep the profile folder
to preserve it across restarts.

**Continue in → Saved hand-off sessions** shows links involving that session and
lets you copy a native resume command. Full IDs are displayed to avoid confusing
conversations. `GET /api/handoff/links?session=<agent:uuid>` returns the same records.

Normal menu hand-offs record a destination ID immediately when resuming an existing
session. A newly launched terminal remains **pending** until its real native ID is
registered; opening a terminal is not proof that the agent created a conversation.

For Antigravity, use the wrapper so the returned `conversation_id` is saved:

```powershell
node bin/antigravity-session.js --source codex:<source-uuid> --model <model-from-agy-models> --prompt "Next task"
node bin/antigravity-session.js --link <saved-link-uuid> --prompt "Continue this task"
```

It connects to the prototype at port 5176 by default (`--port` overrides it), exports
source context for a new destination, runs `agy`, then records its returned native
ID. The second form uses `--conversation` with the saved destination ID and model;
it never silently starts a new conversation. Keep the center running. Agent permissions
remain controlled by Antigravity; the wrapper does not auto-approve tools.

The first live Gemini hand-off and its successful same-conversation resume are
recorded in the prototype profile's `session-links.json`. Consult that file for
the actual source/destination IDs, model, folders, and saved link ID to resume.

## Claude dispatch preferences

Machine-local defaults are in the active profile's `claude-dispatch.json`.
`workingDirectory` selects the user-approved team context folder; `model` pins
Claude to `claude-sonnet-5-5`; `defaultEffort` is `medium` unless the dispatcher
chooses another level for the current assignment. The menu offers low, medium,
high, xhigh, max and ultracode. Existing session records retain their historical
folders; new dispatch records include the chosen execution folder, model and effort.

```powershell
node bin/claude-session.js --source codex:<source-uuid> --prompt "Current task" --effort high
node bin/claude-session.js --link <saved-claude-link-uuid> --prompt "Next task" --effort medium
```

The wrapper resumes the saved native ID, uses normal Claude startup so team
CLAUDE.md/settings are available, asks Claude to read the team rules, and saves
the resulting ID. It does not use the safe-mode flags from the read-only connection
test or bypass permissions. The source checkout can be different from the team
context folder; the assignment must specify the intended code checkout when needed.

Ultracode is a workflow setting. `--effort ultracode` enables it and selects xhigh
reasoning, subject to model/organization limits. Reference:
https://code.claude.com/docs/en/model-config#adjust-effort-level

## Current limits

The **Tasks** dashboard and `bin/team-center.js` provide a durable task registry
and provider-neutral mailbox. See [task-mailbox.md](task-mailbox.md) for schemas,
CLI examples and acceptance steps. The primary command form now launches agents
and captures results: [app-dispatch.md](app-dispatch.md). Saving a message in the
separate mailbox composer alone does not launch an agent.

The menu lists sessions recorded in dotpals' retained activity history and recent
native logs. A searchable index of every archived native session is a later step.
Codex's internal approval-review sessions are excluded from activity views and resume destinations.
The original log file must still exist; this prototype does not reconstruct a
deleted native session from an activity summary.

Chat exports include text messages. Images, internal reasoning, tool results and
side-agent transcripts are omitted. Exports have a 64 MB source-file limit and
are created only on a user action. Original log files are read without editing them.

Sessions dotpals observes working or waiting for approval cannot be resumed by
the menu. This is an activity check, not a complete operating-system process lock;
an idle agent window may still be open. The CLI handles its own resume behavior.

## Validation

`node --test test/handoff.test.js test/session-center.test.js test/session-links.test.js test/codex.test.js test/claude.test.js`
checks native IDs, terminal commands, source conversation extraction, full-project
destination matching, HTTP access checks, active-session rejection and both adapters.
Agent launches in the HTTP tests are mocked so test runs do not submit work to a model.

The read-only live Claude connection check and its initial/resumed JSON responses
are stored in the prototype's ignored profile. It passes source context as text,
disables tools, resumes the exact returned native ID, and checks a fresh marker
without resending that context. The resulting source/destination link is saved in
`session-links.json`. Bare Claude activity UUIDs and `claude:<uuid>` registry IDs
resolve to the same conversation in the session and link APIs.

Command reference: https://learn.chatgpt.com/docs/developer-commands?surface=cli
and the installed Claude Code `--help`.
