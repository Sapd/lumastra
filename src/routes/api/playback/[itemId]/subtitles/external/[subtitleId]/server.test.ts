// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ subtitle: vi.fn() }));
vi.mock('$lib/server/middleware/auth.js', () => ({ requireAuth: (handler: unknown) => handler }));
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    withMediaAccess: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/external-subtitles.queries.js', () => ({
    getExternalSubtitleByIdForMediaItem: mocks.subtitle,
}));
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    isPathWithinMediaStore: async () => true,
}));
vi.mock('$lib/server/utils/sidecar-text.js', () => ({
    readSidecarText: async () => '<html>untrusted subtitle</html>',
    SidecarTooLargeError: class extends Error {},
}));
vi.mock('$lib/server/utils/ffmpeg-subtitle-extractor.js', () => ({
    extractSubtitleStream: vi.fn(),
}));
import { GET } from './+server.js';
beforeEach(() => {
    vi.clearAllMocks();
});
it.each(['srt', 'ass'])('serves raw %s without allowing content sniffing', async (format) => {
    mocks.subtitle.mockResolvedValue({
        format,
        file_id: 'file',
        subtitle_path: `/media/subtitle.${format}`,
    });
    const response = await GET({
        params: { subtitleId: 'sub' },
        locals: { resolvedIds: { internalId: 'media' } },
        url: new URL(`http://localhost/subtitle?format=${format}`),
    } as Parameters<typeof GET>[0]);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Type')).toBe(
        format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/plain; charset=utf-8',
    );
    expect(await response.text()).toBe('<html>untrusted subtitle</html>');
});
