# Eval Daemon

`spec eval` (also `spec --eval`) reads the current Git repository and `priority.md`, fingerprints tracked application source and workflows, discovers matching Azure Static Web Apps, and records evaluation hypotheses and observations. Existing `spec` editor and `spec build` behavior is preserved on this VM.

```bash
spec eval
spec --eval --offline
spec eval --repo /home/opencode/nextweb
node --test tools/eval/*.test.mjs
bash tools/eval/install.sh
```

The installer targets this VM explicitly. It installs a non-root, one-shot systemd service with `Description=Eval Daemon`, enabled at boot, plus `/etc/cron.d/eval-daemon` at `5 * * * *`. The process exits between runs, rather than wasting a resident process sleeping. No timer duplicates the cron job. A Git-common-directory `flock` prevents overlapping CLI/service runs; exit 75 means an existing evaluation holds the lock. Runs are capped at 50 minutes and systemd kills the complete process group on termination. The service uses `/snap/node/current/bin` directly because the Snap launcher requires privileges forbidden by `NoNewPrivileges`; the installer waits for its first service invocation to finish successfully.

The interactive `spec` function in `/home/opencode/.bash_aliases` dispatches `eval`/`--eval` to `tools/eval/spec-eval`. The checked-in executable `tools/eval/spec` also supports noninteractive calls and delegates ordinary editor/build commands to that existing function. With `SPEC_BUILD_AUTO=1`, its `spec build <spec-file>` mode runs the OpenCode build agent unattended in the foreground, preserving the invocation directory and exit status. The daemon invokes this executable directly rather than depending on interactive shell functions. The installer creates `~/.local/bin/spec` and `spec-eval` symlinks without overwriting unrelated commands.

## Outputs

- `logs/eval/<UTC timestamp>.json`: immutable-per-run evidence, hypotheses, change fingerprints, limitations, and remediation outcome.
- `logs/eval/latest.json`: atomic rolling state and revision history pointer.
- `logs/eval/hypothesis.md`: human-readable current evaluation hypothesis.
- `logs/eval/fixtures.json`: rolling fixture specifications, priority/source references, observations, targets and build-handoff outcome. Specifications are not implemented or executed tests; every timestamped report also retains its specifications.
- `journalctl -u eval-daemon.service`: service execution/failure summaries.
- `logs/eval/remediation-*.md`, `remediation-*.log` and `fix-*`: private persisted build specifications, agent transcripts and isolated worktrees, if remediation runs.

Outputs are ignored by Git, created with private permissions, and never automatically committed. Keep this directory on a monitored disk and archive old timestamped reports/worktrees as needed; automatic deletion is deliberately avoided. Do not delete `latest.json` casually: it holds deduplication and published-fix state. A corrupt or unsupported state fails closed, rather than losing prior evidence.

## Azure Access

Use the service user's authorized Azure CLI identity. Interactive logins may expire; for unattended operation prefer a VM managed identity with Reader and narrowly scoped monitoring-query permissions. No credentials, SWA deployment tokens, app settings, raw requests, or traces are queried. No monitoring resource is provisioned by this tool.

Optional settings go in `/home/opencode/.config/spec-eval.env` (mode 0600), using systemd `KEY=value` syntax:

```ini
EVAL_REPOSITORY_URL=https://github.com/AI10x/nextweb
EVAL_PRODUCTION_HOST=00z.ai
# Set to the verified Application Insights application UUID, not an instrumentation key:
# EVAL_APP_INSIGHTS_APP_ID=00000000-0000-0000-0000-000000000000
# Optionally select a verified SWA ARM resource ID instead of repository matching:
# EVAL_SWA_RESOURCE_ID=/subscriptions/.../providers/Microsoft.Web/staticSites/...
EVAL_AUTO_FIX=1
```

The service reads this file at each invocation. Interactive `spec eval` uses exported environment variables instead. SWA discovery is restricted to the configured repository/resource. Deployment environments include their branch/name; preview status is never treated as production request telemetry. Azure Monitor metric definitions are discovery metadata, not observed metric values.

Production Application Insights requests are filtered to the exact configured hostname and the **last complete UTC hour**. Failure counts are weighted by `itemCount`; p95 is the sampled-row percentile. Missing credentials, missing resources, query errors, zero traffic, stale windows and fewer than 100 samples all leave request hypotheses **unmeasured**, not healthy. In this subscription no Application Insights component was discovered at installation, so request evaluation requires monitoring configuration before it can produce outcomes.

## Evaluation And Fixes

Initial targets reflect `priority.md`: SWA/Functions reliability (failure rate <=1%), scaling latency (sampled p95 <=2000 ms), database resilience and security regression evidence. These are provisional hypotheses, not claims that these are the correct production SLOs. Tracked source evidence and priority changes are logged; untracked source is excluded. Database saturation, staging load tests and security scan results are not inferred from request metrics.

Every run updates observations and next experiments. Hypothesis revisions change when source, priorities, or supported/breached/unmeasured states change. Targets never automatically relax to disguise regressions. Two **distinct consecutive** complete hours with >=100 request samples and a breached target constitute a substantial finding. Repeat manual runs of the same hour cannot inflate the evidence streak; changing telemetry scope or priorities resets it. Correlation is not causation: the fix agent must establish a reproducible code defect before changing anything.

Unattended implementation is enabled for the installed service; manual runs require `EVAL_AUTO_FIX=1`. It refuses dirty worktrees (including submodules/untracked files), non-main branches, stale report HEADs and local/remote divergence. It works in an isolated worktree, installs locked dependencies without lifecycle scripts, persists a redacted specification, and hands it to `spec build` synchronously with unattended execution enabled. Substantial findings request a deterministic regression fixture and minimal fix using observed outcomes. Subsequent live passes without substantial findings request **fixture-only** implementation of local existing-behavior tests, including unmeasured database/security hypotheses. In this mode validation rejects all non-test changes and deletion or renaming of existing test files, and passing fixtures publish to `eval/fixtures-*` with no production code changes. Offline passes never request implementation. The service does not grant root access to the agent. Agent instructions and file validation are guardrails, **not an OS security sandbox**; the agent uses the service user's existing permissions and credentials.

Successful independent validation is persisted in `fixtureValidation` and carried into later reports and `fixtures.json`. This records the tested branch and base commit, not evidence of current production health. Actual production observations continue to determine supported/breached states; local fixture success cannot turn missing telemetry into a supported hypothesis. Before-fix failure is requested for remediation but is not independently replayed against the original tree.

Independent gates explicitly run changed regression tests, auth, subscription, TTS, signup and ledger tests plus TypeScript checking. Changed files must be TypeScript under `qore-nextjs/src`, include a changed regression test, and pass path/symlink/heuristic-secret checks. Fixes outside that scope are blocked for manual investigation. Only passing fixes are committed and pushed, without force, to `eval/fix-*`. The daemon never merges or deploys them, and never commits the shared worktree's changes. Failed worktrees are retained. The attempt and branch are persisted before creating a worktree, so a reboot or interrupted publication cannot silently start duplicate fixes. A failure has a 24-hour retry cooldown; a published or interrupted in-progress branch blocks further fixes until reviewed. After reviewing/merging or rejecting that branch (including checking whether an interrupted push reached the remote), clear `lastAttempt` to `null` in `latest.json` **while the service is stopped and no CLI run holds the lock** to resume automatic fixes.

```bash
systemctl status eval-daemon.service
systemctl is-enabled eval-daemon.service
journalctl -u eval-daemon.service --since today
sudo systemctl start eval-daemon.service
```

To disable all scheduling, remove `/etc/cron.d/eval-daemon` and run `sudo systemctl disable --now eval-daemon.service`. Disabling only the unit's boot startup does not disable the cron trigger.
