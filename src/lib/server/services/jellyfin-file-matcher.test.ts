// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { matchSyncFiles, relativeSyncPath, type SyncFileItem } from './jellyfin-file-matcher.js';
const item = (
    id: string,
    root: string,
    name = 'Holiday/Film.mkv',
    size: number | null = 123,
): SyncFileItem => ({
    id,
    roots: [root],
    mediaType: 'movie',
    files: [{ path: `${root}/${name}`, size }],
});
describe('relative file matcher', () => {
    it('pairs different mounts, case and Unicode composition', () => {
        expect(
            matchSyncFiles(
                [item('jf', '/media', 'Cafe\u0301/FILM.mkv')],
                [item('local', '/data', 'Café/film.MKV')],
            ),
        ).toEqual(new Map([['jf', 'local']]));
    });
    it('requires matching known sizes on both sides', () => {
        expect(
            matchSyncFiles([item('jf', '/media')], [item('local', '/data', undefined, 124)]).size,
        ).toBe(0);
        expect(
            matchSyncFiles([item('jf', '/media')], [item('local', '/data', undefined, null)]).size,
        ).toBe(0);
    });
    it('rejects missing remote size', () => {
        expect(
            matchSyncFiles([item('jf', '/media', undefined, null)], [item('local', '/data')]).size,
        ).toBe(0);
    });
    it('rejects contradictory ids for a shared provider', () => {
        const remote = { ...item('jf', '/media'), providerIds: { tmdb: '1' } };
        const local = { ...item('local', '/data'), providerIds: { tmdb: '2' } };
        expect(matchSyncFiles([remote], [local]).size).toBe(0);
    });
    it('keeps unknown-size duplicates in ambiguity detection without pairing them', () => {
        expect(
            matchSyncFiles(
                [item('jf', '/media'), item('unknown', '/other', undefined, null)],
                [item('local', '/data')],
            ).size,
        ).toBe(0);
        expect(
            matchSyncFiles(
                [item('jf', '/media')],
                [item('local', '/data'), item('unknown', '/other', undefined, null)],
            ).size,
        ).toBe(0);
    });
    it('refuses duplicate local paths across roots', () => {
        expect(
            matchSyncFiles([item('jf', '/media')], [item('a', '/data'), item('b', '/other')]).size,
        ).toBe(0);
    });
    it('refuses duplicate remote paths even when only one is in the pull batch', () => {
        expect(
            matchSyncFiles([item('jf', '/media'), item('other', '/second')], [item('a', '/data')])
                .size,
        ).toBe(0);
    });
    it('treats case and Unicode collisions as ambiguous', () => {
        expect(
            matchSyncFiles(
                [item('jf', '/media', 'Café.mkv')],
                [item('a', '/data', 'CAFÉ.mkv'), item('b', '/other', 'Cafe\u0301.mkv')],
            ).size,
        ).toBe(0);
    });
    it('uses the longest configured root and directory boundaries; never guesses suffixes', () => {
        expect(relativeSyncPath('/data/movies/A.mkv', ['/data', '/data/movies'])).toBe('a.mkv');
        expect(relativeSyncPath('/data/movies-other/A.mkv', ['/data/movies'])).toBeNull();
        expect(relativeSyncPath('/unknown/A.mkv', ['/data'])).toBeNull();
        expect(relativeSyncPath('/data/../A.mkv', ['/data'])).toBeNull();
    });
    it('supports Windows paths and media sources without cross-type pairing', () => {
        expect(relativeSyncPath('D:\\Movies\\Film.mkv', ['d:\\movies'])).toBe('film.mkv');
        const local = item('a', '/data');
        local.mediaType = 'episode';
        expect(matchSyncFiles([item('jf', '/media')], [local]).size).toBe(0);
    });
    it('does not ignore unsupported combined files when deciding uniqueness', () => {
        const combined = item('combined', '/other');
        combined.pairable = false;
        expect(
            matchSyncFiles([item('jf', '/media')], [item('single', '/data'), combined]).size,
        ).toBe(0);
        const remoteCombined = item('combined', '/other');
        remoteCombined.pairable = false;
        expect(
            matchSyncFiles([item('jf', '/media'), remoteCombined], [item('local', '/data')]).size,
        ).toBe(0);
    });
});

const file = (path: string, size: number | null) => ({ path, size });
const multi = (
    id: string,
    roots: string[],
    files: ReturnType<typeof file>[],
    mediaType = 'movie',
): SyncFileItem => ({ id, roots, mediaType, files });

describe('absolute-path file matcher', () => {
    it('pairs an identical absolute path with equal known sizes when the roots differ', () => {
        expect(
            matchSyncFiles(
                [multi('jf', ['/media'], [file('/shared/Film.mkv', 123)])],
                [multi('local', ['/elsewhere'], [file('/shared/Film.mkv', 123)])],
            ),
        ).toEqual(new Map([['jf', 'local']]));
    });
    it('rejects an absolute-path match whose sizes differ', () => {
        expect(
            matchSyncFiles(
                [multi('jf', ['/media'], [file('/shared/Film.mkv', 123)])],
                [multi('local', ['/elsewhere'], [file('/shared/Film.mkv', 124)])],
            ).size,
        ).toBe(0);
    });
    it('rejects an absolute-path match with an unknown size on either side', () => {
        expect(
            matchSyncFiles(
                [multi('jf', ['/media'], [file('/shared/Film.mkv', null)])],
                [multi('local', ['/elsewhere'], [file('/shared/Film.mkv', 123)])],
            ).size,
        ).toBe(0);
        expect(
            matchSyncFiles(
                [multi('jf', ['/media'], [file('/shared/Film.mkv', 123)])],
                [multi('local', ['/elsewhere'], [file('/shared/Film.mkv', null)])],
            ).size,
        ).toBe(0);
    });
    it('refuses two local items at the same full path', () => {
        expect(
            matchSyncFiles(
                [multi('jf', ['/media'], [file('/shared/Film.mkv', 123)])],
                [
                    multi('a', ['/shared'], [file('/shared/Film.mkv', 123)]),
                    multi('b', ['/'], [file('/shared/Film.mkv', 123)]),
                ],
            ).size,
        ).toBe(0);
    });
    it('treats a relative hit on one local item and an absolute hit on another as ambiguous', () => {
        expect(
            matchSyncFiles(
                [multi('jf', ['/media'], [file('/media/Film.mkv', 123)])],
                [
                    multi('a', ['/data'], [file('/data/Film.mkv', 123)]),
                    multi('b', ['/elsewhere'], [file('/media/Film.mkv', 123)]),
                ],
            ).size,
        ).toBe(0);
    });
    it('requires the path-matched file itself to have equal sizes, not just another file of the item', () => {
        expect(
            matchSyncFiles(
                [
                    multi(
                        'jf',
                        ['/media'],
                        [file('/media/Part1.mkv', 100), file('/media/Part2.mkv', 200)],
                    ),
                ],
                [
                    multi(
                        'local',
                        ['/data'],
                        [file('/data/Part1.mkv', 999), file('/data/Part2.mkv', 200)],
                    ),
                ],
            ).size,
        ).toBe(0);
    });
    it('rejects a multi-file item when a path-matched file has an unknown size, even if another file matches', () => {
        expect(
            matchSyncFiles(
                [
                    multi(
                        'jf',
                        ['/media'],
                        [file('/media/Part1.mkv', null), file('/media/Part2.mkv', 200)],
                    ),
                ],
                [
                    multi(
                        'local',
                        ['/data'],
                        [file('/data/Part1.mkv', 100), file('/data/Part2.mkv', 200)],
                    ),
                ],
            ).size,
        ).toBe(0);
    });
    it('pairs a multi-file item when every path-matched file has equal known sizes', () => {
        expect(
            matchSyncFiles(
                [
                    multi(
                        'jf',
                        ['/media'],
                        [file('/media/Part1.mkv', 100), file('/media/Part2.mkv', 200)],
                    ),
                ],
                [
                    multi(
                        'local',
                        ['/data'],
                        [file('/data/Part1.mkv', 100), file('/data/Part2.mkv', 200)],
                    ),
                ],
            ),
        ).toEqual(new Map([['jf', 'local']]));
    });
});

describe('episodes sharing one file', () => {
    const episode = (
        id: string,
        root: string,
        n: number,
        extra: Partial<SyncFileItem> = {},
    ): SyncFileItem => ({
        ...item(id, root, 'Show/S01E03-E04.mkv', 500),
        mediaType: 'episode',
        season: 1,
        episode: n,
        ...extra,
    });
    const local = [
        episode('l3', '/data', 3, { pairable: false }),
        episode('l4', '/data', 4, { pairable: false }),
    ];
    it('pairs separate Jellyfin items with the Lumastra episode of the same number', () => {
        expect(
            matchSyncFiles([episode('r3', '/media', 3), episode('r4', '/media', 4)], local),
        ).toEqual(
            new Map([
                ['r3', 'l3'],
                ['r4', 'l4'],
            ]),
        );
    });
    it('pairs one spanning Jellyfin item with the first episode only', () => {
        expect(
            matchSyncFiles([episode('r3', '/media', 3, { episodeEnd: 4, pairable: false })], local),
        ).toEqual(new Map([['r3', 'l3']]));
    });
    it('leaves a shared file unpaired when the numbers do not identify an episode', () => {
        expect(matchSyncFiles([episode('r9', '/media', 9)], local)).toEqual(new Map());
        expect(
            matchSyncFiles([episode('a', '/media', 3), episode('b', '/media', 3)], local),
        ).toEqual(new Map());
    });
    it('pairs a spanning item only with the FIRST episode of the file', () => {
        // Jellyfin numbers the file 4-5, Lumastra 3-4: the match would be E04 and E03 would never sync.
        expect(
            matchSyncFiles([episode('r4', '/media', 4, { episodeEnd: 5, pairable: false })], local),
        ).toEqual(new Map());
    });
    it('needs the same season, and treats season 0 as a season', () => {
        expect(matchSyncFiles([episode('r3', '/media', 3, { season: 2 })], local)).toEqual(
            new Map(),
        );
        const specials = [
            episode('l3', '/data', 3, { pairable: false, season: 0 }),
            episode('l4', '/data', 4, { pairable: false, season: 0 }),
        ];
        expect(
            matchSyncFiles(
                [episode('r3', '/media', 3, { season: 0, episodeEnd: 4, pairable: false })],
                specials,
            ),
        ).toEqual(new Map([['r3', 'l3']]));
    });
    it('stays unpaired when another Jellyfin item or a plain local row shares the path', () => {
        // A second, unnumbered Jellyfin item on the same file.
        expect(
            matchSyncFiles(
                [
                    episode('r3', '/media', 3),
                    episode('x', '/media', 0, { season: null, episode: null }),
                ],
                local,
            ),
        ).toEqual(new Map());
        // A non-combined local row on the same file.
        expect(
            matchSyncFiles(
                [episode('r3', '/media', 3)],
                [...local, episode('plain', '/data', 9, { pairable: true })],
            ),
        ).toEqual(new Map());
    });
});
