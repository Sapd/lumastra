// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Music recommendations: the next track (plus alternatives) for a listening
 * session. Behind POST /music/recommendations.
 *
 * Two retrieval paths: the sonic (MSCLAP audio embedding) path, gated by
 * features.sonicQueue, and the metadata embedding path. Both land in
 * `recommendNext`; the sonic path falls back to the metadata path when it has too
 * few candidates, and the metadata path falls back to a popularity/genre pick when
 * it has none.
 */

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getSmartQueueCandidates,
    getRecentlyPlayedVariants,
    getFallbackCandidates,
    getTrackGenreTags,
    getSessionArtistKeys,
    type QueueCandidateRow,
    type TrackDetailRow,
} from '$lib/server/database/queries/music.queries.js';
import { getDislikedTrackIds } from '$lib/server/database/queries/music-quick-picks.queries.js';
import { config, features } from '$lib/server/config.js';
import { pickAutoNext } from '$lib/server/utils/music-autoplay-pick.js';
import {
    computeGenreStreakProfile,
    genreStreakScoreAdjustment,
    isGenreStreakActive,
    getGenreTags,
    type GenreStreakProfile,
} from '$lib/server/utils/music-genre-streak.js';
import {
    computeBlendCompatibility,
    computeEnergyContinuity,
    mixabilityAdjustment,
    type MixabilityWeights,
} from '$lib/server/utils/music-queue-scoring.js';
import { cosineSimilarity } from '$lib/server/utils/embedding-utils.js';
import { mmrRerank } from '$lib/utils/mmr.js';
import type { MusicTrack } from '$lib/schemas/music.js';
import type { MusicRecommendationsResponse } from '$lib/schemas/api-music-responses.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import {
    getSonicQueueCandidates,
    getMoodVector,
    musicMoodVectorKey,
    type SonicQueueCandidateRow,
    type NowPlayingIntent,
    SONIC_GENRE_OVERLAP_BOOST,
    MANUAL_INTENT_TASTE_MULTIPLIER,
} from '$lib/server/database/queries/sonic-queue.queries.js';
import { computeSonicTasteVector } from '$lib/server/database/queries/sonic-taste.queries.js';
import { getArtistLaneData } from '$lib/server/database/queries/popularity.queries.js';
import {
    computeLaneAffinity,
    laneAffinityAdjustment,
    isVariousArtistsName,
    type ArtistLaneData,
    type LaneComparand,
} from '$lib/server/utils/music-lane-affinity.js';
import {
    toMusicTrack,
    musicArtistDiversityKey,
} from '$lib/server/services/music/track-projection.js';
import { effectiveArtistKey, primaryCreditArtistName } from '$lib/server/utils/music-artist-key.js';
import { isNoveltyCutTitle } from '$lib/shared/music-title-normalize.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { UserContext } from '$lib/server/types';
import type postgres from 'postgres';

const logger = Logger.for('MusicRecommendations');

/**
 * Session-level artist cap: how many recent plays to look back over, and how
 * many times one artist may appear in that window before further tracks by
 * them are deferred.
 *
 * Per-response diversity (pickDiverse/pickDiverseSonic) already caps repeats
 * inside a single payload, but each autoplay hop is an independent request —
 * so nothing counted repeats ACROSS hops, and a seed in a sparse region let
 * the same two nearest artists alternate for a whole session (measured on
 * prod: Rise Anew + Green Harbor took 7 of 8 hops from a Sum 43 seed; Eloren
 * + Sora-Vale 7 of 8 from an Eloren seed).
 *
 * A window of 10 with a cap of 2 still permits the natural "two tracks by an
 * artist you're clearly in the mood for" pattern — YouTube's own mixes do it —
 * while breaking the alternation. The cap is SOFT: both pick helpers defer
 * excluded artists to a fallback pool rather than dropping them, so a genuinely
 * sparse neighbourhood still returns a track instead of nothing.
 */
const SESSION_ARTIST_WINDOW = 10;
const SESSION_ARTIST_MAX = 2;

/**
 * Artists that have already filled their session budget (see
 * SESSION_ARTIST_WINDOW). Counts over the recency-ordered window the client
 * sent, so the cap follows the listening session rather than the library.
 */
export function overplayedSessionArtists(
    windowIds: string[],
    artistKeys: Map<string, string>,
): Set<string> {
    const counts = new Map<string, number>();
    const overplayed = new Set<string>();
    for (const id of windowIds) {
        const key = artistKeys.get(id);
        if (!key) continue;
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        if (next >= SESSION_ARTIST_MAX) overplayed.add(key);
    }
    return overplayed;
}

/**
 * A seed in the form the retrieval queries take: the request's `id` field is
 * mapped onto `artistId` / `albumId` by the caller.
 */
export type RecommendationSeed =
    | { type: 'mood'; mood: string }
    | { type: 'genre'; genre: string }
    | { type: 'artist'; artistId: string }
    | { type: 'album'; albumId: string };

/**
 * The `mood_vectors` key a mood seed looks up, or null for any other seed.
 * The seed carries the bare key from `music/moods`; looking that up unprefixed
 * matched no row, so every mood radio ran without its mood arm.
 */
export function seedMoodVectorKey(seed: RecommendationSeed | null | undefined): string | null {
    return seed?.type === 'mood' && seed.mood ? musicMoodVectorKey(seed.mood) : null;
}

function getEssentia(meta: Record<string, unknown> | undefined): {
    bpm?: number;
    key?: string;
    energy?: number;
} {
    if (!meta) return {};
    const e = meta['essentia'];
    if (!e || typeof e !== 'object') return {};
    return e;
}

/**
 * Last.fm lane-affinity re-rank context (see music-lane-affinity.ts): the
 * current artist's comparand plus fetched lane data for every candidate
 * artist. Null disables the term (no current artist, or fetch failed).
 */
interface SonicLaneContext {
    current: LaneComparand;
    byArtistId: Map<string, ArtistLaneData>;
    weight: number;
}

/**
 * Session same-genre-streak state, threaded into both scoring functions as a
 * soft per-candidate score adjustment (see music-genre-streak.ts).
 */
interface GenreStreakContext {
    profile: GenreStreakProfile;
    weight: number;
    /** false during cold start, a genre-mixed session, or an explicit seed. */
    active: boolean;
}

function getArtist(row: QueueCandidateRow): string {
    return musicArtistDiversityKey(row);
}

function pickDiverse(
    scored: QueueCandidateRow[],
    count: number,
    excludeArtists: Set<string> = new Set(),
    maxPerArtist = 1,
    /** See pickAutoNextSonic — the subset that survives an empty result. */
    hardExcludeArtists: Set<string> = excludeArtists,
): QueueCandidateRow[] {
    const picked: QueueCandidateRow[] = [];
    const artistCounts = new Map<string, number>();
    const deferred: QueueCandidateRow[] = [];

    for (const track of scored) {
        if (picked.length >= count) break;
        const artist = getArtist(track);

        if (excludeArtists.has(artist)) {
            deferred.push(track);
            continue;
        }

        const current = artistCounts.get(artist) ?? 0;
        if (current >= maxPerArtist) continue;

        picked.push(track);
        artistCounts.set(artist, current + 1);
    }

    // TIERED fallback. Dropping straight to the unfiltered pool when every
    // candidate is excluded also drops the hard current-artist rule, which is
    // strictly worse than never having applied the soft session cap: measured
    // on prod, capping both artists in a two-artist neighbourhood turned a
    // clean A>B>A>B alternation into runs of five consecutive tracks by A,
    // because the untiered fallback re-admitted the now-playing artist. Retry
    // with the hard rule alone before giving up on exclusions entirely.
    const softDeferred = deferred.filter((t) => !hardExcludeArtists.has(getArtist(t)));
    const hardDeferred = deferred.filter((t) => hardExcludeArtists.has(getArtist(t)));
    for (const track of [...softDeferred, ...hardDeferred]) {
        if (picked.length >= count) break;
        picked.push(track);
    }

    return picked;
}

function toMusicTrackFromSonic(row: SonicQueueCandidateRow, images: ImageSet): MusicTrack {
    return toMusicTrack(row, images);
}

function getArtistFromSonic(row: SonicQueueCandidateRow): string {
    return musicArtistDiversityKey(row);
}

const SONIC_MAX_PER_ALBUM = 2;

function isWithinDurationBounds(
    runtimeSeconds: number | null | undefined,
    minSeconds: number,
    maxSeconds: number,
): boolean {
    if (runtimeSeconds == null) return true;
    if (minSeconds > 0 && runtimeSeconds < minSeconds) return false;
    if (maxSeconds > 0 && runtimeSeconds > maxSeconds) return false;
    return true;
}

function pickDiverseSonic(
    scored: SonicQueueCandidateRow[],
    count: number,
    excludeArtists: Set<string> = new Set(),
    maxPerArtist = 1,
    maxPerAlbum = SONIC_MAX_PER_ALBUM,
    /** See pickAutoNextSonic — the subset that survives an empty result. */
    hardExcludeArtists: Set<string> = excludeArtists,
): SonicQueueCandidateRow[] {
    const picked: SonicQueueCandidateRow[] = [];
    const artistCounts = new Map<string, number>();
    const albumCounts = new Map<string, number>();
    const deferred: SonicQueueCandidateRow[] = [];

    for (const track of scored) {
        if (picked.length >= count) break;
        const artist = getArtistFromSonic(track);

        if (excludeArtists.has(artist)) {
            deferred.push(track);
            continue;
        }

        const currentArtist = artistCounts.get(artist) ?? 0;
        if (currentArtist >= maxPerArtist) continue;

        if (track.parent_id) {
            const currentAlbum = albumCounts.get(track.parent_id) ?? 0;
            if (currentAlbum >= maxPerAlbum) continue;
            albumCounts.set(track.parent_id, currentAlbum + 1);
        }

        picked.push(track);
        artistCounts.set(artist, currentArtist + 1);
    }

    // TIERED fallback. Dropping straight to the unfiltered pool when every
    // candidate is excluded also drops the hard current-artist rule, which is
    // strictly worse than never having applied the soft session cap: measured
    // on prod, capping both artists in a two-artist neighbourhood turned a
    // clean A>B>A>B alternation into runs of five consecutive tracks by A,
    // because the untiered fallback re-admitted the now-playing artist. Retry
    // with the hard rule alone before giving up on exclusions entirely.
    const softDeferred = deferred.filter((t) => !hardExcludeArtists.has(getArtistFromSonic(t)));
    const hardDeferred = deferred.filter((t) => hardExcludeArtists.has(getArtistFromSonic(t)));
    for (const track of [...softDeferred, ...hardDeferred]) {
        if (picked.length >= count) break;
        picked.push(track);
    }

    return picked;
}

export function pickAutoNextSonic(
    candidates: SonicQueueCandidateRow[],
    excludeArtists: Set<string>,
    topK: number,
    excludeAlbumIds?: Set<string>,
    /**
     * The subset of `excludeArtists` that must still hold when the full set
     * excludes every candidate — in practice the now-playing artist. Defaults
     * to the full set, preserving all-or-nothing behaviour for callers that
     * pass only a hard rule.
     */
    hardExcludeArtists: Set<string> = excludeArtists,
): SonicQueueCandidateRow | null {
    if (candidates.length === 0) return null;

    const albumOk = (c: SonicQueueCandidateRow): boolean =>
        !c.parent_id || !excludeAlbumIds?.has(c.parent_id);

    // Tier the FULL candidate list BEFORE taking top-K.
    //
    // This previously sliced to top-K first and filtered afterwards, so the
    // artist rules could only ever choose among K candidates. In a
    // neighbourhood whose top K are all by one or two artists that leaves
    // nothing to pick — measured on prod, an Eloren seed whose top 5 were all
    // Eloren/Sora-Vale could never reach a third artist even though retrieval had
    // returned 60 candidates. Filtering first promotes a deeper but eligible
    // candidate instead of surrendering the rule.
    //
    // Tier 1: satisfies every rule (hard current-artist + soft session cap).
    // Tier 2: hard rule only — the soft cap is relaxed rather than dropping
    //         the current-artist rule with it.
    // Tier 3: no rules; never strand autoplay with nothing to play.
    const softEligible = candidates.filter(
        (c) => !excludeArtists.has(getArtistFromSonic(c)) && albumOk(c),
    );
    const hardEligible =
        softEligible.length > 0
            ? softEligible
            : candidates.filter(
                  (c) => !hardExcludeArtists.has(getArtistFromSonic(c)) && albumOk(c),
              );
    const source = hardEligible.length > 0 ? hardEligible : candidates;

    const pool = source.slice(0, Math.min(topK, source.length));
    const totalScore = pool.reduce((s, c) => s + c.similarity_score, 0);

    // Degenerate scores (all zero/negative) — weighted sampling is meaningless,
    // so take the best-ranked survivor of the tiering above.
    if (totalScore <= 0) return pool[0] ?? null;

    let rand = Math.random() * totalScore;
    for (const c of pool) {
        rand -= c.similarity_score;
        if (rand <= 0) return c;
    }
    return pool[pool.length - 1] ?? null;
}

function scoreSonicCandidates(
    candidates: SonicQueueCandidateRow[],
    current: { bpm?: number; key?: string; energy?: number },
    currentGenres: string[] | null,
    genreStreak: GenreStreakContext,
    weights: MixabilityWeights,
    lane: SonicLaneContext | null,
): SonicQueueCandidateRow[] {
    return candidates
        .map((c) => {
            const essentia = getEssentia(c.custom_metadata);
            const baseSim = c.similarity_score;

            // Soft mix-compatibility tiebreak (see music-queue-scoring.ts) —
            // replaces the old hard BPM/key/energy reject gate. Similarity
            // decides what plays; this only nudges ordering among near-equal
            // candidates.
            const blendCompat = computeBlendCompatibility(current, essentia);
            const energyContinuity = computeEnergyContinuity(current.energy, essentia.energy);
            const mixAdjustment = mixabilityAdjustment(blendCompat, energyContinuity, weights);

            const candidateGenres = c.genres;
            let genreBoost = 0;
            if (
                currentGenres &&
                currentGenres.length > 0 &&
                candidateGenres &&
                candidateGenres.length > 0
            ) {
                const currentSet = new Set(currentGenres);
                const overlap = candidateGenres.filter((g) => currentSet.has(g)).length;
                genreBoost = (overlap / currentGenres.length) * SONIC_GENRE_OVERLAP_BOOST;
            }

            const streakAdjustment = genreStreak.active
                ? genreStreakScoreAdjustment(
                      candidateGenres,
                      genreStreak.profile,
                      genreStreak.weight,
                  )
                : 0;

            // Last.fm scene/lane term (music-lane-affinity.ts): centered
            // ±weight — same-scene artists boosted, disjoint scenes demoted,
            // unknown (no Last.fm data / no resolvable artist) neutral. This
            // is the dimension audio similarity can't hear: a hands-up remix
            // and French electro-house sound alike in MSCLAP space.
            const laneAdjustment = lane
                ? laneAffinityAdjustment(
                      computeLaneAffinity(lane.current, {
                          name: c.resolved_artist,
                          lane: c.resolved_artist_id
                              ? (lane.byArtistId.get(c.resolved_artist_id) ?? null)
                              : null,
                      }),
                      lane.weight,
                  )
                : 0;

            return {
                ...c,
                // Sum every term before clamping (a per-term clamp would
                // silently cap out high-similarity candidates before the
                // streak adjustment could reorder them). Floored at 0 so a
                // streak penalty can never produce a negative weight for
                // pickAutoNextSonic's weighted sampling.
                similarity_score: Math.max(
                    Math.min(
                        baseSim + genreBoost + streakAdjustment + mixAdjustment + laneAdjustment,
                        1.0,
                    ),
                    0,
                ),
            };
        })
        .sort((a, b) => b.similarity_score - a.similarity_score);
}

function scoreCandidates(
    candidates: QueueCandidateRow[],
    current: { bpm?: number; key?: string; energy?: number },
    currentGenres: string[] | null,
    genreStreak: GenreStreakContext,
    weights: MixabilityWeights,
): QueueCandidateRow[] {
    return candidates
        .map((c) => {
            const essentia = getEssentia(c.custom_metadata);

            // See scoreSonicCandidates for why this replaces the old hard
            // BPM/key/energy reject gate with a soft tiebreak.
            const blendCompat = computeBlendCompatibility(current, essentia);
            const energyContinuity = computeEnergyContinuity(current.energy, essentia.energy);
            const mixAdjustment = mixabilityAdjustment(blendCompat, energyContinuity, weights);

            const streakAdjustment = genreStreak.active
                ? genreStreakScoreAdjustment(
                      getGenreTags(c.custom_metadata),
                      genreStreak.profile,
                      genreStreak.weight,
                  )
                : 0;

            return {
                ...c,
                // Clamp [0, 1] like the sonic path — downstream weighted
                // sampling and MMR assume a bounded score.
                similarity_score: Math.max(
                    Math.min(c.similarity_score + streakAdjustment + mixAdjustment, 1.0),
                    0,
                ),
            };
        })
        .sort((a, b) => b.similarity_score - a.similarity_score);
}

export interface RecommendNextParams {
    /** The track playing now, already access-checked by the caller. */
    currentTrack: TrackDetailRow;
    exclude: string[];
    /** Newest first. */
    history: string[];
    skipped: string[];
    /** Tracks the listener queued after the current one. */
    upcoming: string[];
    seed?: RecommendationSeed;
    /** false = the client hard-cuts; absent = assumed capable. */
    crossfade?: boolean;
    startedBy?: 'user' | 'autoplay';
}

/**
 * Picks the next track and up to three alternatives. Never throws for "nothing
 * fits": `next` is then absent.
 */
export async function recommendNext(
    sql: postgres.Sql,
    user: UserContext,
    surface: ApiSurface,
    params: RecommendNextParams,
): Promise<MusicRecommendationsResponse> {
    const { currentTrack, seed } = params;
    const trackId = currentTrack.id;
    const excludeIds = params.exclude;
    const sessionTrackIds = params.history;
    const skippedTrackIds = params.skipped;
    // The current track first, then the queued tracks: the same centroid input
    // the legacy `recentQueue` carried (capped at five).
    const recentQueueIds = [trackId, ...params.upcoming].slice(0, 5);

    const allExcludeIds = [...new Set([...excludeIds, ...sessionTrackIds])];

    // One boundary for every access-filtered branch of this route: the
    // sonic SQL path (getSonicQueueCandidates) and the metadata
    // fallback's JS post-filter (filterAccessibleRows). Built from the
    // real user via searchAccessBoundary — never a hand-rolled
    // { deniedGroupIds, ageRating } literal, which is exactly the
    // permissive-by-default shape the boundary type replaces.
    const accessBoundary = searchAccessBoundary(await buildSearchAccessContext(sql, user));

    const currentMeta = currentTrack.custom_metadata;
    const currentEssentia = getEssentia(currentMeta ?? undefined);
    const currentBpm = currentEssentia.bpm;
    const currentKey = currentEssentia.key;
    const currentEnergy = currentEssentia.energy;
    const currentGenreTags = getGenreTags(currentMeta);
    // BPM/key blend tiebreak is meaningless for a client that never
    // crossfades (hard-cut playback) — see music-queue-scoring.ts.
    // Energy continuity still applies either way.
    const weights: MixabilityWeights = {
        blendWeight: params.crossfade === false ? 0 : config.MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT,
        energyWeight: config.MUSIC_AUTOPLAY_ENERGY_FLOW_WEIGHT,
    };
    const minTrackSeconds = config.MUSIC_AUTOPLAY_MIN_TRACK_SECONDS;
    const maxTrackSeconds = config.MUSIC_AUTOPLAY_MAX_TRACK_SECONDS;
    // MUST resolve the same way as musicArtistDiversityKey (candidates)
    // and getSessionArtistKeys (history) — a credit-derived key on one
    // side and a display-derived key on the other silently no-ops both
    // the hard current-artist rule and the session cap.
    const currentArtist = effectiveArtistKey({
        id: currentTrack.id,
        artistName:
            primaryCreditArtistName(currentTrack.track_artists) ??
            currentTrack.artist_title ??
            (currentMeta?.artist as string | undefined) ??
            (currentMeta?.album_artist as string | undefined),
        fallbackId: currentTrack.parent_id ?? undefined,
    });

    // Recent session plays, most-recent-first, for genre-streak
    // detection. The web client sends `history` newest-first (see
    // historyWithOutgoing in music-player.store.ts), so the head
    // holds the freshest plays. (This previously took .slice(-4)
    // .reverse() under an oldest-first assumption, which computed
    // the streak from the session's OLDEST plays — neutering the
    // lane-keeping signal exactly when a long session drifted.)
    // Deduped: a track played twice recently would otherwise count
    // its genre tags at two decay ranks and inflate streak cohesion
    // off a single repeated track. Set preserves first (= freshest)
    // occurrence order.
    const recentHistoryIds = [...new Set(sessionTrackIds)]
        .filter((id) => id !== trackId)
        .slice(0, 4);

    const cooldownHours = config.MUSIC_AUTOPLAY_COOLDOWN_HOURS;
    // Recency-ordered window for the session artist cap. Deduped and
    // current-track-free for the same reasons as recentHistoryIds: a
    // repeated track must not consume two slots of its artist's budget.
    const sessionArtistWindowIds = [...new Set(sessionTrackIds)]
        .filter((id) => id !== trackId)
        .slice(0, SESSION_ARTIST_WINDOW);
    const [persistentPlayedTitles, dislikedTrackIds, historyGenreTags, sessionArtistKeys] =
        await Promise.all([
            getRecentlyPlayedVariants(sql, user.userId, cooldownHours).catch((err) => {
                logger.warn(
                    'Music autoplay: cool-down stem fetch failed, continuing without title dedup',
                    { error: err instanceof Error ? err.message : String(err) },
                );
                return [] as string[];
            }),
            getDislikedTrackIds(sql, user.userId).catch((err) => {
                logger.warn(
                    'Music autoplay: dislike fetch failed, continuing without hard exclude',
                    { error: err instanceof Error ? err.message : String(err) },
                );
                return [] as string[];
            }),
            getTrackGenreTags(sql, recentHistoryIds).catch((err) => {
                logger.warn(
                    'Music autoplay: session genre fetch failed, continuing without streak detection',
                    { error: err instanceof Error ? err.message : String(err) },
                );
                return new Map<string, string[]>();
            }),
            getSessionArtistKeys(sql, sessionArtistWindowIds).catch((err) => {
                logger.warn(
                    'Music autoplay: session artist fetch failed, continuing without the session artist cap',
                    { error: err instanceof Error ? err.message : String(err) },
                );
                return new Map<string, string>();
            }),
        ]);

    const overplayedArtists = overplayedSessionArtists(sessionArtistWindowIds, sessionArtistKeys);

    // The anchor is the session's ORIGIN (first played track) — the
    // client sends history newest-first, so that's the LAST element.
    // (Previously took [0] under an oldest-first assumption, which
    // anchored each hop to the immediately previous track and did
    // nothing to slow cross-session drift.)
    //
    // Shared by BOTH retrieval paths: the metadata path applies it as
    // an additive similarity term weighted by
    // MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT, the sonic path as a floor on
    // the origin's share of the queue centroid. Same intent — stop a
    // long session walking out of its own genre — expressed in each
    // path's own scoring domain.
    const sessionAnchorCandidate = sessionTrackIds[sessionTrackIds.length - 1];
    const sessionAnchorTrackId =
        sessionTrackIds.length > 0 && sessionAnchorCandidate !== trackId
            ? sessionAnchorCandidate
            : undefined;

    // Same-genre listening-streak profile (see music-genre-streak.ts).
    // An explicit seed (mood/genre/artist/album radio) is deliberate
    // cross-genre intent, so the streak signal is disabled entirely
    // rather than fighting it.
    const genreStreakProfile = computeGenreStreakProfile([
        currentGenreTags,
        ...recentHistoryIds.map((id) => historyGenreTags.get(id) ?? null),
    ]);
    const genreStreak: GenreStreakContext = {
        profile: genreStreakProfile,
        weight: config.MUSIC_AUTOPLAY_GENRE_STREAK_WEIGHT,
        // `!seed` is now safe. It was not before: any value that merely
        // PARSED was truthy and switched the streak off, so a shape with
        // no usable content (`{"genre":"Trance"}` — no `type`) bought
        // less genre coherence, not more. Validation above now rejects
        // those with a 400, and every accepted seed type resolves to a
        // real vector, so a present seed is always deliberate
        // cross-genre intent.
        active:
            !seed &&
            isGenreStreakActive(
                genreStreakProfile,
                config.MUSIC_AUTOPLAY_GENRE_STREAK_COHESION_THRESHOLD,
            ),
    };

    // -----------------------------------------------------------------------
    // Sonic Smart Queue path (features.sonicQueue gate)
    // -----------------------------------------------------------------------
    // Effective taste-arm weight for the sonic retrieval blend.
    // Base comes from config; during a cohesive same-genre streak it
    // shrinks by (1 − cohesion) — the session is declaring the mood
    // right now, and that should outrank overall taste. At full
    // cohesion (uniform recent history) the taste pull vanishes.
    const tasteWeightBase = config.MUSIC_SONIC_TASTE_WEIGHT;
    // An explicit user pick also shrinks the taste arm: taste is the
    // second force (besides session history) that can drag the refill
    // back toward the library's dominant genre, against the pick.
    const nowPlayingIntent: NowPlayingIntent | undefined =
        params.startedBy === 'user'
            ? 'manual'
            : params.startedBy === 'autoplay'
              ? 'auto'
              : undefined;
    const intentTasteMultiplier =
        nowPlayingIntent === 'manual' ? MANUAL_INTENT_TASTE_MULTIPLIER : 1;
    const effectiveTasteWeight =
        (genreStreak.active
            ? tasteWeightBase * (1 - genreStreakProfile.cohesion)
            : tasteWeightBase) * intentTasteMultiplier;

    if (features.sonicQueue) {
        try {
            const tasteVector = await computeSonicTasteVector(sql, user.userId).catch((err) => {
                logger.warn('Sonic queue: taste vector fetch failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
                return null;
            });

            const moodVectorKey = seedMoodVectorKey(seed);
            const moodVector: number[] | null = moodVectorKey
                ? await getMoodVector(sql, moodVectorKey).catch((err) => {
                      logger.warn('Sonic queue: audio mood vector fetch failed', {
                          error: err instanceof Error ? err.message : String(err),
                      });
                      return null;
                  })
                : null;

            const queueTrackIds = recentQueueIds.length > 0 ? recentQueueIds : [trackId];

            const sonicTitleMatchIds = Array.from(
                new Set([trackId, ...sessionTrackIds, ...skippedTrackIds]),
            );

            const sonicCandidates = await getSonicQueueCandidates(sql, {
                queueTrackIds,
                tasteVector,
                moodVector,
                excludeIds: [...new Set([...allExcludeIds, ...dislikedTrackIds])],
                skippedTrackIds,
                limit: 60,
                access: accessBoundary,
                titleMatchIds: sonicTitleMatchIds,
                persistentPlayedTitles,
                tasteWeight: effectiveTasteWeight,
                intent: nowPlayingIntent,
                anchorTrackId: sessionAnchorTrackId,
                // Same config keys as the metadata path, so one setting
                // governs both retrieval paths.
                popularityWeight: config.MUSIC_POPULARITY_WEIGHT,
                popularityExponent: config.MUSIC_POPULARITY_EXPONENT,
                popularityFloor: config.MUSIC_POPULARITY_FLOOR,
                popularityPrimarySource: config.MUSIC_POPULARITY_PRIMARY_SOURCE,
            });
            const durationFilteredSonicCandidates = sonicCandidates.filter(
                (candidate) =>
                    isWithinDurationBounds(
                        candidate.runtime_seconds,
                        minTrackSeconds,
                        maxTrackSeconds,
                    ) &&
                    // Novelty cuts (a cappella / karaoke) run to full
                    // length, so the duration floor above never catches
                    // them. See isNoveltyCutTitle.
                    !isNoveltyCutTitle(candidate.title),
            );

            // Last.fm lane-affinity context: batch-fetch crowd tags +
            // similar-artist lists for the current artist and every
            // candidate artist. Soft signal — any failure degrades to
            // null (term disabled), never blocks the queue.
            const currentArtistId = currentTrack.track_artist_id ?? currentTrack.artist_id;
            const currentArtistName = currentTrack.track_artist_title ?? currentTrack.artist_title;
            let laneCtx: SonicLaneContext | null = null;
            if (
                currentArtistName &&
                !isVariousArtistsName(currentArtistName) &&
                config.MUSIC_SONIC_LANE_WEIGHT > 0
            ) {
                const laneArtistIds = new Set<string>();
                if (currentArtistId) laneArtistIds.add(currentArtistId);
                for (const c of durationFilteredSonicCandidates) {
                    if (c.resolved_artist_id) laneArtistIds.add(c.resolved_artist_id);
                }
                const laneMap = await getArtistLaneData(sql, [...laneArtistIds]).catch((err) => {
                    logger.warn(
                        'Sonic queue: lane data fetch failed, continuing without lane term',
                        { error: err instanceof Error ? err.message : String(err) },
                    );
                    return null;
                });
                if (laneMap && laneMap.size > 0) {
                    laneCtx = {
                        current: {
                            name: currentArtistName,
                            lane: currentArtistId ? (laneMap.get(currentArtistId) ?? null) : null,
                        },
                        byArtistId: laneMap,
                        weight: config.MUSIC_SONIC_LANE_WEIGHT,
                    };
                }
            }

            const minCandidates = config.MUSIC_SONIC_QUEUE_MIN_CANDIDATES;
            if (durationFilteredSonicCandidates.length < minCandidates) {
                logger.debug(
                    'Sonic smart queue: too few candidates, falling back to metadata path',
                    {
                        username: user.username,
                        trackId,
                        candidateCount: durationFilteredSonicCandidates.length,
                        minRequired: minCandidates,
                    },
                );
            } else {
                let scored = scoreSonicCandidates(
                    durationFilteredSonicCandidates,
                    { bpm: currentBpm, key: currentKey, energy: currentEnergy },
                    currentGenreTags,
                    genreStreak,
                    weights,
                    laneCtx,
                );

                if (scored.length === 0) {
                    // There's no hard BPM/key/energy gate anymore (see
                    // music-queue-scoring.ts) — scoring never drops a
                    // candidate, so this is only reachable when the kNN
                    // pool itself was empty. Fall through to the
                    // metadata path below rather than returning an
                    // empty queue — mirrors the too-few-candidates
                    // branch above.
                    logger.debug(
                        'Sonic smart queue: candidate pool was empty, falling back to metadata path',
                        {
                            username: user.username,
                            trackId,
                            candidateCount: durationFilteredSonicCandidates.length,
                            currentBpm,
                            currentKey,
                            currentEnergy,
                        },
                    );
                } else {
                    const mmrCount = Math.max(config.MUSIC_AUTOPLAY_TOP_K * 2, 8);
                    const mmrPoolSize = mmrCount + 4;
                    if (scored.length > 1) {
                        const mmrPool = scored.slice(0, Math.min(scored.length, mmrPoolSize));
                        const hasAnyEmbedding = mmrPool.some((c) => c.embedding != null);
                        if (hasAnyEmbedding) {
                            const tail = scored.slice(mmrPool.length);
                            const diversified = mmrRerank(mmrPool, {
                                count: Math.min(mmrCount, mmrPool.length),
                                lambda: 0.7,
                                relevance: (c) => c.similarity_score,
                                similarity: (a, b) =>
                                    cosineSimilarity(a.embedding ?? null, b.embedding ?? null),
                            });
                            const selectedIds = new Set(diversified.map((d) => d.id));
                            const leftover = mmrPool.filter((c) => !selectedIds.has(c.id));
                            scored = [...diversified, ...leftover, ...tail];
                        }
                    }

                    // Hard rule (never relaxed): don't follow a track with the
                    // same artist. Soft rule (relaxed when applying it would
                    // leave nothing): the session artist cap.
                    const hardArtistSet = new Set([currentArtist]);
                    const currentArtistSet = new Set([currentArtist, ...overplayedArtists]);
                    const currentAlbumId = currentTrack.parent_id ?? undefined;
                    const currentAlbumSet = currentAlbumId
                        ? new Set([currentAlbumId])
                        : new Set<string>();

                    const autoNextSonicRow = pickAutoNextSonic(
                        scored,
                        currentArtistSet,
                        config.MUSIC_AUTOPLAY_TOP_K,
                        currentAlbumSet,
                        hardArtistSet,
                    );

                    const autoNextSonicArtist = autoNextSonicRow
                        ? getArtistFromSonic(autoNextSonicRow)
                        : '';
                    const sonicPool = scored.filter((c) => c.id !== autoNextSonicRow?.id);
                    const sonicExcludeArtists = new Set([
                        currentArtist,
                        autoNextSonicArtist,
                        ...overplayedArtists,
                    ]);
                    const sonicSuggestionRows = pickDiverseSonic(
                        sonicPool,
                        3,
                        sonicExcludeArtists,
                        undefined,
                        undefined,
                        new Set([currentArtist, autoNextSonicArtist]),
                    );
                    const imageSets = await resolveImageSets(sql, surface, [
                        ...(autoNextSonicRow
                            ? [{ id: autoNextSonicRow.id, mediaType: 'track' }]
                            : []),
                        ...sonicSuggestionRows.map((row) => ({
                            id: row.id,
                            mediaType: 'track',
                        })),
                    ]);
                    const autoNextSonic = autoNextSonicRow
                        ? toMusicTrackFromSonic(
                              autoNextSonicRow,
                              imageSets.get(autoNextSonicRow.id) ?? {},
                          )
                        : null;
                    const sonicSuggestions = sonicSuggestionRows.map((row) =>
                        toMusicTrackFromSonic(row, imageSets.get(row.id) ?? {}),
                    );

                    logger.debug('Sonic smart queue computed', {
                        username: user.username,
                        trackId,
                        candidateCount: durationFilteredSonicCandidates.length,
                        scoredCount: scored.length,
                        hasTaste: tasteVector !== null,
                        hasMood: moodVector !== null,
                        recentQueueIds: queueTrackIds.length,
                        autoNextAlbum: autoNextSonicRow?.parent_id ?? null,
                        genreStreakActive: genreStreak.active,
                        genreStreakCohesion: genreStreakProfile.cohesion,
                        tasteWeight: effectiveTasteWeight,
                        blendWeight: weights.blendWeight,
                        crossfadeCapable: params.crossfade !== false,
                        intent: nowPlayingIntent ?? 'auto',
                    });

                    return {
                        // Omitted, never null.
                        ...(autoNextSonic ? { next: autoNextSonic } : {}),
                        alternatives: sonicSuggestions,
                        source: 'sonic',
                    };
                }
            }
        } catch (err) {
            logger.warn('Sonic smart queue error, falling back to metadata path', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // -----------------------------------------------------------------------
    // Metadata embedding path
    // -----------------------------------------------------------------------

    const rawCandidates = await getSmartQueueCandidates(sql, trackId, allExcludeIds, 100, {
        sessionTrackIds,
        userId: user.userId,
        skippedTrackIds,
        dislikedTrackIds,
        persistentPlayedTitles,
        seed,
        sessionAnchorTrackId,
        sessionAnchorWeight: config.MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT,
        minTrackSeconds: config.MUSIC_AUTOPLAY_MIN_TRACK_SECONDS,
        maxTrackSeconds: config.MUSIC_AUTOPLAY_MAX_TRACK_SECONDS,
        popularityWeight: config.MUSIC_POPULARITY_WEIGHT,
        popularityExponent: config.MUSIC_POPULARITY_EXPONENT,
        popularityFloor: config.MUSIC_POPULARITY_FLOOR,
        popularityPrimarySource: config.MUSIC_POPULARITY_PRIMARY_SOURCE,
    });
    const accessibleCandidates = await filterAccessibleRows(sql, rawCandidates, accessBoundary);
    // Same novelty-cut filter as the sonic path above — both paths
    // choose tracks on the user's behalf, so both must apply it.
    const candidates = accessibleCandidates.filter(
        (candidate) => !isNoveltyCutTitle(candidate.title),
    );

    let scored = scoreCandidates(
        candidates,
        { bpm: currentBpm, key: currentKey, energy: currentEnergy },
        currentGenreTags,
        genreStreak,
        weights,
    );

    const mmrCount = Math.max(config.MUSIC_AUTOPLAY_TOP_K * 2, 8);
    const mmrPoolSize = mmrCount + 4;
    if (scored.length > 1) {
        const mmrPool = scored.slice(0, Math.min(scored.length, mmrPoolSize));
        const hasAnyEmbedding = mmrPool.some((c) => c.embedding != null);
        if (hasAnyEmbedding) {
            const tail = scored.slice(mmrPool.length);
            const diversified = mmrRerank(mmrPool, {
                count: Math.min(mmrCount, mmrPool.length),
                lambda: 0.7,
                relevance: (c) => c.similarity_score,
                similarity: (a, b) => cosineSimilarity(a.embedding ?? null, b.embedding ?? null),
            });
            const selectedIds = new Set(diversified.map((d) => d.id));
            const leftover = mmrPool.filter((c) => !selectedIds.has(c.id));
            scored = [...diversified, ...leftover, ...tail];
        }
    }

    let usedFallback = false;

    if (scored.length === 0) {
        usedFallback = true;
        const fallbackExcludeIds = Array.from(new Set([...allExcludeIds, ...dislikedTrackIds]));
        const fallbackOptions = {
            minTrackSeconds: config.MUSIC_AUTOPLAY_MIN_TRACK_SECONDS,
            maxTrackSeconds: config.MUSIC_AUTOPLAY_MAX_TRACK_SECONDS,
        };
        const stage1 = await getFallbackCandidates(
            sql,
            trackId,
            currentTrack,
            fallbackExcludeIds,
            persistentPlayedTitles,
            fallbackOptions,
        );
        const stage1Filtered = await filterAccessibleRows(sql, stage1, accessBoundary);
        if (stage1Filtered.length > 0) {
            scored = stage1Filtered;
        } else {
            logger.warn('Music autoplay: cool-down relaxed, library exhausted', {
                username: user.username,
                cooldownHours,
                excludedCount: persistentPlayedTitles.length,
            });
            const stage2 = await getFallbackCandidates(
                sql,
                trackId,
                currentTrack,
                fallbackExcludeIds,
                [],
                fallbackOptions,
            );
            scored = await filterAccessibleRows(sql, stage2, accessBoundary);
        }
    }

    const autoNextRow = pickAutoNext(
        scored,
        new Set([currentArtist, ...overplayedArtists]),
        getArtist,
        config.MUSIC_AUTOPLAY_TOP_K,
        undefined,
        new Set([currentArtist]),
    );

    const autoNextArtist = autoNextRow ? getArtist(autoNextRow) : '';
    const suggestionsPool = scored.filter((t) => t.id !== autoNextRow?.id);
    const suggestionRows = pickDiverse(
        suggestionsPool,
        3,
        new Set([currentArtist, autoNextArtist, ...overplayedArtists]),
        undefined,
        new Set([currentArtist, autoNextArtist]),
    );
    const imageSets = await resolveImageSets(sql, surface, [
        ...(autoNextRow ? [{ id: autoNextRow.id, mediaType: 'track' }] : []),
        ...suggestionRows.map((row) => ({ id: row.id, mediaType: 'track' })),
    ]);
    const autoNext = autoNextRow
        ? toMusicTrack(autoNextRow, imageSets.get(autoNextRow.id) ?? {})
        : null;
    const suggestions = suggestionRows.map((row) => toMusicTrack(row, imageSets.get(row.id) ?? {}));

    logger.debug('Smart queue computed', {
        username: user.username,
        trackId,
        candidateCount: candidates.length,
        filteredCount: scored.length,
        cooldownHours,
        persistentExcludedCount: persistentPlayedTitles.length,
        genreStreakActive: genreStreak.active,
        genreStreakCohesion: genreStreakProfile.cohesion,
        blendWeight: weights.blendWeight,
        crossfadeCapable: params.crossfade !== false,
    });

    return {
        // Omitted, never null.
        ...(autoNext ? { next: autoNext } : {}),
        alternatives: suggestions,
        source: usedFallback ? 'fallback' : 'metadata',
    };
}
