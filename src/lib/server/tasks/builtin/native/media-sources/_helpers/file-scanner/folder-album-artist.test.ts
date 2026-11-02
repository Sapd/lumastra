// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import { resolveFolderAlbumArtist } from './folder-album-artist.js';
import type { FileScannerContext } from './shared.js';

const { safeReaddir, safeStat, parseAudioTags, findMusicAlbumFolderTracks } = vi.hoisted(() => ({
    safeReaddir: vi.fn(),
    safeStat: vi.fn(),
    parseAudioTags: vi.fn(),
    findMusicAlbumFolderTracks: vi.fn(),
}));
vi.mock('$lib/server/utils/safe-fs.js', async (original) => ({
    ...(await original<object>()),
    safeReaddir,
    safeStat,
}));
vi.mock('$lib/server/database/queries/music-album-folder.queries.js', () => ({
    findMusicAlbumFolderTracks,
}));
vi.mock('./audio-tag-parser.js', () => ({ parseAudioTags }));
vi.mock('./artist-credit-evidence.js', () => ({
    getArtistCreditEvidence: async () => ({ isIndependent: () => true, isKnownAct: () => false }),
}));

const lp = { path: '/music' } as LibraryPathRow;
const sql = {} as postgres.Sql;
const context = (): FileScannerContext =>
    ({ sql, logger: mockLogger() }) as unknown as FileScannerContext;

describe('folder album evidence snapshot', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        findMusicAlbumFolderTracks.mockResolvedValue([]);
        safeStat.mockResolvedValue({ mtimeMs: Math.random(), size: 100 });
    });
    it.each(['parse-error', 'exception'])(
        'skips an unreadable %s and tolerates an untagged bonus track',
        async (failure) => {
            const dir = `/music/Michael/${failure}`;
            const names = ['0.mp3', '1.mp3', '2.mp3', '3.mp3', 'bonus.mp3', 'broken.mp3'];
            safeReaddir.mockResolvedValue(
                names.map((name) => ({ name, isFile: () => true, isDirectory: () => false })),
            );
            parseAudioTags.mockImplementation(async (file: string) => {
                if (file.endsWith('broken.mp3')) {
                    if (failure === 'exception') throw new Error('unreadable');
                    return { parseError: 'bad file' };
                }
                return {
                    albumArtist: file.endsWith('bonus.mp3') ? undefined : 'Michael',
                    artist: file,
                };
            });
            const ctx = context();
            expect(
                await resolveFolderAlbumArtist(
                    sql,
                    dir + '/0.mp3',
                    { albumArtist: 'Michael', artist: 'Zero' },
                    lp,
                    ctx,
                ),
            ).toMatchObject({ artist: 'Michael', source: 'album-tag' });
            await resolveFolderAlbumArtist(
                sql,
                dir + '/1.mp3',
                { albumArtist: 'Michael', artist: 'One' },
                lp,
                ctx,
            );
            expect(safeReaddir).toHaveBeenCalledTimes(1);
            expect(safeStat).toHaveBeenCalledTimes(5);
            expect(parseAudioTags).toHaveBeenCalledTimes(5);
        },
    );
    it('keeps lone suffixes separate and combines same-folder files with different ordinals', async () => {
        safeReaddir.mockResolvedValue([
            { name: 'first.mp3', isFile: () => true, isDirectory: () => false },
            { name: 'second.mp3', isFile: () => true, isDirectory: () => false },
        ]);
        parseAudioTags.mockResolvedValue({
            album: 'Copper Horizon CD1',
            albumArtist: 'Second Loom',
        });
        const first = { album: 'Copper Horizon CD1', albumArtist: 'First Loom' };
        const file = '/music/Loom/Flat/first.mp3';
        const lone = await resolveFolderAlbumArtist(sql, file, first, lp, context());
        expect(lone.discEvidence).toBe(false);
        // The sibling changed on disk: a new stat signature invalidates the tag cache.
        safeStat.mockResolvedValue({ mtimeMs: Math.random(), size: 101 });
        parseAudioTags.mockResolvedValue({
            album: 'Copper Horizon CD2',
            albumArtist: 'First Loom',
        });
        const set = await resolveFolderAlbumArtist(sql, file, first, lp, context());
        expect(set).toMatchObject({ discEvidence: true, artist: 'First Loom' });
    });

    it('refreshes listing/tags for a new run and preserves collaborative credit splitting', async () => {
        safeReaddir.mockResolvedValue([
            { name: 'song.mp3', isFile: () => true, isDirectory: () => false },
        ]);
        expect(
            await resolveFolderAlbumArtist(
                sql,
                '/music/A/Release/song.mp3',
                { albumArtist: 'A & B' },
                lp,
                context(),
            ),
        ).toMatchObject({ artist: 'A' });
        expect(
            await resolveFolderAlbumArtist(
                sql,
                '/music/A/Release/song.mp3',
                { albumArtist: 'Michael' },
                lp,
                context(),
            ),
        ).toMatchObject({ artist: 'Michael' });
        expect(safeReaddir).toHaveBeenCalledTimes(2);
    });
    it('keeps a folder with artists copied from track titles under its fallback artist', async () => {
        safeReaddir.mockResolvedValue(
            ['first.mp3', 'second.mp3', 'third.mp3'].map((name) => ({
                name,
                isFile: () => true,
                isDirectory: () => false,
            })),
        );
        parseAudioTags.mockImplementation(async (file: string) => {
            const title = file.endsWith('second.mp3')
                ? 'Paper Comet [feat. Amber Current]'
                : 'Mist & Lantern';
            return { title, artist: title };
        });
        expect(
            await resolveFolderAlbumArtist(
                sql,
                '/music/Cobalt Finch/Glass Orchard/first.mp3',
                { title: 'Midnight Loom', artist: 'Midnight Loom' },
                lp,
                context(),
            ),
        ).toMatchObject({ artist: 'Cobalt Finch', various: false, source: 'fallback' });
    });
});
