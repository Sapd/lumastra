// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Auto-Identify Personal Media Service
 *
 * Automatically matches unmatched personal media items against metadata providers.
 * Uses a high confidence threshold (0.8) to avoid false matches.
 */

import type { AutoIdentifyResult } from '$lib/schemas/auto-identify.js';
import { getDb } from '$lib/server/database/connection';
import type postgres from 'postgres';
import { listPersonalMediaItems } from '$lib/server/database/queries/media-items.queries';
import { CatalogService } from '$lib/server/services/catalog.service';
import { withTx } from '$lib/server/database/with-tx.js';
import { isPersonalMediaKept } from '$lib/server/database/queries/unmatched-files.queries.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service';
import { Logger } from '$lib/server/utils/logger';
import { isNonEntertainment } from '$lib/server/utils/media-types';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import { parseMediaFilename } from '$lib/server/utils/filename-parser';
import {
    getProvidersByPriority,
    invokeProviderResolveExternalId,
    invokeProviderSearch,
    isProviderConfigured,
} from '$lib/server/tasks/plugin-context';
import { normalizeSearchResult } from '$lib/server/providers/normalize';
import {
    titleSimilarity,
    yearProximity,
} from '$lib/server/providers/implementations/tmdb/normalize';
import type { MetadataCandidate } from '$lib/server/providers/types';

const logger = Logger.for('AutoIdentifyService');

/**
 * Minimum title/year match score (titleSimilarity * yearProximity) required
 * before a fuzzy (Phase 2) candidate may be accepted.
 *
 * Provider "confidence" (e.g. TMDB popularity/100) measures how *popular* a
 * result currently is, not how well its title matches the personal-media
 * item — a back-catalog title long past its theatrical run can sit at
 * popularity ~5-20 indefinitely, while a completely wrong but viral result
 * can hit 90+. Multiplying it into the gate (as this used to do) therefore
 * both rejects correct back-catalog matches AND lets a popular-but-wrong
 * result outrank a correct one. We gate purely on titleSim * yearProximity
 * and use provider confidence only as a tie-breaker between candidates
 * whose title/year match equally well (see Phase 2 below).
 */
const AUTO_IDENTIFY_THRESHOLD = 0.8;
/** Minimum normalized title-similarity required regardless of match score. */
const TITLE_SIMILARITY_FLOOR = 0.6;
const RATE_LIMIT_DELAY_MS = 300;
/**
 * Page size for paginating through personal media items.
 * Allows operator Cancel to interrupt between pages without losing
 * progress on already-processed items.
 */
const PERSONAL_MEDIA_PAGE_SIZE = 1000;

interface AutoMatchCandidate {
    provider: string;
    externalId: string;
    mediaType: 'movie' | 'tv';
    confidence: number;
}

/** Write an auto-match only while the item is still unresolved and not kept. */
async function upsertAutoMatchUnlessKept(
    sql: ReturnType<typeof getDb>,
    mediaId: string,
    candidate: AutoMatchCandidate,
): Promise<boolean> {
    if (!sql) return false;
    const written = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const rows = await tx<{ id: string }[]>`
            SELECT id FROM media_items WHERE id = ${mediaId} AND status='active' AND canonical_id IS NULL AND NOT is_dismissed FOR UPDATE
        `;
        if (rows.length === 0) return false;
        const kept = await tx<{ kept: boolean }[]>`
            SELECT EXISTS (
                SELECT 1 FROM personal_media_dispositions
                WHERE media_id = ${mediaId} AND disposition = 'kept'
            ) AS kept
        `;
        if (kept[0]?.kept === true) return false;
        const identities = await tx<{ media_id: string }[]>`
            SELECT media_id FROM external_ids WHERE media_id = ${mediaId} AND source IS DISTINCT FROM 'watch-sync-file' LIMIT 1
        `;
        if (identities.length > 0) return false;

        return new CatalogService(tx, { skipLifecycleHooks: true }).upsertExternalId(
            mediaId,
            {
                provider: candidate.provider,
                id: candidate.externalId,
                mediaType: candidate.mediaType,
                source: 'auto',
                confidence: candidate.confidence,
            },
            true,
        );
    });
    if (written) {
        MediaLifecycleService.afterExternalIdChanged(mediaId).catch((err: unknown) => {
            logger.error(
                'afterExternalIdChanged lifecycle hook failed',
                err instanceof Error ? err : new Error(String(err)),
                { mediaId, source: 'autoIdentify' },
            );
        });
    }
    return written;
}

/**
 * Extract a 4-digit release year from a TMDB date string (`YYYY-MM-DD`).
 * Returns `undefined` for missing/malformed dates so {@link yearProximity}
 * treats the year as unknown (no penalty) rather than NaN.
 */
function parseTmdbYear(dateStr?: string): number | undefined {
    if (!dateStr) return undefined;
    const year = Number.parseInt(dateStr.slice(0, 4), 10);
    return Number.isNaN(year) ? undefined : year;
}

interface AutoIdentifyOptions {
    onProgress?: (phase: string, matched: number, skipped: number, total: number) => void;
    /**
     * When set, the sweep checks `.aborted` at the top of each item-loop
     * iteration. Wired by the auto-identify task wrapper to ctx.signal so
     * admin Cancel halts the metadata-provider sweep promptly instead of
     * continuing to hit search APIs for thousands of items (RATE_LIMIT
     * delay of 300ms per item compounds the wait).
     */
    signal?: AbortSignal;
    /**
     * Optional DB handle. Task callers pass `ctx.sql` (task pool) so a sweep
     * of thousands of personal-media items can't starve web connections; web
     * callers omit it and fall back to getDb() (web pool). See db pool-split.
     */
    sql?: ReturnType<typeof getDb>;
    /**
     * Restrict the run to these top-level personal-media ids (Fix matches →
     * "Auto-identify selected"). Ids that are not currently unmatched are ignored. No run merges rows.
     */
    mediaItemIds?: readonly string[];
    /**
     * Restrict the run to the unmatched items a filtered Fix-matches list
     * shows (same filters as GET /api/admin/unmatched-files).
     */
    scope?: {
        libraryGroupId?: string;
        mediaType?: 'movie' | 'tv';
        search?: string;
    };
}

export async function processAutoIdentifyPersonalMedia(
    options: AutoIdentifyOptions = {},
): Promise<AutoIdentifyResult> {
    const sql = options.sql ?? getDb();
    if (!sql) {
        return {
            matched: 0,
            skipped: 0,
            failed: 0,
            conflicts: 0,
            conflictItems: [],
            total: 0,
            message: 'Database not available',
        };
    }

    const providers = getProvidersByPriority();
    if (providers.length === 0) {
        return {
            matched: 0,
            skipped: 0,
            failed: 0,
            conflicts: 0,
            conflictItems: [],
            total: 0,
            message: 'No metadata providers available',
        };
    }

    // Identification assigns metadata only. Catalog merges require an explicit
    // named preview and recovery limits, including authoritative ID collisions.
    const targetIds = options.mediaItemIds?.length ? new Set(options.mediaItemIds) : null;
    const scope = options.scope ?? {};

    // Snapshot all unmatched top-level item IDs upfront (before any mutations).
    //
    // We cannot use offset-based pagination here: listPersonalMediaItems filters
    // NOT EXISTS (external_ids), so each matched item falls out of the result set.
    // Incrementing the offset would skip items that shift into the vacated slots.
    // A "restart from offset=0" loop avoids that but infinite-loops on
    // non-entertainment items (which never get matched and never leave the query).
    //
    // Snapshotting IDs solves both problems:
    //   - Each ID is processed exactly once, regardless of match rate.
    //   - Non-entertainment items are identified and counted correctly up front.
    //   - The total count matches what is actually processed (no inflation).
    // Fine for libraries up to hundreds of thousands of items (UUID array ~ few MB).
    const allRows: {
        id: string;
        title: string;
        media_type: string;
        release_year: number | null;
    }[] = [];
    for (let offset = 0; ; offset += PERSONAL_MEDIA_PAGE_SIZE) {
        const page = await listPersonalMediaItems(sql, {
            limit: PERSONAL_MEDIA_PAGE_SIZE,
            offset,
            libraryGroupId: scope.libraryGroupId,
            mediaType: scope.mediaType,
            search: scope.search,
        });
        if (page.length === 0) break;
        for (const r of page) if (!targetIds || targetIds.has(r.id)) allRows.push(r);
        if (page.length < PERSONAL_MEDIA_PAGE_SIZE) break;
    }

    if (allRows.length === 0) {
        return {
            matched: 0,
            skipped: 0,
            failed: 0,
            conflicts: 0,
            conflictItems: [],
            total: 0,
            message: 'No personal media items to identify',
        };
    }

    // Non-entertainment items (home_video, training, educational, personal) are
    // counted in the snapshot but excluded from provider searches. Count them
    // as skipped up-front so matched+skipped+failed == total throughout the run.
    const entertainmentRows = allRows.filter((r) => !isNonEntertainment(r.media_type));
    const nonEntCount = allRows.length - entertainmentRows.length;
    const totalCount = allRows.length;

    logger.info(
        `Auto-identify started: ${totalCount} items to process (${entertainmentRows.length} entertainment, ${nonEntCount} non-entertainment skipped)`,
    );
    options.onProgress?.('searching', 0, 0, totalCount);

    let matched = 0;
    let skipped = nonEntCount; // non-entertainment items are pre-counted as skipped
    let failed = 0;
    let conflicts = 0;
    const conflictItems: AutoIdentifyResult['conflictItems'] = [];
    let aborted = false;
    let processedCount = nonEntCount; // already "processed" (skipped) up-front

    for (const item of entertainmentRows) {
        // Check at the top of every item iteration. Each item incurs
        // multiple provider searches + a 300ms rate-limit sleep, so we
        // want admin Cancel to exit before starting the next item rather
        // than wait for the in-flight search chain to finish.
        if (options.signal?.aborted) {
            aborted = true;
            break;
        }
        try {
            // A targeted run or a list snapshot can outlive the Keep action.
            // Recheck before spending provider calls, then again under the
            // row lock immediately before writing a candidate below.
            if (await isPersonalMediaKept(sql, item.id)) {
                skipped++;
                continue;
            }
            let bestCandidate: {
                provider: string;
                externalId: string;
                mediaType: 'movie' | 'tv';
                confidence: number;
            } | null = null;

            // Track IMDB ID from file paths for authoritative provider resolution.
            let resolvedImdbId: string | undefined;

            // item.media_type is media_items.media_type (INTERNAL_MEDIA_TYPES). The
            // isNonEntertainment() filter above only excludes the library-type
            // non-entertainment labels (home_video/training/educational/personal/
            // product) — it does not guarantee every remaining orphaned, file-
            // attached, external-id-less row is TMDB-representable. A row here can
            // still be e.g. an orphaned audiobook or music entity, neither of which
            // TMDB catalogs. Skip rather than default to 'movie' — that default is
            // the exact mismatch this migration exists to stop.
            const dbMediaType = toTmdbType(item.media_type);
            if (dbMediaType === null) {
                skipped++;
                logger.info(
                    `Skipped "${item.title}" — media type '${item.media_type}' has no TMDB representation`,
                );
                continue;
            }

            // Phase 1: Try resolving by IMDB ID from file paths (authoritative).
            // File-path parsing is provider-agnostic, so the DB query runs once
            // per item — not once per provider. Found IMDB IDs are resolved
            // via the ProviderDefinition.resolveExternalId capability on whichever
            // configured provider declares it (TMDB by default, but any provider
            // can participate). The loop below stops at the first provider that
            // returns a non-null result. Falls through to Phase 2 on null.
            const filePaths = await sql<{ file_path: string }[]>`
                    SELECT DISTINCT mf.file_path
                    FROM media_files mf
                    JOIN media_file_items mfi ON mfi.file_id = mf.id
                    WHERE mfi.media_item_id = ${item.id}
                       OR mfi.media_item_id IN (
                           SELECT ep.id FROM media_items season
                           JOIN media_items ep ON ep.parent_id = season.id
                           WHERE season.parent_id = ${item.id}
                       )
                    LIMIT 5
                `;
            for (const { file_path } of filePaths) {
                const parsed = parseMediaFilename(file_path);
                if (parsed.imdbId) {
                    resolvedImdbId = parsed.imdbId;
                    break;
                }
            }

            // Phase 1: cross-id resolution via the primary provider's
            // resolveExternalId capability. Works whenever ANY configured
            // provider in priority order declares the capability — not only
            // when TMDB is available. Falls through to Phase 2 on null.
            if (resolvedImdbId) {
                // Keep the embedded ID stable across provider attempts.
                const embeddedImdbId = resolvedImdbId;
                const hasResolver = providers.some(
                    (p) => typeof p.resolveExternalId === 'function',
                );
                if (!hasResolver) {
                    logger.debug(
                        'no provider exposes resolveExternalId — skipping Phase 1 cross-id resolution',
                    );
                }
                for (const provider of providers) {
                    if (bestCandidate) break;
                    if (options.signal?.aborted) break;
                    try {
                        const resolved = await invokeProviderResolveExternalId(
                            provider.id,
                            embeddedImdbId,
                            'imdb',
                            dbMediaType,
                            { signal: options.signal },
                        );
                        if (!resolved) continue;

                        // An embedded IMDB ID is authoritative ONLY if it's correct.
                        // A misnamed rip can carry a mislabeled imdb_id tag, which
                        // would otherwise be accepted at confidence 1.0 with no
                        // title check — auto-identifying the file to the wrong
                        // title. Gate the same way Phase 2 does: verify
                        // the resolved record's title actually resembles the
                        // personal-media item's title before trusting the ID.
                        //
                        // Foreign-language rips legitimately have a localized title
                        // that differs from the provider's primary (e.g. English)
                        // title, so we score against BOTH the primary and original
                        // title and take the better of the two.
                        const titleSim = Math.max(
                            titleSimilarity(item.title, resolved.title ?? ''),
                            titleSimilarity(item.title, resolved.originalTitle ?? ''),
                        );
                        const matchYear = parseTmdbYear(resolved.releaseDate);

                        if (titleSim >= TITLE_SIMILARITY_FLOOR) {
                            // Title corroborates the embedded ID — trust it fully.
                            bestCandidate = {
                                provider: provider.id,
                                externalId: resolved.externalId,
                                mediaType: dbMediaType,
                                confidence: 1.0,
                            };
                        } else {
                            // Title does NOT corroborate. Don't accept at 1.0 (which
                            // would bypass the title floor). Demote
                            // to a Phase-2-style scored candidate so it still competes
                            // in the fuzzy fallback if nothing better turns up, but is
                            // never treated as authoritative.
                            const yearScore = yearProximity(
                                item.release_year ?? undefined,
                                matchYear,
                            );
                            const demotedScore = titleSim * yearScore;
                            logger.warn(
                                `IMDB ID ${resolvedImdbId} for "${item.title}" resolved to ${provider.id}:${resolved.externalId} ("${resolved.title ?? resolved.originalTitle ?? '?'}") but title similarity ${titleSim.toFixed(2)} < floor ${TITLE_SIMILARITY_FLOOR} — possible mislabeled imdb_id tag; not accepting at confidence 1.0`,
                            );
                            if (demotedScore >= AUTO_IDENTIFY_THRESHOLD) {
                                bestCandidate = {
                                    provider: provider.id,
                                    externalId: resolved.externalId,
                                    mediaType: dbMediaType,
                                    confidence: demotedScore,
                                };
                            }
                            // The mislabeled IMDB ID must not be persisted as a
                            // cross-reference during the merge path, since the
                            // demoted candidate is no longer authoritative.
                            resolvedImdbId = undefined;
                        }
                    } catch (err) {
                        logger.debug(`${provider.id} resolveExternalId failed`, {
                            imdbId: resolvedImdbId,
                            err: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }

            // Phase 2: Fuzzy title search across all providers (fallback)
            if (!bestCandidate) {
                const searchType: 'movie' | 'tv' = dbMediaType;
                for (const provider of providers) {
                    if (options.signal?.aborted) {
                        aborted = true;
                        break; // exits only the provider for-loop
                    }
                    if (
                        !(await isProviderConfigured(provider.id, {
                            signal: options.signal,
                        }))
                    )
                        continue;

                    try {
                        const raw = await invokeProviderSearch(
                            provider.id,
                            {
                                type: searchType,
                                query: item.title,
                                year: item.release_year ?? undefined,
                            },
                            { signal: options.signal },
                        );
                        const candidates = raw
                            .map((r) =>
                                normalizeSearchResult(
                                    provider.id,
                                    r,
                                    searchType,
                                    item.release_year ?? undefined,
                                ),
                            )
                            .filter((c): c is MetadataCandidate => c !== null);

                        // Score EVERY candidate this provider returned against the
                        // actual title/year of the personal-media item — don't
                        // pre-select "the most popular result" before scoring, since
                        // the correct candidate is often not the most popular one
                        // (e.g. a franchise search where a newer/more popular entry
                        // outranks the actual back-catalog match). Provider
                        // confidence (popularity) only breaks ties between
                        // candidates whose title/year match equally well.
                        const scored = candidates
                            .map((candidate) => {
                                const titleSim = titleSimilarity(item.title, candidate.title);
                                const yearScore = yearProximity(
                                    item.release_year ?? undefined,
                                    candidate.year,
                                );
                                return {
                                    candidate,
                                    titleSim,
                                    matchScore: titleSim * yearScore,
                                };
                            })
                            .sort(
                                (a, b) =>
                                    b.matchScore - a.matchScore ||
                                    b.candidate.confidence - a.candidate.confidence,
                            );

                        const best = scored[0];

                        if (
                            best &&
                            best.matchScore >= AUTO_IDENTIFY_THRESHOLD &&
                            best.titleSim >= TITLE_SIMILARITY_FLOOR &&
                            (!bestCandidate || best.matchScore > bestCandidate.confidence)
                        ) {
                            // best.candidate.mediaType is a MetadataCandidate
                            // ('movie' | 'tv' | 'episode' | 'season' | 'anime',
                            // providers/types.ts) — every member maps onto a TMDB
                            // namespace, so this is never actually null. The
                            // fallback is searchType (the type this very provider
                            // search was run for) rather than a bare 'movie'.
                            const mediaType = toTmdbType(best.candidate.mediaType) ?? searchType;
                            bestCandidate = {
                                provider: best.candidate.provider,
                                externalId: best.candidate.externalId,
                                mediaType,
                                // Store the match score so the cross-provider
                                // comparison above (and the persisted external_id
                                // confidence) reflects match quality, not raw popularity.
                                confidence: best.matchScore,
                            };
                        }
                    } catch (err) {
                        logger.warn(
                            `Provider ${provider.id} search failed for "${item.title}"`,
                            err as Error,
                        );
                    }
                }
            }

            // If the operator cancelled during Phase 2's provider loop,
            // do not commit any bestCandidate that was found just before
            // the break. Without this guard, one extra item would be fully
            // identified and persisted even after cancel was pressed.
            if (aborted) {
                break;
            }

            if (bestCandidate) {
                try {
                    const written = await upsertAutoMatchUnlessKept(sql, item.id, bestCandidate);
                    if (!written) {
                        skipped++;
                        continue;
                    }

                    // Lifecycle hook enqueues metadata sync. Embeddings are
                    // drained by the scheduled discovery-embeddings task.
                    await MediaLifecycleService.afterMatched(
                        item.id,
                        bestCandidate.mediaType,
                        {
                            enqueueMetadataSync: true,
                        },
                        sql,
                    );

                    matched++;
                    logger.info(
                        `Auto-identified "${item.title}" → ${bestCandidate.provider}:${bestCandidate.externalId} (confidence: ${bestCandidate.confidence.toFixed(2)})`,
                    );
                } catch (err) {
                    if (err instanceof Error && err.message.includes('is already mapped')) {
                        skipped++;
                        conflicts++;
                        if (conflictItems.length < 200)
                            conflictItems.push({ id: item.id, title: item.title });
                        logger.info(
                            `Skipped "${item.title}" — online match belongs to another entry; use the explicit merge preview`,
                        );
                    } else {
                        failed++;
                        logger.warn(`Failed to identify "${item.title}"`, err as Error);
                    }
                }
            } else {
                skipped++;
            }

            // Rate limiting between provider searches
            await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
        } catch (err) {
            failed++;
            logger.warn(`Auto-identify error for "${item.title}"`, err as Error);
        } finally {
            // Always increment processedCount so matched+skipped+failed
            // never exceeds it even when an exception is thrown mid-item.
            processedCount++;
            options.onProgress?.('searching', matched, skipped + failed, totalCount);
        }
    }

    const message = aborted
        ? `Auto-identify aborted: ${matched} matched, ${skipped} skipped, ${failed} failed out of ${processedCount} processed (${totalCount} total)`
        : `Auto-identify complete: ${matched} matched, ${skipped} skipped, ${failed} failed out of ${totalCount}`;
    const reportedMessage = conflicts
        ? `${message}; ${conflicts} online matches belong to another entry and need an explicit merge choice`
        : message;
    logger.info(reportedMessage);

    return {
        matched,
        skipped,
        failed,
        conflicts,
        conflictItems,
        total: totalCount,
        message: reportedMessage,
    };
}
