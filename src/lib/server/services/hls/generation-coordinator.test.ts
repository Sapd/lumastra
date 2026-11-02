// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    allocateNextGenerationIndex,
    applyRetainedGenerationSelection,
    buildGenerationOutputDir,
    createPlaybackSession,
    getMaxRetainedGenerations,
    selectRetainedGenerationsToKeep,
    touchPlaybackSession,
} from './generation-coordinator.js';
import type { TranscodeJob } from '../transcoding/types.js';

function job(id: string, segmentOffset: number, lastAccessedAt: Date = new Date(0)): TranscodeJob {
    return {
        id,
        segmentOffset,
        lastAccessedAt,
    } as TranscodeJob;
}

describe('HLS generation coordinator', () => {
    it('creates and touches playback sessions', () => {
        const createdAt = new Date(1000);
        const touchedAt = new Date(2000);
        const session = createPlaybackSession('play', createdAt);

        expect(session).toMatchObject({
            playSessionId: 'play',
            retainedJobIds: [],
            nextGenerationIndex: 1,
            createdAt,
            lastAccessedAt: createdAt,
        });

        touchPlaybackSession(session, touchedAt);
        expect(session.lastAccessedAt).toBe(touchedAt);
    });

    it('allocates monotonic generation indices and output dirs', () => {
        const session = createPlaybackSession('play');

        expect(allocateNextGenerationIndex(session)).toBe(1);
        expect(allocateNextGenerationIndex(session)).toBe(2);
        expect(session.nextGenerationIndex).toBe(3);
        expect(buildGenerationOutputDir('/tmp/play', 12)).toBe('/tmp/play/gen-0012');
    });

    it('derives retained generation capacity from total generation capacity', () => {
        expect(getMaxRetainedGenerations(0)).toBe(0);
        expect(getMaxRetainedGenerations(1)).toBe(0);
        expect(getMaxRetainedGenerations(3)).toBe(2);
    });

    it('applies retained generation selections in session order', () => {
        const session = createPlaybackSession('play');
        session.retainedJobIds = ['old', 'keep', 'missing', 'new'];

        applyRetainedGenerationSelection(session, new Set(['keep', 'new']));

        expect(session.retainedJobIds).toEqual(['keep', 'new']);
    });

    it('preserves explicitly requested retained jobs first', () => {
        const selection = selectRetainedGenerationsToKeep(
            [job('near', 95), job('preserve', 400), job('far', 500)],
            ['near', 'preserve', 'far'],
            {
                maxRetained: 1,
                anchorSegmentOffset: 100,
                preserveJobIds: ['preserve'],
            },
        );

        expect([...selection.keepIds]).toEqual(['preserve']);
        expect(selection.retireIds).toEqual(['near', 'far']);
    });

    it('keeps retained jobs closest to the anchor offset', () => {
        const selection = selectRetainedGenerationsToKeep(
            [job('far', 10), job('near', 95), job('middle', 130)],
            ['far', 'near', 'middle'],
            {
                maxRetained: 1,
                anchorSegmentOffset: 100,
            },
        );

        expect([...selection.keepIds]).toEqual(['near']);
        expect(selection.retireIds).toEqual(['far', 'middle']);
    });

    it('uses recent access as a tie breaker', () => {
        const selection = selectRetainedGenerationsToKeep(
            [job('old', 90, new Date(1000)), job('recent', 110, new Date(2000))],
            ['old', 'recent'],
            {
                maxRetained: 1,
                anchorSegmentOffset: 100,
            },
        );

        expect([...selection.keepIds]).toEqual(['recent']);
        expect(selection.retireIds).toEqual(['old']);
    });

    it('retires every retained generation when capacity is zero', () => {
        const selection = selectRetainedGenerationsToKeep(
            [job('a', 10), job('b', 20)],
            ['a', 'b'],
            {
                maxRetained: 0,
                anchorSegmentOffset: 15,
            },
        );

        expect([...selection.keepIds]).toEqual([]);
        expect(selection.retireIds).toEqual(['a', 'b']);
    });

    it('ignores preserve ids that are no longer retained', () => {
        const selection = selectRetainedGenerationsToKeep(
            [job('near', 95), job('far', 500)],
            ['missing', 'near', 'far'],
            {
                maxRetained: 1,
                anchorSegmentOffset: 100,
                preserveJobIds: ['missing'],
            },
        );

        expect([...selection.keepIds]).toEqual(['near']);
        expect(selection.retireIds).toEqual(['missing', 'far']);
    });

    it('keeps preserved generations plus nearest seek anchor when capacity allows', () => {
        const selection = selectRetainedGenerationsToKeep(
            [job('old-a', 80), job('preserved-b', 520), job('new-a', 92)],
            ['old-a', 'preserved-b', 'new-a'],
            {
                maxRetained: 2,
                anchorSegmentOffset: 90,
                preserveJobIds: ['preserved-b'],
            },
        );

        expect([...selection.keepIds]).toEqual(['preserved-b', 'new-a']);
        expect(selection.retireIds).toEqual(['old-a']);
    });
});
