// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Music maintenance vocabulary shared by SQL filters, optional searches and attention links.
 * Broken hierarchy is actionable; a filename title or conjunction-bearing name alone is not.
 * Keep the filter vocabulary stable for bookmarked optional searches.
 */

/**
 * Track rows whose parent chain never reaches an `artist`.
 *
 * Factual: the row is a track and neither its parent, its grandparent nor its
 * great-grandparent is an `artist` row. Such a track is unreachable from the
 * artist browse hierarchy.
 */
export const MUSIC_HYGIENE_TRACK_NO_ARTIST = 'music-track-no-artist';

/**
 * Album rows with no `artist` parent (`parent_id` null, or pointing at a row
 * that is not an artist).
 *
 * Factual, and a strictly different population from the track finding: an
 * album can be parentless while its tracks are fine, and vice versa.
 */
export const MUSIC_HYGIENE_ALBUM_NO_ARTIST = 'music-album-no-artist';

/** Recorded filename provenance. Optional search only; it does not demand review or protection. */
export const MUSIC_HYGIENE_TITLE_FROM_FILENAME = 'music-title-from-filename';

/** Optional artist-cleanup search. Conjunctions can name one act or several; never auto-split
 * or mark no_split to clear a count. MusicBrainz/no_split and relevant reviewed inputs protect it.
 */
export const MUSIC_HYGIENE_ARTIST_UNSPLIT = 'music-artist-unsplit';

/** Every music-hygiene finding, in the order surfaces should render them. */
export const MUSIC_HYGIENE_FINDINGS = [
    MUSIC_HYGIENE_TRACK_NO_ARTIST,
    MUSIC_HYGIENE_ALBUM_NO_ARTIST,
    MUSIC_HYGIENE_TITLE_FROM_FILENAME,
    MUSIC_HYGIENE_ARTIST_UNSPLIT,
] as const;

/** A music-hygiene finding id, which is also its `?filter=` value verbatim. */
export type MusicHygieneFinding = (typeof MUSIC_HYGIENE_FINDINGS)[number];

/**
 * The findings that are heuristics rather than provable facts.
 *
 * Exported as data so a surface cannot render a heuristic finding without a
 * caveat by forgetting which one it was — the check is
 * `MUSIC_HYGIENE_HEURISTIC_FINDINGS.includes(finding)`, not a hardcoded
 * comparison that a fifth finding would silently skip.
 */
export const MUSIC_HYGIENE_HEURISTIC_FINDINGS: readonly MusicHygieneFinding[] = [
    MUSIC_HYGIENE_ARTIST_UNSPLIT,
];

/** Whether a finding is a heuristic (has expected false positives) or a fact. */
export function isHeuristicMusicHygieneFinding(finding: MusicHygieneFinding): boolean {
    return MUSIC_HYGIENE_HEURISTIC_FINDINGS.includes(finding);
}

/** Narrow an arbitrary `?filter=` value to a music-hygiene finding. */
export function isMusicHygieneFinding(
    value: string | null | undefined,
): value is MusicHygieneFinding {
    return (
        typeof value === 'string' && (MUSIC_HYGIENE_FINDINGS as readonly string[]).includes(value)
    );
}

/**
 * The media-browser view each finding lands in.
 *
 * `domain` and `type` must stay a matching pair for the same reason
 * `ADMIN_MEDIA_FILE_ISSUES_PATH` documents: the browser resolves an absent
 * `type` to the domain default, so a link that omits it opens a DIFFERENT list
 * than the one the count was taken over. `music` + `artist|album|track` are all
 * valid pairs — `inferDomain` maps each of the three music types to `'music'`.
 *
 * The type here is also the type scope the count is taken over, so the two
 * cannot drift: `countMusicHygieneFindings` reads this same map.
 */
export const MUSIC_HYGIENE_VIEW: Record<MusicHygieneFinding, { domain: string; type: string }> = {
    [MUSIC_HYGIENE_TRACK_NO_ARTIST]: { domain: 'music', type: 'track' },
    [MUSIC_HYGIENE_ALBUM_NO_ARTIST]: { domain: 'music', type: 'album' },
    [MUSIC_HYGIENE_TITLE_FROM_FILENAME]: { domain: 'music', type: 'track' },
    [MUSIC_HYGIENE_ARTIST_UNSPLIT]: { domain: 'music', type: 'artist' },
};

/** Actual broken hierarchy only. Provenance and punctuation are optional searches. */
export const MUSIC_ATTENTION_FINDINGS: readonly MusicHygieneFinding[] = [
    MUSIC_HYGIENE_TRACK_NO_ARTIST,
    MUSIC_HYGIENE_ALBUM_NO_ARTIST,
];
