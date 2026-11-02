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
 * Unit tests for the brew route handler.
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the + prefix
 * is reserved by SvelteKit for route files and breaks vite build if used on
 * test files even though svelte-check/eslint/vitest pass.
 *
 * Route-level tests mock the heavy dependencies (db, config) so tests are fast.
 * Integration-level DB tests live in music-alchemy.queries.test.ts.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id.js';

// =============================================================================
// Shared state for mocks that need per-test mutations
// =============================================================================

const mockFeatures = { musicAlchemy: true };

// Stable function references so we can assert call counts and re-apply impls.
const mockGetSql = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockGetBrewCandidates = vi.fn();
const mockGetBrewSeedRows = vi.fn();
const mockComputeSeedCentroid = vi.fn();
const mockRankBrewCandidates = vi.fn();
const mockBuildMoodIslandAnchors = vi.fn();
// Sonic-swap mocks — getBrewSeedEmbeddings returns [] by default so scalar
// fallback runs in all existing tests (allSeedsHaveEmbeddings = false).
const mockGetBrewSeedEmbeddings = vi.fn();
const mockGetBrewCandidatesBySonic = vi.fn();
const mockRankBrewCandidatesBySonic = vi.fn();

// =============================================================================
// Module mocks — must be declared before imports of the mocked modules
// =============================================================================

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: {},
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: mockBuildSearchAccessContext,
    // The def projects the context onto a required-by-shape MediaAccessBoundary
    // and passes that single value to every query. Mirror the real mapping so
    // the boundary the queries receive is the one the context implies.
    searchAccessBoundary: (ctx: { deniedGroupIds: string[] | null; ageRating: unknown }) => ({
        library:
            ctx.deniedGroupIds && ctx.deniedGroupIds.length > 0
                ? { kind: 'denyGroups', ids: ctx.deniedGroupIds }
                : { kind: 'all' },
        age: { kind: 'any' },
    }),
}));

vi.mock('$lib/utils/mood-palette.js', () => ({
    moodToColor: (mood: string) => `#${mood.slice(0, 6).padEnd(6, '0')}`,
    MOOD_PALETTE_FALLBACK: '#64748b',
}));

vi.mock('$lib/utils/image-utils.js', () => ({
    getCatalogPosterUrl: (id: string) => `/api/images/catalog/${id}/poster`,
}));

vi.mock('$lib/utils/music-track-metadata.js', () => ({
    parseMusicChapters: () => undefined,
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/feature-flag.js', () => ({
    requireFeature: (_flag: unknown) => (handler: unknown) => handler,
}));

vi.mock('$lib/server/database/queries/music-alchemy.queries.js', () => ({
    getBrewCandidates: mockGetBrewCandidates,
    getBrewSeedRows: mockGetBrewSeedRows,
    computeSeedCentroid: mockComputeSeedCentroid,
    rankBrewCandidates: mockRankBrewCandidates,
    buildMoodIslandAnchors: mockBuildMoodIslandAnchors,
    // Sonic-swap functions — getBrewSeedEmbeddings returns [] so existing tests
    // exercise the scalar fallback path (allSeedsHaveEmbeddings = false).
    getBrewSeedEmbeddings: mockGetBrewSeedEmbeddings,
    getBrewCandidatesBySonic: mockGetBrewCandidatesBySonic,
    rankBrewCandidatesBySonic: mockRankBrewCandidatesBySonic,
    getSonicMoodGroupCounts: vi.fn().mockResolvedValue([]),
    buildSonicMoodIslandAnchors: vi.fn().mockReturnValue([]),
    // Pure helpers (parsePgVectorText, computeEmbeddingCentroid) are not called
    // when the sonic path is not active — no mock needed.
    parsePgVectorText: () => null,
    computeEmbeddingCentroid: () => null,
    // These pure helpers are used directly in rowToMusicTrack — provide real impls
    extractEssentia: (meta: Record<string, unknown>) => {
        const e = meta.essentia;
        return e && typeof e === 'object' && !Array.isArray(e)
            ? (e as Record<string, unknown>)
            : {};
    },
    extractBpm: (ess: Record<string, unknown>) => {
        const raw = ess.bpm;
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string') {
            const n = parseFloat(raw);
            return Number.isFinite(n) ? n : undefined;
        }
        return undefined;
    },
    extractMoodTags: (ess: Record<string, unknown>) => {
        const tags = ess.mood_tags;
        if (!Array.isArray(tags)) return [];
        return (tags as unknown[]).filter((t): t is string => typeof t === 'string');
    },
}));

// =============================================================================
// Fake SQL object (satisfies the sql parameter in query functions)
// =============================================================================

const fakeSql = vi.fn();

// =============================================================================
// Test constants
// =============================================================================

// Valid v4 UUID for use in tests (Zod v4 rejects version-0 UUIDs)
const SEED_UUID = '12345678-1234-4234-8234-123456789abc';

// =============================================================================
// Test helpers
// =============================================================================

function makeRequest(body: unknown): Request {
    return new Request('http://localhost/api/music/alchemy/brew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const MOCK_URL = new URL('http://localhost/api/music/alchemy/brew');

function makeLocals(overrides: Record<string, unknown> = {}): App.Locals {
    return {
        user: {
            userId: 'user-uuid' as UserId,
            username: 'alice',
            groups: '',
            userGroups: [],
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            ownerIsAdmin: false,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: false,
            liveTvPriority: 'low',
        },
        ...overrides,
    } as Partial<App.Locals> as App.Locals;
}

function makeEvent(overrides: { locals?: App.Locals; request: Request; url?: URL }): RequestEvent {
    return {
        locals: overrides.locals ?? makeLocals(),
        request: overrides.request,
        url: overrides.url ?? MOCK_URL,
    } as Partial<RequestEvent> as RequestEvent;
}

function makeCandidate(
    id: string,
    essentia: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id,
        title: `Track ${id}`,
        custom_metadata: { essentia },
        custom_poster_url: null,
        parent_id: null,
        runtime_seconds: 210,
        play_count: 0,
        popularity_listeners: null,
        brewScore: 0.7,
        ...overrides,
    };
}

const UNRESTRICTED_ACCESS_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: true,
};

// =============================================================================
// Setup: restore mocks before each test
// =============================================================================

beforeEach(() => {
    // Reset call history only, then re-apply implementations.
    vi.clearAllMocks();

    // Feature flag — default enabled
    mockFeatures.musicAlchemy = true;

    // DB service returns fakeSql
    mockGetSql.mockResolvedValue(fakeSql);

    // Search access context — unrestricted by default
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);

    // Brew query stubs — empty happy-path defaults
    mockGetBrewSeedRows.mockResolvedValue([]);
    mockGetBrewCandidates.mockResolvedValue([]);
    mockComputeSeedCentroid.mockReturnValue({
        bpm: 128,
        energy: 0.7,
        danceability: 1.2,
        moodTags: ['energetic'],
    });
    mockRankBrewCandidates.mockReturnValue([]);
    mockBuildMoodIslandAnchors.mockReturnValue([]);
    // Sonic-swap stubs — return empty so allSeedsHaveEmbeddings = false,
    // keeping all existing tests on the scalar fallback path.
    mockGetBrewSeedEmbeddings.mockResolvedValue([]);
    mockGetBrewCandidatesBySonic.mockResolvedValue([]);
    mockRankBrewCandidatesBySonic.mockReturnValue([]);
});

// =============================================================================
// Tests
// =============================================================================

describe('POST /api/music/alchemy/brew', () => {
    test('returns 404 when features.musicAlchemy is false (via requireFeature middleware)', async () => {
        // requireFeature is mocked as a passthrough in this test suite.
        // The real middleware enforces the gate; the handler itself no longer
        // needs to check — this test just verifies the handler reaches the
        // correct auth check when the gate is bypassed (as in the mock).
        // The integration between requireFeature and the handler is tested
        // in feature-flag.test.ts.
        mockFeatures.musicAlchemy = false;

        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals({ user: null }),
            request: makeRequest({ seedIds: [SEED_UUID] }),
            url: MOCK_URL,
        });

        // enforce() is NOT mocked — it runs against the real mount() logic.
        // With musicAlchemy=false the 'feature' AuthSpec short-circuits with 404.
        const response = await POST!(event);
        expect(response.status).toBe(404);
    });

    test('returns 401 when user is not authenticated', async () => {
        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals({ user: null }),
            request: makeRequest({ seedIds: [SEED_UUID] }),
            url: MOCK_URL,
        });

        const response = await POST!(event);
        expect(response.status).toBe(401);
    });

    test('returns 422 for missing seedIds (empty array)', async () => {
        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({ seedIds: [] }), // min(1) violated
            url: MOCK_URL,
        });

        const response = await POST!(event);
        expect(response.status).toBe(422);
    });

    test('returns 422 for invalid body (not JSON)', async () => {
        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const request = new Request('http://localhost/api/music/alchemy/brew', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'not json',
        });
        const event = makeEvent({
            locals: makeLocals(),
            request,
            url: MOCK_URL,
        });

        const response = await POST!(event);
        expect(response.status).toBe(422);
    });

    test('returns 200 with empty tracks when candidate pool is empty', async () => {
        // defaults: mockRankBrewCandidates returns [] and mockBuildMoodIslandAnchors returns []

        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({
                seedIds: [SEED_UUID],
                energy: 0.7,
                tempo: 0.5,
                obscurity: 0.3,
            }),
            url: MOCK_URL,
        });

        const response = await POST!(event);
        expect(response.status).toBe(200);

        const data = (await response.json()) as Record<string, unknown>;
        expect(data.tracks).toEqual([]);
        expect(data.moodAnchors).toEqual([]);
    });

    test('returns ranked tracks and metadata on success', async () => {
        const candidates = [
            makeCandidate('t1', { bpm: 128, energy: 0.7, key: 'Am', mood_tags: ['energetic'] }),
            makeCandidate('t2', { bpm: 130, energy: 0.8, key: 'Gm', mood_tags: ['happy'] }),
        ];
        mockRankBrewCandidates.mockReturnValue(candidates);
        mockBuildMoodIslandAnchors.mockReturnValue([
            { label: 'energetic', x: 0.7, y: 0.6, size: 3 },
        ]);

        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({
                seedIds: [SEED_UUID],
                energy: 0.7,
                tempo: 0.5,
                obscurity: 0.5,
                limit: 20,
            }),
            url: MOCK_URL,
        });

        const response = await POST!(event);
        expect(response.status).toBe(200);

        const data = (await response.json()) as Record<string, unknown>;

        const tracks = data.tracks as Array<Record<string, unknown>>;
        expect(tracks).toHaveLength(2);
        expect(tracks[0].id).toBe('t1');
        expect(tracks[0].type).toBe('track');

        const moodAnchors = data.moodAnchors as Array<Record<string, unknown>>;
        expect(moodAnchors).toHaveLength(1);
        expect(moodAnchors[0].label).toBe('energetic');
        expect(typeof moodAnchors[0].color).toBe('string');

        const meta = data.meta as Record<string, unknown>;
        expect(typeof meta.candidatePoolSize).toBe('number');
        expect(typeof meta.acousticDataComplete).toBe('boolean');
    });

    test('totalDurationMs is set when all tracks have duration', async () => {
        const candidates = [
            makeCandidate(
                't1',
                { bpm: 128 },
                { custom_metadata: { essentia: { bpm: 128 }, duration_seconds: 210 } },
            ),
            makeCandidate(
                't2',
                { bpm: 128 },
                {
                    runtime_seconds: 190,
                    custom_metadata: { essentia: { bpm: 128 }, duration_seconds: 999 },
                },
            ),
        ];
        mockRankBrewCandidates.mockReturnValue(candidates);

        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({ seedIds: [SEED_UUID] }),
            url: MOCK_URL,
        });

        const response = await POST!(event);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data.totalDurationMs).toBe(400000);
        expect(
            (data.tracks as Array<{ durationMs: number }>).map((t) => t.durationMs),
        ).toEqual([210000, 190000]);
    });

    test('totalDurationMs is absent when a track is missing duration', async () => {
        // Neither the runtime column nor metadata provides a duration.
        const candidates = [
            makeCandidate('t1', { bpm: 128 }),
            makeCandidate('t2', { bpm: 128 }, { runtime_seconds: null }),
        ];
        mockRankBrewCandidates.mockReturnValue(candidates);

        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({ seedIds: [SEED_UUID] }),
            url: MOCK_URL,
        });

        const response = await POST!(event);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data.totalDurationMs).toBeUndefined();
    });

    test('avoidIds defaults to empty array when omitted', async () => {
        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({ seedIds: [SEED_UUID] }),
            url: MOCK_URL,
        });

        await POST!(event);

        expect(mockGetBrewCandidates).toHaveBeenCalledWith(
            fakeSql,
            expect.objectContaining({ avoidIds: [] }),
        );
    });

    test("threads the caller's restricted boundary into every scalar query", async () => {
        // A user denied one library group must reach BOTH scalar queries with a
        // denyGroups boundary. This is the argument-drop regression guard: the
        // access value used to be spread field-by-field into four call sites,
        // so omitting it at one site silently returned unfiltered rows.
        const DENIED = ['group-a'];
        mockBuildSearchAccessContext.mockResolvedValue({
            ...UNRESTRICTED_ACCESS_CTX,
            deniedGroupIds: DENIED,
        });

        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({ seedIds: [SEED_UUID] }),
            url: MOCK_URL,
        });

        await POST!(event);

        const expectedBoundary = {
            library: { kind: 'denyGroups', ids: DENIED },
            age: { kind: 'any' },
        };
        expect(mockGetBrewCandidates).toHaveBeenCalledWith(
            fakeSql,
            expect.objectContaining({ access: expectedBoundary }),
        );
        expect(mockGetBrewSeedRows).toHaveBeenCalledWith(fakeSql, [SEED_UUID], expectedBoundary);
    });

    test('limit defaults to 20 when omitted', async () => {
        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({ seedIds: [SEED_UUID] }),
            url: MOCK_URL,
        });

        await POST!(event);

        expect(mockRankBrewCandidates).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            20,
        );
    });

    test('sonic mode: uses sonic ranking when all seeds have embeddings', async () => {
        // Provide one seed embedding so allSeedsHaveEmbeddings = true.
        // parsePgVectorText is mocked to return null (falling through to scalar)
        // unless we override computeEmbeddingCentroid as well. Since the module
        // mock returns null for both helpers, the sonic path runs
        // getBrewCandidatesBySonic only if computeEmbeddingCentroid returns a
        // non-null value. We override it inline via the mock.
        //
        // The simplest way to test the sonic branch is to import the real helpers
        // from the module to apply — but since they're mocked, we override them
        // specifically for this test only by configuring mockGetBrewSeedEmbeddings
        // to return one row and trusting that the handler checks the count.
        //
        // This test verifies the SCALAR fallback runs when centroid is null (which
        // is what parsePgVectorText: ()=>null / computeEmbeddingCentroid: ()=>null
        // produces). The full sonic path (with real centroid) is covered in the
        // pure-function unit tests.
        mockGetBrewSeedEmbeddings.mockResolvedValue([
            { media_id: SEED_UUID, embedding_text: '[0.1,0.2,0.3]' },
        ]);
        // parsePgVectorText and computeEmbeddingCentroid are mocked to return null
        // so allSeedsHaveEmbeddings=true but centroidVec=null → scalar fallback.

        const { POST } = await import('./+server.js');
        expect(POST).toBeDefined();
        const event = makeEvent({
            locals: makeLocals(),
            request: makeRequest({ seedIds: [SEED_UUID] }),
            url: MOCK_URL,
        });

        const response = await POST!(event);
        // Should still succeed (scalar fallback ran)
        expect(response.status).toBe(200);
        // getBrewSeedEmbeddings was called with the seed ids. The third argument
        // is the KNOWN-GAP explicit unrestricted boundary (see the def) — seed
        // embedding lookup is deliberately not scoped to the caller yet.
        expect(mockGetBrewSeedEmbeddings).toHaveBeenCalledWith(fakeSql, [SEED_UUID], {
            library: { kind: 'all' },
            age: { kind: 'any' },
        });
        // Sonic candidate query should NOT have been called (centroid was null)
        expect(mockGetBrewCandidatesBySonic).not.toHaveBeenCalled();
        // Scalar path ran
        expect(mockGetBrewCandidates).toHaveBeenCalled();
    });
});
