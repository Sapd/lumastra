// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { restartRateWindow, updateLiveRates } from './live-rates.js';
import type { TranscodeJob } from './types.js';

type RateJob = Pick<TranscodeJob, 'rateSample' | 'transcodeSpeed' | 'transcodeFps'>;

describe('updateLiveRates', () => {
    it("uses FFmpeg's own readings until a full window has passed", () => {
        const job: RateJob = {};
        updateLiveRates(job, { mediaSeconds: 0, frames: 0 }, 0, { speed: 38, fps: 950 });
        updateLiveRates(job, { mediaSeconds: 20, frames: 500 }, 1000, { speed: 40, fps: 960 });
        expect(job.transcodeSpeed).toBe(40);
        expect(job.transcodeFps).toBe(960);
    });

    it('measures speed and fps from time=/frame= deltas once a window has passed', () => {
        const job: RateJob = {};
        updateLiveRates(job, { mediaSeconds: 0, frames: 0 }, 0, { speed: 38 });
        updateLiveRates(job, { mediaSeconds: 120, frames: 3000 }, 3000, { speed: 40 });
        expect(job.transcodeSpeed).toBe(40);
        expect(job.transcodeFps).toBe(1000);
    });

    it("keeps a pause out of the rate — FFmpeg's since-start average does not", () => {
        const job: RateJob = {};
        updateLiveRates(job, { mediaSeconds: 0, frames: 0 }, 0, {});
        updateLiveRates(job, { mediaSeconds: 120, frames: 3000 }, 3000, {});
        expect(job.transcodeSpeed).toBe(40);

        // Paused for 60 s, then resumed: the throttle restarts the window.
        restartRateWindow(job);
        // FFmpeg's average now reads 14.6x; it must not win any more.
        updateLiveRates(job, { mediaSeconds: 122, frames: 3050 }, 63_100, { speed: 14.6 });
        expect(job.transcodeSpeed).toBe(40);
        updateLiveRates(job, { mediaSeconds: 242, frames: 6050 }, 66_100, { speed: 16 });
        expect(job.transcodeSpeed).toBe(40);
        expect(job.transcodeFps).toBe(1000);
    });

    it('starts a new window when time goes backwards', () => {
        const job: RateJob = {};
        updateLiveRates(job, { mediaSeconds: 100 }, 0, {});
        updateLiveRates(job, { mediaSeconds: 10 }, 4000, {});
        expect(job.rateSample?.anchor).toEqual({ at: 4000, mediaSeconds: 10 });
    });
});
