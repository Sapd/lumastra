// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAirPlayDetector } from './airplay-detector';

/**
 * Build a fake <audio>-like object sufficient for the detector. We stub:
 *  - webkitCurrentPlaybackTargetIsWireless (mutable getter via property)
 *  - addEventListener / removeEventListener / dispatchEvent
 *  - remote.state + remote.addEventListener (standard Remote Playback API)
 *
 * The element is an EventTarget so dispatchEvent/addEventListener work natively.
 */
function makeFakeAudio(initialWireless = false): HTMLAudioElement {
    const target = new EventTarget();
    const remoteTarget = new EventTarget();
    const audio = target as unknown as HTMLAudioElement & {
        webkitCurrentPlaybackTargetIsWireless: boolean;
        remote: {
            state: string;
            addEventListener: EventTarget['addEventListener'];
            removeEventListener: EventTarget['removeEventListener'];
        };
        _setWireless: (active: boolean) => void;
        _dispatchRemote: (type: 'connect' | 'disconnect') => void;
        _dispatchAvailability: (available: boolean) => void;
    };
    let wireless = initialWireless;
    Object.defineProperty(audio, 'webkitCurrentPlaybackTargetIsWireless', {
        get: () => wireless,
        configurable: true,
    });
    (
        audio as unknown as {
            remote: {
                state: string;
                addEventListener: EventTarget['addEventListener'];
                removeEventListener: EventTarget['removeEventListener'];
            };
        }
    ).remote = {
        state: initialWireless ? 'connected' : 'disconnected',
        addEventListener: remoteTarget.addEventListener.bind(remoteTarget),
        removeEventListener: remoteTarget.removeEventListener.bind(remoteTarget),
    };
    audio._setWireless = (active: boolean) => {
        wireless = active;
        (audio as unknown as { remote: { state: string } }).remote.state = active
            ? 'connected'
            : 'disconnected';
        audio.dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged'));
    };
    audio._dispatchRemote = (type: 'connect' | 'disconnect') => {
        const newWireless = type === 'connect';
        wireless = newWireless;
        (audio as unknown as { remote: { state: string } }).remote.state = newWireless
            ? 'connected'
            : 'disconnected';
        remoteTarget.dispatchEvent(new Event(type));
    };
    audio._dispatchAvailability = (available: boolean) => {
        const ev = new Event('webkitplaybacktargetavailabilitychanged') as Event & {
            availability: string;
        };
        ev.availability = available ? 'available' : 'not-available';
        audio.dispatchEvent(ev);
    };
    return audio;
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('createAirPlayDetector', () => {
    it('fires onChange synchronously once during start() with initial state false', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(false);
        detector.start([audio]);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(false);
        detector.stop();
    });

    it('fires onChange synchronously once during start() with initial state true (AirPlay already active)', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(true);
        detector.start([audio]);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith(true);
        detector.stop();
    });

    it('reports true when wireless flips on, then false when it flips off', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(false);
        detector.start([audio]);
        onChange.mockClear(); // ignore the initial seed call
        (audio as unknown as { _setWireless: (a: boolean) => void })._setWireless(true);
        vi.advanceTimersByTime(250); // flush debounce
        expect(onChange).toHaveBeenLastCalledWith(true);
        (audio as unknown as { _setWireless: (a: boolean) => void })._setWireless(false);
        vi.advanceTimersByTime(250);
        expect(onChange).toHaveBeenLastCalledWith(false);
        detector.stop();
    });

    it('aggregates across multiple elements (any wireless = active)', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const a = makeFakeAudio(false);
        const b = makeFakeAudio(false);
        detector.start([a, b]);
        onChange.mockClear();
        (a as unknown as { _setWireless: (a: boolean) => void })._setWireless(true);
        vi.advanceTimersByTime(250);
        expect(onChange).toHaveBeenLastCalledWith(true);
        // b still false, a still true → aggregate stays true (no new emission)
        const callsAfterFirst = onChange.mock.calls.length;
        (b as unknown as { _setWireless: (a: boolean) => void })._setWireless(true);
        vi.advanceTimersByTime(250);
        expect(onChange.mock.calls.length).toBe(callsAfterFirst); // no duplicate true
        // a goes false but b is still true → aggregate stays true
        (a as unknown as { _setWireless: (a: boolean) => void })._setWireless(false);
        vi.advanceTimersByTime(250);
        expect(onChange.mock.calls.length).toBe(callsAfterFirst);
        // b goes false → aggregate flips false
        (b as unknown as { _setWireless: (a: boolean) => void })._setWireless(false);
        vi.advanceTimersByTime(250);
        expect(onChange).toHaveBeenLastCalledWith(false);
        detector.stop();
    });

    it('debounces rapid flip-flops within 200ms', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(false);
        detector.start([audio]);
        onChange.mockClear();
        const set = (audio as unknown as { _setWireless: (a: boolean) => void })._setWireless;
        set(true);
        vi.advanceTimersByTime(50);
        set(false);
        vi.advanceTimersByTime(50);
        set(true);
        vi.advanceTimersByTime(50);
        set(false);
        vi.advanceTimersByTime(250); // flush
        // After all the flapping, current state is false. We expect at most one
        // emission (could be 0 if it equals last-emitted state, which was the
        // initial false). Either way, no rapid-fire callbacks.
        expect(onChange.mock.calls.length).toBeLessThanOrEqual(1);
        detector.stop();
    });

    it('isActive() reflects current aggregate state', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(true);
        detector.start([audio]);
        expect(detector.isActive()).toBe(true);
        (audio as unknown as { _setWireless: (a: boolean) => void })._setWireless(false);
        vi.advanceTimersByTime(250);
        expect(detector.isActive()).toBe(false);
        detector.stop();
    });

    it('stop() removes listeners and prevents further callbacks', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(false);
        detector.start([audio]);
        detector.stop();
        onChange.mockClear();
        (audio as unknown as { _setWireless: (a: boolean) => void })._setWireless(true);
        vi.advanceTimersByTime(500);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('handles audio elements without webkit/remote APIs gracefully', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        // EventTarget without the AirPlay-specific properties
        const plain = new EventTarget() as unknown as HTMLAudioElement;
        // Should not throw, should fire initial false
        expect(() => detector.start([plain])).not.toThrow();
        expect(onChange).toHaveBeenCalledWith(false);
        detector.stop();
    });

    it("reports true when remote 'connect' event fires, after debounce", () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(false);
        detector.start([audio]);
        onChange.mockClear(); // ignore the initial seed call
        (
            audio as unknown as {
                _dispatchRemote: (type: 'connect' | 'disconnect') => void;
            }
        )._dispatchRemote('connect');
        vi.advanceTimersByTime(250); // flush debounce
        expect(onChange).toHaveBeenLastCalledWith(true);
        detector.stop();
    });

    it("reports false when remote 'disconnect' event fires, after debounce", () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(true); // start wireless=true so seed fires true
        detector.start([audio]);
        onChange.mockClear(); // ignore the initial seed call (true)
        (
            audio as unknown as {
                _dispatchRemote: (type: 'connect' | 'disconnect') => void;
            }
        )._dispatchRemote('disconnect');
        vi.advanceTimersByTime(250); // flush debounce
        expect(onChange).toHaveBeenLastCalledWith(false);
        detector.stop();
    });

    it('stop() removes remote listeners (no callback after dispatch)', () => {
        const onChange = vi.fn();
        const detector = createAirPlayDetector(onChange);
        const audio = makeFakeAudio(false);
        detector.start([audio]);
        detector.stop();
        onChange.mockClear(); // ignore the seed call
        (
            audio as unknown as {
                _dispatchRemote: (type: 'connect' | 'disconnect') => void;
            }
        )._dispatchRemote('connect');
        vi.advanceTimersByTime(500);
        expect(onChange).not.toHaveBeenCalled();
    });

    // ── Availability tracking ────────────────────────────────────────────────

    it('seeds onAvailableChange(false) synchronously during start()', () => {
        const onActive = vi.fn();
        const onAvailable = vi.fn();
        const detector = createAirPlayDetector(onActive, onAvailable);
        const audio = makeFakeAudio(false);
        detector.start([audio]);
        // Seed must have fired with false before any async events
        expect(onAvailable).toHaveBeenCalledTimes(1);
        expect(onAvailable).toHaveBeenCalledWith(false);
        detector.stop();
    });

    it('fires onAvailableChange(true) when availability event fires, after debounce', () => {
        const onActive = vi.fn();
        const onAvailable = vi.fn();
        const detector = createAirPlayDetector(onActive, onAvailable);
        const audio = makeFakeAudio(false);
        detector.start([audio]);
        onAvailable.mockClear(); // ignore seed call
        (audio as unknown as { _dispatchAvailability: (a: boolean) => void })._dispatchAvailability(
            true,
        );
        vi.advanceTimersByTime(250); // flush debounce
        expect(onAvailable).toHaveBeenCalledTimes(1);
        expect(onAvailable).toHaveBeenCalledWith(true);
        detector.stop();
    });

    it('aggregates availability across multiple elements (any-true semantics)', () => {
        const onActive = vi.fn();
        const onAvailable = vi.fn();
        const detector = createAirPlayDetector(onActive, onAvailable);
        const a = makeFakeAudio(false);
        const b = makeFakeAudio(false);
        detector.start([a, b]);
        onAvailable.mockClear();

        // Only element a reports available → aggregate is true
        (a as unknown as { _dispatchAvailability: (v: boolean) => void })._dispatchAvailability(
            true,
        );
        vi.advanceTimersByTime(250);
        expect(onAvailable).toHaveBeenLastCalledWith(true);

        // b also available — aggregate already true, no new emission
        const callsAfterFirst = onAvailable.mock.calls.length;
        (b as unknown as { _dispatchAvailability: (v: boolean) => void })._dispatchAvailability(
            true,
        );
        vi.advanceTimersByTime(250);
        expect(onAvailable.mock.calls.length).toBe(callsAfterFirst);

        // a goes away, b still available → still true
        (a as unknown as { _dispatchAvailability: (v: boolean) => void })._dispatchAvailability(
            false,
        );
        vi.advanceTimersByTime(250);
        expect(onAvailable.mock.calls.length).toBe(callsAfterFirst);

        // b goes away → aggregate becomes false
        (b as unknown as { _dispatchAvailability: (v: boolean) => void })._dispatchAvailability(
            false,
        );
        vi.advanceTimersByTime(250);
        expect(onAvailable).toHaveBeenLastCalledWith(false);
        detector.stop();
    });
});
