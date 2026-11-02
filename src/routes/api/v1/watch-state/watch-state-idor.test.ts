// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A1 — IDOR regression tests for PATCH /api/v1/watch-state/{id}
 *
 * Regression: before the fix, a PATCH body of { favorite: true } (no `watched`)
 * skipped the checkMediaAccess gate and wrote user state against media the
 * caller cannot access (existence-leak + state pollution).
 *
 * The fix: when `watched` is absent, the handler calls checkMediaAccess
 * before touching any write; returns 404 (not_found) when access is denied.
 *
 * These tests drive THROUGH the real PATCH handler (imported after mocks) with
 * all I/O mocked — no live DB required.
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
const mockCheckMediaAccess = vi.hoisted(() => vi.fn());

const mockWithTx = vi.hoisted(() =>
    vi
        .fn()
        .mockImplementation(async (sql: unknown, cb: (tx: unknown) => Promise<unknown>) => cb(sql)),
);

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/middleware/auth', () => ({
    requireAuth: (handler: (evt: unknown) => Promise<Response>) => (evt: unknown) => handler(evt),
}));

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

vi.mock('$lib/server/middleware/validate', () => ({
    withValidation:
        (handler: (evt: unknown) => Promise<Response>, _schemas: unknown) =>
        async (evt: Record<string, unknown>) => {
            const body = await (evt.request as Request).json();
            return handler({ ...evt, validated: { body } });
        },
}));

vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: (evt: unknown) => Promise<Response>) => (evt: unknown) =>
        handler(evt),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: mockWithTx,
}));

vi.mock('$lib/server/services/watched-state-ops.js', () => ({
    readWatchedStatus: mockReadWatched,
    markWatchedOp: mockMarkWatched,
    markUnwatchedOp: mockMarkUnwatched,
}));

vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    getUserWatchState: { one: mockGetWatchState },
    setUserMediaFavorite: mockSetFavorite,
}));

vi.mock('$lib/server/database/queries/media-type-cache.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/media-type-cache.queries.js')
    >()),
    getMediaType: vi.fn().mockResolvedValue('movie'),
}));

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    getUserRating: { one: mockGetRating },
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
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
    is_favorite: true,
};
const stubRatingRow = { rating: 7 };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('A1 — IDOR regression: checkMediaAccess gate on favorite without watched', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue(fakeSql);
        mockGetWatchState.mockResolvedValue(stubStateRow);
        mockGetRating.mockResolvedValue(stubRatingRow);
        mockReadWatched.mockResolvedValue({ kind: 'ok', watched: true });
        mockMarkWatched.mockResolvedValue({ kind: 'ok', watched: true });
        mockMarkUnwatched.mockResolvedValue({ kind: 'ok', watched: false });
        mockSetFavorite.mockResolvedValue(undefined);
        mockWithTx.mockImplementation(async (sql: unknown, cb: (tx: unknown) => Promise<unknown>) =>
            cb(sql),
        );
    });

    // ── access DENIED ──────────────────────────────────────────────────────────

    it('returns 404 for { favorite: true } when checkMediaAccess → false', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const { PATCH } = await import('./[id]/+server.js');
        const resp = await PATCH!(
            makeEvent({ favorite: true }) as Parameters<NonNullable<typeof PATCH>>[0],
        );

        expect(resp.status).toBe(404);
        const body = await resp.json();
        expect(body.code).toBe('not_found');
    });

    it('does NOT call setUserMediaFavorite when access is denied', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const { PATCH } = await import('./[id]/+server.js');
        await PATCH!(makeEvent({ favorite: true }) as Parameters<NonNullable<typeof PATCH>>[0]);

        expect(mockSetFavorite).not.toHaveBeenCalled();
    });

    it('does NOT call withTx when access is denied', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const { PATCH } = await import('./[id]/+server.js');
        await PATCH!(makeEvent({ favorite: true }) as Parameters<NonNullable<typeof PATCH>>[0]);

        expect(mockWithTx).not.toHaveBeenCalled();
    });

    // ── access GRANTED ─────────────────────────────────────────────────────────

    it('returns 200 for { favorite: true } when checkMediaAccess → true', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);

        const { PATCH } = await import('./[id]/+server.js');
        const resp = await PATCH!(
            makeEvent({ favorite: true }) as Parameters<NonNullable<typeof PATCH>>[0],
        );

        expect(resp.status).toBe(200);
        expect(mockSetFavorite).toHaveBeenCalledOnce();
    });

    // ── watched present — the gate runs for EVERY field combination ───────────
    //
    // These two used to assert the opposite: that `watched` in the body SKIPPED
    // checkMediaAccess, on the reasoning that markWatchedOp does its own check
    // internally, so a second call was redundant. The handler was later
    // deliberately hardened — see defs/watch-state/[id].ts:177 — because the
    // watched op also COMMITS, so letting it be the gate means a denied caller
    // has already written before anyone says no. Access is now checked before
    // anything is written, for every field the request touches.
    //
    // Left as they were, these tests asserted the ABSENCE of a security check:
    // they failed against the hardened handler and would have passed against
    // the weaker one. Inverted to pin the contract that actually holds.

    it('calls checkMediaAccess exactly once when watched is combined with favorite', async () => {
        mockMarkWatched.mockResolvedValue({ kind: 'ok', watched: true });
        mockCheckMediaAccess.mockResolvedValue(true);

        const { PATCH } = await import('./[id]/+server.js');
        await PATCH!(
            makeEvent({ watched: true, favorite: true }) as Parameters<NonNullable<typeof PATCH>>[0],
        );

        // Once — not once per field.
        expect(mockCheckMediaAccess).toHaveBeenCalledOnce();
    });

    it('calls checkMediaAccess for a watched-only body', async () => {
        mockMarkWatched.mockResolvedValue({ kind: 'ok', watched: true });
        mockCheckMediaAccess.mockResolvedValue(true);

        const { PATCH } = await import('./[id]/+server.js');
        await PATCH!(makeEvent({ watched: true }) as Parameters<NonNullable<typeof PATCH>>[0]);

        expect(mockCheckMediaAccess).toHaveBeenCalledOnce();
    });

    it('denies a watched-only body BEFORE the watched op can commit', async () => {
        // The reason the gate moved ahead of markWatchedOp: that op commits, so
        // if it is the gate, a denied caller has already written by the time the
        // 404 is produced.
        mockCheckMediaAccess.mockResolvedValue(false);

        const { PATCH } = await import('./[id]/+server.js');
        const resp = await PATCH!(
            makeEvent({ watched: true }) as Parameters<NonNullable<typeof PATCH>>[0],
        );

        expect(resp.status).toBe(404);
        expect(mockMarkWatched).not.toHaveBeenCalled();
    });
});
