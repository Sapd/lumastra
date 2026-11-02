# HLS Streaming Engine

This document describes the HLS implementation used to deliver video and audio to clients. The engine handles everything from codec negotiation to multi-generation seek management.

## Architecture Overview

```
Client request
  → PlaybackPlanner (decide method, codec, audio mode)
  → HlsPlaybackService (resolve plan, start FFmpeg)
  → FFmpegTranscodeService (manage FFmpeg lifecycle, generations)
  → Segment Handler (route request, wait for segment, serve file)
```

## Delivery Paths

The planner selects one of these paths based on client capabilities and source media:

| Branch                   | Delivery      | Audio Mode                       | When Used                                  |
| ------------------------ | ------------- | -------------------------------- | ------------------------------------------ |
| `native_hls_multi_audio` | `native_hls`  | muxed (copy) / demux (transcode) | Safari, Apple TV, iOS                      |
| `web_hls_single_audio`   | `mse_hls`     | muxed                            | Web browsers via hls.js — single audio     |
| `full_transcode`         | `mse_hls`     | muxed                            | Incompatible codecs, needs full re-encode  |
| `remux_api`              | `mse_hls`     | muxed                            | Compatible codec, just repackage container |
| `direct`                 | `direct_file` | n/a                              | Direct HTTP range requests, no HLS         |

> **Note:** `native_hls_multi_audio` uses muxed (single audio) for copy-mode video
> because Safari's EXTINF-accumulated `currentTime` drifts from actual PTS with
> irregular keyframes, breaking subtitle sync after seeks. Demux multi-audio is
> only used when FFmpeg fully transcodes (uniform keyframe spacing).

## Audio Modes: Demux vs Muxed

### Demux Mode (native HLS players)

Each audio track gets its own HLS stream. The master playlist advertises them as `#EXT-X-MEDIA` renditions, allowing the native player to switch audio tracks without server interaction.

```
master.m3u8
├── #EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="eng",NAME="English",URI="stream_0/index.m3u8"
├── #EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="deu",NAME="German",URI="stream_1/index.m3u8"
├── #EXT-X-STREAM-INF:BANDWIDTH=...,CODECS="...",AUDIO="audio"
│   stream_2/index.m3u8   (video)
└── #EXT-X-SUBTITLES (if present)
```

FFmpeg outputs:

```
gen-0001/
├── stream_0/   (audio track 1)
│   ├── init.mp4
│   └── segment_00000.m4s, segment_00001.m4s, ...
├── stream_1/   (audio track 2)
│   ├── init.mp4
│   └── segment_00000.m4s, ...
├── stream_2/   (video)
│   ├── init.mp4
│   └── segment_00000.m4s, ...
└── master.m3u8
```

Key properties:

- Video is always the last stream (`stream_N` where N = audio track count)
- Audio streams have `canSeek: false` — only the video stream triggers FFmpeg seeks
- Audio segment duration: 6s (fixed). Video segment duration: ~6s for transcode, keyframe-aligned (~10s) for remux
- Per-stream segment offsets account for different durations between audio and video

### Muxed Mode (web browsers)

All audio is muxed into a single stream alongside video. We initially attempted demux mode with hls.js (separate audio/video renditions like native HLS), but reliable A/V sync proved impossible — hls.js struggles to keep independent audio and video playlists synchronized, leading to persistent drift and desync. Muxing avoids this entirely.

The server publishes a synthetic VOD playlist that maps logical timeline segments to FFmpeg output segments.

```
index.m3u8 (VOD playlist)
├── #EXTINF:6.000,
│   segment_00000.ts
├── #EXTINF:6.000,
│   segment_00001.ts
└── #EXT-X-ENDLIST
```

Key properties:

- No master playlist; single playlist with muxed A/V
- Audio track switching requires a new playback session (server-side switch)
- Simpler segment routing (no per-stream offsets)

## FFmpeg Modes

### Remux (video copy + audio copy)

Source is compatible but needs HLS container repackaging (e.g., MKV → fMP4/HLS).

- `videoAction: 'copy'`, `audioAction: 'copy'`
- Segment naming: local indices (`segment_00000.m4s`, `segment_00001.m4s`, ...)
- Offset handling: **per-stream** via `streamSegmentOffsets` — video has keyframe-aligned ~10s segments while audio has fixed 6s segments
- Seek alignment: snaps to nearest keyframe boundary using `keyframeData`
- CPU usage: near zero

### Full Transcode (video re-encode)

Source codec is incompatible (e.g., AV1 → HEVC for Apple TV).

- `videoAction: 'transcode'`, `audioAction: 'transcode'` (typically)
- Segment naming: global indices (`segment_00500.m4s` after seek to offset 500 via `-start_number`)
- Offset handling: **single global** `segmentOffset` for all streams (FFmpeg controls exact boundaries)
- Encoder selection: GPU-accelerated when available (`hevc_nvenc`, `hevc_qsv`, etc.), falls back to software (`libx265`)
- CPU/GPU usage: high

### Audio-Only Transcode

Video is copied, but audio needs re-encoding (e.g., DTS → AAC for HLS compatibility).

- `videoAction: 'copy'`, `audioAction: 'transcode'`
- Hybrid offset handling (video per-stream keyframe-aligned, audio global)

## Generation System

Each seek creates a new FFmpeg "generation" rather than restarting in-place. This allows the old generation's segments to continue serving stale requests while the new generation catches up.

### Lifecycle

```
1. Initial playback → Gen 1 (role: current, offset: 0)
2. User seeks to 500 →
   - Gen 1 → role: previous (retained, still serving segments 0-N)
   - Gen 2 → role: current (offset: 500, FFmpeg starts here)
3. User seeks to 800 →
   - Gen 1 → retired (directory deleted, too far from anchor)
   - Gen 2 → role: previous (retained, serving segments 500-N)
   - Gen 3 → role: current (offset: 800)
```

### Configuration

| Setting                                  | Default | Purpose                                         |
| ---------------------------------------- | ------- | ----------------------------------------------- |
| `FFMPEG_MAX_GENERATIONS_PER_SESSION`     | 2       | Max concurrent generations (current + retained) |
| `FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS` | 20s     | Inactivity timeout for retained generations     |

### Generation Routing

When a segment request arrives, the router evaluates all active generations:

1. **Build candidates** from current + retained generations
2. **Check coverage**: a generation "covers" segment N if `offset <= N < offset + segmentsReady`
3. **Select best**: prefer covered > current > nearest offset
4. **Serve**: resolve file path within the winning generation's output directory

If no generation covers the segment, the request routes to the current generation and enters the wait loop.

## Seek Handling

### Forward Seek

Triggered when the player requests a segment more than `FFMPEG_FORWARD_SEEK_THRESHOLD` (default: 15) segments ahead of current progress.

It is also triggered when the current run would need more than 6 s to reach the target (`gap × segment duration / FFmpeg speed`), as long as the gap is at least 3 segments and the request is not sequential playback. A 4.5× CPU-tonemap transcode needs ~20 s for a 15-segment gap; a fast GPU covers it in under 5 s. While the speed is unknown (it is cleared on every respawn), only the fixed threshold decides.

1. Video stream request detects gap → `shouldTriggerForwardSeek()` returns true
2. `seekToSegment()` creates new generation at target position
3. Old generation demoted to `previous` (retained)
4. Audio requests route to new generation via the router

Audio streams (`canSeek: false`) never trigger seeks themselves — they follow the video stream's generation and wait for segments.

### Backward Seek

Triggered when the player requests a segment before the current offset.

1. `shouldTriggerBackwardSeek()`: `requestedSegment < segmentOffset`
2. New generation created at the earlier position
3. Same generation promotion/demotion flow

### Seek Cooldown

After a seek, a cooldown period (`HLS_SEEK_COOLDOWN_MS`, default: 5s) prevents distant stale HLS requests from triggering additional seeks. A legitimate second seek can also hit this guard, so suppressed requests return 503 with `Retry-After` set to the remaining cooldown and `Cache-Control: no-store`. They must not return a missing-segment 404.

## Segment Wait Mechanism

When a segment isn't on disk yet, the server holds the HTTP request instead of returning 404:

```
waitForCurrentSegmentFile()
├── Determine timeout:
│   ├── Normal playback: 10s
│   ├── During/after seek: 45s
│   └── I-frame request: custom
├── Poll loop (every 100ms):
│   ├── Check if offset changed (seek completed) → recompute path
│   ├── Try fs.access(filePath)
│   ├── If found → serve
│   ├── If job stopped/error → bail
│   ├── If segment unreachably far ahead (>100 beyond progress) → bail
│   └── Sleep 100ms
└── Return { fileExists, actualFilePath, waitMs }
```

If the wait times out, a media segment the job will still write (job alive, segment at or ahead of production or the job is mid-seek, not a tail probe) gets `503` + `Retry-After: 1` (`segment_not_ready`), not `404`. hls.js never retries a 4xx fragment, and the player triages 404 as terminal. The retry also counts as repeated-segment pressure, which can restart FFmpeg at the target.

This mechanism is critical for slow transcodes (CPU-only libx265) where FFmpeg can't produce segments faster than real-time.

## Stale Segment Guard

Prevents serving leftover segments from a previous FFmpeg run that may have incompatible init segments or wrong PTS.

Four detection layers:

1. **Progress check**: segment index far beyond `segmentsReady` + margin → stale
2. **File mtime**: file older than `lastFFmpegSpawnTime` → stale
3. **Seek-in-progress wait**: if `isSeeking`, wait for offset to stabilize before deciding
4. **Offset re-check**: after wait, verify segment is still reachable from new offset

## Tail Cache

hls.js and AVPlayer probe the last VOD segment to detect stream duration. After a seek, the new generation hasn't produced end-of-file segments yet, causing the player to stall.

Solution: a parallel FFmpeg worker pre-generates the last ~3 segments from the file's tail (last 30s) and caches one of them per stream in memory (`endSegmentCache: Map<streamDir, EndSegmentCacheEntry>`, `end-segment-cache.ts`).

- Cached at job startup via `spawnTailCacheWorker()`; a real tail file the responder serves replaces it
- Inherited across generations on seek
- Served instantly when the player probes the tail segment, but only for the playlist entry the buffer IS. Any other tail index takes the normal wait / 404 path: a stream that ends early (copy audio >= 0.5 s short of the container) has no file for the last grid entry, and answering it with the previous segment repeated that audio
- A worker's file numbers count from its own `-ss`, so its buffer is a `tail_run` entry: it answers only the last grid entry, and only when the stream's media reaches 0.25 s into it. Where a stream ends is measured from the run itself (tfdt + last `#EXTINF` per stream, relative to the longest stream, which is taken to end with the container)
- Valid regardless of seek position because codec settings are preserved

## Init Segment Post-Processing (Firefox Seek Fix)

Every fMP4 init segment served in muxed mode runs through `stripMp4InitEditLists()` (`src/lib/server/utils/mp4-init-edit-list.ts`) before being sent to the client. This removes **empty-edit** `elst` entries (`media_time = -1`) from every `trak` in the `moov` box.

### Why

On post-seek output, FFmpeg (with `-ss` / `-copyts` / `-start_at_zero`) writes an empty edit into the trak's `edts` box whose `segment_duration` equals the seek target (e.g. 1634 s for a 27-min seek). The ISO/IEC 14496-12 sentinel `media_time = -1` means "leave a gap of `segment_duration` in the presentation timeline before playing any media."

Browsers disagree on how to interpret this under MSE:

| Browser | Behavior with fMP4 edit list                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Chrome  | Ignores the edit list — only `timestampOffset` moves the samples. Content lands at the correct manifest position.            |
| Firefox | Honors the edit list **and** applies `timestampOffset`, stacking the seek offset twice. Content lands at 2× the seek target. |

The symptoms on Firefox depend on which trak has the empty edit:

- **Video trak** — hls.js's passthrough remuxer rewrites the `elst` using its own seek math, causing a tight refetch loop between two adjacent segments.
- **Audio trak** (muxed SourceBuffer) — video lands at the seek target (e.g. 1634 s), audio lands at 2× (3268 s). The muxed buffer is disjoint and nothing plays around `currentTime`; MSE eventually fires `QuotaExceededError`.

### What gets stripped, what stays

The utility inspects the `elst` inside each `edts` and drops the **whole `edts`** if any entry has `media_time == -1`. hls.js does not reconstruct a partial elst, so the simplest and safest response is to remove the edit list entirely when an empty edit is present.

Edits with `media_time >= 0` are preserved:

- `media_time = 0` — noop edit, harmless.
- `media_time > 0` — real content trim. FFmpeg emits a positive-`media_time` elst on AAC audio traks to represent the encoder-delay priming samples. Stripping it would shift the audio timeline by a few ms and cause A/V drift on every browser.

### Where it's applied

Wired in `hls-muxed-root-asset.ts` when `options.isInitSegment` is set. Native HLS (AVPlayer) respects fMP4 edit lists correctly and does not need this transformation, but the muxed-mode path is also used by the web player so the strip runs unconditionally on muxed init segments served from disk.

### Test coverage

`src/lib/server/utils/mp4-init-edit-list.test.ts` covers: empty-edit strip on video and audio traks, preservation of `media_time = 0` / positive `media_time`, multi-entry elsts (drop if any entry is empty), idempotency, and malformed input defense (size=0, size=1 largesize, nested traks, top-level trak outside moov).

---

## Master Playlist

Generated for demux mode. Contains:

```m3u8
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS

# Audio renditions
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="English (AAC Stereo)",
  DEFAULT=YES,CHANNELS="2",URI="stream_0/index.m3u8"

# Subtitle renditions (if present)
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="eng",NAME="English",
  DEFAULT=YES,URI="/api/v1/playback/{itemId}/hls-lumastra/subtitles/0/playlist.m3u8"

# Video stream
#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=6400000,
  RESOLUTION=1920x1080,CODECS="hvc1.1.6.L153.B0,mp4a.40.2",
  FRAME-RATE=23.976,AUDIO="audio",SUBTITLES="subs",VIDEO-RANGE=SDR
stream_2/index.m3u8
```

Video codec strings are computed from source metadata:

- H.264: `avc1.PPCCLL` (profile, compatibility, level)
- HEVC: `hvc1.P.flags.LLLL` for fMP4 segments (`hev1` only for MPEG-TS), with HDR10/HLG/DV signaling
- AV1: `av01.P.LL.DD` (profile, level, bit depth)

HDR signaling via `VIDEO-RANGE` attribute: `SDR`, `PQ` (HDR10), or `HLG`.

## File Map

| File                              | Responsibility                                           |
| --------------------------------- | -------------------------------------------------------- |
| `hls-playback.service.ts`         | Entry point — resolve plan, probe media, start FFmpeg    |
| `hls-generation-router.ts`        | Route segment requests to the correct generation         |
| `hls-generation-coordinator.ts`   | Select which retained generations to keep/retire         |
| `hls-segment-generation-route.ts` | Switch job/filePath context when routing to retained gen |
| `hls-segment-action-planner.ts`   | Decide action: serve, wait, seek, or 404                 |
| `hls-segment-action-executor.ts`  | Execute waits, forward/backward seeks                    |
| `hls-segment-availability.ts`     | Init segment wait, missing file responses                |
| `hls-segment-request-state.ts`    | Compute per-request offset, actualIndex, canSeek         |
| `hls-segment-request-tracker.ts`  | Track repeated requests (pressure detection)             |
| `hls-segment-diagnostics.ts`      | Diagnostic logging for segment requests                  |
| `hls-segment-file-responder.ts`   | Read and serve segment files with range support          |
| `hls-stale-segment-guard.ts`      | Detect and reject stale segments from old generations    |
| `hls-seek-coordinator.ts`         | Coordinate seek with wait-for-completion logic           |
| `hls-seek-cooldown-tracker.ts`    | Prevent stale requests from triggering redundant seeks   |
| `hls-seek-trace-collector.ts`     | Collect per-seek diagnostics (classifiers, timing)       |
| `hls-vod-playlist.ts`             | Generate VOD playlists (muxed mode, keyframe-aware)      |
| `hls-muxed-root-asset.ts`         | Muxed mode root asset handling                           |
| `hls-job-restoration.ts`          | Restore FFmpeg jobs after server restart                 |
