// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';

const commitOutcome = vi.hoisted(() => ({ acknowledgementLost: false, receiptFailed: false }));
vi.mock('./artwork-choice.service.js', () => ({
    withArtworkChoice: async (
        sql: Sql,
        _owner: string,
        _actor: string,
        mutate: (tx: Sql) => Promise<unknown>,
    ) => {
        const value = await mutate(sql);
        if (commitOutcome.receiptFailed) throw new Error('Receipt insert failed');
        return { value, undoId: '00000000-0000-4000-8000-000000000001' };
    },
}));
vi.mock('./image-candidates.service.js', () => ({
    mutateImageCandidates: vi.fn().mockResolvedValue({ applied: true }),
}));
vi.mock('$lib/server/database/queries/image-candidates.queries.js', () => ({
    getSelectedImageCandidate: vi.fn(),
}));
import { getSelectedImageCandidate } from '$lib/server/database/queries/image-candidates.queries.js';
import { mutateImageCandidates } from './image-candidates.service.js';
// ---------- metadata storage mock ----------
// Default to 'alongside-prefer' in tests so the existing test expectations
// (which were written when artwork always went alongside) still work.
vi.mock('$lib/server/config.js', () => ({
    // F26 routes the URL-fetch path through ImageProxyService, which transitively
    // pulls in the jellyfin client + task registry at import time. The whole-module
    // mock must therefore expose every field those modules read during init, plus
    // the named exports the registry constructor reads.
    config: {
        METADATA_STORAGE_LOCATION: 'alongside-prefer',
        APP_NAME: 'Lumastra',
        APP_VERSION: '0.0.0-test',
    },
    FEATURE_PER_TASK_QUEUES: false,
}));

// ---------- logger mock ----------
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// ---------- media-files query mock ----------
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: vi.fn(),
    findDescendantDirAnchors: vi.fn(),
}));

// ---------- library-paths query mock ----------
// Library roots bound how far the container-folder walk may climb.
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: vi.fn(),
}));

// ---------- media-artwork query mock ----------
vi.mock('$lib/server/database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtwork: vi.fn().mockResolvedValue(true),
    getOwnLocalArtwork: vi.fn(),
    deleteArtworkById: vi.fn().mockResolvedValue(true),
    addArtworkSuppression: vi.fn().mockResolvedValue(undefined),
    hasArtworkSuppressionForType: vi.fn().mockResolvedValue(false),
}));

// ---------- media-items query mock ----------
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    clearCustomImageUrl: vi.fn().mockResolvedValue(undefined),
    clearProviderCdnCustomImageUrl: vi.fn().mockResolvedValue(undefined),
    clearArtworkBlurhash: vi.fn().mockResolvedValue(undefined),
}));

// ---------- safe-fs mock ----------
// safeExists returns false (dir "absent") so the isWritable() path inside
// metadata-storage.service.ts always exercises safeMkdir + safeAccess, as
// these tests expect.
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeExists: vi.fn().mockResolvedValue(false),
    safeMkdir: vi.fn().mockResolvedValue(undefined),
    safeAccess: vi.fn().mockResolvedValue(undefined),
    safeWriteFile: vi.fn().mockResolvedValue(undefined),
    safeUnlink: vi.fn().mockResolvedValue(undefined),
    safeRename: vi.fn().mockResolvedValue(undefined),
}));

// storeMediaImage writes through writeFileNoFollow (a planted link at the
// destination is replaced, not written through; contained-fs.test.ts covers it).
vi.mock('$lib/server/utils/contained-fs.js', () => ({
    writeFileNoFollow: vi.fn().mockResolvedValue(undefined),
}));

// ---------- image-proxy service mock ----------
// F26: the URL-fetch path now delegates to ImageProxyService.fetchCustomUrl,
// which owns the SSRF guard, the network fetch, and content-type sniffing.
// Mock it here so these tests verify the storage service's handling of the
// proxy result (null → throw, content-type/size validation) rather than
// re-testing SSRF internals — those live in image-proxy/service.test.ts.
const mockFetchCustomUrl = vi.fn();
const mockInvalidateCatalogImage = vi.fn();
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({
        fetchCustomUrl: mockFetchCustomUrl,
        invalidateCatalogImage: mockInvalidateCatalogImage,
    }),
}));

import * as safeFs from '$lib/server/utils/safe-fs.js';
import { writeFileNoFollow } from '$lib/server/utils/contained-fs.js';
import { config } from '$lib/server/config.js';
import {
    getFilesForMediaItem,
    findDescendantDirAnchors,
} from '$lib/server/database/queries/media-files.queries.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import {
    upsertLocalArtwork,
    getOwnLocalArtwork,
    deleteArtworkById,
    hasArtworkSuppressionForType,
} from '$lib/server/database/queries/media-artwork.queries.js';
import {
    clearProviderCdnCustomImageUrl,
    clearArtworkBlurhash,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    storeMediaImage,
    deleteMediaImage,
    deriveContainerDir,
    resolveArtworkWritePath,
    materializeProviderArtwork,
    buildSeasonArtworkFileNameResolver,
} from './media-image-storage.service.js';

// Minimal postgres.Sql-shaped mock
const sql = Object.assign(
    vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => []),
    {
        unsafe: vi.fn(),
        begin: async (callback: (tx: Sql) => Promise<unknown>) => {
            const value = await callback(sql);
            if (commitOutcome.acknowledgementLost)
                throw new Error('Commit acknowledgement lost after publication');
            return value;
        },
    },
) as unknown as Sql;

const MEDIA_ITEM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

/**
 * The real config exposes METADATA_STORAGE_LOCATION as a readonly getter, so
 * the mocked value has to be written through a mutable view of it.
 */
function setStorageLocation(value: 'central' | 'alongside' | 'alongside-prefer'): void {
    (config as unknown as { METADATA_STORAGE_LOCATION: string }).METADATA_STORAGE_LOCATION = value;
}

describe('storeMediaImage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setStorageLocation('alongside-prefer');
        // Default: no descendants and no library roots, so items without their
        // own file land in central storage — the pre-existing behaviour.
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([]);
    });

    it('writes file to media directory when files exist', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([
            {
                id: 'f1',
                file_path: '/movies/MyMovie/MyMovie.mkv',
                edition: null,
                part_number: null,
                library_group_id: null,
                container_format: null,
                duration_seconds: null,
                total_bitrate: null,
                file_size_bytes: null,
                probed_at: null,
                keyframes: null,
                health_issues: null,
                file_mtime: null,
                file_hash_head: null,
                created_at: new Date(),
                updated_at: new Date(),
            },
        ]);

        const buffer = Buffer.from('fakepng');
        const result = await storeMediaImage(sql, MEDIA_ITEM_ID, 'poster', {
            type: 'file',
            buffer,
            contentType: 'image/png',
        });

        expect(safeFs.safeMkdir).toHaveBeenCalledWith('/movies/MyMovie', {
            recursive: true,
        });
        expect(writeFileNoFollow).toHaveBeenCalledWith(result.filePath, buffer);
        expect(upsertLocalArtwork).toHaveBeenCalledWith(sql, {
            mediaItemId: MEDIA_ITEM_ID,
            artworkType: 'poster',
            filePath: result.filePath,
            localContentHash: createHash('sha256').update(buffer).digest('hex'),
            provider: 'upload',
            providerRef: result.filePath,
            sourceTag: 'admin:file',
        });
        expect(result.filePath).toMatch(new RegExp('^/movies/MyMovie/poster-[a-f0-9-]{36}\\.png$'));
        expect(result.serveUrl).toBe(`/api/image/custom/${MEDIA_ITEM_ID}/poster`);
    });

    it('does not create a human curation receipt for routine provider materialization', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        const result = await storeMediaImage(sql, MEDIA_ITEM_ID, 'thumb', {
            type: 'file',
            buffer: Buffer.from('provider-picture'),
            contentType: 'image/png',
            sourceTag: 'provider:tmdb',
            provider: 'tmdb',
            providerRef: '/routine-still.jpg',
        });
        expect(result.undoId).toBeUndefined();
        expect(upsertLocalArtwork).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({ sourceTag: 'provider:tmdb' }),
        );
    });

    it('falls back to .metadata/ directory when no media files exist', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);

        const buffer = Buffer.from('fakejpeg');
        const result = await storeMediaImage(sql, MEDIA_ITEM_ID, 'backdrop', {
            type: 'file',
            buffer,
            contentType: 'image/jpeg',
        });

        const expectedDir = `/config/.metadata/${MEDIA_ITEM_ID}`;
        expect(safeFs.safeMkdir).toHaveBeenCalledWith(expectedDir, {
            recursive: true,
        });
        expect(writeFileNoFollow).toHaveBeenCalledWith(result.filePath, buffer);
        expect(result.filePath).toMatch(
            new RegExp(`^${expectedDir}/backdrop-[a-f0-9-]{36}\\.jpg$`),
        );
    });

    it('fetches image from URL and writes to disk', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);

        const fakeBuffer = Buffer.from('webpdata');
        mockFetchCustomUrl.mockResolvedValueOnce({
            buffer: fakeBuffer,
            contentType: 'image/webp',
            cacheControl: 'public, max-age=604800',
        });

        const result = await storeMediaImage(sql, MEDIA_ITEM_ID, 'logo', {
            type: 'url',
            url: 'https://example.com/logo.webp',
        });

        // F26: the storage service delegates the fetch to ImageProxyService.
        expect(mockFetchCustomUrl).toHaveBeenCalledWith('https://example.com/logo.webp');
        expect(writeFileNoFollow).toHaveBeenCalled();
        expect(result.serveUrl).toBe(`/api/image/custom/${MEDIA_ITEM_ID}/logo`);
    });

    it('accepts an AVIF payload from a URL and stores it with a .avif extension', async () => {
        // Fix round 1 (2026-09-25 review): before the image-proxy AVIF-sniffing
        // fix, an AVIF response from fetchCustomUrl was mislabeled
        // 'image/jpeg' and silently stored as .jpg. After that fix, the proxy
        // correctly reports 'image/avif' — but ALLOWED_CONTENT_TYPES /
        // CONTENT_TYPE_TO_EXT here didn't know about it yet, so the same
        // response newly threw UnsupportedImagePayloadError, a user-visible
        // regression on admin "custom artwork from URL" and on
        // materializeProviderArtwork. AVIF must be accepted and stored as
        // .avif, same as the other supported formats.
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);

        const fakeBuffer = Buffer.from('avifdata');
        mockFetchCustomUrl.mockResolvedValueOnce({
            buffer: fakeBuffer,
            contentType: 'image/avif',
            cacheControl: 'public, max-age=604800',
        });

        const result = await storeMediaImage(sql, MEDIA_ITEM_ID, 'backdrop', {
            type: 'url',
            url: 'https://example.com/backdrop.avif',
        });

        expect(mockFetchCustomUrl).toHaveBeenCalledWith('https://example.com/backdrop.avif');
        expect(writeFileNoFollow).toHaveBeenCalled();
        const writtenPath = vi.mocked(writeFileNoFollow).mock.calls[0][0] as string;
        expect(writtenPath.endsWith('.avif')).toBe(true);
        expect(result.serveUrl).toBe(`/api/image/custom/${MEDIA_ITEM_ID}/backdrop`);
    });

    it('rejects non-image content types', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);

        await expect(
            storeMediaImage(sql, MEDIA_ITEM_ID, 'poster', {
                type: 'file',
                buffer: Buffer.from('data'),
                contentType: 'application/pdf',
            }),
        ).rejects.toThrow('Unsupported content type');
    });

    it('rejects files exceeding 20MB', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);

        const largeBuffer = Buffer.alloc(21 * 1024 * 1024);
        await expect(
            storeMediaImage(sql, MEDIA_ITEM_ID, 'poster', {
                type: 'file',
                buffer: largeBuffer,
                contentType: 'image/jpeg',
            }),
        ).rejects.toThrow('exceeds maximum size');
    });

    // F26: SSRF defense now lives in ImageProxyService.fetchCustomUrl, which
    // returns null when its guard refuses a URL (private IP, non-http scheme,
    // bad URL). The storage service surfaces that null as a fetch failure.
    // The SSRF rejection logic itself is covered in image-proxy/service.test.ts.
    it('surfaces a fetch failure when the proxy refuses a private/blocked URL', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        mockFetchCustomUrl.mockResolvedValue(null);

        for (const url of [
            'http://localhost:8080/secret',
            'http://192.168.1.1/admin',
            'http://10.0.0.1/internal',
            'http://169.254.169.254/metadata',
            'file:///etc/passwd',
        ]) {
            await expect(
                storeMediaImage(sql, MEDIA_ITEM_ID, 'poster', {
                    type: 'url',
                    url,
                }),
            ).rejects.toThrow('Failed to fetch image from URL');
        }
    });

    it('unlinks newly written bytes when publication fails before COMMIT', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        vi.mocked(upsertLocalArtwork).mockRejectedValueOnce(
            new Error('Candidate write failed before COMMIT'),
        );

        await expect(
            storeMediaImage(sql, MEDIA_ITEM_ID, 'poster', {
                type: 'file',
                buffer: Buffer.from('fakepng'),
                contentType: 'image/png',
            }),
        ).rejects.toThrow('Candidate write failed before COMMIT');

        // No COMMIT was sent: the failed publication cannot reference these bytes.
        expect(writeFileNoFollow).toHaveBeenCalled();
        expect(safeFs.safeUnlink).toHaveBeenCalledWith(
            vi.mocked(writeFileNoFollow).mock.calls[0][0],
        );
    });

    it('unlinks the new file when receipt recording fails after candidate registration', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        commitOutcome.receiptFailed = true;
        try {
            await expect(
                storeMediaImage(sql, MEDIA_ITEM_ID, 'poster', {
                    type: 'file',
                    buffer: Buffer.from('fakepng'),
                    contentType: 'image/png',
                }),
            ).rejects.toThrow('Receipt insert failed');
        } finally {
            commitOutcome.receiptFailed = false;
        }
        expect(upsertLocalArtwork).toHaveBeenCalled();
        expect(safeFs.safeUnlink).toHaveBeenCalledWith(
            vi.mocked(writeFileNoFollow).mock.calls[0][0],
        );
    });
    it('retains the new file when the candidate write completed before the commit acknowledgement was lost', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        vi.mocked(upsertLocalArtwork).mockResolvedValueOnce(true);
        commitOutcome.acknowledgementLost = true;
        try {
            await expect(
                storeMediaImage(sql, MEDIA_ITEM_ID, 'poster', {
                    type: 'file',
                    buffer: Buffer.from('fakepng'),
                    contentType: 'image/png',
                }),
            ).rejects.toThrow('Commit acknowledgement lost after publication');
        } finally {
            commitOutcome.acknowledgementLost = false;
        }
        expect(upsertLocalArtwork).toHaveBeenCalled();
        expect(writeFileNoFollow).toHaveBeenCalled();
        expect(safeFs.safeUnlink).not.toHaveBeenCalled();
    });

    it('rejects URL responses with non-image content type', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);

        // The proxy returns a body but with a non-image content-type; the storage
        // service still validates the content-type before writing to disk.
        mockFetchCustomUrl.mockResolvedValueOnce({
            buffer: Buffer.from('<html>'),
            contentType: 'text/html',
            cacheControl: 'public, max-age=604800',
        });

        await expect(
            storeMediaImage(sql, MEDIA_ITEM_ID, 'poster', {
                type: 'url',
                url: 'https://example.com/not-an-image',
            }),
        ).rejects.toThrow('Unsupported content type');
    });
});

// ---------------------------------------------------------------------------
// Container items (artist, album, tv, season)
//
// These rows never own a file — has_files is aggregated up from their
// children — so resolving the write path from their own files alone yielded
// null and, under a strict 'alongside' deployment, threw. Every artist,
// album, series and season upload 500'd.
// ---------------------------------------------------------------------------

describe('storeMediaImage — container items', () => {
    const ARTIST_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
    const MUSIC_ROOTS = [{ path: '/data/music' }] as Awaited<
        ReturnType<typeof getEnabledLibraryPaths>
    >;

    beforeEach(() => {
        vi.clearAllMocks();
        setStorageLocation('alongside');
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([]);
    });

    it('writes artist artwork into the artist folder, not the album folder', async () => {
        // artist → album → track, so the track's own folder is one level too deep.
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            {
                depth: 2,
                minDir: '/data/music/Rave Allstars/To All The Ravers',
                maxDir: '/data/music/Rave Allstars/To All The Ravers',
            },
        ]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue(MUSIC_ROOTS);

        const buffer = Buffer.from('fakejpeg');
        const result = await storeMediaImage(sql, ARTIST_ID, 'poster', {
            type: 'file',
            buffer,
            contentType: 'image/jpeg',
        });

        expect(result.filePath).toMatch(
            new RegExp('^/data/music/Rave\\ Allstars/poster-[a-f0-9-]{36}\\.jpg$'),
        );
        expect(writeFileNoFollow).toHaveBeenCalledWith(result.filePath, buffer);
    });

    it('writes album artwork into the album folder', async () => {
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            {
                depth: 1,
                minDir: '/data/music/Rave Allstars/To All The Ravers',
                maxDir: '/data/music/Rave Allstars/To All The Ravers',
            },
        ]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue(MUSIC_ROOTS);

        const result = await storeMediaImage(sql, ARTIST_ID, 'poster', {
            type: 'file',
            buffer: Buffer.from('x'),
            contentType: 'image/jpeg',
        });

        expect(result.filePath).toMatch(
            new RegExp(
                '^/data/music/Rave\\ Allstars/To\\ All\\ The\\ Ravers/poster-[a-f0-9-]{36}\\.jpg$',
            ),
        );
    });

    it.each(['poster', 'backdrop', 'logo', 'thumb'] as const)(
        'stores %s artwork for a container item',
        async (artworkType) => {
            vi.mocked(findDescendantDirAnchors).mockResolvedValue([
                {
                    depth: 2,
                    minDir: '/data/music/Rave Allstars/To All The Ravers',
                    maxDir: '/data/music/Rave Allstars/To All The Ravers',
                },
            ]);
            vi.mocked(getEnabledLibraryPaths).mockResolvedValue(MUSIC_ROOTS);

            const result = await storeMediaImage(sql, ARTIST_ID, artworkType, {
                type: 'file',
                buffer: Buffer.from('x'),
                contentType: 'image/png',
            });

            expect(result.filePath).toMatch(
                new RegExp(`^/data/music/Rave Allstars/${artworkType}-[a-f0-9-]{36}\\.png$`),
            );
        },
    );

    it('never throws under strict alongside when the item has no files at all', async () => {
        // LiveTV channels, radio stations and discovery-only items have no
        // descendant files. 'alongside' is undefined for them, not violated.
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([]);

        const result = await storeMediaImage(sql, ARTIST_ID, 'poster', {
            type: 'file',
            buffer: Buffer.from('x'),
            contentType: 'image/jpeg',
        });

        expect(result.filePath).toMatch(
            new RegExp(`^/config/\\.metadata/${ARTIST_ID}/poster-[a-f0-9-]{36}\\.jpg$`),
        );
    });

    it('falls back to central when the derived folder would escape the library root', async () => {
        // Flat layout: the artist folder would resolve to the root itself.
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            { depth: 2, minDir: '/data/music', maxDir: '/data/music' },
        ]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue(MUSIC_ROOTS);

        const result = await storeMediaImage(sql, ARTIST_ID, 'poster', {
            type: 'file',
            buffer: Buffer.from('x'),
            contentType: 'image/jpeg',
        });

        expect(result.filePath).toMatch(
            new RegExp(`^/config/\\.metadata/${ARTIST_ID}/poster-[a-f0-9-]{36}\\.jpg$`),
        );
    });
});

describe('deriveContainerDir', () => {
    const ROOTS = ['/data/music', '/data/series'];

    /** One direct child whose files all sit in a single folder. */
    const at = (depth: number, dir: string) => ({ depth, minDir: dir, maxDir: dir });
    /** One direct child whose files span a folder range (multi-disc, etc). */
    const spanning = (depth: number, minDir: string, maxDir: string) => ({
        depth,
        minDir,
        maxDir,
    });

    it('stays in the owning folder for album → track', () => {
        expect(deriveContainerDir([at(1, '/data/music/Artist/Album')], ROOTS)).toBe(
            '/data/music/Artist/Album',
        );
    });

    it('steps up to the artist folder for artist → album → track', () => {
        expect(deriveContainerDir([at(2, '/data/music/Artist/Album')], ROOTS)).toBe(
            '/data/music/Artist',
        );
    });

    it('collapses a multi-disc album to the album folder', () => {
        // Tracks live in Album/CD 01 and Album/CD 02 — the disc folders are not
        // an entity level, so the album's own folder is their common parent.
        expect(
            deriveContainerDir(
                [spanning(1, '/data/music/Artist/Album/CD 01', '/data/music/Artist/Album/CD 02')],
                ROOTS,
            ),
        ).toBe('/data/music/Artist/Album');
    });

    it('reaches the artist folder when the only album is multi-disc', () => {
        // Regression: naively taking one track's folder would stop at the disc
        // folder and land the artist poster two levels too deep.
        expect(
            deriveContainerDir(
                [spanning(2, '/data/music/Artist/Album/CD 01', '/data/music/Artist/Album/CD 02')],
                ROOTS,
            ),
        ).toBe('/data/music/Artist');
    });

    it('reaches the artist folder across several albums', () => {
        expect(
            deriveContainerDir(
                [at(2, '/data/music/Artist/Album A'), at(2, '/data/music/Artist/Album B')],
                ROOTS,
            ),
        ).toBe('/data/music/Artist');
    });

    it('steps up to the show folder for tv → season → episode', () => {
        expect(
            deriveContainerDir(
                [at(2, '/data/series/Show/Season 01'), at(2, '/data/series/Show/Season 02')],
                ROOTS,
            ),
        ).toBe('/data/series/Show');
    });

    it('clamps at the library root for a show stored without season folders', () => {
        // Still depth 2 (the season row exists), but stepping up would land on
        // /data/series itself — the show folder is the correct stop.
        expect(deriveContainerDir([at(2, '/data/series/Show')], ROOTS)).toBe('/data/series/Show');
    });

    it('returns null when files sit directly in a library root', () => {
        expect(deriveContainerDir([at(2, '/data/music')], ROOTS)).toBeNull();
    });

    it('returns null for files outside every library root', () => {
        expect(deriveContainerDir([at(2, '/elsewhere/Artist/Album')], ROOTS)).toBeNull();
    });

    it('returns null when there are no anchors', () => {
        expect(deriveContainerDir([], ROOTS)).toBeNull();
    });

    it('tolerates trailing slashes on configured roots', () => {
        expect(deriveContainerDir([at(2, '/data/music/Artist/Album')], ['/data/music/'])).toBe(
            '/data/music/Artist',
        );
    });
});

describe('deleteMediaImage', () => {
    it('hides the selected slot without unlinking old bytes', async () => {
        vi.mocked(getSelectedImageCandidate).mockResolvedValue({
            id: '00000000-0000-4000-8000-000000000002',
            media_item_id: MEDIA_ITEM_ID,
            artwork_type: 'poster',
            provider: 'upload',
            provider_ref: '/pictures/old.jpg',
            file_path: '/pictures/old.jpg',
            remote_url: 'admin:file',
            language: '',
            width: null,
            height: null,
            chosen_by: 'admin',
            locked: true,
            selected: true,
            sort_order: 0,
            fetched_at: '2026-10-28T00:00:00Z',
        });
        expect(await deleteMediaImage(sql, MEDIA_ITEM_ID, 'poster')).toBe(true);
        expect(mutateImageCandidates).toHaveBeenCalledWith(
            sql,
            MEDIA_ITEM_ID,
            { action: 'hide', candidateId: '00000000-0000-4000-8000-000000000002' },
            'admin',
        );
        expect(safeFs.safeUnlink).not.toHaveBeenCalled();
        expect(deleteArtworkById).not.toHaveBeenCalled();
    });
    it('does not claim a change when the slot has no selected image', async () => {
        vi.mocked(getSelectedImageCandidate).mockResolvedValue(null);
        expect(await deleteMediaImage(sql, MEDIA_ITEM_ID, 'poster')).toBe(false);
    });
});

describe('resolveArtworkWritePath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setStorageLocation('alongside-prefer');
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([]);
    });

    const ownFile = (filePath: string) => [
        {
            id: 'f1',
            file_path: filePath,
            edition: null,
            part_number: null,
            library_group_id: null,
            container_format: null,
            duration_seconds: null,
            total_bitrate: null,
            file_size_bytes: null,
            probed_at: null,
            keyframes: null,
            health_issues: null,
            file_mtime: null,
            file_hash_head: null,
            created_at: new Date(),
            updated_at: new Date(),
        },
    ];

    it('returns the resolved directory alongside the file path', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue(
            ownFile('/movies/MyMovie/MyMovie.mkv') as never,
        );

        const result = await resolveArtworkWritePath(sql, MEDIA_ITEM_ID, 'poster.jpg');

        expect(result.filePath).toBe('/movies/MyMovie/poster.jpg');
        expect(result.resolvedDir).toBe('/movies/MyMovie');
    });

    it('lets the resolver rename the file inside the resolved directory', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue(
            ownFile('/series/Show/S01E01.mkv') as never,
        );

        const result = await resolveArtworkWritePath(sql, MEDIA_ITEM_ID, 'poster.jpg', (dir) =>
            dir === '/series/Show' ? 'season01-poster.jpg' : 'poster.jpg',
        );

        expect(result.filePath).toBe('/series/Show/season01-poster.jpg');
        expect(result.resolvedDir).toBe('/series/Show');
    });

    it('resolves the write path exactly once even with a resolver', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue(
            ownFile('/series/Show/S01E01.mkv') as never,
        );

        await resolveArtworkWritePath(sql, MEDIA_ITEM_ID, 'poster.jpg', () => 'x.jpg');

        expect(getFilesForMediaItem).toHaveBeenCalledTimes(1);
        expect(findDescendantDirAnchors).not.toHaveBeenCalled();
    });

    it('applies the resolver to the central directory too', async () => {
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);

        const result = await resolveArtworkWritePath(
            sql,
            MEDIA_ITEM_ID,
            'poster.jpg',
            () => 'season01-poster.jpg',
        );

        expect(result.resolvedDir).toBe(`/config/.metadata/${MEDIA_ITEM_ID}`);
        expect(result.filePath).toBe(`/config/.metadata/${MEDIA_ITEM_ID}/season01-poster.jpg`);
    });
});

describe('materializeProviderArtwork — pre-fetch guards', () => {
    const PROVIDER_TAG = 'provider:tmdb:poster';
    const URL = 'https://image.tmdb.org/t/p/w342/abc.jpg';

    beforeEach(() => {
        vi.clearAllMocks();
        setStorageLocation('alongside-prefer');
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([]);
        vi.mocked(hasArtworkSuppressionForType).mockResolvedValue(false);
        vi.mocked(getOwnLocalArtwork).mockResolvedValue(null);
    });

    it('rejects an admin:* tag without fetching', async () => {
        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            'admin:url',
        );

        expect(result).toEqual({ materialized: false, reason: 'admin-source-tag' });
        expect(mockFetchCustomUrl).not.toHaveBeenCalled();
    });

    it('rejects a tag without the provider: prefix without fetching', async () => {
        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            'tmdb:season',
        );

        expect(result).toEqual({ materialized: false, reason: 'bad-source-tag' });
        expect(mockFetchCustomUrl).not.toHaveBeenCalled();
    });

    it('bails on an item+type tombstone BEFORE spending bandwidth', async () => {
        vi.mocked(hasArtworkSuppressionForType).mockResolvedValue(true);

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        expect(result).toEqual({ materialized: false, reason: 'suppressed' });
        expect(mockFetchCustomUrl).not.toHaveBeenCalled();
        expect(safeFs.safeWriteFile).not.toHaveBeenCalled();
    });

    it('never overwrites artwork the item already owns on disk', async () => {
        vi.mocked(getOwnLocalArtwork).mockResolvedValue({
            id: 'row-1',
            media_item_id: MEDIA_ITEM_ID,
            artwork_type: 'poster',
            source: 'local',
            file_path: '/series/Show/poster.jpg',
            remote_url: null,
            language: null,
            sort_order: 0,
            created_at: new Date(),
        });

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        expect(result).toEqual({ materialized: false, reason: 'already-local' });
        expect(mockFetchCustomUrl).not.toHaveBeenCalled();
    });

    it('returns instead of throwing when the fetch fails', async () => {
        mockFetchCustomUrl.mockResolvedValue(null);

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        expect(result).toEqual({ materialized: false, reason: 'fetch-failed' });
    });

    it('returns instead of throwing when the content type is disallowed', async () => {
        mockFetchCustomUrl.mockResolvedValue({
            buffer: Buffer.from('<html>'),
            contentType: 'text/html',
            cacheControl: 'public, max-age=604800',
        });

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        // A disallowed content type is rejected inside fetchFromUrl, which throws
        // UnsupportedImagePayloadError — materialize converts that to a TERMINAL
        // skip. It must NOT be 'fetch-failed': that reason is retryable, and while
        // the two shared it, TMDB's SVG logos retried to the attempt cap forever.
        expect(result).toEqual({ materialized: false, reason: 'unsupported-content-type' });
    });

    // The exact prod shape: TMDB serves some title logos as SVG, which is
    // deliberately absent from ALLOWED_CONTENT_TYPES (the serve path excludes it as
    // an XSS vector). It must be terminal, and no bytes may reach disk.
    it('refuses an SVG logo terminally rather than retryably', async () => {
        mockFetchCustomUrl.mockResolvedValue({
            buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
            contentType: 'image/svg+xml',
            cacheControl: 'public, max-age=604800',
        });

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'logo',
            'https://image.tmdb.org/t/p/w300/umNJYUzgeOilCwFzp341ysKBgL8.svg',
            PROVIDER_TAG,
        );

        expect(result).toEqual({ materialized: false, reason: 'unsupported-content-type' });
        expect(safeFs.safeWriteFile).not.toHaveBeenCalled();
    });

    it('returns instead of throwing when the fetch is oversized', async () => {
        mockFetchCustomUrl.mockResolvedValue({
            buffer: Buffer.alloc(21 * 1024 * 1024),
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=604800',
        });

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        // Oversized is also a refused payload, not a transport failure — retrying
        // re-downloads the same too-large body to the same conclusion.
        expect(result).toEqual({ materialized: false, reason: 'unsupported-content-type' });
        expect(safeFs.safeWriteFile).not.toHaveBeenCalled();
    });

    // The transport-failure half of the split must stay retryable.
    it('keeps a transport failure on the retryable fetch-failed reason', async () => {
        mockFetchCustomUrl.mockRejectedValue(new Error('ETIMEDOUT'));

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        expect(result).toEqual({ materialized: false, reason: 'fetch-failed' });
    });
});

describe('materializeProviderArtwork — write order', () => {
    const PROVIDER_TAG = 'provider:tmdb:poster';
    const URL = 'https://image.tmdb.org/t/p/w342/abc.jpg';
    const SERIES_FILE = {
        id: 'f1',
        file_path: '/series/Show/Season 01/S01E01.mkv',
        edition: null,
        part_number: null,
        library_group_id: null,
        container_format: null,
        duration_seconds: null,
        total_bitrate: null,
        file_size_bytes: null,
        probed_at: null,
        keyframes: null,
        health_issues: null,
        file_mtime: null,
        file_hash_head: null,
        created_at: new Date(),
        updated_at: new Date(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        setStorageLocation('alongside-prefer');
        vi.mocked(getFilesForMediaItem).mockResolvedValue([SERIES_FILE] as never);
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([]);
        vi.mocked(hasArtworkSuppressionForType).mockResolvedValue(false);
        vi.mocked(getOwnLocalArtwork).mockResolvedValue(null);
        vi.mocked(upsertLocalArtwork).mockResolvedValue(true);
        mockFetchCustomUrl.mockResolvedValue({
            buffer: Buffer.from('jpegbytes'),
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=604800',
        });
    });

    it('writes a temp sibling, registers the row, THEN renames into place', async () => {
        const order: string[] = [];
        vi.mocked(safeFs.safeWriteFile).mockImplementation(async (p) => {
            order.push(`write:${p}`);
        });
        vi.mocked(upsertLocalArtwork).mockImplementation(async () => {
            order.push('upsert');
            return true;
        });
        vi.mocked(safeFs.safeRename).mockImplementation(async (from, to) => {
            order.push(`rename:${from}->${to}`);
        });

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        expect(result.materialized).toBe(true);
        expect(result.filePath).toBe('/series/Show/Season 01/poster-9bfeaf26a142b8f7.jpg');
        expect(order).toHaveLength(3);
        // Temp file is a SIBLING in the same directory (rename must not cross a
        // filesystem) and is clearly ours.
        expect(order[0]).toMatch(
            /^write:\/series\/Show\/Season 01\/poster-9bfeaf26a142b8f7\.jpg\.lumastra-tmp-[0-9a-f-]{36}$/,
        );
        expect(order[1]).toBe('upsert');
        expect(order[2]).toMatch(
            /^rename:\/series\/Show\/Season 01\/poster-9bfeaf26a142b8f7\.jpg\.lumastra-tmp-[0-9a-f-]{36}->\/series\/Show\/Season 01\/poster-9bfeaf26a142b8f7\.jpg$/,
        );
    });

    it('tags the row with the caller-supplied provider provenance', async () => {
        await materializeProviderArtwork(sql, MEDIA_ITEM_ID, 'poster', URL, PROVIDER_TAG);

        expect(upsertLocalArtwork).toHaveBeenCalledWith(sql, {
            mediaItemId: MEDIA_ITEM_ID,
            artworkType: 'poster',
            filePath: '/series/Show/Season 01/poster-9bfeaf26a142b8f7.jpg',
            localContentHash: createHash('sha256').update(Buffer.from('jpegbytes')).digest('hex'),
            sourceTag: PROVIDER_TAG,
            provider: 'tmdb',
            providerRef: URL,
        });
    });

    it('unlinks the temp file and leaves no final file when the write is tombstoned', async () => {
        vi.mocked(upsertLocalArtwork).mockResolvedValue(false);

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        expect(result).toEqual({ materialized: false, reason: 'register-skipped' });
        expect(safeFs.safeRename).not.toHaveBeenCalled();
        expect(safeFs.safeUnlink).toHaveBeenCalledWith(
            expect.stringMatching(/\.lumastra-tmp-[0-9a-f-]{36}$/),
        );
    });

    it('unlinks the temp file when the rename fails', async () => {
        vi.mocked(safeFs.safeRename).mockRejectedValueOnce(new Error('EXDEV'));

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        expect(result).toEqual({ materialized: false, reason: 'write-failed' });
        expect(safeFs.safeUnlink).toHaveBeenCalledWith(
            expect.stringMatching(/\.lumastra-tmp-[0-9a-f-]{36}$/),
        );
    });

    it('returns write-path-failed instead of throwing on a read-only strict-alongside mount', async () => {
        setStorageLocation('alongside');
        vi.mocked(safeFs.safeAccess).mockRejectedValueOnce(new Error('EACCES'));

        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
        );

        expect(result).toEqual({ materialized: false, reason: 'write-path-failed' });
        expect(safeFs.safeWriteFile).not.toHaveBeenCalled();
    });

    it('honors the filename resolver', async () => {
        const result = await materializeProviderArtwork(
            sql,
            MEDIA_ITEM_ID,
            'poster',
            URL,
            PROVIDER_TAG,
            (_dir, ext) => `season01-poster${ext}`,
        );

        expect(result.filePath).toBe('/series/Show/Season 01/season01-poster-9bfeaf26a142b8f7.jpg');
    });

    it('purges the in-process image caches on success', async () => {
        await materializeProviderArtwork(sql, MEDIA_ITEM_ID, 'poster', URL, PROVIDER_TAG);

        expect(mockInvalidateCatalogImage).toHaveBeenCalledWith(MEDIA_ITEM_ID);
    });

    it('invalidates the paired blurhash only after the file is in place', async () => {
        const order: string[] = [];
        vi.mocked(safeFs.safeRename).mockImplementation(async () => {
            order.push('rename');
        });
        vi.mocked(clearArtworkBlurhash).mockImplementation(async () => {
            order.push('blurhash');
        });

        await materializeProviderArtwork(sql, MEDIA_ITEM_ID, 'poster', URL, PROVIDER_TAG);

        expect(order).toEqual(['rename', 'blurhash']);
        expect(clearArtworkBlurhash).toHaveBeenCalledWith(sql, MEDIA_ITEM_ID, 'poster');
    });
});

describe('materializeProviderArtwork — custom url clear ordering', () => {
    const PROVIDER_TAG = 'provider:tmdb:poster';
    const URL = 'https://image.tmdb.org/t/p/w342/abc.jpg';

    beforeEach(() => {
        vi.clearAllMocks();
        setStorageLocation('alongside-prefer');
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue([]);
        vi.mocked(hasArtworkSuppressionForType).mockResolvedValue(false);
        vi.mocked(getOwnLocalArtwork).mockResolvedValue(null);
        vi.mocked(upsertLocalArtwork).mockResolvedValue(true);
        mockFetchCustomUrl.mockResolvedValue({
            buffer: Buffer.from('jpegbytes'),
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=604800',
        });
    });

    it('clears a stale provider CDN custom url BEFORE registering the row', async () => {
        const order: string[] = [];
        vi.mocked(clearProviderCdnCustomImageUrl).mockImplementation(async () => {
            order.push('clear');
        });
        vi.mocked(upsertLocalArtwork).mockImplementation(async () => {
            order.push('upsert');
            return true;
        });

        await materializeProviderArtwork(sql, MEDIA_ITEM_ID, 'poster', URL, PROVIDER_TAG);

        // upsertLocalArtwork claims custom_poster_url only when it is NULL
        // (media-artwork.queries.ts:135), so the clear must land first.
        expect(order).toEqual(['clear', 'upsert']);
        expect(clearProviderCdnCustomImageUrl).toHaveBeenCalledWith(
            sql,
            MEDIA_ITEM_ID,
            'custom_poster_url',
        );
    });

    it('does not attempt a column clear for banner (no paired column)', async () => {
        await materializeProviderArtwork(sql, MEDIA_ITEM_ID, 'banner', URL, 'provider:tmdb:banner');

        expect(clearProviderCdnCustomImageUrl).not.toHaveBeenCalled();
    });
});

describe('buildSeasonArtworkFileNameResolver', () => {
    const SERIES_ID = 'cccccccc-0000-0000-0000-000000000003';
    const SERIES_ROOTS = [{ path: '/data/series' }] as Awaited<
        ReturnType<typeof getEnabledLibraryPaths>
    >;

    beforeEach(() => {
        vi.clearAllMocks();
        setStorageLocation('alongside-prefer');
        vi.mocked(getFilesForMediaItem).mockResolvedValue([]);
        vi.mocked(getEnabledLibraryPaths).mockResolvedValue(SERIES_ROOTS);
    });

    it('qualifies the filename when the season resolves to the SERIES folder', async () => {
        // Folderless layout: the series folder holds the episode files directly,
        // so deriveContainerDir clamps the series at /data/series/Show.
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            { depth: 2, minDir: '/data/series/Show', maxDir: '/data/series/Show' },
        ]);

        const resolver = await buildSeasonArtworkFileNameResolver(sql, SERIES_ID, 1, 'poster');

        expect(resolver('/data/series/Show', '.jpg')).toBe('season01-poster.jpg');
    });

    it('uses the plain filename when the season has its own folder', async () => {
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            {
                depth: 2,
                minDir: '/data/series/Show/Season 01',
                maxDir: '/data/series/Show/Season 01',
            },
        ]);

        const resolver = await buildSeasonArtworkFileNameResolver(sql, SERIES_ID, 1, 'poster');

        // Series resolved to /data/series/Show; the season's own dir differs.
        expect(resolver('/data/series/Show/Season 01', '.jpg')).toBe('poster.jpg');
    });

    it('uses the specials label for season 0', async () => {
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            { depth: 2, minDir: '/data/series/Show', maxDir: '/data/series/Show' },
        ]);

        const resolver = await buildSeasonArtworkFileNameResolver(sql, SERIES_ID, 0, 'poster');

        expect(resolver('/data/series/Show', '.jpg')).toBe('season-specials-poster.jpg');
    });

    it('resolves the series directory exactly once', async () => {
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            { depth: 2, minDir: '/data/series/Show', maxDir: '/data/series/Show' },
        ]);

        const resolver = await buildSeasonArtworkFileNameResolver(sql, SERIES_ID, 3, 'poster');
        resolver('/data/series/Show', '.jpg');
        resolver('/data/series/Show', '.png');

        expect(findDescendantDirAnchors).toHaveBeenCalledTimes(1);
    });

    it('carries the real extension into the qualified name', async () => {
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            { depth: 2, minDir: '/data/series/Show', maxDir: '/data/series/Show' },
        ]);

        const resolver = await buildSeasonArtworkFileNameResolver(sql, SERIES_ID, 12, 'poster');

        expect(resolver('/data/series/Show', '.webp')).toBe('season12-poster.webp');
    });

    it('qualifies unconditionally when the series directory cannot be resolved', async () => {
        // Strict 'alongside' on a read-only mount: resolveWritePath throws
        // (metadata-storage.service.ts:132-136). We cannot RULE OUT a collision,
        // so the season must not fall back to a bare `poster.jpg` that might
        // land in the series folder and clobber the series poster. Plan D's
        // season lane depends on this exact fallback.
        setStorageLocation('alongside');
        vi.mocked(findDescendantDirAnchors).mockResolvedValue([
            { depth: 2, minDir: '/data/series/Show', maxDir: '/data/series/Show' },
        ]);
        vi.mocked(safeFs.safeAccess).mockRejectedValue(new Error('EACCES'));

        const resolver = await buildSeasonArtworkFileNameResolver(sql, SERIES_ID, 4, 'poster');

        expect(resolver('/data/series/Show/Season 04', '.jpg')).toBe('season04-poster.jpg');
        expect(resolver('/data/series/Show', '.jpg')).toBe('season04-poster.jpg');
    });
});
