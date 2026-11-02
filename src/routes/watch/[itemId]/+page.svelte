<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { afterNavigate, goto } from '$app/navigation';
    import { browser } from '$app/environment';
    import { base } from '$app/paths';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import { apiUrl } from '$lib/shared/api-urls';
    import { onMount, onDestroy, untrack } from 'svelte';
    import { VideoPlayer, playerStore } from '$lib/components/player';
    import SimpleZapOverlay from '$lib/components/livetv/simple/SimpleZapOverlay.svelte';
    import { isVolumeCurve } from '$lib/components/player/volume-control';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import type { PageData } from './$types';
    import {
        saveReturnPathFromReferrer,
        getReturnPath,
        clearReturnPath,
    } from '$lib/stores/playerNavigation';
    import { deriveIsAdmin } from '$lib/utils/permissions';
    import { isEpisode, isMovie, isNonEntertainment } from '$lib/shared/media-types';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import { toasts } from '$lib/stores/toast.store';
    import WatchShell from '$lib/components/viewing/WatchShell.svelte';
    import SeriesFinishedCard from '$lib/components/player/SeriesFinishedCard.svelte';
    import WatchMarkerHint from '$lib/components/player/WatchMarkerHint.svelte';
    import {
        PauseTracker,
        decideRecheck,
        episodeCode,
        installMarkerRecheck,
        resolveMovieRecheck,
        resolveRecheck,
        shouldRecheckOnRebuild,
        shouldRecheckOnResume,
        shouldRunMountRecheck,
        shouldRunMovieMountRecheck,
        type RecheckContext,
        type RecheckDecision,
        type RecheckTrigger,
    } from '$lib/components/player/marker-recheck';
    import type { SeriesWatchMarker } from '$lib/schemas/api-series-responses';
    import { ResumeHandoffResponseSchema } from '$lib/schemas/resume-handoff';
    import {
        HANDOFF_AGE_PARAM,
        HANDOFF_CHAIN_PARAM,
        HANDOFF_REMOUNT_PARAM,
        HANDOFF_MIN_PAUSE_MS,
        HANDOFF_SHOW_AGE_AFTER_MS,
        HandoffThrottle,
        declineHandoffChain,
        installHandoffTriggers,
        isHandoffChainDeclined,
        resolveHandoff,
        shouldCheckHandoff,
        type HandoffContext,
        type HandoffDecision,
        type HandoffTrigger,
    } from '$lib/components/player/resume-handoff';
    import {
        entryFromLanding,
        isLinearEntry,
        readWatchEntry,
        setWatchEntry,
    } from '$lib/stores/watch-entry';
    import { getDeviceId } from '$lib/components/player';
    import { formatRelativeTime } from '$lib/utils/time-formatting';
    import type { WatchStateResponse } from '$lib/schemas/api-playback-responses';
    import { formatTime } from '$lib/components/player/player-utils';
    import {
        carriedIntent,
        intentFromLanding,
        isHintDismissed,
        markHintDismissed,
        readWatchIntent,
        setWatchIntent,
    } from '$lib/stores/watch-intent';
    import {
        isRestoredArrival,
        landingHoldsPlayback,
        landingStartSeconds,
        readWatchLanding,
        stripWatchLandingParams,
        type WatchLanding,
    } from './landing-params';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    // Derive admin status from layout adminGroups + user groups
    let isAdmin = $derived(deriveIsAdmin($page.data));

    // User avatar URL — use the authenticated user UUID.
    // Guard against empty string: getAvatarUrl('') would produce `/api/image/user//avatar`
    // which 400s at the route handler and shows a broken-image glyph.
    let avatarUrl = $derived(data.userId ? getAvatarUrl(data.userId) : null);

    // Get fileId from URL if present
    let fileId = $derived($page.url.searchParams.get('fileId') || undefined);

    // Remount nonce of a same-item resume handoff (resume-handoff.ts). Read from
    // $page.url, which keeps it after the address bar is stripped.
    let handoffRemountKey = $derived($page.url.searchParams.get(HANDOFF_REMOUNT_PARAM) ?? '');

    // Start time in SECONDS for a freshly mounted player: `?t=` (e.g. preview
    // handoff ?t=270), else a series re-check's `resolved=seek&seekMs=`.
    let initialStartTime = $derived(landingStartSeconds($page.url.searchParams));

    // A finished-series landing and a marker jump away from a paused player
    // must not start playing on their own.
    let holdPlayback = $derived(landingHoldsPlayback($page.url.searchParams));

    // Series of the episode on screen — the scope of the continue intent.
    let seriesId = $derived(
        data.playbackInfo && isEpisode(data.playbackInfo.mediaType)
            ? (data.playbackInfo.seriesId ?? null)
            : null,
    );

    // The movie on screen — the scope of the movie position re-check.
    let movieId = $derived(
        data.playbackInfo && isMovie(data.playbackInfo.mediaType) ? data.playbackInfo.itemId : null,
    );

    // Get playlist context from URL if present
    let playlistId = $derived($page.url.searchParams.get('playlist'));
    let playlistPosition = $derived($page.url.searchParams.get('position'));
    let playlistContext = $derived.by(() => {
        if (!playlistId || !playlistPosition) return undefined;
        const parsedId = parseInt(playlistId, 10);
        const parsedPos = parseInt(playlistPosition, 10);
        if (isNaN(parsedId) || isNaN(parsedPos)) return undefined;
        return { playlistId: parsedId, position: parsedPos };
    });

    // Finished-series card (resolved=finished landing, or a re-check). `season`
    // is the season the viewer finished, null when unknown (season-less copy).
    let finishedCard = $state<{ season: number | null; device: string | null } | null>(null);
    let finishedTitle = $derived.by(() => {
        if (!finishedCard) return '';
        const { season, device } = finishedCard;
        if (season === null) {
            return device
                ? m.watch_marker_finished_series_title({ device })
                : m.watch_marker_finished_series_title_plain();
        }
        return device
            ? m.watch_marker_finished_title({ season, device })
            : m.watch_marker_finished_title_plain({ season });
    });
    // "Next season" = the sequential next episode, when it opens a later season.
    let nextSeasonEpisodeId = $derived.by(() => {
        const next = data.playbackInfo?.nextEpisode;
        const season = finishedCard?.season ?? null;
        if (season === null || !next || next.seasonNumber === undefined) return null;
        return next.seasonNumber > season ? next.itemId : null;
    });
    // "Rewatch from start" = the first episode of the lowest main-line season;
    // resolved while the card is up, the button stays hidden until it is known.
    let rewatchEpisodeId = $state<string | null>(null);

    // Set by navigateToNextItem: the next landing is an autoplay continuation,
    // which keeps the tab's watch intent. A same-route goto reuses this
    // component, so onMount's `continuePlayback` read does not see it.
    let autoplayPending = false;
    let hasLanded = false;

    function navigationEntryType(): string | undefined {
        try {
            const entry = performance.getEntriesByType('navigation')[0];
            return entry && 'type' in entry ? String(entry.type) : undefined;
        } catch {
            return undefined;
        }
    }

    function landingPositionSeconds(): number {
        return (data.playbackInfo?.userData?.playbackPositionTicks ?? 0) / 10_000_000;
    }

    function undoMarkerJump(fromEpisodeId: string, fromPositionMs: number | null): void {
        if (landingChainId) declineHandoffChain(landingChainId);
        setWatchIntent({ kind: 'episode' });
        const t = fromPositionMs ? Math.floor(fromPositionMs / 1000) : 0;
        const url = t > 0 ? `/watch/${fromEpisodeId}?t=${t}` : `/watch/${fromEpisodeId}`;
        goto(resolve(url), { replaceState: true });
    }

    /** Exactly one notice per landing: a toast, the finished card, or nothing. */
    function showLandingNotice(landing: WatchLanding): void {
        const device = (name: string | null): string => name ?? m.watch_marker_other_device();
        switch (landing.kind) {
            case 'info':
                toasts.info(landing.message, 6000);
                break;
            case 'continued': {
                const { fromEpisodeId, fromPositionMs, fromCode } = landing;
                toasts.info(
                    withHandoffAge(
                        m.watch_marker_continued({
                            episode: landing.markerCode ?? '',
                            time: formatTime(
                                landing.seekMs !== null
                                    ? landing.seekMs / 1000
                                    : landingPositionSeconds(),
                            ),
                            device: device(landing.device),
                        }),
                        landingAgeMs,
                    ),
                    {
                        timeout: 10_000,
                        action: {
                            label: fromCode
                                ? m.watch_marker_back_to({ episode: fromCode })
                                : m.back(),
                            onClick: () => undoMarkerJump(fromEpisodeId, fromPositionMs),
                        },
                    },
                );
                break;
            }
            case 'resumed': {
                const text = withHandoffAge(
                    m.watch_marker_resumed({
                        time: formatTime(landing.seekMs / 1000),
                        device: device(landing.device),
                    }),
                    landingAgeMs,
                );
                const back = landing.fromPositionMs;
                const itemId = data.playbackInfo?.itemId;
                // A resume handoff in place: Undo goes back to the old spot.
                if (back !== null && itemId) {
                    toasts.info(text, {
                        timeout: 10_000,
                        action: {
                            label: m.watch_handoff_undo(),
                            onClick: () => undoMarkerJump(itemId, back),
                        },
                    });
                } else {
                    toasts.info(text, 5000);
                }
                break;
            }
            case 'finished':
                openFinishedCard({
                    season: data.playbackInfo?.seasonNumber ?? null,
                    device: landing.device,
                });
                break;
            case 'none':
                break;
        }
    }

    // Every landing: settle the tab's watch intent, show the landing's notice,
    // then (M10) drop the one-shot landing params (`resolved`, `info`, `from`,
    // …) from the address bar so a copied URL names only the episode.
    // afterNavigate (not onMount) because a same-route navigation — autoplay,
    // a marker jump — reuses this component. The raw history call matches the
    // slug rewrite below: it leaves `$page.url` untouched, so the values read
    // above stay available, and it runs no load.
    afterNavigate((navigation) => {
        const url = navigation.to?.url ?? new URL(window.location.href);
        const autoplay = autoplayPending || (!hasLanded && isContinuation);
        if (autoplayPending) {
            autoplayPending = false;
            try {
                sessionStorage.removeItem('continuePlayback');
            } catch {
                /* best-effort: the flag is only a continuation hint */
            }
        }
        hasLanded = true;

        const restored = isRestoredArrival(navigation.type, navigationEntryType());
        const intent = intentFromLanding(
            url.searchParams,
            seriesId,
            carriedIntent(readWatchIntent(), { autoplay, restored }),
        );
        setWatchIntent(intent);
        setWatchEntry(entryFromLanding(url.searchParams, { autoplay, restored }, readWatchEntry()));
        lastActionAt = Date.now();
        handoffPausedAt = null;

        finishedCard = null;
        markerHint = null;
        pauseTracker.reset();
        landingAgeMs = Number(url.searchParams.get(HANDOFF_AGE_PARAM)) || 0;
        landingChainId = url.searchParams.get(HANDOFF_CHAIN_PARAM);
        showLandingNotice(readWatchLanding(url.searchParams));

        const stripped = stripWatchLandingParams(new URL(window.location.href));
        if (stripped) window.history.replaceState(window.history.state, '', stripped.toString());

        // A reloaded / history-restored continue-mode tab re-checks once, before
        // its own session exists. Never for autoplay (Safari gesture chain) and
        // never for a landing the server just resolved.
        if (
            !watchTogether.isInWatchParty &&
            (shouldRunMountRecheck({ restored, params: url.searchParams, autoplay, intent }) ||
                shouldRunMovieMountRecheck({ restored, autoplay, movieId }))
        ) {
            void runMarkerRecheck('mount');
        }
    });

    // ---- Series watch-marker re-check (long return, reload) ----

    // Episode-mode hint: the marker is further on, the player stays put.
    let markerHint = $state<SeriesWatchMarker | null>(null);
    let markerHintMessage = $derived.by(() => {
        const ep = markerHint?.episode;
        if (!markerHint || !ep) return '';
        return m.watch_marker_hint({
            episode: episodeCode(ep.seasonNumber, ep.episodeNumber),
            time: formatTime(markerHint.positionMs / 1000),
        });
    });
    // The finished card from a re-check shows once per episode in this tab.
    let finishedShownFor: string | null = null;
    let recheckInFlight = false;
    // Pauses of this player: a play after a long pause re-checks (see marker-recheck).
    const pauseTracker = new PauseTracker();

    // Read live: the page component (and so this context) outlives each episode.
    const recheckCtx: RecheckContext = {
        intent: () => readWatchIntent(),
        get episodeId() {
            return data.playbackInfo?.itemId ?? '';
        },
        get episodeCode() {
            const info = data.playbackInfo;
            return info?.seasonNumber !== undefined && info.episodeNumber !== undefined
                ? episodeCode(info.seasonNumber, info.episodeNumber)
                : null;
        },
        get seriesId() {
            return seriesId;
        },
        get movieId() {
            return movieId;
        },
        get seriesTitle() {
            return data.playbackInfo?.seriesName ?? null;
        },
        // The reporter's live session: a paused player's keepalive keeps it fresh
        // forever, so the server must exclude it or the marker finds this tab.
        sessionId: () =>
            playerStore.reportedSessionId() ??
            playerStore.playSessionId ??
            data.playbackInfo?.playSessionId ??
            null,
        positionMs: () =>
            playerStore.playheadTime > 0
                ? playerStore.playheadTime * 1000
                : landingPositionSeconds() * 1000,
        isPlaying: () => playerStore.isPlaying,
        watchPartyActive: () => watchTogether.isInWatchParty,
    };

    async function fetchWatchMarker(path: string): Promise<SeriesWatchMarker | null> {
        const res = await fetch(apiUrl('internal', path));
        if (!res.ok) return null;
        return (await res.json()) as SeriesWatchMarker;
    }

    async function fetchMovieState(
        path: string,
    ): Promise<Pick<WatchStateResponse, 'positionMs' | 'watched'> | null> {
        const res = await fetch(apiUrl('internal', path));
        if (!res.ok) return null;
        return (await res.json()) as WatchStateResponse;
    }

    // ---- Resume handoff (fast path in front of the marker re-check) ----
    // The tab's last own action (landing, play, pause; seeks live in playerStore).
    let lastActionAt = Date.now();
    // When the player last paused, for the play-press trigger (≥ HANDOFF_MIN_PAUSE_MS).
    let handoffPausedAt: number | null = null;
    const handoffThrottle = new HandoffThrottle();
    // A full re-check that arrived while another one ran; runs right after it.
    let pendingRecheck: RecheckTrigger | null = null;
    // A Play press that arrived while a check ran (its pre-press action time);
    // asks the handoff right after it.
    let pendingHandoffResumeSince: number | null = null;

    // Age of the handoff a jump landed with (`age` param); named in the toast.
    let landingAgeMs = 0;
    // The chain a handoff jump followed (`hchain`); its Back declines it.
    let landingChainId: string | null = null;

    /** "… · 2d ago" for a handoff at least HANDOFF_SHOW_AGE_AFTER_MS old. */
    function withHandoffAge(text: string, ageMs: number): string {
        if (ageMs < HANDOFF_SHOW_AGE_AFTER_MS) return text;
        return `${text} · ${formatRelativeTime(new Date(Date.now() - ageMs))}`;
    }

    const handoffCtx: HandoffContext = {
        mediaId: () =>
            seriesId !== null || movieId !== null ? recheckCtx.episodeId || null : null,
        deviceId: () => getDeviceId(),
        positionMs: () => recheckCtx.positionMs(),
        isPlaying: () => playerStore.isPlaying,
        watchPartyActive: () => watchTogether.isInWatchParty,
        isLinear: () => isLinearEntry(readWatchEntry()),
        lastActionAt: () => Math.max(lastActionAt, playerStore.lastUserSeekAt),
        isDeclined: (chainId) => isHandoffChainDeclined(chainId),
        entry: () => readWatchEntry(),
        seriesTitle: () => recheckCtx.seriesTitle,
        episodeCode: () => recheckCtx.episodeCode,
    };

    async function fetchHandoff(path: string) {
        // A hung request must not hold the re-check lock.
        const res = await fetch(apiUrl('internal', path), { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return undefined;
        const parsed = ResumeHandoffResponseSchema.safeParse(await res.json());
        return parsed.success ? parsed.data.handoff : undefined;
    }

    /**
     * Ask and apply the handoff; true when it moved the player. `lastActionAt`
     * overrides the tab's last action for a queued Play press.
     */
    async function tryHandoff(trigger: HandoffTrigger, lastActionAt?: number): Promise<boolean> {
        const ctx: HandoffContext =
            lastActionAt === undefined
                ? handoffCtx
                : { ...handoffCtx, lastActionAt: () => lastActionAt };
        // Only a request that will really be sent uses up the throttle slot.
        if (!shouldCheckHandoff(ctx, trigger)) return false;
        if (!handoffThrottle.allow(trigger, Date.now())) return false;
        return applyHandoff(await resolveHandoff(ctx, fetchHandoff, trigger));
    }

    function applyHandoff(decision: HandoffDecision): boolean {
        switch (decision.kind) {
            case 'jump':
                goto(resolve(decision.url), { replaceState: true });
                return true;
            case 'seek': {
                if (!playerStore.seekExternally(decision.positionMs / 1000)) return false;
                const back = decision.fromPositionMs / 1000;
                const chainId = decision.chainId;
                toasts.info(
                    withHandoffAge(
                        m.watch_marker_resumed({
                            time: formatTime(decision.positionMs / 1000),
                            device: decision.deviceName ?? m.watch_marker_other_device(),
                        }),
                        decision.ageMs,
                    ),
                    {
                        timeout: 10_000,
                        action: {
                            label: m.watch_handoff_undo(),
                            onClick: () => {
                                // Back to the old spot: this tab never follows that chain again.
                                declineHandoffChain(chainId);
                                playerStore.seekExternally(back);
                            },
                        },
                    },
                );
                return true;
            }
            case 'stay':
                return false;
        }
    }

    /**
     * `handoffOnly`: a short return or pause, below the marker re-check's
     * 10-minute gate; only the handoff may run. One lock for both paths, so
     * they never both move the player; a full re-check that arrives while
     * another runs is queued, and dropped when the handoff moved.
     */
    async function runMarkerRecheck(
        trigger: RecheckTrigger,
        opts: { handoffOnly?: boolean; lastActionAt?: number } = {},
    ): Promise<void> {
        if (recheckInFlight) {
            if (!opts.handoffOnly) pendingRecheck = trigger;
            // A Play press while a return check is in flight: that answer will be
            // dropped (the tab is playing now), so the press asks again after it.
            // Captured now, before the press is recorded as the tab's newest action.
            else if (trigger === 'resume') pendingHandoffResumeSince = handoffCtx.lastActionAt();
            return;
        }
        recheckInFlight = true;
        let moved = false;
        try {
            if (trigger === 'return' || trigger === 'resume') {
                moved = await tryHandoff(trigger, opts.lastActionAt);
            }
            if (moved || opts.handoffOnly) return;
            if (recheckCtx.seriesId) {
                applyRecheck(await resolveRecheck(recheckCtx, fetchWatchMarker, trigger));
            } else if (recheckCtx.movieId) {
                applyMovieRecheck(await resolveMovieRecheck(recheckCtx, fetchMovieState, trigger));
            }
        } finally {
            recheckInFlight = false;
            const next = pendingRecheck;
            const handoffResumeSince = pendingHandoffResumeSince;
            pendingRecheck = null;
            pendingHandoffResumeSince = null;
            if (!moved && next) void runMarkerRecheck(next);
            else if (!moved && handoffResumeSince !== null) {
                void runMarkerRecheck('resume', {
                    handoffOnly: true,
                    lastActionAt: handoffResumeSince,
                });
            }
        }
    }

    /** A movie only ever seeks forward in place; its toast names no device. */
    function applyMovieRecheck(decision: RecheckDecision): void {
        if (decision.kind !== 'seek') return;
        if (playerStore.seekExternally(decision.positionMs / 1000)) {
            toasts.info(
                m.watch_marker_resumed_plain({ time: formatTime(decision.positionMs / 1000) }),
                5000,
            );
        }
    }

    function applyRecheck(decision: RecheckDecision): void {
        const episodeId = recheckCtx.episodeId;
        switch (decision.kind) {
            case 'jump':
                goto(resolve(decision.url), { replaceState: true });
                break;
            case 'seek':
                if (playerStore.seekExternally(decision.positionMs / 1000)) {
                    toasts.info(
                        m.watch_marker_resumed({
                            time: formatTime(decision.positionMs / 1000),
                            device: decision.deviceName ?? m.watch_marker_other_device(),
                        }),
                        5000,
                    );
                }
                break;
            case 'finished': {
                if (finishedShownFor === episodeId) break;
                finishedShownFor = episodeId;
                openFinishedCard({
                    season:
                        decision.marker.episode?.seasonNumber ??
                        data.playbackInfo?.seasonNumber ??
                        null,
                    device: decision.marker.deviceName,
                });
                break;
            }
            case 'hint':
                // Once per (tab, episode): showing it counts, not only a dismissal.
                if (!isHintDismissed(episodeId)) {
                    markerHint = decision.marker;
                    markHintDismissed(episodeId);
                }
                break;
            case 'stay':
                break;
        }
    }

    function followMarkerHint(): void {
        const marker = markerHint;
        markerHint = null;
        const id = seriesId;
        if (!marker || !id) return;
        const intent = { kind: 'continue', seriesId: id } as const;
        setWatchIntent(intent);
        applyRecheck(decideRecheck({ ...recheckCtx, intent: () => intent }, marker));
    }

    function dismissMarkerHint(): void {
        markHintDismissed(recheckCtx.episodeId);
        markerHint = null;
    }

    onMount(() => {
        const uninstallReturn = installMarkerRecheck(
            recheckCtx,
            () => {
                pauseTracker.markChecked(Date.now());
                void runMarkerRecheck('return');
            },
            { doc: document, win: window, now: () => Date.now() },
        );
        // Every return after a short absence: only the handoff (the 10-minute
        // marker re-check above has its own, longer trigger).
        const uninstallHandoff = installHandoffTriggers(
            () => void runMarkerRecheck('return', { handoffOnly: true }),
            { doc: document, win: window, now: () => Date.now() },
        );
        // The server lost this player's session (reaped / expired) and the
        // reporter rebuilt it: a paused player re-checks like a long return.
        const unsubscribeRebuild = playerStore.onSessionRebuilt(() => {
            if (shouldRecheckOnRebuild(recheckCtx)) void runMarkerRecheck('rebuild');
        });
        return () => {
            uninstallReturn();
            uninstallHandoff();
            unsubscribeRebuild();
        };
    });

    // Play after a long pause in a tab that stayed visible (no return event).
    $effect(() => {
        const playing = playerStore.isPlaying;
        untrack(() => {
            const now = Date.now();
            const longPause =
                pauseTracker.update(playing, now) && shouldRecheckOnResume(recheckCtx);
            const pausedFor = handoffPausedAt === null ? 0 : now - handoffPausedAt;
            handoffPausedAt = playing ? null : now;
            if (longPause) {
                void runMarkerRecheck('resume');
            } else if (playing && pausedFor >= HANDOFF_MIN_PAUSE_MS) {
                void runMarkerRecheck('resume', { handoffOnly: true });
            }
            // After the check started: it captured the previous action time,
            // so this press does not count as "the tab acted later".
            lastActionAt = now;
        });
    });

    // Guards against a stale rewatch lookup landing on a later card.
    let finishedCardToken = 0;

    /** Show the finished card and resolve its rewatch target alongside. */
    function openFinishedCard(card: { season: number | null; device: string | null }): void {
        finishedCard = card;
        rewatchEpisodeId = null;
        const token = ++finishedCardToken;
        const id = seriesId;
        if (!id) return;
        void findRewatchEpisodeId(id).then((episodeId) => {
            if (token === finishedCardToken) rewatchEpisodeId = episodeId;
        });
    }

    /** First episode of the lowest main-line (> 0) season, or null. */
    async function findRewatchEpisodeId(id: string): Promise<string | null> {
        try {
            const seasonsRes = await fetch(apiUrl('internal', `/series/${id}/seasons`));
            if (!seasonsRes.ok) return null;
            const season = lowestMainlineSeason(await seasonsRes.json());
            if (season === null) return null;
            const res = await fetch(apiUrl('internal', `/series/${id}/episodes?season=${season}`));
            if (!res.ok) return null;
            return firstEpisodeId(await res.json());
        } catch {
            /* offline: no rewatch button */
            return null;
        }
    }

    function lowestMainlineSeason(body: unknown): number | null {
        if (!body || typeof body !== 'object' || !('items' in body)) return null;
        const items = (body as { items: unknown }).items;
        if (!Array.isArray(items)) return null;
        let lowest: number | null = null;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const { seasonNumber, episodeCount } = item as {
                seasonNumber?: unknown;
                episodeCount?: unknown;
            };
            if (typeof seasonNumber !== 'number' || seasonNumber <= 0) continue;
            if (typeof episodeCount === 'number' && episodeCount <= 0) continue;
            if (lowest === null || seasonNumber < lowest) lowest = seasonNumber;
        }
        return lowest;
    }

    function rewatchFromStart(): void {
        const first = rewatchEpisodeId;
        if (!first) return;
        finishedCard = null;
        setWatchIntent({ kind: 'episode' });
        if (first === data.playbackInfo?.itemId) {
            playerStore.seekExternally(0);
            return;
        }
        goto(resolve(`/watch/${first}`), { replaceState: true });
    }

    function firstEpisodeId(body: unknown): string | null {
        if (!body || typeof body !== 'object' || !('items' in body)) return null;
        const items = (body as { items: unknown }).items;
        if (!Array.isArray(items)) return null;
        let best: { id: string; episodeNumber: number } | null = null;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const { id, episodeNumber } = item as { id?: unknown; episodeNumber?: unknown };
            if (typeof id !== 'string') continue;
            const n = typeof episodeNumber === 'number' ? episodeNumber : Number.MAX_SAFE_INTEGER;
            if (!best || n < best.episodeNumber) best = { id, episodeNumber: n };
        }
        return best?.id ?? null;
    }

    function goToNextSeason(): void {
        const next = nextSeasonEpisodeId;
        if (!next) return;
        finishedCard = null;
        goto(resolve(`/watch/${next}`), { replaceState: true });
    }

    // Get volume curve from config (with type guard for safety)
    let volumeCurve = $derived.by(() => {
        const configValue = $page.data.player?.volumeCurve;
        return isVolumeCurve(configValue) ? configValue : 'linear';
    });

    // Track if we should show fullscreen restore prompt
    let showFullscreenPrompt = $state(false);

    // Persistent wrapper — survives VideoPlayer remounts so we can transfer native fullscreen to it
    let watchPageEl = $state<HTMLElement | null>(null);

    // Track if this is a continuation (next episode)
    let isContinuation = $state(false);

    onMount(() => {
        // Silently add the human-readable slug to the address bar without a
        // redirect round-trip. Only fires when the slug is absent (e.g. direct
        // UUID navigation from Continue Watching).
        if (browser && data.canonicalSlug) {
            const current = new URL(window.location.href);
            if (!current.searchParams.has('slug')) {
                current.searchParams.set('slug', data.canonicalSlug);
                // Keep SvelteKit's history indexes: clearing them makes a
                // Forward return change the URL without restoring the player.
                window.history.replaceState(window.history.state, '', current.toString());
            }
        }

        // Check for fullscreen restoration flag from previous navigation
        if (browser && sessionStorage.getItem('restoreFullscreen') === 'true') {
            sessionStorage.removeItem('restoreFullscreen');
            // Show prompt to restore fullscreen (requires user gesture)
            showFullscreenPrompt = true;
            // Auto-hide after 15 seconds
            setTimeout(() => {
                showFullscreenPrompt = false;
            }, 15000);
        }

        // Check if this is a continuation (next episode auto-play)
        if (browser && sessionStorage.getItem('continuePlayback') === 'true') {
            sessionStorage.removeItem('continuePlayback');
            isContinuation = true;
            console.log('[Watch] Continuation playback detected');
        }

        // Try to capture referrer as return path for full page navigations
        // (direct URL entry, bookmarks, external links)
        // For SvelteKit client-side navigation, saveReturnPath is called before goto
        if (browser) saveReturnPathFromReferrer(document.referrer);
    });

    // Leave watch party when navigating away (guests only, and only when not navigating within session)
    onDestroy(() => {
        if (!browser) return;

        const inParty = watchTogether.isInWatchParty;
        const isHost = watchTogether.isWatchPartyHost;
        const navigatingWithinSession = watchTogether.isNavigatingWithinSession();

        // Guests should leave when navigating away from the video page
        // But NOT when navigating within the session (e.g., host changes video)
        if (inParty && !isHost && !navigatingWithinSession) {
            console.log('[Watch] Guest leaving page, leaving watch party');
            watchTogether.leaveSession();
        }
    });

    function restoreFullscreen() {
        const container = document.querySelector('.watch-page');
        if (container) {
            container.requestFullscreen?.().catch(() => {
                /* Fullscreen may be blocked by browser - user can retry manually */
            });
        }
        showFullscreenPrompt = false;
    }

    // Update URL when version changes (without navigation)
    function handleVersionChange(event: CustomEvent<string> | string) {
        if (browser) {
            const newSourceId = typeof event === 'string' ? event : event.detail;
            const url = new URL(window.location.href);
            url.searchParams.set('fileId', newSourceId);
            window.history.replaceState(window.history.state, '', url.toString());
        }
    }

    function handleBack() {
        if (!browser) return;

        // Playlist playback returns to the playlist page
        if (playlistContext) {
            clearReturnPath();
            goto(resolve(`/playlists/${playlistContext.playlistId}`), { replaceState: true });
            return;
        }

        // Get return path (clears stored path to prevent reuse)
        const mediaType = data.playbackInfo?.mediaType;
        goto(resolve(getReturnPath(mediaType)), { replaceState: true });
    }

    function handleEnded() {
        // Non-entertainment media: keep player open, user uses back button
        const mediaType = data.playbackInfo?.mediaType;
        if (isNonEntertainment(mediaType)) {
            console.log('[Watch] Non-entertainment video ended, keeping player open');
            return;
        }

        // Entertainment: keep open if there's a next episode/playlist item.
        // Read from the LIVE playerStore, not `data.playbackInfo` — the latter
        // is frozen at the initial page load and never updated for an
        // audio-only in-place episode advance (advanceEpisodeInPlace in
        // player-controller.svelte.ts), which never re-runs load(). Using the
        // stale prop here would make `hasNextItem` true forever after even a
        // single in-place advance (it would keep pointing at the episode that
        // was already consumed), leaving a finished video and an open,
        // silent player once the chain genuinely runs out.
        const hasNextItem = !!playerStore.effectiveNextItem;

        if (hasNextItem) {
            console.log('[Watch] Video ended with next item available, keeping player open');
            return;
        }

        // In a watch party, don't auto-close on end. The host should keep control
        // (leave/disband via the back dialog, or search for something new to watch
        // together); guests must wait for the host rather than being silently
        // ejected at their own video's end (which would tear down the session as
        // handleBack → onDestroy → leaveSession).
        if (watchTogether.isInWatchParty) {
            console.log('[Watch] Video ended in a watch party, keeping player open');
            return;
        }

        // No next item available, close the player
        handleBack();
    }

    function handleError(event: CustomEvent<{ message: string }> | { message: string }) {
        const message = 'detail' in event ? event.detail.message : event.message;
        console.error('Playback error:', message);
    }

    function handleNextEpisode(event: CustomEvent<{ itemId: string }> | { itemId: string }) {
        const detail = 'detail' in event ? event.detail : event;
        console.log('[Watch] handleNextEpisode called', detail);
        const { itemId } = detail;
        const url = `/watch/${itemId}`;
        console.log('[Watch] Navigating to', url);
        navigateToNextItem(url);
    }

    function handleNextPlaylistItem(
        event:
            | CustomEvent<{
                  itemId: string;
                  playlistId: number;
                  position: number;
              }>
            | {
                  itemId: string;
                  playlistId: number;
                  position: number;
              },
    ) {
        const detail = 'detail' in event ? event.detail : event;
        console.log('[Watch] handleNextPlaylistItem called', detail);
        const { itemId, playlistId, position } = detail;
        const url = `/watch/${itemId}?playlist=${playlistId}&position=${position}`;
        console.log('[Watch] Navigating to playlist item', url);
        navigateToNextItem(url);
    }

    function navigateToNextItem(url: string) {
        if (browser) {
            if (
                document.fullscreenElement &&
                watchPageEl &&
                document.fullscreenElement !== watchPageEl
            ) {
                // Transfer native fullscreen from .player-container (which gets destroyed on remount)
                // to .watch-page (which persists across the {#key} change).
                // If the transfer fails, fall back to the restore-prompt approach.
                watchPageEl.requestFullscreen?.().catch(() => {
                    sessionStorage.setItem('restoreFullscreen', 'true');
                });
            }

            // Mark that we're continuing playback (next episode) so autoplay is expected
            sessionStorage.setItem('continuePlayback', 'true');
            // Autoplay keeps the tab's watch intent (continue stays continue).
            autoplayPending = true;

            // Use SvelteKit's goto() for client-side navigation
            // This preserves the user gesture chain, allowing autoplay to work in Safari
            // The onDestroy cleanup in VideoPlayer handles all state properly
            // replaceState: true keeps the history stack clean — back exits the player entirely
            goto(resolve(url), { replaceState: true });
        }
    }
</script>

<svelte:head>
    <title>{data.pageTitle} - Watch</title>
    <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="watch-page" bind:this={watchPageEl}>
    {#if data.playbackInfo}
        <!-- Key block forces the player to fully remount when itemId changes -->
        <!-- This ensures clean state when navigating between episodes/lessons with goto() -->
        <!-- A same-item resume handoff (`hn`) remounts too: a fresh player and play session. -->
        {#key `${data.playbackInfo.itemId}:${handoffRemountKey}`}
            {#if data.viewingContext?.kind === 'educational' && data.educationalShell}
                {@const EducationalShell = data.educationalShell}
                <!-- Educational shell: lesson-list rail + next/prev auto-advance -->
                <EducationalShell
                    playbackInfo={data.playbackInfo}
                    userId={data.userId ?? ''}
                    username={data.username}
                    avatarUrl={avatarUrl ?? undefined}
                    initialSourceId={fileId}
                    {initialStartTime}
                    autoPlay={!holdPlayback}
                    {isContinuation}
                    autoQualityEnabled={$page.data.features?.playerAutoQuality !== false}
                    defaultQualityMode={$page.data.player?.defaultQualityMode ?? 'original'}
                    hlsVodBufferSettings={$page.data.player?.hlsVodBufferSettings}
                    subtitleSizeMultiplier={$page.data.player?.subtitleSizeMultiplier ?? 1.2}
                    subtitlePgsScale={$page.data.player?.subtitlePgsScale ?? 55}
                    subtitleSrtScale={$page.data.player?.subtitleSrtScale ?? 140}
                    nextEpisodePromptLeadSeconds={$page.data.player?.nextEpisodePromptLeadSeconds ??
                        0}
                    {volumeCurve}
                    enableAirPlay={$page.data.features?.deviceAuth === true}
                    showAnnotations={false}
                    mediaDbId={data.mediaDbId ?? undefined}
                    onerror={handleError}
                    onversionchange={handleVersionChange}
                    viewingContext={data.viewingContext} />
            {:else if data.viewingContext?.kind === 'personal' && data.personalShell}
                {@const PersonalShell = data.personalShell}
                <!-- Personal/home-video shell: event-context strip + clip auto-advance -->
                <PersonalShell
                    playbackInfo={data.playbackInfo}
                    userId={data.userId ?? ''}
                    username={data.username}
                    avatarUrl={avatarUrl ?? undefined}
                    initialSourceId={fileId}
                    {initialStartTime}
                    autoPlay={!holdPlayback}
                    {isContinuation}
                    autoQualityEnabled={$page.data.features?.playerAutoQuality !== false}
                    defaultQualityMode={$page.data.player?.defaultQualityMode ?? 'original'}
                    hlsVodBufferSettings={$page.data.player?.hlsVodBufferSettings}
                    subtitleSizeMultiplier={$page.data.player?.subtitleSizeMultiplier ?? 1.2}
                    subtitlePgsScale={$page.data.player?.subtitlePgsScale ?? 55}
                    subtitleSrtScale={$page.data.player?.subtitleSrtScale ?? 140}
                    nextEpisodePromptLeadSeconds={$page.data.player?.nextEpisodePromptLeadSeconds ??
                        0}
                    {volumeCurve}
                    enableAirPlay={$page.data.features?.deviceAuth === true}
                    showAnnotations={false}
                    mediaDbId={data.mediaDbId ?? undefined}
                    onerror={handleError}
                    onversionchange={handleVersionChange}
                    viewingContext={data.viewingContext} />
            {:else}
                <!-- Default VOD shell (movies, TV episodes) — full-bleed immersive player -->
                <WatchShell
                    playbackInfo={data.playbackInfo}
                    userId={data.userId ?? ''}
                    username={data.username}
                    avatarUrl={avatarUrl ?? undefined}
                    initialSourceId={fileId}
                    {initialStartTime}
                    autoPlay={!holdPlayback}
                    {isContinuation}
                    {playlistContext}
                    autoQualityEnabled={$page.data.features?.playerAutoQuality !== false}
                    defaultQualityMode={$page.data.player?.defaultQualityMode ?? 'original'}
                    hlsVodBufferSettings={$page.data.player?.hlsVodBufferSettings}
                    subtitleSizeMultiplier={$page.data.player?.subtitleSizeMultiplier ?? 1.2}
                    subtitlePgsScale={$page.data.player?.subtitlePgsScale ?? 55}
                    subtitleSrtScale={$page.data.player?.subtitleSrtScale ?? 140}
                    nextEpisodePromptLeadSeconds={$page.data.player?.nextEpisodePromptLeadSeconds ??
                        0}
                    {volumeCurve}
                    enableAirPlay={$page.data.features?.deviceAuth === true}
                    showAnnotations={$page.data.features?.mediaAnnotations === true &&
                        $page.data.user?.hasMediaAnnotationPermission === true &&
                        !!data.mediaDbId}
                    showChat={$page.data.features?.mediaChat === true}
                    annotationsMaxPins={$page.data.annotations?.maxPins ?? 3}
                    annotationsIsAdmin={isAdmin}
                    annotationsMediaTitle={data.pageTitle}
                    mediaDbId={data.mediaDbId ?? undefined}
                    onback={handleBack}
                    onended={handleEnded}
                    onerror={handleError}
                    onversionchange={handleVersionChange}
                    onnextepisode={handleNextEpisode}
                    onnextplaylistitem={handleNextPlaylistItem} />
            {/if}
        {/key}
        {#if data.playbackInfo.mediaType === 'tvchannel'}
            <!-- Live TV simple mode (renders nothing unless it is on); outside
                 the key block so it survives each channel's remount. -->
            <SimpleZapOverlay
                currentChannelId={data.playbackInfo.itemId}
                pageEl={watchPageEl}
                username={data.username} />
        {/if}
    {/if}

    {#if markerHint}
        <WatchMarkerHint
            message={markerHintMessage}
            ongo={followMarkerHint}
            ondismiss={dismissMarkerHint} />
    {/if}

    {#if finishedCard}
        <SeriesFinishedCard
            title={finishedTitle}
            showNextSeason={nextSeasonEpisodeId !== null}
            showRewatch={rewatchEpisodeId !== null}
            onnextseason={goToNextSeason}
            onrewatch={rewatchFromStart}
            onstay={() => (finishedCard = null)} />
    {/if}

    <!-- Fullscreen restore prompt -->
    {#if showFullscreenPrompt}
        <button class="fullscreen-prompt" onclick={restoreFullscreen}>
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round">
                <path
                    d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
            <span>{m.player_fullscreen()}</span>
        </button>
    {/if}
</div>

<style>
    .watch-page {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        /* Use dvh for dynamic viewport height on mobile (accounts for browser UI) */
        height: 100vh;
        height: 100dvh;
        background: #000;
        z-index: 9000;
    }

    /* Hide any page chrome when in watch mode */
    :global(body) {
        overflow: hidden;
    }

    /* Fullscreen restore prompt */
    .fullscreen-prompt {
        position: fixed;
        bottom: 6rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 100;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem 1.25rem;
        background: rgba(0, 0, 0, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 2rem;
        color: white;
        font-size: 0.9rem;
        cursor: pointer;
        backdrop-filter: blur(8px);
        animation: slideUp 0.3s ease;
        transition:
            background 0.2s,
            transform 0.2s;
    }

    .fullscreen-prompt:hover {
        background: rgba(255, 255, 255, 0.2);
        transform: translateX(-50%) scale(1.05);
    }

    .fullscreen-prompt svg {
        flex-shrink: 0;
    }

    @keyframes slideUp {
        from {
            opacity: 0;
            transform: translateX(-50%) translateY(1rem);
        }
        to {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }
    }
</style>
