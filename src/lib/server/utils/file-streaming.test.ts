// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for file-streaming utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable as NodeReadable } from 'node:stream';
import { getMimeType, serveFileByPath } from './file-streaming';

// ============================================================================
// getMimeType
// ============================================================================

describe('getMimeType', () => {
    describe('video extensions', () => {
        it('maps .mp4 to video/mp4', () => {
            expect(getMimeType('.mp4')).toBe('video/mp4');
        });

        it('maps .m4v to video/mp4', () => {
            expect(getMimeType('.m4v')).toBe('video/mp4');
        });

        it('maps .mkv to video/x-matroska', () => {
            expect(getMimeType('.mkv')).toBe('video/x-matroska');
        });

        it('maps .webm to video/webm', () => {
            expect(getMimeType('.webm')).toBe('video/webm');
        });

        it('maps .avi to video/x-msvideo', () => {
            expect(getMimeType('.avi')).toBe('video/x-msvideo');
        });

        it('maps .mov to video/quicktime', () => {
            expect(getMimeType('.mov')).toBe('video/quicktime');
        });

        it('maps .ts to video/MP2T', () => {
            expect(getMimeType('.ts')).toBe('video/MP2T');
        });
    });

    describe('audio extensions', () => {
        it('maps .flac to audio/flac', () => {
            expect(getMimeType('.flac')).toBe('audio/flac');
        });

        it('maps .mp3 to audio/mpeg', () => {
            expect(getMimeType('.mp3')).toBe('audio/mpeg');
        });

        it('maps .m4a to audio/mp4', () => {
            expect(getMimeType('.m4a')).toBe('audio/mp4');
        });

        it('maps .aac to audio/aac', () => {
            expect(getMimeType('.aac')).toBe('audio/aac');
        });

        it('maps .ogg to audio/ogg', () => {
            expect(getMimeType('.ogg')).toBe('audio/ogg');
        });

        it('maps .opus to audio/opus', () => {
            expect(getMimeType('.opus')).toBe('audio/opus');
        });

        it('maps .wav to audio/wav', () => {
            expect(getMimeType('.wav')).toBe('audio/wav');
        });

        it('maps .wma to audio/x-ms-wma', () => {
            expect(getMimeType('.wma')).toBe('audio/x-ms-wma');
        });

        it('maps .alac to audio/mp4', () => {
            expect(getMimeType('.alac')).toBe('audio/mp4');
        });
    });

    describe('unknown extension', () => {
        it('returns application/octet-stream for unknown extension', () => {
            expect(getMimeType('.xyz')).toBe('application/octet-stream');
        });

        it('returns application/octet-stream for empty extension', () => {
            expect(getMimeType('')).toBe('application/octet-stream');
        });
    });

    describe('case insensitivity', () => {
        it('handles uppercase extensions', () => {
            expect(getMimeType('.MP4')).toBe('video/mp4');
            expect(getMimeType('.MKV')).toBe('video/x-matroska');
            expect(getMimeType('.FLAC')).toBe('audio/flac');
        });

        it('handles mixed case extensions', () => {
            expect(getMimeType('.Mp4')).toBe('video/mp4');
        });
    });
});

// ============================================================================
// serveFileByPath
// ============================================================================

vi.mock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs/promises')>()),
    stat: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    createReadStream: vi.fn(),
}));

// The response body is now wrapped by the throttle, which iterates the stream —
// so the mock has to be an actual Readable rather than a bare object.
function fakeReadStream(): NodeReadable {
    return NodeReadable.from([Buffer.alloc(8)]);
}

describe('serveFileByPath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Fixed mtime so ETag/Last-Modified assertions are deterministic.
    const MTIME_MS = 1_700_000_000_000;

    async function setupMocks(fileSize: number, mtimeMs: number = MTIME_MS): Promise<void> {
        const { stat } = await import('node:fs/promises');
        const { createReadStream } = await import('node:fs');
        vi.mocked(stat).mockResolvedValue({ size: fileSize, mtimeMs } as Awaited<
            ReturnType<typeof stat>
        >);
        vi.mocked(createReadStream).mockImplementation(
            () => fakeReadStream() as unknown as ReturnType<typeof createReadStream>,
        );
    }

    describe('full file response (no Range header)', () => {
        it('returns 200 status', async () => {
            await setupMocks(1024);
            const response = await serveFileByPath('/media/movie.mp4', null);
            expect(response.status).toBe(200);
        });

        it('sets correct Content-Type for video file', async () => {
            await setupMocks(1024);
            const response = await serveFileByPath('/media/movie.mp4', null);
            expect(response.headers.get('Content-Type')).toBe('video/mp4');
        });

        it('sets correct Content-Type for audio file', async () => {
            await setupMocks(2048);
            const response = await serveFileByPath('/music/track.flac', null);
            expect(response.headers.get('Content-Type')).toBe('audio/flac');
        });

        it('sets Content-Length to full file size', async () => {
            await setupMocks(1024);
            const response = await serveFileByPath('/media/movie.mp4', null);
            expect(response.headers.get('Content-Length')).toBe('1024');
        });

        it('sets Accept-Ranges: bytes', async () => {
            await setupMocks(1024);
            const response = await serveFileByPath('/media/movie.mp4', null);
            expect(response.headers.get('Accept-Ranges')).toBe('bytes');
        });

        it('sets Content-Disposition: inline', async () => {
            await setupMocks(1024);
            const response = await serveFileByPath('/media/movie.mp4', null);
            expect(response.headers.get('Content-Disposition')).toBe('inline');
        });
    });

    describe('range request (206 Partial Content)', () => {
        it('returns 206 status for valid Range header', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath('/media/movie.mp4', 'bytes=0-1023');
            expect(response.status).toBe(206);
        });

        it('sets Content-Range header correctly', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath('/media/range-header-test.mp4', 'bytes=0-1023');
            expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/10000');
        });

        it('sets Content-Length to chunk size', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath('/media/movie.mp4', 'bytes=0-1023');
            expect(response.headers.get('Content-Length')).toBe('1024');
        });

        it('sets Accept-Ranges: bytes', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath('/media/movie.mp4', 'bytes=0-1023');
            expect(response.headers.get('Accept-Ranges')).toBe('bytes');
        });

        it('sets Content-Disposition: inline', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath('/media/movie.mp4', 'bytes=0-1023');
            expect(response.headers.get('Content-Disposition')).toBe('inline');
        });

        it('returns 416 for out-of-range request', async () => {
            await setupMocks(1000);
            const response = await serveFileByPath(
                '/media/out-of-range-test.mp4',
                'bytes=5000-9999',
            );
            expect(response.status).toBe(416);
            expect(response.headers.get('Content-Range')).toBe('bytes */1000');
        });

        it('clamps end to file size - 1', async () => {
            await setupMocks(1000);
            const response = await serveFileByPath('/media/clamp-end-test.mp4', 'bytes=900-9999');
            expect(response.status).toBe(206);
            expect(response.headers.get('Content-Range')).toBe('bytes 900-999/1000');
            expect(response.headers.get('Content-Length')).toBe('100');
        });

        // RFC 9110 §14.1.2 suffix range: players ask for the last N bytes to read
        // an MP4's trailing moov box before they start playback.
        it('serves a suffix range (bytes=-N) as the last N bytes', async () => {
            await setupMocks(1000);
            const response = await serveFileByPath('/media/suffix-test.mp4', 'bytes=-100');
            expect(response.status).toBe(206);
            expect(response.headers.get('Content-Range')).toBe('bytes 900-999/1000');
            expect(response.headers.get('Content-Length')).toBe('100');
        });

        it('serves the whole file for a suffix longer than the file', async () => {
            await setupMocks(1000);
            const response = await serveFileByPath('/media/suffix-long.mp4', 'bytes=-5000');
            expect(response.status).toBe(206);
            expect(response.headers.get('Content-Range')).toBe('bytes 0-999/1000');
        });

        it('returns 416 for a zero-length suffix', async () => {
            await setupMocks(1000);
            const response = await serveFileByPath('/media/suffix-zero.mp4', 'bytes=-0');
            expect(response.status).toBe(416);
        });

        it('returns 416 when the range ends before it starts', async () => {
            await setupMocks(1000);
            const response = await serveFileByPath('/media/inverted.mp4', 'bytes=500-100');
            expect(response.status).toBe(416);
        });
    });

    // Validators exist so an interrupted background download can resume instead of
    // restarting from byte zero — see buildValidators() for the full rationale.
    describe('validators (ETag / Last-Modified)', () => {
        it('sets a strong ETag derived from size and mtime', async () => {
            await setupMocks(1024);
            const response = await serveFileByPath('/media/etag-strong.mp4', null);
            const etag = response.headers.get('ETag');
            expect(etag).toBe(`"${(1024).toString(16)}-${MTIME_MS.toString(16)}"`);
            // Strong, not weak — a weak tag is unusable with If-Range.
            expect(etag?.startsWith('W/')).toBe(false);
        });

        it('sets Last-Modified as an HTTP-date', async () => {
            await setupMocks(1024);
            const response = await serveFileByPath('/media/etag-lastmod.mp4', null);
            expect(response.headers.get('Last-Modified')).toBe(new Date(MTIME_MS).toUTCString());
        });

        it('sets the same validators on a 206 as on a 200', async () => {
            await setupMocks(10000);
            const full = await serveFileByPath('/media/etag-parity.mp4', null);
            const partial = await serveFileByPath('/media/etag-parity.mp4', 'bytes=0-1023');
            expect(partial.status).toBe(206);
            expect(partial.headers.get('ETag')).toBe(full.headers.get('ETag'));
            expect(partial.headers.get('Last-Modified')).toBe(full.headers.get('Last-Modified'));
        });

        it('omits Last-Modified but still sets an ETag when the fs reports no usable mtime', async () => {
            await setupMocks(1024, Number.NaN);
            const response = await serveFileByPath('/media/etag-no-mtime.mp4', null);
            expect(response.headers.get('ETag')).toBe(`"${(1024).toString(16)}"`);
            expect(response.headers.get('Last-Modified')).toBeNull();
        });
    });

    describe('If-Range', () => {
        it('serves 206 when the entity-tag still matches', async () => {
            await setupMocks(10000);
            const etag = `"${(10000).toString(16)}-${MTIME_MS.toString(16)}"`;
            const response = await serveFileByPath(
                '/media/ifrange-match.mp4',
                'bytes=0-1023',
                undefined,
                'inline',
                etag,
            );
            expect(response.status).toBe(206);
            expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/10000');
        });

        it('falls back to the full file when the entity-tag is stale', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath(
                '/media/ifrange-stale.mp4',
                'bytes=0-1023',
                undefined,
                'inline',
                '"deadbeef-1"',
            );
            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Range')).toBeNull();
            expect(response.headers.get('Content-Length')).toBe('10000');
        });

        it('rejects a weak entity-tag outright', async () => {
            await setupMocks(10000);
            const weak = `W/"${(10000).toString(16)}-${MTIME_MS.toString(16)}"`;
            const response = await serveFileByPath(
                '/media/ifrange-weak.mp4',
                'bytes=0-1023',
                undefined,
                'inline',
                weak,
            );
            expect(response.status).toBe(200);
        });

        it('serves 206 when the HTTP-date form still matches', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath(
                '/media/ifrange-date-match.mp4',
                'bytes=0-1023',
                undefined,
                'inline',
                new Date(MTIME_MS).toUTCString(),
            );
            expect(response.status).toBe(206);
        });

        it('falls back to the full file when the HTTP-date is stale', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath(
                '/media/ifrange-date-stale.mp4',
                'bytes=0-1023',
                undefined,
                'inline',
                new Date(MTIME_MS - 60_000).toUTCString(),
            );
            expect(response.status).toBe(200);
        });

        it('falls back to the full file when If-Range is unparseable', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath(
                '/media/ifrange-garbage.mp4',
                'bytes=0-1023',
                undefined,
                'inline',
                'not-a-validator',
            );
            expect(response.status).toBe(200);
        });

        it('is inert without a Range header', async () => {
            await setupMocks(10000);
            const response = await serveFileByPath(
                '/media/ifrange-no-range.mp4',
                null,
                undefined,
                'inline',
                '"stale"',
            );
            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Length')).toBe('10000');
        });
    });
});
