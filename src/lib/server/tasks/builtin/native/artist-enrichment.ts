// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { registerImageCandidate } from '$lib/server/database/queries/image-candidates.queries.js';
import { mergeMusicProvenance } from '../../../database/queries/music-enrichment-provenance.queries.js';
import type { MusicProvenance } from '$lib/shared/music-provenance.js';

/**
 * Artist Enrichment — native defineTask implementation.
 *
 * Enriches music artists with images and metadata using a configurable
 * chain of sources (TheAudioDB, Discogs). Sources are tried in order;
 * each source fills gaps left by previous ones.
 *
 * Storage layout (v3): every plugin-written custom_metadata field lives
 * under `custom_metadata.artist_enrichment.{biography, genre, country_code}`
 * so the wipe drops one key instead of hunting for scattered top-level
 * fields that NFO/user also write. Images land in dedicated columns
 * (`custom_poster_url`, `custom_backdrop_url`); MusicBrainz ID goes through
 * `external_ids`. Readers should prefer top-level custom_metadata fields
 * (NFO / user-curated) and fall back to the namespace.
 *
 * Mode semantics (read from ctx.input.mode, default 'catchup'):
 *   - catchup  (scheduled tick):  one slice per run, respects soft budget.
 *   - manual   ("Analyze remaining"): drain until empty.
 *   - force    ("Re-enrich everything"): wipeProcessedData() then drain.
 *
 * Settings (admin UI):
 * - primary_source:  First enrichment source to try
 * - fallback_source: Second source if primary misses fields (or 'none')
 * - DISCOGS_TOKEN:   Discogs personal access token secret (required if Discogs is in chain)
 *
 * Configuration:
 * - SYNC_ARTIST_ENRICHMENT_INTERVAL: Duration-string override for the 24h
 *   cadence (e.g. '12h', '2d'). Read via `schedule.envOverride`.
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext, BacklogStage, FailedItem } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import {
    drainBacklog,
    drainWipe,
    resolveDrainMode,
    formatStopReason,
    computeRemainingHint,
    isAbortedStop,
    lazyBacklog,
} from '../../../plugins/runtime/drain-backlog.js';
import type { PluginContext } from '../../../plugins/types/index.js';
import type {
    ListFailedItemsOptions,
    ListFailedItemsResult,
    RetryItemResult,
} from '../../sync-context-types.js';
import {
    enrichArtistFromChain,
    ALL_SOURCES,
    DEFAULT_PRIMARY,
    DEFAULT_FALLBACK,
} from '../../../services/artist-enrichment-sources.js';
import type { EnrichmentSourceId } from '../../../services/artist-enrichment-sources.js';
// From the types module (not the sources barrel) so the many tests that mock
// the sources module don't each have to re-declare the class.
import { ArtistEnrichmentIncompleteError } from '../../../services/artist-enrichment.types.js';
import { EnrichmentSourceBreaker } from '../../../services/enrichment-source-breaker.js';
import { readDiscogsToken, hasDiscogsToken } from '../../../services/discogs-token.js';
import { CatalogService } from '../../../services/catalog.service.js';
import {
    getTaskSettings,
    upsertTaskSettings,
} from '../../../database/queries/task-settings.queries.js';
import {
    atomicallyWipeArtistEnrichment,
    clearArtistMarkerForGapRepoll,
    countUnenrichedArtists,
    deferArtistAfterSourceOutage,
    findCoverageTableBacklog,
    getArtistEnrichmentBacklog,
    getArtistMusicBrainzId,
    getArtistEnrichmentWipeBatch,
    getUnenrichedArtists,
    markArtistProcessed,
    mergeArtistEnrichmentMetadata,
    reEnrollGapArtistsForRepoll,
    updateArtistPosterUrls,
    type UnenrichedArtistRow,
} from '../../../database/queries/artist-enrichment.queries.js';
import {
    upsertCompletedRow,
    upsertSkippedPermanentRow,
    recordStageAttemptFailure,
} from '../../../database/queries/stage-state.queries.js';
import { withTx } from '../../../database/with-tx.js';
import { assertPublicHttpUrl } from '../../url-safety.js';
import {
    recordFailure,
    getFailureAggregates,
} from '../../../database/queries/plugin-failure-events.queries.js';
import { config, getAuthoritativeStageIds } from '$lib/server/config.js';
import { classifyInfraError } from '../../infra-retry.js';

// ============================================================================
// Constants
// ============================================================================

// v2: configurable source chain (TheAudioDB + Discogs).
// v3: namespace plugin-written custom_metadata under `artist_enrichment`,
//     persist per-artist status (success / no-match / failed) so the drain
//     advances past bad rows instead of re-fetching them every tick.
// v4: re-enrich artists whose v3 marker was written during the broken window
//     (sql.begin on TransactionSql + untyped jsonb key). Bumping invalidates
//     all v3 failed/no-match markers so the drain retries them with fixed code.
// v5: persist selected-field provenance; historical rows with artwork stay protected.
const PROCESSING_VERSION = 5;

const TASK_ID = 'artist-enrichment';

/** Plugin identifier used for plugin_failure_events records. */
const PLUGIN_ID = 'artist-enrichment';

// Key under which all plugin-written custom_metadata fields live, mirroring
// the Essentia namespace approach (music-analysis). Lets the wipe drop a
// single JSON key instead of cherry-picking field names that NFO / user
// edits may legitimately share.
const ENRICHMENT_NAMESPACE_KEY = 'artist_enrichment';

// Slice size for the drain loop. Each artist is one HTTP round-trip per
// source, so we keep slices small to report progress often and let the
// soft budget cut cleanly between iterations.
const SLICE_SIZE = 50;

// Batch size for wipe iterations — keeps lock windows short on libraries
// with thousands of artists.
const WIPE_BATCH_SIZE = 500;

// Backoff + attempt cap for the catch-all per-item failure below, whose
// cause is ambiguous (chain fetch threw, or the write transaction failed).
// Recorded via `recordStageAttemptFailure` (mirrors media-probe's
// recordProbeFailure / album-enrichment's chain-threw branch) so the
// coverage row leaves `pending` with a backoff instead of being re-fetched —
// and re-hammering the upstream APIs — on every drain tick, then promotes to
// `failed_permanent` once attempts are exhausted so a genuinely-broken match
// doesn't retry forever.
const ENRICHMENT_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const ENRICHMENT_FAILURE_MAX_ATTEMPTS = 5;

// How long an artist first waits after a source failed instead of answering
// (and no other source had an image). Long enough that an outage — or a provider that
// stays broken, like TheAudioDB's retired key — isn't re-polled on every
// drain tick; short enough that a one-off blip clears the same day.
const SOURCE_OUTAGE_RETRY_MS = 12 * 60 * 60 * 1000;
// Consecutive deferrals double the wait up to this cap (see
// deferArtistAfterSourceOutage): 12 h, 1 d, 2 d, ... 64 d, then every 90 days.
// A source that fails for one artist for good is then asked about four times
// a year instead of weekly forever.
const SOURCE_OUTAGE_MAX_RETRY_MS = 90 * 24 * 60 * 60 * 1000;

// ============================================================================
// Settings
// ============================================================================

interface ArtistEnrichmentSettings {
    primary_source: EnrichmentSourceId;
    fallback_source: EnrichmentSourceId | 'none';
    tertiary_source: EnrichmentSourceId | 'none';
}

const DEFAULTS: ArtistEnrichmentSettings = {
    primary_source: DEFAULT_PRIMARY,
    fallback_source: DEFAULT_FALLBACK,
    // Deezer defaults ON as a third hop, and because plugin_settings has no
    // row for a key an install has never saved, `mergeSettings` hands this
    // default to EXISTING installs too — not just fresh ones. That is the
    // point: the keyless source that closes most of the coverage gap should
    // not wait on every operator noticing a new dropdown.
    tertiary_source: 'deezer',
};

const VALID_SOURCES = new Set<string>(['theaudiodb', 'discogs', 'deezer']);
const VALID_FALLBACKS = new Set<string>(['theaudiodb', 'discogs', 'deezer', 'none']);

function mergeSettings(raw: Record<string, unknown>): ArtistEnrichmentSettings {
    return {
        primary_source: VALID_SOURCES.has(raw.primary_source as string)
            ? (raw.primary_source as EnrichmentSourceId)
            : DEFAULTS.primary_source,
        fallback_source: VALID_FALLBACKS.has(raw.fallback_source as string)
            ? (raw.fallback_source as EnrichmentSourceId | 'none')
            : DEFAULTS.fallback_source,
        tertiary_source: VALID_FALLBACKS.has(raw.tertiary_source as string)
            ? (raw.tertiary_source as EnrichmentSourceId | 'none')
            : DEFAULTS.tertiary_source,
    };
}

/**
 * Settings key holding the source chain that was last actually applied.
 *
 * Internal bookkeeping, not an operator-facing field, so it is absent from
 * `settings.fields` and the admin UI never renders it. `upsertTaskSettings`
 * writes key-by-key and never deletes keys it wasn't given, so an operator
 * saving the visible fields cannot clobber it.
 */
const APPLIED_CHAIN_KEY = '_applied_source_chain';

/**
 * The ordered, de-duplicated list of sources to try.
 *
 * Extracted because four call sites used to rebuild it inline and only two of
 * them stayed in step; a fifth slot (tertiary) would have made that worse.
 */
function resolveSourceChain(settings: ArtistEnrichmentSettings): EnrichmentSourceId[] {
    const chain: EnrichmentSourceId[] = [settings.primary_source];
    for (const next of [settings.fallback_source, settings.tertiary_source]) {
        if (next === 'none' || chain.includes(next)) continue;
        chain.push(next);
    }
    return chain;
}

/**
 * The chain minus sources that cannot actually run right now — today that is
 * Discogs without a token. This is what gets fingerprinted, so that ADDING a
 * Discogs token counts as a chain change even though the configured chain
 * text is unchanged.
 */
function usableSourceChain(
    chain: EnrichmentSourceId[],
    discogsToken: string,
): EnrichmentSourceId[] {
    return discogsToken ? chain : chain.filter((s) => s !== 'discogs');
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Outcome for a single artist. The `advanced` flag distinguishes "the row
 * left the fetchSlice predicate for the next drain" from "the row is still
 * eligible (mark-write failed)" — drainBacklog relies on advance==false to
 * keep the no-progress detector armed under DB outage conditions. Without
 * this split, a DB failure that kills every mark-write silently lets the
 * drain loop spin forever, crediting work that never landed.
 */
export type EnrichOutcome = {
    /**
     * `deferred`: no image, but not every source answered (one failed, or the
     * run stopped mid-chain). Nothing terminal is written, so the artist is
     * tried again.
     */
    status: 'enriched' | 'no-match' | 'deferred' | 'error';
    advanced: boolean;
    /** For `deferred`: which source did not answer, or that the run stopped. */
    detail?: string;
};

/**
 * Handle a chain run that found no image without hearing from every source.
 *
 * Stopped mid-chain: write nothing. The row is still selectable, and the next
 * run asks again. Source failed: park the coverage row for
 * `SOURCE_OUTAGE_RETRY_MS`. On the legacy (non-coverage) path there is no row
 * to park; the artist stays eligible and `advanced: false` lets the drain's
 * no-progress detector stop a run that keeps hitting a dead provider.
 */
async function deferIncompleteArtist(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    artist: UnenrichedArtistRow,
    err: ArtistEnrichmentIncompleteError,
    knownMusicBrainzId: string | null,
): Promise<EnrichOutcome> {
    if (err.reason === 'aborted') {
        return { status: 'deferred', advanced: false, detail: err.message };
    }

    logger.info('Artist enrichment deferred: a source did not answer', {
        artist: artist.title,
        unavailable: err.unavailableSources,
    });
    if (!getAuthoritativeStageIds().has(TASK_ID))
        return { status: 'deferred', advanced: false, detail: err.message };
    try {
        const deferred = await withTx(sql, async (tx) => {
            const txSql = tx as unknown as postgres.Sql<Record<string, never>>;
            await assertArtistIdentityUnchanged(txSql, artist.id, knownMusicBrainzId);
            return deferArtistAfterSourceOutage(txSql, {
                artistId: artist.id,
                stageId: TASK_ID,
                retryAfterMs: SOURCE_OUTAGE_RETRY_MS,
                maxRetryAfterMs: SOURCE_OUTAGE_MAX_RETRY_MS,
                detail: err.message,
            });
        });
        return { status: 'deferred', advanced: deferred, detail: err.message };
    } catch (deferErr) {
        if (deferErr instanceof ArtistEnrichmentIdentityChangedError) throw deferErr;
        logger.warn('Failed to defer artist after a source outage', {
            id: artist.id,
            error: deferErr instanceof Error ? deferErr.message : String(deferErr),
        });
        return { status: 'deferred', advanced: false, detail: err.message };
    }
}

/** A fetched result predates an operator/scanner identity correction. */
class ArtistEnrichmentIdentityChangedError extends Error {
    constructor() {
        super('Artist identity changed during enrichment; retry with the current identity');
    }
}

async function assertArtistIdentityUnchanged(
    sql: postgres.Sql<Record<string, never>>,
    artistId: string,
    knownMusicBrainzId: string | null,
): Promise<void> {
    if ((await getArtistMusicBrainzId(sql, artistId, true)) !== knownMusicBrainzId) {
        throw new ArtistEnrichmentIdentityChangedError();
    }
}

/**
 * Enrich one artist, persist any results, and mark the artist's
 * processing_state at the current version. On error, sets status='failed'
 * so the drain advances past the row instead of re-fetching every tick.
 *
 * Returns both the outcome category and whether the mark-write landed so
 * the caller can credit `advanced` correctly. See EnrichOutcome.
 */
export async function enrichOneArtist(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    artist: UnenrichedArtistRow,
    sources: EnrichmentSourceId[],
    discogsToken: string,
    signal?: AbortSignal,
    jobId?: string,
    breaker?: EnrichmentSourceBreaker<EnrichmentSourceId>,
): Promise<EnrichOutcome> {
    let knownMusicBrainzId: string | null | undefined;
    try {
        const identitySnapshot = await getArtistMusicBrainzId(sql, artist.id);
        knownMusicBrainzId = identitySnapshot;
        let result: Awaited<ReturnType<typeof enrichArtistFromChain>>;
        try {
            result = await enrichArtistFromChain(artist.title, sources, {
                discogsToken,
                signal,
                breaker,
                knownMusicBrainzId,
                onArtwork: async (role, url, provider) => {
                    await registerImageCandidate(sql, {
                        mediaItemId: artist.id,
                        role,
                        provider,
                        providerRef: url,
                        remoteUrl: url,
                    });
                },
            });
        } catch (err) {
            if (err instanceof ArtistEnrichmentIncompleteError) {
                return await deferIncompleteArtist(sql, logger, artist, err, knownMusicBrainzId);
            }
            throw err;
        }

        if (!result || !result.thumbUrl) {
            logger.debug('No image found from any source', {
                artist: artist.title,
                sources,
            });
            const ok = await withTx(sql, async (tx) => {
                const txSql = tx as unknown as postgres.Sql<Record<string, never>>;
                await assertArtistIdentityUnchanged(txSql, artist.id, identitySnapshot);
                const ok = await markArtistProcessed(
                    txSql,
                    artist.id,
                    PROCESSING_VERSION,
                    'no-match',
                );
                if (!ok) {
                    // Mark-write failed → row stays in backlog, do NOT
                    // advance. drainBacklog's no-progress detector catches
                    // the pathological "every mark fails" case.
                    logger.warn('Failed to persist no-match marker', {
                        id: artist.id,
                    });
                } else {
                    // Tombstone stage_state so the coverage-table candidate
                    // query stops re-fetching this artist forever. Without
                    // this, no-match items loop endlessly: each slice fetches
                    // them, gets no-match, writes processing_state but never
                    // touches stage_state, and the pending row stays eligible.
                    // Identity-change invalidation seeds a fresh stage row
                    // on re-id, so this isn't a permanent dead-end.
                    try {
                        await withTx(txSql, (stageTx) =>
                            upsertSkippedPermanentRow(stageTx, {
                                mediaItemId: artist.id,
                                stageId: TASK_ID,
                                processingVersion: PROCESSING_VERSION,
                                skippedReason: 'no-match-upstream',
                            }),
                        );
                    } catch {
                        // Non-fatal — drain logic still advances on the legacy
                        // marker; next sweep tick will retry coverage write.
                    }
                }
                return ok;
            });
            return { status: 'no-match', advanced: ok };
        }

        // Namespace-scoped metadata so the wipe can drop a single key
        // without stomping NFO / user-curated top-level fields. Readers
        // should prefer top-level (user-owned) and fall back to namespace.
        const enrichmentPayload: Record<string, string> = {};
        if (result.biography) enrichmentPayload.biography = result.biography;
        if (result.genre) enrichmentPayload.genre = result.genre;
        if (result.countryCode) enrichmentPayload.country_code = result.countryCode;

        // Wrap all per-artist writes in a single transaction so a mid-flight
        // crash can't leave us with poster URLs set but no marker — which
        // would park the artist in the `ineligible` bucket forever. The
        // external-id upsert runs inside the tx via a tx-scoped
        // CatalogService; its internal `withTx` resolves to `tx.savepoint`
        // when the surrounding sql is a TransactionSql.
        // If the tx rolls back (including the mark) we treat the row as
        // unadvanced so the next slice retries it.
        await withTx(sql, async (tx) => {
            const txSql = tx as unknown as postgres.Sql<Record<string, never>>;
            await assertArtistIdentityUnchanged(txSql, artist.id, identitySnapshot);
            // Known mappings are never re-confirmed: that would rewrite their
            // provenance (for example fingerprint evidence) to the default api.
            // Discovery still uses the catalogue's atomic preserve-existing guard.
            if (!knownMusicBrainzId && result.musicBrainzId) {
                const txCatalog = new CatalogService(txSql, { skipLifecycleHooks: true });
                const identity = await txCatalog.upsertExternalIdDetailed(
                    artist.id,
                    {
                        provider: 'musicbrainz',
                        id: result.musicBrainzId,
                        mediaType: 'artist',
                    },
                    false,
                    { preserveExisting: true },
                );
                if (!identity.written) throw new ArtistEnrichmentIdentityChangedError();
            }

            // Images live in dedicated columns (not the namespace) so
            // downstream consumers keep the same SELECT — and the image-proxy
            // URL builder continues to work unchanged.
            //
            // Write-time SSRF check (syntactic, no DNS lookup): rejects
            // malformed or obviously-private URLs before they land in the DB.
            // The serve-time image proxy also calls assertNotPrivateUrl
            // (DNS-resolving) — together they defend against both stored
            // garbage and DNS rebinding.
            let safeThumb: string | null = result.thumbUrl;
            let safeFanart: string | null = result.fanartUrl ?? null;
            try {
                if (safeThumb) assertPublicHttpUrl(safeThumb);
            } catch {
                logger.warn('Rejecting artist thumb URL at write time', {
                    artistId: artist.id,
                    url: safeThumb,
                });
                safeThumb = null;
            }
            try {
                if (safeFanart) assertPublicHttpUrl(safeFanart);
            } catch {
                logger.warn('Rejecting artist fanart URL at write time', {
                    artistId: artist.id,
                    url: safeFanart,
                });
                safeFanart = null;
            }
            const written = await updateArtistPosterUrls(txSql, artist.id, safeThumb, safeFanart);
            const provenance: MusicProvenance = {};
            const writtenFields = Object.keys(enrichmentPayload);
            for (const [field, resultField] of [
                ['biography', 'biography'],
                ['genre', 'genre'],
                ['country_code', 'countryCode'],
            ] as const) {
                const value = enrichmentPayload[field];
                const source = result.provenance?.[resultField];
                if (value && source) provenance[field] = { ...source, value };
            }
            for (const [field, resultField, value] of [
                ['poster', 'thumbUrl', safeThumb],
                ['backdrop', 'fanartUrl', safeFanart],
            ] as const) {
                if (written?.[field] && value) {
                    writtenFields.push(field);
                    const source = result.provenance?.[resultField];
                    if (source) provenance[field] = { ...source, value };
                }
            }
            await mergeMusicProvenance(
                txSql,
                artist.id,
                ENRICHMENT_NAMESPACE_KEY,
                writtenFields,
                provenance,
            );

            if (Object.keys(enrichmentPayload).length > 0) {
                await mergeArtistEnrichmentMetadata(
                    txSql,
                    artist.id,
                    ENRICHMENT_NAMESPACE_KEY,
                    enrichmentPayload,
                );
            }

            const ok = await markArtistProcessed(txSql, artist.id, PROCESSING_VERSION, 'success');
            if (!ok) {
                // Rollback the entire enrichment — keeping posters/external
                // IDs without a marker would park the row in the ineligible
                // bucket forever.
                throw new Error('Failed to persist success marker');
            }
            try {
                await withTx(txSql, (stageTx) =>
                    upsertCompletedRow(stageTx, {
                        mediaItemId: artist.id,
                        stageId: TASK_ID,
                        processingVersion: PROCESSING_VERSION,
                    }),
                );
            } catch (coverageErr) {
                logger.warn('Failed to upsert coverage row for artist-enrichment (non-fatal)', {
                    artistId: artist.id,
                    error: coverageErr instanceof Error ? coverageErr.message : String(coverageErr),
                });
            }
        });

        logger.debug('Enriched artist', {
            artist: artist.title,
            thumb: 'yes',
            mbid: result.musicBrainzId ?? 'none',
        });
        return { status: 'enriched', advanced: true };
    } catch (err) {
        if (err instanceof ArtistEnrichmentIdentityChangedError) {
            logger.info(err.message, { artistId: artist.id });
            return { status: 'deferred', advanced: false, detail: err.message };
        }
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn('Error enriching artist', {
            id: artist.id,
            artist: artist.title,
            error: reason,
        });
        // Best-effort: mark so the drain advances past this row. When the
        // mark itself fails the row stays eligible — we return
        // `advanced: false` so drainBacklog's no-progress detector can fire
        // on a genuinely broken writer instead of silently burning through
        // the soft budget. The outer counter still increments as `errors`.
        // If the initial identity read failed, there is no trustworthy snapshot
        // to attribute this error to. Leave the item retryable without writes.
        if (knownMusicBrainzId === undefined) return { status: 'error', advanced: false };
        const identitySnapshot = knownMusicBrainzId;
        try {
            const ok = await withTx(sql, async (tx) => {
                const txSql = tx as unknown as postgres.Sql<Record<string, never>>;
                await assertArtistIdentityUnchanged(txSql, artist.id, identitySnapshot);
                const ok = await markArtistProcessed(
                    txSql,
                    artist.id,
                    PROCESSING_VERSION,
                    'failed',
                    reason,
                    jobId,
                );
                if (ok) {
                    await recordFailure(txSql, PLUGIN_ID, artist.id, reason, jobId ?? null);
                    // Preserve bounded attempt/backoff behavior. A coverage SQL
                    // failure is optional and must not abort the marker/history.
                    try {
                        await withTx(txSql, (stageTx) =>
                            recordStageAttemptFailure(stageTx, {
                                mediaItemId: artist.id,
                                stageId: TASK_ID,
                                error: {
                                    message: reason.slice(0, 500),
                                    code: 'enrich_threw',
                                    retryable: true,
                                },
                                backoffMs: ENRICHMENT_FAILURE_BACKOFF_MS,
                                maxAttempts: ENRICHMENT_FAILURE_MAX_ATTEMPTS,
                            }),
                        );
                    } catch (covErr) {
                        logger.warn('Failed to record attempt-failure coverage row (non-fatal)', {
                            id: artist.id,
                            error: covErr instanceof Error ? covErr.message : String(covErr),
                        });
                    }
                } else {
                    logger.warn('Failed to persist failed marker', { id: artist.id });
                }
                return ok;
            });
            return { status: 'error', advanced: ok };
        } catch (writeErr) {
            if (writeErr instanceof ArtistEnrichmentIdentityChangedError) {
                logger.info(writeErr.message, { artistId: artist.id });
                return { status: 'deferred', advanced: false, detail: writeErr.message };
            }
            throw writeErr;
        }
    }
}

/**
 * Wipe all plugin-written enrichment data in batches via `drainWipe`. Scoped
 * to artists the plugin has touched (processing_state marker present) so
 * user-uploaded posters on never-enriched artists are left alone.
 *
 * Each `wipeBatch` call runs an atomic CTE
 * (`atomicallyWipeArtistEnrichment`) that DELETEs MusicBrainz external_ids
 * AND clears the four plugin-written fields (poster, backdrop, namespace,
 * marker) in one server round-trip — so an abort or crash mid-batch cannot
 * leave a partial wipe behind.
 */
async function wipeArtistEnrichment(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    abortSignal: AbortSignal,
): Promise<void> {
    await drainWipe({
        abortSignal,
        batchSize: WIPE_BATCH_SIZE,
        fetchBatch: (limit) => getArtistEnrichmentWipeBatch(sql, limit),
        wipeBatch: (ids) => atomicallyWipeArtistEnrichment(sql, ids, ENRICHMENT_NAMESPACE_KEY),
        logger,
        label: 'Artist enrichment',
    });
}

/**
 * Retry enrichment for a single artist by ID. Mirrors the same settings-load
 * and enrichOneArtist path used by the drain, so manual retries honor
 * the currently configured source chain.
 */
async function retryOneArtist(
    ctx: TaskContext<ArtistEnrichmentInput>,
    itemId: string,
): Promise<RetryItemResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
        return { success: false, reason: 'Invalid artist id (expected UUID)' };
    }

    const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
    const { logger } = ctx;

    // Match the UnenrichedArtistRow shape the slice uses. `title` is the
    // artist display name — NOT `name`. enrichOneArtist reads the established
    // MusicBrainz identity centrally for retries and ordinary drain runs.
    // Also pull prior `audit_run_job_id` off the existing marker so we can
    // preserve the Phase D "Run #X →" link if this retry also fails —
    // enrichOneArtist's catch will pass whatever jobId we forward into
    // markArtistProcessed, which overwrites the marker wholesale.
    const [artist] = await sql<
        Array<{ id: string; title: string; prior_audit_job_id: string | null }>
    >`
        SELECT
            id,
            title,
            processing_state -> 'artist-enrichment' ->> 'audit_run_job_id' AS prior_audit_job_id
        FROM media_items
        WHERE id = ${itemId}::uuid
          AND media_type = 'artist'
        LIMIT 1
    `;
    if (!artist) {
        return { success: false, reason: 'Artist not found' };
    }
    // Per-item retries have no task_history row; ignore the caller-provided
    // jobId and forward the prior audit link (or undefined) so the marker
    // write preserves the original failure-run reference.
    const auditJobId = artist.prior_audit_job_id ?? undefined;

    try {
        // Load the same enrichment config the slice uses. If Discogs is in the
        // chain but has no token, fail fast — same preflight check as execute().
        const rawSettings = await getTaskSettings(sql, TASK_ID);
        const settings = mergeSettings(rawSettings);
        const sources: EnrichmentSourceId[] = resolveSourceChain(settings);
        const discogsToken = await readDiscogsToken(ctx.sql, TASK_ID);
        if (sources.includes('discogs') && !discogsToken) {
            return {
                success: false,
                reason: 'Discogs configured but no token — update plugin settings',
            };
        }

        const outcome = await enrichOneArtist(
            sql,
            logger as unknown as PluginContext['logger'],
            { id: artist.id, title: artist.title },
            sources,
            discogsToken,
            ctx.signal,
            auditJobId,
        );
        if (outcome.status === 'enriched' || outcome.status === 'no-match') {
            // Both are terminal non-failed states — the artist is no longer
            // in the failed bucket. listFailedItems' predicate filters on
            // status='failed' so the row will not reappear.
            return { success: true };
        }
        if (outcome.status === 'deferred') {
            // Only promise a later retry when the row really was parked; an
            // artist outside the drainable states is not picked up again.
            return {
                success: false,
                reason: (outcome.advanced
                    ? `${outcome.detail ?? 'A source did not answer'}; the artist will be retried later`
                    : `${outcome.detail ?? 'A source did not answer'}; try again later`
                ).slice(0, 200),
            };
        }
        // status === 'error' — enrichOneArtist already wrote a failed marker
        // with the reason. Read it back to surface to the admin.
        const [row] = await sql<Array<{ reason: string | null }>>`
            SELECT processing_state -> 'artist-enrichment' ->> 'reason' AS reason
            FROM media_items
            WHERE id = ${itemId}::uuid
            LIMIT 1
        `;
        return {
            success: false,
            reason: (row?.reason ?? 'Still failing').slice(0, 200),
        };
    } catch (err) {
        return {
            success: false,
            reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        };
    }
}

/**
 * List failed artist enrichments with timeline aggregates from plugin_failure_events.
 */
async function listFailedArtists(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    { limit, offset }: ListFailedItemsOptions,
): Promise<ListFailedItemsResult> {
    const clampedLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);

    // Predicate mirrors getArtistEnrichmentBacklog `failed` bucket exactly:
    //   media_type='artist', version >= PROCESSING_VERSION, status='failed'.
    // Without the version check, artists with a stale failed marker from an
    // older version appear in the drilldown but not the count.
    const [{ count }] = await sql<[{ count: number }]>`
        SELECT COUNT(*)::int AS count
        FROM media_items mi
        WHERE mi.media_type = 'artist'
          AND (mi.processing_state -> 'artist-enrichment' ->> 'version')::int >= ${PROCESSING_VERSION}
          AND mi.processing_state -> 'artist-enrichment' ->> 'status' = 'failed'
    `;

    const rows = await sql<
        Array<{
            id: string;
            title: string;
            processing_state: Record<
                string,
                { status?: string; reason?: string; audit_run_job_id?: string }
            >;
            task_history_id: string | null;
        }>
    >`
        SELECT mi.id, mi.title, mi.processing_state, th.id AS task_history_id
        FROM media_items mi
        LEFT JOIN (
            SELECT id, task_id FROM task_history
            UNION ALL
            SELECT original_id AS id, task_id FROM task_history_archive
            WHERE original_id IS NOT NULL
        ) th ON th.task_id = (mi.processing_state -> 'artist-enrichment' ->> 'audit_run_job_id')
        WHERE mi.media_type = 'artist'
          AND (mi.processing_state -> 'artist-enrichment' ->> 'version')::int >= ${PROCESSING_VERSION}
          AND mi.processing_state -> 'artist-enrichment' ->> 'status' = 'failed'
        ORDER BY mi.updated_at DESC
        LIMIT ${clampedLimit} OFFSET ${safeOffset}
    `;

    const artistIds = rows.map((r) => r.id);
    // Supplementary aggregate — fall back to empty Map on DB blip so the
    // list still renders (without the new timeline columns).
    let aggregates = new Map<
        string,
        {
            plugin_id: string;
            item_id: string;
            failure_count: number;
            first_seen: Date;
            last_seen: Date;
        }
    >();
    try {
        aggregates = await getFailureAggregates(sql, PLUGIN_ID, artistIds);
    } catch (err) {
        logger.warn(
            'listFailedItems aggregate fetch failed — serving list without timeline counts',
            { error: err instanceof Error ? err.message : String(err) },
        );
    }

    return {
        total: count,
        items: rows.map((r) => {
            const agg = aggregates.get(r.id);
            return {
                id: r.id,
                label: r.title,
                reason: r.processing_state['artist-enrichment']?.reason ?? 'Enrichment failed',
                detectedAt: null,
                taskRunId: r.task_history_id ?? undefined,
                ...(agg && {
                    firstSeen: agg.first_seen.toISOString(),
                    failureCount: agg.failure_count,
                    lastSeen: agg.last_seen.toISOString(),
                }),
            };
        }),
    };
}

/**
 * Re-open gap artists when the usable source chain has CHANGED since a drain
 * last ran with one.
 *
 * WHY THIS IS THE ONLY ROUTE. Artists the chain has given up on sit at
 * `skipped_permanent`, and `detectVersionBumps` — the mechanism a
 * `processingVersion` bump goes through — marks ONLY `status='completed'`
 * rows obsolete, leaving `skipped_permanent` deliberately untouched. So
 * bumping the version to ship a new provider would re-poll exactly zero of
 * the artists the new provider was added for. `reEnrollGapArtistsForRepoll`
 * is the one query that flips those rows back to `pending`, and this is what
 * decides when to fire it.
 *
 * The fingerprint is the USABLE chain (see `usableSourceChain`), so both
 * "operator picked a new source" and "operator pasted a Discogs token" count
 * as changes, while a restart with identical config does not — without the
 * stored fingerprint every boot would re-poll the whole gap set forever.
 *
 * Artists that already have a poster are never touched; this is the
 * non-destructive alternative to the force-wipe.
 *
 * Imprecision (inherited from the previous Discogs-only version, still
 * accepted): with no per-item record of which providers ran, gap artists the
 * NEW source also can't fill are re-polled once per chain change and
 * re-tombstoned. Bounded by explicit config changes, not by the schedule.
 */
async function reEnrollOnChainChange(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    usable: EnrichmentSourceId[],
    rawSettings: Record<string, unknown>,
): Promise<number> {
    const fingerprint = usable.join('>');
    const appliedRaw = rawSettings[APPLIED_CHAIN_KEY];
    const applied = typeof appliedRaw === 'string' ? appliedRaw : null;
    if (applied === fingerprint) return 0;

    // Record the new chain FIRST. If the re-enroll below throws, or the run it
    // triggers dies halfway, we still don't want the next tick to re-poll the
    // whole library again — the rows it did flip stay pending and get drained
    // normally. Re-polling is an optimisation, not a correctness requirement.
    if (applied !== fingerprint) {
        await upsertTaskSettings(sql, TASK_ID, { [APPLIED_CHAIN_KEY]: fingerprint });
    }

    // An empty chain can't fill anything; the fingerprint is now recorded so
    // the next real chain counts as a change.
    if (usable.length === 0) return 0;

    const useCoverageTable = getAuthoritativeStageIds().has(TASK_ID);
    let reEnrolled: number;
    if (useCoverageTable) {
        reEnrolled = await reEnrollGapArtistsForRepoll(sql as never, TASK_ID);
        // Clear the legacy marker too, even though the drain reads the coverage
        // table. The admin backlog card buckets off `media_items.processing_state`
        // (see getArtistEnrichmentBacklog), which the stage-state flip above never
        // writes — so without this the re-enrolled artists keep their old
        // version/'no-match' marker, land in the card's "analyzed" bucket, and
        // "Remaining" reads 0 for the whole re-poll. Two views of one fact have
        // to move together. It also stops the 'already-processed-by-legacy'
        // eligibility predicate from immediately re-tombstoning rows we just
        // deliberately re-opened.
        await clearArtistMarkerForGapRepoll(sql as never);
    } else {
        reEnrolled = await clearArtistMarkerForGapRepoll(sql as never);
    }

    if (reEnrolled > 0) {
        logger.info('artist-enrichment: re-enrolled gap artists after source-chain change', {
            reEnrolled,
            useCoverageTable,
            from: applied ?? '(never recorded)',
            to: fingerprint,
        });
    }
    return reEnrolled;
}

// ============================================================================
// Task definition
// ============================================================================

const sourceOptions = [
    ...ALL_SOURCES,
    { value: 'none' as const, label: 'None (disable fallback)' },
];

type ArtistEnrichmentInput = Record<string, unknown>;

type ArtistEnrichmentResult = {
    itemsProcessed: number;
    message: string;
};

const inputSchema = z.object({}).passthrough();

/**
 * Translate the legacy 4-bucket PluginBacklogStatus to BacklogStage[].
 * Mirrors the shim's translateBacklogStatusToStages — remaining-work
 * buckets only; analyzed is omitted so the card doesn't inflate the count.
 */
function toStages(status: {
    analyzed: number;
    remaining: number;
    ineligible: number;
    failed?: number;
}): BacklogStage[] {
    const stages: BacklogStage[] = [];
    if (status.remaining > 0) {
        stages.push({
            id: 'remaining',
            label: 'Remaining',
            count: status.remaining,
        });
    }
    if ((status.failed ?? 0) > 0) {
        stages.push({
            id: 'failed',
            label: 'Failed',
            count: status.failed ?? 0,
        });
    }
    if (status.ineligible > 0) {
        stages.push({
            id: 'ineligible',
            label: 'Ineligible',
            count: status.ineligible,
        });
    }
    return stages;
}

export const artistEnrichmentTask = defineTask<ArtistEnrichmentInput, ArtistEnrichmentResult>({
    id: TASK_ID,
    purpose: 'music-ai',
    name: 'Artist Enrichment',
    version: '3.0.0',
    processingVersion: PROCESSING_VERSION,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },

    schedule: {
        every: '24h',
        runOnStartup: false,
        envOverride: 'SYNC_ARTIST_ENRICHMENT_INTERVAL',
    },

    // MODE-INDEPENDENT on purpose — see music-popularity.ts for the long form.
    // exclusiveWith has no key formula of its own: the orchestrator's SETNX
    // mutex key is `identityKey(taskId, identityFor(input))`, so it inherits
    // whatever this returns. While this was mode-suffixed, catchup, manual and
    // force each got their OWN key, and the guard below collapsed only same-mode
    // re-fires — never cross-mode overlap. That defeated the exact thing it was
    // added for (duplicate provider traffic), and once `force` gained a wipe it
    // also let the wipe delete rows a manual or catchup run was mid-write on.
    // Here the three modes are the same work at different depths, so
    // single-flight across all of them is the correct semantics.
    identityFor: () => 'global',
    scope: 'global',
    // Singleton guard: drains via rate-limited HTTP calls against TheAudioDB /
    // Discogs (external quota). Without exclusiveWith, the scheduler's narrow
    // double-fire window (fast-completing run + failed scheduler_state
    // advance) can spawn a second concurrent 'global-catchup' sweep that
    // doubles provider traffic for no extra coverage. identityFor is
    // mode-independent, so this covers every entry point. ttl exceeds the
    // 30m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '40m' },
    // Mass-enrichment — drains via bulk pool.
    resourceClass: 'bulk',
    // Honours `{ mode: 'manual' }` — drains the whole backlog in one
    // run instead of the single batch a scheduled catchup cycle does.
    supportsFullRun: true,
    // Wipes the enrichment this task wrote for every artist, then re-fetches it.
    supportsForceRun: true,

    inputSchema,

    coversStages: [
        {
            id: 'artist-enrichment',
            appliesTo: ['artist'] as const,
            invalidatedBy: ['identity.assigned', 'identity.changed', 'identity.cleared'] as const,
            enqueueable: true,
            terminalDisposition: [
                {
                    // GLOBAL precondition: the configured enrichment chain must have
                    // at least one USABLE source. theaudiodb is keyless, so the
                    // default chain is always usable — but if an admin sets the
                    // chain to discogs-only (primary=discogs, fallback none/discogs)
                    // with no DISCOGS_TOKEN, execute() skip-not-fails without a
                    // terminal write and every pending row would sit pending forever
                    // (dormant backlog). Drain the whole stage to skipped_transient
                    // and retry in 12h; auto-recovers when a token is added or a
                    // keyless source is selected.
                    kind: 'global-guard' as const,
                    ruleId: 'artist-enrichment-source-configured',
                    reason: 'no-usable-enrichment-source',
                    retryAfterMs: 12 * 60 * 60 * 1000,
                    guard: async (ctx): Promise<boolean> => {
                        // Switched off by the operator: no source is usable.
                        if (config.DISABLE_MUSIC_ARTWORK_ENRICHMENT) return false;
                        try {
                            const settings = mergeSettings(
                                await getTaskSettings(ctx.sql as never, TASK_ID),
                            );
                            const sources: EnrichmentSourceId[] = resolveSourceChain(settings);
                            // theaudiodb (any non-discogs source) is keyless → usable.
                            if (sources.some((s) => s !== 'discogs')) return true;
                            // discogs-only chain → requires a token (shared discogs
                            // integration secret, or a legacy per-task secret).
                            return await hasDiscogsToken(ctx.sql, TASK_ID);
                        } catch (err) {
                            ctx.logger.warn(
                                'artist-enrichment source-configured guard probe failed; assuming configured',
                                {
                                    error: err instanceof Error ? err.message : String(err),
                                },
                            );
                            return true;
                        }
                    },
                },
                {
                    kind: 'predicate' as const,
                    ruleId: 'va-or-custom-poster',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'artist-enrichment-not-applicable',
                    excludes: (sql) => sql`mi.media_type='artist' AND (
                    (mi.custom_poster_url IS NOT NULL AND mi.custom_poster_url != '')
                    OR mi.title ~* '^[[:space:]]*(va|v\\.a\\.?|v/a|various([[:space:]]+artists?)?)[[:space:]]*$'
                    OR mi.title ~* '[/\\\\][[:space:]]*(va|v\\.a\\.?|various([[:space:]]+artists?)?)[[:space:]]*$'
                )`,
                },
                {
                    kind: 'predicate' as const,
                    ruleId: 'legacy-done-completed',
                    disposeAs: 'completed' as const,
                    reason: 'already-processed-by-legacy-success',
                    excludes: (sql) =>
                        sql`mi.processing_state ? 'artist-enrichment' AND mi.processing_state->'artist-enrichment'->>'status' IS NULL`,
                },
                {
                    kind: 'predicate' as const,
                    ruleId: 'legacy-done-skipped',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'already-processed-by-legacy',
                    excludes: (sql) =>
                        sql`mi.processing_state ? 'artist-enrichment' AND mi.processing_state->'artist-enrichment'->>'status' IS NOT NULL`,
                },
            ],
        },
    ],

    timeout: { hard: '30m', soft: '28m' },

    settings: {
        fields: [
            {
                key: 'primary_source',
                type: 'select',
                label: 'Primary Source',
                description: 'First enrichment source to try',
                default: DEFAULT_PRIMARY,
                options: ALL_SOURCES.map((s) => ({
                    value: s.value,
                    label: s.label,
                })),
            },
            {
                key: 'fallback_source',
                type: 'select',
                label: 'Fallback Source',
                description:
                    'Second source if primary misses fields. Set to None to disable. ' +
                    'Discogs needs a token — add it under Settings → Plugins → Discogs.',
                default: DEFAULT_FALLBACK,
                options: sourceOptions.map((s) => ({
                    value: s.value,
                    label: s.label,
                })),
            },
            {
                key: 'tertiary_source',
                type: 'select',
                label: 'Third Source',
                description:
                    'Third source if the first two miss. Set to None to disable. ' +
                    'Deezer is keyless and has by far the best coverage of obscure ' +
                    'artists, so it is the default here.',
                default: DEFAULTS.tertiary_source,
                options: sourceOptions.map((s) => ({
                    value: s.value,
                    label: s.label,
                })),
            },
            // The Discogs token lives on the shared `discogs` integration
            // (/admin/settings/plugins), not per-task — see services/discogs-token.ts.
        ],
    },

    backlog: {
        unitLabel: 'artists',
        sliceSize: 1,
        softBudget: '1s',
        idOf: (row: unknown): string => {
            const r = row as { id?: unknown } | null | undefined;
            return r && typeof r.id === 'string' ? r.id : String(r);
        },
        async stages(ctx: TaskContext<ArtistEnrichmentInput>): Promise<BacklogStage[]> {
            const status = await getArtistEnrichmentBacklog(ctx.sql as never, PROCESSING_VERSION);
            return toStages(status);
        },
        async wipe(ctx: TaskContext<ArtistEnrichmentInput>): Promise<void> {
            await wipeArtistEnrichment(ctx.sql as never, ctx.logger as never, ctx.signal);
        },
        async compute(): Promise<{ items: unknown[]; remainingHint: number }> {
            return { items: [], remainingHint: 0 };
        },
    },

    failures: {
        async list(
            ctx: TaskContext<ArtistEnrichmentInput>,
            opts: { limit: number; offset: number },
        ): Promise<{ items: FailedItem[]; total: number }> {
            const res = await listFailedArtists(ctx.sql as never, ctx.logger as never, opts);
            return {
                total: res.total,
                items: res.items.map((item): FailedItem => ({
                    id: item.id,
                    label: item.label,
                    reason: item.reason,
                    detectedAt: item.detectedAt,
                    subtitle: item.subtitle,
                    firstSeen: item.firstSeen,
                    failureCount: item.failureCount,
                    lastSeen: item.lastSeen,
                })),
            };
        },
        async retry(ctx: TaskContext<ArtistEnrichmentInput>, itemId: string): Promise<void> {
            const result = await retryOneArtist(ctx, itemId);
            if (!result.success) {
                throw new Error(result.reason ?? 'Retry failed');
            }
        },
    },

    lifecycle: {
        // Fired by the settings routes after a settings/secret save commits.
        // Re-open the artists that still lack a poster whenever the usable
        // source chain changed — an operator picking a new source, or pasting a
        // Discogs token that makes an already-configured one usable. Artists
        // that already have a poster are untouched.
        //
        // `execute()` runs the same check, which covers the case this hook
        // cannot: a chain that changed because the APP SHIPPED a new default
        // source, where no operator ever saves anything.
        async onConfigChange(ctx: TaskContext<ArtistEnrichmentInput>): Promise<void> {
            const { sql, logger } = ctx;
            const rawSettings = await getTaskSettings(sql as never, TASK_ID);
            const settings = mergeSettings(rawSettings);
            const discogsToken = await readDiscogsToken(ctx.sql, TASK_ID);
            const usable = usableSourceChain(resolveSourceChain(settings), discogsToken);

            if (
                discogsToken &&
                usable.includes('discogs') &&
                !config.DISABLE_MUSIC_ARTWORK_ENRICHMENT
            ) {
                const { releaseAfterProviderKeySaved, DISCOGS_KEY_RELEASE } =
                    await import('../../provider-key-release.js');
                await releaseAfterProviderKeySaved(sql as never, DISCOGS_KEY_RELEASE);
            }

            const reEnrolled = await reEnrollOnChainChange(
                sql as never,
                logger as unknown as PluginContext['logger'],
                usable,
                rawSettings,
            );
            if (reEnrolled <= 0) return;

            const { orchestrator } = await import('../../orchestrator.js');
            await orchestrator.startRun(
                TASK_ID,
                { mode: 'catchup' },
                {
                    trigger: {
                        kind: 'in-process',
                        by: TASK_ID,
                        sourceRoute: 'task.artist-enrichment.onConfigChange',
                    },
                },
            );
        },
    },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx: TaskContext<ArtistEnrichmentInput>) {
        const { logger, sql, signal } = ctx;
        const startTime = Date.now();

        const rawInput = ctx.input as Record<string, unknown>;
        const mode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';

        // A normal return (as opposed to a thrown TaskError) is invisible to
        // the runner's success/failure bookkeeping — the run is still
        // recorded 'completed'. This is intentional for a genuine abort (the
        // run legitimately stopped, it didn't error); `success: false` here
        // is kept only for convention/consistency with media-probe and with
        // this task's own post-drain abort return below (and for whatever
        // reads the `result` JSONB column) — it does not change runner
        // behavior. Previously this branch returned `success: true`, which
        // was inconsistent with the post-drain abort path's `false`.
        if (signal.aborted) {
            return {
                success: false,
                itemsProcessed: 0,
                stopReason: 'aborted' as const,
                result: {
                    itemsProcessed: 0,
                    message: 'aborted before starting',
                },
            };
        }

        // A music scan enqueues this task directly, so pausing its schedule is not
        // enough to keep artist names on this server; the switch is checked here.
        if (config.DISABLE_MUSIC_ARTWORK_ENRICHMENT) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    itemsProcessed: 0,
                    message: 'artist-enrichment disabled via DISABLE_MUSIC_ARTWORK_ENRICHMENT',
                },
            };
        }

        let enriched = 0;
        let skipped = 0;
        let deferred = 0;
        let errors = 0;

        // Load and validate settings up front so preflight failures bail
        // before any drain work (and, in force mode, before the wipe).
        const rawSettings = await getTaskSettings(sql as never, TASK_ID);
        const settings = mergeSettings(rawSettings);

        let sources: EnrichmentSourceId[] = resolveSourceChain(settings);

        const discogsToken = await readDiscogsToken(ctx.sql, TASK_ID);
        // Gracefully degrade instead of disabling the task. The DEFAULT chain is
        // theaudiodb (keyless) + discogs fallback, so an install with no
        // DISCOGS_TOKEN used to bail with `itemsProcessed: 0, success: true` on
        // EVERY run — silently enriching zero artists forever while the keyless
        // primary would have worked fine. Drop the unconfigured source; only bail
        // if that empties the chain (i.e. discogs was the sole configured source).
        if (!discogsToken && sources.includes('discogs')) {
            const dropped = sources;
            sources = sources.filter((s) => s !== 'discogs');
            if (sources.length === 0) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        itemsProcessed: 0,
                        message:
                            'Discogs is the only configured enrichment source but no token is set. Add a DISCOGS_TOKEN or choose theaudiodb as a source.',
                    },
                };
            }
            logger.warn('Discogs dropped from enrichment chain — no DISCOGS_TOKEN', {
                configured: dropped,
                using: sources,
            });
        }

        logger.info('Enrichment chain configured', {
            sources,
            hasDiscogs: sources.includes('discogs'),
        });

        // A newly SHIPPED source (a changed default) reaches an existing
        // install without any settings save, so `onConfigChange` never fires
        // for it. Checking here means the first scheduled drain after the
        // deploy re-opens the gap artists the new source was added to fix —
        // which, since they are all `skipped_permanent`, nothing else would.
        // Cheap when nothing changed: one settings read already in hand, one
        // string compare, no query.
        // Never let this fail the run: re-polling gap artists is an
        // optimisation, while the drain below is the actual job. A transient
        // DB fault here used to propagate and abort enrichment entirely.
        try {
            await reEnrollOnChainChange(
                sql as never,
                logger as unknown as PluginContext['logger'],
                sources,
                rawSettings,
            );
        } catch (err) {
            logger.warn('artist-enrichment: gap re-enroll failed; continuing with the drain', {
                error: err instanceof Error ? err.message : String(err),
            });
        }

        const drainMode = resolveDrainMode(mode, logger);

        const useCoverageTable = getAuthoritativeStageIds().has(TASK_ID);

        // Skips a source after consecutive failures, for this run only. When
        // every source is down the drain stops: the artists not yet asked stay
        // as they are instead of being parked without a single request.
        const breaker = new EnrichmentSourceBreaker<EnrichmentSourceId>();
        // A holder, not a `let`: TypeScript does not see the closure's write.
        const stop: { sourcesDown: EnrichmentSourceId[] | null } = { sourcesDown: null };
        const allSourcesDown = (): boolean => {
            if (stop.sourcesDown) return true;
            if (!breaker.allOpen(sources)) return false;
            stop.sourcesDown = [...sources];
            logger.warn('Artist enrichment stopped: every source keeps failing', {
                sources: stop.sourcesDown,
            });
            return true;
        };

        // Snapshot the eligible backlog once to avoid a COUNT(*) per
        // slice. Deferred until the first fetchSlice: for force mode
        // onWipe runs *inside* drainBacklog and reseeds the eligible
        // pool, so a pre-wipe count would collapse the progress bar to
        // 100% before real work begins. For non-force modes the
        // lazy-snapshot wrapper is still a no-op second-call cache.
        const initialBacklog = lazyBacklog(async () => {
            const count = await countUnenrichedArtists(sql as never, PROCESSING_VERSION);
            ctx.reportProgress(0, count);
            return count;
        });

        // Record TheAudioDB/Discogs request volume on the cost page. All external
        // HTTP for this task happens inside enrichOneArtist during the drain; the
        // service clients report their calls to the counter, this opens the scope.
        const result = await withApiCallSpend(ctx, () =>
            drainBacklog<UnenrichedArtistRow>(
                { logger, abortSignal: signal },
                {
                    mode: drainMode,
                    // The drain's own default budget is 110 min, but this task is
                    // killed by the run watchdog at timeout.hard (30m) — a manual
                    // drain would be marked FAILED mid-slice instead of stopping
                    // cleanly. Finish under that cap so the run ends as
                    // stopReason 'budget' and the remainder rolls to the next catchup.
                    softBudgetMs: 25 * 60 * 1000,
                    sliceSize: SLICE_SIZE,
                    onWipe: () => wipeArtistEnrichment(sql as never, logger as never, signal),
                    idOf: (row) => row.id,
                    fetchSlice: async (limit) => {
                        // No items ends the drain.
                        if (allSourcesDown()) return { items: [], remainingHint: 0 };
                        const rows = useCoverageTable
                            ? await findCoverageTableBacklog(sql as never, TASK_ID, limit)
                            : await getUnenrichedArtists(sql as never, PROCESSING_VERSION, limit);
                        const total = await initialBacklog();
                        return {
                            items: rows,
                            remainingHint: computeRemainingHint(
                                total,
                                enriched + skipped + deferred + errors,
                                rows.length,
                            ),
                        };
                    },
                    processSlice: async (artists, sliceSignal) => {
                        let sliceEnriched = 0;
                        let sliceAdvanced = 0;
                        for (const artist of artists) {
                            if (sliceSignal.aborted || allSourcesDown()) break;
                            const outcome = await enrichOneArtist(
                                sql as never,
                                logger as never,
                                artist,
                                sources,
                                discogsToken,
                                sliceSignal,
                                ctx.runId,
                                breaker,
                            );
                            if (outcome.status === 'enriched') {
                                enriched++;
                                sliceEnriched++;
                            } else if (outcome.status === 'no-match') {
                                skipped++;
                            } else if (outcome.status === 'deferred') {
                                deferred++;
                            } else {
                                errors++;
                            }
                            // Credit `advanced` strictly on a successful
                            // mark-write — see enrichOneArtist. When the mark
                            // fails (DB pool exhaustion, connection drop, etc.)
                            // the row stays eligible for the next fetchSlice
                            // so drainBacklog's no-progress detector keeps its
                            // trip wire armed. Previously we incremented
                            // unconditionally, hiding the DB outage until the
                            // soft budget blew.
                            if (outcome.advanced) sliceAdvanced++;
                        }
                        return {
                            produced: sliceEnriched,
                            advanced: sliceAdvanced,
                        };
                    },
                    onProgress: (processed, total, meta) => {
                        ctx.reportProgress(processed, total, meta?.currentItem);
                    },
                    phase: 'Enriching artists',
                    // Heartbeat — 50 HTTP calls per slice across two providers
                    // can stretch a slice past the BullMQ stall threshold on
                    // slow upstreams. Emit progress every 2min so the worker
                    // isn't killed mid-slice.
                    heartbeat: {
                        getTotal: () => initialBacklog.peek(),
                        getProcessed: () => enriched + skipped + deferred + errors,
                        getStatus: () =>
                            `Enriching artists... (${enriched} done, ${errors} errors, ${skipped} skipped, ${deferred} deferred)`,
                    },
                },
            ),
        );

        const duration = Date.now() - startTime;
        logger.info(
            `Artist enrichment complete: ${enriched} enriched, ${skipped} skipped, ${deferred} deferred, ${errors} errors (stop=${result.stopReason}, ${duration}ms)`,
        );

        const suffix =
            formatStopReason(result.stopReason) +
            (stop.sourcesDown
                ? ` (stopped early: ${stop.sourcesDown.join(', ')} kept failing — the rest waits for the next run)`
                : '');

        // Same note as the pre-drain abort check above: the runner does not
        // read `success` off a normal return, so this ternary is convention
        // only (matches media-probe / the pre-drain abort branch) — a
        // mid-drain abort already stopped the loop cleanly via
        // drainBacklog's stopReason.
        return {
            success: !isAbortedStop(result.stopReason),
            itemsProcessed: enriched,
            result: {
                itemsProcessed: enriched,
                message:
                    enriched + skipped + deferred + errors === 0
                        ? 'All artists are already enriched'
                        : `Enriched artists (${enriched} done, ${errors} errors, ${skipped} skipped, ${deferred} deferred)${suffix}`,
            },
        };
    },
});

registry.registerTask(artistEnrichmentTask);

// ============================================================================
// Settings helpers (used by admin settings UI route)
// ============================================================================

export async function getArtistEnrichmentSettings(
    sql: postgres.Sql<Record<string, never>>,
): Promise<ArtistEnrichmentSettings> {
    return mergeSettings(await getTaskSettings(sql, TASK_ID));
}

export async function updateArtistEnrichmentSettings(
    sql: postgres.Sql<Record<string, never>>,
    data: Record<string, unknown>,
): Promise<void> {
    const current = await getTaskSettings(sql, TASK_ID);
    if (typeof data.primary_source === 'string' && VALID_SOURCES.has(data.primary_source)) {
        current.primary_source = data.primary_source;
    }
    if (typeof data.fallback_source === 'string' && VALID_FALLBACKS.has(data.fallback_source)) {
        current.fallback_source = data.fallback_source;
    }
    await upsertTaskSettings(sql, TASK_ID, current);
}
