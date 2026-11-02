// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
import { randomUUID } from 'node:crypto';
import { programUuid } from './program-id';
import { withTx } from '$lib/server/database/with-tx.js';
import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { acquireLock, releaseLock } from '$lib/server/cache/valkey.js';
import {
    fetchSsrfValidatedText,
    M3U_MAX_FETCH_BYTES,
    XMLTV_MAX_FETCH_BYTES,
} from './fetch-source.js';
import { parseM3uAsync } from './m3u-parser.js';
import { processChannels } from './auto-processor.js';
import { matchEpgChannelsAsync } from './epg-matcher.js';
import {
    waitForSourceWriteLock,
    LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS,
} from './source-write-lock.js';
export { LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS } from './source-write-lock.js';
import { snapshotSourceFavorites, carryOverSourceFavorites } from './channel-favorites.service.js';
import { LiveTvImportCancelledError, isLiveTvImportCancelled } from './livetv-import-abort.js';
import { parseXmltv, type XmltvWarningKind } from './xmltv-parser.js';
import { collapseByChannel } from './epg-schedule.js';
import {
    getSourceByIdWithCredentials,
    updateRefreshStatus,
    updateEpgRefreshStatus,
} from '$lib/server/database/queries/livetv-sources.queries.js';
import {
    bulkCreateChannels,
    deleteChannelsBySourceId,
    deleteUnusedBackupGroupsOfSource,
    purgeEmptyCategories,
    shareBackupGroupLogos,
    getChannelsBySourceId,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import type {
    BulkImportData,
    CreateChannelData,
} from '$lib/server/database/queries/livetv-channels.queries.js';

import { getSourceLineupFilter } from '$lib/server/database/queries/livetv-setup.queries.js';
import { applySetupPreferences, type SetupResult } from './livetv-setup.service.js';
import { parseLineupFilter } from './lineup-filter.js';
import {
    carryOverChannelNumbers,
    snapshotSourceNumbers,
    type ImportedChannel,
} from './channel-numbers.service.js';
import { lockChannelNumbers } from '$lib/server/database/queries/livetv-channel-numbers.queries.js';

const logger = Logger.for('LiveTvImport');

// ── Types ───────────────────────────────────────────────────────────────

export interface ImportResult {
    sourceId: string;
    sourceName: string;
    channelCount: number;
    backupGroupCount: number;
    categoryCount: number;
    epgMatchCount: number;
    programCount: number;
    errors: string[];
    /** Problems the operator can act on. Keeps an attention item open. */
    warnings: string[];
    /** Routine feed noise (duplicate ids, truncated text, skipped bad ranges). Informational only. */
    notes: string[];
    duration: number;
}

export type ProgressCallback = (progress: {
    phase: string;
    processed: number;
    total: number;
    message?: string;
}) => Promise<void>;

/** Guide-icon logo fill (importEpgSource 7d): minimum match confidence. */
const LOGO_FILL_MIN_CONFIDENCE = 0.8;
/** Channels per guide-logo UPDATE statement. */
const LOGO_FILL_CHUNK = 2000;

// ── M3U Import ───────────────────────────────────────────────────────────

export async function importM3uSource(
    sql: postgres.Sql,
    sourceId: string,
    progressCallback?: ProgressCallback,
    waitForLock = false,
): Promise<ImportResult> {
    // Guard against empty / whitespace-only sourceId. Without this, the
    // lock key collapses to a single global slot ('livetv-source-write:'),
    // which would serialize all empty-source calls behind one mutex and
    // mask the real "invalid input" failure downstream.
    if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
        throw new Error('importM3uSource: sourceId is required');
    }
    // Cross-replica defensive lock. import-m3u + refresh-m3u both delete
    // and re-write the same set of tvchannel media_items + livetv_channels
    // rows; running concurrently against the same source deadlocks at the
    // PG row-lock level. Acquire a Valkey SET NX EX mutex keyed by sourceId
    // before doing any work. The Valkey-backed acquireLock helper is the
    // same primitive the task scheduler and cluster heartbeat use, so it's
    // safe across replicas — only one pod's importM3uSource or
    // refreshM3uSource can hold the key for a given source at a time.
    // TTL slightly longer than the M3U tasks' hard timeout so a hard-killed
    // run's lock auto-expires shortly after the kill instead of wedging the
    // source (see LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS).
    // `lock:` prefix routes this per-source cross-replica write lock to the
    // noeviction coordination Valkey instance (COORDINATION_KEY_PREFIXES) — else
    // eviction could let two replicas import/refresh the same source concurrently.
    const lockKey = `lock:livetv-source-write:${sourceId}`;
    const lockValue = waitForLock
        ? await waitForSourceWriteLock(sourceId, progressCallback)
        : await acquireLock(lockKey, LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS);
    if (!lockValue) {
        throw new Error(
            `LiveTV source ${sourceId} is busy: another import-m3u or ` +
                `refresh-m3u run is in progress for this source. Try again ` +
                `once it finishes (lock TTL up to 25 minutes).`,
        );
    }
    try {
        return await importM3uSourceInner(sql, sourceId, progressCallback);
    } catch (error) {
        // An admin cancel is not a source failure (and must not raise an
        // attention alert); the transaction rolled back, the old channels stay.
        if (isLiveTvImportCancelled(error)) throw error;
        // Record the failure on the source. Without this the card kept its
        // previous status, and the EPG import that runs next wrote 'success'
        // over a source with 0 channels. The summary feeds admin attention
        // alerts, so never the raw (credential-bearing) URL.
        await updateRefreshStatus(sql, sourceId, 'failed', {
            error: redactLiveTvUrlsInText(String(error)),
        }).catch((statusErr: unknown) => {
            logger.warn('Could not record failed M3U import status', {
                sourceId,
                error: String(statusErr),
            });
        });
        throw error;
    } finally {
        await releaseLock(lockKey, lockValue);
    }
}

async function importM3uSourceInner(
    sql: postgres.Sql,
    sourceId: string,
    progressCallback?: ProgressCallback,
): Promise<ImportResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Load source with credentials
    const source = await getSourceByIdWithCredentials(sql, sourceId);
    if (!source) throw new Error(`Source not found: ${sourceId}`);
    if (!source.m3u_url) throw new Error(`Source ${sourceId} has no M3U URL`);

    logger.info('Starting M3U import', { sourceId, sourceName: source.name });

    // 2. Report phase: fetching
    await progressCallback?.({
        phase: 'fetching',
        processed: 0,
        total: 1,
        message: 'Fetching M3U content...',
    });

    // 3-4. SSRF validate + fetch the M3U content (see fetch-source.ts)
    const content = await fetchSsrfValidatedText(source.m3u_url, {
        sourceId,
        logger,
        contentLabel: 'M3U',
        fetchFailLogMessage: 'M3U fetch failed',
        maxBytes: M3U_MAX_FETCH_BYTES,
    });

    // 5. Parse M3U
    await progressCallback?.({
        phase: 'parsing',
        processed: 0,
        total: 1,
        message: 'Parsing M3U content...',
    });
    const parseResult = await parseM3uAsync(content);

    if (parseResult.channels.length === 0) {
        // Distinguish "the playlist had nothing in it" from "the playlist had
        // channels and every one was rejected". Both used to surface as
        // "M3U parsing produced zero channels", which sent you looking at the
        // parser when the usual cause is the SSRF policy discarding stream URLs
        // that resolve to private addresses (see assertStreamUrlAllowed).
        if (parseResult.skipped > 0) {
            throw new Error(
                `M3U parsed but all ${parseResult.skipped} channel(s) were rejected before import — ` +
                    'most often stream URLs resolving to private addresses. ' +
                    'Set LIVETV_ALLOW_PRIVATE_URLS=true for a LAN source, or check the ' +
                    '"M3U channel skipped" warnings in the worker log for the exact reason.',
            );
        }
        throw new Error(
            'M3U parsing produced zero channels — the playlist was fetched but contained no ' +
                '#EXTINF entries (check the URL returns a playlist and not an error page).',
        );
    }

    // Collect parse errors
    for (const err of parseResult.errors) {
        errors.push(`Parse error line ${err.line}: ${err.reason}`);
    }

    // Collect parse warnings (cap at 100 to avoid JSONB bloat)
    const MAX_WARNINGS = 100;
    for (const warn of parseResult.warnings) {
        if (warnings.length >= MAX_WARNINGS) {
            warnings.push(`... and ${parseResult.warnings.length - MAX_WARNINGS} more warnings`);
            break;
        }
        warnings.push(`Line ${warn.line}: ${warn.message}`);
    }

    // 6. Auto-process channels
    await progressCallback?.({
        phase: 'processing',
        processed: 0,
        total: parseResult.channels.length,
        message: 'Auto-processing channels...',
    });
    // Bouquets the stored lineup hides stay categories, so they stay hidden.
    const hiddenCategories = new Set(
        parseLineupFilter(await getSourceLineupFilter(sql, sourceId))?.hiddenCategories,
    );
    const processed = processChannels(parseResult.channels, {
        keepCategories: hiddenCategories,
    });

    // 7. Delete existing channels for this source (re-import is destructive)
    await progressCallback?.({
        phase: 'clearing',
        processed: 0,
        total: 1,
        message: 'Clearing existing channels...',
    });

    // 8. Build bulk import data. The total is the live channels that get saved:
    // a large Xtream playlist is mostly VOD (148k entries, 12.6k channels on a
    // prod source), and counting against all entries made the bar look stuck.
    await progressCallback?.({
        phase: 'persisting',
        processed: 0,
        total: processed.channels.length - processed.vodCount,
        message:
            `Saving ${processed.channels.length - processed.vodCount} channels ` +
            `(${processed.vodCount - processed.separatorCount} VOD entries and ` +
            `${processed.separatorCount} section headers skipped)...`,
    });

    const categoryMap = new Map<string, string>();
    const categories: BulkImportData['categories'] = [];

    // Look up existing categories by name to avoid creating duplicates
    const categoryNames = processed.categories.map((c) => c.normalizedName);
    const existingCategories =
        categoryNames.length > 0
            ? await sql<
                  Array<{ id: string; name: string }>
              >`SELECT id, name FROM livetv_categories WHERE name = ANY(${categoryNames})`
            : [];
    const existingByName = new Map(existingCategories.map((c) => [c.name, c.id]));

    for (const cat of processed.categories) {
        if (categoryMap.has(cat.normalizedName)) continue;
        const existing = existingByName.get(cat.normalizedName);
        if (existing) {
            categoryMap.set(cat.normalizedName, existing);
        } else {
            const id = randomUUID();
            categoryMap.set(cat.normalizedName, id);
            categories.push({ id, name: cat.normalizedName });
        }
    }

    const backupGroupMap = new Map<string, string>();
    const backupGroups: BulkImportData['backupGroups'] = [];
    for (const group of processed.backupGroups) {
        const id = randomUUID();
        backupGroupMap.set(group.key, id);
        backupGroups.push({
            id,
            name: group.name,
            sourceId,
        });
    }

    // Build a map from original processed.channels index to channel UUID
    // so backup group primaryIndex (which references the pre-filter array) resolves correctly
    const originalIndexToId = new Map<number, string>();
    let sortOrder = 0;
    const channels: CreateChannelData[] = [];
    for (let i = 0; i < processed.channels.length; i++) {
        const ch = processed.channels[i];
        if (ch.isVod) continue;
        const id = randomUUID();
        originalIndexToId.set(i, id);
        // sort_order and playlist_index both start as the non-VOD M3U position.
        // sort_order may later be recomputed by the setup wizard; playlist_index
        // is the immutable record of the source order.
        const playlistIndex = sortOrder++;
        channels.push({
            id,
            name: ch.original.name,
            streamUrl: ch.original.streamUrl,
            sourceId,
            logoUrl: ch.original.logoUrl,
            qualityTier: ch.qualityTier,
            epgChannelId: ch.original.tvgId,
            categoryId: categoryMap.get(ch.category),
            backupGroupId: ch.backupGroupKey ? backupGroupMap.get(ch.backupGroupKey) : undefined,
            sortOrder: playlistIndex,
            playlistIndex,
            countryCode: ch.region,
        });
    }

    // Set primary channel IDs on backup groups using the original index mapping
    for (const group of processed.backupGroups) {
        const bgId = backupGroupMap.get(group.key);
        const bg = backupGroups.find((b) => b.id === bgId);
        if (bg && group.primaryIndex >= 0) {
            const primaryChannelId = originalIndexToId.get(group.primaryIndex);
            if (primaryChannelId) {
                bg.primaryChannelId = primaryChannelId;
            }
        }
    }

    // 9. Delete, bulk insert and the stored Configure Lineup in ONE
    // transaction. The new channels are all visible until the filter runs; a
    // reader (or a stream request, gated on visibility) must never see them in
    // that state, and a lineup that fails to apply must not leave the source
    // unfiltered. A failure rolls the whole re-import back (old channels stay).
    // bulkCreateChannels detects whether it's inside a transaction and uses
    // .savepoint() instead of .begin() to avoid nesting errors.
    const { bulkResult, lineup } = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // The new rows get new ids; the channel numbers viewers know follow
        // their channels over (matched like a refresh), see channel-numbers.service.
        // The numbers lock comes FIRST: a lineup read numbering channels while
        // holding it waits on the rows this transaction deletes, so taking it
        // after the delete would deadlock; it also keeps the snapshot current.
        await lockChannelNumbers(tx);
        const numberSnapshot = await snapshotSourceNumbers(tx, sourceId);
        const favorites = await snapshotSourceFavorites(tx, sourceId);
        await deleteChannelsBySourceId(tx, sourceId);
        const created = await bulkCreateChannels(tx, {
            channels,
            categories,
            backupGroups,
        });
        if (numberSnapshot || favorites) {
            const groupOf = new Map(channels.map((ch) => [ch.id, ch.backupGroupId ?? null]));
            const imported: ImportedChannel[] = [];
            for (const [index, id] of originalIndexToId) {
                imported.push({
                    processed: processed.channels[index],
                    id,
                    backupGroupId: groupOf.get(id) ?? null,
                });
            }
            if (numberSnapshot) await carryOverChannelNumbers(tx, numberSnapshot, imported);
            if (favorites) await carryOverSourceFavorites(tx, favorites, imported);
        }
        // The replaced channels' backup groups are now unused; drop them (after the
        // number carry-over, which still reads the old group ids).
        await deleteUnusedBackupGroupsOfSource(tx, sourceId);
        // A re-import replaces every channel, all visible and in playlist
        // order; apply the source's stored Configure Lineup choices again so
        // the countries, 24/7 channels and categories the admin removed stay
        // removed. A source never configured keeps everything visible.
        return {
            bulkResult: created,
            lineup: await reapplyStoredLineup(tx, sourceId, created.channelCount),
        };
    });

    // 9a. A playlist logo on one quality of a station covers its other feeds.
    await shareBackupGroupLogos(sql, sourceId);

    // 9a'. Categories the replaced channels used and the new ones do not.
    await purgeEmptyCategories(sql);

    // 10. Update refresh status
    const summary = {
        channelCount: bulkResult.channelCount,
        categoryCount: bulkResult.categoryCount,
        backupGroupCount: bulkResult.backupGroupCount,
        parseErrors: parseResult.errors.length,
        parseWarnings: parseResult.warnings.length,
        vodFiltered: processed.vodCount - processed.separatorCount,
        separatorsFiltered: processed.separatorCount,
        ...(lineup.result && {
            lineupVisible: lineup.result.visibleChannels,
            lineupHidden: lineup.result.hiddenChannels,
        }),
        warnings,
    };
    await updateRefreshStatus(sql, sourceId, 'success', summary);

    await progressCallback?.({
        phase: 'complete',
        processed: bulkResult.channelCount,
        total: bulkResult.channelCount,
        message: 'Import complete',
    });

    // Invalidate content caches after channel import
    if (bulkResult.channelCount > 0) {
        try {
            const { cacheInvalidation } = await import('$lib/server/cache');
            await cacheInvalidation.onContentAdded(['livetv-import']);
        } catch (e) {
            logger.warn(
                'Cache invalidation failed after channel import — caches will expire on TTL',
                { error: e },
            );
        }
    }

    logger.info('M3U import complete', {
        sourceId,
        channelCount: bulkResult.channelCount,
        duration: Date.now() - startTime,
    });

    return {
        sourceId,
        sourceName: source.name,
        channelCount: bulkResult.channelCount,
        backupGroupCount: bulkResult.backupGroupCount,
        categoryCount: bulkResult.categoryCount,
        epgMatchCount: 0,
        programCount: 0,
        errors,
        warnings,
        notes: [],
        duration: Date.now() - startTime,
    };
}

/**
 * Run the stored Configure Lineup setup on a freshly imported source, on the
 * import's transaction. A source that was never configured keeps everything
 * visible. A failure propagates so the whole re-import rolls back.
 */
async function reapplyStoredLineup(
    tx: postgres.Sql,
    sourceId: string,
    channelCount: number,
): Promise<{ result?: SetupResult }> {
    if (channelCount === 0) return {};
    const stored = await getSourceLineupFilter(tx, sourceId);
    const filter = parseLineupFilter(stored);
    if (!filter) return {};
    const s = stored as Record<string, unknown>;
    // Switches the stored filter never had stay unset (see applySetupPreferences).
    const { hideInfoChannels, hideEventSlots, hideLocalStations, hideRadio, ...rest } = filter;
    const switches = { hideInfoChannels, hideEventSlots, hideLocalStations, hideRadio };
    const result = await applySetupPreferences(tx, {
        sourceId,
        ...rest,
        ...Object.fromEntries(
            Object.entries(switches).filter(([key]) => typeof s[key] === 'boolean'),
        ),
        channelOrder: s.channelOrder === 'sports-first' ? 'sports-first' : 'traditional',
        preferHighQuality: s.preferHighQuality !== false,
    });
    logger.info('Reapplied stored lineup after import', {
        sourceId,
        visible: result.visibleChannels,
        hidden: result.hiddenChannels,
    });
    return { result };
}

// ── EPG Import ───────────────────────────────────────────────────────────

export async function importEpgSource(
    sql: postgres.Sql,
    sourceId: string,
    progressCallback?: ProgressCallback,
    waitForLock = false,
): Promise<ImportResult> {
    const lockKey = `lock:livetv-source-write:${sourceId}`;
    const lockValue = waitForLock
        ? await waitForSourceWriteLock(sourceId, progressCallback)
        : await acquireLock(lockKey, LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS);
    if (!lockValue) throw new Error(m.livetv_admin_source_busy());
    try {
        return await importEpgSourceInner(sql, sourceId, progressCallback);
    } catch (error) {
        if (isLiveTvImportCancelled(error)) throw error;
        await updateEpgRefreshStatus(sql, sourceId, 'failed', {
            error: redactLiveTvUrlsInText(String(error)),
        }).catch((statusError: unknown) => {
            logger.warn('Could not record failed EPG import status', {
                sourceId,
                error: redactLiveTvUrlsInText(String(statusError)),
            });
        });
        throw error;
    } finally {
        await releaseLock(lockKey, lockValue);
    }
}

async function importEpgSourceInner(
    sql: postgres.Sql,
    sourceId: string,
    progressCallback?: ProgressCallback,
): Promise<ImportResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];

    // 1. Load source with credentials
    const source = await getSourceByIdWithCredentials(sql, sourceId);
    if (!source) throw new Error(`Source not found: ${sourceId}`);
    if (!source.xmltv_url) throw new Error(`Source ${sourceId} has no XMLTV URL`);

    logger.info('Starting EPG import', { sourceId, sourceName: source.name });

    // 2. Report phase: fetching
    await progressCallback?.({
        phase: 'fetching',
        processed: 0,
        total: 1,
        message: 'Fetching XMLTV content...',
    });

    // 3-4. SSRF validate + fetch the XMLTV content (see fetch-source.ts)
    const content = await fetchSsrfValidatedText(source.xmltv_url, {
        sourceId,
        logger,
        contentLabel: 'XMLTV',
        fetchFailLogMessage: 'XMLTV fetch failed',
        maxBytes: XMLTV_MAX_FETCH_BYTES,
    });

    // 5. Parse XMLTV
    await progressCallback?.({
        phase: 'parsing',
        processed: 0,
        total: 1,
        message: 'Parsing XMLTV content...',
    });
    const epgData = parseXmltv(content);

    for (const err of epgData.errors) {
        errors.push(`EPG parse error ${err.element}: ${err.reason}`);
    }

    // Routine guide noise is summarised as notes, one line per kind. None of it
    // is something the operator can act on, so it must not keep an attention
    // item open: duplicate channel ids (one id per HD/SD/regional feed, thousands
    // in a large guide), descriptions cut at the length limit, and programmes
    // with a zero or inverted time range that the parser skipped.
    const noiseCounts = new Map<XmltvWarningKind, number>();
    const otherEpgWarnings = epgData.warnings.filter((w) => {
        if (!w.kind) return true;
        noiseCounts.set(w.kind, (noiseCounts.get(w.kind) ?? 0) + 1);
        return false;
    });
    const countOf = (kind: XmltvWarningKind) => noiseCounts.get(kind) ?? 0;
    const duplicateChannelIds = countOf('duplicate-channel-id');
    const truncatedDescriptions = countOf('description-truncated');
    const skippedZeroDuration = countOf('zero-duration');
    const skippedInvertedRange = countOf('inverted-range');
    if (duplicateChannelIds > 0) {
        notes.push(
            `EPG: ${duplicateChannelIds} guide channel${duplicateChannelIds === 1 ? '' : 's'} ${duplicateChannelIds === 1 ? 'reuses' : 'reuse'} another channel's ID`,
        );
    }
    if (truncatedDescriptions > 0) {
        notes.push(
            `EPG: Truncated ${truncatedDescriptions} long programme description${truncatedDescriptions === 1 ? '' : 's'}`,
        );
    }
    if (skippedZeroDuration > 0) {
        notes.push(
            `EPG: Skipped ${skippedZeroDuration} programme${skippedZeroDuration === 1 ? '' : 's'} with a zero-length time range`,
        );
    }
    if (skippedInvertedRange > 0) {
        notes.push(
            `EPG: Skipped ${skippedInvertedRange} programme${skippedInvertedRange === 1 ? '' : 's'} whose end is before their start`,
        );
    }

    // Real parse problems (cap at 100 to avoid JSONB bloat).
    const MAX_WARNINGS = 100;
    for (const [i, warn] of otherEpgWarnings.entries()) {
        if (warnings.length >= MAX_WARNINGS) {
            warnings.push(`... and ${otherEpgWarnings.length - i} more warnings`);
            break;
        }
        warnings.push(`EPG: ${warn.message}`);
    }

    // 6. Get channels for this source from DB
    await progressCallback?.({
        phase: 'matching',
        processed: 0,
        total: 1,
        message: 'Matching EPG to channels...',
    });
    const dbChannels = await getChannelsBySourceId(sql, sourceId);

    // matchEpgChannelsAsync expects ProcessedChannel[] — build minimal wrappers from DB rows
    // The matcher uses channel.original.name and channel.original.tvgId for matching
    const processedForMatching = dbChannels.map((ch) => ({
        original: {
            name: ch.name,
            streamUrl: ch.stream_url,
            tvgId: ch.epg_channel_id ?? undefined,
            tvgName: undefined as string | undefined,
            logoUrl: ch.logo_url ?? undefined,
            groupTitle: undefined as string | undefined,
            countryCode: undefined as string | undefined,
            extras: {},
        },
        qualityTier: (ch.quality_tier as 'uhd' | 'fhd' | 'hd' | 'sd' | null) ?? undefined,
        baseName: ch.name,
        category: '',
        // The matcher copies a guide match to the other feeds of a backup
        // group (Stage 4); without the group only one quality of a station got
        // the guide and its logo.
        backupGroupKey: ch.backup_group_id ?? undefined,
        isPrimary: false,
        isVod: false,
        regionalVariant: undefined as
            { countryCode: string; baseName: string; isRegionalOnly: boolean } | undefined,
        // The matcher prefers the guide entry of the channel's own country
        // (several countries' feeds of one station share a name).
        region: ch.country_code ?? undefined,
    }));

    // 7. Match EPG to channels
    let lastMatchProgressAt = 0;
    // Async: a large source (12k+ channels) takes long enough that a blocking
    // match starved the event loop and the worker was killed by its liveness
    // probe. This yields between chunks and shows admins how far it got.
    const matchResult = await matchEpgChannelsAsync(
        processedForMatching,
        epgData,
        async ({ processed, total }) => {
            // The matcher yields every ~50 ms; one progress write per second
            // is plenty (the callback also carries the cancel check).
            const now = Date.now();
            if (now - lastMatchProgressAt < 1000) return;
            lastMatchProgressAt = now;
            await progressCallback?.({
                phase: 'matching',
                processed,
                total,
                message: `Matching EPG to channels (${processed} / ${total})...`,
            });
        },
    );

    const visibleCount = dbChannels.filter((ch) => ch.is_visible).length;
    const visibleMatched = new Set(
        matchResult.matches
            .filter((match) => dbChannels[match.channelIndex]?.is_visible)
            .map((match) => match.channelIndex),
    ).size;
    if (visibleCount > 0 && (visibleMatched === 0 || visibleMatched / visibleCount < 0.05)) {
        warnings.push(
            m.livetv_admin_epg_low_matches({
                matched: visibleMatched,
                total: visibleCount,
            }),
        );
    }

    logger.info('EPG match complete', {
        sourceId,
        matched: matchResult.stats.matched,
        unmatched: matchResult.stats.unmatched,
    });

    // 7b–8. Persist EPG channel upserts and programs atomically
    await progressCallback?.({
        phase: 'persisting',
        processed: 0,
        total: epgData.programs.length,
        message: 'Saving programs to database...',
    });

    let programCount = 0;
    let duplicateProgramsDropped = 0;
    let duplicateScheduleChannels = 0;

    if (matchResult.matches.length > 0) {
        const epgChannelRows =
            epgData.channels.length > 0
                ? [
                      ...new Map(
                          epgData.channels.map((ch) => [
                              ch.id,
                              {
                                  id: ch.id,
                                  source_id: sourceId,
                                  display_name: ch.displayName,
                                  icon_url: ch.iconUrl ?? null,
                              },
                          ]),
                      ).values(),
                  ]
                : [];

        // Index programmes by XMLTV channel id once — a linear scan per match
        // is O(matches × programs), which is minutes of CPU on a 30k-programme
        // feed with 250 matched channels.
        const programsByEpgChannel = new Map<string, typeof epgData.programs>();
        for (const p of epgData.programs) {
            const bucket = programsByEpgChannel.get(p.channelId);
            if (bucket) bucket.push(p);
            else programsByEpgChannel.set(p.channelId, [p]);
        }

        const rawProgramRows = matchResult.matches.flatMap((match) => {
            const dbChannel = dbChannels[match.channelIndex];
            if (!dbChannel) return [];

            return (programsByEpgChannel.get(match.epgChannelId) ?? []).map((p) => ({
                channel_id: dbChannel.id,
                title: p.title,
                description: p.description ?? null,
                start_time: p.startTime,
                end_time: p.endTime,
                // Provenance: which XMLTV channel this listing came from. Lets an
                // operator (and the API) tell which feed produced an entry.
                epg_id: match.epgChannelId,
                genres: p.genres.length > 0 ? sql.array(p.genres) : null,
                official_rating: p.officialRating ?? null,
            }));
        });

        // A channel airs one thing at a time. Aggregator feeds routinely reuse a
        // single tvg-id for several channel variants and concatenate all of their
        // schedules under it, so a correct 1:1 channel match still yields N
        // parallel, time-shifted schedules. Collapse to one before persisting —
        // see epg-schedule.ts for why title-based dedupe cannot work here.
        const collapsed = collapseByChannel(
            rawProgramRows,
            (row) => row.channel_id,
            (row) => ({
                start: Date.parse(row.start_time),
                end: Date.parse(row.end_time),
            }),
        );
        // Stamp each surviving programme with its natural-key id. Done AFTER the
        // collapse on purpose: collapseByChannel has already discarded entries
        // with an unparseable or zero-length range, so programUuid() can't throw
        // here and one malformed listing can't take the whole import down.
        const identified = collapsed.kept.map((row) => ({
            id: programUuid(row.channel_id, row.start_time),
            ...row,
        }));

        // A channel airs one thing at a time and the collapse enforces it, so
        // these ids are unique by construction. `id` is the primary key, though,
        // and a collision would abort the entire import transaction rather than
        // lose one row — cheap insurance, and it reports rather than hides.
        const byId = new Map<string, (typeof identified)[number]>();
        for (const row of identified) {
            if (!byId.has(row.id)) byId.set(row.id, row);
        }
        const programRows = [...byId.values()];
        if (programRows.length < identified.length) {
            const collisions = identified.length - programRows.length;
            const message =
                `EPG: dropped ${collisions} programme(s) sharing a channel and start time — ` +
                `the schedule collapse should have made this impossible, so the feed or ` +
                `the collapse deserves a look`;
            warnings.push(message);
            logger.warn('Programme id collision after collapse', { sourceId, collisions });
        }

        if (collapsed.droppedCount > 0) {
            const message =
                `EPG: dropped ${collapsed.droppedCount} duplicate programme(s) across ` +
                `${collapsed.channelsAffected} channel(s) — the feed carries parallel ` +
                `schedules for the same channel (one tvg-id reused for several variants)`;
            notes.push(message);
            logger.warn('Collapsed parallel EPG schedules', {
                sourceId,
                dropped: collapsed.droppedCount,
                channelsAffected: collapsed.channelsAffected,
                kept: programRows.length,
            });
        }

        const channelIds = dbChannels.map((ch) => ch.id);

        await withTx(sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;

            await tx`SELECT id FROM livetv_sources WHERE id = ${sourceId} FOR UPDATE`;
            const current = await getSourceByIdWithCredentials(tx, sourceId);
            if (!current || current.xmltv_url !== source.xmltv_url)
                throw new LiveTvImportCancelledError();

            // 7b. Upsert XMLTV channel records
            if (epgChannelRows.length > 0) {
                const CHUNK_SIZE = 500;
                for (let i = 0; i < epgChannelRows.length; i += CHUNK_SIZE) {
                    const chunk = epgChannelRows.slice(i, i + CHUNK_SIZE);
                    await tx`
						INSERT INTO livetv_epg_channels ${tx(chunk, 'id', 'source_id', 'display_name', 'icon_url')}
						ON CONFLICT (id, source_id) DO UPDATE SET
							display_name = EXCLUDED.display_name,
							icon_url = EXCLUDED.icon_url
					`;
                }
                logger.info('Persisted XMLTV channels', {
                    sourceId,
                    count: epgChannelRows.length,
                });
            }

            // 7c. Persist match metadata on livetv_channels
            // Skip channels where epg_manual_override = true (admin's chosen match preserved)
            const matchUpdates = matchResult.matches
                .map((match) => {
                    const dbChannel = dbChannels[match.channelIndex];
                    return {
                        id: dbChannel?.id,
                        confidence: match.confidence,
                        signals: match.signals,
                    };
                })
                .filter((u) => u.id !== undefined);

            if (matchUpdates.length > 0) {
                const ids = matchUpdates.map((u) => u.id);
                const confidences = matchUpdates.map((u) => u.confidence);
                const signalStrings = matchUpdates.map((u) => u.signals.join(','));

                await tx`
					UPDATE livetv_channels SET
						epg_match_confidence = data.confidence,
						epg_match_signals = string_to_array(data.signals, ','),
						updated_at = NOW()
					FROM unnest(
						${ids}::uuid[],
						${confidences}::numeric[],
						${signalStrings}::text[]
					) AS data(id, confidence, signals)
					WHERE livetv_channels.id = data.id
					  AND (livetv_channels.epg_manual_override IS NOT TRUE)
				`;

                logger.info('Persisted EPG match metadata', {
                    sourceId,
                    count: matchUpdates.length,
                });
            }

            // 7d. Logo fallback: a channel the playlist gave no logo (a bare
            // Xtream playlist has no tvg-logo at all) takes its matched guide
            // channel's icon. Only empty logos are filled, so a playlist logo
            // or one set earlier is never replaced; a later M3U refresh that
            // brings a tvg-logo overwrites it as usual. A fill is never revisited,
            // so only confident matches qualify, admin-overridden matches are
            // left alone, and only http(s) icons are taken (the guide feed is
            // untrusted and the image proxy fetches whatever is stored).
            const iconByEpgId = new Map<string, string>();
            for (const ch of epgData.channels) {
                const icon = ch.iconUrl?.trim();
                if (icon && /^https?:\/\//i.test(icon)) iconByEpgId.set(ch.id, icon);
            }
            const fillById = new Map<string, string>();
            for (const match of matchResult.matches) {
                if (match.confidence < LOGO_FILL_MIN_CONFIDENCE) continue;
                const dbChannel = dbChannels[match.channelIndex];
                const icon = iconByEpgId.get(match.epgChannelId);
                if (!dbChannel || !icon || dbChannel.logo_url?.trim()) continue;
                if (!fillById.has(dbChannel.id)) fillById.set(dbChannel.id, icon);
            }
            const logoFills = [...fillById];
            let logosFilled = 0;
            for (let i = 0; i < logoFills.length; i += LOGO_FILL_CHUNK) {
                const chunk = logoFills.slice(i, i + LOGO_FILL_CHUNK);
                const filled = await tx`
					UPDATE media_items mi SET custom_poster_url = data.icon, updated_at = NOW()
					FROM unnest(
						${chunk.map(([id]) => id)}::uuid[],
						${chunk.map(([, icon]) => icon)}::text[]
					) AS data(id, icon)
					WHERE mi.id = data.id
					  AND (mi.custom_poster_url IS NULL OR btrim(mi.custom_poster_url) = '')
					  AND NOT EXISTS (
					      SELECT 1 FROM livetv_channels lc
					       WHERE lc.id = mi.id AND lc.epg_manual_override IS TRUE
					  )
				`;
                logosFilled += filled.count ?? 0;
            }
            if (logoFills.length > 0) {
                logger.info('Filled channel logos from the guide', {
                    sourceId,
                    candidates: logoFills.length,
                    filled: logosFilled,
                });
            }

            // 7e. The other qualities of a station take the logo too.
            const groupLogos = await shareBackupGroupLogos(tx, sourceId);
            if (groupLogos > 0)
                logger.info('Shared logos within backup groups', { sourceId, filled: groupLogos });

            // 8. Delete stale programs and insert new ones
            if (programRows.length > 0) {
                if (channelIds.length > 0) {
                    await tx`DELETE FROM livetv_programs WHERE channel_id = ANY(${tx.array(channelIds)}::uuid[])`;
                }
                // 9 columns per row → max ~7000 rows per batch to stay under 65534 param limit
                const PROGRAM_CHUNK = 7000;
                for (let i = 0; i < programRows.length; i += PROGRAM_CHUNK) {
                    const chunk = programRows.slice(i, i + PROGRAM_CHUNK);
                    await tx`
						INSERT INTO livetv_programs ${tx(chunk, 'id', 'channel_id', 'title', 'description', 'start_time', 'end_time', 'epg_id', 'genres', 'official_rating')}
					`;
                }
            }
        });

        programCount = programRows.length;
        duplicateProgramsDropped = collapsed.droppedCount;
        duplicateScheduleChannels = collapsed.channelsAffected;
    }

    // 9. Update refresh status
    const summary = {
        channelCount: dbChannels.length,
        epgMatchCount: matchResult.stats.matched,
        unmatchedCount: matchResult.stats.unmatched,
        programCount,
        duplicateProgramsDropped,
        duplicateScheduleChannels,
        parseErrors: epgData.errors.length,
        parseWarnings: epgData.warnings.length,
        duplicateChannelIds,
        truncatedDescriptions,
        skippedZeroDuration,
        skippedInvertedRange,
        warnings,
        notes,
    };
    // With no channels the EPG had nothing to attach to. Leave the status the
    // M3U import set (e.g. 'failed') instead of reporting a success.
    if (dbChannels.length > 0) {
        await updateEpgRefreshStatus(sql, sourceId, 'success', summary);
    } else {
        logger.warn('EPG import found no channels for source; status left unchanged', {
            sourceId,
        });
    }

    await progressCallback?.({
        phase: 'complete',
        processed: programCount,
        total: epgData.programs.length,
        message: 'EPG import complete',
    });

    logger.info('EPG import complete', {
        sourceId,
        programCount,
        duration: Date.now() - startTime,
    });

    return {
        sourceId,
        sourceName: source.name,
        channelCount: dbChannels.length,
        backupGroupCount: 0,
        categoryCount: 0,
        epgMatchCount: matchResult.stats.matched,
        programCount,
        errors,
        warnings,
        notes,
        duration: Date.now() - startTime,
    };
}
