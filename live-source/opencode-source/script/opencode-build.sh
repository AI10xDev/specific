#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s "string"\n' "$0" >&2
  exit 1
fi

opencode run --agent build "$1"
