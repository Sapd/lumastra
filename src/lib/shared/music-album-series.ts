// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Album series detection from the title alone ("Future Trance Vol.61",
 * "Future Trance 70", "TechnoBase.FM, Volume 16" …).
 *
 * Nothing in the library links compilation volumes together, and their titles
 * are spelled inconsistently across releases, so a series is "albums whose
 * title reduces to the same key once the trailing volume number is removed".
 * Callers additionally require the same album artist (Various Artists counts
 * as one) so generic stems like "Greatest Hits Vol. 2" never merge across
 * artists, and at least two distinct volume numbers before showing a series
 * (editions or discs of one volume — "Vol. 1 (Deluxe)" — are not a series).
 *
 * Deliberately NOT volume markers:
 *  - "No." / "Nr." — classical numbering ("Symphony No. 5") is not a series.
 *  - a number after "Top" — "Top 100" is part of the name, and treating it as
 *    volume 100 groups the discs of one release ("… Top 100 (CD 1)", "(CD 2)").
 *  - a number after "CD" / "Disc" / "Side" — that is a disc, not a volume.
 */

export interface AlbumSeriesKey {
    /** Normalized series stem: lowercase letters/digits only. */
    key: string;
    /** The volume number parsed from the end of the title. */
    volume: number;
}

/** Shortest stem accepted as a series — keeps "CD 2" / "Vol. 3"-only titles out. */
const MIN_KEY_LENGTH = 3;

const TRAILING_BRACKET = /\s*[([][^)\]]*[)\]]\s*$/;
const VARIOUS_ARTISTS_PREFIX = /^(?:va|various artists)\s*[-–:]\s*/i;
// "Top 100", "Symphony No. 5", "Nr 3": the number belongs to the name;
// "CD 2", "Disc 2", "Side 2": a disc of one release, not a volume.
const TRAILING_NON_VOLUME_NUMBER = /\b(?:top|no|nr|cd|dis[ck]|side)\.?\s*\d+\s*$/i;
// stem, then either an explicit marker + number or a bare trailing number.
const TRAILING_VOLUME =
    /^(.*?)[\s,.:\-_]*(?:\b(?:vol(?:ume)?|part|pt)\.?\s*(\d{1,4})|\s(\d{1,3}))\s*$/i;

export function albumSeriesKey(title: string): AlbumSeriesKey | null {
    let t = title.trim().replace(TRAILING_BRACKET, '');
    if (TRAILING_NON_VOLUME_NUMBER.test(t)) return null;
    t = t.replace(/\s*&\s*/g, ' and ').replace(VARIOUS_ARTISTS_PREFIX, '');

    const match = TRAILING_VOLUME.exec(t);
    if (!match) return null;

    const key = (match[1] ?? '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');
    if (key.length < MIN_KEY_LENGTH) return null;

    return { key, volume: Number(match[2] ?? match[3]) };
}
