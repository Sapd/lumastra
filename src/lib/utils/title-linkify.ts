// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Title Linkify
 *
 * Sibling of `artist-linkify`: splits a track TITLE into segments, linking
 * known artist names that appear inside a remix-credit zone
 * ("Summertime (Ekowraith Remix)" → "Ekowraith" links, everything else is
 * emitted verbatim).
 *
 * Same three honesty rules as `linkifyArtists` (longest title first,
 * delimiter-bounded matches, never invent) plus one stricter rule: a name
 * may only claim a span INSIDE a `findRemixCreditZones` zone — the span of
 * the tag before its trailing version-keyword run. That is what stops an
 * artist named "Summer" from claiming half of "Summertime", and names
 * outside tags from linking at all.
 *
 * @module utils/title-linkify
 */

import { findRemixCreditZones } from '$lib/shared/remix-credit';
import { ARTIST_SEPARATOR_SOURCE, type ArtistSegment } from './artist-linkify';

interface ResolvedCandidate {
    id: string;
    title: string;
}

interface Claim {
    start: number;
    end: number;
    id: string;
}

const SEPARATOR_AT_START = new RegExp(`^${ARTIST_SEPARATOR_SOURCE}`, 'i');
const SEPARATOR_AT_END = new RegExp(`${ARTIST_SEPARATOR_SOURCE}$`, 'i');

/** True when [start, end) intersects any already-claimed span. */
function overlaps(claims: readonly Claim[], start: number, end: number): boolean {
    return claims.some((claim) => start < claim.end && end > claim.start);
}

/**
 * Split `raw` (a track title) into linked and unlinked segments against the
 * track's known artists. Empty when `raw` is empty; a single unlinked
 * segment when nothing resolves.
 */
export function linkifyTitle(
    raw: string,
    artists?: ReadonlyArray<{ id?: string | null; title: string }>,
): ArtistSegment[] {
    if (raw.length === 0) return [];

    const zones = findRemixCreditZones(raw);
    if (zones.length === 0) return [{ text: raw }];

    const candidates: ResolvedCandidate[] = (artists ?? [])
        .map((artist) => ({ id: artist.id, title: artist.title.trim() }))
        .filter(
            (artist): artist is ResolvedCandidate =>
                typeof artist.id === 'string' && artist.id.length > 0 && artist.title.length > 0,
        )
        // Longest first: "Dan Winter" must claim its span before "Dan".
        .sort((a, b) => b.title.length - a.title.length);

    if (candidates.length === 0) return [{ text: raw }];

    const haystack = raw.toLowerCase();
    const claims: Claim[] = [];

    for (const artist of candidates) {
        const needle = artist.title.toLowerCase();
        let claimed = false;
        for (const zone of zones) {
            let from = zone.start;
            for (;;) {
                const start = haystack.indexOf(needle, from);
                if (start === -1 || start + needle.length > zone.end) break;
                const end = start + needle.length;
                // Delimited WITHIN the zone: bounded by the zone edge or a
                // collab separator on both sides.
                const before = raw.slice(zone.start, start);
                const after = raw.slice(end, zone.end);
                const openOk = before.length === 0 || SEPARATOR_AT_END.test(before);
                const closeOk = after.length === 0 || SEPARATOR_AT_START.test(after);
                if (openOk && closeOk && !overlaps(claims, start, end)) {
                    claims.push({ start, end, id: artist.id });
                    claimed = true;
                    break;
                }
                from = start + 1;
            }
            if (claimed) break;
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
