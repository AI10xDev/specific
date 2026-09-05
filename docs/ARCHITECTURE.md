# Architecture

`specific` separates interactive shell ergonomics, portable delegation, and the
editor implementation.

## Components

- `shell/specific.sh` defines `spec`, `run_goal`, and `plan_goal`. It resolves an
  installation through `SPECIFIC_HOME`, translates supported `SPECIFIC_*`
  settings to the editor's internal variables, and owns the latest-save lookup.
- `bin/specific-run-build` validates one file and sends its complete contents to
  OpenCode's `build` agent.
- `bin/specific-run-plan` discovers files recursively, sorts paths, asks for a
  numbered selection, and sends the selected contents to OpenCode's `plan` agent.
- `editor/` is the portable source of the customized Kibi editor. Kibi's source,
  tests, syntax definitions, copyright, and dual-license files remain together.
- `install.sh` compiles the editor and installs all runtime components beneath a
  user-controlled prefix.

## Data Flow

The shell wrapper supplies `KIBI_SAVE_HISTORY_FILE` and `KIBI_SAVE_COPY_DIR` to
the editor. After an original save succeeds, the editor appends the source's
canonical path to history and writes the same buffer to a basename-only mirror.
The `spec build` shortcut reads the final history line; runners independently
validate input and discover OpenCode before invoking it.

Both runners capture the caller's working directory before doing any other path
work and pass it as `opencode run --dir`. This lets project-local OpenCode
configuration and tools operate against the project where the user invoked the
command, not this repository or the specs directory.

## Trust Boundaries

The editor writes local files and may optionally call Azure OpenAI for inline
completion. The runners pass the complete chosen document to the provider
configured in OpenCode. OpenCode itself is neither vendored nor modified here.

See [Configuration](CONFIGURATION.md) for paths and runtime settings.
