// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The calendar feed both calendar endpoints serve: `GET /api/calendar` (web)
 * and `GET /api/v1/upcoming?view=calendar` (apps). They used to carry two
 * copies of this logic, which drifted (different Sonarr/Radarr gate, a copied
 * mute matcher). The endpoints now only parse their query, map rows to their
 * own response shape and paginate.
 *
 * Steps: validate the range, build the access boundary, decide whether to
 * gap-fill Sonarr/Radarr-only rows, read through the global range cache, then
 * drop the rows the user muted (per user, so after the cache).
 */

import type postgres from 'postgres';
import { ApiProblem } from '$lib/server/api/problem.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { config } from '$lib/server/config.js';
import {
    getCalendarItemsFromDb,
    type CalendarRow,
} from '$lib/server/database/queries/calendar.queries.js';
import { isUnrestricted } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    buildSearchAccessCacheKey,
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { getExcludedSeriesKeys } from '$lib/server/utils/excluded-series.js';
import { hasExclusions, isCalendarRowExcluded } from '$lib/server/utils/excluded-series-match.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';
import { toUserId } from '$lib/shared/user-id.js';

export const MAX_CALENDAR_SPAN_DAYS = 90;

/**
 * Bump the key version when the row shape or selection changes; `v3` added the
 * series id on Sonarr/Radarr-only rows of a catalog series. `v4` removes
 * unbound catalog stubs superseded by a renumbered episode.
 */
const CALENDAR_CACHE_VERSION = 'v4';

type CalendarUser = Parameters<typeof buildSearchAccessContext>[1];

/**
 * Parse `start` / `end` (ISO 8601, default today) into UTC day bounds, or the
 * problem response to return.
 */
export function parseCalendarRange(
    startParam: string | null | undefined,
    endParam: string | null | undefined,
): { ok: true; start: Date; end: Date } | { ok: false; response: Response } {
    let start = startParam ? new Date(startParam) : new Date();
    let end = endParam ? new Date(endParam) : new Date();

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return {
            ok: false,
            response: ApiProblem.validationFailed([
                { field: 'start', message: 'Invalid date format. Use ISO 8601.' },
            ]),
        };
    }

    // UTC day boundaries, so the cache key covers whole days.
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    end = new Date(
        Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999),
    );

    if (start > end) {
        return {
            ok: false,
            response: ApiProblem.validationFailed([
                { field: 'start', message: 'start must be before or equal to end' },
            ]),
        };
    }
    if (end.getTime() - start.getTime() > MAX_CALENDAR_SPAN_DAYS * 24 * 60 * 60 * 1000) {
        return {
            ok: false,
            response: ApiProblem.validationFailed([
                {
                    field: 'end',
                    message: `Date range too large. Maximum span is ${MAX_CALENDAR_SPAN_DAYS} days`,
                },
            ]),
        };
    }
    return { ok: true, start, end };
}

/**
 * The calendar rows the user may see in [start, end], muted rows removed.
 */
export async function loadCalendarFeed(
    sql: postgres.Sql,
    user: CalendarUser,
    start: Date,
    end: Date,
): Promise<CalendarRow[]> {
    const accessCtx = await buildSearchAccessContext(sql, user);
    const accessBoundary = searchAccessBoundary(accessCtx);

    // Gap-fill Sonarr/Radarr-only entries ONLY for fully unrestricted users:
    // arr entries carry no library group or content rating to filter on, so a
    // user with a library or age restriction stays catalog-only (no existence
    // leak). Gated on the RAW SHOW_UNAVAILABLE_MEDIA toggle, not the effective
    // accessCtx.showUnavailableMedia (which also requires a configured request
    // path): monitored titles arrive in the library whether or not requests
    // are configured, so an arr-only install keeps its gap-fill.
    //
    // getCalendarItemsFromDb enforces the access half again; it is repeated
    // here because the cache key must agree with the predicate.
    const includeMonitored = config.SHOW_UNAVAILABLE_MEDIA && isUnrestricted(accessBoundary);

    const startDay = start.toISOString().split('T')[0];
    const endDay = end.toISOString().split('T')[0];
    // Access scope is in the key: users with different library-group or age
    // restrictions get separate entries. `mon` keys the gap-fill decision.
    const cacheKey = `calendar:${CALENDAR_CACHE_VERSION}:${startDay}:${endDay}:${buildSearchAccessCacheKey(accessCtx)}${includeMonitored ? ':mon' : ''}`;

    const calendarCache = cacheManager.for(CACHE_NAMESPACES.calendar);
    let rows = await calendarCache.get<CalendarRow[]>(cacheKey);
    if (!rows) {
        rows = await getCalendarItemsFromDb(sql, start, end, accessBoundary, includeMonitored);
        await calendarCache.set(cacheKey, rows);
    }

    // Hiding is a read-time view, including catalog release stubs from a cached range.
    if (!config.SHOW_UNAVAILABLE_MEDIA) rows = rows.filter((row) => row.has_files);

    // Mutes are per user, the cache is not: filter after it. The
    // `get_upcoming_releases` assistant tool runs the same predicate.
    const exclusions = user?.username ? await getExcludedSeriesKeys(user.username) : null;
    if (!exclusions || !hasExclusions(exclusions)) return rows;
    return rows.filter((row) => !isCalendarRowExcluded(exclusions, row));
}

/**
 * Per-user metadata-language overlay (multilingual-media-metadata spec §5) on
 * already mapped items. Pass fresh objects, never cached rows. Rows without a
 * catalog id (Sonarr/Radarr-only) are skipped by the overlay's null-id guard.
 */
export async function overlayCalendarTranslations<
    T extends { id?: string | null; title?: string; overview?: string },
>(sql: postgres.Sql, userId: string | undefined, items: T[]): Promise<void> {
    if (!userId || config.METADATA_ADDITIONAL_LANGUAGES.length === 0) return;
    const langs = resolveMetadataLanguage(
        await getPlaybackPreferences.one(sql, { userId: toUserId(userId) }),
    );
    if (!langs.titleLang && !langs.textLang) return;
    await applyTranslationOverlay(sql, items, langs, {
        id: (it) => (typeof it.id === 'string' ? it.id : null),
        setTitle: (it, v) => {
            it.title = v;
        },
        setOverview: (it, v) => {
            it.overview = v;
        },
    });
}
