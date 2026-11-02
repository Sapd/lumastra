// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Modal Data Composable
 *
 * Svelte 5 composable for ModalMovie data layer.
 * Extracts 6 $effect blocks and 9 state vars from ModalMovie for testability.
 * Self-healing auto-fetch pattern preserved (DL-004): modal auto-fetches missing data.
 *
 * LIFECYCLE HANDLING (DL-013):
 * Two paths converge correctly:
 * - Prop-change (modals.replace): $effect re-runs because props change, resetState() triggers
 * - Component remount: all $state resets to initial values naturally, $effect initial run handles mount
 *
 * ERROR HANDLING (DL-012):
 * All catch blocks use console.warn + empty/null defaults matching ModalMovie behavior.
 * Errors are non-critical (background fetch), no toast notifications for auto-fetch.
 */

import { pickVariant } from '$lib/utils/image-utils';
import { untrack } from 'svelte';
import type { SeriesCountSummary } from '$lib/utils/series-episode-counts';
import type { EnrichedModalData, ModalMediaData, SocialActivity } from '$lib/utils/modal-data';
import type { ContextSimilarItem } from '$lib/schemas/api-media-context-response';
import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
import type { ExternalIds } from '$lib/types/api-common';
import {
    needsEnrichment,
    enrichMediaData,
    fetchSimilarContent,
    fetchSocialActivity,
    fetchAudiobookSocialActivity,
    fetchUserRating,
    fetchWatchedStatus,
    toggleWatchedStatus,
    fetchNextEpisode,
    fetchExplicitEpisode,
    getApiMediaType,
    extractAudiobookFields,
} from '$lib/utils/modal-data';
import { hasValidExternalId, mediaCompositeKey, buildMediaKey } from '$lib/utils/media-id-helpers';
import { getExternalIdFor, hasAnyExternalId } from '$lib/utils/external-ids';
import { getMediaContext, type MediaContextSection } from '$lib/api/content';
import { imageFromIds } from '$lib/utils/image-utils';
import { watchStateVersion } from '$lib/stores/watch-state-version';
import { get as getStore } from 'svelte/store';
import {
    isMovie as checkIsMovie,
    isSeries as checkIsSeries,
    isEpisode as checkIsEpisode,
    isAudiobook as checkIsAudiobook,
} from '$lib/shared/media-types';
import * as m from '$lib/paraglide/messages';
import type { AsyncState } from '$lib/types/async-state';
import {
    idle,
    loading,
    success,
    errorFromUnknown,
    isLoading,
    getDataOr,
} from '$lib/types/async-state';

/**
 * Key-aware data extractor: returns the success payload only when the
 * state's requestKey matches the currently-expected key. A stale success
 * left over from a superseded media identity (rapid A→B modal swap) carries
 * the OLD key and is therefore never returned for the new modal. States
 * with no requestKey (legacy / keyless) fall through to the normal
 * getDataOr behavior to preserve existing callers.
 *
 * Pure function (no runes) — module-level so it can be unit tested without
 * instantiating the composable.
 */
export function getDataForKey<T>(state: AsyncState<T>, expectedKey: string | null, fallback: T): T {
    if (state.status === 'success') {
        if (
            expectedKey !== null &&
            state.requestKey !== undefined &&
            state.requestKey !== expectedKey
        ) {
            return fallback;
        }
        return state.data;
    }
    return fallback;
}

/**
 * Key-based stale-write guard shared by all `load*` fetch functions. Returns
 * true when an in-flight/completed write for `key` has been superseded by a
 * newer request (the state is no longer `loading` for that same key). Used
 * to drop the result of an OLDER promise that resolves AFTER a NEWER key was
 * already requested, so the newer request's result isn't clobbered.
 *
 * Pure function (no runes) — module-level so it can be unit tested without
 * instantiating the composable.
 */
export function isRequestStale<T>(state: AsyncState<T>, key: string): boolean {
    return !isLoading(state) || state.requestKey !== key;
}

/**
 * Sequence-based stale-write guard used by `enrichModalData` /
 * `loadCompositeContext`. Returns true when `capturedSeq` (the sequence
 * token captured at request start) is no longer the most recently issued
 * token, meaning a newer call superseded this one.
 *
 * Pure function (no runes) — module-level so it can be unit tested without
 * instantiating the composable.
 */
export function isSequenceStale(capturedSeq: number, currentSeq: number): boolean {
    return capturedSeq !== currentSeq;
}

/**
 * Merge raw (prop) modal data with locally-fetched enrichment data.
 * The enriched value only fills in fields the raw value didn't supply.
 *
 * NOTE on `overview` (like `title` elsewhere in the modal): the enriched
 * value wins over the raw prop when both are present. The raw `overview`
 * prop is only ever the OPENING card's placeholder text — potentially in the
 * viewer's browser/UI language — while `enrichedData.overview` comes from
 * the freshly-fetched, per-user metadata-language-overlaid `/api/media/{id}`
 * response. Preferring the prop here would (and, before this fix, did)
 * silently override a correctly-localized overview with a stale/wrong-
 * language placeholder (multilingual-media-metadata spec §5 regression).
 *
 * NOTE on `canRequest`/`isAvailable`: these use `??` (not `||`) so an
 * explicit fresh value of `false` is preserved. Fetched detail flags replace
 * opening-card flags; missing fresh flags fall back to the supplied props.
 *
 * Pure function (no runes) — module-level so it can be unit tested without
 * instantiating the composable.
 */
/**
 * Whether there is anything to look social activity up BY.
 *
 * `hasAnyExternalId` deliberately ignores UUIDs — an internal id is not an
 * external provider id — which makes it the wrong question for an audiobook.
 * AudiobookShelf books have no TMDB namespace at all, so `internal` is the ONLY
 * id they ever carry, and the generic check rejects every one of them. Widening
 * the media-type clause in the effect was therefore not enough on its own: this
 * clause was still closed, and the section simply never appeared.
 *
 * Pure and exported because the effect that consumes it cannot be exercised
 * under the default vitest config — see the note at the top of the test file.
 */
export function canLookUpSocialActivity(
    isAudiobook: boolean,
    externalIds: ExternalIds | undefined,
    internalIdFallback?: string | undefined,
): boolean {
    if (isAudiobook) return !!(getExternalIdFor(externalIds, 'internal') ?? internalIdFallback);
    // /api/social/watch-activity/{id} resolves an internal UUID to the item
    // itself (watch activity is keyed by the internal media id), so a
    // library item with only its internal id is looked up too.
    return (
        !!externalIds &&
        (hasAnyExternalId(externalIds) || !!getExternalIdFor(externalIds, 'internal'))
    );
}

/**
 * Project an `enrichMediaData()` result onto the enriched-state shape.
 *
 * Pure function (no runes) — module-level so it can be unit tested without
 * mounting a component.
 *
 * `externalIds` MUST travel with the rest: `mergeModalValue()` below self-heals
 * a missing internal id from the enriched side, and that id is what
 * lets ModalMovie build `seriesPickerData` — i.e. render the episode list and
 * the Watch button. Two writers feed `enrichedState` and the later one replaces
 * it wholesale: `loadCompositeContext()` carried the ids, this whitelist did
 * not, so whether the self-heal fired came down to which of the two racing
 * fetches resolved last.
 *
 * That race is the LIBRARY case (a payload holding one of jellyfin/internal but
 * not the other). A payload holding NEITHER reaches enrichment only through
 * `shouldAutoEnrich()` above — without that gate this projection never runs for
 * it at all, so the two changes only close the thin-payload hole together.
 */
/**
 * Gate for the auto-enrichment fallback effect.
 *
 * Enrichment normally waits for the composite-context fetch to land
 * (`contextAttempted`) so the two don't duplicate work. But the composite is
 * only reachable for a payload carrying an internal id — the identity effect
 * keys on exactly that, and `contextAttempted` is only ever
 * set inside `loadCompositeContext()`. So a THIN payload (tmdb id only: a
 * request-notification toast, a search result) waited on a flag that could
 * never flip, and never enriched at all: no cast, no ratings, no runtime, and
 * no healed media id — which is what leaves a watchable series with no episode
 * list and no Watch button. `loadSimilarContent` is the one ungated fetch,
 * which is why such a modal rendered as title + overview + Similar and nothing
 * else.
 *
 * So: treat "no composite is possible" as "the composite has been attempted".
 *
 * Pure function (no runes) — module-level so it can be unit tested without
 * instantiating the composable.
 */
export function shouldAutoEnrich(args: {
    /** The composite fetch has resolved (or gave up). */
    contextAttempted: boolean;
    /** An internal id exists, so a composite fetch can actually run. */
    compositeAvailable: boolean;
    needsEnrichment: boolean;
    hasExternalIds: boolean;
}): boolean {
    if (!args.needsEnrichment || !args.hasExternalIds) return false;
    return args.contextAttempted || !args.compositeAvailable;
}

export function projectEnrichedFields(enriched: EnrichedModalData): Partial<ModalMediaData> {
    return {
        title: enriched.title,
        tagline: enriched.tagline,
        certification: enriched.certification,
        libraryNames: enriched.libraryNames,
        overview: enriched.overview,
        rating: enriched.rating,
        year: enriched.year,
        rtCritic: enriched.rtCritic,
        rtAudience: enriched.rtAudience,
        letterboxdRating: enriched.letterboxdRating,
        letterboxdVotes: enriched.letterboxdVotes,
        mdblistScore: enriched.mdblistScore,
        metacriticScore: enriched.metacriticScore,
        traktScore: enriched.traktScore,
        duration: enriched.duration,
        genres: enriched.genres,
        actors: enriched.actors,
        directors: enriched.directors,
        canRequest: enriched.canRequest,
        isAvailable: enriched.isAvailable,
        remoteTrailers: enriched.remoteTrailers,
        hasLocalTrailer: enriched.hasLocalTrailer,
        extras: enriched.extras,
        originalLanguage: enriched.originalLanguage,
        audioLanguages: enriched.audioLanguages,
        subtitleLanguages: enriched.subtitleLanguages,
        audiobook: enriched.audiobook,
        seasonCount: enriched.seasonCount,
        episodeCount: enriched.episodeCount,
        availableEpisodeCount: enriched.availableEpisodeCount,
        watchedEpisodeCount: enriched.watchedEpisodeCount,
        unwatchedEpisodeCount: enriched.unwatchedEpisodeCount,

        // enrichMediaData() merges the response's `ids` map over the caller's,
        // so this is the fullest identity we ever hold for the entity.
        externalIds: enriched.externalIds,
    };
}

export function mergeModalValue(
    rawModalValue: ModalMediaData,
    enrichedData: Partial<ModalMediaData>,
): ModalMediaData {
    return {
        ...rawModalValue,
        overview: enrichedData.overview || rawModalValue.overview,
        tagline: enrichedData.tagline ?? rawModalValue.tagline,
        certification: enrichedData.certification ?? rawModalValue.certification,
        libraryNames: enrichedData.libraryNames ?? rawModalValue.libraryNames,
        rating: rawModalValue.rating || enrichedData.rating,
        year: rawModalValue.year || enrichedData.year,
        rtCritic: rawModalValue.rtCritic || enrichedData.rtCritic,
        rtAudience: rawModalValue.rtAudience || enrichedData.rtAudience,
        letterboxdRating: rawModalValue.letterboxdRating || enrichedData.letterboxdRating,
        letterboxdVotes: rawModalValue.letterboxdVotes || enrichedData.letterboxdVotes,
        mdblistScore: rawModalValue.mdblistScore || enrichedData.mdblistScore,
        metacriticScore: rawModalValue.metacriticScore || enrichedData.metacriticScore,
        traktScore: rawModalValue.traktScore || enrichedData.traktScore,
        duration: rawModalValue.duration || enrichedData.duration,
        genres: enrichedData.genres?.length ? enrichedData.genres : rawModalValue.genres,
        actors: rawModalValue.actors || enrichedData.actors,
        directors: rawModalValue.directors || enrichedData.directors,
        canRequest: enrichedData.canRequest ?? rawModalValue.canRequest,
        isAvailable: enrichedData.isAvailable ?? rawModalValue.isAvailable,
        remoteTrailers: rawModalValue.remoteTrailers || enrichedData.remoteTrailers,
        // `??` (not `||`): an explicit prop `false` is a real "no trailer"
        // signal and must not fall through to a stale enriched value.
        hasLocalTrailer: rawModalValue.hasLocalTrailer ?? enrichedData.hasLocalTrailer,
        extras: rawModalValue.extras ?? enrichedData.extras,
        quality: rawModalValue.quality ?? enrichedData.quality,
        originalLanguage: enrichedData.originalLanguage,
        audioLanguages: enrichedData.audioLanguages,
        subtitleLanguages: enrichedData.subtitleLanguages,
        // Audiobook author/narrator/chapters. Enrichment-only by design: no card
        // or deep-link opener carries this block, so there is no prop value to
        // prefer and `??` would only ever read the enriched side anyway.
        audiobook: rawModalValue.audiobook ?? enrichedData.audiobook,
        seasonCount: enrichedData.seasonCount ?? rawModalValue.seasonCount,
        episodeCount: enrichedData.episodeCount ?? rawModalValue.episodeCount,
        availableEpisodeCount:
            enrichedData.availableEpisodeCount ?? rawModalValue.availableEpisodeCount,
        watchedEpisodeCount: enrichedData.watchedEpisodeCount ?? rawModalValue.watchedEpisodeCount,
        unwatchedEpisodeCount:
            enrichedData.unwatchedEpisodeCount ?? rawModalValue.unwatchedEpisodeCount,

        // Self-heal: if the caller didn't supply a playable id, fill the
        // internal id from the resolved item so the watch button can appear.
        externalIds: {
            ...rawModalValue.externalIds,
            internal:
                getExternalIdFor(rawModalValue.externalIds, 'internal') ??
                getExternalIdFor(enrichedData.externalIds, 'internal'),
        },
    } as ModalMediaData;
}

export interface UseModalDataOptions {
    /** Getter for social feature flag (reactive in $effect context) */
    getSocialEnabled: () => boolean;
    /** Getter for age-restricted flag (reactive in $effect context) */
    getIsAgeRestricted: () => boolean;
}

/** Input props for the composable - accepts the full modal data shape */
export interface ModalDataProps extends SeriesCountSummary {
    modalId: string;
    title: string;
    body: string;
    image: string;
    mediaType: string;
    externalIds?: ExternalIds;
    seriesInternalId?: string;
    overview?: string;
    year?: string | number;
    rating?: number;
    criticRating?: number;
    genres?: string[];
    duration?: number;
    studio?: string;
    author?: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    episodeNumberEnd?: number;
    sonarrAbsoluteEpisode?: number;
    sonarrSeriesId?: number;
    initialSeason?: number;
    initialEpisode?: number;
    seriesChildCount?: number;
    rtCritic?: number;
    rtAudience?: number;
    letterboxdRating?: number;
    letterboxdVotes?: number;
    traktScore?: number;
    metacriticScore?: number;
    mdblistScore?: number;
    sonarrNetwork?: string;
    sonarrQuality?: string;
    sonarrHasFile?: boolean;
    sonarrAirDate?: string;
    remoteTrailers?: string;
    /** Local trailer file exists (detail payloads only; undefined = unknown → enrich) */
    hasLocalTrailer?: boolean;
    /** File-backed extras (detail payloads only; undefined = unknown → enrich) */
    extras?: Array<{ id: string; title: string; extraType: string; durationMs?: number }>;
    imageBackdropId?: string;
    canRequest?: boolean;
    isAvailable?: boolean;
    availabilitySource?: string;
    actors?: Array<string | { name: string; character?: string }>;
    directors?: string[];
}

/**
 * Svelte 5 composable for ModalMovie data layer.
 *
 * @param getProps - Getter function returning current modal props (reactive)
 * @param options - Feature flags: socialEnabled, isAgeRestricted
 * @returns Reactive object with state, derived values, and action methods
 */
export function useModalData(getProps: () => ModalDataProps, options: UseModalDataOptions) {
    const { getSocialEnabled, getIsAgeRestricted } = options;

    // =========================================================================
    // State (refactored to AsyncState pattern)
    // =========================================================================

    let enrichedState = $state<AsyncState<Partial<ModalMediaData>>>(idle());
    // Composite key of the last enrichModalData attempt. The context loader
    // ALSO writes enrichedState=success (same requestKey), which used to make
    // the enrichment gate read "already enriched" and skip the real fetch —
    // permanently, because the context payload never carries trailer fields.
    // This key lets the gate distinguish "context wrote first" (retry once)
    // from "enrichment genuinely ran" (settle), without looping on items
    // whose enrichment legitimately returns no hasLocalTrailer (episodes,
    // no-trailer movies — the transform omits false).
    let enrichAttemptKey = $state<string | null>(null);

    let similarState = $state<AsyncState<ContextSimilarItem[]>>(idle());

    let socialState = $state<AsyncState<SocialActivity[]>>(idle());

    let ratingState = $state<AsyncState<number | null>>(idle());

    let watchedState = $state<AsyncState<boolean>>(idle());
    let watchedLoading = $state(false); // Keep separate for toggle guard

    let nextEpisodeState = $state<
        AsyncState<{
            id: string;
            seasonNumber: number;
            episodeNumber: number;
            /** False when the targeted episode has no file (Watch is disabled) */
            playable: boolean;
        } | null>
    >(idle());

    /**
     * The episode the modal was opened for (an episode card, a calendar entry,
     * a `?season=&episode=` URL). The Watch button plays this one, not the
     * NextUp pick; S0 specials count, so compare with `!= null`.
     */
    function explicitEpisodeTarget(): { season: number; episode: number } | null {
        const season = props.seasonNumber ?? props.initialSeason;
        const episode = props.episodeNumber ?? props.initialEpisode;
        return season != null && episode != null ? { season, episode } : null;
    }

    let lastMediaId: string | null = null;
    let contextAttempted = $state(false);

    // Monotonic sequence used to discard stale async writes when rapid prop
    // swaps cause overlapping fetches. Each call captures the sequence at
    // start; if it no longer matches at completion, the result is dropped.
    let compositeSeq = 0;
    let enrichmentSeq = 0;
    let countRefreshSeq = 0;
    let countRefreshPending = false;
    let countRefreshState = $state<AsyncState<Partial<ModalMediaData>>>(idle());

    // =========================================================================
    // Derived Values
    // =========================================================================

    const props = $derived(getProps());
    const currentExternalIds = $derived(props.externalIds);
    /**
     * The id every per-entity load keys on: the internal UUID (UUID-first ID
     * pattern). It used to be the Jellyfin id, so a series without one never
     * got its next or explicitly opened episode fetched.
     */
    const currentMediaIdentifier = $derived(
        getExternalIdFor(props.externalIds, 'internal') ?? null,
    );
    const mediaType = $derived(props.mediaType);
    const isSeries = $derived(checkIsSeries(mediaType));
    const isMovie = $derived(checkIsMovie(mediaType));
    const isEpisode = $derived(checkIsEpisode(mediaType));
    const apiMediaType = $derived(getApiMediaType(mediaType));
    /**
     * Audiobooks carry no TMDB namespace, so the social fetch below cannot key
     * on one. They are looked up by internal UUID through their own endpoint —
     * the same one the player's timeline markers use.
     */
    const isAudiobookItem = $derived(checkIsAudiobook(mediaType));
    const internalMediaId = $derived(getExternalIdFor(props.externalIds, 'internal'));

    const socialLookupReady = $derived(
        canLookUpSocialActivity(isAudiobookItem, currentExternalIds, internalMediaId),
    );

    // Build raw modal value from props (same as ModalMovie's rawModalValue)
    const rawModalValue = $derived({
        seasonCount: props.seasonCount,
        episodeCount: props.episodeCount,
        availableEpisodeCount: props.availableEpisodeCount,
        watchedEpisodeCount: props.watchedEpisodeCount,
        unwatchedEpisodeCount: props.unwatchedEpisodeCount,
        externalIds: props.externalIds,
        mediaType: props.mediaType,
        overview: props.overview || props.body,
        rating: props.rating,
        year: props.year,
        rtCritic: props.rtCritic,
        rtAudience: props.rtAudience,
        letterboxdRating: props.letterboxdRating,
        letterboxdVotes: props.letterboxdVotes,
        mdblistScore: props.mdblistScore,
        metacriticScore: props.metacriticScore,
        traktScore: props.traktScore,
        duration: props.duration,
        genres: props.genres,
        actors: props.actors,
        directors: props.directors,
        canRequest: props.canRequest,
        isAvailable: props.isAvailable,
        seriesInternalId: props.seriesInternalId,
        seriesName: props.seriesName,
        seasonNumber: props.seasonNumber,
        episodeNumber: props.episodeNumber,
        episodeNumberEnd: props.episodeNumberEnd,
        sonarrAbsoluteEpisode: props.sonarrAbsoluteEpisode,
        sonarrSeriesId: props.sonarrSeriesId,
        sonarrNetwork: props.sonarrNetwork,
        sonarrQuality: props.sonarrQuality,
        sonarrHasFile: props.sonarrHasFile,
        sonarrAirDate: props.sonarrAirDate,
        remoteTrailers: props.remoteTrailers,
        hasLocalTrailer: props.hasLocalTrailer,
        extras: props.extras,
        studio: props.studio,
        author: props.author,
        imageBackdropId: props.imageBackdropId,
        availabilitySource: props.availabilitySource,
        criticRating: props.criticRating,
        seriesChildCount: props.seriesChildCount,
        initialSeason: props.initialSeason,
        initialEpisode: props.initialEpisode,
    } as ModalMediaData);

    /** Mirrors the identity effect's `mediaIdentifier` — see the note there. */
    const compositeAvailable = $derived(!!currentMediaIdentifier);

    const currentCompositeKey = $derived(
        currentExternalIds ? mediaCompositeKey(currentExternalIds, apiMediaType || 'movie') : null,
    );

    // Merged modal value: props + local enrichment (enriched fills missing fields only).
    // Key-scoped like similar/social/rating/watched below: an in-place trail swap
    // (series ↔ its episodes share one trailKey) reuses this component instance,
    // and the identity effect that calls resetState() keys on the internal id —
    // so a payload without one never resets. Now that such payloads DO enrich
    // (shouldAutoEnrich), an unscoped read would show entity A's cast, ratings and
    // healed ids on entity B's card.
    const enrichedData = $derived(getDataForKey(enrichedState, currentCompositeKey, {}));
    const modalValue = $derived({
        ...mergeModalValue(rawModalValue, enrichedData),
        ...getDataForKey(countRefreshState, currentCompositeKey, {}),
    });

    const modalNeedsEnrichment = $derived(
        hasValidExternalId(currentExternalIds) &&
            needsEnrichment(rawModalValue) &&
            enrichedState.status !== 'loading' &&
            (enrichedState.status === 'idle' ||
                (enrichedState.status === 'success' &&
                    (enrichedState.requestKey !== currentCompositeKey ||
                        // Context-write-first case: state says "success" for
                        // this key but the real enrichment fetch never ran
                        // (see enrichAttemptKey). Retry at most once per key.
                        enrichAttemptKey !== currentCompositeKey))),
    );

    // =========================================================================
    // Data Fetching Functions (with composite key dedup tracking)
    // =========================================================================

    async function enrichModalData(
        externalIds: ExternalIds,
        initialData: Partial<ModalMediaData>,
    ): Promise<void> {
        const compositeKey = mediaCompositeKey(externalIds, apiMediaType || 'movie');
        const seq = ++enrichmentSeq;
        enrichAttemptKey = compositeKey;

        // Deduplicate: don't start if already loading this key
        if (isLoading(enrichedState) && enrichedState.requestKey === compositeKey) {
            return;
        }

        enrichedState = loading(compositeKey);

        try {
            const enriched = await enrichMediaData(initialData);
            // Stale guard: discard if a newer enrichment superseded this one.
            if (isSequenceStale(seq, enrichmentSeq)) return;
            if (enriched._enriched) {
                enrichedState = success(projectEnrichedFields(enriched), compositeKey);
            } else {
                enrichedState = success({}, compositeKey);
            }
        } catch (err) {
            console.warn(
                '[useModalData] Enrichment failed:',
                err instanceof Error ? err.message : 'Unknown error',
            );
            if (isSequenceStale(seq, enrichmentSeq)) return;
            enrichedState = errorFromUnknown(err);
        }
    }

    async function loadSocialActivity(
        externalIds: ExternalIds,
        type: 'movie' | 'tv' | 'audiobook',
    ): Promise<void> {
        const compositeKey = mediaCompositeKey(externalIds, type);

        // Deduplicate
        if (isLoading(socialState) && socialState.requestKey === compositeKey) {
            return;
        }
        if (socialState.status === 'success' && socialState.requestKey === compositeKey) {
            return;
        }

        socialState = loading(compositeKey);

        try {
            // An audiobook has no TMDB id to look up, so it goes through the
            // UUID-keyed endpoint instead. Both return the SAME item shape, so
            // everything downstream — including the phrasing "N chapters ahead
            // of you" — is already handled.
            const activities =
                type === 'audiobook'
                    ? await fetchAudiobookSocialActivity(externalIds)
                    : await fetchSocialActivity(externalIds, type);
            // Stale guard: discard if a newer request for a different key
            // superseded this one (rapid A→B modal swap).
            if (isRequestStale(socialState, compositeKey)) {
                return;
            }
            socialState = success(activities, compositeKey);
        } catch (err) {
            console.warn(
                '[useModalData] Social activity load failed:',
                err instanceof Error ? err.message : 'Unknown',
            );
            if (isRequestStale(socialState, compositeKey)) {
                return;
            }
            socialState = errorFromUnknown(err);
        }
    }

    async function loadUserRating(externalIds: ExternalIds, type: 'movie' | 'tv'): Promise<void> {
        const compositeKey = mediaCompositeKey(externalIds, type);

        // Deduplicate
        if (isLoading(ratingState) && ratingState.requestKey === compositeKey) {
            return;
        }
        if (ratingState.status === 'success' && ratingState.requestKey === compositeKey) {
            return;
        }

        ratingState = loading(compositeKey);

        try {
            const rating = await fetchUserRating(externalIds, type);
            // Stale guard: discard if a newer request for a different key
            // superseded this one (rapid A→B modal swap).
            if (isRequestStale(ratingState, compositeKey)) {
                return;
            }
            ratingState = success(rating, compositeKey);
        } catch (err) {
            console.warn(
                '[useModalData] User rating load failed:',
                err instanceof Error ? err.message : 'Unknown',
            );
            if (isRequestStale(ratingState, compositeKey)) {
                return;
            }
            ratingState = errorFromUnknown(err);
        }
    }

    async function loadSimilarContent(
        externalIds: ExternalIds,
        type: 'movie' | 'tv',
    ): Promise<void> {
        const compositeKey = mediaCompositeKey(externalIds, type);

        // Deduplicate
        if (isLoading(similarState) && similarState.requestKey === compositeKey) {
            return;
        }
        if (similarState.status === 'success' && similarState.requestKey === compositeKey) {
            return;
        }

        similarState = loading(compositeKey);

        try {
            const newMovies = await fetchSimilarContent(externalIds, type, 10);
            // Stale guard: discard if a newer request for a different key
            // superseded this one (rapid A→B modal swap).
            if (isRequestStale(similarState, compositeKey)) {
                return;
            }
            similarState = success(newMovies, compositeKey);
        } catch (err) {
            console.warn(
                '[useModalData] Similar content load failed:',
                err instanceof Error ? err.message : 'Unknown',
            );
            if (isRequestStale(similarState, compositeKey)) {
                return;
            }
            similarState = errorFromUnknown(err);
        }
    }

    async function loadNextEpisode(seriesId: string): Promise<void> {
        if (!seriesId) return;

        // When a specific episode is shown in the modal (e.g. opened via episode
        // URL), target that episode instead of the NextUp heuristic.
        const explicit = explicitEpisodeTarget();
        const requestKey = explicit
            ? `${seriesId}:${explicit.season}:${explicit.episode}`
            : seriesId;

        if (isLoading(nextEpisodeState) && nextEpisodeState.requestKey === requestKey) return;
        if (nextEpisodeState.status === 'success' && nextEpisodeState.requestKey === requestKey)
            return;

        nextEpisodeState = loading(requestKey);

        try {
            const nextEp: {
                id: string;
                seasonNumber: number;
                episodeNumber: number;
                playable?: boolean;
            } | null = explicit
                ? await fetchExplicitEpisode(seriesId, explicit.season, explicit.episode)
                : await fetchNextEpisode(seriesId);
            // Stale guard: discard if a newer request superseded this one
            // (rapid modal swap or season/episode prop change).
            if (isRequestStale(nextEpisodeState, requestKey)) {
                return;
            }
            if (nextEp) {
                nextEpisodeState = success(
                    {
                        id: nextEp.id,
                        seasonNumber: nextEp.seasonNumber,
                        episodeNumber: nextEp.episodeNumber,
                        playable: nextEp.playable !== false,
                    },
                    requestKey,
                );
            } else {
                nextEpisodeState = success(null, requestKey);
            }
        } catch (err) {
            console.warn('[useModalData] Failed to load next episode:', err);
            if (isRequestStale(nextEpisodeState, requestKey)) {
                return;
            }
            nextEpisodeState = errorFromUnknown(err);
        }
    }

    /**
     * Reset all accumulated state when media identity changes.
     */
    function resetState(): void {
        countRefreshSeq++;
        countRefreshPending = false;
        countRefreshState = idle();
        enrichedState = idle();
        enrichAttemptKey = null;
        similarState = idle();
        socialState = idle();
        ratingState = idle();
        watchedState = idle();
        nextEpisodeState = idle();
        contextAttempted = false;
    }

    // =========================================================================
    // Composite Context Fetch
    // =========================================================================

    /** Refresh only count fields; own watch mutations deliberately retain Next Up for Undo. */
    async function refreshEpisodeCounts(): Promise<void> {
        countRefreshPending = true;
        if (!contextAttempted) return;
        countRefreshPending = false;
        const key = untrack(() => currentCompositeKey);
        const mediaKey = buildMediaKey(
            untrack(() => currentExternalIds),
            untrack(() => apiMediaType) ?? 'series',
        );
        if (!key || !mediaKey) return;
        const seq = ++countRefreshSeq;
        try {
            const { data, error } = await getMediaContext(mediaKey, ['details']);
            if (
                seq !== countRefreshSeq ||
                key !== untrack(() => currentCompositeKey) ||
                error ||
                !data?.details
            )
                return;
            const details = data.details;
            if (details.type !== 'series') return;
            const counts: Partial<ModalMediaData> = {
                availableEpisodeCount: details.availableEpisodeCount,
                watchedEpisodeCount: details.watchedEpisodeCount,
                unwatchedEpisodeCount: details.unwatchedEpisodeCount,
            };
            for (const field of ['seasonCount', 'episodeCount'] as const) {
                const fresh = details[field];
                const existing = untrack(() => modalValue[field]);
                const known = [fresh, existing].filter(
                    (value): value is number => value !== undefined && value > 0,
                );
                if (known.length) counts[field] = Math.max(...known);
            }
            countRefreshState = success(counts, key);
        } catch (err) {
            console.warn(
                '[useModalData] Episode count refresh failed:',
                err instanceof Error ? err.message : 'Unknown',
            );
        }
    }

    /**
     * Fetch all modal data sections in a single request via the composite endpoint.
     * Distributes the response to individual state variables.
     * Individual $effect blocks act as fallbacks for any sections that fail or are omitted.
     */
    async function loadCompositeContext(): Promise<void> {
        const externalIds = untrack(() => currentExternalIds);
        const type = untrack(() => apiMediaType);
        // `apiMediaType` is null when TMDB has no namespace for this row
        // (audiobook, track, album, channel). The composite key only needs a
        // type when there is no internal UUID to key on, so carry the row's OWN
        // type in that case rather than relabelling it 'movie' — media-key-parser
        // resolves `tmdb:123:audiobook`, while `tmdb:123:movie` resolves to a
        // different entity.
        const rawType = untrack(() => mediaType);
        const mediaKey = buildMediaKey(externalIds, type ?? rawType ?? 'movie');
        const seq = ++compositeSeq;

        if (!mediaKey) {
            contextAttempted = true;
            return;
        }

        // Only include time-critical sections in the composite call.
        // similar and social are slow (pgvector / external fetch) and are driven
        // by their own independent $effect blocks that fire in PARALLEL with this
        // composite (keyed on currentExternalIds, NOT gated on contextAttempted).
        // Excluding them here also lets contextAttempted flip to true as soon as
        // watched/rating/nextEpisode are ready instead of waiting for the
        // similarity search to finish.
        const sections: MediaContextSection[] = ['details', 'rating', 'watched'];

        const seriesFlag = untrack(() => isSeries);

        if (seriesFlag) sections.push('nextEpisode');

        try {
            const { data, error } = await getMediaContext(mediaKey, sections);
            // Stale guard: discard if a newer composite call superseded this one.
            if (isSequenceStale(seq, compositeSeq)) {
                return;
            }
            if (error || !data) {
                return;
            }

            const compositeKey = externalIds
                ? mediaCompositeKey(externalIds, type || 'movie')
                : null;
            const mediaIdentifier = untrack(() => currentMediaIdentifier) || '';

            // --- details → enrichedState ---
            if (data.details && compositeKey) {
                const details = data.details;
                const ratings = (details as { ratings?: Record<string, number | null> }).ratings;
                // Audiobook author/narrator/chapters ride the node's TOP level
                // (MediaNodeAudiobookSchema) — this composite is served by
                // buildMediaDetail() with an EMPTY `include`, so a `details`-nested
                // home would never reach the modal.
                const audiobook = extractAudiobookFields(details);
                // Books have a publication year and no other date, so they read it
                // from the same node-level field a movie does.
                const year =
                    checkIsMovie(details.type) || audiobook
                        ? (details as { year?: number }).year
                        : undefined;

                enrichedState = success(
                    {
                        title: details.title,
                        tagline: details.tagline,
                        certification: details.certification,
                        libraryNames: details.libraryNames,
                        overview: details.overview,
                        rating: details.rating,
                        year: year ? String(year) : undefined,
                        duration:
                            audiobook?.durationMs !== undefined
                                ? audiobook.durationMs / 1000
                                : undefined,
                        audiobook,
                        seasonCount:
                            ('seasonCount' in details ? details.seasonCount : undefined) ??
                            getDataOr(enrichedState, {} as Partial<ModalMediaData>).seasonCount,
                        episodeCount:
                            ('episodeCount' in details ? details.episodeCount : undefined) ??
                            getDataOr(enrichedState, {} as Partial<ModalMediaData>).episodeCount,
                        availableEpisodeCount:
                            ('availableEpisodeCount' in details
                                ? details.availableEpisodeCount
                                : undefined) ??
                            getDataOr(enrichedState, {} as Partial<ModalMediaData>)
                                .availableEpisodeCount,
                        watchedEpisodeCount:
                            ('watchedEpisodeCount' in details
                                ? details.watchedEpisodeCount
                                : undefined) ??
                            getDataOr(enrichedState, {} as Partial<ModalMediaData>)
                                .watchedEpisodeCount,
                        unwatchedEpisodeCount:
                            ('unwatchedEpisodeCount' in details
                                ? details.unwatchedEpisodeCount
                                : undefined) ??
                            getDataOr(enrichedState, {} as Partial<ModalMediaData>)
                                .unwatchedEpisodeCount,

                        genres: details.genres,
                        actors: details.actors,
                        directors: details.directors?.map((d: { name: string }) => d.name),
                        canRequest: details.canRequest,
                        isAvailable: details.isAvailable,
                        // NOTE: buildMediaDetail() (defs/catalog/media-id-context.ts)
                        // calls the shared builder with an empty `include`, so
                        // rich fields (trailerUrl/hasLocalTrailer) never
                        // populate on this composite path today. This write
                        // RACES enrichModalData() (whichever resolves last
                        // replaces enrichedState wholesale), so these two
                        // fields must fall back to the previously-enriched
                        // values — a bare `details.trailerUrl` here clobbered
                        // the enrichment's real values with undefined and the
                        // trailer pill vanished whenever context resolved last.
                        remoteTrailers:
                            details.trailerUrl ??
                            getDataOr(enrichedState, {} as Partial<ModalMediaData>).remoteTrailers,
                        hasLocalTrailer:
                            details.hasLocalTrailer ??
                            getDataOr(enrichedState, {} as Partial<ModalMediaData>).hasLocalTrailer,
                        extras:
                            details.extras ??
                            getDataOr(enrichedState, {} as Partial<ModalMediaData>).extras,
                        originalLanguage: details.originalLanguage,
                        audioLanguages: details.audioLanguages,
                        subtitleLanguages: details.subtitleLanguages,
                        // `ids` is the new open external-ID map (replaces old `externalIds`).
                        // Cast to ExternalIds for the modal self-heal pattern.
                        // MERGED, not replaced: `??` would let a partial `ids` map
                        // (or an absent one) drop an id the enrichment path had
                        // already resolved, since the later of the two writers
                        // replaces this state wholesale.
                        externalIds: {
                            ...getDataOr(enrichedState, {} as Partial<ModalMediaData>).externalIds,
                            ...(details.ids as ExternalIds | undefined),
                        },
                        rtCritic: (ratings?.rtCritic as number) ?? undefined,
                        rtAudience: (ratings?.rtAudience as number) ?? undefined,
                        letterboxdRating: (ratings?.letterboxdRating as number) ?? undefined,
                        mdblistScore: (ratings?.mdblistScore as number) ?? undefined,
                        metacriticScore: (ratings?.metacriticScore as number) ?? undefined,
                        traktScore: (ratings?.traktScore as number) ?? undefined,
                    },
                    compositeKey,
                );
            }

            // NOTE: similar + social are deliberately NOT part of the composite
            // `sections` request — they load in parallel via their own effects so
            // they don't wait a full composite RTT (see loadSimilarContent /
            // loadSocialActivity below). Do NOT re-add 'similar'/'social' to the
            // composite here without also removing those parallel effects, or the
            // two writers will race on similarState/socialState.

            // --- rating → ratingState ---
            if (data.rating !== undefined && compositeKey) {
                ratingState = success(data.rating.rating ?? null, compositeKey);
            }

            // --- nextEpisode → nextEpisodeState ---
            if (
                data.nextEpisode &&
                data.nextEpisode.seasonNumber !== null &&
                data.nextEpisode.episodeNumber !== null
            ) {
                nextEpisodeState = success(
                    {
                        id: data.nextEpisode.id,
                        seasonNumber: data.nextEpisode.seasonNumber,
                        episodeNumber: data.nextEpisode.episodeNumber,
                        // NextUp only ever picks a playable episode.
                        playable: true,
                    },
                    mediaIdentifier,
                );
                // If the modal was opened for a specific episode that differs from
                // the NextUp result (e.g. URL has season=1&episode=5 but NextUp
                // returns S1E1), discard the composite result so the fallback
                // effect fetches the explicitly selected episode instead.
                const explicit = explicitEpisodeTarget();
                if (
                    explicit &&
                    (data.nextEpisode.seasonNumber !== explicit.season ||
                        data.nextEpisode.episodeNumber !== explicit.episode)
                ) {
                    nextEpisodeState = idle();
                }
            } else if (data.nextEpisode) {
                // An episode with unknown coordinates cannot drive a numbered
                // action. Leave it unresolved so the explicit-selection fallback
                // can still load the episode the viewer actually opened.
                nextEpisodeState = idle();
            } else if (sections.includes('nextEpisode')) {
                nextEpisodeState = success(null, mediaIdentifier);
            }

            // --- watched → watchedState ---
            if (data.watched !== undefined) {
                watchedState = success(data.watched.watched, mediaIdentifier);
            }
        } catch (err) {
            console.warn(
                '[useModalData] Composite context failed, falling back to individual fetches:',
                err instanceof Error ? err.message : 'Unknown',
            );
        } finally {
            // Only flip the fallback gate when the LATEST composite call
            // resolves — stale calls would let fallbacks fire prematurely
            // while the in-flight newest call is still loading.
            if (seq === compositeSeq) {
                contextAttempted = true;
                if (countRefreshPending) void refreshEpisodeCounts();
            }
        }
    }

    // =========================================================================
    // Action Methods (exposed for event handlers)
    // =========================================================================

    async function loadWatchedStatus(itemId: string): Promise<void> {
        if (!itemId) return;

        // Deduplicate
        if (isLoading(watchedState) && watchedState.requestKey === itemId) {
            return;
        }
        if (watchedState.status === 'success' && watchedState.requestKey === itemId) {
            return;
        }

        watchedState = loading(itemId);

        try {
            const watched = await fetchWatchedStatus(itemId);
            // Stale guard: discard if a newer request for a different item
            // superseded this one (rapid A→B modal swap).
            if (isRequestStale(watchedState, itemId)) {
                return;
            }
            watchedState = success(watched, itemId);
        } catch (err) {
            console.warn(
                '[useModalData] Watched status load failed:',
                err instanceof Error ? err.message : 'Unknown',
            );
            if (isRequestStale(watchedState, itemId)) {
                return;
            }
            watchedState = errorFromUnknown(err);
        }
    }

    /**
     * Toggle watched status with watchedLoading guard (DL-009).
     * Disables toggle during in-flight request to prevent race condition.
     */
    async function performWatchedToggle(
        itemId: string,
        currentlyWatched: boolean,
        context?: {
            externalIds?: ExternalIds;
            mediaType?: string;
            title?: string;
        },
    ): Promise<boolean> {
        if (watchedLoading) return currentlyWatched;

        watchedLoading = true;
        try {
            const newWatched = await withSelfMutation(() =>
                toggleWatchedStatus(itemId, currentlyWatched, context),
            );
            // Key by currentMediaIdentifier (what isWatched reads), not itemId (always the internal UUID) — mismatched keys made getDataForKey fall back to `false` forever after any toggle.
            watchedState = success(newWatched, currentMediaIdentifier as string | undefined);
            return newWatched;
        } catch (err) {
            console.warn('[useModalData] Failed to toggle watched status:', err);
            return currentlyWatched;
        } finally {
            watchedLoading = false;
        }
    }

    function handleRated(rating: number): void {
        // Update rating state with current requestKey preserved
        const currentKey = ratingState.status === 'success' ? ratingState.requestKey : undefined;
        ratingState = success(rating, currentKey);

        // Notify other components (e.g. RecommendationFeed's refresh-available chip)
        // that a rating was submitted
        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('rating-submitted'));
        }
    }

    function handleRatingCleared(): void {
        // Same key-preservation as handleRated so the userRating getter (keyed
        // by currentCompositeKey) picks up the cleared value immediately.
        const currentKey = ratingState.status === 'success' ? ratingState.requestKey : undefined;
        ratingState = success(null, currentKey);

        if (typeof document !== 'undefined') {
            document.dispatchEvent(new CustomEvent('rating-submitted'));
        }
    }

    function retryNextEpisode(): void {
        nextEpisodeState = idle();
        if (currentMediaIdentifier) {
            loadNextEpisode(currentMediaIdentifier);
        }
    }

    function retryEnrichment(): void {
        enrichedState = idle();
        if (currentExternalIds && rawModalValue) {
            enrichModalData(currentExternalIds, rawModalValue);
        }
    }

    // =========================================================================
    // Similar Movies Section Builder
    // =========================================================================

    function transformSimilarMovie(movie: ContextSimilarItem): UniversalMediaItem {
        // `type` is the new canonical discriminator (replaces old `mediaType`)
        const isSeriesItem = checkIsSeries(movie.type);
        // Two vocabularies, deliberately NOT one variable:
        //  - `keyMediaType` ('tv') feeds mediaCompositeKey/imageFromIds, which
        //    interpolate it verbatim into `provider:id:type`. Emitting 'series'
        //    here would silently change every composite key this rail produces.
        //  - `mediaType` on a UniversalMediaItem is the public discriminator and
        //    is always 'series'.
        const keyMediaType = isSeriesItem ? 'tv' : 'movie';
        const cardMediaType = isSeriesItem ? 'series' : 'movie';
        // `ids` is the new open ID map — cast to ExternalIds for downstream helpers
        const externalIds = movie.ids as ExternalIds;
        const compositeKey = mediaCompositeKey(externalIds, keyMediaType, movie.id);
        // Prefer images{} href over the legacy imageFromIds helper
        const posterHref = pickVariant(movie.images?.poster, 'thumb');
        return {
            id: `similar-${compositeKey}`,
            externalIds,
            mediaType: cardMediaType,
            title: movie.title,
            subtitle: m.modal_similar_percent({
                percent: String(Math.round((movie.similarity ?? 0) * 100)),
            }),
            image:
                posterHref ??
                imageFromIds(externalIds, 'poster', keyMediaType, { size: 'thumb' }) ??
                '',
            isAvailable: movie.isAvailable as boolean,
            canRequest: movie.canRequest as boolean,
            rating: undefined, // rating not carried on context similar items
            similarityScore: movie.similarity,
            clickData: { originalMovie: movie },
        };
    }

    function buildSimilarSection(
        state: AsyncState<ContextSimilarItem[]>,
        isMovieType: boolean,
    ): PageSection | null {
        const movies = getDataOr(state, []);
        const loading = isLoading(state);
        const hasError = state.status === 'error';

        if (movies.length === 0 && !loading && !hasError) return null;
        return {
            id: 'similar-movies',
            type: 'carousel',
            title: isMovieType ? m.modal_similar_movies() : m.modal_similar_series(),
            items: movies.map(transformSimilarMovie),
            meta: {
                loading: loading && movies.length === 0,
                error:
                    hasError && movies.length === 0 ? 'Could not load similar content' : undefined,
                showRemoveButton: false,
                hoverPopupEnabled: false,
                collapsible: false,
                showRefresh: false,
            },
        };
    }

    const similarSection = $derived(buildSimilarSection(similarState, isMovie));

    // =========================================================================
    // Effects (6 reactive data-fetching patterns)
    // =========================================================================

    // Reset state when media identity changes, then fire composite fetch
    $effect(() => {
        // `compositeAvailable` (declared with the other derived values) MUST mirror
        // this expression — it is what tells the enrichment fallback whether waiting
        // on `contextAttempted` can ever pay off.
        const mediaIdentifier = currentMediaIdentifier;
        if (mediaIdentifier && mediaIdentifier !== lastMediaId) {
            untrack(() => {
                lastMediaId = mediaIdentifier;
            });
            resetState();
            loadCompositeContext();
        }
    });

    // Cross-instance watch-state invalidation. When ANY modal (or sub-modal,
    // or external code path) toggles a watched state, watchStateVersion bumps.
    // We subscribe and reset our local watchedState/nextEpisodeState so the
    // fallback effects re-fetch fresh data. The initial subscriber fire
    // (current value) is ignored via lastSeenVersion.
    //
    // selfMutating=true while THIS composable is performing its own watch-
    // state mutation. The mutation triggers a global bump, but our own
    // mutation methods already update local state correctly (e.g.
    // markNextEpisodeWatched deliberately keeps nextEpisodeState stale to
    // power the undo affordance). Skipping the subscriber for self-triggered
    // bumps prevents that flow from being clobbered.
    let lastSeenVersion = untrack(() => getStore(watchStateVersion));
    let selfMutating = false;
    $effect(() => {
        const unsub = watchStateVersion.subscribe((version) => {
            if (version === lastSeenVersion) return;
            lastSeenVersion = version;
            if (isSeries) void refreshEpisodeCounts();
            if (selfMutating) return;
            // Only invalidate after the initial composite has attempted —
            // resetting during the initial load would collide with the
            // composite's distribution to states.
            if (!contextAttempted) return;
            if (watchedState.status !== 'idle') {
                watchedState = idle();
            }
            if (nextEpisodeState.status !== 'idle') {
                nextEpisodeState = idle();
            }
        });
        return unsub;
    });

    /** Wrap a self-mutation (mark/unmark) so its bump doesn't invalidate own state. */
    async function withSelfMutation<T>(fn: () => Promise<T>): Promise<T> {
        selfMutating = true;
        try {
            return await fn();
        } finally {
            selfMutating = false;
        }
    }

    // ── Fallback effects ──────────────────────────────────────────────
    // Most of these fire only after the composite context fetch has been
    // attempted. If the composite provided the data, the state won't be 'idle'
    // and the dedup guards inside the load functions will skip the fetch.
    //
    // EXCEPTION — similar + social: the composite call deliberately EXCLUDES
    // these two slow sections (pgvector / external fetch), so it never writes
    // their state. They only need `currentExternalIds` (available synchronously),
    // so they fire from their OWN effects keyed on currentExternalIds /
    // currentCompositeKey, in PARALLEL with the composite — NOT gated on
    // contextAttempted. Their AsyncState + composite-key dedup guards already
    // make them safe to race against a rapid A→B modal swap.

    // Fallback: fetch next episode for series.
    $effect(() => {
        if (
            contextAttempted &&
            isSeries &&
            currentMediaIdentifier &&
            nextEpisodeState.status === 'idle'
        ) {
            loadNextEpisode(currentMediaIdentifier);
        }
    });

    // Fallback: auto-enrich missing modal data
    $effect(() => {
        const runEnrichment = shouldAutoEnrich({
            contextAttempted,
            compositeAvailable,
            needsEnrichment: modalNeedsEnrichment,
            hasExternalIds: !!currentExternalIds,
        });
        if (runEnrichment && currentExternalIds && rawModalValue) {
            enrichModalData(currentExternalIds, rawModalValue);
        }
    });

    // Parallel: fetch social activity (skip for age-restricted profiles).
    // Not gated on contextAttempted — the composite never carries social, and
    // this only needs currentExternalIds, so it races the composite RTT.
    $effect(() => {
        if (
            getSocialEnabled() &&
            !getIsAgeRestricted() &&
            socialLookupReady &&
            currentCompositeKey &&
            // Social activity is fetched per TMDB entity, so a row with no TMDB
            // namespace has nothing to look up. It used to be asked for with a
            // clamped 'movie', which returned another title's activity. An
            // audiobook is the exception: it is keyed by UUID instead.
            (apiMediaType !== null || isAudiobookItem) &&
            (socialState.status === 'idle' ||
                (socialState.status === 'success' &&
                    socialState.requestKey !== currentCompositeKey))
        ) {
            loadSocialActivity(currentExternalIds!, apiMediaType ?? 'audiobook');
        }
    });

    // Fallback: fetch user rating for movies, series, and episodes
    $effect(() => {
        if (!contextAttempted) return;
        // `apiMediaType !== null` is redundant with the isMovie/isSeries/isEpisode
        // guards — those three are exactly the types TMDB has a namespace for —
        // but it is written out so the non-null-ness is STRUCTURAL rather than
        // asserted. If the guards above are ever relaxed, the rating fetch is
        // skipped instead of being made against a fabricated 'movie'.
        if (apiMediaType === null) return;
        if (isMovie || isSeries) {
            if (hasValidExternalId(currentExternalIds)) {
                loadUserRating(currentExternalIds!, apiMediaType);
            }
        } else if (isEpisode && currentExternalIds?.internal) {
            // Episodes use internal UUID as primary identifier
            loadUserRating(currentExternalIds, apiMediaType);
        }
    });

    // Parallel: fetch similar content (skip for age-restricted profiles and
    // episodes). Not gated on contextAttempted — the composite never carries
    // similar, and this only needs currentExternalIds, so it races the composite
    // RTT. loadSimilarContent's composite-key dedup keeps repeat runs safe.
    $effect(() => {
        if (
            hasValidExternalId(currentExternalIds) &&
            (isMovie || isSeries) &&
            // Redundant with (isMovie || isSeries), kept so the non-null-ness is
            // structural rather than asserted — see the rating effect above.
            apiMediaType !== null &&
            !getIsAgeRestricted()
        ) {
            loadSimilarContent(currentExternalIds!, apiMediaType);
        }
    });

    // Fallback: fetch watched status if composite didn't provide it
    $effect(() => {
        const mediaIdentifier = currentMediaIdentifier;
        if (contextAttempted && mediaIdentifier && watchedState.status === 'idle') {
            loadWatchedStatus(mediaIdentifier);
        }
    });

    // =========================================================================
    // Return reactive object
    // =========================================================================

    return {
        // Reactive state (getters for Svelte 5 reactivity)
        get enrichedData() {
            return enrichedData;
        },
        get modalValue() {
            return modalValue;
        },
        get similarMovies() {
            return getDataForKey(similarState, currentCompositeKey, []);
        },
        get socialActivities() {
            return getDataForKey(socialState, currentCompositeKey, []);
        },
        get userRating() {
            return getDataForKey(ratingState, currentCompositeKey, null);
        },
        get isWatched() {
            return getDataForKey(watchedState, currentMediaIdentifier, false);
        },
        get watchedLoading() {
            return watchedLoading;
        },
        get nextEpisodeId() {
            const data = getDataOr(nextEpisodeState, null);
            return data?.id ?? null;
        },
        get nextEpisode() {
            const data = getDataOr(nextEpisodeState, null);
            return data
                ? {
                      seasonNumber: data.seasonNumber,
                      episodeNumber: data.episodeNumber,
                      playable: data.playable,
                  }
                : null;
        },
        get loadingSimilar() {
            return isLoading(similarState);
        },
        get enrichmentInProgress() {
            return isLoading(enrichedState);
        },
        get nextEpisodeLoading() {
            return isLoading(nextEpisodeState);
        },
        reloadNextEpisode() {
            nextEpisodeState = idle();
        },
        reloadWatchedStatus() {
            watchedState = idle();
        },
        async markNextEpisodeWatched(episodeId: string): Promise<boolean> {
            if (!episodeId) return false;
            if (watchedLoading) return false;
            watchedLoading = true;
            try {
                const marked = await withSelfMutation(() => toggleWatchedStatus(episodeId, false));
                if (!marked) return false;
                // Refresh series-level watched badge only; next-episode reload is
                // deferred so the caller can show an undo affordance first.
                watchedState = idle();
                return true;
            } finally {
                watchedLoading = false;
            }
        },
        async markEpisodeUnwatched(episodeId: string): Promise<boolean> {
            if (!episodeId) return false;
            if (watchedLoading) return false;
            watchedLoading = true;
            try {
                const nowWatched = await withSelfMutation(() =>
                    toggleWatchedStatus(episodeId, true),
                );
                if (nowWatched) return false; // API error — still watched
                nextEpisodeState = idle();
                watchedState = idle();
                return true;
            } finally {
                watchedLoading = false;
            }
        },
        // Error flags
        get enrichmentError() {
            return enrichedState.status === 'error';
        },
        get nextEpisodeError() {
            return nextEpisodeState.status === 'error';
        },
        get watchedStatusError() {
            return watchedState.status === 'error';
        },
        get similarContentError() {
            return similarState.status === 'error';
        },
        get socialActivityError() {
            return socialState.status === 'error';
        },
        get userRatingError() {
            return ratingState.status === 'error';
        },
        get similarSection() {
            return similarSection;
        },
        get isSeries() {
            return isSeries;
        },
        get isMovie() {
            return isMovie;
        },
        get isEpisode() {
            return isEpisode;
        },
        get apiMediaType() {
            return apiMediaType;
        },
        get currentExternalIds() {
            return currentExternalIds;
        },
        get mediaDbId() {
            return currentExternalIds?.internal ?? undefined;
        },
        // Action methods
        loadWatchedStatus,
        performWatchedToggle,
        handleRated,
        handleRatingCleared,
        retryNextEpisode,
        retryEnrichment,
        refreshSocialActivity(): void {
            socialState = idle();
        },
    };
}
