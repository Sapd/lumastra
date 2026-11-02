// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    buildHlsSegmentRequestState,
    type HlsSegmentRequestStateAdapter,
} from './segment-request-state.js';
import type { TranscodeJob } from '../transcoding/types.js';

const adapter: HlsSegmentRequestStateAdapter = {
    getSegmentOffsetForJob: () => 100,
    getStreamSegmentOffsetForJob: (_job, streamDirName) =>
        streamDirName === 'stream_0' ? 80 : 100,
    getStreamTargetDurationForJob: (_job, streamDirName) =>
        streamDirName === 'stream_0' ? 6 : undefined,
    canStreamTriggerSeekForJob: (_job, streamDirName) => streamDirName === 'stream_2',
    isSegmentDeletedForJob: (_job, _streamDirName, actualSegmentIndex) => actualSegmentIndex <= 2,
};

function createJob(videoAction: 'copy' | 'transcode' = 'copy'): TranscodeJob {
    return {
        id: 'job',
        segmentDurationSeconds: 10,
        segmentsReady: 30,
        transcodeDecisionResult: {
            videoAction,
        },
    } as TranscodeJob;
}

describe('buildHlsSegmentRequestState', () => {
    it('uses per-stream offsets for remux/copy streams', () => {
        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: {
                streamDir: 'stream_0',
                segmentIndex: 90,
            },
            isSegment: true,
            requestedSegmentNum: 90,
            adapter,
        });

        expect(state.globalSegmentOffset).toBe(100);
        expect(state.streamDirName).toBe('stream_0');
        expect(state.isVideoTranscoded).toBe(false);
        expect(state.segmentOffset).toBe(80);
        expect(state.actualSegmentIndex).toBe(10);
        expect(state.streamTargetDuration).toBe(6);
        expect(state.currentProgressForDiagnostics).toBe(130);
        expect(state.canSeek).toBe(false);
    });

    it('uses global manifest indices in transcode mode', () => {
        const state = buildHlsSegmentRequestState({
            job: createJob('transcode'),
            segmentInfo: {
                streamDir: 'stream_0',
                segmentIndex: 90,
            },
            isSegment: true,
            requestedSegmentNum: 90,
            adapter,
        });

        expect(state.isVideoTranscoded).toBe(true);
        expect(state.segmentOffset).toBe(100);
        expect(state.actualSegmentIndex).toBe(90);
    });

    it('detects deleted segments only for non-negative segment files', () => {
        const deletedState = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: {
                streamDir: 'stream_0',
                segmentIndex: 82,
            },
            isSegment: true,
            requestedSegmentNum: 82,
            adapter,
        });
        const negativeState = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: {
                streamDir: 'stream_0',
                segmentIndex: 79,
            },
            isSegment: true,
            requestedSegmentNum: 79,
            adapter,
        });
        const playlistState = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: {
                streamDir: 'stream_0',
                segmentIndex: 82,
            },
            isSegment: false,
            requestedSegmentNum: 82,
            adapter,
        });

        expect(deletedState.segmentWasDeleted).toBe(true);
        expect(negativeState.actualSegmentIndex).toBe(-1);
        expect(negativeState.segmentWasDeleted).toBe(false);
        expect(playlistState.segmentWasDeleted).toBe(false);
    });

    it('uses stream-specific offset for muxed copy-mode (empty streamDir)', () => {
        // In muxed mode, streamDirName is '' (falsy). The segment handler must
        // still use getStreamSegmentOffsetForJob to get the keyframe-aligned
        // offset, not fall back to job.segmentOffset (audioBasedTarget).
        const muxedAdapter: HlsSegmentRequestStateAdapter = {
            ...adapter,
            getSegmentOffsetForJob: () => 21, // audioBasedTarget
            getStreamSegmentOffsetForJob: (_job, streamDirName) =>
                streamDirName === '' ? 24 : 100, // keyframe-aligned offset for muxed
        };

        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: '', segmentIndex: 24 },
            isSegment: true,
            requestedSegmentNum: 24,
            adapter: muxedAdapter,
        });

        expect(state.streamDirName).toBe('');
        // Must use keyframe-aligned offset (24), not audioBasedTarget (21)
        expect(state.segmentOffset).toBe(24);
        expect(state.actualSegmentIndex).toBe(0);
    });

    it('falls back to stream-specific offset when segmentInfo is null', () => {
        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: null,
            isSegment: false,
            requestedSegmentNum: -1,
            adapter,
        });

        expect(state.streamDirName).toBe('');
        expect(state.segmentOffset).toBe(100);
        expect(state.actualSegmentIndex).toBe(-101);
        expect(state.streamTargetDuration).toBe(10);
    });

    it('uses globalSegmentOffset when segmentInfo is null and video is transcoded', () => {
        // segmentInfo=null → streamDirName=''. In transcode mode, segmentOffset
        // must be globalSegmentOffset, not the per-stream value for ''.
        const state = buildHlsSegmentRequestState({
            job: createJob('transcode'),
            segmentInfo: null,
            isSegment: false,
            requestedSegmentNum: 90,
            adapter,
        });

        expect(state.streamDirName).toBe('');
        expect(state.isVideoTranscoded).toBe(true);
        // Transcode mode uses globalSegmentOffset (100), not stream offset for ''
        expect(state.segmentOffset).toBe(100);
        // Transcode mode: actualSegmentIndex = requestedSegmentNum (no offset subtraction)
        expect(state.actualSegmentIndex).toBe(90);
        expect(state.segmentWasDeleted).toBe(false);
    });

    it('returns offset=0 as a valid value and does not fall back to globalSegmentOffset', () => {
        // This covers the fixed bug: old code used `streamDirName ? per-stream : global`
        // which meant muxed mode (streamDirName='') always returned globalSegmentOffset.
        // A zero stream offset is valid (playback from the start, no seek).
        const zeroOffsetAdapter: HlsSegmentRequestStateAdapter = {
            ...adapter,
            getSegmentOffsetForJob: () => 50, // global is non-zero
            getStreamSegmentOffsetForJob: () => 0, // per-stream is zero (start of file)
        };

        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: 'stream_0', segmentIndex: 5 },
            isSegment: true,
            requestedSegmentNum: 5,
            adapter: zeroOffsetAdapter,
        });

        expect(state.globalSegmentOffset).toBe(50);
        // Must be 0 (per-stream), not 50 (global fallback from old buggy code)
        expect(state.segmentOffset).toBe(0);
        // actualSegmentIndex = 5 - 0 = 5
        expect(state.actualSegmentIndex).toBe(5);
    });

    it('produces actualSegmentIndex=0 exactly at the offset boundary', () => {
        // requestedSegmentNum === segmentOffset → first file segment (index 0)
        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: 'stream_0', segmentIndex: 80 },
            isSegment: true,
            requestedSegmentNum: 80, // equals stream_0 offset (80)
            adapter,
        });

        expect(state.segmentOffset).toBe(80);
        expect(state.actualSegmentIndex).toBe(0);
        // index 0 is <= 2, so isSegmentDeletedForJob returns true
        expect(state.segmentWasDeleted).toBe(true);
    });

    it('produces actualSegmentIndex=-1 for request one below the offset boundary', () => {
        // requestedSegmentNum = offset - 1 → actualSegmentIndex = -1
        // segmentWasDeleted must be false despite isSegmentDeletedForJob(0<=2)
        // because the guard requires actualSegmentIndex >= 0.
        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: 'stream_0', segmentIndex: 79 },
            isSegment: true,
            requestedSegmentNum: 79, // offset is 80, so 79-80 = -1
            adapter,
        });

        expect(state.actualSegmentIndex).toBe(-1);
        expect(state.segmentWasDeleted).toBe(false);
    });

    it('scales streamReadyForDiagnostics when stream target duration differs from job duration', () => {
        // stream_0 has targetDuration=6, jobSegmentDuration=10, segmentsReady=30
        // streamReadyForDiagnostics = floor(30 * 10 / 6) = 50
        // currentProgressForDiagnostics = 50 + segmentOffset(80) = 130
        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: 'stream_0', segmentIndex: 90 },
            isSegment: true,
            requestedSegmentNum: 90,
            adapter,
        });

        expect(state.jobSegmentDuration).toBe(10);
        expect(state.streamTargetDuration).toBe(6);
        expect(state.streamReadyForDiagnostics).toBe(50);
        expect(state.currentProgressForDiagnostics).toBe(130);
    });

    it('does not scale streamReadyForDiagnostics when durations match', () => {
        // stream_2 has no distinct target duration → falls back to jobSegmentDuration (10)
        // streamReadyForDiagnostics = segmentsReady (30), no scaling
        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: 'stream_2', segmentIndex: 110 },
            isSegment: true,
            requestedSegmentNum: 110,
            adapter,
        });

        expect(state.streamTargetDuration).toBe(10);
        expect(state.streamReadyForDiagnostics).toBe(30);
        // currentProgressForDiagnostics = 30 + segmentOffset(100) = 130
        expect(state.currentProgressForDiagnostics).toBe(130);
    });

    it('uses canSeek=true for stream_2 and false for other streams', () => {
        const seekState = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: 'stream_2', segmentIndex: 110 },
            isSegment: true,
            requestedSegmentNum: 110,
            adapter,
        });
        const noSeekState = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: 'stream_0', segmentIndex: 90 },
            isSegment: true,
            requestedSegmentNum: 90,
            adapter,
        });

        expect(seekState.canSeek).toBe(true);
        expect(noSeekState.canSeek).toBe(false);
    });

    it('falls back streamTargetDuration to jobSegmentDuration for empty streamDirName', () => {
        // muxed mode: streamDirName='' is falsy, so streamTargetDuration falls
        // back to jobSegmentDuration rather than calling getStreamTargetDurationForJob.
        const muxedAdapter: HlsSegmentRequestStateAdapter = {
            ...adapter,
            getSegmentOffsetForJob: () => 21,
            getStreamSegmentOffsetForJob: () => 24,
            getStreamTargetDurationForJob: () => 6, // would return 6 if called
        };

        const state = buildHlsSegmentRequestState({
            job: createJob('copy'),
            segmentInfo: { streamDir: '', segmentIndex: 24 },
            isSegment: true,
            requestedSegmentNum: 24,
            adapter: muxedAdapter,
        });

        expect(state.streamDirName).toBe('');
        // Empty streamDirName → streamTargetDuration falls back to jobSegmentDuration (10)
        expect(state.streamTargetDuration).toBe(10);
        expect(state.jobSegmentDuration).toBe(10);
    });
});
