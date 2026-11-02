// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The planner and the HLS job must reach the SAME verdict on a quality cap.
 *
 * Windows e2e 2026-09-27: for a 1080p HEVC MKV with a "1080p 10 Mbps" cap the
 * planner compared the container bitrate (4.6 Mbps) and chose a remux; the job
 * compared the per-stream video bitrate — absent for MKV — treated "unknown"
 * as exceeding, and flipped the job to a software transcode behind a copy-grid
 * playlist (two jobs per switch, 15-18 s restarts).
 *
 * Both sides now read one number (capComparableBitrate — the scanner's
 * media_files.total_bitrate formula) and one rule (a bound binds only when the
 * source is KNOWN to exceed it), and the job trusts a plan that was evaluated
 * against the same cap. These tests pin the planner's real checkCompatibility
 * against the job's real qualityCapForcesTranscode on the same inputs.
 */

import { describe, it, expect } from 'vitest';
import {
    checkCompatibility,
    type DeviceCapabilities,
    type MediaInfo,
} from '$lib/server/utils/media-compatibility.js';
import {
    capComparableBitrate,
    planEvaluatedQualityCap,
    qualityCapForcesTranscode,
    type PlanQualityCap,
    type QualityCap,
} from './quality-cap.js';

/** A browser that plays the source codec — only the cap can force a transcode. */
function caps(cap: QualityCap): DeviceCapabilities {
    return {
        videoCodecs: new Set(['h264', 'hevc']),
        audioCodecs: new Set(['aac', 'eac3', 'ac3']),
        hlsAudioCodecs: new Set(['aac', 'eac3', 'ac3']),
        containers: new Set(['mp4', 'matroska', 'mkv']),
        canSwitchAudioInDirectPlay: false,
        userSelectedMaxBitrate: cap.maxBitrate,
        userSelectedMaxHeight: cap.maxHeight,
    };
}

function source(bitrate: { formatBitrate?: number; videoBitrate?: number }): {
    media: MediaInfo;
    height: number;
    capBitrate: number | undefined;
} {
    const capBitrate = capComparableBitrate(bitrate);
    return {
        height: 1080,
        capBitrate,
        media: {
            videoCodec: 'hevc',
            audioCodecs: ['eac3'],
            audioTrackCount: 2,
            container: 'mkv',
            hdr: 'sdr',
            width: 1920,
            height: 1080,
            bitrate: capBitrate,
        },
    };
}

/** The planner's verdict: did the cap force a (video) transcode? */
function plannerTranscodesForCap(media: MediaInfo, cap: QualityCap): boolean {
    const compat = checkCompatibility(media, caps(cap));
    return (
        (compat.bitrateExceeded && compat.bitrateExceededSource === 'user') ||
        (compat.resolutionExceeded && compat.resolutionExceededSource === 'user')
    );
}

function planCapOf(cap: QualityCap): PlanQualityCap {
    return { max_bitrate: cap.maxBitrate, max_height: cap.maxHeight };
}

const CAP_1080P_10M: QualityCap = { maxBitrate: 10_000_000, maxHeight: 1080 };
const CAP_720P_4M: QualityCap = { maxBitrate: 4_000_000, maxHeight: 720 };

describe('capComparableBitrate — one bitrate for both sides', () => {
    it('prefers the container bitrate, falls back to the video stream', () => {
        expect(capComparableBitrate({ formatBitrate: 4_600_000, videoBitrate: 4_000_000 })).toBe(
            4_600_000,
        );
        expect(capComparableBitrate({ videoBitrate: 4_000_000 })).toBe(4_000_000);
        expect(capComparableBitrate({ formatBitrate: 0, videoBitrate: 3_000_000 })).toBe(3_000_000);
    });

    it('is undefined when neither is known', () => {
        expect(capComparableBitrate({})).toBeUndefined();
        expect(capComparableBitrate({ formatBitrate: null, videoBitrate: null })).toBeUndefined();
    });
});

describe('planner and job agree on a capped request', () => {
    it('known bitrate within the cap (the incident file at 1080p 10 Mbps): both keep the copy', () => {
        const s = source({ formatBitrate: 4_600_000 });
        expect(plannerTranscodesForCap(s.media, CAP_1080P_10M)).toBe(false);
        // With the plan's cap recorded AND without it (safety net) — no flip.
        expect(
            qualityCapForcesTranscode(
                CAP_1080P_10M,
                s.height,
                s.capBitrate,
                planCapOf(CAP_1080P_10M),
            ).force,
        ).toBe(false);
        expect(qualityCapForcesTranscode(CAP_1080P_10M, s.height, s.capBitrate).force).toBe(false);
    });

    it('known bitrate above the cap (720p 4 Mbps): the planner transcodes, the job trusts it', () => {
        const s = source({ formatBitrate: 4_600_000 });
        expect(plannerTranscodesForCap(s.media, CAP_720P_4M)).toBe(true);
        // The plan evaluated this cap — the job never re-decides it.
        expect(
            qualityCapForcesTranscode(CAP_720P_4M, s.height, s.capBitrate, planCapOf(CAP_720P_4M)),
        ).toEqual({ force: false, reason: 'plan_evaluated' });
        // A plan built WITHOUT the cap: the safety net reaches the planner's verdict.
        expect(qualityCapForcesTranscode(CAP_720P_4M, s.height, s.capBitrate)).toEqual({
            force: true,
            reason: 'safety_net',
        });
    });

    it('container bitrate known but no per-stream bitrate (typical MKV): both see the same number', () => {
        // Above the cap only via the container bitrate. The job used to read the
        // (absent) stream bitrate and disagree.
        const s = source({ formatBitrate: 12_000_000, videoBitrate: undefined });
        expect(s.capBitrate).toBe(12_000_000);
        expect(plannerTranscodesForCap(s.media, CAP_1080P_10M)).toBe(true);
        expect(qualityCapForcesTranscode(CAP_1080P_10M, s.height, s.capBitrate).force).toBe(true);
    });

    it('truly unknown bitrate: neither side flips — trust the plan', () => {
        const s = source({});
        expect(s.capBitrate).toBeUndefined();
        expect(plannerTranscodesForCap(s.media, CAP_1080P_10M)).toBe(false);
        expect(qualityCapForcesTranscode(CAP_1080P_10M, s.height, s.capBitrate)).toEqual({
            force: false,
            reason: 'within_cap',
        });
        expect(
            qualityCapForcesTranscode(
                CAP_1080P_10M,
                s.height,
                s.capBitrate,
                planCapOf(CAP_1080P_10M),
            ).force,
        ).toBe(false);
    });

    it('a known height above the cap still binds on both sides with an unknown bitrate', () => {
        const s = source({});
        const cap: QualityCap = { maxHeight: 720 };
        expect(plannerTranscodesForCap(s.media, cap)).toBe(true);
        expect(qualityCapForcesTranscode(cap, s.height, s.capBitrate).force).toBe(true);
    });
});

describe('planEvaluatedQualityCap', () => {
    it('covers the job cap when every bound is matched at least as tightly', () => {
        expect(
            planEvaluatedQualityCap({ max_bitrate: 10_000_000 }, { maxBitrate: 10_000_000 }),
        ).toBe(true);
        expect(
            planEvaluatedQualityCap(
                { max_bitrate: 4_000_000, max_height: 720 },
                { maxBitrate: 10_000_000 },
            ),
        ).toBe(true);
    });

    it('does not cover a looser, different or missing plan cap', () => {
        expect(planEvaluatedQualityCap(undefined, { maxBitrate: 10_000_000 })).toBe(false);
        expect(
            planEvaluatedQualityCap({ max_bitrate: 20_000_000 }, { maxBitrate: 10_000_000 }),
        ).toBe(false);
        expect(planEvaluatedQualityCap({ max_bitrate: 10_000_000 }, { maxHeight: 1080 })).toBe(
            false,
        );
    });
});
