#!/bin/sh
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only

# Fetch the pinned jellyfin-ffmpeg portable build at container boot.
#
# Idempotent, NON-FATAL, and concurrency-safe: every failure path logs a clear
# message and exits 0 so the app still boots. A missing/broken binary degrades
# to "transcoding unavailable", which the app already surfaces (hooks.server.ts
# boot warning + /admin playback health check). Run this BEFORE launching the
# server. In split deploys the web/worker/proxy containers may share one /config
# volume and boot simultaneously, so installs are serialized with a lock.
#
# Env (all have safe defaults set in the Dockerfile):
#   FFMPEG_AUTO_DOWNLOAD  "true" to auto-fetch; anything else = skip (air-gapped/BYO)
#   FFMPEG_VERSION        pinned release tag, e.g. v7.1.4-3
#   FFMPEG_CACHE_DIR      versioned install dir (persist via a volume), e.g. /config/bin
#   FFMPEG_PATH           where the app looks for ffmpeg  (default $FFMPEG_CACHE_DIR/ffmpeg)
#   FFPROBE_PATH          where the app looks for ffprobe (default $FFMPEG_CACHE_DIR/ffprobe)
#
# Auto-download installs the self-contained build into a versioned dir under
# FFMPEG_CACHE_DIR and symlinks FFMPEG_PATH/FFPROBE_PATH at it. Custom
# FFMPEG_PATH/FFPROBE_PATH are honoured as long as their parent dirs are writable.
set -u

FFMPEG_AUTO_DOWNLOAD="${FFMPEG_AUTO_DOWNLOAD:-true}"
FFMPEG_VERSION="${FFMPEG_VERSION:-v7.1.4-3}"
FFMPEG_CACHE_DIR="${FFMPEG_CACHE_DIR:-/config/bin}"
FFMPEG_PATH="${FFMPEG_PATH:-$FFMPEG_CACHE_DIR/ffmpeg}"
FFPROBE_PATH="${FFPROBE_PATH:-$FFMPEG_CACHE_DIR/ffprobe}"

log() { echo "[ffmpeg-fetch] $*"; }

# Ready only when BOTH binaries exist and run — the app probes ffmpeg AND
# ffprobe, so a partial install (good ffmpeg, missing ffprobe) is NOT ready.
ffmpeg_ready() {
    "$FFMPEG_PATH" -version >/dev/null 2>&1 && "$FFPROBE_PATH" -version >/dev/null 2>&1
}

# 1. Opt-out — operator pre-provisions their own binaries (air-gapped/BYO).
if [ "$FFMPEG_AUTO_DOWNLOAD" != "true" ]; then
    log "FFMPEG_AUTO_DOWNLOAD=$FFMPEG_AUTO_DOWNLOAD — skipping auto-download; expecting binaries at $FFMPEG_PATH and $FFPROBE_PATH."
    exit 0
fi

# 2. Already present & runnable — BYO mount or previously cached on the volume.
if ffmpeg_ready; then
    log "ffmpeg + ffprobe already available ($FFMPEG_PATH, $FFPROBE_PATH) — skipping download."
    exit 0
fi

# 3. Cache dir not writable (e.g. a container that mounts it :ro, like the
#    standalone Live TV proxy since P4/2026-09-16) — bail out NOW rather than
#    spinning the ~300s lock-acquire loop below on every single boot: every
#    `mkdir "$LOCK_DIR"` attempt on a read-only mount fails with EROFS, and
#    ffmpeg_ready() can never become true on THIS container either (nothing
#    can install here), so that loop could only ever time out. A container
#    WITH write access (web/worker) installs into the shared cache; this one
#    picks it up via the ffmpeg_ready() check in step 2 on its NEXT restart.
#    Until then, transcoding on THIS container is unavailable exactly as the
#    "download failed" / "checksum mismatch" paths below already leave it.
mkdir -p "$FFMPEG_CACHE_DIR" 2>/dev/null || true
if [ ! -w "$FFMPEG_CACHE_DIR" ]; then
    log "$FFMPEG_CACHE_DIR is not writable — skipping install (read-only mount?). Waiting for a peer container with write access to populate the shared cache. Transcoding unavailable on this container until then."
    exit 0
fi

# 4. Acquire a cross-process install lock (mkdir is atomic on POSIX FS). Peers
#    poll, and bail early the moment the installer finishes.
LOCK_DIR="$FFMPEG_CACHE_DIR/.fetch.lock"
acquired=false
i=0
# 150 * 2s = 300s — must comfortably exceed a slow-link download (a ~60MB tarball
# at 5 Mbps is ~100s) so a waiting peer doesn't reclaim the lock mid-install.
while [ "$i" -lt 150 ]; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        acquired=true
        trap 'rm -rf "$LOCK_DIR"' EXIT
        break
    fi
    if ffmpeg_ready; then
        log "ffmpeg + ffprobe installed by a concurrent container — skipping download."
        exit 0
    fi
    i=$((i + 1))
    sleep 2
done
if [ "$acquired" != true ]; then
    # Lock held >~300s (stale lock or a very slow peer). Reclaim and proceed; the
    # staged-rename install below is atomic, so a late finisher can't corrupt us.
    log "WARNING: could not acquire install lock after ~300s; reclaiming $LOCK_DIR."
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || true
    trap 'rm -rf "$LOCK_DIR"' EXIT
fi

# A killed installer cannot run its trap. Reclaim only old immediate staging
# directories while holding the install lock; keep recent work and installs.
find "$FFMPEG_CACHE_DIR" -mindepth 1 -maxdepth 1 -type d \( -name '.fetch-*' -o -name '.stage-*' \) \
    -mmin +60 -exec rm -rf -- {} + 2>/dev/null || true

# 5. Re-check inside the lock — a peer may have installed while we waited.
if ffmpeg_ready; then
    log "ffmpeg + ffprobe already available ($FFMPEG_PATH, $FFPROBE_PATH) — skipping download."
    exit 0
fi

log "Initializing transcode engine: fetching jellyfin-ffmpeg $FFMPEG_VERSION (one-time, cached to $FFMPEG_CACHE_DIR). Please wait..."

# 6. Resolve the download URL + pinned digest for this architecture.
UNAME_ARCH="$(uname -m)"
if ! ASSET="$(node_modules/.bin/tsx --tsconfig tsconfig.scripts.json scripts/ffmpeg/resolve-asset.ts "$UNAME_ARCH" "$FFMPEG_VERSION")"; then
    log "ERROR: no jellyfin-ffmpeg build available for arch '$UNAME_ARCH'. Transcoding will be unavailable."
    exit 0
fi
URL="$(printf '%s' "$ASSET" | cut -f1)"
SHA256="$(printf '%s' "$ASSET" | cut -f2)"

# Extract on the shared cache filesystem. Moving files from /tmp preserves
# the downloading container's private SELinux MCS label (including across a
# filesystem copy), preventing peer containers from executing the binaries.
# New files here inherit the cache's shared label (Podman volumes use :z).
if ! TMP_DIR="$(mktemp -d "$FFMPEG_CACHE_DIR/.fetch-XXXXXX")"; then
    log "ERROR: cannot create staging directory in $FFMPEG_CACHE_DIR. Transcoding will be unavailable."
    exit 0
fi
# Stage-dir suffix derives from the mktemp dir (urandom-seeded), NOT $$: Docker
# containers share a PID namespace so $$ collides across concurrent peers. Defined
# here (alongside TMP_DIR) so the trap removes it even if the install aborts midway
# — otherwise a partial install leaks a .stage-* dir on the cache volume.
STAGE_DIR="$FFMPEG_CACHE_DIR/.stage-$FFMPEG_VERSION.$(basename "$TMP_DIR")"
trap 'rm -rf "$TMP_DIR" "$STAGE_DIR" "$LOCK_DIR"' EXIT
TARBALL="$TMP_DIR/ffmpeg.tar.xz"

# 7. Download (retries + connect AND total-transfer timeouts; --max-time bounds a
#    stalled transfer so a half-open connection can't hold the lock indefinitely).
if ! curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 -o "$TARBALL" "$URL"; then
    log "ERROR: download failed ($URL). If this host is offline/air-gapped, set FFMPEG_AUTO_DOWNLOAD=false and pre-provision binaries at $FFMPEG_PATH / $FFPROBE_PATH. Transcoding will be unavailable."
    exit 0
fi

# 8. Verify integrity against the pinned digest.
ACTUAL_SHA="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
if [ "$ACTUAL_SHA" != "$SHA256" ]; then
    log "ERROR: checksum mismatch (expected $SHA256, got $ACTUAL_SHA). Refusing to install. Transcoding will be unavailable."
    exit 0
fi

# 9. Extract. The portable build is a self-contained directory (binaries beside
#    bundled libs via $ORIGIN rpath), so locate the binaries instead of assuming
#    a fixed internal layout, and keep them next to their libs.
#    `tar -J` needs an external `xz` binary. The Docker image installs
#    xz-utils, but hosts without it (e.g. the non-root Playwright CI container,
#    where apt-get is not an option) would fail here — so fall back to
#    python3's tarfile, whose lzma module is linked against liblzma directly.
EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"
extract_tarball() {
    if command -v xz >/dev/null 2>&1; then
        tar -xJf "$TARBALL" -C "$EXTRACT_DIR"
    elif command -v python3 >/dev/null 2>&1; then
        log "xz not found — extracting with python3 tarfile instead."
        python3 - "$TARBALL" "$EXTRACT_DIR" <<'PY'
import sys, tarfile
kw = {"filter": "tar"} if hasattr(tarfile, "tar_filter") else {}
with tarfile.open(sys.argv[1], "r:xz") as t:
    t.extractall(sys.argv[2], **kw)
PY
    else
        log "ERROR: neither xz nor python3 is available to extract a .tar.xz (install xz-utils)."
        return 1
    fi
}
if ! extract_tarball; then
    log "ERROR: failed to extract $TARBALL. Transcoding will be unavailable."
    exit 0
fi

REAL_FFMPEG="$(find "$EXTRACT_DIR" -type f -name ffmpeg | head -1)"
REAL_FFPROBE="$(find "$EXTRACT_DIR" -type f -name ffprobe | head -1)"
if [ -z "$REAL_FFMPEG" ] || [ -z "$REAL_FFPROBE" ]; then
    log "ERROR: ffmpeg/ffprobe not found in the extracted archive. Transcoding will be unavailable."
    exit 0
fi

# 10. Install atomically: stage the versioned dir, rename into place, then point
#    the configured FFMPEG_PATH/FFPROBE_PATH symlinks at it. We hold the lock, so
#    this rename + repoint is the only writer.
INSTALL_DIR="$FFMPEG_CACHE_DIR/jellyfin-ffmpeg-$FFMPEG_VERSION"
rm -rf "$STAGE_DIR"
if ! mv "$(dirname "$REAL_FFMPEG")" "$STAGE_DIR"; then
    log "ERROR: failed to stage extracted binaries. Transcoding will be unavailable."
    exit 0
fi
chmod +x "$STAGE_DIR/ffmpeg" "$STAGE_DIR/ffprobe"
rm -rf "$INSTALL_DIR"
mv "$STAGE_DIR" "$INSTALL_DIR"

# Symlink the configured app paths (defaults live under FFMPEG_CACHE_DIR; custom
# paths are honoured as long as their parent dirs are writable).
for pair in "$FFMPEG_PATH:ffmpeg" "$FFPROBE_PATH:ffprobe"; do
    target_path="${pair%:*}"
    bin_name="${pair##*:}"
    parent="$(dirname "$target_path")"
    if ! mkdir -p "$parent" 2>/dev/null; then
        log "ERROR: cannot create $parent for $bin_name. Set FFMPEG_AUTO_DOWNLOAD=false and provision it yourself, or point FFMPEG_PATH/FFPROBE_PATH at a writable location. Transcoding will be unavailable."
        exit 0
    fi
    ln -sfn "$INSTALL_DIR/$bin_name" "$target_path"
done

if ffmpeg_ready; then
    log "ffmpeg ready: jellyfin-ffmpeg $FFMPEG_VERSION ($FFMPEG_PATH, $FFPROBE_PATH)"
else
    log "ERROR: installed ffmpeg/ffprobe failed to run. Transcoding will be unavailable."
fi

exit 0
