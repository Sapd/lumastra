// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { promisify } from 'util';

vi.mock('child_process', () => {
    const execFile = Object.assign(vi.fn(), { [promisify.custom]: vi.fn() });
    return { execFile };
});
vi.mock('$lib/server/config.js', () => ({ config: { FFPROBE_PATH: '/usr/bin/ffprobe' } }));
vi.mock('./library-input-guard.js', () => ({ ffprobeLibraryInputArgs: vi.fn(async () => []) }));

import { execFile } from 'child_process';
import { probeMediaFile, probeStreams } from './ffprobe';

const exec = (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom];

describe('MKV stream bitrate statistics', () => {
    it.each([
        [undefined, { BPS: '3080794' }, 3_080_794],
        [undefined, { 'BPS-eng': '3080794' }, 3_080_794],
        ['4000000', { BPS: '3080794' }, 4_000_000],
        ['N/A', { BPS: '3080794' }, 3_080_794],
        ['0', { BPS: '3080794' }, 3_080_794],
        [undefined, { BPS: 'invalid' }, null],
        [undefined, { BPS: '-1' }, null],
        [undefined, {}, null],
    ])('reads bit_rate=%s tags=%j', async (bit_rate, tags, expected) => {
        exec.mockResolvedValue({
            stdout: JSON.stringify({
                format: {
                    format_name: 'matroska,webm',
                    duration: '1424.981',
                    bit_rate: '3617925',
                },
                streams: [
                    {
                        index: 0,
                        codec_type: 'video',
                        codec_name: 'h264',
                        width: 1920,
                        height: 1080,
                        bit_rate,
                        tags,
                    },
                    { index: 1, codec_type: 'audio', codec_name: 'aac', bit_rate, tags },
                ],
            }),
            stderr: '',
        });
        const media = await probeMediaFile('/data/episode.mkv');
        expect(media?.video?.bitrate).toBe(expected);
        expect(media?.audioStreams[0].bitRate).toBe(expected ?? undefined);
        expect(media?.formatBitrate).toBe(3_617_925);
        const streams = await probeStreams('/data/episode.mkv');
        expect(streams?.video[0].bitrate).toBe(expected);
        expect(streams?.audio[0].bitRate).toBe(expected ?? undefined);
    });
});
