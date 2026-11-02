<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Web player: probe, then start

The web player probes `POST /api/media/{id}/playability` before starting
`POST /api/play-sessions`. The probe has no delivery resources or side effects.
The start response owns the delivery URL and every session-specific resource.
The server's deprecated playback-info definitions and routes remain for Apple clients.

## Field migration

| Former `/info` read                                           | Replacement and use                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `active_file_id`                                              | Probe `activeFileId`; send it as start `fileId`.                                                                                                                                                                                                                                                                               |
| `versions[].id`, `label`, `is_default`, `tracks`              | Probe `versions[].fileId`, `label`, `isDefault`, `tracks`; populate the version picker. A file-specific probe refreshes its entry without losing the other versions.                                                                                                                                                           |
| `playable`, `play_methods.*.available`, `recommended`         | Active probe version `playable`, `blockedBy`, `availableMethods`, `playMethod`. Start `delivery.playMethod` is authoritative once started. `audio_only` is an explicit quality choice.                                                                                                                                         |
| `tracks.video`, `tracks.audio`                                | Active probe version `tracks` before start; start `delivery.tracks` for the started file. Preserve relative audio `index` for UI and absolute `absoluteIndex` for start/reporting. Video metadata and `sizeBytes` also populate version labels.                                                                                |
| `recommended_tracks`                                          | Probe `recommended.audioStreamIndex`, `subtitleStreamIndex`, `subtitleId`, `reason`. Translate the absolute audio index to the UI index; match subtitles by stable ID.                                                                                                                                                         |
| `subtitles` (including embedded/sidecar metadata and `hrefs`) | Probe `tracks.subtitles` supplies IDs, source, format and delivery method before start. Start `delivery.subtitles` supplies the actual indices and all `text`, `raw`, `rendered` hrefs. A sidecar selection survives synthetic-index changes by matching its ID. Never send a sidecar index as an embedded subtitle selection. |
| `duration_ms`                                                 | Active probe version `durationMs`, then start `delivery.durationMs`. Clamp an initial resume before sending it.                                                                                                                                                                                                                |
| `resume_position_ms`, `is_watched`                            | Probe `resumePositionMs`, `isWatched`, reconciled with the existing local resume cache and explicit URL/watch-party position. Start `delivery.startPositionMs` controls loading/seeking.                                                                                                                                       |
| `stream_start_position_ms`, `client_should_seek`              | Start `delivery.seek.streamStartPositionMs`, `clientShouldSeek` and `startPositionMs`. Omit an initial zero position so the server can apply a combined episode's entry point.                                                                                                                                                 |
| `episodeNumberStart`, `episodeNumberEnd`                      | Initial page metadata still supplies the display range. An in-place advance clears the old optional range instead of copying another episode's range; start seek metadata supplies its entry point.                                                                                                                            |
| `resume_anchor`                                               | Initial page metadata provides the existing cache anchor; heartbeat acknowledgements update it. An in-place item change clears it until that item's first acknowledgement. No extra probe/start field is needed.                                                                                                               |
| `output_hdr`, `tracks.video.dv_profile`, `dv_bl_compat_id`    | Active probe version `outputHdr`, `tracks.video.dvProfile`, `dvBlCompatId` for the HDR readout.                                                                                                                                                                                                                                |
| `transcode_reasons`, `transcode_reason_codes`                 | Active probe version `reasons`, `reasonCodes` before start; start `delivery.reasons` after start. Do not attach the probe's reason codes to a different started method.                                                                                                                                                        |
| `transcode_codec`                                             | Removed. It only decorated the codec label with an output-codec arrow; no playback decision depended on it. Actual decoder/transcode telemetry can still update the readout.                                                                                                                                                   |
| `plan_id`                                                     | Removed from the reporter context. The start request never accepted or sent it; the server creates and owns the plan.                                                                                                                                                                                                          |
| `caps_used`                                                   | No web player reads; no replacement dependency. The same detected capabilities are sent to probe and start.                                                                                                                                                                                                                    |
| `trickplay`                                                   | Start `delivery.previews.href` is passed directly to the existing manifest loader. Its response supplies tile dimensions and sheet hrefs. The start's `delivery.timeline.href` also supplies available trickplay variants.                                                                                                     |
| Constructed timeline URL                                      | Follow start `delivery.timeline.href`; retain grant/query parameters. Discard responses from an older session/file. Detail views retain their separate catalog timeline API.                                                                                                                                                   |

## Planner authority and capabilities

Previously the reporter sent `selectedMethod ?? data.playMethod` as
`requestedMethod` on every start. The display label `Transcode` normalizes to
`full_transcode`, so a coarse/stale display value became a planner override.
The controller also changed remux recommendations using its own audio heuristic.
Both dependencies are removed: selected/started methods describe diagnostics;
`requestedMethod` is separately set only for an explicit audio-only choice or a
logged fallback after a real playback failure. Fixed quality and subtitle conversion
are expressed as capabilities and track selection so the planner chooses the method.
Ordinary start, seek, resume and recovery never infer an override from a badge.
Start planning evaluates the selected absolute audio stream's codec and channels
against the chosen delivery path's capabilities. Another compatible track cannot
mask unsupported selected audio. The track count remains file-wide so multi-audio
files still use a delivery path that supports track selection. Same-file metadata
refreshes preserve audio by absolute stream index, including same-language tracks.

Hover previews also let their H.264/AAC/720p capabilities drive planning instead
of unconditionally requesting `full_transcode`. The adapter and memo retain
`delivery.kind`: file deliveries load directly into the video element and seek to
the returned position after metadata loads. Only HLS deliveries enter hls.js.
File playback reports absolute time without adding the preview's seek offset twice.

The capability vocabulary has one HEVC token and no bit-depth qualifier. Advertise
it only when both Main (8-bit) and Main 10 codec MIME probes succeed on that delivery
path. Native/file paths require `canPlayType`; MSE requires `MediaSource.isTypeSupported`
(or ManagedMediaSource), even if MediaCapabilities optimistically reports support.
An 8-bit HEVC result alone must not advertise support for 10-bit files.

No server response fields or OpenAPI changes are required for this migration.
