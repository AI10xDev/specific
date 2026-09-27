# Live `spec` source snapshot

Captured on 2026-09-27 from the development machine, including uncommitted source changes. This is an archival snapshot of the command actually in use, **not a new portable installation or a replacement for the root package**. `../install.sh` does not install this snapshot. No shell startup files or running services were changed.

## Contents and command routing

- `shell/spec.bash`: the exact `spec`, `run_goal`, `plan_goal`, and `opencode-source` definitions extracted from `~/.bash_aliases`. Unrelated SSH configuration is excluded.
- `nextweb/tools/eval/spec`: the executable targeted by `~/.local/bin/spec`. `/eval`, `/telle`, and `telle` dispatch to the Bun workflow; `eval`/`--eval` dispatch to `spec-eval`; ordinary calls load the shell function. `SPEC_BUILD_AUTO=1 spec build <file>` runs unattended in the foreground.
- `nextweb/tools/eval/`: the evaluation implementation, supporting Azure/remediation modules, tests, and existing VM-specific service/install files.
- `opencode-source/script/`: the active build/plan launchers, persistent session runner, hypothesis/telemetry dispatch, supporting telemetry implementation, and their documentation.
- `opencode-source/.opencode/`: only the agent/command definitions used by these workflows. These are archived configuration files, not installed configuration for this repository.
- `opencode-source/packages/opencode/test/cli/`: the corresponding runner/workflow tests and fake server fixture.
- `opencode-runtime.patch`: supporting OpenCode package source and test changes relative to upstream commit `909db63265971d67d2fe4ba7f9d7b74cc33e2fdc`. Includes both the locally committed runtime customizations and current uncommitted package changes. Some tests are also copied separately above for convenient inspection.
- `manifest.json`: source checkout revisions, capture time, and SHA-256 hashes of all copied files and the runtime patch. Revisions describe the base checkouts; hashes describe the actual working-tree snapshot.

The current editor source is already in this repository's `../editor/`; it is not duplicated here. The installed editor was sourced from that checkout. The live shell uses the installed editor at `$HOME/.local/share/specific/editor/specific-editor`, saves history under `$HOME/.local/state/spec`, and enables persistent sessions for the local `run-spec.sh` launcher. This differs from the portable shell's defaults.

## Dependencies and limitations

The copied sources deliberately preserve their original paths and behavior, including `/home/opencode/...` paths. They are **not runnable as a standalone OpenCode checkout**. Bun, Node.js, Bash, Linux tools (`setsid`, `flock`, `nohup`), the customized OpenCode runtime, and the separately built editor are external dependencies. Workflow tests that import OpenCode packages require the full OpenCode checkout and its installed workspace dependencies.

To reconstruct the source in a separate, clean OpenCode checkout:

1. Check out upstream `anomalyco/opencode` at the `runtimePatchBase` revision in `manifest.json`.
2. Run `git apply --check /path/to/specific/live-source/opencode-runtime.patch`, then apply that patch.
3. Overlay the contents of `live-source/opencode-source/` onto that checkout, preserving dot directories and executable modes. The duplicate tests are byte-identical to the runtime patch's target versions.
4. Follow that checkout's dependency/build instructions and the included runner documentation. Review and adapt machine-specific executable paths before using the archived shell integration.

The snapshot excludes binaries, `node_modules`, build artifacts, environment files, authentication stores, saved specifications, runtime inboxes, logs, and unrelated working-tree files. References to credential/environment paths are retained as source text; their contents are not included. It is not a backup of the entire machine or all three repositories.

**Security/behavior warning:** the existing runtime customizations include automatic permission approval and question recommendations. The archived eval installer can enable scheduled evaluation and unattended remediation. These are recorded existing behaviors, not new recommendations or a security boundary. Do not source the archived shell file or run its installer without reviewing those behaviors and paths. Tests use stubs/offline fixtures; they do not require live model calls or Azure access.

## Verification

From the root of the `specific` repository:

```bash
node --test live-source/nextweb/tools/eval/*.test.mjs
(cd live-source/opencode-source && bun test packages/opencode/test/cli/run-spec.test.ts packages/opencode/test/cli/spec-session.test.ts)
bats tests/*.bats
```

Run `spec-workflow.test.ts` and `telle.test.ts` in the full source checkout (from `packages/opencode`), since they import the OpenCode configuration/permission implementations or shared workspace fixtures. The optional installed-runtime smoke test is not enabled by default. See the captured source documentation for additional development checks.

OpenCode source retains its MIT license in `opencode-source/LICENSE`. The nextweb files retain their existing notices and provenance; no new license grant for those files is implied by this snapshot.
