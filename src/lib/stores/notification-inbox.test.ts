// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for notification-inbox.ts:
 *  - optimistic markRead() + rollback on API failure
 *  - `hrefFromLink` — the only thing still derived client-side, and it derives
 *    from the server's structured `link`, never from `payload`
 *  - live frames HYDRATE from the server rather than being rendered locally
 *
 * The old `deriveViewItem` suites are gone with the function: title/body/image
 * now arrive pre-rendered in `display`, so there is nothing client-side left to
 * test there. What replaced them is a contract test on the server side
 * (`notifications-openapi-contract.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InboxNotificationItem } from '$lib/schemas/notifications-types.js';

vi.mock('$app/environment', () => ({ browser: true }));

const mockGetNotifications = vi.fn();
const mockGetNotification = vi.fn();
const mockGetUnreadCount = vi.fn();
const mockMarkRead = vi.fn();
const mockMarkAllRead = vi.fn();
const mockDeleteNotification = vi.fn();

vi.mock('$lib/api/notifications.js', () => ({
    getNotifications: (...args: unknown[]) => mockGetNotifications(...args),
    getNotification: (...args: unknown[]) => mockGetNotification(...args),
    getNotificationUnreadCount: (...args: unknown[]) => mockGetUnreadCount(...args),
    markNotificationRead: (...args: unknown[]) => mockMarkRead(...args),
    markAllNotificationsRead: (...args: unknown[]) => mockMarkAllRead(...args),
    deleteNotification: (...args: unknown[]) => mockDeleteNotification(...args),
}));

// notification-inbox.ts imports `userEvents` eagerly (for startLive()); these
// tests exercise loadInitial()/markRead() directly and never call init(), but
// the module import still needs a working mock to resolve.
vi.mock('$lib/stores/user-events.js', () => ({
    userEvents: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        teardown: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        subscribeAll: vi.fn(() => () => {}),
        onConnectedChange: vi.fn(() => () => {}),
        connected: false,
    },
}));

function makeItem(overrides: Partial<InboxNotificationItem> = {}): InboxNotificationItem {
    return {
        id: 'n1',
        kind: 'request.available',
        // Pre-rendered by the server — the client never builds this.
        display: { title: 'Dawn', body: 'Your request is ready to watch' },
        link: { target: 'media', mediaId: 'm1' },
        payload: { title: 'Dawn' },
        readAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        expiresAt: null,
        ...overrides,
    };
}

async function freshStore(): Promise<typeof import('./notification-inbox.js')> {
    vi.resetModules();
    return import('./notification-inbox.js');
}

beforeEach(() => {
    mockGetNotifications.mockReset();
    mockGetNotification.mockReset();
    mockGetUnreadCount.mockReset();
    mockMarkRead.mockReset();
    mockMarkAllRead.mockReset();
    mockDeleteNotification.mockReset();
});

afterEach(() => {
    vi.resetModules();
});

describe('notificationInbox.markRead — optimistic update + rollback', () => {
    it('flips readAt and decrements unreadCount synchronously, before the API call resolves', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 1 }, error: null });
        mockGetNotifications.mockResolvedValue({
            data: { items: [makeItem({ readAt: null })], page: { limit: 30, hasMore: false } },
            error: null,
        });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();

        let resolveMarkRead!: (v: { data: unknown; error: null }) => void;
        mockMarkRead.mockReturnValue(
            new Promise((resolve) => {
                resolveMarkRead = resolve;
            }),
        );

        const pending = notificationInbox.markRead('n1');

        // The optimistic write happens synchronously inside markRead(), before
        // its first `await` — so it must already be visible here, while the
        // mocked API call is still pending.
        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        notificationInbox.subscribe((s) => (snapshot = s))();
        expect(snapshot?.items[0].readAt).not.toBeNull();
        expect(snapshot?.unreadCount).toBe(0);

        resolveMarkRead({ data: { id: 'n1', readAt: snapshot?.items[0].readAt }, error: null });
        await pending;

        notificationInbox.subscribe((s) => (snapshot = s))();
        expect(snapshot?.items[0].readAt).not.toBeNull();
        expect(snapshot?.unreadCount).toBe(0);
    });

    it('rolls back readAt and unreadCount when the API call fails', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 1 }, error: null });
        mockGetNotifications.mockResolvedValue({
            data: { items: [makeItem({ readAt: null })], page: { limit: 30, hasMore: false } },
            error: null,
        });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();

        mockMarkRead.mockResolvedValue({ data: null, error: 'network error' });

        await notificationInbox.markRead('n1');

        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        notificationInbox.subscribe((s) => (snapshot = s))();
        expect(snapshot?.items[0].readAt).toBeNull();
        expect(snapshot?.unreadCount).toBe(1);
    });

    it('is a no-op for an already-read row — never calls the API, never double-decrements', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 0 }, error: null });
        mockGetNotifications.mockResolvedValue({
            data: {
                items: [makeItem({ readAt: '2026-08-01T00:00:00.000Z' })],
                page: { limit: 30, hasMore: false },
            },
            error: null,
        });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();

        await notificationInbox.markRead('n1');

        expect(mockMarkRead).not.toHaveBeenCalled();
    });

    it('rollback restores unreadCount even if the row was removed locally before the API resolved', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 1 }, error: null });
        mockGetNotifications.mockResolvedValue({
            data: { items: [makeItem({ readAt: null })], page: { limit: 30, hasMore: false } },
            error: null,
        });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();

        let resolveMarkRead!: (v: { data: null; error: string }) => void;
        mockMarkRead.mockReturnValue(
            new Promise((resolve) => {
                resolveMarkRead = resolve;
            }),
        );
        mockDeleteNotification.mockResolvedValue({ data: null, error: null });

        const pending = notificationInbox.markRead('n1');
        await notificationInbox.remove('n1'); // row deleted while markRead is still in flight

        resolveMarkRead({ data: null, error: 'network error' });
        await pending;

        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        notificationInbox.subscribe((s) => (snapshot = s))();
        // The row is gone (delete won), but the unread count still gets its
        // credit back rather than under-counting forever.
        expect(snapshot?.items).toHaveLength(0);
        expect(snapshot?.unreadCount).toBe(1);
    });
});

describe('notificationInbox.loadInitial — partial failure reconciliation', () => {
    it('derives unreadCount from the loaded list when only the unread-count endpoint fails, and does not surface an error', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: null, error: 'count endpoint down' });
        mockGetNotifications.mockResolvedValue({
            data: {
                items: [
                    makeItem({ id: 'n1', readAt: null }),
                    makeItem({ id: 'n2', readAt: null }),
                    makeItem({ id: 'n3', readAt: '2026-08-01T00:00:00.000Z' }),
                ],
                page: { limit: 30, hasMore: false },
            },
            error: null,
        });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();

        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        notificationInbox.subscribe((s) => (snapshot = s))();
        expect(snapshot?.items).toHaveLength(3);
        // 2 of the 3 loaded rows are unread — the badge must reflect that
        // instead of sitting on the stale initial 0, and the drawer (whose
        // error UI is gated on items.length === 0) never sees this partial
        // failure because it's reconciled rather than surfaced.
        expect(snapshot?.unreadCount).toBe(2);
        expect(snapshot?.error).toBeNull();
    });

    it('still surfaces an error when the list itself fails, even if the count succeeded', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 5 }, error: null });
        mockGetNotifications.mockResolvedValue({ data: null, error: 'list endpoint down' });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();

        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        notificationInbox.subscribe((s) => (snapshot = s))();
        expect(snapshot?.error).toBe('list endpoint down');
    });

    it('keeps the previous unreadCount when BOTH endpoints fail (nothing to derive from)', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: null, error: 'count endpoint down' });
        mockGetNotifications.mockResolvedValue({ data: null, error: 'list endpoint down' });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();

        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        notificationInbox.subscribe((s) => (snapshot = s))();
        expect(snapshot?.unreadCount).toBe(0); // initialState default, unchanged
        expect(snapshot?.error).toBe('list endpoint down');
    });
});

describe('notificationInbox.markAllRead — relative rollback', () => {
    it('does not clobber a live frame that arrived while the markAllRead request was in flight', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 2 }, error: null });
        mockGetNotifications.mockResolvedValue({
            data: {
                items: [makeItem({ id: 'n1', readAt: null }), makeItem({ id: 'n2', readAt: null })],
                page: { limit: 30, hasMore: false, nextCursor: null },
            },
            error: null,
        });
        const { notificationInbox } = await freshStore();
        const { userEvents } = await import('$lib/stores/user-events.js');

        const subscribeMock = userEvents.subscribe as ReturnType<typeof vi.fn>;
        subscribeMock.mockClear();

        // init() registers startLive()'s per-kind subscribe() callbacks
        // synchronously; loadInitial() (awaited directly, again, for a
        // deterministic settle point) populates the two unread rows.
        const teardown = notificationInbox.init();
        await notificationInbox.loadInitial();

        const call = subscribeMock.mock.calls.find(([kind]) => kind === 'request.available');
        expect(call).toBeDefined();
        const applyLiveFrame = call?.[1] as (frame: unknown) => void;

        let resolveMarkAllRead!: (v: { data: unknown; error: string | null }) => void;
        mockMarkAllRead.mockReturnValue(
            new Promise((resolve) => {
                resolveMarkAllRead = resolve;
            }),
        );

        const pending = notificationInbox.markAllRead();

        // A brand-new notification arrives live while the mark-all-read
        // request is still in flight. Live frames are HYDRATED now, so the frame
        // names its durable row and the store fetches it.
        mockGetNotification.mockResolvedValue({
            data: makeItem({ id: 'n3', readAt: null }),
            error: null,
        });
        applyLiveFrame({
            kind: 'request.available',
            data: { notificationId: 'n3' },
            receivedAt: Date.now(),
        });
        // Let the hydrate settle, so the frame's credit is genuinely in the
        // count before the rollback runs — otherwise this asserts nothing.
        await new Promise((resolve) => setTimeout(resolve, 0));

        resolveMarkAllRead({ data: null, error: 'network error' });
        await pending;

        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        notificationInbox.subscribe((s) => (snapshot = s))();
        // Both original rows roll back to unread...
        expect(snapshot?.items.find((i) => i.id === 'n1')?.readAt).toBeNull();
        expect(snapshot?.items.find((i) => i.id === 'n2')?.readAt).toBeNull();
        // ...and the count reflects the rollback PLUS the live frame that
        // arrived mid-flight (3), not a flat restore to the pre-request
        // snapshot (2) that would silently drop the live frame's credit.
        expect(snapshot?.unreadCount).toBe(3);

        teardown();
    });
});

describe('notificationInbox — read-state reconcile on focus', () => {
    /**
     * A dismissal on another device marks the `request.available` row read
     * server-side and puts NOTHING on the wire (startLive() only subscribes to
     * the two notification kinds). Returning to this tab must therefore refetch,
     * or the badge keeps counting a row that is already read.
     *
     * The suite runs in the node environment, so `document` / `window` are
     * stubbed rather than assumed.
     */
    type Listener = () => void;
    let visibilityListeners: Listener[];
    let focusListeners: Listener[];
    let hidden: boolean;

    beforeEach(() => {
        // Only `Date` is faked: the throttle window has to be steppable, but
        // the store's own promise plumbing must still settle on real timers.
        vi.useFakeTimers({ toFake: ['Date'] });
        visibilityListeners = [];
        focusListeners = [];
        hidden = false;
        vi.stubGlobal('document', {
            get hidden() {
                return hidden;
            },
            addEventListener: (type: string, fn: Listener) => {
                if (type === 'visibilitychange') visibilityListeners.push(fn);
            },
            removeEventListener: (type: string, fn: Listener) => {
                if (type === 'visibilitychange') {
                    visibilityListeners = visibilityListeners.filter((l) => l !== fn);
                }
            },
        });
        vi.stubGlobal('window', {
            addEventListener: (type: string, fn: Listener) => {
                if (type === 'focus') focusListeners.push(fn);
            },
            removeEventListener: (type: string, fn: Listener) => {
                if (type === 'focus') focusListeners = focusListeners.filter((l) => l !== fn);
            },
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    /**
     * The endpoints answer from `serveRead`, so a test can flip the server's
     * truth mid-flight the way another device's dismissal does.
     */
    let serveRead: boolean;

    function serveInbox(): void {
        serveRead = false;
        mockGetUnreadCount.mockImplementation(async () => ({
            data: { count: serveRead ? 0 : 1 },
            error: null,
        }));
        mockGetNotifications.mockImplementation(async () => ({
            data: {
                items: [makeItem({ readAt: serveRead ? '2026-08-02T00:00:00.000Z' : null })],
                page: { limit: 30, hasMore: false },
            },
            error: null,
        }));
    }

    it('picks up a row another device marked read when the tab becomes visible again', async () => {
        serveInbox();
        const { notificationInbox } = await freshStore();

        const teardown = notificationInbox.init();
        await notificationInbox.loadInitial();

        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        notificationInbox.subscribe((s) => (snapshot = s))();
        expect(snapshot?.unreadCount).toBe(1);

        // The dismissal happens on the phone; this tab is told nothing.
        serveRead = true;
        const before = mockGetNotifications.mock.calls.length;

        // Away long enough to clear the anti-storm floor, then back.
        vi.setSystemTime(Date.now() + 30_000);
        hidden = false;
        expect(visibilityListeners).toHaveLength(1);
        for (const fire of visibilityListeners) fire();
        await vi.waitFor(() => {
            expect(mockGetNotifications.mock.calls.length).toBe(before + 1);
            notificationInbox.subscribe((s) => (snapshot = s))();
            expect(snapshot?.loading).toBe(false);
        });

        expect(snapshot?.items[0].readAt).not.toBeNull();
        expect(snapshot?.unreadCount).toBe(0);

        teardown();
    });

    it('reconciles on window focus too, not only on visibilitychange', async () => {
        serveInbox();
        const { notificationInbox } = await freshStore();

        const teardown = notificationInbox.init();
        await notificationInbox.loadInitial();
        serveRead = true;
        const before = mockGetNotifications.mock.calls.length;

        vi.setSystemTime(Date.now() + 30_000);
        expect(focusListeners).toHaveLength(1);
        for (const fire of focusListeners) fire();

        let snapshot: import('./notification-inbox.js').NotificationInboxState | undefined;
        await vi.waitFor(() => {
            expect(mockGetNotifications.mock.calls.length).toBe(before + 1);
            notificationInbox.subscribe((s) => (snapshot = s))();
            expect(snapshot?.unreadCount).toBe(0);
        });

        teardown();
    });

    it('does not refetch while the tab is still hidden', async () => {
        serveInbox();
        const { notificationInbox } = await freshStore();

        const teardown = notificationInbox.init();
        await notificationInbox.loadInitial();
        const before = mockGetNotifications.mock.calls.length;

        vi.setSystemTime(Date.now() + 30_000);
        hidden = true;
        for (const fire of focusListeners) fire();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockGetNotifications).toHaveBeenCalledTimes(before);
        teardown();
    });

    it('throttles a focus storm to a single refetch', async () => {
        serveInbox();
        const { notificationInbox } = await freshStore();

        const teardown = notificationInbox.init();
        await notificationInbox.loadInitial();
        const before = mockGetNotifications.mock.calls.length;

        vi.setSystemTime(Date.now() + 30_000);
        // Alt-tabbing fires focus and visibilitychange together, repeatedly.
        for (let i = 0; i < 5; i++) {
            for (const fire of focusListeners) fire();
            for (const fire of visibilityListeners) fire();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockGetNotifications).toHaveBeenCalledTimes(before + 1);
        teardown();
    });

    it('removes its listeners on teardown', async () => {
        serveInbox();
        const { notificationInbox } = await freshStore();

        const teardown = notificationInbox.init();
        await notificationInbox.loadInitial();
        expect(focusListeners).toHaveLength(1);
        expect(visibilityListeners).toHaveLength(1);

        teardown();

        expect(focusListeners).toHaveLength(0);
        expect(visibilityListeners).toHaveLength(0);
    });
});

describe('hrefFromLink — routing from the server’s structured link', () => {
    it('opens an episode row at its SERIES, with the numbering preselected', async () => {
        const { hrefFromLink } = await freshStore();
        // `link.mediaId` is ALREADY the series — the server decided that. This
        // function only spells the URL; it must not re-derive the target.
        expect(
            hrefFromLink({
                target: 'episode',
                mediaId: 'series-1',
                seasonNumber: 2,
                episodeNumber: 7,
            }),
        ).toBe('/?modal=series-1&season=2&episode=7');
    });

    it('omits season/episode when the link carries none', async () => {
        const { hrefFromLink } = await freshStore();
        expect(hrefFromLink({ target: 'episode', mediaId: 'series-1' })).toBe('/?modal=series-1');
    });

    it('opens a media link as a plain item modal', async () => {
        const { hrefFromLink } = await freshStore();
        expect(hrefFromLink({ target: 'media', mediaId: 'movie-1', requestId: 42 })).toBe(
            '/?modal=movie-1',
        );
    });

    it('returns undefined for an absent link, so the row renders but does not navigate', async () => {
        const { hrefFromLink } = await freshStore();
        // This is how an unrecognized FUTURE kind arrives: display, no link.
        expect(hrefFromLink(undefined)).toBeUndefined();
    });

    it('refuses to route a url link as an in-app path', async () => {
        const { hrefFromLink } = await freshStore();
        // `target: 'url'` points OUTSIDE this app. Returning anything here
        // would put an absolute URL through `resolve()` and the client router,
        // which mangles it — the row uses `externalUrlFromLink` instead.
        expect(hrefFromLink({ target: 'url', url: 'https://example.com/notes' })).toBeUndefined();
    });
});

describe('externalUrlFromLink — the one link that leaves the app', () => {
    it('returns the address for an http(s) url link', async () => {
        const { externalUrlFromLink } = await freshStore();
        expect(externalUrlFromLink({ target: 'url', url: 'https://example.com/notes' })).toBe(
            'https://example.com/notes',
        );
        expect(externalUrlFromLink({ target: 'url', url: 'http://status.example.com' })).toBe(
            'http://status.example.com',
        );
    });

    it('returns undefined for every in-app target', async () => {
        const { externalUrlFromLink } = await freshStore();
        expect(externalUrlFromLink({ target: 'media', mediaId: 'm1' })).toBeUndefined();
        expect(externalUrlFromLink({ target: 'episode', mediaId: 's1' })).toBeUndefined();
        expect(externalUrlFromLink(undefined)).toBeUndefined();
    });

    it('drops a url link whose scheme is not http(s)', async () => {
        const { externalUrlFromLink } = await freshStore();
        // The server refuses to store these, so this is a second gate on an
        // already-validated value — worth having because the result goes
        // straight into an `href`, where `javascript:` executes in this origin.
        for (const url of [
            'javascript:alert(1)',
            'data:text/html,<script>',
            'file:///etc/passwd',
        ]) {
            expect(externalUrlFromLink({ target: 'url', url }), url).toBeUndefined();
        }
    });

    it('drops a url link that is relative or unparseable', async () => {
        const { externalUrlFromLink } = await freshStore();
        expect(externalUrlFromLink({ target: 'url', url: '/status' })).toBeUndefined();
        expect(externalUrlFromLink({ target: 'url', url: 'nonsense' })).toBeUndefined();
        // A `url` target with no address at all: readable row, no tap.
        expect(externalUrlFromLink({ target: 'url' })).toBeUndefined();
    });
});

describe('applyLiveFrame — hydrate, never render locally', () => {
    /** Start the store and hand back the frame callback it registered. */
    async function startedStore() {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 0 }, error: null });
        mockGetNotifications.mockResolvedValue({
            data: { items: [], page: { limit: 30, hasMore: false, nextCursor: null } },
            error: null,
        });
        const mod = await freshStore();
        const { userEvents } = await import('$lib/stores/user-events.js');
        // The userEvents mock is module-level and OUTLIVES vi.resetModules(),
        // so its call history accumulates across tests. Without this clear,
        // `calls[0]` is a callback closed over a previous test's (torn-down)
        // store and every assertion here silently tests the wrong instance.
        const subscribe = vi.mocked(userEvents.subscribe);
        subscribe.mockClear();

        const teardown = mod.notificationInbox.init();
        await mod.notificationInbox.loadInitial();
        const onFrame = subscribe.mock.calls[0][1] as unknown as (frame: unknown) => void;
        return { ...mod, onFrame, teardown };
    }

    function snapshot(store: {
        subscribe: (
            fn: (s: import('./notification-inbox.js').NotificationInboxState) => void,
        ) => () => void;
    }): import('./notification-inbox.js').NotificationInboxState {
        let s: import('./notification-inbox.js').NotificationInboxState | undefined;
        store.subscribe((v) => (s = v))();
        return s!;
    }

    it('fetches the durable row named by the frame and prepends it', async () => {
        const { notificationInbox, onFrame, teardown } = await startedStore();
        const row = makeItem({ id: 'row-1', display: { title: 'Starhaven' } });
        mockGetNotification.mockResolvedValue({ data: row, error: null });

        onFrame({ kind: 'library.new_episode', data: { notificationId: 'row-1' }, receivedAt: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The point of hydrating: the row carries the SERVER's rendering, so a
        // live row is identical to the same row after a reload.
        expect(mockGetNotification).toHaveBeenCalledWith('row-1');
        expect(snapshot(notificationInbox).items[0].display.title).toBe('Starhaven');
        expect(snapshot(notificationInbox).unreadCount).toBe(1);
        teardown();
    });

    it('ignores a frame with no notificationId — there is no durable row', async () => {
        const { notificationInbox, onFrame, teardown } = await startedStore();

        onFrame({ kind: 'library.new_episode', data: { seriesTitle: 'X' }, receivedAt: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Rendering this from `data` is exactly the guesswork the display
        // envelope exists to remove; the focus reconcile picks it up instead.
        expect(mockGetNotification).not.toHaveBeenCalled();
        expect(snapshot(notificationInbox).items).toHaveLength(0);
        teardown();
    });

    it('does not double-insert a row the reconcile already pulled in', async () => {
        const { notificationInbox, onFrame, teardown } = await startedStore();
        mockGetNotification.mockResolvedValue({ data: makeItem({ id: 'row-1' }), error: null });

        onFrame({ kind: 'library.new_episode', data: { notificationId: 'row-1' }, receivedAt: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        onFrame({ kind: 'library.new_episode', data: { notificationId: 'row-1' }, receivedAt: 2 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(snapshot(notificationInbox).items).toHaveLength(1);
        expect(snapshot(notificationInbox).unreadCount).toBe(1);
        teardown();
    });

    it('survives a failed hydrate without corrupting the list', async () => {
        const { notificationInbox, onFrame, teardown } = await startedStore();
        mockGetNotification.mockResolvedValue({ data: null, error: 'boom' });

        onFrame({ kind: 'library.new_episode', data: { notificationId: 'row-1' }, receivedAt: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(snapshot(notificationInbox).items).toHaveLength(0);
        teardown();
    });
});

describe('loadMore — opaque cursor, not a reconstructed timestamp', () => {
    it('sends the server’s nextCursor back verbatim', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 0 }, error: null });
        mockGetNotifications.mockResolvedValueOnce({
            data: {
                items: [makeItem({ id: 'n1' })],
                page: { limit: 30, hasMore: true, nextCursor: 'CURSOR-1' },
            },
            error: null,
        });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();

        mockGetNotifications.mockResolvedValueOnce({
            data: {
                items: [makeItem({ id: 'n2' })],
                page: { limit: 30, hasMore: false, nextCursor: null },
            },
            error: null,
        });
        await notificationInbox.loadMore();

        // Rebuilding a cursor from the last row's createdAt is what skipped or
        // repeated rows whenever several notifications shared a millisecond.
        expect(mockGetNotifications).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: 'CURSOR-1' }),
        );
    });

    it('does not fetch when the server said there is no next page', async () => {
        mockGetUnreadCount.mockResolvedValue({ data: { count: 0 }, error: null });
        mockGetNotifications.mockResolvedValue({
            data: { items: [makeItem()], page: { limit: 30, hasMore: false, nextCursor: null } },
            error: null,
        });
        const { notificationInbox } = await freshStore();
        await notificationInbox.loadInitial();
        const before = mockGetNotifications.mock.calls.length;

        await notificationInbox.loadMore();
        expect(mockGetNotifications).toHaveBeenCalledTimes(before);
    });
});
