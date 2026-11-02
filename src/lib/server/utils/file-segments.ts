// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File Segment Derivation
 *
 * A "combined" file backs several episode rows (S02E24E25 → one .mkv, two
 * media_items). Playback needs to know where each episode lives inside that
 * file, otherwise picking episode 25 replays episode 24 from the top.
 *
 * PROVENANCE comes from the filename, not from arithmetic. `S02E24E25` is a
 * release-naming convention meaning "this file holds episodes 24 and 25", and
 * it is what made the scanner create those rows in the first place (see
 * video-processor's episodeStart..episodeEnd loop). When the declared range
 * matches the rows on the file, the file genuinely holds that many episodes.
 *
 * Runtimes deliberately do NOT gate that decision, because provider runtime
 * metadata is unreliable for exactly these files: TMDB routinely records the
 * COMBINED length on each part of a two-parter (Lost's "The End" is 6283s and
 * lists 6300s against BOTH halves), and mixed libraries carry a correct runtime
 * on one part and the combined one on its sibling (Hafentage E20 660s, E21 1320s).
 * An earlier version treated "one episode as long as the whole file" as proof of
 * a mis-link and refused to split — which rejected 59 genuine double episodes.
 *
 * Given provenance, the boundary is placed from the best evidence available:
 *
 *   1. chapter      — the file says where each part begins (exact)
 *   2. runtime-split — per-episode runtimes, when they describe this file
 *   3. even-split    — equal shares; runtimes are absent or describe something else
 *
 * `null` remains a first-class answer for anything without provenance: the file
 * keeps whole-file playback, exactly as before.
 */

/** Playback boundary eligibility is independent of title-identity evidence.
 * Preserve the historical chapter filter: labels such as Folge 2, Main or Start
 * can mark an episode boundary even though they cannot establish its identity.
 */
const NON_BOUNDARY_CHAPTER_PATTERNS: RegExp[] = [
    /^(chapter|kapitel|teil|part|episode|szene|scene)\s*\d+$/i,
    /^(intro|opening|outro|ending|credits?|abspann|vorspann|recap|preview|prologue|epilogue|teaser|titles?)$/i,
    /^\d{1,2}:\d{2}(:\d{2})?$/,
    /^chapter\s*$/i,
];

function isEligibleBoundaryChapter(name: string | null | undefined): boolean {
    const trimmed = name?.trim();
    return Boolean(trimmed && !NON_BOUNDARY_CHAPTER_PATTERNS.some((re) => re.test(trimmed)));
}

export interface SegmentEpisodeInput {
    mediaItemId: string;
    episodeNumber: number | null;
    /** Canonical (provider) runtime for this episode alone, not the file. */
    runtimeMs: number | null;
}

export interface SegmentChapterInput {
    name: string | null;
    /** Offset from the start of the FILE. */
    startMs: number;
}

export type FileSegmentSource = 'chapter' | 'runtime-split' | 'even-split';

export interface FileSegment {
    mediaItemId: string;
    /** Inclusive start offset within the file. */
    startMs: number;
    /** Exclusive end offset within the file. */
    endMs: number;
    source: FileSegmentSource;
}

export interface DeriveFileSegmentsInput {
    durationMs: number | null;
    episodes: SegmentEpisodeInput[];
    chapters: SegmentChapterInput[];
    /**
     * How many episodes the FILENAME declares (S02E24E25 → 2), or null when it
     * declares no range. This is the provenance signal: it must match the number
     * of episode rows for the file to be treated as genuinely combined.
     */
    declaredEpisodeCount: number | null;
}

/**
 * Tolerance for "does this arithmetic describe the file we actually have".
 * Provider runtimes are rounded to whole minutes and exclude ad breaks, so an
 * exact match never happens; 25% is wide enough for that noise but far tighter
 * than the ~100%+ error a mis-link produces.
 */
const DURATION_TOLERANCE = 0.25;

/**
 * Shortest plausible episode slice. Anything below this means the chapter marks
 * are scene markers rather than episode boundaries.
 */
const MIN_SEGMENT_MS = 60_000;

function relativeError(value: number, reference: number): number {
    return Math.abs(value - reference) / reference;
}

/** Episode order defines segment order. */
function sortEpisodes(episodes: SegmentEpisodeInput[]): SegmentEpisodeInput[] {
    return [...episodes].sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
}

/**
 * Whether the runtimes describe THIS file, and are therefore usable to place the
 * boundary. Number.isFinite, not `> 0` alone: NaN fails every comparison, so a
 * NaN runtime would slip through a `<= 0` filter and poison the arithmetic into
 * NaN offsets that are then persisted.
 */
function hasKnownRuntimes(episodes: SegmentEpisodeInput[]): boolean {
    return episodes.every(
        (e) => e.runtimeMs !== null && Number.isFinite(e.runtimeMs) && e.runtimeMs > 0,
    );
}

function runtimesDescribeFile(episodes: SegmentEpisodeInput[], durationMs: number): boolean {
    if (!hasKnownRuntimes(episodes)) return false;
    const sum = episodes.reduce((a, e) => a + (e.runtimeMs as number), 0);
    return relativeError(sum, durationMs) <= DURATION_TOLERANCE;
}

/**
 * Positional binding is only meaningful if the episode order is knowable:
 * a null or duplicated episode number leaves the sort arbitrary, which would
 * silently attach each window to the wrong episode (they would all still look
 * numerically valid, so no later guard catches it).
 */
function hasTrustworthyOrder(episodes: SegmentEpisodeInput[]): boolean {
    const numbers = episodes.map((e) => e.episodeNumber);
    if (numbers.some((n) => n === null)) return false;
    return new Set(numbers).size === numbers.length;
}

/**
 * Turn ascending boundary offsets into gapless segments spanning the whole file.
 *
 * `starts[0]` is forced to 0 and the final segment runs to EOF, so material
 * outside the content chapters (opening titles, end credits) always belongs to
 * the adjacent episode instead of falling into a hole.
 */
function buildSegments(
    episodes: SegmentEpisodeInput[],
    starts: number[],
    durationMs: number,
    source: FileSegmentSource,
): FileSegment[] | null {
    const segments: FileSegment[] = episodes.map((ep, i) => ({
        mediaItemId: ep.mediaItemId,
        startMs: i === 0 ? 0 : starts[i],
        endMs: i === episodes.length - 1 ? durationMs : starts[i + 1],
        source,
    }));

    for (const seg of segments) {
        if (seg.endMs - seg.startMs < MIN_SEGMENT_MS) return null;
    }
    return segments;
}

/**
 * Chapter marks are only episode boundaries if the slices they imply actually
 * resemble the episodes. Without this, any file whose chapter count happens to
 * equal its episode count is split on coincidence alone — enough to hand episode
 * 25 the last 64s of episode 24 because the marks were late scene changes.
 *
 * Only meaningful when the runtimes describe this file; for a two-parter whose
 * provider runtime is the combined length, every real chapter slice looks "half
 * the expected size" and the check would reject a perfectly good boundary. The
 * caller gates on that.
 */
function chapterSegmentsMatchRuntimes(
    segments: FileSegment[],
    episodes: SegmentEpisodeInput[],
): boolean {
    return segments.every(
        (seg, i) =>
            relativeError(seg.endMs - seg.startMs, episodes[i].runtimeMs as number) <=
            DURATION_TOLERANCE,
    );
}

/**
 * Equal shares of the file. The fallback when the runtimes describe something
 * other than this file — which for combined releases is the common case, not the
 * exception. Approximate by construction: the boundary is an entry point in a
 * file that still plays as one video, so being a little early or late costs the
 * viewer a scrub, whereas refusing to split costs them the whole feature.
 */
function deriveEvenly(episodes: SegmentEpisodeInput[], durationMs: number): FileSegment[] | null {
    const share = durationMs / episodes.length;
    const starts = episodes.map((_, i) => Math.round(i * share));
    return buildSegments(episodes, starts, durationMs, 'even-split');
}

/**
 * Bind content chapter[i] → episode[i] and use each chapter start as the
 * boundary. Uses ordinal binding independently of title-identity filtering:
 * only the unambiguous case (one content chapter per episode row) is trusted.
 */
function deriveFromChapters(
    episodes: SegmentEpisodeInput[],
    chapters: SegmentChapterInput[],
    durationMs: number,
): FileSegment[] | null {
    const content = chapters
        .filter((c) => isEligibleBoundaryChapter(c.name))
        .sort((a, b) => a.startMs - b.startMs);

    if (content.length !== episodes.length) return null;

    for (let i = 0; i < content.length; i++) {
        // Reject non-finite marks explicitly: NaN fails `< 0` and `>= duration`
        // alike, so it would pass as a valid boundary and persist NaN offsets.
        if (!Number.isFinite(content[i].startMs)) return null;
        if (content[i].startMs < 0 || content[i].startMs >= durationMs) return null;
        if (i > 0 && content[i].startMs <= content[i - 1].startMs) return null;
    }

    const segments = buildSegments(
        episodes,
        content.map((c) => c.startMs),
        durationMs,
        'chapter',
    );
    if (!segments) return null;

    // Corroborate against the runtimes only when they describe this file; when
    // they describe something else they cannot falsify anything.
    if (
        runtimesDescribeFile(episodes, durationMs) &&
        !chapterSegmentsMatchRuntimes(segments, episodes)
    ) {
        return null;
    }
    return segments;
}

/**
 * Split the file in proportion to each episode's runtime, scaled to the real
 * duration. Only trusted when the runtimes add up to roughly the file we have —
 * otherwise the metadata is describing something else and an equal share is the
 * better guess.
 */
function deriveFromRuntimes(
    episodes: SegmentEpisodeInput[],
    durationMs: number,
): FileSegment[] | null {
    if (!runtimesDescribeFile(episodes, durationMs)) return null;

    const known = episodes.map((e) => e.runtimeMs as number);
    const sum = known.reduce((a, b) => a + b, 0);

    const starts: number[] = [];
    let cursor = 0;
    for (const runtime of known) {
        starts.push(Math.round(cursor));
        cursor += (runtime / sum) * durationMs;
    }

    return buildSegments(episodes, starts, durationMs, 'runtime-split');
}

/**
 * Derive the per-episode playback window for every episode row on a file.
 *
 * @returns One segment per episode, ordered by episode number and covering the
 *   file with no gaps — or `null` when the evidence does not support splitting,
 *   in which case callers must keep whole-file playback.
 */
export function deriveFileSegments(input: DeriveFileSegmentsInput): FileSegment[] | null {
    const { durationMs, chapters, declaredEpisodeCount } = input;

    if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return null;
    if (input.episodes.length < 2) return null;

    // Provenance: the filename must declare exactly the episodes that are linked.
    // A file whose rows came from somewhere else (a manual link, a sync) is not
    // known to hold several episodes, and nothing here could place a boundary in
    // it honestly.
    if (declaredEpisodeCount !== input.episodes.length) return null;

    // Positional binding is meaningless without a knowable episode order: a null
    // or duplicated number would attach windows to the wrong episodes while still
    // looking numerically valid.
    if (!hasTrustworthyOrder(input.episodes)) return null;

    const episodes = sortEpisodes(input.episodes);

    return (
        deriveFromChapters(episodes, chapters, durationMs) ??
        deriveFromRuntimes(episodes, durationMs) ??
        deriveEvenly(episodes, durationMs)
    );
}
