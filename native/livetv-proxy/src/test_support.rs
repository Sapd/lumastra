// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Helpers shared by unit tests.

use std::path::Path;

/// Makes a just-written test script executable without the ETXTBSY race.
///
/// Tests run in parallel threads and many of them spawn children. A fork in another thread
/// while this process holds the script open for writing hands that child the writable
/// descriptor until it execs, and exec of the script then fails with "Text file busy". A
/// separate `install` process writes the final file, so no descriptor of this process ever
/// refers to the inode that is executed.
pub(crate) fn seal_executable(path: impl AsRef<Path>, mode: u32) {
    let path = path.as_ref();
    let mut source = path.as_os_str().to_owned();
    source.push(".source");
    std::fs::rename(path, &source).unwrap();
    let status = std::process::Command::new("install")
        .arg("-m")
        .arg(format!("{mode:o}"))
        .arg(&source)
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success(), "install {}", path.display());
    std::fs::remove_file(&source).unwrap();
}
