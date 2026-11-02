#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only

# Generate synthetic media files for E2E testing.
# Requires: ffmpeg
#
# Usage: ./scripts/test/generate-test-media.sh [OUTPUT_DIR]
#   OUTPUT_DIR defaults to tests/fixtures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-$SCRIPT_DIR/../../tests/fixtures}"
mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# Video fixtures
# ---------------------------------------------------------------------------
VIDEO_FILE="$OUTPUT_DIR/test-video.mp4"
if [ ! -f "$VIDEO_FILE" ]; then
    echo "[generate] Creating test video: $VIDEO_FILE"
    ffmpeg -y -f lavfi -i "color=c=blue:s=320x240:d=2" \
        -f lavfi -i "sine=frequency=440:duration=2" \
        -c:v libx264 -preset ultrafast -crf 51 \
        -c:a aac -b:a 32k \
        "$VIDEO_FILE" 2>/dev/null
else
    echo "[generate] Skipping test video (already exists)"
fi

# ---------------------------------------------------------------------------
# Music fixtures
# ---------------------------------------------------------------------------
MUSIC_DIR="$OUTPUT_DIR/music/Test Artist/Test Album"
mkdir -p "$MUSIC_DIR"

MUSIC_DIR2="$OUTPUT_DIR/music/Another Artist/Another Album"
mkdir -p "$MUSIC_DIR2"

# Track 1: MP3 with ID3 tags (440Hz A4)
TRACK1="$MUSIC_DIR/01 - Test Track 01.mp3"
if [ ! -f "$TRACK1" ]; then
    echo "[generate] Creating music track 1: $TRACK1"
    ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" \
        -metadata title="Test Track 01" -metadata artist="Test Artist" \
        -metadata album="Test Album" -metadata track="1/3" \
        -metadata genre="Electronic" -metadata date="2025" \
        -b:a 64k "$TRACK1" 2>/dev/null
fi

# Track 2: MP3 (523Hz C5)
TRACK2="$MUSIC_DIR/02 - Test Track 02.mp3"
if [ ! -f "$TRACK2" ]; then
    echo "[generate] Creating music track 2: $TRACK2"
    ffmpeg -y -f lavfi -i "sine=frequency=523:duration=2" \
        -metadata title="Test Track 02" -metadata artist="Test Artist" \
        -metadata album="Test Album" -metadata track="2/3" \
        -metadata genre="Electronic" -metadata date="2025" \
        -b:a 64k "$TRACK2" 2>/dev/null
fi

# Track 3: FLAC with tags (659Hz E5) — tests lossless tag parsing
TRACK3="$MUSIC_DIR/03 - Test Track 03.flac"
if [ ! -f "$TRACK3" ]; then
    echo "[generate] Creating music track 3 (FLAC): $TRACK3"
    ffmpeg -y -f lavfi -i "sine=frequency=659:duration=2" \
        -metadata title="Test Track 03" -metadata artist="Test Artist" \
        -metadata album="Test Album" -metadata track="3/3" \
        -metadata genre="Electronic" -metadata date="2025" \
        "$TRACK3" 2>/dev/null
fi

# Second artist/album — variety for browse tests
TRACK4="$MUSIC_DIR2/01 - Different Track.mp3"
if [ ! -f "$TRACK4" ]; then
    echo "[generate] Creating music track 4 (different artist): $TRACK4"
    ffmpeg -y -f lavfi -i "sine=frequency=880:duration=2" \
        -metadata title="Different Track" -metadata artist="Another Artist" \
        -metadata album="Another Album" -metadata track="1/1" \
        -metadata genre="Jazz" -metadata date="2024" \
        -b:a 64k "$TRACK4" 2>/dev/null
fi

echo "[generate] Done. Fixtures in: $OUTPUT_DIR"
