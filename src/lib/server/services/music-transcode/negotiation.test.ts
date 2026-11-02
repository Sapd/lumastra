// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
vi.mock('$lib/server/config.js', () => ({ config: { MUSIC_TRANSCODE_DEFAULT_BITRATE: 192 } }));
import { negotiateAudio } from './negotiation.js';
const mp3 = {
    codec: 'mp3',
    container: 'mp3',
    bitrate: 320_000,
    channels: 2,
    sampleRate: 44100,
    bitDepth: 16,
};
const enabled = { transcodeEnabled: true };
describe('shared music start/byte decision', () => {
    it('caps without forcing and always encodes an explicit bitrate', () => {
        expect(negotiateAudio(mp3, { ...enabled, maxBitrateKbps: 320 }).playMethod).toBe('direct');
        expect(negotiateAudio(mp3, { ...enabled, format: 'mp3', bitrateKbps: 100 })).toMatchObject({
            codec: 'mp3',
            container: 'mp3',
            bitrateKbps: 96,
            playMethod: 'audio_transcode',
        });
        expect(
            negotiateAudio(
                { ...mp3, bitrate: 128_000 },
                { ...enabled, format: 'mp3', bitrateKbps: 320 },
            ).playMethod,
        ).toBe('audio_transcode');
    });
    it('honors BOTH codec and container, including AAC in MP4', () => {
        const capabilities = { containers: ['mp4'], audioCodecs: ['aac'] };
        expect(negotiateAudio(mp3, { ...enabled, capabilities })).toMatchObject({
            target: 'm4a',
            codec: 'aac',
            container: 'mp4',
            playMethod: 'audio_transcode',
        });
        expect(negotiateAudio(mp3, { ...enabled, capabilities }).reasonCodes).toEqual([
            { code: 'audio_codec_incompatible', params: { codecs: 'mp3' } },
            { code: 'audio_container_incompatible' },
        ]);
        expect(() => negotiateAudio(mp3, { ...enabled, capabilities, format: 'aac' })).toThrow(
            'incompatible',
        );
        expect(() => negotiateAudio(mp3, { ...enabled, capabilities, format: 'flac' })).toThrow(
            'Unsupported',
        );
    });
    it('a direct override cannot disable required encoding; an upgrade has a structured reason', () => {
        expect(
            negotiateAudio(mp3, {
                ...enabled,
                capabilities: { containers: ['mp4'], audioCodecs: ['aac'] },
                requestedMethod: 'direct',
            }).playMethod,
        ).toBe('audio_transcode');
        expect(
            negotiateAudio(mp3, { ...enabled, requestedMethod: 'full_transcode' }).reasonCodes,
        ).toContainEqual({ code: 'client_requested' });
    });
    it('byte delivery preserves a forced same-codec start decision', () => {
        const source = { ...mp3, codec: 'aac', container: 'mp4', bitrate: 128_000 };
        const start = negotiateAudio(source, {
            ...enabled,
            capabilities: { containers: ['mp4'], audioCodecs: ['aac'] },
            requestedMethod: 'full_transcode',
        });
        expect(start.playMethod).toBe('audio_transcode');
        expect(
            negotiateAudio(source, {
                ...enabled,
                format: start.target,
                bitrateKbps: start.bitrateKbps,
            }),
        ).toMatchObject({
            codec: start.codec,
            container: start.container,
            bitrateKbps: start.bitrateKbps,
            playMethod: start.playMethod,
        });
    });
    it('rejects impossible or disabled conversion instead of claiming successful direct delivery', () => {
        expect(() => negotiateAudio(mp3, { transcodeEnabled: false, format: 'opus' })).toThrow(
            'unavailable',
        );
        expect(() =>
            negotiateAudio(mp3, { ...enabled, capabilities: { containers: [], audioCodecs: [] } }),
        ).toThrow('No supported');
        expect(() =>
            negotiateAudio(mp3, { ...enabled, format: 'raw', maxBitrateKbps: 64 }),
        ).toThrow('Raw');
        expect(() =>
            negotiateAudio(
                { ...mp3, channels: 6 },
                { ...enabled, format: 'raw', capabilities: { maxAudioChannels: 2 } },
            ),
        ).toThrow('Raw');
        expect(() => negotiateAudio(mp3, { ...enabled, maxBitrateKbps: 1 })).toThrow('minimum');
    });
});

it('refuses contradictory raw and forced conversion controls', () => {
    expect(() =>
        negotiateAudio(mp3, { ...enabled, format: 'raw', requestedMethod: 'full_transcode' }),
    ).toThrow('conflicts');
});

it.each(['opus', 'aac'] as const)(
    'honors explicit %s with default or partially omitted capabilities',
    (format) => {
        for (const capabilities of [{}, { maxAudioChannels: 2 }]) {
            expect(negotiateAudio(mp3, { ...enabled, capabilities, format })).toMatchObject({
                playMethod: 'audio_transcode',
                target: format,
            });
        }
        for (const capabilities of [
            { audioCodecs: ['mp3'] },
            { containers: ['mp3'] },
            { audioCodecs: [] },
            { containers: [] },
        ]) {
            expect(() => negotiateAudio(mp3, { ...enabled, capabilities, format })).toThrow(
                'incompatible',
            );
        }
    },
);
