// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audiobook listening projection.
 *
 * Every case here is a shape MEASURED in the reference library or in this
 * integration's history, not one invented to exercise a branch:
 *
 * - A finished book reads `resume_position_ms = 0` (all 10 finished books in the
 *   reference library). Reporting that as a position renders "is at 0%" on a book
 *   somebody has read twice.
 * - 129 of 1188 books carry NO chapters, so every chapter field has to be absent
 *   rather than defaulted.
 * - `is_watched = true` can coexist with a position — the rebuilder no longer
 *   zeroes `resume_position_ms` on a watched row — which is what a re-listen looks
 *   like, and it must not be flattened into "has finished it".
 * - `watch_count` is `snapshot + positives - negatives` and can be 0 on a row that
 *   is marked watched, so "0× gehört" is reachable if it is not guarded.
 */

import { describe, it, expect, vi } from 'vitest';

/**
 * Messages return `key(args)` so an assertion can pin BOTH which message was
 * chosen and what it was given. Asserting on English wording would pass while the
 * count or the percentage was wrong, which is most of what can break here.
 */
vi.mock('$lib/paraglide/messages.js', () => {
    const keys = [
        'social_listen_chapter',
        'social_listen_chapter_percent',
        'social_listen_percent',
        'social_listen_started',
        'social_listen_finished',
        'social_listen_finished_times',
        'social_listen_shared',
        'social_listen_shared_together',
        'social_listen_shared_ahead',
        'social_listen_shared_ahead_one',
        'social_listen_shared_behind',
        'social_listen_shared_behind_one',
        'social_listen_shared_ahead_timed',
        'social_listen_shared_ahead_one_timed',
        'social_listen_shared_behind_timed',
        'social_listen_shared_behind_one_timed',
        'social_listen_shared_ahead_time_only',
        'social_listen_shared_behind_time_only',
        // The label for a book whose chapter list stops before the audio does.
        'audiobook_chapter_untagged_tail',
        // formatDurationHoursMinutes reaches through the SAME mocked module.
        'time_hours_abbr',
        'time_minutes_abbr',
        'time_zero_minutes',
    ];
    const out: Record<string, (args?: Record<string, unknown>) => string> = {};
    for (const key of keys) {
        out[key] = (args?: Record<string, unknown>) =>
            args === undefined ? key : `${key}(${JSON.stringify(args)})`;
    }
    out.social_someone = () => 'Someone';
    return out;
});

import { buildAudiobookListeningEntries } from './audiobook-listening-rows.js';
import type { AudiobookListeningRow } from '$lib/server/database/queries/social-activity.queries.js';
import type { AbsChapterInput } from '$lib/utils/audiobook-timeline.js';

/** Three 10-minute chapters, ABS units (seconds). */
const CHAPTERS: AbsChapterInput[] = [
    { id: 0, title: 'Kapitel 1', start: 0, end: 600 },
    { id: 1, title: 'Kapitel 2', start: 600, end: 1200 },
    { id: 2, title: 'Kapitel 3', start: 1200, end: 1800 },
];
const BOOK_MS = 1_800_000;

function row(overrides: Partial<AudiobookListeningRow> = {}): AudiobookListeningRow {
    return {
        user_id: 'u-anna',
        username: 'anna',
        position_ms: 0,
        duration_ms: BOOK_MS,
        is_finished: false,
        finished_recently: false,
        times_finished: 0,
        listened_on: null,
        ...overrides,
    };
}

function build(
    rows: AudiobookListeningRow[],
    viewer: AudiobookListeningRow | null = null,
    options: { chapters?: AbsChapterInput[]; bookDurationMs?: number | null } = {},
) {
    return buildAudiobookListeningEntries({
        rows,
        displayNameFor: () => 'Anna',
        viewer,
        chapters: options.chapters ?? CHAPTERS,
        bookDurationMs: options.bookDurationMs === undefined ? BOOK_MS : options.bookDurationMs,
    });
}

describe('audiobook listening rows — in progress', () => {
    it('reports position, duration, chapter and percentage', () => {
        // 700_000 ms is 100s into the second chapter.
        const [entry] = build([row({ position_ms: 700_000 })]);

        expect(entry.positionMs).toBe(700_000);
        expect(entry.durationMs).toBe(BOOK_MS);
        expect(entry.chapterIndex).toBe(1);
        expect(entry.chapterTitle).toBe('Kapitel 2');
        expect(entry.chapterCount).toBe(3);
        expect(entry.finished).toBeUndefined();
        expect(entry.description).toBe(
            'social_listen_chapter_percent({"name":"Anna","chapter":"Kapitel 2","percent":39})',
        );
    });

    it('omits every chapter field for a book that has no chapters', () => {
        const [entry] = build([row({ position_ms: 700_000 })], null, { chapters: [] });

        expect(entry.chapterTitle).toBeUndefined();
        expect(entry.chapterIndex).toBeUndefined();
        expect(entry.chapterCount).toBeUndefined();
        // Falls back to the percentage line rather than saying nothing.
        expect(entry.description).toBe('social_listen_percent({"name":"Anna","percent":39})');
    });

    it('falls back to the chapter-only line when no duration is known anywhere', () => {
        const [entry] = build([row({ position_ms: 700_000, duration_ms: null })], null, {
            bookDurationMs: null,
        });

        expect(entry.durationMs).toBeUndefined();
        expect(entry.chapterTitle).toBe('Kapitel 2');
        expect(entry.description).toBe(
            'social_listen_chapter({"name":"Anna","chapter":"Kapitel 2"})',
        );
    });

    it('says only "has started" when neither chapter nor duration is available', () => {
        const [entry] = build([row({ position_ms: 700_000, duration_ms: null })], null, {
            chapters: [],
            bookDurationMs: null,
        });

        expect(entry.description).toBe('social_listen_started({"name":"Anna"})');
    });

    it('takes the book duration from the largest reported runtime when ABS gave none', () => {
        // Both effects of the fallback, because the first one alone passes without
        // it (ABS's own `end` on the last chapter usually rescues the span):
        //   1. the FINAL chapter survives even when its `end` is missing too —
        //      otherwise everyone near the end of the book reports the
        //      second-to-last chapter;
        //   2. a listener whose own row reports no runtime still gets a percentage.
        const openEnded: AbsChapterInput[] = [
            { id: 0, title: 'Kapitel 1', start: 0, end: 600 },
            { id: 1, title: 'Kapitel 2', start: 600, end: null },
        ];
        const entries = build(
            [
                row({
                    user_id: 'u-a',
                    username: 'anna',
                    position_ms: 1_700_000,
                    duration_ms: null,
                }),
                row({
                    user_id: 'u-b',
                    username: 'bea',
                    position_ms: 700_000,
                    duration_ms: BOOK_MS,
                }),
            ],
            null,
            { chapters: openEnded, bookDurationMs: null },
        );

        expect(entries[0].chapterCount).toBe(2);
        expect(entries[0].chapterIndex).toBe(1);
        expect(entries[0].durationMs).toBe(BOOK_MS);
        expect(entries[0].description).toContain('"percent":94');
    });

    it('clamps a position past the end of the book to 100%', () => {
        // Measured on the live server: ABS's `currentTime` can exceed `duration`
        // on a finished book (104747.898 vs 104747.180).
        const [entry] = build([row({ position_ms: BOOK_MS + 60_000 })]);
        expect(entry.description).toContain('"percent":100');
    });
});

describe('audiobook listening rows — finished', () => {
    it('renders a finished book distinctly, not as a position of 0', () => {
        const [entry] = build([
            row({
                position_ms: 0,
                is_finished: true,
                finished_recently: true,
                times_finished: 1,
            }),
        ]);

        expect(entry.finished).toBe(true);
        expect(entry.recentlyFinished).toBe(true);
        expect(entry.timesFinished).toBe(1);
        expect(entry.positionMs).toBeUndefined();
        expect(entry.chapterTitle).toBeUndefined();
        expect(entry.description).toBe('social_listen_finished({"name":"Anna"})');
    });

    it('counts re-listens', () => {
        const [entry] = build([row({ position_ms: 0, is_finished: true, times_finished: 3 })]);
        expect(entry.description).toBe('social_listen_finished_times({"name":"Anna","count":3})');
    });

    it('never says "0×" when a watched row has no counted completion', () => {
        const [entry] = build([row({ position_ms: 0, is_finished: true, times_finished: 0 })]);

        expect(entry.timesFinished).toBeUndefined();
        expect(entry.description).toBe('social_listen_finished({"name":"Anna"})');
    });

    it('keeps reporting the position of someone re-listening', () => {
        // is_watched = true AND a position: finished once, started again. Collapsing
        // this to "has listened to this" would drop the live half of the row.
        const [entry] = build([
            row({ position_ms: 700_000, is_finished: true, times_finished: 1 }),
        ]);

        expect(entry.finished).toBe(true);
        expect(entry.timesFinished).toBe(1);
        expect(entry.positionMs).toBe(700_000);
        expect(entry.description).toContain('social_listen_chapter_percent');
    });
});

describe('audiobook listening rows — shared listen (§4.2)', () => {
    const viewerAtChapterOne = row({
        user_id: 'u-me',
        username: 'me',
        position_ms: 100_000,
    });

    it('detects both sides mid-book and reports the chapter gap', () => {
        const [entry] = build([row({ position_ms: 1_300_000 })], viewerAtChapterOne);

        expect(entry.sharedListen).toBe(true);
        expect(entry.chapterDelta).toBe(2);
        expect(entry.positionDeltaMs).toBe(1_200_000);
        expect(entry.description).toBe(
            'social_listen_shared_ahead_timed({"name":"Anna","count":2,"time":"time_minutes_abbr({\\"minutes\\":20})"})',
        );
    });

    it('uses the singular wording for exactly one chapter', () => {
        const [entry] = build([row({ position_ms: 700_000 })], viewerAtChapterOne);
        expect(entry.chapterDelta).toBe(1);
        expect(entry.description).toBe(
            'social_listen_shared_ahead_one_timed({"name":"Anna","time":"time_minutes_abbr({\\"minutes\\":10})"})',
        );
    });

    it('signs the delta the other way when the other person is behind', () => {
        const [entry] = build(
            [row({ position_ms: 100_000 })],
            row({ user_id: 'u-me', username: 'me', position_ms: 1_300_000 }),
        );

        expect(entry.chapterDelta).toBe(-2);
        expect(entry.positionDeltaMs).toBe(-1_200_000);
        expect(entry.description).toBe(
            'social_listen_shared_behind_timed({"name":"Anna","count":2,"time":"time_minutes_abbr({\\"minutes\\":20})"})',
        );
    });

    it('uses the singular wording one chapter behind', () => {
        const [entry] = build(
            [row({ position_ms: 100_000 })],
            row({ user_id: 'u-me', username: 'me', position_ms: 700_000 }),
        );
        expect(entry.description).toBe(
            'social_listen_shared_behind_one_timed({"name":"Anna","time":"time_minutes_abbr({\\"minutes\\":10})"})',
        );
    });

    it('says "same chapter" rather than "0 chapters ahead"', () => {
        const [entry] = build([row({ position_ms: 200_000 })], viewerAtChapterOne);

        expect(entry.chapterDelta).toBe(0);
        expect(entry.description).toBe('social_listen_shared_together({"name":"Anna"})');
    });

    it('still detects a shared listen on a book with no chapters', () => {
        // 129 of 1188 books. positionDeltaMs is the only comparison available, and
        // without it the shared-listen upgrade would silently never fire on them.
        const [entry] = build([row({ position_ms: 700_000 })], viewerAtChapterOne, {
            chapters: [],
        });

        expect(entry.sharedListen).toBe(true);
        expect(entry.chapterDelta).toBeUndefined();
        expect(entry.positionDeltaMs).toBe(600_000);
        // No chapters, so time is the ONLY comparison there is — which makes it
        // more valuable here than anywhere else, not less.
        expect(entry.description).toBe(
            'social_listen_shared_ahead_time_only({"name":"Anna","time":"time_minutes_abbr({\\"minutes\\":10})"})',
        );
    });

    it('drops the time when the gap is under a minute', () => {
        // "48 chapters / 0m ahead" reads as a bug. Below a minute the chapter
        // count already says everything true, so the time is left off entirely
        // rather than rounded into a claim.
        // Straddling a chapter boundary 20s apart: a real chapter gap, but no
        // time gap worth naming.
        const [entry] = build(
            [row({ position_ms: 610_000 })],
            row({ user_id: 'u-me', username: 'me', position_ms: 590_000 }),
        );

        expect(entry.positionDeltaMs).toBe(20_000);
        expect(entry.chapterDelta).toBe(1);
        expect(entry.description).toBe('social_listen_shared_ahead_one({"name":"Anna"})');
    });

    it('says nothing at all when a sub-minute gap has no chapter gap either', () => {
        const [entry] = build(
            [row({ position_ms: 630_000 })],
            row({ user_id: 'u-me', username: 'me', position_ms: 600_000 }),
            { chapters: [] },
        );

        expect(entry.sharedListen).toBe(true);
        expect(entry.description).toBe('social_listen_shared({"name":"Anna"})');
    });

    it('carries hours into the wording for a long gap', () => {
        // The case that prompted this: a chapter count alone cannot distinguish
        // 48 short chapters from 48 long ones.
        const [entry] = build([row({ position_ms: 9_000_000 })], viewerAtChapterOne, {
            chapters: [],
        });

        expect(entry.description).toBe(
            'social_listen_shared_ahead_time_only({"name":"Anna","time":"time_hours_abbr({\\"hours\\":2}) time_minutes_abbr({\\"minutes\\":28})"})',
        );
    });

    it('is not a shared listen when the viewer has only FINISHED the book', () => {
        // The viewer's row exists and reads position 0 — the measured shape of a
        // finished book. Treating "has a row" as "is listening" would claim a shared
        // listen with someone who read it last year.
        const viewerFinished = row({
            user_id: 'u-me',
            username: 'me',
            position_ms: 0,
            is_finished: true,
            times_finished: 1,
        });
        const [entry] = build([row({ position_ms: 700_000 })], viewerFinished);

        expect(entry.sharedListen).toBeUndefined();
        expect(entry.chapterDelta).toBeUndefined();
        expect(entry.positionDeltaMs).toBeUndefined();
        expect(entry.description).toContain('social_listen_chapter_percent');
    });

    it('is not a shared listen when the viewer has no row at all', () => {
        const [entry] = build([row({ position_ms: 700_000 })], null);
        expect(entry.sharedListen).toBeUndefined();
    });
});

describe('audiobook listening rows — no clock times, at any tier', () => {
    /**
     * The design doc's hardest rule: "Never clock times, at any tier — the harm
     * lives in recency and precision, not position." The row type carries no
     * timestamp, so this asserts the projection did not invent one and cannot start
     * forwarding one without failing here.
     */
    it('emits only the declared fields, and none of them is a time', () => {
        const allowed = new Set([
            'userId',
            'description',
            'positionMs',
            'durationMs',
            'chapterTitle',
            'chapterIndex',
            'chapterCount',
            'finished',
            'recentlyFinished',
            'timesFinished',
            'sharedListen',
            'chapterDelta',
            'positionDeltaMs',
            'listenedOn',
        ]);
        const entries = build(
            [
                row({ position_ms: 700_000, listened_on: '2026-09-27' }),
                row({ user_id: 'u-b', username: 'bea', is_finished: true, times_finished: 2 }),
            ],
            row({ user_id: 'u-me', username: 'me', position_ms: 100_000 }),
        );

        for (const entry of entries) {
            for (const key of Object.keys(entry)) {
                expect(allowed.has(key), `unexpected field ${key}`).toBe(true);
            }
            for (const [key, value] of Object.entries(entry)) {
                expect(value instanceof Date).toBe(false);
                if (typeof value !== 'string') continue;
                // No h:mm anywhere in the payload.
                expect(value).not.toMatch(/\d{1,2}:\d{2}/);
                if (key === 'listenedOn') {
                    // The one recency field is a bare calendar date.
                    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
                } else {
                    // And no date hides anywhere else.
                    expect(value).not.toMatch(/\d{4}-\d{2}-\d{2}/);
                }
            }
        }
    });

    it('forwards the reciprocal-tier day, and omits it when the query withheld it', () => {
        const [shared, withheld] = build([
            row({ position_ms: 700_000, listened_on: '2026-09-27' }),
            row({ user_id: 'u-b', username: 'bea', position_ms: 100_000, listened_on: null }),
        ]);
        expect(shared.listenedOn).toBe('2026-09-27');
        expect('listenedOn' in withheld).toBe(false);
    });

    it('keeps the query order — it does not re-sort by anything', () => {
        const entries = build([
            row({ user_id: 'u-1', username: 'zoe', position_ms: 100_000 }),
            row({ user_id: 'u-2', username: 'adam', position_ms: 200_000 }),
        ]);
        expect(entries.map((e) => e.userId)).toEqual(['u-1', 'u-2']);
    });
});

describe('audiobook listening public names', () => {
    it.each(['Public Listener', null])('uses display name %s without the login handle', (name) => {
        const [entry] = buildAudiobookListeningEntries({
            rows: [row({ username: 'private-login', position_ms: 700_000 })],
            displayNameFor: () => name,
            viewer: null,
            chapters: CHAPTERS,
            bookDurationMs: BOOK_MS,
        });
        expect(entry.description).toContain(`"name":"${name ?? 'Someone'}"`);
        expect(JSON.stringify(entry)).not.toContain('private-login');
        expect(entry).not.toHaveProperty('username');
    });
});
