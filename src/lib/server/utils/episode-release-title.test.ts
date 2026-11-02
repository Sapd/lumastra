// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    episodeTitleFromFileName,
    isReleaseStyleTitle,
    looksLikeReleaseName,
    rederiveEpisodeTitle,
    releaseTitleSegments,
} from './episode-release-title.js';

describe('episodeTitleFromFileName', () => {
    it('extracts the title from a Sonarr-style anime release (the reported notification)', () => {
        expect(
            episodeTitleFromFileName(
                'The 100 Girlfriends Who Really, Really, Really, Really, REALLY Love You (2023) - S03E09 - 033 - Hardcore Hot Springs Hopping With A Chance Of Heaven [WEBDL 720p][8bit][AVC][AAC 2.0][JA]-Erai-raws.mkv',
                9,
            ),
        ).toBe('Hardcore Hot Springs Hopping With A Chance Of Heaven');
    });

    it('extracts the title from a dotted scene release', () => {
        expect(
            episodeTitleFromFileName(
                'Show.Name.S01E05.The.Big.Day.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv',
                5,
            ),
        ).toBe('The Big Day');
    });

    it('extracts the title from a plain "Show - SxxEyy - Title" name', () => {
        expect(episodeTitleFromFileName('Show - S02E03 - Pilot Redux.mkv', 3)).toBe('Pilot Redux');
    });

    it('drops a trailing source tag segment ("- DVD"), but keeps DVD inside a title', () => {
        expect(episodeTitleFromFileName('Show - S01E03 - The Red Codebook - DVD.avi', 3)).toBe(
            'The Red Codebook',
        );
        expect(episodeTitleFromFileName('Show - S01E04 - The Red Codebook - VHS.mkv', 4)).toBe(
            'The Red Codebook',
        );
        expect(episodeTitleFromFileName('Show - S01E05 - The DVD Commentary.mkv', 5)).toBe(
            'The DVD Commentary',
        );
        // A title that is only such a word stays: an episode can be called "Audio".
        expect(episodeTitleFromFileName('Show - S01E06 - Audio.mkv', 6)).toBe('Audio');
        expect(releaseTitleSegments('Show - S01E03 - The Red Codebook - DVD.avi')).toEqual([
            'The Red Codebook',
        ]);
    });

    it('falls back to "Episode N" when a release has no title after the SxxEyy token', () => {
        expect(episodeTitleFromFileName('Show.S01E07.720p.HDTV.x264-GRP.mkv', 7)).toBe('Episode 7');
        expect(episodeTitleFromFileName('Show - S01E07 - 007 [1080p].mkv', 7)).toBe('Episode 7');
    });

    it('falls back to "Episode N" for a fansub release without SxxEyy (series name ≠ episode title)', () => {
        expect(
            episodeTitleFromFileName('[Erai-raws] Some Show - 09 [720p][Multiple Subtitle].mkv', 9),
        ).toBe('Episode 9');
    });

    it('keeps the legacy title-cased basename for plain personal-video names', () => {
        expect(episodeTitleFromFileName('summer-holiday_2019.mp4', 1)).toBe('Summer Holiday 2019');
        expect(episodeTitleFromFileName('Pilot.mkv', 1)).toBe('Pilot');
    });

    it('never returns an empty or bracket-bearing title', () => {
        for (const name of ['[x].mkv', 'S01E01.mkv', '[GRP] - 01 [1080p].mkv']) {
            const title = episodeTitleFromFileName(name, 1);
            expect(title.length).toBeGreaterThan(0);
            expect(title).not.toMatch(/[[\]]/);
        }
    });
});

describe('looksLikeReleaseName', () => {
    it('flags release-style names', () => {
        expect(looksLikeReleaseName('Show S01E01 [720p]')).toBe(true);
        expect(looksLikeReleaseName('Show.S01E01.WEB-DL')).toBe(true);
        expect(looksLikeReleaseName('[Grp] Show - 01')).toBe(true);
    });

    it('does not flag ordinary titles', () => {
        expect(looksLikeReleaseName('The Big Day')).toBe(false);
        expect(looksLikeReleaseName('Episode 36')).toBe(false);
        expect(looksLikeReleaseName('Summer Holiday 2019')).toBe(false);
    });
});

describe('episodeTitleFromFileName — absolute-numbered files without a title', () => {
    it('falls back to "Episode N" when the name is only the series, year and the episode number', () => {
        expect(episodeTitleFromFileName('Quillon Harbour (2031) - 07.mkv', 7)).toBe('Episode 7');
        expect(episodeTitleFromFileName('Quillon Harbour (2031) - 007.mkv', 7)).toBe('Episode 7');
        expect(episodeTitleFromFileName('Quillon Harbour (2031) - 09.mkv', 9)).toBe('Episode 9');
    });

    it('keeps a real title that follows the S/E token', () => {
        expect(
            episodeTitleFromFileName('Quillon Harbour (2031) - S01E02 - The Bridge.mkv', 2),
        ).toBe('The Bridge');
        expect(episodeTitleFromFileName('Show - S01E02 - The Bridge.mkv', 2)).toBe('The Bridge');
    });

    it('keeps the legacy title when the trailing number is not the episode number', () => {
        // 2019 is not this episode's number (1), so the name is not read as a bare number.
        expect(episodeTitleFromFileName('Holiday - 2019.mkv', 1)).not.toBe('Episode 1');
    });

    it('keeps plain personal names that end in a number without a dash', () => {
        expect(episodeTitleFromFileName('summer-holiday_2019.mp4', 7)).toBe('Summer Holiday 2019');
    });
});

describe('episodeTitleFromFileName — prod edge cases', () => {
    it('drops an unbalanced trailing group tag', () => {
        expect(
            episodeTitleFromFileName(
                'Battle Girl High School - Battle Girl Project (2017) - S01E03 - 003 - Resort! Retreat! Escape! [Bluray-1080p][10bit][x265][AC3 2.0][JA]-GHOST][.mkv',
                3,
            ),
        ).toBe('Resort! Retreat! Escape!');
    });

    it('cuts a trailing quality segment', () => {
        expect(
            episodeTitleFromFileName('Kitchen Nightmares (US) - S08E07 - Verdict - WEBDL.mkv', 7),
        ).toBe('Verdict');
    });
});

describe('isReleaseStyleTitle', () => {
    it.each([
        'Bleach (2004)   S17E48   414   THE END TWO WORLD [WEBDL 1080p][8bit][H265][AAC 2.0][JA] ToonsHub',
        'S01E0894 - SKY HARBOR',
        'Sky.Harbor.S01E0921.GerSub',
        '[uP] Sorami - 155 (BDRip 1080p x264 AC3 Multi)',
        '[Erai-raws]_AVC_CR',
    ])('flags %s', (title) => {
        expect(isReleaseStyleTitle(title)).toBe(true);
    });

    it.each([
        'flowers for m[A]chine',
        '[DEBUT STREAM] The Demon Lord Veltol Has Arisen!',
        'The Edible Arrangement [450th episode]',
        'Azur Lane 40sec. Understanding [Javelin Ver.]',
        "Valentines and Hot Springs! (Please Don't Get Your Hopes Up)",
        'Episode 36',
    ])('keeps %s', (title) => {
        expect(isReleaseStyleTitle(title)).toBe(false);
    });
});

describe('glued quality tags and space-separated groups', () => {
    it('cuts WEBDL-1080p / HDTV-1080p segments', () => {
        expect(
            episodeTitleFromFileName(
                'Bluey Minisodes - S02E01 - Humpty Dumpty - WEBDL-1080p.mkv',
                1,
            ),
        ).toBe('Humpty Dumpty');
        expect(isReleaseStyleTitle('Humpty Dumpty - WEBDL-1080p')).toBe(true);
    });
});

describe('rederiveEpisodeTitle', () => {
    it('keeps the title from the stored release name when the file carries none', () => {
        expect(
            rederiveEpisodeTitle(
                'Bleach (2004)   S04E18   081   Hitsugaya Moves! The Attacked City [WEBDL 720p][8bit][H264][AAC 2.0][JA] Emmid',
                'Bleach (2004) - S04E18 - 081 [HDTV-1080p].mkv',
                18,
            ),
        ).toBe('Hitsugaya Moves! The Attacked City');
    });

    it('prefers the current file name when it has a title', () => {
        expect(
            rederiveEpisodeTitle(
                'Old   S01E02   Stale [WEBDL 720p] G',
                'Show - S01E02 - Fresh [720p].mkv',
                2,
            ),
        ).toBe('Fresh');
    });
});

describe('placeholders and SD tags', () => {
    it('treats a Sonarr TBA title as untitled', () => {
        expect(
            episodeTitleFromFileName('Morden im Norden - S10E15 - TBA - WEBDL-1080p.mkv', 15),
        ).toBe('Episode 15');
    });

    it('cuts an SDTV segment', () => {
        expect(episodeTitleFromFileName('Bait Car - S02E19 - LA-219 - SDTV.mkv', 19)).toBe(
            'LA-219',
        );
    });
});

describe('releaseTitleSegments', () => {
    it('drops the absolute number and the tags', () => {
        expect(
            releaseTitleSegments('Show (2004) - S09E21 - 188 - Duel! Amagai [Bluray-720p].mkv'),
        ).toEqual(['Duel! Amagai']);
    });

    it('keeps the parts of a multi-part title apart', () => {
        expect(
            releaseTitleSegments('Show - S01E05 - Part One - Part Two - WEBDL-1080p.mkv'),
        ).toEqual(['Part One', 'Part Two']);
    });

    it('is empty for TBA and for names without SxxEyy', () => {
        expect(releaseTitleSegments('Show - S04E21 - 085 - TBA [WEBDL-720p].mkv')).toEqual([]);
        expect(releaseTitleSegments('[Grp] Show - 09 [720p].mkv')).toEqual([]);
    });

    it('drops the series name and language words, so the file is untitled', () => {
        expect(
            releaseTitleSegments('S01E0422 - ONE PIECE [GER-JAP].mp4', {
                seriesTitle: 'One Piece',
            }),
        ).toEqual([]);
        expect(
            releaseTitleSegments('InuYasha.S01E120.German.AC3.DL.720p.BluRay.x264-Fuuko.mkv', {
                seriesTitle: 'InuYasha',
            }),
        ).toEqual([]);
        expect(releaseTitleSegments('Show - S01E05 - Real Title - JAP.mkv')).toEqual([
            'Real Title',
        ]);
        expect(releaseTitleSegments('Show - S01E05 - Real Title - Dubbed Sub.mkv')).toEqual([
            'Real Title',
        ]);
    });

    it('keeps a real title next to the series name and ignores a year on the series title', () => {
        expect(
            releaseTitleSegments('Show - S01E05 - Show - Real Title.mkv', {
                seriesTitle: 'Show (2004)',
            }),
        ).toEqual(['Real Title']);
        expect(
            releaseTitleSegments('Show - S01E05 - Real Title.mkv', { seriesTitle: 'Show' }),
        ).toEqual(['Real Title']);
    });

    it('does not use a series title shorter than three characters as a filter', () => {
        expect(releaseTitleSegments('X - S01E05 - Xenon Rising.mkv', { seriesTitle: 'X' })).toEqual(
            ['Xenon Rising'],
        );
    });
});
