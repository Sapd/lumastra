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
 * Unit tests for GET /api/music/text-search (the legacy BFF surface),
 * which is now mounted via mount(def, …) from
 * $lib/server/api/defs/music/text-search.ts.
 *
 * Handler logic is exercised by calling def.handlers.GET directly.
 * Auth / feature-gate enforcement is exercised through mount().
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ---------------------------------------------------------------------------
// Shared mutable mock state
// ---------------------------------------------------------------------------

const mockGetSql = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockTextSoundSearch = vi.fn();
const mockEmbedTextQuery = vi.fn();

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules.
//
// IMPORTANT: the config mock uses importOriginal so that named exports such as
// FEATURE_PER_TASK_QUEUES (used by tasks/registry.ts which is transitively
// loaded by mount.ts's api-auth import chain) are preserved.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        features: mockFeatures,
    };
});

// mockFeatures must be declared before the vi.mock factory runs (hoisting).
// Declare it as a module-level mutable object; the factory closes over it.
const mockFeatures: Record<string, unknown> = { textToSound: true };

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    // The handler also imports `searchAccessBoundary` from this module — the mock
    // factory replaces the whole module, so it must be re-provided here too or
    // calling it throws "No searchAccessBoundary export is defined on the mock",
    // which the handler's catch-all turns into a 503 dependency_unavailable.
    // Identity passthrough keeps the boundary assertions below in terms of the
    // plain SearchAccessContext fields (deniedGroupIds/ageRating) the tests set up.
    searchAccessBoundary: (ctx: unknown) => ctx,
}));

vi.mock('$lib/server/database/queries/text-sound-search.queries.js', () => ({
    textSoundSearch: (...args: unknown[]) => mockTextSoundSearch(...args),
}));

vi.mock('$lib/server/services/sonic-embedding.service.js', () => ({
    embedTextQuery: (...args: unknown[]) => mockEmbedTextQuery(...args),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

// ---------------------------------------------------------------------------
// Import def and mount AFTER mocks are declared
// ---------------------------------------------------------------------------

const { def } = await import('$lib/server/api/defs/music/text-search.js');
const { mount } = await import('$lib/server/api/mount.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX = { surface: 'internal' as const };

const UNRESTRICTED_ACCESS_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: true,
};

/** Fake 1024-dim float array returned by the mocked embedder. */
const FAKE_EMBEDDING = Array.from({ length: 1024 }, (_, i) => i / 1024);

function makeEvent(
    searchParams: Record<string, string> = {},
    opts: { anon?: boolean } = {},
): RequestEvent {
    const url = new URL('http://localhost/api/music/text-search');
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
    return {
        url,
        params: {},
        route: { id: '/api/music/text-search' as const },
        request: new Request(url.toString()),
        locals: {
            user: opts.anon
                ? null
                : {
                      userId: 'user-uuid',
                      username: 'alice',
                      groups: '',
                      userGroups: [],
                      isAdmin: false,
                      maxAgeRating: null,
                  },
            principal: opts.anon ? undefined : undefined,
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function makeTextSoundRow(id: string, score = 0.85): Record<string, unknown> {
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

async function callGet(params: Record<string, string> = {}, opts: { anon?: boolean } = {}) {
    const event = makeEvent(params, opts);
    const handler = def.handlers.GET!;
    const res = await handler(event, CTX);
    const body = await res.clone().json();
    return { status: res.status, body, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();

    mockFeatures.textToSound = true;
    mockGetSql.mockResolvedValue({ query: vi.fn() });
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);
    mockEmbedTextQuery.mockResolvedValue(FAKE_EMBEDDING);
    mockTextSoundSearch.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Handler logic tests (call def.handlers.GET directly, bypassing mount)
// ---------------------------------------------------------------------------

describe('GET /api/music/text-search — handler logic', () => {
    test('returns 503 when database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const { status, body } = await callGet({ q: 'calm piano' });
        expect(status).toBe(503);
        expect(body.code).toBe('dependency_unavailable');
    });

    test('returns 422 when q param is missing', async () => {
        const { status, body } = await callGet({});
        expect(status).toBe(422);
        expect(body.code).toBe('validation_failed');
    });

    test('returns 422 when q param is blank whitespace', async () => {
        const { status, body } = await callGet({ q: '   ' });
        expect(status).toBe(422);
        expect(body.code).toBe('validation_failed');
    });

    test('returns 503 when embedTextQuery returns null (spawn failed)', async () => {
        mockEmbedTextQuery.mockResolvedValue(null);
        const { status, body } = await callGet({ q: 'calm piano' });
        expect(status).toBe(503);
        expect(body.code).toBe('dependency_unavailable');
    });

    test('returns 200 with empty items when no results found', async () => {
        const { status, body } = await callGet({ q: 'calm piano' });
        expect(status).toBe(200);
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.items).toHaveLength(0);
        expect(body.page).toBeDefined();
    });

    test('returns mapped MusicSearchResultItem objects on success', async () => {
        const rows = [
            makeTextSoundRow('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 0.92),
            makeTextSoundRow('11111111-2222-4333-8444-555555555555', 0.78),
        ];
        mockTextSoundSearch.mockResolvedValue(rows);

        const { status, body } = await callGet({ q: 'aggressive metal' });
        expect(status).toBe(200);

        const items = body.items as Track[];
        expect(items).toHaveLength(2);
        expect(items[0].id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(items[0].type).toBe('track');
        expect(items[0].artists[0]?.title).toBe('Artist');
        expect(items[0].similarityScore).toBe(0.92);
        expect(items[0].images).toBeDefined();
    });

    test('passes limit query param to textSoundSearch (clamped to 50 by schema)', async () => {
        // The schema clamps limit to max 50; passing 100 → coerce to 50 (schema max).
        // But the schema uses .max(50) so 100 would be rejected by Zod — use 50 directly.
        await callGet({ q: 'summer party', limit: '50' });
        expect(mockTextSoundSearch).toHaveBeenCalledWith(
            expect.anything(),
            FAKE_EMBEDDING,
            51, // limit + 1 (truncated detection)
            expect.objectContaining({ deniedGroupIds: null }),
        );
    });

    test('uses default limit of 20 when limit param is absent', async () => {
        await callGet({ q: 'sad ballad' });
        expect(mockTextSoundSearch).toHaveBeenCalledWith(
            expect.anything(),
            FAKE_EMBEDDING,
            21, // limit(20) + 1
            expect.objectContaining({ deniedGroupIds: null }),
        );
    });

    test('passes trimmed query to embedTextQuery', async () => {
        await callGet({ q: '  calm piano  ' });
        expect(mockEmbedTextQuery).toHaveBeenCalledWith('calm piano');
    });

    test('passes access context to textSoundSearch', async () => {
        const restrictedCtx = {
            ...UNRESTRICTED_ACCESS_CTX,
            deniedGroupIds: ['group-uuid-1'],
            ageRating: { maxAgeRating: 12, allowUnrated: false },
        };
        mockBuildSearchAccessContext.mockResolvedValue(restrictedCtx);

        await callGet({ q: 'smooth jazz' });

        expect(mockTextSoundSearch).toHaveBeenCalledWith(
            expect.anything(),
            FAKE_EMBEDDING,
            21,
            expect.objectContaining({
                deniedGroupIds: ['group-uuid-1'],
                ageRating: { maxAgeRating: 12, allowUnrated: false },
            }),
        );
    });

    test('similarityScore rounds to 4 decimal places', async () => {
        const row = makeTextSoundRow('cccccccc-dddd-4eee-8fff-000000000000', 0.123456789);
        mockTextSoundSearch.mockResolvedValue([row]);

        const { body } = await callGet({ q: 'funk groove' });
        const items = body.items as Track[];
        // Math.round(0.123456789 * 10000) / 10000 = 0.1235
        expect(items[0].similarityScore).toBe(0.1235);
    });

    test('truncated is true when backend yields more than limit rows', async () => {
        // Default limit = 20; supply 21 rows (handler fetches limit+1 = 21 to detect truncated).
        const rows = Array.from({ length: 21 }, (_, i) =>
            makeTextSoundRow(`t-${i}`, 0.9 - i * 0.01),
        );
        mockTextSoundSearch.mockResolvedValue(rows);

        const { body } = await callGet({ q: 'ambient' });
        expect(body.page.truncated).toBe(true);
        expect(body.items).toHaveLength(20);
    });

    test('truncated is false when backend yields fewer than limit+1 rows', async () => {
        mockTextSoundSearch.mockResolvedValue([makeTextSoundRow('t-1', 0.9)]);

        const { body } = await callGet({ q: 'folk guitar' });
        expect(body.page.truncated).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Mount-layer gating tests (enforce auth + feature flag through mount())
// ---------------------------------------------------------------------------

describe('GET /api/music/text-search — mount-layer gating', () => {
    const { GET } = mount(def, CTX);

    test('returns 401 when user is not authenticated', async () => {
        mockFeatures.textToSound = true;
        const event = makeEvent({ q: 'calm piano' }, { anon: true });
        const response = await GET!(event);
        expect(response.status).toBe(401);
        const body = (await response.json()) as { code: string };
        expect(body.code).toBe('unauthorized');
        expect(mockTextSoundSearch).not.toHaveBeenCalled();
    });

    test('returns 404 when feature flag is disabled', async () => {
        mockFeatures.textToSound = false;
        const event = makeEvent({ q: 'calm piano' });
        const response = await GET!(event);
        expect(response.status).toBe(404);
        const body = (await response.json()) as { code: string };
        expect(body.code).toBe('not_found');
        expect(mockTextSoundSearch).not.toHaveBeenCalled();
    });

    test('passes through (200) when feature is ON and caller is authenticated', async () => {
        mockFeatures.textToSound = true;
        const event = makeEvent({ q: 'calm piano' });
        const response = await GET!(event);
        expect(response.status).toBe(200);
    });
});
