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
 * Unit tests for defs/music/text-search.ts (GET /api/v1/music/text-search).
 *
 * Covers:
 *   - Auth spec: {kind:'feature', flag:'textToSound', then:{kind:'user'}}.
 *   - Handler declares a GET handler.
 *   - 503 dependency_unavailable when aiDbService.getSql() returns null.
 *   - 503 when embedTextQuery returns null (embedding provider down).
 *   - 422 validation_failed for empty/missing q.
 *   - 200 {items, page} response shape on success: each item has
 *     id, type='track', title, images{}, similarityScore.
 *   - truncated detection (limit+1 trick).
 *
 * We call def.handlers.GET directly (bypassing mount) — matches the pattern
 * used by all other def unit tests in this codebase. Feature-flag gating and
 * auth enforcement live in mount.ts, not in the handler body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const mockGetSql = vi.fn();
const mockEmbedTextQuery = vi.fn();
const mockBuildSearchAccessContext = vi.fn();
const mockTextSoundSearch = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getSql: (...args: unknown[]) => mockGetSql(...args),
    },
}));

vi.mock('$lib/server/services/sonic-embedding.service.js', () => ({
    embedTextQuery: (...args: unknown[]) => mockEmbedTextQuery(...args),
}));

// Only buildSearchAccessContext is stubbed. searchAccessBoundary keeps its real
// implementation so the projection from context -> MediaAccessBoundary is
// genuinely exercised rather than faked.
vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>();
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => mockBuildSearchAccessContext(...args),
    };
});

vi.mock('$lib/server/database/queries/text-sound-search.queries.js', () => ({
    textSoundSearch: (...args: unknown[]) => mockTextSoundSearch(...args),
}));

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

// Config/features partial mock — mount.ts reads `features` to resolve the
// {kind:'feature'} gate. We keep every real config export intact (the mount
// import chain pulls in the task registry, which reads other FEATURE_* exports)
// and override only `features.textToSound` so the gate is controllable.
const mockFeatures: Record<string, unknown> = { textToSound: true };
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, features: mockFeatures };
});

// Rate limit (C21) — mocked the same way bulk-rate-limit.test.ts mocks it, so
// the mount-layer tests below control allow/deny deterministically instead of
// depending on real time windows.
const mockCheckRateLimit = vi.fn();
vi.mock('$lib/server/middleware/valkey-rate-limit.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/middleware/valkey-rate-limit.js')>();
    return {
        ...actual,
        checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    };
});

// ── Import def AFTER mocks ────────────────────────────────────────────────────

const { def } = await import('./text-search.js');
const { mount } = await import('$lib/server/api/mount.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const CTX = { surface: 'v1' as const };

function makeEvent(q: string, extra: Record<string, string> = {}): RequestEvent {
    const url = new URL('http://localhost/api/v1/music/text-search');
    if (q) url.searchParams.set('q', q);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);

    return {
        url,
        params: {},
        route: { id: '/api/v1/music/text-search' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
                groups: '',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
            principal: undefined,
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

function makeTrackRow(id: string, title: string, score: number) {
    return {
        custom_poster_url: '/cover.jpg',
        media_id: id,
        title,
        artist_title: 'Artist',
        album_title: 'Album',
        similarity_score: score,
    };
}

async function callGet(q: string, extra: Record<string, string> = {}) {
    const event = makeEvent(q, extra);
    const handler = def.handlers.GET!;
    const res = await handler(event, CTX);
    const body = await res.clone().json();
    return { status: res.status, body, headers: res.headers };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockFeatures.textToSound = true; // feature ON by default
    mockGetSql.mockResolvedValue({ query: vi.fn() }); // non-null Sql
    mockEmbedTextQuery.mockResolvedValue([0.1, 0.2, 0.3]); // valid embedding
    mockBuildSearchAccessContext.mockResolvedValue({
        username: 'tester',
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: false,
        showUnavailableMedia: true,
    });
    mockTextSoundSearch.mockResolvedValue([]);
    mockCheckRateLimit.mockResolvedValue({
        allowed: true,
        remaining: 29,
        resetAt: Math.floor(Date.now() / 1000) + 60,
        total: 30,
    });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MusicTextSearchDef — structure', () => {
    it('declares auth kind = feature with then kind = user', () => {
        const auth = def.auth as Record<string, unknown>;
        expect((auth as { kind: string }).kind).toBe('feature');
        expect((auth as { flag: string }).flag).toBe('textToSound');
        const then = (auth as { then: { kind: string } }).then;
        expect(then.kind).toBe('user');
    });

    it('has a GET handler', () => {
        expect(typeof def.handlers.GET).toBe('function');
    });

    it('does NOT have a POST handler', () => {
        expect(def.handlers.POST).toBeUndefined();
    });
});

describe('GET /api/v1/music/text-search — 503 on dependency down', () => {
    it('returns 503 with code=dependency_unavailable when DB is null', async () => {
        mockGetSql.mockResolvedValue(null);

        const { status, body, headers } = await callGet('upbeat summer song');

        expect(status).toBe(503);
        expect(headers.get('content-type')).toMatch('application/problem+json');
        expect(body.code).toBe('dependency_unavailable');
    });

    it('returns 503 when embedTextQuery returns null (embedding provider down)', async () => {
        mockEmbedTextQuery.mockResolvedValue(null);

        const { status, body } = await callGet('rainy day jazz');

        expect(status).toBe(503);
        expect(body.code).toBe('dependency_unavailable');
    });

    it('returns 503 when textSoundSearch throws', async () => {
        mockTextSoundSearch.mockRejectedValue(new Error('kNN failed'));

        const { status, body } = await callGet('heavy metal guitar');

        expect(status).toBe(503);
        expect(body.code).toBe('dependency_unavailable');
    });
});

describe('GET /api/v1/music/text-search — access boundary', () => {
    it('passes a required-by-shape MediaAccessBoundary, not the raw context', async () => {
        await callGet('ambient drone');

        const boundary = mockTextSoundSearch.mock.calls[0][3];
        expect(boundary).toEqual({ library: { kind: 'all' }, age: { kind: 'any' } });
    });

    it('projects a restricted context onto both boundary axes', async () => {
        mockBuildSearchAccessContext.mockResolvedValue({
            username: 'restricted',
            deniedGroupIds: ['group-a'],
            ageRating: { maxAgeRating: 12, allowUnrated: false },
            liveTvAllowed: false,
            showUnavailableMedia: false,
        });

        await callGet('ambient drone');

        const boundary = mockTextSoundSearch.mock.calls[0][3];
        expect(boundary).toEqual({
            library: { kind: 'denyGroups', ids: ['group-a'] },
            age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
        });
    });
});

describe('GET /api/v1/music/text-search — validation', () => {
    it('returns 422 validation_failed for empty q', async () => {
        const { status, body } = await callGet('');

        expect(status).toBe(422);
        expect(body.code).toBe('validation_failed');
    });
});

describe('GET /api/v1/music/text-search — success response shape', () => {
    it('returns {items, page} envelope on success', async () => {
        mockTextSoundSearch.mockResolvedValue([makeTrackRow('track-1', 'Moonlight Sonata', 0.9)]);

        const { status, body } = await callGet('piano classical');

        expect(status).toBe(200);
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.page).toBeDefined();
        expect(typeof body.page.limit).toBe('number');
        expect(body.page).not.toHaveProperty('offset');
        expect(body.page).not.toHaveProperty('hasMore');
        expect(typeof body.page.truncated).toBe('boolean');
    });

    it('each item has id, type="track", title, images{}, similarityScore', async () => {
        mockTextSoundSearch.mockResolvedValue([makeTrackRow('track-abc', 'Harbor Rhapsody', 0.95)]);

        const { body } = await callGet('epic rock');

        const item = body.items[0];
        expect(item.id).toBe('track-abc');
        expect(item.type).toBe('track');
        expect(item.title).toBe('Harbor Rhapsody');
        expect(typeof item.similarityScore).toBe('number');
        expect(item.images).toBeDefined();
        expect(item.images.primary).toBeDefined();
        expect(item.images.primary.href).toContain('track-abc');
    });

    it('truncated is true when backend yields more than limit results', async () => {
        // Default limit=20; supply 21 rows to trigger truncated
        const rows = Array.from({ length: 21 }, (_, i) =>
            makeTrackRow(`t-${i}`, `Track ${i}`, 1 - i * 0.01),
        );
        mockTextSoundSearch.mockResolvedValue(rows);

        const { body } = await callGet('ambient music');

        expect(body.page.truncated).toBe(true);
        expect(body.items.length).toBe(20);
    });

    it('truncated is false when backend yields exactly limit results', async () => {
        const rows = Array.from({ length: 3 }, (_, i) => makeTrackRow(`t-${i}`, `Track ${i}`, 0.9));
        mockTextSoundSearch.mockResolvedValue(rows);

        const { body } = await callGet('folk guitar', { limit: '5' });

        expect(body.page.truncated).toBe(false);
    });

    it('similarityScore is rounded to 4 decimal places', async () => {
        mockTextSoundSearch.mockResolvedValue([makeTrackRow('track-x', 'Test', 0.123456789)]);

        const { body } = await callGet('test');

        const score = body.items[0].similarityScore;
        expect(score).toBe(0.1235); // Math.round(0.123456789 * 10000) / 10000
    });
});

// ── Mount-layer gating ─────────────────────────────────────────────────────────
//
// The tests above call def.handlers.GET directly, bypassing mount() — so the
// {kind:'feature', then:{kind:'user'}} AuthSpec is never actually enforced.
// These drive THROUGH mount(def, ctx) to prove the feature gate AND the auth
// fallthrough are enforced at the mount layer. A regression that dropped the
// gate (feature served while disabled) or the user requirement would slip past
// the direct-handler tests above.

describe('GET /api/v1/music/text-search — mount-layer gating', () => {
    const { GET } = mount(def, CTX);

    /** Build a mount event; pass anon:true for an unauthenticated caller. */
    function mountEvent(q: string, opts: { anon?: boolean } = {}): RequestEvent {
        const e = makeEvent(q);
        if (opts.anon) {
            Object.assign(e.locals, { user: undefined, principal: undefined });
        }
        return e;
    }

    it('returns 401 when no user is present (auth fallthrough enforced THROUGH mount)', async () => {
        mockFeatures.textToSound = true; // feature ON, but caller is anonymous
        const res = await GET!(mountEvent('upbeat song', { anon: true }));
        expect(res.status).toBe(401);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('unauthorized');
        // The handler must NOT run — auth short-circuits first.
        expect(mockTextSoundSearch).not.toHaveBeenCalled();
    });

    it('returns 404 when the feature is disabled (feature gate enforced THROUGH mount)', async () => {
        mockFeatures.textToSound = false; // supporter-tier feature OFF
        const res = await GET!(mountEvent('upbeat song'));
        expect(res.status).toBe(404);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('not_found');
        // Feature gate runs before auth and before the handler.
        expect(mockTextSoundSearch).not.toHaveBeenCalled();
    });

    it('passes the gate (200) when feature is ON and caller is authenticated', async () => {
        mockFeatures.textToSound = true;
        const res = await GET!(mountEvent('piano classical'));
        expect(res.status).toBe(200);
    });
});

// ── Per-user rate limit (C21 fix-plan finding) ──────────────────────────────
//
// The interactive embedding call bypassed the task-scoped SSRF guard AND had
// no per-user rate limit. mount() enforces `def.rateLimit` — see define.ts /
// mount.ts (Task 5, C5) — so these tests drive THROUGH mount() rather than
// calling def.handlers.GET directly.

describe('GET /api/v1/music/text-search — rate limit (C21, mount-layer)', () => {
    const { GET } = mount(def, CTX);

    it('declares a 30-req/60s budget', () => {
        expect(def.rateLimit).toMatchObject({ limit: 30, windowSec: 60 });
        expect(typeof def.rateLimit?.keyBy).toBe('function');
    });

    it('keys the budget by music:semantic-search:<userId> (shared with lyrics-search)', async () => {
        await GET!(makeEvent('piano classical'));

        expect(mockCheckRateLimit).toHaveBeenCalledWith(
            'music:semantic-search:usr_00000000-0000-0000-0000-000000000001',
            30,
            60,
        );
    });

    it('returns 429 rate_limited over budget, and the handler never runs', async () => {
        mockCheckRateLimit.mockResolvedValueOnce({
            allowed: false,
            remaining: 0,
            resetAt: Math.floor(Date.now() / 1000) + 30,
            total: 30,
        });

        const res = await GET!(makeEvent('piano classical'));

        expect(res.status).toBe(429);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe('rate_limited');
        expect(mockTextSoundSearch).not.toHaveBeenCalled();
    });
});
