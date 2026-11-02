// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    findSubtitleFormatMismatch: vi.fn(),
    resolveSubtitle: vi.fn(),
    getOwnerItemForFile: vi.fn(),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({ requireAuth: (handler: unknown) => handler }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getOwnerItemForFile: mocks.getOwnerItemForFile,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    userNeedsMediaAccessCheck: async () => false,
    checkMediaAccess: vi.fn(),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackSubtitle: vi.fn() },
}));
vi.mock('$lib/server/services/subtitle-resolver.service.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/subtitle-resolver.service.js')>()),
    findSubtitleFormatMismatch: mocks.findSubtitleFormatMismatch,
    resolveSubtitle: mocks.resolveSubtitle,
}));

import { GET } from './+server.js';

const id = '12345678-1234-4234-8234-123456789012';

function event(query: string) {
    const url = new URL(`http://localhost/api/v1/playback/${id}/subtitles/2?${query}`);
    return {
        params: { id, index: '2' },
        url,
        locals: { user: {} },
        request: new Request(url),
    } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/v1/playback/{id}/subtitles/{index} format guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getOwnerItemForFile.mockResolvedValue(null);
        mocks.resolveSubtitle.mockResolvedValue({
            content: Buffer.from([0x50, 0x47, 0x00, 0x01]),
            contentType: 'application/octet-stream',
        });
    });

    it('answers 422 validation_failed for a text format on a PGS track, without extracting', async () => {
        mocks.findSubtitleFormatMismatch.mockResolvedValue({
            trackKind: 'pgs',
            validFormats: ['pgssub'],
        });

        const response = await GET(event('format=vtt'));

        expect(response.status).toBe(422);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        const body = await response.json();
        expect(body.code).toBe('validation_failed');
        expect(body.error).toContain('pgssub');
        expect(body.details[0]).toMatchObject({ field: 'format', value: 'vtt' });
        expect(mocks.resolveSubtitle).not.toHaveBeenCalled();
    });

    it('answers 422 for pgssub on a text track', async () => {
        mocks.findSubtitleFormatMismatch.mockResolvedValue({
            trackKind: 'text',
            validFormats: ['vtt', 'srt', 'ass'],
        });

        const response = await GET(event('format=pgssub'));

        expect(response.status).toBe(422);
        expect((await response.json()).error).toContain('vtt, srt, ass');
        expect(mocks.resolveSubtitle).not.toHaveBeenCalled();
    });

    it('serves the bytes when the format matches the track', async () => {
        mocks.findSubtitleFormatMismatch.mockResolvedValue(null);

        const response = await GET(event('format=pgssub'));

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/octet-stream');
        expect(mocks.resolveSubtitle).toHaveBeenCalledWith(
            {},
            id,
            2,
            expect.objectContaining({ format: 'pgssub' }),
        );
    });
});
