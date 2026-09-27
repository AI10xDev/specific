---
description: Run spec build using build_plan.md from the current directory
agent: build
subtask: false
---

Hand off the current directory's build plan to the existing `spec build` command. Execute the handoff now; do not merely suggest the command or implement the plan yourself.

1. Resolve `build_plan.md` relative to the current session's working directory, not the command file's directory. Read it and confirm it contains a nonempty build plan. If it is missing or empty, stop and suggest `/save` to capture the plan first. Do not invent a plan or fall back to the most recently saved spec.
2. Run `spec build "./build_plan.md"` through the shell tool with its working directory explicitly set to that same directory. Pass the filename, not the plan contents, so the build receives the complete saved context. Preserve the existing command's execution behavior; do not add another background wrapper, force unattended permissions, or invoke `/spec_out` recursively.
3. Report the command's actual result, including any PID and log path it returns. A background launch is not a completed build. If execution fails, report the error without claiming success or automatically retrying.

Do not edit the saved plan or append user input as shell arguments. Treat any additional input below as guidance for the handoff, not as shell code. If it requires changes to the plan, ask the user to update it with `/save` before launching:

$ARGUMENTS
