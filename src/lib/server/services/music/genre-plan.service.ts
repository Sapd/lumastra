// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { getTracksByGenre, type GenreTrackRow } from '$lib/server/database/queries/music.queries';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary';
import { Logger } from '$lib/server/utils/logger';
import {
    normalizeTitle,
    isVersionTagged,
    collapseTitleVariants,
} from '$lib/server/database/queries/music-title-normalize';

const logger = Logger.for('GenrePlan');

export interface GenrePlanInput {
    recentlyPlayedIds: string[];
    genreCarouselNames: string[];
    /**
     * The viewer's access boundary. The plan's track ids are served back by
     * the genre-section endpoint, so a track the viewer may not play must
     * never be planned.
     */
    access: MediaAccessBoundary;
}

/**
 * A deterministic pseudo-random generator factory. Given a numeric seed it
 * returns a function producing a stable `[0, 1)` sequence. Injectable so the
 * plan is unit-testable and reproducible within the 3-min cache window.
 */
export type RngFactory = (seed: number) => () => number;

/**
 * Default RNG: mulberry32. Tiny, fast, deterministic for a given seed — good
 * enough for shuffling a few dozen track candidates (not cryptographic).
 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * FNV-1a 32-bit string hash — turns the userId+genre key into a stable seed so
 * the same user gets the same shuffle/album-cap for a genre across requests.
 */
function hashSeed(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * The seeded RNG a genre carousel must use — `mulberry32(hashSeed(user::genre))`.
 *
 * Exported so the lazy `/music/sections/genre/{name}` endpoint seeds EXACTLY as
 * `computeGenrePlan` does. It previously fell back to `Math.random`, so that
 * surface reshuffled on every request: the rail changed under the viewer each
 * time they scrolled away and back, and nothing they had just seen was findable
 * again. That contradicted this module's own stated contract (see `hashSeed`) —
 * same user, same genre, same batch across requests.
 *
 * Stability is not staleness: the pool itself moves as tracks are added and as
 * the plan excludes what was recently played, so the rail still evolves — it
 * just stops being random noise per request.
 */
export function genreBatchRng(userId: string, genre: string): () => number {
    return mulberry32(hashSeed(`${userId}::${genre}`));
}

/**
 * Build a per-user plan of track IDs per genre carousel.
 *
 * Runs the same cross-section dedup logic that used to live inline in
 * +page.server.ts: excludes recently-played IDs, enforces a 1-2 tracks
 * per album cap across all genres, dedups on normalized title+artist,
 * shuffles for variety, and caps each genre at 20 IDs. Returns only
 * the track IDs — full hydration happens lazily in the genre endpoint
 * via getTracksByIds.
 *
 * A failure on one genre logs a warning and produces an empty slot for
 * that genre; the rest of the plan is unaffected.
 */
/**
 * Collapse a candidate pool to one representative per normalized
 * title+artist key, preferring the untagged (original) title over a
 * remix/edit/live variant. Ties (equal taggedness, or no title match at all)
 * keep the existing order — the first-seen candidate for that key wins,
 * which for an already-shuffled input means the shuffle order is preserved.
 *
 * Run BEFORE the album-cap/title-dedup keep-scan so that scan only ever sees
 * one candidate per song, and that candidate is the original whenever one is
 * present in the fetched pool.
 *
 * Thin wrapper over the shared `collapseTitleVariants` (also used by the
 * stations queue) — kept as a named local function since call sites here
 * pass `GenreTrackRow[]` and the artist-key convention (`artist_title`
 * lowercased) specific to this module.
 */
function pickOriginalPerTitle(tracks: GenreTrackRow[]): GenreTrackRow[] {
    return collapseTitleVariants(
        tracks,
        (t) => t.title,
        (t) => (t.artist_title ?? '').toLowerCase(),
    );
}

/**
 * The smart per-genre track selection: shuffle a candidate pool for variety,
 * collapse remix/edit/live variants down to their original per song, cap
 * each album to 1-2 tracks, drop duplicate titles, and slice to `limit`.
 * Shared by the initial plan (`computeGenrePlan`) and the lazy "load more"
 * genre endpoint so both surfaces apply identical curation.
 *
 * `rng` is injectable for deterministic tests; defaults to `Math.random`.
 */
export function selectGenreTrackBatch(
    tracks: GenreTrackRow[],
    limit: number,
    rng: () => number = Math.random,
): GenreTrackRow[] {
    const shuffled = [...tracks];
    for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }

    const representatives = pickOriginalPerTitle(shuffled);

    const albumCap = rng() < 0.5 ? 1 : 2;
    const albumCounts = new Map<string, number>();
    const seenTitleKeys = new Set<string>();
    const kept: GenreTrackRow[] = [];

    for (const t of representatives) {
        if (kept.length >= limit) break;

        const albumKey = t.album_id ?? t.id;
        const albumCount = albumCounts.get(albumKey) ?? 0;
        if (albumCount >= albumCap) continue;

        const artist = (t.artist_title ?? '').toLowerCase();
        const titleKey = `${normalizeTitle(t.title)}::${artist}`;
        if (seenTitleKeys.has(titleKey)) continue;

        kept.push(t);
        albumCounts.set(albumKey, albumCount + 1);
        seenTitleKeys.add(titleKey);
    }

    return kept;
}

export async function computeGenrePlan(
    sql: postgres.Sql,
    userId: string,
    input: GenrePlanInput,
    rngFactory: RngFactory = mulberry32,
): Promise<Record<string, string[]>> {
    const { recentlyPlayedIds, genreCarouselNames, access } = input;
    if (genreCarouselNames.length === 0) return {};

    const seenTrackIds = new Set(recentlyPlayedIds);
    // Cross-genre original-preference bookkeeping (A6): for each normalized
    // title+artist key, remember which genre's `kept[]` array holds the
    // accepted entry, at what index, and the accepted GenreTrackRow itself —
    // needed to decide + apply a later swap when an untagged original for
    // the same key turns up in a genre processed afterward. Mirrors the
    // quick-picks swap-in-place strategy, but across genre boundaries
    // instead of buckets.
    const acceptedByTitleKey = new Map<
        string,
        { genre: string; index: number; track: GenreTrackRow }
    >();
    const globalAlbumCounts = new Map<string, number>();

    const plan: Record<string, string[]> = {};

    // Overfetch 2x the per-genre cap (20) so a genre dominated by remixes
    // still has a good chance of the original being in the fetched pool for
    // pickOriginalPerTitle to prefer.
    const GENRE_FETCH_LIMIT = 40;
    const results = await Promise.allSettled(
        genreCarouselNames.map((genre) => getTracksByGenre(sql, genre, access, GENRE_FETCH_LIMIT)),
    );

    for (let i = 0; i < genreCarouselNames.length; i++) {
        const genre = genreCarouselNames[i];
        const result = results[i];
        if (result.status === 'rejected') {
            logger.warn('Genre plan query failed', {
                genre,
                error:
                    result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
            plan[genre] = [];
            continue;
        }

        // Seed a deterministic RNG from userId+genre so the shuffle and album
        // cap are stable for the lifetime of the cached plan (and unit-testable).
        const rng = rngFactory(hashSeed(`${userId}::${genre}`));

        // Shuffle the raw results for variety
        const tracks = [...result.value];
        for (let j = tracks.length - 1; j > 0; j--) {
            const k = Math.floor(rng() * (j + 1));
            [tracks[j], tracks[k]] = [tracks[k], tracks[j]];
        }

        // Collapse remix/edit/live variants to their original before the
        // keep-scan, so the album cap and title dedup below only ever
        // consider one (preferably untagged) candidate per song.
        const representatives = pickOriginalPerTitle(tracks);

        // Single-pass accumulator: apply all dedup/cap rules and commit as we go
        const albumCapForGenre = rng() < 0.5 ? 1 : 2;
        const kept: string[] = [];

        for (const t of representatives) {
            if (kept.length >= 20) break;
            if (seenTrackIds.has(t.id)) continue;

            const artist = (t.artist_title ?? '').toLowerCase();
            const titleKey = `${normalizeTitle(t.title)}::${artist}`;

            const existing = acceptedByTitleKey.get(titleKey);
            if (existing) {
                // Cross-genre original preference (A6): an earlier-processed
                // genre already claimed this song. Swap its entry in place —
                // same genre, same index — only when this candidate is the
                // untagged original, the earlier pick was version-tagged,
                // and both are by the same artist. Genre-tag agreement is
                // NOT required: it's the same song by the same artist, and
                // genre tags on variants of a song are normally identical
                // anyway, so accepting the swap across genres is safe.
                const sameArtist = artist === (existing.track.artist_title ?? '').toLowerCase();
                const canSwap =
                    sameArtist &&
                    isVersionTagged(existing.track.title) &&
                    !isVersionTagged(t.title);
                if (!canSwap) continue; // non-swappable duplicate — drop, as before

                const oldAlbumKey = existing.track.album_id ?? existing.track.id;
                const newAlbumKey = t.album_id ?? t.id;
                if (oldAlbumKey !== newAlbumKey) {
                    const oldCount = globalAlbumCounts.get(oldAlbumKey) ?? 0;
                    if (oldCount > 0) globalAlbumCounts.set(oldAlbumKey, oldCount - 1);
                    globalAlbumCounts.set(
                        newAlbumKey,
                        (globalAlbumCounts.get(newAlbumKey) ?? 0) + 1,
                    );
                    // NOTE: swapping to a different album can leave the
                    // EARLIER genre's per-genre album cap exceeded by one —
                    // the swap replaces a whole song (not just a track ID),
                    // and re-running that genre's scan to re-enforce the cap
                    // isn't worth it for this rare case. Accepted trade-off.
                }
                seenTrackIds.delete(existing.track.id);
                seenTrackIds.add(t.id);
                plan[existing.genre][existing.index] = t.id;
                acceptedByTitleKey.set(titleKey, {
                    genre: existing.genre,
                    index: existing.index,
                    track: t,
                });
                continue; // lives at its existing slot in an earlier genre, not appended here
            }

            const albumKey = t.album_id ?? t.id;
            const albumCount = globalAlbumCounts.get(albumKey) ?? 0;
            if (albumCount >= albumCapForGenre) continue;

            // Accept this track — commit to all dedup sets
            kept.push(t.id);
            seenTrackIds.add(t.id);
            globalAlbumCounts.set(albumKey, albumCount + 1);
            acceptedByTitleKey.set(titleKey, { genre, index: kept.length - 1, track: t });
        }

        plan[genre] = kept;
    }

    return plan;
}
