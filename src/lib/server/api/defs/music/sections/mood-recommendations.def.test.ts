// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

/**
 * Guards the published contract of the music mood-recommendations def:
 * a per-user rate limit (its ?cursor= path bypasses the cache by design and is
 * an uncached pgvector keyset scan) and the sonicQueue feature 404.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckRateLimit = vi.fn();
const mockGetSql = vi.fn();
const mockFeatures: Record<string, boolean> = {};

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    // Faithful stand-in for the real helper: it sets the X-RateLimit-*
    // headers on the response it is handed and returns that same response.
    withRateLimitHeaders: (
        response: Response,
        result: { total: number; remaining: number; resetAt: number },
    ) => {
        response.headers.set('X-RateLimit-Limit', String(result.total));
        response.headers.set('X-RateLimit-Remaining', String(result.remaining));
        response.headers.set('X-RateLimit-Reset', String(result.resetAt));
        return response;
    },
}));

// Other modules pulled in transitively (task registry, etc.) read further
// config/feature exports beyond `sonicQueue`, so this mutates the real
// `features` object in place rather than replacing the module — every other
// export stays live, only `sonicQueue` is ever overridden by a test.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    Object.assign(mockFeatures, actual.features);
    return { ...actual, features: mockFeatures };
});

// The handler checks DB-availability before the rate limit (auth → feature
// gate → DB → rate limit), so this must resolve a usable value or every
// request 503s before the limiter is ever reached.
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/services/music/mood-page.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/music/mood-page.service.js')>()),
    getCachedMoodPage: vi.fn(async () => ({ rows: [], nextCursor: 'mood-next' })),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({ deniedGroupIds: null, ageRating: null })),
}));
vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

const { def } = await import('./mood-recommendations.js');

function makeEvent(query = '?mood=chill'): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL(`http://localhost/api/v1/music/mood-recommendations${query}`),
        params: {},
        request: new Request(`http://localhost/api/v1/music/mood-recommendations${query}`),
    } as unknown as RequestEvent;
}

describe('mood-recommendations published contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.sonicQueue = true;
        mockGetSql.mockResolvedValue({});
        mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
    });

    it('returns 404 when sonicQueue is disabled', async () => {
        mockFeatures.sonicQueue = false;
        const res = await def.handlers.GET!(makeEvent(), {} as never);
        expect(res.status).toBe(404);
    });

    it('returns 429 when the per-user limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            resetAt: Date.now() / 1000 + 30,
        });
        const res = await def.handlers.GET!(makeEvent(), {} as never);
        expect(res.status).toBe(429);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('u1'),
            expect.any(Number),
            expect.any(Number),
        );
    });
    it('returns items and page metadata rather than tracks or a top-level cursor', async () => {
        const res = await def.handlers.GET!(makeEvent(), { surface: 'v1' });
        const body = await res.json();
        expect(body).toEqual({
            items: [],
            mood: 'chill',
            page: { limit: 20, hasMore: true, nextCursor: 'mood-next' },
        });
        expect(body).not.toHaveProperty('tracks');
        expect(body).not.toHaveProperty('nextCursor');
    });
});
