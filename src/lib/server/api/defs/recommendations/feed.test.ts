// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C1 — Unit tests for defs/recommendations/feed.ts (GET /api/v1/feed).
 *
 * Covers:
 *   - sections= query filter: only the requested section ids are composed.
 *   - Per-section fault isolation: a DependencyUnavailableError from one
 *     strategy drops that section but the response is still 200 with the
 *     remaining sections.
 *   - Sections returning 0 items are omitted from the response.
 *
 * All external I/O (getRailItems, buildAccessContext, strategy registry,
 * logger, typedJson) is mocked — no live DB required.
 *
 * The handler is called directly via `def.handlers.GET` with a minimal fake
 * RequestEvent + ApiContext that matches the pattern in search.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { AudiobookActivityFeedResponseSchema } from '$lib/schemas/api-feed-responses.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import { mount } from '$lib/server/api/mount.js';
import { runWithRequestLanguage } from '$lib/server/utils/request-language-context.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────

const mockPaths = vi.hoisted(() => ({ base: '' }));
vi.mock('$app/paths', () => ({
    get base() {
        return mockPaths.base;
    },
}));

const mockResolveImageSets = vi.hoisted(() => vi.fn(async () => new Map()));
vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: mockResolveImageSets,
}));

const mockGetRailItems = vi.hoisted(() => vi.fn());
const mockBuildAccessContext = vi.hoisted(() => vi.fn());
const mockGetStrategy = vi.hoisted(() => vi.fn());

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock recommender — intercept getRailItems and buildAccessContext at their
// call sites inside feed.ts. getStrategy is called at MODULE LOAD for the
// SECTION_PLAN guard, so it must be mocked before the import below.
vi.mock('./recommender.js', () => ({
    getRailItems: (...args: unknown[]) => mockGetRailItems(...args),
    buildAccessContext: (...args: unknown[]) => mockBuildAccessContext(...args),
}));

// Mock strategy registry — feed.ts calls getStrategy(id) at module load to
// validate every entry in SECTION_IDS. Return a minimal stub for any id.
vi.mock('./strategies/index.js', () => ({
    getStrategy: (...args: unknown[]) => mockGetStrategy(...args),
}));

// The handler dynamically imports the watching-section composer; mock it so
// the test suite never exercises the real effective-watching.service/getDb
// chain (which would only fail to matter in a clean env — a dev shell with
// DATABASE_URL set would hit a real DB).
const mockBuildWatchingSection = vi.hoisted(() => vi.fn());
vi.mock('./feed-watching-section.js', () => ({
    buildWatchingSection: (...args: unknown[]) => mockBuildWatchingSection(...args),
}));

const mockBuildAudiobookActivitySection = vi.hoisted(() => vi.fn());
vi.mock('./feed-audiobook-activity-section.js', () => ({
    buildAudiobookActivitySection: (...args: unknown[]) =>
        mockBuildAudiobookActivitySection(...args),
}));

// The handler dynamically imports the BYW fan-out composer; mock it so the
// existing suite's section counts/ordering aren't perturbed by the new phase.
const mockBuildBywSections = vi.hoisted(() => vi.fn());
vi.mock('./feed-byw-sections.js', () => ({
    buildBywSections: (...args: unknown[]) => mockBuildBywSections(...args),
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

// typedJson: in tests just emit a plain JSON response — the handler-level
// schema validation is a dev/prod guard; we test the logical shape here.
vi.mock('$lib/server/utils/typed-response.js', () => ({
    typedJson: (_schema: unknown, data: unknown) =>
        new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }),
}));

// DependencyUnavailableError + isDependencyUnavailable must be the real
// implementations so the feed's fault-isolation catch branch works correctly.
// Import from the real module (not mocked).

// ── Import def AFTER mocks ────────────────────────────────────────────────────

// Set up getStrategy stub BEFORE the module loads (it is called at load time).
// We need to do this before the dynamic import so the hoisted mock is in place.

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECTION_IDS = [
    'ai',
    'trending',
    'fulfilled-requests',
    'popular-shows',
    'fresh-releases',
    'for-you',
    'binge-worthy',
    'anime',
    'short-movies',
    'recently-added',
] as const;

/**
 * Minimal label map so SECTION_PLAN validation passes at module load.
 *
 * Locale-aware (not a constant string) so this mock is a regression detector
 * for the per-request locale plumbing in feed.ts: if `uiLocale` is ever
 * hardcoded or the `{ locale }` argument dropped from a `label()` call, the
 * German-locale test below starts asserting the English strings and fails.
 */
const STRATEGY_LABELS: Record<string, (i?: object, o?: { locale?: string }) => string> = {
    'for-you': (_i, o) => (o?.locale === 'de' ? 'Für Dich' : 'For You'),
    ai: (_i, o) => (o?.locale === 'de' ? 'KI-Empfehlungen' : 'AI Picks'),
    trending: (_i, o) => (o?.locale === 'de' ? 'Angesagt' : 'Trending'),
    'fulfilled-requests': (_i, o) =>
        o?.locale === 'de' ? 'Erfüllte Anfragen' : 'Fulfilled Requests',
    'popular-shows': (_i, o) => (o?.locale === 'de' ? 'Beliebte Serien' : 'Popular Shows'),
    'fresh-releases': (_i, o) => (o?.locale === 'de' ? 'Neuerscheinungen' : 'Fresh Releases'),
    'binge-worthy': (_i, o) => (o?.locale === 'de' ? 'Zum Durchsuchten' : 'Binge Worthy'),
    anime: (_i, o) => (o?.locale === 'de' ? 'Anime für Dich' : 'Anime For You'),
    'short-movies': (_i, o) => (o?.locale === 'de' ? 'Kurze Filme' : 'Short Movies'),
    'recently-added': (_i, o) => (o?.locale === 'de' ? 'Neu hinzugefügt' : 'Recently Added'),
};

// Stub getStrategy to return a minimal strategy object for any known id.
// This satisfies the load-time `if (!strategy) throw` guard in SECTION_PLAN.
mockGetStrategy.mockImplementation((id: string) => {
    if (STRATEGY_LABELS[id]) {
        return { id, label: STRATEGY_LABELS[id], fetch: vi.fn() };
    }
    return undefined;
});

const { def, _resolveUiLocale, FEED_SECTION_BUDGET_MS } = await import('./feed.js');
const { DependencyUnavailableError } = await import('$lib/server/api/problem.js');

const CTX = {
    surface: 'v1' as const,
    input: { query: { limit: 10, sections: undefined as string | undefined } },
};

const FAKE_ACCESS_CTX = {
    userId: 'usr_00000000-0000-0000-0000-000000000001' as import('$lib/shared/user-id.js').UserId,
    username: 'alice',
    deniedGroupIds: null,
    maxAgeRating: null,
    allowUnrated: true,
    showUnavailableMedia: true,
    isAgeRestricted: false,
};

function makeEvent(
    params: {
        limit?: number;
        sections?: string;
        types?: string;
        headers?: Record<string, string>;
    } = {},
): RequestEvent {
    const url = new URL('http://localhost/api/v1/feed');
    if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
    if (params.sections !== undefined) url.searchParams.set('sections', params.sections);
    if (params.types !== undefined) url.searchParams.set('types', params.types);

    return {
        url,
        params: {},
        route: { id: '/api/v1/feed' as const },
        request: new Request(url.toString(), { headers: params.headers }),
        locals: {
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
                groups: '',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
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

/** Build a minimal success result with `n` items. */
function makeRailResult(n: number) {
    return {
        items: Array.from({ length: n }, (_, i) => ({
            media: { id: `tmdb:${i + 1}:movie`, type: 'movie', title: `Movie ${i}`, ids: {} },
        })),
        hasMore: false,
    };
}

function makeCtx(extra: { sections?: string; limit?: number; types?: string } = {}) {
    return {
        ...CTX,
        input: {
            query: {
                limit: extra.limit ?? 10,
                sections: extra.sections,
                types: extra.types,
            },
        },
    };
}

async function callGet(
    params: {
        limit?: number;
        sections?: string;
        types?: string;
        headers?: Record<string, string>;
    } = {},
) {
    const event = makeEvent(params);
    const ctx = makeCtx(params);
    const handler = def.handlers.GET!;
    const res = await handler(event, ctx as Parameters<typeof handler>[1]);
    const body = await res.clone().json();
    return { status: res.status, body };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockPaths.base = '';
    // Restore getStrategy stub after clearAllMocks.
    mockGetStrategy.mockImplementation((id: string) => {
        if (STRATEGY_LABELS[id]) {
            return { id, label: STRATEGY_LABELS[id], fetch: vi.fn() };
        }
        return undefined;
    });
    mockBuildAccessContext.mockResolvedValue(FAKE_ACCESS_CTX);
    // Default: every section returns 2 items.
    mockGetRailItems.mockResolvedValue(makeRailResult(2));
    // Default: no watching section (most existing tests don't care about it).
    mockBuildWatchingSection.mockResolvedValue(null);
    mockBuildAudiobookActivitySection.mockResolvedValue(null);
    // Default: no BYW rails (most existing tests don't care about it).
    mockBuildBywSections.mockResolvedValue([]);
});

describe('GET /api/v1/feed — audiobook activity rail', () => {
    const activitySection = {
        type: 'audiobook-activity',
        id: 'audiobook-activity',
        title: 'Listening in your circle',
        items: [
            {
                author: {
                    userId: '550e8400-e29b-41d4-a716-446655440001',
                    displayName: 'Alex',
                    images: {
                        primary: {
                            href: '/api/users/alex/images/primary',
                            revision: '1',
                            source: 'generated',
                        },
                    },
                },
                media: {
                    id: '550e8400-e29b-41d4-a716-446655440002',
                    catalogId: '550e8400-e29b-41d4-a716-446655440002',
                    type: 'audiobook',
                    ids: {},
                    title: 'A Book',
                    images: {},
                    audiobook: { authors: [], narrators: [], series: null },
                },
                kind: 'listened',
                listenedMinutes: 15,
                occurredOn: '2026-10-23',
                approximate: true,
            },
        ],
    };

    it.each(['', '/lumastra'])(
        'preserves nonempty rich activity through the mounted internal response at install base %s',
        async (base) => {
            mockPaths.base = base;
            mockBuildAudiobookActivitySection.mockResolvedValue(activitySection);
            const event = makeEvent({ sections: 'audiobook-activity' });
            event.url.pathname = `${base}/api/feed`;
            event.request = new Request(event.url);
            event.route = { id: '/api/feed' } as RequestEvent['route'];
            const response = await mount(def, { surface: 'internal' }).GET!(event);
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body.sections[0].source.href).toBe(
                `${base}/api/feed?sections=audiobook-activity`,
            );
            for (const path of [
                '/api/v1/feed',
                '/api/other',
                '/unexpected/feed',
                '/api/feed/extra',
                '/lumastra/api/feed',
            ]) {
                // 91d8ae8c9a restores the public contract as the fallback so
                // mount() also validates ordinary public feed responses.
                expect(def.docsByPath!(path)).toBe(def.docs);
            }
            const internalDocs = def.docsByPath!('/api/feed')!.GET!;
            const publicDocs = def.docs!.GET!;
            expect(internalDocs.query).toBe(publicDocs.query);
            expect(internalDocs.auth).toBe(publicDocs.auth);
            expect(internalDocs.stability).toBe(publicDocs.stability);
            expect(internalDocs.tags).toEqual(publicDocs.tags);
            for (const status of [401, 500, 503]) {
                expect(internalDocs.responses[status]).toEqual(publicDocs.responses[status]);
            }
            expect(internalDocs.description).toContain(
                'author, media, kind, listenedMinutes, occurredOn, and approximate',
            );
            expect(internalDocs.description).toContain('?sections=for-you,trending');
            expect(internalDocs.description).toContain('fault isolation');
            expect(AudiobookActivityFeedResponseSchema.parse(body).sections[0].items).toEqual(
                activitySection.items,
            );
            // Prove production's final conformance parse keeps the same rich fields.
            const schema = def.docsByPath!('/api/feed')!.GET!.responses[200];
            if (typeof schema === 'string' || !('schema' in schema) || !schema.schema)
                throw new Error('Missing internal schema');
            expect(schema.schema.parse(body)).toEqual(body);
            expect(mockBuildAudiobookActivitySection).toHaveBeenCalledWith(
                FAKE_ACCESS_CTX,
                'internal',
                'en',
                10,
                { requireViewerListening: true },
            );
        },
    );

    it('retains ordinary flat carousels alongside rich internal activity in order', async () => {
        mockBuildAudiobookActivitySection.mockResolvedValue(activitySection);
        const event = makeEvent({ sections: 'audiobook-activity,for-you' });
        event.route = { id: '/api/feed' } as RequestEvent['route'];
        const response = await mount(def, { surface: 'internal' }).GET!(event);
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.sections.map((section: { id: string }) => section.id)).toEqual([
            'audiobook-activity',
            'for-you',
        ]);
        expect(body.sections[0].items).toEqual(activitySection.items);
        expect(MediaPreviewSchema.parse(body.sections[1].items[0])).toEqual(
            body.sections[1].items[0],
        );
        const schema = def.docsByPath!('/api/feed')!.GET!.responses[200];
        if (typeof schema === 'string' || !('schema' in schema) || !schema.schema)
            throw new Error('Missing internal schema');
        expect(schema.schema.parse(body)).toEqual(body);
    });

    it('drops invalid internal activity rows before rendering', async () => {
        mockBuildAudiobookActivitySection.mockResolvedValue({
            ...activitySection,
            items: [{ ...activitySection.items[0], author: undefined }],
        });
        const response = await mount(def, { surface: 'internal' }).GET!(
            makeEvent({ sections: 'audiobook-activity' }),
        );
        const body = await response.json();
        expect(AudiobookActivityFeedResponseSchema.parse(body).sections[0].items).toEqual([]);
    });

    it('composes the narrow activity-only request without recommendation fan-out', async () => {
        mockBuildAudiobookActivitySection.mockResolvedValue(activitySection);

        const response = await mount(def, { surface: 'v1' }).GET!(
            makeEvent({ sections: 'audiobook-activity' }),
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.sections).toHaveLength(1);
        const preview = body.sections[0].items[0];
        expect(MediaPreviewSchema.parse(preview)).toEqual(preview);
        expect(preview).toMatchObject({
            id: activitySection.items[0].media.id,
            type: 'audiobook',
            title: 'A Book',
            reason: { kind: 'listened', label: 'Alex' },
        });
        expect(preview).not.toHaveProperty('author');
        expect(preview).not.toHaveProperty('media');
        expect(body.sections[0].source.href).toBe('/api/v1/feed?sections=audiobook-activity');
        expect(mockGetRailItems).not.toHaveBeenCalled();
        // The gate is part of /feed's contract, not an implementation detail:
        // this is the general home feed, so the rail must earn its slot on the
        // viewer's own listening. /audiobooks builds its section without it.
        expect(mockBuildAudiobookActivitySection).toHaveBeenCalledWith(
            FAKE_ACCESS_CTX,
            'v1',
            'en',
            10,
            { requireViewerListening: true },
        );
    });

    it('places activity after watching and before recommendation carousels', async () => {
        mockBuildWatchingSection.mockResolvedValue({
            type: 'watching',
            id: 'watching',
            title: 'Watching',
            items: [],
            source: { href: '/api/v1/continue-watching' },
        });
        mockBuildAudiobookActivitySection.mockResolvedValue(activitySection);

        const { body } = await callGet({ sections: 'watching,audiobook-activity,for-you' });
        expect(body.sections.map((section: { id: string }) => section.id)).toEqual([
            'watching',
            'audiobook-activity',
            'for-you',
        ]);
    });

    it('isolates activity composer failures', async () => {
        mockBuildAudiobookActivitySection.mockRejectedValue(new Error('activity failed'));

        const { status, body } = await callGet({ sections: 'audiobook-activity,for-you' });
        expect(status).toBe(200);
        expect(body.sections.map((section: { id: string }) => section.id)).toEqual(['for-you']);
    });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/feed — sections= filter', () => {
    it('returns only the requested section when sections= names one id', async () => {
        const { status, body } = await callGet({ sections: 'trending' });

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(1);
        expect(body.sections[0].id).toBe('trending');
        // Only trending was requested → getRailItems called once.
        expect(mockGetRailItems).toHaveBeenCalledTimes(1);
        expect(mockGetRailItems).toHaveBeenCalledWith(
            'trending',
            FAKE_ACCESS_CTX,
            expect.any(Object),
        );
    });

    it('returns only the two requested sections when sections= names two ids', async () => {
        const { status, body } = await callGet({ sections: 'for-you,anime' });

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(2);
        const ids = body.sections.map((s: { id: string }) => s.id);
        expect(ids).toContain('for-you');
        expect(ids).toContain('anime');
        expect(mockGetRailItems).toHaveBeenCalledTimes(2);
    });

    it('returns ALL sections when sections= is absent', async () => {
        const { status, body } = await callGet({});

        expect(status).toBe(200);
        // All 8 section IDs → 8 calls → all 8 have items → 8 in response.
        expect(mockGetRailItems).toHaveBeenCalledTimes(SECTION_IDS.length);
        expect(body.sections).toHaveLength(SECTION_IDS.length);
        expect(body).not.toHaveProperty('pendingSections');
    });

    it('leads with the personalised ai rail and keeps for-you off its heels, each with its own icon', async () => {
        const { body } = await callGet({});
        const sections = body.sections as Array<{ id: string; icon?: string }>;
        const ids = sections.map((s) => s.id);

        expect(ids[0]).toBe('ai');
        // "For You" and "Recommended for You" read as one rail twice when adjacent.
        expect(Math.abs(ids.indexOf('ai') - ids.indexOf('for-you'))).toBeGreaterThan(1);

        const icons = sections.map((s) => s.icon);
        expect(icons.every((icon) => typeof icon === 'string' && icon.length > 0)).toBe(true);
        expect(new Set(icons).size).toBe(icons.length);
    });

    it('treats sections= (empty string param) as no filter — returns all sections', async () => {
        // An empty sections= value after split+filter produces no ids,
        // so the feed falls back to emitting all sections.
        const { status, body } = await callGet({ sections: '' });

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(SECTION_IDS.length);
    });

    it('returns 0 sections for an unknown section id (not in the SECTION_PLAN)', async () => {
        // 'unknown-rail' is not in SECTION_IDS so it is filtered out before
        // any getRailItems call — the result is an empty sections array.
        const { status, body } = await callGet({ sections: 'unknown-rail' });

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(0);
        expect(mockGetRailItems).not.toHaveBeenCalled();
    });
});

describe('GET /api/v1/feed — per-section time budget', () => {
    it('answers without a rail that outlives its budget, and that rail keeps running', async () => {
        vi.useFakeTimers();
        try {
            let bingeSettled = false;
            let finishBinge: (v: ReturnType<typeof makeRailResult>) => void = () => {};
            mockGetRailItems.mockImplementation(async (id: string) => {
                if (id !== 'binge-worthy') return makeRailResult(2);
                return new Promise((resolve) => {
                    finishBinge = (v) => {
                        bingeSettled = true;
                        resolve(v);
                    };
                });
            });

            const pending = callGet({ sections: 'ai,binge-worthy' });
            await vi.advanceTimersByTimeAsync(FEED_SECTION_BUDGET_MS + 1);
            const { status, body } = await pending;

            expect(status).toBe(200);
            expect(body.sections.map((s: { id: string }) => s.id)).toEqual(['ai']);
            expect(body).not.toHaveProperty('pendingSections');
            // Not cancelled: the late computation still completes (and warms its cache).
            finishBinge(makeRailResult(3));
            await vi.advanceTimersByTimeAsync(0);
            expect(bingeSettled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('GET /api/v1/feed — per-section fault isolation', () => {
    it('drops a section that throws DependencyUnavailableError; other sections remain (200)', async () => {
        // 'trending' throws; 'for-you' succeeds with 2 items.
        mockGetRailItems.mockImplementation(async (id: string) => {
            if (id === 'trending') {
                throw new DependencyUnavailableError('Valkey unavailable', 'valkey');
            }
            return makeRailResult(2);
        });

        const { status, body } = await callGet({ sections: 'for-you,trending' });

        expect(status).toBe(200);
        // 'trending' was dropped; 'for-you' must be present.
        expect(body.sections).toHaveLength(1);
        expect(body.sections[0].id).toBe('for-you');
    });

    it('returns 200 with an empty sections array when ALL sections throw DependencyUnavailableError', async () => {
        mockGetRailItems.mockRejectedValue(
            new DependencyUnavailableError('Database unavailable', 'postgres'),
        );

        const { status, body } = await callGet({ sections: 'for-you,trending' });

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(0);
    });

    it('drops a section that throws a generic (non-dependency) error; other sections remain (200)', async () => {
        mockGetRailItems.mockImplementation(async (id: string) => {
            if (id === 'ai') throw new Error('AI service timeout');
            return makeRailResult(3);
        });

        const { status, body } = await callGet({ sections: 'ai,for-you' });

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(1);
        expect(body.sections[0].id).toBe('for-you');
    });

    it('does NOT propagate DependencyUnavailableError to the caller as 503', async () => {
        // /feed must always be 200 even when every dependency is down.
        mockGetRailItems.mockRejectedValue(
            new DependencyUnavailableError('Database unavailable', 'postgres'),
        );

        const { status } = await callGet({});

        expect(status).toBe(200);
        expect(status).not.toBe(503);
    });
});

describe('GET /api/v1/feed — preview hydration fault isolation', () => {
    it('drops only the section whose artwork hydration fails', async () => {
        mockResolveImageSets.mockRejectedValueOnce(new Error('Artwork database unavailable'));
        const { status, body } = await callGet({ sections: 'ai,trending' });
        expect(status).toBe(200);
        expect(body.sections).toHaveLength(1);
        expect(body.sections[0].items[0]).toMatchObject({
            id: 'tmdb:1:movie',
            catalogId: null,
            type: 'movie',
            images: {},
        });
    });
});

describe('GET /api/v1/feed — empty-section pruning', () => {
    it('omits a section whose strategy returns 0 items', async () => {
        mockGetRailItems.mockImplementation(async (id: string) => {
            if (id === 'anime') return makeRailResult(0); // 0 items → must be dropped
            return makeRailResult(2);
        });

        const { status, body } = await callGet({ sections: 'for-you,anime' });

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(1);
        expect(body.sections[0].id).toBe('for-you');
    });

    it('returns an empty sections array when ALL strategies return 0 items', async () => {
        mockGetRailItems.mockResolvedValue(makeRailResult(0));

        const { status, body } = await callGet({});

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(0);
    });

    it('includes sections with items but excludes those with 0 items', async () => {
        // Three sections requested; middle one has 0 items.
        mockGetRailItems.mockImplementation(async (id: string) => {
            if (id === 'trending') return makeRailResult(0);
            return makeRailResult(5);
        });

        const { status, body } = await callGet({ sections: 'for-you,trending,anime' });

        expect(status).toBe(200);
        expect(body.sections).toHaveLength(2);
        const ids = body.sections.map((s: { id: string }) => s.id);
        expect(ids).not.toContain('trending');
        expect(ids).toContain('for-you');
        expect(ids).toContain('anime');
    });
});

describe('GET /api/v1/feed — section shape', () => {
    it('each section carries id, type=carousel, title, items, source.href', async () => {
        const { status, body } = await callGet({ sections: 'trending' });

        expect(status).toBe(200);
        const section = body.sections[0];
        expect(section.id).toBe('trending');
        expect(section.type).toBe('carousel');
        expect(typeof section.title).toBe('string');
        expect(Array.isArray(section.items)).toBe(true);
        expect(section.source?.href).toBeDefined();
    });

    it('trending section href links to /api/v1/trending (not /recommendations?type=trending)', async () => {
        const { body } = await callGet({ sections: 'trending' });
        expect(body.sections[0].source.href).toContain('/trending');
        expect(body.sections[0].source.href).not.toContain('recommendations');
    });

    it('non-trending section href links to /api/v1/recommendations?type=<id>', async () => {
        const { body } = await callGet({ sections: 'for-you' });
        expect(body.sections[0].source.href).toContain('/recommendations?type=for-you');
    });
});

describe('GET /api/v1/feed — watching section ordering (m3)', () => {
    it('places the watching section at sections[0] when present, ahead of carousels', async () => {
        const watchingStub = {
            type: 'watching' as const,
            id: 'watching',
            title: 'Continue Watching',
            items: [
                {
                    id: '123e4567-e89b-42d3-a456-426614174001',
                    catalogId: '123e4567-e89b-42d3-a456-426614174001',
                    type: 'episode',
                    title: 'Ep',
                    ids: {},
                    images: {},
                    origin: 'cw' as const,
                },
            ],
            source: { href: '/api/v1/continue-watching' },
        };
        mockBuildWatchingSection.mockResolvedValue(watchingStub);

        const { status, body } = await callGet({ sections: 'watching,for-you' });

        expect(status).toBe(200);
        expect(body.sections[0].type).toBe('watching');
        expect(body.sections[0].id).toBe('watching');
        expect(body.sections[1].id).toBe('for-you');
    });

    it('omits the watching section entirely when the composer returns null', async () => {
        mockBuildWatchingSection.mockResolvedValue(null);

        const { body } = await callGet({ sections: 'watching,for-you' });

        expect(body.sections.map((s: { id: string }) => s.id)).not.toContain('watching');
    });

    it('does not call buildWatchingSection when sections= excludes it', async () => {
        const { body } = await callGet({ sections: 'for-you' });

        expect(mockBuildWatchingSection).not.toHaveBeenCalled();
        expect(body.sections.map((s: { id: string }) => s.id)).not.toContain('watching');
    });

    it('passes a public media-type allow-list to the watching composer', async () => {
        mockBuildWatchingSection.mockResolvedValue(null);

        await callGet({ sections: 'watching', types: 'movie,series' });

        expect(mockBuildWatchingSection).toHaveBeenCalledWith(
            expect.anything(),
            10,
            expect.any(String),
            'v1',
            'en',
            new Set(['movie', 'series']),
        );
    });

    it('rejects unknown watching media types', async () => {
        const { status } = await callGet({ types: 'movies' });

        expect(status).toBe(422);
        expect(mockBuildWatchingSection).not.toHaveBeenCalled();
    });
});

describe('GET /api/v1/feed — byw scoping', () => {
    const BYW_A = {
        type: 'carousel' as const,
        id: 'byw:aaa',
        title: 'Because you watched A',
        items: [
            {
                id: 'tmdb:1:movie',
                catalogId: null,
                type: 'movie',
                title: 'Rec A',
                ids: {},
                images: {},
            },
        ],
        source: { href: '/api/v1/recommendations?type=because-you-watched&seed=aaa' },
    };
    const BYW_B = {
        type: 'carousel' as const,
        id: 'byw:bbb',
        title: 'Because you watched B',
        items: [
            {
                id: 'tmdb:2:movie',
                catalogId: null,
                type: 'movie',
                title: 'Rec B',
                ids: {},
                images: {},
            },
        ],
        source: { href: '/api/v1/recommendations?type=because-you-watched&seed=bbb' },
    };

    it('returns ONLY the requested byw:<id> rail, not every offered top-N rail', async () => {
        mockBuildBywSections.mockResolvedValue([BYW_A, BYW_B]);

        const { status, body } = await callGet({ sections: 'byw:aaa' });

        expect(status).toBe(200);
        const ids = body.sections.map((s: { id: string }) => s.id);
        expect(ids).toContain('byw:aaa');
        expect(ids).not.toContain('byw:bbb');
        expect(body.sections).toHaveLength(1);
    });

    it('returns ALL offered byw rails when sections=byw (the all-rails pseudo-id)', async () => {
        mockBuildBywSections.mockResolvedValue([BYW_A, BYW_B]);

        const { status, body } = await callGet({ sections: 'byw' });

        expect(status).toBe(200);
        const ids = body.sections.map((s: { id: string }) => s.id);
        expect(ids).toContain('byw:aaa');
        expect(ids).toContain('byw:bbb');
    });

    it('yields no BYW section (not an error) when the requested byw:<id> is not among the offered top-N', async () => {
        mockBuildBywSections.mockResolvedValue([BYW_A, BYW_B]);

        const { status, body } = await callGet({ sections: 'byw:ccc' });

        expect(status).toBe(200);
        const ids = body.sections.map((s: { id: string }) => s.id);
        expect(ids).not.toContain('byw:aaa');
        expect(ids).not.toContain('byw:bbb');
        expect(ids).not.toContain('byw:ccc');
    });
});

describe('GET /api/v1/feed — auth', () => {
    it('returns 401 when buildAccessContext returns null (no authenticated user)', async () => {
        mockBuildAccessContext.mockResolvedValue(null);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), makeCtx() as Parameters<typeof handler>[1]);

        expect(res.status).toBe(401);
        expect(mockGetRailItems).not.toHaveBeenCalled();
    });
});

describe('GET /api/v1/feed — locale-negotiated section titles', () => {
    it('returns German section titles for an Accept-Language: de request', async () => {
        const { status, body } = await runWithRequestLanguage(
            { cookieLocale: null, acceptLanguage: 'de-DE,de;q=0.9' },
            () => callGet({ headers: { 'accept-language': 'de-DE,de;q=0.9' } }),
        );

        expect(status).toBe(200);
        const titles = body.sections.map((s: { title: string }) => s.title);
        const expectedDeTitles = Object.values(STRATEGY_LABELS).map((label) =>
            label({}, { locale: 'de' }),
        );
        for (const title of titles) {
            expect(expectedDeTitles).toContain(title);
        }
    });

    it('returns English section titles when no Accept-Language header or cookie is present', async () => {
        const { status, body } = await runWithRequestLanguage(
            { cookieLocale: null, acceptLanguage: null },
            () => callGet({}),
        );

        expect(status).toBe(200);
        const titles = body.sections.map((s: { title: string }) => s.title);
        const expectedEnTitles = Object.values(STRATEGY_LABELS).map((label) =>
            label({}, { locale: 'en' }),
        );
        for (const title of titles) {
            expect(expectedEnTitles).toContain(title);
        }
    });

    it('does not render German chrome for an invalid cookie value', () => {
        const locale = runWithRequestLanguage(
            { cookieLocale: 'xx-not-a-locale', acceptLanguage: 'en' },
            () =>
                _resolveUiLocale({
                    request: new Request('http://x/', {
                        headers: { 'accept-language': 'en' },
                    }),
                } as RequestEvent),
        );
        expect(locale).toBe('en');
    });
});
