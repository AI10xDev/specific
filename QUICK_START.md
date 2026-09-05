# Quick Start

1. Clone and enter the repository.

   ```bash
   git clone https://github.com/AI10xDev/specific.git
   cd specific
   ```

2. Install the editor and commands.

   ```bash
   ./install.sh
   ```

3. Load the shell integration now, then add the same line to your Bash startup
   file when ready.

   ```bash
   source "${XDG_DATA_HOME:-$HOME/.local/share}/specific/shell/specific.sh"
   ```

   Alternatively, `./install.sh --configure-shell` adds the resolved line to
   `~/.bashrc` idempotently.

4. Verify the installation.

   ```bash
   type spec
   specific-run-build --help
   specific-run-plan --help
   ```

5. Open a target project and write the first specification.

   ```bash
   cd /path/to/your/project
   spec first-feature.md
   ```

   Save with `Ctrl-S`, then quit with `Ctrl-Q`.

6. Send that file to OpenCode's build agent.

   ```bash
   spec build first-feature.md
   ```

7. Use the latest-save shortcut after saving any specification with `spec`.

   ```bash
   spec build
   ```

8. Select a specification for OpenCode's plan agent.

   ```bash
   plan_goal
   # Or choose another source directory:
   plan_goal "$HOME/specs"
   ```

Azure-backed inline completion is optional. Leave `KIBI_ENV_FILE` and all
`AZURE_OPENAI_*` variables unset to omit it. Core editing and delegation still
work. See the [complete configuration](README.md#configuration) and
[troubleshooting guide](README.md#troubleshooting).
