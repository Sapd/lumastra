// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notification-inbox.ts — the durable notification inbox store.
 *
 * Reads/writes the ALREADY-SHIPPED `user_notifications` API via the validated
 * client in `$lib/api/notifications.ts` (no new endpoint, no raw fetch):
 *
 *   GET    /api/notifications              (paginated list)
 *   GET    /api/notifications/unread-count
 *   POST   /api/notifications/{id}/read
 *   POST   /api/notifications/read-all
 *   DELETE /api/notifications/{id}
 *
 * Fetches the unread count + first page once on `init()`, then stays live off
 * `$lib/stores/user-events.ts` instead of polling: a `library.new_episode` or
 * `request.available` frame arriving means increment + prepend (see
 * `startLive()`). See `docs/architecture/user-events.md` — this is the "Build
 * — the in-app inbox" surface, the highest-value item on that list and, until
 * this module, unread by anything.
 *
 * ## Rendering is the SERVER's job now
 *
 * This module used to hold `deriveViewItem`/`deriveImageUrls`/`deriveHref` — a
 * client-side reconstruction of each kind's title, subtitle, artwork and route
 * out of raw `payload`. That was a second implementation of rules the server
 * already had (`push-content-text.ts` renders the same text for the push
 * banner), and the two were free to drift: a notification could read one way on
 * a phone's lock screen and another way in this drawer.
 *
 * The API now returns a `display` envelope and a structured `link` on every row.
 * This module renders `display` and routes `link`, and reads `payload` for
 * NOTHING. The practical consequences:
 *
 *  - A `kind` this build has never heard of still renders correctly, because
 *    the server rendered it. No client release is needed to show a new kind.
 *  - A row with no `link` is simply not tappable (`hrefFromLink` returns
 *    undefined), rather than being routed somewhere by guesswork.
 *  - Live SSE frames are HYDRATED rather than rendered locally — see
 *    `applyLiveFrame`, which also fixes a real bug in the old path.
 *
 * ## Read-state reconciliation on focus — and why not a seventh wire kind
 *
 * A dismissal made on one device retires the `request.available` row
 * server-side (`request-dismissal-sync.service.ts` →
 * `markRequestAvailableReadByMediaId`). Nothing on the wire says so, because
 * `startLive()` subscribes to the two NOTIFICATION kinds and a row flipping to
 * read is not a new notification — so a drawer or badge open on a second
 * device kept rendering the fulfilled request as unread until a manual reload.
 * That is the exact "dismissed on my phone, still showing on the TV"
 * inconsistency this feature exists to remove.
 *
 * Two ways to close it, and the cheaper one is the right one:
 *
 *  (a) Publish a read-state SIGNAL frame so other clients flip live. This is a
 *      CONTRACT change, not an implementation detail: a seventh kind has to go
 *      through `shared/user-event-kinds.ts`, the capabilities `kinds[]`, and
 *      the no-skip-list guard in `server/api/event-kinds.test.ts`, and once
 *      advertised, third-party clients see it forever. That is a permanent
 *      widening of a public surface.
 *
 *  (b) Refetch on focus / visibilitychange. `user-event-kinds.ts`'s own
 *      taxonomy calls a stale view a SIGNAL-class problem, whose definition of
 *      correct is "missing the live frame is harmless, the next fetch is
 *      correct" — so the honest question is only whether a fetch happens soon
 *      enough. Returning to the tab is precisely when a stale badge would be
 *      noticed, so the reconcile lands before the user can see the wrong
 *      value, and it costs one already-shipped endpoint pair and no contract.
 *
 * (b) is implemented below. It is also the pattern the sibling popup store
 * already uses (`request-notifications.ts`'s `installNotificationListeners` /
 * `refreshOnFocus`), so the two surfaces recover the same way rather than by
 * two different mechanisms. (a) would only become necessary if a badge had to
 * be correct on a tab the user is *watching but not touching* — which is not
 * a case this feature has.
 */

import { writable, get, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import {
    getNotification,
    getNotifications,
    getNotificationUnreadCount,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification,
} from '$lib/api/notifications.js';
import { userEvents, type UserEventFrame } from '$lib/stores/user-events.js';
import { NOTIFICATION_EVENT_KIND_NAMES } from '$lib/shared/user-event-kinds.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import type { InboxNotificationItem, NotificationLink } from '$lib/schemas/notifications-types.js';

export type { InboxNotificationItem };

const PAGE_SIZE = 30;

/**
 * Floor between two focus-driven reconciles. Alt-tabbing fires `focus` and
 * `visibilitychange` back to back (and again on every window switch), so
 * without this one trip to another app and back would be several round trips.
 * Short enough that "pick the TV up again" always reconciles.
 */
const FOCUS_RECONCILE_MIN_INTERVAL_MS = 10_000;

export interface NotificationInboxState {
    items: InboxNotificationItem[];
    /**
     * Currently-pinned administrator announcements, newest pin first.
     *
     * A SEPARATE array rather than rows tagged inside `items`, mirroring the
     * wire: the server excludes a pinned row from the paginated list precisely
     * so the two never overlap, and merging them back together here would
     * reintroduce the de-duplication the split exists to avoid — plus the pinned
     * block has to stay put while `items` scrolls and pages.
     *
     * REPLACED WHOLESALE on every `loadInitial()` (which is also the focus
     * reconcile), never merged. That is the entire unpin propagation mechanism
     * and it is deliberate: unpinning is not a notification, so it gets no wire
     * kind — a seventh advertised kind is a permanent public-contract widening,
     * and pin state is a SIGNAL-class concern by the taxonomy's own definition
     * ("missing the live frame is harmless, the next fetch is correct"). Since a
     * pin's lifetime is measured in days and the reconcile fires on focus, the
     * staleness window is bounded by when the user could notice. Same argument,
     * same mechanism, as the read-state reconciliation documented above.
     */
    pinned: InboxNotificationItem[];
    unreadCount: number;
    /** True while an initial load or loadMore() is in flight. */
    loading: boolean;
    error: string | null;
    hasMore: boolean;
    /**
     * Opaque cursor for the next page, straight from the last response. Held
     * rather than recomputed: it is the server's keyset position, and the whole
     * point of an opaque cursor is that the client does not know how to build
     * one. `null` = no further page.
     */
    nextCursor: string | null;
}

const initialState: NotificationInboxState = {
    items: [],
    pinned: [],
    unreadCount: 0,
    loading: false,
    error: null,
    hasMore: false,
    nextCursor: null,
};

// ---------------------------------------------------------------------------
// Routing — the ONE thing still computed client-side, and only from `link`.
// ---------------------------------------------------------------------------

/**
 * Turn the server's structured `link` into an in-app path.
 *
 * The server deliberately sends STRUCTURE, not a URL: a path would bake this
 * web app's route table into a durable row that outlives it, and would be
 * meaningless to the iOS app, which has its own navigation. So the mapping from
 * `target` to a screen lives here, on the client that owns the routes — but the
 * DECISION about what a row points at was already made server-side.
 *
 * The shape follows the app's one deep-link convention (`modal-url-sync.ts`, and
 * `openHrefFor` in `server/tasks/context-primitives.ts`): a media item opens as
 * `?modal=<uuid>` over a page, and an episode opens its parent SERIES with the
 * season/episode preselected. `link.mediaId` is already the series for
 * `target: 'episode'`, so this does not re-derive that — it only spells the URL.
 *
 * `/` is the base rather than a relative `?modal=…` because the drawer can be
 * open on any route (including `/watch/*`, where a modal is wrong) and
 * `resolve()` in NotificationRow expects a rooted path.
 *
 * Returns undefined when there is no link — an unrecognised future kind renders
 * as a readable, non-tappable row. Also undefined for `target: 'url'`, which is
 * NOT an in-app path and must not be routed as one; see
 * {@link externalUrlFromLink}.
 */
export function hrefFromLink(link: NotificationLink | undefined): string | undefined {
    if (!link?.mediaId) return undefined;

    const params = new URLSearchParams({ modal: link.mediaId });
    if (link.target === 'episode') {
        if (link.seasonNumber !== undefined) params.set('season', String(link.seasonNumber));
        if (link.episodeNumber !== undefined) params.set('episode', String(link.episodeNumber));
    }
    return `/?${params.toString()}`;
}

/**
 * Schemes an inbox link may be rendered as a clickable destination.
 *
 * The server refuses to STORE anything else (`admin-broadcasts.ts`'s
 * `isAllowedLinkUrl`), so this is a second gate on a value that has already
 * passed one. It is worth having anyway: the output of this function goes
 * straight into an `href`, where `javascript:` executes in this origin. One
 * validated write path plus one validated render path is the arrangement where
 * neither a future write path nor a row from an older server can turn an
 * announcement into script execution.
 */
const EXTERNAL_LINK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The EXTERNAL address a `target: 'url'` link points at, if it is safe to open.
 *
 * Separate from {@link hrefFromLink} rather than folded into it, because the two
 * produce fundamentally different things and the caller has to tell them apart:
 * an in-app path goes through `resolve()` and SvelteKit's client router, while
 * this is an absolute URL to somewhere this application does not control and
 * must be opened as a plain external link (new tab, no opener). Returning both
 * from one function would leave `NotificationRow` guessing which kind of string
 * it received — and `resolve()`ing an absolute URL would mangle it.
 *
 * Returns undefined for every other target, for a `url` link that somehow
 * carries no address, and for any scheme outside
 * {@link EXTERNAL_LINK_PROTOCOLS} — in each case the row stays readable and
 * simply is not tappable, which is the same treatment an unrecognised target
 * gets.
 */
export function externalUrlFromLink(link: NotificationLink | undefined): string | undefined {
    if (link?.target !== 'url' || !link.url) return undefined;

    let parsed: URL;
    try {
        parsed = new URL(link.url);
    } catch {
        // expected: a relative or malformed value is not an external link
        return undefined;
    }
    return EXTERNAL_LINK_PROTOCOLS.has(parsed.protocol) ? link.url : undefined;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createNotificationInboxStore() {
    const { subscribe, update, set } = writable<NotificationInboxState>(initialState);

    let liveStarted = false;
    let unsubscribeLive: (() => void) | null = null;
    let removeFocusListeners: (() => void) | null = null;
    let lastReconcileAt = 0;

    /**
     * The durable row's id, when the frame is one that has a row.
     *
     * `publishUserEvent` sets `notificationId` on the frame payload iff the
     * insert succeeded, so its presence is exactly "this frame is in the inbox".
     * A signal-class frame, or one delivered while Postgres was down, has none.
     */
    function frameNotificationId(frame: UserEventFrame): string | null {
        if (!isRecord(frame.data)) return null;
        const id = frame.data.notificationId;
        return typeof id === 'string' && id.length > 0 ? id : null;
    }

    /**
     * Prepend a live-arrived notification by HYDRATING it from the server.
     *
     * This used to synthesize a row locally from `frame.data` and hand it to
     * `deriveViewItem`. That was wrong twice over. It duplicated the server's
     * rendering rules — and it did not even work: the SSE frame's `data` is the
     * ENVELOPE (`{targetUserId, kind, data}`), so the payload the old code
     * stored was nested one level too deep and every live row silently rendered
     * the generic fallback title instead of the series name. Nothing caught it,
     * because the store test builds its frames by hand rather than from a real
     * envelope.
     *
     * Fetching the row instead gets the server-rendered `display` and `link`,
     * makes a live row identical to the same row after a reload, and means this
     * function has no per-kind knowledge at all. The cost is one small request
     * per notification — these arrive at human frequency, not machine frequency.
     *
     * A frame with no `notificationId` has no durable row to fetch (see above);
     * the badge and list will pick the state up on the next focus reconcile, so
     * it is dropped rather than rendered from guesswork.
     */
    async function applyLiveFrame(frame: UserEventFrame): Promise<void> {
        const notificationId = frameNotificationId(frame);
        if (!notificationId) return;

        const { data } = await getNotification(notificationId);
        if (!data) return;

        update((state) => {
            // The focus reconcile may have already pulled this row in — into
            // EITHER list, so both have to be checked or a pinned announcement
            // arriving live would be added a second time.
            if (
                state.items.some((item) => item.id === data.id) ||
                state.pinned.some((item) => item.id === data.id)
            ) {
                return state;
            }

            // A pinned announcement goes to the pinned block, not the list. The
            // server keeps the two disjoint (`pinned` rows are excluded from
            // `items`), and the hydrate carries `pinnedAt`, so honouring it here
            // is what keeps a live-arrived broadcast in the same place a
            // reloaded one would land. Prepended rather than sorted: the pinned
            // block is ordered newest-pin-first and this pin is the newest.
            const unreadCount = state.unreadCount + (data.readAt === null ? 1 : 0);
            return data.pinnedAt !== undefined
                ? { ...state, pinned: [data, ...state.pinned], unreadCount }
                : { ...state, items: [data, ...state.items], unreadCount };
        });
    }

    /**
     * Start listening for live notification-class frames off the shared
     * user-events connection. Idempotent — safe to call from multiple
     * mount points; only the first call actually subscribes.
     */
    function startLive(): void {
        if (liveStarted || !browser) return;
        liveStarted = true;
        userEvents.connect();
        const unsubscribers = NOTIFICATION_EVENT_KIND_NAMES.map((kind) =>
            userEvents.subscribe(kind, (frame) => {
                void applyLiveFrame(frame);
            }),
        );
        unsubscribeLive = () => {
            for (const off of unsubscribers) off();
        };
        installFocusReconcile();
    }

    function stopLive(): void {
        if (!liveStarted) return;
        liveStarted = false;
        unsubscribeLive?.();
        unsubscribeLive = null;
        removeFocusListeners?.();
        removeFocusListeners = null;
        userEvents.disconnect();
    }

    /**
     * Re-read the server's truth for rows this client cannot be told about
     * live — today, a row another device flipped to read (see the module doc's
     * "Read-state reconciliation on focus").
     *
     * `loadInitial()` IS the reconcile: it re-reads `readAt` for the first page
     * and re-reads the unread count, and because it REPLACES `items` it also
     * picks up rows deleted elsewhere, which a merge could not. The cost is
     * that a drawer scrolled past page one resets to page one; that only
     * happens on a tab the user just returned to, where the deeper pages were
     * stale anyway, so it is the right trade rather than an oversight.
     */
    function reconcileOnFocus(): void {
        if (!browser) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        const now = Date.now();
        if (now - lastReconcileAt < FOCUS_RECONCILE_MIN_INTERVAL_MS) return;
        // A load already in flight is itself the reconcile — piling a second
        // one on top would race two `update()`s over the same list.
        if (get({ subscribe }).loading) return;
        lastReconcileAt = now;
        void loadInitial();
    }

    /** Idempotent via `removeFocusListeners`; only `startLive()` calls it. */
    function installFocusReconcile(): void {
        if (!browser || removeFocusListeners) return;
        if (typeof document === 'undefined' || typeof window === 'undefined') return;

        const onVisibility = (): void => {
            if (!document.hidden) reconcileOnFocus();
        };
        const onFocus = (): void => reconcileOnFocus();

        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('focus', onFocus);
        removeFocusListeners = () => {
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('focus', onFocus);
        };
    }

    /** Fetch the unread count and first page. Call once on mount. */
    async function loadInitial(): Promise<void> {
        if (!browser) return;
        update((state) => ({ ...state, loading: true, error: null }));

        const [countResult, listResult] = await Promise.all([
            getNotificationUnreadCount(),
            getNotifications({ limit: PAGE_SIZE }),
        ]);

        update((state) => {
            const items = listResult.data?.items ?? state.items;
            // Replaced wholesale, and `?? []` rather than `?? state.pinned` on a
            // SUCCESSFUL response: this call always asks for the first page, so
            // the server always answers with the current pinned set, and an
            // omitted-or-empty `pinned` means "nothing is pinned any more" —
            // which is exactly how an unpin propagates. Falling back to the
            // previous value there would make a pin impossible to remove
            // without a reload. Only a FAILED list keeps the old block.
            const pinned = listResult.data ? (listResult.data.pinned ?? []) : state.pinned;

            // Reconcile, don't fail: a lone unread-count failure must not
            // leave the badge stuck at a stale value while the list renders
            // real unread rows. When the count endpoint failed but the list
            // came back, derive a best-effort count from the unread rows we
            // actually have (undercounts only if there's more than one page
            // of unread items — still strictly better than the stale/zero
            // value it replaces). If BOTH fail there's nothing to derive
            // from, so keep the previous count as-is.
            //
            // Pinned rows are counted alongside `items` because the server's
            // `countUnread` counts them too (it is a plain unread count over the
            // whole table and knows nothing about pinning) — leaving them out of
            // the fallback would make the degraded path disagree with the
            // authoritative one in a way that looks like a badge bug.
            let unreadCount = state.unreadCount;
            if (countResult.data) {
                unreadCount = countResult.data.count;
            } else if (listResult.data) {
                unreadCount = [...pinned, ...items].filter((item) => item.readAt === null).length;
            }

            return {
                ...state,
                loading: false,
                unreadCount,
                items,
                pinned,
                hasMore: listResult.data?.page.hasMore ?? state.hasMore,
                nextCursor: listResult.data?.page.nextCursor ?? state.nextCursor,
                // Only a failed LIST is a blocking error — the list is the
                // more valuable half, and a count-only failure is already
                // reconciled above rather than surfaced.
                error: listResult.data ? null : (listResult.error ?? countResult.error ?? null),
            };
        });
    }

    /**
     * Fetch the next page, resuming from the server's opaque cursor.
     *
     * The cursor comes from the last response rather than being rebuilt from
     * the last row's `createdAt` — which is what this used to do, and which
     * skipped or repeated rows whenever several notifications shared a
     * millisecond (a season drop does exactly that). The server's cursor carries
     * the `id` tiebreaker; a timestamp cannot.
     */
    async function loadMore(): Promise<void> {
        if (!browser) return;
        const state = get({ subscribe });
        if (!state.hasMore || state.loading || !state.nextCursor) return;

        update((s) => ({ ...s, loading: true, error: null }));
        const { data, error } = await getNotifications({
            limit: PAGE_SIZE,
            cursor: state.nextCursor,
        });
        update((s) => ({
            ...s,
            loading: false,
            items: data ? [...s.items, ...data.items] : s.items,
            hasMore: data?.page.hasMore ?? false,
            nextCursor: data?.page.nextCursor ?? null,
            error: error ?? null,
        }));
    }

    /**
     * Set `readAt` on whichever list holds `id`, leaving the other untouched.
     *
     * A row lives in exactly ONE of `items`/`pinned` — the server keeps them
     * disjoint — but read-state operations have to search both, because marking
     * a pinned announcement read is not only legal, it is the ONLY thing a user
     * can do to it (dismissing is refused with a 409 while the pin holds). The
     * first version of this searched `items` alone, which silently made the
     * "mark read" button on a pinned row do nothing at all: no optimistic flip,
     * and so no server call either.
     *
     * Returns null when the id is absent from both, or already in the target
     * state, so callers can skip the network round trip.
     */
    function withReadAt(
        state: NotificationInboxState,
        id: string,
        readAt: string | null,
    ): NotificationInboxState | null {
        for (const key of ['items', 'pinned'] as const) {
            const idx = state[key].findIndex((item) => item.id === id);
            if (idx === -1) continue;
            if ((state[key][idx].readAt === null) === (readAt === null)) return null;
            const next = state[key].slice();
            next[idx] = { ...next[idx], readAt };
            return { ...state, [key]: next };
        }
        return null;
    }

    /**
     * Mark one notification as read. Optimistic: flips `readAt` and
     * decrements the unread count immediately, then rolls both back if the
     * server call fails. No-op if the row is missing or already read.
     */
    async function markRead(id: string): Promise<void> {
        let didOptimisticUpdate = false;
        const nowIso = new Date().toISOString();

        update((state) => {
            const next = withReadAt(state, id, nowIso);
            if (!next) return state;
            didOptimisticUpdate = true;
            return { ...next, unreadCount: Math.max(0, state.unreadCount - 1) };
        });

        if (!didOptimisticUpdate) return;

        const { error } = await markNotificationRead(id);
        if (error) {
            update((state) => {
                // The row may have been replaced by a reconcile in the
                // meantime; credit the count back either way, matching the
                // previous behaviour for a vanished row.
                const next = withReadAt(state, id, null) ?? state;
                return { ...next, unreadCount: state.unreadCount + 1 };
            });
        }
    }

    /**
     * Mark every unread notification as read. Optimistic, with rollback if
     * the server call fails.
     *
     * The rollback is RELATIVE, not a restore of a snapshotted scalar: it
     * flips back only the rows this call itself marked read, and bumps
     * `unreadCount` by however many of those rows still exist and are still
     * marked read at rollback time (rather than resetting to a
     * pre-request snapshot). A snapshot-restore would discard any live
     * frame that incremented `unreadCount` while the request was in
     * flight — the badge would then undercount relative to the actual
     * unread rows until a reload. Rows removed via remove() in the
     * meantime are simply skipped (nothing to flip back, no count credit
     * — remove()'s own rollback already accounts for its row).
     */
    async function markAllRead(): Promise<void> {
        const changedIds: string[] = [];
        const nowIso = new Date().toISOString();

        update((state) => {
            // Both lists — "mark all read" means all, and the server's
            // `markAllRead` flips every unread row for the user including the
            // pinned ones. Leaving `pinned` out would clear the badge while the
            // pinned block still rendered its rows as unread.
            const flip = (item: InboxNotificationItem): InboxNotificationItem => {
                if (item.readAt === null) {
                    changedIds.push(item.id);
                    return { ...item, readAt: nowIso };
                }
                return item;
            };
            return {
                ...state,
                items: state.items.map(flip),
                pinned: state.pinned.map(flip),
                unreadCount: 0,
            };
        });

        if (changedIds.length === 0) return;

        const { error } = await markAllNotificationsRead();
        if (error) {
            const changedSet = new Set(changedIds);
            update((state) => {
                let revertedCount = 0;
                const unflip = (item: InboxNotificationItem): InboxNotificationItem => {
                    if (changedSet.has(item.id) && item.readAt !== null) {
                        revertedCount++;
                        return { ...item, readAt: null };
                    }
                    return item;
                };
                const items = state.items.map(unflip);
                const pinned = state.pinned.map(unflip);
                return {
                    ...state,
                    items,
                    pinned,
                    unreadCount: state.unreadCount + revertedCount,
                };
            });
        }
    }

    /**
     * Delete a notification. Optimistic removal, with rollback (re-inserted
     * at its original index, and the unread count restored) if the server
     * call fails.
     *
     * Searches `items` ONLY, unlike the read-state operations above, and that
     * asymmetry is the feature rather than an omission: a currently-pinned
     * announcement is not dismissible (the server answers 409 for exactly this
     * reason), and the drawer does not render a dismiss control on a pinned row.
     * Confining the search here means a stray call for a pinned id no-ops
     * locally instead of optimistically removing a row the server will then
     * refuse to delete — a flicker followed by a rollback, for an action that
     * was never going to succeed.
     */
    async function remove(id: string): Promise<void> {
        let removedItem: InboxNotificationItem | undefined;
        let removedIndex = -1;

        update((state) => {
            removedIndex = state.items.findIndex((item) => item.id === id);
            if (removedIndex === -1) return state;
            removedItem = state.items[removedIndex];
            const items = state.items.slice();
            items.splice(removedIndex, 1);
            const unreadCount =
                removedItem.readAt === null
                    ? Math.max(0, state.unreadCount - 1)
                    : state.unreadCount;
            return { ...state, items, unreadCount };
        });

        if (!removedItem) return;

        const { error } = await deleteNotification(id);
        if (error) {
            const restored = removedItem;
            update((state) => {
                const items = state.items.slice();
                items.splice(Math.min(removedIndex, items.length), 0, restored);
                const unreadCount =
                    restored.readAt === null ? state.unreadCount + 1 : state.unreadCount;
                return { ...state, items, unreadCount };
            });
        }
    }

    /**
     * Fetch the initial state and start the live feed. Returns a teardown —
     * call it on unmount. Idempotent-safe to call from multiple mount points
     * (startLive() no-ops after the first call); loadInitial() itself is not
     * deduped, so callers that mount more than one inbox surface at once
     * should share one `init()` call rather than invoking it per surface.
     */
    function init(): () => void {
        // Counts as a reconcile, so a `focus` fired moments later (mounting the
        // layout usually IS a focus) doesn't immediately fetch the same page.
        lastReconcileAt = Date.now();
        void loadInitial();
        startLive();
        return () => stopLive();
    }

    /** Hard reset — call on logout. Drops all state and tears down the live feed. */
    function teardown(): void {
        stopLive();
        lastReconcileAt = 0;
        set(initialState);
    }

    return {
        subscribe,
        init,
        loadInitial,
        loadMore,
        markRead,
        markAllRead,
        remove,
        teardown,
    };
}

export type NotificationInboxStore = ReturnType<typeof createNotificationInboxStore>;

/** Singleton — import this, never construct your own. */
export const notificationInbox: NotificationInboxStore & Readable<NotificationInboxState> =
    createNotificationInboxStore();
