// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// error-fingerprint.ts — normalize → hash of failure messages (Slice 3 §4.1).
//
// A single, ordered, documented redaction pipeline so that "42 runs failed with
// the same error" collapses to ONE fingerprint, even when each raw message
// carries a different run id / timestamp / path / count. The rules live here
// (beside their unit tests) as the single tunable source of truth — there is NO
// persisted fingerprint column and NO backfill, so changing a rule instantly
// re-groups historical rows on the next read.
//
// Contract (Slice 3 §4.1 — applied in this order to a raw message):
//   1. Lowercase.
//   2. Strip UUIDs, bare run ids (`run_…`), and 16+ hex runs → `<id>`.
//   3. Strip ISO-8601 timestamps and epoch-ms integers → `<ts>`.
//   4. Strip absolute paths and URLs (keep host, drop path/query) → `<path>` / `<url>`.
//   5. Collapse standalone integers ≥ 3 digits → `<n>`.
//   6. Collapse whitespace; truncate to 200 chars.
//   7. fingerprint = sha1(normalized).slice(0, 16).

import { createHash } from 'node:crypto';

const MAX_NORMALIZED_LEN = 200;

// Ordered redaction stages. Each is a [pattern, replacement] applied in sequence.
// Order matters: URLs/paths before bare-id/number collapse so a path segment
// isn't half-redacted into `<id>`/`<n>` first.

// ISO-8601 timestamps: 2026-06-02T14:32:01.123Z, 2026-06-02 14:32:01, etc.
const RE_ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/g;

// UUID v1-v5 canonical form.
const RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// Bare run ids: run_<alnum…> / run-<alnum…> (the orchestrator's ulid-style ids).
const RE_RUN_ID = /\brun[_-][0-9a-z]+\b/g;

// Long hex runs (16+ chars) — sha/jobids/digests not in UUID shape.
const RE_LONG_HEX = /\b[0-9a-f]{16,}\b/g;

// FFmpeg's bracketed logging context has a per-process pointer. Keep the
// context name (and hexadecimal codec values outside it) as diagnostic evidence.
const RE_FFMPEG_CONTEXT = /(\[[^\r\n[\]]+? @ )0x[0-9a-f]+(?=\])/g;

// URLs — keep the host, drop the path/query so "timeout to api.tmdb.org" groups
// regardless of the specific resource path. Captures host into `<url:host>`.
const RE_URL = /\b(?:https?|wss?):\/\/([^/\s:]+)(?::\d+)?(?:\/\S*)?/g;

// Absolute POSIX paths (/foo/bar/baz) → `<path>`. Run AFTER URLs so a URL's
// path component is already gone.
const RE_ABS_PATH = /(?<![\w<])\/(?:[\w.\-+@]+\/)+[\w.\-+@]*/g;

// Epoch-ms integers (13-digit) → `<ts>`. Run before the generic number collapse
// so a millis timestamp reads as a time, not a count.
const RE_EPOCH_MS = /\b\d{13}\b/g;

// Standalone integers >= 3 digits → `<n>`. Word-boundary anchored so it does not
// eat the digits inside an already-substituted token.
const RE_LONG_INT = /\b\d{3,}\b/g;

const RE_WHITESPACE = /\s+/g;

/**
 * Apply the §4.1 redaction pipeline to a raw failure message. Pure + total:
 * never throws; null/undefined/empty input yields the empty string.
 */
export function normalizeError(raw: string | null | undefined): string {
    if (!raw) return '';
    let s = String(raw).toLowerCase();

    s = s.replace(RE_FFMPEG_CONTEXT, '$1<address>');

    // 2. ids (UUID → run id → long hex)
    s = s.replace(RE_UUID, '<id>');
    s = s.replace(RE_RUN_ID, '<id>');
    s = s.replace(RE_LONG_HEX, '<id>');

    // 3. timestamps (ISO first, then epoch-ms) — before number collapse.
    s = s.replace(RE_ISO_TIMESTAMP, '<ts>');
    s = s.replace(RE_EPOCH_MS, '<ts>');

    // 4. URLs (keep host) then absolute paths.
    s = s.replace(RE_URL, (_m, host: string) => `<url:${host}>`);
    s = s.replace(RE_ABS_PATH, '<path>');

    // 5. remaining long integers → <n>.
    s = s.replace(RE_LONG_INT, '<n>');

    // 6. collapse whitespace + trim + truncate.
    s = s.replace(RE_WHITESPACE, ' ').trim();
    if (s.length > MAX_NORMALIZED_LEN) s = s.slice(0, MAX_NORMALIZED_LEN);
    return s;
}

/**
 * sha1(normalize(raw)).slice(0, 16) — the stable group key for a failure class.
 * Two messages differing only in ids/timestamps/paths/counts share a fingerprint.
 */
export function fingerprintError(raw: string | null | undefined): string {
    const normalized = normalizeError(raw);
    return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}
