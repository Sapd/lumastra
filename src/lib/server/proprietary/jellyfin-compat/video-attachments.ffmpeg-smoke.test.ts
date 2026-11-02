// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Runs REAL ffprobe/ffmpeg against a Matroska file with an attached font:
 * the listing PlaybackInfo hands out and the bytes the Attachments route
 * serves must be the font that went in. Skips when ffmpeg/ffprobe are absent.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg';

const mockConfig = vi.hoisted(() => ({ FFMPEG_PATH: 'ffmpeg', FFPROBE_PATH: 'ffprobe' }));
vi.mock('$lib/server/config', () => ({ config: mockConfig, LUMASTRA_FFMPEG_THREADS: 0 }));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig, LUMASTRA_FFMPEG_THREADS: 0 }));
vi.mock('$lib/server/utils/media-path-resolver', () => ({
    resolveMediaPath: vi.fn(async (p: string) => ({ isAccessible: true, containerPath: p })),
}));

const { listVideoAttachments, extractVideoAttachment, mediaAttachmentsForSource } =
    await import('./video-attachments');

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('video attachments (real ffmpeg)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jf-attach-'));
    const font = randomBytes(4096);
    const mkv = join(dir, 'with-font.mkv');
    const plain = join(dir, 'plain.mkv');

    beforeAll(() => {
        writeFileSync(join(dir, 'font.ttf'), font);
        const video = ['-f', 'lavfi', '-i', 'testsrc=d=1:s=64x64:r=5', '-c:v', 'mpeg4'];
        execFileSync('ffmpeg', ['-v', 'error', '-y', ...video, plain]);
        execFileSync('ffmpeg', [
            '-v',
            'error',
            '-y',
            ...video,
            '-attach',
            join(dir, 'font.ttf'),
            '-metadata:s:t:0',
            'mimetype=font/ttf',
            '-metadata:s:t:0',
            'filename=Fancy Font.ttf',
            mkv,
        ]);
    });

    it('lists the attachment by its container stream index', async () => {
        const list = await listVideoAttachments(mkv);
        expect(list).toEqual([
            expect.objectContaining({ index: 1, fileName: 'Fancy Font.ttf', mimeType: 'font/ttf' }),
        ]);
        expect(await listVideoAttachments(plain)).toEqual([]);
    });

    it('extracts exactly the bytes that were attached', async () => {
        const out = await extractVideoAttachment(mkv, 1);
        expect(out?.attachment.fileName).toBe('Fancy Font.ttf');
        expect(Buffer.compare(out!.data, font)).toBe(0);
        // Cached: same bytes again.
        expect(Buffer.compare((await extractVideoAttachment(mkv, 1))!.data, font)).toBe(0);
    });

    it('returns null for an index that is not an attachment', async () => {
        expect(await extractVideoAttachment(mkv, 0)).toBeNull();
        expect(await extractVideoAttachment(mkv, 7)).toBeNull();
        expect(await extractVideoAttachment(join(dir, 'missing.mkv'), 1)).toBeNull();
    });

    it('builds MediaAttachments with an authenticated DeliveryUrl', async () => {
        const list = await mediaAttachmentsForSource({} as never, {
            itemId: 'item-1',
            fileId: 'file-1',
            filePath: mkv,
            container: 'mkv',
            subtitleCodecs: ['ass'],
            apiKey: 'tok',
        });
        expect(list).toEqual([
            {
                Codec: null,
                CodecTag: null,
                Comment: null,
                Index: 1,
                FileName: 'Fancy Font.ttf',
                MimeType: 'font/ttf',
                DeliveryUrl: '/Videos/item-1/file-1/Attachments/1?api_key=tok',
            },
        ]);
        // No ASS track: no probe, nothing listed.
        expect(
            await mediaAttachmentsForSource({} as never, {
                itemId: 'item-1',
                fileId: 'file-1',
                filePath: mkv,
                container: 'mkv',
                subtitleCodecs: ['subrip'],
                apiKey: 'tok',
            }),
        ).toEqual([]);
    });
});
