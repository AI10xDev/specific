---
description: Save the current conversation context and build plan to build_plan.md
agent: build
subtask: false
---

Save a self-contained handoff of the current conversation to `build_plan.md` in the current working directory. Perform the file edit now; do not just print a proposed plan.

Use the conversation history available to you. Capture the user's goals, requirements, constraints, decisions and their rationale, relevant files, work already completed, verification results, outstanding tasks, blockers, and concrete next steps. Preserve important commands and acceptance criteria so a fresh session can resume the work without this conversation. Distinguish confirmed facts from assumptions and proposals. This is a context summary, not a verbatim transcript; do not claim access to unavailable history.

If `build_plan.md` already exists, read it first and integrate the current context, preserving still-relevant requirements and unfinished work. Mark completed work accurately and replace stale information only when the conversation supports it. Do not include secrets, credentials, or unrelated sensitive content.

Organize the document into Goal, Requirements and Constraints, Decisions, Current State, Build Steps, Verification, and Open Questions. Use actionable checkboxes for remaining build steps. Note unavailable information rather than inventing it.

Treat any additional user arguments as guidance for this handoff:

$ARGUMENTS

Only update `build_plan.md`; do not start implementation, run the build, commit, or push. Finish by confirming the saved file's location and briefly identifying any unresolved blockers.
