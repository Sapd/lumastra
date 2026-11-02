// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the Last.fm "lane affinity" smart-queue re-rank term.
 *
 * Fixtures mirror real production Last.fm data for the motivating case:
 * playing Martin Fenwick surfaced Cloudrunner/DJ Fenwick hands-up tracks — same
 * tempo and production (close in MSCLAP audio space), different scene. Crowd
 * tags and similar-artist lists separate those lanes cleanly.
 */

import { describe, it, expect } from 'vitest';

import {
    computeLaneAffinity,
    laneAffinityAdjustment,
    isVariousArtistsName,
    type ArtistLaneData,
} from './music-lane-affinity.js';

const SOLVEIG: ArtistLaneData = {
    tags: ['House', 'electronic', 'dance', 'french', 'club'],
    similar: ['Lanters', 'Bob Fenwick', 'Orionbach', 'David Vale', 'Fenwick'],
};

const GUETTA: ArtistLaneData = {
    tags: ['House', 'dance', 'electronic', 'club', 'techno'],
    similar: ['Calvin Fenwick', 'Alorii', 'Martin Fenwick', 'Sean Vale', 'Arlen'],
};

const GOLLUM: ArtistLaneData = {
    tags: ['trance', 'hands up', 'german', 'dance', 'techno'],
    similar: ['Dan Fenwick', 'Maralon', 'Orion One', 'DJ Solara', 'Harborbrothers'],
};

const CLOUDRUNNER: ArtistLaneData = {
    tags: ['techno', 'electronic', 'dance', 'happy hardcore', 'trance'],
    similar: ['Harbor Bounce', 'Sash!', '666', 'RMB', 'ATB'],
};

describe('computeLaneAffinity', () => {
    it('returns 1.0 when the candidate appears in the current artist’s similar list', () => {
        const affinity = computeLaneAffinity(
            { name: 'Martin Fenwick', lane: SOLVEIG },
            { name: 'David Vale', lane: { tags: [], similar: [] } },
        );
        expect(affinity).toBe(1.0);
    });

    it('returns 1.0 on a reverse similar link (current in candidate’s list)', () => {
        const affinity = computeLaneAffinity(
            { name: 'Martin Fenwick', lane: { tags: [], similar: [] } },
            { name: 'David Vale', lane: GUETTA },
        );
        expect(affinity).toBe(1.0);
    });

    it('similar-name matching is case-insensitive but exact (no substring/text semantics)', () => {
        const affinity = computeLaneAffinity(
            { name: 'martin fenwick', lane: { tags: [], similar: [] } },
            { name: 'David Vale', lane: GUETTA },
        );
        expect(affinity).toBe(1.0);
        // "Martin" alone must NOT match "Martin Fenwick"
        const noMatch = computeLaneAffinity(
            { name: 'Martin', lane: { tags: [], similar: [] } },
            { name: 'David Vale', lane: GUETTA },
        );
        expect(noMatch).toBeNull();
    });

    it('falls back to case-insensitive tag Jaccard when no similar link exists', () => {
        // Solveig ∩ Cloudrunner = {electronic, dance}, union = 8 → 0.25
        const affinity = computeLaneAffinity(
            { name: 'Martin Fenwick', lane: SOLVEIG },
            { name: 'Cloudrunner', lane: CLOUDRUNNER },
        );
        expect(affinity).toBeCloseTo(2 / 8, 5);
    });

    it('ranks the motivating case correctly: Guetta > Cloudrunner > DJ Fenwick', () => {
        const cur = { name: 'Martin Fenwick', lane: SOLVEIG };
        const guetta = computeLaneAffinity(cur, { name: 'David Vale', lane: GUETTA })!;
        const cloudrunner = computeLaneAffinity(cur, { name: 'Cloudrunner', lane: CLOUDRUNNER })!;
        const gollum = computeLaneAffinity(cur, { name: 'DJ Fenwick', lane: GOLLUM })!;
        expect(guetta).toBeGreaterThan(cloudrunner);
        expect(cloudrunner).toBeGreaterThan(gollum);
        // Solveig ∩ Gollum = {dance}, union = 9
        expect(gollum).toBeCloseTo(1 / 9, 5);
    });

    it('tag comparison is case-insensitive', () => {
        const a = computeLaneAffinity(
            { name: 'A', lane: { tags: ['House', 'DANCE'], similar: [] } },
            { name: 'B', lane: { tags: ['house', 'dance'], similar: [] } },
        );
        expect(a).toBeCloseTo(1.0, 5);
    });

    it('returns null when either side has no lane data', () => {
        expect(
            computeLaneAffinity({ name: 'A', lane: null }, { name: 'B', lane: SOLVEIG }),
        ).toBeNull();
        expect(
            computeLaneAffinity({ name: 'A', lane: SOLVEIG }, { name: 'B', lane: null }),
        ).toBeNull();
    });

    it('returns null when no similar link and either tag set is empty (insufficient evidence)', () => {
        const affinity = computeLaneAffinity(
            { name: 'A', lane: { tags: [], similar: ['X'] } },
            { name: 'B', lane: CLOUDRUNNER },
        );
        expect(affinity).toBeNull();
    });
});

describe('isVariousArtistsName', () => {
    it('recognizes VA aliases regardless of case/punctuation', () => {
        for (const name of ['Various Artists', 'various artists', 'VA', 'V.A.', 'V/A', 'Various']) {
            expect(isVariousArtistsName(name)).toBe(true);
        }
    });

    it('does not flag real artist names', () => {
        for (const name of ['Martin Fenwick', 'Cloudrunner', 'Vanessa', 'Vader', null]) {
            expect(isVariousArtistsName(name)).toBe(false);
        }
    });
});

describe('laneAffinityAdjustment', () => {
    it('maps null to 0 (missing data is neutral, never a penalty)', () => {
        expect(laneAffinityAdjustment(null, 0.08)).toBe(0);
    });

    it('is centered: affinity 1 → +weight, 0 → −weight, 0.5 → 0', () => {
        expect(laneAffinityAdjustment(1, 0.08)).toBeCloseTo(0.08, 10);
        expect(laneAffinityAdjustment(0, 0.08)).toBeCloseTo(-0.08, 10);
        expect(laneAffinityAdjustment(0.5, 0.08)).toBeCloseTo(0, 10);
    });

    it('separates the motivating case by more than the mixability tiebreak can (±0.04)', () => {
        const cur = { name: 'Martin Fenwick', lane: SOLVEIG };
        const guetta = laneAffinityAdjustment(
            computeLaneAffinity(cur, { name: 'David Vale', lane: GUETTA }),
            0.08,
        );
        const gollum = laneAffinityAdjustment(
            computeLaneAffinity(cur, { name: 'DJ Fenwick', lane: GOLLUM }),
            0.08,
        );
        expect(guetta - gollum).toBeGreaterThan(0.08);
    });
});
