---
description: Configure or control the passive telle systemd telemetry workflow
agent: build
subtask: false
---

Control the passive telemetry workflow in the session working directory using the
existing `spec` executable. Accept exactly one of: init, check, run, install, start,
stop, status. With no argument use status. Reject other input and show those choices;
never pass arbitrary user text as shell code. Run `spec /telle ACTION` through the
shell tool with that working directory, replacing ACTION only with the validated
literal action. Do not invoke this slash command recursively.

`init` creates `.telle.json`; the user must select sanitized snapshots and objectives.
`check` validates without calling a model. `run` sends the configured data to the
model once. `install` installs user-level telle.service/telle.timer but does not start
them. `start` explicitly enables recurring, billable model analysis. `stop` disables
the timer and stops an active assessment. `status` reports service and assessment state.

Do not auto-start after init/install, fabricate telemetry, collect secrets, authorize
production changes, use sudo, or change linger. If configuration/credentials are
missing, report the actual error and explain the required setup rather than bypassing
safeguards. Running/starting transmits selected data to the configured model provider.
Report the actual outcome, not merely the requested action. Monitoring adapts its
assessment and recommendations; it never remediates production automatically.

Requested action:

$ARGUMENTS
