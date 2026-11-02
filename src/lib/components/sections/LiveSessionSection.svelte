<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	LiveSessionSection.svelte

	Self-contained component for displaying active streaming sessions.

	Features:
	- Fetches sessions from /api/home/active-sessions
	- Real-time playback progress updates (every second)
	- Technical info overlay on hover (when enabled in preferences)
	- User avatar and username display
	- Privacy toggle (admin only)
	- Season/episode badges for TV content
	- Opens modal with MDB ratings and similar content on click

	@example
	<LiveSessionSection {data} />
-->
<script lang="ts">
    import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
    import { pickVariant } from '$lib/utils/image-utils.js';
    import { onMount, untrack } from 'svelte';
    import { isRecord } from '$lib/utils/data-extraction';
    import { SvelteSet, SvelteDate, SvelteMap } from 'svelte/reactivity';
    import { browser } from '$app/environment';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { modals } from '$lib/stores/modal.store';
    import * as playbackApi from '$lib/api/playback';
    import { toasts } from '$lib/stores/toast.store';
    import { isAuthFailed } from '$lib/auth-monitor';
    import {
        getAvatarUrl,
        imageFromIds,
        getCatalogPosterUrl,
        getCatalogBackdropUrl,
        getCatalogThumbUrl,
        getCatalogLogoUrl,
        fallbackImage,
    } from '$lib/utils/image-utils';
    import * as m from '$lib/paraglide/messages';
    import { showStreamTechInfo } from '$lib/stores/uiPreferences';
    import type { ExternalIds } from '$lib/types/api-common';
    import { openMediaModal, openAlbumModal, openArtistModal } from '$lib/utils/modal-utils';

    import { preventDefault, stopPropagation } from '$lib/utils/event-helpers';
    import { displayName } from '$lib/utils/data-extraction';
    import {
        isMovie,
        isSeries,
        isEpisode,
        isAudio,
        isAudiobook,
        isTvChannel,
    } from '$lib/shared/media-types';
    import { FALLBACK_IMAGE } from '$lib/constants/images';
    import { getFriendlyResolution } from '$lib/utils/media-display';
    import { toPlayMethod, getPlayMethodLabel } from '$lib/utils/playback-method';
    import { isSessionSeedFresh } from '$lib/utils/ssr-seed';
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import * as watchTogetherApi from '$lib/api/watch-together';
    import type { PublicParty } from '$lib/api/watch-together';
    import { CLIENT_TUNING_DEFAULTS } from '$lib/stores/client-tuning';
    import WatchPartyCluster from './WatchPartyCluster.svelte';
    import CrossfadeStreamIndicator from '$lib/components/music/CrossfadeStreamIndicator.svelte';
    import AdaptiveStreamBadge from '$lib/components/sessions/AdaptiveStreamBadge.svelte';
    import type { SessionAdaptive } from '$lib/schemas/session-adaptive.js';
    import { foldWatchParties, type StreamGroup, type WatchPartyTag } from './watch-party-groups';

    // =========================================================================
    // Types
    // =========================================================================

    interface StreamSession {
        __id: string;
        id: string;
        /**
         * Legacy provider id — optional because the SSR loader omits it for
         * UUID-first rows. Both readers below fold it into an `externalIds`
         * record whose `jellyfin` key is itself optional.
         */
        jellyfinId?: string;
        title: string;
        overview?: string;
        /**
         * Mirrors the session source's own union — keep it in step with
         * `StreamSessionMediaTypeSchema` (schemas/api-playback-responses.ts),
         * which is what `data.initialSessions` is actually typed as. It has
         * drifted twice now: first by omitting 'season' | 'book' | 'manga' |
         * 'comic' | 'podcast', then by keeping the DB's 'tv' after the schema
         * moved to the public 'series'. Both times the seed simply could not be
         * passed in. Rendering routes through isAudio()/isEpisode() with a
         * generic fallback, so new tokens need no new branches.
         */
        mediaType:
            | 'movie'
            | 'series'
            | 'episode'
            | 'season'
            | 'audiobook'
            | 'audio'
            | 'music'
            | 'tvchannel'
            | 'track'
            | 'radio'
            | 'book'
            | 'manga'
            | 'comic'
            | 'podcast';
        year?: number;
        author?: string;
        chapter?: string;
        duration?: number;
        seasonNumber?: number;
        episodeNumber?: number;
        seriesName?: string;
        imageId?: string;
        images?: ImageSet;
        seriesId?: string;
        artistId?: string;
        externalIds?: ExternalIds;
        /** Artist name for music tracks (populated from DB join). */
        artistName?: string;
        /** Album name for music tracks (populated from DB join). */
        albumName?: string;
        /** Album UUID for music tracks (for routing). */
        albumId?: string;
        /** Radio program name (populated from radioNowPlaying cache). */
        radioProgram?: string;
        /** On-air DJ name (populated from radioNowPlaying cache). */
        radioDj?: string;
        /** Now-playing track title from broadcast metadata (radio only). */
        nowPlayingTrack?: string;
        /** Now-playing artist from broadcast metadata (radio only). */
        nowPlayingArtist?: string;
        /** Next queued track — present only for music sessions with a known next track. */
        nextTrack?: {
            mediaId: string;
            title: string;
            artistName?: string;
            albumName?: string;
        };
        /** Crossfade in progress — present only while the client reports one. */
        crossfade?: {
            role: 'incoming' | 'outgoing';
            otherTrack: { mediaId: string; title: string; artistName?: string; albumName?: string };
            remainingMs: number;
            durationMs: number;
        };
        rating?: number;
        criticRating?: number;
        officialRating?: string;
        playMethod?: string;
        playCodec?: string;
        playCodecInfo?: string;
        /**
         * `unknown` to match the wire schema (`playTranscodeInfo:
         * z.unknown().optional()` in api-playback-responses.ts) — it carries
         * Jellyfin's TranscodingInfo verbatim, whose full shape is not modelled.
         * Narrowed where it is read; declaring the two flags here made the
         * SSR-seeded sessions unassignable to this prop.
         */
        playTranscodeInfo?: unknown;
        playTranscodeCodec?: string;
        playBitrate?: number;
        playIsPlaying?: boolean;
        playCurrentTime?: number;
        playItemDuration?: number;
        streamProgress?: number;
        streamCurrentTimeSeconds?: number;
        streamRuntimeTicks?: number;
        playOriginalAudioCodec?: string;
        playTranscodeAudioCodec?: string;
        playOriginalAudioBitrate?: number;
        playTranscodeAudioBitrate?: number;
        playVideoWidth?: number;
        playVideoHeight?: number;
        playOriginalVideoWidth?: number;
        playOriginalVideoHeight?: number;
        playVideoRange?: string;
        playOriginalVideoRange?: string;
        playIsTranscoding?: boolean;
        playTranscodeReasons?: string[];
        playHardwareAcceleration?: string;
        playOriginalCodec?: string;
        playOriginalBitrate?: number;
        playTranscodeBitrate?: number;
        playOriginalContainer?: string;
        playTranscodeContainer?: string;
        playSubtitleLanguage?: string;
        playSubtitleTitle?: string;
        playSubtitleCodec?: string;
        playSubtitleMethod?: 'none' | 'external_vtt' | 'burn_in' | 'client_render';
        playAudioLanguage?: string;
        playAudioTitle?: string;
        playAudioChannels?: number;
        playAudioSampleRate?: number;
        username: string;
        /**
         * REDACTED, not merely unknown — optional to match
         * `ActiveSessionSchema` (schemas/api-playback-responses.ts), which is
         * what `data.initialSessions` is actually typed as. When the viewer may
         * not see device info, active-sessions-view.service.ts drops
         * `clientname`/`browsername`/`formFactor` from every row. Declaring
         * them required here made the SSR seed unassignable to this prop; the
         * render path at `canSeeDeviceInfo && (session.clientname || ...)`
         * already handles their absence, so only the types were wrong.
         */
        isCarPlay?: boolean;
        clientname?: string;
        browsername?: string;
        playSessionId?: string;
        deviceId?: string;
        // Client app info (from /api/v1 clients like tvOS)
        clientApp?: string;
        clientPlayerName?: string;
        formFactor?: 'desktop' | 'mobile' | 'tablet' | 'tv' | 'unknown';
        mediaItemId?: string;
        userId?: string;
        liveTvProgramName?: string;
        liveTvProgramDescription?: string;
        liveTvProgramStartTime?: string;
        liveTvProgramEndTime?: string;
        liveTvProgramProgressPercent?: number;
        liveTvNextProgramName?: string;
        liveTvNextProgramStartTime?: string;
        /** Adaptive-bitrate state: the variant playing now and the ladder. */
        adaptive?: SessionAdaptive;
        isPrivate?: boolean;
        isPreview?: boolean;
        isBuffering?: boolean;
        /**
         * Mirrors the producer's narrowing of `PlaySessionSource`. `'local'` is
         * playback of a file the client already holds — an iOS download played
         * off the device. It belongs here precisely because it is not charged a
         * stream slot: the point of making it a source at all was that somebody
         * genuinely is watching and nothing could show it (c96610de2). Excluding
         * it from this surface would restore the invisibility that change fixed.
         *
         * Hand-copied from the server union rather than imported, like the rest
         * of this interface — which is why it silently fell behind when 'local'
         * was added. Nothing type-checked .svelte until the check:svelte-types
         * gate landed, so this is the first drift of its kind to be caught
         * rather than shipped.
         */
        sessionSource?: 'jellyfin' | 'lumastra' | 'subsonic' | 'audiobookshelf' | 'local';
        /** Observed in another server's app — Lumastra cannot stop it. */
        isReadOnly?: boolean;
        /** Set when this stream is one participant of a visible watch party. */
        watchParty?: WatchPartyTag;
    }

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** Page data with user context */
        data: {
            user?: {
                hasWatchPermission?: boolean;
                isAdmin?: boolean;
                /** Stable users.id UUID of the current viewer (present at runtime). */
                userId?: string;
                /** Current viewer's login/display handle. */
                username?: string;
            };
            features?: { sessionsDeviceInfoPublic?: boolean; watchTogether?: boolean };
            sessions?: { pollIntervalMs?: number };
        };
        /**
         * SSR-seeded active sessions. When provided (even an empty array — that
         * means "the server already knows there are no streams"), the section
         * renders with seeded data the instant it mounts on hydration — no
         * client-fetch-after-mount round-trip or spinner. `null`/`undefined` →
         * no SSR data, the client fetches on mount as before.
         */
        initialSessions?: StreamSession[] | null;
        /**
         * Read timestamp for the SSR sessions (when the server read positions),
         * used to seed progress interpolation so the first paint is accurate.
         */
        initialSessionsCacheTimestamp?: number | null;
        /** Called after first load — allows parent to hide/show the widget */
        onvisibilityChange?: (detail: { visible: boolean }) => void;
    }

    let {
        data,
        initialSessions = null,
        initialSessionsCacheTimestamp = null,
        onvisibilityChange,
    }: Props = $props();

    // =========================================================================
    // State
    // =========================================================================

    // Seed from SSR data when present so the section renders its streams (or its
    // empty state) immediately on mount — no spinner, no client fetch round-trip.
    // A provided array (even empty) means "we already know the answer", so
    // `loading` starts false; only a null/undefined seed forces a client fetch.
    //
    // ...but ONLY when the seed is actually recent. The homepage HTML (with the
    // seed embedded in it) is cached by the service worker as an app shell, so a
    // reopen served from that cache — offline, fetch error, or the >3s network
    // race timeout — carries whatever streams were live when the shell was
    // written, potentially days ago. An unfresh seed is treated as no seed at
    // all: spinner + immediate fetch, rather than rendering dead streams until
    // the first poll lands.
    function seedIsUsable(): boolean {
        return initialSessions != null && isSessionSeedFresh(initialSessionsCacheTimestamp);
    }

    function initialSessionList(): StreamSession[] {
        return seedIsUsable() ? (initialSessions ?? []) : [];
    }

    function initialLoading(): boolean {
        return !seedIsUsable();
    }

    let sessions: StreamSession[] = $state(initialSessionList());
    let loading = $state(initialLoading());
    let initialLoadDone = $state(false); // Track if we've completed initial load
    let fetching = false; // Guard against concurrent fetches
    /** Public watch parties (for lobby cards) — see `lobbyParties`. */
    let publicParties: PublicParty[] = $state([]);
    let partiesEnabled = $derived(data?.features?.watchTogether !== false);

    async function loadPublicParties() {
        if (!partiesEnabled) return;
        try {
            const { data: res, error: apiError } = await watchTogetherApi.getPublicParties();
            if (apiError) return; // keep the last good list; parties are secondary here
            publicParties = res?.items ?? [];
            if (lobbyParties.length > 0) onvisibilityChange?.({ visible: true });
        } catch {
            // Fail-soft: the streams themselves must never go dark over this.
        }
    }
    let error = $state<string | null>(null);
    // Track hover state per session ID (not index) to avoid re-render cascades
    let hoveredSessionId = $state<string | null>(null);

    // Track which titles need marquee animation (overflow their container)
    // Using object instead of Set to avoid creating new objects on update
    let longTitles: Record<string, boolean> = $state({});

    // Minimum font size (px) a shrinking title may reach before we stop
    // shrinking and fall back to the reveal affordance (ellipsis + scrub/marquee).
    const TITLE_MIN_FONT_PX = 13;

    // True on pointer devices with real hover (desktop). Drives whether an
    // over-long title reveals via mouse-position scrub (desktop) or auto-marquee
    // (touch). Device capability doesn't change at runtime, so read it once;
    // defaults true under SSR (CSS media queries own the actual touch fallback).
    const scrubFractions = new WeakMap<HTMLElement, number>();

    const isHoverDevice = browser ? window.matchMedia('(hover: hover)').matches : true;

    // Attachment: auto-shrink a title so it fits its container on one line
    // (keeps every card the same height). Titles that STILL overflow at the
    // minimum font size are flagged in `longTitles`, which turns on the reveal
    // affordance (ellipsis at rest; scrub on desktop, marquee on touch).
    // Re-runs when the title text changes; re-measures on container resize.
    function fitTitle(sessionId: string, _title: string) {
        return (element: HTMLElement) => {
            const container = element.parentElement;
            if (!container) return;
            let raf = 0;

            const setLong = (value: boolean) => {
                if (Boolean(longTitles[sessionId]) === value) return;
                if (value) longTitles[sessionId] = true;
                else delete longTitles[sessionId];
                longTitles = { ...longTitles }; // trigger reactivity
            };

            const measure = () => {
                // Reset to natural size / position before measuring.
                element.style.fontSize = '';
                element.style.transform = '';
                element.style.removeProperty('--stream-overflow');

                const basePx = Number.parseFloat(getComputedStyle(element).fontSize) || 16;
                const containerWidth = container.clientWidth;
                const textWidth = element.scrollWidth;
                if (containerWidth === 0 || textWidth === 0) return;

                if (textWidth <= containerWidth) {
                    setLong(false); // fits at natural size
                    return;
                }

                // Shrink to fit — but never below the floor.
                const minimumPx = Math.min(basePx, TITLE_MIN_FONT_PX);
                const desiredPx = basePx * (containerWidth / textWidth) * 0.99;
                if (desiredPx >= minimumPx) {
                    element.style.fontSize = `${desiredPx}px`;
                    setLong(false);
                    return;
                }

                // Still too long at the floor: clamp the font, expose the overflow
                // distance (consumed by the touch marquee) and flag it long.
                element.style.fontSize = `${minimumPx}px`;
                const overflowPx = Math.max(0, element.scrollWidth - containerWidth);
                element.style.setProperty('--stream-overflow', `${overflowPx}px`);
                setLong(true);
                const card = element.closest<HTMLElement>('.stream-card');
                const fraction = card ? scrubFractions.get(card) : undefined;
                if (fraction !== undefined) {
                    element.style.transform = `translateX(${-fraction * overflowPx}px)`;
                }
            };

            const schedule = () => {
                cancelAnimationFrame(raf);
                raf = requestAnimationFrame(measure);
            };

            schedule();
            const observer = new ResizeObserver(schedule);
            observer.observe(container);

            return () => {
                cancelAnimationFrame(raf);
                observer.disconnect();
            };
        };
    }

    // Desktop reveal: pan an over-long title horizontally in proportion to the
    // cursor's X within the whole card (left edge → title start, right
    // edge → title end). No-op unless the title actually overflows.
    function scrubTitle(event: PointerEvent) {
        if (!isHoverDevice || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const card = event.currentTarget as HTMLElement;
        const rect = card.getBoundingClientRect();
        const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        // The outer 20% snaps to the start/end, so neither edge is hard to reach.
        const DEAD_ZONE = 0.2;
        const eased = Math.min(1, Math.max(0, (fraction - DEAD_ZONE) / (1 - DEAD_ZONE * 2)));
        scrubFractions.set(card, eased);
        for (const title of card.querySelectorAll<HTMLElement>('.stream-title')) {
            const container = title.parentElement;
            if (!container) continue;
            const overflow = title.scrollWidth - container.clientWidth;
            title.style.transform = overflow > 0 ? `translateX(${-(eased * overflow)}px)` : '';
        }
    }

    function resetScrub(event: PointerEvent) {
        const card = event.currentTarget as HTMLElement;
        scrubFractions.delete(card);
        for (const title of card.querySelectorAll<HTMLElement>('.stream-title')) {
            title.style.transform = '';
        }
    }

    // Permissions
    let hasWatchPermission = $derived(data?.user?.hasWatchPermission || false);
    let isAdmin = $derived(data?.user?.isAdmin || false);
    let canSeeDeviceInfo = $derived(
        data?.features?.sessionsDeviceInfoPublic || hasWatchPermission || isAdmin,
    );

    // Own-session gate: UUID match against the current viewer.
    let viewerUserId = $derived(data?.user?.userId);
    function isOwnSession(session: StreamSession): boolean {
        // `isReadOnly` rows are a mirror of playback inside another server's
        // app. One CAN be attributed to the viewer — a direct AudiobookShelf
        // listener whose ABS username matches their Lumastra account — but we
        // still have no session to cancel, so it must not gate the Stop button
        // in. Without this guard the viewer would get a button that quietly
        // does nothing and a row that never disappears.
        return !!viewerUserId && session.userId === viewerUserId && !session.isReadOnly;
    }

    function formFactorLabel(formFactor: StreamSession['formFactor']): string | null {
        switch (formFactor) {
            case 'mobile':
                return 'Mobile';
            case 'tablet':
                return 'Tablet';
            case 'desktop':
                return 'Desktop';
            case 'tv':
                return 'TV';
            default:
                return null;
        }
    }

    // Recently-stopped session ids (with stop timestamp) — guards against the
    // server's ~2s single-flight active-sessions cache resurrecting a
    // just-stopped session in a concurrent poll response (other tab, SSR, AI
    // assistant tool). Entries expire after 5s — longer than the cache TTL —
    // via pruneRecentlyStopped().
    const RECENTLY_STOPPED_TTL_MS = 5000;
    const recentlyStopped = new SvelteMap<string, number>();

    function pruneRecentlyStopped(): void {
        const now = Date.now();
        for (const [id, ts] of recentlyStopped) {
            if (now - ts > RECENTLY_STOPPED_TTL_MS) recentlyStopped.delete(id);
        }
    }

    function markRecentlyStopped(id: string): void {
        pruneRecentlyStopped();
        recentlyStopped.set(id, Date.now());
    }

    // Stop-stream flow: confirm dialog routed through the shared modal store
    // (matches every other ConfirmModal call site — it has no backdrop/
    // positioning of its own and relies on ModalContainer to render it).
    async function stopSession(session: StreamSession): Promise<void> {
        try {
            // `__id` is the bare play_sessions UUID (builder sets `__id: view.sessionId`).
            // Do NOT use `playSessionId` — that is `sourceSessionId`, a different value.
            const result = await playbackApi.cancelSession(session.__id);
            // A 404 means the session is already gone — another tab/admin/the
            // reconciler beat us to it, or the poll hasn't dropped the card
            // yet (TOCTOU). Treat that exactly like a successful stop instead
            // of surfacing an error toast.
            if (result.error && result.status !== 404) throw new Error(result.error);
            markRecentlyStopped(session.__id);
            // Optimistic remove; the poll interval reconciles regardless.
            sessions = sessions.filter((s) => s.__id !== session.__id);
            toasts.success(m.session_stop_success());
        } catch {
            toasts.error(m.session_stop_error());
            loadSessions();
        }
    }

    function requestStopSession(session: StreamSession): void {
        modals.open(ConfirmModal, {
            title: m.session_stop_confirm_title(),
            body: m.session_stop_confirm_body(),
            confirmText: m.session_stop_confirm_button(),
            confirmVariant: 'danger' as const,
            onConfirm: () => stopSession(session),
        });
    }

    // Client-side progress tracking
    let clientCurrentTimes: Record<string, number> = {}; // Base time from server
    let clientTimeBaseTimestamps: Record<string, number> = {}; // When the server data was actually fetched (from cache timestamp)
    // Advance from the server's read time rather than the browser's wall clock.
    let programmeClock = $state({
        serverTime: untrack(() => initialSessionsCacheTimestamp ?? Date.now()),
        receivedAt: browser ? performance.now() : 0,
    });
    let timerTick = $state(0); // Incremented every second to force re-render

    // Seed progress-interpolation base times from the SSR data so the first
    // paint shows accurate positions, mirroring the "first time seeing this
    // session" branch of loadSessions(). The cache timestamp is the server's
    // read time; guard against missing/invalid values the same way loadSessions
    // does (fall back to "now"). Playing sessions interpolate from the base
    // timestamp; paused sessions use a base timestamp of 0.
    function seedInitialProgressTimes(): void {
        if (!seedIsUsable() || !initialSessions || initialSessions.length === 0) return;
        const now = Date.now();
        const seedFetchTime = isSessionSeedFresh(initialSessionsCacheTimestamp)
            ? (initialSessionsCacheTimestamp ?? now)
            : now;
        for (const session of initialSessions) {
            const serverTime = session.playCurrentTime ?? session.streamCurrentTimeSeconds;
            if (serverTime === undefined) continue;
            clientCurrentTimes[session.__id] = serverTime;
            clientTimeBaseTimestamps[session.__id] = session.playIsPlaying ? seedFetchTime : 0;
        }
    }

    seedInitialProgressTimes();

    // =========================================================================
    // Session Display Item (minimal - only what's used in template)
    // =========================================================================

    interface SessionDisplayItem {
        title: string;
        subtitle: string | undefined;
        backdrop: string;
        year: number | undefined;
        // Precomputed values to avoid duplicate function calls in template
        logoUrl: string | null;
        episodeBackdropUrl: string | null;
        resolution: string;
        /** Audio format badge ("FLAC 96kHz", "MP3 320") — music sessions only. */
        musicFormat: string;
        isHDR: boolean;
        mediaTypeDisplay: string;
        mediaTypeColor: string;
        isMusic: boolean;
        isSquareArt: boolean;
    }

    function transformSession(session: StreamSession): SessionDisplayItem {
        const isMusicSession =
            isAudio(session.mediaType) ||
            session.mediaType === 'music' ||
            session.mediaType === 'track';
        const isSquareArt =
            isMusicSession || isAudiobook(session.mediaType) || session.mediaType === 'tvchannel';
        return {
            title: getSessionDisplayName(session),
            subtitle: getSessionDisplaySubtitle(session),
            backdrop: getImageUrl(session),
            year: session.year,
            // Precompute these to avoid calling 2x each in template
            // Square artwork already identifies music and audiobooks. Neither
            // surface has movie/TV-style logo art, and asking the generic logo
            // endpoint for an audiobook resolves to the popcorn placeholder.
            logoUrl: isSquareArt ? null : getLogoUrl(session),
            episodeBackdropUrl: isMusicSession ? null : getEpisodeBackdropUrl(session),
            resolution: isMusicSession
                ? ''
                : getFriendlyResolution(session.playVideoWidth, session.playVideoHeight),
            musicFormat: isMusicSession ? getMusicFormatBadge(session) : '',
            isHDR: isMusicSession ? false : isHDR(session),
            mediaTypeDisplay: getMediaTypeDisplay(session.mediaType),
            mediaTypeColor: getMediaTypeColor(session.mediaType),
            isMusic: isMusicSession,
            isSquareArt,
        };
    }

    // =========================================================================
    // Display Helpers
    // =========================================================================

    // Scene/torrent release names ("The.Apothecary.Diaries.S01E01.1080p...") use
    // dots/underscores as separators and carry a tell-tale marker (season/episode,
    // a 19xx/20xx year, a resolution, or a source/codec token). Only humanize when
    // such a marker is present AND the string has no real spaces — this leaves
    // legitimate dotted acronym titles ("S.W.A.T.", "E.R.", "9.5") untouched
    // instead of mangling them into "S W A T".
    const SCENE_RELEASE_MARKER =
        /[._](?:s\d{1,2}e\d{1,2}|(?:19|20)\d{2}|\d{3,4}p|web[-.]?dl|webrip|bluray|bdrip|hdtv|dvdrip|x26[45]|h26[45]|hevc|xvid)(?:[._]|$)/i;
    function cleanDisplayTitle(raw: string): string {
        if (raw && !raw.includes(' ') && SCENE_RELEASE_MARKER.test(raw)) {
            return raw.replace(/[._]+/g, ' ').trim();
        }
        return raw;
    }

    function getSessionDisplayName(session: StreamSession): string {
        if (isTvChannel(session.mediaType)) {
            return session.title;
        }
        if (isEpisode(session.mediaType) && session.seriesName) {
            return session.seriesName;
        }
        // Prefer the canonical resolved title; fall back to humanizing a dotted
        // filename when that is all the session carries.
        return cleanDisplayTitle(session.title);
    }

    function getSessionDisplaySubtitle(session: StreamSession): string | undefined {
        if (isTvChannel(session.mediaType)) {
            // For LiveTV, don't return subtitle here - we'll show it in a custom section
            return undefined;
        }
        if (isEpisode(session.mediaType) && session.seriesName) {
            return `S${session.seasonNumber || '?'}:E${session.episodeNumber || '?'} - ${cleanDisplayTitle(session.title)}`;
        }
        if (session.mediaType === 'radio') {
            // For radio: show program and/or DJ
            const parts: string[] = [];
            if (session.radioProgram) parts.push(session.radioProgram);
            if (session.radioDj) parts.push(`DJ ${session.radioDj}`);
            return parts.length > 0 ? parts.join(' · ') : undefined;
        }
        if (
            isAudio(session.mediaType) ||
            session.mediaType === 'music' ||
            session.mediaType === 'track'
        ) {
            // Prefer dedicated artistName/albumName fields; fall back to legacy author/seriesName
            const artist = session.artistName ?? session.author;
            const album = session.albumName ?? session.seriesName;
            const parts: string[] = [];
            if (artist) parts.push(artist);
            if (album) parts.push(album);
            return parts.length > 0 ? parts.join(' · ') : undefined;
        }
        return undefined;
    }

    function formatLiveTvTime(isoString?: string): string {
        if (!isoString) return '';
        try {
            const date = new SvelteDate(isoString);
            // Check for invalid date
            if (isNaN(date.getTime())) return '';
            return date.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch {
            /* expected: SvelteDate constructor may throw on invalid ISO string */
            return '';
        }
    }

    function getImageUrl(session: StreamSession): string {
        if (isAudiobook(session.mediaType) || session.mediaType === 'tvchannel')
            return pickVariant(session.images?.primary, 'card') ?? '';

        // Image entity when the session has no internal id: the series / image
        // id the session carries (for a live session read from a Jellyfin server
        // that is its Jellyfin item id, which the catalog image route serves
        // only while Jellyfin sync is usable). Used directly — never smuggled
        // through `externalIds.jellyfin`.
        const fallbackImageId = session.seriesId || session.imageId || session.jellyfinId;

        if (isAudio(session.mediaType) || session.mediaType === 'music') {
            if (session.externalIds?.internal) {
                return getCatalogPosterUrl(session.externalIds.internal, { size: 'card' });
            }
            if (fallbackImageId) return getCatalogPosterUrl(fallbackImageId, { size: 'card' });
            return (
                imageFromIds(session.externalIds, 'poster', 'movie', { size: 'card' }) ||
                FALLBACK_IMAGE
            );
        }

        // Video sessions: prefer catalog backdrop, fall back through providers.
        // Episodes only ever have their OWN artwork under the 'thumb' image type
        // (still_path / locally extracted frame) — 'backdrop' has no per-episode
        // source and inherits the series' art instead (or 404s to the popcorn
        // placeholder if the series has none either), so resolve via the
        // episode's own id under 'thumb', not the series id under 'backdrop'.
        if (isEpisode(session.mediaType) && session.externalIds?.internal) {
            return getCatalogThumbUrl(session.externalIds.internal, { size: 'wide' });
        }

        const backdropId = session.externalIds?.internal;
        if (backdropId) {
            return getCatalogBackdropUrl(backdropId, {
                size: 'wide',
            });
        }

        // For episodes without an internal id, try the episode's OWN thumb via
        // the session's own item id — NOT `fallbackImageId` above, which
        // prioritizes the series id.
        if (isEpisode(session.mediaType)) {
            if (session.jellyfinId) {
                return getCatalogThumbUrl(session.jellyfinId, { size: 'wide' });
            }
            return (
                imageFromIds(session.externalIds, 'thumb', 'tv', { size: 'wide' }) || FALLBACK_IMAGE
            );
        }

        if (fallbackImageId) return getCatalogBackdropUrl(fallbackImageId, { size: 'wide' });
        return (
            imageFromIds(session.externalIds, 'backdrop', 'movie', { size: 'wide' }) ||
            FALLBACK_IMAGE
        );
    }

    function getLogoUrl(session: StreamSession): string | null {
        if (
            session.externalIds?.internal &&
            (isMovie(session.mediaType) ||
                isSeries(session.mediaType) ||
                isEpisode(session.mediaType))
        ) {
            // Logo is series-level branding — for episodes use the series id
            // (episode id → 404, leaving the series fallback below unreachable).
            const logoId =
                isEpisode(session.mediaType) && session.seriesId
                    ? session.seriesId
                    : session.externalIds.internal;
            // Missing logos must trigger the text title, not the image placeholder.
            return getCatalogLogoUrl(logoId, { fallback: 'none' }) || null;
        }

        const logoId = isEpisode(session.mediaType)
            ? session.seriesId
            : (session.jellyfinId ?? session.mediaItemId);

        if (logoId) {
            return getCatalogLogoUrl(logoId, { fallback: 'none' }) ?? null;
        }

        return null;
    }

    // Track which sessions have logo load errors (fallback to title)
    // Using object instead of Set to avoid creating new objects on update
    let logoErrors: Record<string, boolean> = $state({});

    // Track which episodes have their own backdrop (vs using series backdrop)
    let episodeBackdropErrors: Record<string, boolean> = $state({});

    function getEpisodeBackdropUrl(session: StreamSession): string | null {
        if (!isEpisode(session.mediaType)) return null;

        // The episode's OWN still — 'thumb' is the only type that resolves to
        // per-episode art (see getImageUrl above for the full rationale).
        if (session.externalIds?.internal) {
            return getCatalogThumbUrl(session.externalIds.internal, { size: 'wide' });
        }

        const episodeImageId = session.jellyfinId ?? session.mediaItemId;
        if (episodeImageId) return getCatalogThumbUrl(episodeImageId, { size: 'wide' });
        return imageFromIds(session.externalIds, 'thumb', 'tv', { size: 'wide' });
    }

    // =========================================================================
    // Technical Info Helpers
    // =========================================================================

    // Containers in the MP4 family that should be normalized to "MP4"
    const MP4_FAMILY = ['MOV', 'M4A', 'M4V', '3GP', '3G2', 'MJ2'];

    // Hardware acceleration labels (constant to avoid recreating on each call)
    const HW_ACCEL_LABELS: Record<string, string> = {
        nvenc: 'NVENC',
        qsv: 'QSV',
        vaapi: 'VAAPI',
        amf: 'AMF',
        videotoolbox: 'VideoToolbox',
        v4l2m2m: 'V4L2',
        rkmpp: 'RKMPP',
    };

    function formatBitrate(bitrate?: number): string {
        if (!bitrate) return 'Unknown';
        const mbps = bitrate / 1000000;
        const kbps = bitrate / 1000;
        if (mbps < 1) {
            return `${Math.round(kbps)} kbps`;
        }
        return `${mbps.toFixed(1)} Mbps`;
    }

    // Format hardware acceleration type to friendly label
    function formatHwAccel(hwAccel?: string): string {
        if (!hwAccel || hwAccel === 'none') return '';
        return HW_ACCEL_LABELS[hwAccel.toLowerCase()] || hwAccel.toUpperCase();
    }

    function getTranscodeInfo(session: StreamSession): string {
        if (!session.playMethod) return '';

        let info = session.playMethod;
        let isTranscoding = false;

        // Determine playback method. Jellyfin's IsVideoDirect/IsAudioDirect
        // signal is finer-grained than the canonical play-method enum (it
        // distinguishes video-only transcoding from audio-only) — so we
        // derive the label inline here when present.
        if (isRecord(session.playTranscodeInfo)) {
            const { IsVideoDirect, IsAudioDirect } = session.playTranscodeInfo as {
                IsVideoDirect?: boolean;
                IsAudioDirect?: boolean;
            };
            if (IsVideoDirect && IsAudioDirect) {
                info = 'Remux';
            } else if (IsVideoDirect) {
                info = 'Audio Transcode';
                isTranscoding = true;
            } else {
                info = 'Video Transcode';
                isTranscoding = true;
            }
        } else {
            const canonical = toPlayMethod(session.playMethod);
            if (canonical) {
                info = getPlayMethodLabel(canonical);
                isTranscoding = canonical === 'audio_transcode' || canonical === 'full_transcode';
            }
        }

        // Add hardware acceleration indicator for transcoding
        if (isTranscoding || session.playIsTranscoding) {
            const hwAccel = formatHwAccel(session.playHardwareAcceleration);
            if (hwAccel) {
                info = `${info} (${hwAccel})`;
            }
        }

        // Add container conversion info
        // Jellyfin can return comma-separated containers (e.g., "mov,mp4,m4a,3gp") - take the first one
        const originalRaw = session.playOriginalContainer?.split(',')[0]?.trim().toUpperCase();
        const transcodeRaw = session.playTranscodeContainer?.split(',')[0]?.trim().toUpperCase();

        // Normalize MP4-family containers to just "MP4"
        const original = originalRaw && MP4_FAMILY.includes(originalRaw) ? 'MP4' : originalRaw;
        const transcode = transcodeRaw && MP4_FAMILY.includes(transcodeRaw) ? 'MP4' : transcodeRaw;

        if (original) {
            if (transcode && original !== transcode) {
                // We have both containers from the API - show the conversion
                // TS is almost always HLS, MP4 could be HLS (fMP4) or progressive HTTP
                if (transcode === 'TS') {
                    info = `${info} · ${original}→${transcode} (HLS)`;
                } else {
                    info = `${info} · ${original}→${transcode}`;
                }
            } else if (!transcode && original !== 'MP4' && original !== 'TS' && info !== 'Direct') {
                // No transcode container from API but we're streaming (not direct play)
                // Likely HLS output
                info = `${info} · ${original}→MP4 (HLS)`;
            } else if (info !== 'Direct') {
                // Show original container for context
                info = `${info} · ${original}`;
            }
        }

        return info;
    }

    function getCodecInfo(session: StreamSession): string {
        if (session.playIsTranscoding) {
            if (session.playOriginalCodec && session.playTranscodeCodec) {
                return `${session.playOriginalCodec.toUpperCase()} → ${session.playTranscodeCodec.toUpperCase()}`;
            } else if (session.playTranscodeCodec) {
                return session.playTranscodeCodec.toUpperCase();
            } else if (session.playOriginalCodec) {
                return session.playOriginalCodec.toUpperCase();
            }
        } else {
            if (session.playOriginalCodec) {
                return session.playOriginalCodec.toUpperCase();
            } else if (session.playCodec) {
                return session.playCodec.toUpperCase();
            }
        }
        return '';
    }

    // Format resolution as friendly string (4K, 1080p, 720p, etc.)
    function formatResolution(width?: number, height?: number): string {
        if (!width || !height) return '';
        if (width >= 3840 || height >= 2160) return '4K';
        if (width >= 2560 || height >= 1440) return '1440p';
        if (width >= 1920 || height >= 1080) return '1080p';
        if (width >= 1280 || height >= 720) return '720p';
        if (width >= 854 || height >= 480) return '480p';
        return `${height}p`;
    }

    // Combined codec + bitrate display for transcoding: "HEVC (50 Mbps) → H264 (8 Mbps)"
    // Also shows resolution change if downscaling: "4K→1080p"
    function getVideoTranscodeDisplay(session: StreamSession): string {
        const parts: string[] = [];

        if (!session.playIsTranscoding) {
            // Not transcoding - show source info only
            const codec =
                session.playOriginalCodec?.toUpperCase() || session.playCodec?.toUpperCase() || '';
            const bitrate = session.playOriginalBitrate || session.playBitrate;
            if (codec && bitrate) {
                parts.push(`${codec} (${formatBitrate(bitrate)})`);
            } else if (codec) {
                parts.push(codec);
            } else if (bitrate) {
                parts.push(formatBitrate(bitrate));
            }
        } else {
            // Transcoding - show source → destination for codec/bitrate
            const srcCodec =
                session.playOriginalCodec?.toUpperCase() || session.playCodec?.toUpperCase() || '';
            // Fallback to playBitrate if playOriginalBitrate is not available
            const srcBitrate = session.playOriginalBitrate || session.playBitrate;
            const dstCodec = session.playTranscodeCodec?.toUpperCase() || '';
            // playTranscodeBitrate is the total transcode bitrate from TranscodingInfo
            const dstBitrate = session.playTranscodeBitrate;

            // Build source part - prefer showing codec (bitrate)
            let srcPart = '';
            if (srcCodec && srcBitrate) {
                srcPart = `${srcCodec} (${formatBitrate(srcBitrate)})`;
            } else if (srcCodec) {
                srcPart = srcCodec;
            } else if (srcBitrate) {
                srcPart = formatBitrate(srcBitrate);
            }

            // Build destination part - prefer showing codec (bitrate)
            let dstPart = '';
            if (dstCodec && dstBitrate) {
                dstPart = `${dstCodec} (${formatBitrate(dstBitrate)})`;
            } else if (dstCodec) {
                dstPart = dstCodec;
            } else if (dstBitrate) {
                dstPart = formatBitrate(dstBitrate);
            }

            // Show arrow notation only if we have both parts
            if (srcPart && dstPart) {
                parts.push(`${srcPart} → ${dstPart}`);
            } else if (srcPart) {
                // Only source info available
                parts.push(srcPart);
            } else if (dstPart) {
                // Only destination info available (rare)
                parts.push(dstPart);
            }

            // Check for resolution change (downscaling)
            const srcRes = formatResolution(
                session.playOriginalVideoWidth,
                session.playOriginalVideoHeight,
            );
            const dstRes = formatResolution(session.playVideoWidth, session.playVideoHeight);
            if (srcRes && dstRes && srcRes !== dstRes) {
                parts.push(`${srcRes}→${dstRes}`);
            }

            // Check for HDR → SDR tone-mapping
            const srcHdr = session.playOriginalVideoRange;
            const dstHdr = session.playVideoRange;
            if (srcHdr && dstHdr && srcHdr !== dstHdr && srcHdr !== 'SDR') {
                parts.push(`${srcHdr}→${dstHdr}`);
            }
        }

        return parts.join(' • ');
    }

    // Combined audio codec + bitrate display for transcoding
    function getAudioTranscodeDisplay(session: StreamSession): string {
        if (!session.playIsTranscoding) {
            // Not transcoding - show source info only
            const codec = session.playOriginalAudioCodec?.toUpperCase() || '';
            const bitrate = session.playOriginalAudioBitrate;
            if (codec && bitrate) {
                return `${codec} (${formatBitrate(bitrate)})`;
            }
            return codec || (bitrate ? formatBitrate(bitrate) : '');
        }

        // Transcoding - show source → destination
        const srcCodec = session.playOriginalAudioCodec?.toUpperCase() || '';
        const srcBitrate = session.playOriginalAudioBitrate;
        const dstCodec = session.playTranscodeAudioCodec?.toUpperCase() || '';
        const dstBitrate = session.playTranscodeAudioBitrate;

        // Build source part
        let srcPart = '';
        if (srcCodec && srcBitrate) {
            srcPart = `${srcCodec} (${formatBitrate(srcBitrate)})`;
        } else if (srcCodec) {
            srcPart = srcCodec;
        } else if (srcBitrate) {
            srcPart = formatBitrate(srcBitrate);
        }

        // Build destination part
        let dstPart = '';
        if (dstCodec && dstBitrate) {
            dstPart = `${dstCodec} (${formatBitrate(dstBitrate)})`;
        } else if (dstCodec) {
            dstPart = dstCodec;
        } else if (dstBitrate) {
            dstPart = formatBitrate(dstBitrate);
        }

        // Show arrow notation only if we have both parts
        if (srcPart && dstPart) {
            return `${srcPart} → ${dstPart}`;
        }
        return srcPart || dstPart || '';
    }

    // Codecs that carry no meaningful bitrate figure — FLAC/ALAC report none at
    // all per stream, and quoting a lossless file's ~1000 kbps says nothing
    // about quality. For these the sample rate is the informative number.
    const LOSSLESS_AUDIO_CODECS = new Set([
        'flac',
        'alac',
        'wav',
        'ape',
        'wavpack',
        'wv',
        'tta',
        'truehd',
        'mlp',
    ]);

    /** "pcm_s24le" → "PCM", "mp3" → "MP3". */
    function audioCodecLabel(codec: string): string {
        const lower = codec.toLowerCase();
        if (lower.startsWith('pcm')) return 'PCM';
        return lower.toUpperCase();
    }

    function isLosslessAudioCodec(codec: string): boolean {
        const lower = codec.toLowerCase();
        return lower.startsWith('pcm') || LOSSLESS_AUDIO_CODECS.has(lower);
    }

    /** 96000 → "96kHz", 88200 → "88.2kHz". */
    function formatSampleRate(hz: number): string {
        const khz = hz / 1000;
        return `${Number.isInteger(khz) ? khz : khz.toFixed(1)}kHz`;
    }

    /**
     * Containers whose name IS the codec, usable when a session reports no
     * codec of its own. Deliberately excludes the MP4/Matroska/Ogg families:
     * ffprobe reports those as a comma-joined list ("mov,mp4,m4a,3gp,3g2,mj2")
     * and they carry AAC or ALAC or Vorbis or Opus — labelling such a track
     * "MOV" would be worse than showing no badge.
     */
    const SELF_DESCRIBING_AUDIO_CONTAINERS = new Set(['mp3', 'flac', 'wav', 'aiff', 'ape', 'wv']);

    /**
     * Compact format badge for music sessions — the audio counterpart to the
     * 1080p/4K badge video sessions get. Lossy codecs are qualified by bitrate
     * ("MP3 320"), lossless ones only by sample rate and only when it exceeds
     * CD quality ("FLAC 96kHz"), so the badge stays short and every number
     * shown actually distinguishes something.
     */
    function getMusicFormatBadge(session: StreamSession): string {
        const container = session.playOriginalContainer?.split(',')[0]?.trim().toLowerCase();
        const raw =
            session.playOriginalAudioCodec ||
            session.playTranscodeAudioCodec ||
            (container && SELF_DESCRIBING_AUDIO_CONTAINERS.has(container) ? container : '');
        if (!raw) return '';
        const label = audioCodecLabel(raw);

        if (isLosslessAudioCodec(raw)) {
            const hz = session.playAudioSampleRate;
            return hz && hz > 48000 ? `${label} ${formatSampleRate(hz)}` : label;
        }

        const bps = session.playOriginalAudioBitrate;
        return bps ? `${label} ${Math.round(bps / 1000)}` : label;
    }

    /**
     * Sample rate / channel layout for the hover tech overlay — the detail the
     * badge deliberately leaves out.
     */
    function getAudioQualityDetail(session: StreamSession): string {
        const parts: string[] = [];
        if (session.playAudioSampleRate) {
            parts.push(formatSampleRate(session.playAudioSampleRate));
        }
        // Stereo is the assumption for music; only call out anything else.
        if (session.playAudioChannels && session.playAudioChannels !== 2) {
            parts.push(`${session.playAudioChannels}ch`);
        }
        return parts.join(' • ');
    }

    function getAudioCodecInfo(session: StreamSession): string {
        if (session.playIsTranscoding) {
            if (session.playOriginalAudioCodec && session.playTranscodeAudioCodec) {
                return `${session.playOriginalAudioCodec.toUpperCase()} → ${session.playTranscodeAudioCodec.toUpperCase()}`;
            } else if (session.playTranscodeAudioCodec) {
                return session.playTranscodeAudioCodec.toUpperCase();
            } else if (session.playOriginalAudioCodec) {
                return session.playOriginalAudioCodec.toUpperCase();
            }
        } else {
            if (session.playOriginalAudioCodec) {
                return session.playOriginalAudioCodec.toUpperCase();
            }
        }
        return '';
    }

    function isHDR(session: StreamSession): boolean {
        const range = session.playVideoRange || session.playOriginalVideoRange;
        return Boolean(range && range.toLowerCase().includes('hdr'));
    }

    function getAudioChannelDisplay(channels?: number): string {
        if (!channels) return '';
        if (channels === 1) return 'Mono';
        if (channels === 2) return 'Stereo';
        if (channels === 6) return '5.1';
        if (channels === 8) return '7.1';
        return `${channels}ch`;
    }

    function getSubtitleDisplay(session: StreamSession): string {
        const isBurnIn = session.playSubtitleMethod === 'burn_in';

        // Explicitly-disabled subs always render as "none" — even if a stale
        // language label is still on the row, don't display it. The SQL
        // clears stale language on the next heartbeat; the frontend must not
        // race that write.
        if (session.playSubtitleMethod === 'none') return m.stream_none();

        // `playSubtitleTitle` is the human-readable track name (e.g. "German [SDH]"),
        // populated for Jellyfin sessions. For Lumastra sessions only the language
        // code is stored, so fall back to an uppercased language.
        const label =
            session.playSubtitleTitle ||
            (session.playSubtitleLanguage ? session.playSubtitleLanguage.toUpperCase() : '');

        if (!label) return isBurnIn ? 'Burn-in' : m.stream_none();

        return isBurnIn ? `${label} (Burn-in)` : label;
    }

    function getAudioTrackDisplay(session: StreamSession): string {
        const parts = [];
        if (session.playAudioTitle) parts.push(session.playAudioTitle);
        else if (session.playAudioLanguage) parts.push(session.playAudioLanguage.toUpperCase());

        if (session.playAudioChannels)
            parts.push(getAudioChannelDisplay(session.playAudioChannels));

        return parts.join(' • ') || '';
    }

    function getTranscodeReasonText(session: StreamSession): string {
        if (!session.playTranscodeReasons || session.playTranscodeReasons.length === 0) return '';

        const reasons = session.playTranscodeReasons.map((reason) => {
            switch (reason.toLowerCase()) {
                case 'videocodecnotsupported':
                    return m.transcode_video_codec();
                case 'audiocodecnotsupported':
                    return m.transcode_audio_codec();
                case 'containernotsupported':
                    return m.transcode_container();
                case 'videobitratenotsupported':
                    return m.transcode_video_bitrate();
                case 'audiobitratenotsupported':
                    return m.transcode_audio_bitrate();
                case 'unknownvideostreaminfo':
                    return m.transcode_unknown_video();
                case 'unknownaudiostreaminfo':
                    return m.transcode_unknown_audio();
                default:
                    return reason;
            }
        });

        return reasons.join(', ');
    }

    function getMediaTypeDisplay(type: string): string {
        switch (type) {
            case 'movie':
                return m.stream_movie();
            // 'tv' still accepted: a stale SSR seed or an older cached payload
            // can carry the pre-projection token, and falling through to
            // `default` would print the raw string instead of a label.
            case 'tv':
            case 'series':
                return m.stream_series();
            case 'episode':
                return m.stream_episode();
            case 'audiobook':
                return m.stream_audiobook();
            case 'audio':
            case 'music':
            case 'track':
                return m.stream_music();
            case 'tvchannel':
                return m.stream_live_tv();
            case 'radio':
                return 'Radio';
            default:
                return type;
        }
    }

    function getMediaTypeColor(type: string): string {
        switch (type) {
            case 'movie':
                return 'bg-blue-500';
            case 'tv':
            case 'series':
                return 'bg-green-500';
            case 'episode':
                return 'bg-green-400';
            case 'audiobook':
                return 'bg-orange-500';
            case 'audio':
            case 'music':
            case 'track':
                return 'bg-purple-500';
            case 'tvchannel':
                return 'bg-red-500';
            case 'radio':
                return 'bg-rose-600';
            default:
                return 'bg-gray-500';
        }
    }

    // =========================================================================
    // Progress Tracking
    // =========================================================================

    // Programme timing is a wall-clock schedule, independent of the viewer's
    // transport state. Keepalives do not tell us whether their player is paused.
    function getProgramTiming(
        session: StreamSession,
    ): { elapsed: number; duration: number } | undefined {
        void timerTick;
        if (!isTvChannel(session.mediaType)) return undefined;
        const start = Date.parse(session.liveTvProgramStartTime ?? '');
        const end = Date.parse(session.liveTvProgramEndTime ?? '');
        const now =
            programmeClock.serverTime +
            (browser ? performance.now() - programmeClock.receivedAt : 0);
        if (
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            end <= start ||
            now < start ||
            now >= end
        ) {
            return undefined;
        }
        return { elapsed: (now - start) / 1000, duration: (end - start) / 1000 };
    }

    function getDurationForDisplay(session: StreamSession): number {
        if (isTvChannel(session.mediaType)) return getProgramTiming(session)?.duration ?? 0;
        return session.playItemDuration ?? 0;
    }

    function getProgressForDisplay(session: StreamSession): number {
        if (isTvChannel(session.mediaType)) {
            const timing = getProgramTiming(session);
            return timing ? (timing.elapsed / timing.duration) * 100 : 0;
        }
        let progress: number;
        if (session.playIsPlaying && session.__id in clientCurrentTimes) {
            let totalSeconds = 0;
            if (session.streamRuntimeTicks) {
                totalSeconds = session.streamRuntimeTicks / 10000000;
            } else if (session.playItemDuration) {
                totalSeconds = session.playItemDuration;
            }
            if (totalSeconds > 0) {
                // Use interpolated current time for smooth progress updates
                const currentTime = getCurrentTimeForDisplay(session);
                progress = (currentTime / totalSeconds) * 100;
            } else {
                progress = session.streamProgress || 0;
            }
        } else {
            progress = session.streamProgress || 0;
        }
        // Clamp to 0-100 to prevent overflow issues
        return Math.min(100, Math.max(0, progress));
    }

    function getCurrentTimeForDisplay(session: StreamSession): number {
        // Track the clock without recreating the progress bar DOM.
        void timerTick;
        if (isTvChannel(session.mediaType)) return getProgramTiming(session)?.elapsed ?? 0;
        // Check if we have interpolated client time (use 'in' to handle 0 values correctly)
        if (session.playIsPlaying && session.__id in clientCurrentTimes) {
            const baseTime = clientCurrentTimes[session.__id];
            const baseTimestamp = clientTimeBaseTimestamps[session.__id];
            // baseTimestamp of 0 means "paused" - don't interpolate
            if (baseTimestamp && baseTimestamp > 0) {
                // Calculate elapsed time since we received the server time
                // This compensates for Jellyfin's reporting lag
                const elapsedSeconds = (Date.now() - baseTimestamp) / 1000;

                // Guard against stale timestamps (e.g., after tab was hidden)
                // or clock skew (server timestamp in future causing negative elapsed)
                if (elapsedSeconds > 30 || elapsedSeconds < 0) {
                    return baseTime;
                }

                const interpolatedTime = baseTime + elapsedSeconds;

                // Cap at duration to prevent showing time > total duration
                const duration =
                    session.playItemDuration ||
                    (session.streamRuntimeTicks ? session.streamRuntimeTicks / 10000000 : 0);
                if (duration > 0 && interpolatedTime > duration) {
                    return duration;
                }

                return interpolatedTime;
            }
            return baseTime;
        }
        // Fallback to server data - use ?? to handle position 0 correctly
        return session.playCurrentTime ?? session.streamCurrentTimeSeconds ?? 0;
    }

    function formatTime(seconds?: number): string {
        if (!seconds || seconds < 0) return '0:00';
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    function updateClientTimes() {
        // Simply increment timerTick to trigger re-render
        // The actual time calculation happens in getCurrentTimeForDisplay()
        // using timestamp-based interpolation (baseTime + elapsed since we received it)
        timerTick++;
    }

    // =========================================================================
    // Data Fetching
    // =========================================================================

    async function loadSessions() {
        if (!browser) return;
        if (isAuthFailed()) {
            // Auth failed - stop loading and show error
            loading = false;
            error = 'Authentication required. Please refresh the page.';
            return;
        }
        if (fetching) return; // Prevent concurrent fetches

        fetching = true;
        // Only show loading spinner on initial load, not during polling
        if (!initialLoadDone) {
            loading = true;
        }
        error = null;

        try {
            const result = await playbackApi.getHomeActiveSessions();

            if (result.error) {
                throw new Error(result.error);
            }

            const apiResponse = result.data;
            if (!apiResponse) {
                throw new Error('Failed to fetch sessions');
            }

            const newSessions = apiResponse.sessions;
            if (!Array.isArray(newSessions)) {
                sessions = [];
                return;
            }

            // Drop any session we just stopped ourselves that the server's short-lived
            // active-sessions cache may still be echoing back (see recentlyStopped above).
            pruneRecentlyStopped();
            sessions =
                recentlyStopped.size > 0
                    ? newSessions.filter((s) => !recentlyStopped.has(s.__id))
                    : newSessions;

            // Use the server read time so cached positions interpolate just as
            // they do for the SSR seed.
            const now = Date.now();
            const dataFetchTime = apiResponse.cacheTimestamp ?? now;
            programmeClock = { serverTime: dataFetchTime, receivedAt: performance.now() };

            // Sync timing data with server, but avoid resetting to stale positions
            // Jellyfin clients only report position every ~10 seconds, so server data can lag
            sessions.forEach((session) => {
                // Use ?? instead of || to properly handle position 0 (just started watching)
                const serverTime = session.playCurrentTime ?? session.streamCurrentTimeSeconds;
                if (serverTime === undefined) return;

                const sessionId = session.__id;
                const hasExistingTime =
                    sessionId in clientCurrentTimes && sessionId in clientTimeBaseTimestamps;

                const wasPaused = clientTimeBaseTimestamps[sessionId] === 0;

                if (!hasExistingTime) {
                    // First time seeing this session - initialize
                    clientCurrentTimes[sessionId] = serverTime;
                    clientTimeBaseTimestamps[sessionId] = session.playIsPlaying ? dataFetchTime : 0;
                } else if (session.playIsPlaying) {
                    if (wasPaused) {
                        // Just resumed from pause - start fresh from current position
                        clientCurrentTimes[sessionId] = serverTime;
                        clientTimeBaseTimestamps[sessionId] = dataFetchTime;
                    } else {
                        // Already playing - check for seek or drift
                        const elapsedSinceBase = (now - clientTimeBaseTimestamps[sessionId]) / 1000;

                        // Guard against clock skew or stale timestamps causing negative elapsed
                        if (elapsedSinceBase < 0) {
                            // Clock went backwards or timestamp is in future - reset to server
                            clientCurrentTimes[sessionId] = serverTime;
                            clientTimeBaseTimestamps[sessionId] = dataFetchTime;
                            return;
                        }

                        const interpolatedTime = clientCurrentTimes[sessionId] + elapsedSinceBase;

                        // Calculate what server time would be if interpolated from cache timestamp
                        // Guard against negative elapsed (server clock ahead) by clamping to 0
                        const serverElapsed = Math.max(0, (now - dataFetchTime) / 1000);
                        const serverInterpolatedTime = serverTime + serverElapsed;

                        // Difference between server's view and ours (positive = server ahead)
                        const diff = serverInterpolatedTime - interpolatedTime;

                        if (diff > 3 || diff < -5) {
                            // Large difference - user seeked, hard reset to server time
                            // Using 5s backward threshold for better seek detection
                            clientCurrentTimes[sessionId] = serverTime;
                            clientTimeBaseTimestamps[sessionId] = dataFetchTime;
                        } else if (diff > 0.5) {
                            // Server is 0.5-3s ahead - we're behind, correct gradually
                            // Correct 70% of the difference for faster convergence
                            const correctedPosition = interpolatedTime + diff * 0.7;
                            clientCurrentTimes[sessionId] = correctedPosition;
                            clientTimeBaseTimestamps[sessionId] = now;
                        } else if (diff < -1 && serverElapsed < 2) {
                            // Server is >1s behind AND data is relatively fresh
                            // Correct 70% toward server time
                            const correctedPosition = interpolatedTime + diff * 0.7;
                            clientCurrentTimes[sessionId] = correctedPosition;
                            clientTimeBaseTimestamps[sessionId] = now;
                        } else {
                            // Diff is small (-1 to +0.5) - interpolation is accurate
                            // Still refresh timestamp to prevent 30s stale guard from triggering
                            clientCurrentTimes[sessionId] = interpolatedTime;
                            clientTimeBaseTimestamps[sessionId] = now;
                        }
                    }
                } else {
                    // Paused - sync position, mark as paused with timestamp=0
                    clientCurrentTimes[sessionId] = serverTime;
                    clientTimeBaseTimestamps[sessionId] = 0;
                }
            });

            // Clean up stale entries for sessions that no longer exist
            const activeSessionIds = new SvelteSet(sessions.map((s) => s.__id));
            Object.keys(clientCurrentTimes).forEach((id) => {
                if (!activeSessionIds.has(id)) {
                    delete clientCurrentTimes[id];
                    delete clientTimeBaseTimestamps[id];
                    delete logoErrors[id];
                    delete episodeBackdropErrors[id];
                }
            });

            const activeTitleIds = new SvelteSet(
                sessions.flatMap((session) => [
                    session.__id,
                    `program:${session.__id}`,
                    `next-program:${session.__id}`,
                ]),
            );
            for (const id of Object.keys(longTitles)) {
                if (!activeTitleIds.has(id)) delete longTitles[id];
            }

            // Trigger reactivity
            clientCurrentTimes = { ...clientCurrentTimes };
            longTitles = { ...longTitles };
            logoErrors = { ...logoErrors };
            episodeBackdropErrors = { ...episodeBackdropErrors };
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Unknown error';
            if (errorMessage.includes('Authentication required') || errorMessage.includes('401')) {
                error = 'Authentication required. Please refresh the page.';
            } else {
                error = errorMessage;
            }
        } finally {
            loading = false;
            const wasInitial = !initialLoadDone;
            initialLoadDone = true;
            fetching = false;
            if (wasInitial) {
                // Base visibility on the filtered/deduped groups so the parent
                // hides the widget when only the viewer's own streams exist.
                onvisibilityChange?.({
                    visible: computeSessionGroups().length > 0 || lobbyParties.length > 0,
                });
            }
        }
    }

    // =========================================================================
    // Modal
    // =========================================================================

    function openSessionModal(session: StreamSession) {
        if (session.mediaType === 'tvchannel') {
            const stationId = session.mediaItemId ?? session.id;
            if (stationId) void goto(resolve(`/watch/${encodeURIComponent(stationId)}`));
            return;
        }
        const isMusicSession =
            isAudio(session.mediaType) ||
            session.mediaType === 'music' ||
            session.mediaType === 'track';

        // Radio sessions have no navigable detail modal — skip silently.
        if (session.mediaType === 'radio') return;

        if (isMusicSession) {
            // For music tracks: open album modal if available, then artist modal,
            // then fall through to generic modal as last resort.
            const albumId = session.albumId ?? session.seriesId;
            if (albumId) {
                openAlbumModal(albumId);
                return;
            }
            if (session.artistId) {
                openArtistModal(session.artistId);
                return;
            }
            // Fall through to generic modal if no album or artist available
        }

        // Only include season/episode for actual episodes (not movies)
        const isEpisodeSession = isEpisode(session.mediaType) && session.seasonNumber !== undefined;

        openMediaModal(
            {
                externalIds: session.externalIds,
                mediaType: session.mediaType,
                title: session.title,
                overview: session.overview || m.stream_no_description(),
                year: session.year,
                author: session.author,
                duration: session.duration,
                genres: [],
                rating: session.rating,
                criticRating: session.criticRating,
                imageBackdropId: session.imageId,
                isAvailable: true,
                // Only pass season/episode for actual episodes
                ...(isEpisodeSession && {
                    seasonNumber: session.seasonNumber,
                    episodeNumber: session.episodeNumber,
                    // session.seriesId is the SERIES' own id (internal UUID for
                    // DB-backed sessions). Pass it as seriesInternalId so the
                    // series modal resolves the correct parent series directly
                    // via the UUID short-circuit. Without this, the opener falls
                    // back to a fuzzy search on `title` — which for a session is
                    // the EPISODE title (e.g. "Die Brigade") — and can resolve an
                    // unrelated series whose synopsis happens to match (e.g.
                    // "Galaxy Angel", whose overview contains "Engels Brigade"),
                    // showing the wrong metadata over the right episodes.
                    seriesInternalId: session.seriesId,
                    // Carry the real series name so any name fallback latches onto
                    // the series ("The Bear"), never the episode title.
                    seriesName: session.seriesName,
                }),
            },
            getImageUrl(session),
        );
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    onMount(() => {
        if (!seedIsUsable()) {
            // No SSR data, or a stale seed replayed from a cached app shell —
            // fetch immediately rather than trusting it.
            loadSessions();
        } else {
            // SSR data is ~0s old: skip the redundant immediate refetch (the
            // poll interval will refresh it). Mark the initial load as done so
            // the poll path never reverts to the spinner, and replicate the
            // post-first-load visibility signal the fetch path emits.
            initialLoadDone = true;
            if (computeSessionGroups().length > 0 || lobbyParties.length > 0) {
                onvisibilityChange?.({ visible: true });
            }
        }

        // Use configurable poll interval (default 5s)
        const pollInterval = data?.sessions?.pollIntervalMs || 5000;
        const interval = setInterval(() => {
            // Skip polling when tab is hidden to save resources
            if (document.hidden) return;
            loadSessions();
        }, pollInterval);

        const clientTimer = setInterval(() => {
            // Skip time updates when tab is hidden
            if (document.hidden) return;
            updateClientTimes();
        }, 1000);

        // Refresh data when tab becomes visible again
        const handleVisibilityChange = () => {
            if (!document.hidden) {
                loadSessions();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Lobby parties on the watch-parties cadence (read off page data — see
        // the note in WatchParties.svelte about mount-time tuning reads).
        loadPublicParties();
        const partiesInterval = setInterval(() => {
            if (document.hidden) return;
            loadPublicParties();
        }, $page.data?.clientTuning?.partiesRefreshMs ?? CLIENT_TUNING_DEFAULTS.partiesRefreshMs);

        return () => {
            clearInterval(partiesInterval);
            clearInterval(interval);
            clearInterval(clientTimer);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    });

    // =========================================================================
    // Computed
    // =========================================================================

    type SessionGroup = StreamGroup<StreamSession>;

    // One card PER stream. A real double stream (the same user playing the same
    // media on two devices) is intentionally shown as two separate cards — that's
    // useful info, not a duplicate to hide. The viewer's own sessions are kept too.
    // The one exception is a watch party: its participants' streams fold into ONE
    // card (foldWatchParties) — they are one shared viewing, not N coincidences.
    // Pure + cheap — no network, no timers. Extracted so the visibility signal reuses it.
    function computeSessionGroups(): SessionGroup[] {
        return foldWatchParties(computeStreamGroups());
    }

    function computeStreamGroups(): { key: string; session: StreamSession }[] {
        const seenKeys = new SvelteSet<string>();
        const groups = sessions.map((session, index) => {
            // `|| undefined` so an empty-string username (subsonic/token sessions)
            // isn't treated as a real identity by the `??` fallback chains below.
            const sessionUser = session.username?.toLowerCase() || undefined;
            const userKey = sessionUser ?? session.userId ?? 'unknown';
            const mediaKey = session.mediaItemId ?? session.externalIds?.internal ?? session.__id;
            // Prefer a stable per-session id so a card doesn't remount on reorder;
            // fall back to a composite + index when the source omits it.
            const sessionId = session.playSessionId ?? session.deviceId;
            let key = sessionId
                ? `${userKey}::${mediaKey}::${sessionId}`
                : `${userKey}::${mediaKey}::${index}`;
            // Guarantee uniqueness even if the same id is somehow reported twice.
            while (seenKeys.has(key)) key = `${key}::${index}`;
            seenKeys.add(key);
            return { key, session };
        });

        // Playing sessions lead; otherwise stable (server/insertion) order —
        // Array.prototype.sort is stable.
        return groups.sort((a, b) => {
            const aPlaying = a.session.playIsPlaying ? 1 : 0;
            const bPlaying = b.session.playIsPlaying ? 1 : 0;
            return bPlaying - aPlaying;
        });
    }

    let sessionGroups = $derived.by(computeSessionGroups);

    // Public parties that have no visible stream yet (created, nobody pressed
    // play — or every participant hides their streams). They used to live in a
    // separate "Watch Parties" widget; that widget now only renders when this
    // one is off (see +page.svelte).
    let lobbyParties = $derived.by(() => {
        const shown = new SvelteSet<string>();
        for (const g of sessionGroups) {
            const code = g.party?.tag.code;
            if (code) shown.add(code.toUpperCase());
        }
        return publicParties.filter((p) => !shown.has(p.code.toUpperCase()));
    });

    function joinParty(event: Event, code: string) {
        event.stopPropagation();
        goto(resolve(`/party/${encodeURIComponent(code)}`));
    }

    // Keep ticking progress outside this metadata map: rebuilding it each
    // second reattaches fitTitle and resets the reader's mouse-position reveal.
    let itemsById = $derived(
        Object.fromEntries(sessions.map((session) => [session.__id, transformSession(session)])),
    );
</script>

<section class="mb-8">
    <!-- Header -->
    <div class="mb-4">
        <h2 class="h2 text-center md:text-left">
            {m.session_active_streams()}
        </h2>
    </div>

    <!-- Content -->
    {#if loading}
        <div class="center py-12">
            <div class="relative">
                <span
                    class="loading-spinner loading-spinner-lg loading-spinner-primary w-12 h-12 border-4"
                ></span>
            </div>
            <div class="ml-4">
                <p class="text-surface-300 font-medium">
                    {m.session_loading_active_streams()}
                </p>
                <p class="text-surface-500 text-sm">
                    {m.session_from_all_sources()}
                </p>
            </div>
        </div>
    {:else if error}
        <div class="text-center py-12">
            <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-error-500/20 center">
                <svg
                    class="w-8 h-8 text-error-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
            </div>
            <p class="text-error-400 font-medium mb-4">
                {m.session_error_loading_streams()}
            </p>
            <p class="text-surface-400 text-sm mb-4">{error}</p>
            <button
                class="px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg font-medium transition-colors"
                onclick={loadSessions}>
                {m.session_retry()}
            </button>
        </div>
    {:else if sessionGroups.length === 0 && lobbyParties.length === 0}
        <!-- Fixed height empty state to prevent layout shifts during polling -->
        <div class="text-center py-12 min-h-[200px] center-col">
            <div
                class="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-surface-600/50 to-surface-700/30 center border border-surface-500/30">
                <svg
                    class="w-10 h-10 text-surface-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M7 4V2a1 1 0 011-1h8a1 1 0 011 1v2m0 0V3a1 1 0 011 1v12a1 1 0 01-1 1H8a1 1 0 01-1-1V4m0 0h10M9 7h6m-6 4h6m-6 4h4" />
                </svg>
            </div>
            <h3 class="text-surface-300 font-semibold mb-2">
                {m.session_no_active_streams()}
            </h3>
            <p class="text-surface-400 text-sm">
                {m.session_currently_no_one_watching()}
            </p>
        </div>
    {:else}
        <!-- Session Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {#each sessionGroups as group (group.key)}
                {@const session = group.session}
                {#if itemsById[session.__id]}
                    <CrossfadeStreamIndicator crossfade={session.crossfade}>
                        {#snippet children(crossfading)}
                            <div
                                class="stream-card relative rounded-xl overflow-hidden cursor-pointer shadow-lg hover:shadow-xl border border-surface-600/50 hover:border-surface-500/70 bg-gradient-to-br from-surface-800/50 to-surface-700/30"
                                class:party-card={!!group.party}
                                class:party-card-deep={(group.party?.members.length ?? 0) > 2}
                                onpointermove={scrubTitle}
                                onpointerleave={resetScrub}
                                onmouseenter={() => {
                                    hoveredSessionId = session.__id;
                                }}
                                onmouseleave={() => {
                                    hoveredSessionId = null;
                                }}
                                onclick={() => {
                                    hoveredSessionId = null;
                                    openSessionModal(session);
                                }}
                                onkeydown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        hoveredSessionId = null;
                                        openSessionModal(session);
                                    }
                                }}
                                role="button"
                                tabindex="0"
                                aria-describedby={crossfading
                                    ? `crossfade-${session.__id}`
                                    : undefined}
                                aria-label="{itemsById[session.__id].title}{itemsById[session.__id]
                                    .subtitle
                                    ? ` - ${itemsById[session.__id].subtitle}`
                                    : ''}{session.liveTvProgramName
                                    ? `, ${session.liveTvProgramName}`
                                    : ''}, {session.username
                                    ? `watched by ${displayName(session.username)}`
                                    : 'streaming'}">
                                <!-- Image -->
                                <div class="stream-artwork relative aspect-video overflow-hidden">
                                    {#if itemsById[session.__id].isSquareArt}
                                        <div class="absolute inset-0 isolate">
                                            <!-- Pillarbox: blurred background + centered square art -->
                                            <img
                                                src={itemsById[session.__id].backdrop}
                                                alt=""
                                                aria-hidden="true"
                                                class="absolute inset-0 w-full h-full object-cover scale-150 blur-2xl brightness-50"
                                                loading="lazy"
                                                use:fallbackImage />
                                            <img
                                                src={itemsById[session.__id].backdrop}
                                                alt={itemsById[session.__id].title}
                                                class="absolute inset-0 h-full object-contain mx-auto transition-transform duration-300 drop-shadow-lg"
                                                class:scale-105={hoveredSessionId === session.__id}
                                                class:crossfade-cover-current={crossfading}
                                                class:crossfade-cover-incoming={crossfading &&
                                                    session.crossfade?.role === 'incoming'}
                                                loading="lazy"
                                                use:fallbackImage />
                                            {#if crossfading && session.crossfade}
                                                <img
                                                    src={getCatalogPosterUrl(
                                                        session.crossfade.otherTrack.mediaId,
                                                        { size: 'card' },
                                                    )}
                                                    alt={session.crossfade.otherTrack.title}
                                                    class="crossfade-cover-other"
                                                    class:crossfade-cover-outgoing={session
                                                        .crossfade.role === 'incoming'}
                                                    loading="eager"
                                                    use:fallbackImage />
                                            {/if}
                                        </div>
                                    {:else}
                                        <!-- Base image (series backdrop for episodes, or item backdrop) -->
                                        <img
                                            src={itemsById[session.__id].backdrop}
                                            alt={itemsById[session.__id].title}
                                            class="w-full h-full object-cover transition-transform duration-300"
                                            class:scale-105={hoveredSessionId === session.__id}
                                            loading="lazy"
                                            use:fallbackImage />
                                        <!-- Episode-specific backdrop on hover (if available) -->
                                        {#if itemsById[session.__id].episodeBackdropUrl && !episodeBackdropErrors[session.__id]}
                                            <img
                                                src={itemsById[session.__id].episodeBackdropUrl}
                                                alt={itemsById[session.__id].title}
                                                class="absolute inset-0 w-full h-full object-cover transition-[opacity,transform] duration-300"
                                                class:opacity-100={hoveredSessionId ===
                                                    session.__id}
                                                class:scale-105={hoveredSessionId === session.__id}
                                                class:opacity-0={hoveredSessionId !== session.__id}
                                                loading="lazy"
                                                onerror={() => {
                                                    episodeBackdropErrors[session.__id] = true;
                                                    episodeBackdropErrors = episodeBackdropErrors;
                                                }} />
                                        {/if}
                                    {/if}

                                    <!-- Buffering indicator — shown while position not yet reported -->
                                    {#if session.isBuffering}
                                        <div
                                            class="absolute bottom-2 left-2 flex items-center gap-1 text-xs font-medium text-white">
                                            <span
                                                class="px-1.5 py-0.5 bg-black/70 backdrop-blur-sm rounded text-amber-400 italic">
                                                Buffering…
                                            </span>
                                        </div>
                                    {/if}

                                    <!-- Playback time and progress update in place every second. -->
                                    {#if !session.isBuffering && (isTvChannel(session.mediaType) ? getDurationForDisplay(session) > 0 : getProgressForDisplay(session) > 0 || crossfading)}
                                        <!-- timerTick drives the display item without remounting the animated bar. -->
                                        <!-- Time Display -->
                                        <div
                                            class="absolute bottom-2 left-2 flex items-center gap-1 text-xs font-medium text-white">
                                            <span
                                                class="px-1.5 py-0.5 bg-black/70 backdrop-blur-sm rounded">
                                                {formatTime(getCurrentTimeForDisplay(session))}
                                                {#if session.playIsPlaying}
                                                    <span class="text-green-400 ml-0.5">▶</span>
                                                {/if}
                                            </span>
                                            <span class="text-surface-300">/</span>
                                            <span
                                                class="px-1.5 py-0.5 bg-black/70 backdrop-blur-sm rounded">
                                                {formatTime(getDurationForDisplay(session))}
                                            </span>
                                        </div>
                                        <!-- Keep the ordinary playback progress during a crossfade. -->
                                        <div
                                            class="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                                            <div
                                                class:crossfade-progress={crossfading &&
                                                    !!session.playIsPlaying}
                                                data-testid="stream-progress-fill"
                                                class="h-full {session.playIsPlaying === false
                                                    ? 'bg-gradient-to-r from-yellow-500 to-yellow-400 animate-pulse-slow'
                                                    : 'bg-gradient-to-r from-primary-500 to-primary-400'}"
                                                style="width: {Math.round(
                                                    getProgressForDisplay(session),
                                                )}%">
                                            </div>
                                        </div>
                                    {/if}

                                    <!-- Status Badge -->
                                    {#if session.playIsPlaying !== undefined}
                                        <div
                                            class="absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-medium backdrop-blur-md {session.playIsPlaying
                                                ? 'bg-green-500/90 text-white'
                                                : 'bg-yellow-500/90 text-black'}">
                                            {session.playIsPlaying ? '▶️' : '⏸️'}
                                        </div>
                                    {/if}

                                    <!-- Watch party chip -->
                                    {#if group.party}
                                        <div
                                            class="absolute top-10 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold text-white bg-primary-600/90 backdrop-blur-md shadow">
                                            <svg
                                                class="w-3 h-3"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                stroke-width="2.5"
                                                aria-hidden="true">
                                                <path
                                                    d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                                <circle cx="9" cy="7" r="4" />
                                                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                                                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                                            </svg>
                                            {group.party.members.length > 1
                                                ? m.session_party_watching_together({
                                                      count: group.party.members.length,
                                                  })
                                                : m.session_party_label()}
                                        </div>
                                    {/if}

                                    <!-- Media Type Badge + Season/Episode Badges -->
                                    <div class="absolute top-2 left-2 flex items-center gap-1">
                                        <div
                                            class="px-2 py-1 rounded-full text-xs font-bold text-white backdrop-blur-md {itemsById[
                                                session.__id
                                            ].mediaTypeColor}/90">
                                            {itemsById[session.__id].mediaTypeDisplay}
                                        </div>
                                        {#if isEpisode(session.mediaType)}
                                            <span
                                                class="px-1.5 py-0.5 bg-surface-600/80 text-white rounded text-xs font-medium backdrop-blur-sm">
                                                S{session.seasonNumber || '?'}
                                            </span>
                                            <span
                                                class="px-1.5 py-0.5 bg-surface-600/80 text-white rounded text-xs font-medium backdrop-blur-sm">
                                                E{session.episodeNumber || '?'}
                                            </span>
                                        {/if}
                                        {#if session.isPreview}
                                            <div
                                                class="px-1.5 py-0.5 bg-amber-500/90 text-black rounded text-xs font-bold backdrop-blur-sm">
                                                PREVIEW
                                            </div>
                                        {/if}
                                        {#if session.sessionSource === 'jellyfin'}
                                            <span
                                                class="px-1.5 py-0.5 bg-purple-900/80 text-purple-200 rounded text-xs font-medium backdrop-blur-sm">
                                                Jellyfin
                                            </span>
                                        {:else if session.sessionSource === 'lumastra' && session.deviceId?.startsWith('jellyfin-compat-')}
                                            <span
                                                class="px-1.5 py-0.5 bg-teal-900/80 text-teal-200 rounded text-xs font-medium backdrop-blur-sm">
                                                /j Compat
                                            </span>
                                        {:else if session.sessionSource === 'subsonic'}
                                            <span
                                                class="px-1.5 py-0.5 bg-amber-900/80 text-amber-200 rounded text-xs font-medium backdrop-blur-sm">
                                                Subsonic
                                            </span>
                                        {:else if session.sessionSource === 'audiobookshelf' && session.isReadOnly}
                                            <!--
                                      Direct AudiobookShelf listener: Lumastra only
                                      observed this session (mirrored from ABS's own
                                      API) and cannot stop it — see isOwnSession above.
                                      The badge names the app actually serving the
                                      bytes.
                                    -->
                                            <span
                                                class="px-1.5 py-0.5 bg-sky-900/80 text-sky-200 rounded text-xs font-medium backdrop-blur-sm">
                                                AudiobookShelf
                                            </span>
                                        {:else if session.sessionSource === 'audiobookshelf'}
                                            <!--
                                      isReadOnly is false/undefined here — Lumastra's
                                      own byte proxy is serving this stream (see
                                      isOwnSession's `!session.isReadOnly`), not
                                      AudiobookShelf directly. Brand it the same as
                                      any other Lumastra-served session rather than
                                      the source library, or the badge reads
                                      backwards to an operator.
                                    -->
                                            <span
                                                class="px-1.5 py-0.5 bg-blue-900/80 text-blue-200 rounded text-xs font-medium backdrop-blur-sm">
                                                Lumastra
                                            </span>
                                        {/if}
                                        {#if canSeeDeviceInfo && session.isCarPlay}
                                            <span
                                                class="px-1.5 py-0.5 bg-emerald-900/90 text-emerald-200 rounded text-xs font-medium backdrop-blur-sm"
                                                >CarPlay</span>
                                        {/if}
                                    </div>

                                    <!-- Quality Badges + Info Button -->
                                    <div class="absolute bottom-2 right-2 flex items-center gap-1">
                                        <!-- Stop button for the viewer's own stream — self-cancel skips the kick cooldown. -->
                                        {#if isOwnSession(session)}
                                            <button
                                                type="button"
                                                class="p-1 rounded-full bg-black/50 hover:bg-error-500/90 text-white/70 hover:text-white transition-colors duration-200 z-10"
                                                aria-label={m.session_stop_stream()}
                                                title={m.session_stop_stream()}
                                                onclick={stopPropagation(
                                                    preventDefault(() =>
                                                        requestStopSession(session),
                                                    ),
                                                )}
                                                onpointerdown={stopPropagation()}>
                                                <svg
                                                    class="w-3.5 h-3.5"
                                                    viewBox="0 0 24 24"
                                                    fill="currentColor"
                                                    aria-hidden="true">
                                                    <rect
                                                        x="6"
                                                        y="6"
                                                        width="12"
                                                        height="12"
                                                        rx="2" />
                                                </svg>
                                            </button>
                                        {/if}
                                        <!-- Info button for touch/mobile only - toggles technical overlay (only if enabled in preferences) -->
                                        {#if $showStreamTechInfo}
                                            <button
                                                class="p-1 rounded-full bg-black/50 hover:bg-black/70 text-white/70 hover:text-white transition-colors duration-200 md:hidden z-10"
                                                onclick={stopPropagation(
                                                    preventDefault(
                                                        () =>
                                                            (hoveredSessionId =
                                                                hoveredSessionId === session.__id
                                                                    ? null
                                                                    : session.__id),
                                                    ),
                                                )}
                                                onpointerdown={stopPropagation()}
                                                aria-label={m.footer_stream_tech_info()}
                                                title={m.footer_stream_tech_info()}>
                                                <svg
                                                    class="w-3.5 h-3.5"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    viewBox="0 0 24 24"
                                                    aria-hidden="true">
                                                    <path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        stroke-width="2"
                                                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                            </button>
                                        {/if}
                                        {#if itemsById[session.__id].resolution}
                                            <span
                                                class="px-1.5 py-0.5 bg-blue-500/90 text-white rounded text-xs font-bold backdrop-blur-sm">
                                                {itemsById[session.__id].resolution}
                                            </span>
                                        {/if}
                                        {#if session.adaptive}
                                            <AdaptiveStreamBadge adaptive={session.adaptive} />
                                        {/if}
                                        {#if itemsById[session.__id].musicFormat}
                                            <span
                                                class="px-1.5 py-0.5 bg-emerald-600/90 text-white rounded text-xs font-bold backdrop-blur-sm">
                                                {itemsById[session.__id].musicFormat}
                                            </span>
                                        {/if}
                                        {#if itemsById[session.__id].isHDR}
                                            <span
                                                class="px-1.5 py-0.5 rounded text-xs font-bold text-white"
                                                style="background: linear-gradient(45deg, #f59e0b, #ea580c);">
                                                HDR
                                            </span>
                                        {/if}
                                    </div>

                                    <!-- Technical Info Overlay on Hover (only if enabled in preferences) -->
                                    {#if $showStreamTechInfo && hoveredSessionId === session.__id}
                                        <div
                                            class="absolute inset-0 bg-black/70 center p-4 transition-opacity duration-200">
                                            <div class="text-xs space-y-0.5 w-full max-w-[280px]">
                                                {#if isAudiobook(session.mediaType) || isAudio(session.mediaType) || session.mediaType === 'music'}
                                                    <!-- Audio content -->
                                                    <div class="flex text-surface-200">
                                                        <span class="text-green-400 mr-2">🎵</span>
                                                        <span
                                                            >{[
                                                                getAudioTranscodeDisplay(session),
                                                                getAudioQualityDetail(session),
                                                                getTranscodeInfo(session),
                                                            ]
                                                                .filter(Boolean)
                                                                .join(' • ')}</span>
                                                    </div>
                                                {:else}
                                                    <!-- Video line: CODEC (bitrate) → CODEC (bitrate) -->
                                                    {#if getVideoTranscodeDisplay(session)}
                                                        <div class="flex text-surface-200">
                                                            <span class="text-blue-400 mr-2"
                                                                >🎬</span>
                                                            <span
                                                                >{getVideoTranscodeDisplay(
                                                                    session,
                                                                )}</span>
                                                        </div>
                                                    {/if}
                                                    <!-- Audio line: CODEC (bitrate) → CODEC (bitrate) • track info -->
                                                    {#if getAudioTranscodeDisplay(session) || getAudioTrackDisplay(session)}
                                                        <div class="flex text-surface-200">
                                                            <span class="text-green-400 mr-2"
                                                                >🎵</span>
                                                            <span
                                                                >{[
                                                                    getAudioTranscodeDisplay(
                                                                        session,
                                                                    ),
                                                                    getAudioTrackDisplay(session),
                                                                ]
                                                                    .filter(Boolean)
                                                                    .join(' • ')}</span>
                                                        </div>
                                                    {/if}
                                                    <!-- Playback method (only if not DirectPlay) -->
                                                    {#if getTranscodeInfo(session) && getTranscodeInfo(session) !== 'Direct'}
                                                        <div class="flex text-surface-200">
                                                            <span class="text-purple-400 mr-2"
                                                                >⚡</span>
                                                            <span
                                                                >{getTranscodeInfo(
                                                                    session,
                                                                )}{getTranscodeReasonText(session)
                                                                    ? ` (${getTranscodeReasonText(
                                                                          session,
                                                                      )})`
                                                                    : ''}</span>
                                                        </div>
                                                    {/if}
                                                {/if}

                                                <!-- Subtitles (only if active) -->
                                                {#if session.playSubtitleMethod === 'burn_in' || ((session.playSubtitleLanguage || session.playSubtitleTitle) && session.playSubtitleMethod !== 'none')}
                                                    <div class="flex text-surface-200">
                                                        <span class="text-pink-400 mr-2">💬</span>
                                                        <span>{getSubtitleDisplay(session)}</span>
                                                    </div>
                                                {/if}

                                                <!-- Device info (only if user has permission) -->
                                                {#if canSeeDeviceInfo && (session.clientname || session.browsername || session.clientApp || formFactorLabel(session.formFactor))}
                                                    <div class="flex text-surface-200">
                                                        <span class="text-surface-400 mr-2"
                                                            >📱</span>
                                                        <span>
                                                            {#if session.clientApp || session.clientPlayerName}
                                                                <!-- Show client app info when available (from /api/v1 clients like tvOS) -->
                                                                {[
                                                                    formFactorLabel(
                                                                        session.formFactor,
                                                                    ),
                                                                    session.clientApp,
                                                                    session.clientPlayerName,
                                                                ]
                                                                    .filter(Boolean)
                                                                    .join(' • ')}
                                                            {:else}
                                                                <!-- Fallback to standard Jellyfin client info -->
                                                                {[
                                                                    formFactorLabel(
                                                                        session.formFactor,
                                                                    ),
                                                                    session.clientname,
                                                                    session.browsername,
                                                                ]
                                                                    .filter(Boolean)
                                                                    .join(' • ')}
                                                            {/if}
                                                        </span>
                                                    </div>
                                                {/if}

                                                <!-- Fallback if no technical details -->
                                                {#if !getTranscodeInfo(session) && !getCodecInfo(session) && !getAudioCodecInfo(session)}
                                                    <div class="text-surface-400 italic">
                                                        {m.stream_no_tech_details()}
                                                    </div>
                                                {/if}
                                            </div>
                                        </div>
                                    {/if}
                                </div>

                                <!-- Title Section with User Avatar -->
                                <div
                                    class="p-3 md:p-4 flex flex-col min-h-[140px] md:min-h-[155px]">
                                    <!-- Top row: Logo/Title and Avatar -->
                                    <div class="flex items-start justify-between gap-2">
                                        <!-- Left side: Logo/Title -->
                                        <div class="flex-1 min-w-0">
                                            <!-- Logo/Title container with fixed height -->
                                            <div
                                                class="h-8 flex items-center relative overflow-hidden">
                                                {#if itemsById[session.__id].logoUrl && !logoErrors[session.__id]}
                                                    <!-- Show logo by default, title on hover -->
                                                    <img
                                                        src={itemsById[session.__id].logoUrl}
                                                        alt={itemsById[session.__id].title}
                                                        class="max-h-8 max-w-full object-contain object-left transition-opacity duration-200"
                                                        class:opacity-100={hoveredSessionId !==
                                                            session.__id}
                                                        class:opacity-0={hoveredSessionId ===
                                                            session.__id}
                                                        onerror={() => {
                                                            logoErrors[session.__id] = true;
                                                            logoErrors = {
                                                                ...logoErrors,
                                                            };
                                                        }} />
                                                    <div
                                                        class="absolute inset-0 flex items-center overflow-hidden transition-opacity duration-200"
                                                        class:opacity-0={hoveredSessionId !==
                                                            session.__id}
                                                        class:opacity-100={hoveredSessionId ===
                                                            session.__id}>
                                                        <h3
                                                            {@attach fitTitle(
                                                                session.__id,
                                                                itemsById[session.__id].title,
                                                            )}
                                                            class="stream-title font-bold text-white"
                                                            class:is-long={longTitles[session.__id]}
                                                            class:is-hovered={hoveredSessionId ===
                                                                session.__id}>
                                                            {itemsById[session.__id].title}
                                                        </h3>
                                                    </div>
                                                {:else}
                                                    <!-- Fallback to title if no logo or logo failed -->
                                                    <h3
                                                        {@attach fitTitle(
                                                            session.__id,
                                                            itemsById[session.__id].title,
                                                        )}
                                                        class="stream-title font-bold text-white transition-colors"
                                                        class:is-long={longTitles[session.__id]}
                                                        class:is-hovered={hoveredSessionId ===
                                                            session.__id}
                                                        class:text-blue-300={hoveredSessionId ===
                                                            session.__id}>
                                                        {itemsById[session.__id].title}
                                                    </h3>
                                                {/if}
                                            </div>
                                            <!-- Subtitle with fixed height slot -->
                                            <div class="h-5 mt-1">
                                                {#if itemsById[session.__id].subtitle}
                                                    <p class="text-sm text-surface-400 truncate">
                                                        {itemsById[session.__id].subtitle}
                                                    </p>
                                                {/if}
                                            </div>
                                        </div>

                                        <!-- Right side: User Avatar -->
                                        {#if group.party}
                                            {@const party = group.party}
                                            <div class="flex items-center gap-2 shrink-0">
                                                {#if party.tag.code && !party.tag.viewerIsParticipant}
                                                    <button
                                                        type="button"
                                                        class="text-xs font-semibold px-2 py-0.5 rounded-full bg-primary-500 hover:bg-primary-400 text-white transition-colors"
                                                        aria-label={m.session_party_join_aria({
                                                            host: displayName(
                                                                party.tag.host.displayName ?? '',
                                                            ),
                                                        })}
                                                        onclick={(e) =>
                                                            joinParty(e, party.tag.code ?? '')}
                                                        onkeydown={(e) => e.stopPropagation()}>
                                                        {m.session_party_join()}
                                                    </button>
                                                {/if}
                                                <WatchPartyCluster
                                                    members={party.members}
                                                    syncState={party.tag.syncState}
                                                    showDevices={canSeeDeviceInfo} />
                                            </div>
                                        {:else}
                                            <div class="flex items-center gap-2 shrink-0">
                                                {#if session.isPrivate && isAdmin}
                                                    <span
                                                        class="text-[10px] px-1.5 py-0.5 rounded bg-surface-600 text-surface-300"
                                                        title={m.session_private_hint()}>
                                                        {m.session_private()}
                                                    </span>
                                                {/if}
                                                {#if session.username}
                                                    <span
                                                        class="text-xs font-medium text-surface-300 hidden sm:inline">
                                                        {displayName(session.username)}
                                                    </span>
                                                {/if}
                                                <Avatar
                                                    src={getAvatarUrl(
                                                        session.userId ||
                                                            session.username ||
                                                            'user',
                                                    )}
                                                    alt={session.username
                                                        ? `${session.username} avatar`
                                                        : 'User avatar'}
                                                    initials={(session.username || 'U')
                                                        .charAt(0)
                                                        .toUpperCase()}
                                                    username={session.username}
                                                    size="xs"
                                                    border="border-2 border-surface-500/50" />
                                            </div>
                                        {/if}
                                    </div>

                                    <!-- LiveTV Enhanced Info -->
                                    {#if isTvChannel(session.mediaType)}
                                        <div class="mt-2 space-y-1.5 flex-1">
                                            <!-- Current Program -->
                                            {#if session.liveTvProgramName}
                                                <div class="flex items-start gap-2">
                                                    <span class="text-green-400 text-xs mt-0.5"
                                                        >▶</span>
                                                    <div class="flex-1 min-w-0 overflow-hidden">
                                                        <p
                                                            {@attach fitTitle(
                                                                `program:${session.__id}`,
                                                                session.liveTvProgramName,
                                                            )}
                                                            class="stream-title stream-program-title text-sm text-white font-medium"
                                                            class:is-long={longTitles[
                                                                `program:${session.__id}`
                                                            ]}
                                                            class:is-hovered={hoveredSessionId ===
                                                                session.__id}
                                                            title={session.liveTvProgramName}>
                                                            {session.liveTvProgramName}
                                                        </p>
                                                        {#if session.liveTvProgramEndTime}
                                                            <p class="text-xs text-surface-400">
                                                                {m.stream_until()}
                                                                {formatLiveTvTime(
                                                                    session.liveTvProgramEndTime,
                                                                )}
                                                                {#if getProgramTiming(session)}
                                                                    <span
                                                                        class="text-surface-500 hidden sm:inline"
                                                                        >({Math.round(
                                                                            getProgressForDisplay(
                                                                                session,
                                                                            ),
                                                                        )}%)</span>
                                                                {/if}
                                                            </p>
                                                        {/if}
                                                    </div>
                                                </div>
                                            {/if}
                                            <!-- Next Program -->
                                            {#if session.liveTvNextProgramName}
                                                <div class="flex items-start gap-2">
                                                    <span class="text-surface-500 text-xs mt-0.5"
                                                        >▷</span>
                                                    <div class="flex-1 min-w-0 overflow-hidden">
                                                        <p
                                                            {@attach fitTitle(
                                                                `next-program:${session.__id}`,
                                                                `${session.liveTvNextProgramStartTime ?? ''} ${session.liveTvNextProgramName}`,
                                                            )}
                                                            class="stream-title stream-program-title text-xs text-surface-400"
                                                            class:is-long={longTitles[
                                                                `next-program:${session.__id}`
                                                            ]}
                                                            class:is-hovered={hoveredSessionId ===
                                                                session.__id}
                                                            title={session.liveTvNextProgramName}>
                                                            {#if session.liveTvNextProgramStartTime}
                                                                <span class="text-surface-500"
                                                                    >{formatLiveTvTime(
                                                                        session.liveTvNextProgramStartTime,
                                                                    )}</span>
                                                            {/if}
                                                            {session.liveTvNextProgramName}
                                                        </p>
                                                    </div>
                                                </div>
                                            {/if}
                                        </div>
                                    {:else if session.mediaType === 'radio'}
                                        <!-- Radio-specific info -->
                                        <div class="mt-2 space-y-1 flex-1">
                                            {#if session.radioProgram}
                                                <p class="text-sm text-surface-300 truncate">
                                                    <span class="text-surface-500">📻</span>
                                                    {session.radioProgram}
                                                </p>
                                            {/if}
                                            {#if session.radioDj}
                                                <p class="text-xs text-surface-400 truncate">
                                                    <span class="text-surface-500">🎙️</span>
                                                    DJ {session.radioDj}
                                                </p>
                                            {/if}
                                            {#if session.nowPlayingArtist || session.nowPlayingTrack}
                                                <p class="text-xs text-rose-400/80 truncate">
                                                    <span>♪</span>
                                                    {#if session.nowPlayingArtist && session.nowPlayingTrack}
                                                        {session.nowPlayingArtist} – {session.nowPlayingTrack}
                                                    {:else}
                                                        {session.nowPlayingTrack ??
                                                            session.nowPlayingArtist}
                                                    {/if}
                                                </p>
                                            {/if}
                                        </div>
                                    {:else if isAudio(session.mediaType) || session.mediaType === 'music' || session.mediaType === 'track'}
                                        <!-- Music-specific info -->
                                        <div class="mt-2 space-y-1 flex-1">
                                            {#if session.artistName ?? session.author}
                                                <p class="text-sm text-surface-300 truncate">
                                                    <span class="text-surface-500">🎤</span>
                                                    {session.artistName ?? session.author}
                                                </p>
                                            {/if}
                                            {#if session.albumName ?? session.seriesName}
                                                <p class="text-xs text-surface-400 truncate">
                                                    <span class="text-surface-500">💿</span>
                                                    {session.albumName ?? session.seriesName}
                                                </p>
                                            {/if}
                                            <div class="h-4">
                                                {#if crossfading && session.crossfade}
                                                    <p
                                                        class="text-xs text-primary-300 truncate"
                                                        data-testid="crossfade-indicator"
                                                        id="crossfade-{session.__id}">
                                                        {session.crossfade.role === 'incoming'
                                                            ? m.stream_crossfade_from()
                                                            : m.stream_crossfade_into()}
                                                        {session.crossfade.otherTrack.title}{session
                                                            .crossfade.otherTrack.artistName
                                                            ? ` — ${session.crossfade.otherTrack.artistName}`
                                                            : ''}
                                                    </p>
                                                {:else if session.nextTrack}
                                                    <p class="text-xs text-surface-500 truncate">
                                                        <span>Next:</span>
                                                        {session.nextTrack.title}{session.nextTrack
                                                            .artistName
                                                            ? ` — ${session.nextTrack.artistName}`
                                                            : ''}
                                                    </p>
                                                {/if}
                                            </div>
                                        </div>
                                        <!-- Year only if valid (> 1900) -->
                                        {#if itemsById[session.__id].year && Number(itemsById[session.__id].year) > 1900}
                                            <div class="mt-auto pt-2">
                                                <p class="text-xs text-surface-500">
                                                    {itemsById[session.__id].year}
                                                </p>
                                            </div>
                                        {/if}
                                    {:else}
                                        <!-- Description (2 lines max) for non-LiveTV, non-Audio -->
                                        {#if session.overview}
                                            <p class="text-xs text-surface-400 line-clamp-2 mt-2">
                                                {session.overview}
                                            </p>
                                        {/if}

                                        <!-- Bottom row: Year (pushed to bottom) - only if valid -->
                                        {#if itemsById[session.__id].year && Number(itemsById[session.__id].year) > 1900}
                                            <div class="mt-auto pt-2">
                                                <p class="text-xs text-surface-500">
                                                    {itemsById[session.__id].year}
                                                </p>
                                            </div>
                                        {/if}
                                    {/if}
                                </div>
                            </div>
                        {/snippet}
                    </CrossfadeStreamIndicator>
                {/if}
            {/each}
            {#each lobbyParties as lobby (lobby.code)}
                <button
                    type="button"
                    class="party-lobby relative rounded-xl border-2 border-dashed border-primary-500/40 hover:border-primary-400/80 bg-surface-800/40 hover:bg-surface-800/70 transition-colors text-left p-4 flex flex-col justify-between gap-3 min-h-[8rem]"
                    aria-label={m.session_party_join_aria({
                        host: displayName(lobby.host.displayName ?? ''),
                    })}
                    onclick={(e) => joinParty(e, lobby.code)}>
                    <div class="flex items-center gap-2">
                        <span class="relative flex h-2.5 w-2.5" aria-hidden="true">
                            <span
                                class="absolute inline-flex h-full w-full rounded-full bg-primary-400 opacity-75 motion-safe:animate-ping"
                            ></span>
                            <span
                                class="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary-500"
                            ></span>
                        </span>
                        <span
                            class="text-xs font-semibold uppercase tracking-wide text-primary-300">
                            {lobby.isPlaying
                                ? m.session_party_live_now()
                                : m.session_party_starting_soon()}
                        </span>
                    </div>
                    <div class="min-w-0">
                        <p class="font-semibold text-surface-100 truncate">{lobby.title}</p>
                        <p class="text-xs text-surface-400 truncate">
                            {m.session_party_lobby_hosted_by({
                                host: displayName(lobby.host.displayName ?? ''),
                                count: lobby.participantCount,
                            })}
                        </p>
                    </div>
                    <span
                        class="self-start text-xs font-semibold px-2.5 py-1 rounded-full bg-primary-500 text-white">
                        {m.session_party_join()}
                    </span>
                </button>
            {/each}
        </div>
    {/if}
</section>

<style>
    /* --- Active-stream title overflow handling ---
       Titles are auto-shrunk to fit one line (JS `fitTitle`), so cards stay a
       uniform height. Titles that still overflow at the minimum font size get
       `.is-long`, which enables the reveal affordance:
         - desktop (hover): ellipsis at rest, mouse-position scrub on hover
         - touch (no hover): auto-marquee
         - reduced-motion: static ellipsis (never scrolls) */
    .stream-title {
        white-space: nowrap;
        max-width: 100%;
    }

    .stream-title.is-long {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    /* Desktop: on hover, drop the ellipsis clip so the JS scrub can pan the full
       title within the (already clipped) container. */
    @media (hover: hover) {
        .stream-title.is-long.is-hovered {
            overflow: visible;
            text-overflow: clip;
        }
    }

    .stream-card:focus-visible .stream-program-title {
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        transform: none !important;
        animation: none;
    }

    /* Touch: no cursor to scrub with — auto-scroll long titles instead. The
       overflow distance is measured in JS and exposed as --stream-overflow. */
    @media (hover: none) {
        .stream-title.is-long {
            overflow: visible;
            text-overflow: clip;
            animation: marquee-scroll 10s ease-in-out infinite;
        }
    }

    @keyframes marquee-scroll {
        0%,
        25% {
            transform: translateX(0);
        }
        45%,
        55% {
            transform: translateX(calc(-1 * var(--stream-overflow, 0px)));
        }
        75%,
        100% {
            transform: translateX(0);
        }
    }

    /* Watch-party card: the extra participants' streams read as cards stacked
       behind this one. box-shadow is not clipped by the card's own
       overflow:hidden, so no wrapper element is needed. */
    .party-card {
        border-color: rgb(var(--color-primary-500-rgb) / 0.55);
        box-shadow:
            6px -6px 0 -1px var(--color-surface-700),
            6px -6px 0 0 rgb(var(--color-primary-500-rgb) / 0.35),
            0 10px 15px -3px rgb(0 0 0 / 0.3);
        margin-top: 6px;
        margin-right: 6px;
    }

    .party-card.party-card-deep {
        box-shadow:
            6px -6px 0 -1px var(--color-surface-700),
            6px -6px 0 0 rgb(var(--color-primary-500-rgb) / 0.35),
            12px -12px 0 -2px var(--color-surface-800),
            12px -12px 0 -1px rgb(var(--color-primary-500-rgb) / 0.2),
            0 10px 15px -3px rgb(0 0 0 / 0.3);
        margin-top: 12px;
        margin-right: 12px;
    }

    .crossfade-cover-current {
        transform: translateX(-14%) scale(0.86);
    }

    .crossfade-cover-other {
        position: absolute;
        top: 12%;
        left: 46%;
        height: 76%;
        aspect-ratio: 1;
        object-fit: cover;
        border-radius: 0.5rem;
        border: 2px solid rgb(255 255 255 / 0.25);
        box-shadow: 0 6px 18px rgb(0 0 0 / 0.4);
    }

    .crossfade-cover-incoming {
        transform: translateX(14%) scale(0.86);
        z-index: 1;
    }

    .crossfade-cover-outgoing {
        left: 12%;
    }

    .crossfade-progress {
        animation: pulse-slow 4s ease-in-out infinite;
        box-shadow: 0 0 8px rgb(var(--color-primary-500-rgb) / 0.5);
    }

    /* Slower pulse for paused progress bar (4s instead of Tailwind's 2s) */
    .animate-pulse-slow {
        animation: pulse-slow 4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }

    @keyframes pulse-slow {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.6;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .stream-title.is-long {
            animation: none;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .crossfade-progress,
        .animate-pulse-slow {
            animation: none;
        }
        .stream-artwork img {
            transition: none;
        }
    }
</style>
