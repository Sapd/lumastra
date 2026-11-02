// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    estimateBytes,
    mergeRotationSources,
    MAX_WANT,
    buildEmbeddingProjectionFields,
} from './candidates.js';
import { EMBEDDING_PROJECTION_VERSION } from '$lib/server/database/queries/music-embedding-projection.queries.js';
import type { DownloadCandidateRow } from '$lib/server/database/queries/music-downloads.queries.js';

function row(
    id: string,
    source: 'play_count' | 'rating',
    runtime: number | null,
): DownloadCandidateRow {
    return {
        media_id: id,
        title: id,
        artist_id: 'artist-1',
        artist_title: 'An Artist',
        runtime_seconds: runtime,
        play_count: 1,
        source,
        projection_version: null,
        projected_vector: null,
    };
}

describe('estimateBytes', () => {
    it('is duration x bitrate / 8, in bytes', () => {
        // 240s at 128 kbps = 240 * 128 * 1000 / 8 = 3_840_000
        expect(estimateBytes(240, 128)).toBe(3_840_000);
    });

    it('returns null when runtime is unknown rather than guessing zero', () => {
        // A null estimate must stay null: the client refuses to admit a
        // null-size candidate near the ceiling, whereas 0 would read as free.
        expect(estimateBytes(null, 128)).toBeNull();
    });

    it('estimates off the real encoder floor (64 kbps), not a below-ladder request (32)', () => {
        // QuerySchema allows bitrateKbps down to 32, but clampBitrate('mp3', n)
        // falls back to the ladder floor (64) for anything below it -- the
        // route never actually encodes at 32. Estimating off the raw request
        // would under-budget by ~2x here.
        // 240s at 64 kbps = 240 * 64 * 1000 / 8 = 1_920_000
        expect(estimateBytes(240, 32)).toBe(1_920_000);
    });

    it('estimates off the actual clamped rung (96) for an off-ladder request (100)', () => {
        // clampBitrate('mp3', 100) picks the largest rung <= 100, which is 96.
        // 240s at 96 kbps = 240 * 96 * 1000 / 8 = 2_880_000
        expect(estimateBytes(240, 100)).toBe(2_880_000);
    });
});

describe('mergeRotationSources', () => {
    it('deduplicates a track present in both sources, keeping the play_count entry', () => {
        const merged = mergeRotationSources(
            [row('dup', 'play_count', 100)],
            [row('dup', 'rating', 100)],
        );
        expect(merged).toHaveLength(1);
        expect(merged[0]!.source).toBe('play_count');
    });

    it('interleaves so a favourite is never buried behind the whole play-count head', () => {
        const played = [row('p1', 'play_count', 10), row('p2', 'play_count', 10)];
        const rated = [row('r1', 'rating', 10)];

        const merged = mergeRotationSources(played, rated);

        // r1 must appear before the play-count head is exhausted, otherwise a
        // small `want` can never surface a favourite.
        expect(merged.map((r) => r.media_id).indexOf('r1')).toBeLessThan(2);
    });

    it('produces a merge order the caller can assign contiguous rank to, not just an array of the right length', () => {
        // A same-length identity check (`merged.map((_, i) => i)`) would pass
        // for any 3-element array regardless of merge order — this instead
        // asserts the actual interleaved order the merge is documented to
        // produce, so a broken merge (e.g. plain concatenation) fails it.
        const merged = mergeRotationSources(
            [row('p1', 'play_count', 10), row('p2', 'play_count', 10)],
            [row('r1', 'rating', 10)],
        );
        // RATING_INTERLEAVE_EVERY reserves position 0 for the rating stream.
        expect(merged.map((r) => r.media_id)).toEqual(['r1', 'p1', 'p2']);
    });
});

describe('MAX_WANT', () => {
    it("reaches the ~1200-track rotation lane capacity target, since want is the lane's only depth control (no cursor)", () => {
        expect(MAX_WANT).toBeGreaterThanOrEqual(1200);
    });

    it('is bounded — enforced independently by pagination-bounds.test.ts against QuerySchema', () => {
        expect(Number.isFinite(MAX_WANT)).toBe(true);
        expect(MAX_WANT).toBe(2000);
    });
});

describe('buildEmbeddingProjectionFields', () => {
    it('emits both fields null when the row has no projection at all', () => {
        const result = buildEmbeddingProjectionFields(row('p1', 'play_count', 200));
        expect(result).toEqual({ embeddingProjection: null, embeddingProjectionVersion: null });
    });

    it('emits both fields null when the stored version does not match the active version', () => {
        const stale: DownloadCandidateRow = {
            ...row('p1', 'play_count', 200),
            projection_version: EMBEDDING_PROJECTION_VERSION + 1,
            projected_vector: Buffer.from(Array.from({ length: 64 }, () => 1)),
        };
        const result = buildEmbeddingProjectionFields(stale);
        expect(result).toEqual({ embeddingProjection: null, embeddingProjectionVersion: null });
    });

    it('emits the base64-encoded vector + current version when the stored version matches', () => {
        const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 1 : -1)));
        const withProjection: DownloadCandidateRow = {
            ...row('p1', 'play_count', 200),
            projection_version: EMBEDDING_PROJECTION_VERSION,
            projected_vector: bytes,
        };
        const result = buildEmbeddingProjectionFields(withProjection);
        expect(result.embeddingProjectionVersion).toBe(EMBEDDING_PROJECTION_VERSION);
        expect(result.embeddingProjection).toBe(bytes.toString('base64'));
        // Exactly 64 bytes once decoded, matching the wire contract.
        expect(Buffer.from(result.embeddingProjection!, 'base64').byteLength).toBe(64);
    });
});
