// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearActiveHlsSeeksForTests,
    deduplicatedHlsSeek,
    type HlsSeekTranscodeService,
} from './seek-coordinator.js';
import type { TranscodeJob } from '../transcoding/types.js';

function createService(job: TranscodeJob): HlsSeekTranscodeService & {
    calls: Array<{
        targetSegmentIndex: number;
        segmentDurationSeconds: number;
        seekTimeSeconds?: number;
    }>;
} {
    const calls: Array<{
        targetSegmentIndex: number;
        segmentDurationSeconds: number;
        seekTimeSeconds?: number;
    }> = [];

    return {
        calls,
        getJobByPlaySession: () => job,
        seekToSegment: async (
            _playSessionId,
            targetSegmentIndex,
            segmentDurationSeconds,
            seekTimeSeconds,
        ) => {
            calls.push({
                targetSegmentIndex,
                segmentDurationSeconds,
                seekTimeSeconds,
            });
            return true;
        },
    };
}

describe('deduplicatedHlsSeek', () => {
    afterEach(() => {
        clearActiveHlsSeeksForTests();
    });

    it('normalizes seek targets to job segment duration', async () => {
        const service = createService({
            id: 'job',
            segmentDurationSeconds: 10,
        } as TranscodeJob);

        await deduplicatedHlsSeek({
            playSessionId: 'play',
            targetSegmentIndex: 12,
            segmentDurationSeconds: 6,
            fallbackSegmentDurationSeconds: 6,
            transcodeService: service,
        });

        expect(service.calls).toEqual([
            {
                targetSegmentIndex: 7,
                segmentDurationSeconds: 10,
                seekTimeSeconds: 72,
            },
        ]);
    });

    it('joins an active seek when the target is identical', async () => {
        let resolveSeek: (value: boolean) => void = () => undefined;
        const service = {
            calls: 0,
            getJobByPlaySession: () =>
                ({
                    id: 'job',
                    segmentDurationSeconds: 10,
                }) as TranscodeJob,
            seekToSegment: async () => {
                service.calls += 1;
                return new Promise<boolean>((resolve) => {
                    resolveSeek = resolve;
                });
            },
        };

        const first = deduplicatedHlsSeek({
            playSessionId: 'play',
            targetSegmentIndex: 10,
            segmentDurationSeconds: 10,
            fallbackSegmentDurationSeconds: 10,
            transcodeService: service,
        });
        // Same target from a different stream — should deduplicate
        const second = deduplicatedHlsSeek({
            playSessionId: 'play',
            targetSegmentIndex: 10,
            segmentDurationSeconds: 10,
            fallbackSegmentDurationSeconds: 10,
            transcodeService: service,
        });

        resolveSeek(true);
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(service.calls).toBe(1);
    });

    it('re-seeks when the new target differs from the active seek', async () => {
        const resolvers: Array<(value: boolean) => void> = [];
        const service = {
            calls: 0,
            getJobByPlaySession: () =>
                ({
                    id: 'job',
                    segmentDurationSeconds: 10,
                }) as TranscodeJob,
            seekToSegment: async () => {
                service.calls += 1;
                return new Promise<boolean>((resolve) => {
                    resolvers.push(resolve);
                });
            },
        };

        const first = deduplicatedHlsSeek({
            playSessionId: 'play',
            targetSegmentIndex: 10,
            segmentDurationSeconds: 10,
            fallbackSegmentDurationSeconds: 10,
            transcodeService: service,
        });
        const second = deduplicatedHlsSeek({
            playSessionId: 'play',
            targetSegmentIndex: 50,
            segmentDurationSeconds: 10,
            fallbackSegmentDurationSeconds: 10,
            transcodeService: service,
        });

        // Resolve the first seek — this unblocks the second caller which then re-seeks
        resolvers[0]?.(true);
        // Wait a tick for the second seek to be created
        await new Promise((r) => setTimeout(r, 10));
        // Resolve the second seek
        resolvers[1]?.(true);

        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        // Different targets must trigger separate seeks
        expect(service.calls).toBe(2);
    });

    it.each([127, 153])('serializes a backward request burst ending at %s', async (lastTarget) => {
        const resolvers: Array<(value: boolean) => void> = [];
        const targets: number[] = [];
        let active = 0;
        let peakActive = 0;
        const service: HlsSeekTranscodeService = {
            getJobByPlaySession: () => ({ segmentDurationSeconds: 6 }) as TranscodeJob,
            seekToSegment: async (_session, target) => {
                targets.push(target);
                peakActive = Math.max(peakActive, ++active);
                await new Promise<boolean>((resolve) => resolvers.push(resolve));
                active--;
                return true;
            },
        };
        const seek = (targetSegmentIndex: number): Promise<boolean> =>
            deduplicatedHlsSeek({
                playSessionId: 'backward-burst',
                targetSegmentIndex,
                segmentDurationSeconds: 6,
                fallbackSegmentDurationSeconds: 6,
                transcodeService: service,
            });
        const requests = [seek(158), seek(153), seek(lastTarget)];
        resolvers[0]!(true);
        await vi.waitFor(() => expect(targets.length).toBeGreaterThanOrEqual(2));
        // Drain before asserting, including overlapping seeks in the broken implementation.
        resolvers[1]!(true);
        if (lastTarget !== 153 || targets.length > 2) {
            await vi.waitFor(() => expect(targets.length).toBe(3));
            resolvers[2]!(true);
        }
        await expect(Promise.all(requests)).resolves.toEqual([true, true, true]);
        expect(peakActive).toBe(1);
        expect(targets).toEqual(lastTarget === 153 ? [158, 153] : [158, 153, 127]);
    });

    it('keeps the captured rapid-rewind burst to one restart at a time', async () => {
        const targets = [143, 140, 138, 136, 135, 133, 130, 128, 125, 123, 121, 120, 116, 111, 108];
        const completed: number[] = [];
        let active = 0;
        let peakActive = 0;
        const service: HlsSeekTranscodeService = {
            getJobByPlaySession: () => ({ segmentDurationSeconds: 6 }) as TranscodeJob,
            seekToSegment: async (_session, target) => {
                peakActive = Math.max(peakActive, ++active);
                await new Promise<void>((resolve) => setTimeout(resolve, 1));
                completed.push(target);
                active--;
                return true;
            },
        };
        const results = await Promise.all(
            targets.map((targetSegmentIndex) =>
                deduplicatedHlsSeek({
                    playSessionId: 'rapid-rewind',
                    targetSegmentIndex,
                    segmentDurationSeconds: 6,
                    fallbackSegmentDurationSeconds: 6,
                    transcodeService: service,
                }),
            ),
        );
        expect(results.every(Boolean)).toBe(true);
        expect(peakActive).toBe(1);
        expect(completed).toEqual(targets);
    });

    it('uses keyframe segment targets for muxed copy sessions', async () => {
        const service = createService({
            id: 'job',
            segmentDurationSeconds: 10,
            config: {
                totalDurationSeconds: 100,
                hlsOutput: {
                    hlsAudioMode: 'muxed',
                },
            },
            transcodeDecisionResult: {
                videoAction: 'copy',
            },
            keyframeData: [0, 11, 23],
        } as TranscodeJob);

        await deduplicatedHlsSeek({
            playSessionId: 'play',
            targetSegmentIndex: 1,
            segmentDurationSeconds: 10,
            fallbackSegmentDurationSeconds: 10,
            transcodeService: service,
        });

        expect(service.calls[0]?.targetSegmentIndex).toBe(1);
        expect(service.calls[0]?.seekTimeSeconds).toBe(11);
    });

    it('uses keyframe grid targets for GOP-mode demux copy sessions', async () => {
        const service = createService({
            id: 'job',
            segmentDurationSeconds: 10,
            config: {
                totalDurationSeconds: 100,
                hlsOutput: { hlsAudioMode: 'demux' },
                gopSegments: true,
            },
            transcodeDecisionResult: { videoAction: 'copy' },
            keyframeData: [0, 11, 23, 31],
        } as TranscodeJob);

        await deduplicatedHlsSeek({
            playSessionId: 'play',
            targetSegmentIndex: 2,
            segmentDurationSeconds: 10,
            fallbackSegmentDurationSeconds: 10,
            transcodeService: service,
        });

        expect(service.calls[0]?.targetSegmentIndex).toBe(2);
        expect(service.calls[0]?.seekTimeSeconds).toBe(23);
    });

    it('uses uniform time for demux copy sessions (not keyframe time)', async () => {
        // In demux mode, segment indices are on the uniform audio timeline.
        // Keyframe segment 50 might start at 521s but audio segment 50 = 500s.
        // Seeking to keyframe time would make audio segments unreachable.
        const service = createService({
            id: 'job',
            segmentDurationSeconds: 10,
            config: {
                totalDurationSeconds: 12000,
                hlsOutput: {
                    hlsAudioMode: 'demux',
                },
            },
            transcodeDecisionResult: {
                videoAction: 'copy',
            },
            keyframeData: [0, 10.4, 20.8, 31.2], // avg ~10.4s per keyframe
        } as TranscodeJob);

        await deduplicatedHlsSeek({
            playSessionId: 'play',
            targetSegmentIndex: 50,
            segmentDurationSeconds: 10,
            fallbackSegmentDurationSeconds: 10,
            transcodeService: service,
        });

        // Must use uniform time (50 * 10 = 500), NOT keyframe time (~521)
        expect(service.calls[0]?.seekTimeSeconds).toBe(500);
        // audioBasedTarget = floor(500 / 10) = 50 — makes segment 50 reachable
        expect(service.calls[0]?.targetSegmentIndex).toBe(50);
    });
});
