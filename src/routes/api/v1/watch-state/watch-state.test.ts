// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for PATCH /api/v1/watch-state/{id}
 *
 * Focus: the favorite write runs in a withTx transaction and `watched` runs
 * last, so a failing watched op leaves only an idempotent favorite write behind.
 * `rating` is not part of this body any more (see /media/{id}/rating).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ────────────────────────────────────────────────────────

const mockMarkWatched = vi.hoisted(() => vi.fn());
const mockMarkUnwatched = vi.hoisted(() => vi.fn());
const mockReadWatched = vi.hoisted(() => vi.fn());
const mockSetFavorite = vi.hoisted(() => vi.fn());
const mockGetWatchState = vi.hoisted(() => vi.fn());
const mockGetRating = vi.hoisted(() => vi.fn());
const mockGetSql = vi.hoisted(() => vi.fn());

// withTx: by default just runs the callback with the same sql handle.
// Tests that need rollback behaviour override this.
const mockWithTx = vi.hoisted(() =>
    vi
        .fn()
        .mockImplementation(async (sql: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(sql)),
);

// ── Module mocks ──────────────────────────────────────────────────────────────

// Auth middleware: pass through with a pre-populated user
vi.mock('$lib/server/middleware/auth', () => ({
    requireAuth: (handler: (evt: unknown) => Promise<Response>) => (evt: unknown) => handler(evt),
}));

// Error handler: re-throw (tests check raw throws, not HTTP 500 wrappers)
vi.mock('$lib/server/middleware/error-handler', () => ({
    withErrorHandler: (handler: (evt: unknown) => Promise<Response>) => async (evt: unknown) => {
        try {
            return await handler(evt);
        } catch (err) {
            return new Response(JSON.stringify({ error: String((err as Error).message ?? err) }), {
                status: 500,
            });
        }
    },
}));

// withValidation: extract JSON body and inject as validated.body
vi.mock('$lib/server/middleware/validate', () => ({
    withValidation:
        (handler: (evt: unknown) => Promise<Response>, _schemas: unknown) =>
        async (evt: Record<string, unknown>) => {
            const body = await (evt.request as Request).json();
            return handler({ ...evt, validated: { body } });
        },
}));

// withIdResolution: no-op pass-through
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: (evt: unknown) => Promise<Response>) => (evt: unknown) =>
        handler(evt),
}));

// checkMediaAccess: grant access by default (tests exercise the withTx path, not the gate)
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: mockWithTx,
}));

// The route's watched branch now delegates to the shared, music-aware,
// access-gated ops module. Mock it so the watched path is exercised without a
// real DB; the ops resolve to { kind: 'ok' } by default (access granted).
vi.mock('$lib/server/services/watched-state-ops.js', () => ({
    readWatchedStatus: mockReadWatched,
    markWatchedOp: mockMarkWatched,
    markUnwatchedOp: mockMarkUnwatched,
}));

vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    getUserWatchState: { one: mockGetWatchState },
    setUserMediaFavorite: mockSetFavorite,
}));

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    getUserRating: { one: mockGetRating },
}));

// `problem()` is called directly by the route handler; `ApiProblem.*` is
// called by mount()'s enforce()/withMountErrorHandler (the {kind:'user'} gate
// and the catch-all 500 fallback) — both must be mocked or mount.ts's real
// import resolves `ApiProblem` to `undefined` and crashes.
function fakeProblem(code: string, opts?: { error?: string }) {
    return new Response(JSON.stringify({ code, ...(opts ?? {}) }), {
        status:
            code === 'unauthorized'
                ? 401
                : code === 'forbidden' || code === 'scope_required'
                  ? 403
                  : code === 'not_found'
                    ? 404
                    : code === 'dependency_unavailable'
                      ? 503
                      : code === 'validation_failed'
                        ? 422
                        : 500,
    });
}
vi.mock('$lib/server/api/problem.js', () => ({
    problem: fakeProblem,
    ApiProblem: {
        unauthorized: (error?: string) => fakeProblem('unauthorized', { error }),
        forbidden: (error?: string) => fakeProblem('forbidden', { error }),
        scopeRequired: () => fakeProblem('scope_required'),
        notFound: (error?: string) => fakeProblem('not_found', { error }),
        dependencyUnavailable: (error?: string) => fakeProblem('dependency_unavailable', { error }),
        validationFailed: () => fakeProblem('validation_failed'),
        internalError: (error?: string) => fakeProblem('internal_error', { error }),
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001' as `${string}`;
const MEDIA_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

/** A minimal fake sql object — withTx mock passes this to the callback */
const fakeSql = {} as unknown as import('postgres').Sql;

function makeEvent(body: unknown) {
    return {
        request: new Request('http://localhost/api/v1/watch-state/' + MEDIA_ID, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        // mount()'s {kind:'user'} gate + its catch-all error logger both read
        // event.url — a real handler always has one (SvelteKit populates it).
        url: new URL('http://localhost/api/v1/watch-state/' + MEDIA_ID),
        params: { id: MEDIA_ID },
        locals: {
            // username is required by mount()'s {kind:'user'} gate (it checks
            // locals.principal?.username ?? locals.user?.username).
            user: { userId: USER_ID, username: 'contract_guard_user' },
            resolvedIds: { internalId: MEDIA_ID },
        },
    };
}

const stubStateRow = {
    is_watched: true,
    resume_position_ms: 0,
    runtime_ms: null,
    watch_count: 1,
    last_watched_at: null,
    last_event_at: '2026-08-19T12:00:00.000Z',
    is_favorite: true,
};
const stubRatingRow = { rating: 7 };

function makeGetEvent() {
    return {
        request: new Request('http://localhost/api/v1/watch-state/' + MEDIA_ID, {
            method: 'GET',
        }),
        url: new URL('http://localhost/api/v1/watch-state/' + MEDIA_ID),
        params: { id: MEDIA_ID },
        locals: {
            user: { userId: USER_ID, username: 'contract_guard_user' },
            resolvedIds: { internalId: MEDIA_ID },
        },
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/watch-state/{id}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue(fakeSql);
        mockGetWatchState.mockResolvedValue(stubStateRow);
        mockGetRating.mockResolvedValue(stubRatingRow);
        mockMarkWatched.mockResolvedValue({ kind: 'ok', watched: true });
        mockMarkUnwatched.mockResolvedValue({ kind: 'ok', watched: false });
        mockReadWatched.mockResolvedValue({ kind: 'ok', watched: true });
        mockSetFavorite.mockResolvedValue(undefined);
        // Default withTx: transparent pass-through
        mockWithTx.mockImplementation(async (sql: unknown, cb: (tx: unknown) => Promise<unknown>) =>
            cb(sql),
        );
    });

    it('returns 422 when body is empty', async () => {
        const { PATCH } = await import('./[id]/+server.js');
        const resp = await PATCH!(makeEvent({}) as Parameters<NonNullable<typeof PATCH>>[0]);
        expect(resp.status).toBe(422);
    });

    it('returns 422 for a body that only carries rating (ratings live on /media/{id}/rating)', async () => {
        const { PATCH } = await import('./[id]/+server.js');
        const resp = await PATCH!(makeEvent({ rating: 7 }) as Parameters<NonNullable<typeof PATCH>>[0]);
        expect(resp.status).toBe(422);
        expect(mockWithTx).not.toHaveBeenCalled();
    });

    it('ignores a rating next to watched and still answers the stored rating', async () => {
        const { PATCH } = await import('./[id]/+server.js');
        const resp = await PATCH!(
            makeEvent({ watched: true, rating: 3 }) as Parameters<NonNullable<typeof PATCH>>[0],
        );
        expect(resp.status).toBe(200);
        expect((await resp.json()).rating).toBe(7);
    });

    it('updates only watched when favorite is absent', async () => {
        const { PATCH } = await import('./[id]/+server.js');
        const resp = await PATCH!(
            makeEvent({ watched: true }) as Parameters<NonNullable<typeof PATCH>>[0],
        );
        expect(resp.status).toBe(200);
        expect(mockMarkWatched).toHaveBeenCalledWith(USER_ID, MEDIA_ID, expect.anything());
        expect(mockSetFavorite).not.toHaveBeenCalled();
        // withTx was NOT called: only the favorite path uses it
        expect(mockWithTx).not.toHaveBeenCalled();
    });

    it('does not call withTx when only watched is provided', async () => {
        const { PATCH } = await import('./[id]/+server.js');
        await PATCH!(makeEvent({ watched: false }) as Parameters<NonNullable<typeof PATCH>>[0]);
        expect(mockMarkUnwatched).toHaveBeenCalledWith(USER_ID, MEDIA_ID, expect.anything());
        expect(mockWithTx).not.toHaveBeenCalled();
    });

    it('writes the favorite when only favorite is provided', async () => {
        const { PATCH } = await import('./[id]/+server.js');
        await PATCH!(makeEvent({ favorite: false }) as Parameters<NonNullable<typeof PATCH>>[0]);
        expect(mockWithTx).toHaveBeenCalledTimes(1);
        expect(mockSetFavorite).toHaveBeenCalledWith(expect.anything(), USER_ID, MEDIA_ID, false);
    });

    it('returns 500 when watched throws, with the favorite already committed', async () => {
        // The order was deliberately flipped (defs/watch-state/[id].ts):
        // markWatchedOp commits on its own via appendEventAndRebuild, so running
        // it first meant a later throw in the favorite block left the watch event
        // already committed, and the client's retry of the whole PATCH appended a
        // SECOND mark_watched event, inflating watch_count with nothing to
        // dedupe it, since those events carry no source_event_id.
        //
        // Reversed, a failure can only leave the favorite write done. It is
        // idempotent (a set), so the retry is clean. That is the property worth
        // pinning.
        mockMarkWatched.mockRejectedValue(new Error('DB down'));
        const { PATCH } = await import('./[id]/+server.js');
        const resp = await PATCH!(
            makeEvent({ watched: true, favorite: true }) as Parameters<NonNullable<typeof PATCH>>[0],
        );
        expect(resp.status).toBe(500);
        expect(mockWithTx).toHaveBeenCalledTimes(1);
        expect(mockSetFavorite).toHaveBeenCalledTimes(1);
    });
});

describe('GET /api/v1/watch-state/{id}', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue(fakeSql);
        mockGetWatchState.mockResolvedValue(stubStateRow);
        mockGetRating.mockResolvedValue(stubRatingRow);
        mockReadWatched.mockResolvedValue({ kind: 'ok', watched: true });
    });

    it('returns lastEventAt populated when the column is set', async () => {
        const { GET } = await import('./[id]/+server.js');
        const resp = await GET!(makeGetEvent() as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body.lastEventAt).toBe('2026-08-19T12:00:00.000Z');
    });

    it('returns lastEventAt null when the column is null', async () => {
        mockGetWatchState.mockResolvedValue({ ...stubStateRow, last_event_at: null });
        const { GET } = await import('./[id]/+server.js');
        const resp = await GET!(makeGetEvent() as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(200);
        const body = await resp.json();
        expect(body.lastEventAt).toBeNull();
    });

    it('keeps lastWatchedAt reporting the last completion event (regression guard)', async () => {
        mockGetWatchState.mockResolvedValue({
            ...stubStateRow,
            last_watched_at: '2026-08-01T00:00:00.000Z',
            last_event_at: '2026-08-19T12:00:00.000Z',
        });
        const { GET } = await import('./[id]/+server.js');
        const resp = await GET!(makeGetEvent() as Parameters<NonNullable<typeof GET>>[0]);
        const body = await resp.json();
        expect(body.lastWatchedAt).toBe('2026-08-01T00:00:00.000Z');
        expect(body.lastEventAt).toBe('2026-08-19T12:00:00.000Z');
    });
});
