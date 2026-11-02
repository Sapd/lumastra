// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Cross-process ownership distinguishes crashed generations from live replicas.
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const OWNER_MAGIC: &str = "lumastra-native-proxy-generation-v1\n";
pub struct MediaGeneration {
    root: PathBuf,
    _owner: File,
}
impl MediaGeneration {
    pub fn path(&self) -> &Path {
        &self.root
    }
    pub async fn create(parent: PathBuf) -> Result<Self, String> {
        tokio::task::spawn_blocking(move || create_owned(&parent))
            .await
            .map_err(|_| "media_generation_task_failed")?
    }
    pub async fn cleanup(self) {
        let _ = tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(&self.root);
            drop(self);
        })
        .await;
    }
}
#[cfg(unix)]
fn try_lock(file: &File) -> bool {
    use std::os::fd::AsRawFd;
    // The descriptor stays owned for the complete generation lifetime. flock is
    // released by the kernel on crash, including SIGKILL, unlike a PID marker.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}
#[cfg(unix)]
fn create_owned(parent: &Path) -> Result<MediaGeneration, String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(parent).map_err(|_| "media_root_unavailable")?;
    let global = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(parent.join(".native-generations.lock"))
        .map_err(|_| "media_generation_lock_unavailable")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !try_lock(&global) {
        if std::time::Instant::now() >= deadline {
            return Err("media_generation_lock_busy".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let entries = std::fs::read_dir(parent).map_err(|_| "media_root_unavailable")?;
    for entry in entries.take(1024).flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(nonce) = name.strip_prefix("instance-") else {
            continue;
        };
        if nonce.len() != 32
            || !nonce.bytes().all(|c| c.is_ascii_hexdigit())
            || !entry.file_type().is_ok_and(|t| t.is_dir())
        {
            continue;
        }
        let Ok(mut owner) = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(entry.path().join(".owner.lock"))
        else {
            continue;
        };
        if !owner.metadata().is_ok_and(|m| m.is_file()) || !try_lock(&owner) {
            continue;
        }
        let mut marker = String::new();
        if (&mut owner).take(128).read_to_string(&mut marker).is_ok() && marker == OWNER_MAGIC {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|_| "media_generation_entropy_failed")?;
    let nonce = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let root = parent.join(format!("instance-{nonce}"));
    std::fs::create_dir(&root).map_err(|_| "media_generation_unavailable")?;
    let mut owner = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join(".owner.lock"))
        .map_err(|_| "media_generation_owner_unavailable")?;
    if !try_lock(&owner) {
        return Err("media_generation_owner_busy".into());
    }
    owner
        .write_all(OWNER_MAGIC.as_bytes())
        .map_err(|_| "media_generation_owner_unavailable")?;
    owner
        .sync_data()
        .map_err(|_| "media_generation_owner_unavailable")?;
    drop(global);
    Ok(MediaGeneration {
        root,
        _owner: owner,
    })
}
#[cfg(not(unix))]
fn create_owned(_parent: &Path) -> Result<MediaGeneration, String> {
    Err("media_generation_platform_unsupported".into())
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn restart_reclaims_crashed_media_and_preserves_live_and_unowned_paths() {
        let mut nonce = [0; 8];
        getrandom::fill(&mut nonce).unwrap();
        let parent = std::env::temp_dir().join(format!(
            "native-generation-test-{}-{:x}",
            std::process::id(),
            u64::from_ne_bytes(nonce)
        ));
        let live = MediaGeneration::create(parent.clone()).await.unwrap();
        std::fs::write(live.path().join("live.ts"), b"live").unwrap();
        let crashed = MediaGeneration::create(parent.clone()).await.unwrap();
        let old = crashed.path().to_owned();
        std::fs::write(old.join("stale.ts"), b"stale").unwrap();
        drop(crashed);
        let unrelated = parent.join("instance-00000000000000000000000000000000");
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(unrelated.join("data"), b"operator-owned").unwrap();
        // Parallel process tests may fork while this test still owns the old
        // descriptor. CLOEXEC releases that inherited lock at exec, not fork.
        // Recovery deliberately skips every locked owner, so allow subsequent
        // startups to reclaim it once that transient child descriptor closes.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let next = loop {
            let next = MediaGeneration::create(parent.clone()).await.unwrap();
            if !old.exists() {
                break next;
            }
            next.cleanup().await;
            assert!(
                std::time::Instant::now() < deadline,
                "crashed generation remained locked"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        assert!(!old.exists());
        assert!(live.path().join("live.ts").is_file());
        assert!(unrelated.join("data").is_file());
        assert_ne!(next.path(), live.path());
        next.cleanup().await;
        live.cleanup().await;
        std::fs::remove_dir_all(parent).unwrap();
    }
}
