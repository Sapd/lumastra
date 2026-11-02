// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    buildAudiobookTimeline,
    buildChapterSpans,
    chapterProgress,
    clampBookMs,
    findChapterAt,
    findChapterSpanAt,
    nextTrack,
    resolveFilePosition,
    seekChapterTarget,
    toBookMs,
    type AbsAudioTrackInput,
} from './audiobook-timeline';
import liveSession from './__fixtures__/audiobook-play-session.fahrenheit451.json';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The fixture is a VERBATIM `POST /api/items/:id/play` response captured from
 * the production AudiobookShelf on 2026-07-29 (Lanternlight 451, 5 files, 5
 * chapters, `playMethod: 0` = direct play). Hand-written inputs would have
 * agreed with whatever this module assumed; this one cannot.
 */
describe('buildAudiobookTimeline — against a real ABS play session', () => {
    const timeline = buildAudiobookTimeline(
        liveSession.audioTracks as AbsAudioTrackInput[],
        liveSession.chapters,
    );

    it('converts ABS seconds to ms and keeps the server-accumulated offsets', () => {
        // Compared loosely on purpose: ABS reports float seconds, so `* 1000`
        // lands at 6111582.040999999 rather than 6111582.041. Nothing here
        // re-derives an offset by summing durations — 227 additions of that
        // error on a 228-file book is exactly the drift this avoids.
        const expected = [0, 3_161_835.102, 6_111_582.041, 9_051_715.919, 11_987_826.939];
        timeline.tracks.forEach((t, i) => expect(t.startOffsetMs).toBeCloseTo(expected[i], 6));
        expect(timeline.tracks[0].ino).toBe('8941');
        expect(timeline.tracks[0].codec).toBe('mp3');
    });

    it('derives book duration matching the session total', () => {
        expect(timeline.durationMs).toBeCloseTo(liveSession.duration * 1000, 3);
    });

    it('reports the chapters as real, not synthesised', () => {
        expect(timeline.chaptersAreSynthetic).toBe(false);
        expect(timeline.chapters).toHaveLength(5);
        expect(timeline.chapters[0].title).toBe('01 - Lanternlight 451');
    });

    it('has chapters aligned to files — the common case, not an edge case', () => {
        // 87% of a real library is multi-file and usually chapters === files,
        // so every chapter change is also a file boundary.
        timeline.chapters.forEach((c, i) =>
            expect(c.startMs).toBeCloseTo(timeline.tracks[i].startOffsetMs, 6),
        );
    });

    it('maps a mid-book position to the right file and offset', () => {
        const pos = resolveFilePosition(timeline, 7_000_000);
        expect(pos?.track.ino).toBe('8831'); // third file
        expect(pos?.fileMs).toBeCloseTo(7_000_000 - 6_111_582.041, 3);
    });

    it('round-trips book → file → book', () => {
        for (const bookMs of [0, 1, 3_161_835, 3_161_836, 9_051_715.919, 15_000_000]) {
            const pos = resolveFilePosition(timeline, bookMs);
            expect(pos).not.toBeNull();
            expect(toBookMs(pos!.track, pos!.fileMs)).toBeCloseTo(bookMs, 6);
        }
    });

    it('puts a position exactly ON a boundary in the file that STARTS there', () => {
        // The other way round lands a "jump to chapter 2" on the last sample of
        // chapter 1, where `ended` fires immediately and advances — a seek that
        // arrives one chapter from where the user tapped.
        const boundary = 3_161_835.102;
        const pos = resolveFilePosition(timeline, boundary);
        expect(pos?.track.ino).toBe('8997'); // second file
        expect(pos?.fileMs).toBe(0);

        const chapter = findChapterAt(timeline, boundary);
        expect(chapter?.index).toBe(1);
        expect(chapter?.startMs).toBe(boundary);
    });

    it('resolves one millisecond before a boundary to the preceding file', () => {
        const pos = resolveFilePosition(timeline, 3_161_835.102 - 1);
        expect(pos?.track.ino).toBe('8941');
    });

    it('clamps a position past the end to the last file rather than returning null', () => {
        // ABS itself reports currentTime slightly past duration on a finished
        // book, so this path is reached by real data.
        const pos = resolveFilePosition(timeline, timeline.durationMs + 5_000);
        expect(pos?.track.ino).toBe('9088');
        expect(pos!.fileMs).toBeCloseTo(timeline.tracks[4].durationMs, 3);
    });

    it('walks files forward and stops at the end of the book', () => {
        expect(nextTrack(timeline, timeline.tracks[0])?.ino).toBe('8997');
        expect(nextTrack(timeline, timeline.tracks[4])).toBeNull();
    });
});

describe('chapter navigation', () => {
    const timeline = buildAudiobookTimeline(
        liveSession.audioTracks as AbsAudioTrackInput[],
        liveSession.chapters,
    );

    it('reports chapter-relative position and duration for the scrubber', () => {
        const p = chapterProgress(timeline, 3_161_835.102 + 60_000);
        expect(p?.chapter.index).toBe(1);
        expect(p?.positionMs).toBeCloseTo(60_000, 3);
        expect(p?.durationMs).toBeCloseTo(2_949_746.939, 3);
    });

    it('next chapter targets the following chapter start', () => {
        expect(seekChapterTarget(timeline, 100_000, 1)).toBeCloseTo(3_161_835.102, 3);
    });

    it('next chapter returns null in the last chapter', () => {
        expect(seekChapterTarget(timeline, timeline.durationMs - 1_000, 1)).toBeNull();
    });

    it('previous chapter restarts the current one when already past the threshold', () => {
        const inside = 3_161_835.102 + 30_000;
        expect(seekChapterTarget(timeline, inside, -1)).toBeCloseTo(3_161_835.102, 3);
    });

    it('previous chapter goes back a chapter when near its start', () => {
        const justInside = 3_161_835.102 + 500;
        expect(seekChapterTarget(timeline, justInside, -1)).toBe(0);
    });

    it('previous chapter in the first chapter goes to the start of the book', () => {
        expect(seekChapterTarget(timeline, 500, -1)).toBe(0);
    });
});

describe('zero-chapter books', () => {
    const tracks: AbsAudioTrackInput[] = [
        { index: 1, ino: 'a', startOffset: 0, duration: 600, title: 'part-one.mp3' },
        { index: 2, ino: 'b', startOffset: 600, duration: 540, title: 'part-two.mp3' },
    ];

    it('synthesises one chapter per audio file', () => {
        // 22 of 666 measured books carry no chapters; without this the
        // chapter-scoped scrubber, prev/next and the label all break at once.
        const timeline = buildAudiobookTimeline(tracks, []);
        expect(timeline.chaptersAreSynthetic).toBe(true);
        expect(timeline.chapters).toEqual([
            { index: 0, title: 'Part 1', startMs: 0, endMs: 600_000, synthetic: true },
            { index: 1, title: 'Part 2', startMs: 600_000, endMs: 1_140_000, synthetic: true },
        ]);
    });

    it('accepts a localised label', () => {
        const timeline = buildAudiobookTimeline(tracks, null, {
            synthesizeChapterTitle: (n) => `Teil ${n}`,
        });
        expect(timeline.chapters.map((c) => c.title)).toEqual(['Teil 1', 'Teil 2']);
    });

    it('degrades a single-file chapterless book to one whole-book chapter', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'only', startOffset: 0, duration: 24_684.859229 }],
            undefined,
        );
        expect(timeline.chapters).toHaveLength(1);
        expect(timeline.chapters[0].startMs).toBe(0);
        expect(timeline.chapters[0].endMs).toBeCloseTo(24_684_859.229, 3);
        // The chapter scrubber is now the whole-book scrubber — no downstream
        // special-casing required, which is the point of the fallback.
        const p = chapterProgress(timeline, 12_000_000);
        expect(p?.positionMs).toBe(12_000_000);
    });
});

describe('payload defects the live server actually produces', () => {
    it('orders by startOffset, not by array position or index', () => {
        const timeline = buildAudiobookTimeline(
            [
                { index: 2, ino: 'b', startOffset: 100, duration: 100 },
                { index: 1, ino: 'a', startOffset: 0, duration: 100 },
            ],
            [],
        );
        expect(timeline.tracks.map((t) => t.ino)).toEqual(['a', 'b']);
    });

    it('fills an unprobed duration from the next track offset', () => {
        const timeline = buildAudiobookTimeline(
            [
                { index: 1, ino: 'a', startOffset: 0, duration: null },
                { index: 2, ino: 'b', startOffset: 300, duration: 200 },
            ],
            [],
        );
        expect(timeline.tracks[0].durationMs).toBe(300_000);
        expect(timeline.durationMs).toBe(500_000);
        // Without the fill, file `a` would be zero-length and every position
        // inside it would resolve to file `b`.
        expect(resolveFilePosition(timeline, 150_000)?.track.ino).toBe('a');
    });

    /**
     * The filter drops UNUSABLE tracks, not inode-less ones.
     *
     * It used to require an inode outright, which emptied the timeline for every
     * transcode session — one synthetic whole-book track, served as an HLS
     * playlist and therefore with no inode. `durationMs` fell to 0, every
     * position clamped to 0, and the player pushed position 0 into
     * AudiobookShelf's history-less progress row.
     */
    it('keeps an inode-less track that carries its own duration (the HLS case)', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: null, startOffset: 0, duration: 3144.7 }],
            [],
        );
        expect(timeline.tracks).toHaveLength(1);
        expect(timeline.tracks[0].ino).toBeNull();
        expect(timeline.durationMs).toBeCloseTo(3_144_700, 0);
    });

    it('drops a track that is neither addressable nor measurable', () => {
        const timeline = buildAudiobookTimeline(
            [
                // No inode AND no duration: nothing can be fetched and nothing
                // can be positioned. An empty string is the same case.
                { index: 1, ino: null, startOffset: 0, duration: null },
                { index: 2, ino: '', startOffset: 0, duration: 0 },
                { index: 3, ino: 'b', startOffset: 100, duration: 100 },
            ],
            [],
        );
        expect(timeline.tracks.map((t) => t.ino)).toEqual(['b']);
    });

    it('closes a hole between chapters instead of leaving positions uncovered', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 1000 }],
            [
                { title: 'one', start: 0, end: 100 },
                { title: 'two', start: 400, end: 500 },
            ],
        );
        // A hole BETWEEN chapters is absorbed by the one before it — 'one' runs
        // to 400 s, not to its own 100 s end. The hole after the LAST chapter is
        // not: see "a chapter list that stops before the book does".
        expect(timeline.chapters.map((c) => [c.startMs, c.endMs])).toEqual([
            [0, 400_000],
            [400_000, 500_000],
            [500_000, 1_000_000],
        ]);
        expect(findChapterAt(timeline, 250_000)?.title).toBe('one');
        expect(timeline.chapters[2].untagged).toBe(true);
    });

    it('discards zero-length chapter entries', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 100 }],
            [
                { title: 'dupe', start: 50, end: 50 },
                { title: 'dupe2', start: 50, end: 50 },
                { title: 'real', start: 50, end: 100 },
            ],
        );
        // A zero-length span makes the scrubber divide by zero.
        expect(timeline.chapters.every((c) => c.endMs > c.startMs)).toBe(true);
    });

    it('collapses a run of duplicate-start chapters into ONE reachable span', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 300 }],
            [
                { title: 'first', start: 0, end: 100 },
                { title: 'dupe-a', start: 100, end: 200 },
                { title: 'dupe-b', start: 100, end: 200 },
                { title: 'last', start: 200, end: 300 },
            ],
        );
        // Emitting both duplicates produces identical spans, and findChapterAt
        // scans backwards — so the earlier one is unreachable and next/previous
        // cycles between two chapters the listener cannot tell apart.
        expect(timeline.chapters.map((c) => c.title)).toEqual(['first', 'dupe-a', 'last']);
        expect(findChapterAt(timeline, 150_000)?.title).toBe('dupe-a');
        expect(seekChapterTarget(timeline, 150_000, 1)).toBe(200_000);
    });

    it('uses the session duration when the FINAL track was never probed', () => {
        // No successor to measure against, so without the hint this track is
        // zero-length: the book's total stops short of its real end and
        // clampBookMs pins every report to a position already played past.
        const timeline = buildAudiobookTimeline(
            [
                { index: 1, ino: 'a', startOffset: 0, duration: 600 },
                { index: 2, ino: 'b', startOffset: 600, duration: null },
            ],
            [],
            { totalDurationMs: 1_500_000 },
        );
        expect(timeline.durationMs).toBe(1_500_000);
        expect(timeline.tracks[1].durationMs).toBe(900_000);
        expect(resolveFilePosition(timeline, 1_400_000)?.track.ino).toBe('b');
    });

    it('ignores a total-duration hint shorter than the tracks themselves', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 600 }],
            [],
            { totalDurationMs: 1_000 },
        );
        expect(timeline.durationMs).toBe(600_000);
    });

    it('returns null rather than inventing a position for an empty timeline', () => {
        const timeline = buildAudiobookTimeline([], []);
        expect(resolveFilePosition(timeline, 0)).toBeNull();
        expect(findChapterAt(timeline, 0)).toBeNull();
        expect(chapterProgress(timeline, 0)).toBeNull();
    });

    it('clamps NaN and negative positions', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 100 }],
            [],
        );
        expect(clampBookMs(timeline, Number.NaN)).toBe(0);
        expect(clampBookMs(timeline, -5)).toBe(0);
        expect(clampBookMs(timeline, 1e12)).toBe(100_000);
    });
});

/**
 * The server-side readers (social listening rows) have the STORED chapter list
 * and a duration, and no track list at all — the stored per-file metadata carries
 * no `startOffset` to accumulate. These two exports are what they use, and the
 * property that matters is that they land on the same chapter the player would:
 * "Anna is at Kapitel 3" on the modal and "Kapitel 3" on her own scrubber must be
 * the same chapter, or the feature lies.
 */
describe('buildChapterSpans / findChapterSpanAt — the server-side chapter reader', () => {
    const timeline = buildAudiobookTimeline(
        liveSession.audioTracks as AbsAudioTrackInput[],
        liveSession.chapters,
    );

    it('produces exactly the spans the player timeline produces, on real data', () => {
        const spans = buildChapterSpans(liveSession.chapters, timeline.durationMs);
        expect(spans).toEqual(timeline.chapters);
    });

    it('agrees with findChapterAt at every chapter boundary and midpoint', () => {
        const spans = buildChapterSpans(liveSession.chapters, timeline.durationMs);
        for (const span of timeline.chapters) {
            for (const probe of [span.startMs, span.startMs + 1, (span.startMs + span.endMs) / 2]) {
                expect(findChapterSpanAt(spans, probe)?.index, `@${probe}`).toBe(
                    findChapterAt(timeline, probe)?.index,
                );
            }
        }
    });

    it('has no synthetic fallback — a chapterless book yields no chapters', () => {
        // buildAudiobookTimeline invents one chapter per FILE here; this reader has
        // no file list, so it must report "no chapter" instead of inventing a
        // "Teil 1" that does not match what the listener's own player shows.
        expect(buildChapterSpans([], 600_000)).toEqual([]);
        expect(buildChapterSpans(null, 600_000)).toEqual([]);
        expect(findChapterSpanAt([], 1_000)).toBeNull();
    });

    it('keeps the LAST chapter when the duration is unknown but `end` is present', () => {
        // The measured shape: `custom_metadata.audiobookshelf.duration` can be
        // null. Without ABS's own `end` as the tie-breaker the final chapter is
        // dropped, and everyone listening to the end of the book would report the
        // second-to-last chapter.
        const spans = buildChapterSpans(liveSession.chapters, 0);
        expect(spans).toHaveLength(5);
        expect(findChapterSpanAt(spans, 15_000_000)?.index).toBe(4);
    });

    it('keeps the LAST chapter when the duration is unknown AND `end` is not usable', () => {
        // The other half of the case above. With no duration to fall back on
        // and no `end` worth using, the end landed at 0, the zero-length guard
        // fired, and the final chapter vanished from the list entirely — the
        // same shape of hole the untagged-tail work exists to close.
        const spans = buildChapterSpans(
            [
                { id: 0, title: 'One', start: 0, end: 100 },
                { id: 1, title: 'Two', start: 100, end: 100 },
            ],
            0,
        );
        expect(spans.map((s) => s.title)).toEqual(['One', 'Two']);
        expect(spans[1].endMs).toBeGreaterThan(spans[1].startMs);
    });

    it('covers the opening of a book whose first chapter starts late', () => {
        const spans = buildChapterSpans(
            [
                { id: 0, title: 'Intro', start: 50, end: 100 },
                { id: 1, title: 'One', start: 100, end: 200 },
            ],
            200_000,
        );
        expect(spans[0].startMs).toBe(0);
        expect(findChapterSpanAt(spans, 0)?.title).toBe('Intro');
    });

    it('drops entries with no numeric start rather than defaulting them to 0', () => {
        // A run of synthetic zeros collapses into one span and makes every real
        // chapter after it unreachable behind the backward scan.
        const spans = buildChapterSpans(
            [
                { id: 0, title: 'Bad', start: null, end: 100 },
                { id: 1, title: 'Good', start: 0, end: 100 },
                { id: 2, title: 'Also good', start: 100, end: 200 },
            ],
            200_000,
        );
        expect(spans.map((s) => s.title)).toEqual(['Good', 'Also good']);
    });
});

describe('needsRemux passthrough', () => {
    // The server's persisted-codec verdict arrives on the session payload and the
    // player picks a URL from the TIMELINE, so a projection that dropped this flag
    // would leave the server's only statement about decodability unread — and the
    // client back to guessing from a codec string that is null on a transcode
    // session's synthetic track.
    it('carries the flag through to the timeline track', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 60, codec: 'eac3', needsRemux: true }],
            [],
        );
        expect(timeline.tracks[0].needsRemux).toBe(true);
    });

    it('reads an absent flag as false rather than undefined', () => {
        // An older server sends no flag at all. `false` keeps every consumer a
        // plain boolean check instead of a three-state one.
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 60, codec: 'mp3' }],
            [],
        );
        expect(timeline.tracks[0].needsRemux).toBe(false);
    });

    it('keeps the flag with its own track when tracks arrive out of order', () => {
        // The live server does return tracks out of `startOffset` order, and the
        // timeline sorts them — so a flag matched by position rather than carried
        // on the object would land on the wrong file.
        const timeline = buildAudiobookTimeline(
            [
                { index: 2, ino: 'b', startOffset: 60, duration: 60, codec: 'mp3' },
                {
                    index: 1,
                    ino: 'a',
                    startOffset: 0,
                    duration: 60,
                    codec: 'eac3',
                    needsRemux: true,
                },
            ],
            [],
        );
        expect(timeline.tracks.map((t) => [t.ino, t.needsRemux])).toEqual([
            ['a', true],
            ['b', false],
        ]);
    });
});

/**
 * Measured on the production library (1060 books with a chapter list):
 *
 * | book                                       | chapters end | book duration | tail     |
 * | ------------------------------------------ | ------------ | ------------- | -------- |
 * | Stormrage — World Of Warcraft              | 16 800.8 s   | 84 552.5 s    | 18h49m   |
 * | Babel                                      | 17 549.3 s   | 68 109.6 s    | 14h02m   |
 * | The Hobbit                                 | 14 294.5 s   | 39 890.0 s    |  7h06m   |
 * | Milo Farrow … Lantern of Dawn (Simon Vale)| 74 060.4 s   | 75 423.8 s    |    22m43s|
 * | Milo Farrow … Starhaven (Simon Vale)       | 42 416.0 s   | 43 428.2 s    |    16m52s|
 * | Hollowpox — Nevermoor 3                    | 52 076.1 s   | 52 078.8 s    |     2.6 s|
 * | Tommyknockers (ungekürzt)                  | 111 784.6 s  | 111 786.5 s   |     1.9 s|
 *
 * Nine books in all; the same query found ZERO holes over 60 s BETWEEN
 * chapters, so this defect is exclusively a tail and the fix is scoped to one.
 *
 * The two sub-3-second rows are float rounding and must keep behaving as they
 * always have — absorbed into the final chapter. The rest are real, unlabelled
 * audio that the listener has no way to reach when the final chapter simply
 * swallows it.
 */
describe('a chapter list that stops before the book does', () => {
    /** Milo Farrow and the Keeper of Starhaven, narrated by Simon Vale. */
    const azkaban = () =>
        buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 43_428.153471 }],
            [
                {
                    title: '210. Chapter 22. 11 Owl Post Again',
                    start: 42_291.092421,
                    end: 42_387.553921,
                },
                { title: '211. Conclusion', start: 42_387.553921, end: 42_416.016171 },
            ],
        );

    it('leaves the final REAL chapter at the end ABS gave it', () => {
        const chapters = azkaban().chapters;
        const conclusion = chapters.find((c) => c.title === '211. Conclusion');
        // Not 43_428_153: swallowing the tail turns a 28-second chapter into a
        // 17-minute one, and the chapter-scoped scrubber — the audiobook
        // player's primary seek control — is then scaled to a fiction.
        expect(conclusion?.endMs).toBeCloseTo(42_416_016.171, 0);
    });

    it('adds a span for the untagged tail so it can be selected', () => {
        const chapters = azkaban().chapters;
        const tail = chapters[chapters.length - 1];
        expect(tail.untagged).toBe(true);
        expect(tail.startMs).toBeCloseTo(42_416_016.171, 0);
        expect(tail.endMs).toBeCloseTo(43_428_153.471, 0);
    });

    it('still covers every position in the book — no hole to fall into', () => {
        const timeline = azkaban();
        expect(timeline.chapters[0].startMs).toBe(0);
        for (let i = 1; i < timeline.chapters.length; i++) {
            expect(timeline.chapters[i].startMs).toBe(timeline.chapters[i - 1].endMs);
        }
        expect(timeline.chapters[timeline.chapters.length - 1].endMs).toBe(timeline.durationMs);
    });

    it('scopes the scrubber to the tail rather than pinning it at 100%', () => {
        const timeline = azkaban();
        // Ten minutes into the untagged tail.
        const progress = chapterProgress(timeline, 43_016_016);
        expect(progress?.chapter.untagged).toBe(true);
        expect(progress?.positionMs).toBeCloseTo(600_000, 0);
        expect(progress?.durationMs).toBeCloseTo(1_012_137.3, 0);
    });

    it('lets next-chapter reach the tail from the last real chapter', () => {
        const timeline = azkaban();
        expect(seekChapterTarget(timeline, 42_400_000, 1)).toBeCloseTo(42_416_016.171, 0);
    });

    it('absorbs a rounding-scale tail instead of adding a 2-second row', () => {
        // Tommyknockers: 1.9 s short of its own duration.
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 111_786.5 }],
            [
                { title: '669', start: 111_700, end: 111_763.2 },
                { title: '670', start: 111_763.2, end: 111_784.6 },
            ],
        );
        expect(timeline.chapters).toHaveLength(2);
        expect(timeline.chapters[1].endMs).toBe(111_786_500);
        expect(timeline.chapters.some((c) => c.untagged)).toBe(false);
    });

    it('adds no tail when the chapters run PAST the end of the audio', () => {
        // Milo Farrow and the Hall of Lanterns overshoots by 24 s, and the
        // two LOTR books carry 25 chapters against a single ~190 s fragment.
        // There is no unlabelled audio to point at in either case — what
        // happens to the overshooting chapters themselves is the subject of
        // "a chapter list that runs past the end of the audio" below.
        const spans = buildChapterSpans(
            [
                { title: 'one', start: 0, end: 5_000 },
                { title: 'two', start: 5_000, end: 5_535.5 },
            ],
            189_900,
        );
        expect(spans.some((c) => c.untagged)).toBe(false);
    });

    it('applies on the server-side reader too, so both agree on the chapter', () => {
        const spans = buildChapterSpans(
            [{ title: 'last', start: 42_387.553921, end: 42_416.016171 }],
            43_428_153.471,
        );
        expect(findChapterSpanAt(spans, 43_000_000)?.untagged).toBe(true);
    });
});

/**
 * The mirror image of the untagged tail: chapters describing audio that is not
 * there.
 *
 * Measured on the production library — `The Two Towers` and `The Fellowship of
 * the Ring` are each a single 1.6 MB mp3 of ~190 seconds (a download that
 * fetched one fragment: `The Two Towers (9).mp3`), whose embedded ID3 chapter
 * list still describes the whole 1.6-hour book. So `duration` is RIGHT and the
 * chapters are the stale half — 24 of the 25 chapters start past the end of the
 * only audio that exists.
 *
 * `clampBookMs` pins every position to the book's duration, so those 24 can
 * never be the answer to `findChapterAt`: before this they were rows the
 * chapter list offered, the scrubber highlighted "chapter 1" for, and a tap
 * silently clamped back to the start. Dropping them is not lost information —
 * it is declining to list audio the library does not have.
 *
 * `duration` is the trustworthy number in BOTH readers by construction: the
 * player derives it from the play session's real `audioTracks[]`, and
 * `buildChapterSpans` gets ABS's `duration`, which is the sum of the audio
 * files' own durations. Both describe audio that can actually be played.
 */
describe('a chapter list that runs past the end of the audio', () => {
    /** The Two Towers: one ~190 s fragment carrying the whole book's chapters. */
    const twoTowers = () =>
        buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 189.936 }],
            [
                { title: 'one', start: 0, end: 120 },
                { title: 'two', start: 120, end: 2_000 },
                { title: 'three', start: 2_000, end: 4_000 },
                { title: 'four', start: 4_000, end: 5_535.5 },
            ],
        );

    it('drops the chapters that start past the end of the audio', () => {
        expect(twoTowers().chapters.map((c) => c.title)).toEqual(['one', 'two']);
    });

    it('truncates the surviving chapter to where the audio actually stops', () => {
        const chapters = twoTowers().chapters;
        expect(chapters[chapters.length - 1].endMs).toBe(189_936);
    });

    it('makes every listed chapter reachable again', () => {
        const timeline = twoTowers();
        // The whole point: before this, a tap on any of chapters 2-25 clamped
        // back into chapter 1, and the highlight never left it.
        for (const chapter of timeline.chapters) {
            expect(findChapterAt(timeline, chapter.startMs)?.index).toBe(chapter.index);
        }
    });

    it('trims a small overshoot without dropping anything', () => {
        // Milo Farrow and the Hall of Lanterns overshoots by 24 s — the last
        // chapter simply ends a little past the audio. Nothing to drop.
        const spans = buildChapterSpans(
            [
                { title: 'one', start: 0, end: 33_300.8 },
                { title: 'two', start: 33_300.8, end: 34_992.8 },
            ],
            34_968_700,
        );
        expect(spans.map((c) => c.title)).toEqual(['one', 'two']);
        expect(spans[1].endMs).toBe(34_968_700);
    });

    it('leaves the chapters alone when the duration is unknown', () => {
        // durationMs 0 is "we do not know", not "there is no audio" — clamping
        // to it would erase every chapter of a book that plays perfectly well.
        const spans = buildChapterSpans(
            [
                { title: 'one', start: 0, end: 100 },
                { title: 'two', start: 100, end: 200 },
            ],
            0,
        );
        expect(spans.map((c) => c.title)).toEqual(['one', 'two']);
    });
});

/**
 * The server now normalises chapters before they reach any client, and marks
 * the span it invented. This describes what the client must do with that.
 *
 * The marker is NOT recoverable by re-deriving it: normalisation fills in the
 * very gap the client used to infer "this is a tail", so a re-normalised list
 * looks like an ordinary book (measured: `untagged` 1 → 0 with identical
 * geometry). Honouring the flag is the only way the label and the
 * label-cleanup exclusion survive the round trip.
 */
describe('a chapter list the server already normalised', () => {
    /** What the server sends for Starhaven: contiguous spans, tail flagged. */
    const serverSent = [
        { title: '210. Chapter 22. 11 Owl Post Again', start: 42_291.092421, end: 42_387.553921 },
        { title: '211. Conclusion', start: 42_387.553921, end: 42_416.016171 },
        { title: null, start: 42_416.016171, end: 43_428.153471, synthetic: true },
    ];

    it('carries the server’s marker through to the span', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 43_428.153471 }],
            serverSent,
            { untaggedTailTitle: 'TAIL' },
        );
        expect(timeline.chapters).toHaveLength(3);
        expect(timeline.chapters.map((c) => c.untagged === true)).toEqual([false, false, true]);
    });

    it('labels the marked span, since the server deliberately sends no title', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 43_428.153471 }],
            serverSent,
            { untaggedTailTitle: 'Nach dem letzten Kapitel' },
        );
        // Not "3": the ordinal fallback would be a worse label than the one
        // the caller localised for exactly this case.
        expect(timeline.chapters[2].title).toBe('Nach dem letzten Kapitel');
    });

    it('does not append a SECOND tail to a list that already has one', () => {
        // The client measures the book from its own tracks; the server measured
        // it from ABS's `duration`. A float's worth of disagreement must not
        // produce two tail rows.
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 43_500 }],
            serverSent,
            { untaggedTailTitle: 'TAIL' },
        );
        expect(timeline.chapters.filter((c) => c.untagged).length).toBe(1);
        // The existing tail stretches to the client's own end of book instead.
        expect(timeline.chapters.at(-1)!.endMs).toBe(43_500_000);
    });

    it('still synthesises a tail when the server sent none (older server)', () => {
        const timeline = buildAudiobookTimeline(
            [{ index: 1, ino: 'a', startOffset: 0, duration: 43_428.153471 }],
            [{ title: '211. Conclusion', start: 42_387.553921, end: 42_416.016171 }],
            { untaggedTailTitle: 'TAIL' },
        );
        expect(timeline.chapters.filter((c) => c.untagged).length).toBe(1);
    });
});
