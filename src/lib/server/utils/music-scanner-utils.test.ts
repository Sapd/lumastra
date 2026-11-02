// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    parseDiscFolder,
    resolveAlbumDir,
    extractYearFromFolder,
    findSidecarLyrics,
    cleanAlbumTitle,
    splitDiscSuffix,
    folderAlbumTitle,
    hasMatchingDiscTitles,
    parseVAFolderPattern,
    deriveArtistName,
    parseArtistTitleFromFilename,
    isCompilationArtistName,
    normalizeUnderscoreStem,
    deriveDisplayFromStem,
    cleanUnderscoreSeparators,
    spaceUnderscoreWords,
    stripTrackNumberFromArtistTag,
    trackNumberFromFilename,
} from './music-scanner-utils.js';
import { readContainedFile } from './contained-fs.js';
import path from 'node:path';

vi.mock('node:fs/promises');
// Sidecar reads go through the containment helper; its own behaviour is tested in contained-fs.test.ts.
vi.mock('./contained-fs.js');

// Mock the metadata storage service so resolveReadPath returns the alongside path
// (simulating the old behavior where lyrics are always next to the track)
vi.mock('$lib/server/services/metadata-storage.service.js', () => ({
    resolveWritePath: vi.fn(async (opts: { mediaFilePath: string; fileName: string }) => ({
        filePath: path.join(path.dirname(opts.mediaFilePath), opts.fileName),
        location: 'alongside',
    })),
    resolveReadPath: vi.fn((opts: { mediaFilePath: string; fileName: string }) =>
        path.join(path.dirname(opts.mediaFilePath), opts.fileName),
    ),
}));

describe('parseDiscFolder', () => {
    it('recognizes "CD 01"', () => expect(parseDiscFolder('CD 01')).toBe(1));
    it('recognizes "cd2"', () => expect(parseDiscFolder('cd2')).toBe(2));
    it('recognizes "Disc 1"', () => expect(parseDiscFolder('Disc 1')).toBe(1));
    it('recognizes "Disk 03"', () => expect(parseDiscFolder('Disk 03')).toBe(3));
    it('recognizes "Vol. 2"', () => expect(parseDiscFolder('Vol. 2')).toBe(2));
    it('recognizes "Volume 1"', () => expect(parseDiscFolder('Volume 1')).toBe(1));
    it('recognizes "Part 3"', () => expect(parseDiscFolder('Part 3')).toBe(3));
    it('rejects "Bonus"', () => expect(parseDiscFolder('Bonus')).toBeNull());
    it('rejects "Season 01"', () => expect(parseDiscFolder('Season 01')).toBeNull());
    it('rejects empty string', () => expect(parseDiscFolder('')).toBeNull());
    it('rejects "CD" without number', () => expect(parseDiscFolder('CD')).toBeNull());
});

describe('resolveAlbumDir', () => {
    it('returns parent dir for normal layout', () => {
        const result = resolveAlbumDir('/music/Artist/Album/track.flac');
        expect(result).toEqual({
            albumDir: '/music/Artist/Album',
            discNumber: null,
        });
    });

    it('goes one level up for disc subfolder', () => {
        const result = resolveAlbumDir('/music/Artist/Album/CD 01/track.flac');
        expect(result).toEqual({
            albumDir: '/music/Artist/Album',
            discNumber: 1,
        });
    });

    it('handles Disc 2 subfolder', () => {
        const result = resolveAlbumDir('/music/Artist/Album/Disc 2/track.flac');
        expect(result).toEqual({
            albumDir: '/music/Artist/Album',
            discNumber: 2,
        });
    });
});

describe('extractYearFromFolder', () => {
    it('extracts year from "(2020)"', () => {
        expect(extractYearFromFolder('Great Album (2020)')).toBe(2020);
    });
    it('extracts year from "(1999)"', () => {
        expect(extractYearFromFolder('Album Name (1999)')).toBe(1999);
    });
    it('returns null for no year', () => {
        expect(extractYearFromFolder('Album Name')).toBeNull();
    });
    it('returns null for out-of-range year', () => {
        expect(extractYearFromFolder('Album (1800)')).toBeNull();
    });
    it('returns null for far future year', () => {
        expect(extractYearFromFolder('Album (2099)')).toBeNull();
    });
    it('handles multiple parenthesized groups, takes first valid year', () => {
        expect(extractYearFromFolder('Album (Deluxe) (2020)')).toBe(2020);
    });
});

describe('cleanAlbumTitle', () => {
    it('strips trailing -WEB', () => {
        expect(cleanAlbumTitle('Whiteline Fever-WEB')).toBe('Whiteline Fever');
    });
    it('strips trailing .WEB', () => {
        expect(cleanAlbumTitle('Whiteline Fever.WEB')).toBe('Whiteline Fever');
    });
    it('strips trailing _WEB', () => {
        expect(cleanAlbumTitle('Whiteline_Fever_WEB')).toBe('Whiteline Fever');
    });
    it('strips trailing WEB-DL before WEB would match', () => {
        expect(cleanAlbumTitle('Some Album-WEB-DL')).toBe('Some Album');
    });
    it('strips multiple chained scene tokens', () => {
        expect(cleanAlbumTitle('Some Album-WEB-FLAC')).toBe('Some Album');
    });
    it('strips FLAC suffix', () => {
        expect(cleanAlbumTitle('Some Album.FLAC')).toBe('Some Album');
    });
    it('strips trailing whitespace after the scene token', () => {
        expect(cleanAlbumTitle('Some Album-WEB  ')).toBe('Some Album');
    });
    it('is case-insensitive', () => {
        expect(cleanAlbumTitle('Some Album-web')).toBe('Some Album');
    });
    it('leaves clean titles untouched', () => {
        expect(cleanAlbumTitle('Whiteline Fever')).toBe('Whiteline Fever');
    });
    it('does not strip dash-separated words that are not scene tags', () => {
        expect(cleanAlbumTitle('Album-Deluxe')).toBe('Album-Deluxe');
    });
    it('does not strip space-separated WEB ("The WEB")', () => {
        expect(cleanAlbumTitle('The WEB')).toBe('The WEB');
    });
    it('does not strip space-separated CD ("Some CD")', () => {
        expect(cleanAlbumTitle('Some CD')).toBe('Some CD');
    });
    it('does not strip space-separated bitrate-like numbers ("Route 192")', () => {
        expect(cleanAlbumTitle('Route 192')).toBe('Route 192');
    });
    it('does not strip space-separated version suffix ("Mario Kart V2")', () => {
        expect(cleanAlbumTitle('Mario Kart V2')).toBe('Mario Kart V2');
    });
    it('does not strip space-separated PROMO ("Halo Promo")', () => {
        expect(cleanAlbumTitle('Halo Promo')).toBe('Halo Promo');
    });
    it('strips a space-separated upper-case WEB from a tag value', () => {
        expect(cleanAlbumTitle('Sucker WEB')).toBe('Sucker');
        expect(cleanAlbumTitle('Dark Horse (Break System Bootleg) WEB')).toBe(
            'Dark Horse (Break System Bootleg)',
        );
    });
    it('strips space-separated CDM / CDS / VINYL / MP3', () => {
        expect(cleanAlbumTitle('Cheri Cheri Lady CDM')).toBe('Cheri Cheri Lady');
        expect(cleanAlbumTitle('Encore CDS')).toBe('Encore');
        expect(cleanAlbumTitle('Feel The Rhythm VINYL')).toBe('Feel The Rhythm');
        expect(cleanAlbumTitle('Hybrid Theory (2000) MP3')).toBe('Hybrid Theory (2000)');
    });
    it('strips a trailing parenthetical made only of scene tags', () => {
        expect(cleanAlbumTitle('Crack A Bottle (Promo CDS)')).toBe('Crack A Bottle');
        expect(cleanAlbumTitle('Some Album (WEB)')).toBe('Some Album');
        expect(cleanAlbumTitle('Some Album [Vinyl]')).toBe('Some Album');
    });
    it('keeps a parenthetical that is not only scene tags', () => {
        expect(cleanAlbumTitle('Live (Promo Tour)')).toBe('Live (Promo Tour)');
    });
    it('keeps title-case words after a space ("The Web", "Black Vinyl")', () => {
        expect(cleanAlbumTitle('Into The Web')).toBe('Into The Web');
        expect(cleanAlbumTitle('Black Vinyl')).toBe('Black Vinyl');
    });
    it('keeps edition words, bitrates and versions in brackets', () => {
        expect(cleanAlbumTitle('Abbey Lane (Remastered)')).toBe('Abbey Lane (Remastered)');
        expect(cleanAlbumTitle('Album (Remaster)')).toBe('Album (Remaster)');
        expect(cleanAlbumTitle('Greatest Hits (Promo)')).toBe('Greatest Hits (Promo)');
        expect(cleanAlbumTitle('Album (V2)')).toBe('Album (V2)');
        expect(cleanAlbumTitle('Mixes (192)')).toBe('Mixes (192)');
    });
    it('needs matched brackets and allows , / & between bracketed tags', () => {
        expect(cleanAlbumTitle('Album (WEB]')).toBe('Album (WEB]');
        expect(cleanAlbumTitle('Album (Promo, CDS)')).toBe('Album');
        expect(cleanAlbumTitle('Album (WEB/FLAC)')).toBe('Album');
    });
    it('keeps an all-caps title that ends in WEB or VINYL', () => {
        expect(cleanAlbumTitle('SPIDER WEB')).toBe('SPIDER WEB');
        expect(cleanAlbumTitle('BLACK VINYL')).toBe('BLACK VINYL');
    });
    it('does not leave a dangling word after a spaced strip', () => {
        expect(cleanAlbumTitle('The WEB')).toBe('The WEB');
        expect(cleanAlbumTitle('Into The WEB')).toBe('Into The WEB');
        expect(cleanAlbumTitle('Out of WEB')).toBe('Out of WEB');
    });
    it('drops the separator in front of a spaced tag', () => {
        expect(cleanAlbumTitle('Sucker - WEB')).toBe('Sucker');
        expect(cleanAlbumTitle('Encore, CDS')).toBe('Encore');
    });
    it('strips MP3 and FLAC after a space only in upper case', () => {
        expect(cleanAlbumTitle('Greatest Hits Mp3')).toBe('Greatest Hits Mp3');
        expect(cleanAlbumTitle('Greatest Hits MP3')).toBe('Greatest Hits');
    });
    it('strips stacked spaced tags and is idempotent', () => {
        expect(cleanAlbumTitle('Sucker WEB CDS')).toBe('Sucker');
        expect(cleanAlbumTitle('Album (WEB) CDS')).toBe('Album');
        for (const t of ['Sucker WEB', 'Album (Promo CDS)', 'Hate_That_I_Love_You CDM']) {
            expect(cleanAlbumTitle(cleanAlbumTitle(t))).toBe(cleanAlbumTitle(t));
        }
    });
    it('drops an Artist- prefix only for dash/dot scene names', () => {
        expect(cleanAlbumTitle('Muse-Muse WEB', 'Muse')).toBe('Muse-Muse');
        expect(cleanAlbumTitle('Muse-Origin-WEB', 'Muse')).toBe('Origin');
    });
    it('turns underscores back into spaces after a spaced strip', () => {
        expect(cleanAlbumTitle('Hate_That_I_Love_You CDM')).toBe('Hate That I Love You');
    });
    it('stays fast on a long whitespace run', () => {
        const t = `A${' '.repeat(50_000)}B`;
        const start = performance.now();
        expect(cleanAlbumTitle(t)).toBe(t);
        expect(performance.now() - start).toBeLessThan(500);
    });
    it('does not strip mid-title scene tokens', () => {
        expect(cleanAlbumTitle('WEB Junkies')).toBe('WEB Junkies');
    });
    it('returns original trimmed input if stripping would consume everything', () => {
        expect(cleanAlbumTitle('WEB')).toBe('WEB');
    });
    it('trims whitespace', () => {
        expect(cleanAlbumTitle('  Album Name  ')).toBe('Album Name');
    });
    it('turns a double-underscore separator into " - "', () => {
        expect(cleanAlbumTitle('10 years__DJ Edition-WEB')).toBe('10 years - DJ Edition');
    });
    it('turns a double-underscore separator into " - " without a scene tag', () => {
        expect(cleanAlbumTitle('10 years__DJ Edition')).toBe('10 years - DJ Edition');
    });
    it('normalizes a fully underscored scene folder name', () => {
        expect(cleanAlbumTitle('10_Years__DJ_Edition-WEB')).toBe('10 Years - DJ Edition');
    });
    it('keeps single underscores when the title has spaces', () => {
        expect(cleanAlbumTitle('some_word Album-WEB')).toBe('some_word Album');
    });
    it('keeps single underscores in a title that was not a scene release', () => {
        expect(cleanAlbumTitle('lo_fi')).toBe('lo_fi');
    });
    it('leaves leading/trailing double underscores alone', () => {
        expect(cleanAlbumTitle('__init__')).toBe('__init__');
    });
    it('converts underscores only inside the fully underscored segment', () => {
        expect(cleanAlbumTitle('Cream Ibiza__Mixed_By_Eddie_Halliwell-2CD')).toBe(
            'Cream Ibiza - Mixed By Eddie Halliwell',
        );
    });
    it('strips a full scene tail (format tokens, year, group)', () => {
        expect(cleanAlbumTitle('Strictly Physical-16BIT-44-KHZ-WEB-FLAC-2020-WALKMAN')).toBe(
            'Strictly Physical',
        );
    });
    it('strips a scene tail and the artist prefix when the artist is known', () => {
        expect(
            cleanAlbumTitle(
                'Monrose-Strictly Physical-16BIT-44-KHZ-WEB-FLAC-2020-WALKMAN',
                'Monrose',
            ),
        ).toBe('Strictly Physical');
    });
    it('keeps an artist-like prefix on a title that was not a scene release', () => {
        expect(cleanAlbumTitle('Monrose-Strictly Physical', 'Monrose')).toBe(
            'Monrose-Strictly Physical',
        );
    });
    it('does not treat a dashed year without a scene tag as a scene tail', () => {
        expect(cleanAlbumTitle('Live-2020-Tour')).toBe('Live-2020-Tour');
    });
});

describe('parseArtistTitleFromFilename', () => {
    it('splits "Artist - Title"', () => {
        const result = parseArtistTitleFromFilename('/m/Eloren - Beautiful.mp3');
        expect(result).toEqual({
            left: 'Eloren',
            right: 'Beautiful',
            separator: '-',
        });
    });
    it('strips leading track number "01 - "', () => {
        const result = parseArtistTitleFromFilename('/m/01 - Cold Lantern Glows - Eloren.mp3');
        expect(result).toEqual({
            left: 'Cold Lantern Glows',
            right: 'Eloren',
            separator: '-',
        });
    });
    it('strips leading track number "01. "', () => {
        const result = parseArtistTitleFromFilename('/m/01. Artist - Title.mp3');
        expect(result).toEqual({
            left: 'Artist',
            right: 'Title',
            separator: '-',
        });
    });
    it('strips leading track number "01 " (no dash)', () => {
        const result = parseArtistTitleFromFilename('/m/01 Artist - Title.mp3');
        expect(result).toEqual({
            left: 'Artist',
            right: 'Title',
            separator: '-',
        });
    });
    it('recognizes en-dash separator', () => {
        const result = parseArtistTitleFromFilename('/m/Marc Fenwick – Miracle (Remix).mp3');
        expect(result).toEqual({
            left: 'Marc Fenwick',
            right: 'Miracle (Remix)',
            separator: '–',
        });
    });
    it('splits on FIRST separator only', () => {
        const result = parseArtistTitleFromFilename(
            '/m/Light The Way You Go [feat. Riona] - Eloren.mp3',
        );
        expect(result).toEqual({
            left: 'Light The Way You Go [feat. Riona]',
            right: 'Eloren',
            separator: '-',
        });
    });
    it('returns null when filename has no separator', () => {
        const result = parseArtistTitleFromFilename('/m/Happy Hour (Bangboy Mix).mp3');
        expect(result).toBeNull();
    });
    it('returns null when only a track number remains', () => {
        const result = parseArtistTitleFromFilename('/m/01.mp3');
        expect(result).toBeNull();
    });
    it('does not strip leading digits that are part of the name', () => {
        const result = parseArtistTitleFromFilename('/m/24K Lanterns - Bruno Vale.mp3');
        expect(result).toEqual({
            left: '24K Lanterns',
            right: 'Bruno Vale',
            separator: '-',
        });
    });
    it('rejects "YYYY - Title" layout (year on left)', () => {
        const result = parseArtistTitleFromFilename('/m/1999 - Little Red Lantern.mp3');
        expect(result).toBeNull();
    });
    it('rejects "YYYY - Title" even after track-number strip', () => {
        const result = parseArtistTitleFromFilename('/m/05 - 1999 - Sign o the Tides.mp3');
        expect(result).toBeNull();
    });
    it('accepts a 4-digit left side outside plausible year range', () => {
        // 4040 is a valid 4-digit string but far outside [1900, currentYear+1],
        // so it's kept as-is (not treated as year-title layout).
        const result = parseArtistTitleFromFilename('/m/4040 - Not Found.mp3');
        expect(result).toEqual({
            left: '4040',
            right: 'Not Found',
            separator: '-',
        });
    });
    it('recognizes underscore-flanked-by-spaces as a separator', () => {
        // Some rippers replace "Artist - Title" with "Artist _ Title" because
        // the dash is reserved on certain filesystems or by stylistic choice.
        const result = parseArtistTitleFromFilename(
            '/m/01-ARLO M. vs. MARC VAN VALE _ Bang The Drum (Allez Allez) (Dan Fenwick Bootleg Mix).mp3',
        );
        expect(result).toEqual({
            left: 'ARLO M. vs. MARC VAN VALE',
            right: 'Bang The Drum (Allez Allez) (Dan Fenwick Bootleg Mix)',
            separator: '_',
        });
    });
    it('does not split on inline underscores without flanking spaces', () => {
        // file_name_with_underscores must not be misinterpreted as artist/title
        const result = parseArtistTitleFromFilename('/m/some_filename_with_underscores.mp3');
        expect(result).toBeNull();
    });
    it('splits a wholly underscore-substituted filename (`Artist_-_Title`)', () => {
        // An untagged track whose every space is an underscore. Normalization
        // turns `_-_` into ` - ` so the artist splits out instead of being
        // buried in the title with underscores.
        const result = parseArtistTitleFromFilename('/m/artist_name_-_song_title.mp3');
        expect(result).toEqual({
            left: 'artist name',
            right: 'song title',
            separator: '-',
        });
    });
    it('strips a track number from a wholly underscore-substituted filename', () => {
        const result = parseArtistTitleFromFilename('/m/03_-_artist_two_-_second_song.mp3');
        expect(result).toEqual({
            left: 'artist two',
            right: 'second song',
            separator: '-',
        });
    });
    it('rejects disc/volume/disk patterns on the left side', () => {
        // "CD1", "Disc 2", "Disk 3", "Vol 1", "Volume 2", "Part 4" are almost
        // always disc identifiers leaked into a flat track filename, not real
        // artist names. Promote nothing — caller falls back to folder/etc.
        for (const name of [
            'CD1 - Some Song.mp3',
            'Disc 2 - Some Song.mp3',
            'Disk 3 - Some Song.mp3',
            'Vol 1 _ Some Song.mp3',
            'Volume 2 - Some Song.mp3',
            'Part 4 - Some Song.mp3',
        ]) {
            expect(
                parseArtistTitleFromFilename(`/m/${name}`),
                `expected null for "${name}"`,
            ).toBeNull();
        }
    });
});

describe('normalizeUnderscoreStem', () => {
    it('converts a wholly underscore-substituted stem to spaces', () => {
        expect(normalizeUnderscoreStem('artist_name_-_song_title')).toBe(
            'artist name - song title',
        );
    });
    it('leaves a stem that already contains spaces untouched', () => {
        expect(normalizeUnderscoreStem('some_word - title')).toBe('some_word - title');
    });
    it('leaves a stem with no underscores untouched', () => {
        expect(normalizeUnderscoreStem('plain - title')).toBe('plain - title');
    });
    it('collapses whitespace runs produced by adjacent underscores', () => {
        expect(normalizeUnderscoreStem('a__b')).toBe('a b');
    });
    it('never returns empty for an all-underscore stem', () => {
        expect(normalizeUnderscoreStem('___')).toBe('___');
    });
    it('leaves a stem containing a tab (non-space whitespace) untouched', () => {
        expect(normalizeUnderscoreStem('a\tb_c')).toBe('a\tb_c');
    });
});

describe('deriveDisplayFromStem', () => {
    it('splits artist and title out of an underscore stem', () => {
        expect(deriveDisplayFromStem('artist_name_-_song_title')).toEqual({
            title: 'song title',
            artist: 'artist name',
        });
    });
    it('cleans underscores in a title with no artist separator', () => {
        expect(deriveDisplayFromStem('some_untitled_title')).toEqual({
            title: 'some untitled title',
        });
    });
    it('does not lop off a trailing dotted token the way path.extname would', () => {
        // A raw DB title like "track.v2" must survive intact — deriveDisplayFromStem
        // operates on the bare stem, not a file path.
        expect(deriveDisplayFromStem('track.v2')).toEqual({ title: 'track.v2' });
    });
});

describe('deriveArtistName', () => {
    it('never takes the library folder itself as the artist (flat /music/Album or /music/Artist/track)', () => {
        // /music/Some Album/01.mp3: the "artist folder" would be the library root.
        expect(
            deriveArtistName({
                tagArtist: 'Tag Artist',
                filePath: '/music/Some Album/01.mp3',
                albumDir: '/music/Some Album',
                libraryRoot: '/music',
            }),
        ).toBe('Tag Artist');
        // /music/Artist/song.mp3: the track's folder is the album dir; its parent is the root.
        expect(
            deriveArtistName({
                tagArtist: 'Tag Artist',
                filePath: '/music/Artist/song.mp3',
                albumDir: '/music/Artist',
                libraryRoot: '/music/',
            }),
        ).toBe('Tag Artist');
        // The standard layout still uses the folder.
        expect(
            deriveArtistName({
                tagArtist: 'Track Artist',
                filePath: '/music/Folder Artist/Album/x.mp3',
                albumDir: '/music/Folder Artist/Album',
                libraryRoot: '/music',
            }),
        ).toBe('Folder Artist');
    });
    it('prefers albumArtist tag', () => {
        expect(
            deriveArtistName({
                tagAlbumArtist: 'Album Artist',
                tagArtist: 'Artist',
                filePath: '/music/Wrong/Wrong/wrong.mp3',
                albumDir: '/music/Wrong/Wrong',
            }),
        ).toBe('Album Artist');
    });
    it('prefers folder over ARTIST tag when albumArtist is empty', () => {
        // ARTIST is per-track, ALBUMARTIST is per-album; on compilations the
        // ARTIST tag varies between tracks but the album dir is shared. The
        // folder convention is the safer source for the album-level artist.
        expect(
            deriveArtistName({
                tagAlbumArtist: '',
                tagArtist: 'Track Artist',
                filePath: '/music/Folder Artist/Album/wrong.mp3',
                albumDir: '/music/Folder Artist/Album',
            }),
        ).toBe('Folder Artist');
    });
    it('uses folder parent when tags are missing', () => {
        expect(
            deriveArtistName({
                filePath: '/music/Eloren/Recovery/Song.mp3',
                albumDir: '/music/Eloren/Recovery',
            }),
        ).toBe('Eloren');
    });
    it('trusts folder when filename split confirms it (right side)', () => {
        expect(
            deriveArtistName({
                filePath: '/music/Eloren/Recovery/01 - Cold Lantern Glows - Eloren.mp3',
                albumDir: '/music/Eloren/Recovery',
            }),
        ).toBe('Eloren');
    });
    it('trusts folder when filename split confirms it (left side)', () => {
        expect(
            deriveArtistName({
                filePath: '/music/Eli Fenwick/Perfect/Eli Fenwick - Perfect.mp3',
                albumDir: '/music/Eli Fenwick/Perfect',
            }),
        ).toBe('Eli Fenwick');
    });
    it('normalizes differences between folder and filename artist', () => {
        // Folder has capital J, filename lowercases it
        expect(
            deriveArtistName({
                filePath: '/m/Alice DeeJay/Back In My Life/Alice Deejay - Back In My Life.mp3',
                albumDir: '/m/Alice DeeJay/Back In My Life',
            }),
        ).toBe('Alice DeeJay');
    });
    it('keeps compilation tracks unified under the folder artist', () => {
        // /<curator>/<compilation>/<track> layout: each track's filename names
        // a different per-track artist (Timmy Trumpet, ANGEMI, ...) but the
        // album-level artist is the curator one level above the album dir.
        // The per-track artist still gets captured by ensureTrackArtistLinks.
        expect(
            deriveArtistName({
                filePath:
                    '/music/Robin/Eskalationsplaylist (2024)/Timmy Trumpet & ANGEMI - Collab Bro.mp3',
                albumDir: '/music/Robin/Eskalationsplaylist (2024)',
            }),
        ).toBe('Robin');
    });
    it('falls back to folder parent when filename has no separator (even if generic)', () => {
        expect(
            deriveArtistName({
                filePath: '/music/Robin/Eskalationsplaylist (2024)/Happy Hour (Bangboy Mix).mp3',
                albumDir: '/music/Robin/Eskalationsplaylist (2024)',
            }),
        ).toBe('Robin');
    });
    it('returns "Unknown Artist" when nothing else is available', () => {
        expect(
            deriveArtistName({
                filePath: '/track.mp3',
                albumDir: '/',
            }),
        ).toBe('Unknown Artist');
    });
    it('trims tag whitespace', () => {
        expect(
            deriveArtistName({
                tagAlbumArtist: '  Eloren  ',
                filePath: '/x.mp3',
                albumDir: '/x',
            }),
        ).toBe('Eloren');
    });
    it('trusts non-Latin folder when normalization collapses to empty', () => {
        // "星野蒼月" (Aotsuki Hoshino) collapses to "" under [a-z0-9 ] normalization.
        // Without the fallback, the filename's left side would win; with it, we
        // trust the folder convention since we're clearly in /Artist/Album/Track.
        expect(
            deriveArtistName({
                filePath: '/music/星野蒼月/Async/01 - andata - 星野蒼月.mp3',
                albumDir: '/music/星野蒼月/Async',
            }),
        ).toBe('星野蒼月');
    });
    it('falls back to filename when year-only left is rejected and folder matches none', () => {
        // "1999 - Little Red Lantern.mp3" under a compilation folder that matches
        // neither side. Parser rejects year-left, so filename parse returns null;
        // we fall back to the folder parent ("Compilations").
        expect(
            deriveArtistName({
                filePath: '/music/Compilations/80s Hits/1999 - Little Red Lantern.mp3',
                albumDir: '/music/Compilations/80s Hits',
            }),
        ).toBe('Compilations');
    });
    it('prefers folder over `_`-separated filename split', () => {
        // `_` shows up inside track titles ("Foo _ Bar") more often than as
        // an artist/title delimiter; the folder convention is the safer source
        // of the album-level artist.
        expect(
            deriveArtistName({
                filePath: '/music/Artist Name/Album/01 - Track _ Subtitle.mp3',
                albumDir: '/music/Artist Name/Album',
            }),
        ).toBe('Artist Name');
    });
    it('keeps compilation tracks unified under the folder when filename uses hyphen split', () => {
        // Even with the canonical `-` separator, the filename's left side is
        // the per-track artist on a compilation, not the album artist. Trust
        // the folder so all tracks in the same compilation dir land under the
        // same album hierarchy rather than fragmenting into one per artist.
        expect(
            deriveArtistName({
                filePath: '/music/Compilations/Mix/Real Artist - Real Song.mp3',
                albumDir: '/music/Compilations/Mix',
            }),
        ).toBe('Compilations');
    });
    it('prefers folder over per-track ARTIST tag when albumArtist is empty', () => {
        // The bug case: ALBUMARTIST tag empty, ARTIST tag set per track. With
        // a folder convention present, the folder is the album-level artist;
        // the ARTIST tag is captured separately as a per-track collaboration.
        expect(
            deriveArtistName({
                tagAlbumArtist: '',
                tagArtist: 'harborbrothers',
                filePath: '/music/Rob Fenwick/80 Plus (2015)/02-harborbrothers_-_welcome.mp3',
                albumDir: '/music/Rob Fenwick/80 Plus (2015)',
            }),
        ).toBe('Rob Fenwick');
    });
    it('uses tagArtist when no folder context is available', () => {
        // File at library root with no /<Artist>/ subfolder: folder-derivation
        // is meaningless, so the per-track ARTIST tag is the best signal.
        expect(
            deriveArtistName({
                tagArtist: 'Solo Artist',
                filePath: '/track.mp3',
                albumDir: '/',
            }),
        ).toBe('Solo Artist');
    });
});

describe('findSidecarLyrics', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('returns synced lyrics from .lrc file', async () => {
        const lrcContent = '[00:12.34]Hello world\n[00:15.00]Second line';
        vi.mocked(readContainedFile).mockResolvedValueOnce(Buffer.from(lrcContent));
        const result = await findSidecarLyrics('/music/Artist/Album/track.flac');
        expect(result).not.toBeNull();
        expect(result!.source).toBe('file');
        expect(result!.synced).toContain('[00:12.34]');
        expect(result!.format).toBe('lrc');
    });

    it('returns plain lyrics from .txt file when no .lrc exists', async () => {
        vi.mocked(readContainedFile)
            .mockRejectedValueOnce(new Error('ENOENT'))
            .mockResolvedValueOnce(Buffer.from('Plain lyrics text'));
        const result = await findSidecarLyrics('/music/Artist/Album/track.flac');
        expect(result).not.toBeNull();
        expect(result!.source).toBe('file');
        expect(result!.plain).toBe('Plain lyrics text');
        expect(result!.format).toBe('plain');
    });

    it('prefers .lrc over .txt', async () => {
        const lrcContent = '[00:01.00]LRC line';
        vi.mocked(readContainedFile).mockResolvedValueOnce(Buffer.from(lrcContent));
        const result = await findSidecarLyrics('/music/Artist/Album/track.flac');
        expect(result!.format).toBe('lrc');
    });

    it('returns null when no sidecar exists', async () => {
        vi.mocked(readContainedFile)
            .mockRejectedValueOnce(new Error('ENOENT'))
            .mockRejectedValueOnce(new Error('ENOENT'));
        const result = await findSidecarLyrics('/music/Artist/Album/track.flac');
        expect(result).toBeNull();
    });

    it('detects LRC content in .txt files', async () => {
        vi.mocked(readContainedFile)
            .mockRejectedValueOnce(new Error('ENOENT'))
            .mockResolvedValueOnce(Buffer.from('[00:12.34]Synced in txt'));
        const result = await findSidecarLyrics('/music/Artist/Album/track.flac');
        expect(result!.format).toBe('lrc');
        expect(result!.synced).toContain('[00:12.34]');
    });
});

describe('isCompilationArtistName', () => {
    it('matches bare "Various"', () => {
        expect(isCompilationArtistName('Various')).toBe(true);
        expect(isCompilationArtistName('various')).toBe(true);
        expect(isCompilationArtistName('Various Artists')).toBe(true);
        expect(isCompilationArtistName('Various Artist')).toBe(true);
    });

    it('matches "VA" / "V.A."', () => {
        expect(isCompilationArtistName('VA')).toBe(true);
        expect(isCompilationArtistName('va')).toBe(true);
        expect(isCompilationArtistName('V.A.')).toBe(true);
        expect(isCompilationArtistName('v.a')).toBe(true);
    });

    it('matches slash-suffix compilation markers', () => {
        expect(isCompilationArtistName('Bass T/Various')).toBe(true);
        expect(isCompilationArtistName('Artist/VA')).toBe(true);
        expect(isCompilationArtistName('Curator / Various Artists')).toBe(true);
    });

    it('rejects real artist names', () => {
        expect(isCompilationArtistName('Rocco')).toBe(false);
        expect(isCompilationArtistName('Future Breeze')).toBe(false);
        expect(isCompilationArtistName('Sonny & Cher')).toBe(false);
        expect(isCompilationArtistName('AC/DC')).toBe(false);
    });

    it('treats empty / whitespace as compilation', () => {
        expect(isCompilationArtistName('')).toBe(true);
        expect(isCompilationArtistName('   ')).toBe(true);
    });
});

describe('cleanUnderscoreSeparators', () => {
    it.each([
        ['Lantern Tango__Club Mix', 'Lantern Tango - Club Mix'],
        ['Im A Good Man__A1', 'Im A Good Man - A1'],
        ['MARRY THE NIGHT__(RADIO EDIT)', 'MARRY THE NIGHT (RADIO EDIT)'],
        ['Nana__Snooze (the Remixes)', 'Nana - Snooze (the Remixes)'],
        ['Cream Ibiza__Mixed_By_Eddie_Halliwell', 'Cream Ibiza - Mixed By Eddie Halliwell'],
        ['lo_fi', 'lo_fi'],
        ['__init__', '__init__'],
        ['Plain Title', 'Plain Title'],
    ])('%s -> %s', (input, expected) => {
        expect(cleanUnderscoreSeparators(input)).toBe(expected);
    });
});

describe('spaceUnderscoreWords', () => {
    // Shapes of the prod rows from 2026-10-15 (names invented).
    it.each([
        ['Corin_Vale', 'Corin Vale'],
        ['Hold_The_Signal', 'Hold The Signal'],
        ['NVX_feat_Orrin', 'NVX feat Orrin'],
        ['Mira_M._for_Tessa', 'Mira M. for Tessa'],
        ['marco_van_halden_feat._orrin', 'marco van halden feat. orrin'],
        ['4_Strings', '4 Strings'],
        ['03-Harbor_Project', '03-Harbor Project'],
        ['01_17_08_LIVE_Lantern', '01 17 08 LIVE Lantern'],
        ['18-Tom_Vale_joins_NVX_and_DE_', '18-Tom Vale joins NVX and DE_'],
        ['light_up_the_sky__acoustic_mix', 'light up the sky - acoustic mix'],
    ])('%s -> %s', (input, expected) => {
        expect(spaceUnderscoreWords(input)).toBe(expected);
    });

    it.each([
        // One real space: the underscores are deliberate.
        'Mara Feat_ Tessa',
        'Quiet Full_VLS',
        'Im A Good Man__A2',
        // Edges only, or a lower-case handle with one underscore.
        '__init__',
        '_ensnare_',
        'lo_fi',
        'Plain',
        '',
    ])('leaves %j alone', (input) => {
        expect(spaceUnderscoreWords(input)).toBe(input);
    });
});

describe('underscore-for-space names in the album and artist fallbacks', () => {
    it('cleanAlbumTitle spaces a no-space album tag', () => {
        expect(cleanAlbumTitle('Hold_The_Signal')).toBe('Hold The Signal');
        expect(cleanAlbumTitle('Lantern_Trance_vol_12_CD1')).toBe('Lantern Trance vol 12 CD1');
    });

    it('deriveArtistName spaces an underscore folder artist', () => {
        expect(
            deriveArtistName({
                filePath: '/music/Corin_Vale/Hold_The_Signal (2010)/CD 01/05.mp3',
                albumDir: '/music/Corin_Vale/Hold_The_Signal (2010)',
            }),
        ).toBe('Corin Vale');
    });

    it('deriveArtistName spaces the artist of an `Artist - Title` filename at the library root', () => {
        expect(
            deriveArtistName({
                filePath: '/Corin_Vale - hold the signal.mp3',
                albumDir: '/',
            }),
        ).toBe('Corin Vale');
    });
});

describe('stripTrackNumberFromArtistTag', () => {
    const strip = (v: string, filePath: string): string =>
        stripTrackNumberFromArtistTag(v, { filePath });
    const dir = '/data/music/Various Artists/Dance Mix Vol. 3 (2001)/CD 01/';

    it('strips the prefix when the file name repeats the tag and the track number', () => {
        expect(
            strip(
                '09-Corin_Vale',
                `${dir}09-Corin_Vale - Dance_Mix_vol_3 - 09 - Hold_the_signal.mp3`,
            ),
        ).toBe('Corin_Vale');
        // The stored copy was already spaced by an earlier migration.
        expect(
            strip(
                '05-Harbor and Lane',
                `${dir}05-Harbor_and_Lane - Dance_Mix_vol_3 - 05 - Night_run.mp3`,
            ),
        ).toBe('Harbor and Lane');
        expect(strip(' 09-Corin_Vale ', `${dir}09-Corin_Vale - A - 09 - T.mp3`)).toBe('Corin_Vale');
    });

    it('accepts a disc+track segment', () => {
        expect(
            strip(
                '06-Lantern_Gate',
                `${dir}06-Lantern_Gate - Dance_Mix_vol_3CD2 - 206 - Anthem.mp3`,
            ),
        ).toBe('Lantern_Gate');
    });

    it('keeps legit names that start with digits', () => {
        // Even when the file name carries the very same number.
        expect(strip('2-4 Grooves', `${dir}2-4 Grooves - Some Title.flac`)).toBe('2-4 Grooves');
        expect(strip('2-4 Grooves', `${dir}2-4 Grooves - Album - 02 - Some Title.flac`)).toBe(
            '2-4 Grooves',
        );
        expect(strip('2-4 Grooves', `${dir}2-4 Grooves - Album - 102 - Some Title.flac`)).toBe(
            '2-4 Grooves',
        );
        expect(strip('50-50', `${dir}50-50 - Album - 50 - Title.mp3`)).toBe('50-50');
        for (const name of ['4 Strings', '2000 Canarias', '808 State', 'Corin Vale']) {
            expect(strip(name, `${dir}${name} - Album - 04 - Title.mp3`)).toBe(name);
        }
    });

    it('keeps the tag when the file does not repeat it or the number differs', () => {
        expect(strip('09-Corin_Vale', `${dir}Title.mp3`)).toBe('09-Corin_Vale');
        expect(strip('09-Corin_Vale', `${dir}09-Corin_Vale - Album - 11 - Title.mp3`)).toBe(
            '09-Corin_Vale',
        );
        expect(strip('09-', `${dir}09- - Album - 09 - Title.mp3`)).toBe('09-');
    });

    it('a tag-less file name already loses the prefix through the filename split', () => {
        expect(
            parseArtistTitleFromFilename(`${dir}09-Corin_Vale - Album - 09 - Title.mp3`)?.left,
        ).toBe('Corin_Vale');
    });
});

describe('splitDiscSuffix', () => {
    it.each<[string, number]>([
        ['X CD1', 1],
        ['X CD 1', 1],
        ['X - CD 1', 1],
        ['X - CD1', 1],
        ['X (CD1)', 1],
        ['X [CD 2]', 2],
        ['X (Disc 2)', 2],
        ['X — Disc 2', 2],
        ['X CD20', 20],
        ['X - Disk 3', 3],
        ['X [Disc 1 of 2]', 1],
        ['X CD 01', 1],
        ['X – cd 2', 2],
        ['X: dIsK 3', 3],
        ['X, CD2', 2],
        ['Night Drive Vol. 2 CD1', 1],
    ])('splits %s', (input, disc) => {
        const title = input.startsWith('Night') ? 'Night Drive Vol. 2' : 'X';
        expect(splitDiscSuffix(input)).toEqual({ title, disc });
    });
    it.each([
        'X Vol. 2',
        'X Volume 2',
        'X Part 2',
        'CD1',
        'CD 2',
        '(CD1)',
        '[Disc 2]',
        'ABCD 2',
        'CD2Future',
        'X CD2Future',
        'X 2CD',
        'X [2CD]',
        'X (2CD)',
        'X (CD1]',
        'X [Disc 2)',
        'X CD0',
        'Compact Disc 1983',
        'Copper Horizon (2000)',
        'Best of CD 2000',
        'Off the Disc 3',
        'X Disk 2',
        'X CD21',
        'X - Disc 21',
        'X CD-1',
        'X CD1 bonus',
        '',
    ])('preserves %s without inventing a disc number', (title) => {
        expect(splitDiscSuffix(title)).toEqual({ title, disc: null });
    });
});

describe('folder album title identity', () => {
    it('requires evidence for bare Disc/Disk markers even when the ordinal is plausible', () => {
        expect(splitDiscSuffix('Copper Horizon Disc 3', true)).toEqual({
            title: 'Copper Horizon',
            disc: 3,
        });
        expect(splitDiscSuffix('Copper Horizon Disk 2', true)).toEqual({
            title: 'Copper Horizon',
            disc: 2,
        });
        expect(splitDiscSuffix('Copper Horizon Disc 1983', true).disc).toBeNull();
    });
    it('keeps the marker without folder evidence, even for explicit CD syntax', () => {
        for (const title of [
            'Copper Horizon CD1',
            'Copper Horizon [Disc 2]',
            'Copper Horizon — Disc 2',
        ]) {
            expect(folderAlbumTitle(title)).toBe(title);
            expect(folderAlbumTitle(title, true)).toBe('Copper Horizon');
        }
    });
    it('requires different markers for the same cleaned base', () => {
        expect(
            hasMatchingDiscTitles('Copper Horizon CD1', [
                'Copper Horizon CD1',
                'Other Horizon CD2',
            ]),
        ).toBe(false);
        expect(hasMatchingDiscTitles('Copper Horizon CD1', ['Copper Horizon'])).toBe(false);
        expect(
            hasMatchingDiscTitles('Copper Horizon CD1 (2000)', [' copper horizon Disc 2 WEB']),
        ).toBe(true);
        expect(hasMatchingDiscTitles('Copper Horizon CD1', ['Copper Horizon CD2000'])).toBe(false);
    });
    it.each(['Copper Horizon CD1 (2000)', 'Copper Horizon CD1 WEB', 'Copper Horizon — Disc 1 WEB'])(
        'finds the marker after scene cleanup in %s only with evidence',
        (title) => {
            expect(folderAlbumTitle(title, true)).toBe('Copper Horizon');
            expect(folderAlbumTitle(title)).toContain(title.includes('Disc') ? 'Disc 1' : 'CD1');
        },
    );
    it('applies the same evidence rule to VA folder fallbacks', () => {
        expect(parseVAFolderPattern('VA - Copper Horizon CD1 WEB')?.album).toBe(
            'Copper Horizon CD1',
        );
        expect(parseVAFolderPattern('VA - Copper Horizon CD1 WEB', true)?.album).toBe(
            'Copper Horizon',
        );
    });
    it('bounds matching work for oversized titles and long trailing whitespace', () => {
        const long = 'Copper Horizon' + ' '.repeat(100_000) + 'CD1';
        expect(splitDiscSuffix(long)).toEqual({ title: long, disc: null });
        const padded = 'Copper Horizon CD1' + ' '.repeat(300);
        expect(splitDiscSuffix(padded)).toEqual({ title: 'Copper Horizon', disc: 1 });
        const longBase = 'x'.repeat(501) + ' CD1';
        expect(splitDiscSuffix(longBase, true).disc).toBeNull();
    });
});

describe('trackNumberFromFilename', () => {
    it.each<[string, number | null, number | null]>([
        ['Mira Vale - Glass Roads - 06 - Lantern.mp3', null, 6],
        ['Mira Vale - Glass Roads - 116 - Lantern.mp3', 1, 16],
        ['01-Mira Vale - Glass_Roads - 07 - Lantern.mp3', null, 7],
        ['101_mira_vale_-_lantern.mp3', 1, 1],
        ['301. Mira Vale - Lantern.mp3', 3, 1],
        ['01 - Mira Vale - Lantern.mp3', null, 1],
        ['02. Lantern.mp3', null, 2],
        ['03-Lantern.mp3', null, 3],
        ['04_Lantern.mp3', null, 4],
        ['5 - Lantern.mp3', null, null],
        ['2-Unlimited - Lantern.mp3', null, null],
        ['666 - Lantern.mp3', null, null],
        ['666 - Glass Roads - 06 - Lantern.mp3', null, 6],
        ['999 - Lantern.mp3', 9, 99],
        ['116 - Lantern.mp3', null, null],
        ['116 - Lantern.mp3', 2, null],
        ['Mira Vale - Glass Roads - 116 - Lantern.mp3', null, 116],
        ['Artist - 07 - Album - 07 - Title.mp3', null, 7],
        ['Artist - 07 - Album - 08 - Title.mp3', null, null],
        ['01-Artist - 07 - Album - 08 - Title.mp3', null, null],
        ['2024 - Lantern.mp3', null, null],
        ['2024_Lantern.mp3', null, null],
        ['Artist - Album - 2024 - Lantern.mp3', null, null],
        ['2-4 Grooves - Lantern.mp3', null, null],
        ['50-50.mp3', null, null],
        ['Artist - Title 07.mp3', null, null],
        ['00 - Lantern.mp3', null, null],
        ['000_Lantern.mp3', null, null],
        ['100_Lantern.mp3', 1, null],
        ['Artist - Album - 00 - Lantern.mp3', null, null],
        ['/music/07 - Album/Lantern.mp3', null, null],
    ])('%s (disc %s) → %s', (filePath, disc, expected) => {
        expect(trackNumberFromFilename(filePath, disc)).toBe(expected);
    });
});
