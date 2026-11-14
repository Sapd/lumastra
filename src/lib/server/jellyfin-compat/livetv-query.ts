// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query parsing, filtering, sorting and paging for the /j Live TV list routes
 * (`/LiveTv/Programs` GET+POST, `/LiveTv/Programs/Recommended`, `/LiveTv/Channels`).
 *
 * Mirrors Jellyfin's LiveTvController + BaseItemRepository.TranslateQuery
 * semantics over the in-memory guide the Live TV provider hands out:
 *  - `HasAired=true` → ended by now; `false` → still running or upcoming.
 *  - `IsAiring=true` → running now; `false` → not running now.
 *  - `IsMovie`/`IsSeries` are AND filters; `IsSports`/`IsNews`/`IsKids` are tag
 *    filters: every `true` one is OR'ed together, every `false` one excluded.
 *  - `Genres` is pipe-delimited (any-match, case-insensitive).
 *  - `EnableTotalRecordCount=false` → TotalRecordCount is the page length.
 *
 * Content flags come from the channel category (programFlagsForCategory), the
 * same approximation the serializer reports, so a filter never disagrees with
 * the flags on the items it returns.
 */

import { getParam, getParamAll } from '$lib/server/jellyfin-compat/utils';
import { isRecord } from '$lib/utils/data-extraction';
import { programFlagsForCategory } from '$lib/server/jellyfin-compat/serializers/livetv';
import type { LiveTvChannel, LiveTvFeedProgram } from '$lib/schemas/livetv';

/** Explicit Limit sanity bound, and the default when a guide query sends none. */
export const MAX_PROGRAM_LIMIT = 20000;

const HOUR_MS = 60 * 60 * 1000;
/** Default guide window when the client sends no date bounds. */
const DEFAULT_WINDOW_BEFORE_MS = 3 * HOUR_MS;
const DEFAULT_WINDOW_AFTER_MS = 24 * HOUR_MS;
/**
 * Upper bound on the guide window one request may load. The provider loads the
 * window for EVERY visible channel (ChannelIds only filters afterwards), with no
 * row limit, and caches each window: at ~1.3k channels a 15-day span is ~1M rows
 * per request. 48 h keeps a request near the classic 27 h guide; clients scroll
 * further by moving the window, not widening it.
 */
export const MAX_WINDOW_MS = 48 * HOUR_MS;

export type SortOrder = 'Ascending' | 'Descending';

export interface ContentFlagFilters {
    isMovie?: boolean;
    isSeries?: boolean;
    isNews?: boolean;
    isKids?: boolean;
    isSports?: boolean;
}

export interface ProgramQuery extends ContentFlagFilters {
    /** Raw ChannelIds tokens as sent (placeholders like "null" not yet removed). */
    channelIdSources: string[];
    minStartDate?: Date;
    maxStartDate?: Date;
    minEndDate?: Date;
    maxEndDate?: Date;
    hasAired?: boolean;
    isAiring?: boolean;
    genres: string[];
    startIndex: number;
    limit: number;
    /** True when the client sent a Limit (Recommended applies its own default otherwise). */
    limitGiven: boolean;
    sortBy: string[];
    sortOrder: SortOrder[];
    enableTotalRecordCount: boolean;
}

/** One guide entry plus the channel facts its DTO and filters need. */
export interface ProgramEntry {
    program: LiveTvFeedProgram;
    channelName: string;
    hasLogo: boolean;
    category: string | undefined;
}

/** `true`/`false` (any case) → boolean; anything else → undefined (filter not applied). */
export function parseBool(raw: unknown): boolean | undefined {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw !== 'string') return undefined;
    const lower = raw.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return undefined;
}

function parseDate(raw: unknown): Date | undefined {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms) : undefined;
}

function parseNonNegativeInt(raw: unknown): number | undefined {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined;
}

function clampLimit(raw: unknown): { limit: number; limitGiven: boolean } {
    const n = parseNonNegativeInt(raw);
    if (n === undefined) return { limit: MAX_PROGRAM_LIMIT, limitGiven: false };
    return { limit: Math.min(Math.max(1, n), MAX_PROGRAM_LIMIT), limitGiven: true };
}

/** Comma-delimited and/or repeated query values, trimmed, empties dropped. */
function listParam(url: URL, name: string, separator = ','): string[] {
    return getParamAll(url, name)
        .flatMap((v) => v.split(separator))
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

function stringList(raw: unknown, separator = ','): string[] {
    if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter((v) => v.length > 0);
    if (typeof raw === 'string') {
        return raw
            .split(separator)
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
    }
    return [];
}

function parseSortOrders(values: string[]): SortOrder[] {
    return values.map((v) => (v.toLowerCase() === 'descending' ? 'Descending' : 'Ascending'));
}

export function flagFiltersFromQuery(url: URL): ContentFlagFilters {
    return {
        isMovie: parseBool(getParam(url, 'IsMovie')),
        isSeries: parseBool(getParam(url, 'IsSeries')),
        isNews: parseBool(getParam(url, 'IsNews')),
        isKids: parseBool(getParam(url, 'IsKids')),
        isSports: parseBool(getParam(url, 'IsSports')),
    };
}

/** GET /LiveTv/Programs and /LiveTv/Programs/Recommended query string. */
export function programQueryFromUrl(url: URL): ProgramQuery {
    // Android TV sends channelIds as repeated query params (channelIds=a&channelIds=b),
    // while web clients send a single comma-separated value (channelIds=a,b). Read both.
    return {
        channelIdSources: listParam(url, 'ChannelIds'),
        minStartDate: parseDate(getParam(url, 'MinStartDate')),
        maxStartDate: parseDate(getParam(url, 'MaxStartDate')),
        minEndDate: parseDate(getParam(url, 'MinEndDate')),
        maxEndDate: parseDate(getParam(url, 'MaxEndDate')),
        hasAired: parseBool(getParam(url, 'HasAired')),
        isAiring: parseBool(getParam(url, 'IsAiring')),
        ...flagFiltersFromQuery(url),
        genres: listParam(url, 'Genres', '|'),
        startIndex: parseNonNegativeInt(getParam(url, 'StartIndex')) ?? 0,
        ...clampLimit(getParam(url, 'Limit')),
        sortBy: listParam(url, 'SortBy'),
        sortOrder: parseSortOrders(listParam(url, 'SortOrder')),
        enableTotalRecordCount: parseBool(getParam(url, 'EnableTotalRecordCount')) ?? true,
    };
}

/**
 * Jellyfin's GetProgramsDto (POST body): large ChannelIds lists don't fit a query
 * string, so some clients (e.g. Moonfin above ~1800 chars of joined IDs) switch to
 * POST with a JSON body using the same PascalCase field names as the GET params.
 */
export function programQueryFromBody(body: unknown): ProgramQuery {
    const obj = isRecord(body) ? body : {};
    return {
        channelIdSources: stringList(obj.ChannelIds),
        minStartDate: parseDate(obj.MinStartDate),
        maxStartDate: parseDate(obj.MaxStartDate),
        minEndDate: parseDate(obj.MinEndDate),
        maxEndDate: parseDate(obj.MaxEndDate),
        hasAired: parseBool(obj.HasAired),
        isAiring: parseBool(obj.IsAiring),
        isMovie: parseBool(obj.IsMovie),
        isSeries: parseBool(obj.IsSeries),
        isNews: parseBool(obj.IsNews),
        isKids: parseBool(obj.IsKids),
        isSports: parseBool(obj.IsSports),
        genres: stringList(obj.Genres, '|'),
        startIndex: parseNonNegativeInt(obj.StartIndex) ?? 0,
        ...clampLimit(obj.Limit),
        sortBy: stringList(obj.SortBy),
        sortOrder: parseSortOrders(stringList(obj.SortOrder)),
        enableTotalRecordCount: parseBool(obj.EnableTotalRecordCount) ?? true,
    };
}

/**
 * The guide window to load from the provider for this query. Defaults to the
 * classic now-3h..now+24h guide; explicit date bounds widen or move it, capped
 * at MAX_WINDOW_MS so one request cannot pull the whole EPG table.
 */
export function programWindow(q: ProgramQuery, now: Date): { start: Date; end: Date } {
    const nowMs = now.getTime();
    const lowerBounds = [q.minStartDate, q.minEndDate].filter((d): d is Date => !!d);
    let start = lowerBounds.length
        ? Math.min(...lowerBounds.map((d) => d.getTime()))
        : nowMs - DEFAULT_WINDOW_BEFORE_MS;
    // A program still running can have started long before minEndDate; the
    // provider's range test is overlap-based, so the start bound is enough.
    if (q.hasAired === false || q.isAiring === true) start = Math.max(start, nowMs - HOUR_MS);
    const upperBounds = [q.maxStartDate, q.maxEndDate].filter((d): d is Date => !!d);
    let end = upperBounds.length
        ? Math.max(...upperBounds.map((d) => d.getTime()))
        : Math.max(nowMs, start) + DEFAULT_WINDOW_AFTER_MS;
    if (q.hasAired === true || q.isAiring === true) end = Math.min(end, nowMs + HOUR_MS);
    if (end <= start) end = start + HOUR_MS;
    if (end - start > MAX_WINDOW_MS) {
        // With an explicit upper bound, keep the requested start. Without one the
        // end is anchored to now, so keep the end: a lower bound far in the past
        // must still return the current guide, not an empty window long ago.
        if (upperBounds.length) end = start + MAX_WINDOW_MS;
        else start = end - MAX_WINDOW_MS;
    }
    return { start: new Date(start), end: new Date(end) };
}

/** Category-derived content flags + IsSeries (never set: EPG data carries no series info). */
export function matchesFlagFilters(category: string | undefined, f: ContentFlagFilters): boolean {
    const flags = programFlagsForCategory(category);
    if (f.isMovie !== undefined && flags.IsMovie !== f.isMovie) return false;
    if (f.isSeries !== undefined && f.isSeries !== false) return false;
    const tagFilters: Array<[boolean | undefined, boolean]> = [
        [f.isSports, flags.IsSports],
        [f.isNews, flags.IsNews],
        [f.isKids, flags.IsKids],
    ];
    const wanted = tagFilters.filter(([want]) => want === true);
    if (wanted.length > 0 && !wanted.some(([, has]) => has)) return false;
    if (tagFilters.some(([want, has]) => want === false && has)) return false;
    return true;
}

/** Drop jellyfin-androidtv's placeholder ChannelIds ("null", "undefined", ""). */
export function usableChannelIds(channelIdSources: string[]): string[] {
    return channelIdSources
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id !== 'null' && id !== 'undefined');
}

/** Apply the date, airing and content filters of `q` (channel and window filtering are the caller's). */
export function filterPrograms(
    entries: ProgramEntry[],
    q: ProgramQuery,
    now: Date,
): ProgramEntry[] {
    const nowMs = now.getTime();
    const wantedGenres = q.genres.map((g) => g.toLowerCase());
    return entries.filter(({ program, category }) => {
        const start = Date.parse(program.startTime);
        const end = Date.parse(program.endTime);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        if (q.minStartDate && start < q.minStartDate.getTime()) return false;
        if (q.maxStartDate && start > q.maxStartDate.getTime()) return false;
        if (q.minEndDate && end < q.minEndDate.getTime()) return false;
        if (q.maxEndDate && end > q.maxEndDate.getTime()) return false;
        if (q.hasAired === true && end > nowMs) return false;
        if (q.hasAired === false && end < nowMs) return false;
        const airing = start <= nowMs && nowMs < end;
        if (q.isAiring !== undefined && airing !== q.isAiring) return false;
        if (!matchesFlagFilters(category, q)) return false;
        if (wantedGenres.length > 0) {
            const genres = (program.genres ?? []).map((g) => g.toLowerCase());
            if (!wantedGenres.some((g) => genres.includes(g))) return false;
        }
        return true;
    });
}

type ProgramComparator = (a: ProgramEntry, b: ProgramEntry) => number;

const PROGRAM_SORTS: Record<string, ProgramComparator> = {
    startdate: (a, b) => Date.parse(a.program.startTime) - Date.parse(b.program.startTime),
    sortname: (a, b) => a.program.title.localeCompare(b.program.title),
    name: (a, b) => a.program.title.localeCompare(b.program.title),
    runtime: (a, b) =>
        Date.parse(a.program.endTime) -
        Date.parse(a.program.startTime) -
        (Date.parse(b.program.endTime) - Date.parse(b.program.startTime)),
    premieredate: (a, b) => Date.parse(a.program.startTime) - Date.parse(b.program.startTime),
};

/**
 * Sort by Jellyfin's SortBy/SortOrder lists (unknown keys ignored); StartDate
 * ascending when nothing usable was asked for, as Jellyfin's GetPrograms does.
 * `Random` shuffles. Array#sort is stable, so ties keep the guide's order.
 */
export function sortPrograms(entries: ProgramEntry[], q: ProgramQuery): ProgramEntry[] {
    const keys = q.sortBy.map((k) => k.toLowerCase());
    if (keys.includes('random')) {
        const shuffled = [...entries];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }
    const comparators: ProgramComparator[] = [];
    keys.forEach((key, i) => {
        const cmp = PROGRAM_SORTS[key];
        if (!cmp) return;
        // Jellyfin pairs SortOrder[i] with SortBy[i]; a missing one reuses the first.
        const order = q.sortOrder[i] ?? q.sortOrder[0] ?? 'Ascending';
        comparators.push(order === 'Descending' ? (a, b) => cmp(b, a) : cmp);
    });
    if (comparators.length === 0) comparators.push(PROGRAM_SORTS.startdate);
    return [...entries].sort((a, b) => {
        for (const cmp of comparators) {
            const r = cmp(a, b);
            if (r !== 0) return r;
        }
        return 0;
    });
}

/** The QueryResult paging Jellyfin applies (TotalRecordCount = page length when the count is off). */
export function pageResult<T>(
    items: T[],
    startIndex: number,
    limit: number,
    enableTotalRecordCount: boolean,
): { page: T[]; total: number } {
    const page = items.slice(startIndex, startIndex + limit);
    return { page, total: enableTotalRecordCount ? items.length : page.length };
}

/** Channel lookup tables the program routes attach to each guide entry. */
export function channelInfoMap(
    channels: LiveTvChannel[],
): Map<string, { name: string; hasLogo: boolean; category: string | undefined }> {
    return new Map(
        channels.map((ch) => [
            ch.id,
            { name: ch.name, hasLogo: Boolean(ch.images.primary?.href), category: ch.category },
        ]),
    );
}

/** Suffix of the stand-in program Recommended serves per channel when there is no EPG. */
const SYNTHETIC_PROGRAM_SUFFIX = '-live';

/**
 * The stand-in "On Air" program for a channel without EPG data: the channel's
 * name over the current UTC day. Recommended serves one per channel so the
 * Android TV Live TV row stays visible; Programs/{id} resolves the same id
 * when a client opens one.
 */
export function syntheticLiveProgram(channel: LiveTvChannel, now: Date): LiveTvFeedProgram {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS);
    return {
        id: `${channel.id}${SYNTHETIC_PROGRAM_SUFFIX}`,
        channelId: channel.id,
        title: channel.name,
        startTime: dayStart.toISOString(),
        endTime: dayEnd.toISOString(),
    };
}

/** The channel id inside a synthetic program id, or null for any other id. */
export function channelIdOfSyntheticProgram(programId: string): string | null {
    return programId.endsWith(SYNTHETIC_PROGRAM_SUFFIX)
        ? programId.slice(0, -SYNTHETIC_PROGRAM_SUFFIX.length)
        : null;
}
