// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Regression test — OpenAPI contract fidelity for GET /api/v1/notifications.
 *
 * Calls the real handler (DB I/O mocked) and validates the resulting response
 * shape against the Zod schema declared in the colocated `_openapi.ts` files.
 * This catches drift between what the handler actually sends and what the
 * OpenAPI spec (generated from these files) documents — the kind of drift
 * that breaks strict client decoders (e.g. tvOS Swift).
 *
 * Verified invariants:
 *  - every item carries the server-rendered `display` envelope and, for a
 *    routable kind, `link` — the fields the forward-compat contract says a
 *    client may render and route from ALONE;
 *  - `userId` is GONE from the item (self-only endpoint; it only ever echoed
 *    the caller's own id back at them);
 *  - `page` carries the opaque `nextCursor`, and `hasMore` agrees with it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ResponseDef } from '$lib/server/openapi';

// ── Module mocks (must be hoisted before any imports that need them) ──────────

const mockGetDb = vi.fn();
const mockListNotifications = vi.fn();
const mockListPinnedBroadcastsForUser = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    listNotifications: (...args: unknown[]) => mockListNotifications(...args),
    listPinnedBroadcastsForUser: (...args: unknown[]) => mockListPinnedBroadcastsForUser(...args),
    countUnread: vi.fn(),
    markAllRead: vi.fn(),
}));

// ── Import def + OpenAPI route metadata AFTER mocks ────────────────────────────

const { def } = await import('./index.js');
// Route OpenAPI metadata migrated onto the def as `def.docs`.
const route = def.docs!;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(query = ''): RequestEvent {
    const url = new URL(`http://localhost/api/v1/notifications${query}`);
    return {
        url,
        params: {},
        request: new Request(url.toString()),
        locals: {
            principal: { userId: 'user-uuid-0001' },
        } as unknown as RequestEvent['locals'],
    } as unknown as RequestEvent;
}

const CTX = { surface: 'v1' } as const;

/** Narrow a `ResponseDef` to its `{schema}` variant, failing loudly otherwise. */
function schemaOf(def: ResponseDef) {
    if (typeof def === 'string' || !('schema' in def)) {
        throw new Error('Expected a { schema } response definition');
    }
    return def.schema;
}

const EPISODE_ROW = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-uuid-0001',
    kind: 'library.new_episode',
    payload: {
        mediaId: '22222222-2222-4222-8222-222222222222',
        seriesId: '33333333-3333-4333-8333-333333333333',
        seriesTitle: 'Starhaven',
        episodeTitle: 'Harbor Lantern',
        seasonNumber: 2,
        episodeNumber: 7,
    },
    readAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
};

const PINNED_AT = '2026-01-02T09:30:00.000Z';

/**
 * A pinned admin announcement — the parent broadcast's pin is in force.
 *
 * `pinnedAt`/`isPinned` are on the FIXTURE because they are on the row:
 * `listPinnedBroadcastsForUser` returns a `PinnedNotificationRow`, same as the
 * by-id lookup. An earlier version of this fixture carried neither, which is
 * precisely how the handler shipped without surfacing `pinnedAt` — the response
 * still validated, because the schema declares the field `.optional()` and every
 * assertion here was about `display`. A mock that is narrower than the function
 * it stands in for cannot fail the way production does.
 */
const PINNED_BROADCAST_ROW = {
    id: '44444444-4444-4444-8444-444444444444',
    userId: 'user-uuid-0001',
    kind: 'admin.broadcast',
    payload: {
        broadcastId: '55555555-5555-4555-8555-555555555555',
        title: 'Maintenance on Sunday',
        body: 'The server will be offline from 02:00 to 04:00 UTC.',
    },
    readAt: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    expiresAt: null,
    pinnedAt: PINNED_AT,
    isPinned: true,
};

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockListNotifications.mockResolvedValue({ items: [EPISODE_ROW], hasMore: false });
    // Default: nothing pinned. The pinned-block tests opt in explicitly, so
    // every OTHER assertion in this file keeps describing an unpinned inbox.
    mockListPinnedBroadcastsForUser.mockResolvedValue([]);
});

describe('GET /api/v1/notifications — OpenAPI contract', () => {
    it('response matches the documented InboxNotificationsResponseSchema', async () => {
        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        expect(res.status).toBe(200);
        const body = await res.json();

        const schema = schemaOf(route.GET!.responses[200]);
        const result = schema.safeParse(body);
        expect(result.success).toBe(true);
    });

    it('renders a display envelope from the payload, server-side', async () => {
        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const item = (await res.json()).items[0];

        // The same renderer the push banner uses — a row must read identically
        // on the lock screen and in the drawer.
        expect(item.display.title).toBe('Starhaven');
        expect(item.display.body).toContain('S02E07');
        expect(item.display.imageUrl).toBeTypeOf('string');
    });

    it('links an episode row at its SERIES, with the numbering to preselect', async () => {
        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const item = (await res.json()).items[0];

        // Not the episode's own id: that opens a bare episode with no series
        // context and no play button.
        expect(item.link).toEqual({
            target: 'episode',
            mediaId: '33333333-3333-4333-8333-333333333333',
            seasonNumber: 2,
            episodeNumber: 7,
        });
    });

    it('omits link entirely for a kind it does not recognize', async () => {
        mockListNotifications.mockResolvedValue({
            items: [{ ...EPISODE_ROW, kind: 'some.future.kind' }],
            hasMore: false,
        });
        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const item = (await res.json()).items[0];

        // Renderable but not tappable: guessing a route would send the user
        // somewhere the notification was not about.
        expect(item.link).toBeUndefined();
        expect(item.display.title).toBeTruthy();
    });

    it('does not echo userId back on a self-only endpoint', async () => {
        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const item = (await res.json()).items[0];
        expect(item).not.toHaveProperty('userId');
    });

    it('mints a nextCursor only when a further page exists', async () => {
        const lastPage = (await (
            (await def.handlers.GET!(makeEvent(), CTX as never)) as Response
        ).json()) as { page: { hasMore: boolean; nextCursor: string | null } };
        expect(lastPage.page).toMatchObject({ hasMore: false, nextCursor: null });

        mockListNotifications.mockResolvedValue({ items: [EPISODE_ROW], hasMore: true });
        const more = (await (
            (await def.handlers.GET!(makeEvent(), CTX as never)) as Response
        ).json()) as { page: { hasMore: boolean; nextCursor: string | null } };
        expect(more.page.hasMore).toBe(true);
        expect(more.page.nextCursor).toBeTypeOf('string');
    });

    it('round-trips its own cursor back into a keyset position', async () => {
        mockListNotifications.mockResolvedValue({ items: [EPISODE_ROW], hasMore: true });
        const first = (await (
            (await def.handlers.GET!(makeEvent(), CTX as never)) as Response
        ).json()) as { page: { nextCursor: string } };

        await def.handlers.GET!(
            makeEvent(`?cursor=${encodeURIComponent(first.page.nextCursor)}`),
            CTX as never,
        );

        // The cursor must arrive at the query layer as (created_at, id) — the
        // id tiebreaker is what keeps rows sharing a millisecond from being
        // skipped or repeated at a page boundary.
        expect(mockListNotifications).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({
                cursor: { createdAt: EPISODE_ROW.createdAt, id: EPISODE_ROW.id },
            }),
        );
    });

    it('rejects a malformed cursor with 422, not a 500 from the ::uuid cast', async () => {
        const res = (await def.handlers.GET!(
            makeEvent('?cursor=not-a-real-cursor'),
            CTX as never,
        )) as Response;
        expect(res.status).toBe(422);
    });

    it('rejects an unparseable since with 422', async () => {
        const res = (await def.handlers.GET!(
            makeEvent('?since=whenever'),
            CTX as never,
        )) as Response;
        expect(res.status).toBe(422);
    });

    it('passes a valid since through to the query', async () => {
        await def.handlers.GET!(makeEvent('?since=2026-01-01T00:00:00.000Z'), CTX as never);
        expect(mockListNotifications).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ since: '2026-01-01T00:00:00.000Z' }),
        );
    });
});

/**
 * The pinned block's wire contract.
 *
 * Everything here is a promise a client is entitled to build on, so each one
 * gets its own assertion rather than being folded into a single happy path:
 * a client that renders `pinned` above `items` and REPLACES it per response
 * breaks in a different way for each of these if the server stops honouring it.
 */
describe('GET /api/v1/notifications — pinned announcements', () => {
    it('returns pinned rows on the first page, rendered like any other item', async () => {
        mockListPinnedBroadcastsForUser.mockResolvedValue([PINNED_BROADCAST_ROW]);

        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const body = (await res.json()) as {
            pinned?: Array<Record<string, unknown> & { display: { title: string; body?: string } }>;
        };

        expect(body.pinned).toHaveLength(1);
        const pinnedItem = body.pinned![0];

        // The admin's own words, verbatim — this is the one kind whose text is
        // NOT composed from a Paraglide message, because translating what an
        // operator wrote would misquote them.
        expect(pinnedItem.display.title).toBe('Maintenance on Sunday');
        expect(pinnedItem.display.body).toBe('The server will be offline from 02:00 to 04:00 UTC.');
        // Self-only endpoint: the caller's own id must not ride back.
        expect(pinnedItem).not.toHaveProperty('userId');
    });

    it('carries pinnedAt on every pinned row — the field that MEANS pinned', async () => {
        mockListPinnedBroadcastsForUser.mockResolvedValue([PINNED_BROADCAST_ROW]);

        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const pinnedItem = (await res.json()).pinned[0];

        // Asserted on the VALUE, not merely on schema validity: `pinnedAt` is
        // `.optional()`, so a response that omits it validates perfectly while
        // every client reading "pinned iff `pinnedAt` is present" renders the
        // row as an ordinary notification — dismiss button and all — and only
        // discovers otherwise when the DELETE comes back 409.
        expect(pinnedItem.pinnedAt).toBe(PINNED_AT);
        // `isPinned` is the same fact under a second name and is not declared
        // on the wire; emitting it would hand clients two things to keep in sync.
        expect(pinnedItem).not.toHaveProperty('isPinned');
    });

    it('gives a broadcast with no attached link no link and no artwork', async () => {
        mockListPinnedBroadcastsForUser.mockResolvedValue([PINNED_BROADCAST_ROW]);

        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const pinnedItem = (await res.json()).pinned[0];

        // An announcement is not about a media item, so there is nothing in-app
        // to point it at, and artwork would mean inventing a poster for
        // something that names no media. This is still the ordinary case: the
        // link below only appears when an admin typed one.
        expect(pinnedItem.link).toBeUndefined();
        expect(pinnedItem.display.imageUrl).toBeUndefined();
    });

    it('renders an admin-attached link as an EXTERNAL url target', async () => {
        mockListPinnedBroadcastsForUser.mockResolvedValue([
            {
                ...PINNED_BROADCAST_ROW,
                payload: {
                    ...PINNED_BROADCAST_ROW.payload,
                    linkUrl: 'https://lumastra.org/status',
                },
            },
        ]);

        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const pinnedItem = (await res.json()).pinned[0];

        // `target: 'url'` and no `mediaId` — this is the one link on the wire
        // that a client must NOT feed to its own router. Widening the target
        // set was safe only because the set is contractually open: a client
        // that has never heard of 'url' treats the link as absent.
        expect(pinnedItem.link).toEqual({ target: 'url', url: 'https://lumastra.org/status' });
        // Artwork is unaffected — a link is not a media item.
        expect(pinnedItem.display.imageUrl).toBeUndefined();
    });

    it('still validates against the documented schema with a url link', async () => {
        mockListPinnedBroadcastsForUser.mockResolvedValue([
            {
                ...PINNED_BROADCAST_ROW,
                payload: { ...PINNED_BROADCAST_ROW.payload, linkUrl: 'https://example.com/x' },
            },
        ]);

        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const schema = schemaOf(route.GET!.responses[200]);
        // `mediaId` had to become optional for this variant to exist; a schema
        // that still required it would reject the whole response for a strict
        // decoder rather than just the link.
        expect(schema.safeParse(await res.json()).success).toBe(true);
    });

    it('still validates against the documented response schema', async () => {
        mockListPinnedBroadcastsForUser.mockResolvedValue([PINNED_BROADCAST_ROW]);

        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const schema = schemaOf(route.GET!.responses[200]);
        expect(schema.safeParse(await res.json()).success).toBe(true);
    });

    it('OMITS pinned on a cursor continuation, and does not query for it', async () => {
        mockListNotifications.mockResolvedValue({ items: [EPISODE_ROW], hasMore: true });
        const first = (await (
            (await def.handlers.GET!(makeEvent(), CTX as never)) as Response
        ).json()) as { page: { nextCursor: string } };

        mockListPinnedBroadcastsForUser.mockClear();
        const res = (await def.handlers.GET!(
            makeEvent(`?cursor=${encodeURIComponent(first.page.nextCursor)}`),
            CTX as never,
        )) as Response;
        const body = (await res.json()) as Record<string, unknown>;

        // Absent, not empty: a client accumulating pages REPLACES its pinned
        // block from this field, so an empty array on page two would clear a
        // pinned announcement that is still pinned.
        expect(body).not.toHaveProperty('pinned');
        expect(mockListPinnedBroadcastsForUser).not.toHaveBeenCalled();
    });

    it('DOES include pinned on a ?since= reconnect delta', async () => {
        mockListPinnedBroadcastsForUser.mockResolvedValue([PINNED_BROADCAST_ROW]);

        const res = (await def.handlers.GET!(
            makeEvent('?since=2026-01-01T00:00:00.000Z'),
            CTX as never,
        )) as Response;
        const body = (await res.json()) as { pinned?: unknown[] };

        // The disconnection is exactly when a pin the client never saw could
        // have been placed, so the reconnect path carries the full current set
        // even though it is otherwise a delta.
        expect(body.pinned).toHaveLength(1);
    });

    it('sends an empty pinned array when nothing is pinned — that is how an unpin propagates', async () => {
        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const body = (await res.json()) as { pinned?: unknown[] };

        // Present-and-empty rather than absent on the first page: a client
        // replaces its block from this field, and omitting it here would leave
        // an unpinned announcement stuck at the top until a full reload.
        expect(body.pinned).toEqual([]);
    });
});
