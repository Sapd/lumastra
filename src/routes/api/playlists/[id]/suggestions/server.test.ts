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

import type { Track } from '$lib/schemas/api-music-dto';
/**
 * Unit tests for GET /api/playlists/42/suggestions.
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files (even though svelte-check/eslint/vitest pass).
 *
 * All heavy dependencies (db, config, query functions, access checks) are
 * mocked so tests run fast without a real database.
 *
 * Key contracts verified:
 *   - Uses sonic path when features.sonicEmbeddings=true AND sonicCount>=3
 *     AND sonic returns non-empty rows.
 *   - Falls back to metadata when sonicEmbeddings=false.
 *   - Falls back to metadata when sonicCount < 3.
 *   - Falls back to metadata when sonic returns empty rows.
 *   - Response shape is identical regardless of which path was taken.
 *   - source field is 'sonic' or 'metadata' in the response body.
 *   - Access filtering (filterAccessibleRows) is always applied.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Shared mutable mock state — mutated in beforeEach / individual tests
// ---------------------------------------------------------------------------

const mockFeatures = { sonicEmbeddings: true };

const mockGetSql = vi.fn();
const mockGetPlaylistSuggestionsFull = vi.fn();
const mockGetPlaylistSuggestionsViaSonic = vi.fn();
const mockCountPlaylistSonicEmbeddings = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockFilterAccessibleRows = vi.fn();

// ---------------------------------------------------------------------------
// Module mocks — MUST be declared before any import of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('$lib/server/utils/playlist-utils.js', () => ({
    getUserRole: async () => ({ role: 'readonly' }),
}));

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: {},
    FEATURE_PER_TASK_QUEUES: false,
    FEATURE_AUDIT_TAMPER_EVIDENCE: false,
    FEATURE_PIPELINE_EVENT_OUTBOX: false,
    FEATURE_PLUGIN_WORKER_ISOLATION: false,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getPlaylistSuggestionsFull: mockGetPlaylistSuggestionsFull,
    getPlaylistSuggestionsViaSonic: mockGetPlaylistSuggestionsViaSonic,
    countPlaylistSonicEmbeddings: mockCountPlaylistSonicEmbeddings,
}));

// `searchAccessBoundary` is deliberately NOT stubbed: the route now passes a
// required-by-shape MediaAccessBoundary to filterAccessibleRows, and the
// boundary assertion below is only meaningful against the real projection.
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: mockBuildSearchAccessContext,
    };
});

vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: mockFilterAccessibleRows,
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: unknown) => handler,
}));

vi.mock('$lib/server/api/defs/catalog/media-id.js', () => ({
    buildImageRefs: (id: string, surface: 'internal' | 'v1') => ({
        poster: {
            href: `${surface === 'v1' ? '/api/v1' : '/api'}/media/${id}/images/poster`,
            thumb: `${surface === 'v1' ? '/api/v1' : '/api'}/media/${id}/images/poster?size=thumb`,
            card: `${surface === 'v1' ? '/api/v1' : '/api'}/media/${id}/images/poster?size=card`,
            full: `${surface === 'v1' ? '/api/v1' : '/api'}/media/${id}/images/poster?size=full`,
        },
    }),
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PLAYLIST_ID = 42;
const USER_UUID = 'aaaaaaaa-1111-4111-8111-111111111111';

const UNRESTRICTED_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: true,
};

/** A minimal PlaylistSuggestionFullRow. */
function makeSuggestionRow(id: string, score = 0.85): Record<string, unknown> {
    return {
        id,
        title: `Track ${id}`,
        runtime_seconds: 210,
        custom_poster_url: null,
        artist_title: 'Test Artist',
        album_title: 'Test Album',
        similarity_score: score,
    };
}

/** Two rows used across tests. */
const ROW_A = makeSuggestionRow('row-uuid-aaaa');
const ROW_B = makeSuggestionRow('row-uuid-bbbb', 0.75);

/**
 * Build a fake sql tagged-template function whose `SELECT p.id` access check
 * returns a row (playlist found + accessible). The sql mock returns an array
 * with one row for the playlist access query and empty arrays for anything else.
 */
function makeAccessiblePlaylistSql(): unknown {
    // The endpoint runs: sql`SELECT p.id ...` → expects [{id: PLAYLIST_ID}]
    // We make the mock always return [{id: PLAYLIST_ID}] for any template call.
    const fakeSql = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
        Promise.resolve([{ id: PLAYLIST_ID }])) as unknown;
    return fakeSql;
}

function makeLocals(overrides: Record<string, unknown> = {}): App.Locals {
    return {
        user: {
            userId: USER_UUID as UserId,
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

function makeEvent(params: Record<string, string> = {}, locals?: App.Locals): RequestEvent {
    const url = new URL('http://localhost/api/playlists/42/suggestions');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return {
        url,
        params: { id: params.playlistId },
        request: new Request(url.toString()),
        locals: locals ?? makeLocals(),
    } as Partial<RequestEvent> as RequestEvent;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();

    mockFeatures.sonicEmbeddings = true;
    mockGetSql.mockResolvedValue(makeAccessiblePlaylistSql());
    mockCountPlaylistSonicEmbeddings.mockResolvedValue(5); // above threshold by default
    mockGetPlaylistSuggestionsFull.mockResolvedValue([ROW_A, ROW_B]);
    mockGetPlaylistSuggestionsViaSonic.mockResolvedValue([ROW_A, ROW_B]);
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_CTX);
    // filterAccessibleRows passes through whatever rows it receives
    mockFilterAccessibleRows.mockImplementation((_sql: unknown, rows: unknown[]) =>
        Promise.resolve(rows),
    );
});

// ---------------------------------------------------------------------------
// Auth + param validation
// ---------------------------------------------------------------------------

describe('GET /api/playlists/42/suggestions — param validation', () => {
    test('returns 401 when user is not authenticated', async () => {
        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) }, makeLocals({ user: null }));
        const response = await GET!(event);
        expect(response.status).toBe(401);
    });

    test('returns 422 when playlistId param is missing', async () => {
        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({});
        const response = await GET!(event);
        expect(response.status).toBe(422);
    });

    test('returns 422 when playlistId is not a positive integer', async () => {
        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: '-5' });
        const response = await GET!(event);
        expect(response.status).toBe(422);
    });

    test('returns 503 when database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(503);
    });
});

// ---------------------------------------------------------------------------
// Sonic path selection
// ---------------------------------------------------------------------------

describe('GET /api/playlists/42/suggestions — sonic vs metadata routing', () => {
    test('uses sonic path when sonicEmbeddings=true and sonicCount>=3', async () => {
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(5);
        mockGetPlaylistSuggestionsViaSonic.mockResolvedValue([ROW_A]);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        expect(mockGetPlaylistSuggestionsViaSonic).toHaveBeenCalledOnce();
        expect(mockGetPlaylistSuggestionsFull).not.toHaveBeenCalled();

        const body = (await response.json()) as Record<string, unknown>;
        const queue = body;
        expect(queue.source).toBe('sonic');
    });

    test('uses metadata path (fallback) when sonicEmbeddings=false', async () => {
        mockFeatures.sonicEmbeddings = false;

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        expect(mockCountPlaylistSonicEmbeddings).not.toHaveBeenCalled();
        expect(mockGetPlaylistSuggestionsViaSonic).not.toHaveBeenCalled();
        expect(mockGetPlaylistSuggestionsFull).toHaveBeenCalledOnce();

        const body = (await response.json()) as Record<string, unknown>;
        const queue = body;
        expect(queue.source).toBe('metadata');
    });

    test('uses metadata path when sonicCount < 3 (coverage below threshold)', async () => {
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(2);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        expect(mockGetPlaylistSuggestionsViaSonic).not.toHaveBeenCalled();
        expect(mockGetPlaylistSuggestionsFull).toHaveBeenCalledOnce();

        const body = (await response.json()) as Record<string, unknown>;
        const queue = body;
        expect(queue.source).toBe('metadata');
    });

    test('uses metadata path when sonicCount = 0', async () => {
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(0);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        expect(mockGetPlaylistSuggestionsViaSonic).not.toHaveBeenCalled();
        expect(mockGetPlaylistSuggestionsFull).toHaveBeenCalledOnce();
    });

    test('falls back to metadata when sonic returns empty rows', async () => {
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(5);
        mockGetPlaylistSuggestionsViaSonic.mockResolvedValue([]); // sonic returns nothing

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        expect(mockGetPlaylistSuggestionsViaSonic).toHaveBeenCalledOnce();
        expect(mockGetPlaylistSuggestionsFull).toHaveBeenCalledOnce();

        const body = (await response.json()) as Record<string, unknown>;
        const queue = body;
        expect(queue.source).toBe('metadata');
    });

    test('exact threshold: sonicCount=3 uses sonic path', async () => {
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(3);
        mockGetPlaylistSuggestionsViaSonic.mockResolvedValue([ROW_A]);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        expect(mockGetPlaylistSuggestionsViaSonic).toHaveBeenCalledOnce();
        expect(mockGetPlaylistSuggestionsFull).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe('GET /api/playlists/42/suggestions — response shape', () => {
    test('response shape is identical for sonic and metadata paths', async () => {
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(5);
        mockGetPlaylistSuggestionsViaSonic.mockResolvedValue([ROW_A]);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        const body = (await response.json()) as Record<string, unknown>;
        const queue = body;
        expect(queue).toHaveProperty('items');
        expect(queue).toHaveProperty('source');
        const suggestions = queue.items as Track[];
        expect(suggestions[0]).toHaveProperty('id');
        expect(suggestions[0]).toHaveProperty('title');
        expect(suggestions[0]).toHaveProperty('artists');
    });

    test('maps row fields to suggestion format', async () => {
        const detailRow = {
            id: 'detail-uuid',
            title: 'Detail Track',
            runtime_seconds: 180,
            custom_poster_url: '/covers/detail.jpg',
            artist_title: 'Detail Artist',
            album_title: 'Detail Album',
            album_id: 'detail-album',
            similarity_score: 0.9,
        };
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(5);
        mockGetPlaylistSuggestionsViaSonic.mockResolvedValue([detailRow]);
        mockFilterAccessibleRows.mockResolvedValue([detailRow]);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        const body = (await response.json()) as Record<string, unknown>;
        const queue = body;
        const suggestions = queue.items as Track[];
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].id).toBe('detail-uuid');
        expect(suggestions[0].title).toBe('Detail Track');
        expect(suggestions[0].artists[0]?.title).toBe('Detail Artist');
        expect(suggestions[0].album?.title).toBe('Detail Album');
        expect(suggestions[0].images.primary?.href).toContain(
            '/api/media/detail-uuid/images/poster',
        );
        expect(suggestions[0].durationMs).toBe(180000);
    });

    test('filterAccessibleRows is always called (access control invariant)', async () => {
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(5);
        mockGetPlaylistSuggestionsViaSonic.mockResolvedValue([ROW_A]);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        await GET!(event);

        expect(mockFilterAccessibleRows).toHaveBeenCalledOnce();
        // ...and with a required-by-shape boundary, not the legacy permissive
        // { deniedGroupIds, ageRating } pair. UNRESTRICTED_CTX projects to
        // { all, any }; a restricted user would project to denyGroups/limit.
        const boundary = mockFilterAccessibleRows.mock.calls[0][2];
        expect(boundary).toEqual({ library: { kind: 'all' }, age: { kind: 'any' } });
    });

    test('filterAccessibleRows is called even on metadata path', async () => {
        mockFeatures.sonicEmbeddings = false;
        mockGetPlaylistSuggestionsFull.mockResolvedValue([ROW_A, ROW_B]);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID) });
        await GET!(event);

        expect(mockFilterAccessibleRows).toHaveBeenCalledOnce();
    });

    test('respects count param when provided', async () => {
        mockCountPlaylistSonicEmbeddings.mockResolvedValue(5);
        mockGetPlaylistSuggestionsViaSonic.mockResolvedValue([ROW_A]);

        const { def } = await import('$lib/server/api/defs/playlists/[id]/suggestions.js');
        const GET = (event: RequestEvent) => def.handlers.GET!(event, { surface: 'internal' });
        const event = makeEvent({ playlistId: String(PLAYLIST_ID), count: '12' });
        await GET!(event);

        expect(mockGetPlaylistSuggestionsViaSonic).toHaveBeenCalledWith(
            expect.anything(),
            PLAYLIST_ID,
            48, // count=12, fetchLimit=count*4=48
        );
    });
});
