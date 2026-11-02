// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The audiobook virtual timeline — one position, three readings.
 *
 * A book is a single continuous 15–40 hour thing to the listener, a list of
 * files to the backend, and a list of chapters to the scrubber. Exactly one of
 * those is the source of truth here (book time, ms from the start of the book);
 * the other two are derived.
 *
 * ```
 * bookMs ─┬─→ file    = the last track whose startOffsetMs <= bookMs
 *         ├─→ fileMs  = bookMs - track.startOffsetMs      (what the backend is told)
 *         └─→ chapter = the chapter containing bookMs     (what the scrubber shows)
 * ```
 *
 * ## Units, because they have bitten this integration repeatedly
 *
 * AudiobookShelf reports `startOffset` and `duration` on `audioTracks[]` in
 * **seconds as floats**, and chapters' `start`/`end` likewise — while
 * `lastUpdate`/`startedAt`/`finishedAt` elsewhere in the same API are epoch
 * **milliseconds**. Everything in this module is milliseconds; conversion
 * happens once, in {@link buildAudiobookTimeline}, and nowhere else.
 *
 * ## Why the offsets are not re-derived
 *
 * `startOffset` comes from the server accumulated
 * (`audiobookshelf/server/models/Book.js`), and is used as given. Re-deriving
 * it by summing durations would drift: the values are floats, a 228-file book
 * accumulates 227 additions of rounding error, and one track with a null
 * duration would silently shift every file after it.
 */

import type {
    AudiobookPlaybackChapter,
    AudiobookPlaybackTrack,
} from '$lib/schemas/api-audiobook-session';

/** One audio file, as the player needs it. */
export interface AudiobookTrack {
    /** ABS `audioTracks[].index` — 1-based on the live payload. */
    index: number;
    /**
     * AudiobookShelf addresses files by inode.
     *
     * **Null on a transcode session's single synthetic track**, which stands for
     * the whole book and is fetched as an HLS playlist rather than as a file.
     * Callers that build a file URL are on the direct-play path by construction
     * and must still guard: a null here means "there is no file to fetch", not
     * "fetch file null".
     */
    ino: string | null;
    url?: string;
    remuxUrl?: string;
    /** Accumulated offset of this file from the start of the book, ms. */
    startOffsetMs: number;
    /** Duration of this file, ms. */
    durationMs: number;
    /** Exclusive end of this file in book time, ms. */
    endOffsetMs: number;
    mimeType: string | null;
    codec: string | null;
    /** Display name, used only by the synthetic-chapter fallback. */
    title: string | null;
    /**
     * The SERVER's verdict that this file needs a Lumastra remux, derived from the
     * persisted per-file codec rather than the container MIME type AudiobookShelf
     * negotiated on.
     *
     * Carried through the timeline on purpose. It arrives on the session payload,
     * and the player decides which URL to fetch from the timeline — so a
     * projection that dropped it would leave the server's only statement about
     * decodability unread, and the client back to guessing from a codec string
     * that is `null` on a transcode session's synthetic track.
     *
     * Not an instruction: whether it MATTERS is the engine's own `canPlayType`
     * answer (WebKit decodes E-AC-3 natively). See `trackNeedsRemux`.
     */
    needsRemux: boolean;
}

/** One chapter in book time. */
export interface AudiobookChapterSpan {
    /** Position in the chapter list, 0-based. */
    index: number;
    title: string;
    startMs: number;
    /** Exclusive end, ms. */
    endMs: number;
    /**
     * True when this chapter was invented from the file list because the book
     * carries none. Surfaces in the UI as "Teil N" rather than a real title.
     */
    synthetic: boolean;
    /**
     * True for the ONE span that is not a chapter at all: the stretch of book
     * lying past the end of AudiobookShelf's chapter list.
     *
     * Optional because it is absent on every ordinary chapter and on every
     * synthesised part — `untagged === undefined` and `untagged === false` mean
     * the same thing, and requiring it would only add a `false` to every
     * literal that builds a span.
     *
     * A UI that shows chapter titles should substitute its own localised label
     * here rather than printing {@link normalizeChapters}'s English default, and
     * should keep this span out of any title-cleanup pass — `formatChapterLabels`
     * strips the prefix EVERY title shares, and one foreign label among 555
     * uniform ones collapses that shared prefix to nothing.
     */
    untagged?: boolean;
}

export interface AudiobookTimeline {
    tracks: AudiobookTrack[];
    chapters: AudiobookChapterSpan[];
    /** Total book duration, ms. */
    durationMs: number;
    /** True when {@link chapters} was synthesised from the file list. */
    chaptersAreSynthetic: boolean;
}

/** The raw ABS shapes this module accepts, in ABS's own units (seconds). */
export interface AbsAudioTrackInput {
    index?: number | null;
    ino?: string | null;
    url?: string;
    remuxUrl?: string;
    startOffset?: number | null;
    duration?: number | null;
    mimeType?: string | null;
    codec?: string | null;
    title?: string | null;
    /** The server's persisted-codec verdict; absent on an older payload. */
    needsRemux?: boolean | null;
}

export interface AbsChapterInput {
    id?: number | null;
    title?: string | null;
    start?: number | null;
    end?: number | null;
    /**
     * The SERVER's statement that it invented this entry — the stretch of book
     * past the end of AudiobookShelf's chapter list.
     *
     * Absent from AudiobookShelf's own payload and from an older Lumastra
     * server, in which case the tail is inferred here exactly as before.
     *
     * Load-bearing rather than a convenience: normalisation fills in the very
     * gap this module infers a tail FROM, so once the server has normalised,
     * the flag is the only surviving evidence (measured on Starhaven — identical
     * geometry, `untagged` 1 → 0). Without it the tail loses its localised
     * label and rejoins the title-cleanup pass it must stay out of.
     */
    synthetic?: boolean | null;
}

export interface BuildTimelineOptions {
    /**
     * Label for a synthesised chapter. Receives the 1-based part number.
     * Defaults to English; the player passes a localised formatter.
     */
    synthesizeChapterTitle?: (partNumber: number, track: AudiobookTrack) => string;
    /**
     * Total book duration in ms, from the session payload's own `duration`.
     *
     * Load-bearing for exactly one case: the LAST track has a null duration
     * (AudiobookShelf could not probe it) and there is no following track to
     * derive its length from. Without the hint that track is zero-length, the
     * book's total stops short of its real end, and `clampBookMs` then pins the
     * scrubber and every progress report to a position the listener has already
     * played past.
     */
    totalDurationMs?: number;
    /**
     * Label for the untagged-tail span ({@link AudiobookChapterSpan.untagged}).
     * Defaults to English; callers that render it pass a localised string.
     */
    untaggedTailTitle?: string;
}

const secToMs = (seconds: number | null | undefined): number =>
    typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : 0;

/**
 * How much unlabelled audio at the end of a book earns its own span.
 *
 * Below this the tail is absorbed into the final chapter exactly as it always
 * was. Measured across 1060 books with chapter lists, the tails fall into two
 * populations with nothing in between: two books short by 1.9 s and 2.6 s —
 * float rounding, and a two-second row in the chapter list would be noise — and
 * seven short by 16 minutes to 18 hours, which is content. A minute sits in the
 * empty middle, and is also the point below which there is nothing a listener
 * would navigate TO.
 *
 * Deliberately absolute rather than a fraction of the book: 22 minutes of
 * unlabelled audio is worth reaching whether it trails a 3-hour book or a
 * 40-hour one, and a fraction would hide the second case.
 */
export const UNTAGGED_TAIL_MIN_MS = 60_000;

/** English fallback for {@link AudiobookChapterSpan.untagged}. */
const DEFAULT_UNTAGGED_TAIL_TITLE = 'After the last chapter';

/**
 * Build the timeline from an ABS play-session payload.
 *
 * Tolerates the two things the live server actually does: tracks arriving out
 * of order (sorted by `startOffset`, not by `index`), and a null `duration` on
 * a file ABS could not probe (the gap to the next track's offset is used
 * instead, so the timeline stays contiguous).
 */
export function buildAudiobookTimeline(
    absTracks: readonly AbsAudioTrackInput[],
    absChapters: readonly AbsChapterInput[] | null | undefined,
    options: BuildTimelineOptions = {},
): AudiobookTimeline {
    // A track is usable if it can be ADDRESSED (it has an inode) or if it has a
    // length of its own (the whole-book synthetic track of a transcode session,
    // which has no inode because it is served as an HLS playlist).
    //
    // The filter used to require an inode outright, and that quietly emptied the
    // timeline for every transcode session: `durationMs` fell to 0, `clampBookMs`
    // pinned every position to 0, and the player reported position 0 into
    // AudiobookShelf's last-write-wins progress row — losing the listener's place
    // in the book. Nothing caught it because the transcode tests built their
    // fixtures from the DIRECT-play track list with the method flag flipped, so
    // their tracks all had inodes.
    const ordered = [...absTracks]
        .filter((t) => {
            const addressable = Boolean(t.url) || (typeof t.ino === 'string' && t.ino !== '');
            const hasOwnLength = typeof t.duration === 'number' && t.duration > 0;
            return addressable || hasOwnLength;
        })
        .sort((a, b) => secToMs(a.startOffset) - secToMs(b.startOffset));

    const tracks: AudiobookTrack[] = ordered.map((raw, i) => {
        const startOffsetMs = secToMs(raw.startOffset);
        const next = ordered[i + 1];
        const declared = secToMs(raw.duration);
        // A probe failure leaves duration null. The distance to the next
        // track's offset is the only other statement of this file's length the
        // payload makes, and using it keeps the book contiguous.
        const durationMs =
            declared > 0
                ? declared
                : next
                  ? Math.max(0, secToMs(next.startOffset) - startOffsetMs)
                  : 0;
        return {
            index: typeof raw.index === 'number' ? raw.index : i + 1,
            ino: typeof raw.ino === 'string' && raw.ino !== '' ? raw.ino : null,
            url: raw.url,
            remuxUrl: raw.remuxUrl,
            startOffsetMs,
            durationMs,
            endOffsetMs: startOffsetMs + durationMs,
            mimeType: raw.mimeType ?? null,
            codec: raw.codec ?? null,
            title: raw.title ?? null,
            needsRemux: raw.needsRemux === true,
        };
    });

    // Extend the final track when it was unprobed and the payload told us the
    // book's real length. Only ever extends: a hint SHORTER than the tracks
    // themselves is the less trustworthy of the two numbers.
    const last = tracks[tracks.length - 1];
    if (last && last.durationMs === 0 && (options.totalDurationMs ?? 0) > last.startOffsetMs) {
        last.durationMs = options.totalDurationMs! - last.startOffsetMs;
        last.endOffsetMs = options.totalDurationMs!;
    }

    const durationMs = tracks.length > 0 ? tracks[tracks.length - 1].endOffsetMs : 0;

    const real = normalizeChapters(absChapters ?? [], durationMs, options.untaggedTailTitle);
    if (real.length > 0) {
        return { tracks, chapters: real, durationMs, chaptersAreSynthetic: false };
    }

    return {
        tracks,
        chapters: synthesizeChapters(tracks, options.synthesizeChapterTitle),
        durationMs,
        chaptersAreSynthetic: true,
    };
}

/**
 * Chapter spans from a STORED ABS chapter list plus a known book duration.
 *
 * The player builds its chapters through {@link buildAudiobookTimeline}, which
 * needs the play session's `audioTracks[]`. Server-side readers — the social
 * listening rows, which turn another user's `resume_position_ms` into "is at
 * Kapitel 12" — have `custom_metadata.audiobookshelf.chapters` and a duration
 * and no track list at all, because the stored per-file metadata carries no
 * `startOffset` to accumulate.
 *
 * Exported rather than reimplemented so both readers land on the same chapter
 * for the same position. A second implementation would drift on exactly the
 * malformed data this one is shaped for (duplicate starts, a first chapter that
 * begins late, `end` disagreeing with the next `start`).
 *
 * Returns `[]` for a book with no chapters — 129 of 1188 books in the reference
 * library, so callers must treat "no chapter" as normal, not as an error. There
 * is deliberately NO synthetic fallback here: synthesising "Teil N" needs the
 * file list this caller does not have.
 */
export function buildChapterSpans(
    absChapters: readonly AbsChapterInput[] | null | undefined,
    durationMs: number,
    options: { untaggedTailTitle?: string } = {},
): AudiobookChapterSpan[] {
    return normalizeChapters(absChapters ?? [], Math.max(0, durationMs), options.untaggedTailTitle);
}

/**
 * The span covering `positionMs` in an already-built span list.
 *
 * Same backward-scan and same boundary rule as {@link findChapterAt} — this is
 * the body of that function, minus the timeline clamp, so a caller holding bare
 * spans cannot pick a different chapter than the player would.
 */
export function findChapterSpanAt(
    chapters: readonly AudiobookChapterSpan[],
    positionMs: number,
): AudiobookChapterSpan | null {
    if (chapters.length === 0) return null;
    for (let i = chapters.length - 1; i >= 0; i--) {
        if (positionMs >= chapters[i].startMs) return chapters[i];
    }
    return chapters[0];
}

/**
 * Turn ABS chapters into contiguous book-time spans covering `[0, durationMs]`.
 *
 * **Only `start` is trusted, except at the very end.** Each span runs to the
 * NEXT chapter's start. That is deliberate: `findChapterAt` returns null inside
 * a hole, and a null chapter breaks the chapter-scoped scrubber, prev/next and
 * the lock-screen label all at once. Extending a chapter across the silence
 * before the next one is the better answer for a scrubber that must never go
 * blank.
 *
 * On the live server `end` already equals the next `start` exactly (verified on
 * a real 5-chapter book), so this rule changes nothing for well-formed data and
 * only rescues the malformed case.
 *
 * ## The final chapter, and what lies past it
 *
 * The last chapter has no next start to run to, so its own `end` is used — and
 * on 7 of 1060 books in the reference library that `end` falls well short of
 * the book's duration: Milo Farrow and the Keeper of Starhaven (Simon Vale)
 * by 16m52s, Stormrage by 18h49m. The audio is there and playable; ABS's
 * chapter list simply stops describing it.
 *
 * That leftover becomes its own span, flagged {@link AudiobookChapterSpan.untagged}.
 * The two alternatives are both worse:
 *
 * - **Stretch the last chapter to the end of the book** (what this did until
 *   2026-08-20). Coverage is preserved, but a 28-second "Conclusion" is
 *   reported as 17 minutes long, so the chapter-scoped scrubber — the audiobook
 *   player's primary seek control — is scaled to a length that does not exist,
 *   and the chapter list offers no row to reach the tail with at all. On
 *   Stormrage one "chapter" swallows 80% of the book.
 * - **Leave a hole.** `findChapterSpanAt` scans backwards and would answer with
 *   the last chapter anyway, but `chapterProgress` clamps into that chapter's
 *   length — so the scrubber sits pinned at 100% for the whole tail and
 *   dragging it throws the listener backwards.
 *
 * A tail shorter than {@link UNTAGGED_TAIL_MIN_MS} is still absorbed, because
 * at that scale it is float rounding rather than content. A NEGATIVE tail —
 * chapters running past the reported duration, which 3 books do, two of them
 * with a `duration` of ~190 s against a 1.5-hour chapter list — means the
 * duration is the broken number and nothing is added.
 *
 * Mid-book holes are deliberately NOT given spans: the same survey found zero
 * holes over a minute BETWEEN chapters across the whole library, so absorbing
 * them into the preceding chapter stays the right trade.
 */
function normalizeChapters(
    absChapters: readonly AbsChapterInput[],
    durationMs: number,
    untaggedTailTitle: string = DEFAULT_UNTAGGED_TAIL_TITLE,
): AudiobookChapterSpan[] {
    const ordered = [...absChapters]
        // An entry with no numeric `start` is DROPPED, not defaulted to 0.
        // `secToMs(null)` is 0, which sorts such an entry to the front of the book
        // and — because the duplicate-start rule below keeps the FIRST of a run —
        // evicts the real opening chapter and shifts every reported chapter by one.
        // `projectAbsChapters` filters these out on the play-session path, so this
        // was unreachable from the player; the stored-metadata readers reach
        // `buildChapterSpans` directly, and both paths want the same answer.
        .filter((c) => typeof c.start === 'number' && Number.isFinite(c.start))
        .map((c) => ({
            startMs: secToMs(c.start),
            endMs: secToMs(c.end),
            title: c.title ?? '',
            synthetic: c.synthetic === true,
        }))
        .sort((a, b) => a.startMs - b.startMs)
        // A chapter starting at or past the end of the audio describes audio the
        // library does not have, and `clampBookMs` makes it permanently
        // unreachable — see the doc block above. A `durationMs` of 0 means "not
        // known", not "no audio", and must not erase anything.
        .filter((c) => durationMs <= 0 || c.startMs < durationMs);

    const spans: AudiobookChapterSpan[] = [];
    for (let i = 0; i < ordered.length; i++) {
        const c = ordered[i];
        // Emit only the FIRST entry of a duplicate-start run. Emitting all of
        // them produces identical spans, and `findChapterAt` scans backwards —
        // so the earlier ones become unreachable and next/previous silently
        // cycles between indistinguishable chapters.
        if (i > 0 && ordered[i - 1].startMs === c.startMs) continue;

        // The next DISTINCT start bounds this span.
        let nextStart = 0;
        let hasNext = false;
        for (let j = i + 1; j < ordered.length; j++) {
            if (ordered[j].startMs > c.startMs) {
                nextStart = ordered[j].startMs;
                hasNext = true;
                break;
            }
        }
        // The final chapter has no next start, so ABS's own `end` is the only
        // statement of where it stops. Falling back to the book's duration
        // keeps a chapter with no usable `end` from being dropped outright.
        //
        // Unless the duration is unknown too, which is a state this function
        // explicitly supports (see the filter above). Then that fallback is 0,
        // the zero-length guard below fires, and the LAST chapter of the book
        // silently disappears from the list — the same shape of hole the
        // untagged-tail work exists to close. A nominal span keeps the row: the
        // geometry is already unknowable here, but its existence is not.
        const lastResortEnd = durationMs > 0 ? durationMs : c.startMs + 1;
        const endMs = hasNext ? nextStart : c.endMs > c.startMs ? c.endMs : lastResortEnd;
        // A zero-length span would make the scrubber divide by zero.
        if (endMs <= c.startMs) continue;
        spans.push({
            index: spans.length,
            // A server-marked span carries no title on purpose — wording is the
            // client's, because the API's language negotiation is decoupled
            // from the UI locale. The ordinal fallback would be worse than the
            // label the caller localised for exactly this span.
            title: c.synthetic ? untaggedTailTitle : c.title || `${spans.length + 1}`,
            startMs: c.startMs,
            endMs,
            synthetic: c.synthetic,
            untagged: c.synthetic || undefined,
        });
    }

    // Pull the first chapter back to the start of the book: a book whose first
    // chapter begins at 0:50 would otherwise leave its opening chapter-less.
    if (spans.length > 0 && spans[0].startMs > 0) spans[0].startMs = 0;

    // Trim an end that runs past the audio. Left until here so the next-start
    // rule above is unaffected: only the final span can overshoot once the
    // chapters that begin past the end have been filtered out.
    const overshooting = spans[spans.length - 1];
    if (durationMs > 0 && overshooting && overshooting.endMs > durationMs) {
        overshooting.endMs = durationMs;
    }

    const last = spans[spans.length - 1];
    if (last) {
        const tailMs = durationMs - last.endMs;
        if (last.untagged === true) {
            // The server already marked a tail. The client measures the book
            // from its own tracks and the server measured it from ABS's
            // `duration`; where they disagree, stretch the existing span rather
            // than stacking a second one on top of it.
            if (tailMs > 0) last.endMs = durationMs;
        } else if (tailMs >= UNTAGGED_TAIL_MIN_MS) {
            spans.push({
                index: spans.length,
                title: untaggedTailTitle,
                startMs: last.endMs,
                endMs: durationMs,
                synthetic: true,
                untagged: true,
            });
        } else if (tailMs > 0) {
            // Rounding-scale shortfall: absorb it, as this always has.
            last.endMs = durationMs;
        }
    }

    return spans;
}

/**
 * One chapter per audio file, for the 22-in-666 of books that carry none.
 *
 * A single-file book degrades to a single synthetic chapter spanning the whole
 * book, which makes the chapter-scoped scrubber equivalent to a whole-book one.
 * Nothing downstream needs to special-case either case — that is the point.
 */
function synthesizeChapters(
    tracks: readonly AudiobookTrack[],
    label?: (partNumber: number, track: AudiobookTrack) => string,
): AudiobookChapterSpan[] {
    return tracks
        .filter((t) => t.durationMs > 0)
        .map((track, i) => ({
            index: i,
            title: label ? label(i + 1, track) : `Part ${i + 1}`,
            startMs: track.startOffsetMs,
            endMs: track.endOffsetMs,
            synthetic: true,
        }));
}

// ---------------------------------------------------------------------------
// Position mapping
// ---------------------------------------------------------------------------

export interface FilePosition {
    track: AudiobookTrack;
    /** Position within that file, ms — what the backend is told. */
    fileMs: number;
}

/**
 * Book time → the file that covers it, and the offset inside that file.
 *
 * Boundary rule: a position exactly on `startOffsetMs` belongs to the file
 * that STARTS there, never to the one that ends there. Getting this backwards
 * puts a seek to the start of chapter N at the very last sample of chapter
 * N−1, where it immediately fires `ended` and advances — a seek that lands one
 * chapter away from where the user tapped.
 *
 * Returns null only for an empty timeline. A position past the end clamps to
 * the last file, because the alternative — null — reads to every caller as
 * "no audio" and stops a book two seconds early.
 */
export function resolveFilePosition(
    timeline: AudiobookTimeline,
    bookMs: number,
): FilePosition | null {
    const { tracks } = timeline;
    if (tracks.length === 0) return null;

    const clamped = clampBookMs(timeline, bookMs);

    // findLast semantics, written as a loop: `Array.prototype.findLast` is
    // ES2023 and this file is shared with the server-side test harness.
    for (let i = tracks.length - 1; i >= 0; i--) {
        const track = tracks[i];
        if (clamped >= track.startOffsetMs) {
            return { track, fileMs: Math.max(0, clamped - track.startOffsetMs) };
        }
    }
    // Positions before the first offset (a book whose first track starts late).
    return { track: tracks[0], fileMs: 0 };
}

/** File offset → book time. The inverse of {@link resolveFilePosition}. */
export function toBookMs(track: AudiobookTrack, fileMs: number): number {
    return track.startOffsetMs + Math.max(0, fileMs);
}

/**
 * The track after `track`, or null at the end of the book.
 *
 * Matched on inode when there is one and on `index` otherwise: an inode-less
 * track is the transcode path's single synthetic track, and two of them would
 * both match a `null === null` comparison.
 */
export function nextTrack(
    timeline: AudiobookTimeline,
    track: AudiobookTrack,
): AudiobookTrack | null {
    const i = timeline.tracks.findIndex((t) =>
        track.ino === null ? t.ino === null && t.index === track.index : t.ino === track.ino,
    );
    if (i < 0) return null;
    return timeline.tracks[i + 1] ?? null;
}

/**
 * The chapter covering `bookMs`.
 *
 * Same boundary rule as files, for the same reason. Never returns null on a
 * non-empty timeline: {@link buildAudiobookTimeline} guarantees the chapter
 * list is contiguous and covers the book, synthesising one per file when the
 * book has none.
 */
export function findChapterAt(
    timeline: AudiobookTimeline,
    bookMs: number,
): AudiobookChapterSpan | null {
    return findChapterSpanAt(timeline.chapters, clampBookMs(timeline, bookMs));
}

/** Position within the current chapter, ms — what the interactive scrubber shows. */
export function chapterProgress(
    timeline: AudiobookTimeline,
    bookMs: number,
): { chapter: AudiobookChapterSpan; positionMs: number; durationMs: number } | null {
    const chapter = findChapterAt(timeline, bookMs);
    if (!chapter) return null;
    const clamped = clampBookMs(timeline, bookMs);
    return {
        chapter,
        positionMs: Math.max(
            0,
            Math.min(clamped - chapter.startMs, chapter.endMs - chapter.startMs),
        ),
        durationMs: chapter.endMs - chapter.startMs,
    };
}

/**
 * Book time of the chapter to move to, or null when there is none.
 *
 * `direction: -1` implements the podcast-style "previous" that most listeners
 * expect: within the first {@link RESTART_CHAPTER_THRESHOLD_MS} of a chapter it
 * goes to the previous chapter, after that it restarts the current one.
 */
export function seekChapterTarget(
    timeline: AudiobookTimeline,
    bookMs: number,
    direction: 1 | -1,
): number | null {
    const chapter = findChapterAt(timeline, bookMs);
    if (!chapter) return null;

    if (direction === 1) {
        const next = timeline.chapters[chapter.index + 1];
        return next ? next.startMs : null;
    }

    const intoChapter = clampBookMs(timeline, bookMs) - chapter.startMs;
    if (intoChapter > RESTART_CHAPTER_THRESHOLD_MS) return chapter.startMs;
    const prev = timeline.chapters[chapter.index - 1];
    return prev ? prev.startMs : chapter.startMs;
}

/** How far into a chapter "previous" stops meaning "the one before this". */
export const RESTART_CHAPTER_THRESHOLD_MS = 3_000;

/** Clamp to `[0, durationMs]`, tolerating NaN. */
export function clampBookMs(timeline: AudiobookTimeline, bookMs: number): number {
    if (!Number.isFinite(bookMs)) return 0;
    if (bookMs < 0) return 0;
    // ABS itself reports currentTime slightly PAST duration on a finished book
    // (measured: 104747.898 vs 104747.180), so this clamp is load-bearing on
    // real data, not defensive.
    return Math.min(bookMs, timeline.durationMs);
}

// ---------------------------------------------------------------------------
// Display-only chapter labels
// ---------------------------------------------------------------------------

/** A chapter title as the chapter sheet should show it, alongside the original. */
export interface AudiobookChapterLabel {
    /** What to render. Equal to `raw` whenever no cleanup applied. */
    display: string;
    /** The upstream title exactly as ABS reported it. */
    raw: string;
}

/**
 * A leading `NN-` / `NN_` / `NN.` / `NN ` run — AudiobookShelf's file-index
 * convention. Confirmed on a live capture (`audiobook-play-session
 * .fahrenheit451.json`, a REAL — not synthesised — chapter list):
 * `01 - Fahrenheit 451`, `02 - Fahrenheit 451`, … `05 - Fahrenheit 451`, one
 * chapter split across 5 files, each carrying its own track number plus the
 * BOOK's own title as a stand-in chapter name. That is the exact shape of the
 * "108 sections that read like duplicates" bug report, just five files
 * instead of a hundred.
 *
 * Requires at least one non-separator character after the digits, so a title
 * that is ENTIRELY digits ("1984") never matches — there is nothing left to
 * strip it down to, and returning "" would be worse than leaving it alone.
 */
const FILE_INDEX_PREFIX = /^\s*\d+[-_. ]+(.+)$/;

function stripFileIndexPrefix(title: string): string {
    const match = FILE_INDEX_PREFIX.exec(title);
    if (!match) return title;
    const rest = match[1].trim();
    return rest.length > 0 ? rest : title;
}

/** Separators a shared prefix is allowed to end on. */
const PREFIX_BOUNDARY = /[-_.:\s]/;
/** Below this, a shared prefix is more likely coincidence than a naming scheme. */
const MIN_SHARED_PREFIX = 4;
/**
 * Below this many entries, leave the titles alone.
 *
 * Repetition is only a problem at length. A 12-chapter book listing
 * `Kapitel 1` … `Kapitel 12` reads fine and the word is what a reader
 * recognises; stripping the shared part would leave a bare `1` … `12` that
 * says less than what it replaced. At 555 entries the same repetition is the
 * entire content of the column.
 */
const MIN_TITLES_FOR_PREFIX_STRIP = 20;

/**
 * The prefix EVERY title shares, cut back to a separator boundary.
 *
 * The complement of {@link FILE_INDEX_PREFIX}: that handles an index at the
 * FRONT (`01 - Fahrenheit 451`), this handles the equally common export that
 * puts it at the BACK (`Liu Cixin - Jenseits der Zeit - 001`), where the shared
 * part is the prefix and stripping the leading index does nothing at all. A
 * 555-file book rendered 555 rows of the same sentence, distinguished only by a
 * number the list already shows in its own gutter.
 *
 * Cutting back to a boundary is load-bearing. The raw common prefix of
 * `… - 001` … `… - 555` is `… - 0` (001 and 010 agree on that `0`), which would
 * leave `01`, `10`, `55` — silently wrong numbering. Trimming to the last
 * separator yields `… - ` and leaves the numbers intact.
 */
function sharedTitlePrefix(titles: readonly string[]): string {
    if (titles.length < MIN_TITLES_FOR_PREFIX_STRIP) return '';
    let prefix = titles[0];
    for (const title of titles) {
        let i = 0;
        while (i < prefix.length && i < title.length && prefix[i] === title[i]) i++;
        prefix = prefix.slice(0, i);
        if (prefix.length === 0) return '';
    }
    let cut = prefix.length;
    while (cut > 0 && !PREFIX_BOUNDARY.test(prefix[cut - 1])) cut--;
    const trimmed = prefix.slice(0, cut);
    const core = trimmed.replace(/[-_.:\s]+$/, '').trim();
    if (core.length < MIN_SHARED_PREFIX) return '';
    // Never strip a prefix that would leave an entry empty — that title would
    // become less identifiable, not more.
    const remainders = titles.map((title) => title.slice(trimmed.length).trim());
    if (remainders.some((rest) => rest.length === 0)) return '';

    // When the remainder is nothing but a number, the SEPARATOR says which case
    // this is:
    //
    //   `Kapitel 1`                          word + space  → a numbering scheme
    //   `Liu Cixin - Jenseits der Zeit - 001` word + dash   → a title with an
    //                                                        index bolted on
    //
    // `Kapitel 1` … `Kapitel 108` are real chapters and the word is what a
    // reader recognises; stripping it leaves a bare `1` … `108` that reads as
    // "this book has no chapter names", the opposite of the truth. A title
    // repeated in front of a punctuated index carries nothing and goes.
    const numberedOnly = remainders.every((rest) => /^\d+$/.test(rest));
    if (numberedOnly && !/[-_.:]\s*$/.test(trimmed)) return '';

    return trimmed;
}

/**
 * True when the titles say nothing a listener can navigate by.
 *
 * After the strips above, a uniformly split book leaves entries that are
 * nothing but their own ordinal — `001`, `002`, … — which the chapter list
 * already prints in its number column. A caller that gets `true` here should
 * show something with actual information instead; the player uses each
 * chapter's start time, because on a book split into equal parts the offset is
 * the only thing that distinguishes one entry from another.
 */
export function chapterTitlesAreUninformative(labels: readonly AudiobookChapterLabel[]): boolean {
    if (labels.length < MIN_TITLES_FOR_PREFIX_STRIP) return false;
    return labels.every((label) => /^\d+$/.test(label.display.trim()));
}

/**
 * Turn raw ABS chapter titles into what a chapter sheet should show.
 *
 * Presentation only. Nothing here reads or produces `startMs`/`endMs`/
 * `index` — a caller maps titles through this and keeps using the timeline's
 * own spans for seeking and the active-chapter highlight, so `findChapterAt`
 * and the virtual timeline behave exactly as before this function existed.
 *
 * Two independent cleanups:
 *
 * 1. Strip a leading file-index prefix ({@link FILE_INDEX_PREFIX}), whenever
 *    one is present.
 * 2. When that leaves the SAME cleaned name on two or more CONSECUTIVE
 *    entries — the file-per-chapter case this exists for — number them as
 *    parts of that run: "Ein Junge überlebt (1/6)" … "(6/6)".
 *
 * The run is consecutive-only, deliberately, not book-wide: AudiobookShelf's
 * own per-file index restarts at 1 for every real chapter (the reported bug's
 * own example — chapter 2's files also start at `01-`), so grouping by the
 * index VALUE would be wrong; and grouping by cleaned TITLE TEXT book-wide
 * would incorrectly weld together two same-named chapters that happen to sit
 * far apart (a recap chapter titled the same as an earlier one, say).
 * Consecutive-run grouping gets both right for free.
 *
 * A book whose titles are already clean ("The Boy Who Lived") has no digit
 * prefix to strip and, for a well-tagged book, no back-to-back duplicate
 * either, so every entry round-trips unchanged: `display === raw`.
 *
 * Known, accepted gap: a chapter genuinely titled "007 - Casino Royale" is
 * indistinguishable, from the title string alone, from a file-index artifact,
 * and gets stripped the same way. Nothing in a bare title list can tell the
 * two apart, and the live Fahrenheit-451 fixture above shows the file-index
 * shape is common enough on real data that leaving the whole class unstripped
 * to protect this rare case would fail to fix the reported bug for a real
 * slice of the library.
 */
export function formatChapterLabels(rawTitles: readonly string[]): AudiobookChapterLabel[] {
    const shared = sharedTitlePrefix(rawTitles);
    const cleaned = rawTitles
        .map((title) => (shared ? title.slice(shared.length).trim() : title))
        .map(stripFileIndexPrefix);
    const labels: AudiobookChapterLabel[] = [];
    let i = 0;
    while (i < rawTitles.length) {
        let j = i;
        while (j + 1 < rawTitles.length && cleaned[j + 1] === cleaned[i]) j++;
        const runLength = j - i + 1;
        for (let k = i; k <= j; k++) {
            const display =
                runLength > 1 ? `${cleaned[i]} (${k - i + 1}/${runLength})` : cleaned[i];
            labels.push({ display, raw: rawTitles[k] });
        }
        i = j + 1;
    }
    return labels;
}

/** Build the player timeline from the public millisecond/URL contract. */
export function buildPlaybackAudiobookTimeline(
    tracks: readonly AudiobookPlaybackTrack[],
    chapters: readonly AudiobookPlaybackChapter[],
    options: BuildTimelineOptions = {},
): AudiobookTimeline {
    return buildAudiobookTimeline(
        tracks.map((track) => ({
            ...track,
            startOffset: track.startMs / 1000,
            duration: track.durationMs == null ? null : track.durationMs / 1000,
        })),
        chapters.map((chapter) => ({
            ...chapter,
            start: chapter.startMs / 1000,
            end: (chapter.startMs + chapter.durationMs) / 1000,
        })),
        options,
    );
}
