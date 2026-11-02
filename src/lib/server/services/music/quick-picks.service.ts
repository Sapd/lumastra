// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quick Picks Service
 *
 * Builds a personalized Quick Picks mix for the /music Quick Picks section.
 * Fetches buckets in parallel, deduplicates, interleaves for variety.
 *
 * @module services/music/quick-picks
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { RecentTrackRow } from '$lib/server/database/queries/music.queries.js';
import {
    getMostPlayedTracks,
    getHotThisWeek,
    getHighlyRatedTracks,
    getDeepCutTracks,
    getRandomTracks,
    getTasteSimilarTracks,
    getUnplayedFromLovedAlbums,
    getCoAlbumTracks,
    getTracksNearCentroid,
    getNeverPlayedTracksNearCentroid,
    getNeverPlayedSonicTracksNearCentroid,
    getDislikedTrackIds,
    getPopularHitTracks,
    getForgottenFavouriteTracks,
    getTopPlayedEmbeddings,
    type QuickPickBucket,
    type CentroidNeighborRow,
} from '$lib/server/database/queries/music-quick-picks.queries.js';
import {
    getSonicTastePicks,
    computeSonicTasteVector,
    type SonicTasteVector,
} from '$lib/server/database/queries/sonic-taste.queries.js';
import { getRecentlyPlayedVariants } from '$lib/server/database/queries/music.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { rankWeightedSample } from '$lib/server/utils/rank-weighted-sample.js';
import { config, features } from '$lib/server/config.js';
import { getUserTasteClusters, TOP_N_TRACKS, type TasteCluster } from './taste-clusters.service.js';
import { mmrRerank } from '$lib/utils/mmr.js';
import {
    averageVectors,
    cosineSimilarity,
    parseEmbedding,
} from '$lib/server/utils/embedding-utils.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { effectiveArtistKey as computeEffectiveArtistKey } from '$lib/server/utils/music-artist-key.js';
import {
    trackArtistIdSql,
    trackDisplayArtistSql,
} from '$lib/server/database/queries/fragments/music-artist.fragments.js';
import { trackFilePathJoin } from '$lib/server/database/queries/fragments/music-file-path.fragments.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { filterAccessibleMediaIds } from '$lib/server/utils/media-access-batch.js';
import {
    normalizeTitle,
    isVersionTagged,
} from '$lib/server/database/queries/music-title-normalize.js';

/**
 * Return only the subset of `trackIds` the caller is allowed to see.
 * Single batch query — cheaper than per-track checkMediaAccess for the
 * ~20 tracks Quick Picks returns. The bucket helpers below don't accept
 * access parameters individually (Codex round 6 finding); we post-filter
 * the assembled output instead.
 *
 * This is a thin alias for the shared {@link filterAccessibleMediaIds}. It used
 * to be a hand-rolled duplicate — same fast path, same two SQL fragments, same
 * existence-check side effect — which is exactly the kind of copy the access
 * boundary migration exists to remove.
 *
 * `filterAccessibleMediaIds` now takes a required-by-shape
 * {@link MediaAccessBoundary}, so the legacy pair `getQuickPicks` still threads
 * internally is converted here. The conversion is semantics-preserving for every
 * current caller: all of them source `access` from a `SearchAccessContext`, whose
 * `deniedGroupIds` is null-or-non-empty (never `[]`) and whose `ageRating` is
 * null-or-numeric (never `{ maxAgeRating: null }`) — the two shapes on which
 * the `restrictedAccess` projection would otherwise change the fast path.
 * Migrating `getQuickPicks`' own signature is a separate step.
 */
async function filterAccessibleTrackIds(
    sql: postgres.Sql,
    trackIds: string[],
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<Set<string>> {
    return filterAccessibleMediaIds(
        sql,
        trackIds,
        restrictedAccess({
            deniedGroupIds: access.deniedGroupIds ?? [],
            maxAgeRating: access.ageRating?.maxAgeRating ?? null,
            allowUnrated: access.ageRating?.allowUnrated ?? false,
        }),
    );
}

const logger = Logger.for('QuickPicksService');

export interface TaggedTrack extends RecentTrackRow {
    bucket: QuickPickBucket;
}

/** Bucket fetch order — determines interleave priority */
const BUCKET_ORDER: QuickPickBucket[] = [
    'heavy-rotation',
    'recently-heard',
    'hot-this-week',
    'popular-hits',
    'sonic-taste',
    'taste-similar',
    'new-discovery',
    'sonic-discovery',
    'highly-rated',
    'forgotten-favourites',
    'unplayed-from-loved-albums',
    'co-album',
    'deep-cuts',
    'random',
];

/**
 * Buckets whose picks reflect the user's ACTUAL listening behavior. When a
 * title collision happens here, the incumbent is kept even if it's a remix —
 * that's genuinely what the user plays, not an arbitrary ranking artifact.
 * All other buckets are "discovery" buckets: swappable in favor of the
 * original when a same-artist untagged variant shows up later.
 */
const USER_BEHAVIOR_BUCKETS: ReadonlySet<QuickPickBucket> = new Set([
    'heavy-rotation',
    'hot-this-week',
    'recently-heard',
    'highly-rated',
    'forgotten-favourites',
]);

/** Max tracks from any single artist in the final mix */
const MAX_PER_ARTIST = 2;
/** Max tracks from any single album in the final mix */
const MAX_PER_ALBUM = 1;
/**
 * When the strict caps fail to fill the target, the interleave is allowed to
 * relax — but only by a small amount, never up to the full target. This stops
 * one artist from saturating the carousel just because they dominate every
 * bucket.
 */
const RELAXED_MAX_PER_ARTIST = MAX_PER_ARTIST + 1;
const RELAXED_MAX_PER_ALBUM = MAX_PER_ALBUM + 1;

/**
 * Per-bucket rank decay for weighted sampling.
 * - Sharp (2.0): anchor buckets — top items should dominate.
 * - Medium (1.0): recently-heard rotates naturally via play history.
 * - Flat (0.5): discovery buckets — wide spread.
 *
 * `random` and `co-album` skip sampling — they're already uniformly random
 * from the DB.
 */
const BUCKET_DECAY: Record<QuickPickBucket, number | null> = {
    'heavy-rotation': 2.0,
    'hot-this-week': 2.0,
    'popular-hits': 2.0,
    'highly-rated': 2.0,
    'recently-heard': 1.0,
    'forgotten-favourites': 1.0,
    'unplayed-from-loved-albums': 1.0,
    'taste-similar': 0.5,
    // sonic-taste: null → pre-sorted by cosine distance from the taste vector;
    // do not re-sample, preserve the kNN ordering.
    'sonic-taste': null,
    'deep-cuts': 0.5,
    // new-discovery: null → pre-sampled by per-cluster MMR + album-diversity
    // inside getNewDiscoveryBucket(); don't re-sample here.
    'new-discovery': null,
    // sonic-discovery: null → pre-sampled by MMR + album-diversity inside
    // getSonicDiscoveryBucket(); pinned 24h like new-discovery.
    'sonic-discovery': null,
    'co-album': null,
    random: null,
};

/**
 * Base mix target per bucket. Larger Quick Picks requests scale from this
 * composition so the mix stays balanced.
 *
 * v3.4 (sonic-additive):
 *   - sonic-taste: now ADDITIVE (weight 3, own slot) — no longer replaces
 *     taste-similar. When features.sonicTaste is off both sonic buckets
 *     contribute 0 and taste-similar + new-discovery absorb the carousel.
 *   - taste-similar: reduced 3→2 (kept as coverage safety-net for ~33% of
 *     tracks lacking sonic embeddings).
 *   - new-discovery: reduced 4→3 to fund sonic-discovery.
 *   - sonic-discovery (NEW): 2 — never-played kNN in MSCLAP space, pinned 24h.
 *     Gate: features.sonicTaste; returns [] when sonic coverage thin.
 *
 * v3.5:
 *   - recently-heard retired (weight 3→0) — it duplicates the Recently
 *     Played rail rendered directly above Quick Picks on /music, so its
 *     slots were wasted. Its weight moves to the new popular-hits bucket.
 *   - popular-hits (NEW): 3 — unplayed tracks that are broadly popular per
 *     Last.fm (track_in_artist × artist_global normalized score).
 *   - forgotten-favourites (NEW): 2 — high-play-count tracks not heard in
 *     60+ days (with a skip-dominance guard so soured-on tracks don't
 *     resurface).
 *
 * Signal balance (26-total, ~62% behavioral / ~19% metadata / ~19% sonic):
 *   Behavioral: heavy-rotation(3) + hot-this-week(2) + highly-rated(2) +
 *               unplayed-from-loved-albums(2) + co-album(2) +
 *               popular-hits(3) + forgotten-favourites(2) = 16
 *   Metadata:   taste-similar(2) + new-discovery(3) = 5
 *   Sonic:      sonic-taste(3) + sonic-discovery(2) = 5 (when gate on)
 *
 * v3 retired `random` and `deep-cuts` (weak signals); v3.5 retires
 * `recently-heard` the same way. They stay in the type with weight 0 so the
 * new-user fallback can still build pools from them.
 */
const BASE_BUCKET_TARGET: Record<QuickPickBucket, number> = {
    'heavy-rotation': 3,
    // recently-heard: retired v3.5 — duplicates the Recently Played rail
    // rendered directly above Quick Picks on /music. Weight moved to
    // popular-hits. Stays in the type (weight 0) for the new-user fallback.
    'recently-heard': 0,
    'hot-this-week': 2,
    // popular-hits (NEW v3.5): unplayed tracks that are broadly popular per
    // Last.fm. Absorbs the weight retired from recently-heard.
    'popular-hits': 3,
    // sonic-taste: ADDITIVE — has its own slot regardless of taste-similar.
    // When features.sonicTaste is off, contributes 0 and getScaledBucketTargets
    // rounds it to 0 slots; metadata buckets absorb the carousel.
    'sonic-taste': 3,
    // taste-similar: reduced from 3 to 2. Kept as coverage safety-net for
    // tracks that lack sonic embeddings (~33% of library). Runs unconditionally;
    // no longer suppressed when sonic-taste is active.
    'taste-similar': 2,
    // new-discovery: reduced from 4 to 3 to fund the new sonic-discovery slot.
    'new-discovery': 3,
    // sonic-discovery (NEW): MSCLAP never-played kNN, pinned 24h.
    // Gate: features.sonicTaste. Returns [] when sonic coverage thin.
    'sonic-discovery': 2,
    'highly-rated': 2,
    // forgotten-favourites (NEW v3.5): high-play-count tracks not heard in
    // 60+ days; skip-dominance guard excludes tracks the user soured on.
    'forgotten-favourites': 2,
    'unplayed-from-loved-albums': 2,
    'co-album': 2,
    'deep-cuts': 0,
    random: 0,
};

const BASE_TARGET_COUNT = Object.values(BASE_BUCKET_TARGET).reduce((sum, count) => sum + count, 0);

/**
 * k-means cluster sample over-fetch per cluster. Each candidate row carries
 * its full embedding (~12KB) so MMR can compute candidate-vs-candidate
 * diversity; fetching 15 × k=3 keeps the PG→Node payload under ~550KB per
 * request, which is a ~50% cut from the original 30 without measurable
 * quality loss in MMR's top-3 selection.
 */
const CLUSTER_OVERFETCH = 15;

export function getScaledBucketTargets(targetCount: number): Record<QuickPickBucket, number> {
    const safeTarget = Math.max(1, Math.floor(targetCount));
    const scaled = BUCKET_ORDER.map((bucket) => {
        const exact = (BASE_BUCKET_TARGET[bucket] / BASE_TARGET_COUNT) * safeTarget;
        const whole = Math.floor(exact);
        return {
            bucket,
            count: whole,
            remainder: exact - whole,
        };
    });

    let remaining = safeTarget - scaled.reduce((sum, entry) => sum + entry.count, 0);

    for (const entry of scaled.toSorted((a, b) => b.remainder - a.remainder)) {
        if (remaining <= 0) break;
        // Only redistribute drift to buckets with non-zero base weight,
        // otherwise retired buckets (deep-cuts/random) would silently come back.
        if (BASE_BUCKET_TARGET[entry.bucket] === 0) continue;
        entry.count += 1;
        remaining -= 1;
    }

    return Object.fromEntries(scaled.map(({ bucket, count }) => [bucket, count])) as Record<
        QuickPickBucket,
        number
    >;
}

function getBucketFetchLimit(bucketTarget: number, excludeCount: number): number {
    const safeBucket = Number.isFinite(bucketTarget) && bucketTarget > 0 ? bucketTarget : 1;
    const safeExclude = Number.isFinite(excludeCount) && excludeCount >= 0 ? excludeCount : 0;
    return Math.min(Math.max(safeBucket * 8 + safeExclude, 40), 250);
}

export function getDiversityCaps(targetCount: number): {
    maxPerArtist: number;
    maxPerAlbum: number;
} {
    return {
        maxPerArtist: Math.max(MAX_PER_ARTIST, Math.ceil(targetCount / 12)),
        maxPerAlbum: Math.max(MAX_PER_ALBUM, Math.ceil(targetCount / 32)),
    };
}

function effectiveArtistKey(t: TaggedTrack): string {
    // Pass artist_id as fallbackId so tracks with empty/null artist_title
    // still group under a stable key (the underlying artist row's UUID).
    // The shared util prefers artist_title for everything else so the same
    // artist always hashes the same regardless of whether a row was joined
    // through the album→artist hierarchy or came in as an orphan.
    return computeEffectiveArtistKey({
        id: t.id,
        artistName: t.artist_title,
        fallbackId: t.artist_id,
    });
}

// normalizeTitle is imported from the shared music-title-normalize module.
// It applies a three-pass regex (REMIX_TAG_REGEX + DASH_REMIX_SUFFIX_REGEX +
// BARE_REMIX_SUFFIX_REGEX) and is the single source of truth for title dedup
// across the queue, quick-picks, and playlist-suggestions paths.
// Null/undefined guard: call sites pass `track.title ?? ''`.

/**
 * Interleave tracks from multiple pools, deduplicating by track ID,
 * normalized title (catches remixes), cross-session title cooldown, and
 * per-artist cap.
 * Walks round-robin through pools: pool1[0], pool2[0], ..., pool1[1], pool2[1], ...
 */
export function interleaveAndDedup(
    pools: Partial<Record<QuickPickBucket, TaggedTrack[]>>,
    targetCount: number,
    options: {
        maxPerArtist?: number;
        maxPerAlbum?: number;
        relaxCapsOnShortfall?: boolean;
        relaxedMaxPerArtist?: number;
        relaxedMaxPerAlbum?: number;
        /**
         * Title stems of tracks recently played (past N hours), from
         * getRecentlyPlayedVariants(). When a candidate's normalised title
         * matches a stem in this set, it is suppressed — prevents remix
         * variants of recently-played tracks from re-appearing in the carousel.
         * Pass an empty Set to disable (new-user path, cold start).
         */
        playedTitleStems?: ReadonlySet<string>;
    } = {},
): TaggedTrack[] {
    const result: TaggedTrack[] = [];
    const seenIds = new Set<string>();
    // normalized title -> index of the accepted entry within `result`. Lets a
    // later same-artist original swap out an earlier version-tagged pick in
    // place, rather than only ever dropping later collisions.
    const titleIndex = new Map<string, number>();
    const artistCount = new Map<string, number>();
    const albumCount = new Map<string, number>();
    const maxPerArtist = options.maxPerArtist ?? MAX_PER_ARTIST;
    const maxPerAlbum = options.maxPerAlbum ?? MAX_PER_ALBUM;
    const playedTitleStems = options.playedTitleStems ?? new Set<string>();

    // Order pools by BUCKET_ORDER
    const orderedPools = BUCKET_ORDER.filter((b) => pools[b] && pools[b].length > 0).map((b) => ({
        bucket: b,
        tracks: [...pools[b]!],
    }));

    if (orderedPools.length === 0) return [];

    const maxLen = Math.max(...orderedPools.map((p) => p.tracks.length));

    /**
     * Swap the version-tagged incumbent at `existingIndex` for the untagged
     * `track` in place — same result index, same overall length. Album
     * counters are adjusted since the swapped-in track may belong to a
     * different album than the one it replaces; artist counters are left
     * alone (the same-artist requirement makes them a no-op).
     */
    const swapInPlace = (existingIndex: number, track: TaggedTrack): void => {
        const existing = result[existingIndex];
        seenIds.delete(existing.id);
        seenIds.add(track.id);
        if (existing.album_id !== track.album_id) {
            if (existing.album_id) {
                const prevCount = albumCount.get(existing.album_id) ?? 0;
                if (prevCount > 0) albumCount.set(existing.album_id, prevCount - 1);
            }
            if (track.album_id) {
                albumCount.set(track.album_id, (albumCount.get(track.album_id) ?? 0) + 1);
            }
        }
        result[existingIndex] = track;
    };

    /**
     * `allowAppend = false` restricts a call to the SWAP branch only — no new
     * entry can be pushed onto `result`. Used by the post-fill swap-only pass
     * below, where `result` is already at (or as full as it'll get for)
     * `targetCount` and only length-neutral swaps are safe.
     */
    const tryAddTrack = (
        track: TaggedTrack,
        artistCap: number,
        albumCap: number,
        allowAppend: boolean = true,
    ): boolean => {
        if (seenIds.has(track.id)) return false;

        const normTitle = normalizeTitle(track.title ?? '');
        // Cross-session cooldown: suppress remix variants of recently-played titles.
        if (normTitle && playedTitleStems.size > 0 && playedTitleStems.has(normTitle)) return false;

        if (normTitle && titleIndex.has(normTitle)) {
            const existingIndex = titleIndex.get(normTitle)!;
            const existing = result[existingIndex];
            // Prefer the original over a remix: only when the incumbent is
            // version-tagged, the new candidate is not, they're the same
            // artist, and the incumbent didn't come from a bucket reflecting
            // actual listening behavior (those stay as-is — that's what the
            // user demonstrably plays). When the swap would move the song to
            // a DIFFERENT album, that album must still have room under its
            // own cap — otherwise the swap silently pushes it over.
            const albumsDiffer = existing.album_id !== track.album_id;
            const albumCapOk =
                !albumsDiffer ||
                !track.album_id ||
                (albumCount.get(track.album_id) ?? 0) < albumCap;
            const canSwap =
                !USER_BEHAVIOR_BUCKETS.has(existing.bucket) &&
                isVersionTagged(existing.title ?? '') &&
                !isVersionTagged(track.title ?? '') &&
                effectiveArtistKey(existing) === effectiveArtistKey(track) &&
                albumCapOk;
            if (!canSwap) return false;
            swapInPlace(existingIndex, track);
            return true;
        }

        if (!allowAppend) return false;

        if (track.album_id) {
            const aCount = albumCount.get(track.album_id) ?? 0;
            if (aCount >= albumCap) return false;
        }

        const aKey = effectiveArtistKey(track);
        const artistN = artistCount.get(aKey) ?? 0;
        if (artistN >= artistCap) return false;

        seenIds.add(track.id);
        if (normTitle) titleIndex.set(normTitle, result.length);
        if (track.album_id) {
            albumCount.set(track.album_id, (albumCount.get(track.album_id) ?? 0) + 1);
        }
        artistCount.set(aKey, artistN + 1);
        result.push(track);
        return true;
    };

    const appendFromPools = (artistCap: number, albumCap: number): void => {
        for (let round = 0; round < maxLen && result.length < targetCount; round++) {
            for (const pool of orderedPools) {
                if (round >= pool.tracks.length) continue;
                if (result.length >= targetCount) break;
                tryAddTrack(pool.tracks[round], artistCap, albumCap);
            }
        }
    };

    appendFromPools(maxPerArtist, maxPerAlbum);

    let finalAlbumCap = maxPerAlbum;
    if (options.relaxCapsOnShortfall && result.length < targetCount) {
        const relaxedArtist = options.relaxedMaxPerArtist ?? RELAXED_MAX_PER_ARTIST;
        const relaxedAlbum = options.relaxedMaxPerAlbum ?? RELAXED_MAX_PER_ALBUM;
        appendFromPools(relaxedArtist, relaxedAlbum);
        finalAlbumCap = relaxedAlbum;
    }

    // Swap-only pass: the fill loop above stops entirely the moment
    // `result.length === targetCount`, so a same-artist original arriving in
    // a pool/round that was never reached can't swap out an earlier
    // version-tagged pick. One bounded pass over every pool's full track
    // list (allowAppend=false) gives those late-arriving originals a chance
    // — length-neutral, so it's safe to run even when `result` is already
    // full. Already-considered tracks are idempotent no-ops here (seenIds
    // short-circuits, or the title-collision branch simply re-evaluates the
    // same swap decision).
    for (const pool of orderedPools) {
        for (const track of pool.tracks) {
            tryAddTrack(track, maxPerArtist, finalAlbumCap, false);
        }
    }

    return result;
}

/**
 * Strict global per-artist cap applied AFTER interleave. Tracks beyond the
 * cap are pushed to the tail of the result (preserving total count) so the
 * carousel's *visible* portion never repeats an artist more than `cap` times.
 *
 * Fixes the failure mode where every bucket independently selects the same
 * dominant artist and interleave's per-bucket cap doesn't catch it.
 */
export function applyGlobalArtistCap(
    tracks: TaggedTrack[],
    cap: number = MAX_PER_ARTIST,
): TaggedTrack[] {
    const counts = new Map<string, number>();
    const kept: TaggedTrack[] = [];
    const overflow: TaggedTrack[] = [];
    for (const track of tracks) {
        const key = effectiveArtistKey(track);
        const n = counts.get(key) ?? 0;
        if (n >= cap) {
            overflow.push(track);
        } else {
            counts.set(key, n + 1);
            kept.push(track);
        }
    }
    return [...kept, ...overflow];
}

/**
 * If 3+ consecutive tracks share the same effective artist (including the
 * synthetic "unknown" bucket), move the 3rd one to the end of the list.
 * Single pass, O(n). VA tracks each get a unique `va:${id}` key so this
 * never fires for consecutive compilation tracks (which are different real
 * artists).
 */
export function applyArtistDiversityGuard(tracks: TaggedTrack[]): TaggedTrack[] {
    const result = [...tracks];
    const displaced: TaggedTrack[] = [];

    let i = 0;
    while (i < result.length) {
        if (
            i >= 2 &&
            effectiveArtistKey(result[i]) === effectiveArtistKey(result[i - 1]) &&
            effectiveArtistKey(result[i - 1]) === effectiveArtistKey(result[i - 2])
        ) {
            displaced.push(...result.splice(i, 1));
        } else {
            i++;
        }
    }

    return [...result, ...displaced];
}

function tagTracks(tracks: RecentTrackRow[], bucket: QuickPickBucket): TaggedTrack[] {
    return tracks.map((t) => ({ ...t, bucket }));
}

function isWithinConfiguredDuration(track: RecentTrackRow): boolean {
    const duration = track.runtime_seconds;
    if (duration == null) return true;
    const minSeconds = Math.max(0, config.MUSIC_AUTOPLAY_MIN_TRACK_SECONDS);
    const maxSeconds = Math.max(0, config.MUSIC_AUTOPLAY_MAX_TRACK_SECONDS);
    if (minSeconds > 0 && duration < minSeconds) return false;
    if (maxSeconds > 0 && duration > maxSeconds) return false;
    return true;
}

/**
 * Drop tracks outside the configured autoplay duration window. Exported so
 * callers apply it at POOL-ASSEMBLY time (before interleaveAndDedup spends
 * artist/album cap slots on a candidate that's about to be dropped anyway) —
 * the final filterConfiguredDurations call after interleave is a cheap safety
 * net, not the primary enforcement point.
 */
export function filterConfiguredDurations<T extends RecentTrackRow>(tracks: T[]): T[] {
    return tracks.filter(isWithinConfiguredDuration);
}

/**
 * Distribute `slots` proportionally across buckets sized [s1, s2, ...].
 * Uses largest-remainder rounding so the sum equals `slots` exactly.
 */
export function allocateClusterSlots(sizes: number[], slots: number): number[] {
    const total = sizes.reduce((s, n) => s + n, 0);
    if (total === 0 || slots <= 0) {
        return new Array<number>(sizes.length).fill(0);
    }
    const exact = sizes.map((s) => (s / total) * slots);
    const whole = exact.map(Math.floor);
    let remainder = slots - whole.reduce((s, n) => s + n, 0);
    const order = exact
        .map((e, i) => ({ idx: i, frac: e - Math.floor(e) }))
        .sort((a, b) => b.frac - a.frac);
    for (const { idx } of order) {
        if (remainder <= 0) break;
        whole[idx] += 1;
        remainder -= 1;
    }
    return whole;
}

/**
 * Per-cluster never-played kNN with aggressive album-diversity.
 *
 * The `new-discovery` bucket is the Discover-Weekly analog: pure fresh
 * content biased by taste clusters. Because a user's highest-weight cluster
 * contains many near-identical tracks from a single compilation, naive kNN
 * would return 4 tracks all from the same album. This function enforces at
 * most one track per album (across all returned picks) so untouched
 * compilations can each get representation.
 *
 * Results are pinned for 24h per user via Valkey so the bucket acts like a
 * daily ritual rather than a reroll-on-every-pageload lottery.
 */
async function getNewDiscoveryBucket(
    sql: postgres.Sql,
    userId: UserId,
    clusters: TasteCluster[] | null,
    excludeIds: string[],
    slots: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<TaggedTrack[]> {
    if (slots <= 0) return [];

    const cache = cacheManager.for(CACHE_NAMESPACES.musicNewDiscovery);
    const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const cacheKey = `new-discovery:${dayKey}`;

    // Per-request exclude set — the pinned IDs were computed against a
    // possibly-different exclude set earlier in the day, so re-filter here.
    const excludeSet = new Set(excludeIds);

    // Cache hit → re-fetch row data for the pinned IDs (preserves order).
    let pinnedIds: string[] | null = null;
    try {
        pinnedIds = await cache.get<string[]>(cacheKey, userId);
    } catch {
        // cache read failure — fall through to fresh computation
    }

    if (Array.isArray(pinnedIds) && pinnedIds.length > 0) {
        const rows = await getCentroidRowsByIds(sql, userId, pinnedIds);
        if (rows.length > 0) {
            // Access-control gate: the pin is a 24h artifact, so a library/age
            // change between day N and N+1 must not leak now-forbidden tracks.
            const allowedIds = await filterAccessibleTrackIds(
                sql,
                rows.map((r) => r.id),
                access,
            );
            const byId = new Map(rows.map((r) => [r.id, r]));
            const pinned = pinnedIds
                .map((id) => byId.get(id))
                .filter((r): r is RecentTrackRow => Boolean(r))
                .filter((r) => allowedIds.has(r.id) && !excludeSet.has(r.id))
                // Annotated return rather than `bucket: '…' as QuickPickBucket`:
                // the widening IS load-bearing (without it `bucket` infers as
                // `string` and the array stops being assignable to TaggedTrack[]),
                // but `no-unnecessary-type-assertion` judges the assertion against
                // the immediate receiver only, and it disagrees across
                // environments — the suppressing directive was itself reported as
                // unused in CI while being required locally. A contextual type
                // needs no assertion, so neither side of that fires.
                .map((r): TaggedTrack => ({ ...r, bucket: 'new-discovery' }));

            // The pin shrinks intra-day as excludes accumulate and access
            // changes drop tracks. Top up with fresh never-played neighbours
            // (also access-filtered) so the bucket keeps its target size.
            if (pinned.length >= slots) return pinned;
            const topUp = await computeFreshNewDiscovery(
                sql,
                userId,
                clusters,
                [...excludeIds, ...pinned.map((t) => t.id)],
                slots - pinned.length,
                access,
            );
            const seen = new Set(pinned.map((t) => t.id));
            for (const t of topUp) {
                if (seen.has(t.id)) continue;
                seen.add(t.id);
                pinned.push(t);
                if (pinned.length >= slots) break;
            }
            return pinned;
        }
        // pinned IDs no longer resolvable — fall through to fresh computation
    }

    const selected = await computeFreshNewDiscovery(
        sql,
        userId,
        clusters,
        excludeIds,
        slots,
        access,
    );

    // Pin the selected IDs for 24h.
    if (selected.length > 0) {
        try {
            await cache.set(
                cacheKey,
                selected.map((t) => t.id),
                undefined,
                userId,
            );
        } catch {
            // best-effort pin — a cache write failure just means tomorrow's
            // page-load rerolls, no correctness issue.
        }
    }

    return selected;
}

/**
 * Compute a fresh `new-discovery` selection (kNN → MMR → album-diversity →
 * access gate). Extracted so both the cold path and the cache-hit top-up can
 * share it. Does NOT touch the 24h pin cache — the caller owns pinning.
 *
 * Exported (in addition to being used internally) so tests can regression-test
 * the no-cluster fallback in isolation, without needing to drive the full
 * getQuickPicks pipeline / Valkey pin cache.
 */
export async function computeFreshNewDiscovery(
    sql: postgres.Sql,
    userId: UserId,
    clusters: TasteCluster[] | null,
    excludeIds: string[],
    slots: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<TaggedTrack[]> {
    if (slots <= 0) return [];

    // Fresh computation path.
    let candidates: CentroidNeighborRow[] = [];
    // Tracks whether `candidates` carry real embeddings (so MMR reranking is
    // meaningful) vs. the last-resort zero-embedding fallback below. Every
    // path that reaches the read below assigns it (the catch returns early).
    let candidatesHaveEmbeddings: boolean;

    const hasClusters = Boolean(clusters && clusters.length > 0);
    if (hasClusters && clusters) {
        // Per-cluster kNN on never-played tracks, proportionally allocated
        // over-fetch so MMR + album diversity has a meaningful pool.
        const perCluster = Math.max(slots * 3, Math.ceil(CLUSTER_OVERFETCH / 2));
        const clusterResults = await Promise.all(
            clusters.map(async (c): Promise<CentroidNeighborRow[]> => {
                try {
                    return await getNeverPlayedTracksNearCentroid(
                        sql,
                        userId,
                        c.centroid,
                        excludeIds,
                        perCluster,
                    );
                } catch (err) {
                    logger.warn('new-discovery cluster query failed', {
                        userId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return [];
                }
            }),
        );
        // Dedupe candidates by track id, keeping first occurrence (highest
        // similarity across clusters).
        const seen = new Set<string>();
        for (const batch of clusterResults) {
            for (const row of batch) {
                if (!seen.has(row.id)) {
                    seen.add(row.id);
                    candidates.push(row);
                }
            }
        }
        candidatesHaveEmbeddings = true;
    } else {
        // No clusters (clustering disabled, or the user is below
        // MIN_PLAYS_FOR_CLUSTERING) — average the user's top-played track
        // embeddings into a single centroid and run a NEVER-PLAYED kNN
        // against it. This MUST be a candidate stream distinct from
        // taste-similar's own legacy fallback: taste-similar's single-centroid
        // query (getTasteSimilarTracks) has no never-played filter and is
        // called with an effectively-equal exclude set, so previously both
        // buckets resolved to near-identical top-K rows. Since taste-similar
        // runs first in BUCKET_ORDER, interleaveAndDedup's seenIds swallowed
        // nearly every new-discovery candidate for <10-play users, collapsing
        // the bucket. getNeverPlayedTracksNearCentroid's WHERE clause on
        // user_music_state.play_count guarantees no overlap with tracks the
        // user has already played, which is the actual source of divergence.
        try {
            const topPlayed = await getTopPlayedEmbeddings(sql, userId, TOP_N_TRACKS);
            const vectors = topPlayed
                .map((r) => parseEmbedding(r.embedding))
                .filter(
                    (v): v is number[] => v !== null && v.length > 0 && v.every(Number.isFinite),
                );

            if (vectors.length > 0) {
                const centroid = averageVectors(vectors);
                candidates = await getNeverPlayedTracksNearCentroid(
                    sql,
                    userId,
                    centroid,
                    excludeIds,
                    slots * 6,
                );
                candidatesHaveEmbeddings = true;
            } else {
                // Cold-start edge case: the user has plays but none of them
                // have embeddings at all (e.g. embedding backfill hasn't run
                // yet). No centroid can be computed, so fall back to the
                // legacy single-centroid ordering as a last resort — better
                // than an empty bucket. Note this can't collide with
                // taste-similar in practice: a user with zero embeddable
                // plays gives taste-similar's own centroid CTE nothing to
                // average either, so both buckets degrade toward [] together
                // rather than duplicating rows.
                const singleCentroidRows = await getTasteSimilarTracks(
                    sql,
                    userId,
                    excludeIds,
                    slots * 6,
                );
                candidates = singleCentroidRows.map((r) => ({
                    ...r,
                    embedding: [],
                    similarity: 0,
                }));
                candidatesHaveEmbeddings = false;
            }
        } catch (err) {
            logger.warn('new-discovery single-centroid fallback failed', {
                userId,
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }

    if (candidates.length === 0) return [];

    // MMR re-rank for diversity, then collapse to at-most-one-per-album.
    // Only meaningful when candidates carry real embeddings — the rare
    // zero-embedding last-resort fallback above synthesizes empty embedding
    // arrays (the single-centroid query is already distance-ordered), so
    // cosine similarity is uncomputable → MMR would map every pair to
    // ±Infinity and collapse to a single track. Skip MMR entirely in that
    // case; the candidates are already in the right order.
    const reranked = candidatesHaveEmbeddings
        ? mmrRerank(candidates, {
              count: Math.min(slots * 3, candidates.length),
              relevance: (c) => c.similarity ?? 0,
              similarity: (a, b) =>
                  cosineSimilarity(parseEmbedding(a.embedding), parseEmbedding(b.embedding)),
          })
        : candidates;

    const seenAlbums = new Set<string>();
    const selected: TaggedTrack[] = [];
    for (const row of reranked) {
        if (selected.length >= slots) break;
        // Album-less tracks must not all collapse to one synthetic album key —
        // key them per-track so a library of singles can each get a pick.
        const albumKey = row.album_id ?? `__no_album__:${row.id}`;
        if (seenAlbums.has(albumKey)) continue;
        seenAlbums.add(albumKey);
        selected.push({
            id: row.id,
            title: row.title,
            sort_order: row.sort_order,
            runtime_seconds: row.runtime_seconds,
            custom_poster_url: row.custom_poster_url,
            custom_metadata: row.custom_metadata,
            album_id: row.album_id,
            album_title: row.album_title,
            album_custom_poster_url: row.album_custom_poster_url,
            artist_id: row.artist_id,
            artist_title: row.artist_title,
            last_played_at: row.last_played_at,
            hours_since_played: row.hours_since_played,
            file_path: row.file_path,
            bucket: 'new-discovery',
        });
    }

    if (selected.length === 0) return [];

    // Access-control gate before the pin is written so a forbidden track never
    // becomes a 24h artifact in the first place.
    const allowedIds = await filterAccessibleTrackIds(
        sql,
        selected.map((t) => t.id),
        access,
    );
    return selected.filter((t) => allowedIds.has(t.id));
}

/**
 * Sonic-space discovery bucket — "discover music that SOUNDS like what I love".
 *
 * Never-played kNN in the MSCLAP 1024-dim audio-embedding space, using the
 * user's Rocchio sonic taste vector. Results are MMR-reranked for diversity
 * and collapsed to at-most-one-per-album, then pinned for 24h per user
 * (same treatment as `new-discovery`).
 *
 * Gates:
 *   - Returns [] when `features.sonicTaste` is off.
 *   - Returns [] when `sonicVector` is null (cold start / no sonic coverage).
 *   - Any query failure degrades gracefully to [].
 */
async function getSonicDiscoveryBucket(
    sql: postgres.Sql,
    userId: UserId,
    sonicVector: SonicTasteVector,
    excludeIds: string[],
    slots: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<TaggedTrack[]> {
    if (!features.sonicTaste) return [];
    if (!sonicVector || slots <= 0) return [];

    const cache = cacheManager.for(CACHE_NAMESPACES.musicSonicDiscovery);
    const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const cacheKey = `sonic-discovery:${dayKey}`;

    const excludeSet = new Set(excludeIds);

    // Cache hit — rehydrate pinned IDs.
    let pinnedIds: string[] | null = null;
    try {
        pinnedIds = await cache.get<string[]>(cacheKey, userId);
    } catch {
        // cache read failure — fall through to fresh computation
    }

    if (Array.isArray(pinnedIds) && pinnedIds.length > 0) {
        const rows = await getCentroidRowsByIds(sql, userId, pinnedIds);
        if (rows.length > 0) {
            const allowedIds = await filterAccessibleTrackIds(
                sql,
                rows.map((r) => r.id),
                access,
            );
            const byId = new Map(rows.map((r) => [r.id, r]));
            const pinned = pinnedIds
                .map((id) => byId.get(id))
                .filter((r): r is RecentTrackRow => Boolean(r))
                .filter((r) => allowedIds.has(r.id) && !excludeSet.has(r.id))
                // Contextually typed for the same reason as the 'new-discovery'
                // site above.
                .map((r): TaggedTrack => ({ ...r, bucket: 'sonic-discovery' }));

            if (pinned.length >= slots) return pinned;

            // Top-up from fresh computation.
            const topUp = await computeFreshSonicDiscovery(
                sql,
                userId,
                sonicVector,
                [...excludeIds, ...pinned.map((t) => t.id)],
                slots - pinned.length,
                access,
            );
            const seen = new Set(pinned.map((t) => t.id));
            for (const t of topUp) {
                if (seen.has(t.id)) continue;
                seen.add(t.id);
                pinned.push(t);
                if (pinned.length >= slots) break;
            }
            return pinned;
        }
    }

    const selected = await computeFreshSonicDiscovery(
        sql,
        userId,
        sonicVector,
        excludeIds,
        slots,
        access,
    );

    if (selected.length > 0) {
        try {
            await cache.set(
                cacheKey,
                selected.map((t) => t.id),
                undefined,
                userId,
            );
        } catch {
            // best-effort pin — cache write failure just means the next page-load rerolls
        }
    }

    return selected;
}

/**
 * Fresh sonic-discovery computation (kNN → MMR → album-diversity → access gate).
 * Extracted so both the cold path and the cache-hit top-up share the same logic.
 */
async function computeFreshSonicDiscovery(
    sql: postgres.Sql,
    userId: UserId,
    sonicVector: number[],
    excludeIds: string[],
    slots: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<TaggedTrack[]> {
    if (slots <= 0 || sonicVector.length === 0) return [];

    let candidates: CentroidNeighborRow[];
    try {
        candidates = await getNeverPlayedSonicTracksNearCentroid(
            sql,
            userId,
            sonicVector,
            excludeIds,
            // Over-fetch for MMR + album-diversity.
            Math.min(slots * 6, 120),
        );
    } catch (err) {
        logger.warn('sonic-discovery kNN query failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }

    if (candidates.length === 0) return [];

    // MMR re-rank for candidate diversity.
    const reranked = mmrRerank(candidates, {
        count: Math.min(slots * 3, candidates.length),
        relevance: (c) => c.similarity ?? 0,
        similarity: (a, b) =>
            cosineSimilarity(parseEmbedding(a.embedding), parseEmbedding(b.embedding)),
    });

    // Collapse to at-most-one-per-album.
    const seenAlbums = new Set<string>();
    const selected: TaggedTrack[] = [];
    for (const row of reranked) {
        if (selected.length >= slots) break;
        const albumKey = row.album_id ?? `__no_album__:${row.id}`;
        if (seenAlbums.has(albumKey)) continue;
        seenAlbums.add(albumKey);
        selected.push({
            id: row.id,
            title: row.title,
            sort_order: row.sort_order,
            runtime_seconds: row.runtime_seconds,
            custom_poster_url: row.custom_poster_url,
            custom_metadata: row.custom_metadata,
            album_id: row.album_id,
            album_title: row.album_title,
            album_custom_poster_url: row.album_custom_poster_url,
            artist_id: row.artist_id,
            artist_title: row.artist_title,
            last_played_at: row.last_played_at,
            hours_since_played: row.hours_since_played,
            file_path: row.file_path,
            bucket: 'sonic-discovery',
        });
    }

    if (selected.length === 0) return [];

    // Access gate before writing the pin.
    const allowedIds = await filterAccessibleTrackIds(
        sql,
        selected.map((t) => t.id),
        access,
    );
    return selected.filter((t) => allowedIds.has(t.id));
}

/**
 * Fetch full RecentTrackRow shape for a list of track IDs (order-preserving
 * result is rebuilt by the caller). Used only by the new-discovery 24h-pin
 * cache-hit path to rehydrate pinned picks.
 */
async function getCentroidRowsByIds(
    sql: postgres.Sql,
    userId: UserId,
    trackIds: string[],
): Promise<RecentTrackRow[]> {
    if (trackIds.length === 0) return [];
    return sql<RecentTrackRow[]>`
        SELECT
            track.id,
            track.title,
            track.sort_order,
            track.runtime_seconds,
            track.custom_poster_url,
            COALESCE(track.custom_metadata, '{}'::jsonb) AS custom_metadata,
            album.id AS album_id,
            album.title AS album_title,
            album.custom_poster_url AS album_custom_poster_url,
            ${trackArtistIdSql(sql)} AS artist_id,
            ${trackDisplayArtistSql(sql)} AS artist_title,
            track.created_at::text AS last_played_at,
            NULL::double precision AS hours_since_played,
            mf.file_path AS file_path
        FROM media_items track
        LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        LEFT JOIN user_music_state ums ON ums.track_id = track.id AND ums.user_id = ${userId}
        ${trackFilePathJoin(sql)}
        WHERE track.media_type = 'track'
          AND track.has_files = true
          AND track.id = ANY(${trackIds})
    `;
}

/**
 * Per-cluster taste-similar fetch with MMR diversity within each cluster.
 */
async function getMultiClusterTasteSimilar(
    sql: postgres.Sql,
    userId: UserId,
    clusters: TasteCluster[],
    excludeIds: string[],
    targetSlots: number,
): Promise<TaggedTrack[]> {
    if (clusters.length === 0 || targetSlots <= 0) return [];
    const allocations = allocateClusterSlots(
        clusters.map((c) => c.size),
        targetSlots,
    );

    const perClusterResults = await Promise.all(
        clusters.map(async (cluster, i): Promise<TaggedTrack[]> => {
            const slots = allocations[i];
            if (slots <= 0) return [];
            let candidates: CentroidNeighborRow[];
            try {
                candidates = await getTracksNearCentroid(
                    sql,
                    userId,
                    cluster.centroid,
                    excludeIds,
                    CLUSTER_OVERFETCH,
                );
            } catch (err) {
                // Dimension mismatch, stale cached centroid, or transient pg
                // error — one bad cluster must not kill the whole mix.
                logger.warn('taste-similar cluster query failed', {
                    userId,
                    clusterIndex: i,
                    error: err instanceof Error ? err.message : String(err),
                });
                return [];
            }
            if (candidates.length === 0) return [];
            const reranked = mmrRerank(candidates, {
                count: slots,
                relevance: (c: CentroidNeighborRow) => c.similarity ?? 0,
                // Return the raw result (which may be null) so MMR can apply
                // its "uncomputable similarity ⇒ +Infinity" policy. Replacing
                // null with 0 here would make missing-embedding rows *win*
                // the diversity term.
                similarity: (a: CentroidNeighborRow, b: CentroidNeighborRow) =>
                    cosineSimilarity(parseEmbedding(a.embedding), parseEmbedding(b.embedding)),
            });
            // Strip the heavy embedding/similarity fields before returning —
            // downstream consumers only need the RecentTrackRow shape.
            return reranked.map((row): TaggedTrack => {
                const tagged: TaggedTrack = {
                    id: row.id,
                    title: row.title,
                    sort_order: row.sort_order,
                    runtime_seconds: row.runtime_seconds,
                    custom_poster_url: row.custom_poster_url,
                    custom_metadata: row.custom_metadata,
                    album_id: row.album_id,
                    album_title: row.album_title,
                    album_custom_poster_url: row.album_custom_poster_url,
                    artist_id: row.artist_id,
                    artist_title: row.artist_title,
                    last_played_at: row.last_played_at,
                    hours_since_played: row.hours_since_played,
                    file_path: row.file_path,
                    bucket: 'taste-similar',
                };
                return tagged;
            });
        }),
    );

    return perClusterResults.flat();
}

/**
 * Apply the full set of bucket counts for one request in a single cache
 * GET/MODIFY/SET. Issuing one write per bucket races against itself even
 * within a single replica (each parallel call reads the same initial state
 * and overwrites the others). Cross-replica races are still possible under
 * high concurrency; this is acceptable for best-effort observability.
 */
async function incrementBucketCounters(
    counts: Partial<Record<QuickPickBucket, number>>,
): Promise<void> {
    const entries = Object.entries(counts).filter(([, count]) => (count ?? 0) > 0);
    if (entries.length === 0) return;
    try {
        const cache = cacheManager.for(CACHE_NAMESPACES.musicQuickPicksStats);
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
        const key = `bucket-counts:${today}`;
        const raw = await cache.get<Record<string, number>>(key);
        // Defensive: if the cached value is corrupt (array, primitive, etc.)
        // reset to a fresh counter rather than merging into a weird shape.
        const current: Record<string, number> =
            raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        for (const [bucket, count] of entries) {
            const prev =
                typeof current[bucket] === 'number' && Number.isFinite(current[bucket])
                    ? current[bucket]
                    : 0;
            current[bucket] = prev + (count ?? 0);
        }
        await cache.set(key, current);
    } catch {
        // Counter is best-effort observability — never break the request.
    }
}

/**
 * Build a personalized Quick Picks mix.
 *
 * Mix composition (26 tracks, scales proportionally via getScaledBucketTargets):
 *
 * Behavioral (~62%):
 * - 3 Heavy rotation (all-time most played)
 * - 2 Hot this week (most plays in last 7 days)
 * - 3 Popular hits (unplayed, broadly popular per Last.fm)
 * - 2 Highly rated (rating >= 8)
 * - 2 Forgotten favourites (high play-count, not heard in 60+ days)
 * - 2 Unplayed-from-loved-albums (compilation discovery)
 * - 2 Co-album (siblings of currently-hot tracks)
 *
 * Metadata embedding (~19%):
 * - 2 Taste-similar (k-means clustered + MMR re-rank; fallback to single
 *   centroid for small libraries)
 * - 3 New-discovery (never-played kNN, album-diversity, pinned 24h)
 *
 * Sonic embedding / MSCLAP (~19%, when features.sonicTaste is ON):
 * - 3 Sonic-taste (Rocchio taste vector + NEG_CENTROID_THRESHOLD post-filter)
 * - 2 Sonic-discovery (MSCLAP never-played kNN, MMR, pinned 24h)
 *   When features.sonicTaste is off both sonic buckets contribute 0 and
 *   metadata buckets absorb the carousel.
 *
 * v3.5 changes vs v3.4:
 *   - recently-heard retired — it duplicated the Recently Played rail
 *     rendered directly above Quick Picks on /music. Weight moved to the
 *     new popular-hits bucket.
 *   - New: popular-hits bucket (unplayed tracks broadly popular per
 *     Last.fm — track_in_artist weighted by artist_global popularity).
 *   - New: forgotten-favourites bucket (high-play-count tracks not heard
 *     in 60+ days; skip-dominance guard).
 *
 * v3.4 changes vs v3.3:
 *   - Sonic-taste is now ADDITIVE (own slot), not a 1:1 replacement of
 *     taste-similar. taste-similar runs at reduced weight (2) unconditionally.
 *   - New: sonic-discovery bucket (MSCLAP never-played kNN, same MMR + album
 *     diversity + 24h pin treatment as new-discovery but in sonic space).
 *   - Cross-session title cooldown: remix variants of recently-played tracks
 *     (past 48h) are suppressed via getRecentlyPlayedVariants.
 *   - normalizeTitle now uses the shared three-pass regex module.
 *   - getDislikedTrackIds capped at 500 most-recent entries.
 *
 * New-user fallback: popular hits (when Last.fm data is available) plus
 * random, topped up with deep cuts if popular hits fall short of target;
 * falls back to deep cuts + random unchanged when no popularity data exists.
 */

/**
 * Whether the user has ANY recorded music play history
 * (`user_music_state`). `getQuickPicks` uses this to decide between the
 * personalized/behavioral pipeline and the new-user (deep-cuts + random)
 * fallback; callers that need to know WHICH path was taken — e.g. the
 * `get_music_picks` assistant tool, to annotate cold-start results as
 * non-personalized — can call this directly instead of re-deriving it.
 */
export async function hasMusicListeningHistory(
    sql: postgres.Sql,
    userId: UserId,
): Promise<boolean> {
    const [{ exists }] = await sql<[{ exists: boolean }]>`
        SELECT EXISTS(
            SELECT 1 FROM user_music_state WHERE user_id = ${userId} LIMIT 1
        ) AS exists
    `;
    return exists;
}

export async function getQuickPicks(
    sql: postgres.Sql,
    userId: UserId,
    targetCount: number,
    excludeIds: string[],
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<TaggedTrack[]> {
    const startedAt = Date.now();
    try {
        // Defensive: the default only applies for `undefined`. Explicit
        // null/non-array values would break `new Set(…)` / `.filter(…)`.
        const callerExcludeIds = Array.isArray(excludeIds) ? excludeIds : [];

        // Fix A — merge in disliked tracks (explicit ratings <= 3, explicit
        // skip marks, and skip-dominant behavioral signal with ≥3 plays).
        // Any track in this set never appears in any bucket.
        let dislikedIds: string[] = [];
        try {
            dislikedIds = await getDislikedTrackIds(sql, userId);
        } catch (err) {
            logger.warn('Failed to load disliked track IDs', {
                userId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        const safeExcludeIds = Array.from(new Set([...callerExcludeIds, ...dislikedIds]));
        const bucketTargets = getScaledBucketTargets(targetCount);
        const excludeSet = new Set(safeExcludeIds);
        // Duration filtering happens HERE — at pool-assembly time, before any
        // candidate can consume an artist/album cap slot in interleaveAndDedup.
        // Every call site below feeds directly into tagging/sampling for a
        // bucket pool, so folding filterConfiguredDurations into the shared
        // `exclude` helper guarantees no bucket's pool can contain an
        // out-of-window track. The filterConfiguredDurations calls after
        // interleaveAndDedup (further below) stay in place as a cheap safety
        // net only — they should be a no-op in the common case now.
        const exclude = (rows: RecentTrackRow[]): RecentTrackRow[] =>
            filterConfiguredDurations(rows.filter((r) => !excludeSet.has(r.id)));

        // Check if user has any music play history.
        const hasMusicHistory = await hasMusicListeningHistory(sql, userId);

        const isNewUser = !hasMusicHistory;

        if (isNewUser) {
            const deepCutTarget = Math.ceil(targetCount / 2);
            const randomTarget = Math.max(1, targetCount - deepCutTarget);
            const fetchLimit = Math.min(Math.max(targetCount * 4 + safeExcludeIds.length, 30), 250);
            const [deepCuts, random, popularHits] = await Promise.all([
                getDeepCutTracks(sql, userId, fetchLimit),
                getRandomTracks(sql, userId, fetchLimit),
                getPopularHitTracks(
                    sql,
                    userId,
                    safeExcludeIds,
                    fetchLimit,
                    config.MUSIC_POPULARITY_PRIMARY_SOURCE,
                ),
            ]);

            const filteredPopularHits = exclude(popularHits);
            const popularHitTarget = Math.ceil((targetCount * 2) / 3);

            let pools: Partial<Record<QuickPickBucket, TaggedTrack[]>>;
            if (filteredPopularHits.length > 0) {
                const restTarget = Math.max(1, targetCount - popularHitTarget);
                pools = {
                    'popular-hits': rankWeightedSample(
                        tagTracks(filteredPopularHits, 'popular-hits'),
                        {
                            decay: BUCKET_DECAY['popular-hits']!,
                            count: popularHitTarget * 2,
                        },
                    ),
                    random: tagTracks(exclude(random), 'random').slice(0, restTarget * 2),
                };
                // Top up with deep-cuts only when popular-hits didn't reach the
                // full target — e.g. Last.fm coverage is thin for this library.
                if (filteredPopularHits.length < popularHitTarget) {
                    pools['deep-cuts'] = rankWeightedSample(
                        tagTracks(exclude(deepCuts), 'deep-cuts'),
                        {
                            decay: BUCKET_DECAY['deep-cuts']!,
                            count: deepCutTarget * 2,
                        },
                    );
                }
            } else {
                // No Last.fm popularity data configured/populated — fall back
                // to the original deep-cuts + random cold-start mix unchanged.
                pools = {
                    'deep-cuts': rankWeightedSample(tagTracks(exclude(deepCuts), 'deep-cuts'), {
                        decay: BUCKET_DECAY['deep-cuts']!,
                        count: deepCutTarget * 2,
                    }),
                    random: tagTracks(exclude(random), 'random').slice(0, randomTarget * 2),
                };
            }

            // Derive the relaxed caps FROM the scaled strict caps (+1 each)
            // rather than the flat RELAXED_MAX_PER_ARTIST/ALBUM module
            // constants — those constants don't scale with targetCount, so a
            // large request (e.g. 48) could see a strict cap of 4 but a
            // relaxed cap of only 3, giving the shortfall pass zero headroom
            // exactly when it's needed most.
            const newUserDiversityCaps = getDiversityCaps(targetCount);
            const newUserResult = interleaveAndDedup(pools, targetCount, {
                ...newUserDiversityCaps,
                relaxCapsOnShortfall: true,
                relaxedMaxPerArtist: newUserDiversityCaps.maxPerArtist + 1,
                relaxedMaxPerAlbum: newUserDiversityCaps.maxPerAlbum + 1,
            });

            const newUserAllowedIds = await filterAccessibleTrackIds(
                sql,
                newUserResult.map((t) => t.id),
                access,
            );
            const newUserGuarded = filterConfiguredDurations(
                newUserResult.filter((t) => newUserAllowedIds.has(t.id)),
            );

            // Emit bucket counters even for the fallback path so the admin
            // observability page reflects every Quick Picks request, not just
            // the experienced-user branch.
            const newUserBucketCounts: Partial<Record<QuickPickBucket, number>> = {};
            for (const t of newUserGuarded) {
                newUserBucketCounts[t.bucket] = (newUserBucketCounts[t.bucket] ?? 0) + 1;
            }
            void incrementBucketCounters(newUserBucketCounts);

            logger.info('quick_picks.served', {
                userId,
                path: 'new-user-fallback',
                returned: newUserGuarded.length,
                bucketCounts: newUserBucketCounts,
                durationMs: Date.now() - startedAt,
            });

            return newUserGuarded;
        }

        // Experienced user: parallel fetches for the active buckets.
        const [
            heavyRotation,
            hotThisWeek,
            highlyRated,
            unplayedFromLovedAlbumsRaw,
            popularHits,
            forgottenFavourites,
        ] = await Promise.all([
            getMostPlayedTracks(
                sql,
                userId,
                getBucketFetchLimit(bucketTargets['heavy-rotation'], safeExcludeIds.length),
            ),
            getHotThisWeek(
                sql,
                userId,
                7,
                getBucketFetchLimit(bucketTargets['hot-this-week'], safeExcludeIds.length),
                access.deniedGroupIds,
                access.ageRating,
            ),
            getHighlyRatedTracks(
                sql,
                userId,
                8,
                getBucketFetchLimit(bucketTargets['highly-rated'], safeExcludeIds.length),
            ),
            getUnplayedFromLovedAlbums(
                sql,
                userId,
                safeExcludeIds,
                getBucketFetchLimit(
                    bucketTargets['unplayed-from-loved-albums'],
                    safeExcludeIds.length,
                ),
            ),
            getPopularHitTracks(
                sql,
                userId,
                safeExcludeIds,
                getBucketFetchLimit(bucketTargets['popular-hits'], safeExcludeIds.length),
                config.MUSIC_POPULARITY_PRIMARY_SOURCE,
                access.deniedGroupIds,
                access.ageRating,
            ),
            getForgottenFavouriteTracks(
                sql,
                userId,
                getBucketFetchLimit(bucketTargets['forgotten-favourites'], safeExcludeIds.length),
            ),
        ]);

        // Co-album seed set prefers *current momentum* (hot-this-week) so the
        // bucket responds to recent listening spikes, and unions with
        // heavy-rotation so a quiet week still produces seeds. The SQL dedupes
        // albums via DISTINCT on parent_id, so duplicate track-ID inputs are
        // harmless.
        const heavyRotationIds = heavyRotation.map((t) => t.id);
        const hotThisWeekIds = hotThisWeek.map((t) => t.id);
        const coAlbumSeedIds = Array.from(new Set([...hotThisWeekIds, ...heavyRotationIds]));
        const coAlbumPromise = getCoAlbumTracks(
            sql,
            userId,
            coAlbumSeedIds,
            [...safeExcludeIds, ...heavyRotationIds, ...hotThisWeekIds],
            getBucketFetchLimit(bucketTargets['co-album'], safeExcludeIds.length),
        );

        // Personalized IDs for taste-similar exclusion (avoid recommending
        // tracks already in the personalized buckets). safeExcludeIds is
        // folded in so disliked tracks can't sneak into taste-similar or
        // new-discovery through the kNN path.
        const personalizedIds = Array.from(
            new Set([
                ...safeExcludeIds,
                ...heavyRotation.map((t) => t.id),
                ...hotThisWeek.map((t) => t.id),
                ...highlyRated.map((t) => t.id),
                // popular-hits draws from the same never-played pool as the
                // discovery buckets — exclude its ids so kNN slots aren't
                // wasted on tracks already surfaced as hits.
                ...popularHits.map((t) => t.id),
            ]),
        );

        // Resolve clusters ONCE — both taste-similar and new-discovery
        // buckets need them, and getUserTasteClusters is cached so duplicate
        // calls would be cheap but wasteful.
        let clusters: TasteCluster[] | null = null;
        if (features.musicClustering) {
            try {
                clusters = await getUserTasteClusters(sql, userId);
            } catch (err) {
                logger.warn('Cluster fetch failed; using fallback', {
                    userId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // ---------------------------------------------------------------------------
        // Cross-session title cooldown — suppress remix variants of recently-played
        // tracks. `getRecentlyPlayedVariants` returns SQL-normalised title stems for
        // tracks played in the last 48h. Fail-soft: any error yields an empty set so
        // the carousel is never broken by a cache/DB hiccup.
        // ---------------------------------------------------------------------------
        let playedTitleStems = new Set<string>();
        try {
            const stems = await getRecentlyPlayedVariants(sql, userId, 48);
            playedTitleStems = new Set(stems);
        } catch (err) {
            logger.warn('getRecentlyPlayedVariants failed; skipping title cooldown', {
                userId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // ---------------------------------------------------------------------------
        // Sonic taste vector — computed once and shared between sonic-taste and
        // sonic-discovery buckets so we don't issue two separate Rocchio DB rounds.
        // Returns null when the user has no sonic signal (cold start) — both sonic
        // buckets check for null and gracefully return [].
        // ---------------------------------------------------------------------------
        let sonicVector: SonicTasteVector = null;
        if (features.sonicTaste) {
            try {
                sonicVector = await computeSonicTasteVector(sql, userId);
            } catch (err) {
                logger.warn('computeSonicTasteVector failed; sonic buckets will be empty', {
                    userId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // ---------------------------------------------------------------------------
        // Sonic taste bucket (features.sonicTaste ON only)
        // v3.4: ADDITIVE — runs at its own weight alongside taste-similar.
        // taste-similar is no longer suppressed when sonic picks are available.
        // ---------------------------------------------------------------------------
        const sonicTastePromise = (async (): Promise<TaggedTrack[]> => {
            if (!features.sonicTaste || !sonicVector) return [];
            const slots = bucketTargets['sonic-taste'];
            if (slots <= 0) return [];
            try {
                const rows = await getSonicTastePicks(
                    sql,
                    userId,
                    // Over-fetch so the interleave has room to dedup.
                    Math.min(slots * 3, 60),
                    // getSonicTastePicks now takes a required MediaAccessBoundary.
                    // `access` is still the legacy pair because getQuickPicks and
                    // its bucket helpers are a later module in the migration;
                    // constructing the boundary from a real user's values is 1:1,
                    // so no rows change. Replace with the boundary itself once
                    // getQuickPicks is migrated.
                    restrictedAccess({
                        deniedGroupIds: access.deniedGroupIds ?? [],
                        maxAgeRating: access.ageRating?.maxAgeRating ?? null,
                        allowUnrated: access.ageRating?.allowUnrated ?? false,
                    }),
                );
                return tagTracks(rows, 'sonic-taste').filter((t) => !excludeSet.has(t.id));
            } catch (err) {
                logger.warn('Sonic taste picks failed', {
                    userId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return [];
            }
        })();

        // Multi-cluster taste-similar (with single-centroid fallback).
        // Runs unconditionally at its own (reduced) weight; no longer suppressed
        // when sonic-taste is active. Provides coverage for tracks lacking sonic
        // embeddings (~33% of library) and acts as a safety-net on cold-start.
        const tasteSimilarPromise = (async (): Promise<TaggedTrack[]> => {
            const slots = bucketTargets['taste-similar'] * 2;

            if (clusters && clusters.length > 0) {
                try {
                    return await getMultiClusterTasteSimilar(
                        sql,
                        userId,
                        clusters,
                        personalizedIds,
                        slots,
                    );
                } catch (err) {
                    // Any unexpected failure in the cluster path falls through
                    // to the legacy single-centroid query rather than taking
                    // the whole Quick Picks request down.
                    logger.warn('Multi-cluster taste-similar failed', {
                        userId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            // Legacy fallback: single-centroid pgvector kNN.
            try {
                const rows = await getTasteSimilarTracks(
                    sql,
                    userId,
                    personalizedIds,
                    getBucketFetchLimit(bucketTargets['taste-similar'], safeExcludeIds.length),
                );
                return tagTracks(rows, 'taste-similar');
            } catch (err) {
                logger.warn('Quick picks taste-similar fetch failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
                return [];
            }
        })();

        // New-discovery bucket: metadata kNN, purely untouched content, pinned 24h.
        const newDiscoveryPromise = getNewDiscoveryBucket(
            sql,
            userId,
            clusters,
            // Exclude anything already in the personalized set so we never
            // pin a track that's about to appear in another bucket anyway.
            [...safeExcludeIds, ...personalizedIds],
            bucketTargets['new-discovery'],
            access,
        ).catch((err: unknown) => {
            logger.warn('new-discovery bucket failed', {
                userId,
                error: err instanceof Error ? err.message : String(err),
            });
            return [] as TaggedTrack[];
        });

        // Sonic-discovery bucket: MSCLAP kNN, never-played, pinned 24h.
        // Shares the pre-computed sonicVector; returns [] when sonic is off or
        // coverage is thin.
        const sonicDiscoveryPromise = getSonicDiscoveryBucket(
            sql,
            userId,
            sonicVector,
            [...safeExcludeIds, ...personalizedIds],
            bucketTargets['sonic-discovery'],
            access,
        ).catch((err: unknown) => {
            logger.warn('sonic-discovery bucket failed', {
                userId,
                error: err instanceof Error ? err.message : String(err),
            });
            return [] as TaggedTrack[];
        });

        const [coAlbumRaw, tasteSimilar, newDiscovery, sonicTaste, sonicDiscovery] =
            await Promise.all([
                coAlbumPromise,
                tasteSimilarPromise,
                newDiscoveryPromise,
                sonicTastePromise,
                sonicDiscoveryPromise,
            ]);

        // Rank-weighted sampling per bucket — replaces Fisher-Yates shuffle.
        const samplePool = (rows: RecentTrackRow[], bucket: QuickPickBucket): TaggedTrack[] => {
            const tagged = tagTracks(exclude(rows), bucket);
            const decay = BUCKET_DECAY[bucket];
            const target = bucketTargets[bucket];
            if (decay === null) return tagged.slice(0, target * 2);
            return rankWeightedSample(tagged, {
                decay,
                count: target * 2,
            });
        };

        // v3.4: sonic-taste is ADDITIVE — it keeps its own slot and taste-similar
        // runs unconditionally at its own (reduced) weight. No 1:1 replacement swap.
        const pools: Partial<Record<QuickPickBucket, TaggedTrack[]>> = {
            'heavy-rotation': samplePool(heavyRotation, 'heavy-rotation'),
            'hot-this-week': samplePool(hotThisWeek, 'hot-this-week'),
            'popular-hits': samplePool(popularHits, 'popular-hits'),
            // Sonic taste picks come pre-ordered by cosine distance — no
            // re-sampling, but still duration-filtered at pool-assembly time
            // (see filterConfiguredDurations doc) so an out-of-window track
            // can't spend an artist/album cap slot before being dropped.
            'sonic-taste': filterConfiguredDurations(sonicTaste).slice(
                0,
                bucketTargets['sonic-taste'] * 2,
            ),
            // taste-similar: pre-tagged tracks, exclude + duration-filter + slice.
            'taste-similar': filterConfiguredDurations(
                tasteSimilar.filter((t) => !excludeSet.has(t.id)),
            ).slice(0, bucketTargets['taste-similar'] * 2),
            // new-discovery and sonic-discovery come pre-tagged (access-gated,
            // MMR-reranked, album-diversity collapsed) — exclude stragglers
            // and duration-filter before they can occupy a cap slot.
            'new-discovery': filterConfiguredDurations(
                newDiscovery.filter((t) => !excludeSet.has(t.id)),
            ),
            'sonic-discovery': filterConfiguredDurations(
                sonicDiscovery.filter((t) => !excludeSet.has(t.id)),
            ),
            'highly-rated': samplePool(highlyRated, 'highly-rated'),
            'forgotten-favourites': samplePool(forgottenFavourites, 'forgotten-favourites'),
            'unplayed-from-loved-albums': samplePool(
                unplayedFromLovedAlbumsRaw,
                'unplayed-from-loved-albums',
            ),
            'co-album': samplePool(coAlbumRaw, 'co-album'),
        };

        // Derive the relaxed caps FROM the scaled strict caps (+1 each) —
        // see the matching comment on the new-user path above. Previously
        // relaxedMaxPerArtist was pinned to the flat RELAXED_MAX_PER_ARTIST
        // (3) and relaxedMaxPerAlbum to a flat 2, so at targetCount=48 (where
        // getDiversityCaps scales maxPerArtist to 4) the "relax" pass was
        // actually BELOW the strict cap and added no headroom at all.
        const diversityCaps = getDiversityCaps(targetCount);
        const interleaved = interleaveAndDedup(pools, targetCount, {
            ...diversityCaps,
            relaxCapsOnShortfall: true,
            relaxedMaxPerArtist: diversityCaps.maxPerArtist + 1,
            // Allow a slightly wider per-album cap on relax so loved-album
            // tracks aren't all squeezed out by the strict per-album limit.
            relaxedMaxPerAlbum: diversityCaps.maxPerAlbum + 1,
            // Cross-session title cooldown: suppress remix variants of recently-played tracks.
            playedTitleStems,
        });

        const capped = applyGlobalArtistCap(interleaved, MAX_PER_ARTIST);
        const guarded = filterConfiguredDurations(applyArtistDiversityGuard(capped));

        // Final access gate: drop any track the caller is no longer allowed
        // to see (library group restrictions / age policy). Single batch
        // query against media_items. The bucket helpers don't carry access
        // filters individually; centralizing the gate here keeps the bucket
        // SQL untouched.
        const allowedIds = await filterAccessibleTrackIds(
            sql,
            guarded.map((t) => t.id),
            access,
        );
        const accessGuarded = guarded.filter((t) => allowedIds.has(t.id));

        const bucketCounts: Partial<Record<QuickPickBucket, number>> = {};
        for (const t of accessGuarded) {
            bucketCounts[t.bucket] = (bucketCounts[t.bucket] ?? 0) + 1;
        }

        // Fire-and-forget telemetry — single batched write avoids the
        // per-bucket get/modify/set race.
        void incrementBucketCounters(bucketCounts);

        logger.info('quick_picks.served', {
            userId,
            path: 'experienced',
            returned: accessGuarded.length,
            bucketCounts,
            durationMs: Date.now() - startedAt,
        });

        return accessGuarded;
    } catch (err) {
        logger.error('Failed to build quick picks', err as Error);
        return [];
    }
}
