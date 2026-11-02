// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/playlists/[id]/items/index.ts (GET /playlists/{id}/items).
 *
 * Covers:
 *  • the metadata-language overlay (multilingual-media-metadata spec §5) on the
 *    playlist items list — item titles must swap to the viewer's preferred
 *    language when one is configured and resolvable, on BOTH the cursor
 *    pagination branch and the offset pagination branch;
 *  • `posterPath` — a GENERATED, surface-correct entity-image URL rather than
 *    the raw stored `playlist_items.poster_path`, and one that actually
 *    survives the `docs.200` response schema (which strips undeclared fields).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { z } from 'zod';
import { encodeKeysetCursor } from '$lib/server/database/queries/builders/keyset-cursor.builder.js';

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const mockGetDb = vi.fn();
const mockGetUserRole = vi.fn();
const mockGetDeniedLibraryGroups = vi.fn();
const mockGetPlaylistItems = vi.fn();
const mockGetPlaylistType = vi.fn();
const mockGetPlaybackPreferencesOne = vi.fn();
const mockTranslations = vi.fn().mockResolvedValue(new Map());

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/utils/playlist-utils.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/playlist-utils.js')>();
    return {
        ...actual,
        getUserRole: (...args: unknown[]) => mockGetUserRole(...args),
    };
});

vi.mock('$lib/server/cache/library-group-permissions-cache.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/cache/library-group-permissions-cache.js')
        >();
    return {
        ...actual,
        getDeniedLibraryGroups: (...args: unknown[]) => mockGetDeniedLibraryGroups(...args),
    };
});

vi.mock('$lib/server/database/queries/playlists.queries.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/database/queries/playlists.queries.js')>();
    return {
        ...actual,
        getPlaylistItems: (...args: unknown[]) => mockGetPlaylistItems(...args),
        getPlaylistType: (...args: unknown[]) => mockGetPlaylistType(...args),
    };
});

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: {
        one: (...args: unknown[]) => mockGetPlaybackPreferencesOne(...args),
    },
}));

vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    getTranslationMapForItems: (...args: unknown[]) => mockTranslations(...args),
}));

const { config } = await import('$lib/server/config.js');
const { def } = await import('./index.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

const CTX = { surface: 'internal' as const };
const CTX_V1 = { surface: 'v1' as const };

/**
 * The response schema the def actually declares under `docs.GET.responses[200]`.
 *
 * Read off the def rather than re-imported: that object is what activates the
 * mount gate, and the gate STRIPS fields the schema does not declare. Parsing
 * through it is the only way a test can prove `posterPath` reaches the wire
 * instead of being silently dropped.
 */
const ITEMS_200_SCHEMA = (
    def.docs!.GET!.responses![200] as {
        schema: z.ZodType<{ items: Array<{ posterPath?: string }> }>;
    }
).schema;

// Matches the private `ITEMS_CURSOR_TAG` ('pi:') in index.ts, so a decodable
// cursor reaches the cursor branch instead of tripping the tag/format guard.
const VALID_CURSOR = 'pi:' + encodeKeysetCursor({ ts: '0', id: '0' });

const ITEM_ROW = {
    id: 1,
    media_id: '550e8400-e29b-41d4-a716-446655440000',
    primary_ext_id: 'tt123',
    media_type: 'movie',
    jellyfin_id: null,
    jellyfin_series_id: null,
    season_number: null,
    episode_number: null,
    title: 'Original Title',
    series_name: null,
    artist: null,
    parent_id: null,
    artist_id: null,
    overview: null,
    // Deliberately a stored ingest-time value: the feed must IGNORE it and
    // generate posterPath from media_id instead.
    poster_path: 'https://image.tmdb.org/t/p/w500/stale.jpg',
    position: 1,
    added_at: '2026-01-01T00:00:00.000Z',
    watched: false,
    watched_at: null,
};

async function callItems(
    query: { cursor?: string; offset?: number } = {},
    ctx: typeof CTX | typeof CTX_V1 = CTX,
): Promise<Response> {
    const url = new URL('http://localhost/api/v1/playlists/1/items');
    if (query.cursor !== undefined) url.searchParams.set('cursor', query.cursor);
    if (query.offset !== undefined) url.searchParams.set('offset', String(query.offset));

    const event = {
        url,
        params: { id: '1' },
        route: { id: '/api/v1/playlists/[id]/items' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
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
    return await def.handlers.GET!(event, ctx);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockGetUserRole.mockResolvedValue({ role: 'owner', visibility: 'private' });
    mockGetDeniedLibraryGroups.mockResolvedValue(null);
    // Absent playlist_type resolves to the open policy (position order) —
    // matches the historical, pre-Task-4 ordering these tests assert on.
    mockGetPlaylistType.mockResolvedValue(null);
    mockGetPlaylistItems.mockResolvedValue([ITEM_ROW]);
    mockGetPlaybackPreferencesOne.mockResolvedValue({
        metadata_language: 'de-DE',
        metadata_title_language: 'de-DE',
    });
    mockTranslations.mockResolvedValue(new Map());
});

// ── Metadata-language overlay ───────────────────────────────────────────────

describe('GET /playlists/{id}/items — metadata-language overlay', () => {
    it('overlays item titles in the viewer language on both pagination branches', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue(['de-DE']);
        try {
            mockTranslations.mockResolvedValue(
                new Map([['550e8400-e29b-41d4-a716-446655440000', { title: 'Deutscher Titel' }]]),
            );

            const cursorBody = await (await callItems({ cursor: VALID_CURSOR })).json();
            expect(cursorBody.items[0].title).toBe('Deutscher Titel');

            const offsetBody = await (await callItems({ offset: 0 })).json();
            expect(offsetBody.items[0].title).toBe('Deutscher Titel');
        } finally {
            langSpy.mockRestore();
        }
    });

    it('issues zero preference/translation queries when no additional language is configured', async () => {
        const langSpy = vi
            .spyOn(config, 'METADATA_ADDITIONAL_LANGUAGES', 'get')
            .mockReturnValue([]);
        try {
            const cursorBody = await (await callItems({ cursor: VALID_CURSOR })).json();
            expect(cursorBody.items[0].title).toBe('Original Title');

            const offsetBody = await (await callItems({ offset: 0 })).json();
            expect(offsetBody.items[0].title).toBe('Original Title');

            expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
            expect(mockTranslations).not.toHaveBeenCalled();
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

            const cursorRes = await callItems({ cursor: VALID_CURSOR });
            const cursorBody = await cursorRes.json();
            expect(cursorRes.status).toBe(200);
            expect(cursorBody.items[0].title).toBe('Original Title');

            const offsetRes = await callItems({ offset: 0 });
            const offsetBody = await offsetRes.json();
            expect(offsetRes.status).toBe(200);
            expect(offsetBody.items[0].title).toBe('Original Title');

            expect(mockTranslations).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });
});

// ── posterPath: generated, surface-correct, schema-declared ─────────────────

describe('GET /playlists/{id}/items — posterPath', () => {
    const INTERNAL_URL = '/api/media/550e8400-e29b-41d4-a716-446655440000/images/poster?size=thumb';
    const V1_URL = '/api/v1/media/550e8400-e29b-41d4-a716-446655440000/images/poster?size=thumb';

    it('emits the surface-correct entity-image URL for the SAME item', async () => {
        const internalBody = await (await callItems({ offset: 0 }, CTX)).json();
        expect(internalBody.items[0].posterPath).toBe(INTERNAL_URL);

        const v1Body = await (await callItems({ offset: 0 }, CTX_V1)).json();
        expect(v1Body.items[0].posterPath).toBe(V1_URL);
    });

    it('does the same on the cursor branch', async () => {
        const internalBody = await (await callItems({ cursor: VALID_CURSOR }, CTX)).json();
        expect(internalBody.items[0].posterPath).toBe(INTERNAL_URL);

        const v1Body = await (await callItems({ cursor: VALID_CURSOR }, CTX_V1)).json();
        expect(v1Body.items[0].posterPath).toBe(V1_URL);
    });

    it('ignores the raw stored playlist_items.poster_path', async () => {
        const body = await (await callItems({ offset: 0 })).json();
        expect(body.items[0].posterPath).not.toContain('image.tmdb.org');
        expect(body.items[0].posterPath).not.toBe(ITEM_ROW.poster_path);
    });

    // The docs.200 schema activates the mount gate, which strips undeclared
    // fields. If posterPath ever falls out of playlistEntrySchema, the handler
    // would keep emitting it and the client would keep not receiving it — this
    // parse is what makes that failure visible here instead of on a device.
    it('survives the declared docs.200 response schema', async () => {
        const body = await (await callItems({ offset: 0 }, CTX_V1)).json();
        const parsed = ITEMS_200_SCHEMA.parse(body);
        expect(parsed.items[0].posterPath).toBe(V1_URL);
    });
});
