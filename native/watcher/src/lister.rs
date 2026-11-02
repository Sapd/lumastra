// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! The filesystem half of reconciling one directory, run on its root's lane: identity
//! checks, the listing, ignore files and per-entry classification. The engine applies the
//! result to its index on the main loop, so nothing here touches engine state.

use crate::lanes::Worker;
use crate::policy::{self, Containment, FileKind, Link, Patterns, Rules};
use crate::probe::Fingerprint;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Entries between progress reports and stop checks inside one listing.
const PROGRESS_ENTRIES: usize = 256;

/// Directory identity for loop detection and inotify wd sharing (a wd is per inode).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum DirKey {
    Inode(u64, u64),
    Path(PathBuf),
}

#[cfg(unix)]
fn inode_key(meta: &fs::Metadata) -> Option<DirKey> {
    use std::os::unix::fs::MetadataExt;
    (meta.ino() != 0).then(|| DirKey::Inode(meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn inode_key(_: &fs::Metadata) -> Option<DirKey> {
    None
}

/// Some overlay/virtual filesystems report inode 0 for everything: fall back to the path.
pub(crate) fn dir_key(meta: &fs::Metadata, canonical: &Path) -> DirKey {
    inode_key(meta).unwrap_or_else(|| DirKey::Path(canonical.to_path_buf()))
}

fn is_permission(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
}

pub(crate) struct WantFile {
    pub name: String,
    pub kind: FileKind,
    /// A symlinked file: its real path and the target's fingerprint.
    pub link: Option<(PathBuf, Fingerprint)>,
    pub check: bool,
    /// Sampled now: known files that need a check, and every file of an initial walk.
    pub observed: Option<(Fingerprint, Option<PathBuf>)>,
}

pub(crate) struct WantDir {
    pub name: String,
    /// None keeps the known child without re-inspecting it.
    pub found: Option<(PathBuf, DirKey, bool)>,
}

/// What the engine knew about the directory when it asked for the listing.
pub(crate) struct ListContext {
    pub rules: Arc<Rules>,
    pub containment: Arc<Containment>,
    pub extras: Arc<Vec<PathBuf>>,
    pub root_logical: PathBuf,
    pub root_canonical: Option<PathBuf>,
    pub is_root: bool,
    pub mount_point: bool,
    pub canonical: PathBuf,
    pub inherited: Patterns,
    pub local: Option<(Vec<String>, bool)>,
    pub excluded: bool,
    pub known_files: HashSet<String>,
    pub known_dirs: HashSet<String>,
    pub all: bool,
    pub names: HashSet<String>,
    pub initial: bool,
}

pub(crate) enum Target {
    /// A configured root: the nearest existing ancestor, then the root itself.
    Root { old: Option<(DirKey, PathBuf)> },
    /// A known directory below a root; `old` is its recorded identity.
    Dir {
        old: (DirKey, PathBuf),
        root_canonical: Option<PathBuf>,
    },
    /// A directory just found by its parent's listing (identity known from that lstat).
    New,
}

pub(crate) struct InspectRequest {
    pub logical: PathBuf,
    pub target: Target,
    /// Listed only when the identity is unchanged.
    pub list: Option<ListContext>,
}

pub(crate) enum DirState {
    /// Missing or no longer a directory: the parent's listing decides.
    Gone,
    Fail(String, bool),
    /// The same inode or path now resolves outside the root.
    Outside,
    Changed(PathBuf, DirKey, bool),
    Same,
}

/// A root's identity (key, real path, is a symlink), or why it cannot be inspected.
pub(crate) type RootIdentity = Result<(DirKey, PathBuf, bool), (String, bool)>;

pub(crate) enum Identity {
    Root {
        sentinel: Option<(PathBuf, DirKey)>,
        state: RootIdentity,
    },
    Dir(DirState),
    New,
}

pub(crate) struct Listed {
    /// A refused empty marker at a root (for the warning).
    pub root_marker: bool,
    /// An empty `.ignore` marker: the directory is excluded, nothing else was classified.
    pub excluded: bool,
    pub local: Vec<String>,
    pub dropped: usize,
    pub ignore_links: Vec<PathBuf>,
    pub want_files: Vec<WantFile>,
    pub want_dirs: Vec<WantDir>,
    pub errors: HashSet<String>,
    pub refused: u64,
    pub non_utf8: u64,
    pub present: HashSet<String>,
    pub known_files: HashSet<String>,
    pub known_dirs: HashSet<String>,
}

pub(crate) enum Listing {
    Skipped,
    Aborted,
    Failed {
        reason: String,
        permission: bool,
        /// Logged on stderr when the directory newly fails.
        log: Option<String>,
    },
    Listed(Box<Listed>),
}

pub(crate) struct Inspected {
    pub identity: Identity,
    pub listing: Listing,
}

pub(crate) fn inspect(request: InspectRequest, worker: &Worker) -> Inspected {
    worker.enter(&request.logical);
    let (identity, same) = match &request.target {
        Target::Root { old } => {
            let (sentinel, state) = root_identity(&request.logical, worker);
            let same = match (&state, old) {
                (Ok((key, canonical, _)), Some((old_key, old_canonical))) => {
                    key == old_key && canonical == old_canonical
                }
                _ => false,
            };
            (Identity::Root { sentinel, state }, same)
        }
        Target::Dir {
            old,
            root_canonical,
        } => {
            let state = dir_identity(&request.logical, old, root_canonical.as_deref(), worker);
            let same = matches!(state, DirState::Same);
            (Identity::Dir(state), same)
        }
        Target::New => (Identity::New, true),
    };
    let listing = match request.list {
        Some(context) if same => list(&request.logical, context, worker),
        _ => Listing::Skipped,
    };
    Inspected { identity, listing }
}

fn root_identity(logical: &Path, worker: &Worker) -> (Option<(PathBuf, DirKey)>, RootIdentity) {
    let mut sentinel = None;
    for ancestor in logical.ancestors().skip(1) {
        let meta = fs::metadata(ancestor);
        worker.progress();
        if let Ok(meta) = meta
            && meta.is_dir()
        {
            sentinel = fs::canonicalize(ancestor)
                .ok()
                .map(|canonical| (dir_key(&meta, &canonical), canonical))
                .map(|(key, canonical)| (canonical, key));
            worker.progress();
            break;
        }
    }
    let meta = match fs::metadata(logical) {
        Ok(meta) if meta.is_dir() => meta,
        Ok(_) => {
            return (
                sentinel,
                Err(("configured root is not a directory".into(), false)),
            );
        }
        Err(error) => {
            let reason = if error.kind() == io::ErrorKind::NotFound {
                "configured root is absent; preserving prior file state".into()
            } else {
                format!("cannot inspect configured root: {error}")
            };
            return (sentinel, Err((reason, is_permission(&error))));
        }
    };
    worker.progress();
    let canonical = match fs::canonicalize(logical) {
        Ok(canonical) => canonical,
        Err(error) => {
            let reason = format!("cannot resolve configured root: {error}");
            return (sentinel, Err((reason, is_permission(&error))));
        }
    };
    worker.progress();
    let key = dir_key(&meta, &canonical);
    let symlink = fs::symlink_metadata(logical).is_ok_and(|m| m.file_type().is_symlink());
    (sentinel, Ok((key, canonical, symlink)))
}

/// Re-check a known directory's identity before listing it.
fn dir_identity(
    logical: &Path,
    old: &(DirKey, PathBuf),
    root_canonical: Option<&Path>,
    worker: &Worker,
) -> DirState {
    let meta = match fs::metadata(logical) {
        Ok(meta) if meta.is_dir() => meta,
        Ok(_) => return DirState::Gone,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return DirState::Gone,
        Err(error) => {
            return DirState::Fail(
                format!("cannot inspect directory: {error}"),
                is_permission(&error),
            );
        }
    };
    worker.progress();
    // No inode-only fast path: the same directory moved out of the root and linked back
    // in keeps its inode but no longer passes containment.
    let canonical = match fs::canonicalize(logical) {
        Ok(canonical) => canonical,
        Err(error) => {
            return DirState::Fail(
                format!("cannot resolve directory: {error}"),
                is_permission(&error),
            );
        }
    };
    worker.progress();
    let key = dir_key(&meta, &canonical);
    if key == old.0 && canonical == old.1 {
        return DirState::Same;
    }
    if !root_canonical.is_some_and(|rc| policy::within(&canonical, rc)) {
        return DirState::Outside;
    }
    let symlink = fs::symlink_metadata(logical).is_ok_and(|m| m.file_type().is_symlink());
    DirState::Changed(canonical, key, symlink)
}

/// Whether the directory that first claimed an identity still has it.
pub(crate) fn owner_live(path: &Path, canonical: &Path, key: &DirKey, worker: &Worker) -> bool {
    worker.enter(path);
    fs::metadata(path).is_ok_and(|meta| dir_key(&meta, canonical) == *key)
}

/// A watch candidate's identity, right before it is registered.
pub(crate) fn preflight(path: &Path, worker: &Worker) -> Option<DirKey> {
    worker.enter(path);
    fs::metadata(path).ok().map(|meta| dir_key(&meta, path))
}

/// Fingerprint (and symlink target) of a listed file.
fn observe(
    path: &Path,
    link: Option<&(PathBuf, Fingerprint)>,
) -> Option<(Fingerprint, Option<PathBuf>)> {
    if let Some((target, fingerprint)) = link {
        return Some((*fingerprint, Some(target.clone())));
    }
    let meta = fs::symlink_metadata(path).ok()?;
    meta.is_file().then(|| (Fingerprint::of(&meta), None))
}

fn list(logical: &Path, context: ListContext, worker: &Worker) -> Listing {
    let rules = context.rules.clone();
    let reader = match fs::read_dir(logical) {
        Ok(reader) => reader,
        Err(error) => {
            return Listing::Failed {
                reason: format!("cannot list directory: {error}"),
                permission: is_permission(&error),
                log: None,
            };
        }
    };
    worker.progress();
    let mut entries: Vec<(String, fs::FileType)> = Vec::new();
    let mut errors: HashSet<String> = HashSet::new();
    let mut non_utf8 = 0u64;
    for (count, entry) in reader.enumerate() {
        if count % PROGRESS_ENTRIES == PROGRESS_ENTRIES - 1 {
            worker.progress();
            if worker.stopping() {
                return Listing::Aborted;
            }
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                return Listing::Failed {
                    reason: format!("cannot list directory: {error}"),
                    permission: is_permission(&error),
                    log: None,
                };
            }
        };
        let Ok(name) = entry.file_name().into_string() else {
            non_utf8 += 1;
            continue;
        };
        match entry.file_type() {
            Ok(kind) => entries.push((name, kind)),
            Err(_) => {
                errors.insert(name);
            }
        }
    }
    worker.progress();
    // readdir order is libuv's strcmp-sorted scandir order on the Node side.
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    // An empty root or mount point that used to hold files is far more likely an
    // unmounted share than a deleted library: keep the prior state.
    if entries.is_empty()
        && errors.is_empty()
        && non_utf8 == 0
        && (!context.known_files.is_empty() || !context.known_dirs.is_empty())
        && (context.is_root || context.mount_point)
    {
        return Listing::Failed {
            reason:
                "listing is empty although files were known (unmounted share?); preserving prior state"
                    .into(),
            permission: false,
            log: None,
        };
    }

    // Ignore files, read only when listed (as a file or a symlink).
    let extras = context.extras.clone();
    let mut local = Vec::new();
    let mut marker = false;
    let mut dropped = 0usize;
    let mut ignore_links = Vec::new();
    let ignore_files = [
        (rules.pattern_file.clone(), false),
        (rules.marker_file.clone(), true),
    ];
    for (file, is_marker) in ignore_files {
        if !entries
            .iter()
            .any(|(n, k)| *n == file && (k.is_file() || k.is_symlink()))
        {
            continue;
        }
        let path = logical.join(&file);
        if entries.iter().any(|(n, k)| *n == file && k.is_symlink())
            && let Ok(real) = fs::canonicalize(&path)
        {
            ignore_links.push(real);
        }
        let read = policy::read_contained(&path, &context.containment, &extras, rules.max_bytes);
        worker.progress();
        match read {
            Ok(content) => {
                let parsed = policy::parse_ignore(
                    &content,
                    rules.max_pattern_length,
                    rules.max_patterns_per_file,
                );
                dropped += parsed.meaningful - parsed.lines.len();
                if is_marker && parsed.meaningful == 0 {
                    marker = true;
                } else {
                    local.extend(parsed.lines);
                }
            }
            Err(reason) => {
                // Fail closed: the directory is skipped and nothing under it is removed.
                return Listing::Failed {
                    reason: format!("cannot use ignore file {file}: {reason}"),
                    permission: false,
                    log: Some(format!(
                        "lumastra-watcher: cannot use ignore file {}: {reason}; skipping its directory",
                        path.display()
                    )),
                };
            }
        }
    }
    let root_marker = context.is_root && marker;
    if context.is_root {
        marker = false;
    }
    let mut listed = Listed {
        root_marker,
        excluded: marker,
        local,
        dropped,
        ignore_links,
        want_files: Vec::new(),
        want_dirs: Vec::new(),
        errors,
        refused: 0,
        non_utf8,
        present: entries.iter().map(|(n, _)| n.clone()).collect(),
        known_files: HashSet::new(),
        known_dirs: HashSet::new(),
    };
    if marker {
        listed.known_files = context.known_files;
        listed.known_dirs = context.known_dirs;
        return Listing::Listed(Box::new(listed));
    }

    // The same rules as the engine applies to its own state afterwards.
    let mut all = context.all || context.excluded;
    let signature = (listed.local.clone(), false);
    if context.local.as_ref() != Some(&signature) && context.local.is_some() {
        all = true;
    }
    let patterns = policy::combine(&context.inherited, &listed.local);

    let rel_base = if context.is_root {
        String::new()
    } else {
        logical
            .strip_prefix(&context.root_logical)
            .ok()
            .and_then(Path::to_str)
            .map(|r| format!("{r}/"))
            .unwrap_or_default()
    };
    let root_canonical = context.root_canonical.as_ref();
    let limit = rules.max_accumulated;
    let containment = &context.containment;
    let mut refused = 0u64;
    for (index, (name, kind)) in entries.iter().enumerate() {
        // Every entry may cost several calls (lstat, symlink resolution, a stat).
        worker.progress();
        if index % PROGRESS_ENTRIES == PROGRESS_ENTRIES - 1 && worker.stopping() {
            return Listing::Aborted;
        }
        let path = logical.join(name);
        let known_file = context.known_files.contains(name);
        let known_dir = context.known_dirs.contains(name);
        let check = all
            || context.names.contains(name)
            || (known_file && kind.is_dir())
            || (known_dir && kind.is_file());
        let relative = format!("{rel_base}{name}");
        let ignored = || policy::is_ignored(name, &relative, &patterns, limit);
        let sample = (known_file && check) || (!known_file && context.initial);
        let want_file = |kind: FileKind, link: Option<(PathBuf, Fingerprint)>, check: bool| {
            let observed = if sample {
                observe(&path, link.as_ref())
            } else {
                None
            };
            WantFile {
                name: name.clone(),
                kind,
                link,
                check,
                observed,
            }
        };
        if kind.is_dir() {
            if rules.dir_pruned(name) || ignored() {
                continue;
            }
            if known_dir && !check {
                listed.want_dirs.push(WantDir {
                    name: name.clone(),
                    found: None,
                });
                continue;
            }
            // lstat: the entry may have been swapped for a symlink since readdir, and
            // then `canonical/name` would not be its real path.
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() => {
                    let canonical = context.canonical.join(name);
                    let key = dir_key(&meta, &canonical);
                    listed.want_dirs.push(WantDir {
                        name: name.clone(),
                        found: Some((canonical, key, false)),
                    });
                }
                Ok(meta) if meta.file_type().is_symlink() => match policy::resolve_link(&path) {
                    Link::Dir(real, meta)
                        if root_canonical.is_some_and(|rc| policy::within(&real, rc)) =>
                    {
                        let key = dir_key(&meta, &real);
                        listed.want_dirs.push(WantDir {
                            name: name.clone(),
                            found: Some((real, key, true)),
                        });
                    }
                    Link::Dir(..) => refused += 1,
                    Link::Unreachable => {
                        listed.errors.insert(name.clone());
                    }
                    Link::File(..) | Link::Other => {}
                },
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => {
                    listed.errors.insert(name.clone());
                }
            }
        } else if kind.is_symlink() {
            if !check && (known_file || known_dir) {
                if known_dir {
                    listed.want_dirs.push(WantDir {
                        name: name.clone(),
                        found: None,
                    });
                } else if let Some(file_kind) = rules.file_kind(name) {
                    listed.want_files.push(WantFile {
                        name: name.clone(),
                        kind: file_kind,
                        link: None,
                        check: false,
                        observed: None,
                    });
                }
                continue;
            }
            // A name that can be neither an eligible file nor a walked directory
            // needs no resolution (debrid libraries link every sidecar).
            if ignored() || (rules.dir_pruned(name) && rules.file_kind(name).is_none()) {
                continue;
            }
            match policy::resolve_link(&path) {
                Link::Unreachable => {
                    listed.errors.insert(name.clone());
                }
                Link::Dir(real, meta) => {
                    if rules.dir_pruned(name) || ignored() {
                        continue;
                    }
                    if !root_canonical.is_some_and(|rc| policy::within(&real, rc)) {
                        refused += 1;
                        continue;
                    }
                    let key = dir_key(&meta, &real);
                    listed.want_dirs.push(WantDir {
                        name: name.clone(),
                        found: Some((real, key, true)),
                    });
                }
                Link::File(real, meta) => {
                    let Some(file_kind) = rules.file_kind(name) else {
                        continue;
                    };
                    if ignored() {
                        continue;
                    }
                    if !containment.file_link_allowed(file_kind, &real, &extras) {
                        refused += 1;
                        continue;
                    }
                    listed.want_files.push(want_file(
                        file_kind,
                        Some((real, Fingerprint::of(&meta))),
                        check,
                    ));
                }
                Link::Other => {}
            }
        } else if kind.is_file() {
            let Some(file_kind) = rules.file_kind(name) else {
                continue;
            };
            if ignored() {
                continue;
            }
            listed.want_files.push(want_file(file_kind, None, check));
        }
    }
    listed.refused = refused;
    listed.known_files = context.known_files;
    listed.known_dirs = context.known_dirs;
    Listing::Listed(Box::new(listed))
}
