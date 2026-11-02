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
 * POST /api/music/alchemy/brew — seed embeddings must be resolved within the
 * caller's own access boundary (library/age), not `unrestrictedAccess()`.
 *
 * Before the fix, `getBrewSeedEmbeddings` was always called with
 * `unrestrictedAccess()`: a user could pass a seedId for a track outside
 * their library/age scope and have it steer the sonic centroid — the row
 * count of `seedEmbeddingRows` (via `allSeedsHaveEmbeddings`) also leaked
 * whether that out-of-scope track exists and has an embedding at all
 * (an inference oracle). `getBrewCandidatesBySonic` was always correctly
 * scoped, so the leak was inference-only, not direct data exposure.
 *
 * These tests assert the call-site contract rather than re-testing SQL
 * filtering (covered by `music-alchemy.queries.ts`'s own tests): the exact
 * boundary the caller resolved must reach `getBrewSeedEmbeddings`, and the
 * def's branch behaviour (sonic vs. scalar/acoustic fallback) must follow
 * whatever that boundary allows through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';

const mockGetSql = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockGetBrewSeedEmbeddings = vi.fn();
const mockGetBrewSeedRows = vi.fn();
const mockGetBrewCandidates = vi.fn();
const mockGetBrewCandidatesBySonic = vi.fn();
const mockGetSonicMoodGroupCounts = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    // Real implementation is pure and deterministic; keeping it real makes the
    // resulting boundary shape below (deny group g1) unambiguous evidence
    // that THIS boundary — not unrestrictedAccess() — reached the query.
    searchAccessBoundary: (ctx: { deniedGroupIds?: string[]; ageRating?: unknown }) => ({
        library:
            ctx.deniedGroupIds && ctx.deniedGroupIds.length > 0
                ? { kind: 'denyGroups', ids: [...ctx.deniedGroupIds] }
                : { kind: 'all' },
        age: { kind: 'any' },
    }),
}));

// Query module partially mocked: DB-touching functions are stubbed, the pure
// scoring/parsing helpers stay real so the def's branch logic (sonic vs.
// scalar) is exercised faithfully rather than re-implemented in the test.
vi.mock('$lib/server/database/queries/music-alchemy.queries.js', async () => {
    const actual = await vi.importActual<
        typeof import('$lib/server/database/queries/music-alchemy.queries.js')
    >('$lib/server/database/queries/music-alchemy.queries.js');
    return {
        ...actual,
        getBrewSeedEmbeddings: (...args: unknown[]) => mockGetBrewSeedEmbeddings(...args),
        getBrewSeedRows: (...args: unknown[]) => mockGetBrewSeedRows(...args),
        getBrewCandidates: (...args: unknown[]) => mockGetBrewCandidates(...args),
        getBrewCandidatesBySonic: (...args: unknown[]) => mockGetBrewCandidatesBySonic(...args),
        getSonicMoodGroupCounts: (...args: unknown[]) => mockGetSonicMoodGroupCounts(...args),
    };
});

const { def } = await import('./alchemy-brew.js');

const SEED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL('http://localhost/api/music/alchemy/brew'),
        params: {},
        request: new Request('http://localhost/api/music/alchemy/brew', { method: 'POST' }),
    } as unknown as RequestEvent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCtx(seedIds: string[]): any {
    return {
        surface: 'internal' as const,
        input: {
            body: { seedIds, avoidIds: [], energy: 0.5, tempo: 0.5, obscurity: 0.5, limit: 20 },
        },
    };
}

const DENIED_GROUP_BOUNDARY: MediaAccessBoundary = {
    library: { kind: 'denyGroups', ids: ['g1'] },
    age: { kind: 'any' },
};
const UNRESTRICTED_BOUNDARY: MediaAccessBoundary = {
    library: { kind: 'all' },
    age: { kind: 'any' },
};

describe('alchemy-brew seed embedding access boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockBuildSearchAccessContext.mockResolvedValue({ deniedGroupIds: ['g1'] });
        mockGetBrewSeedRows.mockResolvedValue([]);
        mockGetBrewCandidates.mockResolvedValue([]);
        mockGetBrewCandidatesBySonic.mockResolvedValue([]);
        mockGetSonicMoodGroupCounts.mockResolvedValue([]);
    });

    it('passes the caller-scoped access boundary to getBrewSeedEmbeddings, not unrestrictedAccess', async () => {
        mockGetBrewSeedEmbeddings.mockResolvedValue([]);

        await def.handlers.POST!(makeEvent(), makeCtx([SEED_ID]));

        expect(mockGetBrewSeedEmbeddings).toHaveBeenCalledTimes(1);
        const [, , accessArg] = mockGetBrewSeedEmbeddings.mock.calls[0];
        expect(accessArg).toEqual(DENIED_GROUP_BOUNDARY);
        expect(accessArg).not.toEqual(UNRESTRICTED_BOUNDARY);
    });

    it('an out-of-boundary seed (excluded by the DB filter) falls back to the scalar/acoustic path', async () => {
        // Simulates the DB enforcing the boundary: the seed belongs to a
        // denied group, so the scoped query returns no embedding row for it.
        mockGetBrewSeedEmbeddings.mockResolvedValue([]);

        const res = await def.handlers.POST!(makeEvent(), makeCtx([SEED_ID]));

        expect(res.status).toBe(200);
        // Sonic path never entered: no sonic candidate query issued.
        expect(mockGetBrewCandidatesBySonic).not.toHaveBeenCalled();
        // Scalar fallback path was used instead.
        expect(mockGetBrewSeedRows).toHaveBeenCalledTimes(1);
        expect(mockGetBrewCandidates).toHaveBeenCalledTimes(1);

        const body = await res.json();
        expect(body.meta.acousticDataComplete).toBe(true); // empty tracks => vacuously true, acoustic path
    });

    it('an in-scope seed with an embedding still enters sonic mode', async () => {
        mockGetBrewSeedEmbeddings.mockResolvedValue([
            { media_id: SEED_ID, embedding_text: '[0.1,0.2,0.3]' },
        ]);

        await def.handlers.POST!(makeEvent(), makeCtx([SEED_ID]));

        expect(mockGetBrewCandidatesBySonic).toHaveBeenCalledTimes(1);
        expect(mockGetBrewSeedRows).not.toHaveBeenCalled();
        expect(mockGetBrewCandidates).not.toHaveBeenCalled();
    });
});
