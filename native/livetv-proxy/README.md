<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Native Live TV proxy

Rust is the only Live TV proxy implementation. The crate provides the HTTP contract
and operational streaming service; bare binary startup exits with code 78 unless
an explicit operating mode is selected.

The binary name is `lumastra-livetv-proxy`. `--version` never binds a socket.
`--evaluate` is a bounded NDJSON pure-contract adapter; it is not the task service
control protocol. `--contract-server FIXTURE.json` binds only loopback on an
OS-assigned port and hosts HTTP policy tests with explicitly supplied manager
replies. It cannot fetch upstream data or launch FFmpeg.

Implemented boundaries:

- Configuration precedence, numeric parsing/clamping, protocol scopes and child
  environment; constant-time authentication and missing-secret policy.
- Transcode decisions and ordered ingest, fixed-rung, remux and adaptive FFmpeg
  arguments, including HDR reservation and distinct-channel hardware cooldown.
- HLS media playlists/discontinuities/generation init maps, codec metadata and
  bounded incremental fMP4 parsing, track timing normalization and reset.
- Raw probe JSON parsing; HTTP route classification, ordered join validation,
  health/status withholding and bounded JSON request parsing in the fixture host.
- Ready-state ingest, rung, adaptive and compat playlists/masters, init generations
  and binary segment responses with the existing content/cache headers.
- One-entry playlist readiness, 18-second empty/failover deadlines and cancellation
  when the HTTP client disconnects. Availability is supplied by fixture managers.
- Feed-ID validation and explicit delegation of control responses to fixture
  managers; no successful lifecycle operation is invented by the shell.
- Typed Live TV failure reasons (`src/failure_reason.rs`, a port of
  `src/shared/livetv-failure-reason.ts`): the relay records every provider answer
    > = 400 with a 512-byte body snippet, each failed attempt is classified (HTTP status >
    > relay > stderr > crash signal > stalled > offline), fatal answers fail over at once,
    > and a channel whose every URL failed turns terminal (502 `channel_failed` on a waiting
    > join, `failure` on heartbeats, 410 on HLS routes) until a new join starts it over.
- Shared HDR filter discovery with successful-result caching, 60-second failure
  retry, bounded child output/runtime and explicit shutdown that kills and reaps.

The fixture server returns
`native_runtime_unavailable` for a recognized operation without a supplied fixture
reply. Such replies prove only HTTP policy behavior, not real lifecycle behavior.
The explicit `--serve` mode runs the live managers: guarded HTTP(S) transport,
probe/FFmpeg supervision, immutable shared segment rings, continuous encoder feeds,
viewer/source ownership, fixed and synchronized adaptive outputs, HEVC compatibility
variants, failure reporting and replica heartbeats. It never uses fixture replies.
P01 evidence is recorded in [validation/P01.md](validation/P01.md).

RTSP inputs require `LIVETV_ALLOW_PRIVATE_URLS=true` (the control request's
`allowPrivateUrls` flag). FFmpeg follows RTSP redirects to unchecked hosts even
with a pinned initial IP and TCP-only transport, and the pinned build has no
RTSP option to disable redirects. Without that explicit opt-in, admission rejects
RTSP before probing or ingest. RTMP retains checked-IP pinning: the pinned native
RTMP implementation does not follow connect-error redirects. HTTP(S) redirects
and HLS children remain checked by the HTTP relay.

Rust is the only stream proxy. The container starts
`build/lumastra-livetv-proxy --serve`; a missing binary fails startup (exit 78).
Remove legacy TypeScript runtime overrides before upgrading. Viewer sessions remain
local to the proxy process, so restarting it ends active playback.

`PORT`, `STREAM_PROXY_SECRET`, `HLS_TEMP_DIR`, FFmpeg configuration, source policy
and viewer/encoder settings retain the existing proxy contract. Only the native
binary also accepts `STREAM_PROXY_BIND` for isolated loopback qualification.
The cluster heartbeat (`cluster:node:<id>`) and the failure queue
(`livetv:failures:pending`) are coordination state and go to the task Valkey named
by `TASK_CACHE_URL`; `CACHE_URL` is not read. The URL's username and password
(percent-decoded) are sent as `AUTH <user> <pass>`, or `AUTH <pass>` without a
username, and a `/<db>` path selects that database (no path means DB 0). Native
startup rejects `rediss:` because this raw client does not implement Redis TLS.
Without `TASK_CACHE_URL` reporting is off; an unreachable Valkey only makes it
retry. Besides its identity the heartbeat carries host, process and cgroup figures
from procfs (display only; an unreadable file omits its field). Reporting is best
effort, bounded and independent from media delivery.

With the pinned native toolchain and JavaScript dependencies installed, run from
the application root:

```sh
node scripts/native.mjs check livetv-proxy
node scripts/native.mjs test-release livetv-proxy
node scripts/native.mjs build livetv-proxy
node scripts/native.mjs licenses livetv-proxy
node scripts/native.mjs smoke livetv-proxy
NATIVE_PROXY_BINARY="$PWD/build/lumastra-livetv-proxy" npx vitest run --config tests/native-conformance/proxy/vitest.config.ts
```

On startup, both runtime implementations use provider history when the existing
HTTP guard has successfully rewritten an HLS playlist during probing. FFmpeg's
`-live_start_index -6` starts six entries from the end, bounded independently of
archive size; one to five entries start at the earliest available entry immediately.
Identification uses the guarded response body, including extensionless, redirected
and master playlists. Without positive HLS observation (including raw TS/RTSP/RTMP
or a probe that never observes HLS), no HLS demuxer option is sent. Finite/ENDLIST HLS retains
its ordinary beginning and loop behavior.

Successful redirected playlists keep their resolved provider destination pinned while in use
(up to 64 entries per ingest, least recently used first, expired entries before live ones);
an evicted entry simply resolves its redirect again on its next reload. Reloads therefore do
not revisit a load balancer that may choose servers with incompatible segment numbering.
Destinations remain behind the same checked HTTP transport: redirects and DNS answers are
re-checked on every reload, and a pinned host that now resolves to a private address is
refused (403) without a server switch. A redirect from an https entry to plain http is
served but never pinned. The route table is cleared on shutdown.

A pinned playlist is replaced, and the configured entry URL resolved once again, when it
answers 401/403/404/410, when it answers 200 with something that is not a playlist, or after
three consecutive transport failures (connect, DNS, TLS, timeout) or 5xx answers. Other
refusals (including 429) and private-address refusals do not trigger a server switch. HEAD
requests use the pin read-only and never replace it. A renewal shares the refresh deadline
with the first attempt; the cached manifest is dropped only once the renewal produced a
response, and the renewed manifest is cached. A successful destination renewal may
introduce a new timeline, handled by the sequence-reset recovery below.

Limits: only the entry playlist is pinned and renewed. Variants below a redirected master
playlist are not individually renewed; they follow their own redirects on every load. The
address checks are advisory behind an egress proxy (`LIVETV_UPSTREAM_PROXY_URL`): the proxy
resolves and connects on its own, so enforcement of private destinations belongs to it.

Each guard also retains up to four validated live media manifests (64 KiB per
entry including its requested URL, at most 256 KiB per guard). Masters and finite/VOD
playlists are excluded. A fresh known manifest has a two-second whole-refresh deadline,
including headers, body and rewriting. On a timeout, connection failure or HTTP
500/502/503/504, the guard may return its exact last safe rewritten manifest while
listed media remains available through the guard. Protected failures remain visible
in privacy-safe logs and counters, while only an unprotected failure degrades ingest
health; serving cached bytes never reports that the upstream recovered. Fallback never renews the fixed 30-second maximum age from
the successful response; cancellation, policy/SSRF refusals, invalid URI attributes
and HTTP 401/403/404/410/429 are not masked. Cache state ends with the ingest guard.
Request tickets fence cache writes and invalidations, including expiry and eviction,
with bounded metadata. A newer sequence reset invalidates the previous fallback
generation; actual upstream responses remain unfiltered. When FFmpeg reports a backwards
live media sequence, ingest latches the reset instead of allowing later packets to
mark that timeline healthy. The next health check restarts the same feed first,
with increasing output segment IDs and a discontinuity for the new generation.
A second reset before 30 seconds of healthy ingest follows the ordinary backup/
terminal-failure path, rather than looping on the same input. This restarts a broken
timeline; it does not reconstruct lost or corrupt provider content. Cache admission requires self-contained segment ordering,
one valid target duration and at most one sequence tag; delta playlists are excluded.
Provider duration drift (for example an 11.52-second segment with target duration 10)
is still forwarded and may be cached.

This can put playback farther behind live by using history the provider already
has. It adds no history wait: pacing remains real time with the existing 12-second
initial burst, output cadence stays three seconds, and the first playlist publishes
whatever is ready. A cold provider with no backlog gains no extra reserve. Neither
lost/corrupt content nor timestamp corruption is repaired, and this does not guarantee
a fixed client buffer or recovery time. Output ring and byte limits are unchanged.

`python3 tests/native-conformance/proxy/provider-backlog.py --help` describes the focused
baseline/changed FFmpeg qualification: owned ten/five/one-entry live playlists,
redirected extensionless masters, finite HLS and raw TS, with provider selection,
startup timing, decoded advancement and paced/bounded sustained output evidence.
Its `--refresh-only` mode compares the actual native cache with a six-entry baseline
under manifest 503s and hung bodies, and checks permanent-outage expiry, rolling
provider retention and refusal controls. `--startup-only` also holds the probe
long enough to advance the provider window and checks the actual served selection.

Run `tests/native-conformance/proxy/operational-smoke.py --help` for the real FFmpeg/network lifecycle qualification harness. It uses owned synthetic sources, clears inherited cache endpoints and retains decoded-frame, timing, process and source identities in its artifact directory.

The conformance suite executes the Rust binary and compares its results with live
fixed pre-removal reference vectors. HTTP tests use actual loopback sockets. Neither
fixture comparisons nor parser tests establish provider/device playback or soak
reliability. P03 must retain real FFmpeg/network segment-arrival measurements to
catch renewed input polling/bunched release; P07 requires device and soak gates
before any default switch.

The native component CI job runs the provider-history startup and refresh controls
against both current runtime builds. `--startup-only` and `--refresh-only` need no
historical baseline; supplying `--baseline` additionally runs the comparison control.
Their evidence is retained with the operational media artifacts.

For an explicitly authorized live-source qualification, the `upstream_soak` example runs
the actual HTTP guard with a supplied FFmpeg and decodes video/audio for a bounded 30–900
seconds. Build with `cargo build --example upstream_soak`. Supply one JSON line on stdin
with `url`, `ffmpeg` (executable path), `seconds`, and `stderr` (private log path). Provider
URLs stay off stdout; FFmpeg progress is emitted there. Keep the input and stderr private.
This does not replace adaptive-output or physical-player verification.
