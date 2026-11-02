// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * release-calendar-sync — periodic Sonarr + Radarr calendar pull.
 *
 * Motivation: /api/calendar now reads premiere_date from media_items instead
 * of calling the arr APIs live. TMDB discovery pre-creates episode stubs for
 * tracked series (has_files=false), but two categories fall through:
 *
 *   1. Newly-announced future episodes whose premiere_date has shifted since
 *      the last series-sync run (series-sync is manual-only).
 *   2. Radarr-monitored pre-release movies with no TMDB discovery stub yet.
 *
 * This task pulls Sonarr + Radarr /api/v3/calendar over a wide window
 * (now-7d … now+90d) every 6h and does two things with the results:
 *
 * 1. Projection (coverage): every calendar entry is upserted into the
 *    upcoming_releases table — a flat snapshot that is NOT part of the
 *    catalog. This is the gap-fill source the calendar query reads for
 *    monitored-but-not-owned titles, so no Sonarr/Radarr entry is silently
 *    dropped just because it has no media_items stub. Stale in-window rows are
 *    reconciled (deleted) after a successful fetch.
 *
 * 2. Catalog freshness: for entries that DO have a catalog row it keeps
 *    premiere_date fresh, and reconciles has_files against LOCAL scanner
 *    evidence (media_file_items) rather than trusting Sonarr/Radarr's
 *    `hasFile` flag directly:
 *      - Episodes: updates the existing episode row identified by (series
 *        external-id → season row → episode number). If no stub exists yet
 *        (series-sync not yet run), the media_items UPDATE is skipped — the task
 *        does NOT create full series hierarchies (the phantom-series gate). The
 *        episode still appears via the projection table above.
 *      - Movies: updates the existing movie row identified by tmdbId (premiere_date
 *        written directly, has_files reconciled the same way as episodes). No
 *        stub is created: a movie without a catalog row is skipped here and
 *        still appears via the projection table. Pre-release movies with no
 *        TMDB id are likewise only recorded in the projection table.
 *
 *    has_files reconciliation (bug fix — the arr payload is NOT trusted as the
 *    source of truth here): `has_files = EXISTS(media_file_items row for this
 *    item)`, ignoring the arr entry's own `hasFile` field for the WRITE value
 *    entirely. Two failure directions this avoids:
 *      (a) Sonarr/Radarr momentarily reporting `hasFile: false` (e.g. a
 *          re-scan race, disk hiccup, or lag between the file landing and the
 *          arr's own DB catching up) would otherwise flip a locally-scanned,
 *          currently-playable item to unavailable for up to the 6h schedule
 *          gap — hidden from users despite being fully playable.
 *      (b) Sonarr/Radarr reporting `hasFile: true` for an item this instance
 *          hasn't actually scanned yet (e.g. a shared *arr instance pointing
 *          at a different library mount, or a file that landed but the local
 *          scanner hasn't processed it) would create exactly the catalog
 *          "phantom" the module already avoids for whole series (see the
 *          phantom-series gate above) — a card that promises playback with no
 *          backing file. media_file_items presence is the only local,
 *          verifiable signal for "this instance can actually stream this".
 *    A dismissed row keeps its has_files: a dismissal clears it while keeping
 *    the links (see propagateHasFiles in media-files.queries.ts).
 *
 * Provider-down handling: each provider (Sonarr, Radarr) is guarded
 * independently. A failure on one side is logged and skipped; the other
 * provider continues. The whole task never hard-fails due to a single
 * provider being unreachable.
 *
 * Idempotency: all writes are UPDATEs on rows found by external-id lookup;
 * this task creates no media_items rows. Re-running produces the same DB state.
 */

import { z } from 'zod';
import type { Sql } from 'postgres';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';

interface ReleaseCalendarSyncResult {
    sonarrEntries: number;
    radarrEntries: number;
    episodesUpdated: number;
    episodesSkipped: number;
    moviesUpserted: number;
    moviesSkipped: number;
    /** Rows written to the upcoming_releases projection table (gap-fill source). */
    releasesUpserted: number;
    errors: number;
    message: string;
}

/**
 * One row of the upcoming_releases projection table. This is a flat
 * snapshot of a Sonarr/Radarr calendar item — NOT a catalog row. It exists so
 * the calendar query can gap-fill monitored-but-not-owned titles without
 * materializing them into media_items (see the migration + calendar.queries.ts).
 */
interface UpcomingReleaseRow {
    source: 'sonarr' | 'radarr';
    source_item_id: number;
    source_series_id: number | null;
    media_type: 'episode' | 'movie';
    tmdb_id: number | null;
    tvdb_id: number | null;
    imdb_id: string | null;
    series_title: string | null;
    title: string;
    season_number: number | null;
    episode_number: number | null;
    air_date: string | null;
    has_file: boolean;
    runtime: number | null;
    overview: string | null;
}

const UPCOMING_RELEASE_COLUMNS = [
    'source',
    'source_item_id',
    'source_series_id',
    'media_type',
    'tmdb_id',
    'tvdb_id',
    'imdb_id',
    'series_title',
    'title',
    'season_number',
    'episode_number',
    'air_date',
    'has_file',
    'runtime',
    'overview',
] as const;

/**
 * Batch-upsert calendar projection rows, keyed by (source, source_item_id).
 * Re-running produces the same DB state (idempotent).
 */
async function upsertUpcomingReleaseRows(sql: Sql, rows: UpcomingReleaseRow[]): Promise<void> {
    if (rows.length === 0) return;
    await sql`
        INSERT INTO upcoming_releases ${sql(rows, ...UPCOMING_RELEASE_COLUMNS)}
        ON CONFLICT (source, source_item_id) DO UPDATE SET
            source_series_id  = EXCLUDED.source_series_id,
            media_type     = EXCLUDED.media_type,
            tmdb_id        = EXCLUDED.tmdb_id,
            tvdb_id        = EXCLUDED.tvdb_id,
            imdb_id        = EXCLUDED.imdb_id,
            series_title   = EXCLUDED.series_title,
            title          = EXCLUDED.title,
            season_number  = EXCLUDED.season_number,
            episode_number = EXCLUDED.episode_number,
            air_date       = EXCLUDED.air_date,
            has_file       = EXCLUDED.has_file,
            runtime        = EXCLUDED.runtime,
            overview       = EXCLUDED.overview,
            updated_at     = NOW()
    `;
}

/**
 * Reconcile the projection table against the just-fetched calendar: delete
 * in-window rows for this source that are no longer present upstream (unmonitored
 * / removed in Sonarr-Radarr). Only call after a SUCCESSFUL fetch — on provider
 * error the caller skips this so a transient outage never wipes the table.
 */
async function pruneUpcomingReleaseRows(
    sql: Sql,
    source: 'sonarr' | 'radarr',
    keepItemIds: number[],
    windowStartDate: string,
): Promise<void> {
    // Sentinel keeps the `<> ALL` well-formed when the fetch legitimately
    // returned zero entries (nothing upcoming → drop all in-window rows).
    const keep = keepItemIds.length > 0 ? keepItemIds : [-1];
    await sql`
        DELETE FROM upcoming_releases
        WHERE source = ${source}
          AND air_date >= ${windowStartDate}::date
          AND source_item_id <> ALL(${keep}::int[])
    `;
}

const inputSchema = z.object({}).passthrough();

export const releaseCalendarSyncTask = defineTask<
    Record<string, unknown>,
    ReleaseCalendarSyncResult
>({
    id: 'release-calendar-sync',
    purpose: 'library',
    name: 'Release Calendar Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },

    schedule: { every: '6h', runOnStartup: false },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'bulk',
    inputSchema,

    timeout: { hard: '20m', soft: '18m' },
    cost: { kind: 'api_calls' },

    // Singleton guard: calls Sonarr/Radarr (cost: 'api_calls') then reconciles
    // upcoming_releases with a scoped DELETE of stale rows (pruneUpcomingReleaseRows).
    // Without exclusiveWith, the scheduler's narrow double-fire window
    // (fast-completing run + failed scheduler_state advance) can spawn a
    // second concurrent 'global' sync that both doubles Sonarr/Radarr traffic
    // and lets two DELETE/insert reconciles race against slightly different
    // snapshots. identityFor is the constant 'global'. ttl exceeds the 20m
    // hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '30m' },

    async execute(ctx) {
        return withApiCallSpend(ctx, async () => {
            const { logger, signal } = ctx;

            if (signal.aborted) {
                return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
            }

            // Wide window: 7 days back (to catch recently-aired with updated
            // has_files) and 90 days forward (future premiere dates).
            const now = new Date();
            const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const windowEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
            const windowStartDate = windowStart.toISOString().split('T')[0];

            const { sonarrClient, radarrClient, ArrApiError } =
                await import('$lib/server/sonarr.js');
            const { resolveExternalIdToUuid } =
                await import('../../../database/queries/media-lookup.queries.js');
            const { getPrimaryExternalIdProvider } =
                await import('$lib/server/utils/provider-config.js');

            const primaryProvider = getPrimaryExternalIdProvider();

            let sonarrEntries = 0;
            let radarrEntries = 0;
            let episodesUpdated = 0;
            let episodesSkipped = 0;
            let moviesUpserted = 0;
            let moviesSkipped = 0;
            let releasesUpserted = 0;
            let errors = 0;

            // Projection rows accumulated per source, upserted in one batch after
            // each provider loop. Every calendar entry is recorded here (the
            // gap-fill source) regardless of whether a catalog stub exists.
            const sonarrReleases: UpcomingReleaseRow[] = [];
            const radarrReleases: UpcomingReleaseRow[] = [];

            // ──────────────────────────────────────────────────────────────────
            // Sonarr: update premiere_date + has_files for existing episode stubs
            // ──────────────────────────────────────────────────────────────────

            let sonarrCalendar = null;
            let sonarrErrorStatus: number | null | undefined;
            try {
                sonarrCalendar = await sonarrClient.getCalendar(windowStart, windowEnd);
            } catch (err) {
                logger.warn('release-calendar-sync: Sonarr getCalendar failed — skipping', {
                    error: err instanceof Error ? err.message : String(err),
                });
                sonarrErrorStatus = err instanceof ArrApiError ? err.status : null;
                errors++;
            }

            if (sonarrCalendar && sonarrCalendar.length > 0) {
                sonarrEntries = sonarrCalendar.length;
                logger.info('release-calendar-sync: Sonarr entries', { count: sonarrEntries });

                for (const entry of sonarrCalendar) {
                    if (signal.aborted) break;

                    const seriesTmdbId = entry.series?.tmdbId;
                    const seriesTvdbId = entry.series?.tvdbId;
                    const airDate = entry.airDateUtc ? entry.airDateUtc.split('T')[0] : null;

                    // Record EVERY entry into the projection table first — this is
                    // the gap-fill source and must include entries with no catalog
                    // stub (the ones the media_items UPDATE below skips).
                    if (airDate) {
                        sonarrReleases.push({
                            source: 'sonarr',
                            source_item_id: entry.id,
                            source_series_id: entry.series?.id ?? entry.seriesId ?? null,
                            media_type: 'episode',
                            tmdb_id: seriesTmdbId && seriesTmdbId > 0 ? seriesTmdbId : null,
                            tvdb_id: seriesTvdbId && seriesTvdbId > 0 ? seriesTvdbId : null,
                            imdb_id: entry.series?.imdbId ?? null,
                            series_title: entry.series?.title ?? null,
                            title: entry.title,
                            season_number: entry.seasonNumber ?? null,
                            episode_number: entry.episodeNumber ?? null,
                            air_date: airDate,
                            has_file: entry.hasFile,
                            runtime: entry.runtime ?? null,
                            overview: entry.overview ?? null,
                        });
                    }

                    if (!airDate) {
                        episodesSkipped++;
                        continue;
                    }

                    // Resolve series UUID. Try the primary provider's ID first,
                    // then fall back to the other available ID.
                    let seriesId: string | null = null;
                    if (primaryProvider === 'tvdb') {
                        if (seriesTvdbId && seriesTvdbId > 0) {
                            seriesId = await resolveExternalIdToUuid(
                                ctx.sql,
                                String(seriesTvdbId),
                                'tv',
                                'tvdb',
                            ).catch(() => null);
                        }
                        if (!seriesId && seriesTmdbId && seriesTmdbId > 0) {
                            seriesId = await resolveExternalIdToUuid(
                                ctx.sql,
                                String(seriesTmdbId),
                                'tv',
                                'tmdb',
                            ).catch(() => null);
                        }
                    } else {
                        // Default: tmdb is primary
                        if (seriesTmdbId && seriesTmdbId > 0) {
                            seriesId = await resolveExternalIdToUuid(
                                ctx.sql,
                                String(seriesTmdbId),
                                'tv',
                                'tmdb',
                            ).catch(() => null);
                        }
                        if (!seriesId && seriesTvdbId && seriesTvdbId > 0) {
                            seriesId = await resolveExternalIdToUuid(
                                ctx.sql,
                                String(seriesTvdbId),
                                'tv',
                                'tvdb',
                            ).catch(() => null);
                        }
                    }

                    if (!seriesId) {
                        episodesSkipped++;
                        continue;
                    }

                    const seasonNumber = entry.seasonNumber;
                    const episodeNumber = entry.episodeNumber;

                    if (
                        seasonNumber === undefined ||
                        seasonNumber === null ||
                        episodeNumber === undefined ||
                        episodeNumber === null
                    ) {
                        episodesSkipped++;
                        continue;
                    }

                    try {
                        // Find the season row for this series.
                        const [seasonRow] = await ctx.sql<{ id: string }[]>`
                            SELECT mi.id
                            FROM media_items mi
                            WHERE mi.media_type = 'season'
                              AND mi.parent_id = ${seriesId}::uuid
                              AND mi.season_number = ${seasonNumber}
                            LIMIT 1
                        `;

                        if (!seasonRow) {
                            episodesSkipped++;
                            continue;
                        }

                        // Update the episode row if it exists. has_files is
                        // reconciled against local media_file_items evidence,
                        // NOT the arr's `hasFile` flag directly — see the
                        // module doc comment ("has_files reconciliation").
                        const updated = await ctx.sql<{ id: string }[]>`
                            UPDATE media_items AS mi
                            SET premiere_date = ${airDate}::date,
                                has_files     = CASE WHEN mi.is_dismissed THEN mi.has_files ELSE EXISTS (
                                    SELECT 1 FROM media_file_items mfi
                                     WHERE mfi.media_item_id = mi.id
                                ) END,
                                updated_at    = NOW()
                            WHERE mi.media_type    = 'episode'
                              AND mi.parent_id     = ${seasonRow.id}::uuid
                              AND mi.season_number = ${seasonNumber}
                              AND mi.episode_number = ${episodeNumber}
                            RETURNING mi.id
                        `;

                        if (updated.length > 0) {
                            episodesUpdated++;
                        } else {
                            episodesSkipped++;
                        }
                    } catch (err) {
                        logger.warn('release-calendar-sync: error updating episode', {
                            seriesId,
                            seasonNumber,
                            episodeNumber,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        errors++;
                    }
                }
            }

            // Persist the Sonarr projection rows + reconcile stale in-window rows.
            // Guarded on a successful fetch (non-null) so a provider outage never
            // wipes the table.
            if (sonarrCalendar !== null) {
                try {
                    await upsertUpcomingReleaseRows(ctx.sql, sonarrReleases);
                    await pruneUpcomingReleaseRows(
                        ctx.sql,
                        'sonarr',
                        sonarrReleases.map((r) => r.source_item_id),
                        windowStartDate,
                    );
                    releasesUpserted += sonarrReleases.length;
                } catch (err) {
                    logger.warn('release-calendar-sync: failed to persist Sonarr projection rows', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    errors++;
                }
            }

            if (signal.aborted) {
                return {
                    success: false,
                    itemsProcessed: episodesUpdated + moviesUpserted,
                    stopReason: 'aborted',
                    result: {
                        sonarrEntries,
                        radarrEntries,
                        episodesUpdated,
                        episodesSkipped,
                        moviesUpserted,
                        moviesSkipped,
                        releasesUpserted,
                        errors,
                        message: 'aborted',
                    },
                };
            }

            // ──────────────────────────────────────────────────────────────────
            // Radarr: refresh existing movie rows (premiere_date + has_files); no stubs
            // ──────────────────────────────────────────────────────────────────

            let radarrCalendar = null;
            let radarrErrorStatus: number | null | undefined;
            try {
                radarrCalendar = await radarrClient.getCalendar(windowStart, windowEnd);
            } catch (err) {
                logger.warn('release-calendar-sync: Radarr getCalendar failed — skipping', {
                    error: err instanceof Error ? err.message : String(err),
                });
                radarrErrorStatus = err instanceof ArrApiError ? err.status : null;
                errors++;
            }

            if (radarrCalendar && radarrCalendar.length > 0) {
                radarrEntries = radarrCalendar.length;
                logger.info('release-calendar-sync: Radarr entries', { count: radarrEntries });

                for (const entry of radarrCalendar) {
                    if (signal.aborted) break;

                    const tmdbId = entry.tmdbId;

                    // Pick the earliest available release date.
                    const releaseDate =
                        entry.inCinemas || entry.physicalRelease || entry.digitalRelease || null;
                    const airDate = releaseDate ? releaseDate.split('T')[0] : null;

                    // Record EVERY movie with a release date into the projection
                    // table (gap-fill source), including ones with no TMDB id that
                    // the media_items stub path below skips.
                    if (airDate) {
                        radarrReleases.push({
                            source: 'radarr',
                            source_item_id: entry.id,
                            source_series_id: null,
                            media_type: 'movie',
                            tmdb_id: tmdbId && tmdbId > 0 ? tmdbId : null,
                            tvdb_id: null,
                            imdb_id: null,
                            series_title: null,
                            title: entry.title,
                            season_number: null,
                            episode_number: null,
                            air_date: airDate,
                            has_file: entry.hasFile,
                            runtime: entry.runtime ?? null,
                            overview: entry.overview ?? null,
                        });
                    }

                    if (!tmdbId || tmdbId <= 0) {
                        moviesSkipped++;
                        continue;
                    }

                    try {
                        // Never create a movie stub: the calendar shows monitored
                        // movies from the upcoming_releases projection written
                        // above, so a media_items row here would only add an
                        // unreferenced fileless discovery candidate. Only a movie
                        // that already has a catalog row is refreshed.
                        const mediaId = await resolveExternalIdToUuid(
                            ctx.sql,
                            String(tmdbId),
                            'movie',
                            // Radarr's id is a TMDB id whatever the primary provider is.
                            'tmdb',
                        );
                        if (!mediaId) {
                            moviesSkipped++;
                            continue;
                        }

                        // Update premiere_date and has_files directly. has_files is reconciled against
                        // local media_file_items evidence, NOT the arr's
                        // `hasFile` flag directly — see the module doc comment
                        // ("has_files reconciliation").
                        if (airDate !== null) {
                            await ctx.sql`
                                UPDATE media_items AS mi
                                SET premiere_date = ${airDate}::date,
                                    has_files     = CASE WHEN mi.is_dismissed THEN mi.has_files ELSE EXISTS (
                                        SELECT 1 FROM media_file_items mfi
                                         WHERE mfi.media_item_id = mi.id
                                    ) END,
                                    updated_at    = NOW()
                                WHERE mi.id = ${mediaId}::uuid
                            `;
                        } else {
                            await ctx.sql`
                                UPDATE media_items AS mi
                                SET has_files  = CASE WHEN mi.is_dismissed THEN mi.has_files ELSE EXISTS (
                                        SELECT 1 FROM media_file_items mfi
                                         WHERE mfi.media_item_id = mi.id
                                    ) END,
                                    updated_at = NOW()
                                WHERE mi.id = ${mediaId}::uuid
                            `;
                        }

                        moviesUpserted++;
                    } catch (err) {
                        logger.warn('release-calendar-sync: error upserting movie', {
                            tmdbId,
                            title: entry.title,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        errors++;
                        moviesSkipped++;
                    }
                }
            }

            // Persist the Radarr projection rows + reconcile stale in-window rows.
            if (radarrCalendar !== null) {
                try {
                    await upsertUpcomingReleaseRows(ctx.sql, radarrReleases);
                    await pruneUpcomingReleaseRows(
                        ctx.sql,
                        'radarr',
                        radarrReleases.map((r) => r.source_item_id),
                        windowStartDate,
                    );
                    releasesUpserted += radarrReleases.length;
                } catch (err) {
                    logger.warn('release-calendar-sync: failed to persist Radarr projection rows', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    errors++;
                }
            }

            const totalProcessed = episodesUpdated + moviesUpserted;
            const message =
                `Sonarr: ${sonarrEntries} entries, ${episodesUpdated} episodes updated, ` +
                `${episodesSkipped} skipped; ` +
                `Radarr: ${radarrEntries} entries, ${moviesUpserted} movies upserted, ` +
                `${moviesSkipped} skipped; ${releasesUpserted} calendar rows; ` +
                `errors: ${errors}`;

            logger.info('release-calendar-sync: complete', {
                sonarrEntries,
                radarrEntries,
                episodesUpdated,
                episodesSkipped,
                moviesUpserted,
                moviesSkipped,
                releasesUpserted,
                errors,
            });

            // Monitoring-blindness guard: gate on the CONFIGURED providers only.
            // A not-configured Arr returns [] (non-null) from getCalendar and does
            // no work — its calendar being non-null must NOT mask an outage of the
            // OTHER (configured) provider. The naive `sonarrCalendar === null &&
            // radarrCalendar === null` test was unreachable on single-arr
            // deployments: the unconfigured side is always [] (non-null), so a
            // total outage of the ONLY configured provider returned success.
            //
            // Require EVERY configured provider's calendar to be null (each
            // getCalendar() threw → total upstream outage). Throw a transient
            // TaskError so the run is marked failed, retried, and the breaker can
            // trip. A single configured provider down while another configured one
            // is up stays success per this task's independent-provider design; the
            // not-configured case (no configured providers) also stays success.
            const configuredCalendars = [
                {
                    name: 'Sonarr',
                    configured: sonarrClient.isConfigured(),
                    calendar: sonarrCalendar,
                    status: sonarrErrorStatus,
                },
                {
                    name: 'Radarr',
                    configured: radarrClient.isConfigured(),
                    calendar: radarrCalendar,
                    status: radarrErrorStatus,
                },
            ].filter((p) => p.configured);

            if (
                configuredCalendars.length > 0 &&
                configuredCalendars.every((p) => p.calendar === null)
            ) {
                // Distinguish a misconfigured/rejected API key (401/403 — needs an
                // operator to fix the key in settings) from a genuine outage
                // (5xx/network — self-healing, no action needed). ArrApiError.status
                // is null for network-layer failures (timeout/ECONNREFUSED), so a
                // failed provider with status undefined/null falls through as an
                // outage rather than a misconfiguration.
                const authFailed = configuredCalendars.filter(
                    (p) => p.status === 401 || p.status === 403,
                );
                throw new TaskError({
                    message:
                        authFailed.length > 0
                            ? `release-calendar-sync: ${authFailed.map((p) => p.name).join('/')} ` +
                              `rejected the configured API key (HTTP ${authFailed[0].status}) — ` +
                              `check the key in settings; no releases synced.`
                            : 'release-calendar-sync: upstream outage — every configured Arr ' +
                              '(Sonarr/Radarr) calendar was unreachable; no releases synced.',
                    kind: 'transient',
                });
            }

            return {
                success: true,
                itemsProcessed: totalProcessed,
                result: {
                    sonarrEntries,
                    radarrEntries,
                    episodesUpdated,
                    episodesSkipped,
                    moviesUpserted,
                    moviesSkipped,
                    releasesUpserted,
                    errors,
                    message,
                },
            };
        });
    },
});

registry.registerTask(releaseCalendarSyncTask);
