// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    PlaybackCapabilitiesSchema,
    resolvePlaybackCapabilities,
} from './playback-capabilities.js';
import { PlayabilityRequestSchema } from './api-playability.js';
import { PlaybackStartRequestSchema } from './playback-start.js';

describe('hlsCopyReload request contract', () => {
    it.each([true, false])('preserves %s in both probe and start bodies', (hlsCopyReload) => {
        const capabilities = { hlsCopyReload };
        expect(PlayabilityRequestSchema.parse({ capabilities }).capabilities).toEqual(capabilities);
        expect(
            PlaybackStartRequestSchema.parse({
                mediaId: '6b1f0000-0000-4000-8000-000000000001',
                deviceId: 'native-player',
                capabilities,
            }).capabilities,
        ).toEqual(capabilities);
    });

    it('is optional and accepts only booleans', () => {
        expect(PlaybackCapabilitiesSchema.parse({})).not.toHaveProperty('hlsCopyReload');
        for (const value of ['true', 1, null]) {
            expect(PlaybackCapabilitiesSchema.safeParse({ hlsCopyReload: value }).success).toBe(
                false,
            );
        }
    });
});

describe('resolvePlaybackCapabilities', () => {
    it('returns the documented default when capabilities are omitted', () => {
        expect(resolvePlaybackCapabilities(undefined)).toEqual({
            containers: ['mp4', 'ts', 'mp3', 'm4a'],
            videoCodecs: ['h264'],
            audioCodecs: ['aac', 'mp3'],
            subtitleFormats: ['vtt'],
            hdr: [],
        });
    });

    it('returns a fresh copy of the default on every call', () => {
        const first = resolvePlaybackCapabilities(undefined);
        first.containers.push('mkv');
        const second = resolvePlaybackCapabilities(undefined);
        expect(second.containers).toEqual(['mp4', 'ts', 'mp3', 'm4a']);
        expect(second.containers).not.toBe(first.containers);
    });

    it('keeps every declared list', () => {
        const declared = {
            containers: ['mkv'],
            videoCodecs: ['hevc'],
            audioCodecs: ['ac3'],
            subtitleFormats: ['pgs'],
            hdr: ['dovi'],
        };
        expect(resolvePlaybackCapabilities(declared)).toEqual(declared);
    });

    it('fills only the lists a partial declaration omits (no hdr is SDR, not a 422)', () => {
        const resolved = resolvePlaybackCapabilities({ videoCodecs: ['hevc'], maxHeight: 1080 });
        expect(resolved).toEqual({
            containers: ['mp4', 'ts', 'mp3', 'm4a'],
            videoCodecs: ['hevc'],
            audioCodecs: ['aac', 'mp3'],
            subtitleFormats: ['vtt'],
            hdr: [],
            maxHeight: 1080,
        });
        expect(PlaybackCapabilitiesSchema.safeParse({ videoCodecs: ['h264'] }).success).toBe(true);
    });
});

describe('PlaybackCapabilitiesSchema token length', () => {
    const base = {
        containers: [] as string[],
        videoCodecs: [] as string[],
        audioCodecs: [] as string[],
        subtitleFormats: [] as string[],
        hdr: [] as string[],
    };

    it('accepts a 100-character token', () => {
        const parsed = PlaybackCapabilitiesSchema.safeParse({
            ...base,
            containers: ['a'.repeat(100)],
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects a 200-character token', () => {
        const parsed = PlaybackCapabilitiesSchema.safeParse({
            ...base,
            containers: ['a'.repeat(200)],
        });
        expect(parsed.success).toBe(false);
    });
});

describe('deprecated multipartVideo request compatibility', () => {
    it.each([undefined, false, true])(
        'accepts %s from shipped Apple clients on probe and start',
        (multipartVideo) => {
            const capabilities = multipartVideo === undefined ? {} : { multipartVideo };
            expect(PlayabilityRequestSchema.parse({ capabilities }).capabilities).toEqual(
                capabilities,
            );
            expect(
                PlaybackStartRequestSchema.parse({
                    mediaId: '6b1f0000-0000-4000-8000-000000000001',
                    deviceId: 'native-player',
                    capabilities,
                }).capabilities,
            ).toEqual(capabilities);
        },
    );
});

describe('deprecated versionId on playback start', () => {
    it('accepts and ignores a stale versionId from older Apple builds', async () => {
        const { PlaybackStartRequestSchema } = await import('./playback-start.js');
        const parsed = PlaybackStartRequestSchema.safeParse({
            mediaId: '6f4b4f8e-2b1c-4c39-9a51-0b7c1f2a3d4e',
            versionId: '0d9f7c55-3a7e-4f0e-8b6a-5c2d1e9f8a7b',
            deviceId: 'device-1',
        });
        expect(parsed.success).toBe(true);
    });
});
