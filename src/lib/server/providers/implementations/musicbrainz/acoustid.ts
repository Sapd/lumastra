// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AcoustID Fingerprinting
 *
 * The one track-level fingerprint path. Generates Chromaprint fingerprints via
 * the `fpcalc` CLI and resolves them to MusicBrainz recordings via the AcoustID
 * lookup API. Driven only by the `acoustid-fingerprint` background task — the
 * scan never fingerprints inline.
 *
 * Requires: an AcoustID application key (MusicBrainz provider setting
 * `ACOUSTID_API_KEY`, or the env var of the same name).
 * Requires: the fpcalc binary (Debian `libchromaprint-tools`, shipped in the image).
 *
 * API notes, verified against api.acoustid.org on 2026-10-01:
 * - Batch lookups need `batch=1` plus `fingerprint.N` / `duration.N`; without
 *   `batch=1` the server answers for index 0 only. The batch reply is
 *   `{ fingerprints: [{ index, results }] }`.
 * - A fingerprint the server can't decode is silently LEFT OUT of a batch
 *   reply; some malformed ones instead fail the whole request with error
 *   code 3. An invalid key is HTTP 400 with error code 4.
 * - `meta` is space-separated. Building it with literal '+' through
 *   URLSearchParams sends '%2B', which the server reads as one unknown token
 *   and returns no recordings at all (the old dead code had exactly that bug).
 */

import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { gzipSync } from 'node:zlib';
import type postgres from 'postgres';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { Logger } from '$lib/server/utils/logger.js';
import { assertTranscodeInputIsMedia } from '$lib/server/services/transcoding/input-guard.js';
import { PluginSecrets } from '$lib/server/tasks/secrets.js';
import { acquireHttpToken } from '$lib/server/tasks/http-rate-limit.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

const logger = Logger.for('AcoustID');

const ACOUSTID_API_URL = 'https://api.acoustid.org/v2/lookup';

// The AcoustID key is configured on the MusicBrainz provider as a `secret`
// settings field, so it lives in plugin_secrets under this (plugin_id, key).
export const MUSICBRAINZ_PROVIDER_ID = 'musicbrainz-metadata-provider';
export const ACOUSTID_SECRET_KEY = 'ACOUSTID_API_KEY';

const REQUEST_TIMEOUT_MS = 20_000;
const FPCALC_TIMEOUT_MS = 60_000;

/**
 * AcoustID allows 3 requests/s per application key. 2.5 leaves headroom for
 * the admin provider health check, which uses the same key. Enforced through
 * the shared (cross-replica) HTTP token bucket.
 */
export const ACOUSTID_RPS = 2.5;
const RATE_LIMIT_BUCKET = 'acoustid';

/** Fingerprints per lookup request. ~2.5 KB each after gzip. */
export const ACOUSTID_BATCH_SIZE = 10;

/** Minimum AcoustID score for a result to be considered at all. */
export const MATCH_SCORE_THRESHOLD = 0.85;

/**
 * When the file and the recording both report a duration, they must agree
 * within this many seconds. Catches a fingerprint cluster that also holds a
 * radio edit / extended mix of the same song.
 */
export const MATCH_DURATION_TOLERANCE_SEC = 7;

const FPCALC_CANDIDATES = ['/usr/bin/fpcalc', '/usr/local/bin/fpcalc', '/opt/homebrew/bin/fpcalc'];

// AcoustID application error codes we act on (others are per-request rejections).
const ERR_INVALID_FINGERPRINT = 3;
const ERR_INVALID_API_KEY = 4;
const ERR_INTERNAL = 5;
const ERR_TOO_MANY_REQUESTS = 14;

// =============================================================================
// Interfaces
// =============================================================================

export interface FingerprintResult {
    fingerprint: string;
    /** Whole-file duration in seconds, as fpcalc reports it. */
    duration: number;
}

export interface AcoustIdRecording {
    id: string;
    title?: string;
    duration?: number;
    artists?: Array<{ id: string; name: string }>;
    releasegroups?: Array<{
        id: string;
        title?: string;
        type?: string;
        releases?: Array<{ id: string; date?: { year?: number } }>;
    }>;
}

export interface AcoustIdResult {
    id: string;
    score: number;
    recordings?: AcoustIdRecording[];
}

/** The key was rejected (code 4). Stop the run; nothing is item-specific. */
export class AcoustIdKeyRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AcoustIdKeyRejectedError';
    }
}

/** Outage, throttle or server error. Retry later; not the item's fault. */
export class AcoustIdTransientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AcoustIdTransientError';
    }
}

/** The request itself was rejected (e.g. code 3, invalid fingerprint). */
export class AcoustIdRequestRejectedError extends Error {
    constructor(
        message: string,
        readonly code: number | undefined,
    ) {
        super(message);
        this.name = 'AcoustIdRequestRejectedError';
    }
}

// =============================================================================
// fpcalc
// =============================================================================

let resolvedFpcalc: string | null | undefined = undefined;

function findFpcalc(): string | null {
    if (resolvedFpcalc !== undefined) return resolvedFpcalc;

    for (const candidate of FPCALC_CANDIDATES) {
        if (existsSync(candidate)) {
            resolvedFpcalc = candidate;
            logger.debug('Found fpcalc binary', { path: candidate });
            return candidate;
        }
    }

    resolvedFpcalc = null;
    logger.info('fpcalc binary not found — AcoustID fingerprinting unavailable', {
        searched: FPCALC_CANDIDATES,
    });
    return null;
}

/** Synchronous, memoised — safe to call from a stage eligibility builder. */
export function isFpcalcAvailable(): boolean {
    return findFpcalc() !== null;
}

/** Test hook: forget the memoised fpcalc lookup. */
export function __resetFpcalcForTests(): void {
    resolvedFpcalc = undefined;
}

export type FingerprintOutcome =
    | ({ ok: true } & FingerprintResult)
    | {
          ok: false;
          /**
           * `fpcalc-failed`: the file is there but can't be decoded (permanent).
           * `file-missing` / `fpcalc-timeout`: storage trouble (retry later).
           */
          reason:
              | 'fpcalc-unavailable'
              | 'fpcalc-failed'
              | 'file-missing'
              | 'fpcalc-timeout'
              | 'aborted';
          detail?: string;
      };

/**
 * Generate a Chromaprint fingerprint for an audio file.
 *
 * fpcalc decodes only the first 120 s (its default) on a single thread. The
 * child is dropped to the lowest CPU priority right after spawn so it always
 * yields to playback transcodes and the web process.
 */
export async function generateFingerprint(
    filePath: string,
    opts: { signal?: AbortSignal } = {},
): Promise<FingerprintOutcome> {
    const fpcalc = findFpcalc();
    if (!fpcalc) return { ok: false, reason: 'fpcalc-unavailable' };
    if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };

    // fpcalc decodes with libavformat and takes no -format_whitelist: a file
    // that became a playlist/manifest body after the scan would be followed.
    try {
        await assertTranscodeInputIsMedia({ localFilePath: filePath });
    } catch (error) {
        return {
            ok: false,
            reason: 'fpcalc-failed',
            detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
    }

    let stdout: string;
    try {
        stdout = await new Promise<string>((resolve, reject) => {
            const child: ChildProcess = execFile(
                fpcalc,
                ['-json', filePath],
                { timeout: FPCALC_TIMEOUT_MS, signal: opts.signal, maxBuffer: 4 * 1024 * 1024 },
                (err, out) => (err ? reject(err) : resolve(String(out))),
            );
            if (child.pid !== undefined) {
                try {
                    setPriority(child.pid, 19);
                } catch {
                    // Lowering priority is best-effort (the process may already be gone).
                }
            }
        });
    } catch (error) {
        if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
        const err = error as Error & { killed?: boolean; signal?: string | null };
        const detail = err.message?.slice(0, 300);
        logger.debug('fpcalc failed', { filePath, detail });
        // Classify by facts, not by matching the message (it contains the path).
        if (err.killed || err.signal) return { ok: false, reason: 'fpcalc-timeout', detail };
        try {
            await access(filePath);
        } catch {
            return { ok: false, reason: 'file-missing', detail };
        }
        return { ok: false, reason: 'fpcalc-failed', detail };
    }

    try {
        const parsed = JSON.parse(stdout) as { fingerprint?: string; duration?: number };
        if (!parsed.fingerprint || typeof parsed.duration !== 'number') {
            return { ok: false, reason: 'fpcalc-failed', detail: 'incomplete fpcalc output' };
        }
        return { ok: true, fingerprint: parsed.fingerprint, duration: Math.round(parsed.duration) };
    } catch {
        return { ok: false, reason: 'fpcalc-failed', detail: 'unparseable fpcalc output' };
    }
}

// =============================================================================
// API key
// =============================================================================

/**
 * Resolve the effective AcoustID API key.
 *
 * The admin Settings UI stores the key as a `secret` settings field on the
 * MusicBrainz provider, i.e. in `plugin_secrets` under
 * (`musicbrainz-metadata-provider`, `ACOUSTID_API_KEY`), falling back to the
 * `ACOUSTID_API_KEY` env var for env-configured deployments. Returns
 * `undefined` when neither source is set.
 */
export async function resolveAcoustIdApiKey(sql?: postgres.Sql): Promise<string | undefined> {
    if (sql) {
        try {
            const secret = await new PluginSecrets(sql).getOptional(
                MUSICBRAINZ_PROVIDER_ID,
                ACOUSTID_SECRET_KEY,
            );
            if (secret && secret.trim().length > 0) return secret.trim();
        } catch (err) {
            logger.warn(
                'Failed to read AcoustID key from plugin_secrets — falling back to env',
                {},
                err as Error,
            );
        }
    }
    const env = process.env.ACOUSTID_API_KEY?.trim();
    return env && env.length > 0 ? env : undefined;
}

// =============================================================================
// Lookup
// =============================================================================

interface AcoustIdErrorBody {
    status?: string;
    error?: { code?: number; message?: string };
}

/**
 * Look up several fingerprints in one request (`batch=1`).
 *
 * Returns one entry per query, in query order. An entry is `null` when the
 * server left that index out of its reply (it could not decode that
 * fingerprint) — a per-item rejection, distinct from `[]` (decoded, no match).
 *
 * Throws {@link AcoustIdKeyRejectedError}, {@link AcoustIdTransientError} or
 * {@link AcoustIdRequestRejectedError} — never silently returns "no match" for
 * a request that did not get an answer.
 */
export async function lookupAcoustIdBatch(
    queries: FingerprintResult[],
    apiKey: string,
    opts: { signal?: AbortSignal } = {},
): Promise<Array<AcoustIdResult[] | null>> {
    if (queries.length === 0) return [];

    const params = new URLSearchParams({
        client: apiKey,
        format: 'json',
        batch: '1',
        meta: 'recordings releasegroups releases compress',
    });
    queries.forEach((q, i) => {
        params.set(`duration.${i}`, String(q.duration));
        params.set(`fingerprint.${i}`, q.fingerprint);
    });

    await acquireHttpToken(RATE_LIMIT_BUCKET, { rps: ACOUSTID_RPS }, opts.signal);

    let response: Response;
    try {
        response = await trackExternalCall(
            ACOUSTID_API_URL,
            () =>
                fetchWithTimeout(
                    ACOUSTID_API_URL,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Content-Encoding': 'gzip',
                        },
                        body: gzipSync(params.toString()),
                        signal: opts.signal,
                    },
                    REQUEST_TIMEOUT_MS,
                ),
            opts.signal,
        );
    } catch (err) {
        if (opts.signal?.aborted) throw err;
        throw new AcoustIdTransientError(`AcoustID request failed: ${(err as Error).message}`);
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

    const errBody = (body ?? {}) as AcoustIdErrorBody;
    if (!response.ok || errBody.status !== 'ok') {
        const code = errBody.error?.code;
        const message = errBody.error?.message ?? `HTTP ${response.status}`;
        if (code === ERR_INVALID_API_KEY) {
            throw new AcoustIdKeyRejectedError(`AcoustID rejected the API key: ${message}`);
        }
        if (
            response.status === 429 ||
            response.status >= 500 ||
            code === ERR_INTERNAL ||
            code === ERR_TOO_MANY_REQUESTS ||
            code === undefined
        ) {
            throw new AcoustIdTransientError(`AcoustID lookup failed: ${message}`);
        }
        throw new AcoustIdRequestRejectedError(`AcoustID rejected the request: ${message}`, code);
    }

    const fingerprints =
        (body as { fingerprints?: Array<{ index: number | string; results?: AcoustIdResult[] }> })
            .fingerprints ?? [];
    const out: Array<AcoustIdResult[] | null> = queries.map(() => null);
    for (const entry of fingerprints) {
        const idx = Number(entry.index);
        if (Number.isInteger(idx) && idx >= 0 && idx < out.length) {
            out[idx] = entry.results ?? [];
        }
    }
    return out;
}

/** True when a batch failure should be retried one fingerprint at a time. */
export function isPerItemRejection(err: unknown): boolean {
    return err instanceof AcoustIdRequestRejectedError && err.code === ERR_INVALID_FINGERPRINT;
}

// =============================================================================
// Match selection
// =============================================================================

export interface MatchContext {
    /** Track title from tags / the library. */
    title?: string | null;
    /** Album title from the library. */
    album?: string | null;
    /** File duration in seconds. */
    durationSec?: number | null;
}

export interface ConfidentMatch {
    acoustidId: string;
    score: number;
    recordingMbid: string;
    recordingTitle?: string;
    artistMbids: string[];
    artistNames: string[];
    /** Release groups the recording appears on (as AcoustID reports them). */
    releaseGroups: Array<{ id: string; title?: string; releaseIds: string[] }>;
}

export type MatchDecision =
    | { kind: 'matched'; match: ConfidentMatch }
    | { kind: 'no-match' }
    | { kind: 'ambiguous'; candidates: number };

/**
 * Normalise a title for comparison: case-, accent- and punctuation-blind, and
 * without trailing bracketed qualifiers ("(Remastered 2011)", "[Live]").
 */
export function normalizeTitle(s: string | null | undefined): string {
    if (!s) return '';
    return s
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s*[([].*?[)\]]\s*/g, ' ')
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/**
 * Pick a single confident recording from AcoustID results, or decide there
 * isn't one.
 *
 * 1. Keep results scoring >= {@link MATCH_SCORE_THRESHOLD}.
 * 2. Collect their recordings that carry metadata, dropping any whose duration
 *    disagrees with the file by more than {@link MATCH_DURATION_TOLERANCE_SEC}.
 * 3. One distinct recording id left → matched.
 * 4. Several → narrow by exact (normalised) title, then by a release group
 *    titled like the album. Exactly one left → matched; else ambiguous.
 *
 * Never guesses: two plausible recordings is "ambiguous", not "pick the first".
 */
export function selectConfidentMatch(
    results: AcoustIdResult[],
    ctx: MatchContext = {},
): MatchDecision {
    const byId = new Map<string, { rec: AcoustIdRecording; score: number; acoustidId: string }>();
    for (const r of results) {
        if (!(r.score >= MATCH_SCORE_THRESHOLD)) continue;
        for (const rec of r.recordings ?? []) {
            if (!rec.id) continue;
            if (
                typeof rec.duration === 'number' &&
                typeof ctx.durationSec === 'number' &&
                ctx.durationSec > 0 &&
                Math.abs(rec.duration - ctx.durationSec) > MATCH_DURATION_TOLERANCE_SEC
            ) {
                continue;
            }
            const prev = byId.get(rec.id);
            if (!prev || r.score > prev.score)
                byId.set(rec.id, { rec, score: r.score, acoustidId: r.id });
        }
    }

    let candidates = [...byId.values()];
    if (candidates.length === 0) return { kind: 'no-match' };

    if (candidates.length > 1) {
        const wantTitle = normalizeTitle(ctx.title);
        if (wantTitle) {
            const byTitle = candidates.filter((c) => normalizeTitle(c.rec.title) === wantTitle);
            if (byTitle.length > 0) candidates = byTitle;
        }
    }
    if (candidates.length > 1) {
        const wantAlbum = normalizeTitle(ctx.album);
        if (wantAlbum) {
            const byAlbum = candidates.filter((c) =>
                (c.rec.releasegroups ?? []).some((rg) => normalizeTitle(rg.title) === wantAlbum),
            );
            if (byAlbum.length > 0) candidates = byAlbum;
        }
    }
    if (candidates.length !== 1) return { kind: 'ambiguous', candidates: candidates.length };

    const { rec, score, acoustidId } = candidates[0];
    return {
        kind: 'matched',
        match: {
            acoustidId,
            score,
            recordingMbid: rec.id.toLowerCase(),
            recordingTitle: rec.title,
            artistMbids: (rec.artists ?? []).map((a) => a.id.toLowerCase()),
            artistNames: (rec.artists ?? []).map((a) => a.name),
            releaseGroups: (rec.releasegroups ?? []).map((rg) => ({
                id: rg.id.toLowerCase(),
                title: rg.title,
                releaseIds: (rg.releases ?? []).map((rel) => rel.id.toLowerCase()),
            })),
        },
    };
}
