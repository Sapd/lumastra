// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artist Linkify
 *
 * Splits a track's raw display-artist string (e.g. "DJ Fenwick, Milo
 * Sebastian" or "Megalanterns feat. Sarah") into segments, marking the spans
 * that correspond to a known artist so each name can be linked separately.
 *
 * The raw string is preserved byte-for-byte: separators ("`, `", "` feat. `",
 * "` & `") are emitted verbatim as unlinked segments, so the line still reads
 * the way the file's tag wrote it.
 *
 * Three rules keep this honest:
 *
 *   1. **Longest title first** — "DJ Fenwick" claims its span before a
 *      separate "Fenwick" artist can take part of it.
 *   2. **Separator-delimited matches only** — a name must sit between real
 *      delimiters (or string edges). A plain space is NOT a delimiter, which
 *      is what stops the artist "Sara" from linkifying half of the single
 *      artist "Sara Vale".
 *   3. **Never invent** — a title absent from the raw string simply does not
 *      link. The worst case is an unlinked name, never a wrong destination.
 *
 * Matching uses `indexOf` on lowercased strings rather than a built regex, so
 * names full of metacharacters ("A$AP Rowan", "!!!") need no escaping.
 *
 * @module utils/artist-linkify
 */

/** One run of the artist line. `id` is set only for a resolved artist. */
export interface ArtistSegment {
    /** Text sliced from the raw string — original casing and spacing intact. */
    text: string;
    /** Artist UUID when this run resolved to a known artist. */
    id?: string;
}

/** An artist candidate as carried by `MusicTrack.artists[]`. */
interface ArtistCandidate {
    id?: string | null;
    title: string;
}

interface ResolvedCandidate {
    id: string;
    title: string;
}

interface Claim {
    start: number;
    end: number;
    id: string;
}

/**
 * The delimiters the file scanner itself splits artist tags on — kept in sync
 * with ARTIST_COLLAB_SEPARATOR / ARTIST_AND_SEPARATOR / ARTIST_COMMA_SEPARATOR
 * in
 * `server/tasks/builtin/native/media-sources/_helpers/file-scanner/audio-processor.ts`.
 *
 * Deliberately excludes a bare space: "Sara Vale" is one artist, not two.
 */
export const ARTIST_SEPARATOR_SOURCE = String.raw`(?:\s*[,&+]\s*|\s+(?:feat\.?|ft\.?|featuring|vs\.?|and|x)\s+)`;
const SEPARATOR_AT_START = new RegExp(`^${ARTIST_SEPARATOR_SOURCE}`, 'i');
const SEPARATOR_AT_END = new RegExp(`${ARTIST_SEPARATOR_SOURCE}$`, 'i');

/**
 * True when the span [start, end) is bounded by a separator or a string edge
 * on both sides.
 */
function isDelimited(raw: string, start: number, end: number): boolean {
    const before = raw.slice(0, start);
    const after = raw.slice(end);
    const openOk = before.length === 0 || SEPARATOR_AT_END.test(before);
    const closeOk = after.length === 0 || SEPARATOR_AT_START.test(after);
    return openOk && closeOk;
}

/** True when [start, end) intersects any already-claimed span. */
function overlaps(claims: readonly Claim[], start: number, end: number): boolean {
    return claims.some((claim) => start < claim.end && end > claim.start);
}

/**
 * Split `raw` into linked and unlinked segments against a list of known
 * artists.
 *
 * @param raw     The track's display-artist string, exactly as shown.
 * @param artists Known artists for the track (`MusicTrack.artists`). Entries
 *                without an id or with a blank title are ignored.
 * @returns Segments in source order. Empty when `raw` is empty; a single
 *          unlinked segment when nothing resolves.
 */
export function linkifyArtists(
    raw: string,
    artists?: ReadonlyArray<ArtistCandidate>,
): ArtistSegment[] {
    if (raw.length === 0) return [];

    const candidates: ResolvedCandidate[] = (artists ?? [])
        .map((artist) => ({ id: artist.id, title: artist.title.trim() }))
        .filter(
            (artist): artist is ResolvedCandidate =>
                typeof artist.id === 'string' && artist.id.length > 0 && artist.title.length > 0,
        )
        // Longest first: "DJ Fenwick" must claim its span before "Fenwick".
        .sort((a, b) => b.title.length - a.title.length);

    if (candidates.length === 0) return [{ text: raw }];

    const haystack = raw.toLowerCase();
    const claims: Claim[] = [];

    for (const artist of candidates) {
        const needle = artist.title.toLowerCase();
        let from = 0;
        for (;;) {
            const start = haystack.indexOf(needle, from);
            if (start === -1) break;
            const end = start + needle.length;
            if (isDelimited(raw, start, end) && !overlaps(claims, start, end)) {
                claims.push({ start, end, id: artist.id });
                break;
            }
            from = start + 1;
        }
    }

    if (claims.length === 0) return [{ text: raw }];

    claims.sort((a, b) => a.start - b.start);

    const segments: ArtistSegment[] = [];
    let cursor = 0;
    for (const claim of claims) {
        if (claim.start > cursor) {
            segments.push({ text: raw.slice(cursor, claim.start) });
        }
        segments.push({ text: raw.slice(claim.start, claim.end), id: claim.id });
        cursor = claim.end;
    }
    if (cursor < raw.length) {
        segments.push({ text: raw.slice(cursor) });
    }

    return segments;
}
