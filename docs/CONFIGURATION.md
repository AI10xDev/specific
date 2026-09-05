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
| `KIBI_ENV_FILE` | Optional dotenv file for editor completion | nearest `.env`, if present |
| `AZURE_OPENAI_ENDPOINT` | Optional editor completion endpoint | unset |
| `AZURE_OPENAI_API_KEY` | Optional editor completion credential | unset |
| `AZURE_OPENAI_API_VERSION` | Version for legacy Azure endpoints | unset |
| `DEPLOYMENT_NAME` | Azure completion deployment | `gpt-5.5` |

`KIBI_SAVE_HISTORY_FILE` and `KIBI_SAVE_COPY_DIR` are internal editor variables.
Use `SPECIFIC_STATE_DIR` and `SPECIFIC_SPECS_DIR`; the shell integration maps
them for each editor process.

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
