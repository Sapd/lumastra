<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Native library watcher

This executable is a filesystem-only child of the existing TypeScript task process, inside the
same task container. TypeScript retains Valkey leadership, database ingestion, task dispatch,
mount-outage deletion guards and the scheduled full-library reconciliation safety net.

Rust is the only watcher in production and local development. A missing or incompatible
binary fails visibly. `LUMASTRA_WATCHER_BINARY` overrides the default
`build/lumastra-watcher` path.

From the application directory, build with the exact toolchain pinned in
`native/rust-toolchain.toml`:

```sh
npm run build:watcher
```

This runs `node scripts/native.mjs build watcher`, uses the committed Cargo lockfile and
copies the release executable to `build/lumastra-watcher`. `npm run dev:worker` reuses it
when it is newer than all files under `native/watcher/src`, `Cargo.toml` and `Cargo.lock`;
otherwise it rebuilds before starting the lean task host. Rebuild after `npm run build` clears the
build directory. The Docker image builds the watcher in its Rust stage and copies it into the
runtime image; the JavaScript app build does not bundle a watcher.

The child inherits the task container's user and filesystem permissions. Its environment contains
only PATH and LANG; it receives no database, Valkey or plugin credentials. This process boundary
is not an additional filesystem security sandbox.

## Protocol

Protocol version 2. The first stdin frame is one newline-terminated JSON `init` message. It carries
the absolute library roots, `networkPaths` (a subset of the roots) with `networkReconcileSecs`
(0 disables, otherwise 60..86400), the 500 ms stability / 100 ms sampling settings, `aliveMs`, and
the scanner policy serialized by `media-file-kinds.ts`: media/audio/lyrics extensions, pruned
directory names/prefixes/suffixes, ignored file prefixes, the sample word, the ignore-file names and
limits, the containment roots and the sensitive prefixes. Unknown fields and other versions are
rejected. Later `{ "type": "close" }` or stdin EOF shuts down; any other control frame fails.

Stdout carries only NDJSON records, each at most 1 MiB:

| Record   | Meaning                                                                                                                                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`  | initial walk done, watches registered; includes `version: 2`                                                                                                                                                                                                                                                                                              |
| `event`  | `add` / `change` / `unlink` of an eligible file under a configured root                                                                                                                                                                                                                                                                                   |
| `status` | `coverage` (`full`/`partial`), `watchedDirs`, `failedDirs`, `failedSample` (≤ 5), `watchLimit`, `unwatchedDirs`, `stalledProbes`, `stalledRoots`, `nonUtf8Skipped`, `refusedSymlinks`, `networkRoots`. Sent after `ready` and when coverage, the watch limit, unwatched directories, a stalled stat or root, or the failure set change, at most every 5 s |
| `error`  | non-fatal problem, optional `code`: `watch_limit`, `permission`, `io`, `backend`                                                                                                                                                                                                                                                                          |
| `rescan` | observation was lost; never repeated for the same persistent failure                                                                                                                                                                                                                                                                                      |
| `alive`  | `seq`, every `aliveMs` from the main thread (also during the initial walk), so a wedged loop goes silent                                                                                                                                                                                                                                                  |

Golden examples, shared with the Node bridge, are in `tests/fixtures/protocol.json`. Diagnostics
use stderr. When the child stops on an error it writes a final `error` frame with `fatal: true`
(code `watch_limit` when the kernel limit prevented any registration) and gives queued output up
to one second to drain.

`--version` prints `lumastra-watcher <version> protocol 2`. `--snapshot` reads one init frame,
performs the initial walk and prints every eligible path as one JSON string per line, then exits;
the parity conformance test compares it with the TypeScript scanner. Unknown arguments fail.

## Eligibility

The child applies the scanner's rules from `walk-directory.ts` and `contained-fs.ts`; Node
re-checks eligibility and containment in `ingestSingleFile`. Directories below a root are pruned by
name (case-insensitive) without touching the filesystem; a symlink is pruned by name only once it
is known to be a directory. Directory entries are visited in byte order, pre-order, so the first
path that reaches a directory identity owns it (symlink loops and aliases are walked once). A
directory, symlinked or not, whose real path leaves the root's real path is not walked.

`.lumastraignore` and `.ignore` are read only when listed. Patterns accumulate down the tree; a
pattern with `/` matches the path relative to the root, otherwise the bare name, using the
scanner's glob semantics on lowercased UTF-16 code units. An empty or comment-only `.ignore` skips
its directory, except at a root, where it is refused with a warning. An ignore file that cannot be
used (too large, not a regular file, a symlink out of the containment roots, an I/O error) skips the
directory and counts as a listing failure.

Files keep the scanner's order: `._` prefix, extension by Node's `path.extname`, the sample word with
ASCII word boundaries, then ignore patterns. A symlinked media or audio file must resolve to a
regular file inside a containment root or anywhere outside the sensitive prefixes; a symlinked
lyrics file must resolve inside a containment root. Paths are compared component-wise in both their
lexical and real forms. An unreachable symlink target is an inspection error, as in the scanner:
the entry keeps its prior state, counts toward `refusedSymlinks` and only that name is re-checked
with backoff; the directory is not failed. Names that are not valid UTF-8 are skipped, never
indexed, and reported as one count.

## Filesystem behavior

Registration uses nonrecursive native watches over the accepted directories, the nearest existing
ancestor of each root, and the parents of symlink targets. An event on a directory entry marks that
directory dirty; dirty directories are re-listed after a 250 ms debounce and diffed against the
index, so only the affected subtree is walked. Removals are inferred only from successful listings:
a known file missing from its directory's listing is unlinked, a known subdirectory missing from it
unlinks everything below. A directory whose listing failed keeps its prior file state, enters the
failure set and is retried with exponential backoff from 5 s to 5 min; coverage is `partial` while
the set is non-empty. A root or mount point (a directory on another device than its parent) whose
listing is suddenly empty although files were known is treated as an unmounted share: a failure,
not a mass removal. Metadata events on directories are ignored. A new directory's watch is
registered before it is listed, so files copied in right after `mkdir` are not missed. Directories
whose registration failed for another reason count as `unwatchedDirs` (coverage `partial`) and
are retried with the same backoff; failure notices and their `rescan` share it too.

inotify uses one watch descriptor per inode, and notify drops a watch (and every watch below it)
itself when it sees a rename source or a delete. The engine mirrors that, unregisters before it
registers within a batch, and re-adds any kept path that shared an inode with a released watch, so a
folder renamed inside a root keeps being observed.

When the kernel watch limit is reached the child reports `error` with code `watch_limit` and
`raise fs.inotify.max_user_watches; N/M dirs watched`, keeps listing, marks coverage partial and
retries the missing watches every 5 min. Network roots get a full reconcile every
`networkReconcileSecs`, because writes from another host produce no local events on NFS or SMB.

A file must keep the same size and modification time for 500 ms before `add`/`change` is
delivered (device and inode numbers are not compared: they are unstable on FUSE, rclone, SMB and
overlay mounts). Stability checks are ordered by deadline, at most 256 per tick and 256 in flight
per root.

## Hung mounts

The main loop makes no filesystem calls. Every root has two worker threads (lanes): one walks it,
one directory at a time in walk order (identity checks, listing, ignore files, symlink resolution
and stats of listed files), the other runs its stability stats, the stat taken right before a
watch is registered, and the resolution of its real path for containment. The main loop sends a
directory to its root's lane and applies the result when it arrives; other containment roots and
the sensitive prefixes resolve on one shared lane. One hung NFS, SMB or rclone mount, or a dead
provider path, therefore blocks only its own root's lanes: the other roots keep delivering events
and `alive` continues.

A lane with work whose filesystem calls have not returned for twice `aliveMs` (bounded to
1..30 s; 20 s by default) is stalled. Its root appears in `stalledRoots` (coverage `partial`; `stalledProbes` when the stat
lane is the one stuck) and is reported once with an `error` (code `io`). Its thread stays blocked
in the kernel until the mount answers; work for that root queues meanwhile, at most one
reconciliation per directory. When the root answers again its queued work runs and a `rescan`
follows (rate-limited like failure notices). The initial walk does not wait for a stalled root:
`ready` follows once every other root is walked, and the stalled root finishes its initial walk
later, still without events. With a stalled root and nothing else to watch the child still
becomes ready.

inotify registration resolves the path in the kernel on the thread that registers it, so the
engine registers a watch directly only for a directory whose identity a lane observed just
before; every other registration (re-registration after an overflow, retries, symlink-target and
root-ancestor directories) is first stat'ed on its root's lane, and a stalled root's paths are not
registered until it answers. A mount that hangs exactly between that stat and the registration can
still block the main loop; removing that needs one inotify instance per mount.

Until every sensitive prefix has been resolved once, symlinked media files that leave the
containment roots are refused (fail closed). Debug builds accept `LUMASTRA_WATCHER_TEST_HANG=<dir>`:
lane work for paths under `<dir>` blocks while `<dir>.hang` exists, which the filesystem tests use
to simulate a hung mount; the bridge starts the child with PATH and LANG only, and release builds
ignore the variable.

## Bounds

Raw events (4096), pending stability checks (8192), in-flight stats (256 per root) and output
records (4096) are bounded. Access events never enter the raw queue, and a data write to a path whose earlier
write is still queued is coalesced. An overflowing raw queue or a kernel overflow re-registers
every watch (lost events may include the rename that removed one) and triggers a full reconcile
(rate-limited with the same backoff) and a `rescan`; a pending overflow only reconciles. An event
that does not fit the output queue is dropped; the `rescan` it causes is written only after every
record queued before it. `alive` and `status` replace a queued record of their kind instead of
being dropped. Watches on symlink-target directories outside the library are capped at a tenth of
`fs.inotify.max_user_watches` (at most 4096) and registered after library directories. The file and directory indexes grow
with the library itself.

The bridge restarts unexpected exits with bounded backoff, requests reconciliation and stops after
repeated failure. Invalid protocols and missing executables fail directly. Startup has a ten-minute
readiness deadline to accommodate large or slow libraries. Shutdown requests stdin close, then
uses bounded TERM/KILL escalation. A kernel-blocked process that still cannot exit is reported and
its handle quarantined; further native launches in that task process are refused until it exits.

## Verification

Run from the application folder with the pinned Rust toolchain:

```sh
node scripts/native.mjs check watcher
```

The explicit Node conformance job requires an executable; it fails if absent rather than skipping.
After building, set `LUMASTRA_WATCHER_BINARY` to the built executable
and run Vitest with `tests/native-conformance/watcher/vitest.config.ts`. Rust tests cover actual
filesystem changes, folder renames, symlink containment, inaccessible trees and `--snapshot`
eligibility, a hung root next to a healthy one, plus protocol, queue saturation, watch-limit and
rescan recovery.
Image/arm64 smoke, representative memory/latency measurements and soak are separate checks;
unit tests do not establish production resource usage or behavior under sustained load.
