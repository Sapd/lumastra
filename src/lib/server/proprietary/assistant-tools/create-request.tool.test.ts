// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `create_request` WRITE tool.
 *
 * `requestManager` is mocked, so these cover the two-phase confirmation, the
 * refusal surface, and the duplicate guard — NOT Jellyseerr behaviour. The one
 * thing they are designed to make impossible is a submission on a call the
 * user never confirmed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
}));
vi.mock('../../database/queries/media-lookup.queries.js', () => ({
    getExternalIdsByMediaId: vi.fn(),
}));
vi.mock('$lib/server/services/request-manager.service.js', () => ({
    requestManager: {
        canRequest: vi.fn(() => true),
        findExistingRequest: vi.fn(async () => null),
        getRemainingQuota: vi.fn(async () => null),
        createRequest: vi.fn(),
    },
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    // peek is the dedupe GATE; checkRateLimit only consumes the token, and only
    // after something was actually submitted.
    peekRateLimit: vi.fn(),
    checkRateLimit: vi.fn(),
}));

// Backs confirm-gate.ts's hard two-phase confirm (P5) — a tiny in-memory
// stand-in for Valkey so markPendingConfirmation/isConfirmedFromEarlierInvocation
// exercise real read/write behaviour instead of being mocked away themselves.
// importOriginal: other modules pulled in transitively (e.g.
// search-access-context.ts → library-group-permissions-cache.ts) call
// subscribeToChannel() at import time, so a full replacement mock breaks them.
const confirmStore = new Map<string, string>();
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return {
        ...actual,
        isCoordinationValkeyReady: () => true,
        cacheGet: vi.fn(async (key: string) => confirmStore.get(key) ?? null),
        setEx: vi.fn(async (key: string, _seconds: number, value: string) => {
            confirmStore.set(key, value);
            return true;
        }),
    };
});

/**
 * `checkRateLimit` doubles as the per-title duplicate guard here. Its result
 * type is not exported, so it is derived rather than restated.
 */
type RateLimitResult = Awaited<ReturnType<typeof checkRateLimit>>;

const rateLimit = (allowed: boolean): RateLimitResult => ({
    allowed,
    resetAt: 0,
    remaining: allowed ? 1 : 0,
    total: 1,
});

import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { getExternalIdsByMediaId } from '../../database/queries/media-lookup.queries.js';
import { requestManager } from '$lib/server/services/request-manager.service.js';
import { checkRateLimit, peekRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { createRequestTool } from './create-request.tool.js';
import { createRequestArgsSchema } from '../../../schemas/assistant-tools.js';
import { assistantTestUser } from './test-context.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

function makeCtx(over: Partial<AssistantToolContext> = {}): AssistantToolContext {
    return {
        sql: {} as never,
        userId: ALICE,
        userIsAdmin: false,
        user: assistantTestUser({ hasRequestPermission: true }),
        writesAllowed: true,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
        ...over,
    };
}

const ghost = {
    media_id: '66666666-6666-4666-8666-666666666666',
    primary_ext_id: '693134',
    title: 'Dawn: Part Two',
    media_type: 'movie',
    release_date: '2024-01-01',
    is_available: false,
    can_request: true,
} as AssistantMovieRow;

function body(res: { summaryForModel: string }): Record<string, unknown> {
    return JSON.parse(res.summaryForModel);
}

describe('createRequestTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        confirmStore.clear();
        vi.mocked(requestManager.canRequest).mockReturnValue(true);
        vi.mocked(requestManager.findExistingRequest).mockResolvedValue(null);
        vi.mocked(requestManager.getRemainingQuota).mockResolvedValue(null);
        vi.mocked(peekRateLimit).mockResolvedValue(rateLimit(true));
        vi.mocked(checkRateLimit).mockResolvedValue(rateLimit(true));
        vi.mocked(searchMediaByTitle).mockResolvedValue([ghost]);
        vi.mocked(getExternalIdsByMediaId).mockResolvedValue([
            { provider: 'tmdb', external_id: '693134' },
        ] as never);
    });

    it('requires an explicit confirmed flag and rejects a model-supplied mediaId', () => {
        expect(createRequestArgsSchema.safeParse({ title: 'Dawn' }).success).toBe(false);
        expect(
            createRequestArgsSchema.safeParse({ title: 'Dawn', confirmed: true, mediaId: 'x' })
                .success,
        ).toBe(false);
        expect(createRequestArgsSchema.safeParse({ title: 'Dawn', confirmed: false }).success).toBe(
            true,
        );
    });

    it('submits NOTHING on the unconfirmed call and names the resolved title', async () => {
        const res = await createRequestTool.execute(
            { title: 'Dawn Part Two', confirmed: false },
            makeCtx(),
        );
        const b = body(res);
        expect(requestManager.createRequest).not.toHaveBeenCalled();
        expect(b.ok).toBe(false);
        expect(b.reason).toBe('confirmation_required');
        expect(b.title).toBe('Dawn: Part Two');
        expect(b.year).toBe(2024);
        expect(b.note).toContain('NOTHING was requested.');
    });

    it('submits on the confirmed call and never calls it available', async () => {
        vi.mocked(requestManager.createRequest).mockResolvedValue({
            kind: 'created',
            requestId: 812,
            requestedAt: '2026-08-20T00:00:00.000Z',
        });

        const b = body(
            await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx()),
        );
        expect(b.ok).toBe(true);
        expect(b.action).toBe('requested');
        expect(b.requestId).toBe(812);
        expect(b.note).toContain('NOT available yet');

        const params = vi.mocked(requestManager.createRequest).mock.calls[0][0];
        // IDs come from the row we resolved, never from the model.
        expect(params.externalIds).toEqual({ tmdb: '693134' });
        expect(params.mediaType).toBe('movie');
        expect(params.effectiveUsername).toBe('alice');
    });

    // The peek/consume split is the fix for a real incident, and nothing
    // asserted on the CONSUME half: reintroducing the bug — calling
    // checkRateLimit before the switch, or on every outcome — left the whole
    // suite green. These two pin both directions.
    it('consumes the dedupe token once something was actually submitted', async () => {
        vi.mocked(requestManager.createRequest).mockResolvedValue({
            kind: 'created',
            requestId: 812,
            requestedAt: '2026-08-20T00:00:00.000Z',
        });

        await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx());

        expect(checkRateLimit).toHaveBeenCalledTimes(1);
        // Same key the peek gated on, or the two halves guard different things.
        expect(vi.mocked(checkRateLimit).mock.calls[0][0]).toBe(
            vi.mocked(peekRateLimit).mock.calls[0][0],
        );
    });

    it('leaves the token unspent when the submission failed', async () => {
        // Jellyseerr unreachable means NOTHING was requested. Burning the token
        // here made the user's immediate "try again" hit `duplicate_call`,
        // whose note tells the model to say it is already on its way — the one
        // payload whose prose asserts an action that did not happen.
        vi.mocked(requestManager.createRequest).mockResolvedValue({
            kind: 'create_failed',
        } as never);

        await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx());

        expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it('does not submit twice for the same title in one round', async () => {
        // The dedupe GATE is the peek — a spent token means "already submitted".
        vi.mocked(peekRateLimit).mockResolvedValue(rateLimit(false));
        const b = body(
            await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx()),
        );
        expect(requestManager.createRequest).not.toHaveBeenCalled();
        expect(b.reason).toBe('duplicate_call');
    });

    it('reports an existing request instead of firing a duplicate', async () => {
        vi.mocked(requestManager.findExistingRequest).mockResolvedValue({
            requestId: 5,
            status: 'pending',
        });
        const b = body(
            await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx()),
        );
        expect(requestManager.createRequest).not.toHaveBeenCalled();
        expect(b.ok).toBe(true);
        expect(b.action).toBe('noop');
        expect(b.alreadyRequested).toBe(true);
        expect(b.status).toBe('pending');
    });

    it('refuses a title that is already in the library', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            { ...ghost, is_available: true } as AssistantMovieRow,
        ]);
        const b = body(
            await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx()),
        );
        expect(b.reason).toBe('already_available');
        expect(requestManager.createRequest).not.toHaveBeenCalled();
    });

    it('refuses a title with no resolvable provider id', async () => {
        vi.mocked(getExternalIdsByMediaId).mockResolvedValue([
            { provider: 'jellyfin', external_id: 'abc' },
        ] as never);
        const b = body(
            await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx()),
        );
        expect(b.reason).toBe('no_tmdb_id');
        expect(requestManager.createRequest).not.toHaveBeenCalled();
    });

    it('reports an exhausted quota with the numbers, and that nothing was requested', async () => {
        vi.mocked(requestManager.createRequest).mockResolvedValue({
            kind: 'quota_exceeded',
            bucket: 'movie',
            limit: 5,
            used: 5,
            days: 7,
        });
        const b = body(
            await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx()),
        );
        expect(b.reason).toBe('quota_exceeded');
        expect(b.limit).toBe(5);
        expect(b.resetsInDays).toBe(7);
        expect(b.note).toContain('NOTHING was requested.');
    });

    it('refuses a caller without request permission', async () => {
        vi.mocked(requestManager.canRequest).mockReturnValue(false);
        const b = body(
            await createRequestTool.execute({ title: 'Dawn Part Two', confirmed: true }, makeCtx()),
        );
        expect(b.reason).toBe('not_permitted');
        expect(searchMediaByTitle).not.toHaveBeenCalled();
    });

    it('refuses when this run may not write', async () => {
        const b = body(
            await createRequestTool.execute(
                { title: 'Dawn', confirmed: true },
                makeCtx({ writesAllowed: false }),
            ),
        );
        expect(b.reason).toBe('not_allowed');
        expect(requestManager.createRequest).not.toHaveBeenCalled();
    });

    it('never reveals whether an inaccessible title exists', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([]);
        const b = body(
            await createRequestTool.execute({ title: 'Secret', confirmed: true }, makeCtx()),
        );
        expect(b.reason).toBe('not_found');
        expect(b.note).toContain('NOTHING was requested.');
    });

    // -------------------------------------------------------------------------
    // P5: hard two-phase confirm gate (confirm-gate.ts)
    // -------------------------------------------------------------------------
    //
    // These use an explicit invocationId (the dispatch loop always sets one —
    // see dispatch.ts / AssistantToolContext.invocationId). Every test ABOVE
    // this block omits invocationId, exercising the "no real loop invocation"
    // bypass (confirm-gate.ts) unchanged.
    describe('P5: hard confirm gate', () => {
        it('confirmed:true in the SAME invocation as the confirmed:false call is refused — createRequest never called', async () => {
            await createRequestTool.execute(
                { title: 'Dawn Part Two', confirmed: false },
                makeCtx({ invocationId: 'inv-A' }),
            );

            const b = body(
                await createRequestTool.execute(
                    { title: 'Dawn Part Two', confirmed: true },
                    makeCtx({ invocationId: 'inv-A' }),
                ),
            );

            expect(requestManager.createRequest).not.toHaveBeenCalled();
            expect(b.ok).toBe(false);
            expect(b.reason).toBe('confirmation_required');
        });

        it('confirmed:true with NO prior confirmed:false call at all is refused', async () => {
            const b = body(
                await createRequestTool.execute(
                    { title: 'Dawn Part Two', confirmed: true },
                    makeCtx({ invocationId: 'inv-A' }),
                ),
            );
            expect(requestManager.createRequest).not.toHaveBeenCalled();
            expect(b.reason).toBe('confirmation_required');
        });

        it('confirmed:true from a DIFFERENT (later) invocation than the confirmed:false call SUCCEEDS', async () => {
            vi.mocked(requestManager.createRequest).mockResolvedValue({
                kind: 'created',
                requestId: 812,
                requestedAt: '2026-08-20T00:00:00.000Z',
            });

            await createRequestTool.execute(
                { title: 'Dawn Part Two', confirmed: false },
                makeCtx({ invocationId: 'inv-A' }),
            );

            const b = body(
                await createRequestTool.execute(
                    { title: 'Dawn Part Two', confirmed: true },
                    makeCtx({ invocationId: 'inv-B' }),
                ),
            );

            expect(requestManager.createRequest).toHaveBeenCalledTimes(1);
            expect(b.ok).toBe(true);
            expect(b.action).toBe('requested');
        });
    });
});
