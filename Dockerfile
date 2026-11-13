# Stage 1 - build the application bundle. ALWAYS RUNS NATIVELY.
#
# `--platform=$BUILDPLATFORM` pins this stage to the BUILDER's architecture, never
# the target's. That is the whole point: Vite's output is platform-neutral
# JavaScript, so nothing here needs to match the image we are producing, and
# running it emulated is both pointless and fatal. Building linux/arm64 on the
# amd64 runner used to hang forever in `rendering chunks...` — Vite minifies via
# esbuild, esbuild is a Go binary, and Go's runtime dies under QEMU user-mode
# emulation (three `[esbuild] <defunct>` zombies, 122 of 125 node threads parked
# in futex_wait_queue, 740 CPU-seconds burned and then nothing). Only the
# arch-specific `node_modules` genuinely needs the target, and that is what the
# `prod-deps` stage below is for.
#
# Do NOT remove this pin to "simplify" the file. Without it a cross-build does not
# fail — it hangs, which on `stable` means a release build that never returns.
FROM --platform=$BUILDPLATFORM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder
WORKDIR /app

# Copy package files first for better layer caching.
# Workspace package.json files must be present BEFORE `npm ci` so npm can
# create the workspace symlinks in node_modules. Without this, the root
# build fails at runtime with "Cannot find package '@sapd/lumastra-plugin-sdk'".
COPY package*.json ./
COPY packages/@sapd/lumastra-plugin-sdk/package.json packages/@sapd/lumastra-plugin-sdk/package.json

# package.json's `prepare` lifecycle script runs during `npm ci`, so the script
# it invokes has to exist by then. It is NOT covered by the source COPY further
# down — that happens after this layer — and without it `npm ci` dies with
# MODULE_NOT_FOUND on scripts/prepare-husky.mjs and takes the whole image build
# with it. Copied on its own so the dependency layer still caches on
# package*.json alone.
COPY scripts/prepare-husky.mjs scripts/prepare-husky.mjs

# Install dependencies with cache mount for faster rebuilds
# npm ci is faster and more reliable than npm install
#
# --loglevel=error only: vitest (a devDependency here AND in the
# packages/@sapd/* workspace members, needed only for `npm test`, never for
# `npm run build` below or for anything shipped in the runtime image) declares
# an `engines.node` range an odd-numbered builder Node (node:25 until 2026-10)
# does not satisfy, so a plain `npm ci` printed `npm warn EBADENGINE vitest@... requires node ^22.12 || ^24
# || >=26`. `engine-strict=false` (already npm's default) does NOT silence
# this — it only controls whether npm treats it as an install-time hard
# failure, not whether it prints the warning — and `npm pkg delete
# devDependencies.vitest` doesn't remove it either, since the two workspace
# packages each redeclare `"vitest": "*"` in their OWN (published)
# package.json, which npm workspaces installs regardless of the root's
# devDependencies. Editing those published manifests just to quiet a Docker
# build warning is out of scope here, so this scopes `--loglevel=error` to
# this one RUN instead: it changes nothing about what gets installed (still
# the exact set `--legacy-peer-deps` would install without it, verified
# locally), it only drops warn-level npm output for this step.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --loglevel=error

# Generate the machine-readable third-party license manifest from the PRODUCTION
# dependency graph, baked into the image next to THIRD-PARTY-NOTICES.md. Runs here
# (right after npm ci, before the source COPY) so it caches with the deps layer and
# only re-runs when package*.json changes. Non-fatal: a registry hiccup must never
# break the build — fall back to an empty manifest. Mirrors `npm run licenses`.
#
# Version-pinned (not `--yes license-checker-rseidelsohn` bare): an unpinned `npx
# --yes` re-resolves to whatever is latest on the registry at build time — a
# malicious or compromised release of this package would run unreviewed code
# during every image build. Bump the pin deliberately when upgrading.
RUN --mount=type=cache,target=/root/.npm \
    npx --yes license-checker-rseidelsohn@5.0.1 --production --json --excludePrivatePackages \
        --out third-party-npm-licenses.json \
    || { echo "WARN: license manifest generation FAILED — shipping a self-describing placeholder"; \
         echo '{"__generation_failed__":"license-checker failed during this image build; this manifest is INCOMPLETE. See THIRD-PARTY-NOTICES.md for the curated component list, or regenerate with: npm run licenses"}' \
            > third-party-npm-licenses.json; }

# Copy source code (invalidates cache only when code changes)
COPY . ./

# Accept build args — build identity (see deriveBuildInfo / vite.config.ts) and sourcemaps.
#
# APP_VERSION defaults to empty, NOT the literal "dev": an empty ENV is falsy, so
# config.ts's fallback chain (deriveBuildInfo) can still resolve a real value —
# git describe, or package.json's `version` (+short sha) when there's no git at
# all, which is the normal case here since `.dockerignore` excludes `.git` from
# this build context. A hardcoded "dev" default used to short-circuit that
# chain unconditionally, so every build without an explicit --build-arg (the
# plain `docker build .` a source build does) showed "Version dev" regardless
# of what git or package.json actually said.
ARG APP_VERSION=
ARG APP_COMMIT=
ARG APP_COMMIT_SHORT=
ARG APP_BUILD_TIME=
ARG APP_BRANCH=
ARG API_CONTRACT_STRICT=
ENV API_CONTRACT_STRICT=$API_CONTRACT_STRICT
ENV APP_VERSION=$APP_VERSION \
    APP_COMMIT=$APP_COMMIT \
    APP_COMMIT_SHORT=$APP_COMMIT_SHORT \
    APP_BUILD_TIME=$APP_BUILD_TIME \
    APP_BRANCH=$APP_BRANCH
ARG SOURCEMAP=false
ENV SOURCEMAP=$SOURCEMAP

# Build application (increase heap to avoid OOM during Vite build).
# Full esbuild parallelism, always — this stage is native by construction.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build \
    && test -s build/task-runtime.js \
    && test -s build/task-executor.js \
    && test -s build/task-executor-guardian.js \
    && test -s build/livetv-proxy-build

# Stage 2 - production node_modules for the TARGET architecture.
#
# Deliberately NOT pinned to $BUILDPLATFORM: this is the one part of the build
# that must match the image we ship, because it contains prebuilt native binaries
# (@img/sharp-*, @valkey/valkey-glide-*, msgpackr-extract). On a cross-build this
# stage IS emulated — that is fine and cheap. It only downloads and unpacks
# prebuilds; no Go binary is executed, so the esbuild/QEMU deadlock that forced
# the `builder` stage to stay native does not apply here.
#
# glibc base, matching the Ubuntu runtime stage below. This stage used to be
# node:25-alpine on the belief that npm resolves BOTH the musl and glibc optional
# variants from the lockfile. It does not: @img/sharp-*, @valkey/valkey-glide-*
# and friends each declare `"libc": ["glibc"]` or `["musl"]`, and npm honours that
# field — on alpine it installs the musl set ONLY. The glibc binaries that made it
# into shipped images were coming from a stale prod-deps cache layer; the first
# build after that layer was evicted produced an image with musl-only bindings and
# preprod crash-looped on `Cannot find module '@valkey/valkey-glide-linux-x64-gnu'`.
# Resolving on the same libc we ship makes the stage produce what the runtime needs.
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS prod-deps
WORKDIR /app

COPY package*.json ./
COPY packages/@sapd/lumastra-plugin-sdk/package.json packages/@sapd/lumastra-plugin-sdk/package.json

# `prepare` is husky, a devDependency — with --omit=dev it is not installed and the
# lifecycle script would fail the install. Dropping it here is safe: this stage
# contributes ONLY node_modules to the final image, and package.json is copied from
# `builder`, so the shipped manifest still has its scripts intact.
RUN --mount=type=cache,target=/root/.npm \
    npm pkg delete scripts.prepare \
    && npm ci --omit=dev --legacy-peer-deps

# Native executables for the TARGET architecture: glibc binaries for the Ubuntu runtime.
# The stage runs on the BUILD platform and cross-compiles when the target differs
# (an arm64 release build no longer compiles Rust under QEMU, which took most of
# the release job). Native builds (target == build arch) are unchanged.
# Runtime selection remains explicit; packaging does not activate either binary.
FROM --platform=$BUILDPLATFORM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS native-node-tools
FROM --platform=$BUILDPLATFORM rust:1.99.1-bookworm AS native-builder
ARG TARGETARCH
ARG BUILDARCH
ENV CARGO_BUILD_JOBS=2
WORKDIR /app
COPY --from=native-node-tools /usr/local/bin/node /usr/local/bin/node
COPY native/ native/
COPY scripts/native.mjs scripts/native.mjs
RUN set -eu; \
    if [ "$TARGETARCH" != "$BUILDARCH" ]; then \
        case "$TARGETARCH" in \
            arm64) triple=aarch64-unknown-linux-gnu; gnu=aarch64-linux-gnu; pkg=gcc-aarch64-linux-gnu ;; \
            amd64) triple=x86_64-unknown-linux-gnu; gnu=x86_64-linux-gnu; pkg=gcc-x86-64-linux-gnu ;; \
            *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;; \
        esac; \
        apt-get update && apt-get install -y --no-install-recommends "$pkg" libc6-dev-"$TARGETARCH"-cross \
            && rm -rf /var/lib/apt/lists/*; \
        toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' native/rust-toolchain.toml); \
        rustup target add --toolchain "$toolchain" "$triple"; \
        env_triple=$(echo "$triple" | tr 'a-z-' 'A-Z_'); \
        export CARGO_BUILD_TARGET="$triple" \
            "CARGO_TARGET_${env_triple}_LINKER=${gnu}-gcc" \
            "CC_$(echo "$triple" | tr '-' '_')=${gnu}-gcc" \
            "AR_$(echo "$triple" | tr '-' '_')=${gnu}-ar"; \
    fi; \
    node scripts/native.mjs build watcher \
    && node scripts/native.mjs licenses watcher \
    && node scripts/native.mjs build livetv-proxy \
    && node scripts/native.mjs licenses livetv-proxy

# Official Node distribution for the TARGET architecture (no $BUILDPLATFORM pin).
# All Node stages use the same patch version and multi-arch INDEX digests.
# Keep these pins >= .node-min-version; Dependabot checks for updates daily.
# Bookworm glibc 2.36 binaries run on Ubuntu noble's newer glibc 2.39.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node-runtime

# Production runtime (Ubuntu 24.04 "noble").
# Ubuntu base (not Debian) because the Intel GPU userspace required for QSV (the
# oneVPL GPU runtime, libmfx-gen1) and HDR->SDR tonemapping (intel-opencl-icd) is
# published only via Intel's apt repo, which targets Ubuntu — the same reason
# Jellyfin's official image is Ubuntu-based. This lets the portable jellyfin-ffmpeg
# fetched at runtime dlopen every Linux HW path: Intel VA-API (iHD) + Intel QSV
# (oneVPL) + Intel OpenCL + AMD VA-API (mesa); NVIDIA NVENC libs are injected at
# runtime by the nvidia-container-toolkit. node_modules ships the glibc
# prebuilt native binaries (sharp etc.); the glibc variant is manylinux-targeted
# and runs fine on Ubuntu's glibc.
FROM ubuntu:24.04

# Node.js 24 from the official image (same patch as the build/prod-deps stages,
# so the prebuilt node_modules ABI matches). Base runtime tools: xz-utils to extract the
# portable jellyfin-ffmpeg .tar.xz (fetched at boot by scripts/fetch-ffmpeg.sh —
# not baked in), libchromaprint-tools for fpcalc, procps for healthcheck `ps`,
# libjemalloc2 (swapped in by default below — glibc malloc's per-thread arena
# fragmentation is a real, well-documented source of Node.js RSS bloat that
# neither --max-old-space-size nor V8 heap tuning can touch, since V8 manages
# its own heap via direct mmap, not malloc; jemalloc only affects
# malloc-routed native memory — Buffers, native addons, libuv, OpenSSL —
# which measurement on preprod showed was the majority of this app's worker
# RSS, not the JS heap), and fontconfig + fonts-dejavu-core, which back the
# Top Shelf overlay text rendering (sharp/librsvg renders SVG <text> at
# runtime and needs fontconfig plus at least one installed font or text
# overlays fail). tini is the image ENTRYPOINT (see the bottom of this file):
# it reaps orphaned FFmpeg children that node, as PID 1, never waited on.
#
# `tsx` to run the migration/worker entrypoints is NOT installed here anymore
# (`npm install -g tsx` used to re-resolve to whatever is latest on every
# build, back when ARG APP_COMMIT sat above it and busted the cache on every commit). It is
# now an exact-pinned production dependency in package.json, installed with
# integrity verification by `npm ci --omit=dev` in the `prod-deps` stage and
# copied in via that stage's node_modules below — see start.sh /
# start-worker.sh / scripts/fetch-ffmpeg.sh, which now invoke
# `node_modules/.bin/tsx` instead of a global/PATH `tsx`.
#
# `apt-get upgrade` first: installing packages never upgrades the ones already in
# the ubuntu:24.04 base layer, and that layer is cached between builds, so the
# image shipped with pending noble-security fixes (libfreetype6, librsvg2 on
# 2026-10-07) until the base tag happened to be re-pulled. The layer cache keys on
# the instruction text, so CI passes the ISO week as OS_PATCH_EPOCH: a new week
# re-runs this layer, builds within the week reuse it.
ARG OS_PATCH_EPOCH=
RUN echo "OS patch epoch: ${OS_PATCH_EPOCH:-unset}" \
    && apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg xz-utils libchromaprint-tools procps util-linux libjemalloc2 \
        fontconfig fonts-dejavu-core tini libstdc++6 libgcc-s1 libatomic1 \
    && mkdir -p /usr/share/keyrings \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy the upstream Node binary and bundled npm/Corepack, not the source image's
# entrypoint or user. Ubuntu's PATH already puts /usr/local/bin first; start.sh,
# start-worker.sh and tsx's /usr/bin/env node shebang resolve this binary.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-runtime /usr/local/LICENSE /usr/local/share/doc/node/LICENSE
COPY .node-min-version /app/.node-min-version
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && node --version && npm --version && npx --version && corepack --version \
    && node -e 'const min = require("node:fs").readFileSync("/app/.node-min-version", "utf8").trim(); \
        if (!/^\d+\.\d+\.\d+$/.test(min)) throw new Error("Invalid .node-min-version"); \
        const required = min.split(".").map(Number); \
        const delta = process.versions.node.split(".").map((n, i) => Number(n) - required[i]).find(n => n !== 0) ?? 0; \
        if (delta < 0) throw new Error(`Node ${process.versions.node} is below minimum ${min}`);'

# Force jemalloc as the process-wide allocator. background_thread:true lets
# jemalloc return freed pages to the OS on its own background thread rather than
# only at the next allocation, which is what actually keeps RSS from plateauing
# high. Override LD_PRELOAD to empty in a specific deployment's env if this ever
# needs to be disabled for troubleshooting.
#
# The lib path is arch-DEPENDENT (Debian multiarch: x86_64-linux-gnu vs
# aarch64-linux-gnu), and ENV cannot branch — so resolve it once at build time
# and expose it under a stable, arch-independent path. Hardcoding the x86_64
# triplet (as this did while the image was amd64-only) does not fail the build
# on arm64: ld.so just prints "cannot be preloaded ... ignored" on EVERY exec
# — including the healthcheck — and silently runs with glibc malloc, i.e. the
# RSS problem jemalloc is here to solve comes back with no error to notice.
# Fail the build instead if the lib is missing.
RUN set -eux; \
    jemalloc="$(ls /usr/lib/*/libjemalloc.so.2 2>/dev/null | head -n1)"; \
    if [ -z "$jemalloc" ]; then \
        echo "FATAL: libjemalloc.so.2 not found for $(dpkg --print-architecture)"; \
        exit 1; \
    fi; \
    mkdir -p /usr/local/lib; \
    ln -sf "$jemalloc" /usr/local/lib/libjemalloc.so.2; \
    echo "jemalloc: $jemalloc -> /usr/local/lib/libjemalloc.so.2"
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true

# UID/GID 1000: Ubuntu 24.04 ships a default `ubuntu` user at 1000 — remove it and
# recreate it as `node` (matches the build stage + the Jellyfin media-permission
# convention). The compose adds the host `render` group for /dev/dri at runtime.
RUN userdel -r ubuntu 2>/dev/null || true; \
    groupadd -g 1000 node && useradd -u 1000 -g 1000 -m -s /bin/bash node

# Download Essentia extractors (static binary for audio analysis)
# Binary is named "streaming_extractor_music" in the archive; rename to match ESSENTIA_EXTRACTOR_PATH
#
# Essentia only ships a prebuilt linux-x86_64 extractor — there is NO arm64 build
# (https://essentia.upf.edu/extractors/). On non-amd64 arches we skip it; the app
# degrades gracefully (isEssentiaAvailable() returns false → music audio analysis
# is skipped with a logged warning, no crash). See
# src/lib/server/services/essentia-analysis.service.ts.
#
# SHA256 pinned below (verified 2026-09-14, TLS-verified download from
# essentia.upf.edu) — download to a file and verify BEFORE extracting, the same
# pattern scripts/fetch-ffmpeg.sh uses for the runtime-fetched ffmpeg binary.
# essentia.upf.edu does not publish a digest of its own to cross-check against,
# so this pin — baked into our own source rather than fetched from the same
# server serving the binary — is the actual root of trust: it stops a
# compromised/tampered essentia.upf.edu download from being extracted and run
# as root during the image build. Bump deliberately (re-download + re-verify by
# hand) when moving to a newer extractor release.
ARG ESSENTIA_VERSION=v2.1_beta2
ARG ESSENTIA_SHA256=b6aaaefab379cb6cc0a12d95865327813ecffa2a8a3d2ad37619456e9cfbaaa6
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        set -eux; \
        curl -fsSL -o /tmp/essentia.tar.gz \
            "https://essentia.upf.edu/extractors/essentia-extractors-${ESSENTIA_VERSION}-linux-x86_64.tar.gz"; \
        echo "${ESSENTIA_SHA256}  /tmp/essentia.tar.gz" | sha256sum -c -; \
        tar xz -C /tmp -f /tmp/essentia.tar.gz \
        && mv "/tmp/essentia-extractors-${ESSENTIA_VERSION}/streaming_extractor_music" /usr/local/bin/essentia_streaming_extractor_music \
        && chmod +x /usr/local/bin/essentia_streaming_extractor_music \
        && rm -rf "/tmp/essentia-extractors-${ESSENTIA_VERSION}" /tmp/essentia.tar.gz; \
    else \
        echo "Skipping Essentia extractor: no prebuilt binary for $(dpkg --print-architecture). Music audio analysis (BPM/mood) will be disabled on this arch."; \
    fi

# Multi-vendor GPU userspace for the runtime-fetched jellyfin-ffmpeg to dlopen
# against the shared /dev/dri device (amd64-gated — Intel/AMD/NVIDIA GPUs are
# x86). Non-fatal: a build-time failure here must never break the image; the app
# falls back to software transcode.
#   Intel: VA-API (iHD driver) + QSV (oneVPL GPU runtime libmfx-gen1 + libvpl2) +
#          OpenCL (intel-opencl-icd, used for HDR->SDR tonemapping) — from Intel's
#          official noble GPU apt repo (these QSV/OpenCL runtimes are NOT in the
#          Debian/Ubuntu base repos, which is why this image is Ubuntu-based).
#   AMD:   VA-API via mesa-va-drivers (on Linux, AMD HW transcode == VA-API; AMF
#          is Windows-only and cannot run in a Linux container).
#   NVIDIA: NVENC encoders are compiled into jellyfin-ffmpeg; the driver libs
#          (libnvidia-encode / libcuda) are injected at runtime by the host's
#          nvidia-container-toolkit (see NVIDIA_* env below) — no image package.
# This step FAILS the build when it cannot install, and that is deliberate. It
# used to end in `|| echo "WARN: …"`, so a transient fetch failure produced a
# green build and an image with no GPU userspace at all — which is exactly what
# reached prod on 2026-08-27: `/usr/share/keyrings/intel-graphics.gpg` was
# 0 bytes, intel-gpu-noble.list was never written, only the Ubuntu-base packages
# landed, and `vainfo` was absent. The operator found out from a
# "Hardware transcoding (qsv) unavailable" alert hours later, while the
# preprod image built from the same commit was fine. A failed build you can
# retry beats a silently degraded image you ship to prod.
#
# Retried, because the failure it hit was transient: Intel's repo answered
# HTTP 200 with the full 5,615-byte key when checked shortly afterwards.
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        set -eux; \
        for attempt in 1 2 3; do \
            curl -fsSL --retry 3 --retry-delay 2 --max-time 60 \
                 https://repositories.intel.com/gpu/intel-graphics.key \
              | gpg --dearmor -o /usr/share/keyrings/intel-graphics.gpg \
            && [ -s /usr/share/keyrings/intel-graphics.gpg ] \
            && break; \
            echo "Intel GPU key fetch failed (attempt $attempt) — retrying"; \
            rm -f /usr/share/keyrings/intel-graphics.gpg; \
            sleep 5; \
        done; \
        # An empty keyring is the exact shape of the prod failure: gpg creates the
        # file before it has anything to write, so `-o` succeeding proves nothing.
        [ -s /usr/share/keyrings/intel-graphics.gpg ] \
            || { echo "FATAL: could not fetch Intel GPU signing key"; exit 1; }; \
        echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble client" \
            > /etc/apt/sources.list.d/intel-gpu-noble.list; \
        apt-get update; \
        apt-get install -y --no-install-recommends \
            intel-media-va-driver-non-free libmfx-gen1 libvpl2 intel-opencl-icd libigdgmm12 \
            mesa-va-drivers libva2 libva-drm2 vainfo; \
        # Verify the outcome rather than the exit code — apt can succeed while the
        # Intel repo silently contributes nothing, which is how the broken image
        # still passed. vainfo is the binary the runtime health check spawns, so
        # its absence is precisely what the operator would see as "unavailable".
        command -v vainfo >/dev/null \
            || { echo "FATAL: GPU userspace installed but vainfo is missing"; exit 1; }; \
        apt-get clean && rm -rf /var/lib/apt/lists/*; \
    else \
        echo "Skipping GPU userspace: x86-only ($(dpkg --print-architecture))."; \
    fi

# NVIDIA NVENC: harmless on non-NVIDIA hosts; only takes effect when the host's
# nvidia-container-toolkit injects the driver (compose `runtime: nvidia` / --gpus).
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

# Note: Essentia SVM models for highlevel classifiers (voice/instrumental, mood)
# require a Gaia-enabled binary. The pre-built static binary does not include Gaia,
# so voice/instrumental detection uses a lowlevel spectral heuristic instead.

# FFmpeg is fetched at runtime into $FFMPEG_CACHE_DIR (persist via a volume on
# /config). Defaults below are read by scripts/fetch-ffmpeg.sh and by the app.
ENV FFMPEG_CACHE_DIR=/config/bin
ENV FFMPEG_PATH=/config/bin/ffmpeg
ENV FFPROBE_PATH=/config/bin/ffprobe
ENV FFMPEG_VERSION=v7.1.4-3
ENV FFMPEG_AUTO_DOWNLOAD=true
# Set Essentia/Chromaprint paths for music analysis
ENV ESSENTIA_EXTRACTOR_PATH=/usr/local/bin/essentia_streaming_extractor_music
ENV FPCALC_PATH=/usr/bin/fpcalc

WORKDIR /app

# Copy dependencies and the built application from the earlier stages.
# node_modules is the ONLY target-arch artifact — from prod-deps, not builder.
# Taking it from `builder` would ship the BUILD host's native binaries and the
# image would die on first `require('sharp')` with an exec-format/ELF error.
# It goes FIRST: build/ changes on every commit, and a COPY after it re-runs
# and yields a new ~165 MB layer digest even when node_modules is unchanged.
COPY --chown=node:node --from=prod-deps /app/node_modules node_modules/
COPY --chown=node:node --from=builder /app/build build/
COPY --chown=node:node --from=native-builder /app/build/ build/
# The cross-compiled binaries must run on the target: an exec-format or glibc
# mismatch fails the build here instead of crash-looping the worker on boot.
RUN build/lumastra-watcher --version && build/lumastra-livetv-proxy --version \
    && test -s build/livetv-proxy-build
# Workspace packages — node_modules/@sapd/lumastra-plugin-sdk is a symlink that points
# back into this directory. Required at runtime because scripts/startup-migration.ts
# is run via tsx (not the bundled SvelteKit build), and tsx resolves
# `@sapd/lumastra-plugin-sdk` by following the symlink to the on-disk source.
# Without this, the migration crashes with ERR_MODULE_NOT_FOUND on the SDK package.
COPY --chown=node:node --from=builder /app/packages packages/
COPY --chown=node:node --from=builder /app/src src/
COPY --chown=node:node --from=builder /app/scripts scripts/
COPY --chown=node:node --from=builder /app/deploy/docker/start.sh start.sh
COPY --chown=node:node --from=builder /app/deploy/docker/start-worker.sh start-worker.sh
COPY --chown=node:node --from=builder /app/deploy/docker/start-proxy.sh start-proxy.sh
COPY --chown=node:node --from=builder /app/tsconfig.scripts.json tsconfig.scripts.json
COPY --chown=node:node --from=builder /app/package.json package.json
# Read at runtime from process.cwd(): /api-docs (Swagger UI + ?format=yaml|json) serves
# api-v1.yaml, /api-docs?format=md and /llms.txt serve API.md. Without them all three
# fall back to an empty stub spec.
COPY --chown=node:node --from=builder /app/docs/api/api-v1.yaml docs/api/api-v1.yaml
COPY --chown=node:node --from=builder /app/docs/api/API.md docs/api/API.md
# License + third-party attribution. Shipping these in the image satisfies the
# attribution / "corresponding source" notice obligations of the copyleft
# components we bundle or fetch (Essentia AGPL-3.0, jellyfin-ffmpeg GPL-3.0,
# fpcalc, libvips, akarisub/fribidi/FreeType). See THIRD-PARTY-NOTICES.md.
COPY --chown=node:node --from=builder /app/LICENSE LICENSE
COPY --chown=node:node --from=builder /app/LICENSES LICENSES/
COPY --chown=node:node --from=builder /app/LICENSING.md LICENSING.md
COPY --chown=node:node --from=builder /app/THIRD-PARTY-NOTICES.md THIRD-PARTY-NOTICES.md
COPY --chown=node:node --from=builder /app/LICENSES/THIRD-PARTY-NOTICES-akarisub-COPYRIGHT.txt LICENSES/THIRD-PARTY-NOTICES-akarisub-COPYRIGHT.txt
COPY --chown=node:node --from=builder /app/third-party-npm-licenses.json third-party-npm-licenses.json
# External drop-in plugins. The image ships the MAL watch-sync example plus the
# shoutbox (a feature-plugin reference + real feature).
# lumastra-intro-analyzer is a builtin native now (tasks/builtin/native/
# lumastra-intro-analyzer.ts) and no longer ships as an external bundle.
# Operators add their own drop-ins by mounting onto $PLUGINS_EXTERNAL_DIR.
#
# These ship into /app/plugins-bundled, NOT /app/plugins. The two were the same
# path until 2026-08-27, and sharing it broke both halves at once: mounting a
# volume over /app/plugins is what makes INSTALLED plugins survive an image
# update, but a named volume is seeded from the image only on FIRST use and
# never re-seeded — so the operator's volume kept a frozen copy of these files
# and a first-party plugin fixed in a later image never reached them. Splitting
# the paths means the image dir is always current and the volume holds only what
# the operator installed. It also lets PLUGINS_REQUIRE_REGISTRY=true be
# recommended, which previously disabled every plugin below (they have no
# registry row). Override with $PLUGINS_BUNDLED_DIR.
COPY --chown=node:node --from=builder /app/plugins/mal-watch-sync/index.js /app/plugins-bundled/mal-watch-sync/index.js
COPY --chown=node:node --from=builder /app/plugins/trakt-watch-sync/index.js /app/plugins-bundled/trakt-watch-sync/index.js
# Shoutbox is an UNBUNDLED multi-file drop-in (no src/index.ts, so build:plugins
# skips it; the loader loads index.js directly and it dynamic-imports ./lib/*.js
# + reads ./widget.js from disk at runtime). Ship the runtime .js only — the
# `lib/*.js` glob deliberately excludes the *.test.ts files.
COPY --chown=node:node --from=builder /app/plugins/shoutbox/index.js /app/plugins/shoutbox/widget.js /app/plugins-bundled/shoutbox/
COPY --chown=node:node --from=builder /app/plugins/shoutbox/lib/*.js /app/plugins-bundled/shoutbox/lib/
# Announcement is a simple two-file drop-in (index.js + widget.js, no lib/, no DB).
COPY --chown=node:node --from=builder /app/plugins/announcement/index.js /app/plugins/announcement/widget.js /app/plugins-bundled/announcement/

# Fix line endings (Windows git checkout may convert LF to CRLF) and make executable
# Create transcode directory for multi-audio HLS with proper permissions
RUN sed -i 's/\r$//' start.sh start-worker.sh start-proxy.sh scripts/fetch-ffmpeg.sh \
    && chmod +x start.sh start-worker.sh start-proxy.sh scripts/fetch-ffmpeg.sh \
    # sed -i replaces the files, so they come back root-owned; the rest of /app
    # is already node-owned via COPY --chown (a chown -R here would copy all of
    # /app, node_modules included, into this layer on every build).
    && chown node:node /app start.sh start-worker.sh start-proxy.sh scripts/fetch-ffmpeg.sh \
    && mkdir -p /tmp/lumastra-transcode && chown node:node /tmp/lumastra-transcode \
    && mkdir -p /config && chown node:node /config \
    # Pre-create the ffmpeg cache dir node-owned so a volume mounted on /config (or
    # /config/bin) inherits node ownership and fetch-ffmpeg.sh can write to it.
    && mkdir -p /config/bin && chown node:node /config/bin \
    # Pre-create the image cache dir (process.cwd()/.cache) OWNED BY node so that
    # when it's backed by a named docker volume (e.g. `cache:/app/.cache`), the
    # volume inherits node ownership on first creation. Without this the volume
    # is created root-owned and the non-root `node` process gets EACCES on
    # mkdir '/app/.cache/<provider>' — silently disabling ALL image caching on a
    # fresh install. (Volume ownership is seeded from the image path at mount.)
    && mkdir -p /app/.cache && chown node:node /app/.cache

# Production environment
ENV NODE_ENV=production

# adapter-node request body cap. Unset, it is 512K: every avatar over 512 KiB
# (the UI allows 2 MB) and every artwork upload (MAX_IMAGE_UPLOAD_MB, default
# 10) was refused on an install that did not copy the compose example. Same
# value as docker-compose.example.yml and the Helm chart (app.bodySizeLimit);
# a reverse proxy in front needs a body limit at least this large.
ENV BODY_SIZE_LIMIT=50M

# Runtime optimizations:
# - UV_THREADPOOL_SIZE: libuv runs async fs, getaddrinfo (DNS) and crypto on this
#   shared pool. The worker is heavily I/O-bound (NFS file walks/probes) AND must
#   keep resolving DNS for Postgres/Valkey. A small pool lets a burst of slow NFS
#   reads occupy every thread and starve DNS → connection CONNECT_TIMEOUTs →
#   heartbeat/reconciler failures → task-runner wedge. We size the pool large so
#   there is always ample headroom; the app ALSO caps concurrent guarded fs ops
#   well below this (LUMASTRA_FS_MAX_CONCURRENCY, see utils/safe-fs.ts) so file I/O
#   can never consume the whole pool regardless of size. Override per-env if needed.
# - NODE_OPTIONS: Increase memory if needed (default ~512MB is usually fine)
ENV UV_THREADPOOL_SIZE=64

EXPOSE 3000

# Switch to non-root user (UID/GID 1000, compatible with Jellyfin media permissions)
USER node

# Background encoders use idle I/O and nice 19. Verify the non-root runtime can
# lower its own priority without CAP_SYS_NICE (both wrappers exec their child).
RUN /usr/bin/ionice -t -c 3 /usr/bin/nice -n 19 node -e "if (require('node:os').getPriority() !== 19) process.exit(1)"

# Build identity. Re-declared in this stage (ARG/ENV do not cross multi-stage
# boundaries) and surfaced to the running app + stream-proxy at runtime.
# config.ts reads these from process.env at runtime; CI sets them from git
# (git describe + SHA + build time). APP_VERSION defaults to empty (not the
# literal "dev") so a hand-run build with no --build-arg falls through to
# config.ts's own resolution (package.json version, +short sha if known)
# instead of always shipping the placeholder string "dev" as the version.
#
# Deliberately the LAST thing before the entrypoint: these values change on
# every commit, and an ARG invalidates the build cache of every instruction
# after it. At the top of the stage it rebuilt the apt/Node/GPU layers
# on every build, uploading the base layers to the central registry over the
# private network instead of just the app layers.
ARG APP_VERSION=
ARG APP_COMMIT=
ARG APP_COMMIT_SHORT=
ARG APP_BUILD_TIME=
ARG APP_BRANCH=
ENV APP_VERSION=$APP_VERSION \
    APP_COMMIT=$APP_COMMIT \
    APP_COMMIT_SHORT=$APP_COMMIT_SHORT \
    APP_BUILD_TIME=$APP_BUILD_TIME \
    APP_BRANCH=$APP_BRANCH

# A minimal init as PID 1. Without it, `node` (exec'd by start.sh) is PID 1 and
# nothing reaps an FFmpeg child whose parent exited or whose `wait` was never
# collected: the runtime pass on preprod left two such zombies. tini forwards
# SIGTERM/SIGINT to its child (start.sh execs node, so the child IS node and
# hooks.server.ts' gracefulShutdown still runs) and exits with its code. `-s`
# registers it as a child subreaper too, so reaping still works when something
# else is PID 1 (docker `--init`, compose `init: true`, a k8s pod sharing its
# process namespace). Setting it here, not in compose, makes it hold on compose,
# Compose and Kubernetes alike — but a compose `entrypoint:` or a k8s
# `command:` REPLACES it; override the CMD (compose `command:`, k8s `args:`)
# instead, or add `init: true` where the entrypoint must change.
ENTRYPOINT [ "/usr/bin/tini", "-s", "--" ]
CMD [ "./start.sh" ]
