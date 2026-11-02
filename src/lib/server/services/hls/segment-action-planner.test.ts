// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    SPEED_AWARE_FORWARD_SEEK_BUDGET_SECONDS,
    estimateForwardWaitSeconds,
    planHlsSegmentAction,
} from './segment-action-planner.js';

const defaults = {
    isSegment: true,
    isIframeRequest: false,
    requestedSegmentNum: 10,
    actualSegmentIndex: 10,
    segmentOffset: 0,
    canSeek: true,
    fileExists: false,
    isDeleted: false,
    jobStatus: 'running' as const,
    jobIsSeeking: false,
    isVideoTranscoded: false,
    isSequentialPlayback: false,
    currentProgress: 10,
    forwardSeekThreshold: 50,
    farFromOriginThreshold: 200,
    isRepeatedSegmentPressure: false,
    repeatedPressureForwardSeekThreshold: 10,
    isTailProbe: false,
    hasTailCache: false,
};

describe('HLS segment action planner', () => {
    it('returns gone_deleted before any seek or wait decision', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            actualSegmentIndex: 4,
            isDeleted: true,
            fileExists: true,
        });

        expect(action.type).toBe('gone_deleted');
        expect(action.branch).toBe('deleted');
    });

    it('plans a backward seek for authoritative requests before the offset', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 50,
            actualSegmentIndex: -50,
            segmentOffset: 100,
        });

        expect(action.type).toBe('trigger_seek');
        expect(action.branch).toBe('backward_seek');
    });

    // A generation whose video is TRANSCODED is numbered absolutely: FFmpeg gets
    // `-start_number N`, so `segment_00042.m4s` in that directory IS segment 42's
    // content whatever `segmentOffset` says. Disk presence is therefore the truth
    // about availability, and `segmentOffset` only records where the encoder was
    // told to start. A restore that resumes at the viewer's position leaves real
    // segments BELOW its offset (prod 2026-08-28), and re-transcoding those
    // instead of serving them retires the in-flight forward generation.
    //
    // Copy mode is the opposite and must keep seeking: names are RELATIVE
    // (`translateToActualIndex` = requested - offset), so a below-offset request
    // does not even resolve to a real index there.
    it('serves a below-offset segment already on disk when numbering is absolute', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 40,
            actualSegmentIndex: 40,
            segmentOffset: 59,
            isVideoTranscoded: true,
            fileExists: true,
        });

        expect(action.type).toBe('serve_file');
        expect(action.branch).toBe('serve_file');
    });

    it('still seeks backward when the below-offset segment is NOT on disk', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 40,
            actualSegmentIndex: 40,
            segmentOffset: 59,
            isVideoTranscoded: true,
            fileExists: false,
        });

        expect(action.type).toBe('trigger_seek');
        expect(action.branch).toBe('backward_seek');
    });

    it('still seeks backward below the offset when numbering is relative', () => {
        // Copy mode: a file sitting at that NAME holds different content, so
        // serving it would be a correctness bug, not an optimisation.
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 40,
            actualSegmentIndex: -19,
            segmentOffset: 59,
            isVideoTranscoded: false,
            fileExists: true,
        });

        expect(action.type).toBe('trigger_seek');
        expect(action.branch).toBe('backward_seek');
    });

    it('does not plan playback seeks for iframe requests', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 50,
            actualSegmentIndex: -50,
            segmentOffset: 100,
            isIframeRequest: true,
        });

        expect(action.type).toBe('wait_current');
    });

    it('fast-fails negative non-authoritative requests', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            canSeek: false,
            requestedSegmentNum: 50,
            actualSegmentIndex: -50,
            segmentOffset: 100,
        });

        expect(action.type).toBe('not_found');
        expect(action.branch).toBe('negative_non_authoritative');
    });

    it('serves existing files after higher-priority guards pass', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            fileExists: true,
        });

        expect(action.type).toBe('serve_file');
    });

    it('restarts far-from-origin copy playback even if the file exists', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 250,
            actualSegmentIndex: 250,
            fileExists: true,
        });

        expect(action.type).toBe('trigger_seek');
        expect(action.branch).toBe('far_from_origin_seek');
    });

    it('serves file on first stream access (audio rendition switch) instead of far-from-origin seek', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 500,
            actualSegmentIndex: 500,
            fileExists: true,
            isFirstStreamAccess: true,
        });

        expect(action.type).toBe('serve_file');
        expect(action.branch).toBe('serve_file');
    });

    it('serves file when segment is within current FFmpeg progress (not stale)', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 840,
            actualSegmentIndex: 531,
            segmentOffset: 309,
            fileExists: true,
            currentProgress: 1480,
        });

        expect(action.type).toBe('serve_file');
        expect(action.branch).toBe('serve_file');
    });

    it('still triggers far_from_origin_seek when segment is beyond current progress (stale)', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 840,
            actualSegmentIndex: 531,
            segmentOffset: 309,
            fileExists: true,
            currentProgress: 500,
        });

        expect(action.type).toBe('trigger_seek');
        expect(action.branch).toBe('far_from_origin_seek');
    });

    it('triggers far_from_origin_seek when currentProgress is unknown (safety default)', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 250,
            actualSegmentIndex: 250,
            fileExists: true,
            currentProgress: undefined,
        });

        expect(action.type).toBe('trigger_seek');
        expect(action.branch).toBe('far_from_origin_seek');
    });

    it('plans a forward seek when the authoritative request is beyond progress threshold', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 80,
            actualSegmentIndex: 80,
            currentProgress: 20,
            fileExists: false,
        });

        expect(action.type).toBe('trigger_seek');
        expect(action.branch).toBe('forward_seek');
    });

    it('prioritizes repeated authoritative misses before the normal forward threshold', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 35,
            actualSegmentIndex: 35,
            currentProgress: 20,
            isRepeatedSegmentPressure: true,
            fileExists: false,
        });

        expect(action.type).toBe('trigger_seek');
        expect(action.branch).toBe('repeated_pressure_forward_seek');
    });

    it('does not prioritize tiny repeated misses near current progress', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 23,
            actualSegmentIndex: 23,
            currentProgress: 20,
            isRepeatedSegmentPressure: true,
            fileExists: false,
        });

        expect(action.type).toBe('wait_current');
    });

    describe('speed-aware forward seek', () => {
        // GPU hw test 2026-10-01: 4K HDR -> 720p at ~4.5x (CPU tonemap). 12 s in,
        // progress ~9; segment 24 is 15 ahead — inside the fixed threshold, so the
        // planner waited ~20 s of encode and the 10 s segment wait timed out.
        const slowSeek = {
            ...defaults,
            requestedSegmentNum: 24,
            actualSegmentIndex: 24,
            currentProgress: 9,
            forwardSeekThreshold: 15,
            segmentDurationSeconds: 6,
        };

        it('restarts at the target when the current run would take longer than the budget', () => {
            const action = planHlsSegmentAction({ ...slowSeek, transcodeSpeed: 4.5 });

            expect(action.type).toBe('trigger_seek');
            // Its own branch: the executor cools it down at any distance.
            expect(action.branch).toBe('speed_aware_forward_seek');
        });

        it('keeps the fixed-threshold branch when the gap is past the threshold anyway', () => {
            const action = planHlsSegmentAction({
                ...slowSeek,
                requestedSegmentNum: 40,
                actualSegmentIndex: 40,
                transcodeSpeed: 4.5,
            });

            expect(action.branch).toBe('forward_seek');
        });

        it('does not trust the speed of a generation that has served nothing on this stream', () => {
            const action = planHlsSegmentAction({
                ...slowSeek,
                transcodeSpeed: 0.8,
                isFirstStreamAccess: true,
            });

            expect(action.type).toBe('wait_current');
        });

        it('does not trust the speed before the generation produced a couple of segments', () => {
            const action = planHlsSegmentAction({
                ...slowSeek,
                segmentOffset: 8,
                transcodeSpeed: 0.8,
            });

            expect(action.type).toBe('wait_current');
        });

        it('keeps waiting when a fast run covers the same gap inside the budget', () => {
            const action = planHlsSegmentAction({ ...slowSeek, transcodeSpeed: 20 });

            expect(action.type).toBe('wait_current');
        });

        it('falls back to the fixed threshold while the speed is unknown (fresh respawn)', () => {
            const action = planHlsSegmentAction({ ...slowSeek, transcodeSpeed: undefined });

            expect(action.type).toBe('wait_current');
        });

        it('never restarts for a target within the minimum gap, however slow the run', () => {
            const action = planHlsSegmentAction({
                ...slowSeek,
                requestedSegmentNum: 11,
                actualSegmentIndex: 11,
                transcodeSpeed: 0.5,
            });

            expect(action.type).toBe('wait_current');
        });

        it('does not restart sequential playback that caught up with a slow run', () => {
            const action = planHlsSegmentAction({
                ...slowSeek,
                transcodeSpeed: 0.8,
                isSequentialPlayback: true,
            });

            expect(action.type).toBe('wait_current');
        });

        it('serves a file that already exists instead of restarting', () => {
            const action = planHlsSegmentAction({
                ...slowSeek,
                transcodeSpeed: 4.5,
                fileExists: true,
                isVideoTranscoded: true,
            });

            expect(action.type).toBe('serve_file');
        });

        it('estimates the wait from gap, segment duration and speed', () => {
            expect(
                estimateForwardWaitSeconds({
                    requestedSegmentNum: 24,
                    currentProgress: 9,
                    segmentDurationSeconds: 6,
                    transcodeSpeed: 4.5,
                }),
            ).toBeCloseTo(((15 + 1) * 6) / 4.5);
            expect(
                estimateForwardWaitSeconds({
                    requestedSegmentNum: 24,
                    currentProgress: 9,
                    segmentDurationSeconds: 6,
                    transcodeSpeed: 0,
                }),
            ).toBeUndefined();
            expect(SPEED_AWARE_FORWARD_SEEK_BUDGET_SECONDS).toBeLessThan(10);
        });
    });

    it('serves the tail cache for tail probes before waiting', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            isTailProbe: true,
            hasTailCache: true,
            fileExists: false,
        });

        expect(action.type).toBe('serve_tail_cache');
        expect(action.branch).toBe('tail_cache');
    });

    it('serves tail cache before normal forward-seek production', () => {
        const action = planHlsSegmentAction({
            ...defaults,
            requestedSegmentNum: 900,
            currentProgress: 20,
            isTailProbe: true,
            hasTailCache: true,
            fileExists: false,
        });

        expect(action.type).toBe('serve_tail_cache');
    });

    it('waits for active segment jobs when the file is not ready', () => {
        const action = planHlsSegmentAction(defaults);

        expect(action.type).toBe('wait_current');
    });
});
