// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audiobook listening rows — the projection behind the modal's social section
 * (design doc `2026-07-28-audiobook-social-design.md` §4.1 and §4.2).
 *
 * Turns the per-user `user_media_state` rows the trust-circle predicate returned
 * into the wire fields `SocialActivityItemSchema` declares, plus the one-line
 * copy the modal renders.
 *
 * ## A pure function, on purpose
 *
 * Everything here is arithmetic over already-fetched rows, and the parts that go
 * wrong are the arithmetic: a finished book sitting at position 0, a book with no
 * chapters, a duration nobody reported, a chapter delta whose sign flips. Those
 * are exactly the cases a DB-backed test states badly and a table-driven unit
 * test states well, so the whole projection is separated from the endpoint and
 * takes rows as input.
 *
 * ## What it must never do
 *
 * Emit a time. Not a timestamp, not "3 hours ago", not "listened at 03:12". The
 * design doc bans clock times at every tier ("the harm lives in recency and
 * precision, not position"), and the row type it consumes carries no timestamp at
 * all, so the only way to break that is to add one on purpose.
 *
 * The one recency field, `listenedOn`, is a calendar date the query already
 * truncated, and the query fills it only for the reciprocal activity tier. This
 * module forwards it untouched and never derives anything finer from it.
 */

import type { AudiobookListeningRow } from '$lib/server/database/queries/social-activity.queries.js';
import {
    buildChapterSpans,
    findChapterSpanAt,
    type AbsChapterInput,
    type AudiobookChapterSpan,
} from '$lib/utils/audiobook-timeline.js';
import * as m from '$lib/paraglide/messages.js';
import { formatDurationHoursMinutes } from '$lib/utils/time-formatting.js';

/**
 * The audiobook-specific optional fields of `SocialActivityItemSchema`.
 *
 * Every one is optional and every one is genuinely absent in a measured case:
 * no chapters (129 of 1188 books in the reference library), no duration reported,
 * the viewer is not listening, the person only finished it and is not mid-book.
 */
export interface AudiobookListeningFields {
    positionMs?: number;
    durationMs?: number;
    chapterTitle?: string;
    chapterIndex?: number;
    chapterCount?: number;
    finished?: boolean;
    /** True when the completion is recent enough for a timeline endpoint marker. */
    recentlyFinished?: boolean;
    timesFinished?: number;
    sharedListen?: boolean;
    chapterDelta?: number;
    positionDeltaMs?: number;
    /** Calendar day of this person's latest activity; reciprocal tier only. */
    listenedOn?: string;
}

/** One person's line in the section: the copy plus the structured fields. */
export interface AudiobookListeningEntry extends AudiobookListeningFields {
    userId: string;
    description: string;
}

export interface AudiobookListeningInput {
    /** Other people's rows, already filtered by the trust-circle predicate. */
    rows: readonly AudiobookListeningRow[];
    /** Public display names only; never resolve a login handle here. */
    displayNameFor: (userId: string) => string | null;
    /** The viewer's own row, or null when they have not opened the book. */
    viewer: AudiobookListeningRow | null;
    /** The book's ABS chapter list, in ABS's own units (SECONDS). */
    chapters: readonly AbsChapterInput[];
    /** `custom_metadata.audiobookshelf.duration` in ms, or null when unknown. */
    bookDurationMs: number | null;
}

/**
 * Build one entry per row.
 *
 * @returns entries in the input order (recency, as the query ordered them)
 */
export function buildAudiobookListeningEntries(
    input: AudiobookListeningInput,
): AudiobookListeningEntry[] {
    const effectiveDuration = resolveBookDuration(input);
    const spans = buildChapterSpans(input.chapters, effectiveDuration, {
        // Books whose chapter list stops early get a final span for the
        // remainder; without a title it would read as the English default.
        untaggedTailTitle: m.audiobook_chapter_untagged_tail(),
    });

    const viewerPosition = inProgressPosition(input.viewer);
    const viewerChapter = viewerPosition === null ? null : findChapterSpanAt(spans, viewerPosition);

    return input.rows.map((row) =>
        buildEntry(row, {
            firstName: input.displayNameFor(row.user_id) ?? m.social_someone(),
            spans,
            effectiveDuration,
            viewerPosition,
            viewerChapter,
        }),
    );
}

interface EntryContext {
    firstName: string;
    spans: AudiobookChapterSpan[];
    effectiveDuration: number;
    viewerPosition: number | null;
    viewerChapter: AudiobookChapterSpan | null;
}

function buildEntry(row: AudiobookListeningRow, ctx: EntryContext): AudiobookListeningEntry {
    const firstName = ctx.firstName;
    const fields: AudiobookListeningFields = {};

    // Per-row duration first (whichever client last reported for THIS listener),
    // then the book's own. Either can be missing, which only costs a percentage.
    const durationMs =
        row.duration_ms && row.duration_ms > 0 ? row.duration_ms : ctx.effectiveDuration;
    if (durationMs > 0) fields.durationMs = durationMs;

    if (row.is_finished) {
        fields.finished = true;
        if (row.finished_recently) fields.recentlyFinished = true;
        // watch_count is `snapshot + positives - negatives` and can legitimately
        // be 0 on a row marked watched by a source that emitted no completion.
        // Reporting "0× gehört" would be worse than reporting nothing.
        if (row.times_finished > 0) fields.timesFinished = row.times_finished;
    }

    if (row.listened_on) fields.listenedOn = row.listened_on;

    const position = inProgressPosition(row);
    const chapter = position === null ? null : findChapterSpanAt(ctx.spans, position);

    if (position !== null) {
        fields.positionMs = position;
        if (ctx.spans.length > 0) fields.chapterCount = ctx.spans.length;
        if (chapter) {
            fields.chapterIndex = chapter.index;
            fields.chapterTitle = chapter.title;
        }
    }

    // Shared listen: both sides mid-book. §4.2 — "no pairing ceremony, no new
    // data", it falls out of the two rows already in hand.
    const shared = position !== null && ctx.viewerPosition !== null;
    if (shared) {
        fields.sharedListen = true;
        fields.positionDeltaMs = position - ctx.viewerPosition!;
        if (chapter && ctx.viewerChapter) {
            fields.chapterDelta = chapter.index - ctx.viewerChapter.index;
        }
    }

    return {
        userId: row.user_id,
        description: describe({ row, fields, firstName, shared, position, durationMs }),
        ...fields,
    };
}

interface DescribeInput {
    row: AudiobookListeningRow;
    fields: AudiobookListeningFields;
    firstName: string;
    shared: boolean;
    position: number | null;
    durationMs: number;
}

/**
 * The one line the modal shows.
 *
 * Ordering of the branches is the design: shared-listen is the highest-value
 * statement ("the only social feature that could not exist for film"), a finished
 * book "renders distinctly, not as 100%, Kapitel 45", and only then does the
 * plain position line apply. Wording says *"is at"*, never *"is listening to"* —
 * the position is a mirrored projection that may lag or move backwards, so
 * claiming presence would be a claim the data cannot support.
 */
/** A minute is the floor: below it the formatter renders "0m", which reads as a
 * bug rather than a distance, and the chapter count already says more. */
const MIN_REPORTABLE_DELTA_MS = 60_000;

/**
 * The absolute time gap between two listeners, or null when it is not worth
 * saying. Sign lives with the caller — the copy differs by direction.
 */
function aheadTime(positionDeltaMs: number | undefined): string | null {
    if (positionDeltaMs === undefined) return null;
    const magnitude = Math.abs(positionDeltaMs);
    if (magnitude < MIN_REPORTABLE_DELTA_MS) return null;
    return formatDurationHoursMinutes(Math.round(magnitude / 1000));
}

function describe(input: DescribeInput): string {
    const { fields, firstName, shared, position, durationMs } = input;

    if (shared) {
        const delta = fields.chapterDelta;
        // "48 chapters" is a poor unit on its own: chapters run from 90 seconds
        // to an hour, so the same count means wildly different distances. The
        // time delta is the one both listeners actually feel.
        const time = aheadTime(fields.positionDeltaMs);
        if (delta === undefined) {
            // No chapter list (129 of 1188 books in the reference library), so
            // time is the ONLY comparison available — worth more here than
            // anywhere else.
            if (time === null) return m.social_listen_shared({ name: firstName });
            return (fields.positionDeltaMs ?? 0) > 0
                ? m.social_listen_shared_ahead_time_only({ name: firstName, time })
                : m.social_listen_shared_behind_time_only({ name: firstName, time });
        }
        if (delta === 0) return m.social_listen_shared_together({ name: firstName });
        const chapters = Math.abs(delta);
        if (delta > 0) {
            if (time === null) {
                return chapters === 1
                    ? m.social_listen_shared_ahead_one({ name: firstName })
                    : m.social_listen_shared_ahead({ name: firstName, count: chapters });
            }
            return chapters === 1
                ? m.social_listen_shared_ahead_one_timed({ name: firstName, time })
                : m.social_listen_shared_ahead_timed({ name: firstName, count: chapters, time });
        }
        if (time === null) {
            return chapters === 1
                ? m.social_listen_shared_behind_one({ name: firstName })
                : m.social_listen_shared_behind({ name: firstName, count: chapters });
        }
        return chapters === 1
            ? m.social_listen_shared_behind_one_timed({ name: firstName, time })
            : m.social_listen_shared_behind_timed({ name: firstName, count: chapters, time });
    }

    // Finished and not currently mid-book. Measured: a finished book reads
    // resume_position_ms = 0, so this is the ordinary shape of "has read it" —
    // rendering it as the position line would say "is at 0%".
    if (position === null) {
        if (fields.finished) {
            const times = fields.timesFinished ?? 0;
            return times > 1
                ? m.social_listen_finished_times({ name: firstName, count: times })
                : m.social_listen_finished({ name: firstName });
        }
        // No position and not finished cannot happen through the query (its row
        // filter is `resume_position_ms > 0 OR is_watched`), but the projection is
        // called with rows, and "started it" is the honest statement for a row
        // that says nothing else.
        return m.social_listen_started({ name: firstName });
    }

    const percent = durationMs > 0 ? clampPercent((position / durationMs) * 100) : null;

    if (fields.chapterTitle !== undefined) {
        return percent === null
            ? m.social_listen_chapter({ name: firstName, chapter: fields.chapterTitle })
            : m.social_listen_chapter_percent({
                  name: firstName,
                  chapter: fields.chapterTitle,
                  percent,
              });
    }

    if (percent === null) return m.social_listen_started({ name: firstName });
    return m.social_listen_percent({ name: firstName, percent });
}

/**
 * The position to report, or null when there is nothing to report.
 *
 * A row can be finished (`is_watched`) AND carry a position — that is a
 * re-listen, and the rebuilder no longer zeroes `resume_position_ms` on a watched
 * row (verified: a `mark_watched` followed by a later `progress` leaves
 * `resume_position_ms` at the reported value). So "finished" is not a reason to
 * suppress the position; a position of 0 is.
 */
function inProgressPosition(row: AudiobookListeningRow | null): number | null {
    if (!row) return null;
    if (row.position_ms <= 0) return null;
    return row.position_ms;
}

/**
 * The book duration every listener is measured against.
 *
 * The book's own `duration` when ABS reported one; otherwise the largest
 * per-listener `runtime_ms` in hand. The fallback matters because chapter spans
 * need an upper bound for the FINAL chapter — without one the last chapter of a
 * book whose entries carry no `end` is dropped, and everyone listening to the end
 * of the book reports the second-to-last chapter.
 */
function resolveBookDuration(input: AudiobookListeningInput): number {
    if (input.bookDurationMs !== null && input.bookDurationMs > 0) return input.bookDurationMs;
    let max = 0;
    for (const row of [...input.rows, ...(input.viewer ? [input.viewer] : [])]) {
        if (row.duration_ms !== null && row.duration_ms > max) max = row.duration_ms;
    }
    return max;
}

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, Math.round(value)));
}
