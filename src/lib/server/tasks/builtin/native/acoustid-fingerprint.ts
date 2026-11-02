// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AcoustID fingerprint matching — background stage for music tracks.
 *
 * For tracks WITHOUT a MusicBrainz recording id (none in the tags, no earlier
 * match), run `fpcalc`, look the fingerprints up on AcoustID in batches, and on
 * a confident match store the recording MBID. Albums and artists then get a
 * release-group / artist MBID when their matched tracks agree on one, which is
 * what album enrichment (Cover Art Archive) and music popularity read.
 *
 * Gates (no work at all unless both hold):
 *   - an AcoustID key is configured (MusicBrainz provider setting, or the
 *     `ACOUSTID_API_KEY` env var);
 *   - `fpcalc` is installed (the image ships it).
 * Without them every row is `skipped_permanent` with a specific reason, and the
 * sweep re-opens them the moment the gate flips (`recoverWhenAdditionalReasons`).
 *
 * Per-item outcomes are all terminal or bounded, so nothing is re-selected
 * forever:
 *   matched            → completed
 *   no / ambiguous / rejected / unreadable → skipped_permanent (own reason each)
 *   outage / throttle  → failed_transient with a 1 h backoff, failed_permanent
 *                        after MAX_ATTEMPTS
 *   key rejected       → the run stops without touching rows (sweep backoff
 *                        then spaces out the retries)
 *
 * Never overwrites good data: a tag-supplied recording MBID wins, album/artist
 * ids are only added where none exists. Files are never renamed or moved.
 *
 * Load: fpcalc decodes the first 120 s on one thread, one file at a time, at the
 * lowest CPU priority; lookups go through a shared 2.5 req/s token bucket
 * (AcoustID allows 3/s per key). While a VIDEO transcode is running anywhere,
 * the drain slows to one batch per 30 s; music, direct play, remux and idle
 * sessions don't slow it at all (they cost next to nothing).
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { resolveDrainMode } from '../../../plugins/runtime/drain-backlog.js';
import { countLiveVideoTranscodes } from '../../../database/queries/transcode-jobs.queries.js';
import {
    ACOUSTID_BATCH_SIZE,
    AcoustIdKeyRejectedError,
    AcoustIdTransientError,
    generateFingerprint,
    isFpcalcAvailable,
    isPerItemRejection,
    lookupAcoustIdBatch,
    normalizeTitle,
    resolveAcoustIdApiKey,
    selectConfidentMatch,
    type AcoustIdResult,
    type FingerprintResult,
} from '$lib/server/providers/implementations/musicbrainz/acoustid.js';
import {
    ACOUSTID_SKIP,
    ACOUSTID_STAGE_ID,
    acoustIdKeyConfiguredSql,
    applyAcoustIdMatch,
    clearOwnAcoustIdMatch,
    countAcoustIdRemaining,
    findAcoustIdBacklog,
    getAcoustIdStageCounts,
    hasTagRecordingMbidSql,
    insertExternalIdIfAbsent,
    loadAlbumMatchEvidence,
    markAcoustIdMatched,
    markAcoustIdSkipped,
    markAcoustIdTransientFailure,
    reopenAlbumEnrichmentForPoster,
    type AcoustIdBacklogRow,
    type AlbumMatchEvidence,
} from '../../../database/queries/acoustid-fingerprint.queries.js';

const TASK_ID = ACOUSTID_STAGE_ID;
const PROCESSING_VERSION = 1;

/** Tracks per scheduled (catchup) run; a manual run drains everything. */
const CATCHUP_TRACK_BUDGET = 600;
/** Leave this much of the soft timeout unused so the run ends cleanly. */
const SOFT_BUDGET_MS = 50 * 60 * 1000;

const TRANSIENT_BACKOFF_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Consecutive batches that hit an outage before the run gives up. */
const MAX_CONSECUTIVE_OUTAGES = 3;

/** While a video transcode is live: at most one batch per this interval. */
const TRANSCODE_BATCH_INTERVAL_MS = 30_000;

function envKeySet(): boolean {
    return (process.env.ACOUSTID_API_KEY?.trim() ?? '').length > 0;
}

const inputSchema = z
    .object({
        mode: z.enum(['catchup', 'manual', 'force']).optional(),
    })
    .passthrough();

type AcoustIdInput = z.infer<typeof inputSchema>;

export interface AcoustIdRunResult {
    fingerprinted: number;
    matched: number;
    noMatch: number;
    ambiguous: number;
    rejected: number;
    fingerprintFailed: number;
    hasTagMbid: number;
    errors: number;
    albumsLinked: number;
    artistsLinked: number;
    stopReason?: string;
}

function emptyResult(): AcoustIdRunResult {
    return {
        fingerprinted: 0,
        matched: 0,
        noMatch: 0,
        ambiguous: 0,
        rejected: 0,
        fingerprintFailed: 0,
        hasTagMbid: 0,
        errors: 0,
        albumsLinked: 0,
        artistsLinked: 0,
    };
}

// =============================================================================
// Album / artist consensus (pure, exported for tests)
// =============================================================================

export interface AlbumArtistDecision {
    releaseGroupMbid: string | null;
    artistMbid: string | null;
    confidence: number;
}

/**
 * Decide album + artist MBIDs from an album's fingerprint-matched tracks.
 *
 * Album: at least two matched tracks (one for a single-track album) covering at
 * least half the album; a release group present on EVERY matched track; and
 * that release group titled like the album. One survivor → use it.
 *
 * Artist: on each matched track, the credited artist whose name equals the
 * album artist's name; all of those must be the same MBID, seen on at least two
 * tracks (one for a single-track album).
 *
 * Anything less is no decision — a wrong album link is worse than none.
 */
export function decideAlbumArtistMbids(ev: AlbumMatchEvidence): AlbumArtistDecision {
    const matches = ev.matches ?? [];
    const minMatches = ev.track_count <= 1 ? 1 : 2;
    const enough = matches.length >= minMatches && matches.length * 2 >= ev.track_count;
    const confidence = matches.length ? Math.min(...matches.map((m) => m.score || 0)) : 0;

    let releaseGroupMbid: string | null = null;
    if (enough) {
        let common: Map<string, string | undefined> | null = null;
        for (const m of matches) {
            const ids = new Map((m.release_groups ?? []).map((rg) => [rg.id, rg.title]));
            if (common === null) {
                common = ids;
            } else {
                for (const id of [...common.keys()]) if (!ids.has(id)) common.delete(id);
            }
        }
        const wantTitle = normalizeTitle(ev.album_title);
        const titled = [...(common ?? new Map()).entries()].filter(
            ([, title]) => wantTitle !== '' && normalizeTitle(title) === wantTitle,
        );
        if (titled.length === 1) releaseGroupMbid = titled[0][0];
    }

    let artistMbid: string | null = null;
    const wantArtist = normalizeTitle(ev.artist_title);
    if (wantArtist && matches.length >= minMatches) {
        const seen: string[] = [];
        for (const m of matches) {
            const names = m.artist_names ?? [];
            const idx = names.findIndex((n) => normalizeTitle(n) === wantArtist);
            const id = idx >= 0 ? m.artist_mbids?.[idx] : undefined;
            if (id) seen.push(id);
        }
        const distinct = new Set(seen);
        if (distinct.size === 1 && seen.length >= minMatches) artistMbid = seen[0];
    }

    return { releaseGroupMbid, artistMbid, confidence };
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Look up a batch; when the server rejects the whole batch for one bad
 * fingerprint, retry one at a time so only that item is marked rejected. An
 * item the server silently left out of a batch reply is retried alone once
 * before it counts as rejected, so a truncated reply can't tombstone it.
 */
async function lookupWithIsolation(
    queries: FingerprintResult[],
    apiKey: string,
    signal: AbortSignal,
): Promise<Array<AcoustIdResult[] | null>> {
    try {
        const out = await lookupAcoustIdBatch(queries, apiKey, { signal });
        if (queries.length > 1) {
            for (let i = 0; i < out.length; i++) {
                if (out[i] !== null) continue;
                try {
                    out[i] =
                        (await lookupAcoustIdBatch([queries[i]], apiKey, { signal }))[0] ?? null;
                } catch (err) {
                    if (!isPerItemRejection(err)) throw err;
                }
            }
        }
        return out;
    } catch (err) {
        if (!isPerItemRejection(err) || queries.length === 1) {
            if (isPerItemRejection(err)) return [null];
            throw err;
        }
    }
    const out: Array<AcoustIdResult[] | null> = [];
    for (const q of queries) {
        try {
            const [one] = await lookupAcoustIdBatch([q], apiKey, { signal });
            out.push(one ?? null);
        } catch (err) {
            if (isPerItemRejection(err)) out.push(null);
            else throw err;
        }
    }
    return out;
}

/** Fill album / artist MBIDs from the tracks' matches. Best-effort. */
async function propagateToAlbums(
    sql: postgres.Sql,
    albumIds: string[],
    result: AcoustIdRunResult,
    logger: { warn: (m: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
    if (albumIds.length === 0) return;
    let evidence: AlbumMatchEvidence[];
    try {
        evidence = await loadAlbumMatchEvidence(sql, albumIds);
    } catch (err) {
        logger.warn('acoustid: loading album evidence failed (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    for (const ev of evidence) {
        const decision = decideAlbumArtistMbids(ev);
        try {
            if (decision.releaseGroupMbid && !ev.album_has_rg) {
                const added = await insertExternalIdIfAbsent(sql, {
                    mediaId: ev.album_id,
                    provider: 'musicbrainz_releasegroup',
                    externalId: decision.releaseGroupMbid,
                    mediaType: 'album',
                    confidence: decision.confidence,
                });
                if (added) {
                    result.albumsLinked++;
                    if (!ev.album_has_poster)
                        await reopenAlbumEnrichmentForPoster(sql, ev.album_id);
                }
            }
            if (decision.artistMbid && ev.artist_id && !ev.artist_has_mbid) {
                const added = await insertExternalIdIfAbsent(sql, {
                    mediaId: ev.artist_id,
                    provider: 'musicbrainz',
                    externalId: decision.artistMbid,
                    mediaType: 'artist',
                    confidence: decision.confidence,
                });
                if (added) result.artistsLinked++;
            }
        } catch (err) {
            logger.warn('acoustid: album/artist MBID write failed (non-fatal)', {
                albumId: ev.album_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

// =============================================================================
// Task
// =============================================================================

export const acoustIdFingerprintTask = defineTask<AcoustIdInput, AcoustIdRunResult>({
    id: TASK_ID,
    purpose: 'music-ai',
    name: 'AcoustID Fingerprint Matching',
    version: '1.0.0',
    processingVersion: PROCESSING_VERSION,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    schedule: { every: '6h', runOnStartup: false, envOverride: 'SYNC_ACOUSTID_INTERVAL' },

    // One drain at a time across all triggers: two concurrent drains would
    // fingerprint the same backlog twice and double the AcoustID request rate.
    identityFor: () => 'global',
    scope: 'global',
    exclusiveWith: { scope: 'global', ttl: '70m' },
    // fpcalc is short single-threaded CPU work; keep it on the analysis lane
    // (one slot, behind nothing latency-sensitive) like the other audio tasks.
    resourceClass: 'analysis',
    quotas: { maxConcurrent: 1 },
    supportsFullRun: true,
    inputSchema,

    coversStages: [
        {
            id: ACOUSTID_STAGE_ID,
            appliesTo: ['track'] as const,
            // Structural + gate eligibility. The two gates are read INSIDE the
            // builder (called every sweep tick), so adding a key or installing
            // fpcalc re-opens the rows the predicates below tombstoned.
            eligibility: {
                sql: (sql) => sql`
                    ${isFpcalcAvailable() ? sql`true` : sql`false`}
                    AND ${acoustIdKeyConfiguredSql(sql as unknown as postgres.Sql, envKeySet())}
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                          JOIN media_files mf ON mf.id = mfi.file_id
                          JOIN media_streams ms ON ms.file_id = mf.id
                         WHERE mfi.media_item_id = mi.id
                           AND NOT mf.is_missing
                           AND ms.stream_type = 'audio'
                    )
                    AND NOT ${hasTagRecordingMbidSql(sql as unknown as postgres.Sql)}
                `,
                recoverWhenAdditionalReasons: [
                    'no-file-linked',
                    ACOUSTID_SKIP.noKey,
                    ACOUSTID_SKIP.noFpcalc,
                    ACOUSTID_SKIP.hasTagMbid,
                ],
            },
            healLimit: 500,
            invalidatedBy: [
                'file.attached',
                'file.detached',
                'file.contentChanged',
                'file.defaultChanged',
                'file.probed',
            ] as const,
            // An alternate file of the same recording does not need a new lookup.
            preserveCompletedOn: ['file.attached'] as const,
            enqueueable: true,
            terminalDisposition: [
                {
                    // Whole-stage gates as predicates (not a global guard) so the
                    // rows read "not applicable to this install" — skipped, not
                    // remaining — with a reason the admin can act on.
                    kind: 'predicate' as const,
                    ruleId: 'acoustid-key-configured',
                    disposeAs: 'skipped_permanent' as const,
                    reason: ACOUSTID_SKIP.noKey,
                    excludes: (sql) =>
                        sql`NOT ${acoustIdKeyConfiguredSql(sql as unknown as postgres.Sql, envKeySet())}`,
                },
                {
                    kind: 'predicate' as const,
                    ruleId: 'acoustid-fpcalc-available',
                    disposeAs: 'skipped_permanent' as const,
                    reason: ACOUSTID_SKIP.noFpcalc,
                    excludes: (sql) => (isFpcalcAvailable() ? sql`false` : sql`true`),
                },
                {
                    // Tags already name the recording — nothing to look up.
                    kind: 'predicate' as const,
                    ruleId: 'acoustid-has-tag-mbid',
                    disposeAs: 'skipped_permanent' as const,
                    reason: ACOUSTID_SKIP.hasTagMbid,
                    excludes: (sql) => hasTagRecordingMbidSql(sql as unknown as postgres.Sql),
                },
                {
                    kind: 'self-terminal' as const,
                    ruleId: 'acoustid-self-terminal',
                },
            ],
        },
    ],

    timeout: { hard: '60m', soft: '55m' },

    async execute(ctx) {
        const sql = ctx.sql as unknown as postgres.Sql;
        const { signal, logger } = ctx;
        const result = emptyResult();

        if (!isFpcalcAvailable()) {
            logger.info('fpcalc not installed — nothing to do');
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'skipped',
                result: { ...result, stopReason: 'no-fpcalc' },
            };
        }
        const apiKey = await resolveAcoustIdApiKey(sql);
        if (!apiKey) {
            logger.info('No AcoustID API key configured — nothing to do');
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'skipped',
                result: { ...result, stopReason: 'no-key' },
            };
        }

        const mode = resolveDrainMode(ctx.input.mode, logger);
        const trackBudget = mode === 'catchup' ? CATCHUP_TRACK_BUDGET : Number.POSITIVE_INFINITY;
        const startedAt = Date.now();
        const total = await countAcoustIdRemaining(sql);
        let processed = 0;
        let consecutiveOutages = 0;
        let lastBatchAt: number | null = null;

        while (!signal.aborted) {
            if (processed >= trackBudget) {
                result.stopReason = 'budget';
                break;
            }
            if (Date.now() - startedAt > SOFT_BUDGET_MS) {
                result.stopReason = 'time-budget';
                break;
            }

            const slice: AcoustIdBacklogRow[] = await findAcoustIdBacklog(sql, ACOUSTID_BATCH_SIZE);
            if (slice.length === 0) break;

            // Slow down (never stop) while a video transcode is running: at most one
            // batch per TRANSCODE_BATCH_INTERVAL_MS. Best-effort — a failed probe
            // means full speed, since fpcalc runs at nice 19 anyway.
            const transcoding = await countLiveVideoTranscodes(sql).catch(() => 0);
            if (transcoding > 0 && lastBatchAt !== null) {
                const wait = lastBatchAt + TRANSCODE_BATCH_INTERVAL_MS - Date.now();
                if (wait > 0) await sleep(wait, signal);
                if (signal.aborted) break;
            }
            lastBatchAt = Date.now();

            // Tracks whose tags carry an MBID (the sweep may not have disposed them yet).
            const tagged = slice.filter((r) => r.has_tag_mbid);
            if (tagged.length) {
                await markAcoustIdSkipped(
                    sql,
                    tagged.map((r) => r.id),
                    ACOUSTID_SKIP.hasTagMbid,
                    PROCESSING_VERSION,
                );
                result.hasTagMbid += tagged.length;
            }

            // 1. Fingerprint, one file at a time.
            const ready: Array<{ row: AcoustIdBacklogRow; fp: FingerprintResult }> = [];
            const unreadable: string[] = [];
            const fsErrors: string[] = [];
            for (const row of slice) {
                if (row.has_tag_mbid) continue;
                // Rows not reached stay pending for the next run.
                if (signal.aborted || Date.now() - startedAt > SOFT_BUDGET_MS) break;
                const fp = await generateFingerprint(row.file_path, { signal });
                if (fp.ok) {
                    ready.push({ row, fp: { fingerprint: fp.fingerprint, duration: fp.duration } });
                } else if (fp.reason === 'fpcalc-failed') {
                    // The file is there but can't be decoded: permanent.
                    unreadable.push(row.id);
                } else if (fp.reason === 'file-missing' || fp.reason === 'fpcalc-timeout') {
                    // Unmounted share / slow storage: retry later.
                    fsErrors.push(row.id);
                }
            }
            if (signal.aborted) break;
            result.fingerprinted += ready.length;
            if (unreadable.length) {
                await markAcoustIdSkipped(
                    sql,
                    unreadable,
                    ACOUSTID_SKIP.fingerprintFailed,
                    PROCESSING_VERSION,
                );
                result.fingerprintFailed += unreadable.length;
            }
            if (fsErrors.length) {
                await markAcoustIdTransientFailure(
                    sql,
                    fsErrors,
                    { message: 'audio file not readable', code: 'file_unreadable' },
                    TRANSIENT_BACKOFF_MS,
                    MAX_ATTEMPTS,
                );
                result.errors += fsErrors.length;
            }

            // 2. Look up the batch.
            let answers: Array<AcoustIdResult[] | null> = [];
            if (ready.length > 0) {
                try {
                    answers = await lookupWithIsolation(
                        ready.map((r) => r.fp),
                        apiKey,
                        signal,
                    );
                    consecutiveOutages = 0;
                } catch (err) {
                    if (signal.aborted) break;
                    if (err instanceof AcoustIdKeyRejectedError) {
                        // Nothing item-specific: leave every row as it is and fail the
                        // run visibly. The sweep's no-progress backoff spaces retries.
                        throw new TaskError({
                            message: `${err.message} — check the AcoustID key in the MusicBrainz provider settings`,
                            kind: 'permanent',
                            cause: err,
                        });
                    }
                    const message = err instanceof Error ? err.message : String(err);
                    logger.warn('AcoustID lookup failed — backing off this batch', {
                        error: message,
                    });
                    await markAcoustIdTransientFailure(
                        sql,
                        ready.map((r) => r.row.id),
                        {
                            message,
                            code:
                                err instanceof AcoustIdTransientError
                                    ? 'acoustid_unavailable'
                                    : 'acoustid_error',
                        },
                        TRANSIENT_BACKOFF_MS,
                        MAX_ATTEMPTS,
                        // An AcoustID outage says nothing about these tracks: back
                        // off, but don't spend their attempts on it.
                        { countAttempt: false },
                    );
                    result.errors += ready.length;
                    processed += slice.length;
                    if (++consecutiveOutages >= MAX_CONSECUTIVE_OUTAGES) {
                        result.stopReason = 'acoustid-unavailable';
                        break;
                    }
                    continue;
                }
            }

            // 3. Decide and store, per track.
            const touchedAlbums = new Set<string>();
            const noMatch: string[] = [];
            const ambiguous: string[] = [];
            const rejected: string[] = [];
            for (let i = 0; i < ready.length; i++) {
                const { row, fp } = ready[i];
                const answer = answers[i];
                if (answer === null || answer === undefined) {
                    rejected.push(row.id);
                    continue;
                }
                const decision = selectConfidentMatch(answer, {
                    title: row.title,
                    album: row.album_title,
                    durationSec: fp.duration,
                });
                if (decision.kind === 'no-match') {
                    noMatch.push(row.id);
                } else if (decision.kind === 'ambiguous') {
                    ambiguous.push(row.id);
                } else {
                    const m = decision.match;
                    await applyAcoustIdMatch(sql, row.id, {
                        recording_mbid: m.recordingMbid,
                        acoustid_id: m.acoustidId,
                        score: m.score,
                        recording_title: m.recordingTitle,
                        artist_mbids: m.artistMbids,
                        artist_names: m.artistNames,
                        release_groups: m.releaseGroups.map((rg) => ({
                            id: rg.id,
                            title: rg.title,
                        })),
                        matched_at: new Date().toISOString(),
                    });
                    await markAcoustIdMatched(sql, row.id, PROCESSING_VERSION);
                    result.matched++;
                    if (row.album_id) touchedAlbums.add(row.album_id);
                }
            }
            // A re-lookup (file changed) that no longer matches drops the earlier
            // fingerprint answer, so a stale recording MBID doesn't linger.
            const unmatched = [...noMatch, ...ambiguous, ...rejected];
            if (unmatched.length) await clearOwnAcoustIdMatch(sql, unmatched);
            for (const [ids, reason] of [
                [noMatch, ACOUSTID_SKIP.noMatch],
                [ambiguous, ACOUSTID_SKIP.ambiguous],
                [rejected, ACOUSTID_SKIP.rejected],
            ] as const) {
                if (ids.length) await markAcoustIdSkipped(sql, ids, reason, PROCESSING_VERSION);
            }
            result.noMatch += noMatch.length;
            result.ambiguous += ambiguous.length;
            result.rejected += rejected.length;

            await propagateToAlbums(sql, [...touchedAlbums], result, logger);

            processed += slice.length;
            ctx.reportProgress(
                Math.min(processed, total),
                total,
                `${result.matched} matched, ${result.noMatch} no match`,
            );
        }

        if (signal.aborted) {
            return { success: false, itemsProcessed: processed, stopReason: 'aborted', result };
        }

        try {
            const counts = await getAcoustIdStageCounts(sql);
            logger.info('AcoustID fingerprint run finished', { ...result, stageCounts: counts });
        } catch {
            logger.info('AcoustID fingerprint run finished', { ...result });
        }
        return { success: true, itemsProcessed: processed, result };
    },
});

registry.registerTask(acoustIdFingerprintTask);
