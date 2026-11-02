// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit coverage for the pure classification helpers behind
 * `segment-delivery-failure.service.ts`.
 *
 * The point of this table is answering "were segments reaching this player?",
 * so the two things worth pinning are the ones that would silently make the
 * answer wrong: mislabelling a deliberate 503 retry-hint as a hard failure
 * (it is the fix for the AVFoundation 404 trap, not a symptom), and letting
 * anything from the request URL into a stored column — segment routes carry
 * `api_key` in the query string.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDb = vi.fn();
const mockRecord = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/segment-delivery-failures.queries.js', () => ({
    recordSegmentDeliveryFailure: (...args: unknown[]) => mockRecord(...args),
}));

const { categorizeSegmentFailure, classifySegmentResource, extractStreamVariant, recordFailure } =
    await import('./segment-delivery-failure.service.js');

describe('categorizeSegmentFailure', () => {
    it('ignores every success and redirect status', () => {
        for (const status of [200, 206, 301, 302, 304, 399]) {
            expect(categorizeSegmentFailure(status)).toBeNull();
        }
    });

    it("files 503 as 'not_ready', not an error", () => {
        // The handler answers 503 + Retry-After deliberately while a job is
        // still producing, precisely so AVFoundation retries instead of
        // penalty-boxing the variant. Counting it as a hard failure would make
        // the fix look like the bug.
        expect(categorizeSegmentFailure(503)).toBe('not_ready');
    });

    it("files 404 and 410 as 'gone' — the status that strands Apple players", () => {
        expect(categorizeSegmentFailure(404)).toBe('gone');
        expect(categorizeSegmentFailure(410)).toBe('gone');
    });

    it('separates auth rejections from malformed requests', () => {
        expect(categorizeSegmentFailure(401)).toBe('forbidden');
        expect(categorizeSegmentFailure(403)).toBe('forbidden');
        expect(categorizeSegmentFailure(400)).toBe('bad_request');
        expect(categorizeSegmentFailure(416)).toBe('bad_request');
    });

    it("files other 5xx as 'server_error'", () => {
        expect(categorizeSegmentFailure(500)).toBe('server_error');
        expect(categorizeSegmentFailure(502)).toBe('server_error');
    });
});

describe('classifySegmentResource', () => {
    it('distinguishes the master playlist from a media playlist', () => {
        expect(classifySegmentResource('master.m3u8')).toBe('master_playlist');
        expect(classifySegmentResource('video_0/index.m3u8')).toBe('media_playlist');
    });

    it('recognises media segments and init segments', () => {
        expect(classifySegmentResource('video_0/seg_00133.m4s')).toBe('segment');
        expect(classifySegmentResource('audio_1/seg_00001.ts')).toBe('segment');
        expect(classifySegmentResource('video_0/init.mp4')).toBe('init');
    });

    it('recognises subtitles ahead of the generic media-extension test', () => {
        expect(classifySegmentResource('subs_2/seg_00133.vtt')).toBe('subtitle');
        expect(classifySegmentResource('subs_2/subs.m3u8')).toBe('subtitle');
    });

    it('falls back to other for an unknown or absent path', () => {
        expect(classifySegmentResource(undefined)).toBe('other');
        expect(classifySegmentResource('nonsense')).toBe('other');
    });

    it('ignores the query string, which is where api_key rides', () => {
        expect(classifySegmentResource('video_0/seg_1.m4s?api_key=SECRET')).toBe('segment');
    });
});

describe('extractStreamVariant', () => {
    it('returns the stream directory, not the path', () => {
        expect(extractStreamVariant('video_0/seg_00133.m4s')).toBe('video_0');
        expect(extractStreamVariant('audio_1/init.mp4')).toBe('audio_1');
    });

    it('returns null when the path has no directory', () => {
        expect(extractStreamVariant('master.m3u8')).toBeNull();
        expect(extractStreamVariant(undefined)).toBeNull();
    });

    it('never leaks the query string into the stored value', () => {
        // A stored `api_key` would be a credential at rest — the whole reason
        // this is a typed table rather than a log tap.
        expect(extractStreamVariant('video_0/seg_1.m4s?api_key=SECRET')).toBe('video_0');
    });

    it('rejects a directory that is not a plain name', () => {
        // Path traversal or an injected segment must not become a stored key.
        expect(extractStreamVariant('../../etc/passwd')).toBeNull();
        expect(extractStreamVariant('we ird/seg_1.m4s')).toBeNull();
    });

    it('bounds the stored variant length', () => {
        const long = 'a'.repeat(500);
        const got = extractStreamVariant(`${long}/seg_1.m4s`);
        expect(got).not.toBeNull();
        expect(got!.length).toBeLessThanOrEqual(64);
    });
});

describe('recordFailure', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockRecord.mockResolvedValue(undefined);
    });

    const ok = { playSessionId: 'ps-1', status: 404, segmentPath: 'video_0/seg_1.m4s' };

    it('records a failure with the classified shape', () => {
        recordFailure(ok);

        expect(mockRecord).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                playSessionId: 'ps-1',
                category: 'gone',
                httpStatus: 404,
                resourceKind: 'segment',
                streamVariant: 'video_0',
            }),
        );
    });

    it('is a no-op for a successful response', () => {
        recordFailure({ ...ok, status: 200 });
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('is a no-op with no play session id to correlate against', () => {
        recordFailure({ ...ok, playSessionId: undefined });
        recordFailure({ ...ok, playSessionId: '   ' });
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('is a no-op when the DB is unavailable', () => {
        mockGetDb.mockReturnValue(null);
        recordFailure(ok);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('drops an absurdly long play session id rather than storing it', () => {
        recordFailure({ ...ok, playSessionId: 'x'.repeat(500) });
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('never throws when the write rejects, and returns before it settles', async () => {
        // The contract that matters: a diagnostics write must not turn a served
        // segment into a failed one, so recordFailure returns void (uncallable
        // with await by a handler) and swallows the rejection.
        mockRecord.mockRejectedValue(new Error('db exploded'));

        expect(() => recordFailure(ok)).not.toThrow();
        // Let the rejection settle; an unhandled rejection would fail the run.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});
