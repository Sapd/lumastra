// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { EndpointDef, HttpMethod } from './define.js';
import {
    BulkUpdateChannelsRequestSchema,
    ReorderChannelsRequestSchema,
} from '$lib/schemas/livetv.js';
import { UpdatePolicyRequestSchema } from '$lib/schemas/play-sessions.js';
import { ReorderEpisodesRequestSchema } from '$lib/schemas/admin-episodes.js';
import { playbackPreferencesSchema } from '$lib/schemas/user.js';

const q = vi.hoisted(() => ({
    getCategoryById: vi.fn(),
    listCategories: vi.fn(),
    bulkUpdateChannels: vi.fn(),
    batchUpdateChannelSortOrder: vi.fn(),
    batchUpdateCategorySortOrder: vi.fn(),
    verifyEpisodesBelongToSeries: vi.fn(),
    reorderEpisodes: vi.fn(),
    invalidate: vi.fn(),
    begin: vi.fn(),
    upsert: vi.fn(),
    getLibraryPathById: vi.fn(),
    getFilesForMediaItem: vi.fn(),
    saveUploadedChapters: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    syncOrderings: vi.fn(),
    syncAllOrderings: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({ begin: q.begin }) }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({ begin: q.begin }) }));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({ begin: q.begin }) },
}));
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    getCategoryById: q.getCategoryById,
    listCategories: q.listCategories,
    bulkUpdateChannels: q.bulkUpdateChannels,
    batchUpdateChannelSortOrder: q.batchUpdateChannelSortOrder,
    batchUpdateCategorySortOrder: q.batchUpdateCategorySortOrder,
}));
vi.mock('$lib/server/services/livetv-cache.service.js', () => ({
    invalidateLiveTvCaches: q.invalidate,
}));
vi.mock('$lib/server/database/queries/episode-reorder.queries.js', () => ({
    verifyEpisodesBelongToSeries: q.verifyEpisodesBelongToSeries,
    reorderEpisodes: q.reorderEpisodes,
}));
vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: { afterMetadataChanged: async () => {} },
}));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: vi.fn() },
    upsertPlaybackPreferences: q.upsert,
    PLAYBACK_PREF_COLUMNS: { maxBitrateBps: 'max_bitrate' },
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getLibraryPathById: q.getLibraryPathById,
}));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: q.getFilesForMediaItem,
}));
vi.mock('$lib/server/services/uploaded-chapters.service.js', () => ({
    saveUploadedChapters: q.saveUploadedChapters,
    undoUploadedChapters: vi.fn(),
    publishSidecar: vi.fn(),
}));
vi.mock('$lib/server/services/upload-session.service.js', () => ({
    UPLOADABLE_LIBRARY_TYPES: new Set(['home_video']),
    validateAncillaryMime: () => ({ valid: true }),
    ancillarySizeLimit: () => 1e6,
}));
vi.mock('node:fs/promises', async (original) => ({
    ...(await original<typeof import('node:fs/promises')>()),
    mkdir: q.mkdir,
    writeFile: q.writeFile,
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: vi.fn() } }));
vi.mock('$lib/server/tasks/builtin/native/file-delta-ingest-queue.js', () => ({
    enqueueDeltaPayload: vi.fn(),
}));
vi.mock('$lib/server/services/episode-ordering.service.js', () => ({
    getEpisodeOrderingService: () => ({
        syncOrderings: q.syncOrderings,
        syncAllOrderings: q.syncAllOrderings,
    }),
}));
vi.mock('$lib/server/utils/media-resolution.js', () => ({
    lookupLegacyJellyfinMediaId: async () => null,
}));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({ mediaIdResolver: {} }));
vi.mock('$lib/server/cache/index.js', () => ({ cacheManager: {} }));

import { mount } from './mount.js';
import { def as bulkDef } from './defs/livetv/admin/channels/bulk.js';
import { def as reorderDef } from './defs/livetv/admin/channels/reorder.js';
import { def as episodesDef } from './defs/admin/media/[id]/episodes/reorder.js';
import { def as prefsDef } from './defs/user/playback-preferences.js';
import { def as ancillaryDef } from './defs/admin/upload/[libraryPathId]/ancillary.js';
import { syncDef } from './defs/catalog/series/ordering.js';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

async function call(
    def: EndpointDef,
    method: HttpMethod,
    body?: unknown,
    params = { id: ID },
    query = '',
): Promise<Response> {
    const url = new URL(`http://localhost/api/test${query}`);
    const request = new Request(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const event = {
        request,
        url,
        params,
        locals: { user: { username: 'admin', userId: ID }, resolvedIds: { internalId: ID } },
    } as unknown as RequestEvent;
    // Auth has separate coverage. Exercise the real input/error pipeline.
    return mount({ ...def, auth: { kind: 'public' } }, { surface: 'internal' })[method]!(event);
}

beforeEach(() => {
    vi.clearAllMocks();
    q.writeFile.mockResolvedValue(undefined);
    q.mkdir.mockResolvedValue(undefined);
    q.saveUploadedChapters.mockResolvedValue('00000000-0000-4000-8000-000000000003');
    q.begin.mockImplementation(async (fn) => fn({}));
    q.getCategoryById.mockResolvedValue(null);
    q.listCategories.mockResolvedValue([]);
    q.bulkUpdateChannels.mockResolvedValue(1);
    q.verifyEpisodesBelongToSeries.mockResolvedValue(new Set([ID, OTHER]));
    q.reorderEpisodes.mockResolvedValue(undefined);
    q.upsert.mockRejectedValue({ code: '22003' });
    q.syncAllOrderings.mockResolvedValue([]);
    q.getLibraryPathById.mockResolvedValue({ path: '/library', media_type: 'home_video' });
    q.getFilesForMediaItem.mockResolvedValue([
        { id: OTHER, file_path: '/library/video.mp4', is_default: true },
    ]);
});

describe('database-bound request limits', () => {
    it('rejects policy bitrate overflow and accepts the int32 boundary', () => {
        expect(UpdatePolicyRequestSchema.safeParse({ max_bitrate_kbps: 2147483648 }).success).toBe(
            false,
        );
        expect(UpdatePolicyRequestSchema.safeParse({ max_bitrate_kbps: 2147483647 }).success).toBe(
            true,
        );
    });
    it.each([0.5, 2147483648])('rejects playback maxBitrateBps %s', (maxBitrateBps) => {
        expect(playbackPreferencesSchema.safeParse({ maxBitrateBps }).success).toBe(false);
    });
    it('keeps valid playback bitrate boundaries', () => {
        for (const maxBitrateBps of [0, 2147483647, null])
            expect(playbackPreferencesSchema.safeParse({ maxBitrateBps }).success).toBe(true);
    });
    it('rejects episode number overflow', () => {
        expect(
            ReorderEpisodesRequestSchema.safeParse({ items: [{ id: ID, episodeNumber: 100001 }] })
                .success,
        ).toBe(false);
        expect(
            ReorderEpisodesRequestSchema.safeParse({ items: [{ id: ID, episodeNumber: 100000 }] })
                .success,
        ).toBe(true);
    });
    it('rejects non-UUID bulk categories', () => {
        expect(
            BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: [ID],
                action: 'moveToCategory',
                categoryId: 'nope',
            }).success,
        ).toBe(false);
    });
    it.each([
        { channels: [{ id: 'nope', sortOrder: 0 }] },
        { channels: [{ id: ID, categoryId: 'nope', sortOrder: 0 }] },
        { categories: [{ id: 'nope', sortOrder: 0 }] },
    ])('rejects malformed reorder ids: %j', (body) => {
        expect(ReorderChannelsRequestSchema.safeParse(body).success).toBe(false);
    });
});

it('bulk category move rejects an unknown category before any write', async () => {
    const res = await call(bulkDef, 'PUT', {
        channelIds: [ID],
        action: 'moveToCategory',
        categoryId: OTHER,
    });
    expect(res.status).toBe(422);
    expect(q.bulkUpdateChannels).not.toHaveBeenCalled();
    expect(q.invalidate).not.toHaveBeenCalled();
});

it.each([
    { channels: [{ id: ID, categoryId: OTHER, sortOrder: 0 }] },
    { channels: [{ id: ID, sortOrder: 0 }], categories: [{ id: OTHER, sortOrder: 0 }] },
])('reorder rejects unknown category ids before any write: %j', async (body) => {
    expect((await call(reorderDef, 'PUT', body)).status).toBe(422);
    expect(q.batchUpdateChannelSortOrder).not.toHaveBeenCalled();
    expect(q.batchUpdateCategorySortOrder).not.toHaveBeenCalled();
    expect(q.invalidate).not.toHaveBeenCalled();
});

it('reorder allows null/omitted destination categories', async () => {
    const res = await call(reorderDef, 'PUT', {
        channels: [
            { id: ID, categoryId: null, sortOrder: 0 },
            { id: OTHER, sortOrder: 1 },
        ],
    });
    expect(res.status).toBe(200);
    expect(q.batchUpdateChannelSortOrder).toHaveBeenCalled();
});

it('episode reorder rejects duplicate numbers before writing', async () => {
    const res = await call(episodesDef, 'PUT', {
        items: [
            { id: ID, episodeNumber: 1 },
            { id: OTHER, episodeNumber: 1 },
        ],
    });
    expect(res.status).toBe(422);
    expect(q.reorderEpisodes).not.toHaveBeenCalled();
});

it('episode reorder maps a unique-constraint race to conflict', async () => {
    q.reorderEpisodes.mockRejectedValueOnce({ code: '23505' });
    const res = await call(episodesDef, 'PUT', { items: [{ id: ID, episodeNumber: 1 }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict' });
});

it('playback preferences lets database validation errors reach mount', async () => {
    const res = await call(prefsDef, 'PATCH', { maxBitrateBps: 1000 });
    expect(res.status).toBe(422);
    expect(q.upsert).toHaveBeenCalled();
});

it.each(['body', 'query'])('ordering sync rejects invalid %s orderingType', async (source) => {
    const res = await call(
        syncDef,
        'POST',
        source === 'body' ? { orderingType: 'invalid' } : {},
        { id: ID },
        source === 'query' ? '?orderingType=invalid&provider=tmdb&groupId=x' : '',
    );
    expect(res.status).toBe(422);
    expect(q.syncOrderings).not.toHaveBeenCalled();
    expect(q.syncAllOrderings).not.toHaveBeenCalled();
});

async function upload(chapters: unknown, mediaItemId = ID): Promise<Response> {
    const url = new URL('http://localhost/api/admin/upload/test/ancillary/test');
    const data = new FormData();
    data.set(
        'file',
        new File([JSON.stringify(chapters)], 'chapters.json', { type: 'application/json' }),
    );
    data.set('type', 'chapter');
    const event = {
        url,
        request: new Request(url, { method: 'POST', headers: { origin: url.origin }, body: data }),
        params: { libraryPathId: ID, mediaItemId },
        locals: {},
    } as unknown as RequestEvent;
    return mount({ ...ancillaryDef, auth: { kind: 'public' } }, { surface: 'internal' }).POST!(
        event,
    );
}

it.each([{ startMs: 1e12 + 1 }, { startMs: 0, endMs: 1e12 + 1 }])(
    'rejects chapter timestamp overflow before writing: %j',
    async (chapter) => {
        expect((await upload([chapter])).status).toBe(422);
        expect(q.writeFile).not.toHaveBeenCalled();
        expect(q.mkdir).not.toHaveBeenCalled();
        expect(q.saveUploadedChapters).not.toHaveBeenCalled();
    },
);

it('accepts the chapter timestamp cap', async () => {
    expect((await upload([{ startMs: 1e12, endMs: 1e12 }])).status).toBe(200);
    expect(q.saveUploadedChapters).toHaveBeenCalledWith(
        expect.anything(),
        ID,
        OTHER,
        expect.any(String),
        expect.any(Buffer),
        [expect.objectContaining({ startMs: 1e12, endMs: 1e12 })],
        expect.any(String),
    );
});

it('rejects malformed media UUID before writing a sidecar or querying', async () => {
    expect((await upload([{ startMs: 0 }], 'nope')).status).toBe(404);
    expect(q.getFilesForMediaItem).not.toHaveBeenCalled();
    expect(q.writeFile).not.toHaveBeenCalled();
    expect(q.mkdir).not.toHaveBeenCalled();
});

it('reorder accepts an existing category, including uppercase UUID input', async () => {
    const category = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    q.listCategories.mockResolvedValue([{ id: category }]);
    const res = await call(reorderDef, 'PUT', {
        channels: [{ id: ID, categoryId: category.toUpperCase(), sortOrder: 0 }],
        categories: [{ id: category, sortOrder: 0 }],
    });
    expect(res.status).toBe(200);
    expect(q.batchUpdateChannelSortOrder).toHaveBeenCalled();
    expect(q.batchUpdateCategorySortOrder).toHaveBeenCalled();
});

it('propagates protected chapter conflicts from the publication service', async () => {
    q.saveUploadedChapters.mockRejectedValue(
        Object.assign(new Error('Manual chapter markers are protected.'), { statusCode: 409 }),
    );
    expect((await upload([{ startMs: 0, title: 'A preserved opening' }])).status).toBe(409);
    expect(q.writeFile).not.toHaveBeenCalled();
    expect(q.saveUploadedChapters).toHaveBeenCalledOnce();
});
