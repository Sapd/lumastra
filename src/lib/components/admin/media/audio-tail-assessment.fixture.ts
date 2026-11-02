// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import {
    AudioTailAssessmentSchema,
    type AudioTailAssessment,
} from '$lib/schemas/audio-tail-assessment.js';

/** Generated test evidence only; never a claim about real library bytes. */
export function audioTailAssessmentFixture(
    fileId: string,
    observation: 'near_silent' | 'audible' = 'near_silent',
): AudioTailAssessment {
    const silent = observation === 'near_silent';
    return AudioTailAssessmentSchema.parse({
        version: 1,
        measuredAt: '2026-10-24T12:00:00Z',
        method: 'ffmpeg-astats-frames-v1',
        thresholdDbfs: -60,
        completeness: 'unverified',
        scope: 'measured',
        observation,
        requested: { start: 100, end: 120 },
        inventorySignature: `fixture-inventory-${fileId}`,
        inventory: [
            {
                index: 0,
                codec_type: 'video',
                codec_name: 'h264',
                time_base: '1/1000',
                start_time: '0.000000',
            },
            {
                index: 1,
                codec_type: 'audio',
                codec_name: 'pcm_s16le',
                channels: 2,
                sample_rate: '48000',
                time_base: '1/1000',
                start_time: '0.000000',
                duration: '120.000000',
            },
        ],
        source: {
            generation: `fixture-generation-${fileId}`,
            physical: `fixture-physical-${fileId}`,
            streams: `fixture-streams-${fileId}`,
        },
        limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
        reasons: [],
        streams: [
            {
                index: 1,
                requested: { start: 100, end: 120 },
                decoded: { start: 100, end: 120 },
                samples: 960000,
                coverageSeconds: 20,
                continuous: true,
                channels: [1, 2].map((channel) => ({
                    channel,
                    peakDbfs: silent ? -300 : -12,
                    rmsDbfs: silent ? -300 : -18,
                    digitalZero: silent,
                })),
                reasons: [],
            },
        ],
    });
}
