// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    buildTranscodeProgressView,
    formatClock,
    isTranscodeFinished,
    SOFTWARE_FALLBACK_NOTICE_MS,
    stableDisplayFps,
    transcodeNotice,
    encoderExplainsWaiting,
    SLOW_READING_MAX_AGE_MS,
} from './transcode-progress-view.js';

const T0 = 1_000_000;
const reading = {
    progressPercent: 60,
    segmentsReady: 154,
    totalSegments: 256,
    elapsedSeconds: 30,
    speed: 2,
    etaSeconds: 40,
    receivedAt: T0,
};

describe('buildTranscodeProgressView', () => {
    it('ticks elapsed and ETA between readings', () => {
        const view = buildTranscodeProgressView(reading, T0 + 5_400);
        expect(view.elapsedSeconds).toBe(35);
        expect(view.etaSeconds).toBe(35);
        expect(view.state).toBe('running');
    });

    it('never counts the ETA below zero', () => {
        expect(buildTranscodeProgressView(reading, T0 + 120_000).etaSeconds).toBe(0);
    });

    it('shows the throttle pause instead of an ETA', () => {
        const view = buildTranscodeProgressView(
            { ...reading, throttled: true, bufferAheadSeconds: 130 },
            T0,
        );
        expect(view.state).toBe('paused');
        expect(view.etaSeconds).toBeUndefined();
        expect(view.aheadSeconds).toBe(130);
    });

    it('a paused transcode stays paused even at 100 %', () => {
        expect(
            buildTranscodeProgressView({ ...reading, progressPercent: 100, throttled: true }, T0)
                .state,
        ).toBe('paused');
    });

    it('freezes elapsed once the transcode is complete', () => {
        const done = buildTranscodeProgressView({ ...reading, progressPercent: 100 }, T0 + 60_000);
        expect(done.elapsedSeconds).toBe(30);
    });

    it('flags encoding below realtime as slow, and finished as complete', () => {
        expect(buildTranscodeProgressView({ ...reading, speed: 0.7 }, T0).state).toBe('slow');
        const done = buildTranscodeProgressView({ ...reading, progressPercent: 100 }, T0);
        expect(done.state).toBe('complete');
        expect(done.etaSeconds).toBeUndefined();
    });

    it('shows no ETA without a server estimate rather than guessing from elapsed time', () => {
        const { etaSeconds, ...rest } = reading;
        void etaSeconds;
        expect(buildTranscodeProgressView(rest, T0).etaSeconds).toBeUndefined();
    });
});

describe('coverage', () => {
    it('an encoder that reached the end after a seek is complete, with partial coverage', () => {
        const view = buildTranscodeProgressView(
            {
                ...reading,
                progressPercent: 85,
                encoderPercent: 100,
                coveredRanges: [
                    { start: 0, end: 10 },
                    { start: 25, end: 100 },
                ],
            },
            T0,
        );
        expect(view.state).toBe('complete');
        expect(view.percent).toBe(85);
        expect(view.encoderPercent).toBeUndefined();
        expect(view.ranges).toHaveLength(2);
    });

    it('marks the encoder position while it runs', () => {
        const view = buildTranscodeProgressView(
            { ...reading, encoderPercent: 72.5, coveredRanges: [{ start: 50, end: 72.5 }] },
            T0,
        );
        expect(view.encoderPercent).toBe(72.5);
    });

    it('draws an older server reading as one range from the start', () => {
        expect(buildTranscodeProgressView(reading, T0).ranges).toEqual([{ start: 0, end: 60 }]);
    });

    it('clamps out-of-range values and drops empty ranges', () => {
        const view = buildTranscodeProgressView(
            {
                ...reading,
                coveredRanges: [
                    { start: -5, end: 10 },
                    { start: 30, end: 30 },
                    { start: 90, end: 120 },
                ],
            },
            T0,
        );
        expect(view.ranges).toEqual([
            { start: 0, end: 10 },
            { start: 90, end: 100 },
        ]);
        expect(buildTranscodeProgressView({ ...reading, progressPercent: 0 }, T0).ranges).toEqual(
            [],
        );
    });

    it('isTranscodeFinished: encoder at the end and not paused', () => {
        expect(isTranscodeFinished({ progressPercent: 40, encoderPercent: 100 })).toBe(true);
        expect(isTranscodeFinished({ progressPercent: 100, encoderPercent: 70 })).toBe(false);
        expect(isTranscodeFinished({ progressPercent: 100 })).toBe(true);
        expect(
            isTranscodeFinished({ progressPercent: 100, encoderPercent: 100, throttled: true }),
        ).toBe(false);
    });
});

describe('formatClock', () => {
    it('formats minutes and hours', () => {
        expect(formatClock(5)).toBe('0:05');
        expect(formatClock(125)).toBe('2:05');
        expect(formatClock(3725)).toBe('1:02:05');
    });
});

describe('stableDisplayFps', () => {
    it('shows the source rate while the measurement wobbles around it', () => {
        expect(stableDisplayFps(24.99, 25)).toBe(25);
        expect(stableDisplayFps(25.4, 25)).toBe(25);
        expect(stableDisplayFps(23.95, 23.976)).toBe(23.976);
    });

    it('shows a clearly lower measured rate as a whole number', () => {
        expect(stableDisplayFps(18.37, 25)).toBe(18);
    });

    it('falls back to the source rate before the first sample, and rounds without one', () => {
        expect(stableDisplayFps(null, 29.97)).toBe(29.97);
        expect(stableDisplayFps(59.6, undefined)).toBe(60);
        expect(stableDisplayFps(undefined, undefined)).toBeUndefined();
    });
});

describe('transcodeNotice', () => {
    it('is silent while the encode keeps up', () => {
        expect(transcodeNotice({}, undefined, T0)).toBeNull();
        expect(transcodeNotice(null, undefined, T0)).toBeNull();
    });

    it('names the busy GPU encoder or the slow CPU, as the server judged it', () => {
        expect(transcodeNotice({ slowReason: 'gpu_busy' }, undefined, T0)).toBe('gpu_busy');
        expect(transcodeNotice({ slowReason: 'cpu_slow' }, undefined, T0)).toBe('cpu_slow');
    });

    it('stays quiet when minutes are already encoded ahead, or the throttle paused it', () => {
        expect(
            transcodeNotice({ slowReason: 'gpu_busy', bufferAheadSeconds: 300 }, undefined, T0),
        ).toBeNull();
        expect(
            transcodeNotice({ slowReason: 'gpu_busy', throttled: true }, undefined, T0),
        ).toBeNull();
    });

    it('says the video switched to software for a few seconds only', () => {
        const progress = { softwareFallbackFrom: 'hevc_nvenc' };
        expect(transcodeNotice(progress, T0, T0 + 1000)).toBe('software_fallback');
        expect(transcodeNotice(progress, T0, T0 + SOFTWARE_FALLBACK_NOTICE_MS)).toBeNull();
    });

    it('a throttle pause right after the switch does not hide the switch notice', () => {
        expect(
            transcodeNotice({ softwareFallbackFrom: 'hevc_nvenc', throttled: true }, T0, T0 + 1000),
        ).toBe('software_fallback');
    });

    it('a software fallback that cannot keep up says both', () => {
        expect(
            transcodeNotice(
                { softwareFallbackFrom: 'hevc_nvenc', slowReason: 'gpu_busy' },
                T0,
                T0 + 60_000,
            ),
        ).toBe('software_fallback_slow');
    });
});

describe('encoderExplainsWaiting', () => {
    it('only a server-judged slow encode that is not throttle-paused explains a stall', () => {
        expect(encoderExplainsWaiting({ slowReason: 'gpu_busy' })).toBe(true);
        expect(encoderExplainsWaiting({ slowReason: 'cpu_slow', throttled: true })).toBe(false);
        expect(encoderExplainsWaiting({})).toBe(false);
        expect(encoderExplainsWaiting(null)).toBe(false);
    });

    it('before the first heartbeat, the startup probe answer counts', () => {
        expect(encoderExplainsWaiting(null, { slowReason: 'gpu_busy' })).toBe(true);
        expect(encoderExplainsWaiting(null, { softwareFallbackFrom: 'hevc_nvenc' })).toBe(false);
        // A progress reading wins over the older startup answer.
        expect(encoderExplainsWaiting({}, { slowReason: 'gpu_busy' })).toBe(false);
    });
});

describe('encoderExplainsWaiting — stale readings', () => {
    it('a slow reading the heartbeat stopped refreshing no longer explains a stall', () => {
        const reading = { slowReason: 'gpu_busy' as const, receivedAt: T0 };
        expect(encoderExplainsWaiting(reading, null, T0 + SLOW_READING_MAX_AGE_MS)).toBe(true);
        expect(encoderExplainsWaiting(reading, null, T0 + SLOW_READING_MAX_AGE_MS + 1)).toBe(false);
        // Not even via an older startup answer.
        expect(encoderExplainsWaiting(reading, { slowReason: 'gpu_busy' }, T0 + 120_000)).toBe(
            false,
        );
    });
});
