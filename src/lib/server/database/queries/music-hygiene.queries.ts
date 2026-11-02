// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Music hygiene findings — the PREDICATES and the COUNTS.
 *
 * All functions take `sql: postgres.Sql` first and have no side effects.
 *
 * ## Division of labour with `admin-media.queries.ts`
 *
 * This module owns what a finding IS (the SQL predicate) and how many rows
 * carry it (the count). It does NOT own the media browser's list query — that
 * lives in `admin-media.queries.ts`, which imports
 * {@link buildMusicHygieneFragment} and appends it to the list's WHERE like any
 * other advanced filter. The dependency runs one way only (admin-media →
 * music-hygiene); the base population both of them narrow lives in
 * `builders/admin-media-scope.builder.ts`, which neither owns, so the count and
 * the list cannot drift into counting different things.
 *
 * ## Why no "junk title" heuristic
 *
 * The three shortest album titles on page one of a real music library are `+`,
 * `-` and `=` — symbol-only album fixtures. A shape test for "junk-looking title"
 * flags his whole catalogue on day one, and an operator who sees one obviously
 * wrong finding stops believing every other number on the page. Three of the
 * four findings here are therefore provable facts about the row, and the fourth
 * says in its own name, its own doc comment and its operator-facing copy that
 * it is a heuristic review list.
 */

import type postgres from 'postgres';
import {
    MUSIC_HYGIENE_ALBUM_NO_ARTIST,
    MUSIC_HYGIENE_ARTIST_UNSPLIT,
    MUSIC_HYGIENE_FINDINGS,
    MUSIC_ATTENTION_FINDINGS,
    MUSIC_HYGIENE_TITLE_FROM_FILENAME,
    MUSIC_HYGIENE_TRACK_NO_ARTIST,
    MUSIC_HYGIENE_VIEW,
    type MusicHygieneFinding,
} from '$lib/shared/music-hygiene.js';
import { buildAdminBrowserBaseScope } from './builders/admin-media-scope.builder.js';
import { collaborationNeedsReviewSql } from './collaboration-review.queries.js';

/**
 * Track rows whose parent chain never reaches an `artist`.
 *
 * Bounded three-level walk rather than a recursive CTE: the music hierarchy is
 * artist → album → track, so three levels above the track covers every shape
 * the writers can produce (`insertScannedMediaItem` always parents a track to
 * an album, and an album to an artist) with room to spare, at the cost of three
 * primary-key lookups instead of a recursive scan. A cycle cannot run away
 * because the walk is bounded.
 *
 * `'artist' IN (p1.media_type, p2.media_type, p3.media_type)` yields NULL, not
 * false, when the chain runs out early — which `NOT EXISTS` treats as
 * "not found", the answer we want.
 */
function buildTrackNoArtistFragment(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`AND mi.media_type = 'track'
        AND NOT EXISTS (
            SELECT 1
            FROM media_items mh_p1
            LEFT JOIN media_items mh_p2 ON mh_p2.id = mh_p1.parent_id
            LEFT JOIN media_items mh_p3 ON mh_p3.id = mh_p2.parent_id
            WHERE mh_p1.id = mi.parent_id
              AND 'artist' IN (mh_p1.media_type, mh_p2.media_type, mh_p3.media_type)
        )`;
}

/**
 * Album rows with no `artist` parent.
 *
 * Covers both shapes in one `NOT EXISTS`: a null `parent_id` produces no row to
 * join, and a parent of the wrong type fails the type check. A strictly
 * different population from the track finding — an album can be parentless
 * while every one of its tracks reaches an artist through some other route, and
 * an orphan track can hang off a perfectly parented album.
 */
function buildAlbumNoArtistFragment(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`AND mi.media_type = 'album'
        AND NOT EXISTS (
            SELECT 1 FROM media_items mh_ap
            WHERE mh_ap.id = mi.parent_id AND mh_ap.media_type = 'artist'
        )`;
}

/** Optional filename-title search, served by idx_media_items_track_title_from_filename.
 * Keeping a title clears this marker; its recovery receipt retains the original value.
 */
function buildTitleFromFilenameFragment(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`AND mi.media_type = 'track'
        AND mi.title_source = 'filename'`;
}

/** Optional conjunction search. The shared artist-conjunction table defines these markers;
 * tests compare it with this SQL and the scanner. These names do not create attention tasks.
 * MusicBrainz, no_split and a current collaboration fingerprint preserve existing choices.
 */
function buildArtistUnsplitFragment(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    const needsReview = collaborationNeedsReviewSql(sql, 'mi');
    return sql`AND mi.media_type = 'artist'
        AND COALESCE(mi.custom_metadata->>'no_split', '') <> 'true'
        AND COALESCE(mi.custom_metadata->>'musicbrainz_artist_id', '') = ''
        AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id=mi.id
            AND ei.provider='musicbrainz' AND ei.external_id<>'')
        AND ${needsReview}
        AND (
            mi.title ~* '[[:space:]]+(feat[.]?|ft[.]?|featuring|vs[.]?|x|und|and)[[:space:]]+'
            OR mi.title ~ '[[:space:]]+[&+][[:space:]]+'
        )`;
}

/**
 * The `AND …` predicate for one finding, for a query whose `media_items` alias
 * is `mi`.
 *
 * Every fragment pins its own `media_type`. That is what makes a count taken
 * here and a list rendered from `admin-media.queries.ts` agree even when a
 * hand-edited URL supplies a `?type=` the finding cannot apply to: both sides
 * intersect the same self-scoping predicate, so both go to zero together
 * instead of one of them quietly widening.
 */
export function buildMusicHygieneFragment(
    sql: postgres.Sql,
    finding: MusicHygieneFinding,
): postgres.PendingQuery<postgres.Row[]> {
    switch (finding) {
        case MUSIC_HYGIENE_TRACK_NO_ARTIST:
            return buildTrackNoArtistFragment(sql);
        case MUSIC_HYGIENE_ALBUM_NO_ARTIST:
            return buildAlbumNoArtistFragment(sql);
        case MUSIC_HYGIENE_TITLE_FROM_FILENAME:
            return buildTitleFromFilenameFragment(sql);
        case MUSIC_HYGIENE_ARTIST_UNSPLIT:
            return buildArtistUnsplitFragment(sql);
    }
}

/** How many rows each finding matches, keyed by the finding's `?filter=` value. */
export type MusicHygieneCounts = Record<MusicHygieneFinding, number>;

interface HygieneCountRow {
    total: number;
}

/**
 * Count the rows one finding matches, over the population the browser would
 * list at the finding's own deep link.
 *
 * The scope comes from `MUSIC_HYGIENE_VIEW` — the same map
 * `buildMusicHygieneLink` builds the href from — and the base population from
 * `buildAdminBrowserBaseScope`, the same builder `listAdminMediaItems` and
 * `countAdminMediaItems` use. Neither is re-spelled here, so the number this
 * returns and the number the operator counts on the page are the same query
 * with a different projection.
 */
export async function countMusicHygieneFinding(
    sql: postgres.Sql,
    finding: MusicHygieneFinding,
): Promise<number> {
    const scope = buildAdminBrowserBaseScope(sql, { types: [MUSIC_HYGIENE_VIEW[finding].type] });
    const predicate = buildMusicHygieneFragment(sql, finding);
    const [row] = await sql<[HygieneCountRow]>`
        SELECT COUNT(*)::int AS total
        FROM media_items mi
        WHERE ${scope}
        ${predicate}
    `;
    return row?.total ?? 0;
}

/**
 * Count every music-hygiene finding in one round of parallel queries.
 *
 * All four are index or primary-key work, cheap enough to call directly from
 * the attention derive cycle.
 */
export async function countMusicHygieneFindings(
    sql: postgres.Sql,
    attentionOnly = false,
): Promise<MusicHygieneCounts> {
    const totals = await Promise.all(
        MUSIC_HYGIENE_FINDINGS.map((finding) =>
            attentionOnly && !MUSIC_ATTENTION_FINDINGS.includes(finding)
                ? Promise.resolve(0)
                : countMusicHygieneFinding(sql, finding),
        ),
    );
    const counts = {} as MusicHygieneCounts;
    MUSIC_HYGIENE_FINDINGS.forEach((finding, index) => {
        counts[finding] = totals[index]!;
    });
    return counts;
}
