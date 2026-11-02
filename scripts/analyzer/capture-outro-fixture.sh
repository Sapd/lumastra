#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
#
# Capture a real-media fixture for the intro-analyzer's Outro detectors.
#
# WHY THIS EXISTS
#   The Outro detectors are luma/chapter heuristics whose only real oracle is
#   "does it land where the credits actually start". Unit fixtures written by
#   hand tend to contain exactly ONE qualifying dark region, so they cannot
#   catch the failure modes that matter on real files — an earlier fade-to-black
#   winning over the true credits, or a returned segment shorter than the
#   detector's own minimum. This captures the detector's EXACT ffmpeg input from
#   a real file so those cases can be pinned as regression tests.
#
# USAGE
#   ./capture-outro-fixture.sh <media-file> [expected-outro-start]
#
#   `expected-outro-start` is optional and accepts seconds (2683), mm:ss /
#   h:mm:ss (44:43), or the literal `none`.
#
#   `none` marks a NEGATIVE fixture: a file verified to have no credits
#   sequence at all. Those are the most valuable captures — a false positive
#   puts a skip-credits button in the middle of the episode, which is worse
#   than no marker. Omit the argument entirely to record an observation with
#   no assertion (its checks then skip rather than passing vacuously).
#
#   Emits fixture JSON on stdout. Run it wherever the media lives (it only needs
#   ffmpeg + ffprobe), then commit the JSON under __fixtures__/ next to the
#   detector tests:
#
#     ssh <media-host> 'bash -s' < capture-outro-fixture.sh \
#         "/data/.../S03E12.mkv" 44:43 > tng-s03e12.json
#
# CONTRACT
#   The ffmpeg invocation below MUST match what detectBlackFrames() in
#   src/lib/server/utils/ffmpeg-analysis.ts builds AT THE CALL SITE IN
#   blackframe.ts — not the module defaults. If the scale width, fps decimation,
#   blackframe amount or threshold changes, captured fixtures silently stop
#   representing what the detector sees.
set -euo pipefail

FILE="${1:?usage: capture-outro-fixture.sh <media-file> [expected-outro-start]}"
EXPECTED_RAW="${2:-}"

# Episode defaults from EffectiveConfig (buildBlackframeConfig):
#   minCreditsDuration = minSegmentDuration = 15
#   maxSearchDistance  = maxCreditsDuration = 300
MIN_CREDITS=15
MAX_SEARCH=300
# DEFAULT_BLACKFRAME_CONFIG supplies the threshold, but NOT the amount:
# analyzeBlackFrames deliberately calls detectBlackFrames with
# `minimumBlackPct: 0` ("Ask ffmpeg for every decimated frame... the complete
# pblack signal lets us recognise the decisive cut from a very dark scene into
# an actually black credits plate", blackframe.ts). Capturing at amount=50
# silently drops every sub-50% frame, which is precisely the signal the ramp
# detector reads for `precedingBlackPct` — it would make fixtures stricter than
# production and hide false positives.
BLACK_AMOUNT=0
BLACK_THRESHOLD=32

to_seconds() {
    # accepts "", "none", "2683", "44:43", "1:02:03"
    local v="$1"
    [ -z "$v" ] && { echo "null"; return; }
    [ "$v" = "none" ] && { echo "null"; return; }
    awk -v s="$v" 'BEGIN{
        n = split(s, p, ":")
        if (n == 1) { printf "%.3f", p[1] }
        else if (n == 2) { printf "%.3f", p[1]*60 + p[2] }
        else { printf "%.3f", p[1]*3600 + p[2]*60 + p[3] }
    }'
}

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE")
SEARCH_START=$(awk -v d="$DURATION" -v mc="$MIN_CREDITS" -v ms="$MAX_SEARCH" 'BEGIN{
    mo = ms; if (d - mc < mo) mo = d - mc
    s = d - mo; if (s < 0) s = 0
    printf "%.6f", s
}')
LENGTH=$(awk -v d="$DURATION" -v s="$SEARCH_START" 'BEGIN{ printf "%.6f", d - s }')
EXPECTED=$(to_seconds "$EXPECTED_RAW")

CHAPTERS=$(ffprobe -v error -show_chapters -of json "$FILE" | tr -d '\n')

# Mirrors detectBlackFrames() argv exactly. `-ss` before `-i` seeks on input, so
# reported `t:` values are RELATIVE to SEARCH_START — the parser below re-adds
# the offset, matching `time: startSec + relativeTime` in ffmpeg-analysis.ts.
FRAMES=$(ffmpeg -hide_banner -nostdin -ss "$SEARCH_START" -i "$FILE" -t "$LENGTH" \
    -an -dn -sn \
    -vf "scale=320:-2:flags=fast_bilinear,fps=5,blackframe=amount=${BLACK_AMOUNT}:threshold=${BLACK_THRESHOLD}" \
    -f null - 2>&1 |
    grep -oE 'pblack:[0-9]+.*?t:[0-9.]+' |
    awk -v off="$SEARCH_START" -F'[:[:space:]]+' '{
        pct = ""; t = ""
        for (i = 1; i < NF; i++) {
            if ($i == "pblack") pct = $(i+1)
            if ($i == "t") t = $(i+1)
        }
        if (pct != "" && t != "") printf "%s{\"t\":%.3f,\"pct\":%d}", (NR>1 ? "," : ""), t + off, pct
    }')

cat <<JSON
{
  "file": $(printf '%s' "$FILE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "durationSec": $DURATION,
  "searchStartSec": $SEARCH_START,
  "expectedOutroStartSec": $EXPECTED,
  "expectNoOutro": $([ "$EXPECTED_RAW" = "none" ] && echo true || echo false),
  "capture": {
    "minCreditsDuration": $MIN_CREDITS,
    "maxSearchDistance": $MAX_SEARCH,
    "blackframeAmount": $BLACK_AMOUNT,
    "blackframeThreshold": $BLACK_THRESHOLD,
    "sampleFps": 5,
    "scaleWidth": 320
  },
  "chapters": $CHAPTERS,
  "frames": [$FRAMES]
}
JSON
