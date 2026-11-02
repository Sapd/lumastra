// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/rate` swipe-trainer session store (rate-trainer plan, Task 2).
 *
 * Pure state orchestration for the swipe deck: owns the visible card deck,
 * the refill cursor, the undo window, and server-reconciled counters.
 * `fetchQueue`/`submit`/`clear` are injected via {@link RateSessionDeps} —
 * this module has NO `$lib/api` imports, so unit tests need no network
 * mocks, just stub functions.
 *
 * Concurrency model:
 * - ONE busy gate covers every user-initiated mutation (`start`, `setFilter`,
 *   `rate`, `skip`, `undo`). Each gated action early-returns while another is
 *   in flight, and sets `busy` synchronously before its first await.
 * - Background refills do NOT hold the busy gate (they must not block input);
 *   instead every page load captures a session generation token (`#gen`) and
 *   discards its result — no state writes at all — if `start()`/`setFilter()`
 *   bumped the generation while the fetch was in flight.
 */

import type { RatingCandidate } from '$lib/schemas/api-ai-responses';
import { mediaCompositeKey } from '$lib/utils/media-id-helpers';

/** Queue scope: previously-seen library items only, or the full discovery pool. */
export type QueueFilter = 'seen' | 'all';

/** Lifecycle phase of the deck. `'exhausted'` is terminal until {@link RateSession.setFilter}. */
export type RateSessionPhase = 'loading' | 'ready' | 'exhausted' | 'error';

export interface RateSessionDeps {
    fetchQueue: (p: { filter: QueueFilter; count: number; cursor?: string }) => Promise<{
        status: 'ready' | 'exhausted';
        items: RatingCandidate[];
        nextCursor?: string;
    }>;
    submit: (
        item: RatingCandidate,
        rating: number,
        ratingStyle: 'quick' | 'stars',
    ) => Promise<{
        ok: boolean;
        totalRatings?: number;
        milestone?: number;
        profileStatus?: string;
    }>;
    clear: (item: RatingCandidate) => Promise<{ ok: boolean; totalRatings?: number }>;
    /** Best-effort durable-skip recorder — must never throw; failures are swallowed by the caller. */
    recordSkip?: (item: RatingCandidate) => void;
}

/** Deck page size for both the first load and every refill. */
const PAGE_SIZE = 10;
/** Refill trigger: top up once the visible deck sinks to this size (spec: "≤5"). */
const REFILL_THRESHOLD = 5;

/** Composite dedupe key, mirroring `mediaCompositeKey` semantics (internal → tmdb+mediaType → title). */
function keyOf(item: RatingCandidate): string {
    return mediaCompositeKey(item.externalIds, item.mediaType, item.title);
}

export class RateSession {
    readonly #deps: RateSessionDeps;

    #cards = $state<RatingCandidate[]>([]);
    #busy = $state(false);
    #phase = $state<RateSessionPhase>('loading');
    #filter = $state<QueueFilter>('all'); // spec §5: default Everything
    #totalRatings = $state(0);
    #sessionCount = $state(0);
    #milestone = $state<number | null>(null);
    #undoable = $state<{ item: RatingCandidate; rating: number } | null>(null);
    #lastError = $state<string | null>(null);

    /** Opaque server session token for the next page. Not reactive UI state. */
    #cursor: string | undefined;
    /** Guards against concurrent background refills. */
    #refilling = false;
    /**
     * Session generation token. Bumped by `start()`/`setFilter()`; any page
     * load that resolves after a bump discards its result entirely so a stale
     * fetch (old filter / superseded session) can never clobber the new deck,
     * cursor, or phase.
     */
    #gen = 0;

    constructor(deps: RateSessionDeps, initialTotal: number) {
        this.#deps = deps;
        this.#totalRatings = initialTotal;
    }

    get cards(): RatingCandidate[] {
        return this.#cards;
    }

    get busy(): boolean {
        return this.#busy;
    }

    get phase(): RateSessionPhase {
        return this.#phase;
    }

    get filter(): QueueFilter {
        return this.#filter;
    }

    get totalRatings(): number {
        return this.#totalRatings;
    }

    get sessionCount(): number {
        return this.#sessionCount;
    }

    get milestone(): number | null {
        return this.#milestone;
    }

    get undoable(): { item: RatingCandidate; rating: number } | null {
        return this.#undoable;
    }

    get lastError(): string | null {
        return this.#lastError;
    }

    /**
     * Load the first page for the current filter.
     *
     * Re-entrancy: gated by the shared busy flag — a second `start()` while
     * one is in flight is a NO-OP (not a supersede); the generation token
     * additionally invalidates any stale background refill from before.
     */
    async start(): Promise<void> {
        if (this.#busy) return;
        this.#busy = true;
        this.#gen += 1;
        this.#cards = [];
        this.#cursor = undefined;
        this.#phase = 'loading';
        this.#lastError = null;
        try {
            await this.#loadPage(undefined);
        } finally {
            this.#busy = false;
        }
    }

    /**
     * Switch filter: fresh session token — resets deck, cursor, undo and
     * milestone state. Gated by the shared busy flag: calling while a
     * `rate()`/`undo()`/`start()` is in flight is a NO-OP, so a resolving
     * mutation can never slice or reconcile against a freshly-reset deck.
     */
    async setFilter(filter: QueueFilter): Promise<void> {
        if (this.#busy) return;
        this.#busy = true;
        this.#gen += 1;
        this.#filter = filter;
        this.#cards = [];
        this.#cursor = undefined;
        this.#phase = 'loading';
        this.#undoable = null;
        this.#milestone = null;
        this.#lastError = null;
        try {
            await this.#loadPage(undefined);
        } finally {
            this.#busy = false;
        }
    }

    /**
     * Rate the front card. Busy is set synchronously before the await (race
     * rule: no rate-vs-skip races). The card is removed only on success; on
     * failure it stays in place and `lastError` is set.
     */
    async rate(rating: number, style: 'quick' | 'stars'): Promise<void> {
        if (this.#busy) return;
        const item = this.#cards[0];
        if (!item) return;
        this.#busy = true;
        try {
            const res = await this.#deps.submit(item, rating, style);
            if (res.ok) {
                this.#cards = this.#cards.slice(1);
                if (res.totalRatings !== undefined) this.#totalRatings = res.totalRatings;
                this.#sessionCount += 1;
                if (res.milestone !== undefined) this.#milestone = res.milestone;
                this.#undoable = { item, rating };
                this.#lastError = null;
                this.#refillIfNeeded();
            } else {
                this.#lastError = 'Failed to submit rating';
            }
        } catch (err) {
            this.#lastError = err instanceof Error ? err.message : 'Failed to submit rating';
        } finally {
            this.#busy = false;
        }
    }

    /** Local removal, plus a best-effort durable-skip record — never calls the network directly. */
    skip(): void {
        if (this.#busy) return;
        if (this.#cards.length === 0) return;
        const item = this.#cards[0];
        this.#cards = this.#cards.slice(1);
        try {
            this.#deps.recordSkip?.(item);
        } catch {
            // Best-effort: a throwing recordSkip must never break local skipping.
        }
        this.#refillIfNeeded();
    }

    /**
     * Clear the last rating server-side, reinsert the card at the front, and
     * reconcile counters. Counter rules: `sessionCount` decrements only when
     * the clear was accepted AND applied; `totalRatings` takes the server
     * value when present, otherwise falls back to a local −1 so the lifetime
     * counter is never left inflated after a successful clear.
     */
    async undo(): Promise<void> {
        if (this.#busy || !this.#undoable) return;
        const { item } = this.#undoable;
        this.#busy = true;
        try {
            const res = await this.#deps.clear(item);
            if (res.ok) {
                this.#totalRatings =
                    res.totalRatings !== undefined
                        ? res.totalRatings
                        : Math.max(0, this.#totalRatings - 1);
                this.#sessionCount = Math.max(0, this.#sessionCount - 1);
                this.#cards = [item, ...this.#cards];
                // A restored card makes an empty-deck refill error recoverable.
                if (this.#phase === 'error') this.#phase = 'ready';
                this.#undoable = null;
                this.#lastError = null;
            } else {
                this.#lastError = 'Failed to undo rating';
            }
        } catch (err) {
            this.#lastError = err instanceof Error ? err.message : 'Failed to undo rating';
        } finally {
            this.#busy = false;
        }
    }

    acknowledgeMilestone(): void {
        this.#milestone = null;
    }

    dismissError(): void {
        this.#lastError = null;
    }

    /**
     * Fetch one page, dedupe against the current deck by composite key, and
     * append. Captures the session generation at entry: if `start()`/
     * `setFilter()` bumped it while the fetch was in flight, the result is
     * discarded wholesale — no writes to cards, cursor, phase, or lastError.
     */
    async #loadPage(cursor: string | undefined): Promise<void> {
        const gen = this.#gen;
        try {
            const params =
                cursor === undefined
                    ? { filter: this.#filter, count: PAGE_SIZE }
                    : { filter: this.#filter, count: PAGE_SIZE, cursor };
            const res = await this.#deps.fetchQueue(params);
            if (gen !== this.#gen) return; // stale session — discard
            const existingKeys = new Set(this.#cards.map(keyOf)); // eslint-disable-line svelte/prefer-svelte-reactivity -- transient local inside a pure dedupe step, never reactive state
            const fresh = res.items.filter((it) => !existingKeys.has(keyOf(it)));
            this.#cards = [...this.#cards, ...fresh];
            this.#cursor = res.nextCursor;
            this.#phase = res.status === 'exhausted' ? 'exhausted' : 'ready';
        } catch (err) {
            if (gen !== this.#gen) return; // stale session — discard the error too
            this.#lastError = err instanceof Error ? err.message : 'Failed to load queue';
            // A background refill (deck still has visible cards) must NOT flip the
            // page into its full error state — that hides the whole deck behind a
            // retry screen over a transient hiccup the user hasn't even noticed
            // yet. Only a failed FIRST load (deck empty) is a hard error; a failed
            // refill just surfaces via `lastError` (the page toasts it) while the
            // deck — and phase 'ready' — stays exactly as it was.
            this.#phase = this.#cards.length === 0 ? 'error' : 'ready';
        }
    }

    /** Background top-up once the visible deck sinks to the refill threshold. */
    #refillIfNeeded(): void {
        if (this.#phase !== 'ready') return;
        if (this.#cards.length > REFILL_THRESHOLD) return;
        if (this.#refilling) return;
        this.#refilling = true;
        void this.#loadPage(this.#cursor).finally(() => {
            this.#refilling = false;
        });
    }
}
