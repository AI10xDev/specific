#!/usr/bin/env bash
set -euo pipefail
root=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
if [[ "$root" != /home/opencode/nextweb || "$(id -un)" != opencode ]]; then
  printf 'These VM service templates target opencode at /home/opencode/nextweb. Adjust templates before installing elsewhere.\n' >&2
  exit 1
fi
for binary in node git flock az systemctl crontab; do command -v "$binary" >/dev/null; done
test -x /snap/node/current/bin/node
sudo -n true
node --test "$root"/tools/eval/*.test.mjs
sudo systemd-analyze verify "$root/tools/eval/eval-daemon.service"
install -d -m 700 "$HOME/.local/bin"
for name in spec spec-eval; do
  target="$HOME/.local/bin/$name"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ "$(realpath "$target")" == "$root/tools/eval/$name" ]] || { printf 'Refusing to replace %s\n' "$target" >&2; exit 1; }
  else
    ln -s "$root/tools/eval/$name" "$target"
  fi
done
sudo install -m 644 "$root/tools/eval/eval-daemon.service" /etc/systemd/system/eval-daemon.service
sudo install -m 644 "$root/tools/eval/eval-daemon.cron" /etc/cron.d/eval-daemon
sudo systemctl daemon-reload
sudo systemctl enable --now cron.service
sudo systemctl enable eval-daemon.service
sudo systemctl start eval-daemon.service
printf 'Installed Eval Daemon: on boot and hourly at minute 05. Inspect: systemctl status eval-daemon\n'
