// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Write-stability stats, run on the file's root's stat lane (`lanes`).

use crate::policy::{Containment, FileKind, Link, resolve_link};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Change detection uses size and modification time only: device and inode numbers are
/// unstable on FUSE, rclone, SMB and overlay mounts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub modified: Option<SystemTime>,
}

impl Fingerprint {
    pub fn of(metadata: &fs::Metadata) -> Self {
        Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

pub type FileId = (usize, PathBuf);

pub enum Probe {
    /// A regular file (or an allowed symlink to one) with its resolved target.
    File {
        fingerprint: Fingerprint,
        target: Option<PathBuf>,
    },
    /// Missing, not a file, refused by containment, or not inspectable.
    Unavailable,
}

pub struct ProbeResult {
    pub id: FileId,
    pub ticket: u64,
    pub outcome: Probe,
}

pub fn probe(path: &Path, kind: FileKind, containment: &Containment, extras: &[PathBuf]) -> Probe {
    let Ok(lstat) = fs::symlink_metadata(path) else {
        return Probe::Unavailable;
    };
    if lstat.file_type().is_symlink() {
        return match resolve_link(path) {
            Link::File(real, meta) if containment.file_link_allowed(kind, &real, extras) => {
                Probe::File {
                    fingerprint: Fingerprint::of(&meta),
                    target: Some(real),
                }
            }
            _ => Probe::Unavailable,
        };
    }
    if lstat.is_file() {
        Probe::File {
            fingerprint: Fingerprint::of(&lstat),
            target: None,
        }
    } else {
        Probe::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn fingerprint_ignores_inode_identity() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a.mkv");
        let second = dir.path().join("b.mkv");
        fs::write(&first, "same").unwrap();
        fs::write(&second, "same").unwrap();
        let when = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        for path in [&first, &second] {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(when)
                .unwrap();
        }
        let a = Fingerprint::of(&fs::metadata(&first).unwrap());
        let b = Fingerprint::of(&fs::metadata(&second).unwrap());
        assert_eq!(a, b);
        fs::write(&second, "different").unwrap();
        assert_ne!(a, Fingerprint::of(&fs::metadata(&second).unwrap()));
    }
}
