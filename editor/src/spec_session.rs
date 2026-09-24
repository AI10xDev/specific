// SPDX-License-Identifier: MIT OR Apache-2.0

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

/// One editor's durable inbox. Dropping it must not interrupt the detached build.
pub struct SpecSession {
    pub(crate) directory: PathBuf,
    sequence: u64,
}

impl SpecSession {
    pub(crate) fn new() -> io::Result<Self> {
        let root =
            std::env::var_os("XDG_STATE_HOME").filter(|value| !value.is_empty()).map_or_else(
                || {
                    std::env::var_os("HOME").map_or_else(std::env::temp_dir, |home| {
                        PathBuf::from(home).join(".local/state")
                    })
                },
                PathBuf::from,
            );
        let root = root.join("spec/sessions");
        fs::create_dir_all(&root)?;
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(io::Error::other)?;
        let directory = root.join(format!("{}-{}", std::process::id(), timestamp.as_nanos()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&directory)?;
        Ok(Self { directory, sequence: 0 })
    }

    pub(crate) fn publish(&mut self, spec: &Path) -> io::Result<()> {
        let text = fs::read_to_string(spec)?;
        if text.trim().is_empty() {
            return Err(io::Error::other("The spec is empty"));
        }
        let message = serde_json::to_vec(&serde_json::json!({ "text": text }))?;
        if message.len() > 8 * 1024 * 1024 {
            return Err(io::Error::other("The spec update exceeds 8 MiB"));
        }
        self.sequence += 1;
        let destination = self.directory.join(format!("{:020}.json", self.sequence));
        let temporary = destination.with_extension("tmp");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(&message)?;
        file.sync_all()?;
        // The runner only sees complete, immutable snapshots, never a half-written save.
        fs::rename(temporary, destination)?;
        #[cfg(unix)]
        fs::File::open(&self.directory)?.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishes_immutable_ordered_snapshots() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let spec = root.path().join("spec");
        let mut session = SpecSession { directory: root.path().to_path_buf(), sequence: 0 };
        fs::write(&spec, "first \"quoted\"\n\\path\t")?;
        session.publish(&spec)?;
        fs::write(&spec, "second")?;
        session.publish(&spec)?;
        for (sequence, expected) in [(1, "first \"quoted\"\n\\path\t"), (2, "second")] {
            let file = root.path().join(format!("{sequence:020}.json"));
            let value: serde_json::Value = serde_json::from_reader(fs::File::open(&file)?)?;
            assert_eq!(value["text"], expected);
            assert!(!file.with_extension("tmp").exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(fs::metadata(file)?.permissions().mode() & 0o777, 0o600);
            }
        }
        drop(session);
        assert!(root.path().join("00000000000000000001.json").exists());
        Ok(())
    }

    #[test]
    fn invalid_updates_are_not_published() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let spec = root.path().join("spec");
        let mut session = SpecSession { directory: root.path().to_path_buf(), sequence: 0 };
        assert!(session.publish(&spec).is_err());
        fs::write(&spec, " \n")?;
        assert!(session.publish(&spec).is_err());
        fs::write(&spec, vec![b'a'; 8 * 1024 * 1024])?;
        assert!(session.publish(&spec).is_err());
        assert_eq!(session.sequence, 0);
        Ok(())
    }
}
