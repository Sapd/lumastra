// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Modal URL Synchronization
 *
 * SINGLE SOURCE OF TRUTH for modal-related URL updates.
 * Auto-subscribes to modal stack and keeps URL in sync.
 *
 * This module:
 * - Updates URL when modals open/close/change
 * - Provides openModalFromUrl() for page load
 * - Ensures URL always reflects current modal state
 *
 * IMPORTANT: All manual URL update calls should be removed from components.
 * This module is the only place that should update modal-related URL params.
 */

/* eslint-disable svelte/no-navigation-without-resolve -- Using resolve from $lib/paths wrapper */

import { get } from 'svelte/store';
import { browser } from '$app/environment';
import { pushState, replaceState } from '$app/navigation';
import { resolve, stripBase } from '$lib/paths';
import { page } from '$app/stores';
import { modalStack, modals, type ModalEntry } from '$lib/stores/modal.store';
import type { ExternalIds } from '$lib/types/api-common';
import { buildMediaKey } from '$lib/utils/media-id-helpers';
import { buildEpisodeSlug, buildTitleSlug, slugKindForMediaType } from '$lib/utils/url-slugs';
import { isEpisode, isMovie, isSeries } from '$lib/shared/media-types';
import { toInternalMediaType, type MediaTypeInternal } from '$lib/shared/media-type-domain';
import { UUID_RE_LOOSE as UUID_REGEX } from '$lib/utils/id-patterns.js';

function isWatchUrl(url: URL): boolean {
    return /\/watch\/[^/]+/.test(url.pathname);
}

/**
 * Write the modal URL via SvelteKit SHALLOW routing (`pushState`/`replaceState`)
 * instead of `goto`. A modal is client state — the URL is just a deep-link — so
 * it must NOT re-run the page's `load` functions. `goto` did: opening a modal
 * fired `/__data.json?...x-sveltekit-invalidated` plus a flood of home refetches
 * (For-You, recommendations, hero previews), re-rendering the whole page behind
 * the modal — the "enormous flicker". Shallow routing updates the address bar +
 * history without any navigation/load/re-render. Browser Back/Forward is handled
 * by an explicit `popstate` listener (below), since shallow pops do NOT fire
 * `afterNavigate`. Mirrors `$lib/components/admin/detail/detail-url.ts`.
 */
function sameNavigationUrl(left: string, right: string): boolean {
    const a = new URL(left, window.location.href);
    const b = new URL(right, window.location.href);
    a.searchParams.sort();
    b.searchParams.sort();
    return a.href === b.href;
}

function applyModalUrl(pathAndSearch: string, replace: boolean): void {
    if (!browser) return;
    const target = resolve(stripBase(pathAndSearch));
    const state = get(page).state;
    if (
        _poppingTrail &&
        state.modalPreviousUrl &&
        sameNavigationUrl(state.modalPreviousUrl, target)
    ) {
        // The previous browser entry is exactly the parent we just exposed.
        // Traverse it instead of pushing the child back onto the return path.
        window.history.back();
    } else if (replace) {
        replaceState(target, state);
    } else {
        pushState(target, {
            ...state,
            modalPreviousUrl: window.location.pathname + window.location.search,
        });
    }
}

function clearModalParams(): void {
    if (!browser) return;

    const url = new URL(window.location.href);
    const hasModalParams =
        url.searchParams.has('modal') ||
        url.searchParams.has('actor') ||
        url.searchParams.has('artist') ||
        url.searchParams.has('album');

    if (!hasModalParams) return;

    url.searchParams.delete('modal');
    url.searchParams.delete('actor');
    url.searchParams.delete('actorName');
    url.searchParams.delete('season');
    url.searchParams.delete('episode');
    if (!isWatchUrl(url)) {
        url.searchParams.delete('slug');
    }
    url.searchParams.delete('artist');
    url.searchParams.delete('album');

    applyModalUrl(url.pathname + url.search, true);
}

// =============================================================================
// URL Sync Suppression
// =============================================================================

/**
 * When a modal is opened from URL (page load / back navigation), the URL is
 * already correct. Suppress the next URL sync to avoid overwriting e.g. an
 * episode UUID with the resolved series composite key.
 */
let _suppressNextUrlSync = false;

/**
 * The trail key of the last modal we synced to the URL. Comparing the new top's
 * trail key against this tells the sync whether the user JUMPED to a different
 * entity (→ pushState, so browser Back steps one trail step) or merely SWAPPED
 * content within the same entity (→ replaceState, no history spam).
 */
let _lastSyncedTrailKey: string | null = null;

/**
 * True while reconcileModalsFromUrl() is popping/rebuilding the stack to match a
 * popstate. The URL is already the source of truth during reconcile, so the
 * modal-stack subscriber must NOT write it back (which would push spurious
 * history entries mid-back-navigation).
 */
let _reconciling = false;
let _poppingTrail = false;

// =============================================================================
// Modal to URL Sync
// =============================================================================

/**
 * internal media type → the `?modal=` composite-key vocabulary.
 *
 * Exhaustive over `MediaTypeInternal`, so adding a media type is a compile error
 * here until someone decides whether it is deep-linkable by composite key.
 *
 * `null` means "this type has no `?modal=` composite spelling". It is NOT the
 * same as "not deep-linkable": every `media_items` row has an internal UUID, and
 * `buildMediaKey` prefers that UUID over any composite form, so a null here only
 * affects rows that additionally have no UUID.
 */
const TO_MODAL_KEY_TYPE: Readonly<Record<MediaTypeInternal, 'movie' | 'tv' | 'episode' | null>> = {
    movie: 'movie',
    tv: 'tv',
    episode: 'episode',
    // A season deep-links as its series plus ?season=N (see the episode branch
    // in updateUrlForModal), never as a composite key of its own.
    season: null,
    extra: null,
    audiobook: null,
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: null,
    album: null,
    track: null,
    audio: null,
    music: null,
    tvchannel: null,
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * Normalize a media type to the `?modal=` composite-key vocabulary, or `null`
 * when that vocabulary cannot express it.
 *
 * It used to end in `default: return 'movie'`, and its own doc comment warned
 * "LOSSY BY DESIGN — never feed this function's output to a media-type
 * predicate" because `isAudiobook(normalizeType(x))` is dead code. That warning
 * was the workaround; this is the fix. The old default was not merely lossy, it
 * was actively wrong: it turned an audiobook into the composite key
 * `tmdb:<id>:movie`, which on reopen resolved to a DIFFERENT entity — whichever
 * movie happens to hold that TMDB id.
 */
function normalizeType(type: string): 'movie' | 'tv' | 'episode' | null {
    const internal = toInternalMediaType(type);
    return internal === null ? null : TO_MODAL_KEY_TYPE[internal];
}

/**
 * Update URL based on modal props
 * Called automatically when modal stack changes
 */
function updateUrlForModal(props: Record<string, unknown>, isJump = false): void {
    if (!browser) return;

    // Skip URL update when modal was opened from URL — the URL is already correct
    if (_suppressNextUrlSync) {
        _suppressNextUrlSync = false;
        return;
    }

    // Entity JUMPS (different trail key) push a history entry so browser Back
    // steps one trail step; content SWAPS (same entity — season/episode changes,
    // metadata loads) replace in place so history stays in lockstep with the
    // trail and doesn't fill with spam.

    // Media modal: ?modal=tmdb:550:movie
    if (props.externalIds && props.mediaType) {
        const externalIds = props.externalIds as ExternalIds;
        // The type as the opener passed it — any case convention, any library
        // type. Use THIS for every media-type predicate. `mediaType` below is the
        // lossy `?modal=` composite-key form; see normalizeType's doc comment.
        const rawMediaType = String(props.mediaType);
        const mediaType = normalizeType(rawMediaType);
        const season =
            typeof props.initialSeason === 'number'
                ? props.initialSeason
                : typeof props.seasonNumber === 'number'
                  ? props.seasonNumber
                  : undefined;
        const episode =
            typeof props.initialEpisode === 'number'
                ? props.initialEpisode
                : typeof props.episodeNumber === 'number'
                  ? props.episodeNumber
                  : undefined;
        const mediaTitle =
            typeof props.title === 'string'
                ? props.title
                : typeof props.seriesName === 'string'
                  ? props.seriesName
                  : undefined;

        // For episodes with a series context, save the SERIES identifier in the URL.
        // This ensures reopening shows the full series modal with seasons/episodes
        // and play button, instead of a bare episode with no context.
        // Also preserve season/episode numbers so back navigation can auto-expand.
        const seriesIdForUrl = props.seriesInternalId;
        if (isEpisode(rawMediaType) && seriesIdForUrl) {
            const url = new URL(window.location.href);
            url.searchParams.set('modal', String(seriesIdForUrl));
            if (season != null) {
                url.searchParams.set('season', String(season));
            }
            if (episode != null) {
                url.searchParams.set('episode', String(episode));
            }
            if (mediaTitle && season != null && episode != null) {
                url.searchParams.set(
                    'slug',
                    buildEpisodeSlug(
                        typeof props.seriesName === 'string' ? props.seriesName : mediaTitle,
                        season,
                        episode,
                    ),
                );
            } else {
                url.searchParams.delete('slug');
            }
            applyModalUrl(url.pathname + url.search, !isJump);
            return;
        }

        // Gate on buildMediaKey (UUID-first, includeUuids) returning a key —
        // NOT on hasValidExternalId, which excludes internal-only UUIDs. A
        // local movie with no external provider id (e.g. not in TMDB) still has
        // an internal UUID and a valid bare-UUID modal key; gating on
        // hasValidExternalId left such items with no ?modal= param, so the modal
        // opened with no deep link and back-nav couldn't reopen it.
        {
            // `mediaType ?? rawMediaType`: buildMediaKey prefers
            // externalIds.internal (a bare UUID), so the type only ever appears
            // in the provider-composite fallback. For a row the `?modal=`
            // vocabulary cannot express, carrying its OWN type keeps the key
            // honest — the old 'movie' default produced a well-formed key that
            // reopened the wrong entity, which is strictly worse than a key that
            // only works in its UUID form.
            const key = buildMediaKey(externalIds, mediaType ?? rawMediaType);
            if (key) {
                const url = new URL(window.location.href);
                url.searchParams.set('modal', key);
                if (season != null) {
                    url.searchParams.set('season', String(season));
                } else {
                    url.searchParams.delete('season');
                }
                if (episode != null) {
                    url.searchParams.set('episode', String(episode));
                } else {
                    url.searchParams.delete('episode');
                }
                if (mediaTitle) {
                    // Reached whenever a non-series, non-episode modal is opened
                    // directly rather than restored from a URL — the ordinary path
                    // from a browse or Continue-Watching card.
                    //
                    // `rawMediaType`, NOT `mediaType`: the latter is
                    // normalizeType()'s output, which has already collapsed
                    // 'audiobook' onto its 'movie' default, so an `isAudiobook()`
                    // check on it could never fire. That is exactly why the earlier
                    // fix to this expression changed nothing in production.
                    const slugKind = slugKindForMediaType(rawMediaType);
                    const slug =
                        isSeries(rawMediaType) && season != null && episode != null
                            ? buildEpisodeSlug(mediaTitle, season, episode)
                            : buildTitleSlug(slugKind, mediaTitle);
                    if (slug) {
                        url.searchParams.set('slug', slug);
                    } else {
                        url.searchParams.delete('slug');
                    }
                } else {
                    url.searchParams.delete('slug');
                }
                // Clear actor params if they exist
                url.searchParams.delete('actor');
                url.searchParams.delete('actorName');
                applyModalUrl(url.pathname + url.search, !isJump);
                return;
            }
        }
    }

    // Actor modal: ?actor=287&actorName=Brad+Pitt
    if (props.actorId) {
        const url = new URL(window.location.href);
        url.searchParams.set('actor', String(props.actorId));
        if (props.actorName) {
            url.searchParams.set('actorName', String(props.actorName));
            const slug = buildTitleSlug('actor', String(props.actorName));
            if (slug) {
                url.searchParams.set('slug', slug);
            }
        } else {
            url.searchParams.delete('actorName');
            url.searchParams.delete('slug');
        }
        url.searchParams.delete('modal');
        url.searchParams.delete('season');
        url.searchParams.delete('episode');
        url.searchParams.delete('artist');
        url.searchParams.delete('album');
        applyModalUrl(url.pathname + url.search, !isJump);
        return;
    }

    // Artist modal: ?artist=<uuid>
    if (props.artistId) {
        const url = new URL(window.location.href);
        url.searchParams.set('artist', String(props.artistId));
        url.searchParams.delete('modal');
        url.searchParams.delete('actor');
        url.searchParams.delete('actorName');
        url.searchParams.delete('season');
        url.searchParams.delete('episode');
        // Mirror the album branch's delete('artist'): closing an album modal
        // that was stacked on top of this artist modal re-runs this branch,
        // and without the delete the stale ?album= param survives — the
        // shared URL would then reopen the album, not the visible artist.
        url.searchParams.delete('album');
        const slug =
            typeof props.artistName === 'string'
                ? buildTitleSlug('artist', props.artistName)
                : null;
        if (slug) {
            url.searchParams.set('slug', slug);
        } else {
            url.searchParams.delete('slug');
        }
        applyModalUrl(url.pathname + url.search, !isJump);
        return;
    }

    // Album modal: ?album=<uuid>
    if (props.albumId) {
        const url = new URL(window.location.href);
        url.searchParams.set('album', String(props.albumId));
        url.searchParams.delete('modal');
        url.searchParams.delete('actor');
        url.searchParams.delete('actorName');
        url.searchParams.delete('artist');
        url.searchParams.delete('season');
        url.searchParams.delete('episode');
        const slug =
            typeof props.albumTitle === 'string' ? buildTitleSlug('album', props.albumTitle) : null;
        if (slug) {
            url.searchParams.set('slug', slug);
        } else {
            url.searchParams.delete('slug');
        }
        applyModalUrl(url.pathname + url.search, !isJump);
        return;
    }

    // No recognizable modal props - clear params
    clearModalParams();
}

// =============================================================================
// Auto-Subscribe to Modal Stack (Side Effect)
// =============================================================================

// BROWSER GUARD: Prevent SSR side effects
if (browser) {
    // Skip the very first subscriber fire (initial subscription with empty stack).
    // On page load with ?modal=... the stack is empty, but we must NOT clear the
    // URL — openModalFromUrl() still needs to read it.
    let _firstFire = true;
    let previousIds: string[] = [];

    modalStack.subscribe((stack) => {
        if (_firstFire) {
            _firstFire = false;
            return;
        }

        const topModal = stack[stack.length - 1];
        const returnedToExisting = !!topModal && previousIds.includes(topModal.id);
        const shrank = stack.length < previousIds.length;
        previousIds = stack.map((entry) => entry.id);

        // While reconciling to a popstate, the URL is already authoritative —
        // just keep the jump-tracker current and don't write the URL back.
        if (_reconciling) {
            _lastSyncedTrailKey = topModal?.options?.trailKey ?? null;
            return;
        }

        if (!topModal) {
            _lastSyncedTrailKey = null;
            clearModalParams();
        } else {
            const key = topModal.options?.trailKey ?? null;
            const isJump = key !== _lastSyncedTrailKey && !returnedToExisting;
            _lastSyncedTrailKey = key;
            _poppingTrail = shrank && returnedToExisting;
            try {
                updateUrlForModal(topModal.props, isJump);
            } finally {
                _poppingTrail = false;
            }
        }
    });

    // Browser Back/Forward (incl. mobile edge-swipe) reconcile. Because modal
    // URLs are written via SHALLOW routing (pushState/replaceState), popping
    // them does NOT fire SvelteKit's afterNavigate — so we listen to the raw
    // `popstate` event directly and reconcile the stack to whatever the URL now
    // says (pop to the named trail step, or close/rebuild). Our own writes use
    // pushState/replaceState which never emit popstate, so this only fires on
    // real user Back/Forward.
    window.addEventListener('popstate', () => {
        void reconcileModalsFromUrl();
    });
}

// =============================================================================
// URL to Modal (Page Load)
// =============================================================================

export interface MediaModalParams {
    type: 'media';
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    /** Season number from URL (for back-navigation episode context) */
    seasonNumber?: number;
    /** Episode number from URL (for back-navigation episode context) */
    episodeNumber?: number;
}

export interface ActorModalParams {
    type: 'actor';
    actorId: number | string;
    actorName?: string;
}

export interface ArtistModalParams {
    type: 'artist';
    artistId: string;
}

export interface AlbumModalParams {
    type: 'album';
    albumId: string;
}

/**
 * Parse modal parameters from current URL
 * Returns null if no modal params found
 *
 * Supports:
 * - UUID format: ?modal=a3f5e8c7-1234-5678-90ab-cdef12345678
 * - Composite format: ?modal=tmdb:550:movie
 */
export function getModalFromUrl():
    MediaModalParams | ActorModalParams | ArtistModalParams | AlbumModalParams | null {
    if (!browser) return null;

    const url = new URL(window.location.href);

    // Parse optional season/episode context from URL
    const seasonParam = url.searchParams.get('season');
    const episodeParam = url.searchParams.get('episode');
    const seasonNumber = seasonParam ? parseInt(seasonParam, 10) : undefined;
    const episodeNumber = episodeParam ? parseInt(episodeParam, 10) : undefined;

    // Check for media modal
    const modalParam = url.searchParams.get('modal');
    if (modalParam) {
        // Check if it's a UUID (internal or Jellyfin ID)
        if (UUID_REGEX.test(modalParam)) {
            // For UUIDs, we'll resolve the media type server-side
            // Pass as internal ID - the modal opener will fetch details
            return {
                type: 'media',
                externalIds: { internal: modalParam },
                mediaType: 'movie', // Default, will be resolved from API
                seasonNumber: Number.isFinite(seasonNumber) ? seasonNumber : undefined,
                episodeNumber: Number.isFinite(episodeNumber) ? episodeNumber : undefined,
            };
        }

        // Composite key format: provider:id:mediaType
        const parts = modalParam.split(':');
        if (parts.length === 3) {
            const [provider, id, mediaType] = parts;

            // Validate media type (only movie and tv are valid for modals)
            if (!isMovie(mediaType) && !isSeries(mediaType)) {
                return null;
            }

            // Build ExternalIds object
            const externalIds: ExternalIds = {};
            externalIds[provider as keyof ExternalIds] = id;

            return {
                type: 'media',
                externalIds,
                // isSeries() above accepts BOTH 'tv' and 'series', so a
                // ?modal=tmdb:1399:series URL passes the guard — normalise
                // instead of asserting, or 'series' rides on as MediaModalParams
                // and every consumer comparing === 'tv' takes the movie branch.
                mediaType: isMovie(mediaType) ? 'movie' : 'tv',
                seasonNumber: Number.isFinite(seasonNumber) ? seasonNumber : undefined,
                episodeNumber: Number.isFinite(episodeNumber) ? episodeNumber : undefined,
            };
        }
    }

    // Check for actor modal: ?actor=287
    const actorParam = url.searchParams.get('actor');
    if (actorParam) {
        const actorId = actorParam;
        if (/^(?:tmdb:)?[0-9]+$/.test(actorId)) {
            return {
                type: 'actor',
                actorId,
                actorName: url.searchParams.get('actorName') || undefined,
            };
        }
    }

    // Check for artist modal: ?artist=<uuid>
    const artistParam = url.searchParams.get('artist');
    if (artistParam && UUID_REGEX.test(artistParam)) {
        return { type: 'artist', artistId: artistParam };
    }

    // Check for album modal: ?album=<uuid>
    const albumParam = url.searchParams.get('album');
    if (albumParam && UUID_REGEX.test(albumParam)) {
        return { type: 'album', albumId: albumParam };
    }

    return null;
}

/**
 * Open modal from URL parameters (call on page load)
 * Returns true if modal was opened, false otherwise
 */
export async function openModalFromUrl(): Promise<boolean> {
    if (!browser) return false;

    // Don't open if a modal is already showing (prevents double-open
    // when both onMount and afterNavigate call this function)
    if (modals.hasAny) return false;

    const params = getModalFromUrl();
    if (!params) return false;

    try {
        if (params.type === 'media') {
            // Dynamic import to avoid circular dependency
            const { openMediaModalFromUrl } = await import('$lib/utils/modal-utils');
            // Suppress URL sync — the URL already has the correct modal param
            _suppressNextUrlSync = true;
            const result = await openMediaModalFromUrl(
                params.externalIds,
                params.mediaType,
                params.seasonNumber,
                params.episodeNumber,
            );
            if (!result) _suppressNextUrlSync = false; // Clean up if modal wasn't opened
            return result;
        } else if (params.type === 'actor') {
            // Dynamic import to avoid circular dependency
            const { openActorModalFromUrl } = await import('$lib/utils/modal-utils');
            _suppressNextUrlSync = true;
            const result = openActorModalFromUrl(params.actorId, params.actorName);
            if (!result) _suppressNextUrlSync = false;
            return !!result;
        } else if (params.type === 'artist') {
            const { openArtistModal } = await import('$lib/utils/modal-utils');
            _suppressNextUrlSync = true;
            const result = openArtistModal(params.artistId);
            if (!result?.id) _suppressNextUrlSync = false;
            return !!result?.id;
        } else if (params.type === 'album') {
            const { openAlbumModal } = await import('$lib/utils/modal-utils');
            _suppressNextUrlSync = true;
            const result = openAlbumModal(params.albumId);
            if (!result?.id) _suppressNextUrlSync = false;
            return !!result?.id;
        }
    } catch (error) {
        _suppressNextUrlSync = false; // Clean up on error
        console.error('[ModalUrlSync] Error opening modal from URL:', error);
        clearModalParams();
        return false;
    }

    return false;
}

// =============================================================================
// Popstate Reconcile (browser Back / Forward ↔ trail)
// =============================================================================

/**
 * The bare id token the current URL points at (the raw value of whichever modal
 * param is present). Null when the URL carries no modal.
 */
function urlModalToken(): string | null {
    if (!browser) return null;
    const p = new URL(window.location.href).searchParams;
    return p.get('modal') ?? p.get('actor') ?? p.get('artist') ?? p.get('album') ?? null;
}

/**
 * The bare id token a stack entry corresponds to — its trail key with the
 * category prefix stripped (`series:S7` → `S7`, `media:tmdb:550:movie` →
 * `tmdb:550:movie`, `actor:287` → `287`). This matches the raw value the URL
 * carries for that entity, sidestepping the fact that a bare-UUID `?modal=` has
 * an ambiguous media type until fetched.
 */
function entryModalToken(entry: ModalEntry): string | null {
    const key = entry.options?.trailKey;
    if (!key) return null;
    const idx = key.indexOf(':');
    return idx >= 0 ? key.slice(idx + 1) : key;
}

/**
 * Reconcile the modal stack to the current URL after a browser Back/Forward
 * (popstate). Because entity jumps push one history entry and one trail step in
 * lockstep, the correct response is almost always to POP to the trail step the
 * URL now names — not to tear down and rebuild the whole stack.
 *
 * - URL has no modal        → back out: close the whole trail
 * - URL matches the top      → nothing to do
 * - URL matches a step below → pop down to it (preserves everything beneath)
 * - URL matches nothing/empty stack → rebuild the top from the URL (forward nav
 *   to a modal the stack never held)
 */
let reconciliation: Promise<void> | null = null;
let reconcileAgain = false;

export function reconcileModalsFromUrl(): Promise<void> {
    if (!browser) return Promise.resolve();
    reconcileAgain = true;
    if (reconciliation) return reconciliation;
    reconciliation = (async () => {
        do {
            reconcileAgain = false;
            await reconcileCurrentUrl();
        } while (reconcileAgain);
    })().finally(() => {
        reconciliation = null;
    });
    return reconciliation;
}

async function reconcileCurrentUrl(): Promise<void> {
    _reconciling = true;
    try {
        const token = urlModalToken();
        const stack = get(modalStack);

        if (!token) {
            if (modals.hasAny) await modals.closeAll();
            return;
        }

        if (stack.length === 0) {
            _suppressNextUrlSync = true;
            const opened = await openModalFromUrl();
            if (!opened) _suppressNextUrlSync = false;
            return;
        }

        if (entryModalToken(stack[stack.length - 1]) === token) {
            return; // Already showing the right trail step.
        }

        const idx = stack.findIndex((e) => entryModalToken(e) === token);
        if (idx >= 0) {
            const toPop = stack.length - 1 - idx;
            for (let i = 0; i < toPop; i++) await modals.close();
            return;
        }

        // URL names an entity the stack doesn't hold → rebuild the top from it.
        await modals.closeAll();
        _suppressNextUrlSync = true;
        const opened = await openModalFromUrl();
        if (!opened) _suppressNextUrlSync = false;
    } finally {
        _reconciling = false;
        // The subscriber skipped every write while reconciling, so any
        // suppression flag set along the way has nothing left to suppress —
        // clear it so it can't swallow the next genuine sync.
        _suppressNextUrlSync = false;
    }
}
