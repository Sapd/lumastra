<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  /rate swipe trainer — full page assembly (rate-trainer plan, Task 5).

  Wires the presentational deck (Task 4) to the real API via a small
  `RateSessionDeps` adapter, owns the help/confirmation/milestone UI
  state that lives outside the store, and gates keyboard shortcuts on the
  store's busy flag + "not typing in an input" + "no modal open".
-->
<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { browser } from '$app/environment';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import * as aiApi from '$lib/api/ai';
    import { RateSession, type RateSessionDeps } from '$lib/stores/rate-session.svelte';
    import type { RatingCandidate } from '$lib/schemas/api-ai-responses';
    import type { SwipeDirection } from '$lib/actions/swipe-math';
    import SwipeDeck from '$lib/components/rate/SwipeDeck.svelte';
    import RateActionBar from '$lib/components/rate/RateActionBar.svelte';
    import MilestoneOverlay from '$lib/components/rate/MilestoneOverlay.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import { hasModals } from '$lib/stores/modal.store';
    import { openMediaModal, type MediaItem } from '$lib/utils/modal-utils';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { isSeries } from '$lib/shared/media-types';
    import { apiUrl } from '$lib/shared/api-urls.js';

    /** Milestone at which the For You rail unlocks (spec §4). */
    const RAIL_UNLOCK_MILESTONE = 5;
    /** Debounce window before a buffered batch of skips is flushed to the durable-skip beacon. */
    const SKIP_FLUSH_DELAY_MS = 2000;
    /** Matches the server's per-request cap (RateSkipBodySchema.mediaIds.max(100)) — both an
     *  immediate-flush trigger (buffer never grows past this) and a chunk size for flush paths,
     *  so a large accumulated buffer is sent as multiple ≤100 batches instead of one that 422s. */
    const SKIP_FLUSH_MAX = 100;

    /** Buffered internal UUIDs awaiting a durable-skip flush (module-level: survives re-renders). */
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain non-reactive buffer, never read in the template
    const pendingSkipIds = new Set<string>();
    let skipFlushTimer: ReturnType<typeof setTimeout> | undefined;

    /** Splits `ids` into chunks of at most `size` — keeps every outgoing batch within the
     *  server's per-request cap. */
    function chunkIds(ids: string[], size: number): string[][] {
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
        return chunks;
    }

    /** Best-effort POST of the buffered skip ids, chunked to ≤SKIP_FLUSH_MAX per request;
     *  swallows errors — never surfaces to the user. */
    function flushSkips(): void {
        if (skipFlushTimer !== undefined) {
            clearTimeout(skipFlushTimer);
            skipFlushTimer = undefined;
        }
        if (pendingSkipIds.size === 0) return;
        const ids = [...pendingSkipIds];
        pendingSkipIds.clear();
        for (const batch of chunkIds(ids, SKIP_FLUSH_MAX)) {
            void aiApi.skipRateItems(batch).catch(() => {
                // Best-effort: a failed durable-skip beacon must never surface to the user.
            });
        }
    }

    /** Synchronous best-effort flush for page-hide paths (visibilitychange/beforeunload), where
     *  an in-flight fetch may be cancelled — prefers sendBeacon, falls back to a keepalive fetch.
     *  Chunked to ≤SKIP_FLUSH_MAX per request, same as flushSkips. */
    function flushSkipsOnHide(): void {
        if (skipFlushTimer !== undefined) {
            clearTimeout(skipFlushTimer);
            skipFlushTimer = undefined;
        }
        if (pendingSkipIds.size === 0) return;
        const ids = [...pendingSkipIds];
        pendingSkipIds.clear();
        for (const batch of chunkIds(ids, SKIP_FLUSH_MAX)) {
            try {
                const sent = navigator.sendBeacon(
                    apiUrl('internal', '/rate/skip'),
                    new Blob([JSON.stringify({ mediaIds: batch })], { type: 'application/json' }),
                );
                if (sent) continue;
            } catch {
                // Fall through to the fetch fallback below.
            }
            void fetch(apiUrl('internal', '/rate/skip'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mediaIds: batch }),
                keepalive: true,
            }).catch(() => {
                // Best-effort: a failed durable-skip beacon must never surface to the user.
            });
        }
    }

    function handleVisibilityChange(): void {
        if (document.visibilityState === 'hidden') flushSkipsOnHide();
    }

    /** Buffers a skipped item's internal UUID and schedules a debounced flush; best-effort.
     *  If the buffer reaches the server's cap, flushes immediately instead of only arming
     *  the debounce timer, so `pendingSkipIds` can never grow past SKIP_FLUSH_MAX. */
    function recordSkip(item: RatingCandidate): void {
        const internalId = item.externalIds.internal;
        if (!internalId) return;
        pendingSkipIds.add(internalId);
        if (pendingSkipIds.size >= SKIP_FLUSH_MAX) {
            flushSkips();
            return;
        }
        if (skipFlushTimer !== undefined) clearTimeout(skipFlushTimer);
        skipFlushTimer = setTimeout(flushSkips, SKIP_FLUSH_DELAY_MS);
    }

    const deps: RateSessionDeps = {
        fetchQueue: async ({ filter, count, cursor }) => {
            const { data, error } = await aiApi.getRateQueue({ filter, count, cursor });
            if (error || !data) {
                throw new Error(m.ai_rate_load_error());
            }
            return { status: data.status, items: data.items, nextCursor: data.page.nextCursor };
        },
        submit: async (item, rating, ratingStyle) => {
            const { data, error } = await aiApi.submitRating(
                item.externalIds,
                item.mediaType,
                rating,
                'rate-trainer',
                { ratingStyle },
            );
            if (error || !data) return { ok: false };
            return {
                ok: true,
                totalRatings: data.totalRatings,
                milestone: data.milestone,
                profileStatus: data.profileStatus,
            };
        },
        clear: async (item) => {
            const { data, error } = await aiApi.clearRating(
                item.externalIds,
                item.mediaType,
                'rate-trainer',
            );
            if (error || !data) return { ok: false };
            return { ok: true, totalRatings: data.totalRatings };
        },
        recordSkip,
    };

    let session = $state<RateSession | undefined>(undefined);
    let railUnlockShown = $state(false);
    let confirmationElement: HTMLDivElement | undefined = $state();
    let mainElement: HTMLElement | undefined = $state();

    /** Bound to RateActionBar — suppresses global shortcuts while the star row is open. */
    let starsOpen = $state(false);
    /** Bound to SwipeDeck — lets keyboard/action-bar commits (which have no drag
     *  gesture of their own) trigger the same fly-off animation a swipe gets. */
    let deckRef: SwipeDeck | null = $state(null);

    let showDeck = $derived(
        !!session &&
            session.phase !== 'loading' &&
            session.phase !== 'error' &&
            !(session.phase === 'exhausted' && session.cards.length === 0),
    );

    onMount(() => {
        void (async () => {
            const stats = await aiApi.getUserStats();
            if (stats.error) {
                // Non-fatal: the trainer still works with a 0 lifetime-count
                // fallback, but silently swallowing this hides a real backend
                // problem from the user — surface it once and keep going.
                console.error('[RateTrainer] failed to load user stats:', stats.error);
                toasts.error(m.stats_error_load_failed());
            }
            const initialTotal = stats.data?.stats?.totalRatings ?? 0;
            session = new RateSession(deps, initialTotal);
            await session.start();
        })();

        if (!browser) return;
        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('beforeunload', flushSkipsOnHide);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('beforeunload', flushSkipsOnHide);
            flushSkipsOnHide();
        };
    });

    function submitRate(rating: number, style: 'quick' | 'stars'): void {
        if (!session) return;
        const active = session;
        let focusMoved = false;
        const trackFocus = (): void => {
            focusMoved = true;
        };
        document.addEventListener('focusin', trackFocus);
        void active.rate(rating, style).then(async () => {
            try {
                if (active.lastError) {
                    toasts.error(m.ai_rate_save_failed());
                    active.dismissError();
                    return;
                }
                await tick();
                // Reveal feedback on short screens unless the user started another activity.
                if (!focusMoved && active.undoable) {
                    confirmationElement?.scrollIntoView?.({
                        block: 'nearest',
                        behavior: 'instant',
                    });
                }
            } finally {
                document.removeEventListener('focusin', trackFocus);
            }
        });
    }

    /** SwipeDeck's onrate — swipe gestures are always the semantic quick vocabulary. */
    function handleDeckRate(rating: number): void {
        submitRate(rating, 'quick');
    }

    /** The quick ratings that map onto one of the deck's four swipe directions —
     *  everything else (Meh, star-row ratings) has no directional analog and
     *  keeps submitting straight through, with no fly-off animation to trigger. */
    const QUICK_RATING_DIRECTION: Partial<Record<number, SwipeDirection>> = {
        2: 'left',
        8: 'right',
        10: 'up',
    };

    /** RateActionBar's onrate — quick buttons or the stars row, style comes from the caller.
     *  Directional quick ratings are routed through the deck so they play the same
     *  fly-off animation a drag commit gets; the deck's own onrate prop (handleDeckRate)
     *  ends up calling straight back into submitRate with the same args either way. */
    function handleBarRate(rating: number, style: 'quick' | 'stars'): void {
        const direction = style === 'quick' ? QUICK_RATING_DIRECTION[rating] : undefined;
        if (direction && deckRef) {
            deckRef.commit(direction);
            return;
        }
        submitRate(rating, style);
    }

    function handleSkip(): void {
        if (!session) return;
        session.skip();
    }

    /** Requests a skip from a non-gesture source (action bar button, keyboard) —
     *  routed through the deck so it plays the same fly-off animation a downward
     *  drag commit gets. Falls back to the direct skip if the deck isn't mounted
     *  yet (defensive: showDeck gates both, so this should be rare/never). */
    function requestSkip(): void {
        if (deckRef) {
            deckRef.commit('down');
            return;
        }
        handleSkip();
    }

    /** Requests a directional quick rating from a non-gesture source (keyboard) —
     *  see requestSkip for the fallback rationale. */
    function requestDirectionalRate(direction: SwipeDirection, rating: number): void {
        if (deckRef) {
            deckRef.commit(direction);
            return;
        }
        submitRate(rating, 'quick');
    }

    function handleUndo(event?: MouseEvent): void {
        if (!session || session.busy || !session.undoable) return;
        const active = session;
        const trigger =
            event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : undefined;
        const restoreFocus = trigger !== undefined && document.activeElement === trigger;
        let focusMoved = false;
        const trackFocus = (focusEvent: FocusEvent): void => {
            if (focusEvent.target !== trigger) focusMoved = true;
        };
        if (restoreFocus) document.addEventListener('focusin', trackFocus);
        void (async () => {
            try {
                await active.undo();
                if (active.lastError) {
                    toasts.error(m.rate_undo_failed());
                    active.dismissError();
                    return;
                }
                await tick();
                // Only repair focus lost when this successful Undo removed its own button.
                if (
                    restoreFocus &&
                    !focusMoved &&
                    !active.undoable &&
                    (document.activeElement === trigger || document.activeElement === document.body)
                ) {
                    mainElement?.focus({ preventScroll: true });
                }
            } finally {
                if (restoreFocus) document.removeEventListener('focusin', trackFocus);
            }
        })();
    }

    function handleRetry(): void {
        void session?.start();
    }

    function handleMilestoneDismiss(): void {
        if (session?.milestone === RAIL_UNLOCK_MILESTONE) railUnlockShown = true;
        session?.acknowledgeMilestone();
    }

    function handleDetails(item: RatingCandidate): void {
        const modalMediaType = isSeries(item.mediaType) ? 'tv' : 'movie';
        const media: MediaItem = {
            title: item.title,
            overview: item.overview,
            externalIds: item.externalIds,
            mediaType: modalMediaType,
            year: item.year,
            genres: item.genres,
            criticRating: item.criticRating,
            rating: item.communityRating,
            isAvailable: item.source === 'watched',
        };
        const imageUrl = imageFromIds(item.externalIds, 'poster', modalMediaType, { size: 'card' });
        openMediaModal(media, imageUrl ?? '');
    }

    function isInteractiveTarget(target: EventTarget | null): boolean {
        return (
            target instanceof HTMLElement &&
            (target.isContentEditable ||
                target.closest(
                    'input, textarea, select, button, a[href], summary, [contenteditable], [role="button"], [role="slider"], [role="menuitem"]',
                ) !== null)
        );
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (!session || session.busy || $hasModals || e.defaultPrevented) return;
        // The milestone celebration overlay owns the keyboard while it's open —
        // arrows/M must not rate the card sitting behind it.
        if (session.milestone !== null) return;
        // While the star picker is open, RateActionBar owns the keyboard
        // (digits 1-9/0, Escape) — page-level arrows/M must not rate/skip
        // the card behind the picker mid-star-interaction. Only applies
        // while the action bar is actually mounted (showDeck): if the deck
        // unmounts with the row left open, the stale bound value must not
        // block the undo shortcut.
        if (starsOpen && showDeck) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isInteractiveTarget(e.target) || isInteractiveTarget(document.activeElement)) return;
        if (!showDeck && e.key !== 'u' && e.key !== 'U') return;

        switch (e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                requestDirectionalRate('left', 2);
                break;
            case 'ArrowRight':
                e.preventDefault();
                requestDirectionalRate('right', 8);
                break;
            case 'ArrowUp':
                e.preventDefault();
                requestDirectionalRate('up', 10);
                break;
            case 'ArrowDown':
            case ' ': // Space = skip ("pass"), the natural next-card key
                e.preventDefault();
                requestSkip();
                break;
            case 'm':
            case 'M':
                e.preventDefault();
                submitRate(5, 'quick');
                break;
            case 'u':
            case 'U':
                if (session.undoable) {
                    e.preventDefault();
                    handleUndo();
                }
                break;
        }
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
    <title>{m.rate_trainer_title()}</title>
</svelte:head>

<div class="rate-trainer-shell">
    <header class="rate-trainer-header">
        <a class="rate-trainer-back" href={resolve('/')}>&larr; {m.rate_trainer_back()}</a>
        <h1 class="rate-trainer-title">{m.rate_trainer_title()}</h1>

        {#if session}
            <div class="rate-trainer-stats">
                <span>{m.rate_lifetime_count({ count: String(session.totalRatings) })}</span>
                <span class="rate-trainer-stats-session" data-testid="session-count"
                    >{m.rate_session_count({ count: String(session.sessionCount) })}</span>
            </div>

            <div class="rate-trainer-filter" role="group" aria-label={m.rate_trainer_title()}>
                <button
                    type="button"
                    class="rate-trainer-filter-btn"
                    class:active={session.filter === 'seen'}
                    aria-pressed={session.filter === 'seen'}
                    disabled={session.busy}
                    onclick={() => void session?.setFilter('seen')}>
                    {m.rate_filter_seen()}
                </button>
                <button
                    type="button"
                    class="rate-trainer-filter-btn"
                    class:active={session.filter === 'all'}
                    aria-pressed={session.filter === 'all'}
                    disabled={session.busy}
                    onclick={() => void session?.setFilter('all')}>
                    {m.rate_filter_all()}
                </button>
            </div>
        {/if}
        <p class="rate-trainer-purpose">{m.rate_trainer_purpose()}</p>
        <details class="rate-trainer-help">
            <summary>{m.rate_help_toggle()}</summary>
            <div class="rate-trainer-help-content">
                <p>{m.rate_help_intro()}</p>
                <ul class="rate-trainer-coach-list">
                    <li>{m.rate_coach_left()}</li>
                    <li>{m.rate_coach_right()}</li>
                    <li>{m.rate_coach_up()}</li>
                    <li>{m.rate_coach_down()}</li>
                    <li>{m.rate_coach_meh()}</li>
                    <li>{m.rate_coach_undo()}</li>
                </ul>
                <p>{m.rate_help_exact()}</p>
            </div>
        </details>
    </header>

    {#if railUnlockShown}
        <div class="rate-trainer-rail-unlock">
            <a href={resolve('/')}>{m.rate_milestone_unlock()}</a>
        </div>
    {/if}

    <main
        class="rate-trainer-main"
        bind:this={mainElement}
        tabindex="-1"
        aria-label={m.rate_trainer_title()}>
        {#if !session || session.phase === 'loading'}
            <div class="rate-trainer-skeleton" aria-hidden="true">
                <div class="animate-pulse"></div>
            </div>
        {:else if session.phase === 'error'}
            <div class="rate-trainer-state">
                <p>{m.ai_rate_load_error()}</p>
                <button type="button" class="btn variant-filled-primary" onclick={handleRetry}>
                    {m.common_retry()}
                </button>
            </div>
        {:else if showDeck}
            <SwipeDeck
                bind:this={deckRef}
                cards={session.cards}
                disabled={session.busy || $hasModals}
                onrate={handleDeckRate}
                onskip={handleSkip}
                ondetails={handleDetails} />
        {:else}
            <div class="rate-trainer-state">
                <h2>{m.rate_exhausted_title()}</h2>
                <p>{m.rate_exhausted_body()}</p>
                {#if session.filter === 'seen'}
                    <button
                        type="button"
                        class="btn variant-ghost-surface"
                        onclick={() => void session?.setFilter('all')}>
                        {m.rate_exhausted_switch_filter()}
                    </button>
                {/if}
                <a class="btn variant-filled-primary" href={resolve('/')}>
                    {m.rate_trainer_back()}
                </a>
            </div>
        {/if}
    </main>

    {#if showDeck && session}
        <footer class="rate-trainer-footer">
            <RateActionBar
                disabled={session.busy || $hasModals || session.cards.length === 0}
                bind:starsOpen
                onrate={handleBarRate}
                onskip={requestSkip} />
        </footer>
    {/if}

    <div class:rate-trainer-confirmation={!!session?.undoable} bind:this={confirmationElement}>
        <p class="rate-trainer-status" role="status" aria-live="polite" aria-atomic="true">
            {#if session?.undoable}
                {m.rate_saved_confirmation({
                    title: session.undoable.item.title,
                    rating: String(session.undoable.rating),
                })}
            {/if}
        </p>
        {#if session?.undoable}
            <button
                type="button"
                disabled={$hasModals || session.milestone !== null}
                aria-disabled={session.busy}
                onclick={handleUndo}>
                {m.rate_undo()}
            </button>
        {/if}
    </div>
</div>

<MilestoneOverlay milestone={session?.milestone ?? null} ondismiss={handleMilestoneDismiss} />

<style>
    .rate-trainer-shell {
        display: flex;
        min-height: 100vh;
        min-height: 100dvh;
        width: 100%;
        max-width: 52rem;
        margin-inline: auto;
        flex-direction: column;
        padding-bottom: 2rem;
    }

    /* Desktop: the app navbar (src/app.html) is position:fixed with z-index 500
       and would overlay our header, swallowing clicks on the back link — clear
       it, same approach as .browse-page (padding-top: 5rem). Below 1024px the
       navbar sits in normal document flow and needs no clearance. */
    @media (min-width: 1024px) {
        .rate-trainer-shell {
            padding-top: 5rem;
        }
    }

    .rate-trainer-header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem 1rem;
        padding: 1rem 1.25rem 1.25rem;
    }

    .rate-trainer-back {
        color: var(--color-surface-300, #cbd5e1);
        font-size: 0.875rem;
        text-decoration: none;
        white-space: nowrap;
    }

    .rate-trainer-back:hover {
        text-decoration: underline;
    }

    .rate-trainer-title {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 600;
    }

    .rate-trainer-stats {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin-left: auto;
        font-size: 0.8125rem;
        color: var(--color-surface-300, #cbd5e1);
    }

    .rate-trainer-stats-session {
        color: var(--color-primary-400, #38bdf8);
        font-weight: 600;
    }

    .rate-trainer-filter {
        display: flex;
        flex-wrap: wrap;
        max-width: 100%;
        gap: 0.375rem;
        margin-left: auto;
    }

    .rate-trainer-filter-btn {
        border-radius: 9999px;
        border: 1px solid var(--color-surface-600, #475569);
        background: transparent;
        min-height: 44px;
        padding: 0.5rem 0.75rem;
        font-size: 0.75rem;
        color: var(--color-surface-300, #cbd5e1);
    }

    .rate-trainer-filter-btn.active {
        border-color: var(--color-primary-500, #0ea5e9);
        background: var(--color-primary-500, #0ea5e9);
        color: white;
    }

    .rate-trainer-filter-btn:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }

    .rate-trainer-rail-unlock {
        display: flex;
        justify-content: center;
        padding: 0 1.25rem 0.5rem;
    }

    .rate-trainer-rail-unlock a {
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--color-primary-400, #38bdf8);
        text-decoration: none;
    }

    .rate-trainer-rail-unlock a:hover {
        text-decoration: underline;
    }

    .rate-trainer-main {
        display: flex;
        min-height: 0;
        align-items: center;
        justify-content: center;
        padding: 0.25rem 1rem 0;
        /* Clip flying/dragged cards at the FULL-WIDTH page area (not at the
           card-sized deck box) so swipes can't cause horizontal scroll but
           also don't get cut off right at the card's own edge. */
        overflow: clip;
    }

    .rate-trainer-skeleton {
        display: flex;
        height: 420px;
        width: 100%;
        max-width: 360px;
        align-items: stretch;
    }

    .rate-trainer-skeleton .animate-pulse {
        width: 100%;
        border-radius: 1rem;
        background: var(--color-surface-800, #1e293b);
    }

    .rate-trainer-state {
        display: flex;
        max-width: 420px;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        text-align: center;
        color: var(--color-surface-200, #e2e8f0);
    }

    .rate-trainer-state h2 {
        font-size: 1.25rem;
        font-weight: 700;
    }

    .rate-trainer-footer {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        padding: 1.75rem 1rem 0;
    }

    .rate-trainer-purpose {
        flex-basis: 100%;
        margin: 0;
        color: var(--color-surface-200, #e2e8f0);
        font-size: 0.9375rem;
        line-height: 1.5;
    }

    .rate-trainer-help {
        width: 100%;
        font-size: 0.875rem;
        color: var(--color-surface-200, #e2e8f0);
    }

    .rate-trainer-help summary {
        width: fit-content;
        min-height: 44px;
        align-content: center;
        cursor: pointer;
        color: var(--color-primary-300, #7dd3fc);
    }

    .rate-trainer-help-content {
        border: 1px solid var(--color-surface-600, #475569);
        border-radius: 0.75rem;
        padding: 1rem;
        line-height: 1.5;
    }

    .rate-trainer-coach-list {
        margin: 0.75rem 0;
        list-style: none;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 0.375rem 1rem;
    }

    .rate-trainer-confirmation {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 0.5rem 1rem;
        margin: 1rem 1rem 0;
        padding: 0.75rem 1rem;
        border: 1px solid var(--color-surface-600, #475569);
        border-radius: 0.75rem;
        background: var(--color-surface-900, #0f172a);
        color: var(--color-surface-100, #f1f5f9);
        font-size: 0.875rem;
        overflow-wrap: anywhere;
    }

    .rate-trainer-status {
        margin: 0;
    }

    .rate-trainer-confirmation button {
        min-height: 44px;
        padding: 0.5rem 1rem;
        border-radius: 0.5rem;
        background: var(--color-surface-700, #334155);
        font-weight: 600;
    }

    .rate-trainer-confirmation button:disabled,
    .rate-trainer-confirmation button[aria-disabled='true'] {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .rate-trainer-shell :is(button, a, summary):focus-visible {
        outline: 3px solid var(--color-primary-300, #7dd3fc);
        outline-offset: 3px;
    }
</style>
