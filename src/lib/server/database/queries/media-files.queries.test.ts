// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import {
    upsertMediaFile,
    attachFileToItem,
    getFilesForMediaItem,
    findMediaFileByPath,
    getLinkedMediaItemIds,
    getEditionsForMediaItem,
    isFileLinkedToMediaItem,
    findAllLinkedMediaItemsByFilePath,
    getLinkedEpisodeNumbersForFile,
} from './media-files.queries.js';

describe('upsertMediaFile', () => {
    it('returns an id string', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ id: 'file-uuid', created: true }]);
        const result = await upsertMediaFile(mockSql as never, {
            filePath: '/media/movie.mkv',
        });
        expect(typeof result.id).toBe('string');
    });

    it('returns created=true for new files', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ id: 'file-uuid', created: true }]);
        const result = await upsertMediaFile(mockSql as never, {
            filePath: '/media/movie.mkv',
        });
        expect(result.created).toBe(true);
    });

    it('passes edition and partNumber to the query', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ id: 'file-uuid', created: false }]);
        const result = await upsertMediaFile(mockSql as never, {
            filePath: '/media/movie.mkv',
            edition: 'directors_cut',
            partNumber: 1,
        });
        expect(result.id).toBe('file-uuid');
        expect(result.created).toBe(false);
        expect(mockSql).toHaveBeenCalledOnce();
    });
});

describe('attachFileToItem', () => {
    it('runs all writes including has_files propagation in one transaction', async () => {
        const mockTx = vi.fn().mockResolvedValue([]);
        const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
            begin: vi.fn(async (cb: (tx: unknown) => Promise<void>) => cb(mockTx)),
        });
        await attachFileToItem(mockSql as never, 'file-uuid', 'item-uuid');
        // Snapshot the old default after ancestor locks are acquired by
        // propagation, still inside the attach transaction. Count statements
        // by their purpose, not SQL fragment-builder calls.
        const statements = mockTx.mock.calls.map(([parts]) =>
            Array.isArray(parts) ? parts.join('') : '',
        );
        const snapshot = statements.findIndex((query) => query.includes('trickplay-reclaim'));
        const propagation = statements.findIndex((query) => query.includes('SET has_files = true'));
        expect(propagation).toBeGreaterThanOrEqual(0);
        expect(snapshot).toBeGreaterThan(propagation);
        // A file an admin linked by hand is left alone: the attach re-checks
        // manual links inside the same transaction.
        expect(statements.some((query) => query.includes('offset_source ='))).toBe(true);
        // sql is only used via begin() — never called directly.
        expect(mockSql).toHaveBeenCalledTimes(0);
    });
});

describe('getFilesForMediaItem', () => {
    it('returns an array', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        const result = await getFilesForMediaItem(mockSql as never, 'item-uuid');
        expect(Array.isArray(result)).toBe(true);
    });

    it('returns rows from sql', async () => {
        const fakeRow = {
            id: 'file-uuid',
            file_path: '/media/show.mkv',
            edition: null,
            part_number: null,
            created_at: new Date(),
            updated_at: new Date(),
        };
        const mockSql = vi.fn().mockResolvedValue([fakeRow]);
        const result = await getFilesForMediaItem(mockSql as never, 'item-uuid');
        expect(result).toHaveLength(1);
        expect(result[0].file_path).toBe('/media/show.mkv');
    });
});

describe('findMediaFileByPath', () => {
    it('returns null when no rows', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        const result = await findMediaFileByPath(mockSql as never, '/not/found.mkv');
        expect(result).toBeNull();
    });

    it('returns first row when found', async () => {
        const fakeRow = {
            id: 'file-uuid',
            file_path: '/media/found.mkv',
            edition: 'extended',
            part_number: null,
            created_at: new Date(),
            updated_at: new Date(),
        };
        const mockSql = vi.fn().mockResolvedValue([fakeRow]);
        const result = await findMediaFileByPath(mockSql as never, '/media/found.mkv');
        expect(result?.id).toBe('file-uuid');
        expect(result?.edition).toBe('extended');
    });
});

describe('getLinkedMediaItemIds', () => {
    it('returns all media_item_ids linked to the same file', async () => {
        const mockSql = vi
            .fn()
            .mockResolvedValue([
                { media_item_id: 'ep1-uuid' },
                { media_item_id: 'ep2-uuid' },
                { media_item_id: 'ep3-uuid' },
            ]);
        const ids = await getLinkedMediaItemIds(mockSql as never, 'ep2-uuid');
        expect(ids).toHaveLength(3);
        expect(ids).toContain('ep1-uuid');
        expect(ids).toContain('ep2-uuid');
        expect(ids).toContain('ep3-uuid');
        expect(mockSql).toHaveBeenCalledOnce();
    });

    it('returns just the one id when file has no other linked items', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ media_item_id: 'solo-uuid' }]);
        const ids = await getLinkedMediaItemIds(mockSql as never, 'solo-uuid');
        expect(ids).toEqual(['solo-uuid']);
    });

    it('returns empty array when no links found', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        const ids = await getLinkedMediaItemIds(mockSql as never, 'orphan-uuid');
        expect(ids).toEqual([]);
    });
});

describe('isFileLinkedToMediaItem', () => {
    it('returns true when file is linked', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ exists: true }]);
        const result = await isFileLinkedToMediaItem(mockSql as never, '/media/movie.mkv');
        expect(result).toBe(true);
    });

    it('returns false when file is not linked', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ exists: false }]);
        const result = await isFileLinkedToMediaItem(mockSql as never, '/media/orphan.mkv');
        expect(result).toBe(false);
    });

    it('returns false when query returns empty rows', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        const result = await isFileLinkedToMediaItem(mockSql as never, '/media/missing.mkv');
        expect(result).toBe(false);
    });
});

describe('findAllLinkedMediaItemsByFilePath', () => {
    it('returns all linked media item ids', async () => {
        const mockSql = vi
            .fn()
            .mockResolvedValue([{ media_item_id: 'ep1-uuid' }, { media_item_id: 'ep2-uuid' }]);
        const ids = await findAllLinkedMediaItemsByFilePath(
            mockSql as never,
            '/media/S01E01E02.mkv',
        );
        expect(ids).toEqual(['ep1-uuid', 'ep2-uuid']);
    });

    it('returns single id for single-link file', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ media_item_id: 'movie-uuid' }]);
        const ids = await findAllLinkedMediaItemsByFilePath(mockSql as never, '/media/movie.mkv');
        expect(ids).toEqual(['movie-uuid']);
    });

    it('returns empty array when file has no links', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        const ids = await findAllLinkedMediaItemsByFilePath(
            mockSql as never,
            '/media/unlinked.mkv',
        );
        expect(ids).toEqual([]);
    });
});

describe('getLinkedEpisodeNumbersForFile', () => {
    it('returns a Set containing all linked episode numbers for the given season', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ episode_number: 1 }, { episode_number: 2 }]);
        const result = await getLinkedEpisodeNumbersForFile(mockSql as never, 'file-uuid', 1);
        expect(result).toBeInstanceOf(Set);
        expect(result.has(1)).toBe(true);
        expect(result.has(2)).toBe(true);
        expect(result.size).toBe(2);
        expect(mockSql).toHaveBeenCalledOnce();
    });

    it('returns an empty Set when the file has no linked episodes for the season', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        const result = await getLinkedEpisodeNumbersForFile(mockSql as never, 'file-uuid', 1);
        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(0);
    });

    it('returns a Set with only the ep_start episode when ep_end link is missing', async () => {
        // Simulates the Hafentage bug: S01E01E02.mkv where ep1 is linked but ep2 is not.
        // The query returns only ep1 — caller checks set membership for ep2 and
        // breaks out of the short-circuit to create the missing link.
        const mockSql = vi.fn().mockResolvedValue([{ episode_number: 1 }]);
        const result = await getLinkedEpisodeNumbersForFile(mockSql as never, 'file-uuid', 1);
        expect(result.has(1)).toBe(true);
        expect(result.has(2)).toBe(false);
    });
});

describe('getEditionsForMediaItem', () => {
    it('returns distinct non-null editions for a media item', async () => {
        const mockSql = vi.fn().mockResolvedValue([{ edition: 'directors_cut' }]);
        const editions = await getEditionsForMediaItem(mockSql as never, 'item-uuid');
        expect(editions).toContain('directors_cut');
        expect(mockSql).toHaveBeenCalledOnce();
    });

    it('returns empty array when no editions found', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        const editions = await getEditionsForMediaItem(mockSql as never, 'item-uuid');
        expect(editions).toHaveLength(0);
    });

    it('returns multiple editions', async () => {
        const mockSql = vi
            .fn()
            .mockResolvedValue([{ edition: 'directors_cut' }, { edition: 'extended' }]);
        const editions = await getEditionsForMediaItem(mockSql as never, 'item-uuid');
        expect(editions).toHaveLength(2);
        expect(editions).toContain('directors_cut');
        expect(editions).toContain('extended');
    });
});
