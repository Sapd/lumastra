// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import { AdaptiveDriftCompensator } from './adaptive-drift-compensator';
import type { DEFAULT_CONFIG } from './adaptive-drift-compensator';

describe('AdaptiveDriftCompensator', () => {
    let time: number;
    let compensator: AdaptiveDriftCompensator;

    // Helper to create compensator with controlled time
    const createCompensator = (
        config?: Partial<typeof DEFAULT_CONFIG>,
    ): AdaptiveDriftCompensator => {
        time = 0;
        return new AdaptiveDriftCompensator(config, () => time);
    };

    // Helper to advance time
    const advanceTime = (ms: number): void => {
        time += ms;
    };

    // Helper to simulate drift measurements over time
    const simulateDrift = (
        comp: AdaptiveDriftCompensator,
        count: number,
        intervalMs: number,
        driftFn: (index: number) => {
            drift: number;
            guestPos: number;
            hostPos: number;
        },
    ) => {
        const results = [];
        for (let i = 0; i < count; i++) {
            const { drift, guestPos, hostPos } = driftFn(i);
            results.push(comp.update(drift, guestPos, hostPos));
            advanceTime(intervalMs);
        }
        return results;
    };

    describe('Initial State', () => {
        it('should start in measuring state', () => {
            compensator = createCompensator();
            expect(compensator.getState()).toBe('measuring');
        });

        it('should start with rate 1.0', () => {
            compensator = createCompensator();
            expect(compensator.getRate()).toBe(1.0);
        });

        it('should start with no samples', () => {
            compensator = createCompensator();
            expect(compensator.getSampleCount()).toBe(0);
        });

        it('should have default config', () => {
            compensator = createCompensator();
            const config = compensator.getConfig();
            expect(config.hardSeekThreshold).toBe(5.0);
            expect(config.maxRateAdjustment).toBe(0.05);
        });
    });

    describe('Measuring State', () => {
        beforeEach(() => {
            compensator = createCompensator({
                measureDuration: 5000,
                minSamplesForCalibration: 3,
                hardSeekThreshold: 15, // High threshold so small drifts don't trigger seeks
            });
            compensator.setMediaDuration(7200); // 2 hour movie
        });

        it('should stay in measuring until enough time has passed', () => {
            // Add samples but not enough time
            for (let i = 0; i < 5; i++) {
                compensator.update(1.0, 3590, 3600);
                advanceTime(500); // Only 2.5s total
            }
            expect(compensator.getState()).toBe('measuring');
        });

        it('should stay in measuring until enough samples collected', () => {
            // Enough time but not enough samples
            compensator.update(1.0, 3590, 3600);
            advanceTime(6000);
            compensator.update(1.0, 3595, 3606);
            expect(compensator.getState()).toBe('measuring');
        });

        it('should transition to locked after enough time and samples', () => {
            for (let i = 0; i < 5; i++) {
                compensator.update(10, 3590 + i * 6, 3600 + i * 6);
                advanceTime(1500);
            }
            expect(compensator.getState()).toBe('locked');
        });

        it('should return action none while measuring', () => {
            const result = compensator.update(1.0, 3590, 3600);
            expect(result.action).toBe('none');
        });
    });

    describe('Finish-Time Rate Calculation', () => {
        beforeEach(() => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                maxRateAdjustment: 0.05,
                hardSeekThreshold: 600, // High threshold to allow large drift testing
            });
            compensator.setMediaDuration(7200); // 2 hour movie
        });

        it('should calculate correct rate for guest behind host', () => {
            // Guest at 3590s, Host at 3600s (10s behind)
            // syncTime = min(300, 3600) = 300s
            // Required rate = (300 + 10) / 300 = 1.0333x
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 10,
                guestPos: 3590,
                hostPos: 3600,
            }));

            const rate = compensator.getRate();
            expect(rate).toBeCloseTo(1.0333, 3);
        });

        it('should calculate correct rate for guest ahead of host', () => {
            // Guest at 3610s, Host at 3600s (10s ahead)
            // syncTime = min(300, 3600) = 300s
            // Required rate = (300 + (-10)) / 300 = 0.9667x
            simulateDrift(compensator, 5, 1000, () => ({
                drift: -10,
                guestPos: 3610,
                hostPos: 3600,
            }));

            const rate = compensator.getRate();
            expect(rate).toBeCloseTo(0.9667, 3);
        });

        it('should calculate larger rate for larger drift', () => {
            // 15s behind - syncTime = 300s
            // Required rate = (300 + 15) / 300 = 1.05x (exactly at max)
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 15,
                guestPos: 3585,
                hostPos: 3600,
            }));

            const rate = compensator.getRate();
            expect(rate).toBe(1.05); // Clamped to max
        });

        it('should use targetSyncTime for faster correction', () => {
            // 5s behind - with 300s sync time gives more aggressive rate
            // syncTime = 300s, drift = 5s
            // Required rate = (300 + 5) / 300 = 1.0167x
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 5,
                guestPos: 595,
                hostPos: 600,
            }));

            const rate = compensator.getRate();
            expect(rate).toBeCloseTo(1.0167, 3);
        });

        it('should clamp rate at maximum adjustment', () => {
            // Extreme drift: 500s behind (way more than 5% can fix)
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 500,
                guestPos: 3100,
                hostPos: 3600,
            }));

            const rate = compensator.getRate();
            expect(rate).toBe(1.05); // Clamped at max
        });

        it('should not adjust near end of video', () => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                minRemainingTime: 60,
            });
            compensator.setMediaDuration(7200);

            // 10s behind but only 30s remaining
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 10,
                guestPos: 7160,
                hostPos: 7170,
            }));

            // Should stay at 1.0 (no adjustment near end)
            expect(compensator.getRate()).toBe(1.0);
        });

        it('should use finish-time method when duration is set', () => {
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 10,
                guestPos: 3590,
                hostPos: 3600,
            }));

            const info = compensator.getLastCalibrationInfo();
            expect(info?.method).toBe('finish-time');
        });
    });

    describe('Drift-Velocity Fallback', () => {
        beforeEach(() => {
            compensator = createCompensator({
                measureDuration: 5000,
                minSamplesForCalibration: 5,
                useFinishTimeSync: true, // But no duration set!
                hardSeekThreshold: 15, // High threshold for testing
            });
            // Note: NOT setting media duration - should fall back to velocity
        });

        it('should fall back to drift-velocity when duration unknown', () => {
            // Simulate drift growing at 10ms/second
            simulateDrift(compensator, 10, 1000, (i) => ({
                drift: i * 0.01,
                guestPos: 100 + i,
                hostPos: 100 + i + i * 0.01,
            }));

            const info = compensator.getLastCalibrationInfo();
            expect(info?.method).toBe('drift-velocity');
        });

        it('should calculate positive rate for positive drift velocity', () => {
            // Drift growing: 0, 0.01, 0.02, ... (10ms per second)
            simulateDrift(compensator, 10, 1000, (i) => ({
                drift: i * 0.01,
                guestPos: 100 + i,
                hostPos: 100 + i + i * 0.01,
            }));

            const rate = compensator.getRate();
            expect(rate).toBeGreaterThan(1.0);
        });

        it('should use finish-time when duration becomes available', () => {
            // First calibrate without duration
            simulateDrift(compensator, 10, 1000, (i) => ({
                drift: i * 0.01,
                guestPos: 100 + i,
                hostPos: 100 + i + i * 0.01,
            }));
            expect(compensator.getLastCalibrationInfo()?.method).toBe('drift-velocity');

            // Now set duration and recalibrate
            compensator.setMediaDuration(7200);
            compensator.forceRecalibrate();

            simulateDrift(compensator, 10, 1000, () => ({
                drift: 10,
                guestPos: 3590,
                hostPos: 3600,
            }));

            expect(compensator.getLastCalibrationInfo()?.method).toBe('finish-time');
        });
    });

    describe('Locked State', () => {
        beforeEach(() => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                hardSeekThreshold: 15, // High threshold to allow drift testing
            });
            compensator.setMediaDuration(7200);

            // Get to locked state with small drift (2s)
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 2,
                guestPos: 3598,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');
        });

        it('should stay locked and not change rate during normal playback', () => {
            // Simulate 5 minutes of normal playback with stable drift
            let rateChanges = 0;
            for (let i = 0; i < 60; i++) {
                const result = compensator.update(
                    2, // Stable 2s drift (same as initial)
                    3598 + i * 5,
                    3600 + i * 5,
                );
                if (result.action === 'rate') rateChanges++;
                advanceTime(5000);
            }

            // Rate should not change significantly when drift is stable
            // (may have 1 recalibration if interval is reached)
            expect(rateChanges).toBeLessThanOrEqual(1);
            expect(compensator.getState()).toBe('locked');
        });

        it('should return action none while locked', () => {
            const result = compensator.update(10, 3600, 3610);
            expect(result.action).toBe('none');
        });
    });

    describe('Hard Seek', () => {
        beforeEach(() => {
            compensator = createCompensator({
                hardSeekThreshold: 5.0,
                seekLatencyOffset: 0.25,
                measureDuration: 3000, // Shorter measurement period for testing
                minSamplesForCalibration: 3,
            });
            compensator.setMediaDuration(7200);
        });

        it('should trigger hard seek when drift exceeds threshold', () => {
            const result = compensator.update(6.0, 3594, 3600);
            expect(result.action).toBe('seek');
        });

        it('should include seek target with latency offset', () => {
            const result = compensator.update(6.0, 3594, 3600);
            expect(result.seekTarget).toBe(3600.25); // hostPos + offset
        });

        it('should suppress repeated hard seeks until the player has settled', () => {
            expect(compensator.update(6.0, 3594, 3600).action).toBe('seek');
            advanceTime(2000);
            expect(compensator.update(6.0, 3596, 3602).action).toBe('none');
            advanceTime(4000);
            expect(compensator.update(6.0, 3600, 3606).action).toBe('seek');
        });

        it('should reset to measuring state after hard seek', () => {
            // Get to locked state first
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 2,
                guestPos: 3598,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');

            // Trigger hard seek
            compensator.update(6.0, 3594, 3600);
            expect(compensator.getState()).toBe('measuring');
        });

        it('should clear samples after hard seek', () => {
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 2,
                guestPos: 3598,
                hostPos: 3600,
            }));
            expect(compensator.getSampleCount()).toBeGreaterThan(0);

            compensator.update(6.0, 3594, 3600);
            expect(compensator.getSampleCount()).toBe(0);
        });

        it('should handle negative drift (guest ahead) exceeding threshold', () => {
            const result = compensator.update(-6.0, 3606, 3600);
            expect(result.action).toBe('seek');
            expect(result.seekTarget).toBe(3600.25);
        });
    });

    describe('Original Rate Support', () => {
        beforeEach(() => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                hardSeekThreshold: 15, // High threshold for testing
            });
            compensator.setMediaDuration(7200);
        });

        it('should apply compensation relative to original rate', () => {
            compensator.setOriginalRate(1.25); // User watching at 1.25x

            // 10s behind
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 10,
                guestPos: 3590,
                hostPos: 3600,
            }));

            // Rate = 1.25 + 10/300 = 1.2833x. targetSyncTime is wall time.
            const rate = compensator.getRate();
            expect(rate).toBeGreaterThan(1.25);
            expect(rate).toBeCloseTo(1.2833, 3);
        });

        it('should recalibrate when original rate changes', () => {
            // First calibrate at 1.0x
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 10,
                guestPos: 3590,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');

            // Change to 1.5x
            compensator.setOriginalRate(1.5);

            // Should trigger recalibration
            expect(compensator.getState()).toBe('measuring');
        });

        it('should immediately apply new original rate while measuring', () => {
            // Start measuring at default 1.0x
            compensator.update(2, 3598, 3600);
            expect(compensator.getState()).toBe('measuring');
            expect(compensator.getRate()).toBe(1.0);

            // Change to 1.25x while still measuring
            compensator.setOriginalRate(1.25);

            // Next update should immediately apply the new base rate
            advanceTime(500);
            const result = compensator.update(2, 3598.5, 3600.5);

            expect(result.action).toBe('rate');
            expect(result.rate).toBe(1.25);
            expect(compensator.getRate()).toBe(1.25);
            expect(compensator.getState()).toBe('measuring'); // Still measuring
        });
    });

    describe('Reset and Recalibration', () => {
        it('should reset to initial state', () => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                hardSeekThreshold: 15, // High threshold for testing
            });
            compensator.setMediaDuration(7200);

            // Get to locked with modified rate
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 10,
                guestPos: 3590,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');
            expect(compensator.getRate()).not.toBe(1.0);

            // Reset
            compensator.reset();

            expect(compensator.getState()).toBe('measuring');
            expect(compensator.getRate()).toBe(1.0);
            expect(compensator.getSampleCount()).toBe(0);
        });

        it('should force recalibration', () => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                hardSeekThreshold: 15, // High threshold for testing
            });
            compensator.setMediaDuration(7200);

            // Get to locked
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 10,
                guestPos: 3590,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');

            // Force recalibrate (e.g., host seeked)
            compensator.forceRecalibrate();

            expect(compensator.getState()).toBe('measuring');
            expect(compensator.getSampleCount()).toBe(0);
        });

        it('should calibrate immediately after seek (skipping measuring phase)', () => {
            compensator = createCompensator({
                measureDuration: 5000,
                minSamplesForCalibration: 5,
            });
            compensator.setMediaDuration(7200); // 2hr movie

            // Guest at 3590, host at 3600 (10s drift)
            const result = compensator.calibrateImmediately(3590, 3600);

            // Should immediately lock and return rate
            expect(compensator.getState()).toBe('locked');
            expect(result.action).toBe('rate');
            expect(result.rate).toBeGreaterThan(1.0); // Should speed up to catch up
            expect(compensator.getLastCalibrationInfo()?.method).toBe('finish-time');
        });

        it('should return original rate for small drift in immediate calibration', () => {
            compensator = createCompensator();
            compensator.setMediaDuration(7200);

            // Very small drift (0.3s)
            const result = compensator.calibrateImmediately(3599.7, 3600);

            expect(compensator.getState()).toBe('locked');
            expect(result.action).toBe('rate');
            expect(result.rate).toBe(1.0); // Original rate for small drift
        });

        it('should handle immediate calibration without duration', () => {
            compensator = createCompensator();
            // No setMediaDuration call

            const result = compensator.calibrateImmediately(3590, 3600);

            expect(compensator.getState()).toBe('locked');
            expect(result.action).toBe('rate');
            expect(result.rate).toBe(1.0); // Falls back to original rate
        });
    });

    describe('Finish Time Difference Threshold', () => {
        it('should skip recalibration when finish time diff is below threshold', () => {
            // Set up a compensator with short recalibration interval for testing
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                initialRecalibrationInterval: 5000, // First check after 5s
                maxRecalibrationInterval: 5000, // Keep it constant for testing
                minFinishTimeDiff: 1.5, // 1.5 second threshold
                hardSeekThreshold: 20, // High threshold to avoid seeks in this test
            });
            compensator.setMediaDuration(7200); // 2hr movie

            // Get to locked state with initial calibration (2s drift, within threshold)
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 2,
                guestPos: 3598,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');
            const initialRate = compensator.getRate();

            // Advance time past recalibration interval (6 seconds)
            // Small drift change: 2s -> 2.2s drift
            // The finish time difference is tiny (< 1.5s threshold)
            advanceTime(6000);
            const result = compensator.update(2.2, 3597.8, 3600);

            // Should NOT recalibrate because finish time difference is too small
            expect(result.action).toBe('none');
            expect(compensator.getRate()).toBe(initialRate);
        });

        it('should recalibrate when finish time diff exceeds threshold', () => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                initialRecalibrationInterval: 5000,
                maxRecalibrationInterval: 5000,
                minFinishTimeDiff: 1.5,
                minRateChangeThreshold: 0.001, // Lower threshold to ensure rate change is applied
                hardSeekThreshold: 20, // High threshold to avoid seeks in this test
            });
            compensator.setMediaDuration(7200);

            // Get to locked state with small drift (2s)
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 2,
                guestPos: 3598,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');
            const initialRate = compensator.getRate();

            // Advance time and introduce significant drift change
            // Drift jumps from 2s to 15s - this will cause finish time diff > 1.5s
            // and rate change will exceed minRateChangeThreshold
            advanceTime(6000);
            const result = compensator.update(15, 3585, 3600);

            // Should recalibrate because finish time difference is significant
            expect(result.action).toBe('rate');
            expect(compensator.getRate()).not.toBe(initialRate);
        });

        it('should use exponential backoff for recalibration interval', () => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                initialRecalibrationInterval: 10000, // 10s
                maxRecalibrationInterval: 60000, // 60s max
                minFinishTimeDiff: 1.5,
                hardSeekThreshold: 20,
            });
            compensator.setMediaDuration(7200);

            // Get to locked state
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 2,
                guestPos: 3598,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');
            expect(compensator.getRecalibrationInterval()).toBe(10000);

            // First check - no change needed, should double interval
            advanceTime(11000);
            compensator.update(2, 3598, 3600);
            expect(compensator.getRecalibrationInterval()).toBe(20000);

            // Second check - no change needed, should double again
            advanceTime(21000);
            compensator.update(2, 3598, 3600);
            expect(compensator.getRecalibrationInterval()).toBe(40000);

            // Third check - should cap at max
            advanceTime(41000);
            compensator.update(2, 3598, 3600);
            expect(compensator.getRecalibrationInterval()).toBe(60000);
        });
    });

    describe('Full Scenario: Realistic Watch Together Session', () => {
        it('should handle complete viewing session with minimal rate changes', () => {
            compensator = createCompensator({
                measureDuration: 5000,
                minSamplesForCalibration: 5,
                hardSeekThreshold: 20.0, // High threshold to avoid seeks during test
                initialRecalibrationInterval: 0, // Disable periodic recalibration for this test
            });
            compensator.setMediaDuration(7200); // 2hr movie

            // Phase 1: Join session - guest is 5s behind
            let rateActions = 0;
            let seekActions = 0;

            // Initial measurement period
            for (let i = 0; i < 10; i++) {
                const result = compensator.update(
                    5, // Constant 5s behind
                    3595 + i * 2,
                    3600 + i * 2,
                );
                if (result.action === 'rate') rateActions++;
                if (result.action === 'seek') seekActions++;
                advanceTime(1000);
            }

            // Should have calibrated with exactly 1 rate change
            expect(compensator.getState()).toBe('locked');
            expect(rateActions).toBe(1);

            // Phase 2: Normal playback for 30 minutes (simulated)
            // Drift should stay stable due to compensation
            for (let i = 0; i < 360; i++) {
                // 30 min at 5s intervals
                const result = compensator.update(
                    4 + Math.random() * 2, // Drift wandering 4-6s
                    3595 + i * 5,
                    3600 + i * 5,
                );
                if (result.action === 'rate') rateActions++;
                if (result.action === 'seek') seekActions++;
                advanceTime(5000);
            }

            // Should still be locked with no additional rate changes
            expect(compensator.getState()).toBe('locked');
            expect(rateActions).toBe(1); // Only the initial calibration
            expect(seekActions).toBe(0);
        });

        it('should handle host seeking mid-movie', () => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                hardSeekThreshold: 30.0, // High to allow testing large drifts
            });
            compensator.setMediaDuration(7200);

            // Get to locked state with 5s drift
            // Rate = (7200-3595)/(7200-3600) = 3605/3600 = 1.00139
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 5,
                guestPos: 3595,
                hostPos: 3600,
            }));
            expect(compensator.getState()).toBe('locked');
            const firstRate = compensator.getRate();

            // Host seeks forward - guest receives seek event, recalibrates
            compensator.forceRecalibrate();
            expect(compensator.getState()).toBe('measuring');

            // New position after seek with significantly different drift (20s)
            // Near end: Rate = (7200-6880)/(7200-6900) = 320/300 = 1.0667
            // This is a BIG difference from the first rate
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 20,
                guestPos: 6880,
                hostPos: 6900,
            }));

            expect(compensator.getState()).toBe('locked');
            // Rate should be significantly different now
            expect(compensator.getRate()).not.toBe(firstRate);
            expect(compensator.getRate()).toBeGreaterThan(firstRate);
        });
    });

    describe('Edge Cases', () => {
        it('should handle zero drift', () => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
            });
            compensator.setMediaDuration(7200);

            simulateDrift(compensator, 5, 1000, () => ({
                drift: 0,
                guestPos: 3600,
                hostPos: 3600,
            }));

            expect(compensator.getRate()).toBeCloseTo(1.0, 4);
        });

        it('should handle very small drift', () => {
            // Very small drifts should NOT trigger rate changes due to the
            // minRateChangeThreshold filter (avoids micro-stutters).
            // The calculated rate would be ~1.0000278 but difference from 1.0
            // is only 0.0000278, which is below the 0.0005 threshold.
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
            });
            compensator.setMediaDuration(7200);

            simulateDrift(compensator, 5, 1000, () => ({
                drift: 0.1, // 100ms
                guestPos: 3599.9,
                hostPos: 3600,
            }));

            // Rate should stay at 1.0 because the change is too small
            expect(compensator.getRate()).toBe(1.0);
            expect(compensator.getState()).toBe('locked');
        });

        it('should handle single sample', () => {
            compensator = createCompensator();
            const result = compensator.update(5, 3595, 3600);
            expect(result.action).toBe('none');
            expect(compensator.getState()).toBe('measuring');
        });

        it('should handle duration of 0', () => {
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
                hardSeekThreshold: 15, // High threshold for testing
            });
            compensator.setMediaDuration(0);

            simulateDrift(compensator, 5, 1000, () => ({
                drift: 10,
                guestPos: 100,
                hostPos: 110,
            }));

            // Should fall back to velocity-based
            expect(compensator.getLastCalibrationInfo()?.method).toBe('drift-velocity');
        });

        it('should handle position at start of video', () => {
            // With targetSyncTime (default 300s), even at the start of a long video,
            // a 2s drift results in a meaningful rate adjustment.
            // syncTime = min(300, 7200-10) = 300
            // Rate = (300 + 2) / 300 = 1.0067
            compensator = createCompensator({
                measureDuration: 3000,
                minSamplesForCalibration: 3,
            });
            compensator.setMediaDuration(7200);

            // 2s behind at the very start
            simulateDrift(compensator, 5, 1000, () => ({
                drift: 2,
                guestPos: 8,
                hostPos: 10,
            }));

            // Rate is adjusted to sync within 5 minutes
            expect(compensator.getRate()).toBeCloseTo(1.0067, 3);
            expect(compensator.getState()).toBe('locked');
        });
    });

    describe('Sample Management', () => {
        it('should prune old samples', () => {
            compensator = createCompensator({
                sampleRetention: 10000, // 10s retention
            });

            // Add samples over 20s
            for (let i = 0; i < 20; i++) {
                compensator.update(5, 100 + i, 105 + i);
                advanceTime(1000);
            }

            // Should only have ~10 samples
            expect(compensator.getSampleCount()).toBeLessThanOrEqual(11);
            expect(compensator.getSampleCount()).toBeGreaterThanOrEqual(9);
        });
    });

    describe('Configuration', () => {
        it('should use custom config values', () => {
            compensator = createCompensator({
                hardSeekThreshold: 10.0,
                maxRateAdjustment: 0.1,
            });

            const config = compensator.getConfig();
            expect(config.hardSeekThreshold).toBe(10.0);
            expect(config.maxRateAdjustment).toBe(0.1);
        });

        it('should allow disabling finish-time sync', () => {
            compensator = createCompensator({
                useFinishTimeSync: false,
                measureDuration: 3000,
                minSamplesForCalibration: 3,
            });
            compensator.setMediaDuration(7200);

            simulateDrift(compensator, 10, 1000, (i) => ({
                drift: i * 0.01,
                guestPos: 100 + i,
                hostPos: 100 + i + i * 0.01,
            }));

            // Should use velocity even though duration is set
            expect(compensator.getLastCalibrationInfo()?.method).toBe('drift-velocity');
        });
    });
});
