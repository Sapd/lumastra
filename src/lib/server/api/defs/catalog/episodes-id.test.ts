// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/catalog/episodes-id.ts (GET episodes/{id}).
 *
 * Runs through mount() so any undeclared response field fails the route test.
 * Covers the metadata-language overlay (multilingual-media-metadata spec
 * §5): title/overview must swap to the viewer's preferred language when
 * one is configured and resolvable, and the preference/translation lookups
 * must never run when no additional language is configured (hard
 * zero-extra-queries requirement).
 */

import type { ImageOwnerRow } from '$lib/server/database/queries/image-descriptor.queries.js';
import * as imageDescriptor from '$lib/server/services/image-descriptor/index.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount, ResponseContractViolation } from '$lib/server/api/mount.js';

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const mockGetImageDescriptorOwners = vi.fn().mockResolvedValue([]);
vi.mock('$lib/server/database/queries/image-descriptor.queries.js', () => ({
    getImageDescriptorOwners: (...args: unknown[]) => mockGetImageDescriptorOwners(...args),
}));

const mockGetDb = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockGetMediaDetailsById = vi.fn();
const mockGetMediaNavContext = vi.fn();
const mockGetExternalIdsByMediaId = vi.fn();
const mockBuildExternalIdsObject = vi.fn();
const mockGetPlaybackPreferencesOne = vi.fn();
const mockGetTranslationMapForItems = vi.fn().mockResolvedValue(new Map());

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

// The episode duration is resolved through the playback-duration query; the fake
// sql above cannot run it, and these tests do not assert durations.
vi.mock('$lib/server/database/queries/media-items.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        findPlaybackDurationMs: vi.fn(async () => null),
        findPlaybackDurationsMs: vi.fn(async () => new Map<string, number>()),
    };
});

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaDetailsById: (...args: unknown[]) => mockGetMediaDetailsById(...args),
    getMediaNavContext: (...args: unknown[]) => mockGetMediaNavContext(...args),
    getExternalIdsByMediaId: (...args: unknown[]) => mockGetExternalIdsByMediaId(...args),
    buildExternalIdsObject: (...args: unknown[]) => mockBuildExternalIdsObject(...args),
}));

vi.mock('$lib/server/database/queries/episode-detail.queries.js', () => ({
    getSeriesEpisodesWithWatchState: vi.fn(async () => {
        const row = await mockGetMediaDetailsById();
        return [
            {
                ...row,
                series_id: SERIES_ID,
                series_name: 'Example',
                season_id: 'season-uuid',
                ordering: 'standard',
                is_watched: false,
                runtime_ms: null,
                resume_position_ms: 0,
                last_event_at: null,
                last_watched_at: null,
                has_file: true,
            },
        ];
    }),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(),
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: (...args: unknown[]) => mockGetPlaybackPreferencesOne(...args),
    },
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    getTranslationMapForItems: (...args: unknown[]) => mockGetTranslationMapForItems(...args),
}));

const { config } = await import('$lib/server/config.js');
const { def } = await import('./episodes-id.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

const CTX = { surface: 'internal' as const };
const EPISODE_ID = '11111111-1111-4111-8111-111111111111';
const SERIES_ID = '22222222-2222-4222-8222-222222222222';

async function callEpisode(
    id: string,
    opts: { user?: { userId: string } | null; inherit?: 'none' } = {},
): Promise<Response> {
    const url = new URL(`http://localhost/api/v1/episodes/${id}`);
    if (opts.inherit) url.searchParams.set('inherit', opts.inherit);
    const user =
        opts.user === undefined
            ? {
                  userId: 'usr_00000000-0000-0000-0000-000000000001',
                  username: 'alice',
                  userGroups: [],
                  isAdmin: false,
                  maxAgeRating: null,
              }
            : opts.user;
    const event = {
        url,
        params: { id },
        route: { id: '/api/v1/episodes/[id]' as const },
        request: new Request(url.toString()),
        locals: {
            resolvedIds: { internalId: id, source: 'uuid' },
            user,
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
    return await mount(def, CTX).GET!(event);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetImageDescriptorOwners.mockResolvedValue([]);
    mockGetDb.mockReturnValue({});
    mockCheckMediaAccess.mockResolvedValue(true);
    mockGetExternalIdsByMediaId.mockResolvedValue([]);
    mockBuildExternalIdsObject.mockReturnValue({});
    mockGetMediaNavContext.mockResolvedValue({
        series_id: SERIES_ID,
        season_number: 1,
        episode_number: 1,
    });
    mockGetMediaDetailsById.mockResolvedValue({
        id: EPISODE_ID,
        media_type: 'episode',
        title: 'The Episode',
        overview: 'Description',
        premiere_date: '2022-02-18',
        season_number: 1,
        episode_number: 1,
        original_language: 'ja',
    });
    mockGetTranslationMapForItems.mockResolvedValue(new Map());
});

// ── Metadata-language overlay ───────────────────────────────────────────────

describe('GET /episodes/{id} — metadata-language overlay', () => {
    it('overlays the episode title and overview in the viewer language', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de-DE']);
        try {
            mockGetPlaybackPreferencesOne.mockResolvedValue({
                metadata_language: 'de-DE',
                metadata_title_language: 'de-DE',
            });
            mockGetTranslationMapForItems.mockResolvedValue(
                new Map([
                    [EPISODE_ID, { title: 'Die Episode', overview: 'Beschreibung', tagline: null }],
                ]),
            );

            const body = await (await callEpisode(EPISODE_ID)).json();

            expect(body.title).toBe('Die Episode');
            expect(body.overview).toBe('Beschreibung');
        } finally {
            langSpy.mockRestore();
        }
    });

    it('issues zero preference/translation queries when no additional language is configured', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue([]);
        try {
            const body = await (await callEpisode(EPISODE_ID)).json();

            expect(body.title).toBe('The Episode');
            expect(body.overview).toBe('Description');
            expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
            expect(mockGetTranslationMapForItems).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });

    it('degrades to primary language with a 200 when the preferences read rejects', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de-DE']);
        try {
            mockGetPlaybackPreferencesOne.mockRejectedValue(new Error('connection reset'));

            const res = await callEpisode(EPISODE_ID);
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.title).toBe('The Episode');
            expect(body.overview).toBe('Description');
            expect(mockGetTranslationMapForItems).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });
});

describe('GET /episodes/{id} — artwork descriptors', () => {
    it('uses the series backdrop as thumb and never its poster for a landscape card', async () => {
        const owner = (
            id: string,
            media_type: string,
            parent_id: string | null,
        ): ImageOwnerRow => ({
            id,
            media_type,
            is_various_artists: false,
            parent_id,
            preferred_provider: null,
            poster_blurhash: null,
            backdrop_blurhash: null,
            local_artwork: {},
            provider_paths: {},
            custom_urls: {},
        });
        const series = owner(SERIES_ID, 'tv', null);
        series.provider_paths.poster = '/portrait.jpg';
        series.provider_paths.backdrop = '/landscape.jpg';
        mockGetImageDescriptorOwners.mockResolvedValue([
            owner(EPISODE_ID, 'episode', 'season-uuid'),
            owner('season-uuid', 'season', SERIES_ID),
            series,
        ]);
        const response = await callEpisode(EPISODE_ID);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { images: ImageSet };
        expect(body.images.thumb).toMatchObject({ source: 'series', revision: expect.any(String) });
        expect(body.images.thumb?.variants?.card).toContain(
            `/${SERIES_ID}/images/backdrop?size=card&v=`,
        );
        expect(body.images.thumb?.href).not.toContain('/images/poster');
        expect(body.images).not.toHaveProperty('still');
        expect(mockGetImageDescriptorOwners).toHaveBeenCalledTimes(1);

        series.provider_paths.backdrop = null;
        const posterOnly = (await (await callEpisode(EPISODE_ID)).json()) as { images: ImageSet };
        expect(posterOnly.images.thumb).toBeUndefined();
    });

    it('omits every role when no artwork exists', async () => {
        const response = await callEpisode(EPISODE_ID);
        expect((await response.json()).images).toEqual({});
    });
});

describe('GET /episodes/{id} — image inheritance', () => {
    it.each([undefined, 'none'] as const)('passes inherit=%s to the resolver', async (inherit) => {
        const resolver = vi.spyOn(imageDescriptor, 'resolveImageSets');
        try {
            const response = await callEpisode(EPISODE_ID, { inherit });
            expect(response.status).toBe(200);
            expect(resolver).toHaveBeenCalledWith(
                mockGetDb(),
                'internal',
                [{ id: EPISODE_ID, mediaType: 'episode' }],
                inherit === 'none' ? { inherit: 'none' } : undefined,
            );
            expect(def.docs!.GET!.query!.parse({ inherit })).toEqual({ inherit });
        } finally {
            resolver.mockRestore();
        }
    });
});

describe('GET /api/v1/episodes/[id] — response contract', () => {
    it('exposes the original language through the mounted response schema', async () => {
        const response = await callEpisode(EPISODE_ID);
        expect(response.status).toBe(200);
        expect((await response.json()).originalLanguage).toBe('ja');
    });

    it('fails when the episode handler emits an undeclared field', async () => {
        const handler = def.handlers.GET!;
        const spy = vi.spyOn(def.handlers, 'GET').mockImplementationOnce(async (event, ctx) => {
            const response = await handler(event, ctx);
            return Response.json({ ...(await response.json()), undeclared: true });
        });
        try {
            await expect(callEpisode(EPISODE_ID)).rejects.toMatchObject({
                name: ResponseContractViolation.name,
                detail: { undeclaredFields: ['undeclared'] },
            });
        } finally {
            spy.mockRestore();
        }
    });
});
