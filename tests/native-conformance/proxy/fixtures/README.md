<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Preserved proxy contracts

These fixtures were captured from the passing dual-runtime conformance suite at
`823983722d`, before removing the TypeScript proxy. Both runtimes passed all 28
original tests before capture. They contain synthetic data only.

- `vectors.jsonl`: 645 pure contract vectors spanning 24 operations, including
  configuration, authentication, FFmpeg arguments, HDR policy, playlists, codecs,
  MP4 parsing, failure classification and status withholding.
- `http.jsonl`: 100 HTTP request/response observations, including credentials,
  validation, bounded JSON bodies, playlists, init segments and cache headers.

The tests replay fixed expected results against Rust. They must not regenerate
expectations from the implementation under test. A deliberate contract change
needs a reviewed fixture update. Real-media, concurrency, cancellation, upstream
transport and shutdown remain covered by Rust tests and operational qualification.
