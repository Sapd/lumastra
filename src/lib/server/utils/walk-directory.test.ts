// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    walkDirectory,
    walkDirectoryWithResult,
    walkExtras,
    walkArtwork,
    walkSubtitles,
    albumPosterCandidates,
    globMatches,
    isAppleDoubleSidecar,
    SUBTITLE_EXTENSIONS,
} from './walk-directory.js';
import { setSensitivePrefixesForTests } from './contained-fs.js';

// No database in unit tests: only the walked root counts for symlink containment.
vi.mock('../database/connection.js', () => ({ getDb: () => null }));

describe('walkDirectory', () => {
    let tmpDir: string;

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('finds media files recursively', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'Action'), { recursive: true });
        mkdirSync(join(tmpDir, 'Drama'), { recursive: true });
        writeFileSync(join(tmpDir, 'Action', 'The.Lantern.1999.mkv'), '');
        writeFileSync(join(tmpDir, 'Drama', 'Daydream.2010.mp4'), '');
        writeFileSync(join(tmpDir, 'thumbs.db'), ''); // ignored

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(2);
        expect(files.some((f) => f.endsWith('The.Lantern.1999.mkv'))).toBe(true);
        expect(files.some((f) => f.endsWith('Daydream.2010.mp4'))).toBe(true);
    });

    it('returns empty array for empty directory', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        expect(await walkDirectory(tmpDir)).toHaveLength(0);
    });

    it('handles non-existent directory gracefully', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        expect(await walkDirectory('/non/existent/path')).toHaveLength(0);
    });

    it('discovers deeply nested files', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'TV', 'Show', 'Season 01'), { recursive: true });
        writeFileSync(join(tmpDir, 'TV', 'Show', 'Season 01', 'S01E01.mkv'), '');
        writeFileSync(
            join(tmpDir, 'TV', 'Show', 'Season 01', 'S01E01.nfo'),
            '', // ignored
        );

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('S01E01.mkv');
    });

    it('handles all supported video extensions', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        const extensions = ['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.webm'];
        for (const ext of extensions) {
            writeFileSync(join(tmpDir, `video${ext}`), '');
        }

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(extensions.length);
    });

    // ---------------------------------------------------------------------------
    // Excluded folder names
    // ---------------------------------------------------------------------------

    it('skips "extras" folder', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'Movie (2020)'), { recursive: true });
        mkdirSync(join(tmpDir, 'Movie (2020)', 'extras'), { recursive: true });
        writeFileSync(join(tmpDir, 'Movie (2020)', 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'Movie (2020)', 'extras', 'behind-the-scenes.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('Movie.mkv');
    });

    it('skips "samples" folder', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'samples'), { recursive: true });
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'samples', 'clip.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
    });

    it('skips "bonus" folder', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'bonus'), { recursive: true });
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'bonus', 'extra.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
    });

    it('skips "VIDEO_TS" folder (case-insensitive)', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'VIDEO_TS'), { recursive: true });
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'VIDEO_TS', 'VTS_01_1.m2ts'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
    });

    it('skips "BDMV" folder', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'BDMV', 'STREAM'), { recursive: true });
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'BDMV', 'STREAM', '00001.m2ts'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
    });

    it('skips extras subfolders: featurettes, trailers, deleted scenes', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        const skipFolders = [
            'featurettes',
            'trailers',
            'deleted scenes',
            'shorts',
            'interviews',
            'scenes',
        ];
        for (const folder of skipFolders) {
            mkdirSync(join(tmpDir, folder), { recursive: true });
            writeFileSync(join(tmpDir, folder, 'clip.mkv'), '');
        }
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('Movie.mkv');
    });

    // ---------------------------------------------------------------------------
    // Sample file exclusion
    // ---------------------------------------------------------------------------

    it('skips files with "sample" in the name', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'Movie-sample.mkv'), '');
        writeFileSync(join(tmpDir, 'sample.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('Movie.mkv');
    });

    it('does not skip files where "sample" is part of another word', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        // "resampled" does not contain the word boundary \bsample\b
        writeFileSync(join(tmpDir, 'resampled-audio.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
    });

    // ---------------------------------------------------------------------------
    // .lumastraignore
    // ---------------------------------------------------------------------------

    it('.lumastraignore at root excludes matching files', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, '.lumastraignore'), '*trailer*\n');
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'Movie-trailer.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('Movie.mkv');
    });

    it('.lumastraignore excludes by extension', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, '.lumastraignore'), '*.avi\n');
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'OldRip.avi'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('Movie.mkv');
    });

    it('.lumastraignore in subdirectory excludes files in that subtree', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'ScifiMovies'), { recursive: true });
        writeFileSync(join(tmpDir, 'ScifiMovies', '.lumastraignore'), '*480p*\n');
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'ScifiMovies', 'Star.Lanterns.1080p.mkv'), '');
        writeFileSync(join(tmpDir, 'ScifiMovies', 'Star.Lanterns.480p.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(2);
        expect(files.some((f) => f.endsWith('Star.Lanterns.1080p.mkv'))).toBe(true);
        expect(files.some((f) => f.endsWith('Star.Lanterns.480p.mkv'))).toBe(false);
    });

    it('.lumastraignore comments (#) and blank lines are ignored', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, '.lumastraignore'), '# this is a comment\n\n*trailer*\n');
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'Movie-trailer.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
    });

    it('no .lumastraignore file is handled gracefully', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
    });

    // ---------------------------------------------------------------------------
    // Jellyfin/Emby .ignore
    // ---------------------------------------------------------------------------

    it('empty .ignore marker skips the whole subtree', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'Private'), { recursive: true });
        mkdirSync(join(tmpDir, 'Private', 'Nested'), { recursive: true });
        writeFileSync(join(tmpDir, 'Keep.mkv'), '');
        writeFileSync(join(tmpDir, 'Private', '.ignore'), ''); // empty marker
        writeFileSync(join(tmpDir, 'Private', 'Secret.mkv'), '');
        writeFileSync(join(tmpDir, 'Private', 'Nested', 'AlsoSecret.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('Keep.mkv');
    });

    it('.ignore containing only comments/blank lines acts as an empty marker', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        mkdirSync(join(tmpDir, 'Private'), { recursive: true });
        writeFileSync(join(tmpDir, 'Private', '.ignore'), '# nothing here\n\n');
        writeFileSync(join(tmpDir, 'Private', 'Secret.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(0);
    });

    it('non-empty .ignore is treated as gitignore-style patterns', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, '.ignore'), '*trailer*\n');
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'Movie-trailer.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('Movie.mkv');
    });

    it('.ignore and .lumastraignore patterns are both applied', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, '.lumastraignore'), '*.avi\n');
        writeFileSync(join(tmpDir, '.ignore'), '*sample-clip*\n');
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'OldRip.avi'), '');
        writeFileSync(join(tmpDir, 'sample-clip.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('Movie.mkv');
    });

    it('empty .ignore at the LIBRARY ROOT is refused (does not wipe the library)', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, '.ignore'), ''); // empty marker at root
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');

        const result = await walkDirectoryWithResult(tmpDir);
        // Root-level empty marker must NOT be honored — it would exclude the
        // whole library and let stale cleanup cascade-delete every item.
        expect(result.files).toHaveLength(1);
        expect(result.files[0]).toContain('Movie.mkv');
        expect(result.hadErrors).toBe(false);
    });

    it('excludes filename-suffix extras from the main walk (video only)', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        const movieDir = join(tmpDir, 'Movie (2010)');
        mkdirSync(movieDir, { recursive: true });
        writeFileSync(join(movieDir, 'Movie (2010).mkv'), ''); // primary — kept
        writeFileSync(join(movieDir, 'Movie-trailer.mkv'), ''); // suffix extra — excluded
        writeFileSync(join(movieDir, 'trailer.mp4'), ''); // single-file extra — excluded
        writeFileSync(join(movieDir, 'Behind-behindthescenes.mkv'), ''); // excluded

        const files = await walkDirectory(tmpDir);
        expect(files.map((f) => f.split('/').pop())).toEqual(['Movie (2010).mkv']);
    });

    it('does not exclude a "Crime Scene" style title from the main walk', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        writeFileSync(join(tmpDir, 'Crime Scene (2019).mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
    });

    it('keeps a lone suffix-named file when its folder has no primary video', async () => {
        // No sibling primary → the file has no parent to attach to, so it must
        // stay a normal item rather than being dropped as an orphan extra.
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-test-'));
        const dir = join(tmpDir, 'Home Movies');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'Birthday-clip.mkv'), '');
        writeFileSync(join(dir, 'trailer.mp4'), '');

        const files = await walkDirectory(tmpDir);
        expect(files.map((f) => f.split('/').pop()).sort()).toEqual([
            'Birthday-clip.mkv',
            'trailer.mp4',
        ]);
    });
});

// ---------------------------------------------------------------------------
// walkExtras and walkArtwork
// ---------------------------------------------------------------------------

describe('walkExtras and walkArtwork', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = join(tmpdir(), `walk-test-${Date.now()}`);
        // Movie folder structure:
        //   testDir/Movie (2001)/Movie.mkv
        //   testDir/Movie (2001)/folder.jpg
        //   testDir/Movie (2001)/backdrop.jpg
        //   testDir/Movie (2001)/backdrop1.jpg
        //   testDir/Movie (2001)/logo.png
        //   testDir/Movie (2001)/behind the scenes/Outtakes.mp4
        //   testDir/Movie (2001)/trailers/Official Trailer.mp4
        //   testDir/Movie (2001)/featurettes/Making of.mp4
        const movieDir = join(testDir, 'Movie (2001)');
        await mkdir(join(movieDir, 'behind the scenes'), { recursive: true });
        await mkdir(join(movieDir, 'trailers'), { recursive: true });
        await mkdir(join(movieDir, 'featurettes'), { recursive: true });
        await writeFile(join(movieDir, 'Movie.mkv'), '');
        await writeFile(join(movieDir, 'folder.jpg'), '');
        await writeFile(join(movieDir, 'backdrop.jpg'), '');
        await writeFile(join(movieDir, 'backdrop1.jpg'), '');
        await writeFile(join(movieDir, 'logo.png'), '');
        await writeFile(join(movieDir, 'behind the scenes', 'Outtakes.mp4'), '');
        await writeFile(join(movieDir, 'trailers', 'Official Trailer.mp4'), '');
        await writeFile(join(movieDir, 'featurettes', 'Making of.mp4'), '');
        // subtitle file — should NOT appear in artwork results
        await writeFile(join(movieDir, 'Movie.en.srt'), '');
    });

    afterEach(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    describe('walkExtras', () => {
        it('returns extras from all known extras subfolders', async () => {
            const results = await walkExtras(testDir);
            const paths = results.map((r) => r.filePath);
            expect(paths).toContain(
                join(testDir, 'Movie (2001)', 'behind the scenes', 'Outtakes.mp4'),
            );
            expect(paths).toContain(
                join(testDir, 'Movie (2001)', 'trailers', 'Official Trailer.mp4'),
            );
            expect(paths).toContain(join(testDir, 'Movie (2001)', 'featurettes', 'Making of.mp4'));
        });

        it('tags each result with the correct extraType', async () => {
            const results = await walkExtras(testDir);
            const byFile = Object.fromEntries(
                results.map((r) => [r.filePath.split('/').pop(), r.extraType]),
            );
            expect(byFile['Outtakes.mp4']).toBe('behind_the_scenes');
            expect(byFile['Official Trailer.mp4']).toBe('trailer');
            expect(byFile['Making of.mp4']).toBe('featurette');
        });

        it('does not include the main movie file', async () => {
            const results = await walkExtras(testDir);
            const paths = results.map((r) => r.filePath);
            expect(paths).not.toContain(join(testDir, 'Movie (2001)', 'Movie.mkv'));
        });

        it('returns empty array when no extras folders exist', async () => {
            // Create a dir with no extras subfolders
            const clean = join(testDir, 'CleanMovie');
            await mkdir(clean);
            await writeFile(join(clean, 'CleanMovie.mkv'), '');
            const results = await walkExtras(clean);
            expect(results).toHaveLength(0);
        });

        it('tags subfolder extras with the movie folder as parentFolder', async () => {
            const results = await walkExtras(testDir);
            const trailer = results.find((r) => r.filePath.endsWith('Official Trailer.mp4'));
            expect(trailer?.parentFolder).toBe(join(testDir, 'Movie (2001)'));
        });

        it('collects filename-suffix extras sitting beside the movie', async () => {
            const movieDir = join(testDir, 'Suffix Movie (2010)');
            await mkdir(movieDir, { recursive: true });
            await writeFile(join(movieDir, 'Suffix Movie (2010).mkv'), '');
            await writeFile(join(movieDir, 'Suffix Movie-trailer.mkv'), '');
            await writeFile(join(movieDir, 'Making of-behindthescenes.mkv'), '');
            await writeFile(join(movieDir, 'trailer.mp4'), '');

            const results = await walkExtras(testDir);
            const byFile = Object.fromEntries(results.map((r) => [r.filePath.split('/').pop(), r]));
            expect(byFile['Suffix Movie-trailer.mkv']?.extraType).toBe('trailer');
            expect(byFile['Suffix Movie-trailer.mkv']?.parentFolder).toBe(movieDir);
            expect(byFile['Making of-behindthescenes.mkv']?.extraType).toBe('behind_the_scenes');
            expect(byFile['trailer.mp4']?.extraType).toBe('trailer');
            // The primary file is NOT collected as an extra.
            expect(byFile['Suffix Movie (2010).mkv']).toBeUndefined();
        });

        it('does NOT collect a lone suffix file when the folder has no primary', async () => {
            const dir = join(testDir, 'Lone');
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'Something-trailer.mkv'), '');
            await writeFile(join(dir, 'trailer.mp4'), '');

            const results = await walkExtras(testDir);
            const inLone = results.filter((r) => r.filePath.includes('/Lone/'));
            expect(inLone).toHaveLength(0);
        });

        it('does NOT collect a suffix-extra that .lumastraignore excludes', async () => {
            const dir = join(testDir, 'Ignored Movie (2011)');
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'Ignored Movie (2011).mkv'), ''); // primary
            await writeFile(join(dir, 'Ignored Movie-trailer.mkv'), '');
            await writeFile(join(dir, '.lumastraignore'), '*trailer*\n');

            const results = await walkExtras(testDir);
            const inDir = results.filter((r) => r.filePath.includes('/Ignored Movie (2011)/'));
            expect(inDir).toHaveLength(0);
        });

        it('empty .ignore marker skips a subtree in the extras pass too', async () => {
            const dir = join(testDir, 'Private Movie (2012)');
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'Private Movie (2012).mkv'), '');
            await writeFile(join(dir, 'Private Movie-trailer.mkv'), '');
            await writeFile(join(dir, '.ignore'), ''); // empty marker

            const results = await walkExtras(testDir);
            const inDir = results.filter((r) => r.filePath.includes('/Private Movie (2012)/'));
            expect(inDir).toHaveLength(0);
        });

        it('matches a suffix-extra to the right primary in a multi-primary folder', async () => {
            const dir = join(testDir, 'Flat');
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'A.mkv'), '');
            await writeFile(join(dir, 'B.mkv'), '');
            await writeFile(join(dir, 'B-trailer.mkv'), ''); // belongs to B, not A

            const results = await walkExtras(testDir);
            const trailer = results.find((r) => r.filePath.endsWith('B-trailer.mkv'));
            expect(trailer?.extraType).toBe('trailer');
            expect(trailer?.primaryFilePath).toBe(join(dir, 'B.mkv'));
        });

        it('leaves primaryFilePath undefined for a standalone trailer', async () => {
            const dir = join(testDir, 'Solo (2018)');
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'Solo (2018).mkv'), '');
            await writeFile(join(dir, 'trailer.mp4'), '');

            const results = await walkExtras(testDir);
            const trailer = results.find((r) => r.filePath.endsWith('/trailer.mp4'));
            expect(trailer?.extraType).toBe('trailer');
            expect(trailer?.primaryFilePath).toBeUndefined();
        });

        it('collects a SYMLINKED suffix-extra beside a real primary (no loss)', async () => {
            // The main walk resolves symlinked media files; walkExtras must too,
            // or a symlinked trailer would fall into neither pass and vanish.
            const dir = join(testDir, 'Symlink Movie (2013)');
            await mkdir(dir, { recursive: true });
            const primary = join(dir, 'Symlink Movie (2013).mkv');
            await writeFile(primary, '');
            symlinkSync(primary, join(dir, 'Symlink Movie-trailer.mkv'));

            const results = await walkExtras(testDir);
            const trailer = results.find((r) => r.filePath.endsWith('Symlink Movie-trailer.mkv'));
            expect(trailer?.extraType).toBe('trailer');
            expect(trailer?.parentFolder).toBe(dir);
        });
    });

    describe('walkArtwork', () => {
        it('returns image files with resolved artworkType', async () => {
            const results = await walkArtwork(testDir);
            const types = Object.fromEntries(
                results.map((r) => [r.filePath.split('/').pop(), r.artworkType]),
            );
            expect(types['folder.jpg']).toBe('poster');
            expect(types['backdrop.jpg']).toBe('backdrop');
            expect(types['logo.png']).toBe('logo');
            // `backdrop1.jpg` sits in the same directory and resolves to the
            // same (item, backdrop) row as `backdrop.jpg`. Offering both made
            // the two fight over one row on every scan cycle forever, so only
            // the better-ranked stem is returned now.
            expect(types['backdrop1.jpg']).toBeUndefined();
        });

        /**
         * One candidate per (directory, type, season) — the whole point.
         *
         * media_artwork's conflict key is (item, type, source, language), so
         * every candidate a directory offers for one type competes for a SINGLE
         * row. Two candidates meant two upserts per cycle, each re-pointing the
         * row away from the other, forever: 3,426 directories on production,
         * 1,600 of them holding backdrop + backdrop1 + landscape together.
         */
        describe('one candidate per target', () => {
            async function stemsIn(dir: string, files: string[]): Promise<string[]> {
                const d = join(testDir, dir);
                await mkdir(d, { recursive: true });
                for (const f of files) await writeFile(join(d, f), '');
                const results = await walkArtwork(d);
                return results.map((r) => r.filePath.split('/').pop()!).sort();
            }

            it('keeps only the canonical stem from the three-way backdrop set', async () => {
                // The single most common collision in the library.
                expect(
                    await stemsIn('Three Way (2001)', [
                        'landscape.jpg',
                        'backdrop1.jpg',
                        'backdrop.jpg',
                    ]),
                ).toEqual(['backdrop.jpg']);
            });

            it('prefers poster.jpg over folder.jpg', async () => {
                // `poster` is what this application materializes, so preferring
                // it keeps our own managed file — and its provenance tag — the
                // one that stays registered.
                expect(await stemsIn('Both Posters (2002)', ['folder.jpg', 'poster.jpg'])).toEqual([
                    'poster.jpg',
                ]);
            });

            it('prefers a foreign primary over a numbered variant', async () => {
                // fanart1/backdrop2 are ADDITIONAL art by convention, never the
                // primary, so they lose even to a differently-spelled primary.
                expect(
                    await stemsIn('Numbered (2003)', ['backdrop2.jpg', 'landscape.jpg']),
                ).toEqual(['landscape.jpg']);
            });

            it('prefers an exact alias over the poster prefix catch-all', async () => {
                // `poster-en` only matches the trailing startsWith('poster')
                // catch-all, so it must lose to any exact alias — even one that
                // sorts LATER by filename. Chosen precisely because the
                // lexicographic tiebreak would pick the other way, which is the
                // only arrangement that actually pins the table's ordering.
                expect(
                    await stemsIn('Prefix vs Alias (2009)', ['poster-en.jpg', 'show.jpg']),
                ).toEqual(['show.jpg']);
            });

            it('keeps one of each DIFFERENT type', async () => {
                // Deduping is per type — a poster and a backdrop are different
                // rows and must both survive.
                expect(
                    await stemsIn('Mixed (2004)', ['poster.jpg', 'backdrop.jpg', 'logo.png']),
                ).toEqual(['backdrop.jpg', 'logo.png', 'poster.jpg']);
            });

            it('breaks an extension tie deterministically', async () => {
                // Same stem, two extensions: which one wins is arbitrary, that
                // it is always the SAME one is not — a flapping choice rewrites
                // the row every cycle just as a colliding pair does.
                const first = await stemsIn('Ext Tie (2005)', ['folder.webp', 'folder.jpg']);
                const second = await walkArtwork(join(testDir, 'Ext Tie (2005)'));
                expect(first).toHaveLength(1);
                expect(second.map((r) => r.filePath.split('/').pop())).toEqual(first);
            });

            it('does NOT dedupe across directories — a season is its own target', async () => {
                // `Show/backdrop.jpg` resolves to the series, `Show/Season 01/
                // backdrop.jpg` to the season. Folding subdirectory results into
                // the parent's dedupe would silently drop the season's artwork.
                const show = join(testDir, 'Nested Show (2006)');
                await mkdir(join(show, 'Season 01'), { recursive: true });
                await writeFile(join(show, 'backdrop.jpg'), '');
                await writeFile(join(show, 'Season 01', 'backdrop.jpg'), '');

                const results = await walkArtwork(show);
                expect(results).toHaveLength(2);
                expect(results.filter((r) => r.artworkType === 'backdrop')).toHaveLength(2);
            });

            it('keeps season-qualified files apart by season number', async () => {
                // season01-poster and season02-poster name DIFFERENT items.
                const dir = join(testDir, 'Flat Seasons (2007)');
                await mkdir(dir, { recursive: true });
                await writeFile(join(dir, 'season01-poster.jpg'), '');
                await writeFile(join(dir, 'season02-poster.jpg'), '');
                await writeFile(join(dir, 'poster.jpg'), '');

                const results = await walkArtwork(dir);
                expect(results.map((r) => r.seasonNumber).sort()).toEqual([1, 2, undefined]);
            });

            it('ranks a season file by its suffix, not by the type it resolves to', async () => {
                // `season01-folder` classifies as a poster too, so it competes
                // with `season01-poster` for one row. Ranking on the resolved
                // TYPE would score them equal and let the filename tiebreak pick
                // folder; ranking on the suffix picks poster, as for plain files.
                expect(
                    await stemsIn('Season Alias (2008)', [
                        'season01-folder.jpg',
                        'season01-poster.jpg',
                    ]),
                ).toEqual(['season01-poster.jpg']);
            });
        });

        it('does not include subtitle or video files', async () => {
            const results = await walkArtwork(testDir);
            const paths = results.map((r) => r.filePath);
            expect(paths.some((p) => p.endsWith('.srt'))).toBe(false);
            expect(paths.some((p) => p.endsWith('.mkv'))).toBe(false);
        });

        it('does not include images from extras subfolders', async () => {
            // extras subfolder images should not become media_artwork for the parent
            const extrasDir = join(testDir, 'Movie (2001)', 'behind the scenes');
            await writeFile(join(extrasDir, 'thumb.jpg'), '');
            const results = await walkArtwork(testDir);
            const paths = results.map((r) => r.filePath);
            expect(paths.some((p) => p.includes('behind the scenes'))).toBe(false);
        });

        it('returns empty array when no artwork files exist', async () => {
            const emptyDir = join(testDir, 'Empty');
            await mkdir(emptyDir);
            const results = await walkArtwork(emptyDir);
            expect(results).toHaveLength(0);
        });
    });
});

// ---------------------------------------------------------------------------
// walkSubtitles
// ---------------------------------------------------------------------------

describe('walkSubtitles', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'walk-subtitle-test-'));
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('exports SUBTITLE_EXTENSIONS', () => {
        expect(SUBTITLE_EXTENSIONS.has('.srt')).toBe(true);
        expect(SUBTITLE_EXTENSIONS.has('.ass')).toBe(true);
        expect(SUBTITLE_EXTENSIONS.has('.ssa')).toBe(true);
        expect(SUBTITLE_EXTENSIONS.has('.vtt')).toBe(true);
        expect(SUBTITLE_EXTENSIONS.has('.sub')).toBe(true);
        expect(SUBTITLE_EXTENSIONS.has('.sup')).toBe(true);
        expect(SUBTITLE_EXTENSIONS.has('.mkv')).toBe(false);
    });

    it('returns empty array for empty directory', async () => {
        const result = await walkSubtitles(tmpDir);
        expect(result).toEqual([]);
    });

    it('finds subtitle files in root directory', async () => {
        await writeFile(join(tmpDir, 'Movie.en.srt'), '');
        await writeFile(join(tmpDir, 'Movie.de.ass'), '');
        await writeFile(join(tmpDir, 'Movie.mkv'), ''); // not a subtitle

        const result = await walkSubtitles(tmpDir);
        expect(result).toHaveLength(2);
        expect(result.some((f) => f.endsWith('Movie.en.srt'))).toBe(true);
        expect(result.some((f) => f.endsWith('Movie.de.ass'))).toBe(true);
    });

    it('recurses into subdirectories', async () => {
        await mkdir(join(tmpDir, 'Season 01'));
        await writeFile(join(tmpDir, 'Season 01', 'Ep01.en.srt'), '');

        const result = await walkSubtitles(tmpDir);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('Ep01.en.srt');
    });

    it('returns empty array for non-existent directory', async () => {
        const result = await walkSubtitles('/nonexistent/path/xyz');
        expect(result).toEqual([]);
    });

    it('does not recurse into extras subfolders', async () => {
        await mkdir(join(tmpDir, 'trailers'));
        await writeFile(join(tmpDir, 'Movie.en.srt'), '');
        await writeFile(join(tmpDir, 'trailers', 'Trailer.en.srt'), '');

        const result = await walkSubtitles(tmpDir);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('Movie.en.srt');
    });
});

// ---------------------------------------------------------------------------
// walkDirectoryWithResult — new result-shape API for scanners that need
// error visibility before deciding whether to run stale cleanup (D1 fix).
// ---------------------------------------------------------------------------

describe('walkDirectoryWithResult', () => {
    let tmpDir: string;

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns hadErrors=false on a clean walk', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');

        const result = await walkDirectoryWithResult(tmpDir);
        expect(result.hadErrors).toBe(false);
        expect(result.errorPaths).toEqual([]);
        expect(result.files).toHaveLength(1);
        expect(result.lyricsSidecars).toEqual([]);
    });

    it('collects .lrc/.txt lyrics sidecars separately from media files', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        writeFileSync(join(tmpDir, 'song.flac'), '');
        writeFileSync(join(tmpDir, 'song.lrc'), '[00:01.00]hi');
        writeFileSync(join(tmpDir, 'notes.txt'), 'plain text');

        const result = await walkDirectoryWithResult(tmpDir);
        // The audio file stays in `files`; sidecars are not library items.
        expect(result.files.map((f) => f.split('/').pop())).toEqual(['song.flac']);
        const sidecars = result.lyricsSidecars.map((f) => f.split('/').pop()).sort();
        expect(sidecars).toEqual(['notes.txt', 'song.lrc']);
    });

    it('preserves the on-disk byte form of filenames (NFD not normalized to NFC)', async () => {
        // Write a file whose name uses NFD (decomposed) Unicode — "é" as the
        // 2-codepoint sequence `e U+0301`. Linux stores the raw bytes; if the
        // walker normalizes to NFC, fs.open against the returned path yields
        // ENOENT and the scanner falls back to garbage filename-derived titles.
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        const nfdName = 'desénchantée.flac';
        writeFileSync(join(tmpDir, nfdName), '');

        const result = await walkDirectoryWithResult(tmpDir);
        expect(result.files).toHaveLength(1);
        const basename = result.files[0].split('/').pop()!;
        // Bytes from the walker must match the bytes we wrote — neither
        // normalize('NFC') nor normalize('NFD') applied to the on-disk form.
        expect(basename).toBe(nfdName);
        // Defensive: ensure the file is openable through the returned path.
        // (Catches accidental re-introduction of normalization.)
        const { readFileSync } = await import('node:fs');
        expect(() => readFileSync(result.files[0])).not.toThrow();
    });

    it('skips vendor-prefixed folders (@eaDir, #recycle, .Trash-1000)', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        mkdirSync(join(tmpDir, '@eaDir'), { recursive: true });
        mkdirSync(join(tmpDir, '#recycle'), { recursive: true });
        mkdirSync(join(tmpDir, '.Trash-1000'), { recursive: true });
        writeFileSync(join(tmpDir, '@eaDir', 'thumb.mkv'), '');
        writeFileSync(join(tmpDir, '#recycle', 'deleted.mkv'), '');
        writeFileSync(join(tmpDir, '.Trash-1000', 'trashed.mkv'), '');
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');

        const result = await walkDirectoryWithResult(tmpDir);
        expect(result.hadErrors).toBe(false);
        expect(result.files).toHaveLength(1);
        expect(result.files[0]).toContain('Movie.mkv');
    });

    it('never descends into Jellyfin trickplay folders (<video>.trickplay, case-insensitive)', async () => {
        // A Jellyfin-shared library stores trickplay tiles next to each video as
        // `<video>.trickplay/<width> - <cols>x<rows>/N.jpg`. On prod these were
        // ~96% of every TV library's directories, each walked serially over NFS.
        // The planted .mkv proves the subtree is pruned, not merely filtered.
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        const season = join(tmpDir, 'Show', 'Season 01');
        mkdirSync(join(season, 'Show S01E01.trickplay', '320 - 10x10'), { recursive: true });
        mkdirSync(join(season, 'Show S01E02.TRICKPLAY'), { recursive: true });
        writeFileSync(join(season, 'Show S01E01.trickplay', '320 - 10x10', '0.jpg'), '');
        writeFileSync(join(season, 'Show S01E01.trickplay', '320 - 10x10', 'planted.mkv'), '');
        writeFileSync(join(season, 'Show S01E02.TRICKPLAY', 'planted.mkv'), '');
        writeFileSync(join(season, 'Show S01E01.mkv'), '');

        const result = await walkDirectoryWithResult(tmpDir);
        expect(result.hadErrors).toBe(false);
        expect(result.files.map((f) => f.split('/').pop())).toEqual(['Show S01E01.mkv']);
    });

    it('the artwork and subtitle walks prune trickplay/vendor folders like the main walk', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        const season = join(tmpDir, 'Show', 'Season 01');
        const tiles = join(season, 'Show S01E01.trickplay', '320 - 10x10');
        mkdirSync(tiles, { recursive: true });
        mkdirSync(join(season, '@eaDir'), { recursive: true });
        writeFileSync(join(season, 'Show S01E01.mkv'), '');
        writeFileSync(join(season, 'Show S01E01.en.srt'), '');
        writeFileSync(join(season, 'poster.jpg'), '');
        writeFileSync(join(tiles, 'poster.jpg'), '');
        writeFileSync(join(tiles, 'planted.en.srt'), '');
        writeFileSync(join(season, '@eaDir', 'poster.jpg'), '');

        const artwork = (await walkArtwork(tmpDir)).map((a) => a.filePath);
        const subtitles = await walkSubtitles(tmpDir);
        expect(artwork).toEqual([join(season, 'poster.jpg')]);
        expect(subtitles).toEqual([join(season, 'Show S01E01.en.srt')]);
    });

    it('skips hidden folders but NOT ellipsis-led media folders', async () => {
        // Jellyfin ignores `**/.*` (its older trickplay layout is a hidden
        // `.trickplay` per season). But `...Jahr 2022... (1973)` is a real film
        // folder on prod — pruning it would let stale cleanup delete the movie.
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        mkdirSync(join(tmpDir, 'Show', 'Season 02', '.trickplay'), { recursive: true });
        mkdirSync(join(tmpDir, '.snapshot'), { recursive: true });
        mkdirSync(join(tmpDir, '...Jahr 2022... (1973)'), { recursive: true });
        writeFileSync(join(tmpDir, 'Show', 'Season 02', '.trickplay', 'planted.mkv'), '');
        writeFileSync(join(tmpDir, '.snapshot', 'planted.mkv'), '');
        writeFileSync(join(tmpDir, '...Jahr 2022... (1973)', 'Film (1973).mkv'), '');

        const result = await walkDirectoryWithResult(tmpDir);
        expect(result.hadErrors).toBe(false);
        expect(result.files.map((f) => f.split('/').pop())).toEqual(['Film (1973).mkv']);
    });

    it('handles symlinks to files inside the library root', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        writeFileSync(join(tmpDir, 'Original.mkv'), '');
        symlinkSync(join(tmpDir, 'Original.mkv'), join(tmpDir, 'Alias.mkv'));

        const result = await walkDirectoryWithResult(tmpDir);
        // Both the original and the symlink name appear — the walker records
        // them under their discovered paths. Downstream dedup happens at the
        // DB layer via file_path uniqueness (the symlink's path is distinct).
        expect(result.hadErrors).toBe(false);
        const names = result.files.map((f) => f.split('/').pop()).sort();
        expect(names).toEqual(['Alias.mkv', 'Original.mkv']);
    });

    it('rejects symlink directories that escape the library root', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        const escape = mkdtempSync(join(tmpdir(), 'walk-escape-'));
        try {
            writeFileSync(join(escape, 'Escaped.mkv'), '');
            writeFileSync(join(tmpDir, 'Movie.mkv'), '');
            // Create a symlink inside tmpDir that points to the escape dir
            symlinkSync(escape, join(tmpDir, 'badlink'));

            const result = await walkDirectoryWithResult(tmpDir);
            const names = result.files.map((f) => f.split('/').pop());
            expect(names).toContain('Movie.mkv');
            expect(names).not.toContain('Escaped.mkv');
        } finally {
            rmSync(escape, { recursive: true, force: true });
        }
    });

    it('breaks symlink loops without recursing forever', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-result-'));
        mkdirSync(join(tmpDir, 'child'), { recursive: true });
        writeFileSync(join(tmpDir, 'child', 'Movie.mkv'), '');
        // Create a loop: tmpDir/child/loop -> tmpDir
        symlinkSync(tmpDir, join(tmpDir, 'child', 'loop'));

        const result = await walkDirectoryWithResult(tmpDir);
        expect(result.hadErrors).toBe(false);
        // Movie.mkv should appear once (deduped via visited set)
        const matrixMatches = result.files.filter((f) => f.endsWith('Movie.mkv'));
        expect(matrixMatches.length).toBeGreaterThanOrEqual(1);
        // The loop dir's symlinked descendants should not compound duplicates
        // beyond the single canonical appearance.
        expect(matrixMatches.length).toBeLessThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// walkArtwork — flat season convention (Show/season01-poster.jpg)
// ---------------------------------------------------------------------------

describe('walkArtwork — flat season artwork in the series root', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'walk-season-art-'));
        const showDir = join(tmpDir, 'Show (2019)');
        await mkdir(join(showDir, 'Season 01'), { recursive: true });
        await writeFile(join(showDir, 'Season 01', 'S01E01.mkv'), '');
        // Series-level artwork, primary classifier.
        await writeFile(join(showDir, 'poster.jpg'), '');
        // Flat season artwork, new classifier.
        await writeFile(join(showDir, 'season01-poster.jpg'), '');
        await writeFile(join(showDir, 'season-specials-poster.jpg'), '');
        // Not the convention — must stay uncollected.
        await writeFile(join(showDir, 'season-all-poster.jpg'), '');
        await writeFile(join(showDir, 'season01-banner.jpg'), '');
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('collects season-convention files and tags them with the season number', async () => {
        const results = await walkArtwork(tmpDir);
        const byName = Object.fromEntries(results.map((r) => [r.filePath.split('/').pop(), r]));

        expect(byName['season01-poster.jpg']).toMatchObject({
            artworkType: 'poster',
            seasonNumber: 1,
        });
        expect(byName['season-specials-poster.jpg']).toMatchObject({
            artworkType: 'poster',
            seasonNumber: 0,
        });
    });

    it('leaves ordinary artwork without a seasonNumber', async () => {
        const results = await walkArtwork(tmpDir);
        const seriesPoster = results.find((r) => r.filePath.endsWith('/poster.jpg'));
        expect(seriesPoster?.artworkType).toBe('poster');
        expect(seriesPoster?.seasonNumber).toBeUndefined();
    });

    it('does not collect stems the season classifier rejects', async () => {
        const results = await walkArtwork(tmpDir);
        const names = results.map((r) => r.filePath.split('/').pop());
        expect(names).not.toContain('season-all-poster.jpg');
        expect(names).not.toContain('season01-banner.jpg');
    });
});

// ---------------------------------------------------------------------------
// albumPosterCandidates — the music path must ignore season-scoped artwork
// ---------------------------------------------------------------------------

describe('albumPosterCandidates', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'album-poster-'));
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('drops a season-scoped poster from an album folder sweep', async () => {
        const albumDir = join(tmpDir, 'Artist', 'Album');
        await mkdir(albumDir, { recursive: true });
        await writeFile(join(albumDir, 'cover.jpg'), '');
        await writeFile(join(albumDir, 'season01-poster.jpg'), '');

        const entries = await walkArtwork(albumDir);
        // walkArtwork collects BOTH — the season file is a real ArtworkEntry now.
        expect(entries).toHaveLength(2);

        const candidates = albumPosterCandidates(entries);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].filePath.endsWith('cover.jpg')).toBe(true);
    });

    it('keeps ordinary posters and drops non-poster types', async () => {
        const albumDir = join(tmpDir, 'Artist', 'Album 2');
        await mkdir(albumDir, { recursive: true });
        await writeFile(join(albumDir, 'folder.jpg'), '');
        await writeFile(join(albumDir, 'fanart.jpg'), '');

        const candidates = albumPosterCandidates(await walkArtwork(albumDir));
        expect(candidates).toHaveLength(1);
        expect(candidates[0].filePath.endsWith('folder.jpg')).toBe(true);
    });

    it('returns an empty array for an empty sweep', () => {
        expect(albumPosterCandidates([])).toEqual([]);
    });
});

describe('isAppleDoubleSidecar', () => {
    it('matches a macOS resource-fork sidecar next to a real audio file', () => {
        expect(
            isAppleDoubleSidecar(
                '._Tune Up! - Ravers Fantasy (The Album) - 43 - Freakshow (Tune Up! Remix).flac',
            ),
        ).toBe(true);
    });

    it('matches a bare "._" prefixed name regardless of extension', () => {
        expect(isAppleDoubleSidecar('._cover.jpg')).toBe(true);
        expect(isAppleDoubleSidecar('._Song.mp3')).toBe(true);
    });

    it('does NOT match .DS_Store (handled separately, but should not collide)', () => {
        expect(isAppleDoubleSidecar('.DS_Store')).toBe(false);
    });

    it('does NOT match @eaDir (Synology thumbnail directory — a folder, not a sidecar)', () => {
        expect(isAppleDoubleSidecar('@eaDir')).toBe(false);
    });

    it('does NOT match a real file that starts with a dot but not "._"', () => {
        expect(isAppleDoubleSidecar('.hidden-but-real.flac')).toBe(false);
    });

    it('does NOT match a real file that merely contains an underscore', () => {
        expect(isAppleDoubleSidecar('01_Freakshow.flac')).toBe(false);
        expect(isAppleDoubleSidecar('Tune_Up_Remix.flac')).toBe(false);
    });
});

describe('walkDirectory — AppleDouble sidecars', () => {
    let tmpDir: string;

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('skips a "._" sidecar sharing the real file\'s audio extension', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-appledouble-'));
        const albumDir = join(tmpDir, 'Tune Up! - Ravers Fantasy');
        mkdirSync(albumDir, { recursive: true });
        writeFileSync(join(albumDir, '43 - Freakshow (Tune Up! Remix).flac'), '');
        writeFileSync(join(albumDir, '._43 - Freakshow (Tune Up! Remix).flac'), '');

        const files = await walkDirectory(tmpDir);
        expect(files).toHaveLength(1);
        expect(files[0].endsWith('43 - Freakshow (Tune Up! Remix).flac')).toBe(true);
        expect(files.some((f) => f.includes('._'))).toBe(false);
    });

    it('dot-led and #-led TITLES and ALBUMS are walked; only known junk is pruned', async () => {
        // A pruned folder's files vanish from the walk, and file-reconcile then
        // deletes their items — so only KNOWN junk may be pruned, at any depth.
        // Real names: `anime/.harbor Sign` (a title at the root), Slipknot's
        // `.5 The Gray Chapter` (an album one level down), `#Alive (2020)`.
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-appledouble-'));
        const title = join(tmpDir, '.harbor Sign (2002)');
        const album = join(tmpDir, 'Slipknot', '.5 The Gray Chapter');
        mkdirSync(join(title, 'Season 01', '.trickplay'), { recursive: true });
        mkdirSync(join(title, '.actors'), { recursive: true });
        mkdirSync(album, { recursive: true });
        mkdirSync(join(tmpDir, '#Alive (2020)'), { recursive: true });
        writeFileSync(join(title, 'Season 01', 'S01E01.mkv'), '');
        writeFileSync(join(title, 'Season 01', 'S01E01.en.srt'), '');
        writeFileSync(join(title, 'Season 01', '.trickplay', 'planted.mkv'), '');
        writeFileSync(join(title, 'Season 01', '.trickplay', 'planted.en.srt'), '');
        writeFileSync(join(title, '.actors', 'poster.jpg'), '');
        writeFileSync(join(title, 'poster.jpg'), '');
        writeFileSync(join(album, '01 - XIX.flac'), '');
        writeFileSync(join(tmpDir, '#Alive (2020)', '#Alive (2020).mkv'), '');

        const files = (await walkDirectory(tmpDir)).map((f) => f.slice(tmpDir.length)).sort();
        expect(files).toEqual([
            '/#Alive (2020)/#Alive (2020).mkv',
            '/.harbor Sign (2002)/Season 01/S01E01.mkv',
            '/Slipknot/.5 The Gray Chapter/01 - XIX.flac',
        ]);
        expect((await walkSubtitles(tmpDir)).map((f) => f.slice(tmpDir.length))).toEqual([
            '/.harbor Sign (2002)/Season 01/S01E01.en.srt',
        ]);
        expect((await walkArtwork(tmpDir)).map((a) => a.filePath.slice(tmpDir.length))).toEqual([
            '/.harbor Sign (2002)/poster.jpg',
        ]);
    });

    it('the extras walk prunes trickplay/vendor folders too', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-appledouble-'));
        const movie = join(tmpDir, 'Film (2020)');
        const tiles = join(movie, 'Film (2020).trickplay');
        mkdirSync(tiles, { recursive: true });
        writeFileSync(join(movie, 'Film (2020).mkv'), '');
        writeFileSync(join(movie, 'Film (2020)-trailer.mkv'), '');
        writeFileSync(join(tiles, 'Planted.mkv'), '');
        writeFileSync(join(tiles, 'Planted-trailer.mkv'), '');

        const extras = (await walkExtras(tmpDir)).map((e) => e.filePath.slice(tmpDir.length));
        expect(extras).toEqual(['/Film (2020)/Film (2020)-trailer.mkv']);
    });

    it('a symlinked FILE is never pruned by its name (debrid/rclone libraries)', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-appledouble-'));
        mkdirSync(join(tmpDir, 'store'), { recursive: true });
        mkdirSync(join(tmpDir, 'Show', 'Season 01'), { recursive: true });
        writeFileSync(join(tmpDir, 'store', 'real.mkv'), '');
        symlinkSync(
            join(tmpDir, 'store', 'real.mkv'),
            join(tmpDir, 'Show', 'Season 01', '@Home S01E01.mkv'),
        );

        const files = (await walkDirectory(tmpDir)).map((f) => f.slice(tmpDir.length)).sort();
        expect(files).toContain('/Show/Season 01/@Home S01E01.mkv');
    });

    it('known-junk hidden folders are pruned even directly under the root', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-appledouble-'));
        for (const junk of ['.snapshot', '.Trash-1000', '.actors', '.zfs']) {
            mkdirSync(join(tmpDir, junk), { recursive: true });
            writeFileSync(join(tmpDir, junk, 'planted.mkv'), '');
        }
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');

        const files = await walkDirectory(tmpDir);
        expect(files.map((f) => f.slice(tmpDir.length))).toEqual(['/Movie.mkv']);
    });

    // Our own alongside bitmap subtitles are `.sup`/`.sub` files — both in
    // SUBTITLE_EXTENSIONS. For a film stored directly in the library root the
    // folder sits at depth 1, where hidden folders are otherwise kept (titles),
    // so without the junk-list entry the scanner would index them as external
    // subtitles of the film they were extracted from.
    it('never indexes our own .subtitle-cache folder, even directly under the root', async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'walk-subcache-'));
        const cache = join(tmpDir, '.subtitle-cache', '0123456789abcdef');
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, '3.sup'), '');
        writeFileSync(join(cache, '4.sub'), '');
        writeFileSync(join(tmpDir, 'Movie.mkv'), '');
        writeFileSync(join(tmpDir, 'Movie.en.srt'), '');

        expect(await walkSubtitles(tmpDir)).toEqual([join(tmpDir, 'Movie.en.srt')]);
        expect((await walkDirectory(tmpDir)).map((f) => f.slice(tmpDir.length))).toEqual([
            '/Movie.mkv',
        ]);
    });
});

describe('ignore-file glob matcher', () => {
    it('keeps the documented semantics', () => {
        expect(globMatches('*.avi', 'Movie.AVI')).toBe(true);
        expect(globMatches('*trailer*', 'My-Trailer-1.mkv')).toBe(true);
        expect(globMatches('Extras/*', 'Extras/a.mkv')).toBe(true);
        expect(globMatches('Extras/*', 'Extras/sub/a.mkv')).toBe(false); // * stops at /
        expect(globMatches('a.b', 'aXb')).toBe(false); // regex specials are literal
        expect(globMatches('[x](1)+', '[x](1)+')).toBe(true);
        expect(globMatches('', '')).toBe(true);
        expect(globMatches('*', '')).toBe(true);
    });

    // Anyone who can write into a library controls both pattern and file names.
    it.each([
        ['*a*a*a*a*b', 'a'.repeat(255)],
        ['*a*a*a*a*a*a*a*a*b', 'a'.repeat(255)],
        ['*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(255)],
        ['x/*a*a*a*a*a*a*b', `x/${'a'.repeat(4000)}`],
        ['*********a*********a*********b', 'a'.repeat(255)],
    ])('adversarial pattern %s finishes within a time budget', (pattern, text) => {
        const t0 = performance.now();
        expect(globMatches(pattern, text)).toBe(false);
        expect(performance.now() - t0).toBeLessThan(200);
    });

    it('a ReDoS ignore file does not stall the scan', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'walk-redos-'));
        try {
            writeFileSync(join(dir, '.lumastraignore'), '*a*a*a*a*a*a*b\n');
            writeFileSync(join(dir, `${'a'.repeat(240)}.mkv`), '');
            writeFileSync(join(dir, 'Movie.mkv'), '');
            const t0 = performance.now();
            const files = await walkDirectory(dir);
            expect(performance.now() - t0).toBeLessThan(5000);
            expect(files.length).toBe(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('an oversized ignore file is not read whole; the directory is skipped (fail closed)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'walk-bigignore-'));
        try {
            // 200 KB of patterns, over the cap.
            writeFileSync(join(dir, '.lumastraignore'), '*.mkv\n'.repeat(30_000));
            writeFileSync(join(dir, 'Movie.mkv'), '');
            expect(await walkDirectory(dir)).toHaveLength(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('drops over-long patterns', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'walk-longpat-'));
        try {
            writeFileSync(join(dir, '.lumastraignore'), `${'*'.repeat(600)}\n`);
            writeFileSync(join(dir, 'Movie.mkv'), '');
            expect(await walkDirectory(dir)).toHaveLength(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('file symlink containment', () => {
    let lib: string;
    let outside: string;

    beforeEach(() => {
        lib = mkdtempSync(join(tmpdir(), 'walk-sym-lib-'));
        outside = mkdtempSync(join(tmpdir(), 'walk-sym-out-'));
        writeFileSync(join(outside, 'master.key'), 'TESTKEY-123');
    });
    afterEach(() => {
        rmSync(lib, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    it('ingests a media symlink into an outside mount (debrid/rclone)', async () => {
        mkdirSync(join(lib, 'Artist', 'Album'), { recursive: true });
        writeFileSync(join(outside, 'real.mp3'), '');
        symlinkSync(join(outside, 'real.mp3'), join(lib, 'Artist', 'Album', '01 Song.mp3'));
        const files = (await walkDirectory(lib)).map((f) => f.slice(lib.length));
        expect(files).toEqual(['/Artist/Album/01 Song.mp3']);
    });

    it('refuses a media symlink into the config dir (master.key as 01.mp3)', async () => {
        // `outside` stands in for the config dir.
        setSensitivePrefixesForTests([outside]);
        try {
            mkdirSync(join(lib, 'Artist', 'Album'), { recursive: true });
            symlinkSync(join(outside, 'master.key'), join(lib, 'Artist', 'Album', '01 Song.mp3'));
            writeFileSync(join(lib, 'Artist', 'Album', '02 Real.mp3'), '');
            const files = (await walkDirectory(lib)).map((f) => f.slice(lib.length));
            expect(files).toEqual(['/Artist/Album/02 Real.mp3']);
        } finally {
            setSensitivePrefixesForTests([]);
        }
    });

    it('does not collect a lyrics sidecar symlinked outside the library', async () => {
        symlinkSync(join(outside, 'master.key'), join(lib, 'Song.txt'));
        writeFileSync(join(lib, 'Song.mp3'), '');
        const result = await walkDirectoryWithResult(lib);
        expect(result.lyricsSidecars).toEqual([]);
        expect(result.files.map((f) => f.slice(lib.length))).toEqual(['/Song.mp3']);
    });

    it('does not collect an extras symlink that escapes', async () => {
        mkdirSync(join(lib, 'Film (2020)'), { recursive: true });
        writeFileSync(join(lib, 'Film (2020)', 'Film (2020).mkv'), '');
        // `outside` stands in for the config dir.
        setSensitivePrefixesForTests([outside]);
        try {
            symlinkSync(
                join(outside, 'master.key'),
                join(lib, 'Film (2020)', 'Film (2020)-trailer.mkv'),
            );
            expect(await walkExtras(lib)).toEqual([]);
        } finally {
            setSensitivePrefixesForTests([]);
        }
    });

    it('keeps a symlink to another file inside the library', async () => {
        mkdirSync(join(lib, 'store'), { recursive: true });
        writeFileSync(join(lib, 'store', 'real.mkv'), '');
        mkdirSync(join(lib, 'Show'), { recursive: true });
        symlinkSync(join(lib, 'store', 'real.mkv'), join(lib, 'Show', 'S01E01.mkv'));
        const files = (await walkDirectory(lib)).map((f) => f.slice(lib.length));
        expect(files).toContain('/Show/S01E01.mkv');
    });

    it('does not read patterns from a .lumastraignore symlinked outside the library', async () => {
        writeFileSync(join(outside, 'ignore'), '*.mkv\n');
        symlinkSync(join(outside, 'ignore'), join(lib, '.lumastraignore'));
        writeFileSync(join(lib, 'Movie.mkv'), '');
        // refused ⇒ fail closed: nothing is scanned and the walk is flagged incomplete
        const result = await walkDirectoryWithResult(lib);
        expect(result.files).toHaveLength(0);
        expect(result.hadErrors).toBe(true);
    });
});

describe('ignore files: glob ? and fail-closed handling', () => {
    it('? matches exactly one non-slash character', () => {
        expect(globMatches('file?.mkv', 'file1.mkv')).toBe(true);
        expect(globMatches('file?.mkv', 'file.mkv')).toBe(false);
        expect(globMatches('file?.mkv', 'file12.mkv')).toBe(false);
        expect(globMatches('a?b', 'a/b')).toBe(false);
    });

    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'walk-ign-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('a .ignore holding only over-long lines is NOT an empty skip marker', async () => {
        mkdirSync(join(dir, 'Sub'));
        writeFileSync(join(dir, 'Sub', '.ignore'), `${'x'.repeat(600)}\n`);
        writeFileSync(join(dir, 'Sub', 'Movie.mkv'), '');
        expect((await walkDirectory(dir)).map((f) => f.slice(dir.length))).toEqual([
            '/Sub/Movie.mkv',
        ]);
    });

    it('fails closed: an ignore file over the size cap skips its directory and flags the walk', async () => {
        mkdirSync(join(dir, 'Sub'));
        writeFileSync(join(dir, 'Sub', '.lumastraignore'), '*.mkv\n'.repeat(30_000));
        writeFileSync(join(dir, 'Sub', 'Movie.mkv'), '');
        writeFileSync(join(dir, 'Top.mkv'), '');
        const result = await walkDirectoryWithResult(dir);
        expect(result.files.map((f) => f.slice(dir.length))).toEqual(['/Top.mkv']);
        expect(result.hadErrors).toBe(true);
    });

    it('fails closed for a symlinked ignore file pointing outside the library', async () => {
        const outsideDir = mkdtempSync(join(tmpdir(), 'walk-ign-out-'));
        try {
            writeFileSync(join(outsideDir, 'ignore'), '*.avi\n');
            mkdirSync(join(dir, 'Sub'));
            symlinkSync(join(outsideDir, 'ignore'), join(dir, 'Sub', '.lumastraignore'));
            writeFileSync(join(dir, 'Sub', 'Movie.mkv'), '');
            const result = await walkDirectoryWithResult(dir);
            expect(result.files).toEqual([]);
            expect(result.hadErrors).toBe(true);
        } finally {
            rmSync(outsideDir, { recursive: true, force: true });
        }
    });
});
