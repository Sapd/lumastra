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
 * Unit tests for GET /api/music/path.
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files (even though svelte-check/eslint/vitest pass).
 *
 * All heavy dependencies (db, config, access checks, buildSonicPath) are
 * mocked so tests run fast without a real database or python embedder.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Shared mutable mock state
// ---------------------------------------------------------------------------

const mockFeatures = { sonicEmbeddings: true };

const mockGetSql = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockBuildSonicPath = vi.fn();

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: {},
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));

// `searchAccessBoundary` is NOT mocked away: the def's job is to project the
// context onto a MediaAccessBoundary, and stubbing the projection would hide a
// wrong projection. The real implementation is delegated to here — it is a pure
// function over `restrictedAccess`, with no config/db dependencies of its own.
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: mockBuildSearchAccessContext,
    searchAccessBoundary: (ctx: {
        deniedGroupIds: string[] | null;
        ageRating: { maxAgeRating: number | null; allowUnrated: boolean } | null;
    }) =>
        restrictedAccess({
            deniedGroupIds: ctx.deniedGroupIds ?? [],
            maxAgeRating: ctx.ageRating?.maxAgeRating ?? null,
            allowUnrated: ctx.ageRating?.allowUnrated ?? false,
        }),
}));

vi.mock('$lib/server/database/queries/sonic-path.queries.js', () => ({
    buildSonicPath: mockBuildSonicPath,
    SONIC_PATH_DEFAULT_STEPS: 8,
    SONIC_PATH_MIN_STEPS: 1,
    SONIC_PATH_MAX_STEPS: 20,
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

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const fakeSql = vi.fn();

const FROM_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const TO_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const BRIDGE_ID_1 = 'cccccccc-3333-4333-8333-333333333333';
const BRIDGE_ID_2 = 'dddddddd-4444-4444-8444-444444444444';

const UNRESTRICTED_ACCESS_CTX = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: true,
};

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

function makeEvent(params: Record<string, string> = {}, locals?: App.Locals): RequestEvent {
    const base = `http://localhost/api/music/path`;
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return {
        url,
        request: new Request(url.toString()),
        locals: locals ?? makeLocals(),
    } as Partial<RequestEvent> as RequestEvent;
}

function makeBridgeStep(id: string, step: number): Record<string, unknown> {
    return {
        media_id: id,
        step,
        similarity_score: 0.85,
        title: `Bridge Track ${step}`,
        custom_poster_url: null,
        custom_metadata: {},
        runtime_seconds: 210,
        artist_title: 'Bridge Artist',
        artist_id: 'artist-uuid',
        album_id: null,
        album_title: null,
    };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();

    mockFeatures.sonicEmbeddings = true;
    mockGetSql.mockResolvedValue(fakeSql);
    // Both seeds accessible by default
    mockCheckMediaAccess.mockResolvedValue(true);
    mockBuildSearchAccessContext.mockResolvedValue(UNRESTRICTED_ACCESS_CTX);
    mockBuildSonicPath.mockResolvedValue({ steps: [], missingEmbedding: null });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/music/path', () => {
    test('returns 401 when user is not authenticated', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID }, makeLocals({ user: null }));
        const response = await GET!(event);
        expect(response.status).toBe(401);
    });

    test('returns 503 when database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        expect(response.status).toBe(503);
    });

    test('returns 422 when from param is missing', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ to: TO_ID });
        const response = await GET!(event);
        expect(response.status).toBe(422);
        const body = (await response.json()) as Record<string, unknown>;
        expect(JSON.stringify(body)).toMatch(/from/i);
    });

    test('returns 422 when to param is missing', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID });
        const response = await GET!(event);
        expect(response.status).toBe(422);
        const body = (await response.json()) as Record<string, unknown>;
        expect(JSON.stringify(body)).toMatch(/to/i);
    });

    test('returns 422 when from and to are identical', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: FROM_ID });
        const response = await GET!(event);
        expect(response.status).toBe(422);
    });

    test('returns 404 when from track is not accessible', async () => {
        // first call (from) = false, second (to) = true
        mockCheckMediaAccess.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        expect(response.status).toBe(404);
    });

    test('returns 404 when to track is not accessible', async () => {
        // first call (from) = true, second (to) = false
        mockCheckMediaAccess.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        expect(response.status).toBe(404);
    });

    test('returns 422 with embedding hint when from track has no embedding', async () => {
        mockBuildSonicPath.mockResolvedValue({ steps: [], missingEmbedding: 'from' });
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        expect(response.status).toBe(422);
        const body = (await response.json()) as Record<string, unknown>;
        expect(JSON.stringify(body)).toMatch(/start track/i);
    });

    test('returns 422 with embedding hint when to track has no embedding', async () => {
        mockBuildSonicPath.mockResolvedValue({ steps: [], missingEmbedding: 'to' });
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        expect(response.status).toBe(422);
        const body = (await response.json()) as Record<string, unknown>;
        expect(JSON.stringify(body)).toMatch(/end track/i);
    });

    test('returns 200 with empty steps when no bridge tracks found', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        expect(response.status).toBe(200);
        const data = (await response.json()) as Record<string, unknown>;
        expect(data.steps).toEqual([]);
        expect(data.fromId).toBe(FROM_ID);
        expect(data.toId).toBe(TO_ID);
        expect(data.stepCount).toBe(0);
    });

    test('returns mapped bridge steps on success', async () => {
        mockBuildSonicPath.mockResolvedValue({
            steps: [makeBridgeStep(BRIDGE_ID_1, 0), makeBridgeStep(BRIDGE_ID_2, 1)],
            missingEmbedding: null,
        });

        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        expect(response.status).toBe(200);

        const data = (await response.json()) as Record<string, unknown>;
        const steps = data.steps as Array<Record<string, unknown>>;
        expect(steps).toHaveLength(2);
        expect(steps[0].id).toBe(BRIDGE_ID_1);
        expect(steps[0].step).toBe(0);
        expect(steps[0].similarityScore).toBe(0.85);
        expect((steps[0].track as Record<string, unknown>).type).toBe('track');
        expect(data.stepCount).toBe(2);
    });

    test('passes default steps=8 to buildSonicPath when param absent', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        await GET!(event);
        expect(mockBuildSonicPath).toHaveBeenCalledWith(
            fakeSql,
            FROM_ID,
            TO_ID,
            8,
            // An unrestricted context must project to the explicitly
            // unrestricted boundary — both axes open, no permissive default.
            { library: { kind: 'all' }, age: { kind: 'any' } },
        );
    });

    test('rejects steps above maximum 20 with 422', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID, steps: '99' });
        const response = await GET!(event);
        expect(response.status).toBe(422);
        expect(mockBuildSonicPath).not.toHaveBeenCalled();
    });

    test('rejects steps below minimum 1 with 422', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID, steps: '0' });
        const response = await GET!(event);
        expect(response.status).toBe(422);
        expect(mockBuildSonicPath).not.toHaveBeenCalled();
    });

    test('projects a restricted access context onto the boundary passed to buildSonicPath', async () => {
        const restrictedCtx = {
            ...UNRESTRICTED_ACCESS_CTX,
            deniedGroupIds: ['group-uuid-1'],
            ageRating: { maxAgeRating: 12, allowUnrated: false },
        };
        mockBuildSearchAccessContext.mockResolvedValue(restrictedCtx);

        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        await GET!(event);

        expect(mockBuildSonicPath).toHaveBeenCalledWith(fakeSql, FROM_ID, TO_ID, 8, {
            library: { kind: 'denyGroups', ids: ['group-uuid-1'] },
            age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
        });
    });

    test('maps artist_title from artist hierarchy into MusicTrack.artist', async () => {
        const stepWithArtist = {
            ...makeBridgeStep(BRIDGE_ID_1, 0),
            artist_title: 'Test Band',
        };
        mockBuildSonicPath.mockResolvedValue({
            steps: [stepWithArtist],
            missingEmbedding: null,
        });

        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        const data = (await response.json()) as Record<string, unknown>;
        const firstStep = (data.steps as Array<Record<string, unknown>>)[0];
        expect((firstStep.track as { artists: { title: string }[] }).artists[0].title).toBe(
            'Test Band',
        );
    });

    test('extracts essentia audio features into MusicTrack.audioFeatures', async () => {
        const stepWithEssentia = {
            ...makeBridgeStep(BRIDGE_ID_1, 0),
            custom_metadata: {
                essentia: { bpm: 120, key: 'Gm', energy: 0.7 },
            },
        };
        mockBuildSonicPath.mockResolvedValue({
            steps: [stepWithEssentia],
            missingEmbedding: null,
        });

        const { GET } = await import('./+server.js');
        const event = makeEvent({ from: FROM_ID, to: TO_ID });
        const response = await GET!(event);
        const data = (await response.json()) as Record<string, unknown>;
        const track = (data.steps as Array<Record<string, unknown>>)[0].track as Record<
            string,
            unknown
        >;
        const af = track.audioFeatures as Record<string, unknown> | undefined;
        expect(af).toBeDefined();
        expect(af?.bpm).toBe(120);
        expect(af?.key).toBe('Gm');
        expect(af?.energy).toBe(0.7);
    });
});
