# playback/

Internal playback API routes used by the web player: HLS pipeline, session management, and
media serving. Native apps use the matching `/api/v1/playback/...` routes; most handlers here
mount a shared definition from `src/lib/server/api/defs/playback/` with `surface: 'internal'`.

## Playback Architecture

```
Client → POST /media/{id}/playability → POST /play-sessions → granted file/HLS delivery
```

### `[itemId]/hls` — Lumastra FFmpeg Pipeline

Full FFmpeg transcode/remux engine with multi-audio HLS demux, GPU acceleration,
HDR tonemapping, subtitle burn-in, and server-side seeking (kill + restart FFmpeg).

## Routes

| Route                                      | What                                                    | Notes                     |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------- |
| `[itemId]/hls/`, `[itemId]/hls/[...path]/` | FFmpeg HLS pipeline (transcode, remux, multi-audio)     | Primary HLS endpoint      |
| `[itemId]/file/`                           | Local file serving with Range requests                  | Direct play               |
| `[itemId]/stream-token/`                   | Stream token for authenticated media URLs               | Auth                      |
| `stream-tokens/`, `stream-tokens/[id]/…`   | Create, revoke and refresh stream tokens                | Auth                      |
| `[itemId]/preview-session/`                | Video preview on hover (short transcode)                | Hover previews            |
| `[itemId]/probe-status/`                   | Whether the item's media probe has finished             |                           |
| `subtitles/[itemId]/[index]/`              | Subtitle extraction from local files                    | Embedded streams          |
| `[itemId]/subtitles/external/[id]/`        | External subtitle files next to the media               | Scoped to the item (IDOR) |
| `[itemId]/chapters/`                       | Chapter markers and media segments (skip intro)         | DB-only                   |
| `[itemId]/chapter-image/[index]/`          | Per-chapter thumbnail cropped from the trickplay sprite |                           |
| `[itemId]/trickplay/[width]/…`             | Scrubbing thumbnails and their manifest                 | DB-only                   |
| `[itemId]/livetv-programs/`                | EPG program data                                        | Live TV                   |
| `session/`                                 | Current playback session                                |                           |
| `telemetry/`, `incidents/`                 | Player telemetry and playback incident reports          | Client diagnostics        |

## Client-Side Paths

| Player Mode        | Info Source                       | HLS Source                   | URL Builder                |
| ------------------ | --------------------------------- | ---------------------------- | -------------------------- |
| Lumastra (browser) | `POST /api/media/{id}/playability` | Start envelope delivery URL | `POST /api/play-sessions` |
| Native apps | `POST /api/v1/media/{id}/playability` | Start envelope delivery URL | `POST /api/v1/play-sessions` |
