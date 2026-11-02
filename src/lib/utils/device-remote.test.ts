// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    commandFailureOf,
    deviceHasCommands,
    deviceSupports,
    extrapolatePosition,
    framePayload,
    isSettled,
    isSuccessful,
    mediaPlayKind,
} from './device-remote';

describe('device capabilities', () => {
    it('finds an announced command and nothing else', () => {
        const caps = { commands: { 'media.play': {}, 'ui.message': { maxLength: 280 } } };
        expect(deviceSupports(caps, 'media.play')).toBe(true);
        expect(deviceSupports(caps, 'party.join')).toBe(false);
        expect(deviceSupports(undefined, 'media.play')).toBe(false);
        expect(deviceSupports({ commands: {} }, 'toString')).toBe(false);
        expect(deviceHasCommands(caps)).toBe(true);
        expect(deviceHasCommands({ commands: {} })).toBe(false);
        expect(deviceHasCommands(null)).toBe(false);
    });
});

describe('mediaPlayKind', () => {
    it.each([
        ['movie', 'movie'],
        ['MOVIE', 'movie'],
        ['tv', 'series'],
        ['Series', 'series'],
        ['episode', 'episode'],
        ['track', 'track'],
        ['album', 'album'],
        ['audiobook', 'audiobook'],
    ])('maps %s to %s', (input, kind) => {
        expect(mediaPlayKind(input)).toBe(kind);
    });

    it('returns null for types a device cannot play', () => {
        expect(mediaPlayKind('season')).toBeNull();
        expect(mediaPlayKind(undefined)).toBeNull();
    });
});

describe('commandFailureOf', () => {
    it('reads the stable code from details, plain or stringified', () => {
        expect(commandFailureOf({ details: 'device_unreachable' })).toBe('device_unreachable');
        expect(commandFailureOf({ details: '{"details":"device_unsupported"}' })).toBe(
            'device_unsupported',
        );
        expect(commandFailureOf({ details: { details: 'stale_target' } })).toBe('stale_target');
        expect(commandFailureOf({ code: 'simple_mode_locked' })).toBe('simple_mode_locked');
    });

    it('falls back to rate_limited on 429 and other otherwise', () => {
        expect(commandFailureOf({ status: 429 })).toBe('rate_limited');
        expect(commandFailureOf({ details: 'something_else' })).toBe('other');
    });
});

describe('command status', () => {
    it('separates in-flight, settled and successful', () => {
        expect(isSettled({ status: 'pending' })).toBe(false);
        expect(isSettled({ status: 'delivered' })).toBe(false);
        expect(isSettled({ status: 'applied' })).toBe(true);
        expect(isSettled({ status: 'rejected' })).toBe(true);
        expect(isSuccessful({ status: 'applied' })).toBe(true);
        expect(isSuccessful({ status: 'acknowledged' })).toBe(true);
        expect(isSuccessful({ status: 'expired' })).toBe(false);
    });
});

describe('framePayload', () => {
    it('unwraps the stream envelope and tolerates a bare object', () => {
        expect(
            framePayload({ targetUserId: 'u', kind: 'device.state', data: { revision: 3 } }),
        ).toEqual({
            revision: 3,
        });
        expect(framePayload({ id: 'cmd_1', status: 'applied' })).toEqual({
            id: 'cmd_1',
            status: 'applied',
        });
        expect(framePayload(null)).toBeNull();
    });
});

describe('extrapolatePosition', () => {
    const observedAt = '2026-10-16T12:00:00.000Z';
    const at = (seconds: number) => Date.parse(observedAt) + seconds * 1000;

    it('advances while playing, scaled by rate', () => {
        const np = { positionSeconds: 100, paused: false, rate: 2, observedAt };
        expect(extrapolatePosition(np, at(5))).toBe(110);
    });

    it('stays put while paused', () => {
        expect(extrapolatePosition({ positionSeconds: 100, paused: true, observedAt }, at(5))).toBe(
            100,
        );
    });

    it('never runs past the duration, backwards, or beyond 30 seconds', () => {
        const base = { positionSeconds: 100, paused: false, observedAt };
        expect(extrapolatePosition({ ...base, durationMs: 102_000 }, at(10))).toBe(102);
        expect(extrapolatePosition(base, at(-5))).toBe(100);
        expect(extrapolatePosition(base, at(600))).toBe(130);
    });

    it('is null without a reported position', () => {
        expect(extrapolatePosition({ paused: false }, Date.now())).toBeNull();
    });
});
