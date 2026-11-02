<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Presentational card stack: renders up to the top 3 `cards` (index 0 =
  front), wires the swipe-card action onto the front card only, and turns a
  commit into onrate()/onskip() callback props. Owns just enough local state
  to drive the drag transform + exit animation — no API/store imports, no
  network calls. The caller (rate-session store via the /rate page) decides
  what happens to `cards` once onrate/onskip fires.
-->
<script lang="ts">
    import { swipeCard } from '$lib/actions/swipe-card';
    import type { SwipeDirection } from '$lib/actions/swipe-math';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import type { RatingCandidate } from '$lib/schemas/api-ai-responses';
    import SwipeCard from './SwipeCard.svelte';

    interface Props {
        /** Visible deck, index 0 = front. Only the top 3 are rendered. */
        cards: RatingCandidate[];
        /** Gate all input (e.g. while a rate/skip request is in flight). */
        disabled?: boolean;
        /**
         * Commit direction mapped to the rating vocabulary: left=2, right=8, up=10.
         *
         * Contract: onrate/onskip fire SYNCHRONOUSLY at gesture commit time —
         * the removal animation is internal (a visual ghost of the committed
         * card animates off while the caller's busy flag can already gate all
         * other input paths). The committed item leaves `cards` whenever the
         * caller removes it (e.g. on submit success); the committed card stays
         * hidden until that removal lands (even past the animation window) and
         * only reappears if the submit settles WITHOUT removal (failure).
         */
        onrate: (rating: number) => void;
        /** Fires synchronously at gesture commit time (see onrate contract). */
        onskip: () => void;
        ondetails?: (item: RatingCandidate) => void;
    }

    let { cards, disabled = false, onrate, onskip, ondetails }: Props = $props();

    // Matches the CSS keyframe duration below — how long the visual ghost of
    // a committed card is kept around to play its exit animation.
    const EXIT_ANIMATION_MS = 400;

    const DIRECTION_RATING: Record<'left' | 'right' | 'up', number> = {
        left: 2,
        right: 8,
        up: 10,
    };

    function cardKey(item: RatingCandidate): string {
        return mediaCompositeKey(item.externalIds, item.mediaType, item.title);
    }

    // Respect prefers-reduced-motion: no fling/exit animation, instant swap.
    // Pattern from RatingMode.svelte:208-216.
    let prefersReducedMotion = $state(false);
    $effect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        prefersReducedMotion = mq.matches;
        const onChange = (e: MediaQueryListEvent): void => {
            prefersReducedMotion = e.matches;
        };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    });

    let deckHeight = $state(0);
    let viewportHeight = $state(0);
    // At enlarged text sizes the card can fill the screen. Let touch users
    // scroll it vertically; horizontal swipes and all rating buttons still work.
    let needsTouchScroll = $derived(viewportHeight > 0 && deckHeight >= viewportHeight);

    // Live drag state for the front card, fed by the swipeCard action.
    let isDragging = $state(false);
    let dragDirection = $state<SwipeDirection | null>(null);
    let dragProgress = $state(0);
    let dragTransformStr = $state('');

    // Visual ghost of the just-committed card: the callback has ALREADY fired
    // (commit-time contract, see Props) — this snapshot only exists to play
    // the exit animation. While it lives, the same item is filtered out of
    // the stack render (the caller may not have removed it from `cards` yet,
    // e.g. the submit request is still in flight) so it never shows twice.
    let exiting = $state<{
        item: RatingCandidate;
        direction: SwipeDirection;
        height: number;
    } | null>(null);
    let exitTimeoutId: ReturnType<typeof setTimeout> | null = null;
    // Key sequence of the `cards` prop captured at the instant the ghost
    // started — the baseline the ghost-lifecycle guard below compares against.
    // Kept in lockstep with `exiting` (both set/cleared together).
    let exitOriginalKeys = $state<string[] | null>(null);

    $effect(() => {
        return () => {
            if (exitTimeoutId !== null) clearTimeout(exitTimeoutId);
        };
    });

    /** True if `prefix` still appears unchanged at the start of `current` —
     *  tolerates extra items appended after it (e.g. a background refill's
     *  tail append landing while this commit is still in flight). */
    function hasUnchangedPrefix(current: string[], prefix: string[]): boolean {
        return current.length >= prefix.length && prefix.every((k, i) => k === current[i]);
    }

    function clearExitGhost(): void {
        if (exitTimeoutId !== null) {
            clearTimeout(exitTimeoutId);
            exitTimeoutId = null;
        }
        exiting = null;
        exitOriginalKeys = null;
    }

    /**
     * Ghost lifecycle guard.
     *
     * `exiting` is a purely-visual snapshot: onrate()/onskip() already fired
     * (commit-time contract) by the time it's set, and the caller mutates
     * `cards` on its own schedule — synchronously for skip(), asynchronously
     * (after a network round-trip) for a submitted rate(). While the ghost is
     * up, `visibleCards` hides the committed item's key so it never renders
     * twice.
     *
     * Two ways `cards` can move out from under that assumption before the
     * animation timer fires naturally:
     *   1. undo() re-inserts the very same item (a fast submit can resolve —
     *      and undo can be actioned — well inside the exit-animation window).
     *      Left alone, `visibleCards`' own filter would hide the freshly
     *      undone card, making the deck look short/empty.
     *   2. An external reset (setFilter, retry) swaps in an unrelated deck.
     *      Left alone, the stale ghost renders on top of cards it no longer
     *      corresponds to.
     *
     * State machine: from `exitOriginalKeys` (the pre-commit key sequence) we
     * accept exactly two "nothing wrong" shapes for the current `cards` —
     * (a) unchanged at the front (removal hasn't landed yet) or (b) the
     * committed item cleanly removed from the front (checked via only the
     * *next* key). Both shapes tolerate a concurrent tail-append background
     * refill (RateSession#refillIfNeeded, triggered once the deck sinks to
     * <=5 cards) landing while this commit's own submit is still in flight —
     * without that tolerance on (a), a refill arriving before an in-flight
     * commit's removal lands would look like neither shape, and the effect
     * would prematurely un-hide a card that's still mid-submission. If the
     * committed key reappears anywhere, or neither shape matches, we clear the
     * ghost immediately. Trade-off: an external reset mid-animation degrades
     * to a reduced-motion-style instant swap instead of finishing the exit
     * animation — accepted, since a stale/duplicate card is worse.
     */
    // Hide that OUTLIVES the 400ms ghost: the committed card must stay hidden
    // until its removal actually lands in `cards` (server-confirmed submit) —
    // the animation timer is usually shorter than a prod round-trip. Cleared:
    //   • when the key leaves `cards` (success / skip), or
    //   • when the submit settles WITHOUT removal (busy drops while the key is
    //     still present after the ghost is done) → failure → the card returns,
    //     matching the documented failure contract (caller toasts).
    let pendingRemovalKey = $state<string | null>(null);

    $effect(() => {
        if (!exiting || exitOriginalKeys === null) return;
        const committedKey = cardKey(exiting.item);
        const currentKeys = cards.map(cardKey);
        // IMPORTANT: while an async submit is in flight the committed key is
        // STILL in `cards` (removal lands with the server response), so "key
        // present" alone must never be treated as an undo-reappear — that
        // killed the ghost instantly on every slow submit (card lingered on
        // the stack, then blinked away with no exit animation). Checked as a
        // prefix, not an exact match, so a concurrent tail-append background
        // refill doesn't false-positive into the "external reset" branch below.
        const stillPending = hasUnchangedPrefix(currentKeys, exitOriginalKeys);
        const restKeys = exitOriginalKeys.slice(1);
        const cleanRemoval =
            !currentKeys.includes(committedKey) &&
            (restKeys.length === 0 ? currentKeys.length === 0 : currentKeys[0] === restKeys[0]);
        if (stillPending || cleanRemoval) return;
        // Anything else: undo re-inserted the key after removal, or an external
        // reset (setFilter/retry) swapped the deck — drop ghost AND pending
        // hide so nothing valid stays hidden.
        clearExitGhost();
        pendingRemovalKey = null;
    });

    $effect(() => {
        if (pendingRemovalKey === null) return;
        const present = cards.some((c) => cardKey(c) === pendingRemovalKey);
        if (!present) {
            pendingRemovalKey = null;
            return;
        }
        if (!exiting && !disabled) pendingRemovalKey = null;
    });

    // Stack to render: hide the committed card while the ghost animates AND
    // while its removal is pending (see pendingRemovalKey above).
    let visibleCards = $derived.by(() => {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity -- throwaway local set, rebuilt on every derivation
        const hiddenKeys = new Set<string>();
        if (exiting) hiddenKeys.add(cardKey(exiting.item));
        if (pendingRemovalKey !== null) hiddenKeys.add(pendingRemovalKey);
        return hiddenKeys.size > 0 ? cards.filter((c) => !hiddenKeys.has(cardKey(c))) : cards;
    });

    function resetDrag(): void {
        isDragging = false;
        dragDirection = null;
        dragProgress = 0;
        dragTransformStr = '';
    }

    function handleProgress(dir: SwipeDirection | null, progress: number, transform: string): void {
        isDragging = true;
        dragDirection = dir;
        dragProgress = progress;
        dragTransformStr = transform;
    }

    // Spring-back: release without reaching the commit threshold.
    function handleRelease(): void {
        resetDrag();
    }

    function handleCommit(direction: SwipeDirection): void {
        // `exiting` also gates here (belt and braces on top of the caller's
        // busy flag) so a commit during an existing ghost is a no-op.
        if (disabled || exiting || visibleCards.length === 0) return;
        const committed = visibleCards[0];
        resetDrag();

        // Hide the committed card until its removal lands (or the submit
        // fails) — independent of the ghost's fixed animation window, and
        // applied in the reduced-motion path too (instant hide, no lingering
        // card while the request is in flight).
        pendingRemovalKey = cardKey(committed);

        // Start the purely-visual exit ghost BEFORE the callback: any sync
        // read of `cards` triggered by the callback (e.g. local removal on
        // skip) then already renders with the ghost filter in place.
        // Reduced motion: no ghost, instant swap.
        if (!prefersReducedMotion) {
            // Snapshot the PRE-commit prop (exiting is still null here, so
            // `cards` and `visibleCards` are the same array) — this is the
            // baseline the ghost-lifecycle guard diffs against. Read it before
            // flipping `exiting`, since `visibleCards` is itself derived from
            // `exiting` and would otherwise already reflect the post-filter view.
            const originalKeys = cards.map(cardKey);
            exiting = { item: committed, direction, height: deckHeight };
            exitOriginalKeys = originalKeys;
            exitTimeoutId = setTimeout(() => {
                exitTimeoutId = null;
                exiting = null;
                exitOriginalKeys = null;
            }, EXIT_ANIMATION_MS);
        }

        // Commit-time contract: fire synchronously so the caller's busy flag
        // gates every other input path (action bar, keyboard) immediately.
        if (direction === 'down') {
            onskip();
        } else {
            onrate(DIRECTION_RATING[direction]);
        }
    }

    /**
     * Imperative entry point for non-gesture commits (keyboard shortcuts, the
     * action bar's quick buttons) so they play the same fly-off/stack-shift
     * animation as an actual drag — without this, those paths only ever
     * called `onrate`/`onskip` directly and the card just vanished/swapped
     * instantly. Delegates to the exact same `handleCommit` a drag gesture
     * uses, so behavior (disabled/exiting guards, ghost lifecycle, reduced
     * motion) is identical either way.
     */
    export function commit(direction: SwipeDirection): void {
        handleCommit(direction);
    }
</script>

<svelte:window bind:innerHeight={viewportHeight} />

<!-- Keep the front card in flow so enlarged metadata can grow the deck.
     The minimum height also holds the empty stack during pending requests.
     Rear cards and exit ghosts overlay it; ghosts retain their original size.
     The page owns overflow clipping so drags and stack peeks stay visible. -->
<div
    class="swipe-deck relative w-full"
    data-testid="swipe-deck"
    bind:clientHeight={deckHeight}
    style="--stack-depth: {Math.min(
        2,
        Math.max(0, cards.length - 1),
    )}; --actual-deck-height: {deckHeight}px; --exit-deck-height: {exiting?.height ?? 0}px;">
    <!-- Exit ghost: non-interactive snapshot of the committed card animating off -->
    {#if exiting}
        <div
            class="pointer-events-none absolute inset-0"
            data-testid="swipe-ghost"
            class:animate-swipe-left={exiting.direction === 'left'}
            class:animate-swipe-right={exiting.direction === 'right'}
            class:animate-swipe-up={exiting.direction === 'up'}
            class:animate-swipe-down={exiting.direction === 'down'}
            style="z-index: 20; height: {exiting.height}px;"
            aria-hidden="true"
            inert>
            <SwipeCard item={exiting.item} />
        </div>
    {/if}

    {#each visibleCards.slice(0, 3) as item, stackIndex (cardKey(item))}
        {@const isFront = stackIndex === 0}
        {@const interactive = isFront && !disabled && !exiting}
        <div
            class="inset-0 rounded-2xl ring-1 ring-white/10"
            class:relative={isFront}
            class:absolute={!isFront}
            data-testid="swipe-live-card"
            style="z-index: {10 - stackIndex};
                transform: {isFront && dragTransformStr
                ? dragTransformStr
                : /* Peek math: scale shrinks ~0.04*H/2 ≈ 13px at the bottom edge
                     (H≈640), so translateY must exceed that for the card behind
                     to actually peek out — 24px offset ⇒ ~11px visible band. */
                  `translateY(${stackIndex * 24}px) scale(${1 - stackIndex * 0.04})`};
                transition: {(isFront && isDragging) || prefersReducedMotion
                ? 'none'
                : 'transform 0.3s ease-out'};
                touch-action: {isFront ? (needsTouchScroll ? 'pan-y pinch-zoom' : 'none') : 'auto'};
                pointer-events: {interactive ? 'auto' : 'none'};"
            inert={!interactive}
            aria-hidden={!isFront || exiting ? 'true' : undefined}
            use:swipeCard={{
                enabled: interactive,
                onprogress: handleProgress,
                oncommit: handleCommit,
                onrelease: handleRelease,
            }}>
            <SwipeCard
                {item}
                dragDirection={isFront ? dragDirection : null}
                dragProgress={isFront ? dragProgress : 0}
                {ondetails} />
        </div>
    {/each}
</div>

<style>
    .swipe-deck {
        max-width: 22.5rem;
        --deck-height: clamp(21.25rem, 52vh, 32.5rem);
        --deck-height: clamp(21.25rem, 52dvh, 32.5rem);
        min-height: max(var(--deck-height), var(--exit-deck-height));
        /* Reserve the exact visible peek so controls stay 28px below any stack size. */
        margin-bottom: calc(var(--stack-depth) * (24px - var(--actual-deck-height) * 0.02));
    }

    @keyframes swipe-left {
        from {
            transform: translate(0, 0) rotate(0deg);
            opacity: 1;
        }
        to {
            transform: translate(-150%, 0) rotate(-20deg);
            opacity: 0;
        }
    }

    @keyframes swipe-right {
        from {
            transform: translate(0, 0) rotate(0deg);
            opacity: 1;
        }
        to {
            transform: translate(150%, 0) rotate(20deg);
            opacity: 0;
        }
    }

    @keyframes swipe-up {
        from {
            transform: translate(0, 0) scale(1);
            opacity: 1;
        }
        to {
            transform: translate(0, -120%) scale(1.05);
            opacity: 0;
        }
    }

    @keyframes swipe-down {
        from {
            transform: translate(0, 0) scale(1);
            opacity: 1;
        }
        to {
            transform: translate(0, 100%) scale(0.85);
            opacity: 0;
        }
    }

    .animate-swipe-left {
        animation: swipe-left 0.4s ease-out forwards;
    }

    .animate-swipe-right {
        animation: swipe-right 0.4s ease-out forwards;
    }

    .animate-swipe-up {
        animation: swipe-up 0.4s ease-out forwards;
    }

    .animate-swipe-down {
        animation: swipe-down 0.4s ease-out forwards;
    }
</style>
