// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// jellyfin-androidtv shows a picked version as an item whose Id is the
// media_files id, and asks for its artwork under that id. The route looked the
// file id up in the catalog, missed, and served the default placeholder — the
// 2160p pick of "2001: A Space Odyssey" showed no logo (prod 2026-10-02).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const {
    mockGetImageByCatalogId,
    mockGetOwnerItemForFile,
    mockGetMediaType,
    mockCheckMediaAccess,
    mockImageResponse,
    mockCurrentImageTag,
} = vi.hoisted(() => ({
    mockCurrentImageTag: vi.fn(),
    mockGetImageByCatalogId: vi.fn(),
    mockGetOwnerItemForFile: vi.fn(),
    mockGetMediaType: vi.fn(),
    mockCheckMediaAccess: vi.fn(),
    mockImageResponse: vi.fn(
        (result: { tag: string; cacheControl?: string; contentType?: string }) =>
            new Response(result.tag ?? 'img', {
                headers: {
                    'X-Test-Image': result.tag ?? '',
                    'Cache-Control': result.cacheControl ?? '',
                    'Content-Type': result.contentType ?? 'image/webp',
                },
            }),
    ),
}));

vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: () => ({ getImageByCatalogId: mockGetImageByCatalogId }),
    imageResponse: mockImageResponse,
}));
vi.mock('$lib/server/utils/placeholder-image.js', () => ({
    noImageResponse: async () =>
        new Response('placeholder', { headers: { 'X-Lumastra-Placeholder': 'default' } }),
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/jellyfin-compat/image-enrichment', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/jellyfin-compat/image-enrichment')
    >()),
    currentImageTag: mockCurrentImageTag,
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: mockGetOwnerItemForFile,
}));
vi.mock('$lib/server/database/queries/livetv-programs.queries', () => ({
    getProgramById: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: mockGetMediaType,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));
vi.mock('$lib/server/services/library-backdrop.service', () => ({
    getLibraryBackdrop: vi.fn(),
    getLibraryPlaceholder: vi.fn(),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { GET } from './+server';
import { GET as GET_INDEXED } from './[imageIndex]/+server';

const MOVIE_ID = 'bb3b478a-c128-496f-9068-e6622988b99b';
const FILE_ID = 'ba0faac2-2bc1-46d7-b87d-9e971d80b5e8';

async function getImage(
    itemId: string,
    imageType = 'Logo',
    query = '',
    opts: { imageIndex?: string; locals?: Record<string, unknown> } = {},
): Promise<Response> {
    const index = opts.imageIndex === undefined ? '' : `/${opts.imageIndex}`;
    const url = new URL(
        `https://example.test/j/Items/${itemId}/Images/${imageType}${index}${query}`,
    );
    const handler = opts.imageIndex === undefined ? GET : GET_INDEXED;
    return (handler as unknown as (e: RequestEvent) => Promise<Response>)({
        params: {
            itemId,
            imageType,
            ...(opts.imageIndex === undefined ? {} : { imageIndex: opts.imageIndex }),
        },
        url,
        request: new Request(url),
        locals: opts.locals ?? {},
    } as unknown as RequestEvent);
}

describe('/j/Items/{id}/Images — version (file) ids', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetImageByCatalogId.mockImplementation(async (id: string) =>
            id === MOVIE_ID ? { tag: 'movie-logo' } : null,
        );
        mockGetOwnerItemForFile.mockImplementation(async (_sql: unknown, id: string) =>
            id === FILE_ID ? MOVIE_ID : null,
        );
        mockGetMediaType.mockResolvedValue('movie');
    });

    it("an episode version's Primary is the owning episode's still, not a poster", async () => {
        // getMediaType knows the episode, not its file id.
        mockGetMediaType.mockImplementation(async (_sql: unknown, id: string) =>
            id === MOVIE_ID ? 'episode' : null,
        );
        await getImage(FILE_ID, 'Primary');
        expect(mockGetImageByCatalogId).toHaveBeenLastCalledWith(
            MOVIE_ID,
            'thumb',
            expect.any(Object),
        );
    });

    it('a non-UUID id is never looked up as a file', async () => {
        await getImage('not-a-uuid');
        expect(mockGetOwnerItemForFile).not.toHaveBeenCalled();
    });

    it("serves the owning movie's art for a file id", async () => {
        const res = await getImage(FILE_ID);
        expect(res.headers.get('X-Test-Image')).toBe('movie-logo');
        expect(mockGetImageByCatalogId).toHaveBeenLastCalledWith(
            MOVIE_ID,
            'logo',
            expect.any(Object),
        );
    });

    it('an item id is served directly, without the file lookup', async () => {
        const res = await getImage(MOVIE_ID);
        expect(res.headers.get('X-Test-Image')).toBe('movie-logo');
        expect(mockGetOwnerItemForFile).not.toHaveBeenCalled();
    });

    it('an id that is neither still gets the default placeholder', async () => {
        const res = await getImage('00000000-0000-4000-8000-000000000000');
        expect(res.headers.get('X-Lumastra-Placeholder')).toBe('default');
    });
});

describe('/j/Items/{id}/Images — Jellyfin size parameters', () => {
    let poster: Buffer;
    beforeEach(async () => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetMediaType.mockResolvedValue('movie');
        mockGetOwnerItemForFile.mockResolvedValue(null);
        poster ??= await sharp({
            create: { width: 480, height: 720, channels: 3, background: '#224466' },
        })
            .png()
            .toBuffer();
        mockGetImageByCatalogId.mockImplementation(async (id: string) =>
            id === MOVIE_ID
                ? {
                      buffer: poster,
                      contentType: 'image/png',
                      cacheControl: 'public, max-age=86400',
                      servedRevision: 'served-revision',
                  }
                : null,
        );
    });

    async function servedSize(): Promise<[number | undefined, number | undefined, string]> {
        const result = mockImageResponse.mock.lastCall?.[0] as unknown as {
            buffer: Buffer;
            contentType: string;
        };
        const meta = await sharp(result.buffer).metadata();
        return [meta.width, meta.height, result.contentType];
    }

    it('uses the fenced byte revision without an image chain query', async () => {
        const tag = createHash('md5')
            .update(`${MOVIE_ID}|Primary|canonical:served-revision`)
            .digest('hex');
        const response = await getImage(MOVIE_ID, 'Primary', `?tag=${tag}&fillWidth=200`);
        expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
        expect(mockCurrentImageTag).not.toHaveBeenCalled();
    });

    it('no size parameters → the catalog image as before (one plain call)', async () => {
        await getImage(MOVIE_ID, 'Primary');
        expect(mockGetImageByCatalogId).toHaveBeenCalledTimes(1);
        expect(mockGetImageByCatalogId.mock.calls[0][2]).not.toHaveProperty('size');
    });

    it('fillWidth/fillHeight: smallest image that covers the box, aspect kept', async () => {
        await getImage(MOVIE_ID, 'Primary', '?fillWidth=320&fillHeight=320&quality=90');
        expect(mockGetImageByCatalogId).toHaveBeenCalledWith(MOVIE_ID, 'poster', {
            size: 'medium',
            bounded: true,
        });
        expect(await servedSize()).toEqual([320, 480, 'image/png']);
    });

    it('maxWidth/maxHeight: fits inside the box', async () => {
        await getImage(MOVIE_ID, 'Primary', '?maxWidth=400&maxHeight=360');
        expect((await servedSize()).slice(0, 2)).toEqual([240, 360]);
    });

    it('width/height: exactly that size; format=Jpg is honoured', async () => {
        await getImage(MOVIE_ID, 'Primary', '?width=120&height=80&format=Jpg');
        expect(await servedSize()).toEqual([120, 80, 'image/jpeg']);
    });

    it('sizes above the cap are clamped and never upscaled', async () => {
        await getImage(MOVIE_ID, 'Primary', '?fillWidth=99999');
        expect((await servedSize()).slice(0, 2)).toEqual([480, 720]);
    });

    it('a non-integer size is a 400 (Jellyfin model binding); zero is ignored', async () => {
        expect((await getImage(MOVIE_ID, 'Primary', '?fillWidth=abc')).status).toBe(400);
        expect((await getImage(MOVIE_ID, 'Primary', '?maxHeight=1.5')).status).toBe(400);
        const res = await getImage(MOVIE_ID, 'Primary', '?maxWidth=0');
        expect(res.status).toBe(200);
        expect(mockGetImageByCatalogId.mock.lastCall?.[2]).not.toHaveProperty('size');
    });

    it('only caches a tag matching the proven revision, item, and role as immutable', async () => {
        const tag = createHash('md5')
            .update(`${MOVIE_ID}|Primary|canonical:served-revision`)
            .digest('hex');
        const tagged = await getImage(MOVIE_ID, 'Primary', `?tag=${tag}&fillWidth=200`);
        expect(tagged.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
        for (const [id, role, query] of [
            [MOVIE_ID, 'Primary', '?tag=old-tag&fillWidth=200'],
            [MOVIE_ID, 'Primary', `?tag=${MOVIE_ID.replace(/-/g, '').slice(0, 16)}`],
            [MOVIE_ID, 'Logo', `?tag=${tag}`],
            [MOVIE_ID, 'Primary', '?fillWidth=200'],
        ]) {
            const response = await getImage(id, role, query);
            expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
        }
        expect(mockCurrentImageTag).not.toHaveBeenCalled();
    });

    it('keeps bytes mutable when the provider cannot prove their revision (including mid-fetch changes)', async () => {
        const tag = createHash('md5')
            .update(`${MOVIE_ID}|Primary|canonical:served-revision`)
            .digest('hex');
        mockGetImageByCatalogId.mockResolvedValue({
            buffer: poster,
            contentType: 'image/png',
            cacheControl: 'public, max-age=86400',
        });
        const response = await getImage(MOVIE_ID, 'Primary', `?tag=${tag}&fillWidth=200`);
        expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
        expect(mockCurrentImageTag).not.toHaveBeenCalled();
    });

    it('Quality is read case-insensitively like every other /j parameter', async () => {
        await getImage(MOVIE_ID, 'Primary', '?Quality=60');
        expect(mockGetImageByCatalogId).toHaveBeenLastCalledWith(MOVIE_ID, 'poster', {
            quality: 60,
        });
        await getImage(MOVIE_ID, 'Primary', '?quality=300');
        // Out of range → the configured default, not 300.
        expect(mockGetImageByCatalogId.mock.lastCall?.[2].quality).not.toBe(300);
    });

    it('the placeholder for an unknown id is never marked cacheable by a tag', async () => {
        const res = await getImage('00000000-0000-4000-8000-000000000000', 'Primary', '?tag=abc');
        expect(res.headers.get('X-Lumastra-Placeholder')).toBe('default');
        expect(res.headers.get('Cache-Control') ?? '').not.toContain('immutable');
    });

    it('/{imageIndex}: 0 is the image, any other index 404, junk 400', async () => {
        const zero = await getImage(MOVIE_ID, 'Backdrop', '?maxWidth=200', { imageIndex: '0' });
        expect(zero.status).toBe(200);
        expect(mockGetImageByCatalogId).toHaveBeenCalledWith(
            MOVIE_ID,
            'backdrop',
            expect.any(Object),
        );
        expect((await getImage(MOVIE_ID, 'Backdrop', '', { imageIndex: '1' })).status).toBe(404);
        expect((await getImage(MOVIE_ID, 'Backdrop', '', { imageIndex: 'x' })).status).toBe(400);
    });

    it('an item the caller may not see is a 404 when a user is known', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const res = await getImage(MOVIE_ID, 'Primary', '?fillWidth=200', {
            locals: { user: { userId: 'u1' } },
        });
        expect(res.status).toBe(404);
        expect(mockGetImageByCatalogId).not.toHaveBeenCalled();
        expect(mockCurrentImageTag).not.toHaveBeenCalled();
    });
});
