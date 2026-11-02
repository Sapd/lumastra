// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which genre rails a viewer's Music home shows, and in what order.
 *
 * Replaces a hardcoded eight-name list that predated this library having 399
 * genres. On the production library that list produced a Classical rail off 51
 * tracks while omitting Trance (1,848 tracks), Dance (2,381) and Hard Rock
 * (1,811) — a taxonomy describing some other collection.
 *
 * ## The score
 *
 * Library size is the PRIOR, listening is the EVIDENCE:
 *
 *     s_lib(g) = track_count(g) / Σ track_count over eligible genres
 *     score(g) = ( c_u(g) + K · s_lib(g) ) / ( C_u + K )
 *
 * where `c_u(g)` is the album-capped listening weight from
 * {@link getUserGenreAffinity} and `C_u` is its total. The denominator is
 * constant per user so it does not affect ORDER — it is kept so the number is a
 * comparable posterior share worth logging.
 *
 * `K = 40` against a per-album cap of 6 means roughly seven fully-played albums
 * of history before a viewer's taste outweighs raw library size. That is the one
 * tuning knob and it has a plain-English meaning; change it deliberately.
 *
 * **Cold start is not a branch.** With no plays every `c_u(g)` is 0 and the
 * score collapses to `s_lib(g)` — pure library ordering. That matters more than
 * it sounds: on this deployment most accounts have little or no listening
 * history, so the prior IS the common path, not a fallback.
 *
 * ## Why not embeddings
 *
 * `media_audio_embeddings` covers 99.98% of tracks and is tempting. Measured, a
 * per-genre CLAP centroid over the eligible set costs ~380ms per access scope
 * and mostly re-derives the same ordering the listening history already gives,
 * at ~16x the cost. Sonic adjacency earns its keep on the OPPOSITE problem —
 * surfacing a genre with ZERO plays — which is a separate rail, not this
 * ordering function. Text embeddings are worse than useless here: the embedded
 * document contains the genre string, so ranking genres by it is circular.
 */

import type { Sql } from 'postgres';
import type { MusicGenreRow, UserGenreAffinityRow } from '../../database/queries/music.queries.js';
import { getUserGenreAffinity } from '../../database/queries/music.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '../../cache/index.js';
import {
    scopedCacheKey,
    searchAccessBoundary,
    type SearchAccessContext,
} from '../../utils/search-access-context.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('GenreRanker');

/** Genres smaller than this cannot sustain a rail — see {@link ELIGIBILITY}. */
const MIN_TRACKS = 120;
const MIN_ALBUMS = 8;

/** Prior strength. ~7 fully-played albums of history to outweigh library size. */
const PRIOR_STRENGTH = 40;

/** Default rail count, matching what both surfaces rendered before. */
const DEFAULT_LIMIT = 8;

/** At most this many rails may share a head token ("Rock", "Hard Rock", …). */
const MAX_PER_HEAD_TOKEN = 2;

/**
 * How far a previously-shown rail may slip before it disappears. Hysteresis: a
 * single listening session must not evict a rail the viewer was using.
 */
const HYSTERESIS_SLACK = 4;

export const ELIGIBILITY = { MIN_TRACKS, MIN_ALBUMS } as const;

export interface GenreRail {
    /** Normalised key — stable across display-variant changes. Use for section ids. */
    key: string;
    /** Display name: the variant carrying the most tracks. */
    title: string;
    /** Every stored spelling folded into this rail, lowercased, for the fetch predicate. */
    variants: string[];
    trackCount: number;
    albumCount: number;
    /** Posterior share. Ordering value; exposed for logging, not for clients. */
    score: number;
    /**
     * Set on the sonic-adjacency rail: a genre the viewer has NEVER played,
     * chosen by audio similarity to what they do play. Rendered with its own
     * title and section id so a client can style or dismiss it separately.
     */
    discovery?: true;
}

/**
 * Fold a genre name to its identity key.
 *
 * Casefold + strip non-alphanumerics. Measured on prod this merges 399 → 388,
 * and every merge is genuinely one genre spelled two ways: `Dance`/`dance`,
 * `Hip Hop`/`Hip-Hop`/`HipHop`, `Eurodance`/`Euro Dance`, `Edm`/`EDM`.
 *
 * Deliberately NOT fuzzy. Trigram or embedding similarity starts folding
 * `Hard Rock` into `Rock`, which destroys real signal — on this library the
 * heavy listener plays those at measurably different rates.
 */
export function genreKey(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface FoldedGenre {
    key: string;
    title: string;
    variants: string[];
    trackCount: number;
    albumCount: number;
}

/**
 * Collapse spelling variants, summing their counts. The display name is the
 * variant with the most tracks, so the rail is labelled the way the library
 * mostly spells it.
 */
export function foldGenres(rows: MusicGenreRow[]): FoldedGenre[] {
    const byKey = new Map<string, FoldedGenre & { topVariantTracks: number }>();
    for (const row of rows) {
        const key = genreKey(row.genre);
        if (!key) continue;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, {
                key,
                title: row.genre,
                variants: [row.genre.toLowerCase()],
                trackCount: row.track_count,
                albumCount: row.album_count,
                topVariantTracks: row.track_count,
            });
            continue;
        }
        existing.trackCount += row.track_count;
        // album_count sums across variants: the same album tagged two ways would
        // be double-counted, but that is rare and only ever helps a genre clear
        // the floor it would clear on tracks anyway.
        existing.albumCount += row.album_count;
        // Deduped: `Dance` and `dance` differ as stored but are one predicate
        // value, and a repeated element would just bloat the ARRAY[...] we build.
        const lowered = row.genre.toLowerCase();
        if (!existing.variants.includes(lowered)) existing.variants.push(lowered);
        if (row.track_count > existing.topVariantTracks) {
            existing.title = row.genre;
            existing.topVariantTracks = row.track_count;
        }
    }
    return [...byKey.values()].map(({ topVariantTracks: _drop, ...rest }) => rest);
}

/** Last word of the display name, lowercased — the diversity axis. */
function headToken(title: string): string {
    const parts = title.trim().toLowerCase().split(/\s+/);
    return parts[parts.length - 1] ?? title.toLowerCase();
}

export interface RankGenreRailsInput {
    /** Access-filtered library genre counts (`getDistinctMusicGenres`). */
    libraryGenres: MusicGenreRow[];
    /** This viewer's album-capped listening weights (`getUserGenreAffinity`). */
    affinity: UserGenreAffinityRow[];
    /** Explicitly pinned genre names — always shown, exempt from gate and cap. */
    pinnedGenreNames?: string[];
    /** Keys shown to this viewer last time, for hysteresis. */
    previousKeys?: string[];
    limit?: number;
}

/**
 * Rank the library's genres for one viewer. Pure — all I/O is the caller's.
 */
export function rankGenreRails(input: RankGenreRailsInput): GenreRail[] {
    const { libraryGenres, affinity, pinnedGenreNames = [], previousKeys = [] } = input;
    const limit = input.limit ?? DEFAULT_LIMIT;

    const folded = foldGenres(libraryGenres);
    const byKey = new Map(folded.map((g) => [g.key, g]));

    // Affinity arrives keyed by raw stored tag; fold it the same way or a
    // viewer's "Hip-Hop" plays would not score the "Hip Hop" rail.
    const weightByKey = new Map<string, number>();
    for (const row of affinity) {
        const key = genreKey(row.genre);
        if (!key) continue;
        weightByKey.set(key, (weightByKey.get(key) ?? 0) + row.weight);
    }

    // A genre too small to refill a rail is worse than no rail: the pool cannot
    // satisfy the carousel without repeating itself, and cross-rail dedup makes
    // it worse. This is also what stops one obsessively-played mini-genre from
    // taking a slot.
    const eligible = folded.filter((g) => g.trackCount >= MIN_TRACKS && g.albumCount >= MIN_ALBUMS);
    if (eligible.length === 0) return [];

    const libTotal = eligible.reduce((sum, g) => sum + g.trackCount, 0) || 1;
    const affinityTotal = [...weightByKey.values()].reduce((sum, w) => sum + w, 0);

    const scored: GenreRail[] = eligible
        .map((g) => {
            const sLib = g.trackCount / libTotal;
            const cU = weightByKey.get(g.key) ?? 0;
            return {
                key: g.key,
                title: g.title,
                variants: g.variants,
                trackCount: g.trackCount,
                albumCount: g.albumCount,
                score: (cU + PRIOR_STRENGTH * sLib) / (affinityTotal + PRIOR_STRENGTH),
            };
        })
        // `key` as the final tiebreaker so equal scores order deterministically
        // rather than by whatever order the DB returned.
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

    // Hysteresis: a rail the viewer saw last time survives if it is still within
    // `limit + HYSTERESIS_SLACK`. Without this, one evening of listening silently
    // reorders the whole tab.
    const rankByKey = new Map(scored.map((g, i) => [g.key, i]));
    const survivors = previousKeys.filter((k) => {
        const rank = rankByKey.get(k);
        return rank !== undefined && rank < limit + HYSTERESIS_SLACK;
    });

    const pinnedKeys = pinnedGenreNames.map(genreKey).filter((k) => byKey.has(k));

    const chosen: GenreRail[] = [];
    const taken = new Set<string>();
    const headCounts = new Map<string, number>();

    const push = (rail: GenreRail, enforceDiversity: boolean): void => {
        if (chosen.length >= limit || taken.has(rail.key)) return;
        const head = headToken(rail.title);
        const used = headCounts.get(head) ?? 0;
        if (enforceDiversity && used >= MAX_PER_HEAD_TOKEN) return;
        chosen.push(rail);
        taken.add(rail.key);
        headCounts.set(head, used + 1);
    };

    // Pinned first and unconditionally — an explicit choice outranks any score,
    // and is exempt from the eligibility gate (a viewer may pin a small genre on
    // purpose).
    for (const key of pinnedKeys) {
        const folded = byKey.get(key);
        if (!folded) continue;
        push({ ...folded, score: Number.POSITIVE_INFINITY }, false);
    }
    for (const key of survivors) {
        const rail = scored.find((g) => g.key === key);
        if (rail) push(rail, true);
    }
    for (const rail of scored) push(rail, true);

    return chosen;
}

interface CachedRails {
    rails: GenreRail[];
    /** Keys that were shown when this entry was written — next day's hysteresis input. */
    prevKeys: string[];
    /** ISO year-week the discovery rail was chosen in, and the genre it chose. */
    discoveryWeek?: string;
    discoveryKey?: string;
}

/**
 * Where the discovery rail sits, and what it costs.
 *
 * Position 4 is above the fold on most clients, so the rail is actually seen;
 * appending a 9th would both dilute the budget and bury it. It displaces the
 * WEAKEST proven-taste rail, which is the right thing to trade exploration
 * against.
 */
const DISCOVERY_SLOT = 3;

/** ISO year-week — the discovery rail's stability bucket. */
function weekKey(now: Date): string {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // ISO: Thursday of the current week decides the year.
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** UTC day bucket. The rail set is fixed for its duration. */
/**
 * Exported so callers can seed rail CONTENT on the same day boundary the rail
 * LIST is cached on. Deriving the two separately would let a rail's items
 * reshuffle at a different moment than the rail set itself.
 */
export function dayKey(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/**
 * The cached, per-viewer rail list both Music surfaces render.
 *
 * Day-bucketed rather than TTL-drifted: a plain TTL would let the rails reorder
 * at an arbitrary moment mid-session, which is the complaint this whole change
 * exists to answer. Yesterday's keys ride along in the entry so today's ranking
 * can apply hysteresis without a second store.
 *
 * Degrades to the library prior (never throws): if the affinity read fails the
 * viewer gets library-ordered rails, which is exactly what a listener with no
 * history sees anyway.
 */
export async function loadGenreRails(
    sql: Sql,
    userId: string,
    accessCtx: SearchAccessContext,
    pinnedGenreNames: string[],
    libraryGenres: MusicGenreRow[],
    now: Date = new Date(),
): Promise<GenreRail[]> {
    const today = dayKey(now);
    const cache = cacheManager.for(CACHE_NAMESPACES.musicGenreRails);
    const key = scopedCacheKey('music-genre-rails', accessCtx, [userId, today]);

    const cached = await cache.get<CachedRails>(key);
    if (cached) return cached.rails;

    // Yesterday's entry, read only for its key list.
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const prev = await cache
        .get<CachedRails>(
            scopedCacheKey('music-genre-rails', accessCtx, [userId, dayKey(yesterday)]),
        )
        .catch(() => null);

    let affinity: UserGenreAffinityRow[] = [];
    try {
        affinity = await getUserGenreAffinity(sql, userId, searchAccessBoundary(accessCtx));
    } catch (error) {
        logger.warn('Genre affinity read failed; ranking on the library prior alone', {
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const rails = rankGenreRails({
        libraryGenres,
        affinity,
        pinnedGenreNames,
        previousKeys: prev?.rails.map((r) => r.key) ?? [],
    });

    const thisWeek = weekKey(now);
    const { rails: withDiscovery, discoveryKey } = await withDiscoveryRail({
        sql,
        userId,
        accessCtx,
        rails,
        libraryGenres,
        affinity,
        // Held for a WEEK, not a day: the point of the rail is that a listener
        // gets to explore a genre. Rotating it daily means nobody ever finishes
        // one. A 7-day hold is its own hysteresis.
        carriedKey: prev?.discoveryWeek === thisWeek ? prev.discoveryKey : undefined,
    });

    void cache.set(key, {
        rails: withDiscovery,
        prevKeys: withDiscovery.map((r) => r.key),
        discoveryWeek: thisWeek,
        discoveryKey,
    } satisfies CachedRails);
    return withDiscovery;
}

/**
 * Insert the sonic-adjacency rail, if this viewer qualifies for one.
 *
 * Displaces rather than appends — see {@link DISCOVERY_SLOT}. Every failure
 * mode here resolves to "no discovery rail": no embeddings, an empty centroid
 * table (the nightly task has never run), too little listening history, a
 * best-match below the confidence floor, or every eligible genre already
 * played. The 8 proven rails are unaffected in all of them, so the page is
 * always complete.
 */
async function withDiscoveryRail(args: {
    sql: Sql;
    userId: string;
    accessCtx: SearchAccessContext;
    rails: GenreRail[];
    libraryGenres: MusicGenreRow[];
    affinity: UserGenreAffinityRow[];
    carriedKey?: string;
}): Promise<{ rails: GenreRail[]; discoveryKey?: string }> {
    const { sql, userId, accessCtx, rails, libraryGenres, affinity, carriedKey } = args;

    const played = new Set(affinity.map((a) => genreKey(a.genre)).filter(Boolean));
    const shown = new Set(rails.map((r) => r.key));
    const candidates = foldGenres(libraryGenres)
        .filter((g) => g.trackCount >= MIN_TRACKS && g.albumCount >= MIN_ALBUMS)
        .filter((g) => !played.has(g.key) && !shown.has(g.key));
    if (candidates.length === 0) return { rails };

    const byKey = new Map(candidates.map((g) => [g.key, g]));

    try {
        // A carried choice costs no query at all — the whole point of the week
        // bucket.
        let chosen = carriedKey ? byKey.get(carriedKey) : undefined;
        if (!chosen) {
            const { getUserGenreAdjacency } =
                await import('../../database/queries/music-genre-centroids.queries.js');
            const match = await getUserGenreAdjacency(
                sql,
                userId,
                candidates.map((g) => g.key),
                searchAccessBoundary(accessCtx),
            );
            if (!match) return { rails };
            chosen = byKey.get(match.genreKey);
        }
        if (!chosen) return { rails };

        const rail: GenreRail = { ...chosen, score: 0, discovery: true };
        const next = [...rails];
        next.splice(DISCOVERY_SLOT, 0, rail);
        return { rails: next.slice(0, rails.length), discoveryKey: chosen.key };
    } catch (error) {
        logger.warn('Sonic discovery rail unavailable; serving proven rails only', {
            error: error instanceof Error ? error.message : String(error),
        });
        return { rails };
    }
}
