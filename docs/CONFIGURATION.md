# Configuration

All path settings are optional.

| Variable | Purpose | Default |
| --- | --- | --- |
| `SPECIFIC_HOME` | Installed runtime location used by shell integration | `${XDG_DATA_HOME:-$HOME/.local/share}/specific` |
| `SPECIFIC_BIN_DIR` | Installer command-link directory | `$HOME/.local/bin` |
| `SPECIFIC_SPECS_DIR` | Basename-only mirror destination | `$HOME/specs` |
| `SPECIFIC_STATE_DIR` | State and save-history directory | `${XDG_STATE_HOME:-$HOME/.local/state}/specific` |
| `SPECIFIC_PLAN_DIR` | Default directory searched by `plan_goal` | `$HOME/specing` |
| `SPECIFIC_OPENCODE_BIN` | Explicit OpenCode executable path or command | automatic discovery |
| `KIBI_RUN_COMMAND` | Editor save-and-build executable path, not a shell command string | resolved `specific-run-build` when launched by `spec` |
| `KIBI_ENV_FILE` | Optional dotenv file for editor completion | nearest `.env`, if present |
| `AZURE_OPENAI_ENDPOINT` | Optional editor completion endpoint | unset |
| `AZURE_OPENAI_API_KEY` | Optional editor completion credential | unset |
| `AZURE_OPENAI_API_VERSION` | Version for legacy Azure endpoints | unset |
| `DEPLOYMENT_NAME` | Azure completion deployment | `gpt-5.5` |

`KIBI_SAVE_HISTORY_FILE` and `KIBI_SAVE_COPY_DIR` are internal editor variables.
Use `SPECIFIC_STATE_DIR` and `SPECIFIC_SPECS_DIR`; the shell integration maps
them for each editor process.

## Editor Commands

`spec` sets `KIBI_RUN_COMMAND` using `_specific_command`: first the executable
at `$SPECIFIC_HOME/bin/specific-run-build`, then `specific-run-build` on `PATH`.
A nonempty external override is forwarded unchanged; an unset or empty value
uses the default lookup. This setting affects editor builds only, not
`spec build` or `run_goal`.

The value must be the path to an executable, **not a shell command string**.
The editor executes it directly with the saved filename as one argument, even
when either path contains spaces. Do not include arguments or shell quoting
inside the value. To customize build behavior, point to an executable wrapper:

```bash
export KIBI_RUN_COMMAND="$HOME/my tools/build-spec"
spec feature.md
```

`Ctrl+R` saves the buffer, prompting with Save As for an unnamed buffer, then
starts the build only after a successful save. The build is noninteractive;
it cannot read input from the editor. Its live output appears in the left pane
instead of the text buffer. Use `spec build [file]` outside the editor for the
unchanged portable foreground workflow.

`Ctrl+E` prompts for an arbitrary shell command and runs it via `bash -c`,
showing live output in the same left pane, never inserting it into the buffer.
Only run commands you trust. Unlike `KIBI_RUN_COMMAND`, this prompt accepts
shell syntax such as pipes and redirections. `Ctrl+K` removes a line, replacing
the old `Ctrl+R` binding.

The editor prevents overlapping runs: wait for the active build or command to
finish before starting another. Quitting the editor stops its active job.
The output pane follows the newest output, retaining up to 1,000 lines (8 KiB
per line) and discarding older output. Manual output scrolling is not available.
Below 20 terminal columns, the pane is hidden to leave room for editing; it
returns when the terminal is widened. ANSI terminal controls are stripped.
On Unix, jobs run in a separate session and their process group is stopped on
exit. Explicitly detached processes are outside that group and are not managed
by the editor.

## OpenCode Discovery

The runners use `SPECIFIC_OPENCODE_BIN` first, then `opencode` on `PATH`, then
the compatibility command `opencode-source`. The explicit setting may be an
absolute path or a command name on `PATH`.

## Optional Completion

Completion is not needed for editing, saving, planning, or building. To omit it,
leave the Azure variables unset and do not supply `KIBI_ENV_FILE`.

To enable it without committing secrets, export values in your shell or point
to a local ignored file:

```bash
export KIBI_ENV_FILE="$HOME/.config/specific/completion.env"
export AZURE_OPENAI_ENDPOINT="https://example-resource.openai.azure.com"
export AZURE_OPENAI_API_KEY="replace-with-your-key"
export AZURE_OPENAI_API_VERSION="replace-with-supported-version"
export DEPLOYMENT_NAME="replace-with-deployment"
```

An endpoint containing `/openai/v1` uses the Responses API and does not require
`AZURE_OPENAI_API_VERSION`. Other Azure endpoint forms use chat completions and
require it. Never place a real credential in this repository.
