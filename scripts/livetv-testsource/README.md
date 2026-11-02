<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Synthetic Live TV provider

Run from the app directory, with Node 22+ and FFmpeg (libx264, AAC and lavfi):

```sh
node scripts/livetv-testsource/server.mjs
# {"baseUrl":"http://127.0.0.1:<port>","m3uUrl":"…/playlist.m3u","xmltvUrl":"…/guide.xml"}
```

The first stdout line is machine-readable readiness JSON; FFmpeg diagnostics go to stderr.
Use `--port 8098` or `PORT=8098` to fix the port (default: an OS-assigned free port).
`FFMPEG_PATH` selects the encoder binary. Stop with SIGINT or SIGTERM; the server kills its
encoders and closes clients. Each disconnected HTTP stream also kills its encoder.

Five M3U feeds form four stations: News One, Sports Two, Movies Three, and Kids Four HD/SD.
The two Kids feeds share `tvg-id="kids-four"` and `tvg-name="Kids Four"`; their display names
have HD/SD suffixes. The real importer strips those suffixes and makes one backup group,
whose group UUID is the station ID and whose default feed is HD. There are no logos or
external media. Every feed has its own tone; the video is a moving test pattern, with its
feed name drawn when a supported Linux DejaVu font exists. The SD label tests feed choice;
both feeds deliberately encode at 640×360.

- `/playlist.m3u`: five entries with tvg-id, tvg-name and group-title, no tvg-logo.
- `/guide.xml`: invented half-hour programmes from three hours before to at least three hours
  after the current time, generated in UTC on each request; no real show names.
- `/stream/<feed-id>.ts`: endless real-time H.264/AAC MPEG-TS, one FFmpeg per connection.
- `/__status`: `connections`, `maxConnections`, `active` feed IDs, and the last 500 connection
  events (`sequence`, `event: opened|closed|refused`, `id`, `at`). Probes count as connections.

`PROVIDER_MAX_CONNECTIONS=1` is the default and enforces an actual provider slot limit:
excess simultaneous requests get HTTP 429 with Retry-After. A slot remains occupied until
its encoder exits. Increase it explicitly to experiment with multiple independent feeds.

## Failure modes

`POST /__control` with a JSON body switches a feed (or every feed, `"feed": "*"`, the default)
into a failure mode, to exercise the Live TV failure reasons:

| `mode`          | New connections                                             | Open connections                       |
| --------------- | ----------------------------------------------------------- | -------------------------------------- |
| `ok`            | stream normally                                             | resume a frozen encoder                |
| `status:<code>` | answer that HTTP status; optional `body` text (≤ 512 chars) | closed                                 |
| `stall`         | `200` headers, then no bytes                                | encoder frozen (connection stays open) |
| `end`           | `200` headers, then the response ends                       | closed                                 |

`maxConnections` in the same body changes the provider slot limit at runtime. A `"*"` request
clears every per-feed mode first. `GET /__status` shows the active modes.

```sh
curl -XPOST "$BASE/__control" -d '{"feed":"news-one","mode":"status:401","body":"Unauthorized"}'
curl -XPOST "$BASE/__control" -d '{"mode":"ok"}'
```

## Add to a real development instance

Bind to an address the **app, import worker and stream proxy** can all reach, and advertise
that address rather than loopback if they run in containers or on another machine:

```sh
HOST=0.0.0.0 PORT=8098 PUBLIC_BASE_URL=http://<reachable-test-host>:8098 \
  node scripts/livetv-testsource/server.mjs
```

This fixture has no authentication. Expose it only on your development network; the printed
URLs must be reachable directly by the worker and proxy, with no SSH tunnel dependency.
In the admin UI, open **Live TV → Sources → Add M3U source**, use the printed `m3uUrl` and
`xmltvUrl`, and set the source's maximum streams to 1. Enable `FEATURE_LIVETV=true`,
`LIVETV_SOURCE=standalone` and `LIVETV_ALLOW_PRIVATE_URLS=true` for private hosts; the standalone
proxy also needs the private-URL setting. Run the source import and EPG refresh, wait for four
stations, then tune one. A second viewer on another station should be refused, while a
high-priority viewer can take over. Remove this test source when finished.

See [the E2E runbook](../../docs/dev/livetv-e2e.md) for the automated full-stack suite.
