// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isImageCandidateFileReferenced } from '$lib/server/database/queries/image-candidates.queries.js';
import { registerImageCandidate } from '$lib/server/database/queries/image-candidates.queries.js';
import { deriveImageProvider } from '$lib/shared/image-provenance.js';
import {
    mergeMusicProvenance,
    getAlbumEnrichmentArtworkPaths,
    writableAlbumArtwork,
    persistAlbumCoverArtFallback,
} from '../../../database/queries/music-enrichment-provenance.queries.js';
import type { MusicProvenance } from '$lib/shared/music-provenance.js';

/**
 * Album Enrichment — native defineTask implementation.
 *
 * Sweeps albums missing local poster artwork and fetches cover art + MusicBrainz
 * release IDs from a configurable source chain (TheAudioDB → Discogs → Deezer), with
 * Cover Art Archive used inline as a quality upgrade whenever an MBID surfaces.
 *
 * Bytes are always materialized to disk via `upsertLocalArtwork` (the same
 * chokepoint admin upload uses), so the upstream CDN URL never reaches the
 * client and the rest of the artwork stack treats plugin-written rows
 * identically to user-uploaded ones.
 *
 * Storage location is governed by the global `METADATA_STORAGE_LOCATION`
 * env var via `resolveWritePath` — the unified chokepoint everything else
 * uses.
 *
 * Mode semantics:
 *   - catchup  (scheduled tick):  one slice per run, respects soft budget.
 *   - manual   ("Analyze remaining"): drain until empty.
 *   - force    ("Re-enrich everything"): wipeAlbumEnrichment() then drain.
 *
 * Settings (admin UI):
 * - primary_source:  First enrichment source to try
 * - fallback_source: Second source if primary misses fields (or 'none')
 * - tertiary_source: Third source, default Deezer (or 'none')
 * - DISCOGS_TOKEN:   Discogs personal access token secret (required if Discogs is in chain)
 *
 * Configuration:
 * - SYNC_ALBUM_ENRICHMENT_INTERVAL: Duration-string override for the 24h
 *   cadence (e.g. '12h', '2d'). Read via schedule.envOverride.
 */

import {
    recoverLocalAlbumArt,
    backfillLocalAlbumArt,
} from '$lib/server/services/album-local-art.js';
import { getAlbumReleaseIdentifiers } from '$lib/server/database/queries/album-local-art.queries.js';
import * as path from 'path';
import { safeMkdir, safeUnlink } from '$lib/server/utils/safe-fs.js';
import { randomUUID } from 'node:crypto';
import { writeFileNoFollow } from '$lib/server/utils/contained-fs.js';
import { CONVERTIBLE_CONTENT_TYPES, convertCoverToPng } from './album-artwork-convert.js';
import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext, BacklogStage, FailedItem } from '@sapd/lumastra-plugin-sdk';
import {
    drainBacklog,
    resolveDrainMode,
    formatStopReason,
    computeRemainingHint,
    isAbortedStop,
    lazyBacklog,
} from '../../../plugins/runtime/drain-backlog.js';
import {
    enrichAlbumFromChain,
    ALL_SOURCES,
    DEFAULT_PRIMARY,
    DEFAULT_FALLBACK,
} from '../../../services/album-enrichment-sources.js';
import type {
    AlbumEnrichmentResult as ChainResult,
    EnrichmentSourceId,
} from '../../../services/album-enrichment-sources.js';
// From the types module (not the sources barrel) so the tests that mock the
// sources module don't each have to re-declare the class.
import { AlbumEnrichmentIncompleteError } from '../../../services/album-enrichment.types.js';
import { EnrichmentSourceBreaker } from '../../../services/enrichment-source-breaker.js';
import { getStoredAlbumMbids } from '../../../database/queries/acoustid-fingerprint.queries.js';
import { readDiscogsToken, hasDiscogsToken } from '../../../services/discogs-token.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import { CatalogService } from '../../../services/catalog.service.js';
import { getTaskSettings } from '../../../database/queries/task-settings.queries.js';
import {
    atomicallyWipeAlbumEnrichment,
    clearAlbumMarkerForGapRepoll,
    countUnenrichedAlbums,
    deferAlbumAfterSourceOutage,
    findCoverageTableBacklog,
    getAlbumEnrichmentBacklog,
    getAlbumEnrichmentWipeBatch,
    getUnenrichedAlbums,
    markAlbumProcessed,
    reEnrollGapAlbumsForRepoll,
    updateAlbumPosterUrls,
    type UnenrichedAlbumRow,
} from '../../../database/queries/album-enrichment.queries.js';
import {
    upsertCompletedRow,
    upsertSkippedPermanentRow,
    recordStageAttemptFailure,
} from '../../../database/queries/stage-state.queries.js';
import {
    recordFailure,
    getFailureAggregates,
    type FailureAggregateRow,
} from '../../../database/queries/plugin-failure-events.queries.js';
import {
    upsertLocalArtwork,
    lockArtworkOwners,
} from '../../../database/queries/media-artwork.queries.js';
import { withTx } from '../../../database/with-tx.js';
import { findTrackFileForAlbum } from '../../../database/queries/album-art.queries.js';
import { resolveWritePath } from '../../../services/metadata-storage.service.js';
import {
    getAlbumArt,
    getAlbumArtUrl,
} from '$lib/server/providers/implementations/musicbrainz/cover-art.js';
import { config, getAuthoritativeStageIds } from '$lib/server/config.js';
import type { HttpClient } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { classifyInfraError } from '../../infra-retry.js';
import {
    ResponseTooLargeError,
    readBoundedResponseBytes,
} from '$lib/server/utils/bounded-response.js';

// ============================================================================
// Constants
// ============================================================================

// v2: selected artwork provenance; old rows with existing art remain protected.
const PROCESSING_VERSION = 2;

const TASK_ID = 'album-enrichment';

/** Plugin identifier used for plugin_failure_events records. */
const PLUGIN_ID = 'album-enrichment';

// Authorship marker stored in `media_artwork.remote_url`. The wipe filter
// keys on this string — every plugin-written artwork row carries it, every
// row we don't own (admin upload, post-scan) does not.
const ARTWORK_SOURCE_TAG = 'album-enrichment';

// Slice size for the drain loop. Each album is one HTTP round-trip per
// source plus image-byte fetches, so we keep slices small to report
// progress often and let the soft budget cut cleanly between iterations.
const SLICE_SIZE = 50;

// Batch size for wipe iterations — keeps lock windows short on libraries
// with thousands of plugin-written artwork rows.
const WIPE_BATCH_SIZE = 500;

// Backoff + attempt cap for durable per-item failures whose cause is
// ambiguous (chain threw, poster fetch/write failed against TheAudioDB /
// Discogs / disk). These are recorded via `recordStageAttemptFailure`
// (mirrors media-probe's recordProbeFailure) so the coverage row leaves
// `pending` with a backoff instead of being re-fetched — and re-hammering
// the upstream APIs — on every drain tick, then promotes to
// `failed_permanent` once attempts are exhausted so a genuinely-broken
// match doesn't retry forever.
const ENRICHMENT_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const ENRICHMENT_FAILURE_MAX_ATTEMPTS = 5;

// How long an album first waits after a source failed instead of answering
// (and nothing produced a poster). Same values as artist-enrichment: long
// enough that an outage, or a provider that stays broken like TheAudioDB's
// retired key, isn't re-polled on every drain tick; short enough that a
// one-off blip clears the same day.
const SOURCE_OUTAGE_RETRY_MS = 12 * 60 * 60 * 1000;
// Consecutive deferrals double the wait up to this cap (see
// deferAlbumAfterSourceOutage): 12 h, 1 d, 2 d, ... 64 d, then every 90 days.
// A source that fails for one album for good (a Discogs release whose detail
// 404s) is then asked about four times a year instead of weekly forever.
const SOURCE_OUTAGE_MAX_RETRY_MS = 90 * 24 * 60 * 60 * 1000;

// Allowed image content-types (mirror media-image-storage.service.ts).
// gif is not stored as-is (animated covers would burn cache space); a GIF,
// TIFF or AVIF cover is re-encoded to PNG instead (see album-artwork-convert).
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
};

// 20MB cap mirrors media-image-storage.service.ts. Defends against pathological
// upstream responses that could OOM the worker during a slice.
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// Image-fetch timeout. Album cover URLs occasionally live behind slow CDN
// origins, so we use the MEDIUM tier instead of the default 10s.
const IMAGE_FETCH_TIMEOUT_MS = 20_000;

// ============================================================================
// Settings
// ============================================================================

interface AlbumEnrichmentSettings {
    primary_source: EnrichmentSourceId;
    fallback_source: EnrichmentSourceId | 'none';
    tertiary_source: EnrichmentSourceId | 'none';
}

const DEFAULTS: AlbumEnrichmentSettings = {
    primary_source: DEFAULT_PRIMARY,
    fallback_source: DEFAULT_FALLBACK,
    tertiary_source: 'deezer',
};

const VALID_SOURCES = new Set<string>(['theaudiodb', 'discogs', 'deezer']);
const VALID_FALLBACKS = new Set<string>(['theaudiodb', 'discogs', 'deezer', 'none']);

function mergeSettings(raw: Record<string, unknown>): AlbumEnrichmentSettings {
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

/** Preserve configured order, asking each source at most once. */
export function buildAlbumSourceChain(settings: AlbumEnrichmentSettings): EnrichmentSourceId[] {
    const sources: EnrichmentSourceId[] = [settings.primary_source];
    for (const source of [settings.fallback_source, settings.tertiary_source]) {
        if (source !== 'none' && !sources.includes(source)) sources.push(source);
    }
    return sources;
}

// ============================================================================
// Types
// ============================================================================

type AlbumEnrichmentInput = Record<string, unknown>;

type AlbumEnrichmentResult = {
    itemsProcessed: number;
    message: string;
};

const inputSchema = z.object({}).passthrough();

/** Outcome for a single album. Same `advanced` semantics as artist-enrichment. */
type EnrichOneOutcome = {
    /**
     * `deferred`: no poster, but not every source answered (one failed, or the
     * run stopped mid-chain). Nothing terminal is written, so the album is
     * tried again.
     */
    status: 'enriched' | 'no-match' | 'deferred' | 'failed';
    advanced: boolean;
    /** For `deferred`: which source did not answer, or that the run stopped. */
    detail?: string;
};

type ArtworkType = 'poster' | 'backdrop';

/** Bytes + content-type pair, either fetched from CAA or from the chain URL. */
interface ImageBytes {
    buffer: Buffer;
    contentType: string;
}

// ============================================================================
// Backlog stage translation
// ============================================================================

/**
 * Translate the legacy 4-bucket PluginBacklogStatus to BacklogStage[].
 * Remaining-work buckets only; analyzed is omitted so the card doesn't
 * inflate the count.
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

// ============================================================================
// Artwork helpers
// ============================================================================

/**
 * Resolve the central directory for plugin-written artwork on a given album.
 * Mirrors `media-image-storage.service.ts:60` (artworkCentralDir) — kept inline
 * because that helper is not exported.
 */
function albumArtworkCentralDir(albumId: string): string {
    const baseDir = config.BASE_PATH || '/data';
    return path.join(baseDir, '.metadata', albumId);
}

/**
 * Map a content-type to a file extension, defaulting to `.jpg` when the
 * upstream returns something we recognised as image/jpeg variants.
 */
function extForContentType(contentType: string): string | null {
    return CONTENT_TYPE_TO_EXT[contentType] ?? null;
}

/**
 * Fetch upstream image bytes with timeout + abort-signal composition. Returns
 * null on any non-OK response, disallowed content-type, or oversize payload —
 * the caller turns null into a per-row failure with a structured reason.
 */
async function fetchImageBytes(
    url: string,
    signal: AbortSignal | undefined,
    http: HttpClient,
): Promise<{ ok: true; data: ImageBytes } | { ok: false; reason: string }> {
    // DNS-resolving SSRF guard. The plugin HTTP client already does a
    // syntactic check, but the URL here comes from TheAudioDB / Discogs
    // responses — chained SSRF via a compromised CDN entry could otherwise
    // point us at private IPs that survive the syntactic check.
    try {
        const { assertNotPrivateUrl } = await import('$lib/server/utils/ssrf-guard.js');
        await assertNotPrivateUrl(new URL(url));
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `ssrf_blocked: ${reason.slice(0, 120)}` };
    }

    let response: Response;
    try {
        const timeoutSignal = AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS);
        const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        response = await http.get(url, { signal: combinedSignal });
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `fetch_failed: ${reason.slice(0, 120)}` };
    }
    if (!response.ok) {
        return {
            ok: false,
            reason: `fetch_failed: HTTP ${response.status} ${response.statusText}`,
        };
    }
    const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    const convert = CONVERTIBLE_CONTENT_TYPES.has(contentType);
    if (!ALLOWED_CONTENT_TYPES.has(contentType) && !convert) {
        return {
            ok: false,
            reason: `unsupported_content_type: ${contentType || 'unknown'}`,
        };
    }
    // Streamed with the cap: the URL is whatever the album's metadata names.
    let buffer: Buffer;
    try {
        buffer = await readBoundedResponseBytes(response, MAX_FILE_SIZE);
    } catch (err) {
        if (err instanceof ResponseTooLargeError) {
            return { ok: false, reason: `image_too_large: over ${MAX_FILE_SIZE} bytes` };
        }
        throw err;
    }
    if (convert) {
        const png = await convertCoverToPng(buffer);
        if (!png.ok) return png;
        return { ok: true, data: { buffer: png.buffer, contentType: 'image/png' } };
    }
    return { ok: true, data: { buffer, contentType } };
}

/**
 * Normalize a CAA-returned content-type onto our allowed set. CAA streams
 * sometimes return `image/jpeg` with a charset suffix or a vendor-specific
 * variant; fall back to JPEG when the upstream is plausibly image-flavoured
 * and the buffer doesn't tip past the cap.
 */
function normalizeImageBytes(image: ImageBytes): ImageBytes | null {
    const ct = image.contentType.split(';')[0].trim().toLowerCase();
    if (ALLOWED_CONTENT_TYPES.has(ct)) {
        return { buffer: image.buffer, contentType: ct };
    }
    // CAA's index-image sometimes lacks an explicit Content-Type. Default to
    // jpeg only if upstream looked image-flavoured.
    if (!ct || ct.startsWith('image/')) {
        return { buffer: image.buffer, contentType: 'image/jpeg' };
    }
    return null;
}

/**
 * Write image bytes to disk and return the resolved file path. Does NOT touch
 * the database — the `media_artwork` row is registered separately so it can
 * join the success-path transaction in `enrichOneAlbum` (TASK-H26). On any
 * failure the file is not left half-written by `fs.writeFile` (atomic at the
 * syscall level for our small images), and no DB state has changed.
 */
async function writeArtworkFile(
    albumId: string,
    artworkType: ArtworkType,
    bytes: ImageBytes,
    mediaFilePath: string | null,
): Promise<{ ok: true; filePath: string } | { ok: false; reason: string }> {
    const ext = extForContentType(bytes.contentType);
    if (!ext) {
        return {
            ok: false,
            reason: `unsupported_content_type: ${bytes.contentType}`,
        };
    }
    // Unique managed paths keep pre-transaction byte writes from overwriting an
    // admin upload or sidecar that appears while an upstream fetch is in flight.
    // Storage location still follows METADATA_STORAGE_LOCATION.
    const fileName = `album-enrichment-${artworkType}-${randomUUID()}${ext}`;
    let filePath: string;
    try {
        const resolved = await resolveWritePath({
            mediaFilePath,
            centralDir: albumArtworkCentralDir(albumId),
            fileName,
        });
        filePath = resolved.filePath;
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            reason: `resolve_path_failed: ${reason.slice(0, 120)}`,
        };
    }

    try {
        await safeMkdir(path.dirname(filePath), { recursive: true });
        await writeFileNoFollow(filePath, bytes.buffer);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            reason: `write_failed: ${reason.slice(0, 120)}`,
        };
    }

    return { ok: true, filePath };
}

/** Best-effort unlink of an artwork file written by writeArtworkFile. */
async function unlinkArtworkFile(
    logger: TaskContext['logger'],
    albumId: string,
    filePath: string,
): Promise<void> {
    try {
        await safeUnlink(filePath);
    } catch (unlinkErr) {
        logger.warn('Failed to clean up artwork file after DB rollback', {
            albumId,
            filePath,
            error: unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr),
        });
    }
}

/**
 * Upsert the album's MusicBrainz release + release-group external IDs. Free
 * metadata regardless of whether image bytes landed; unlocks Cover Art Archive
 * on a future force-rerun. Collisions (same MBID already mapped to a different
 * media item) are non-fatal: log and continue.
 *
 * Kept as independent best-effort writes on the top-level connection (never
 * inside the success transaction) precisely because the per-call try/catch
 * here would otherwise swallow an error that already aborted a surrounding
 * postgres transaction, poisoning it for later statements.
 */
async function upsertAlbumMbids(
    sql: postgres.Sql<Record<string, never>>,
    logger: TaskContext['logger'],
    albumId: string,
    chainResult: {
        releaseMbid?: string | null;
        releaseGroupMbid?: string | null;
    },
): Promise<void> {
    const catalog = new CatalogService(sql);
    if (chainResult.releaseMbid) {
        try {
            await catalog.upsertExternalId(albumId, {
                provider: 'musicbrainz_release',
                id: chainResult.releaseMbid,
                mediaType: 'album',
                source: PLUGIN_ID,
            });
        } catch (err) {
            logger.warn('musicbrainz_release upsert failed (non-fatal)', {
                albumId,
                releaseMbid: chainResult.releaseMbid,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    if (chainResult.releaseGroupMbid) {
        try {
            await catalog.upsertExternalId(albumId, {
                provider: 'musicbrainz_releasegroup',
                id: chainResult.releaseGroupMbid,
                mediaType: 'album',
                source: PLUGIN_ID,
            });
        } catch (err) {
            logger.warn('musicbrainz_releasegroup upsert failed (non-fatal)', {
                albumId,
                releaseGroupMbid: chainResult.releaseGroupMbid,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * The source chain threw something other than an incomplete result (a bug, or
 * a DB/infra fault inside it). Mark the album failed and record a bounded
 * attempt failure.
 */
async function recordChainFailure(
    sql: postgres.Sql<Record<string, never>>,
    logger: TaskContext['logger'],
    album: UnenrichedAlbumRow,
    err: unknown,
    jobId: string | undefined,
): Promise<EnrichOneOutcome> {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('Album enrichment chain threw', {
        id: album.id,
        album: album.title,
        artist: album.parent_title,
        error: reason,
    });
    const ok = await markAlbumProcessed(
        sql,
        album.id,
        PROCESSING_VERSION,
        'failed',
        reason.slice(0, 200),
        jobId,
    );
    if (ok) {
        await recordFailure(sql, PLUGIN_ID, album.id, reason, jobId ?? null);
        // Plausibly-transient: the chain composes HTTP calls to
        // TheAudioDB/Discogs, so a throw here is often a network blip or
        // rate-limit rather than a permanently-unmatchable album. Record
        // a bounded-attempt coverage failure so the row leaves `pending`
        // with a backoff instead of cycling on every drain tick; it
        // promotes to `failed_permanent` after
        // ENRICHMENT_FAILURE_MAX_ATTEMPTS.
        try {
            await recordStageAttemptFailure(sql, {
                mediaItemId: album.id,
                stageId: TASK_ID,
                error: {
                    message: reason.slice(0, 500),
                    code: 'chain_threw',
                    retryable: true,
                },
                backoffMs: ENRICHMENT_FAILURE_BACKOFF_MS,
                maxAttempts: ENRICHMENT_FAILURE_MAX_ATTEMPTS,
            });
        } catch (covErr) {
            logger.warn('Failed to record attempt-failure coverage row (non-fatal)', {
                id: album.id,
                error: covErr instanceof Error ? covErr.message : String(covErr),
            });
        }
    }
    return { status: 'failed', advanced: ok };
}

/**
 * Handle an album that got no poster without hearing from every source.
 *
 * Park the coverage row for `SOURCE_OUTAGE_RETRY_MS` (doubling per consecutive
 * deferral). On the legacy (non-coverage) path there is no row to park; the
 * album stays eligible and `advanced: false` lets the drain's no-progress
 * detector stop a run that keeps hitting a dead provider.
 */
async function deferIncompleteAlbum(
    sql: postgres.Sql<Record<string, never>>,
    logger: TaskContext['logger'],
    album: UnenrichedAlbumRow,
    err: AlbumEnrichmentIncompleteError,
): Promise<EnrichOneOutcome> {
    logger.info('Album enrichment deferred: a source did not answer', {
        album: album.title,
        artist: album.parent_title,
        unavailable: err.unavailableSources,
    });
    if (!getAuthoritativeStageIds().has(TASK_ID)) {
        return { status: 'deferred', advanced: false, detail: err.message };
    }
    try {
        const deferred = await deferAlbumAfterSourceOutage(sql, {
            albumId: album.id,
            stageId: TASK_ID,
            retryAfterMs: SOURCE_OUTAGE_RETRY_MS,
            maxRetryAfterMs: SOURCE_OUTAGE_MAX_RETRY_MS,
            detail: err.message,
        });
        return { status: 'deferred', advanced: deferred, detail: err.message };
    } catch (deferErr) {
        logger.warn('Failed to defer album after a source outage', {
            id: album.id,
            error: deferErr instanceof Error ? deferErr.message : String(deferErr),
        });
        return { status: 'deferred', advanced: false, detail: err.message };
    }
}

/**
 * Enrich a single album: run the source chain, optionally upgrade poster
 * bytes via Cover Art Archive, persist artwork rows + MBIDs, and write a
 * processing-state marker.
 *
 * The `advanced` flag tracks whether the row left the fetchSlice predicate
 * for the next drain — drainBacklog uses it to keep its no-progress detector
 * armed under DB-pool exhaustion. See artist-enrichment for the parallel
 * implementation.
 */
export async function enrichOneAlbum(
    sql: postgres.Sql<Record<string, never>>,
    logger: TaskContext['logger'],
    album: UnenrichedAlbumRow,
    sources: EnrichmentSourceId[],
    discogsToken: string,
    signal: AbortSignal | undefined,
    jobId: string | undefined,
    http: HttpClient,
    breaker?: EnrichmentSourceBreaker<EnrichmentSourceId>,
): Promise<EnrichOneOutcome> {
    // Local files do not require a parent artist or a usable network source.
    try {
        if (await recoverLocalAlbumArt(sql as postgres.Sql, album.id, logger, signal)) {
            const ok = await markAlbumProcessed(sql, album.id, PROCESSING_VERSION, 'success');
            if (ok)
                await upsertCompletedRow(sql, {
                    mediaItemId: album.id,
                    stageId: TASK_ID,
                    processingVersion: PROCESSING_VERSION,
                });
            return { status: 'enriched', advanced: ok };
        }
    } catch (err) {
        logger.warn('Local album art attempt failed; trying configured sources', {
            id: album.id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    if (signal?.aborted) return { status: 'deferred', advanced: false, detail: 'aborted' };
    // 1. Resolve parent artist title — already on the row from the join.
    if (!album.parent_title) {
        const reason = 'no_parent_artist';
        const ok = await markAlbumProcessed(
            sql,
            album.id,
            PROCESSING_VERSION,
            'failed',
            reason,
            jobId,
        );
        if (ok) {
            await recordFailure(sql, PLUGIN_ID, album.id, reason, jobId ?? null);
            // Deterministic exclusion: an album with no linked parent artist
            // can never be enriched by this chain (every source needs an
            // artist name to search on). Tombstone the coverage row so it
            // leaves `pending` instead of being re-fetched every drain tick
            // forever — an identity.assigned/changed event (parent linked)
            // re-opens it via the stage's invalidatedBy list.
            try {
                await upsertSkippedPermanentRow(sql, {
                    mediaItemId: album.id,
                    stageId: TASK_ID,
                    processingVersion: PROCESSING_VERSION,
                    skippedReason: 'no-parent-artist',
                });
            } catch {
                // Non-fatal — drain advances on the legacy marker;
                // wedge-guard backstops the coverage row if this keeps failing.
            }
        } else {
            logger.warn('Failed to persist no_parent_artist marker', {
                id: album.id,
            });
        }
        return { status: 'failed', advanced: ok };
    }

    let chainResult: ChainResult | null;
    // Set when a source failed: the album may still get a poster from what the
    // other sources returned (Cover Art Archive via an MBID), but a miss must
    // not be recorded as a no-match.
    let incomplete: AlbumEnrichmentIncompleteError | null = null;
    try {
        // 2. Run the source chain. The chain itself composes the abort
        //    signal into rate-limit sleeps + HTTP fetches.
        const identifiers = await getAlbumReleaseIdentifiers(sql as postgres.Sql, album.id);
        chainResult = await enrichAlbumFromChain(album.parent_title, album.title, sources, {
            ...identifiers,
            discogsToken,
            signal,
            breaker,
            onArtwork: async (role, url, provider) => {
                await registerImageCandidate(sql, {
                    mediaItemId: album.id,
                    role,
                    provider,
                    providerRef: url,
                    remoteUrl: url,
                });
            },
        });
    } catch (err) {
        if (err instanceof AlbumEnrichmentIncompleteError) {
            // Stopped mid-chain: write nothing, the next run asks again.
            if (err.reason === 'aborted') {
                return { status: 'deferred', advanced: false, detail: err.message };
            }
            incomplete = err;
            chainResult = err.partial;
        } else {
            return await recordChainFailure(sql, logger, album, err, jobId);
        }
    }

    // Fill a missing release group from the one already stored on the album —
    // e.g. derived by the acoustid-fingerprint stage from the album's matched
    // tracks — so Cover Art Archive can still supply a poster when the
    // name-based chain misses. Best-effort: a failed read just skips it.
    try {
        const stored = await getStoredAlbumMbids(sql as unknown as postgres.Sql, album.id);
        // Release group only: a stored release MBID would also trigger the blind
        // CAA URL write below, which this fallback must not widen.
        if (stored.releaseGroupMbid && !chainResult?.releaseGroupMbid) {
            chainResult = {
                provenance: chainResult?.provenance,
                posterUrl: chainResult?.posterUrl ?? null,
                backdropUrl: chainResult?.backdropUrl ?? null,
                releaseMbid: chainResult?.releaseMbid ?? null,
                releaseGroupMbid: stored.releaseGroupMbid,
            };
        }
    } catch (err) {
        logger.debug('Stored album MBID lookup failed (non-fatal)', {
            id: album.id,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    if (!chainResult) {
        if (incomplete) return await deferIncompleteAlbum(sql, logger, album, incomplete);
        const ok = await markAlbumProcessed(sql, album.id, PROCESSING_VERSION, 'no-match');
        if (!ok) {
            logger.warn('Failed to persist no-match marker', { id: album.id });
        } else {
            // Tombstone stage_state so the coverage candidate query stops
            // re-fetching this album. Identity-change invalidation will
            // seed a fresh stage row on re-id. See artist-enrichment for
            // the same pattern + rationale.
            try {
                await upsertSkippedPermanentRow(sql, {
                    mediaItemId: album.id,
                    stageId: TASK_ID,
                    processingVersion: PROCESSING_VERSION,
                    skippedReason: 'no-match-upstream',
                });
            } catch {
                // Non-fatal — drain advances on the legacy marker.
            }
        }
        return { status: 'no-match', advanced: ok };
    }

    // Discovery stores references. The image proxy downloads only an elected/requested
    // image; a successful provider URL is a successful enrichment without eager I/O.
    if (chainResult.posterUrl || chainResult.backdropUrl) {
        for (const [role, field] of [
            ['poster', 'posterUrl'],
            ['backdrop', 'backdropUrl'],
        ] as const) {
            const url = chainResult[field];
            if (!url) continue;
            const origin = chainResult.provenance?.[field]?.provider;
            await registerImageCandidate(sql, {
                mediaItemId: album.id,
                role,
                provider:
                    origin === 'coverartarchive'
                        ? 'musicbrainz-caa'
                        : (origin ?? deriveImageProvider(url)),
                providerRef: url,
                remoteUrl: url,
            });
        }
        await upsertAlbumMbids(sql, logger, album.id, chainResult);
        const ok = await markAlbumProcessed(sql, album.id, PROCESSING_VERSION, 'success');
        if (ok)
            await upsertCompletedRow(sql, {
                mediaItemId: album.id,
                stageId: TASK_ID,
                processingVersion: PROCESSING_VERSION,
            });
        return { status: 'enriched', advanced: ok };
    }

    // 3. Cover Art Archive inline upgrade. CAA is poster-only; if the chain
    //    surfaced an MBID, prefer CAA bytes for the poster slot.
    const writable = await writableAlbumArtwork(sql, album.id);
    let posterFromCaa = false;
    let posterBytes: ImageBytes | null = null;
    if (writable.poster && (chainResult.releaseMbid || chainResult.releaseGroupMbid)) {
        try {
            const caa = await getAlbumArt(chainResult.releaseMbid, chainResult.releaseGroupMbid);
            if (caa) {
                const normalized = normalizeImageBytes(caa);
                if (normalized) {
                    posterBytes = normalized;
                    posterFromCaa = true;
                    logger.debug('Cover Art Archive provided poster bytes', {
                        albumId: album.id,
                        releaseMbid: chainResult.releaseMbid,
                        releaseGroupMbid: chainResult.releaseGroupMbid,
                    });
                }
            }
        } catch (err) {
            // CAA failure is not fatal — fall through to upstream URL.
            logger.warn('Cover Art Archive lookup failed (non-fatal)', {
                albumId: album.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // 3b. Persist the Cover Art Archive URL as a fallback poster when the album has
    //     a release MBID, so the image proxy can serve cover art even if no local
    //     bytes get stored below. Idempotent (writes only when custom_poster_url is
    //     null); a successful local-bytes write upgrades it to the on-disk path.
    if (writable.poster && chainResult.releaseMbid) {
        try {
            await persistAlbumCoverArtFallback(
                sql,
                album.id,
                getAlbumArtUrl(chainResult.releaseMbid),
            );
        } catch (err) {
            logger.warn('Failed to persist Cover Art Archive URL (non-fatal)', {
                albumId: album.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // 4. Resolve the on-disk media file (if any). Used by resolveWritePath
    //    to derive the alongside-the-track location when the storage
    //    strategy prefers it.
    const trackFile = await findTrackFileForAlbum(sql, album.id);
    const mediaFilePath = trackFile?.filePath ?? null;

    // 5. Fetch upstream bytes for any slot CAA didn't fill. For poster: only
    //    fetch from chain URL if CAA didn't give us bytes. For backdrop:
    //    always from chain URL (CAA is poster-only).
    let backdropBytes: ImageBytes | null = null;

    if (writable.poster && !posterBytes && chainResult.posterUrl) {
        const fetched = await fetchImageBytes(chainResult.posterUrl, signal, http);
        if (!fetched.ok) {
            const ok = await markAlbumProcessed(
                sql,
                album.id,
                PROCESSING_VERSION,
                'failed',
                fetched.reason,
                jobId,
            );
            if (ok) {
                await recordFailure(sql, PLUGIN_ID, album.id, fetched.reason, jobId ?? null);
                // Plausibly-transient: the poster URL fetch can fail on a
                // slow/flaky upstream CDN as easily as on a genuinely dead
                // link. Record a bounded-attempt coverage failure so the row
                // leaves `pending` with a backoff instead of cycling on
                // every drain tick; it promotes to `failed_permanent` after
                // ENRICHMENT_FAILURE_MAX_ATTEMPTS.
                try {
                    await recordStageAttemptFailure(sql, {
                        mediaItemId: album.id,
                        stageId: TASK_ID,
                        error: {
                            message: fetched.reason.slice(0, 500),
                            code: 'poster_fetch_failed',
                            retryable: true,
                        },
                        backoffMs: ENRICHMENT_FAILURE_BACKOFF_MS,
                        maxAttempts: ENRICHMENT_FAILURE_MAX_ATTEMPTS,
                    });
                } catch (covErr) {
                    logger.warn('Failed to record attempt-failure coverage row (non-fatal)', {
                        id: album.id,
                        error: covErr instanceof Error ? covErr.message : String(covErr),
                    });
                }
            }
            return { status: 'failed', advanced: ok };
        }
        posterBytes = fetched.data;
    }

    if (writable.backdrop && chainResult.backdropUrl) {
        const fetched = await fetchImageBytes(chainResult.backdropUrl, signal, http);
        if (fetched.ok) {
            backdropBytes = fetched.data;
        } else {
            // Backdrop is best-effort — don't fail the whole album over a
            // missing fanart. Just log and skip.
            logger.warn('Backdrop fetch failed (non-fatal)', {
                albumId: album.id,
                reason: fetched.reason,
            });
        }
    }

    // 6. If neither path produced image bytes, classify as no-match. MBIDs
    //    are still free metadata that unlock CAA on a future force-rerun, so
    //    we persist them even here — but the user-facing outcome is "no image
    //    found", so we don't surface success. MBID upserts on the no-match
    //    path are independent best-effort writes (collisions non-fatal); they
    //    don't need to be atomic with the marker because re-processing simply
    //    re-upserts them idempotently.
    if (!posterBytes && !backdropBytes) {
        await upsertAlbumMbids(sql, logger, album.id, chainResult);
        // A source failed and Cover Art Archive had nothing either: retry
        // later rather than record a no-match the failed source might fill.
        if (incomplete) return await deferIncompleteAlbum(sql, logger, album, incomplete);
        const ok = await markAlbumProcessed(sql, album.id, PROCESSING_VERSION, 'no-match');
        if (ok) {
            try {
                await upsertSkippedPermanentRow(sql, {
                    mediaItemId: album.id,
                    stageId: TASK_ID,
                    processingVersion: PROCESSING_VERSION,
                    skippedReason: 'no-image-bytes',
                });
            } catch {
                // Non-fatal — drain advances on the legacy marker.
            }
        }
        return { status: 'no-match', advanced: ok };
    }

    // 7. Upsert MBIDs — free metadata, independent of the artwork+marker
    //    write group below. Kept OUTSIDE the success transaction on purpose:
    //    collisions (same MBID already mapped elsewhere) are expected and
    //    non-fatal, and swallowing them inside a transaction would poison it
    //    (postgres aborts the tx on the first error). They're idempotent, so a
    //    re-processed album simply re-upserts them — no atomicity needed.
    await upsertAlbumMbids(sql, logger, album.id, chainResult);

    // 8. Write artwork bytes to disk BEFORE opening the success transaction.
    //    Filesystem writes can't participate in a DB transaction, so we land
    //    the bytes first and keep the resulting paths to register + roll back.
    //    Poster is the primary artifact — a write failure fails the album.
    //    Backdrop is best-effort — a failure is logged and skipped.
    const writtenFiles: Array<{ artworkType: ArtworkType; filePath: string }> = [];

    if (posterBytes) {
        const wrote = await writeArtworkFile(album.id, 'poster', posterBytes, mediaFilePath);
        if (!wrote.ok) {
            const ok = await markAlbumProcessed(
                sql,
                album.id,
                PROCESSING_VERSION,
                'failed',
                wrote.reason,
                jobId,
            );
            if (ok) {
                await recordFailure(sql, PLUGIN_ID, album.id, wrote.reason, jobId ?? null);
                // Plausibly-transient: write failures are usually local disk
                // / mount issues (ENOSPC, NFS hiccup) rather than a
                // permanently-unwritable album. Record a bounded-attempt
                // coverage failure so the row leaves `pending` with a
                // backoff instead of cycling on every drain tick; it
                // promotes to `failed_permanent` after
                // ENRICHMENT_FAILURE_MAX_ATTEMPTS.
                try {
                    await recordStageAttemptFailure(sql, {
                        mediaItemId: album.id,
                        stageId: TASK_ID,
                        error: {
                            message: wrote.reason.slice(0, 500),
                            code: 'poster_write_failed',
                            retryable: true,
                        },
                        backoffMs: ENRICHMENT_FAILURE_BACKOFF_MS,
                        maxAttempts: ENRICHMENT_FAILURE_MAX_ATTEMPTS,
                    });
                } catch (covErr) {
                    logger.warn('Failed to record attempt-failure coverage row (non-fatal)', {
                        id: album.id,
                        error: covErr instanceof Error ? covErr.message : String(covErr),
                    });
                }
            }
            return { status: 'failed', advanced: ok };
        }
        writtenFiles.push({ artworkType: 'poster', filePath: wrote.filePath });
    }

    if (backdropBytes) {
        const wrote = await writeArtworkFile(album.id, 'backdrop', backdropBytes, mediaFilePath);
        if (wrote.ok) {
            writtenFiles.push({
                artworkType: 'backdrop',
                filePath: wrote.filePath,
            });
        } else {
            // Backdrop write failure is best-effort — log and continue, since
            // the poster (the primary artifact) already landed. We don't
            // retry the album on the next slice just for a missing backdrop.
            logger.warn('Backdrop write failed (non-fatal)', {
                albumId: album.id,
                reason: wrote.reason,
            });
        }
    }

    // 9. Persist the success-path business writes atomically (TASK-H26): the
    //    media_artwork rows + the 'success' processing marker. Without one
    //    transaction, a crash between these writes leaves the album in an
    //    inconsistent state — artwork rows set but the marker missing
    //    (re-processed next slice) or, worse, the marker set but artwork rows
    //    absent (a broken poster reference forever). Wrapping makes the
    //    terminal write group indivisible: either the album is fully enriched
    //    and marked, or the tx rolls back and the row is retried intact.
    //    (Mirrors artist-enrichment.)
    const replacedFiles: string[] = [];
    try {
        await withTx(sql, async (tx) => {
            const txSql = tx as unknown as postgres.Sql<Record<string, never>>;

            await lockArtworkOwners(txSql, [album.id]);
            const stillWritable = await writableAlbumArtwork(txSql, album.id);
            if (
                writtenFiles.some(
                    ({ artworkType }) =>
                        !stillWritable[artworkType === 'poster' ? 'poster' : 'backdrop'],
                )
            ) {
                throw new Error('Artwork ownership changed during enrichment');
            }
            const priorArtwork = await getAlbumEnrichmentArtworkPaths(txSql, album.id);
            const provenance: MusicProvenance = {};
            const writtenFields: string[] = [];
            for (const { artworkType, filePath } of writtenFiles) {
                const registered = await upsertLocalArtwork(txSql, {
                    mediaItemId: album.id,
                    artworkType,
                    filePath,
                    sourceTag: ARTWORK_SOURCE_TAG,
                    provider:
                        artworkType === 'poster' && posterFromCaa
                            ? 'musicbrainz-caa'
                            : deriveImageProvider(
                                  artworkType === 'poster'
                                      ? chainResult.posterUrl
                                      : chainResult.backdropUrl,
                              ),
                    providerRef:
                        artworkType === 'poster' && posterFromCaa
                            ? `https://coverartarchive.org/${chainResult.releaseMbid ? 'release' : 'release-group'}/${chainResult.releaseMbid ?? chainResult.releaseGroupMbid}/front`
                            : ((artworkType === 'poster'
                                  ? chainResult.posterUrl
                                  : chainResult.backdropUrl) ?? filePath),
                });
                if (registered) {
                    for (const prior of priorArtwork) {
                        // Admin uploads reuse legacy poster/backdrop filenames before taking the DB lock.
                        // Only unique enrichment files are safe to clean up after commit.
                        if (
                            prior.artwork_type === artworkType &&
                            prior.file_path !== filePath &&
                            /^album-enrichment-(poster|backdrop)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:jpg|jpeg|png|webp)$/i.test(
                                path.basename(prior.file_path),
                            )
                        )
                            replacedFiles.push(prior.file_path);
                    }
                    await updateAlbumPosterUrls(
                        txSql,
                        album.id,
                        artworkType === 'poster'
                            ? { posterUrl: `/api/image/custom/${album.id}/poster` }
                            : { backdropUrl: `/api/image/custom/${album.id}/backdrop` },
                    );
                    writtenFields.push(artworkType);
                    const source =
                        artworkType === 'poster'
                            ? posterFromCaa
                                ? { provider: 'coverartarchive' as const }
                                : chainResult.provenance?.posterUrl
                            : chainResult.provenance?.backdropUrl;
                    if (source)
                        provenance[artworkType] = {
                            ...source,
                            value: `/api/image/custom/${album.id}/${artworkType}`,
                        };
                }
            }

            await mergeMusicProvenance(
                txSql,
                album.id,
                'album_enrichment',
                writtenFields,
                provenance,
            );
            const ok = await markAlbumProcessed(txSql, album.id, PROCESSING_VERSION, 'success');
            if (!ok) {
                // Roll back the whole enrichment — artwork rows without a
                // marker would re-process the album every slice forever.
                throw new Error('Failed to persist success marker');
            }
        });
    } catch (txErr) {
        // The DB transaction rolled back, but the artwork files are already on
        // disk — clean them up so we don't leak orphans. The album stays
        // eligible and the next slice retries it from scratch (idempotent).
        for (const { filePath } of writtenFiles) {
            await unlinkArtworkFile(logger, album.id, filePath);
        }
        logger.warn('Failed to persist album success writes; rolled back', {
            id: album.id,
            error: txErr instanceof Error ? txErr.message : String(txErr),
        });
        return { status: 'failed', advanced: false };
    }

    // Reaching here means the success transaction committed (the catch above
    // returns early otherwise).
    //
    // 10. Coverage row: this task uses a global-scope input, so the runner
    //     wrapper does not auto-write completion. Best-effort + idempotent —
    //     kept outside the tx (mirrors artist-enrichment); a re-run re-marks it.
    try {
        await upsertCompletedRow(sql, {
            mediaItemId: album.id,
            stageId: TASK_ID,
            processingVersion: PROCESSING_VERSION,
        });
    } catch (coverageErr) {
        logger.warn('Failed to upsert coverage row for album-enrichment (non-fatal)', {
            albumId: album.id,
            error: coverageErr instanceof Error ? coverageErr.message : String(coverageErr),
        });
    }

    for (const filePath of replacedFiles) {
        if (!(await isImageCandidateFileReferenced(sql, filePath)))
            await unlinkArtworkFile(logger, album.id, filePath);
    }

    logger.debug('Enriched album', {
        albumId: album.id,
        album: album.title,
        artist: album.parent_title,
        poster: posterBytes ? 'yes' : 'no',
        backdrop: backdropBytes ? 'yes' : 'no',
        releaseMbid: chainResult.releaseMbid ?? 'none',
        releaseGroupMbid: chainResult.releaseGroupMbid ?? 'none',
    });
    return { status: 'enriched', advanced: true };
}

/**
 * Wipe all plugin-written enrichment data in batches.
 *
 * The wipe-batch query returns artwork rows (one per artwork_type per album)
 * with their on-disk file paths. For each batch we:
 *   1. Best-effort `unlink` every file_path (missing file is not fatal).
 *   2. Group rows by album id and call `atomicallyWipeAlbumEnrichment` once
 *      per batch — the atomic CTE deletes the artwork rows, nulls
 *      custom_*_url columns that point at the plugin's proxy endpoint,
 *      removes plugin-authored MBIDs, and drops the processing-state
 *      namespace key.
 *
 * The loop terminates when the fetch returns zero rows or `signal` fires.
 * Same dual-call pattern as artist-enrichment: invoked from
 * `backlog.wipe` (admin "Wipe" button) AND from `drainBacklog`'s
 * `onWipe` (force mode).
 */
async function wipeAlbumEnrichment(
    sql: postgres.Sql<Record<string, never>>,
    logger: TaskContext['logger'],
    signal: AbortSignal,
): Promise<void> {
    let totalRowsWiped = 0;
    let totalAlbumsWiped = 0;
    let iterations = 0;

    while (!signal.aborted) {
        const rows = await getAlbumEnrichmentWipeBatch(sql, WIPE_BATCH_SIZE);
        if (rows.length === 0) break;
        iterations++;

        // Best-effort unlink on disk before we drop the DB rows. A missing
        // file is not fatal — the plugin may have written to a now-detached
        // library mount, or a prior partial wipe already removed the file
        // but not the row.
        for (const row of rows) {
            if (!row.file_path) continue;
            try {
                await safeUnlink(row.file_path);
            } catch (err) {
                const errno = (err as { code?: string } | null)?.code;
                if (errno !== 'ENOENT') {
                    logger.warn('Failed to unlink artwork file during wipe', {
                        filePath: row.file_path,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        }

        const distinctAlbumIds = Array.from(new Set(rows.map((r) => r.media_item_id)));

        if (distinctAlbumIds.length > 0) {
            await atomicallyWipeAlbumEnrichment(sql, distinctAlbumIds);
            totalAlbumsWiped += distinctAlbumIds.length;
        }
        totalRowsWiped += rows.length;

        // Safety net — if we somehow keep fetching the same rows forever
        // (e.g. atomic wipe couldn't delete the artwork rows due to schema
        // drift), bail rather than spin.
        if (rows.length < WIPE_BATCH_SIZE) {
            // Fewer rows than the batch size means we've drained the table.
            break;
        }
        if (iterations > 10_000) {
            logger.warn('Album enrichment wipe exceeded iteration cap', {
                iterations,
                totalRowsWiped,
                totalAlbumsWiped,
            });
            break;
        }
    }

    if (signal.aborted) {
        logger.warn(
            `Album enrichment wipe aborted after ${totalRowsWiped} artwork row(s) across ${totalAlbumsWiped} album(s)`,
        );
    } else {
        logger.info(
            `Album enrichment wipe complete (${totalRowsWiped} artwork row(s) across ${totalAlbumsWiped} album(s))`,
        );
    }
}

/**
 * Retry a single album. UUID-validated, loads settings, calls enrichOneAlbum.
 * Throws on unrecoverable failure so the SDK marks the retry as failed.
 */
async function retryOneAlbum(
    ctx: TaskContext<AlbumEnrichmentInput>,
    itemId: string,
): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
        throw new Error('Invalid album id (expected UUID)');
    }
    if (!ctx.http) throw new Error('album-enrichment: http capability required');
    const http = ctx.http;

    const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
    const logger = ctx.logger;

    // Match the UnenrichedAlbumRow shape the slice uses, including the
    // parent-artist join. Per-item retries have no task_history row, so we
    // forward the prior `audit_run_job_id` to preserve the Phase D
    // "Run #X →" link if this retry also fails.
    const [album] = await sql<
        Array<{
            id: string;
            title: string;
            parent_id: string | null;
            parent_title: string | null;
            prior_audit_job_id: string | null;
        }>
    >`
        SELECT
            mi.id,
            mi.title,
            mi.parent_id,
            parent.title AS parent_title,
            mi.processing_state -> 'album-enrichment' ->> 'audit_run_job_id' AS prior_audit_job_id
        FROM media_items mi
        LEFT JOIN media_items parent
            ON parent.id = mi.parent_id
            AND parent.media_type = 'artist'
        WHERE mi.id = ${itemId}::uuid
          AND mi.media_type = 'album'
        LIMIT 1
    `;
    if (!album) {
        throw new Error('Album not found');
    }
    const auditJobId = album.prior_audit_job_id ?? undefined;

    // Load the same enrichment config the slice uses. If Discogs is in the
    // chain but has no token, fail fast — same preflight check as execute().
    const rawSettings = await getTaskSettings(sql, TASK_ID);
    const settings = mergeSettings(rawSettings);
    const sources = buildAlbumSourceChain(settings);
    const discogsToken = await readDiscogsToken(ctx.sql, TASK_ID);
    if (sources.includes('discogs') && !discogsToken) {
        throw new Error('Discogs configured but no token — update plugin settings');
    }

    const outcome = await enrichOneAlbum(
        sql,
        logger,
        {
            id: album.id,
            title: album.title,
            parent_id: album.parent_id,
            parent_title: album.parent_title,
        },
        sources,
        discogsToken,
        ctx.signal,
        auditJobId,
        http,
    );
    if (outcome.status === 'enriched') {
        return;
    }
    if (outcome.status === 'no-match') {
        // Terminal non-failed state — the album is no longer in the
        // failed bucket — but no image bytes landed, so the admin's
        // visible outcome is "nothing to show." Throw so the UI can
        // distinguish from an actual fetched-and-saved outcome.
        throw new Error('No image found in any provider');
    }
    if (outcome.status === 'deferred') {
        // Only promise a later retry when the row really was parked; an album
        // outside the drainable states is not picked up again.
        throw new Error(
            (outcome.advanced
                ? `${outcome.detail ?? 'A source did not answer'}; the album will be retried later`
                : `${outcome.detail ?? 'A source did not answer'}; try again later`
            ).slice(0, 200),
        );
    }
    // status === 'failed' — enrichOneAlbum already wrote a failed marker
    // with the reason. Read it back to surface to the admin.
    const [row] = await sql<Array<{ reason: string | null }>>`
        SELECT processing_state -> 'album-enrichment' ->> 'reason' AS reason
        FROM media_items
        WHERE id = ${itemId}::uuid
        LIMIT 1
    `;
    throw new Error((row?.reason ?? 'Still failing').slice(0, 200));
}

// ============================================================================
// Source options for settings UI
// ============================================================================

const sourceOptions = [
    ...ALL_SOURCES,
    { value: 'none' as const, label: 'None (disable fallback)' },
];

// ============================================================================
// Task definition
// ============================================================================

export const albumEnrichmentTask = defineTask<AlbumEnrichmentInput, AlbumEnrichmentResult>({
    id: TASK_ID,
    purpose: 'music-ai',
    name: 'Album Enrichment',
    version: '1.0.0',
    processingVersion: PROCESSING_VERSION,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },

    schedule: {
        every: '24h',
        runOnStartup: false,
        envOverride: 'SYNC_ALBUM_ENRICHMENT_INTERVAL',
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
    // Singleton guard: drains via rate-limited HTTP calls against
    // MusicBrainz / TheAudioDB / Discogs (external quota). Without
    // exclusiveWith, the scheduler's narrow double-fire window
    // (fast-completing run + failed scheduler_state advance) can spawn a
    // second concurrent 'global-catchup' sweep that doubles provider traffic
    // for no extra coverage. identityFor is mode-independent, so this
    // covers every entry point. ttl exceeds the 30m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '40m' },
    // Mass-enrichment — drains via bulk pool.
    resourceClass: 'bulk',
    // Honours `{ mode: 'manual' }` — drains the whole backlog in one
    // run instead of the single batch a scheduled catchup cycle does.
    supportsFullRun: true,
    // Wipes the enrichment this task wrote for every album, then re-fetches it.
    supportsForceRun: true,

    inputSchema,

    coversStages: [
        {
            id: 'album-enrichment',
            appliesTo: ['album'] as const,
            invalidatedBy: ['identity.assigned', 'identity.changed', 'identity.cleared'] as const,
            enqueueable: true,
            // Only albums with at least one track file on disk. An album whose files
            // are gone has nowhere to put "alongside" artwork, so every attempt
            // failed with resolve_path_failed and the row ended failed_permanent
            // after five tries. The dispose pass skips these as 'ineligible'; the
            // sweep's eligibility heal re-opens them when a file is linked again
            // (`has_files` rolls up from the tracks).
            eligibility: {
                sql: (sql) => sql`mi.has_files`,
            },
            terminalDisposition: [
                {
                    // GLOBAL precondition: the configured enrichment chain must have
                    // at least one USABLE source. theaudiodb is keyless, so the
                    // default chain is always usable — but if an admin sets the
                    // chain to discogs-only with no DISCOGS_TOKEN, execute()
                    // skip-not-fails without a terminal write and every pending row
                    // would sit pending forever (dormant backlog). Drain the whole
                    // stage to skipped_transient and retry in 12h; auto-recovers
                    // when a token is added or a keyless source is selected.
                    kind: 'global-guard' as const,
                    ruleId: 'album-enrichment-source-configured',
                    reason: 'no-usable-enrichment-source',
                    retryAfterMs: 12 * 60 * 60 * 1000,
                    guard: async (ctx): Promise<boolean> => {
                        // Switched off by the operator: no source is usable.
                        if (config.DISABLE_MUSIC_ARTWORK_ENRICHMENT) return false;
                        try {
                            const settings = mergeSettings(
                                await getTaskSettings(ctx.sql as never, TASK_ID),
                            );
                            const sources = buildAlbumSourceChain(settings);
                            // TheAudioDB and Deezer are keyless → usable.
                            if (sources.some((s) => s !== 'discogs')) return true;
                            // discogs-only chain → requires a token (shared discogs
                            // integration secret, or a legacy per-task secret).
                            return await hasDiscogsToken(ctx.sql, TASK_ID);
                        } catch (err) {
                            ctx.logger.warn(
                                'album-enrichment source-configured guard probe failed; assuming configured',
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
                    ruleId: 'plugin-wrote-poster',
                    disposeAs: 'completed' as const,
                    reason: 'album-enrichment-plugin-completed',
                    excludes: (sql) => sql`mi.media_type='album' AND mi.status='active'
                    AND (mi.processing_state->'album-enrichment'->>'version')::int >= 1
                    AND COALESCE(mi.processing_state->'album-enrichment'->>'status','success') != 'failed'
                    AND EXISTS (SELECT 1 FROM media_artwork ma WHERE ma.media_item_id=mi.id AND lower(ma.artwork_type)='poster')`,
                },
                {
                    kind: 'predicate' as const,
                    ruleId: 'album-already-has-poster',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'album-already-has-poster',
                    excludes: (sql) => sql`mi.media_type='album' AND mi.status='active'
                    AND EXISTS (SELECT 1 FROM media_artwork ma WHERE ma.media_item_id=mi.id AND lower(ma.artwork_type)='poster')`,
                },
                {
                    kind: 'predicate' as const,
                    ruleId: 'legacy-no-match',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'already-processed-no-match',
                    excludes: (sql) =>
                        sql`mi.processing_state->'album-enrichment'->>'status' = 'no-match'
                            AND (mi.processing_state->'album-enrichment'->>'version')::int >= ${PROCESSING_VERSION}`,
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
                description: 'Third source if earlier sources miss fields. Set to None to disable.',
                default: 'deezer',
                options: sourceOptions.map((s) => ({ value: s.value, label: s.label })),
            },
            // The Discogs token lives on the shared `discogs` integration
            // (/admin/settings/plugins), not per-task — see services/discogs-token.ts.
        ],
    },

    backlog: {
        unitLabel: 'albums',
        sliceSize: 1,
        softBudget: '1s',
        idOf: (row: unknown): string => {
            const r = row as { id?: unknown } | null | undefined;
            return r && typeof r.id === 'string' ? r.id : String(r);
        },
        async stages(ctx: TaskContext<AlbumEnrichmentInput>): Promise<BacklogStage[]> {
            const status = await getAlbumEnrichmentBacklog(ctx.sql, PROCESSING_VERSION);
            return toStages(status);
        },
        async wipe(ctx: TaskContext<AlbumEnrichmentInput>): Promise<void> {
            await wipeAlbumEnrichment(
                ctx.sql as unknown as postgres.Sql<Record<string, never>>,
                ctx.logger,
                ctx.signal,
            );
        },
        async compute(): Promise<{ items: unknown[]; remainingHint: number }> {
            return { items: [], remainingHint: 0 };
        },
    },

    failures: {
        async list(
            ctx: TaskContext<AlbumEnrichmentInput>,
            opts: { limit: number; offset: number },
        ): Promise<{ items: FailedItem[]; total: number }> {
            const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
            const clampedLimit = Math.min(100, Math.max(1, opts.limit));
            const safeOffset = Math.max(0, opts.offset);

            // Predicate mirrors getAlbumEnrichmentBacklog `failed` bucket exactly:
            //   media_type='album', version >= PROCESSING_VERSION, status='failed'.
            // Without the version check, albums with a stale failed marker from an
            // older version appear in the drilldown but not the count.
            const [{ count }] = await sql<[{ count: number }]>`
                SELECT COUNT(*)::int AS count
                FROM media_items mi
                WHERE mi.media_type = 'album'
                  AND (mi.processing_state -> 'album-enrichment' ->> 'version')::int >= ${PROCESSING_VERSION}
                  AND mi.processing_state -> 'album-enrichment' ->> 'status' = 'failed'
            `;

            const rows = await sql<
                Array<{
                    id: string;
                    title: string;
                    processing_state: Record<
                        string,
                        {
                            status?: string;
                            reason?: string;
                            audit_run_job_id?: string;
                        }
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
                ) th ON th.task_id = (mi.processing_state -> 'album-enrichment' ->> 'audit_run_job_id')
                WHERE mi.media_type = 'album'
                  AND (mi.processing_state -> 'album-enrichment' ->> 'version')::int >= ${PROCESSING_VERSION}
                  AND mi.processing_state -> 'album-enrichment' ->> 'status' = 'failed'
                ORDER BY mi.updated_at DESC
                LIMIT ${clampedLimit} OFFSET ${safeOffset}
            `;

            const albumIds = rows.map((r) => r.id);
            // Supplementary aggregate — fall back to empty Map on DB blip so the
            // list still renders (without the new timeline columns).
            let aggregates = new Map<string, FailureAggregateRow>();
            try {
                aggregates = await getFailureAggregates(sql, PLUGIN_ID, albumIds);
            } catch (err) {
                ctx.logger.warn(
                    'listFailedItems aggregate fetch failed — serving list without timeline counts',
                    { error: err instanceof Error ? err.message : String(err) },
                );
            }

            return {
                total: count,
                items: rows.map((r): FailedItem => {
                    const agg = aggregates.get(r.id);
                    return {
                        id: r.id,
                        label: r.title,
                        reason:
                            r.processing_state['album-enrichment']?.reason ?? 'Enrichment failed',
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
        },
        async retry(ctx: TaskContext<AlbumEnrichmentInput>, itemId: string): Promise<void> {
            await retryOneAlbum(ctx, itemId);
        },
    },

    lifecycle: {
        // Mirror of artist-enrichment: when Discogs becomes a usable source after
        // a settings/secret save, re-open albums that still lack a poster so the
        // new provider can fill the gap — non-destructively, no force-wipe. No-op
        // when Discogs isn't usable.
        async onConfigChange(ctx: TaskContext<AlbumEnrichmentInput>): Promise<void> {
            const { sql, logger } = ctx;
            const settings = mergeSettings(await getTaskSettings(sql as never, TASK_ID));
            const sources = buildAlbumSourceChain(settings);
            const discogsToken = await readDiscogsToken(ctx.sql, TASK_ID);
            if (!sources.includes('discogs') || !discogsToken) return;

            if (!config.DISABLE_MUSIC_ARTWORK_ENRICHMENT) {
                const { releaseAfterProviderKeySaved, DISCOGS_ALBUM_KEY_RELEASE } =
                    await import('../../provider-key-release.js');
                await releaseAfterProviderKeySaved(sql as never, DISCOGS_ALBUM_KEY_RELEASE);
            }

            const useCoverageTable = getAuthoritativeStageIds().has(TASK_ID);
            const reEnrolled = useCoverageTable
                ? await reEnrollGapAlbumsForRepoll(sql as never, TASK_ID)
                : await clearAlbumMarkerForGapRepoll(sql as never);

            if (reEnrolled <= 0) return;
            logger.info('album-enrichment: re-enrolled gap albums after provider config change', {
                reEnrolled,
                useCoverageTable,
            });
            const { orchestrator } = await import('../../orchestrator.js');
            await orchestrator.startRun(
                TASK_ID,
                { mode: 'catchup' },
                {
                    trigger: {
                        kind: 'in-process',
                        by: TASK_ID,
                        sourceRoute: 'task.album-enrichment.onConfigChange',
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

    async execute(ctx: TaskContext<AlbumEnrichmentInput>) {
        const { logger, sql, signal } = ctx;
        if (!ctx.http) throw new Error('album-enrichment: http capability required');
        const http = ctx.http;

        const rawInput = ctx.input as Record<string, unknown>;
        const mode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';

        // A normal return (as opposed to a thrown TaskError) is invisible to
        // the runner's success/failure bookkeeping — the run is still
        // recorded 'completed'. This is intentional for a genuine abort (the
        // run legitimately stopped, it didn't error); `success: false` here
        // is kept only for convention/consistency with media-probe and for
        // whatever reads the `result` JSONB column, not because the runner
        // branches on it.
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

        // Runs even for permanently skipped albums, disabled networking and a missing token.
        let localCovered = 0;
        try {
            localCovered = await backfillLocalAlbumArt(
                sql as postgres.Sql,
                logger,
                signal,
                PROCESSING_VERSION,
            );
        } catch (err) {
            logger.warn('Local album art sweep failed; continuing enrichment', {
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // A music scan enqueues this task directly, so pausing its schedule is not
        // enough to keep album names on this server; the switch is checked here.
        if (config.DISABLE_MUSIC_ARTWORK_ENRICHMENT) {
            return {
                success: true,
                itemsProcessed: localCovered,
                result: {
                    itemsProcessed: localCovered,
                    message: 'album-enrichment disabled via DISABLE_MUSIC_ARTWORK_ENRICHMENT',
                },
            };
        }

        let enriched = localCovered;
        let skipped = 0;
        let deferred = 0;
        let errors = 0;

        // Load and validate settings up front so preflight failures bail
        // before any drain work (and, in force mode, before the wipe).
        const rawSettings = await getTaskSettings(
            sql as unknown as postgres.Sql<Record<string, never>>,
            TASK_ID,
        );
        const settings = mergeSettings(rawSettings);

        let sources = buildAlbumSourceChain(settings);

        const discogsToken = await readDiscogsToken(ctx.sql, TASK_ID);
        // Gracefully degrade rather than disable the task. The DEFAULT chain is
        // TheAudioDB + Discogs + Deezer, so an install with no
        // DISCOGS_TOKEN used to bail `itemsProcessed: 0, success: true` every run,
        // silently enriching zero albums forever. Drop the unconfigured source;
        // bail only if that empties the chain.
        if (!discogsToken && sources.includes('discogs')) {
            const dropped = sources;
            sources = sources.filter((s) => s !== 'discogs');
            if (sources.length === 0) {
                return {
                    success: true,
                    itemsProcessed: localCovered,
                    result: {
                        itemsProcessed: localCovered,
                        message:
                            'Discogs is the only configured enrichment source but no token is set. Add a DISCOGS_TOKEN or choose theaudiodb as a source.',
                    },
                };
            }
            logger.warn('Discogs dropped from album enrichment chain — no DISCOGS_TOKEN', {
                configured: dropped,
                using: sources,
            });
        }

        logger.info('Album enrichment chain configured', {
            sources,
            hasDiscogs: sources.includes('discogs'),
        });

        const drainMode = resolveDrainMode(mode, logger);

        const typedSql = sql as unknown as postgres.Sql<Record<string, never>>;

        const useCoverageTable = getAuthoritativeStageIds().has(TASK_ID);

        // Skips a source after consecutive failures, for this run only. When
        // every source is down the drain stops: the albums not yet asked stay
        // as they are instead of being parked without a single request.
        const breaker = new EnrichmentSourceBreaker<EnrichmentSourceId>();
        // A holder, not a `let`: TypeScript does not see the closure's write.
        const stop: { sourcesDown: EnrichmentSourceId[] | null } = { sourcesDown: null };
        const allSourcesDown = (): boolean => {
            if (stop.sourcesDown) return true;
            if (!breaker.allOpen(sources)) return false;
            stop.sourcesDown = [...sources];
            logger.warn('Album enrichment stopped: every source keeps failing', {
                sources: stop.sourcesDown,
            });
            return true;
        };

        // Snapshot the eligible backlog once to avoid a COUNT(*) per
        // slice. Deferred until the first fetchSlice: for force mode
        // onWipe runs *inside* drainBacklog and reseeds the eligible
        // pool, so a pre-wipe count would collapse the progress bar to
        // 100% before real work begins.
        const initialBacklog = lazyBacklog(async () => {
            const count =
                (await countUnenrichedAlbums(typedSql, PROCESSING_VERSION)) + localCovered;
            ctx.reportProgress(localCovered, count);
            return count;
        });

        // Record TheAudioDB/Discogs + cover-art request volume on the cost page.
        // All external HTTP happens inside the drain; this opens the counting scope.
        const result = await withApiCallSpend(ctx, () =>
            drainBacklog<UnenrichedAlbumRow>(
                { logger, abortSignal: signal },
                {
                    mode: drainMode,
                    // The drain's own default budget is 110 min, but this task is
                    // killed by the run watchdog at timeout.hard (30m) — a manual
                    // drain would be marked FAILED mid-slice instead of stopping
                    // cleanly. Finish under that cap so the run ends as
                    // stopReason 'budget' and the remainder rolls to the next catchup.
                    softBudgetMs: 20 * 60 * 1000,
                    sliceSize: SLICE_SIZE,
                    onWipe: () => wipeAlbumEnrichment(typedSql, logger, signal),
                    idOf: (row) => row.id,
                    fetchSlice: async (limit) => {
                        // No items ends the drain.
                        if (allSourcesDown()) return { items: [], remainingHint: 0 };
                        const rows = useCoverageTable
                            ? await findCoverageTableBacklog(typedSql, TASK_ID, limit)
                            : await getUnenrichedAlbums(typedSql, PROCESSING_VERSION, limit);
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
                    processSlice: async (albums, sliceSignal) => {
                        let sliceEnriched = 0;
                        let sliceAdvanced = 0;
                        for (const album of albums) {
                            if (sliceSignal.aborted || allSourcesDown()) break;
                            const outcome = await enrichOneAlbum(
                                typedSql,
                                logger,
                                album,
                                sources,
                                discogsToken,
                                sliceSignal,
                                ctx.runId,
                                http,
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
                            // mark-write — see enrichOneAlbum. When the mark
                            // fails (DB pool exhaustion, connection drop, etc.)
                            // the row stays eligible for the next fetchSlice
                            // so drainBacklog's no-progress detector keeps its
                            // trip wire armed.
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
                    phase: 'Enriching albums',
                    // Heartbeat — 50 albums × (chain + image-byte fetches) per
                    // slice can stretch past the BullMQ stall threshold on slow
                    // upstreams. Emit progress every 2min so the worker isn't
                    // killed mid-slice.
                    heartbeat: {
                        getTotal: () => initialBacklog.peek(),
                        getProcessed: () => enriched + skipped + deferred + errors,
                        getStatus: () =>
                            `Enriching albums... (${enriched} done, ${errors} errors, ${skipped} skipped, ${deferred} deferred)`,
                    },
                },
            ),
        );

        logger.info(
            `Album enrichment complete: ${enriched} enriched, ${skipped} skipped, ${deferred} deferred, ${errors} errors (stop=${result.stopReason})`,
        );

        const suffix =
            formatStopReason(result.stopReason) +
            (stop.sourcesDown
                ? ` (stopped early: ${stop.sourcesDown.join(', ')} kept failing — the rest waits for the next run)`
                : '');

        const message =
            enriched + skipped + deferred + errors === 0
                ? 'All albums are already enriched'
                : `Enriched albums (${enriched} done, ${errors} errors, ${skipped} skipped, ${deferred} deferred)${suffix}`;

        // Same note as the pre-drain abort check above: the runner does not
        // read `success` off a normal return, so `false` here is convention
        // only (matches media-probe) — the mid-drain abort itself already
        // stopped the loop cleanly via drainBacklog's stopReason.
        if (isAbortedStop(result.stopReason)) {
            return {
                success: false,
                itemsProcessed: enriched,
                stopReason: 'aborted',
                result: { itemsProcessed: enriched, message },
            };
        }

        return {
            success: true,
            itemsProcessed: enriched,
            result: { itemsProcessed: enriched, message },
        };
    },
});

registry.registerTask(albumEnrichmentTask);
