#!/usr/bin/env python3
"""Linux/macOS smoke test; build first, then optionally pass the kibi binary path."""
import contextlib
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import traceback


class Terminal:
    def __init__(self, binary, root, name):
        self.root, self.pending, self.screen, self.trace = root, b"", "", b""
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        # No inherited credentials/config, and python3 cannot start the completion agent.
        env = dict(HOME=str(root), XDG_CONFIG_HOME=str(root), XDG_CONFIG_DIRS=str(root),
                   XDG_DATA_HOME=str(root), XDG_DATA_DIRS=str(root), TERM="xterm", NO_COLOR="1",
                   PATH=str(root / "bin"), KIBI_RUN_COMMAND=str(root / "runner ; literal"))
        try:
            self.proc = subprocess.Popen([str(binary)] + ([name] if name else []), cwd=root,
                                         env=env, stdin=slave, stdout=slave, stderr=slave,
                                         start_new_session=True)
        except OSError:
            os.close(self.fd)
            raise
        finally:
            os.close(slave)
        os.set_blocking(self.fd, False)

    def send(self, keys):
        self.screen = ""
        data = keys.encode()
        while data:
            _, ready, _ = select.select([], [self.fd], [], 10)
            assert ready, "PTY write timeout"
            data = data[os.write(self.fd, data):]

    def wait(self, text):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            assert self.proc.poll() is None, f"editor exited: {self.trace[-3000:]!r}"
            if text in self.screen and self.screen:
                return self.screen
            if not select.select([self.fd], [], [], 0.05)[0]:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            assert chunk, f"PTY closed: {self.trace[-3000:]!r}"
            self.trace = (self.trace + chunk)[-16000:]
            frames = (self.pending + chunk).split(b"\x1b[?25h")
            self.pending = frames[-1]
            if len(frames) > 1:
                self.screen = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", frames[-2]).decode("utf-8", "replace")
        raise AssertionError(f"waiting for {text!r}: {self.trace[-3000:]!r}")

    def resize(self, cols, rows=24):
        self.screen = ""
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.proc.send_signal(signal.SIGWINCH)
        self.wait("")

    def calls(self):
        path = self.root / "calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def close(self):
        if self.proc.poll() is None:
            with contextlib.suppress(OSError):
                self.send("\x11" * 4)
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait(timeout=2)
        os.close(self.fd)
        # Output jobs use their own process group; also clean up after editor panics.
        for call in self.calls():
            with contextlib.suppress(ProcessLookupError):
                os.killpg(call[0], signal.SIGKILL)


@contextlib.contextmanager
def editor(binary, name=None, content=""):
    with tempfile.TemporaryDirectory(prefix="kibi-pty-") as directory:
        root = Path(directory).resolve()
        (root / "bin").mkdir()
        (root / "bin/bash").symlink_to(shutil.which("bash"))
        stub = root / "bin/python3"
        stub.write_text("#!/bin/sh\nexit 0\n")
        stub.chmod(0o755)
        runner = root / "runner ; literal"
        runner.write_text(f"#!{sys.executable}\n" + '''import json, os, pathlib, select, sys, time
root = pathlib.Path.cwd()
with (root / "calls").open("a") as log:
    log.write(json.dumps([os.getpid(), sys.argv[1:], pathlib.Path(sys.argv[1]).read_text()]) + "\\n")
print("LIVE-OUT", flush=True)
print("LIVE-ERR", file=sys.stderr, flush=True)
deadline = time.monotonic() + 20
while not (root / "release").exists():
    if time.monotonic() > deadline:
        sys.exit(99)
    select.select([], [], [], 0.02)
print("FINISHED", flush=True)
''')
        runner.chmod(0o755)
        if name:
            (root / name).write_text(content)
        terminal = Terminal(binary, root, name)
        try:
            terminal.wait("Output | Idle")
            yield terminal
        finally:
            terminal.close()


def named(binary):
    name = "spec ;$(touch INJECTED) ' &.txt"
    with editor(binary, name, "old\nkeep\n") as t:
        t.send("\x0blatest\x12")  # Ctrl+K deletes the old line, Ctrl+R saves/runs.
        t.wait("LIVE-ERR")
        screen = t.wait("LIVE-OUT")
        assert screen.splitlines()[0].startswith("Output | Running")
        assert "latestkeep" in screen.splitlines()[0][40:], "document must be in right pane"
        assert not (t.root / "release").exists(), "output must arrive before child exit"
        assert t.calls()[0][1:] == [[str(t.root / name)], "latestkeep\n"], t.calls()
        assert (t.root / name).read_text() == "latestkeep\n"
        t.send("+edit\x13")
        t.wait("16B written to")
        assert (t.root / name).read_text() == "latest+editkeep\n", "editor blocked during run"
        t.send("\x12")
        t.wait("already running")
        t.send("\x05printf forbidden > forbidden\r")
        t.wait("already running")
        (t.root / "release").touch()
        t.wait("Exited:")
        assert len(t.calls()) == 1 and not (t.root / "forbidden").exists()
        assert not (t.root / "INJECTED").exists(), "filename was interpreted by a shell"
        t.send("\x05printf 'SHELL-%s\\n' OUT; printf 'SHELL-%s\\n' ERR >&2; exit 7\r")
        t.wait("exit status: 7")
        assert "\r\nSHELL-OUT" in t.screen and "\r\nSHELL-ERR" in t.screen
        t.send("\x13")
        t.wait("written to")
        assert (t.root / name).read_text() == "latest+editkeep\n", "shell output entered document"
        t.resize(40)
        t.resize(2, 2)
        t.resize(80)
        t.send("!\x13")
        t.wait("17B written to")
        assert (t.root / name).read_text() == "latest+edit!keep\n"


def unnamed(binary):
    with editor(binary) as t:
        t.send("new spec\x12")
        t.wait("Save and run as: ")
        t.send("\x1b")
        t.wait("aborted")
        assert not t.calls(), "cancel executed runner"
        t.send("\x12saved spec.txt\r")
        t.wait("LIVE-ERR")
        assert t.calls()[0][1:] == [[str(t.root / "saved spec.txt")], "new spec"]
        (t.root / "release").touch()
        t.wait("Exited:")
        assert len(t.calls()) == 1


def save_failure(binary):
    with editor(binary, "spec", "original") as t:
        (t.root / "spec").unlink()
        (t.root / "spec").mkdir()  # Deterministic even when tests run as root.
        t.send("changed\x12")
        t.wait("Can't save!")
        t.send("\x05printf 'BARRIER-%s' OK\r")
        t.wait("Exited:")
        assert "BARRIER-OK" in t.screen and not t.calls(), "failed save executed runner"


def unicode_resize(binary):
    with editor(binary, "ab" + "\u20ac" * 20, "text") as t:
        t.resize(40)
        t.resize(2, 2)
        t.resize(80)


def unicode_save(binary):
    with editor(binary, "a" * 20 + "\u20ac" * 16, "text") as t:
        t.send("\x13")
        t.wait("written to")


if __name__ == "__main__":
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else
                  Path(__file__).resolve().parents[1] / "editor/target/debug/kibi").resolve()
    failures = 0
    for test in (named, unnamed, save_failure, unicode_resize, unicode_save):
        try:
            test(binary)
            print(f"PASS {test.__name__}", flush=True)
        except Exception:
            failures += 1
            print(f"FAIL {test.__name__}", flush=True)
            traceback.print_exc()
    sys.exit(bool(failures))
