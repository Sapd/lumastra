// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    isStreamTokenUsable,
    parseStreamTokenExpiry,
    StreamTokenRecoveryGate,
    streamTokenOf,
} from './stream-token-recovery';

describe('parseStreamTokenExpiry', () => {
    it('parses the ISO string both endpoints return', () => {
        expect(parseStreamTokenExpiry('2026-09-29T10:00:00Z')).toBe(
            Date.UTC(2026, 8, 29, 10, 0, 0),
        );
    });

    it('reads a small number as epoch seconds and a large one as epoch ms', () => {
        expect(parseStreamTokenExpiry(1_790_000_000)).toBe(1_790_000_000_000);
        expect(parseStreamTokenExpiry(1_790_000_000_000)).toBe(1_790_000_000_000);
    });

    it('returns null for absent or unparseable values', () => {
        expect(parseStreamTokenExpiry(undefined)).toBeNull();
        expect(parseStreamTokenExpiry(null)).toBeNull();
        expect(parseStreamTokenExpiry('')).toBeNull();
        expect(parseStreamTokenExpiry('not a date')).toBeNull();
        expect(parseStreamTokenExpiry(Number.NaN)).toBeNull();
        expect(parseStreamTokenExpiry(0)).toBeNull();
    });
});

describe('isStreamTokenUsable', () => {
    it('needs a token', () => {
        expect(isStreamTokenUsable(null, null, 0)).toBe(false);
        expect(isStreamTokenUsable('', null, 0)).toBe(false);
    });

    it('treats an unknown expiry as usable', () => {
        expect(isStreamTokenUsable('t', null, 1_000)).toBe(true);
    });

    it('is unusable from the expiry instant on', () => {
        expect(isStreamTokenUsable('t', 1_000, 999)).toBe(true);
        expect(isStreamTokenUsable('t', 1_000, 1_000)).toBe(false);
    });
});

describe('StreamTokenRecoveryGate', () => {
    it('allows the first recovery, then blocks until the cooldown elapses', () => {
        const gate = new StreamTokenRecoveryGate(60_000);
        expect(gate.tryAcquire(1_000)).toBe(true);
        expect(gate.tryAcquire(1_001)).toBe(false);
        expect(gate.tryAcquire(60_999)).toBe(false);
        expect(gate.tryAcquire(61_000)).toBe(true);
    });

    it('allows a recovery at time zero (no epoch-relative default)', () => {
        expect(new StreamTokenRecoveryGate(60_000).tryAcquire(0)).toBe(true);
    });

    it('reset() forgets the last recovery', () => {
        const gate = new StreamTokenRecoveryGate(60_000);
        gate.tryAcquire(1_000);
        gate.reset();
        expect(gate.tryAcquire(1_001)).toBe(true);
    });
});

describe('streamTokenOf', () => {
    it('reads grant from relative and absolute URLs', () => {
        expect(streamTokenOf('/api/v1/music/tracks/a/stream?grant=a%2Bb')).toBe('a+b');
        expect(streamTokenOf('https://x.test/api/v1/music/tracks/a/stream?grant=t')).toBe('t');
    });

    it('returns null without the parameter or for an empty src', () => {
        expect(streamTokenOf('/api/music/tracks/a/stream')).toBeNull();
        expect(streamTokenOf('')).toBeNull();
    });
});
