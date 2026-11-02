// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AiStrategy — SHOW_UNAVAILABLE_MEDIA gate coverage.
 *
 * `ctx.showUnavailableMedia` is the always-on server-config gate for
 * discovery-sourced (has_files=false) items. These tests verify the AI
 * strategy filters `suggestion.is_available` on the raw suggestions before
 * paging when the gate is off, and includes them when the gate is on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import type { AccessContext, RecommenderOptions } from '../recommender.js';
import { isDependencyUnavailable } from '$lib/server/api/problem.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: vi.fn().mockReturnValue('tmdb'),
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    createExternalIds: vi.fn().mockReturnValue({}),
}));

vi.mock('$lib/server/utils/media-types.js', () => ({
    toPublicMediaType: (t: string) => (t === 'tv' ? 'series' : t),
}));

const mockGetDb = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockFilterAccessibleMediaIds = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleMediaIds: (...args: unknown[]) => mockFilterAccessibleMediaIds(...args),
}));

const mockGetMediaEmbeddingsByUuids = vi.hoisted(() => vi.fn());
const mockGetUserProfileOrCreate = vi.hoisted(() => vi.fn());
const mockGetSuggestionEngine = vi.hoisted(() => vi.fn());
const mockGenerateSuggestionsFromProfile = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getMediaEmbeddingsByUuids: (...args: unknown[]) => mockGetMediaEmbeddingsByUuids(...args),
        getUserProfileOrCreate: (...args: unknown[]) => mockGetUserProfileOrCreate(...args),
        getSuggestionEngine: (...args: unknown[]) => mockGetSuggestionEngine(...args),
    },
}));

// Default (non-refresh, non-cursor) fetches now read PERSISTED suggestions
// directly via `getUserSuggestions` — the AI engine only runs on an explicit
// refresh or the first-page self-heal fallthrough.
const mockGetUserSuggestions = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/suggestion-management.queries.js', () => ({
    getUserSuggestions: (...args: unknown[]) => mockGetUserSuggestions(...args),
}));

const mockGetWatchedMediaIdsCached = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getWatchedMediaIdsCached: (...args: unknown[]) => mockGetWatchedMediaIdsCached(...args),
    },
}));

const { aiStrategy } = await import('./ai.strategy.js');

function makeCtx(partial: Partial<AccessContext> = {}): AccessContext {
    return {
        userId: 'usr_00000000-0000-0000-0000-000000000001' as UserId,
        username: 'alice',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
        ...partial,
    };
}

function makeOpts(partial: Partial<RecommenderOptions> = {}): RecommenderOptions {
    return {
        surface: 'internal',
        limit: 10,
        offset: 0,
        ...partial,
    };
}

const AVAILABLE_SUGGESTION = {
    id: 1,
    user_id: 'usr_1',
    media_id: 'media-available',
    primary_ext_id: '100',
    media_type: 'movie',
    cache_context: 'x',
    library_similarity_score: null,
    discovery_similarity_score: null,
    combined_score: 0.8,
    suggestion_reason: null,
    reason_data: null,
    is_available: true,
    can_request: false,
    created_at: new Date(),
    expires_at: new Date(),
};

const UNAVAILABLE_SUGGESTION = {
    ...AVAILABLE_SUGGESTION,
    id: 2,
    media_id: 'media-unavailable',
    primary_ext_id: '200',
    is_available: false,
    can_request: true,
};

function seedDefaultMocks(): void {
    mockGetDb.mockReturnValue({});
    mockGetUserSuggestions.mockResolvedValue([AVAILABLE_SUGGESTION, UNAVAILABLE_SUGGESTION]);
    mockGetUserProfileOrCreate.mockResolvedValue({ catalog_embedding: [0.1] });
    mockGetSuggestionEngine.mockResolvedValue({
        generateSuggestionsFromProfile: mockGenerateSuggestionsFromProfile,
    });
    mockGenerateSuggestionsFromProfile.mockResolvedValue([
        AVAILABLE_SUGGESTION,
        UNAVAILABLE_SUGGESTION,
    ]);
    mockFilterAccessibleMediaIds.mockResolvedValue(
        new Set(['media-available', 'media-unavailable']),
    );
    mockGetMediaEmbeddingsByUuids.mockResolvedValue(
        new Map([
            ['media-available', { title: 'Available Movie', release_year: 2020 }],
            ['media-unavailable', { title: 'Unavailable Movie', release_year: 2021 }],
        ]),
    );
    mockGetWatchedMediaIdsCached.mockResolvedValue([]);
}

describe('AiStrategy — SHOW_UNAVAILABLE_MEDIA gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedDefaultMocks();
    });

    it('excludes has_files=false suggestions when the gate is off', async () => {
        const result = await aiStrategy.fetch(makeCtx({ showUnavailableMedia: false }), makeOpts());

        expect(result.items).toHaveLength(1);
        expect(result.items[0].media.id).toBe('media-available');
    });

    it('includes has_files=false suggestions when the gate is on', async () => {
        const result = await aiStrategy.fetch(makeCtx({ showUnavailableMedia: true }), makeOpts());

        expect(result.items).toHaveLength(2);
        const ids = result.items.map((i) => i.media.id);
        expect(ids).toEqual(expect.arrayContaining(['media-available', 'media-unavailable']));
    });
});

describe('AiStrategy — regeneration boundaries (refresh / self-heal / cursor)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedDefaultMocks();
    });

    it('refresh=true on the first page calls the engine with refresh=true and serves its output', async () => {
        const result = await aiStrategy.fetch(makeCtx(), makeOpts({ refresh: true }));

        expect(mockGenerateSuggestionsFromProfile).toHaveBeenCalledTimes(1);
        const args = mockGenerateSuggestionsFromProfile.mock.calls[0];
        expect(args[0]).toBe('usr_00000000-0000-0000-0000-000000000001');
        expect(args[4]).toBe(true); // refresh flag forwarded
        // The read-only persisted path is bypassed entirely on refresh
        expect(mockGetUserSuggestions).not.toHaveBeenCalled();
        expect(result.status).toBe('ready');
        expect(result.items.map((i) => i.media.id)).toEqual(
            expect.arrayContaining(['media-available', 'media-unavailable']),
        );
    });

    it('self-heals expired/absent rows on the FIRST page with exactly one refresh=false engine call', async () => {
        // Persisted store is empty (rows expired ~2 days after generation)
        mockGetUserSuggestions.mockResolvedValue([]);

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(mockGenerateSuggestionsFromProfile).toHaveBeenCalledTimes(1);
        expect(mockGenerateSuggestionsFromProfile.mock.calls[0][4]).toBe(false); // NOT a forced refresh
        expect(result.status).toBe('ready');
        expect(result.items).toHaveLength(2);
    });

    it('returns generating when the self-heal attempt also yields nothing', async () => {
        mockGetUserSuggestions.mockResolvedValue([]);
        mockGenerateSuggestionsFromProfile.mockResolvedValue([]);

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(mockGenerateSuggestionsFromProfile).toHaveBeenCalledTimes(1);
        expect(result.items).toHaveLength(0);
        expect(result.status).toBe('generating');
    });

    it('a cursor page NEVER regenerates, even when the persisted store is empty', async () => {
        mockGetUserSuggestions.mockResolvedValue([]);
        // New "o:<offset>:<gen>" cursor format (see FIX 4); gen 0 matches the
        // gen derived from an empty row set (rows.length === 0 → gen 0), so
        // this exercises the ordinary empty-page path, not the gen-mismatch
        // short-circuit.
        const cursor = Buffer.from('o:2:0', 'utf8').toString('base64url');

        const result = await aiStrategy.fetch(makeCtx(), makeOpts({ cursor }));

        expect(mockGenerateSuggestionsFromProfile).not.toHaveBeenCalled();
        expect(mockGetUserProfileOrCreate).not.toHaveBeenCalled();
        expect(result.items).toHaveLength(0);
        expect(result.status).toBe('exhausted');
    });

    it('reports exhausted (not generating) when raw rows exist but access filtering removes them all', async () => {
        // Raw persisted rows exist — the user just isn't allowed to see any.
        mockFilterAccessibleMediaIds.mockResolvedValue(new Set());

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(result.items).toHaveLength(0);
        expect(result.status).toBe('exhausted');
        // Rows were present, so the self-heal fallthrough must not fire.
        expect(mockGenerateSuggestionsFromProfile).not.toHaveBeenCalled();
    });

    it('a cursor whose gen no longer matches the persisted batch reports exhausted without slicing', async () => {
        // Cursor was issued against an older generation (gen 111) than the
        // batch currently persisted (created_at derived from AVAILABLE_SUGGESTION,
        // seeded fresh via `new Date()` — always > 111ms epoch).
        const cursor = Buffer.from('o:1:111', 'utf8').toString('base64url');

        const result = await aiStrategy.fetch(makeCtx(), makeOpts({ cursor }));

        expect(result.items).toHaveLength(0);
        expect(result.hasMore).toBe(false);
        expect(result.status).toBe('exhausted');
    });
});

describe('AiStrategy — post-mapping status derivation (FIX 1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedDefaultMocks();
    });

    it('reports exhausted (not a false ready) when every raw row maps to an unrenderable title', async () => {
        // Raw rows exist and survive access-filtering, but the embeddings
        // lookup yields no usable title for either — the per-row mapping loop
        // drops both, leaving items: [].
        mockGetMediaEmbeddingsByUuids.mockResolvedValue(
            new Map([
                ['media-available', { title: 'undefined', release_year: 2020 }],
                ['media-unavailable', { title: null, release_year: 2021 }],
            ]),
        );

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(result.items).toHaveLength(0);
        expect(result.status).toBe('exhausted');
    });
});

describe('AiStrategy — decodeCursor defensive clamping (FIX 6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedDefaultMocks();
    });

    it('clamps a large-but-safe offset to 100_000 instead of using it verbatim', async () => {
        const cursor = Buffer.from('o:200000:0', 'utf8').toString('base64url');

        await aiStrategy.fetch(makeCtx(), makeOpts({ cursor, limit: 10 }));

        // fetchCount = offset + limit*2 + 1; clamped offset is 100_000, not 200_000.
        expect(mockGetUserSuggestions).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            100_000 + 10 * 2 + 1,
            expect.anything(),
        );
    });

    it('resets a non-safe-integer offset to 0 rather than clamping it', async () => {
        const cursor = Buffer.from('o:99999999999999999999999:0', 'utf8').toString('base64url');

        await aiStrategy.fetch(makeCtx(), makeOpts({ cursor, limit: 10 }));

        expect(mockGetUserSuggestions).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            10 * 2 + 1,
            expect.anything(),
        );
    });
});

describe('AiStrategy — watched exclusion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedDefaultMocks();
    });

    it('excludes a suggestion whose media_id is in the watched set', async () => {
        mockGetWatchedMediaIdsCached.mockResolvedValue(['media-available']);

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(result.items).toHaveLength(1);
        expect(result.items[0].media.id).toBe('media-unavailable');
    });

    it('includes all suggestions when nothing is watched', async () => {
        mockGetWatchedMediaIdsCached.mockResolvedValue([]);

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(result.items).toHaveLength(2);
    });

    it('does not fail the whole fetch when the watched-ids lookup throws', async () => {
        mockGetWatchedMediaIdsCached.mockRejectedValue(new Error('cache down'));

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(result.items).toHaveLength(2);
        expect(result.status).toBe('ready');
    });
});

describe('AiStrategy — mapReason shape validation (FIX 7)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedDefaultMocks();
    });

    it('falls back to {kind:"ai"} for a rated-similar reason_data with a malformed shape', async () => {
        mockGetUserSuggestions.mockResolvedValue([
            {
                ...AVAILABLE_SUGGESTION,
                reason_data: { kind: 'rated-similar', title: 123, rating: 'nine' },
            },
        ]);

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(result.items[0].reason).toEqual({ kind: 'ai' });
    });

    it('falls back to {kind:"ai"} for a genre-affinity reason_data with a malformed shape', async () => {
        mockGetUserSuggestions.mockResolvedValue([
            { ...AVAILABLE_SUGGESTION, reason_data: { kind: 'genre-affinity', genre: 42 } },
        ]);

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(result.items[0].reason).toEqual({ kind: 'ai' });
    });
});

describe('AiStrategy — database fault reporting (error-swallowing fix)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seedDefaultMocks();
    });

    /**
     * Reproduces the production incident: `getUserSuggestions` throws a real
     * `postgres.PostgresError` (the `sql.array()` type-OID race — "op
     * ANY/ALL (array) requires array on right side" — fixed in ac9e63a22).
     * Before the fix, `AiStrategy.fetch`'s catch-all swallowed ANY non-
     * dependency error to `{ items: [], hasMore: false }` — no `status` at
     * all, which `getTasteRailPage` (for-you/taste.ts) then defaulted to
     * `status: 'ready'`, rendering a hard DB failure as a legitimately-empty
     * "Recommended for You" rail with nothing retriable.
     */
    it('reports a genuine Postgres query fault as dependency-unavailable, not a status-less empty result', async () => {
        mockGetUserSuggestions.mockRejectedValue(
            Object.assign(
                new postgres.PostgresError('op ANY/ALL (array) requires array on right side'),
                { code: '42883', severity: 'ERROR' },
            ),
        );

        let caught: unknown;
        try {
            await aiStrategy.fetch(makeCtx(), makeOpts());
            expect.unreachable('aiStrategy.fetch should have thrown');
        } catch (err) {
            caught = err;
        }

        expect(isDependencyUnavailable(caught)).toBe(true);
    });

    it('reports a Postgres connection fault (e.g. a cold pool timing out) as dependency-unavailable', async () => {
        mockGetUserSuggestions.mockRejectedValue(
            Object.assign(new Error('write CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' }),
        );

        let caught: unknown;
        try {
            await aiStrategy.fetch(makeCtx(), makeOpts());
            expect.unreachable('aiStrategy.fetch should have thrown');
        } catch (err) {
            caught = err;
        }

        expect(isDependencyUnavailable(caught)).toBe(true);
    });

    it('still isolates a truly unexpected non-DB error to a (status-less, pre-existing) empty result', async () => {
        // Not a Postgres-shaped error — a genuine bug elsewhere in fetch().
        // This is the residual, pre-existing behavior shared with
        // runRecommender's own catch-all; unchanged by this fix.
        mockGetMediaEmbeddingsByUuids.mockRejectedValue(new TypeError('mapping bug'));

        const result = await aiStrategy.fetch(makeCtx(), makeOpts());

        expect(result).toEqual({ items: [], hasMore: false });
    });
});

// Real limiter: the legacy middleware and the strategy must consume one user bucket.
import {
    withAISuggestionRateLimit,
    resetRateLimit,
} from '$lib/server/middleware/valkey-rate-limit.js';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { runRecommender } from '../recommender.js';

describe('forced AI refresh budget', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        seedDefaultMocks();
        await resetRateLimit(`ai-suggestions:${makeCtx().userId}`, 60);
        await resetRateLimit('192.0.2.1:alice:/api/recommendations', 60);
    });
    it.each(['internal', 'v1'] as const)(
        '%s shares the legacy AI suggestion bucket',
        async (surface) => {
            const request = new Request('http://localhost/api/recommendations');
            const event = {
                request,
                url: new URL(request.url),
                locals: { user: { userId: makeCtx().userId, username: 'alice' } },
                getClientAddress: () => '192.0.2.1',
            } as unknown as RequestEvent;
            const legacy = withAISuggestionRateLimit(async () => new Response('ok'));
            for (let n = 0; n < 30; n++) expect((await legacy(event)).status).toBe(200);
            const def = defineEndpoint({
                auth: { kind: 'public' },
                handlers: {
                    GET: async () =>
                        Response.json(
                            await runRecommender(
                                aiStrategy,
                                makeCtx(),
                                makeOpts({ surface, refresh: true }),
                            ),
                        ),
                },
            });
            const response = await mount(def, { surface }).GET!(event);
            expect(response.status).toBe(429);
            expect(response.headers.get('Retry-After')).toBeTruthy();
            expect(await response.json()).toMatchObject({ code: 'rate_limited' });
            expect(mockGenerateSuggestionsFromProfile).not.toHaveBeenCalled();
        },
    );
    it('does not charge persisted reads or cursor pages', async () => {
        for (let n = 0; n < 31; n++) await aiStrategy.fetch(makeCtx(), makeOpts());
        await expect(
            aiStrategy.fetch(makeCtx(), makeOpts({ refresh: true })),
        ).resolves.toMatchObject({ status: 'ready' });
        expect(mockGenerateSuggestionsFromProfile).toHaveBeenCalledTimes(1);
    });
});
