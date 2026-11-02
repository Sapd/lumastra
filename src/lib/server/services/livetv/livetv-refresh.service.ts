// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV Refresh Service — Smart Diffing Orchestrator
 *
 * Refreshes M3U/XMLTV sources using channel identity matching to preserve
 * admin customizations while absorbing provider-side changes.
 *
 * @module services/livetv/livetv-refresh
 */

import {
    LIVETV_SOURCE_WRITE_LOCK_TTL_SECONDS,
    waitForSourceWriteLock,
} from './source-write-lock.js';
import { randomUUID } from 'node:crypto';
import { withTx } from '$lib/server/database/with-tx.js';
import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
import { acquireLock, releaseLock } from '$lib/server/cache/valkey.js';
import { fetchSsrfValidatedText, M3U_MAX_FETCH_BYTES } from './fetch-source.js';
import { parseM3uAsync } from './m3u-parser.js';
import { processChannels } from './auto-processor.js';
import { matchChannels, type ExistingChannel } from './channel-matcher.js';
import {
    getSourceByIdWithCredentials,
    updateRefreshStatus,
} from '$lib/server/database/queries/livetv-sources.queries.js';
import {
    getChannelsForRefresh,
    updateMatchedChannels,
    bulkUpdateChannelAbsences,
    archiveStaleChannels,
    bulkCreateChannels,
    purgeArchivedChannels,
    purgeEmptyCategories,
    shareBackupGroupLogos,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import type {
    MatchedChannelUpdate,
    BulkImportData,
    CreateChannelData,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import type { ProgressCallback } from './livetv-import.service.js';
import {
    bulkUpdateChannelVisibility,
    getChannelsForSetup,
    getSourceLineupFilter,
} from '$lib/server/database/queries/livetv-setup.queries.js';
import { isChannelKept, parseLineupFilter } from './lineup-filter.js';
import { classifyLineup, noiseKindsOf } from './lineup-noise.js';

const logger = Logger.for('LiveTvRefresh');

// ── Types ──────────────────────────────────────────────────────────────

export interface RefreshResult {
    sourceId: string;
    sourceName: string;
    matched: number;
    newChannels: number;
    removedChannels: number;
    urlChanges: number;
    archivedChannels: number;
    /** Channels deleted after PURGE_AFTER_ABSENCES refreshes without them. */
    deletedChannels: number;
    /** New channels hidden by the source's stored Configure Lineup choices. */
    lineupHidden: number;
    flaggedForReview: number;
    massRestructure: boolean;
    errors: string[];
    duration: number;
}

// ── M3U Refresh ────────────────────────────────────────────────────────

/**
 * Refreshes in a row without a channel before it is deleted (about a week at
 * the default 12-hour refresh). It is hidden after three; the gap keeps a
 * provider's passing outage from erasing favourites, renames and the order.
 */
export const PURGE_AFTER_ABSENCES = 14;

export async function refreshM3uSource(
    sql: postgres.Sql,
    sourceId: string,
    progressCallback?: ProgressCallback,
    waitForLock = false,
): Promise<RefreshResult> {
    // Guard against empty / whitespace-only sourceId — matches the guard
    // in importM3uSource. Without this, the lock key collapses to a
    // single global slot and starves every empty-source caller.
    if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
        throw new Error('refreshM3uSource: sourceId is required');
    }
    // Cross-replica defensive lock — shared with importM3uSource. Both
    // operations mutate the same livetv_channels / media_items rows for a
    // given source and deadlock at the PG row-lock level if they overlap.
    // Acquire a Valkey SET NX EX mutex on the same key importM3uSource uses
    // ('lock:livetv-source-write:<sourceId>'). The `lock:` prefix is REQUIRED:
    // it routes the key to the noeviction coordination instance (pickClient) —
    // without it the key lands on the evictable cache instance and can be
    // dropped mid-write, releasing the mutex early — AND it must byte-for-byte
    // match livetv-import.service.ts or the two writers won't mutually exclude.
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
        return await refreshM3uSourceInner(sql, sourceId, progressCallback);
    } finally {
        await releaseLock(lockKey, lockValue);
    }
}

async function refreshM3uSourceInner(
    sql: postgres.Sql,
    sourceId: string,
    progressCallback?: ProgressCallback,
): Promise<RefreshResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // 1. Load source with credentials
    const source = await getSourceByIdWithCredentials(sql, sourceId);
    if (!source) throw new Error(`Source not found: ${sourceId}`);
    if (!source.m3u_url) throw new Error(`Source ${sourceId} has no M3U URL`);

    logger.info('Starting M3U refresh', { sourceId, sourceName: source.name });

    try {
        // 2. Fetch M3U content (SSRF-validated)
        await progressCallback?.({
            phase: 'fetching',
            processed: 0,
            total: 1,
            message: 'Fetching M3U content...',
        });

        const content = await fetchSsrfValidatedText(source.m3u_url, {
            sourceId,
            logger,
            contentLabel: 'M3U',
            fetchFailLogMessage: 'M3U refresh fetch failed',
            maxBytes: M3U_MAX_FETCH_BYTES,
        });

        // 3. Parse M3U
        await progressCallback?.({
            phase: 'parsing',
            processed: 0,
            total: 1,
            message: 'Parsing M3U content...',
        });
        const parseResult = await parseM3uAsync(content);

        if (parseResult.channels.length === 0) {
            throw new Error('M3U refresh parsed zero channels');
        }

        for (const err of parseResult.errors) {
            errors.push(`Parse error line ${err.line}: ${err.reason}`);
        }

        // 4. Auto-process channels
        await progressCallback?.({
            phase: 'processing',
            processed: 0,
            total: parseResult.channels.length,
            message: 'Auto-processing channels...',
        });
        // Read once: bouquets the stored lineup hides stay categories (so
        // they stay hidden), and new channels get the same choices below.
        const lineupFilter = parseLineupFilter(await getSourceLineupFilter(sql, sourceId));
        const processed = processChannels(parseResult.channels, {
            keepCategories: new Set(lineupFilter?.hiddenCategories),
        });

        // 5. Load existing channels from DB
        await progressCallback?.({
            phase: 'matching',
            processed: 0,
            total: 1,
            message: 'Matching channels...',
        });
        const dbChannels = await getChannelsForRefresh(sql, sourceId);

        // Convert DB rows to ExistingChannel for matcher
        const existingChannels: ExistingChannel[] = dbChannels.map((ch) => ({
            id: ch.id,
            name: ch.name,
            streamUrl: ch.stream_url,
            epgChannelId: ch.epg_channel_id ?? undefined,
            qualityTier: ch.quality_tier ?? undefined,
            categoryId: ch.category_id ?? undefined,
            categoryName: ch.category_name ?? undefined,
            backupGroupId: ch.backup_group_id ?? undefined,
            sortOrder: ch.sort_order,
            isVisible: ch.is_visible,
            adminDisplayName: undefined, // Already resolved in getChannelsForRefresh (COALESCE)
            countryCode: ch.country_code ?? undefined,
            consecutiveAbsences: ch.consecutive_absences,
        }));

        // 6. Run channel matcher (pure function, no DB)
        const nonVodChannels = processed.channels.filter((ch) => !ch.isVod);
        const matchResult = matchChannels(existingChannels, nonVodChannels);

        // Position of each parsed channel in the source M3U (non-VOD sequence).
        // Used to keep playlist_index current for matched channels and to give
        // newly-inserted channels their real source slot instead of appending.
        const playlistIndexByChannel = new Map(nonVodChannels.map((ch, i) => [ch, i]));

        logger.info('Channel matching complete', {
            sourceId,
            autoMatched: matchResult.stats.autoMatched,
            reviewMatched: matchResult.stats.reviewMatched,
            newCount: matchResult.stats.newCount,
            removedCount: matchResult.stats.removedCount,
            massRestructure: matchResult.massRestructure,
        });

        // 7. Apply diff within a transaction
        await progressCallback?.({
            phase: 'applying',
            processed: 0,
            total: matchResult.matched.length + matchResult.newChannels.length,
            message: 'Applying changes...',
        });

        let archivedCount = 0;
        let deletedCount = 0;
        let lineupHiddenCount = 0;

        await withTx(sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;

            // 7a. Update matched channels (preserve admin customizations)
            if (matchResult.matched.length > 0) {
                const updates: MatchedChannelUpdate[] = matchResult.matched.map((m) => ({
                    id: m.existingChannel.id,
                    streamUrl:
                        m.newChannel.original.streamUrl !== m.existingChannel.streamUrl
                            ? m.newChannel.original.streamUrl
                            : null,
                    epgChannelId:
                        m.newChannel.original.tvgId !== m.existingChannel.epgChannelId
                            ? (m.newChannel.original.tvgId ?? null)
                            : null,
                    logoUrl: m.newChannel.original.logoUrl ?? null,
                    qualityTier:
                        m.newChannel.qualityTier !== m.existingChannel.qualityTier
                            ? (m.newChannel.qualityTier ?? null)
                            : null,
                    countryCode:
                        m.newChannel.region !== m.existingChannel.countryCode
                            ? (m.newChannel.region ?? null)
                            : null,
                    playlistIndex: playlistIndexByChannel.get(m.newChannel) ?? null,
                }));
                await updateMatchedChannels(tx, updates);
            }

            // 7b. Insert new channels
            if (matchResult.newChannels.length > 0) {
                const categoryMap = new Map<string, string>();
                const categories: BulkImportData['categories'] = [];

                for (const ch of matchResult.newChannels) {
                    if (!categoryMap.has(ch.category)) {
                        const id = randomUUID();
                        categoryMap.set(ch.category, id);
                        categories.push({ id, name: ch.category });
                    }
                }

                let sortOrder =
                    existingChannels.reduce((m, ch) => Math.max(m, ch.sortOrder), 0) + 1;
                const newChannelData: CreateChannelData[] = matchResult.newChannels.map((ch) => ({
                    id: randomUUID(),
                    name: ch.original.name,
                    streamUrl: ch.original.streamUrl,
                    sourceId,
                    logoUrl: ch.original.logoUrl,
                    qualityTier: ch.qualityTier,
                    epgChannelId: ch.original.tvgId,
                    categoryId: categoryMap.get(ch.category),
                    sortOrder: sortOrder++,
                    playlistIndex: playlistIndexByChannel.get(ch),
                    countryCode: ch.region,
                }));

                // Persist backup groups for the newly-inserted channels. The auto-processor
                // already detected which channels are quality variants of one another (e.g.
                // "EKR Sachsen FHD" + "EKR Sachsen HD"); without this the variants each
                // surface as separate cards in the user-facing grid. We create a group only
                // when ≥2 NEW channels share a backup key — groups that straddle pre-existing
                // channels are left alone, since matched channels retain their backup_group_id
                // across refreshes. (Previously this passed `[]`, dropping all grouping for
                // any source first populated via refresh rather than a manual import.)
                const groupNameByKey = new Map(processed.backupGroups.map((g) => [g.key, g.name]));
                const newIndicesByKey = new Map<string, number[]>();
                matchResult.newChannels.forEach((ch, i) => {
                    if (!ch.backupGroupKey) return;
                    const arr = newIndicesByKey.get(ch.backupGroupKey) ?? [];
                    arr.push(i);
                    newIndicesByKey.set(ch.backupGroupKey, arr);
                });

                const backupGroups: BulkImportData['backupGroups'] = [];
                for (const [key, indices] of newIndicesByKey) {
                    if (indices.length < 2) continue; // singleton among new channels — no group
                    // Only form a group when its detected primary (the highest-quality
                    // variant) is itself one of the new channels. If the primary matched a
                    // pre-existing channel, leave grouping to that channel's existing group
                    // rather than promoting a lower-quality variant or creating a competing
                    // group for the same logical channel. (The straddling case keeps the new
                    // backups ungrouped — matched channels retain their backup_group_id.)
                    const primaryIdx = indices.find((i) => matchResult.newChannels[i].isPrimary);
                    if (primaryIdx === undefined) continue;
                    const groupId = randomUUID();
                    backupGroups.push({
                        id: groupId,
                        name: groupNameByKey.get(key) ?? newChannelData[primaryIdx].name,
                        primaryChannelId: newChannelData[primaryIdx].id,
                        sourceId,
                    });
                    for (const i of indices) {
                        newChannelData[i].backupGroupId = groupId;
                    }
                }

                // Note: bulkCreateChannels internally uses sql.begin() which creates a
                // PostgreSQL savepoint inside our outer transaction — this is correct
                // behavior and allows the function to be used both standalone and nested.
                await bulkCreateChannels(tx, {
                    channels: newChannelData,
                    categories,
                    backupGroups,
                });

                // New channels arrive visible. With stored Configure Lineup
                // choices, hide the ones they would have hidden (a refresh
                // never touches existing channels: those keep any hand edits).
                if (lineupFilter) {
                    // Families and neighbours decide the noise kinds: classify
                    // the whole lineup, new channels included.
                    const noise = classifyLineup(await getChannelsForSetup(tx, sourceId));
                    const newRows = matchResult.newChannels.map((ch, i) => ({
                        id: newChannelData[i].id,
                        title: ch.original.name,
                        country_code: ch.region ?? null,
                        category_name: ch.category,
                    }));
                    const visibility = new Map(
                        newRows.map((row) => [
                            row.id,
                            isChannelKept(row, lineupFilter, noiseKindsOf(noise, row.id)),
                        ]),
                    );
                    const hidden = newRows
                        .filter((row) => !visibility.get(row.id))
                        .map((row) => ({ id: row.id, isVisible: false }));
                    await bulkUpdateChannelVisibility(tx, hidden);
                    lineupHiddenCount = hidden.length;
                }
            }

            // New feeds of a station take its logo (and vice versa).
            await shareBackupGroupLogos(tx, sourceId);

            // 7c. Handle removed channels
            if (matchResult.removedChannels.length > 0 && !matchResult.massRestructure) {
                const absenceUpdates = matchResult.removedChannels.map((ch) => ({
                    id: ch.id,
                    absences: ch.consecutiveAbsences + 1,
                }));
                await bulkUpdateChannelAbsences(tx, absenceUpdates);

                // Archive channels with 3+ absences
                archivedCount = await archiveStaleChannels(tx, sourceId);
                // Gone for good: delete them, and the categories they leave empty.
                deletedCount = await purgeArchivedChannels(tx, null, {
                    sourceId,
                    minAbsences: PURGE_AFTER_ABSENCES,
                });
                if (deletedCount > 0) await purgeEmptyCategories(tx);
            }
            // If mass restructure: DON'T increment absences or hide channels
        });

        // 8. Update refresh status
        const refreshResult: RefreshResult = {
            sourceId,
            sourceName: source.name,
            matched: matchResult.matched.length,
            newChannels: matchResult.newChannels.length,
            removedChannels: matchResult.removedChannels.length,
            urlChanges: matchResult.stats.urlChangedCount,
            archivedChannels: archivedCount,
            deletedChannels: deletedCount,
            lineupHidden: lineupHiddenCount,
            flaggedForReview: matchResult.flaggedForReview.length,
            massRestructure: matchResult.massRestructure,
            errors,
            duration: Date.now() - startTime,
        };

        await updateRefreshStatus(sql, sourceId, 'success', refreshResult);

        await progressCallback?.({
            phase: 'complete',
            processed: matchResult.matched.length + matchResult.newChannels.length,
            total: matchResult.matched.length + matchResult.newChannels.length,
            message: `Refresh complete: ${refreshResult.matched} matched, ${refreshResult.newChannels} new, ${refreshResult.removedChannels} removed`,
        });

        // Invalidate content caches after channel refresh
        if (refreshResult.newChannels > 0 || refreshResult.removedChannels > 0) {
            try {
                const { cacheInvalidation } = await import('$lib/server/cache');
                await cacheInvalidation.onContentAdded(['livetv-refresh']);
            } catch (e) {
                logger.warn(
                    'Cache invalidation failed after channel refresh — caches will expire on TTL',
                    { error: e },
                );
            }
        }

        logger.info('M3U refresh complete', {
            sourceId,
            matched: refreshResult.matched,
            newChannels: refreshResult.newChannels,
            removedChannels: refreshResult.removedChannels,
            duration: refreshResult.duration,
        });

        return refreshResult;
    } catch (error) {
        // Stored summary feeds admin attention alerts — never the raw URL.
        await updateRefreshStatus(sql, sourceId, 'failed', {
            error: redactLiveTvUrlsInText(String(error)),
        });
        throw error;
    }
}

// ── EPG Refresh ────────────────────────────────────────────────────────

/**
 * Refresh EPG data for a source.
 * EPG refresh is simpler — just replaces program data, no identity matching.
 * Reuses the importEpgSource pipeline from the import service.
 */
export { importEpgSource as refreshEpgSource } from './livetv-import.service.js';
