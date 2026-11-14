# HLS timeline invariants

What must stay aligned in Lumastra's HLS output, why, and how to change the code without breaking it.

Read this before you touch HLS segmenting, seeks, restore/handover, or audio and subtitle renditions. For the request flow and file layout, see [`src/lib/server/services/hls/README.md`](../../src/lib/server/services/hls/README.md).

> Verified against the code on `main` on 2026-11-01. Where a behaviour is in progress, the text says so. If you change one of the rules below, change this page in the same commit.

## The one idea

A client sees three timelines. They must agree, for every generation of FFmpeg output, after every seek and after every restore:

1. **The playlist timeline.** The sum of `EXTINF` values up to an entry. Players seek, buffer and show the clock by it.
2. **The media timeline.** The `tfdt` (base media decode time) inside each fMP4 fragment.
3. **The source timeline.** The time in the original file. Bitmap subtitles (PGS) and the keyframe list use it.

Most HLS bugs here are one of these drifting from another. The drift is often small (0.1 to 2 s), constant for the rest of the session, and visible only as subtitles that are early or late, or audio that is out of sync.

## Delivery modes and where segment boundaries come from

Three decisions shape the timeline: whether video is **copied or transcoded**, whether audio is **muxed** into the video stream or a **separate rendition** (demux), and whether the **GOP mode** keyframe grid is on. The planner picks them in `playback-planner.service.ts` (`resolveHlsAudioMode`) and the transcode service applies them.

| Mode                                         | Boundaries are set by                                                                                                                                                                                                                   | Playlist is built from                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Transcode video** (muxed or demux)         | The **planned uniform grid**. FFmpeg forces a keyframe at every multiple of the segment length (default 6 s), so the planned and the produced boundaries match.                                                                         | `uniformSegmentCount` / `uniformSegmentDuration`                                     |
| **Copy video, muxed** (remux)                | The **source keyframes**. FFmpeg can only cut on a keyframe, so segments are about 10 s and uneven. Cuts are relative to where each FFmpeg run starts.                                                                                  | `computeSegmentsFromKeyframes`, or `computeSegmentsWithSeekGrid` after a seek        |
| **Copy video, demux, legacy cut**            | Audio on the uniform grid. Video on FFmpeg's own keyframe cuts, listed with each file's real duration, and addressed through the audio's uniform offset.                                                                                | `buildVodManifestContent` in `vod-playlist.ts`                                       |
| **Copy video, demux, GOP mode**              | The **keyframe grid**, computed once per job (`gop-grid.ts`). FFmpeg writes one file per keyframe for video and about 0.5 s parts for audio. `gop-segment-assembler.ts` joins them into grid entries that start exactly where declared. | The grid                                                                             |
| **Live TV** (separate Rust proxy and FFmpeg) | **FFmpeg's own output** into a sliding window. No planned grid, no VOD playlist, no seek generations.                                                                                                                                   | FFmpeg's live playlist (`hls_list_size` ring; see `native/livetv-proxy/src/args.rs`) |

Notes:

- **GOP mode** applies only to demux, copy video, fMP4 output, a job that is not a preview, and a source with usable keyframes. `HLS_COPY_GOP_SEGMENTS` (default on) is the kill switch. The decision is made once at job start and stored in the job's effective plan, so seek generations and restores keep the same mode. Ineligible sources (no keyframes, GOPs longer than 60 s, near all-intra) fall back to the legacy cut and log a warning.
- GOP mode fails closed. If the assembler cannot build an exact entry, the segment route answers `410` so the client restarts from its position, and the title is excluded from GOP mode for a while so it cannot loop on the same break.
- **Why GOP mode exists.** FFmpeg's HLS muxer cuts relative to the start of each run (`pkt_pts - first_pkt_pts >= hls_time * n`). A seek generation therefore never reproduces the first generation's copy-video cuts. hls.js anchors its timeline on the first fragment it loads (`initPTS = tfdt - declared start`). When the declared start was off by 2 s, picture, audio and bitmap subtitles were shifted by 2 s for the whole session. Per-keyframe output removes the dependence on where a run started.
- **Muxed vs demux per client.** Transcoded video on a native-HLS client gets demux with every language as a rendition. Copied video gets muxed (one selected audio track) for native clients that declare copy-reload support. Older native clients and iPhone/iPad web get demux for copied video too: muxed fMP4 with AC-3 made iOS add and drop the audio track in a loop. Web (hls.js) is always muxed.
- **Remux** is copy video with copy or transcoded audio. Its timeline rules are the copy rows above.
- **Live TV** differs in three ways: no seek generations, the media sequence advances as the window slides, and a segment that left the window is gone for good.

## Invariants

### 1. `EXTINF` never exceeds `TARGETDURATION`

RFC 8216 requires every `EXTINF`, rounded to the nearest integer, to be at most `EXT-X-TARGETDURATION`. AVPlayer rejects the whole media playlist with `-12642` ("Playlist parse error") when it is not, and the video rendition is unplayable.

This bites in copy mode because real GOPs vary. A source with a 22 s GOP produced a 22 s entry under a declared target of 10.

- Demux playlists declare the maximum of: the uniform base, the rounded value of every listed `EXTINF` (including FFmpeg's real durations for produced files), and the longest planned keyframe segment (`minTargetDurationSeconds`).
- The planned floor keeps the value **stable across refetches**. A target that grows when a long GOP gets produced makes the second fetch of a playlist differ from the first.
- The muxed playlist declares `ceil` of its longest entry.
- When you add a code path that can write an `EXTINF`, make sure it feeds the target calculation.

### 2. Segment counts come from one grid function

The count and duration of the uniform grid come from `uniformSegmentCount` and `uniformSegmentDuration` (`utils/hls-segment-grid.ts`). They fold a tail shorter than min(0.5 s, segment / 4) into the previous entry.

The container duration usually runs a few milliseconds past the last video frame. A plain `Math.ceil(total / segment)` listed a phantom 0.02 s entry that FFmpeg never writes for video, and the missing entry was answered with the previous segment's bytes. Do not write `Math.ceil(total / seg)` for a playlist.

The tail cache follows the same rule. `endSegmentCache` answers only the index it holds (`lookupEndSegment` and `storeEndSegment`). Never read the map and serve a neighbour.

### 3. Absolute timestamps, and `tfdt` continuity across generations

Every FFmpeg run is a **generation**. A seek, a restore, an audio-track change or a version switch can start a new one. Each generation must write fragments whose `tfdt` matches the playlist position of the segment it carries.

- **Transcode video.** A seek generation starts at a segment boundary and uses `-start_number <offset>` so file names equal the logical index, plus `-hls_segment_options movflags=+frag_discont` so `tfdt` is source-absolute. Timestamps are kept with `-copyts -start_at_zero -avoid_negative_ts disabled`.
- **Copy video, muxed.** There is no `start_number` (file numbering restarts at 0 and the server maps logical to physical indices). Without help, FFmpeg's fMP4 muxer re-bases each track to its first DTS and records the offset only in an edit list. Native-HLS clients therefore get `frag_discont` on seeked copy generations (`keepSourceTimestamps`, selected by `isNativeHlsClient`).
- **GOP mode.** Both outputs write source-absolute `tfdt` in **every** generation, including the first (`forceCopyTimestamps`). Measured: with the same flags in all generations, the same GOP has the same presentation time in each. Only the first fragment of a run reads about 0.09 s later.
- **Do not use `use_editlist=0` here.** It makes seek generations relative again.
- **Init segments strip empty edit lists on the muxed path** (`stripMp4InitEditLists`). Firefox honours an empty edit and also applies the player's offset, which stacks the seek position twice. Edits with a positive `media_time` stay, because they carry encoder delay. If you change what the muxer writes, check both Chrome and Firefox.
- **Previews number from 0.** A preview has no earlier timeline. Starting at `segment_00064` with `EXT-X-MEDIA-SEQUENCE:64` made hls.js map sequence times target duration to a time and fetch a segment that does not exist, which looked like a backward seek.

### 4. `EXT-X-MEDIA-SEQUENCE` and the segment index agree between playlists

The VOD playlists list the whole timeline. Segment URIs carry the **logical** index (`segment_00086.m4s`). The server maps it to a physical file through the generation's offset. The media sequence equals the index of the first listed entry (normally 0).

- In demux, AVPlayer pairs audio and video by segment number and by synthetic `PROGRAM-DATE-TIME`. The playlists give every entry a date computed from the cumulative `EXTINF`, so audio and video must agree on the cumulative time at the same index. Mixing FFmpeg's real dates with synthetic ones would create discontinuities, so only synthetic ones are written.
- In demux copy mode the video playlist uses the **audio's uniform offset** and lists each produced file's real duration. Entry `N` is file `N - offset`. A 200 s desync appeared when video used its own keyframe-space offset.
- The old mapping from a uniform request to the one keyframe file containing `start + n * 10 s` was not one-to-one. Short files were skipped and their neighbours served twice, which showed as a picture that froze for seconds every few minutes. Segment-index tests with evenly spaced keyframes cannot catch this. Use uneven GOPs.
- The public muxed playlist is **server-owned**. FFmpeg's `index.m3u8` is private producer state. The grid used for the public playlist follows the **job's** video action, not the request's: a job whose decision changed after the request resolved (a quality cap flipping copy to transcode) must be numbered on the job's grid, or the first request reads as a backward seek and spawns a second generation.

### 5. Demux audio offset and preroll align to the video grid

Audio and video are fetched independently and audio runs behind. When a seek or restore starts a generation:

- **Audio and video offsets derive from the same start time.** Moving one alone desyncs them.
- **The generation starts early.** A forward seek to segment `N` makes AVPlayer fetch audio `N-1` to prime its decoder. A seek preroll (2 segments) makes `N-1` real. A restore uses a wider preroll (6 segments) because it interrupts linear playback, where audio trails video, and audio cannot trigger a seek on its own. Only video streams can start a seek, to avoid seek storms.
- **Copy video prerolls in grid units, not segments.** The start must land on a keyframe. GOP mode starts one grid entry early, exactly on that entry's first keyframe (`resolveGopGenerationStart`).
- **Round-trip the grid.** The start segment and start time must convert back to each other, or audio and video land on offsets one segment apart. `resolveSeekGenerationStart` skips the preroll rather than risk it for fractional segment lengths.

### 6. fMP4 init segments

- The playlist must name the init file even when it is not on disk yet. Each stream has its own file (`init_<N>.mp4`). A client that caches a playlist naming a file that never appears keeps downloading media but never configures a decoder, with no error.
- A file existing is not the file being ready. FFmpeg creates the init before it writes `ftyp` and `moov`. A request in that window got a 0-byte `200`, which hls.js reported as `fragParsingError`. A part-written file did the same. Readiness is `isCompleteMp4Init` (a definite truncation withholds the file) plus a check that the job is alive. A seek stops FFmpeg on purpose, so a stopped job that is seeking counts as alive.
- When you find one readiness check, search for every other path that serves the same asset. The guard existed in one sibling and not the other.
- A not-yet-written init, media playlist or segment answers `503` with `Retry-After` while the job is alive (see [status codes](#status-codes-for-segments-and-playlists)).

### 7. Discontinuities

The server does not emit `EXT-X-DISCONTINUITY` in VOD playlists. Instead the **media** carries the discontinuity: source-absolute `tfdt` and `frag_discont`. The playlist stays one continuous timeline across generations.

If you introduce a discontinuity tag, you also change what AVPlayer does with `tfdt` and WebVTT. Test that on a device before anything else.

## Subtitles

### AVPlayer places WebVTT cues by `tfdt`

AVPlayer plays fMP4 video by the playlist timeline but places WebVTT cues against the **media** timestamps. Our cue segments declare `X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:0`. If a seeked copy generation has `tfdt` near 0 at playlist position 600 s, cues are about 10 minutes late. The symptom is "no subtitles" after a resume, a Continue Watching start or a long seek, while starts at 0 and slow in-buffer seeks work.

The fix is the `tfdt` rule above (`frag_discont` for native-HLS clients). To diagnose, fetch the init and the segment covering time `T` from two sessions (one started at 0, one seeked to `T`), read the `tfdt` boxes, and compare with the playlist's cumulative `EXTINF` start. `fmp4-timing.ts` has a reader. Do not paste media playlists into logs or tickets, because `EXT-X-MAP` URIs carry the access token.

### Master playlists and subtitle renditions

There are several master generators in `utils/hls-master-playlist.ts`: demux, muxed, and audio-only. Each must emit the subtitle group (`EXT-X-MEDIA:TYPE=SUBTITLES`) and a matching `SUBTITLES="subs"` on the variant, or neither. The muxed master was added so tvOS could read `VIDEO-RANGE` before it configures the display. It first shipped without subtitles, so Apple TV had subtitles for direct and remux playback and none for anything transcoded. Never emit `SUBTITLES=` for a group with no lines.

The web player is the exception: masters for the web route carry no subtitle renditions (`omitManifestSubtitles`). The player renders subtitles from its own `<track>` elements. On iOS Safari, a `<track>` present at load next to a master can fail the whole load, so tracks attach after `loadedmetadata`. See `src/lib/components/player/CLAUDE.md`.

### Text versus bitmap

- **Text subtitles** (SRT, WebVTT, and text codecs converted to WebVTT) are served as WebVTT segments through the subtitle handler. Their timing is the playlist/`tfdt` relationship above.
- **Bitmap subtitles** (PGS, VobSub) cannot become WebVTT. The web player renders them client-side (libbitsub) against **source time**. They are exactly as correct as the player's clock is. If the player's clock is off from the source by 2 s, the subtitles are off by 2 s.
- **Burn-in** renders subtitles into the video on the server. The planner turns a burn-in request into a full transcode, so it stays on the transcode rules.
- Bitmap subtitles are why a timeline error that a viewer would not notice in audio and picture alone shows up as a visible desync.

### Why recovered sessions drifted

A restore (for example after a pod restart) starts a new FFmpeg run. Anything that depends on where the run started changes: where hlsenc cuts, what `tfdt` starts at, and the file numbering. Before GOP mode and the source-timestamp flags, a restored or seeked copy run declared one set of boundaries to the client and produced another. The mismatch was constant for the rest of the session, which is why subtitles were off by a fixed amount rather than drifting.

Restores keep the job's stored mode (`gopSegments` and the effective plan travel with the persisted job), so a GOP-mode session restores into GOP mode. Treat any restore path that recomputes the mode from the request or from current settings as a bug.

## Seeks, generations and handover

- A **generation** is one FFmpeg run in its own `gen-NNNN` directory. The router (`generation-router.ts`) sends each request to the generation that covers it. A retired generation stays routable for a while, so segments the client still reads do not look like backward seeks on the new one.
- A **forward seek** beyond a threshold starts a new generation, aligned to a keyframe (copy) or the grid (transcode), with the preroll above. A **backward seek** into files the sliding window already deleted answers `410` and the client restarts from its position.
- **Output is stamped** (`.lumastra-output.json`: item, pod, job). Disk-serve and restore use only output stamped for the row's item, and a restore wipes anything else before adopting it. This is what stops one item's bytes being served for another after a session switches item.

### Restore after a pod restart (in progress)

A pod that claimed an orphaned session served the segments already on disk and started FFmpeg only when one was missing, at the persisted position. The client's next request was then a forward seek that restarted FFmpeg a second time, and the picture froze for 12 to 15 s.

A change on the `hls-handover-prewarm` branch, **not on `main` yet**, fixes this:

- Claiming a session starts one background restore (single flight) instead of waiting for the first miss.
- The restore starts at `max(last segment on disk + 1, requested segment)`. With separate audio and video, it uses the slowest stream.
- Copy-mode and GOP restores start where a seek to that segment would (keyframe or grid aligned), in a fresh generation, so they cannot overwrite the output being served.
- The old output stays routable as a retained generation until the client has read past it.

Until it lands, a restored copy-video job resumes at the persisted position and relies on the forward-seek path for the rest. Update this section when it merges.

### Status codes for segments and playlists

| Situation                                                                         | Answer                                            | Why                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The job will still write the segment (alive, at or ahead of progress, or seeking) | `503` with `Retry-After: 1` (`segment_not_ready`) | hls.js never retries a 4xx fragment and treats 404 as terminal. It retries 5xx.                                                                                                                    |
| Init segment or media playlist not written yet, job alive                         | `503` with `Retry-After: 1`                       | AVFoundation treats a 404 on these as "does not exist" and stops using the variant.                                                                                                                |
| Segment past the end of the timeline                                              | `404` (`past_end`)                                | It will never exist. The last entry is refused only when FFmpeg closed its manifest one short and the input really ended. A stop also writes `ENDLIST`, so a closed manifest alone proves nothing. |
| Segment removed by the sliding window, or a broken GOP generation                 | `410`                                             | The client should restart from its position.                                                                                                                                                       |
| Job dead, file gone                                                               | `404`                                             | Nothing will produce it.                                                                                                                                                                           |

Measured on iOS Safari (native HLS): AVPlayer handles a media-segment `404` and `503` the same way. It retries about every target duration, seven times, then **stops without an error event**. A segment ready within about 25 s recovers. One that needs 60 s does not. So the status code does not rescue a slow segment. Only producing it faster does.

The reverse is the asymmetry that matters: web needs `503`, because it never retries `404`.

## Multiple audio renditions

`EXT-X-MEDIA TYPE=AUDIO` renditions give a native player (AVPlayer) a built-in language menu. For copied audio the timelines come from the source. For **transcoded** audio and video, each rendition is an extra encode, and all of them must share one timeline:

- The same segment boundaries and the same segment count as the others.
- The same start time per generation, and the same `tfdt`, through every seek and every handover.
- The same decoder-priming preroll (section 5).

Any rendition that misses one of these desyncs on the first seek or restore, for the whole session. A single muxed stream cannot have that problem because audio and video leave one muxer together.

What the code does today:

- **Web (hls.js)** is always muxed. One audio track is in the stream. Changing language **re-plans** at the same playback position, through the same path as a version or quality switch, and reloads the stream. The player compares the request with what the server reports as applied, and records a failed switch when they differ.
- **Native with copied video** is muxed for clients that declare copy-reload support. They reload on an unbuffered seek or an audio change. Older native clients and iPhone/iPad web still receive a demux master with all languages as renditions, and can use the native menu.
- **Native with transcoded video** is demux with every language as a rendition today. This is the path the rules above exist for. Do not add renditions or encode paths to it without the tests in the checklist.

Where native multi-language menus could be safe later: **copy-audio and remux**, where each rendition's timeline is the source's own timeline (GOP mode already gives audio exact parts). Transcoded renditions need an alignment guarantee we do not have, plus one encode per language.

## Rules for changing HLS code

Use this as a checklist in the pull request.

1. **Name the three timelines.** For your change, say which of playlist, `tfdt` and source time it affects, and which mode (the table above).
2. **Test across a seek.** Add a test that asserts `tfdt` and the media sequence or index of the first segment of a seeked generation against the playlist. `fmp4-timing.ts` reads `tfdt`. Reuse the real-FFmpeg smoke tests when you can (they run in CI and on the remote runner). A mock of FFmpeg cannot see this class of bug.
3. **Use uneven data.** Keyframes with uneven gaps, one GOP longer than the segment target, a source whose container is slightly longer than its video, a first keyframe that is not at 0. Evenly spaced fixtures hide most of these bugs.
4. **Assert `EXTINF <= TARGETDURATION`** on every playlist your change can produce, including after a refetch.
5. **Test on AVPlayer, not only hls.js.** hls.js and Chrome forgive things AVPlayer does not: edit lists, a `404` on init, `EXTINF` over the target, cue placement. macOS AVFoundation also accepts streams iOS rejects. Check the real device or the iOS simulator, and see `docs/dev/testing-traps.md`.
6. **Check subtitles after a seek and after a handover.** Use a text track and a bitmap track. Seek forward past the buffer, seek backward, resume from a saved position, and (if you touch restore) restart the serving process during playback.
7. **Check audio and video together** in demux: seek, change audio, and watch for a request for segment `N-1` that no generation can serve.
8. **Don't compute a mode twice.** The job stores its mode and grid. Seek generations and restores read the stored value. A second computation from the request or settings is how timelines split.
9. **Find the sibling.** If you add a readiness check, status code, header or timeline fix, grep for every other path that serves the same asset (muxed and demux, disk-serve and live, preview).
10. **Keep the kill switch working.** `HLS_COPY_GOP_SEGMENTS=false` must still give a playable (legacy) stream.

## References

Code:

- `src/lib/server/services/hls/README.md`: request flow, delivery paths, layout.
- `src/lib/server/services/playback-planner.service.ts`: `resolveHlsAudioMode` and the delivery decision.
- `src/lib/server/services/ffmpeg-transcode.service.ts`: generations, seeks (`resolveSeekGenerationStart`, `RESTORE_PREROLL_SEGMENTS`), restore, `computeSegmentsFromKeyframes`, `computeSegmentsWithSeekGrid`.
- `src/lib/server/services/transcoding/`: `ffmpeg-args-builder.ts` (`keepSourceTimestamps`, `forceCopyTimestamps`), `gop-output-args.ts`, `full-transcode-strategy.ts`.
- `src/lib/server/services/hls/`: `gop-grid.ts`, `gop-segment-assembler.ts`, `fmp4-timing.ts`, `vod-playlist.ts`, `muxed-vod-playlist.ts`, `generation-router.ts`, `segment-availability.ts`, `job-restoration.ts`, `muxed-root-asset.ts`, `end-segment-cache.ts`.
- `src/lib/server/handlers/hls/lumastra-segment-handler.ts`: the segment route and its status codes.
- `src/lib/server/utils/`: `hls-master-playlist.ts`, `hls-segment-grid.ts`, `mp4-init-edit-list.ts`, `webvtt-parser.ts`.
- `src/lib/components/player/`: `playback-manager.ts`, `player-controller.svelte.ts`, `subtitle-renderer.ts`.

Tests worth reading or extending (paths are relative to `src/lib/server/services/`, except the handler tests under `src/lib/server/handlers/hls/`):

- `hls/gop-grid.test.ts`, `hls/gop-segment-assembler.test.ts`, `hls/gop-segments-ffmpeg-smoke.test.ts` (real FFmpeg, `tfdt` per generation).
- `hls/vod-playlist.test.ts`, `hls/muxed-vod-playlist.test.ts` (target duration, grids).
- `hls/demux-seek-reachability.test.ts`, `hls/segment-route-matrix.test.ts` (which request reaches which file).
- `hls/muxed-copy-reload-ffmpeg-smoke.integration.test.ts`, `hls/hls-tail-ffmpeg-smoke.test.ts`, `hls/tail-run-ffmpeg-smoke.test.ts`.
- `hls/job-restoration.test.ts`, `hls/job-restoration.integration.test.ts`, `ffmpeg-transcode.service.test.ts` (restore and seek start).
- `transcoding/full-transcode-strategy.source-timestamps.test.ts`, `transcoding/ffmpeg-args-builder.test.ts` (timestamp flags).
- `lumastra-segment-handler.test.ts`, `lumastra-segment-handler.gop.test.ts` (handler directory).

Run these through the remote runner. See `docs/dev/DEVELOPMENT.md`.
