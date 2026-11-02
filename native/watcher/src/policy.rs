// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Scanner eligibility rules, mirrored from `walk-directory.ts` and `contained-fs.ts`.

use crate::Policy;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    /// Video or audio: a symlink may leave the roots unless it enters a sensitive prefix.
    Media,
    /// Lyrics sidecar: a symlink must stay inside a containment root.
    Lyrics,
}

pub struct Rules {
    media: HashSet<String>,
    lyrics: HashSet<String>,
    pruned_names: HashSet<String>,
    pruned_prefixes: Vec<String>,
    pruned_suffixes: Vec<String>,
    file_prefixes: Vec<String>,
    sample: Vec<u8>,
    pub pattern_file: String,
    pub marker_file: String,
    pub max_bytes: u64,
    pub max_pattern_length: usize,
    pub max_patterns_per_file: usize,
    pub max_accumulated: usize,
}

fn lowered(values: &[String]) -> Vec<String> {
    values.iter().map(|v| v.to_lowercase()).collect()
}

impl Rules {
    pub fn new(policy: &Policy) -> Self {
        Self {
            media: lowered(&policy.media_extensions)
                .into_iter()
                .chain(lowered(&policy.audio_extensions))
                .collect(),
            lyrics: lowered(&policy.lyrics_extensions).into_iter().collect(),
            pruned_names: lowered(&policy.pruned_directory_names)
                .into_iter()
                .collect(),
            pruned_prefixes: lowered(&policy.pruned_directory_prefixes),
            pruned_suffixes: lowered(&policy.pruned_directory_suffixes),
            file_prefixes: policy.ignored_file_prefixes.clone(),
            sample: policy.sample_word.to_ascii_lowercase().into_bytes(),
            pattern_file: policy.ignore_files.pattern_file.clone(),
            marker_file: policy.ignore_files.marker_file.clone(),
            max_bytes: policy.ignore_files.max_bytes,
            max_pattern_length: policy.ignore_files.max_pattern_length,
            max_patterns_per_file: policy.ignore_files.max_patterns_per_file,
            max_accumulated: policy.ignore_files.max_accumulated_patterns,
        }
    }

    /// Name-only directory pruning (`isPrunedFolderName`), case-insensitive.
    pub fn dir_pruned(&self, name: &str) -> bool {
        let name = name.to_lowercase();
        self.pruned_names.contains(&name)
            || self.pruned_prefixes.iter().any(|p| name.starts_with(p))
            || self.pruned_suffixes.iter().any(|s| name.ends_with(s))
    }

    /// File name rules in scanner order: ignored prefix, extension, sample word.
    /// Ignore-file patterns are applied separately because they need the directory context.
    pub fn file_kind(&self, name: &str) -> Option<FileKind> {
        if self
            .file_prefixes
            .iter()
            .any(|p| name.starts_with(p.as_str()))
        {
            return None;
        }
        let ext = node_extname(name).to_lowercase();
        let kind = if self.media.contains(&ext) {
            FileKind::Media
        } else if self.lyrics.contains(&ext) {
            FileKind::Lyrics
        } else {
            return None;
        };
        if sample_matches(name, &self.sample) {
            return None;
        }
        Some(kind)
    }
}

/// Node's `path.extname` for a bare file name: the last `.` onwards, except for names
/// whose only dots lead (`.mkv`, `..`), which have no extension.
pub fn node_extname(name: &str) -> &str {
    let Some(dot) = name.rfind('.') else {
        return "";
    };
    let prefix = &name.as_bytes()[..dot];
    if prefix.is_empty() {
        return "";
    }
    if dot == 1 && dot == name.len() - 1 && prefix.iter().all(|b| *b == b'.') {
        return "";
    }
    &name[dot..]
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `/\bword\b/i` without the `u` flag: ASCII case folding and ASCII word boundaries.
/// `word` is validated to consist of ASCII word characters.
pub fn sample_matches(name: &str, word: &[u8]) -> bool {
    let bytes = name.as_bytes();
    let width = word.len();
    if width == 0 || bytes.len() < width {
        return false;
    }
    (0..=bytes.len() - width).any(|i| {
        bytes[i..i + width].eq_ignore_ascii_case(word)
            && (i == 0 || !is_word_byte(bytes[i - 1]))
            && (i + width == bytes.len() || !is_word_byte(bytes[i + width]))
    })
}

fn lower_units(text: &str) -> Vec<u16> {
    text.to_lowercase().encode_utf16().collect()
}

const STAR: u16 = b'*' as u16;
const QUESTION: u16 = b'?' as u16;
const SLASH: u16 = b'/' as u16;

/// `globMatches` from walk-directory.ts on lowercased UTF-16 code units, with the same
/// single-backtrack iteration (including its check of the unit a star would absorb).
fn glob_units(pattern: &[u16], text: &[u16]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<usize> = None;
    let mut star_t = 0;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == STAR {
            star = Some(p);
            p += 1;
            star_t = t;
        } else if p < pattern.len()
            && (pattern[p] == text[t] || (pattern[p] == QUESTION && text[t] != SLASH))
        {
            p += 1;
            t += 1;
        } else if let Some(star_p) = star
            && text[star_t] != SLASH
        {
            p = star_p + 1;
            star_t += 1;
            t = star_t;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == STAR {
        p += 1;
    }
    p == pattern.len()
}

pub fn glob_matches(pattern: &str, text: &str) -> bool {
    glob_units(&lower_units(pattern), &lower_units(text))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    slash: bool,
    units: Vec<u16>,
}

impl Pattern {
    pub fn new(pattern: &str) -> Self {
        Self {
            slash: pattern.contains('/'),
            units: lower_units(pattern),
        }
    }
}

pub type Patterns = Arc<Vec<Pattern>>;

/// Inherited patterns followed by this directory's own (`[...inherited, ...local]`).
pub fn combine(inherited: &Patterns, local: &[String]) -> Patterns {
    if local.is_empty() {
        return inherited.clone();
    }
    Arc::new(
        inherited
            .iter()
            .cloned()
            .chain(local.iter().map(|l| Pattern::new(l)))
            .collect(),
    )
}

/// `isIgnored`: patterns with `/` match the root-relative path, the rest the bare name.
pub fn is_ignored(name: &str, relative: &str, patterns: &[Pattern], limit: usize) -> bool {
    let mut name_units: Option<Vec<u16>> = None;
    let mut relative_units: Option<Vec<u16>> = None;
    for pattern in patterns.iter().take(limit) {
        let text: &[u16] = if pattern.slash {
            relative_units.get_or_insert_with(|| lower_units(relative))
        } else {
            name_units.get_or_insert_with(|| lower_units(name))
        };
        if glob_units(&pattern.units, text) {
            return true;
        }
    }
    false
}

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim` (which differs from `str::trim` on U+FEFF and U+0085).
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

pub struct IgnoreLines {
    pub lines: Vec<String>,
    /// Meaningful lines before the length/count caps (an over-long-only file is not empty).
    pub meaningful: usize,
}

pub fn parse_ignore(content: &[u8], max_length: usize, max_count: usize) -> IgnoreLines {
    let text = String::from_utf8_lossy(content);
    let meaningful: Vec<&str> = text
        .split('\n')
        .map(js_trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    let lines = meaningful
        .iter()
        .filter(|l| l.encode_utf16().count() <= max_length)
        .take(max_count)
        .map(|l| (*l).to_string())
        .collect();
    IgnoreLines {
        lines,
        meaningful: meaningful.len(),
    }
}

/// Lexical `path.resolve` for an absolute path.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => out.push(component),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
        }
    }
    out
}

/// `isWithinRoot` on normalized absolute paths; component-wise, so `/ab` is not in `/a`.
pub fn within(candidate: &Path, root: &Path) -> bool {
    candidate.starts_with(root)
}

fn both_forms(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for path in paths.iter().filter(|p| !p.as_os_str().is_empty()) {
        let lexical = normalize(path);
        if !out.contains(&lexical) {
            out.push(lexical);
        }
        if let Ok(real) = fs::canonicalize(path)
            && !out.contains(&real)
        {
            out.push(real);
        }
    }
    out
}

pub struct Containment {
    roots: Vec<PathBuf>,
    sensitive: Vec<PathBuf>,
    /// Some sensitive prefix has no resolved real path yet: treat every path as sensitive.
    sensitive_pending: bool,
}

impl Containment {
    pub fn new(roots: &[PathBuf], sensitive: &[PathBuf]) -> Self {
        Self::from_forms(both_forms(roots), both_forms(sensitive), false)
    }

    /// Already expanded forms (lexical and real). While `sensitive_pending`, media symlinks
    /// that leave the roots are refused (fail closed until every prefix was resolved).
    pub fn from_forms(
        roots: Vec<PathBuf>,
        sensitive: Vec<PathBuf>,
        sensitive_pending: bool,
    ) -> Self {
        Self {
            roots,
            sensitive,
            sensitive_pending,
        }
    }

    pub fn inside(&self, real: &Path, extras: &[PathBuf]) -> bool {
        extras.iter().chain(&self.roots).any(|r| within(real, r))
    }

    pub fn sensitive(&self, real: &Path) -> bool {
        self.sensitive_pending || self.sensitive.iter().any(|p| within(real, p))
    }

    /// `resolveContainedMediaFile` / `resolveContainedFile` for a resolved regular file.
    pub fn file_link_allowed(&self, kind: FileKind, real: &Path, extras: &[PathBuf]) -> bool {
        self.inside(real, extras) || (kind == FileKind::Media && !self.sensitive(real))
    }
}

pub enum Link {
    File(PathBuf, fs::Metadata),
    Dir(PathBuf, fs::Metadata),
    Other,
    Unreachable,
}

/// Resolve a symlink entry like `classifyEntry`: an unreachable target is an error, not a removal.
pub fn resolve_link(path: &Path) -> Link {
    let Ok(real) = fs::canonicalize(path) else {
        return Link::Unreachable;
    };
    match fs::metadata(&real) {
        Ok(meta) if meta.is_dir() => Link::Dir(real, meta),
        Ok(meta) if meta.is_file() => Link::File(real, meta),
        Ok(_) => Link::Other,
        Err(_) => Link::Unreachable,
    }
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> io::Result<fs::File> {
    fs::File::open(path)
}

/// `readContainedFile` for ignore files: a symlink must resolve inside a containment root,
/// the opened file must be regular and at most `max_bytes`. Every failure is a refusal.
pub fn read_contained(
    path: &Path,
    containment: &Containment,
    extras: &[PathBuf],
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let lstat = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let target = if lstat.file_type().is_symlink() {
        let real = fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !containment.inside(&real, extras) {
            return Err("symlink target outside library roots".into());
        }
        real
    } else if lstat.is_file() {
        path.to_path_buf()
    } else {
        return Err("not a regular file".into());
    };
    let file = open_no_follow(&target).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    if meta.len() > max_bytes {
        return Err("file too large".into());
    }
    let mut content = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut content)
        .map_err(|e| e.to_string())?;
    if content.len() as u64 > max_bytes {
        return Err("file too large".into());
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extname_follows_node_semantics() {
        for (name, ext) in [
            ("..mkv", ".mkv"),
            (".mkv", ""),
            ("a.", "."),
            ("..", ""),
            ("...", "."),
            (".", ""),
            ("Sample.mkv", ".mkv"),
            ("archive.tar.MKV", ".MKV"),
            ("noext", ""),
            (".a.mkv", ".mkv"),
        ] {
            assert_eq!(node_extname(name), ext, "{name}");
        }
    }

    #[test]
    fn sample_word_uses_ascii_word_boundaries() {
        let word = b"sample";
        for (name, matched) in [
            ("Sample.mkv", true),
            ("movie-SAMPLE.mkv", true),
            ("sample", true),
            ("resample.mkv", false),
            ("my_sample.mkv", false),
            ("samples.mkv", false),
            ("sample1.mkv", false),
            ("é sample é.mkv", true),
            ("ésampleé.mkv", true),
            ("ſample.mkv", false),
        ] {
            assert_eq!(sample_matches(name, word), matched, "{name}");
        }
    }

    #[test]
    fn glob_matches_walk_directory_reference() {
        for (pattern, text, matched) in [
            ("*.mkv", "Film.MKV", true),
            ("*.mkv", "dir/Film.mkv", false),
            ("dir/*.mkv", "dir/Film.mkv", true),
            ("?ilm.mkv", "Film.mkv", true),
            ("?ilm.mkv", "/ilm.mkv", false),
            ("a*b", "a/b", false),
            (
                "*a*a*a*b",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                false,
            ),
            ("**", "", true),
            ("", "", true),
            ("", "x", false),
            ("film", "FILM", true),
            ("ÄRGER*", "ärger.mkv", true),
            ("x?y", "x😀y", false),
            ("x??y", "x😀y", true),
        ] {
            assert_eq!(glob_matches(pattern, text), matched, "{pattern} ~ {text}");
        }
    }

    #[test]
    fn ignore_lines_trim_like_javascript_and_count_before_caps() {
        let parsed = parse_ignore(
            "\u{feff}# c\r\n  skip-*.mkv \r\n\n\u{85}x\nlonglonglong\n#\n".as_bytes(),
            10,
            10,
        );
        assert_eq!(parsed.meaningful, 3);
        assert_eq!(
            parsed.lines,
            vec!["skip-*.mkv".to_string(), "\u{85}x".into()]
        );
        let over_long = parse_ignore(b"abcdefghij\n", 4, 10);
        assert_eq!(over_long.meaningful, 1);
        assert!(over_long.lines.is_empty());
        let capped = parse_ignore(b"a\nb\nc\n", 10, 2);
        assert_eq!(capped.lines, vec!["a".to_string(), "b".into()]);
        assert_eq!(js_trim("\u{3000}a\u{2028}"), "a");
    }

    #[test]
    fn ignore_patterns_respect_the_accumulated_limit() {
        let patterns = vec![Pattern::new("nothing"), Pattern::new("*.mkv")];
        assert!(is_ignored("a.mkv", "a.mkv", &patterns, 2));
        assert!(!is_ignored("a.mkv", "a.mkv", &patterns, 1));
        let nested = vec![Pattern::new("Show/*/x.mkv")];
        assert!(is_ignored("x.mkv", "Show/S1/x.mkv", &nested, 10));
        assert!(!is_ignored("x.mkv", "x.mkv", &nested, 10));
    }

    #[test]
    fn pending_sensitive_prefixes_fail_closed() {
        let roots = vec![PathBuf::from("/media/tv")];
        let pending = Containment::from_forms(roots.clone(), vec![PathBuf::from("/config")], true);
        let outside = Path::new("/elsewhere/film.mkv");
        assert!(pending.sensitive(outside));
        assert!(!pending.file_link_allowed(FileKind::Media, outside, &[]));
        assert!(pending.file_link_allowed(FileKind::Media, Path::new("/media/tv/a.mkv"), &[]));
        let resolved = Containment::from_forms(roots, vec![PathBuf::from("/config")], false);
        assert!(resolved.file_link_allowed(FileKind::Media, outside, &[]));
    }

    #[test]
    fn containment_is_path_boundary_aware() {
        assert!(within(Path::new("/a/b"), Path::new("/a")));
        assert!(within(Path::new("/a"), Path::new("/a")));
        assert!(!within(Path::new("/ab"), Path::new("/a")));
        assert!(within(Path::new("/x"), Path::new("/")));
        assert_eq!(normalize(Path::new("/a/./b/../c/")), PathBuf::from("/a/c"));
        let c = Containment::new(&[PathBuf::from("/media/tv")], &[PathBuf::from("/config")]);
        assert!(c.file_link_allowed(FileKind::Lyrics, Path::new("/media/tv/x.lrc"), &[]));
        assert!(!c.file_link_allowed(FileKind::Lyrics, Path::new("/mnt/x.lrc"), &[]));
        assert!(c.file_link_allowed(FileKind::Media, Path::new("/mnt/x.mkv"), &[]));
        assert!(!c.file_link_allowed(FileKind::Media, Path::new("/config/master.key"), &[]));
        assert!(c.file_link_allowed(FileKind::Media, Path::new("/configx/a.mkv"), &[]));
    }
}
