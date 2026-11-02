// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'No space left on device',
    })),
}));
import { generateEpisodeThumbnail } from './frame-candidate.service.js';

describe('thumbnail candidate infrastructure errors', () => {
    it('retains the disk-full reason when FFmpeg cannot write its candidates', async () => {
        const result = await generateEpisodeThumbnail({
            episodeId: 'disk-full-fixture',
            videoPath: '/fixture/episode.mkv',
            outputPath: '/tmp/unwritten-disk-full-thumbnail.jpg',
            durationSeconds: 600,
        });
        expect(result).toMatchObject({
            success: false,
            error: expect.stringContaining('No space left on device'),
        });
    });
});
