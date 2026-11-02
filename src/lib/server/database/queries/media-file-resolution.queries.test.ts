// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getFilesForMediaItemMock = vi.fn();

vi.mock('./media-files.queries.js', () => ({
    getFilesForMediaItem: (...args: unknown[]) => getFilesForMediaItemMock(...args),
}));

const fakeSql = {} as never;

describe('resolvePlaybackSelection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns empty when no files exist', async () => {
        getFilesForMediaItemMock.mockResolvedValue([]);
        const { resolvePlaybackSelection } = await import('./media-file-resolution.queries.js');
        const result = await resolvePlaybackSelection(fakeSql, 'item-1');
        expect(result).toEqual({ files: [], fileId: null });
    });

    it('returns default file when no fileId requested', async () => {
        const files = [
            { id: 'file-a', file_path: '/a.mkv', is_default: false },
            { id: 'file-b', file_path: '/b.mkv', is_default: true },
        ];
        getFilesForMediaItemMock.mockResolvedValue(files);
        const { resolvePlaybackSelection } = await import('./media-file-resolution.queries.js');
        const result = await resolvePlaybackSelection(fakeSql, 'item-1');
        expect(result.fileId).toBe('file-b');
        expect(result.files).toEqual(files);
    });

    it('falls back to first file when no default', async () => {
        const files = [
            { id: 'file-a', file_path: '/a.mkv', is_default: false },
            { id: 'file-b', file_path: '/b.mkv', is_default: false },
        ];
        getFilesForMediaItemMock.mockResolvedValue(files);
        const { resolvePlaybackSelection } = await import('./media-file-resolution.queries.js');
        const result = await resolvePlaybackSelection(fakeSql, 'item-1');
        expect(result.fileId).toBe('file-a');
    });

    it('filters to requested fileId', async () => {
        const files = [
            { id: 'file-a', file_path: '/a.mkv', is_default: true },
            { id: 'file-b', file_path: '/b.mkv', is_default: false },
        ];
        getFilesForMediaItemMock.mockResolvedValue(files);
        const { resolvePlaybackSelection } = await import('./media-file-resolution.queries.js');
        const result = await resolvePlaybackSelection(fakeSql, 'item-1', {
            fileId: 'file-b',
        });
        expect(result.fileId).toBe('file-b');
        expect(result.files).toEqual([files[1]]);
    });

    it('returns empty when requested fileId not found', async () => {
        const files = [{ id: 'file-a', file_path: '/a.mkv', is_default: true }];
        getFilesForMediaItemMock.mockResolvedValue(files);
        const { resolvePlaybackSelection } = await import('./media-file-resolution.queries.js');
        const result = await resolvePlaybackSelection(fakeSql, 'item-1', {
            fileId: 'nonexistent',
        });
        expect(result).toEqual({ files: [], fileId: null });
    });
});
