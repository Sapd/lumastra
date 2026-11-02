// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The virtual timeline, run over REAL AudiobookShelf payloads.
 *
 * Eight bugs on this integration have been correctly-typed reads of shapes that
 * never carried the data the reader assumed, and one of them reported "0 items,
 * 0 errors" while throwing. The unit tests beside this file pin behaviour
 * against one captured session; this one runs the same code over whatever the
 * live library actually contains, including the books nobody thought to write a
 * fixture for.
 *
 * Env-gated, so it skips silently in CI:
 *
 * ```
 * AUDIOURL=...  AUDIOAPIKEY=...
 * npm run test:integration src/lib/utils/audiobook-timeline.live.integration.test.ts
 * ```
 *
 * `AUDIOBOOKSHELF_TEST_SAMPLE_SIZE` (default 40) bounds how many books are
 * opened as real playback sessions; every session opened is closed again.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
    buildAudiobookTimeline,
    chapterProgress,
    findChapterAt,
    resolveFilePosition,
    toBookMs,
    type AbsAudioTrackInput,
    type AbsChapterInput,
} from './audiobook-timeline';

const BASE_URL = (process.env.AUDIOURL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.AUDIOAPIKEY ?? '';
const LIVE = Boolean(BASE_URL && API_KEY);
const SAMPLE_SIZE = Number(process.env.AUDIOBOOKSHELF_TEST_SAMPLE_SIZE ?? '40');

const suite = LIVE ? describe : describe.skip;

/** Its own device id: ABS closes any other open session for the same pair. */
const DEVICE_ID = 'lumastra-timeline-live-itest';

interface MinifiedItem {
    id: string;
    media: { numAudioFiles: number | null; metadata: { title: string } };
}

interface SessionShape {
    id: string;
    playMethod: number;
    duration: number;
    audioTracks: AbsAudioTrackInput[];
    chapters: AbsChapterInput[];
}

async function absJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
}

function openSession(itemId: string): Promise<SessionShape> {
    return absJson<SessionShape>(`/api/items/${itemId}/play`, {
        method: 'POST',
        body: JSON.stringify({
            deviceInfo: {
                clientName: 'Lumastra',
                clientVersion: '0.0.0-timeline-itest',
                deviceId: DEVICE_ID,
            },
            supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/flac'],
            mediaPlayer: 'html5',
            forceDirectPlay: false,
            forceTranscode: false,
        }),
    });
}

async function closeSession(sessionId: string): Promise<void> {
    await fetch(`${BASE_URL}/api/session/${sessionId}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}` },
    }).catch(() => {});
}

/**
 * Prefer variety over the first N in library order.
 *
 * MEASURED 2026-07-29: sampling in library order found ZERO chapterless books
 * in 50 tries, while a file-count-stratified sample of 25 found 7 — every
 * chapterless book in this library is single-file, so they all sit at one end
 * of that ordering. A test that samples the wrong way passes without ever
 * exercising the fallback it exists to check.
 */
function stratifiedSample(items: readonly MinifiedItem[], size: number): MinifiedItem[] {
    const sorted = [...items].sort(
        (a, b) => (a.media.numAudioFiles ?? 0) - (b.media.numAudioFiles ?? 0),
    );
    const step = Math.max(1, Math.floor(sorted.length / size));
    return sorted.filter((_, i) => i % step === 0).slice(0, size);
}

suite('audiobook timeline — live AudiobookShelf', () => {
    let items: MinifiedItem[] = [];

    beforeAll(async () => {
        const libs = await absJson<{ libraries: Array<{ id: string; mediaType: string }> }>(
            '/api/libraries',
        );
        const bookLibs = libs.libraries.filter((l) => l.mediaType === 'book');
        expect(bookLibs.length).toBeGreaterThan(0);

        const pages = await Promise.all(
            bookLibs.map((l) =>
                absJson<{ results: MinifiedItem[] }>(
                    `/api/libraries/${l.id}/items?limit=${SAMPLE_SIZE * 2}`,
                ),
            ),
        );
        items = pages.flatMap((p) => p.results);
        expect(items.length).toBeGreaterThan(0);
    }, 120_000);

    it('holds its invariants over a sample of real playback sessions', async () => {
        const sample = stratifiedSample(items, SAMPLE_SIZE);

        let multiFile = 0;
        let chapterless = 0;
        let chaptersEqualFiles = 0;

        for (const item of sample) {
            const session = await openSession(item.id);
            try {
                const timeline = buildAudiobookTimeline(session.audioTracks, session.chapters);
                const label = `${item.media.metadata.title} (${item.id})`;

                // 1. The book has playable extent.
                expect(timeline.tracks.length, label).toBeGreaterThan(0);
                expect(timeline.durationMs, label).toBeGreaterThan(0);

                // 2. Duration agrees with what ABS says the session is.
                //    Seconds are floats; 1 ms of tolerance over a 40-hour
                //    book is generous and still catches a unit error.
                expect(Math.abs(timeline.durationMs - session.duration * 1000)).toBeLessThan(1);

                // 3. Files tile the book with no hole and no overlap.
                for (let i = 1; i < timeline.tracks.length; i++) {
                    const gap =
                        timeline.tracks[i].startOffsetMs - timeline.tracks[i - 1].endOffsetMs;
                    expect(Math.abs(gap), `${label} gap before file ${i}`).toBeLessThan(1);
                }

                // 4. Chapters cover [0, duration] contiguously. A hole is
                //    what makes findChapterAt return null, which breaks the
                //    chapter scrubber, prev/next and the label at once.
                expect(timeline.chapters.length, label).toBeGreaterThan(0);
                expect(timeline.chapters[0].startMs, label).toBe(0);
                for (let i = 1; i < timeline.chapters.length; i++) {
                    expect(timeline.chapters[i].startMs, `${label} chapter ${i}`).toBe(
                        timeline.chapters[i - 1].endMs,
                    );
                }
                expect(
                    timeline.chapters.at(-1)!.endMs,
                    `${label} last chapter end`,
                ).toBeGreaterThanOrEqual(timeline.durationMs - 1);

                // 5. Every chapter has positive extent — a zero-length span
                //    divides by zero in the scrubber.
                for (const c of timeline.chapters) {
                    expect(c.endMs, `${label} chapter "${c.title}"`).toBeGreaterThan(c.startMs);
                }

                // 6. book → file → book round-trips, including EXACTLY on
                //    every boundary, and a boundary belongs to the file that
                //    starts there.
                const probes = [
                    0,
                    timeline.durationMs / 3,
                    timeline.durationMs - 1,
                    ...timeline.tracks.map((t) => t.startOffsetMs),
                    ...timeline.chapters.map((c) => c.startMs),
                ];
                for (const bookMs of probes) {
                    const pos = resolveFilePosition(timeline, bookMs);
                    expect(pos, `${label} @${bookMs}`).not.toBeNull();
                    expect(toBookMs(pos!.track, pos!.fileMs)).toBeCloseTo(bookMs, 6);
                    expect(findChapterAt(timeline, bookMs), `${label} @${bookMs}`).not.toBeNull();
                    expect(chapterProgress(timeline, bookMs)!.positionMs).toBeGreaterThanOrEqual(0);
                }
                for (const track of timeline.tracks) {
                    expect(
                        resolveFilePosition(timeline, track.startOffsetMs)!.track.ino,
                        `${label} boundary ${track.startOffsetMs}`,
                    ).toBe(track.ino);
                }

                if (timeline.tracks.length > 1) multiFile += 1;
                if (timeline.chaptersAreSynthetic) chapterless += 1;
                if (session.chapters.length === session.audioTracks.length) {
                    chaptersEqualFiles += 1;
                }
            } finally {
                await closeSession(session.id);
            }
        }

        // Not an assertion about correctness — a check that the sample
        // actually exercised the shapes the design was built around, so a
        // green run cannot mean "we only ever saw single-file books".
        console.info(
            `[timeline-live] ${sample.length} books: ${multiFile} multi-file, ` +
                `${chaptersEqualFiles} with chapters == files, ${chapterless} chapterless`,
        );
        expect(multiFile).toBeGreaterThan(0);
    }, 600_000);

    it('finds at least one chapterless book and synthesises per-file chapters for it', async () => {
        // 22 of 666 measured books carry none, and in this library every one of
        // them is SINGLE-file — so the fallback's real-world shape is the
        // degenerate one: exactly one synthetic chapter spanning the book,
        // which makes the chapter scrubber equivalent to a whole-book scrubber.
        let found: { title: string; files: number } | null = null;

        for (const item of stratifiedSample(items, SAMPLE_SIZE)) {
            const expanded = await absJson<{
                media: { chapters: AbsChapterInput[]; audioFiles: unknown[] };
            }>(`/api/items/${item.id}?expanded=1`);
            if (expanded.media.chapters.length > 0) continue;

            const session = await openSession(item.id);
            try {
                const timeline = buildAudiobookTimeline(session.audioTracks, session.chapters);
                expect(timeline.chaptersAreSynthetic).toBe(true);
                expect(timeline.chapters.length).toBe(timeline.tracks.length);
                expect(timeline.chapters[0].startMs).toBe(0);
                expect(timeline.chapters.at(-1)!.endMs).toBeCloseTo(timeline.durationMs, 6);
                expect(findChapterAt(timeline, timeline.durationMs / 2)).not.toBeNull();
                found = { title: item.media.metadata.title, files: timeline.tracks.length };
            } finally {
                await closeSession(session.id);
            }
            break;
        }

        // Deliberately loud rather than a silent pass: "found nothing" and
        // "the fallback works" look identical from a green run otherwise.
        expect(
            found,
            'no chapterless book in the sample — the fallback went untested',
        ).not.toBeNull();
        console.info(`[timeline-live] chapterless: ${found!.title} (${found!.files} files)`);
    }, 600_000);
});
