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

import type { MusicSearchResultItem as Track } from '$lib/schemas/api-music-responses';
/**
 * Unit tests for GET /api/music/lyrics-search.
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files (even though svelte-check/eslint/vitest pass).
 *
 * All heavy dependencies (db, config, access checks, embedding, query) are
 * mocked so tests run fast without a real database or embedding provider.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Shared mutable mock state
// ---------------------------------------------------------------------------

const mockFeatures = { lyricsSearch: true };

const mockGetSql = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockSearchByLyricsEmbedding = vi.fn();
const mockGenerateVoyageQueryEmbedding = vi.fn();
const mockIsVoyageAvailable = vi.fn(() => true);

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('$lib/server/config.js', () => ({
    config: {},
    features: mockFeatures,
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

// Only buildSearchAccessContext is stubbed. searchAccessBoundary keeps its real
// implementation so the projection from context -> MediaAccessBoundary is
// genuinely exercised rather than faked.
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: mockBuildSearchAccessContext,
    };
});

vi.mock('$lib/server/database/queries/lyrics-search.queries.js', () => ({
    searchByLyricsEmbedding: mockSearchByLyricsEmbedding,
}));

vi.mock('$lib/server/ai/voyage.js', () => ({
    generateVoyageQueryEmbedding: mockGenerateVoyageQueryEmbedding,
    isVoyageAvailable: mockIsVoyageAvailable,
}));

vi.mock('$lib/server/tasks/api-auth.js', () => ({
    authenticate: vi.fn(),
    requireScope: vi.fn(),
    scopeGranted: vi.fn().mockReturnValue(false),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

const fakeSql = vi.fn();

const UNRESTRICTED_ACCESS_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: true,
};

const FAKE_EMBEDDING = Array.from({ length: 1024 }, (_, i) => i / 1024);

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

function makeEvent(searchParams: Record<string, string> = {}, locals?: App.Locals): RequestEvent {
    const url = new URL('http://localhost/api/music/lyrics-search');
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
    return {
        url,
        request: new Request(url.toString()),
        locals: locals ?? makeLocals(),
    } as Partial<RequestEvent> as RequestEvent;
}

function makeLyricsRow(id: string, score = 0.85): Record<string, unknown> {
    return {
        media_id: id,
        similarity_score: score,
        title: `Track ${id}`,
        custom_poster_url: '/cover.jpg',
        custom_metadata: {},
        runtime_seconds: 210,
        artist_title: 'Artist',
        album_id: null,
        album_title: null,
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();

    mockFeatures.lyricsSearch = true;
    mockGetSql.mockResolvedValue(fakeSql);
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);
    mockGenerateVoyageQueryEmbedding.mockResolvedValue(FAKE_EMBEDDING);
    mockIsVoyageAvailable.mockReturnValue(true);
    mockSearchByLyricsEmbedding.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/music/lyrics-search', () => {
    test('returns 401 when user is not authenticated', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'moonlight' }, makeLocals({ user: null }));
        const response = await GET!(event);
        expect(response.status).toBe(401);
    });

    test('returns 503 when database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'moonlight' });
        const response = await GET!(event);
        expect(response.status).toBe(503);
    });

    test('returns 422 when q param is missing', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({});
        const response = await GET!(event);
        expect(response.status).toBe(422);
    });

    test('returns 422 when q param is blank', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: '   ' });
        const response = await GET!(event);
        expect(response.status).toBe(422);
    });

    test('returns 503 when embedding provider is unavailable', async () => {
        mockIsVoyageAvailable.mockReturnValue(false);
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'moonlight' });
        const response = await GET!(event);
        expect(response.status).toBe(503);
    });

    test('returns 503 when embedding generation fails', async () => {
        mockGenerateVoyageQueryEmbedding.mockResolvedValue(null);
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'moonlight' });
        const response = await GET!(event);
        expect(response.status).toBe(503);
    });

    test('returns 200 with empty items when no results found', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'moonlight' });
        const response = await GET!(event);
        expect(response.status).toBe(200);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data.items).toEqual([]);
        expect(data.page).toEqual({ limit: 20, truncated: false });
    });

    test('returns mapped MusicTrack objects on success', async () => {
        const rows = [
            makeLyricsRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 0.92),
            makeLyricsRow('11111111-2222-4333-8444-555555555555', 0.78),
        ];
        mockSearchByLyricsEmbedding.mockResolvedValue(rows);

        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'moonlight dancing' });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        const data = (await response.json()) as Record<string, unknown>;
        const items = data.items as Track[];
        expect(items).toHaveLength(2);
        expect(items[0].id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(items[0].type).toBe('track');
        expect(items[0].artists[0]?.title).toBe('Artist');
        expect(items[0].similarityScore).toBe(0.92);
    });

    test('returns 422 when limit exceeds max of 50', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'rain', limit: '100' }); // over max → schema rejects with 422
        const response = await GET!(event);
        expect(response.status).toBe(422);
        expect(mockSearchByLyricsEmbedding).not.toHaveBeenCalled();
    });

    test('uses default limit of 20 when limit param is absent', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'rain' });
        await GET!(event);
        // The def fetches limit+1 rows to detect truncated without a second round-trip.
        expect(mockSearchByLyricsEmbedding).toHaveBeenCalledWith(
            fakeSql,
            FAKE_EMBEDDING,
            21,
            // An unrestricted context projects to the explicit unrestricted
            // boundary — not to an omitted/permissive argument.
            { library: { kind: 'all' }, age: { kind: 'any' } },
        );
    });

    test('passes trimmed query to generateVoyageQueryEmbedding', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: '  moonlight  ' });
        await GET!(event);
        expect(mockGenerateVoyageQueryEmbedding).toHaveBeenCalledWith('moonlight');
    });

    test('projects the access context into a MediaAccessBoundary on both axes', async () => {
        const restrictedCtx = {
            ...UNRESTRICTED_ACCESS_CTX,
            deniedGroupIds: ['group-uuid-1'],
            ageRating: { maxAgeRating: 12, allowUnrated: false },
        };
        mockBuildSearchAccessContext.mockResolvedValue(restrictedCtx);

        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'stars' });
        await GET!(event);

        // The def fetches limit+1 rows to detect truncated without a second round-trip.
        expect(mockSearchByLyricsEmbedding).toHaveBeenCalledWith(fakeSql, FAKE_EMBEDDING, 21, {
            library: { kind: 'denyGroups', ids: ['group-uuid-1'] },
            age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
        });
    });

    test('response conforms to { items, page } envelope', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ q: 'dancing under the stars' });
        const response = await GET!(event);
        expect(response.status).toBe(200);
        const data = (await response.json()) as Record<string, unknown>;
        expect(Array.isArray(data.items)).toBe(true);
        expect(data.page).toEqual({ limit: 20, truncated: false });
    });
});
