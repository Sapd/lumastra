// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounds on UpdatePolicyRequestSchema — this is the contract that produces the
 * admin UI's 422s, so the accepted range is pinned explicitly here.
 */

import { describe, it, expect } from 'vitest';
import {
    UpdatePolicyRequestSchema,
    UNLIMITED_CONCURRENT_STREAMS,
    isUnlimitedStreams,
    PlayMethodSchema,
} from './play-sessions.js';

describe('PlayMethodSchema', () => {
    it('accepts audio_only — CreateSessionParams/HeartbeatParams share this vocabulary', () => {
        expect(PlayMethodSchema.safeParse('audio_only').success).toBe(true);
    });
});

describe('UpdatePolicyRequestSchema.max_concurrent_streams', () => {
    it('accepts the unlimited sentinel (-1)', () => {
        const result = UpdatePolicyRequestSchema.safeParse({
            max_concurrent_streams: UNLIMITED_CONCURRENT_STREAMS,
        });
        expect(result.success).toBe(true);
    });

    it('accepts 0 (block all streams) and the 1-20 range', () => {
        for (const value of [0, 1, 2, 20]) {
            expect(
                UpdatePolicyRequestSchema.safeParse({ max_concurrent_streams: value }).success,
            ).toBe(true);
        }
    });

    it('rejects values above the cap — the original 422', () => {
        const result = UpdatePolicyRequestSchema.safeParse({ max_concurrent_streams: 100 });
        expect(result.success).toBe(false);
    });

    it('rejects negatives below the sentinel, so -1 stays the only unlimited value on write', () => {
        expect(UpdatePolicyRequestSchema.safeParse({ max_concurrent_streams: -2 }).success).toBe(
            false,
        );
    });

    it('rejects non-integers', () => {
        expect(UpdatePolicyRequestSchema.safeParse({ max_concurrent_streams: 2.5 }).success).toBe(
            false,
        );
    });
});

describe('isUnlimitedStreams', () => {
    it('treats the sentinel as unlimited', () => {
        expect(isUnlimitedStreams(UNLIMITED_CONCURRENT_STREAMS)).toBe(true);
    });

    it('treats 0 as a limit (block all), NOT unlimited', () => {
        expect(isUnlimitedStreams(0)).toBe(false);
    });

    it('fails open for stray negatives written outside the schema (no CHECK constraint)', () => {
        expect(isUnlimitedStreams(-2)).toBe(true);
    });

    it('treats positive limits as limits', () => {
        expect(isUnlimitedStreams(2)).toBe(false);
    });
});
