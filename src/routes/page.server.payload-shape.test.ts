// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Payload-shape ratchet for the homepage `__data.json`.
 *
 * SvelteKit hardcodes `private, no-store` on data responses, so everything this
 * load returns is re-fetched on EVERY client-side navigation — bytes here are
 * paid over and over. A 2026-09-22 audit found three independent leaks:
 *
 *  1. `liveTvSection` serialized the entire channel lineup (60-80 KB on a
 *     200-channel IPTV install) even though `LiveTvWidget` refetches it all on
 *     mount anyway.
 *  2. Keys with zero readers (`renderedWidgets`, and the full `onboardingSteps`
 *     rows behind a single boolean).
 *  3. Full TMDB synopses on rail items, which no homepage card can render at
 *     full length.
 *
 * Each of those regrows silently — nothing fails when a `.slice()` is dropped
 * or a convenient-looking key is added back. So assert at the SEAM: call the
 * real `load` and inspect the object it actually returns, rather than testing
 * an extracted helper that the route might stop calling.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PageSection } from '$lib/types/server-driven-ui.js';
import { homeMusicSessions } from '$lib/api/home-active-sessions.fixture.js';
import { getVisibleActiveSessions } from '$lib/server/services/active-sessions-view.service.js';
import { isWidgetDisabled } from '$lib/server/utils/widget-guard.js';

const CHANNEL_COUNT = 200;

const { mockGetChannels, mockDetermineHeroState, mockCacheGet, mockCacheSet, mockAvailability } =
    vi.hoisted(() => ({
        mockGetChannels: vi.fn(),
        mockDetermineHeroState: vi.fn(),
        mockCacheGet: vi.fn(),
        mockCacheSet: vi.fn(),
        mockAvailability: vi.fn(),
    }));
const mockFavoriteStationIds = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    getFavoriteChannelIds: vi.fn(async () => []),
    stationIdsOfFeeds: mockFavoriteStationIds,
}));

vi.mock('$lib/server/services/livetv/availability.service.js', () => ({
    getLiveTvAvailability: mockAvailability,
}));
vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn(async () => ({ getChannels: mockGetChannels })),
}));
vi.mock('$lib/server/cache/index.js', () => ({
    // `cacheManager.for(ns)` must hand back the SAME stub for every namespace —
    // the load uses it for both the LiveTV section and the hero state.
    cacheManager: { for: () => ({ get: mockCacheGet, set: mockCacheSet }) },
    CACHE_NAMESPACES: { liveTvWhatsOnNow: 'livetv', heroState: 'hero' },
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    determineHeroState: mockDetermineHeroState,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/effective-watching.service.js', () => ({
    effectiveWatchingFor: vi.fn(async () => null),
}));
vi.mock('$lib/server/utils/section-builder.js', () => ({ buildWatchingSections: vi.fn() }));
vi.mock('$lib/server/utils/hero-first-slide.js', () => ({
    resolveHeroFirstSlide: vi.fn(async () => null),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({})),
    searchAccessBoundary: vi.fn(() => ({ library: { kind: 'all' }, age: { kind: 'any' } })),
}));
vi.mock('$lib/server/utils/metadata-language-resolve.js', () => ({
    resolveViewerMetadataLanguages: vi.fn(async () => ({})),
}));
vi.mock('$lib/server/dev-user.js', () => ({ getEffectiveUser: (l: unknown) => l }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn(async () => 'u1'),
}));
vi.mock('$lib/server/database/queries/index.js', () => ({
    // A typed-query object, not a bare function — the route calls `.one(...)`.
    getWidgetOrder: { one: vi.fn(async () => null) },
}));
vi.mock('$lib/server/services/active-sessions-view.service.js', () => ({
    getVisibleActiveSessions: vi.fn(async () => null),
}));
vi.mock('$lib/server/utils/widget-guard.js', () => ({ isWidgetDisabled: vi.fn(() => true) }));
vi.mock('$lib/server/utils/landing-path', () => ({ isValidLandingPath: () => false }));
vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    listPinnedBroadcastsForUser: vi.fn(async () => []),
}));
vi.mock('$lib/server/services/notification-display.service.js', () => ({
    buildNotificationPresentation: vi.fn(),
}));
vi.mock('$lib/server/services/push/push-payload.js', () => ({ resolvePushLocale: () => 'en' }));
vi.mock('$lib/paraglide/runtime.js', () => ({ getLocale: () => 'en' }));
vi.mock('$lib/server/plugins/runtime/widget-metadata.js', () => ({
    listPluginWidgets: vi.fn(async () => []),
}));
vi.mock('$lib/server/config.js', () => ({
    config: { INSTANCE_LANDING_PATH: '', TMDB_API_KEY: '', FEATURE_SESSIONS: true },
}));
vi.mock('$lib/server/services/livetv/simple-mode-autostart.js', () => ({
    opensLiveTvOnStart: async () => false,
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { load } = await import('./+page.server.js');

function makeChannel(i: number) {
    return {
        id: `ch-${i}`,
        name: `Channel ${i}`,
        isVisible: true,
        images: {
            primary: {
                href: `https://example.invalid/logo-${i}.png`,
                revision: '0',
                source: 'self',
            },
        },
        currentProgram: {
            title: `Program ${i}`,
            startTime: new Date(Date.now() - 600_000).toISOString(),
            endTime: new Date(Date.now() + 600_000).toISOString(),
        },
    };
}

async function runLoad() {
    return (await load({
        locals: {
            user: {
                userId: 'u1',
                username: 'alice',
                isAgeRestricted: false,
                // The LiveTV seed is gated on this — without it the section is
                // never built and the bound below would pass vacuously.
                hasLiveTvPermission: true,
            },
        },
        request: new Request('http://localhost/'),
        url: new URL('http://localhost/'),
        depends: () => {},
    } as never)) as Record<string, unknown>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockFavoriteStationIds.mockResolvedValue([]);
    vi.mocked(isWidgetDisabled).mockReturnValue(true);
    mockAvailability.mockResolvedValue({
        observedAt: new Date().toISOString(),
        evidenceUnavailable: false,
        sources: [],
        channels: {},
        suppressedChannelIds: [],
    });
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockGetChannels.mockResolvedValue(
        Array.from({ length: CHANNEL_COUNT }, (_, i) => makeChannel(i)),
    );
    mockDetermineHeroState.mockResolvedValue({
        heroState: 'full-metadata',
        isAdmin: false,
        mediaCount: 10,
        onboardingSteps: [],
    });
});

describe('homepage __data.json payload shape', () => {
    it('seeds the same full session projection used by the home refresh endpoint', async () => {
        vi.mocked(isWidgetDisabled).mockReturnValue(false);
        vi.mocked(getVisibleActiveSessions).mockResolvedValue({
            visible: true,
            sessions: homeMusicSessions(),
            cacheTimestamp: 1234,
        });
        const data = await runLoad();
        expect(data.initialSessions).toEqual(homeMusicSessions());
        expect(data.initialSessionsCacheTimestamp).toBe(1234);
        expect(getVisibleActiveSessions).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ userId: 'u1', username: 'alice', isAdmin: false }),
        );
    });

    it('bounds the LiveTV seed instead of serializing the whole lineup', async () => {
        const data = await runLoad();
        const section = data.liveTvSection as PageSection | null;

        // The provider really did offer 200 — so a passing assertion below is a
        // comparison against an unbounded alternative, not a vacuous check on a
        // short fixture.
        expect(mockGetChannels).toHaveBeenCalled();
        expect(section).not.toBeNull();
        expect(section!.items.length).toBeLessThan(CHANNEL_COUNT);
        expect(section!.items.length).toBeLessThanOrEqual(20);
    });

    it("puts the viewer's favorite channels first, even beyond the seed limit", async () => {
        mockFavoriteStationIds.mockResolvedValue(['ch-150', 'ch-3']);
        const data = await runLoad();
        const section = data.liveTvSection as PageSection;
        expect(section.items.slice(0, 3).map((i) => i.id)).toEqual(['ch-150', 'ch-3', 'ch-0']);
        // The shared cache entry stays in lineup order for every other viewer.
        const cached = mockCacheSet.mock.calls.at(-1)?.[1] as PageSection;
        expect(cached.items[0].id).toBe('ch-0');
    });

    it('caches the BOUNDED section, so a cache hit cannot restore the full lineup', async () => {
        await runLoad();
        const cached = mockCacheSet.mock.calls.at(-1)?.[1] as PageSection;
        expect(cached.items.length).toBeLessThanOrEqual(20);
    });

    it('does not ship keys with no client reader', async () => {
        const data = await runLoad();

        // `renderedWidgets` was declared `{}` and never written or read.
        expect(data).not.toHaveProperty('renderedWidgets');
        // The page reads ONE boolean off the onboarding rows; the rows also
        // carried `dismissed_by` / `dismissed_at`.
        expect(data).not.toHaveProperty('onboardingSteps');
        expect(data).toHaveProperty('tmdbNudgeDismissed');
        expect(typeof data.tmdbNudgeDismissed).toBe('boolean');
    });

    it('resolves tmdbNudgeDismissed from the tmdb_config row', async () => {
        mockDetermineHeroState.mockResolvedValue({
            heroState: 'local-content',
            isAdmin: true,
            mediaCount: 1,
            onboardingSteps: [
                { step_key: 'onboarding_dismissed', dismissed: false },
                { step_key: 'tmdb_config', dismissed: true, dismissed_by: 'denis' },
            ],
        });
        const data = await runLoad();
        expect(data.tmdbNudgeDismissed).toBe(true);
        // The identity of whoever dismissed it must not reach the client.
        expect(JSON.stringify(data)).not.toContain('denis');
    });
});

describe('rail overview truncation', () => {
    const LONG = 'x'.repeat(900);

    async function loadWithWatchingSection(overview?: string) {
        const svc = await import('$lib/server/services/effective-watching.service.js');
        const builder = await import('$lib/server/utils/section-builder.js');
        vi.mocked(svc.effectiveWatchingFor).mockResolvedValue({
            continueWatching: [{ id: 'm1' }],
            nextUp: [],
        } as never);
        vi.mocked(builder.buildWatchingSections).mockReturnValue([
            {
                id: 'continue-watching',
                title: 'Continue Watching',
                type: 'continue-watching',
                items: [
                    {
                        id: 'm1',
                        title: 'A Movie',
                        mediaType: 'movie',
                        // Omit the key entirely when there is no synopsis —
                        // `overview: undefined` would still satisfy
                        // `toHaveProperty`, making that assertion test the
                        // fixture instead of the code.
                        ...(overview === undefined ? {} : { overview }),
                    },
                ],
            },
        ] as never);
        const data = await runLoad();
        const sections = data.watchingSections as PageSection[] | null;
        return sections?.[0]?.items?.[0];
    }

    it('truncates a long synopsis to what the cards can render', async () => {
        const item = await loadWithWatchingSection(LONG);
        expect(item?.overview).toBeDefined();
        expect(item!.overview!.length).toBeLessThanOrEqual(150);
        expect(item!.overview!.endsWith('...')).toBe(true);
        // Byte-identical to what MediaHoverCard would have produced from the
        // full string — so the truncation is invisible to the user.
        expect(item!.overview).toBe(LONG.substring(0, 147) + '...');
    });

    it('leaves a short synopsis untouched', async () => {
        const short = 'A short blurb.';
        const item = await loadWithWatchingSection(short);
        expect(item?.overview).toBe(short);
    });

    it('leaves a missing synopsis absent rather than emitting an empty string', async () => {
        const item = await loadWithWatchingSection();
        expect(item).not.toHaveProperty('overview');
    });
});

describe('audiobook chapter/file list stripping', () => {
    // One in-progress audiobook on prod carried 555 chapters + 555 audioFiles
    // inside this same blob — the fixture below stands in for that shape.
    const audiobookshelf = {
        chapters: [{ title: 'Chapter 1', start: 0 }],
        audioFiles: [{ ino: '1', filename: 'part1.mp3' }],
        authors: ['A. Author'],
        narrators: ['N. Narrator'],
    };

    async function loadWithAudiobookItem() {
        const svc = await import('$lib/server/services/effective-watching.service.js');
        const builder = await import('$lib/server/utils/section-builder.js');
        const hero = await import('$lib/server/utils/hero-first-slide.js');
        vi.mocked(svc.effectiveWatchingFor).mockResolvedValue({
            continueWatching: [{ id: 'ab1' }],
            nextUp: [],
        } as never);
        vi.mocked(builder.buildWatchingSections).mockReturnValue([
            {
                id: 'continue-watching',
                title: 'Continue Watching',
                type: 'continue-watching',
                items: [
                    {
                        id: 'ab1',
                        title: 'An Audiobook',
                        mediaType: 'audiobook',
                        customMetadata: { audiobookshelf },
                    },
                ],
            },
        ] as never);
        vi.mocked(hero.resolveHeroFirstSlide).mockResolvedValue({
            title: 'An Audiobook',
            mediaType: 'audiobook',
            customMetadata: { audiobookshelf },
            externalIds: { internal: 'ab1' },
        } as never);
        return runLoad();
    }

    function shelfOf(customMetadata: unknown): Record<string, unknown> | undefined {
        return (customMetadata as Record<string, unknown> | undefined)?.audiobookshelf as
            Record<string, unknown> | undefined;
    }

    it('strips chapters/audioFiles from the watching-rail item but keeps authors/narrators', async () => {
        const data = await loadWithAudiobookItem();
        const sections = data.watchingSections as PageSection[] | null;
        const item = sections?.[0]?.items?.[0] as { customMetadata?: unknown } | undefined;
        const shelf = shelfOf(item?.customMetadata);

        expect(shelf).toBeDefined();
        expect(shelf).not.toHaveProperty('chapters');
        expect(shelf).not.toHaveProperty('audioFiles');
        expect(shelf?.authors).toEqual(['A. Author']);
        expect(shelf?.narrators).toEqual(['N. Narrator']);
    });

    it('strips chapters/audioFiles from the SSR hero first slide too', async () => {
        const data = await loadWithAudiobookItem();
        const heroFirstSlide = data.heroFirstSlide as { customMetadata?: unknown } | null;
        const shelf = shelfOf(heroFirstSlide?.customMetadata);

        expect(shelf).toBeDefined();
        expect(shelf).not.toHaveProperty('chapters');
        expect(shelf).not.toHaveProperty('audioFiles');
        expect(shelf?.authors).toEqual(['A. Author']);
        expect(shelf?.narrators).toEqual(['N. Narrator']);
    });
});

describe('homepage Live TV promotion availability', () => {
    it('filters outages in fresh SSR before caching, retaining other sources', async () => {
        mockAvailability.mockResolvedValue({ suppressedChannelIds: ['ch-0', 'ch-1'] });
        const data = await runLoad();
        const section = data.liveTvSection as PageSection;
        expect(section.items.some((i) => ['ch-0', 'ch-1'].includes(i.id))).toBe(false);
        expect(section.items[0].id).toBe('ch-2');
    });
    it('filters existing cached SSR seed and re-admits its channels after recovery', async () => {
        const first = await runLoad();
        const seed = first.liveTvSection as PageSection;
        mockCacheGet.mockImplementation(async (key: string) =>
            key === 'whats-on-now' ? seed : null,
        );
        mockAvailability.mockResolvedValue({ suppressedChannelIds: ['ch-0'] });
        const failed = (await runLoad()).liveTvSection as PageSection;
        expect(failed.items.some((i) => i.id === 'ch-0')).toBe(false);
        mockAvailability.mockResolvedValue({ suppressedChannelIds: [] });
        const recovered = (await runLoad()).liveTvSection as PageSection;
        expect(recovered.items.some((i) => i.id === 'ch-0')).toBe(true);
    });
    it('intersects cached IDs with current visible lineup and refreshes changed programmes', async () => {
        const initial = (await runLoad()).liveTvSection as PageSection;
        mockCacheGet.mockImplementation(async (key: string) =>
            key === 'whats-on-now' ? initial : null,
        );
        const channels = await mockGetChannels();
        channels[0].isVisible = false;
        channels[1].currentProgram.title = 'New programme';
        mockGetChannels.mockResolvedValue(channels);
        const current = (await runLoad()).liveTvSection as PageSection;
        expect(current.items.some((item) => item.id === 'ch-0')).toBe(false);
        expect(current.items[0].subtitle).toContain('New programme');
        expect(current.items).toHaveLength(initial.items.length);
        const cached = mockCacheSet.mock.calls
            .filter((call) => call[0] === 'whats-on-now')
            .at(-1)?.[1] as PageSection;
        expect(cached.items[0].subtitle).toContain('New programme');
    });
});
