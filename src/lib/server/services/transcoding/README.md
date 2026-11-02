# Transcoding Engine

This document describes the transcoding subsystem — how Lumastra decides whether media needs transcoding, selects codecs and encoders, builds FFmpeg commands, and manages transcode job lifecycles.

## Architecture Overview

```
Playback request
  → MediaProbeService (resolve streams, codecs, HDR info)
  → TranscodeDecisionEngine (evaluate device profile vs media)
  → FullTranscodeStrategy (build FFmpeg arguments)
  → FFmpegTranscodeService (spawn process, track progress, handle seeks)
  → HLS segment output
```

## Decision Engine

The decision engine evaluates whether a media source can be played directly or needs transcoding. It compares the source media against a device profile (Jellyfin-compatible format).

### Decision Flow

```
Media source + Device profile + User-Agent
        ↓
Extract: codec, bitrate, resolution, HDR type, audio channels
        ↓
Match against DirectPlayProfiles + CodecProfiles
        ↓
Compatibility check:
  ├── Container compatible?
  ├── Video codec supported?
  ├── Video profile/level/resolution within limits?
  ├── Audio codec supported? Channels okay?
  ├── Bitrate under device limit?
  └── HDR format supported?
        ↓
Reasons = bitwise flags (VideoCodecNotSupported | AudioCodecNotSupported | ...)
        ↓
Mode = (reasons == 0) ? 'direct' : 'full'
        ↓
VideoAction = (video issues flagged) ? 'transcode' : 'copy'
AudioAction = (audio issues flagged) ? 'transcode' : 'copy'
        ↓
Select target codecs from TranscodingProfiles
        ↓
Select GPU encoder if available (h264_nvenc, hevc_qsv, etc.)
        ↓
HDR handling:
  ├── HDR source + SDR device → tonemapping (force video transcode)
  ├── HDR source + HDR device → preserve HDR10 metadata
  └── SDR source → passthrough
```

### Output: TranscodeDecision

```typescript
{
  mode: 'direct' | 'full',
  reasons: TranscodeReason,        // bitwise: why transcoding is needed
  videoAction: 'copy' | 'transcode',
  audioAction: 'copy' | 'transcode',
  targetCodec: { video, audio },
  useGpu: boolean,
  gpuEncoder?: string,             // e.g. 'hevc_nvenc', 'hevc_qsv'
  needsTonemapping: boolean,
  preserveHdr10: boolean,
  outputVideoRange: 'SDR' | 'HDR10' | 'HLG'
}
```

### Audio Codec Compatibility

HLS containers only support certain audio codecs natively:

| Codec                   | HLS Compatible | Action           |
| ----------------------- | -------------- | ---------------- |
| AAC                     | Yes            | Copy             |
| AC3 (Dolby Digital)     | Yes            | Copy             |
| E-AC-3 (Dolby Digital+) | Yes            | Copy             |
| DTS / DTS-HD            | No             | Transcode to AAC |
| TrueHD                  | No             | Transcode to AAC |
| FLAC                    | No             | Transcode to AAC |
| PCM                     | No             | Transcode to AAC |

## Device Profiles

Jellyfin-compatible JSON profiles define what each device can play. Bundled profiles:

| Profile           | Key Video Codecs      | Key Audio Codecs       | HDR            |
| ----------------- | --------------------- | ---------------------- | -------------- |
| `apple-tv.json`   | H.264, HEVC           | AAC, AC3, E-AC-3, ALAC | HDR10, HLG, DV |
| `chrome.json`     | H.264, HEVC, VP9, AV1 | AAC, Opus              | No             |
| `android-tv.json` | H.264, HEVC           | AAC, AC3, E-AC-3       | HDR10          |
| `tizen.json`      | H.264, HEVC, VP9      | AAC, AC3, E-AC-3       | HDR10          |
| `webos.json`      | H.264, HEVC, VP9      | AAC, AC3, E-AC-3       | HDR10          |
| `roku.json`       | H.264, HEVC           | AAC, AC3, E-AC-3       | HDR10          |

### Profile Schema

```json
{
    "Name": "Apple TV 4K",
    "MaxStreamingBitrate": 120000000,

    "DirectPlayProfiles": [
        {
            "Container": "mp4,m4v,mov",
            "Type": "Video",
            "VideoCodec": "h264,hevc",
            "AudioCodec": "aac,ac3,eac3"
        }
    ],

    "TranscodingProfiles": [
        {
            "Container": "mp4",
            "Type": "Video",
            "VideoCodec": "hevc,h264",
            "AudioCodec": "aac,ac3,eac3",
            "Protocol": "hls",
            "Context": "Streaming",
            "MaxAudioChannels": "6"
        }
    ],

    "CodecProfiles": [
        {
            "Type": "Video",
            "Codec": "h264",
            "Conditions": [
                {
                    "Property": "VideoLevel",
                    "Condition": "LessThanEqual",
                    "Value": "52"
                },
                {
                    "Property": "VideoProfile",
                    "Condition": "EqualsAny",
                    "Value": "high|main|baseline"
                },
                {
                    "Property": "VideoRangeType",
                    "Condition": "EqualsAny",
                    "Value": "SDR"
                }
            ]
        }
    ],

    "SubtitleProfiles": [
        { "Format": "vtt", "Method": "External" },
        { "Format": "srt", "Method": "External" }
    ],

    "userAgentMatch": "AppleTV|tvOS"
}
```

- **DirectPlayProfiles**: Container/codec combos the device can play natively (stream copy)
- **TranscodingProfiles**: Target codecs when transcoding is required
- **CodecProfiles**: Fine-grained constraints (max level, allowed profiles, HDR range types)
- **SubtitleProfiles**: Subtitle format support (External = sidecar, Embed = mux in, Encode = burn in)

## FFmpeg Argument Building

`FFmpegArgsBuilder` constructs the full FFmpeg command via a fluent API. Major sections:

### Input

- Local file: `-ss <seek> -i /path/to/file`
- Concat demuxer: `-f concat -safe 0 -i concat_list.txt` (multi-file playback)
- HTTP input: `-reconnect 1 -reconnect_streamed 1 -i http://...`
- Seeking: `-ss` before input for fast seek, `-noaccurate_seek` for copy mode (snap to keyframe)

### Video Codec

- **Copy**: `-c:v copy` (remux, no re-encoding)
- **Software**: `libx264` (H.264), `libx265` (HEVC), `libsvtav1` (AV1)
- **GPU**: `h264_nvenc`, `hevc_nvenc`, `h264_qsv`, `hevc_qsv`, `h264_vaapi`, `hevc_vaapi`, `h264_videotoolbox`, `hevc_videotoolbox`, `h264_amf`, `hevc_amf`
- Profile/level set per codec (e.g., HEVC Main 10 Level 5.1 for 4K HDR)
- Quality: CRF mode (default 23) or explicit bitrate
- Keyframes: `-force_key_frames expr:gte(t,n_forced*<segment_duration>)` for HLS segment alignment

### Hardware Acceleration

| GPU           | Accel Flag              | Output Format      | Device                |
| ------------- | ----------------------- | ------------------ | --------------------- |
| NVIDIA        | `-hwaccel cuda`         | `cuda`             | —                     |
| Intel         | `-hwaccel qsv`          | `qsv`              | `/dev/dri/renderD128` |
| AMD (Linux)   | `-hwaccel vaapi`        | `vaapi`            | `/dev/dri/renderD128` |
| AMD (Windows) | `-hwaccel d3d11va`      | `d3d11`            | —                     |
| Apple         | `-hwaccel videotoolbox` | `videotoolbox_vld` | —                     |

### HDR Handling

**Tonemapping** (HDR → SDR): Converts HDR10/HLG to SDR for devices that don't support HDR.

- GPU: Hardware-accelerated tone mapping (CUDA, QSV, VAAPI)
- CPU: `zscale` filter chain with bt2390 or hable algorithm

**HDR10 Preservation**: Passes through mastering display metadata and MaxCLL/MaxFALL.

- Hardware encoders: `-master_display` and `-max_cll` as standalone FFmpeg flags
- `libx265` (software): `-x265-params "master-display=...:max-cll=..."` (hyphenated syntax — standalone flags crash libx265)

### Audio

- Per-track codec selection (copy or transcode independently)
- Adaptive bitrate: target = source × 70% (AAC efficiency), clamped to 96–256 kbps stereo / 192–512 kbps surround
- Async resampling: `-af aresample=async=1` to fix timestamp drift (only when all audio tracks are transcoded)

### HLS Output

- Segment duration: 6s (transcode), keyframe-aligned ~10s (remux)
- Container: fMP4 (`.m4s` + init segments) or MPEG-TS (`.ts`)
- **Demux mode**: `-var_stream_map` maps each audio track + video to separate streams
- **Muxed mode**: Single stream with video + one audio track
- Split-by-time: enabled for transcode (uniform segments), disabled for copy (GOP boundaries for Chrome MSE)

## Job Lifecycle

`FFmpegTranscodeService` manages the full lifecycle:

```
pending → running → ready → stopping → stopped
                      ↑
                    seeking (new generation)
```

### Key Features

- **Multi-generation seeking**: Each seek spawns a new FFmpeg process at the target position while retaining the old generation for in-flight requests (see `../hls/README.md`)
- **Job persistence**: Jobs are stored in the database for recovery after server restart
- **Per-user limits**: Prevents resource exhaustion from concurrent transcodes
- **Sliding window cleanup**: Deletes old segments to keep disk usage constant
- **Resource monitoring**: Tracks CPU, memory, and GPU usage per job
- **I-frame analysis**: Background extraction of keyframe positions for byte-range seeking

## File Map

| File                         | Responsibility                                                   |
| ---------------------------- | ---------------------------------------------------------------- |
| `transcode-decision.ts`      | Evaluate media vs device profile, produce TranscodeDecision      |
| `transcode-strategy.ts`      | Strategy interface for pluggable transcode approaches            |
| `full-transcode-strategy.ts` | Build full FFmpeg args (video, audio, HLS, HDR, filters)         |
| `ffmpeg-args-builder.ts`     | Fluent API for constructing FFmpeg command-line arguments        |
| `device-profiles.ts`         | Load and match Jellyfin-compatible device profiles               |
| `profiles/*.json`            | Bundled device profiles (Apple TV, Chrome, Android TV, etc.)     |
| `hardware-detection.ts`      | Detect GPU encoders, decoders, accelerators, filters             |
| `media-probe.service.ts`     | Resolve stream metadata via database cache or ffprobe            |
| `process-runner.ts`          | Spawn and manage FFmpeg process lifecycle                        |
| `seek-controller.ts`         | Seek state machine (offset, progress, cleanup, tail cache)       |
| `resource-monitor.ts`        | CPU, memory, GPU usage tracking                                  |
| `file-manager.ts`            | Segment file creation, cleanup, directory management             |
| `iframe-analyzer.ts`         | Background keyframe position extraction                          |
| `ffmpeg-stats-cache.ts`      | Cache transcoding statistics (time, bitrate)                     |
| `hls-utils.ts`               | HLS codec compatibility, var_stream_map builder                  |
| `types.ts`                   | All type definitions (TranscodeJob, TranscodeDecision, profiles) |
| `index.ts`                   | Public module exports                                            |
