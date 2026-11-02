// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * integration-watch-history.service.ts — builds the payload of
 * GET /api/v1/integrations/watch-history (one user's history for an external
 * recommender, e.g. a chat bot).
 *
 *  - The target user's CURRENT library-group and age boundary applies, exactly as on
 *    their own Continue Watching row: the caller is an admin token, but what it gets
 *    is what that user could still open.
 *  - `continueWatching` reuses the app's own exact Continue Watching query.
 *  - Bulk-import timestamps (2026-03-31) are reported as `lastWatchedAt: null`.
 *  - In-process cache, 60 s per (user, limit, cursor, days), single-flight; each
 *    replica keeps its own.
 */

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { isUserAdmin } from '$lib/server/auth.js';
import { GenreService } from '$lib/server/services/genre.service.js';
import { getDeniedLibraryGroups } from '$lib/server/cache/library-group-permissions-cache.js';
import {
    BULK_IMPORT_ARTEFACT_END,
    BULK_IMPORT_ARTEFACT_START,
    findWatchHistoryUser,
    getWatchHistoryGenres,
    getWatchHistoryPage,
    getWatchHistoryStats,
    getWatchHistoryTopGenres,
    type WatchHistoryAccess,
    type WatchHistoryCursor,
    type WatchHistoryRow,
    type WatchHistoryUserRow,
} from '$lib/server/database/queries/integration-watch-history.queries.js';
import type {
    WatchHistoryItem,
    WatchHistoryResponse,
} from '$lib/schemas/api-watch-history-integration-responses.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

export const WATCH_HISTORY_CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;
const CONTINUE_WATCHING_LIMIT = 20;
const TOP_GENRES_LIMIT = 10;

export class InvalidWatchHistoryCursorError extends Error {}

// ── Cursor ───────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_MIN_MS = Date.UTC(1970, 0, 1);
const CURSOR_MAX_MS = Date.UTC(2200, 0, 1);

export function encodeWatchHistoryCursor(c: WatchHistoryCursor): string {
    return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Throws {@link InvalidWatchHistoryCursorError} on anything not minted by us. */
export function decodeWatchHistoryCursor(raw: string): WatchHistoryCursor {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        throw new InvalidWatchHistoryCursorError('Malformed cursor');
    }
    const c = parsed as Partial<WatchHistoryCursor> | null;
    if (!c || typeof c.id !== 'string' || !UUID_RE.test(c.id)) {
        throw new InvalidWatchHistoryCursorError('Malformed cursor');
    }
    if (c.t !== null) {
        // Only the exact ISO form we mint, inside a range Postgres accepts — a forged
        // `+275760-…` or `2020` must answer 422, never reach the query as a Date.
        const ms = typeof c.t === 'string' ? Date.parse(c.t) : Number.NaN;
        if (
            Number.isNaN(ms) ||
            ms < CURSOR_MIN_MS ||
            ms > CURSOR_MAX_MS ||
            new Date(ms).toISOString() !== c.t
        ) {
            throw new InvalidWatchHistoryCursorError('Malformed cursor');
        }
    }
    return { t: c.t ?? null, id: c.id.toLowerCase() };
}

// ── Mapping ──────────────────────────────────────────────────────────────────

/** True when `ts` lies in the 2026-03-31 bulk-import window (a sync stamp, not a watch). */
export function isBulkImportArtefact(ts: Date | null): boolean {
    if (!ts) return false;
    const t = ts.getTime();
    return t >= BULK_IMPORT_ARTEFACT_START.getTime() && t < BULK_IMPORT_ARTEFACT_END.getTime();
}

function toDate(v: Date | string | null | undefined): Date | null {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function progressPercent(
    completed: boolean,
    resumeMs: number,
    runtimeMs: number | null,
): number | null {
    if (completed) return 100;
    if (!runtimeMs || runtimeMs <= 0) return null;
    const pct = (resumeMs / runtimeMs) * 100;
    return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

interface ItemInput {
    mediaId: string;
    mediaType: string;
    title: string | null;
    year: number | null;
    seriesId: string | null;
    seriesTitle: string | null;
    seriesYear: number | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    watchedAt: Date | null;
    completed: boolean;
    resumeMs: number;
    runtimeMs: number | null;
}

function toItem(row: ItemInput, genres: Map<string, string[]>): WatchHistoryItem | null {
    const type = row.mediaType.toLowerCase();
    if (type !== 'movie' && type !== 'episode' && type !== 'audiobook') return null;
    const watchedAt = isBulkImportArtefact(row.watchedAt) ? null : row.watchedAt;
    return {
        id: row.mediaId,
        type,
        title: row.title ?? row.seriesTitle ?? '',
        year: row.year ?? row.seriesYear ?? null,
        genres: genres.get(row.seriesId ?? row.mediaId) ?? [],
        series:
            type === 'episode' && row.seriesId
                ? { id: row.seriesId, title: row.seriesTitle ?? '', year: row.seriesYear }
                : null,
        seasonNumber: type === 'episode' ? row.seasonNumber : null,
        episodeNumber: type === 'episode' ? row.episodeNumber : null,
        lastWatchedAt: watchedAt ? watchedAt.toISOString() : null,
        progressPercent: progressPercent(row.completed, row.resumeMs, row.runtimeMs),
        completed: row.completed,
    };
}

function genreName(id: number, name: string | null): string {
    const fromRow = name?.trim();
    if (fromRow) return fromRow;
    const known = GenreService.getGenreName(id);
    return known && known !== 'Unknown' ? known : `Genre ${id}`;
}

async function loadGenres(sql: postgres.Sql, ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const rows = await getWatchHistoryGenres(sql, [...new Set(ids)]);
    for (const r of rows) {
        const list = out.get(r.media_id) ?? [];
        const name = genreName(Number(r.genre_id), r.genre_name);
        if (!list.some((g) => g.toLowerCase() === name.toLowerCase())) list.push(name);
        out.set(r.media_id, list);
    }
    return out;
}

// ── Access boundary of the TARGET user ──────────────────────────────────────

async function accessFor(
    sql: postgres.Sql,
    user: WatchHistoryUserRow,
): Promise<WatchHistoryAccess> {
    const groups = user.groups ?? [];
    const isAdmin = user.is_admin || isUserAdmin(groups);
    const deniedGroupIds = await getDeniedLibraryGroups(sql, { isAdmin, userGroups: groups });
    const ageRating =
        !isAdmin && user.max_age_rating != null
            ? { maxAgeRating: user.max_age_rating, allowUnrated: config.UNRATED_CONTENT_VISIBLE }
            : null;
    return { deniedGroupIds, ageRating };
}

// ── Sections ─────────────────────────────────────────────────────────────────

function rowToInput(r: WatchHistoryRow): ItemInput {
    return {
        mediaId: r.media_id,
        mediaType: r.media_type,
        title: r.title,
        year: r.year,
        seriesId: r.series_id,
        seriesTitle: r.series_title,
        seriesYear: r.series_year,
        seasonNumber: r.season_number,
        episodeNumber: r.episode_number,
        watchedAt: toDate(r.watched_at),
        completed: r.is_watched,
        resumeMs: Number(r.resume_position_ms) || 0,
        runtimeMs: r.runtime_ms == null ? null : Number(r.runtime_ms),
    };
}

async function loadContinueWatching(
    sql: postgres.Sql,
    userId: UserId,
    access: WatchHistoryAccess,
): Promise<ItemInput[]> {
    const [{ getExactContinueWatchingPage }, cw] = await Promise.all([
        import('$lib/server/api/defs/recommendations/continue-watching-page.query.js'),
        import('$lib/server/api/defs/recommendations/continue-watching.js'),
    ]);
    const rows = await getExactContinueWatchingPage(
        userId,
        CONTINUE_WATCHING_LIMIT,
        {
            offset: 0,
            mediaTypes: null,
            staleAfterDays: cw.CW_STALE_AFTER_DAYS,
            audiobookStaleAfterDays: cw.CW_AUDIOBOOK_STALE_AFTER_DAYS,
            minProgressPercent: cw.CW_MIN_PROGRESS_PCT,
        },
        access,
    );
    if (rows.length === 0) return [];

    // The CW row carries no year; one small lookup for the page's items + series.
    const ids = [...new Set(rows.flatMap((r) => [r.media_id, r.series_id ?? r.media_id]))];
    const years = new Map(
        (
            await sql<{ id: string; year: number | null }[]>`
                SELECT id, year FROM media_items WHERE id = ANY(${ids}::uuid[])`
        ).map((r) => [r.id, r.year]),
    );
    return rows.map((r) => ({
        mediaId: r.media_id,
        mediaType: r.media_type,
        title: r.title,
        year: years.get(r.media_id) ?? null,
        seriesId: r.series_id,
        seriesTitle: r.series_name,
        seriesYear: r.series_id ? (years.get(r.series_id) ?? null) : null,
        seasonNumber: r.season_number,
        episodeNumber: r.episode_number,
        watchedAt: toDate(r.last_event_at),
        completed: false,
        resumeMs: Number(r.resume_position_ms) || 0,
        runtimeMs: r.runtime_ms == null ? null : Number(r.runtime_ms),
    }));
}

export interface WatchHistoryParams {
    limit: number;
    cursor: string | undefined;
    days: number;
}

type Sections = Pick<WatchHistoryResponse, 'continueWatching' | 'topGenres' | 'stats'>;
type Page = WatchHistoryResponse['recentlyWatched'];

/**
 * Merge genre ids that share a display name (several providers, movie vs TV ids) by
 * the UNION of their titles, then rank: most titles first, ties by name.
 */
export function rankGenres(
    rows: Array<{ genre_id: number; genre_name: string | null; title_ids: string[] }>,
    limit = TOP_GENRES_LIMIT,
): Array<{ name: string; titles: number }> {
    const merged = new Map<string, { name: string; titles: Set<string> }>();
    for (const r of rows) {
        const name = genreName(Number(r.genre_id), r.genre_name);
        const key = name.toLowerCase();
        const entry = merged.get(key) ?? { name, titles: new Set<string>() };
        for (const id of r.title_ids ?? []) entry.titles.add(id);
        merged.set(key, entry);
    }
    return [...merged.values()]
        .map((g) => ({ name: g.name, titles: g.titles.size }))
        .sort((a, b) => b.titles - a.titles || a.name.localeCompare(b.name))
        .slice(0, limit);
}

/** Continue Watching, top genres and counts — identical for every page of a user. */
async function buildSections(
    sql: postgres.Sql,
    userId: UserId,
    access: WatchHistoryAccess,
    days: number,
): Promise<Sections> {
    const [cwInputs, topGenreRows, stats] = await Promise.all([
        loadContinueWatching(sql, userId, access),
        getWatchHistoryTopGenres(sql, userId, access, days),
        getWatchHistoryStats(sql, userId, access, days),
    ]);
    const genres = await loadGenres(
        sql,
        cwInputs.map((i) => i.seriesId ?? i.mediaId),
    );
    return {
        continueWatching: cwInputs
            .map((i) => toItem(i, genres))
            .filter((i): i is WatchHistoryItem => !!i),
        topGenres: { days, genres: rankGenres(topGenreRows) },
        stats: {
            moviesWatched: Number(stats.movies_watched) || 0,
            episodesWatched: Number(stats.episodes_watched) || 0,
            seriesWatched: Number(stats.series_watched) || 0,
            audiobooksFinished: Number(stats.audiobooks_finished) || 0,
            inProgress: Number(stats.in_progress) || 0,
            activeInWindow: Number(stats.active_in_window) || 0,
            undated: Number(stats.undated) || 0,
            tracksPlayedInWindow: Number(stats.tracks_played_in_window) || 0,
        },
    };
}

/** One keyset page of recentlyWatched. */
async function buildPage(
    sql: postgres.Sql,
    userId: UserId,
    access: WatchHistoryAccess,
    limit: number,
    cursor: WatchHistoryCursor | null,
): Promise<Page> {
    const rows = await getWatchHistoryPage(sql, userId, access, limit, cursor);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(rowToInput);
    const genres = await loadGenres(
        sql,
        page.map((i) => i.seriesId ?? i.mediaId),
    );
    const last = page.at(-1);
    const nextCursor =
        hasMore && last
            ? encodeWatchHistoryCursor({
                  t: last.watchedAt ? last.watchedAt.toISOString() : null,
                  id: last.mediaId,
              })
            : undefined;
    return {
        items: page.map((i) => toItem(i, genres)).filter((i): i is WatchHistoryItem => !!i),
        page: { limit, hasMore, ...(nextCursor ? { nextCursor } : {}) },
    };
}

// ── Cache ────────────────────────────────────────────────────────────────────
//
// Two in-process caches, 60 s each, single-flight, per replica:
//   sections — key (user, days): shared by every page of a crawl;
//   pages    — key (user, limit, CANONICAL cursor): a re-encoded cursor, so equivalent
//              spellings of one cursor share an entry instead of filling the map.
// The TTL starts when a build FINISHES; a rejected build is dropped (next call retries).
// Pagination is best-effort under concurrent viewing: a page built later can reflect
// newer watches than a cached earlier page.

interface Entry<T> {
    expiresAt: number;
    value: Promise<T>;
}

class TtlCache<T> {
    private readonly map = new Map<string, Entry<T>>();

    get(key: string, load: () => Promise<T>): Promise<T> {
        const now = Date.now();
        const hit = this.map.get(key);
        if (hit && hit.expiresAt > now) return hit.value;

        const value = load();
        // In flight: shared by concurrent callers until it settles.
        const entry: Entry<T> = { expiresAt: Number.POSITIVE_INFINITY, value };
        this.map.delete(key);
        this.map.set(key, entry);
        value.then(
            () => {
                entry.expiresAt = Date.now() + WATCH_HISTORY_CACHE_TTL_MS;
            },
            () => {
                if (this.map.get(key) === entry) this.map.delete(key);
            },
        );
        this.evict(now);
        return value;
    }

    private evict(now: number): void {
        if (this.map.size <= CACHE_MAX_ENTRIES) return;
        for (const [k, e] of this.map) {
            if (e.expiresAt <= now) this.map.delete(k);
        }
        // Still full: drop the oldest insertions (Map keeps insertion order).
        for (const k of this.map.keys()) {
            if (this.map.size <= CACHE_MAX_ENTRIES) break;
            this.map.delete(k);
        }
    }

    clear(): void {
        this.map.clear();
    }
}

interface Built<T> {
    data: T;
    /** ISO time the build started reading — the payload's `generatedAt`. */
    builtAt: string;
}

async function stamped<T>(load: () => Promise<T>): Promise<Built<T>> {
    const builtAt = new Date().toISOString();
    return { data: await load(), builtAt };
}

const sectionsCache = new TtlCache<Built<Sections>>();
const pageCache = new TtlCache<Built<Page>>();

/** Test hook. */
export function __resetWatchHistoryCacheForTests(): void {
    sectionsCache.clear();
    pageCache.clear();
}

export type WatchHistoryResult =
    | { ok: true; value: WatchHistoryResponse }
    | { ok: false; reason: 'user_not_found' | 'user_ambiguous' };

/**
 * The payload for `userOrId` (username or UUID). Unknown or deleted users resolve to
 * `user_not_found`; a username matching two accounts case-insensitively (and none
 * exactly) to `user_ambiguous`; a malformed cursor throws
 * {@link InvalidWatchHistoryCursorError}.
 */
export async function getIntegrationWatchHistory(
    sql: postgres.Sql,
    userOrId: string,
    params: WatchHistoryParams,
): Promise<WatchHistoryResult> {
    const cursor = params.cursor ? decodeWatchHistoryCursor(params.cursor) : null;
    const lookup = await findWatchHistoryUser(sql, userOrId);
    if (lookup.kind === 'not_found') return { ok: false, reason: 'user_not_found' };
    if (lookup.kind === 'ambiguous') return { ok: false, reason: 'user_ambiguous' };
    const user = lookup.user;
    const userId = toUserId(user.id);

    let accessPromise: Promise<WatchHistoryAccess> | null = null;
    const access = (): Promise<WatchHistoryAccess> => (accessPromise ??= accessFor(sql, user));

    const pageKey = `${user.id}|${params.limit}|${cursor ? encodeWatchHistoryCursor(cursor) : ''}`;
    const [page, sections] = await Promise.all([
        pageCache.get(pageKey, () =>
            stamped(async () => buildPage(sql, userId, await access(), params.limit, cursor)),
        ),
        sectionsCache.get(`${user.id}|${params.days}`, () =>
            stamped(async () => buildSections(sql, userId, await access(), params.days)),
        ),
    ]);

    return {
        ok: true,
        value: {
            // The older of the two cached parts: what the caller sees is at least this fresh.
            generatedAt: page.builtAt < sections.builtAt ? page.builtAt : sections.builtAt,
            user: { id: user.id, username: user.username, displayName: user.display_name },
            recentlyWatched: page.data,
            ...sections.data,
        },
    };
}
