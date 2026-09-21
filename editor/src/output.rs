// SPDX-License-Identifier: MIT OR Apache-2.0

use std::{
    collections::VecDeque,
    io::{self, Read},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
        mpsc::{self, Receiver, Sender, TryRecvError},
    },
    thread,
    time::Duration,
};

const MAX_LINES: usize = 1000;
const MAX_LINE_BYTES: usize = 8192;
const CHUNK_BYTES: usize = 4096;
const CHANNEL_CHUNKS: usize = 16;

#[derive(Default)]
enum Escape {
    #[default]
    Text,
    Start,
    Intermediate,
    Csi,
    String,
    StringEnd,
}

/// Bounded, terminal-safe shell output. The last entry may be an unfinished line.
pub struct Output {
    pub(crate) lines: VecDeque<String>,
    pub(crate) status: String,
    child: Option<Child>,
    receiver: Option<Receiver<io::Result<Vec<u8>>>>,
    reaper: Option<Sender<Child>>,
    stopped: Arc<AtomicBool>,
    utf8: Vec<u8>,
    escape: Escape,
    carriage_return: bool,
}

impl Default for Output {
    fn default() -> Self {
        Self {
            lines: VecDeque::new(),
            status: "Idle".into(),
            child: None,
            receiver: None,
            reaper: None,
            stopped: Arc::default(),
            utf8: Vec::new(),
            escape: Escape::default(),
            carriage_return: false,
        }
    }
}

impl Output {
    pub(crate) const fn is_running(&self) -> bool {
        self.child.is_some() || self.receiver.is_some()
    }

    /// Replace the previous job, then read the new job's output on a bounded worker.
    pub(crate) fn start(&mut self, command: &mut Command) -> io::Result<()> {
        *self = Self::default();
        let (mut reader, writer) = io::pipe()?;
        #[cfg(unix)]
        crate::sys::nonblocking_pipe(&reader)?;
        let stderr = writer.try_clone()?;
        let (sender, receiver) = mpsc::sync_channel(CHANNEL_CHUNKS);
        let (cleanup, children) = mpsc::channel::<Child>();
        let stopped = Arc::clone(&self.stopped);
        // Start the reaper before the child: Drop never needs to create a thread or wait.
        thread::Builder::new().name("shell-output".into()).spawn(move || {
            let mut buffer = [0; CHUNK_BYTES];
            #[cfg(unix)]
            let mut remaining = None;
            loop {
                #[cfg(unix)]
                if remaining.is_none() && stopped.load(Relaxed) {
                    match crate::sys::pipe_pending(&reader) {
                        Ok(bytes) => remaining = Some(bytes),
                        Err(error) => {
                            drop(sender.send(Err(error)));
                            break;
                        }
                    }
                }
                #[cfg(unix)]
                let size = remaining.unwrap_or(CHUNK_BYTES).min(CHUNK_BYTES);
                #[cfg(not(unix))]
                let size = CHUNK_BYTES;
                if size == 0 {
                    break;
                }
                match reader.read(&mut buffer[..size]) {
                    Ok(0) => break,
                    Ok(size) => {
                        #[cfg(unix)]
                        if let Some(remaining) = &mut remaining {
                            *remaining -= size;
                        }
                        if sender.send(Ok(buffer[..size].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        #[cfg(not(unix))]
                        if stopped.load(Relaxed) {
                            break;
                        }
                        // Recheck the backlog next iteration: exit can race with EAGAIN.
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => {
                        drop(sender.send(Err(error)));
                        break;
                    }
                }
            }
            drop(reader);
            drop(sender);
            if let Ok(mut child) = children.recv() {
                drop(child.wait());
            }
        })?;
        self.receiver = Some(receiver);
        self.reaper = Some(cleanup);
        command.stdin(Stdio::null()).stderr(stderr).stdout(writer);
        #[cfg(unix)]
        crate::sys::detach_job(command);
        let child = command.spawn();
        // Command retains its pipe writers after spawning; close them so EOF can arrive.
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let child = child.inspect_err(|_| {
            *self = Self::default();
        })?;
        self.child = Some(child);
        self.status = "Running".into();
        Ok(())
    }

    /// Consume a bounded amount of ready output and check exit without blocking.
    pub(crate) fn poll(&mut self) -> bool {
        let mut changed = false;
        for _ in 0..CHANNEL_CHUNKS {
            let Some(receiver) = &self.receiver else { break };
            match receiver.try_recv() {
                Ok(Ok(bytes)) => {
                    self.decode(&bytes, false);
                    changed = true;
                }
                Ok(Err(error)) => {
                    self.status = format!("Output error: {error}");
                    changed = true;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.receiver = None;
                    self.decode(&[], true);
                    changed = true;
                    break;
                }
            }
        }
        if let Some(child) = &mut self.child {
            #[cfg(unix)]
            let result = crate::sys::try_wait_job(child);
            #[cfg(not(unix))]
            let result = child.try_wait();
            match result {
                Ok(Some(status)) => {
                    self.stopped.store(true, Relaxed);
                    self.reaper = None;
                    self.child = None;
                    self.status = format!("Exited: {status}");
                    changed = true;
                }
                Ok(None) => {}
                Err(error) => {
                    let status = format!("Wait error: {error}");
                    changed |= self.status != status;
                    self.status = status;
                }
            }
        }
        changed
    }

    fn decode(&mut self, bytes: &[u8], eof: bool) {
        let mut pending = std::mem::take(&mut self.utf8);
        pending.extend_from_slice(bytes);
        let mut remaining = pending.as_slice();
        while !remaining.is_empty() {
            let error = match str::from_utf8(remaining) {
                Ok(text) => {
                    for c in text.chars() {
                        self.character(c);
                    }
                    break;
                }
                Err(error) => error,
            };
            for c in String::from_utf8_lossy(&remaining[..error.valid_up_to()]).chars() {
                self.character(c);
            }
            remaining = &remaining[error.valid_up_to()..];
            if let Some(size) = error.error_len() {
                self.character('\u{fffd}');
                remaining = &remaining[size..];
            } else {
                if eof {
                    self.character('\u{fffd}');
                } else {
                    self.utf8.extend_from_slice(remaining);
                }
                break;
            }
        }
    }

    fn character(&mut self, c: char) {
        // Keep escape state across reads, without ever buffering an escape payload.
        self.escape = match self.escape {
            Escape::String if c == '\u{1b}' => Escape::StringEnd,
            Escape::String | Escape::StringEnd if matches!(c, '\u{7}' | '\u{9c}') => Escape::Text,
            Escape::StringEnd if c == '\\' => Escape::Text,
            Escape::String | Escape::StringEnd => Escape::String,
            _ if c == '\u{1b}' => Escape::Start,
            Escape::Start if c == '[' => Escape::Csi,
            Escape::Start if matches!(c, ']' | 'P' | 'X' | '^' | '_') => Escape::String,
            Escape::Start | Escape::Intermediate if (' '..='/').contains(&c) => {
                Escape::Intermediate
            }
            Escape::Start | Escape::Intermediate => Escape::Text,
            Escape::Csi if ('@'..='~').contains(&c) => Escape::Text,
            Escape::Csi => Escape::Csi,
            Escape::Text if c == '\u{9b}' => Escape::Csi,
            Escape::Text if matches!(c, '\u{90}' | '\u{98}' | '\u{9d}'..='\u{9f}') => {
                Escape::String
            }
            Escape::Text => {
                self.text(c);
                Escape::Text
            }
        };
    }

    fn text(&mut self, c: char) {
        if c == '\r' {
            self.carriage_return = true;
            return;
        }
        if c != '\n' && c != '\t' && c != '\u{8}' && c.is_control() {
            return;
        }
        if self.lines.is_empty() {
            self.lines.push_back(String::new());
        }
        if c == '\n' {
            self.carriage_return = false;
            self.lines.push_back(String::new());
            if self.lines.len() > MAX_LINES {
                self.lines.pop_front();
            }
            return;
        }
        if let Some(line) = self.lines.back_mut() {
            if self.carriage_return {
                line.clear();
                self.carriage_return = false;
            }
            if c == '\u{8}' {
                line.pop();
            } else if c == '\t' {
                if line.len() + 4 <= MAX_LINE_BYTES {
                    line.push_str("    ");
                }
            } else if line.len() + c.len_utf8() <= MAX_LINE_BYTES {
                line.push(c);
            }
        }
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        // Disconnect first: a worker blocked on the bounded channel must be able to exit.
        self.receiver = None;
        self.stopped.store(true, Relaxed);
        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            drop(crate::sys::kill_process_group(child.id()));
            drop(child.kill());
            if let Some(reaper) = self.reaper.take() {
                drop(reaper.send(child));
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{MAX_LINE_BYTES, MAX_LINES, Output};
    use std::{
        io,
        process::Command,
        sync::Arc,
        thread,
        time::{Duration, Instant},
    };

    fn shell(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    fn finish(output: &mut Output) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while output.is_running() {
            output.poll();
            assert!(Instant::now() < deadline, "shell output did not finish");
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn combined_streams_and_exit_status() -> io::Result<()> {
        let mut output = Output::default();
        assert_eq!(output.status, "Idle");
        assert!(!output.poll(), "idle polling should not report changes");
        let mut command = shell("printf 'out\\n'; printf 'err\\n' >&2; exit 7");
        output.start(&mut command)?;
        assert_eq!(output.status, "Running");
        finish(&mut output);
        assert_eq!(output.lines, ["out", "err", ""]);
        assert_eq!(output.status, "Exited: exit status: 7");
        assert!(!output.poll(), "finished polling should not report changes");
        Ok(())
    }

    #[test]
    fn partial_output_and_split_unicode_are_live() -> io::Result<()> {
        let directory = tempfile::tempdir()?;
        let release = directory.path().join("release");
        let mut output = Output::default();
        output.start(shell(
            "printf 'partial\\342'; while [ ! -f \"$1\" ]; do sleep 0.01; done; printf '\\202\\254\\377\\342'",
        ).arg("sh").arg(&release))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while output.lines.back().is_none_or(|line| line != "partial") {
            output.poll();
            assert!(Instant::now() < deadline, "partial line was not delivered before exit");
            thread::sleep(Duration::from_millis(2));
        }
        assert!(output.is_running(), "partial output must be visible while running");
        std::fs::write(release, [])?;
        finish(&mut output);
        assert_eq!(output.lines, ["partial\u{20ac}\u{fffd}\u{fffd}"]);
        Ok(())
    }

    #[test]
    fn sanitizes_terminal_sequences_and_progress() -> io::Result<()> {
        let mut output = Output::default();
        output.start(&mut shell(
            "printf '\\033[31mred\\033[0m\\033]0;hidden\\007!\\033]8;;url\\033\\\\link\\033]8;;\\033\\\\\\nold progress\\rnew\\r\\n\\001a\\tbX\\b!\\033Psecret\\033\\\\'",
        ))?;
        finish(&mut output);
        assert_eq!(output.lines, ["red!link", "new", "a    b!"]);
        assert!(
            output.lines.iter().all(|line| !line.chars().any(char::is_control)),
            "terminal controls escaped sanitization"
        );
        Ok(())
    }

    #[test]
    fn escape_sequences_survive_every_chunk_boundary() {
        let mut output = Output::default();
        for byte in b"\x1b[31mred\x1b[0m\x1b]title\x1b\\!\xc2\x9b32mgreen\xc2\x9b0m" {
            output.decode(&[*byte], false);
        }
        output.decode(&[], true);
        assert_eq!(output.lines, ["red!green"]);
    }

    #[test]
    fn bounds_huge_lines_and_scrollback() -> io::Result<()> {
        let mut output = Output::default();
        output.start(&mut shell("printf '%0100000d' 0"))?;
        finish(&mut output);
        assert_eq!(output.lines.len(), 1);
        assert_eq!(output.lines[0].len(), MAX_LINE_BYTES);
        output.start(&mut shell("i=0; while [ \"$i\" -lt 1500 ]; do printf '%09000d\\n' \"$i\"; i=$((i+1)); done; printf end"))?;
        // Let the bounded channel fill before polling, as it would with an idle UI.
        thread::sleep(Duration::from_millis(30));
        finish(&mut output);
        assert_eq!(output.lines.len(), MAX_LINES);
        assert!(
            output.lines.iter().all(|line| line.len() <= MAX_LINE_BYTES),
            "single line exceeded its byte bound"
        );
        assert_eq!(output.lines.back().map(String::as_str), Some("end"));
        Ok(())
    }

    #[test]
    fn restart_resets_state_and_stdin_is_closed() -> io::Result<()> {
        let mut output = Output::default();
        output.start(&mut shell("printf old; sleep 30"))?;
        output.start(&mut shell("if read -r line; then exit 1; fi; printf new"))?;
        finish(&mut output);
        assert_eq!(output.lines, ["new"]);
        assert_eq!(output.status, "Exited: exit status: 0");
        let missing = tempfile::tempdir()?.path().join("missing-command");
        let error = output.start(&mut Command::new(missing)).err();
        assert_eq!(error.map(|error| error.kind()), Some(io::ErrorKind::NotFound));
        assert!(!output.is_running(), "failed spawn left a running job");
        assert!(output.lines.is_empty(), "failed spawn retained old output");
        Ok(())
    }

    #[test]
    fn drop_kills_descendants_and_reaps_shell() -> io::Result<()> {
        let directory = tempfile::tempdir()?;
        let marker = directory.path().join("survived");
        let mut output = Output::default();
        output.start(
            shell("(sleep 0.5; printf survived > \"$1\") & printf ready; wait")
                .arg("sh")
                .arg(&marker),
        )?;
        let id = output.child.as_ref().map(std::process::Child::id);
        let deadline = Instant::now() + Duration::from_secs(5);
        while output.lines.is_empty() {
            output.poll();
            assert!(Instant::now() < deadline, "shell did not start");
            thread::sleep(Duration::from_millis(2));
        }
        drop(output);
        if let Some(id) = id {
            while Command::new("kill")
                .args(["-0", &id.to_string()])
                .stderr(std::process::Stdio::null())
                .status()?
                .success()
            {
                assert!(Instant::now() < deadline, "shell was not killed and reaped");
                thread::sleep(Duration::from_millis(2));
            }
        }
        thread::sleep(Duration::from_millis(700));
        assert!(!marker.exists(), "descendant survived dropping the output backend");
        Ok(())
    }

    #[test]
    fn shell_exit_cleans_up_background_pipe_holders() -> io::Result<()> {
        let mut output = Output::default();
        output.start(&mut shell("sleep 30 & printf finished"))?;
        finish(&mut output);
        assert_eq!(output.lines, ["finished"]);
        assert_eq!(output.status, "Exited: exit status: 0");
        Ok(())
    }

    #[test]
    fn drop_does_not_wait_for_a_full_output_channel() -> io::Result<()> {
        let mut output = Output::default();
        output.start(&mut shell("while :; do printf '%09000d' 0; done"))?;
        thread::sleep(Duration::from_millis(50));
        let start = Instant::now();
        drop(output);
        assert!(start.elapsed() < Duration::from_secs(2), "drop blocked on the reader worker");
        Ok(())
    }

    #[test]
    fn reused_command_can_start_a_new_session() -> io::Result<()> {
        let mut output = Output::default();
        let mut command = shell("printf reused");
        for _ in 0..2 {
            output.start(&mut command)?;
            finish(&mut output);
            assert_eq!(output.lines, ["reused"]);
        }
        Ok(())
    }

    #[test]
    fn fast_output_drains_completely_after_exit() -> io::Result<()> {
        let mut output = Output::default();
        output.start(&mut shell("i=0; while [ \"$i\" -lt 60 ]; do printf '%07000d\\n' \"$i\"; i=$((i+1)); done; printf FINISHED"))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while output.child.is_some() {
            output.poll();
            assert!(Instant::now() < deadline, "large producer did not exit");
            thread::sleep(Duration::from_millis(2));
        }
        // Backpressure after exit must not discard bytes already queued or in the pipe.
        thread::sleep(Duration::from_millis(100));
        finish(&mut output);
        assert_eq!(output.lines.len(), 61);
        for (i, line) in output.lines.iter().take(60).enumerate() {
            assert_eq!(line, &format!("{i:07000}"));
        }
        assert_eq!(output.lines.back().map(String::as_str), Some("FINISHED"));
        Ok(())
    }

    #[test]
    fn escaped_descendants_cannot_hold_readers_open() -> io::Result<()> {
        struct Group(u32);
        impl Drop for Group {
            fn drop(&mut self) {
                drop(crate::sys::kill_process_group(self.0));
            }
        }

        for mode in ["idle", "busy", "drop"] {
            let directory = tempfile::tempdir()?;
            let pid_file = directory.path().join("pid");
            let mut command = Command::new(std::env::current_exe()?);
            command
                .args(["--exact", "sys::tests::escaped_pipe_holder", "--nocapture"])
                .env("KIBI_OUTPUT_ESCAPED_PID", &pid_file);
            if mode == "busy" {
                command.env("KIBI_OUTPUT_BUSY_WRITER", "1");
            }
            let mut output = Output::default();
            output.start(&mut command)?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while !pid_file.exists() {
                output.poll();
                assert!(Instant::now() < deadline, "escaped descendant did not start");
                thread::sleep(Duration::from_millis(2));
            }
            let group =
                Group(std::fs::read_to_string(pid_file)?.parse().map_err(io::Error::other)?);
            if mode != "drop" {
                while output.is_running() {
                    output.poll();
                    assert!(Instant::now() < deadline, "escaped descendant kept output running");
                    thread::sleep(Duration::from_millis(2));
                }
                if mode == "idle" {
                    assert!(
                        output.lines.iter().any(|line| line == "FINISHED"),
                        "buffered output was lost"
                    );
                }
            }
            let stopped = Arc::clone(&output.stopped);
            drop(output);
            while Arc::strong_count(&stopped) != 1 {
                assert!(Instant::now() < deadline, "reader/reaper worker did not terminate");
                thread::sleep(Duration::from_millis(2));
            }
            drop(group);
        }
        Ok(())
    }
}
