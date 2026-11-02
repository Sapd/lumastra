// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use tempfile::TempDir;

#[derive(Default)]
struct Options {
    containment: Vec<PathBuf>,
    sensitive: Vec<PathBuf>,
    network: Vec<PathBuf>,
    alive_ms: Option<u64>,
}

fn init(roots: &[PathBuf], options: &Options) -> Value {
    let mut containment = roots.to_vec();
    containment.extend(options.containment.iter().cloned());
    json!({
        "type": "init", "version": 2, "paths": roots,
        "networkPaths": options.network,
        "networkReconcileSecs": if options.network.is_empty() { 0 } else { 60 },
        "stabilityMs": 500, "pollMs": 100, "aliveMs": options.alive_ms.unwrap_or(10_000),
        "policy": {
            "mediaExtensions": [".mkv", ".mp4"],
            "audioExtensions": [".mp3", ".flac"],
            "lyricsExtensions": [".lrc", ".txt"],
            "prunedDirectoryNames": ["extras", "samples", "bonus", "trailers", "video_ts", "bdmv",
                ".snapshot", ".subtitle-cache", "#recycle", "@eadir", "$recycle.bin"],
            "prunedDirectoryPrefixes": ["@", ".trash-"],
            "prunedDirectorySuffixes": [".trickplay"],
            "ignoredFilePrefixes": ["._"],
            "sampleWord": "sample",
            "ignoreFiles": { "patternFile": ".lumastraignore", "markerFile": ".ignore",
                "maxBytes": 65536, "maxPatternLength": 512, "maxPatternsPerFile": 1000,
                "maxAccumulatedPatterns": 5000 },
            "containmentRoots": containment,
            "sensitivePrefixes": options.sensitive,
        }
    })
}

struct Harness {
    child: Child,
    messages: Receiver<Value>,
}

impl Harness {
    fn new(roots: &[PathBuf]) -> Self {
        Self::start(init(roots, &Options::default()))
    }

    fn start(init: Value) -> Self {
        Self::start_with(init, &[])
    }

    fn start_with(init: Value, env: &[(&str, &Path)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_lumastra-watcher"))
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let (tx, messages) = mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        writeln!(child.stdin.as_mut().unwrap(), "{init}").unwrap();
        let mut harness = Self { child, messages };
        harness.wait(|v| v["type"] == "ready" && v["version"] == 2);
        harness
    }

    fn wait(&mut self, predicate: impl Fn(&Value) -> bool) -> Value {
        self.wait_for(Duration::from_secs(10), predicate)
    }

    fn wait_for(&mut self, within: Duration, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + within;
        loop {
            let value = self
                .messages
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("watcher message before deadline");
            assert_ne!(value["fatal"], true, "fatal watcher output: {value}");
            if predicate(&value) {
                return value;
            }
        }
    }

    fn event(&mut self, event: &str, path: &Path) {
        self.wait(|v| {
            v["type"] == "event" && v["event"] == event && v["path"] == path.to_str().unwrap()
        });
    }

    /// Wait for every (event, path) pair in any order.
    fn events(&mut self, expected: &[(&str, PathBuf)]) {
        let mut missing: BTreeSet<(String, String)> = expected
            .iter()
            .map(|(e, p)| (e.to_string(), p.to_str().unwrap().to_string()))
            .collect();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !missing.is_empty() {
            let value = self
                .messages
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("missing events: {missing:?}"));
            assert_ne!(value["fatal"], true, "fatal watcher output: {value}");
            if value["type"] == "event" {
                let key = (
                    value["event"].as_str().unwrap().to_string(),
                    value["path"].as_str().unwrap().to_string(),
                );
                missing.remove(&key);
            }
        }
    }

    fn no_event(&mut self, duration: Duration) {
        let deadline = Instant::now() + duration;
        while let Ok(value) = self
            .messages
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            assert_ne!(value["type"], "event", "unexpected file event: {value}");
            if Instant::now() >= deadline {
                break;
            }
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(mut input) = self.child.stdin.take() {
            let _ = writeln!(input, "{{\"type\":\"close\"}}");
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if self.child.try_wait().unwrap().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
            panic!("watcher did not close promptly");
        }
    }
}

/// Run `--snapshot`, bounded so an escaping walk (a link to `/`) fails instead of hanging.
fn snapshot(init: Value) -> BTreeSet<String> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lumastra-watcher"))
        .arg("--snapshot")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{init}").unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let output = rx
        .recv_timeout(Duration::from_secs(30))
        .expect("snapshot finished")
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<String>(line).unwrap())
        .collect()
}

fn set(root: &Path, names: &[&str]) -> BTreeSet<String> {
    names
        .iter()
        .map(|n| root.join(n).to_str().unwrap().to_string())
        .collect()
}

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

#[test]
fn live_media_lyrics_and_populated_directory_moves() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("@configured-root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("existing.mkv"), "initial").unwrap();
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    watcher.no_event(Duration::from_millis(600));
    let file = root.join("@Artist.FLAC");
    fs::write(&file, "a").unwrap();
    watcher.event("add", &file);
    fs::write(&file, "changed").unwrap();
    watcher.event("change", &file);
    let lyric = root.join("track.lrc");
    fs::write(&lyric, "[00:01]line").unwrap();
    watcher.event("add", &lyric);
    fs::remove_file(&lyric).unwrap();
    watcher.event("unlink", &lyric);
    let incoming = temp.path().join("incoming");
    fs::create_dir(&incoming).unwrap();
    fs::write(incoming.join("movie.mkv"), "movie").unwrap();
    let moved = root.join(".harbor Sign");
    fs::rename(&incoming, &moved).unwrap();
    watcher.event("add", &moved.join("movie.mkv"));
    fs::rename(&moved, temp.path().join("outgoing")).unwrap();
    watcher.event("unlink", &moved.join("movie.mkv"));
    fs::remove_file(&file).unwrap();
    watcher.event("unlink", &file);
}

#[test]
fn writes_must_be_stable_and_junk_does_not_emit() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().to_path_buf();
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    for dir in [
        "@eaDir",
        "film.trickplay",
        ".subtitle-cache",
        "Extras",
        "VIDEO_TS",
    ] {
        fs::create_dir(root.join(dir)).unwrap();
        fs::write(root.join(dir).join("junk.mkv"), "junk").unwrap();
    }
    for name in [
        "cover.jpg",
        "subtitle.srt",
        "metadata.nfo",
        "._track.flac",
        "Sample.mkv",
        "movie-sample.mkv",
        ".mkv",
    ] {
        fs::write(root.join(name), "junk").unwrap();
    }
    watcher.no_event(Duration::from_millis(900));
    let file = root.join("slow.mkv");
    for text in ["a", "ab", "abc", "abcd"] {
        fs::write(&file, text).unwrap();
        watcher.no_event(Duration::from_millis(180));
    }
    watcher.event("add", &file);
}

#[test]
fn folder_rename_inside_root_keeps_watching_the_new_path() {
    let temp = TempDir::new().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("tv");
    write(&root.join("Show/Season 01/x.mkv"), "episode");
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    let renamed = root.join("Show (2020)");
    fs::rename(root.join("Show"), &renamed).unwrap();
    watcher.events(&[
        ("unlink", root.join("Show/Season 01/x.mkv")),
        ("add", renamed.join("Season 01/x.mkv")),
    ]);
    let new = renamed.join("new.mkv");
    fs::write(&new, "new").unwrap();
    watcher.event("add", &new);
    let nested = renamed.join("Season 01/y.mkv");
    fs::write(&nested, "nested").unwrap();
    watcher.event("add", &nested);
    // Renaming back reuses the original name; the watch must follow again.
    fs::rename(&renamed, root.join("Show")).unwrap();
    watcher.events(&[
        ("unlink", renamed.join("Season 01/x.mkv")),
        ("add", root.join("Show/Season 01/x.mkv")),
    ]);
    let again = root.join("Show/again.mkv");
    fs::write(&again, "again").unwrap();
    watcher.event("add", &again);
}

#[cfg(unix)]
#[test]
fn symlink_roots_aliases_and_loops_are_bounded() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let real = temp.path().join("real");
    fs::create_dir(&real).unwrap();
    let alias = temp.path().join("alias");
    symlink(&real, &alias).unwrap();
    let child = real.join("child");
    fs::create_dir(&child).unwrap();
    symlink(&real, child.join("loop")).unwrap();
    symlink(&child, real.join("linked-child")).unwrap();
    let mut watcher = Harness::new(std::slice::from_ref(&alias));
    // `child` is walked first (name order) and owns the directory, as in the scanner.
    let file = alias.join("child").join("song.mp3");
    fs::write(real.join("child/song.mp3"), "music").unwrap();
    watcher.event("add", &file);
    fs::remove_file(real.join("child/song.mp3")).unwrap();
    watcher.event("unlink", &file);
    let mut options = Options::default();
    options.containment.push(alias.clone());
    fs::write(child.join("kept.mp3"), "music").unwrap();
    assert_eq!(
        snapshot(init(std::slice::from_ref(&alias), &options)),
        set(&alias, &["child/kept.mp3"])
    );
}

#[test]
fn absent_root_preserves_state_and_reappearance_resumes() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("existing.mkv"), "initial").unwrap();
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    fs::rename(&root, temp.path().join("away")).unwrap();
    watcher.wait(|v| v["type"] == "rescan");
    watcher.no_event(Duration::from_millis(650));
    fs::create_dir(&root).unwrap();
    let file = root.join("new.mkv");
    fs::write(&file, "new").unwrap();
    watcher.event("add", &file);
    fs::write(&file, "changed after root replacement").unwrap();
    watcher.event("change", &file);
}

#[cfg(unix)]
#[test]
fn unreadable_directory_does_not_emit_mass_unlinks() {
    use std::os::unix::fs::PermissionsExt;
    let temp = TempDir::new().unwrap();
    let root = temp.path().to_path_buf();
    let child = root.join("child");
    fs::create_dir(&child).unwrap();
    fs::write(child.join("existing.mkv"), "initial").unwrap();
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    watcher.wait(|v| v["type"] == "status" && v["coverage"] == "full");
    // Write and search but no read: entries can be created, the listing fails.
    fs::set_permissions(&child, fs::Permissions::from_mode(0o300)).unwrap();
    let observed_error = fs::read_dir(&child).is_err();
    // This suite runs as the runner's unprivileged identity; root would invalidate the fixture.
    assert!(
        observed_error,
        "unreadable fixture requires non-root test execution"
    );
    let file = child.join("new.mkv");
    fs::write(&file, "new").unwrap();
    let error = watcher.wait(|v| v["type"] == "error");
    assert_eq!(error["code"], "permission");
    watcher.wait(|v| v["type"] == "rescan");
    watcher.no_event(Duration::from_millis(900));
    let status = watcher.wait(|v| v["type"] == "status");
    assert_eq!(status["coverage"], "partial");
    assert_eq!(status["failedDirs"], 1);
    assert_eq!(status["failedSample"][0], child.to_str().unwrap());
    fs::set_permissions(&child, fs::Permissions::from_mode(0o700)).unwrap();
    // The failed directory is retried with backoff (5 s, then 10 s), not on its chmod event.
    watcher.wait_for(Duration::from_secs(20), |v| {
        v["type"] == "event" && v["event"] == "add" && v["path"] == file.to_str().unwrap()
    });
}

#[test]
fn version_command_and_invalid_protocol_are_visible() {
    let output = Command::new(env!("CARGO_BIN_EXE_lumastra-watcher"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "lumastra-watcher 0.1.0 protocol 2\n"
    );
    assert!(
        !Command::new(env!("CARGO_BIN_EXE_lumastra-watcher"))
            .arg("--unknown")
            .status()
            .unwrap()
            .success()
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_lumastra-watcher"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"type": "init", "version": 999})
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let last: Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(last["type"], "error");
    assert_eq!(last["fatal"], true);
    for frame in ["{\"type\":\"init\",\"version\":999}".to_string(), {
        let mut v1 = init(&[PathBuf::from("/tmp")], &Options::default());
        v1["version"] = json!(1);
        v1.to_string()
    }] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_lumastra-watcher"))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        writeln!(child.stdin.take().unwrap(), "{frame}").unwrap();
        assert!(!child.wait().unwrap().success());
    }
}

#[cfg(unix)]
#[test]
fn symlink_file_target_changes_and_reappearance_are_observed() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    let target = temp.path().join("physical.bin");
    fs::write(&target, "old").unwrap();
    let link = root.join("linked.mkv");
    symlink(&target, &link).unwrap();
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    fs::write(&target, "changed").unwrap();
    watcher.event("change", &link);
    // A dangling link is an inspection error like in the scanner: state is kept, the link
    // counts as refused, the directory itself is not failed.
    fs::remove_file(&target).unwrap();
    let deadline = Instant::now() + Duration::from_millis(900);
    while let Ok(value) = watcher
        .messages
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
    {
        assert_ne!(value["type"], "event", "unexpected file event: {value}");
        assert_ne!(
            value["type"], "rescan",
            "dangling link caused a rescan: {value}"
        );
        assert_ne!(
            value["type"], "error",
            "dangling link caused an error: {value}"
        );
    }
    fs::write(&target, "returned").unwrap();
    // No failure was recorded, so coverage never changed and no new status was needed.
    watcher.event("change", &link);
}

#[cfg(unix)]
#[test]
fn directory_symlink_target_reappears_without_waiting_for_retry_scan() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let links = temp.path().join("links");
    fs::create_dir(&links).unwrap();
    let targets = temp.path().join("targets");
    fs::create_dir(&targets).unwrap();
    let target = targets.join("library");
    fs::create_dir(&target).unwrap();
    let root = links.join("library");
    symlink(&target, &root).unwrap();
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    fs::rename(&target, targets.join("away")).unwrap();
    watcher.wait(|v| v["type"] == "rescan");
    fs::create_dir(&target).unwrap();
    let physical = target.join("returned.mkv");
    fs::write(&physical, "new").unwrap();
    let logical = root.join("returned.mkv");
    // The retry interval is five seconds; this deadline proves native parent-event recovery.
    watcher.wait_for(Duration::from_secs(3), |v| {
        v["type"] == "event" && v["event"] == "add" && v["path"] == logical.to_str().unwrap()
    });
}

#[test]
fn unknown_control_frame_fails_instead_of_being_accepted_as_close() {
    let temp = TempDir::new().unwrap();
    let mut watcher = Harness::new(&[temp.path().to_path_buf()]);
    writeln!(
        watcher.child.stdin.as_mut().unwrap(),
        "{{\"type\":\"unknown\"}}"
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = watcher.child.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "invalid control frame did not stop child"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn newly_created_symlink_file_observes_later_target_changes() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    let target = temp.path().join("target.bin");
    fs::write(&target, "old").unwrap();
    fs::write(root.join("keep.mkv"), "keep").unwrap();
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    let alias = root.join("live.mkv");
    symlink(&target, &alias).unwrap();
    watcher.event("add", &alias);
    fs::write(&target, "changed after alias creation").unwrap();
    watcher.event("change", &alias);
    fs::remove_file(&alias).unwrap();
    watcher.event("unlink", &alias);
}

#[test]
fn snapshot_applies_scanner_eligibility() {
    let temp = TempDir::new().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("library");
    for name in [
        "Movie (2020)/Movie (2020).mkv",
        "Movie (2020)/Sample.mkv",
        "Movie (2020)/movie-sample.mkv",
        "Movie (2020)/resample.mkv",
        "Movie (2020)/my_sample.mkv",
        "Movie (2020)/extras/bonus.mkv",
        "Movie (2020)/Trailers/t.mkv",
        "Movie (2020)/film.trickplay/x.mkv",
        "Movie (2020)/BDMV/stream.mkv",
        "@eaDir/x.mkv",
        ".harbor Sign/ep.mkv",
        "._hidden.mkv",
        "..mkv",
        ".mkv",
        "a.",
        "cover.jpg",
        "notes.TXT",
        "Album/track.FLAC",
        "Album/track.lrc",
        "Ignored/x.mkv",
        "Ignored/deeper/y.mkv",
        "Patterned/skip-1.mkv",
        "Patterned/keep.mkv",
        "Patterned/Sub/deep.mkv",
        "Patterned/Sub/Inner/kept.mkv",
        "Oversize/x.mkv",
        "root.mkv",
    ] {
        write(&root.join(name), "x");
    }
    // Empty marker below the root skips the subtree; at the root it is refused.
    write(&root.join("Ignored/.ignore"), "# only a comment\n");
    write(&root.join(".ignore"), "");
    // Patterns with `/` match the path relative to the library root.
    write(
        &root.join("Patterned/.lumastraignore"),
        "# comment\nskip-*.mkv\nPatterned/Sub/*.mkv\n",
    );
    write(&root.join("Oversize/.lumastraignore"), &"x".repeat(70_000));
    let expected = set(
        &root,
        &[
            "Movie (2020)/Movie (2020).mkv",
            "Movie (2020)/resample.mkv",
            "Movie (2020)/my_sample.mkv",
            ".harbor Sign/ep.mkv",
            "..mkv",
            "notes.TXT",
            "Album/track.FLAC",
            "Album/track.lrc",
            "Patterned/keep.mkv",
            "Patterned/Sub/Inner/kept.mkv",
            "root.mkv",
        ],
    );
    assert_eq!(
        snapshot(init(std::slice::from_ref(&root), &Options::default())),
        expected
    );
}

#[cfg(unix)]
#[test]
fn file_symlinks_follow_scanner_containment() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let base = fs::canonicalize(temp.path()).unwrap();
    let root = base.join("library");
    let sensitive = base.join("config");
    let outside = base.join("debrid");
    write(&sensitive.join("master.key"), "secret");
    write(&outside.join("film.bin"), "film");
    write(&outside.join("lyrics.bin"), "lyrics");
    write(&root.join("real.lrc"), "[00:01]");
    symlink(sensitive.join("master.key"), root.join("01.mp3")).unwrap();
    symlink(outside.join("film.bin"), root.join("linked.mkv")).unwrap();
    symlink(outside.join("lyrics.bin"), root.join("song.lrc")).unwrap();
    symlink(root.join("real.lrc"), root.join("inside.lrc")).unwrap();
    let options = Options {
        sensitive: vec![sensitive.clone()],
        ..Options::default()
    };
    let config = init(std::slice::from_ref(&root), &options);
    assert_eq!(
        snapshot(config.clone()),
        set(&root, &["inside.lrc", "linked.mkv", "real.lrc"])
    );
    let mut watcher = Harness::start(config);
    let status = watcher.wait(|v| v["type"] == "status");
    assert_eq!(status["refusedSymlinks"], 2);
    assert_eq!(status["coverage"], "full");
    let refused = root.join("02.flac");
    symlink(sensitive.join("master.key"), &refused).unwrap();
    let lyrics = root.join("live.txt");
    symlink(outside.join("lyrics.bin"), &lyrics).unwrap();
    watcher.no_event(Duration::from_millis(1200));
    let allowed = root.join("live.mkv");
    symlink(outside.join("film.bin"), &allowed).unwrap();
    watcher.event("add", &allowed);
}

#[cfg(unix)]
#[test]
fn directory_symlinks_cannot_escape_the_root() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let base = fs::canonicalize(temp.path()).unwrap();
    let root = base.join("library");
    let outside = base.join("outside");
    write(&outside.join("escaped.mkv"), "x");
    write(&root.join("inside/ok.mkv"), "x");
    symlink(&outside, root.join("escape")).unwrap();
    symlink("/", root.join("slash")).unwrap();
    symlink(&root, root.join("inside/loop")).unwrap();
    let config = init(std::slice::from_ref(&root), &Options::default());
    assert_eq!(snapshot(config.clone()), set(&root, &["inside/ok.mkv"]));
    let mut watcher = Harness::start(config);
    let status = watcher.wait(|v| v["type"] == "status");
    assert_eq!(status["refusedSymlinks"], 2);
    write(&outside.join("new.mkv"), "x");
    watcher.no_event(Duration::from_millis(900));
    let inside = root.join("inside/new.mkv");
    write(&inside, "x");
    watcher.event("add", &inside);
}

#[cfg(target_os = "linux")]
#[test]
fn status_and_alive_frames_follow_ready() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let temp = TempDir::new().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    fs::write(root.join(OsStr::from_bytes(b"bad\xff.mkv")), "x").unwrap();
    fs::write(root.join("good.mkv"), "x").unwrap();
    let options = Options {
        network: vec![root.clone()],
        alive_ms: Some(200),
        ..Options::default()
    };
    let config = init(std::slice::from_ref(&root), &options);
    assert_eq!(snapshot(config.clone()), set(&root, &["good.mkv"]));
    let mut watcher = Harness::start(config);
    let status = watcher.wait(|v| v["type"] == "status");
    assert_eq!(status["coverage"], "full");
    assert_eq!(status["watchLimit"], false);
    assert_eq!(status["nonUtf8Skipped"], 1);
    assert_eq!(status["failedDirs"], 0);
    assert_eq!(status["networkRoots"], json!([root.to_str().unwrap()]));
    assert!(status["watchedDirs"].as_u64().unwrap() >= 1);
    let first = watcher.wait(|v| v["type"] == "alive")["seq"]
        .as_u64()
        .unwrap();
    let second = watcher.wait(|v| v["type"] == "alive")["seq"]
        .as_u64()
        .unwrap();
    assert_eq!(second, first + 1);
}

#[test]
fn live_ignore_files_add_and_remove_files() {
    let temp = TempDir::new().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap().join("library");
    write(&root.join("keep.mkv"), "keep");
    write(&root.join("skip-1.mkv"), "skip");
    write(&root.join("Show/S1/e1.mkv"), "episode");
    write(&root.join("Show/S1/e2.mkv"), "episode");
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    let patterns = root.join(".lumastraignore");
    fs::write(&patterns, "skip-*.mkv\n").unwrap();
    watcher.event("unlink", &root.join("skip-1.mkv"));
    fs::remove_file(&patterns).unwrap();
    watcher.event("add", &root.join("skip-1.mkv"));
    let marker = root.join("Show/.ignore");
    fs::write(&marker, "").unwrap();
    watcher.events(&[
        ("unlink", root.join("Show/S1/e1.mkv")),
        ("unlink", root.join("Show/S1/e2.mkv")),
    ]);
    fs::remove_file(&marker).unwrap();
    watcher.events(&[
        ("add", root.join("Show/S1/e1.mkv")),
        ("add", root.join("Show/S1/e2.mkv")),
    ]);
    // A refused ignore file fails closed: the directory is skipped without removals.
    fs::write(root.join("Show/.lumastraignore"), "x".repeat(70_000)).unwrap();
    let status = watcher.wait(|v| v["type"] == "status" && v["failedDirs"] == 1);
    assert_eq!(status["coverage"], "partial");
    assert_eq!(
        status["failedSample"][0],
        root.join("Show").to_str().unwrap()
    );
    watcher.no_event(Duration::from_millis(300));
}

#[cfg(unix)]
#[test]
fn symlinked_ignore_file_target_edits_apply() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    let base = fs::canonicalize(temp.path()).unwrap();
    let root = base.join("library");
    let shared = base.join("ignores");
    write(&root.join("keep.mkv"), "keep");
    write(&root.join("skip-1.mkv"), "skip");
    write(&shared.join("library.ignore"), "# nothing yet\n");
    symlink(shared.join("library.ignore"), root.join(".lumastraignore")).unwrap();
    let options = Options {
        containment: vec![shared.clone()],
        ..Options::default()
    };
    let mut watcher = Harness::start(init(std::slice::from_ref(&root), &options));
    fs::write(shared.join("library.ignore"), "skip-*.mkv\n").unwrap();
    watcher.event("unlink", &root.join("skip-1.mkv"));
}

#[test]
fn emptied_root_preserves_state_like_an_unmounted_share() {
    let temp = TempDir::new().unwrap();
    let base = fs::canonicalize(temp.path()).unwrap();
    let root = base.join("library");
    write(&root.join("a.mkv"), "a");
    write(&root.join("Show/b.mkv"), "b");
    let mut watcher = Harness::new(std::slice::from_ref(&root));
    fs::rename(root.join("a.mkv"), base.join("a.mkv")).unwrap();
    fs::rename(root.join("Show"), base.join("Show")).unwrap();
    let status = watcher.wait(|v| v["type"] == "status" && v["failedDirs"] == 1);
    assert_eq!(status["coverage"], "partial");
    watcher.no_event(Duration::from_millis(300));
    // Content coming back is a normal listing again.
    let new = root.join("new.mkv");
    fs::write(&new, "new").unwrap();
    watcher.event("add", &new);
}

/// One root on a hung mount must not stop the others. Debug builds simulate the hang: every
/// filesystem call the child makes for a path under `LUMASTRA_WATCHER_TEST_HANG` blocks
/// while `<dir>.hang` exists, on that root's own worker threads, like a dead NFS server.
#[cfg(debug_assertions)]
#[test]
fn hung_root_does_not_stall_other_roots_or_alive() {
    let temp = TempDir::new().unwrap();
    let base = fs::canonicalize(temp.path()).unwrap();
    let healthy = base.join("healthy");
    let hung = base.join("hung");
    write(&healthy.join("film.mkv"), "x");
    write(&hung.join("old.mkv"), "x");
    let flag = base.join("hung.hang");
    fs::write(&flag, "").unwrap();
    let options = Options {
        alive_ms: Some(1000),
        ..Options::default()
    };
    let config = init(&[healthy.clone(), hung.clone()], &options);
    let started = Instant::now();
    let mut watcher = Harness::start_with(config, &[("LUMASTRA_WATCHER_TEST_HANG", &hung)]);
    // Ready once the hung root missed the 1 s deadline, instead of waiting for it.
    assert!(started.elapsed() < Duration::from_secs(8));
    let stalled = json!([hung.to_str().unwrap()]);
    let status = watcher.wait(|v| v["type"] == "status" && v["stalledRoots"] == stalled);
    assert_eq!(status["coverage"], "partial");

    let added = healthy.join("new.mkv");
    write(&added, "x");
    watcher.event("add", &added);
    let first = watcher.wait(|v| v["type"] == "alive")["seq"]
        .as_u64()
        .unwrap();
    let second = watcher.wait(|v| v["type"] == "alive")["seq"]
        .as_u64()
        .unwrap();
    assert!(second > first);
    let changed = healthy.join("film.mkv");
    write(&changed, "longer");
    watcher.event("change", &changed);

    // The mount answers again: the root finishes its walk and is observed from then on.
    fs::remove_file(&flag).unwrap();
    watcher.wait(|v| v["type"] == "rescan");
    watcher.wait(|v| v["type"] == "status" && v["stalledRoots"] == json!([]));
    std::thread::sleep(Duration::from_millis(300));
    let after = hung.join("after.mkv");
    write(&after, "x");
    // Its late initial walk stays silent: old.mkv was there before and is not announced.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let value = watcher
            .messages
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("add for after.mkv");
        if value["type"] != "event" {
            continue;
        }
        assert_ne!(
            value["path"],
            hung.join("old.mkv").to_str().unwrap(),
            "{value}"
        );
        if value["event"] == "add" && value["path"] == after.to_str().unwrap() {
            break;
        }
    }
}
