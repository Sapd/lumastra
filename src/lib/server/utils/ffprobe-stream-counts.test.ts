// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Isolated subprocess mock: ffprobe.test.ts deliberately exercises the real binary.
import { describe, it, expect, vi } from 'vitest';
import { promisify } from 'util';

vi.mock('child_process', () => {
    const execFileFn = vi.fn() as ReturnType<typeof vi.fn> & {
        [promisify.custom]?: ReturnType<typeof vi.fn>;
    };
    execFileFn[promisify.custom] = vi.fn();
    return { execFile: execFileFn };
});

vi.mock('$lib/server/config.js', () => ({
    config: { FFPROBE_PATH: '/usr/bin/ffprobe' },
}));

import { execFile } from 'child_process';
import { probeStreamCounts } from './ffprobe.js';

const mockExecFileAsync = vi.mocked(
    (execFile as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[promisify.custom],
);

describe('probeStreamCounts — playable video tracks', () => {
    it('ignores PNG cover art in the production ffprobe disposition shape', async () => {
        // Production fixture: one H.264 video, AAC audio and an attached PNG.
        // Put the cover first to also prove it cannot replace video field order.
        mockExecFileAsync.mockResolvedValueOnce({
            stdout: JSON.stringify({
                streams: [
                    {
                        codec_type: 'video',
                        field_order: 'progressive',
                        disposition: { attached_pic: 1 },
                    },
                    {
                        codec_type: 'video',
                        field_order: 'tt',
                        disposition: { attached_pic: 0 },
                    },
                    { codec_type: 'audio', disposition: { attached_pic: 0 } },
                ],
            }),
            stderr: '',
        });

        expect(await probeStreamCounts('/library/episode.mkv')).toEqual({
            video: 1,
            audio: 1,
            subtitle: 0,
            videoFieldOrder: 'tt',
        });
    });

    it('still counts multiple real video tracks, including absent disposition metadata', async () => {
        mockExecFileAsync.mockResolvedValueOnce({
            stdout: JSON.stringify({
                streams: [
                    { codec_type: 'video', field_order: 'progressive' },
                    { codec_type: 'video', disposition: { attached_pic: 0 } },
                    { codec_type: 'audio' },
                    { codec_type: 'subtitle' },
                ],
            }),
            stderr: '',
        });

        expect(await probeStreamCounts('/library/multi-angle.mkv')).toEqual({
            video: 2,
            audio: 1,
            subtitle: 1,
            videoFieldOrder: 'progressive',
        });
    });
});
