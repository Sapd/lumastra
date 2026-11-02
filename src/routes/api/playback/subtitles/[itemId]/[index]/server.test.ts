// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    findSubtitleFormatMismatch: vi.fn(),
    resolveSubtitle: vi.fn(),
    prefetchNextEpisodeSubtitle: vi.fn(),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({ requireAuth: (handler: unknown) => handler }));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/library-access.js', () => ({
    requireResolvedId: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    withMediaAccess: (handler: unknown) => handler,
}));
// Validation runs for real against the route's own schemas; the wrapper only
// parses params and query and hands them over as `validated`.
vi.mock('$lib/server/middleware/validate', () => ({
    withValidation:
        (
            handler: (event: unknown) => unknown,
            spec: {
                params: { parse(value: unknown): unknown };
                query: { parse(value: unknown): unknown };
            },
        ) =>
        (event: { params: unknown; url: URL; locals: unknown }) =>
            handler({
                ...event,
                validated: {
                    params: spec.params.parse(event.params),
                    query: spec.query.parse(Object.fromEntries(event.url.searchParams)),
                },
            }),
}));
vi.mock('$lib/server/services/subtitle-resolver.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/subtitle-resolver.service')>()),
    findSubtitleFormatMismatch: mocks.findSubtitleFormatMismatch,
    resolveSubtitle: mocks.resolveSubtitle,
}));
vi.mock('$lib/server/services/subtitle-prefetch.service.js', () => ({
    prefetchNextEpisodeSubtitle: mocks.prefetchNextEpisodeSubtitle,
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackSubtitle: vi.fn() },
}));

import { GET } from './+server.js';

const itemId = '12345678-1234-4234-8234-123456789012';

function event(query: string) {
    const url = new URL(`http://localhost/api/playback/subtitles/${itemId}/2?${query}`);
    return {
        params: { itemId, index: '2' },
        url,
        locals: { user: {}, resolvedIds: { internalId: itemId } },
        request: new Request(url),
    } as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/playback/subtitles/{itemId}/{index} format guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolveSubtitle.mockResolvedValue({
            content: Buffer.from([0x50, 0x47, 0x00, 0x01]),
            contentType: 'application/octet-stream',
        });
    });

    it('serves a track without a format parameter in its own format (no mismatch check)', async () => {
        mocks.findSubtitleFormatMismatch.mockResolvedValue({
            trackKind: 'pgs',
            validFormats: ['pgssub'],
        });
        await GET(event(''));
        expect(mocks.findSubtitleFormatMismatch).not.toHaveBeenCalled();
    });

    it('answers 422 validation_failed for an explicit vtt format on a PGS track', async () => {
        mocks.findSubtitleFormatMismatch.mockResolvedValue({
            trackKind: 'pgs',
            validFormats: ['pgssub'],
        });

        const response = await GET(event('format=vtt'));

        expect(response.status).toBe(422);
        const body = await response.json();
        expect(body.code).toBe('validation_failed');
        expect(body.error).toContain('pgssub');
        expect(mocks.resolveSubtitle).not.toHaveBeenCalled();
        expect(mocks.prefetchNextEpisodeSubtitle).not.toHaveBeenCalled();
    });

    it('serves the bytes when the format matches the track', async () => {
        mocks.findSubtitleFormatMismatch.mockResolvedValue(null);

        const response = await GET(event('format=pgssub'));

        expect(response.status).toBe(200);
        expect(mocks.resolveSubtitle).toHaveBeenCalledWith(
            {},
            itemId,
            2,
            expect.objectContaining({ format: 'pgssub' }),
        );
    });
});
