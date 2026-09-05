#!/usr/bin/env bats

setup() {
  REPO_ROOT=$(cd -- "$BATS_TEST_DIRNAME/.." && pwd -P)
  TEST_ROOT=$(mktemp -d)
  HOME="$TEST_ROOT/home"
  SPECIFIC_HOME="$TEST_ROOT/install"
  CAPTURE="$TEST_ROOT/capture"
  mkdir -p "$HOME" "$SPECIFIC_HOME/editor" "$SPECIFIC_HOME/bin" "$CAPTURE"
  cp "$REPO_ROOT/tests/helpers/fake-editor" "$SPECIFIC_HOME/editor/specific-editor"
  cp "$REPO_ROOT/tests/helpers/fake-delegate" "$SPECIFIC_HOME/bin/specific-run-build"
  cp "$REPO_ROOT/tests/helpers/fake-delegate" "$SPECIFIC_HOME/bin/specific-run-plan"
  chmod +x "$SPECIFIC_HOME/editor/specific-editor" "$SPECIFIC_HOME/bin/"*
  export REPO_ROOT TEST_ROOT HOME SPECIFIC_HOME CAPTURE
  export FAKE_CAPTURE_DIR="$CAPTURE"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_shell() {
  run bash -c 'source "$1/shell/specific.sh"; shift; "$@"' bash "$REPO_ROOT" "$@"
}

@test "spec launches editor with configured save paths and exact arguments" {
  export SPECIFIC_SPECS_DIR="$TEST_ROOT/mirrored specs"
  export SPECIFIC_STATE_DIR="$TEST_ROOT/local state"
  run_shell spec -- "file with spaces.md" --system-prompt "short prompt"
  [ "$status" -eq 0 ]
  [ "$(<"$CAPTURE/copy-dir")" = "$SPECIFIC_SPECS_DIR" ]
  [ "$(<"$CAPTURE/history-file")" = "$SPECIFIC_STATE_DIR/saved-files" ]
  [ "$(<"$CAPTURE/count")" = 4 ]
  [ "$(<"$CAPTURE/arg-0")" = -- ]
  [ "$(<"$CAPTURE/arg-1")" = "file with spaces.md" ]
  [ "$(<"$CAPTURE/arg-3")" = "short prompt" ]
}

@test "spec build resolves and delegates an explicit file" {
  local project="$TEST_ROOT/project with spaces"
  mkdir "$project"
  printf 'prompt' > "$project/spec file.md"
  run bash -c 'cd -- "$1"; source "$2/shell/specific.sh"; spec build "spec file.md"' bash \
    "$project" "$REPO_ROOT"
  [ "$status" -eq 0 ]
  [ "$(<"$CAPTURE/command")" = specific-run-build ]
  [ "$(<"$CAPTURE/arg-0")" = "$project/spec file.md" ]
}

@test "spec build uses the final history entry" {
  export SPECIFIC_STATE_DIR="$TEST_ROOT/state"
  mkdir -p "$SPECIFIC_STATE_DIR"
  printf 'one' > "$TEST_ROOT/one.md"
  printf 'two' > "$TEST_ROOT/two.md"
  printf '%s\n%s\n' "$TEST_ROOT/one.md" "$TEST_ROOT/two.md" > "$SPECIFIC_STATE_DIR/saved-files"
  run_shell spec build
  [ "$status" -eq 0 ]
  [ "$(<"$CAPTURE/arg-0")" = "$TEST_ROOT/two.md" ]
}

@test "missing empty and stale history fail before delegation" {
  export SPECIFIC_STATE_DIR="$TEST_ROOT/state"
  run_shell spec build
  [ "$status" -ne 0 ]
  [[ "$output" == *"No saved spec is available"* ]]
  [ ! -e "$CAPTURE/command" ]

  mkdir -p "$SPECIFIC_STATE_DIR"
  : > "$SPECIFIC_STATE_DIR/saved-files"
  run_shell spec build
  [ "$status" -ne 0 ]
  [ ! -e "$CAPTURE/command" ]

  printf '%s\n' "$TEST_ROOT/deleted.md" > "$SPECIFIC_STATE_DIR/saved-files"
  run_shell spec build
  [ "$status" -ne 0 ]
  [[ "$output" == *"Saved spec is no longer available"* ]]
  [ ! -e "$CAPTURE/command" ]
}

@test "spec build rejects more than one file" {
  run_shell spec build one two
  [ "$status" -ne 0 ]
  [ "$output" = "Usage: spec build [spec-file]" ]
  [ ! -e "$CAPTURE/command" ]
}

@test "compatibility functions delegate exact arguments" {
  run_shell run_goal "a file.md"
  [ "$status" -eq 0 ]
  [ "$(<"$CAPTURE/command")" = specific-run-build ]
  [ "$(<"$CAPTURE/arg-0")" = "a file.md" ]

  rm "$CAPTURE/command"
  run_shell plan_goal "a directory"
  [ "$status" -eq 0 ]
  [ "$(<"$CAPTURE/command")" = specific-run-plan ]
  [ "$(<"$CAPTURE/arg-0")" = "a directory" ]
}
