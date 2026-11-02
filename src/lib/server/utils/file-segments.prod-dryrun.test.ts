// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Dry run of deriveFileSegments over every combined file in a real library
 * (256 files, snapshot taken 2026-07-15).
 *
 * Hand-written fixtures cannot prove what matters here, because it is entirely
 * about the shape of real data:
 *
 *   1. every genuine combined file gets a window (the release name declares its
 *      range, which is what created the episode rows in the first place)
 *   2. every emitted set is gapless, ordered, finite and plausibly sized
 *
 * The fixture is sanitized: paths and titles become opaque labels, and chapter
 * names collapse to placeholders preserving only their generic/non-generic
 * classification — the sole property of a name the derivation reads. Durations,
 * runtimes, chapter offsets and the declared episode counts are the real values.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveFileSegments, type SegmentEpisodeInput } from './file-segments.js';

interface FixtureFile {
    label: string;
    durationMs: number | null;
    /** Episodes the release name declares — the provenance signal. */
    declaredEpisodeCount: number | null;
    episodes: SegmentEpisodeInput[];
    chapters: { name: string | null; startMs: number }[];
}

const files: FixtureFile[] = JSON.parse(
    readFileSync(new URL('./file-segments.prod-fixture.json', import.meta.url), 'utf8'),
);

const derive = (file: FixtureFile) =>
    deriveFileSegments({
        durationMs: file.durationMs,
        episodes: file.episodes,
        chapters: file.chapters,
        declaredEpisodeCount: file.declaredEpisodeCount,
    });

describe('deriveFileSegments — real-library dry run', () => {
    it('covers the whole combined-file corpus', () => {
        expect(files.length).toBe(256);
    });

    it('every combined file declares its range in the release name', () => {
        // The evidence the whole design rests on: these rows were created BY that
        // parse, so provenance is never in doubt. Nothing here is a mis-link.
        for (const file of files) {
            expect(file.declaredEpisodeCount, file.label).toBe(file.episodes.length);
        }
    });

    it('derives the Hafentage S02E24E25 file from its chapters', () => {
        const hafentage = files.find((f) => f.label === 'hafentage-s02e24e25');
        expect(hafentage).toBeDefined();

        expect(derive(hafentage!)).toEqual([
            { mediaItemId: expect.any(String), startMs: 0, endMs: 692_275, source: 'chapter' },
            {
                mediaItemId: expect.any(String),
                startMs: 692_275,
                endMs: 1_354_602,
                source: 'chapter',
            },
        ]);
    });

    it('gives every file a window', () => {
        const skipped = files.filter((f) => derive(f) === null).map((f) => f.label);
        expect(skipped).toEqual([]);
    });

    it('emits gapless, ordered, finite, plausibly-sized segments everywhere', () => {
        for (const file of files) {
            const segments = derive(file);
            if (!segments) continue;

            expect(segments.length, file.label).toBe(file.episodes.length);
            expect(segments[0].startMs, file.label).toBe(0);
            expect(segments.at(-1)!.endMs, file.label).toBe(file.durationMs);

            for (let i = 0; i < segments.length; i++) {
                expect(Number.isFinite(segments[i].startMs), file.label).toBe(true);
                expect(Number.isFinite(segments[i].endMs), file.label).toBe(true);
                // A real episode slice is never under a minute.
                expect(segments[i].endMs - segments[i].startMs, file.label).toBeGreaterThan(60_000);
                if (i > 0) expect(segments[i].startMs, file.label).toBe(segments[i - 1].endMs);
            }
        }
    });

    it('keeps every window within its file', () => {
        for (const file of files) {
            for (const seg of derive(file) ?? []) {
                expect(seg.startMs, file.label).toBeGreaterThanOrEqual(0);
                expect(seg.endMs, file.label).toBeLessThanOrEqual(file.durationMs!);
            }
        }
    });

    it('matches the expected coverage split across the corpus', () => {
        const counts = { chapter: 0, 'runtime-split': 0, 'even-split': 0, skipped: 0 };
        for (const file of files) {
            const segments = derive(file);
            if (!segments) counts.skipped++;
            else counts[segments[0].source]++;
        }

        // Every combined file now gets a window. even-split carries the releases
        // whose provider runtimes describe the combined block rather than the
        // individual parts (two-part finales, shorts compilations) — an earlier
        // runtime-based guard mistook those for mis-links and refused them.
        expect(counts).toEqual({
            chapter: 25,
            'runtime-split': 173,
            'even-split': 58,
            skipped: 0,
        });
        expect(
            counts.skipped + counts.chapter + counts['runtime-split'] + counts['even-split'],
        ).toBe(256);
    });
});
