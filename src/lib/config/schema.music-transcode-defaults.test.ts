// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    musicTranscodeConcurrencyDefault,
    musicTranscodePerUserDefault,
    configSchema,
} from './schema.js';

describe('musicTranscodeConcurrencyDefault', () => {
    it('scales with cores between the 4 floor and 16 ceiling', () => {
        expect(musicTranscodeConcurrencyDefault(1)).toBe(4);
        expect(musicTranscodeConcurrencyDefault(2)).toBe(4);
        expect(musicTranscodeConcurrencyDefault(4)).toBe(4);
        expect(musicTranscodeConcurrencyDefault(8)).toBe(8);
        expect(musicTranscodeConcurrencyDefault(16)).toBe(16);
        expect(musicTranscodeConcurrencyDefault(48)).toBe(16);
    });
});

describe('musicTranscodePerUserDefault', () => {
    it('is half the server-wide cap, floored at 4', () => {
        expect(musicTranscodePerUserDefault(2)).toBe(4);
        expect(musicTranscodePerUserDefault(8)).toBe(4);
        expect(musicTranscodePerUserDefault(16)).toBe(8);
        expect(musicTranscodePerUserDefault(48)).toBe(8);
    });

    it('never exceeds the server-wide cap', () => {
        for (const cores of [1, 2, 4, 6, 8, 12, 16, 32, 64]) {
            expect(musicTranscodePerUserDefault(cores)).toBeLessThanOrEqual(
                musicTranscodeConcurrencyDefault(cores),
            );
        }
    });
});

describe('music transcode cap schema wiring', () => {
    // Regression guard: a static defaultValue with no dynamicDefault SHADOWS the
    // CPU-derived fallback in config.ts, because ConfigService is consulted
    // first. That's how these two caps silently stayed at 4/2 on a 16-core host.
    it.each([
        ['MUSIC_TRANSCODE_MAX_CONCURRENT', musicTranscodeConcurrencyDefault],
        ['MUSIC_TRANSCODE_MAX_PER_USER', musicTranscodePerUserDefault],
    ])('%s resolves its default from cpuCores', (key, expected) => {
        const setting = configSchema.find((s) => s.key === key);
        expect(setting, `${key} missing from configSchema`).toBeDefined();
        expect(setting!.dynamicDefault, `${key} has no dynamicDefault`).toBeTypeOf('function');
        for (const cpuCores of [2, 8, 16]) {
            expect(setting!.dynamicDefault!({ cpuCores })).toBe(expected(cpuCores));
        }
    });

    it('keeps the derived defaults inside their declared validation range', () => {
        for (const key of ['MUSIC_TRANSCODE_MAX_CONCURRENT', 'MUSIC_TRANSCODE_MAX_PER_USER']) {
            const setting = configSchema.find((s) => s.key === key)!;
            for (const cpuCores of [1, 2, 8, 16, 48, 128]) {
                const value = setting.dynamicDefault!({ cpuCores }) as number;
                expect(value).toBeGreaterThanOrEqual(setting.validation!.min!);
                expect(value).toBeLessThanOrEqual(setting.validation!.max!);
            }
        }
    });

    it('exposes the queue wait so the caps can throttle instead of reject', () => {
        const setting = configSchema.find((s) => s.key === 'MUSIC_TRANSCODE_QUEUE_WAIT_MS');
        expect(setting).toBeDefined();
        expect(setting!.defaultValue).toBe(10000);
        // 0 must stay reachable — it restores reject-immediately behaviour.
        expect(setting!.validation?.min).toBe(0);
    });
});
