// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards two things about the pinned-genres def as published on /api/v1:
 *
 *  1. DELETE genre source: v1 passes the genre as a `{genre}` path param
 *     (published surface — DELETE bodies are dropped by some HTTP clients,
 *     proxies and SDK generators), while the pre-existing internal route
 *     keeps passing it in a JSON body. Both must keep working off the SAME
 *     handler, and path param wins when both are present.
 *
 *     SvelteKit already decodes route params before the handler ever sees
 *     them (runtime/server/respond.js → utils/routing.js decode_params →
 *     decodeURIComponent), so `params.genre` here is passed ALREADY DECODED
 *     — a raw, still-percent-encoded value is not what the runtime delivers
 *     and must not be used in these fixtures.
 *  2. Response conformance: GET/POST/DELETE each declare a `docs[method]`
 *     200 schema, which activates mount()'s response-conformance gate
 *     (mount.ts finalizeResponse). Every actual `json(...)` payload is
 *     safeParse'd against its declared schema here, same pattern as
 *     `routes/api/v1/music/sessions/[id]/session-detail-openapi-contract.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetDb = vi.fn();
const mockGetPinnedGenresAll = vi.fn();
const mockGetPinnedGenresCount = vi.fn();
const mockPinGenreExecute = vi.fn();
const mockUnpinGenre = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/index.js', () => ({
    getPinnedGenres: {
        all: (...args: unknown[]) => mockGetPinnedGenresAll(...args),
        count: (...args: unknown[]) => mockGetPinnedGenresCount(...args),
    },
    pinGenre: { execute: (...args: unknown[]) => mockPinGenreExecute(...args) },
    unpinGenre: { all: (...args: unknown[]) => mockUnpinGenre(...args) },
}));

const { def } = await import('./pinned-genres.js');
// OpenAPI doc metadata is per-path (`def.docsByPath`) since this def is mounted
// at three paths. The internal collection path documents all three methods
// (GET/POST/DELETE), which is all this file's schema-conformance checks need.
const route = def.docsByPath!('/api/me/music/pinned-genres')!;

function makeEvent(opts: { params?: Record<string, string>; body?: unknown }): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/v1/me/music/pinned-genres'),
        params: opts.params ?? {},
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify(opts.body),
        }),
    } as unknown as RequestEvent;
}

describe('pinned-genres DELETE genre source', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockGetPinnedGenresAll.mockResolvedValue([]);
        mockGetPinnedGenresCount.mockResolvedValue(0);
        mockPinGenreExecute.mockResolvedValue(undefined);
        mockUnpinGenre.mockResolvedValue([{ id: 1 }]);
    });

    it('unpins via the v1 path param ("Drum & Bass")', async () => {
        // SvelteKit delivers params already decoded — the fixture passes the
        // decoded value directly, not a percent-encoded one.
        const res = await def.handlers.DELETE!(
            makeEvent({ params: { genre: 'Drum & Bass' } }),
            {} as never,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { genre: string };
        expect(body.genre).toBe('Drum & Bass');
        expect(mockUnpinGenre).toHaveBeenCalledWith(expect.anything(), {
            userId: 'u1',
            genre: 'Drum & Bass',
        });
    });

    it('handles a decoded slash in the path param', async () => {
        // A literal, UNENCODED '/' cannot reach this handler at all — SvelteKit's
        // single-segment [genre] route splits on '/', so the client must send it
        // percent-encoded (%2F) for the request to match this route in the first
        // place. SvelteKit then restores the literal slash before the handler
        // sees it, so the fixture models the post-decode value directly.
        const res = await def.handlers.DELETE!(
            makeEvent({ params: { genre: 'Hip/Hop' } }),
            {} as never,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { genre: string };
        expect(body.genre).toBe('Hip/Hop');
    });

    it('round-trips a genre containing a literal "%" without double-decoding', async () => {
        // Regression: a second decodeURIComponent() call on an already-decoded
        // param would throw a URIError on '80% Pop' (500) or silently mangle a
        // '%NN'-shaped genre into the wrong string (unpins the wrong genre).
        const res = await def.handlers.DELETE!(
            makeEvent({ params: { genre: '80% Pop' } }),
            {} as never,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { genre: string };
        expect(body.genre).toBe('80% Pop');
        expect(mockUnpinGenre).toHaveBeenCalledWith(expect.anything(), {
            userId: 'u1',
            genre: '80% Pop',
        });
    });

    it('falls back to a JSON body when no path param is present (internal route)', async () => {
        const res = await def.handlers.DELETE!(makeEvent({ body: { genre: 'Jazz' } }), {} as never);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { genre: string };
        expect(body.genre).toBe('Jazz');
        expect(mockUnpinGenre).toHaveBeenCalledWith(expect.anything(), {
            userId: 'u1',
            genre: 'Jazz',
        });
    });

    it('prefers the path param over the body when both are present', async () => {
        const res = await def.handlers.DELETE!(
            makeEvent({ params: { genre: 'Rock' }, body: { genre: 'Pop' } }),
            {} as never,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { genre: string };
        expect(body.genre).toBe('Rock');
    });

    it('404s when the genre is not pinned', async () => {
        mockUnpinGenre.mockResolvedValue([]);
        const res = await def.handlers.DELETE!(
            makeEvent({ params: { genre: 'Rock' } }),
            {} as never,
        );
        expect(res.status).toBe(404);
    });
});

function expectMatchesDeclaredSchema(method: 'GET' | 'POST' | 'DELETE', body: unknown): void {
    const responseDef = route[method]?.responses[200];
    expect(responseDef).toBeDefined();
    expect(typeof responseDef).not.toBe('string'); // must carry a schema, not just a description

    const schema = (
        responseDef as {
            schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
        }
    ).schema;
    const result = schema.safeParse(body);
    expect(result.success, `schema mismatch: ${JSON.stringify(result.error, null, 2)}`).toBe(true);
}

describe('pinned-genres response conformance', () => {
    it('publishes the pin request body', () => {
        const body = def.docsByPath?.('/api/v1/me/music/pinned-genres')?.POST?.body;
        expect(body?.safeParse({ genre: 'Jazz' }).success).toBe(true);
        expect(body?.safeParse({}).success).toBe(false);
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockGetPinnedGenresAll.mockResolvedValue([]);
        mockGetPinnedGenresCount.mockResolvedValue(0);
        mockPinGenreExecute.mockResolvedValue(undefined);
        mockUnpinGenre.mockResolvedValue([{ id: 1 }]);
    });

    it('GET 200 body matches the documented MusicPinnedGenresResponse schema', async () => {
        mockGetPinnedGenresAll.mockResolvedValue([
            {
                id: 1,
                user_id: 'u1',
                genre: 'Jazz',
                position: 0,
                pinned_at: new Date('2026-07-01T00:00:00.000Z'),
            },
        ]);
        const res = await def.handlers.GET!(makeEvent({}), {} as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expectMatchesDeclaredSchema('GET', body);
    });

    it('POST 200 body matches the documented PinGenreResponse schema', async () => {
        const res = await def.handlers.POST!(makeEvent({ body: { genre: 'Jazz' } }), {} as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expectMatchesDeclaredSchema('POST', body);
    });

    it('DELETE 200 body matches the documented PinGenreResponse schema', async () => {
        const res = await def.handlers.DELETE!(
            makeEvent({ params: { genre: 'Jazz' } }),
            {} as never,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expectMatchesDeclaredSchema('DELETE', body);
    });
});
