// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

mod engine;
mod lanes;
mod lister;
mod output;
pub mod policy;
mod probe;

pub use engine::{
    Engine, ModifyCoalescer, NullBackend, Raw, WatchBackend, WatchError, make_watcher, raw_waker,
};
pub use lanes::Waker;
pub use output::{Output, write_output};

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};
use std::path::PathBuf;

pub const PROTOCOL_VERSION: u32 = 2;
pub const MAX_LINE: usize = 1024 * 1024;
pub const RAW_CAPACITY: usize = 4096;
pub const PENDING_CAPACITY: usize = 8192;
pub const OUTPUT_CAPACITY: usize = 4096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IgnoreFiles {
    pub pattern_file: String,
    pub marker_file: String,
    pub max_bytes: u64,
    pub max_pattern_length: usize,
    pub max_patterns_per_file: usize,
    pub max_accumulated_patterns: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub media_extensions: Vec<String>,
    pub audio_extensions: Vec<String>,
    pub lyrics_extensions: Vec<String>,
    pub pruned_directory_names: Vec<String>,
    pub pruned_directory_prefixes: Vec<String>,
    pub pruned_directory_suffixes: Vec<String>,
    pub ignored_file_prefixes: Vec<String>,
    pub sample_word: String,
    pub ignore_files: IgnoreFiles,
    pub containment_roots: Vec<PathBuf>,
    pub sensitive_prefixes: Vec<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Init {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u32,
    pub paths: Vec<PathBuf>,
    pub network_paths: Vec<PathBuf>,
    pub network_reconcile_secs: u64,
    pub policy: Policy,
    pub stability_ms: u64,
    pub poll_ms: u64,
    pub alive_ms: u64,
}

fn valid_file_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 255 && !name.contains('/') && name != "." && name != ".."
}

impl Init {
    pub fn validate(&self) -> Result<(), String> {
        if self.kind != "init" || self.version != PROTOCOL_VERSION {
            return Err("unsupported watcher protocol".into());
        }
        if self.paths.is_empty()
            || self.paths.len() > 1024
            || self.paths.iter().any(|p| !p.is_absolute())
        {
            return Err("paths must contain 1..1024 absolute roots".into());
        }
        if self.network_paths.len() > self.paths.len()
            || self.network_paths.iter().any(|p| !self.paths.contains(p))
        {
            return Err("networkPaths must be a subset of paths".into());
        }
        if self.network_reconcile_secs != 0 && !(60..=86_400).contains(&self.network_reconcile_secs)
        {
            return Err("networkReconcileSecs must be 0 or 60..86400".into());
        }
        if self.stability_ms != 500 || self.poll_ms != 100 {
            return Err("unsupported write stability policy (expected 500/100 ms)".into());
        }
        if !(100..=600_000).contains(&self.alive_ms) {
            return Err("aliveMs must be 100..600000".into());
        }
        let policy = &self.policy;
        for entries in [
            &policy.media_extensions,
            &policy.audio_extensions,
            &policy.lyrics_extensions,
            &policy.pruned_directory_names,
            &policy.pruned_directory_prefixes,
            &policy.pruned_directory_suffixes,
            &policy.ignored_file_prefixes,
        ] {
            if entries.len() > 1024 || entries.iter().any(|s| s.is_empty() || s.len() > 1024) {
                return Err("invalid filename policy".into());
            }
        }
        let extensions = policy
            .media_extensions
            .iter()
            .chain(&policy.audio_extensions)
            .chain(&policy.lyrics_extensions);
        if policy.media_extensions.is_empty()
            || extensions
                .clone()
                .any(|e| !e.starts_with('.') || e.len() < 2)
        {
            return Err("invalid extension policy".into());
        }
        let word = policy.sample_word.as_bytes();
        if word.is_empty()
            || word.len() > 64
            || !word.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
        {
            return Err("sampleWord must be 1..64 ASCII word characters".into());
        }
        let ignore = &policy.ignore_files;
        if !valid_file_name(&ignore.pattern_file)
            || !valid_file_name(&ignore.marker_file)
            || !(1..=16 * 1024 * 1024).contains(&ignore.max_bytes)
            || !(1..=65_536).contains(&ignore.max_pattern_length)
            || !(1..=100_000).contains(&ignore.max_patterns_per_file)
            || !(1..=1_000_000).contains(&ignore.max_accumulated_patterns)
        {
            return Err("invalid ignore-file policy".into());
        }
        for roots in [&policy.containment_roots, &policy.sensitive_prefixes] {
            if roots.len() > 4096 || roots.iter().any(|p| !p.is_absolute()) {
                return Err("containment roots and sensitive prefixes must be absolute".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub coverage: &'static str,
    pub watched_dirs: usize,
    pub failed_dirs: usize,
    pub failed_sample: Vec<String>,
    pub watch_limit: bool,
    /// Library directories that are listed but have no native watch right now.
    pub unwatched_dirs: usize,
    /// A stability stat has not returned within the stall deadline (hung mount).
    pub stalled_probes: bool,
    /// Library roots whose filesystem calls have not returned within the stall deadline
    /// (`aliveMs`, 1..30 s). Other roots keep being observed; coverage is partial.
    pub stalled_roots: Vec<String>,
    pub non_utf8_skipped: u64,
    pub refused_symlinks: u64,
    pub network_roots: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Message {
    Ready {
        version: u32,
    },
    Event {
        event: &'static str,
        path: String,
    },
    Status(Status),
    Error {
        message: String,
        fatal: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'static str>,
    },
    Rescan {
        reason: String,
    },
    Alive {
        seq: u64,
    },
}

/// Read one bounded NDJSON frame without allowing read_line to allocate forever.
pub fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "unterminated frame",
                ))
            };
        }
        let end = chunk.iter().position(|b| *b == b'\n');
        let count = end.map_or(chunk.len(), |i| i + 1);
        if line.len() + count > MAX_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "watcher frame exceeds 1 MiB",
            ));
        }
        line.extend_from_slice(&chunk[..count]);
        reader.consume(count);
        if end.is_some() {
            line.pop();
            return Ok(Some(line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_are_bounded_and_must_be_terminated() {
        assert!(read_frame(&mut Cursor::new(vec![b'x'; MAX_LINE + 1])).is_err());
        assert!(read_frame(&mut Cursor::new(b"unterminated")).is_err());
        assert_eq!(
            read_frame(&mut Cursor::new(b"{}\n")).unwrap(),
            Some(b"{}".to_vec())
        );
    }

    fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/protocol.json")).unwrap()
    }

    #[test]
    fn golden_protocol_and_version_validation() {
        let golden = golden();
        let init: Init = serde_json::from_value(golden["init"].clone()).unwrap();
        init.validate().unwrap();
        let encoded = |m: Message| serde_json::to_value(m).unwrap();
        assert_eq!(
            encoded(Message::Ready {
                version: PROTOCOL_VERSION
            }),
            golden["ready"]
        );
        assert_eq!(
            encoded(Message::Event {
                event: "unlink",
                path: "/media/tv/example.mkv".into()
            }),
            golden["event"]
        );
        assert_eq!(
            encoded(Message::Status(Status {
                coverage: "partial",
                watched_dirs: 412,
                failed_dirs: 1,
                failed_sample: vec!["/media/tv/Locked".into()],
                watch_limit: false,
                unwatched_dirs: 0,
                stalled_probes: false,
                stalled_roots: vec!["/media/music".into()],
                non_utf8_skipped: 2,
                refused_symlinks: 1,
                network_roots: vec!["/media/music".into()],
            })),
            golden["status"]
        );
        assert_eq!(encoded(Message::Alive { seq: 7 }), golden["alive"]);
        assert_eq!(
            encoded(Message::Error {
                message: "temporary filesystem observation failure".into(),
                fatal: false,
                code: None
            }),
            golden["error"]
        );
        assert_eq!(
            encoded(Message::Error {
                message: "raise fs.inotify.max_user_watches; 8192/9000 dirs watched".into(),
                fatal: false,
                code: Some("watch_limit")
            }),
            golden["errorWithCode"]
        );
        assert_eq!(
            encoded(Message::Rescan {
                reason: "watcher output queue overflow; events were dropped".into()
            }),
            golden["rescan"]
        );
        for version in [0, 1, 3] {
            let mut changed = init.clone();
            changed.version = version;
            assert!(changed.validate().is_err());
        }
    }

    #[test]
    fn init_rejects_inconsistent_options() {
        let base: Init = serde_json::from_value(golden()["init"].clone()).unwrap();
        let mut network = base.clone();
        network.network_paths = vec!["/elsewhere".into()];
        assert!(network.validate().is_err());
        let mut interval = base.clone();
        interval.network_reconcile_secs = 30;
        assert!(interval.validate().is_err());
        let mut off = base.clone();
        off.network_reconcile_secs = 0;
        assert!(off.validate().is_ok());
        let mut word = base.clone();
        word.policy.sample_word = "sam ple".into();
        assert!(word.validate().is_err());
        let mut marker = base.clone();
        marker.policy.ignore_files.marker_file = "a/b".into();
        assert!(marker.validate().is_err());
        let mut relative = base;
        relative.policy.sensitive_prefixes = vec!["config".into()];
        assert!(relative.validate().is_err());
        let mut unknown = golden()["init"].clone();
        unknown["extensions"] = serde_json::json!([".mkv"]);
        assert!(serde_json::from_value::<Init>(unknown).is_err());
    }
}
