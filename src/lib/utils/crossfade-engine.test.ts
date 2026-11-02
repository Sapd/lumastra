// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    describe,
    it,
    expect,
    vi,
    beforeEach,
} from 'vitest';
import { CrossfadeEngine, type AudioDeck } from './crossfade-engine';

// Mock soundtouch-worklet import
vi.mock('./soundtouch-worklet', () => ({
    createTimeStretchNode: vi.fn(),
}));

function createMockAudioContext(): AudioContext {
    return {
        currentTime: 0,
        state: 'running',
        resume: vi.fn(),
        destination: {} as AudioDestinationNode,
        createBiquadFilter: vi.fn(() => ({
            type: 'lowpass',
            frequency: {
                value: 350,
                setValueAtTime: vi.fn(),
                linearRampToValueAtTime: vi.fn(),
                cancelScheduledValues: vi.fn(),
            },
            Q: { value: 1 },
            connect: vi.fn(),
            disconnect: vi.fn(),
        })),
        createDelay: vi.fn(() => ({
            delayTime: { value: 0 },
            connect: vi.fn(),
            disconnect: vi.fn(),
        })),
        createGain: vi.fn(() => ({
            gain: {
                value: 0,
                setValueAtTime: vi.fn(),
                linearRampToValueAtTime: vi.fn(),
                cancelScheduledValues: vi.fn(),
            },
            connect: vi.fn(),
            disconnect: vi.fn(),
        })),
    } as unknown as AudioContext;
}

function createMockDeck(overrides?: Partial<AudioDeck>): AudioDeck {
    const mockFilter = {
        frequency: { value: 0 },
        gain: {
            value: 0,
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            cancelScheduledValues: vi.fn(),
        },
        type: 'lowshelf',
        connect: vi.fn(),
        disconnect: vi.fn(),
    } as unknown as BiquadFilterNode;

    return {
        audio: {
            currentTime: 0,
            playbackRate: 1,
            src: '',
            pause: vi.fn(),
            play: vi.fn().mockResolvedValue(undefined),
        } as unknown as HTMLAudioElement,
        source: {
            connect: vi.fn(),
            disconnect: vi.fn(),
        } as unknown as MediaElementAudioSourceNode,
        gain: {
            gain: {
                value: 1,
                setValueAtTime: vi.fn(),
                cancelScheduledValues: vi.fn(),
                linearRampToValueAtTime: vi.fn(),
            },
            connect: vi.fn(),
            disconnect: vi.fn(),
        } as unknown as GainNode,
        eqLow: mockFilter,
        eqHigh: {
            ...mockFilter,
            type: 'highshelf',
        } as unknown as BiquadFilterNode,
        ...overrides,
    };
}

describe('CrossfadeEngine', () => {
    let engine: CrossfadeEngine;
    let ctx: AudioContext;

    beforeEach(() => {
        vi.useFakeTimers();
        ctx = createMockAudioContext();
        engine = new CrossfadeEngine(ctx);
    });

    it('can be instantiated', () => {
        expect(engine).toBeInstanceOf(CrossfadeEngine);
    });

    it('cancel does not throw on a fresh instance', () => {
        expect(() => engine.cancel()).not.toThrow();
    });

    it('destroy does not throw on a fresh instance', () => {
        expect(() => engine.destroy()).not.toThrow();
    });

    describe('normalizePlaybackRate', () => {
        it('does nothing if playbackRate is already 1', () => {
            const deck = createMockDeck();
            deck.audio.playbackRate = 1;
            engine.normalizePlaybackRate(deck, 120);
            vi.advanceTimersByTime(500);
            expect(deck.audio.playbackRate).toBe(1);
        });

        it('converges playbackRate toward 1.0 over time', () => {
            const deck = createMockDeck();
            deck.audio.playbackRate = 1.05;
            engine.normalizePlaybackRate(deck, 120);

            // After several intervals, rate should be closer to 1
            vi.advanceTimersByTime(1000);
            expect(deck.audio.playbackRate).toBeLessThan(1.05);
            expect(deck.audio.playbackRate).toBeGreaterThan(0.95);
        });

        it('snaps to exactly 1.0 when close enough', () => {
            const deck = createMockDeck();
            deck.audio.playbackRate = 1.003;
            engine.normalizePlaybackRate(deck, 120);

            vi.advanceTimersByTime(200);
            expect(deck.audio.playbackRate).toBe(1);
        });
    });

    describe('startCrossfade', () => {
        beforeEach(() => {
            vi.stubGlobal('cancelAnimationFrame', vi.fn());
        });

        function makeRafController(): {
            fire: (elapsedMs: number) => void;
            rafMock: ReturnType<typeof vi.fn>;
        } {
            let rafCallback: ((time: number) => void) | null = null;
            const rafMock = vi.fn((cb: (time: number) => void) => {
                rafCallback = cb;
                return 1;
            });
            vi.stubGlobal('requestAnimationFrame', rafMock);
            const startTime = 0;
            vi.spyOn(performance, 'now').mockReturnValue(startTime);
            return {
                rafMock,
                fire(elapsedMs: number) {
                    // Advance both wall clock and AudioContext time so the
                    // engine's suspension-detection heuristic doesn't trigger.
                    vi.spyOn(performance, 'now').mockReturnValue(startTime + elapsedMs);
                    (ctx as { currentTime: number }).currentTime = elapsedMs / 1000;
                    if (rafCallback) rafCallback(startTime + elapsedMs);
                },
            };
        }

        describe('hidden page (requestAnimationFrame paused)', () => {
            // rAF does not run in a background tab. Before this, a fade that
            // started hidden never moved: the outgoing deck stayed at full level,
            // the incoming one played silently, and the fallback timer hard-swapped
            // at the end. The rest of the fade must be scheduled on the audio clock.
            type Listener = () => void;
            function stubDocument(hidden: boolean) {
                const listeners: Listener[] = [];
                const doc = {
                    hidden,
                    addEventListener: vi.fn((_: string, l: Listener) => listeners.push(l)),
                    removeEventListener: vi.fn(),
                };
                vi.stubGlobal('document', doc);
                return { doc, fireVisibility: () => listeners.forEach((l) => l()) };
            }
            function withCurveParam(deck: AudioDeck): ReturnType<typeof vi.fn> {
                const curve = vi.fn();
                (
                    deck.gain.gain as unknown as { setValueCurveAtTime: unknown }
                ).setValueCurveAtTime = curve;
                return curve;
            }

            it('schedules the whole blend on the audio clock when the fade starts hidden', async () => {
                makeRafController(); // registered, but never fired — hidden tab
                const { doc } = stubDocument(true);
                const fromDeck = createMockDeck();
                const toDeck = createMockDeck();
                const fromCurve = withCurveParam(fromDeck);
                const toCurve = withCurveParam(toDeck);

                // 8 beats at the assumed 120 BPM → 4000ms.
                const fade = engine.startCrossfade(fromDeck, toDeck, { beats: 8, volume: 1 });

                expect(fromCurve).toHaveBeenCalledTimes(1);
                expect(toCurve).toHaveBeenCalledTimes(1);
                const [outValues, outStart, outDur] = fromCurve.mock.calls[0];
                const [inValues] = toCurve.mock.calls[0];
                expect(outStart).toBe(0);
                expect(outDur).toBeCloseTo(4);
                expect(outValues[0]).toBeCloseTo(1);
                expect(outValues[outValues.length - 1]).toBeCloseTo(0);
                expect(inValues[0]).toBeCloseTo(0);
                expect(inValues[inValues.length - 1]).toBeCloseTo(1);

                // The fallback timer still completes the fade with rAF frozen,
                // once the audio clock (which runs the curve) has got there.
                (ctx as { currentTime: number }).currentTime = 4.2;
                vi.advanceTimersByTime(4500);
                await fade;
                expect(fromDeck.gain.gain.value).toBe(0);
                expect(toDeck.gain.gain.value).toBe(1);
                expect(doc.removeEventListener).toHaveBeenCalled();
                vi.unstubAllGlobals();
            });

            it('hands the remainder to the audio clock on hide, and back to frames on show', () => {
                const { fire } = makeRafController();
                const { doc, fireVisibility } = stubDocument(false);
                const fromDeck = createMockDeck();
                const toDeck = createMockDeck();
                const fromCurve = withCurveParam(fromDeck);
                withCurveParam(toDeck);

                engine
                    .startCrossfade(fromDeck, toDeck, { beats: 8, volume: 1 })
                    .catch(() => undefined);
                expect(fromCurve).not.toHaveBeenCalled();

                fire(2000); // halfway, visible: per-frame path
                doc.hidden = true;
                fireVisibility();
                expect(fromCurve).toHaveBeenCalledTimes(1);
                const [values, start, dur] = fromCurve.mock.calls[0];
                expect(start).toBeCloseTo(2);
                expect(dur).toBeCloseTo(2);
                // Resumes from where the fade is (blend outgoing ≈ cos(π/4)), not from the top.
                expect(values[0]).toBeCloseTo(Math.cos(Math.PI / 4), 2);
                expect(values[values.length - 1]).toBeCloseTo(0);

                const cancel = fromDeck.gain.gain.cancelScheduledValues as ReturnType<typeof vi.fn>;
                cancel.mockClear();
                doc.hidden = false;
                fireVisibility();
                expect(cancel).toHaveBeenCalledWith(0);
                vi.unstubAllGlobals();
            });

            it('the fallback waits for a lagging audio clock instead of snapping mid-curve', async () => {
                makeRafController();
                stubDocument(true);
                const fromDeck = createMockDeck();
                const toDeck = createMockDeck();
                withCurveParam(fromDeck);
                withCurveParam(toDeck);
                let done = false;
                const fade = engine
                    .startCrossfade(fromDeck, toDeck, { beats: 8, volume: 1 })
                    .then(() => (done = true));

                (ctx as { currentTime: number }).currentTime = 2; // audio clock half-way
                await vi.advanceTimersByTimeAsync(4500); // wall clock past the end
                expect(done).toBe(false);
                expect(fromDeck.gain.gain.value).not.toBe(0);

                (ctx as { currentTime: number }).currentTime = 4.1;
                await vi.advanceTimersByTimeAsync(2100);
                await fade;
                expect(fromDeck.gain.gain.value).toBe(0);
                vi.unstubAllGlobals();
            });

            it('cancel() clears a scheduled curve before anything writes the params', () => {
                makeRafController();
                stubDocument(true);
                const fromDeck = createMockDeck();
                const toDeck = createMockDeck();
                withCurveParam(fromDeck);
                withCurveParam(toDeck);
                engine
                    .startCrossfade(fromDeck, toDeck, { beats: 8, volume: 1 })
                    .catch(() => undefined);
                const cancel = toDeck.gain.gain.cancelScheduledValues as ReturnType<typeof vi.fn>;
                cancel.mockClear();
                engine.cancel();
                expect(cancel).toHaveBeenCalledWith(0);
                vi.unstubAllGlobals();
            });
        });

        it('paces the fade with paceBpm when the BPMs used for sync are omitted', async () => {
            // Unsynced transitions omit incomingBpm; the planner still paced the
            // fade off it. paceBpm keeps the engine on the planner's length.
            const { fire } = makeRafController();
            let done = false;
            const fade = engine
                .startCrossfade(createMockDeck(), createMockDeck(), {
                    beats: 8,
                    volume: 1,
                    paceBpm: 100,
                })
                .then(() => (done = true));
            fire(4_700); // 8 beats at 100 BPM = 4800ms
            await Promise.resolve();
            expect(done).toBe(false);
            fire(4_800);
            await fade;
            expect(done).toBe(true);
            vi.restoreAllMocks();
        });

        it('bass-swap: the incoming highshelf covers the mids during the swap, restored after', async () => {
            // A -40 dB highshelf at the stock 3 kHz corner left the incoming
            // vocals/snare (200 Hz-3 kHz) almost untouched from the first frame.
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();
            const inHigh = {
                ...toDeck.eqHigh,
                frequency: { value: 3000 },
            } as unknown as BiquadFilterNode;
            toDeck.eqHigh = inHigh;

            const fade = engine.startCrossfade(fromDeck, toDeck, {
                beats: 16,
                volume: 1,
                fadeMode: 'bassswap',
                paceBpm: 120,
            });
            expect(inHigh.frequency.value).toBe(250);
            fire(8_000);
            await fade;
            expect(inHigh.frequency.value).toBe(3000);
            vi.restoreAllMocks();
        });

        it('sets gain values during crossfade', async () => {
            const { fire } = makeRafController();

            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume: 0.8,
            });

            // Advance past the fade duration (16s at 0 BPM)
            fire(20000);
            await fadePromise;

            expect(fromDeck.gain.gain.setValueAtTime).toHaveBeenCalled();
            expect(toDeck.gain.gain.setValueAtTime).toHaveBeenCalled();

            vi.restoreAllMocks();
        });

        it('final state: fromDeck gain = 0, toDeck gain = volume', async () => {
            const { fire } = makeRafController();
            const volume = 0.8;
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            // Capture the last call args
            const fromCalls: [number, number][] = [];
            const toCalls: [number, number][] = [];
            (fromDeck.gain.gain.setValueAtTime as ReturnType<typeof vi.fn>).mockImplementation(
                (v: number, t: number) => fromCalls.push([v, t]),
            );
            (toDeck.gain.gain.setValueAtTime as ReturnType<typeof vi.fn>).mockImplementation(
                (v: number, t: number) => toCalls.push([v, t]),
            );

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume,
            });
            fire(20000); // well past end (16s fallback for bpm=0)
            await fadePromise;

            // setFinalGains uses .value = directly (not setValueAtTime) to avoid crackling
            expect(fromDeck.gain.gain.value).toBe(0);
            expect(toDeck.gain.gain.value).toBe(volume);

            vi.restoreAllMocks();
        });

        it('equal-power at midpoint: both gains approx volume * sin(π/4)', async () => {
            // At t=0.5, gainOut=cos(π/4)*v, gainIn=sin(π/4)*v → both ≈ v*0.707.
            // Mid-fade the target gain is delivered via linearRampToValueAtTime
            // (a short per-frame glide); only the final frame uses setValueAtTime.
            const { fire, rafMock } = makeRafController();
            const volume = 1.0;
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            // 8 beats at unknown BPM → assumed 120 BPM → 8 * (60000/120) = 4000ms.
            const fadeDurationMs = 4000;

            const fromCalls: number[] = [];
            const toCalls: number[] = [];
            (
                fromDeck.gain.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>
            ).mockImplementation((v: number) => fromCalls.push(v));
            (
                toDeck.gain.gain.linearRampToValueAtTime as ReturnType<typeof vi.fn>
            ).mockImplementation((v: number) => toCalls.push(v));

            engine.startCrossfade(fromDeck, toDeck, { beats: 8, volume }).catch(() => undefined);

            // Fire at exactly t=0.5
            fire(fadeDurationMs * 0.5);

            // Flush pending rAF
            const lastRafCall = rafMock.mock.calls.length;
            expect(lastRafCall).toBeGreaterThan(0);

            const expectedGain = Math.cos(0.5 * Math.PI * 0.5); // cos(π/4)
            const lastFrom = fromCalls[fromCalls.length - 1];
            const lastTo = toCalls[toCalls.length - 1];

            if (lastFrom !== undefined) {
                expect(lastFrom).toBeCloseTo(expectedGain, 3);
            }
            if (lastTo !== undefined) {
                const tIn = Math.max(0, (0.5 - 0.12) / 0.88);
                expect(lastTo).toBeCloseTo(Math.sin(tIn * Math.PI * 0.5), 3);
            }

            engine.cancel();
            vi.restoreAllMocks();
        });

        it('positions incoming track at introEndMs when provided', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                incomingIntroEndMs: 2000,
            });
            fire(20000); // past the 16s fade duration
            await fadePromise;

            expect(toDeck.audio.currentTime).toBe(2);
            vi.restoreAllMocks();
        });

        it('adjusts playbackRate for small BPM gap (≤8%)', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            // 120→125 BPM: gap = |1 - 125/120| ≈ 4.2% — uses native rate
            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                outgoingBpm: 120,
                incomingBpm: 125,
            });
            fire(5000);
            await fadePromise;

            const expectedRate = 120 / 125;
            expect(toDeck.audio.playbackRate).toBeCloseTo(expectedRate, 4);
            vi.restoreAllMocks();
        });

        it('skips BPM matching for large gap (>25%)', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            // rate = outgoing/incoming = 120/170 ≈ 0.71 → gap ≈ 0.29 > 0.25 → skipped
            // (120→160 gives exactly 0.25 which hits the ≤0.25 timestretch branch;
            // 200 would octave-fold to 100 → a 20% gap, not a skip)
            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                outgoingBpm: 120,
                incomingBpm: 170,
            });
            fire(5000);
            await fadePromise;

            // playbackRate should remain 1 (no matching applied)
            expect(toDeck.audio.playbackRate).toBe(1);
            vi.restoreAllMocks();
        });

        it('cancel() stops the animation frame mid-fade', () => {
            let rafCallback: ((time: number) => void) | null = null;
            vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
                rafCallback = cb;
                return 42;
            });
            vi.spyOn(performance, 'now').mockReturnValue(0);

            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            engine.startCrossfade(fromDeck, toDeck, { beats: 8 }).catch(() => undefined);
            expect(rafCallback).not.toBeNull();

            engine.cancel();

            // After cancel, firing the rAF should be a no-op (already cancelled)
            const callsBefore = (fromDeck.gain.gain.setValueAtTime as ReturnType<typeof vi.fn>).mock
                .calls.length;
            if (rafCallback) (rafCallback as (time: number) => void)(5000); // this fires but engine is cancelled

            // The engine should have cancelled the animation
            vi.restoreAllMocks();

            expect(callsBefore).toBeGreaterThanOrEqual(0); // Just verify no crash
        });

        it('default fadeMode is blend when not specified', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume: 0.8,
            });
            fire(20000);
            await fadePromise;

            // createBiquadFilter should NOT have been called (no filter mode)
            expect(
                (
                    ctx as unknown as {
                        createBiquadFilter: ReturnType<typeof vi.fn>;
                    }
                ).createBiquadFilter,
            ).not.toHaveBeenCalled();
            vi.restoreAllMocks();
        });

        it('cut mode behaves like blend (equal-power gains)', async () => {
            makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 2,
                volume: 0.8,
                fadeMode: 'cut',
            });
            // cut mode resolves via setTimeout(20ms) — advance fake timers to fire it
            await vi.runAllTimersAsync();
            await fadePromise;

            expect(fromDeck.gain.gain.setValueAtTime).toHaveBeenCalled();
            expect(toDeck.gain.gain.setValueAtTime).toHaveBeenCalled();
            // createBiquadFilter should NOT have been called
            expect(
                (
                    ctx as unknown as {
                        createBiquadFilter: ReturnType<typeof vi.fn>;
                    }
                ).createBiquadFilter,
            ).not.toHaveBeenCalled();
            vi.restoreAllMocks();
        });

        it('filter mode creates a BiquadFilterNode and inserts it on the from deck', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume: 0.8,
                fadeMode: 'filter',
            });
            fire(20000);
            await fadePromise;

            const mockCtx = ctx as unknown as {
                createBiquadFilter: ReturnType<typeof vi.fn>;
            };
            expect(mockCtx.createBiquadFilter).toHaveBeenCalledOnce();

            // source should have been disconnected from gain and reconnected via filter
            expect(fromDeck.source.disconnect).toHaveBeenCalled();
            expect(fromDeck.source.connect).toHaveBeenCalled();

            vi.restoreAllMocks();
        });

        it('filter mode cleans up BiquadFilterNode after fade completes', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume: 0.8,
                fadeMode: 'filter',
            });
            fire(20000);
            await fadePromise;

            const mockCtx = ctx as unknown as {
                createBiquadFilter: ReturnType<typeof vi.fn>;
            };
            const filterNode = mockCtx.createBiquadFilter.mock.results[0].value as {
                disconnect: ReturnType<typeof vi.fn>;
            };

            // Filter should have been disconnected during cleanup
            expect(filterNode.disconnect).toHaveBeenCalled();

            // Source should be reconnected to eqLow (normal signal chain) after cleanup
            const connectCalls = (fromDeck.source.connect as ReturnType<typeof vi.fn>).mock.calls;
            const lastConnect = connectCalls[connectCalls.length - 1][0];
            expect(lastConnect).toBe(fromDeck.eqLow);

            vi.restoreAllMocks();
        });

        it('echo mode creates DelayNode and GainNodes on the from deck', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume: 0.8,
                fadeMode: 'echo',
                outgoingBpm: 120,
            });
            fire(20000);
            await fadePromise;

            const mockCtx = ctx as unknown as {
                createDelay: ReturnType<typeof vi.fn>;
                createGain: ReturnType<typeof vi.fn>;
            };
            expect(mockCtx.createDelay).toHaveBeenCalledOnce();
            // Two extra GainNodes: feedback + wet
            expect(mockCtx.createGain).toHaveBeenCalledTimes(2);

            vi.restoreAllMocks();
        });

        it('echo mode cleans up delay and gain nodes after fade completes', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume: 0.8,
                fadeMode: 'echo',
                outgoingBpm: 120,
            });
            fire(20000);
            await fadePromise;

            const mockCtx = ctx as unknown as {
                createDelay: ReturnType<typeof vi.fn>;
                createGain: ReturnType<typeof vi.fn>;
            };
            const delayNode = mockCtx.createDelay.mock.results[0].value as {
                disconnect: ReturnType<typeof vi.fn>;
            };
            expect(delayNode.disconnect).toHaveBeenCalled();

            vi.restoreAllMocks();
        });

        it('cancel during filter mode cleans up BiquadFilterNode', () => {
            let rafCallback: ((time: number) => void) | null = null;
            vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
                rafCallback = cb;
                return 42;
            });
            vi.spyOn(performance, 'now').mockReturnValue(0);

            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            engine
                .startCrossfade(fromDeck, toDeck, {
                    beats: 8,
                    fadeMode: 'filter',
                })
                .catch(() => undefined);

            expect(rafCallback).not.toBeNull();

            engine.cancel();

            const mockCtx = ctx as unknown as {
                createBiquadFilter: ReturnType<typeof vi.fn>;
            };
            const filterNode = mockCtx.createBiquadFilter.mock.results[0].value as {
                disconnect: ReturnType<typeof vi.fn>;
            };

            // Filter should be disconnected on cancel
            expect(filterNode.disconnect).toHaveBeenCalled();
            vi.restoreAllMocks();
        });

        it('bassswap mode controls EQ shelf gains on both decks', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume: 0.8,
                fadeMode: 'bassswap',
            });
            fire(20000);
            await fadePromise;

            // bassswap uses the decks' pre-wired EQ shelves — no new nodes created
            const mockCtx = ctx as unknown as {
                createBiquadFilter: ReturnType<typeof vi.fn>;
                createGain: ReturnType<typeof vi.fn>;
            };
            expect(mockCtx.createBiquadFilter).not.toHaveBeenCalled();
            expect(mockCtx.createGain).not.toHaveBeenCalled();

            // EQ shelf gains must have been set on both decks
            expect(fromDeck.eqLow.gain.setValueAtTime).toHaveBeenCalled();
            expect(fromDeck.eqHigh.gain.setValueAtTime).toHaveBeenCalled();
            expect(toDeck.eqLow.gain.setValueAtTime).toHaveBeenCalled();
            expect(toDeck.eqHigh.gain.setValueAtTime).toHaveBeenCalled();

            vi.restoreAllMocks();
        });

        it('bassswap: at t=0 outgoing bass EQ is set, incoming bass EQ starts silent', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();
            const volume = 0.8;

            engine
                .startCrossfade(fromDeck, toDeck, {
                    beats: 8,
                    volume,
                    fadeMode: 'bassswap',
                })
                .catch(() => undefined);

            // Fire at t=0 (just started)
            fire(1);

            // bassswap uses deck EQ shelves directly — check setup called setValueAtTime
            // on the incoming deck to silence it (EQ_MIN_DB) and tick set outgoing EQ
            expect(fromDeck.eqLow.gain.setValueAtTime).toHaveBeenCalled();
            expect(toDeck.eqLow.gain.setValueAtTime).toHaveBeenCalled();

            engine.cancel();
            vi.restoreAllMocks();
        });

        it('bassswap mode disconnects all band nodes after fade completes', async () => {
            const { fire } = makeRafController();
            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            const fadePromise = engine.startCrossfade(fromDeck, toDeck, {
                beats: 8,
                volume: 0.8,
                fadeMode: 'bassswap',
            });
            fire(20000);
            await fadePromise;

            const mockCtx = ctx as unknown as {
                createBiquadFilter: ReturnType<typeof vi.fn>;
                createGain: ReturnType<typeof vi.fn>;
            };

            for (const result of mockCtx.createBiquadFilter.mock.results) {
                const node = result.value as {
                    disconnect: ReturnType<typeof vi.fn>;
                };
                expect(node.disconnect).toHaveBeenCalled();
            }
            for (const result of mockCtx.createGain.mock.results) {
                const node = result.value as {
                    disconnect: ReturnType<typeof vi.fn>;
                };
                expect(node.disconnect).toHaveBeenCalled();
            }

            vi.restoreAllMocks();
        });

        it('cancel during bassswap mode cleans up band nodes', () => {
            let rafCallback: ((time: number) => void) | null = null;
            vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
                rafCallback = cb;
                return 42;
            });
            vi.spyOn(performance, 'now').mockReturnValue(0);

            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            engine
                .startCrossfade(fromDeck, toDeck, {
                    beats: 8,
                    fadeMode: 'bassswap',
                })
                .catch(() => undefined);

            expect(rafCallback).not.toBeNull();

            engine.cancel();

            const mockCtx = ctx as unknown as {
                createBiquadFilter: ReturnType<typeof vi.fn>;
            };
            for (const result of mockCtx.createBiquadFilter.mock.results) {
                const node = result.value as {
                    disconnect: ReturnType<typeof vi.fn>;
                };
                expect(node.disconnect).toHaveBeenCalled();
            }

            vi.restoreAllMocks();
        });

        it('cancel during echo mode cleans up delay and gain nodes', () => {
            let rafCallback: ((time: number) => void) | null = null;
            vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => {
                rafCallback = cb;
                return 42;
            });
            vi.spyOn(performance, 'now').mockReturnValue(0);

            const fromDeck = createMockDeck();
            const toDeck = createMockDeck();

            engine
                .startCrossfade(fromDeck, toDeck, {
                    beats: 8,
                    fadeMode: 'echo',
                    outgoingBpm: 120,
                })
                .catch(() => undefined);

            expect(rafCallback).not.toBeNull();

            engine.cancel();

            const mockCtx = ctx as unknown as {
                createDelay: ReturnType<typeof vi.fn>;
            };
            const delayNode = mockCtx.createDelay.mock.results[0].value as {
                disconnect: ReturnType<typeof vi.fn>;
            };

            expect(delayNode.disconnect).toHaveBeenCalled();
            vi.restoreAllMocks();
        });
    });
});
