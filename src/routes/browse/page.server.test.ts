// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { PageSection } from '$lib/types/server-driven-ui.js';

const { mockEffectiveWatchingFor, mockLoadBrowseIndexData } = vi.hoisted(() => ({
    mockEffectiveWatchingFor: vi.fn(),
    mockLoadBrowseIndexData: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn() }));
vi.mock('$lib/server/services/effective-watching.service.js', () => ({
    effectiveWatchingFor: mockEffectiveWatchingFor,
}));
vi.mock('$lib/server/utils/section-builder.js', () => ({ buildWatchingSections: vi.fn() }));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(),
}));
vi.mock('$lib/server/utils/metadata-language-resolve.js', () => ({
    resolveViewerMetadataLanguages: vi.fn(),
}));
vi.mock('$lib/server/dev-user.js', () => ({ getEffectiveUser: vi.fn() }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn(),
}));
vi.mock('$lib/server/config.js', () => ({ config: { DEFAULT_USER: 'default' } }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn() }) },
}));
vi.mock('$lib/server/services/browse-index.service.js', () => ({
    loadBrowseIndexData: mockLoadBrowseIndexData,
}));

const { load } = await import('./+page.server.js');

const BROWSE_URL = new URL('http://localhost/browse');

describe('browse watching SSR policy', () => {
    it('marks age-restricted watching as intentionally suppressed', async () => {
        mockLoadBrowseIndexData.mockResolvedValue({
            recentlyAdded: [],
            genres: [],
            totalGenres: 0,
            hasMoreGenres: false,
            mediaServerAvailable: true,
        });
        const { getDb } = await import('$lib/server/database/connection.js');
        vi.mocked(getDb).mockReturnValue({} as never);

        const result = await load({
            locals: {
                user: {
                    userId: 'u1',
                    username: 'child',
                    isAgeRestricted: true,
                },
            },
            request: new Request('http://localhost/browse'),
            url: BROWSE_URL,
        } as never);

        expect(result).toMatchObject({ watching: null, watchingSuppressed: true });
        expect(mockEffectiveWatchingFor).not.toHaveBeenCalled();
        // Age-restricted viewers are NOT anonymous — the genre/recently-added
        // SSR branch is independent of watching suppression and still runs.
        expect(mockLoadBrowseIndexData).toHaveBeenCalled();
    });

    it('marks an unrestricted SSR miss as retryable rather than suppressed', async () => {
        mockLoadBrowseIndexData.mockResolvedValue({
            recentlyAdded: [],
            genres: [],
            totalGenres: 0,
            hasMoreGenres: false,
            mediaServerAvailable: true,
        });
        const { getDb } = await import('$lib/server/database/connection.js');
        vi.mocked(getDb).mockReturnValue(undefined as never);

        const result = await load({
            locals: {
                user: {
                    userId: 'u1',
                    username: 'alice',
                    isAgeRestricted: false,
                },
            },
            request: new Request('http://localhost/browse'),
            url: BROWSE_URL,
        } as never);

        expect(result).toMatchObject({ watching: null, watchingSuppressed: false });
        expect(mockEffectiveWatchingFor).not.toHaveBeenCalled();
    });
});

describe('browse watching SSR payload shape', () => {
    // One in-progress audiobook on prod carried 555 chapters + 555 audioFiles
    // inside this same blob — the fixture below stands in for that shape.
    const audiobookshelf = {
        chapters: [{ title: 'Chapter 1', start: 0 }],
        audioFiles: [{ ino: '1', filename: 'part1.mp3' }],
        authors: ['A. Author'],
        narrators: ['N. Narrator'],
    };

    it('strips chapters/audioFiles from the SSR Continue-Watching sections but keeps authors/narrators', async () => {
        const { getEffectiveUser } = await import('$lib/server/dev-user.js');
        const { getUserIdByUsername } =
            await import('$lib/server/database/queries/users.queries.js');
        const { buildSearchAccessContext } =
            await import('$lib/server/utils/search-access-context.js');
        const { resolveViewerMetadataLanguages } =
            await import('$lib/server/utils/metadata-language-resolve.js');
        const { buildWatchingSections } = await import('$lib/server/utils/section-builder.js');
        const { getDb } = await import('$lib/server/database/connection.js');

        vi.mocked(getDb).mockReturnValue({} as never);
        vi.mocked(getEffectiveUser).mockReturnValue('alice');
        vi.mocked(getUserIdByUsername).mockResolvedValue('u1' as never);
        vi.mocked(buildSearchAccessContext).mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
        } as never);
        vi.mocked(resolveViewerMetadataLanguages).mockResolvedValue({} as never);
        mockEffectiveWatchingFor.mockResolvedValue({ continueWatching: [], nextUp: [] });
        mockLoadBrowseIndexData.mockResolvedValue({
            recentlyAdded: [],
            genres: [],
            totalGenres: 0,
            hasMoreGenres: false,
            mediaServerAvailable: true,
        });
        vi.mocked(buildWatchingSections).mockReturnValue([
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

        const result = await load({
            locals: {
                user: { userId: 'u1', username: 'alice', isAgeRestricted: false },
            },
            request: new Request('http://localhost/browse'),
            url: BROWSE_URL,
        } as never);

        const sections = (result as { watching: { sections: PageSection[] } | null }).watching
            ?.sections;
        const item = sections?.[0]?.items?.[0] as { customMetadata?: unknown } | undefined;
        const shelf = (item?.customMetadata as Record<string, unknown> | undefined)
            ?.audiobookshelf as Record<string, unknown> | undefined;

        expect(shelf).toBeDefined();
        expect(shelf).not.toHaveProperty('chapters');
        expect(shelf).not.toHaveProperty('audioFiles');
        expect(shelf?.authors).toEqual(['A. Author']);
        expect(shelf?.narrators).toEqual(['N. Narrator']);
    });
});

describe('browse genre/recently-added SSR', () => {
    const LONG_OVERVIEW =
        'A'.repeat(200) + ' this text is long enough to need truncation for the rail cards';

    function baseEvent(overrides: { url?: URL } = {}) {
        return {
            locals: {
                user: { userId: 'u1', username: 'alice', isAgeRestricted: false },
            },
            request: new Request('http://localhost/browse'),
            url: overrides.url ?? BROWSE_URL,
        } as never;
    }

    it('returns genre sections and recently-added from the shared /api/browse service, reused directly', async () => {
        const { getDb } = await import('$lib/server/database/connection.js');
        vi.mocked(getDb).mockReturnValue({} as never);
        // Suppress the CW branch so this test only exercises the genre branch.
        mockEffectiveWatchingFor.mockResolvedValue({ continueWatching: [], nextUp: [] });
        const { buildSearchAccessContext } =
            await import('$lib/server/utils/search-access-context.js');
        vi.mocked(buildSearchAccessContext).mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
        } as never);
        const { resolveViewerMetadataLanguages } =
            await import('$lib/server/utils/metadata-language-resolve.js');
        vi.mocked(resolveViewerMetadataLanguages).mockResolvedValue({} as never);
        const { getEffectiveUser } = await import('$lib/server/dev-user.js');
        vi.mocked(getEffectiveUser).mockReturnValue('alice');
        const { buildWatchingSections } = await import('$lib/server/utils/section-builder.js');
        vi.mocked(buildWatchingSections).mockReturnValue([] as never);

        mockLoadBrowseIndexData.mockResolvedValue({
            recentlyAdded: [
                { id: 'r1', name: 'Recent One', type: 'movie', overview: LONG_OVERVIEW },
            ],
            genres: [
                {
                    genre: 'Action',
                    items: [
                        { id: 'g1', name: 'Genre One', type: 'movie', overview: LONG_OVERVIEW },
                    ],
                },
            ],
            totalGenres: 1,
            hasMoreGenres: false,
            mediaServerAvailable: true,
        });

        const result = (await load(baseEvent())) as {
            browseSsr: {
                recentlyAdded: Array<{ overview?: string }>;
                genres: Array<{ items: Array<{ overview?: string }> }>;
            } | null;
        };

        // Reuses the exact shared service — same cache entries as /api/browse.
        expect(mockLoadBrowseIndexData).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                mediaType: 'all',
                user: expect.objectContaining({ userId: 'u1' }),
            }),
        );

        expect(result.browseSsr).not.toBeNull();
        expect(result.browseSsr?.recentlyAdded).toHaveLength(1);
        expect(result.browseSsr?.genres).toHaveLength(1);

        // Every overview in the SSR payload is trimmed to the same 150-char
        // (147 + "…") cut the homepage uses.
        for (const item of result.browseSsr!.recentlyAdded) {
            expect(item.overview!.length).toBeLessThanOrEqual(150);
        }
        for (const row of result.browseSsr!.genres) {
            for (const item of row.items) {
                expect(item.overview!.length).toBeLessThanOrEqual(150);
            }
        }
    });

    it('resolves the SSR tab from the URL the same way the client onMount does', async () => {
        const { getDb } = await import('$lib/server/database/connection.js');
        vi.mocked(getDb).mockReturnValue({} as never);
        mockEffectiveWatchingFor.mockResolvedValue({ continueWatching: [], nextUp: [] });
        const { buildSearchAccessContext } =
            await import('$lib/server/utils/search-access-context.js');
        vi.mocked(buildSearchAccessContext).mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
        } as never);
        const { resolveViewerMetadataLanguages } =
            await import('$lib/server/utils/metadata-language-resolve.js');
        vi.mocked(resolveViewerMetadataLanguages).mockResolvedValue({} as never);
        const { getEffectiveUser } = await import('$lib/server/dev-user.js');
        vi.mocked(getEffectiveUser).mockReturnValue('alice');
        const { buildWatchingSections } = await import('$lib/server/utils/section-builder.js');
        vi.mocked(buildWatchingSections).mockReturnValue([] as never);
        mockLoadBrowseIndexData.mockResolvedValue({
            recentlyAdded: [],
            genres: [],
            totalGenres: 0,
            hasMoreGenres: false,
            mediaServerAvailable: true,
        });

        await load(baseEvent({ url: new URL('http://localhost/browse?type=series') }));

        expect(mockLoadBrowseIndexData).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mediaType: 'series' }),
        );
    });

    it('returns null (client fallback) when the shared service throws, without failing the page', async () => {
        const { getDb } = await import('$lib/server/database/connection.js');
        vi.mocked(getDb).mockReturnValue({} as never);
        mockEffectiveWatchingFor.mockResolvedValue({ continueWatching: [], nextUp: [] });
        const { buildSearchAccessContext } =
            await import('$lib/server/utils/search-access-context.js');
        vi.mocked(buildSearchAccessContext).mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
        } as never);
        const { resolveViewerMetadataLanguages } =
            await import('$lib/server/utils/metadata-language-resolve.js');
        vi.mocked(resolveViewerMetadataLanguages).mockResolvedValue({} as never);
        const { getEffectiveUser } = await import('$lib/server/dev-user.js');
        vi.mocked(getEffectiveUser).mockReturnValue('alice');
        const { buildWatchingSections } = await import('$lib/server/utils/section-builder.js');
        vi.mocked(buildWatchingSections).mockReturnValue([] as never);
        mockLoadBrowseIndexData.mockRejectedValue(new Error('db exploded'));

        const result = (await load(baseEvent())) as { browseSsr: unknown };

        expect(result.browseSsr).toBeNull();
    });

    it('runs the genre branch concurrently with the watching branch, not after it', async () => {
        const { getDb } = await import('$lib/server/database/connection.js');
        vi.mocked(getDb).mockReturnValue({} as never);
        const { buildSearchAccessContext } =
            await import('$lib/server/utils/search-access-context.js');
        vi.mocked(buildSearchAccessContext).mockResolvedValue({
            deniedGroupIds: null,
            ageRating: null,
        } as never);
        const { resolveViewerMetadataLanguages } =
            await import('$lib/server/utils/metadata-language-resolve.js');
        vi.mocked(resolveViewerMetadataLanguages).mockResolvedValue({} as never);
        const { getEffectiveUser } = await import('$lib/server/dev-user.js');
        vi.mocked(getEffectiveUser).mockReturnValue('alice');
        const { buildWatchingSections } = await import('$lib/server/utils/section-builder.js');
        vi.mocked(buildWatchingSections).mockReturnValue([] as never);

        const events: string[] = [];
        mockEffectiveWatchingFor.mockImplementation(async () => {
            events.push('watching:start');
            await new Promise((r) => setTimeout(r, 20));
            events.push('watching:end');
            return { continueWatching: [], nextUp: [] };
        });
        mockLoadBrowseIndexData.mockImplementation(async () => {
            events.push('browse:start');
            await new Promise((r) => setTimeout(r, 20));
            events.push('browse:end');
            return {
                recentlyAdded: [],
                genres: [],
                totalGenres: 0,
                hasMoreGenres: false,
                mediaServerAvailable: true,
            };
        });

        await load(baseEvent());

        // Both branches must have STARTED before either finished — proof they
        // ran concurrently rather than one waiting on the other.
        const browseEndIndex = events.indexOf('browse:end');
        const watchingEndIndex = events.indexOf('watching:end');
        const firstEndIndex = Math.min(browseEndIndex, watchingEndIndex);
        expect(events.slice(0, firstEndIndex + 1)).toEqual(
            expect.arrayContaining(['watching:start', 'browse:start']),
        );
    });
});
