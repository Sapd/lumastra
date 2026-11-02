// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The four properties the per-user webhook has to hold, tested through
 * `publishUserEvent` rather than against the enqueue helper alone — because
 * three of the four are properties of the ORDERING between the durable insert
 * and the enqueue, and a test that calls the helper directly cannot see them.
 *
 *  1. A coalesced duplicate produces no webhook. The unique index (16.191.0)
 *     already yields one row; the assertion here is that the SECOND publish
 *     produces zero outbox rows, not one that a receiver would render as a
 *     duplicate push.
 *  2. A signal kind produces no webhook, ever.
 *  3. The admin gate off means no outbox row at all — hence no delivery attempt.
 *  4. A DB failure (not a conflict) produces no webhook either, which is where
 *     this path deliberately diverges from the live frame.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Config — the admin gate is the value under test in half of these
// ---------------------------------------------------------------------------

const mockConfig = {
    FEATURE_USER_NOTIFICATION_WEBHOOKS: true,
    PUBLIC_BASE_URL: 'https://lumastra.example.com',
    DEVICE_VERIFICATION_BASE_URL: '',
    INSTANCE_ID: 'test-instance',
};

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

// ---------------------------------------------------------------------------
// Valkey — enough for publishUserEvent's frame id + fan-out, nothing more
// ---------------------------------------------------------------------------

vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => async () => {}),
    getCoordinationClient: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

interface MockDbState {
    /** Notification identities already written, as the unique index holds them. */
    notificationRows: Set<string>;
    /** true → insertNotification throws (DB down), rather than conflicting. */
    insertThrows: boolean;
    /** null → the user has no endpoint configured. */
    hookIdForUser: string | null;
    /** Every outbox row this test run produced. */
    enqueued: Array<{ userHookId: string; eventId: string; payload: Record<string, unknown> }>;
}

const mockDb: MockDbState = {
    notificationRows: new Set(),
    insertThrows: false,
    hookIdForUser: 'hook-1',
    enqueued: [],
};

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({}) as unknown),
}));

vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    insertNotification: vi.fn(
        async (_sql: unknown, opts: { userId: string; kind: string; payload?: unknown }) => {
            if (mockDb.insertThrows) throw new Error('connection terminated');
            const coalesceKey = (opts.payload as { coalesceKey?: string } | undefined)?.coalesceKey;
            const key = `${opts.userId}|${opts.kind}|${coalesceKey ?? ''}`;
            if (coalesceKey === undefined) return { inserted: true, row: {} };
            if (mockDb.notificationRows.has(key)) return { inserted: false, row: null };
            mockDb.notificationRows.add(key);
            return { inserted: true, row: {} };
        },
    ),
}));

vi.mock('$lib/server/database/queries/user-notification-webhooks.queries.js', () => ({
    getUserNotificationWebhookTarget: vi.fn(async () =>
        mockDb.hookIdForUser ? { id: mockDb.hookIdForUser } : null,
    ),
    enqueueUserWebhookDelivery: vi.fn(
        async (
            _sql: unknown,
            params: { userHookId: string; eventId: string; payload: Record<string, unknown> },
        ) => {
            // Model the partial unique index: same (hook, event id) → no row.
            const dup = mockDb.enqueued.some(
                (e) => e.userHookId === params.userHookId && e.eventId === params.eventId,
            );
            if (dup) return false;
            mockDb.enqueued.push(params);
            return true;
        },
    ),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
    },
}));

const { publishUserEvent } = await import('./notification-events.service.js');

// ---------------------------------------------------------------------------

const NEW_EPISODE = {
    userId: 'user-1',
    kind: 'library.new_episode',
    persist: true,
    data: {
        mediaId: 'episode-1',
        seriesId: 'series-1',
        seriesTitle: 'Starhaven',
        episodeTitle: 'Hello, Ms. Cobel',
        seasonNumber: 2,
        episodeNumber: 3,
        posterUrl: '/api/media/series-1/image/poster',
        coalesceKey: 'series:series-1:s2',
    },
} as const;

beforeEach(() => {
    mockConfig.FEATURE_USER_NOTIFICATION_WEBHOOKS = true;
    mockDb.notificationRows.clear();
    mockDb.insertThrows = false;
    mockDb.hookIdForUser = 'hook-1';
    mockDb.enqueued = [];
});

describe('per-user notification webhook enqueue', () => {
    it('queues exactly one outbox row for a notification kind', async () => {
        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });

        expect(mockDb.enqueued).toHaveLength(1);
        expect(mockDb.enqueued[0].userHookId).toBe('hook-1');
    });

    it('produces NO webhook for a coalesced duplicate', async () => {
        // Two episodes of the same season on the same day — the exact shape the
        // coalescing index exists for. The first publish inserts, the second
        // conflicts, and the conflict must stop the webhook as well as the toast.
        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });
        await publishUserEvent({
            ...NEW_EPISODE,
            data: { ...NEW_EPISODE.data, mediaId: 'episode-2', episodeNumber: 4 },
        });

        expect(mockDb.notificationRows.size).toBe(1);
        expect(mockDb.enqueued).toHaveLength(1);
    });

    it('produces NO webhook for concurrent publishes of the same identity', async () => {
        // The parallel-outbox-shard case: both pre-checks would pass, so only
        // the INSERT can arbitrate. Whichever loses must not enqueue.
        await Promise.all([
            publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } }),
            publishUserEvent({
                ...NEW_EPISODE,
                data: { ...NEW_EPISODE.data, mediaId: 'episode-2' },
            }),
        ]);

        expect(mockDb.enqueued).toHaveLength(1);
    });

    it('produces NO webhook for a signal kind', async () => {
        for (const kind of [
            'session_changed',
            'watch_state_set_changed',
            'device.state',
            'admin',
        ]) {
            await publishUserEvent({ userId: 'user-1', kind, data: { anything: true } });
        }

        expect(mockDb.enqueued).toHaveLength(0);
    });

    it('produces NO webhook for a signal kind even when persist is forced on', async () => {
        // `persist: true` on a signal is not a thing the product does, but the
        // override exists on the API, and the kind gate must not be reachable
        // through it — a signal has no business reaching someone's phone.
        await publishUserEvent({
            userId: 'user-1',
            kind: 'session_changed',
            persist: true,
            data: { coalesceKey: 'x' },
        });

        expect(mockDb.enqueued).toHaveLength(0);
    });

    it('makes NO delivery attempt when the admin gate is off', async () => {
        mockConfig.FEATURE_USER_NOTIFICATION_WEBHOOKS = false;

        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });

        // The durable row and the live frame still happen — the gate is about
        // outbound delivery, not about notifications.
        expect(mockDb.notificationRows.size).toBe(1);
        // Nothing queued means the delivery worker has nothing to attempt.
        expect(mockDb.enqueued).toHaveLength(0);
    });

    it('produces no webhook when the user has not configured an endpoint', async () => {
        mockDb.hookIdForUser = null;

        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });

        expect(mockDb.enqueued).toHaveLength(0);
    });

    it('produces NO webhook when the durable insert FAILED (not conflicted)', async () => {
        // Deliberate divergence from the live frame, which does fall through on
        // a failure so a Postgres outage cannot silently mute notifications. A
        // failed insert means nothing arbitrated, so every parallel shard would
        // enqueue — and an outbox row is durable and retried, unlike a toast.
        mockDb.insertThrows = true;

        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });

        expect(mockDb.enqueued).toHaveLength(0);
    });
});

describe('per-user notification webhook payload', () => {
    it('renders a useful read-only Jellyfin token notice', async () => {
        await publishUserEvent({
            userId: 'user-1',
            kind: 'jellyfin.readonly_token',
            data: {},
        });
        expect(mockDb.enqueued).toHaveLength(1);
        const payload = mockDb.enqueued[0].payload;
        expect(payload.title).toBe('Your Jellyfin app cannot play with this token');
        expect(payload.message).toContain('read-only token');
        expect(payload.message).toContain('Quick Connect');
        expect(payload.click).toBeUndefined();
    });

    it('carries a CloudEvent envelope with render fields mirrored at the top level', async () => {
        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });

        const payload = mockDb.enqueued[0].payload;
        // Envelope — required, because WebhookOutbox.deliver() reads `type` and
        // `id` off the stored payload for its X-Lumastra-* headers.
        expect(payload.specversion).toBe('1.0');
        expect(payload.type).toBe('org.lumastra.user.notification');
        expect(payload.subject).toBe('notification/library.new_episode');
        // Render fields — what a generic receiver actually looks at.
        expect(payload.title).toBe('Starhaven — S02E03');
        expect(typeof payload.message).toBe('string');
        expect(typeof payload.content).toBe('string');
        // The SERIES modal with season/episode preselected, not the episode's
        // own (bare) id — see the `deriveHref`-parity test below.
        expect(payload.click).toBe(
            'https://lumastra.example.com/?modal=series-1&season=2&episode=3',
        );
        // Structured half.
        const data = payload.data as Record<string, unknown>;
        expect(data.kind).toBe('library.new_episode');
        expect(data.posterUrl).toBe('https://lumastra.example.com/api/media/series-1/image/poster');
    });

    it('omits link and poster when no public base URL is configured', async () => {
        // A relative path is useless to ntfy or Discord — they fetch from the
        // open internet, not from a browser that already has an origin.
        mockConfig.PUBLIC_BASE_URL = '';
        try {
            await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });
        } finally {
            mockConfig.PUBLIC_BASE_URL = 'https://lumastra.example.com';
        }

        const payload = mockDb.enqueued[0].payload;
        expect(payload.click).toBeUndefined();
        expect((payload.data as Record<string, unknown>).link).toBeUndefined();
        expect((payload.data as Record<string, unknown>).posterUrl).toBeUndefined();
    });

    it('derives a deterministic event id from the coalescing identity', async () => {
        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });
        const first = mockDb.enqueued[0].eventId;

        // Same identity on a later attempt (e.g. after a crash between the
        // durable insert and the enqueue) must collide on the outbox's partial
        // unique index rather than queue a second push.
        mockDb.notificationRows.clear();
        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });

        expect(mockDb.enqueued).toHaveLength(1);
        expect(first).toContain('series:series-1:s2');
    });

    it('links to the SERIES modal, not the bare episode, for library.new_episode', async () => {
        // The bug this guards: building the link from `mediaId` (the episode's
        // own UUID) instead of `seriesId` reproduces "bare episode modal: no
        // series context, no season list, no play button" — the exact failure
        // `deriveHref()` in notification-inbox.ts was written to avoid.
        await publishUserEvent({ ...NEW_EPISODE, data: { ...NEW_EPISODE.data } });

        const payload = mockDb.enqueued[0].payload;
        expect(payload.click).toBe(
            'https://lumastra.example.com/?modal=series-1&season=2&episode=3',
        );
        expect(payload.click).not.toContain('modal=episode-1');
    });

    it('falls back to the episode id (no season/episode params) when seriesId is absent', async () => {
        const { seriesId: _seriesId, ...dataWithoutSeries } = NEW_EPISODE.data;
        await publishUserEvent({ ...NEW_EPISODE, data: dataWithoutSeries });

        const payload = mockDb.enqueued[0].payload;
        expect(payload.click).toBe('https://lumastra.example.com/?modal=episode-1');
    });

    it('keeps using mediaId as the link target for request.available', async () => {
        await publishUserEvent({
            userId: 'user-1',
            kind: 'request.available',
            persist: true,
            data: {
                mediaId: 'movie-1',
                mediaType: 'movie',
                title: 'Dawn',
                year: 2021,
                requestId: 'req-1',
                coalesceKey: 'request:req-1',
            },
        });

        const payload = mockDb.enqueued[0].payload;
        expect(payload.click).toBe('https://lumastra.example.com/?modal=movie-1');
    });
});
